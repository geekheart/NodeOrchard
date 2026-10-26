#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';

// A protocol-only Hermes stand-in. It never launches tools or reads real auth.
const statePath = process.env.FAKE_HERMES_STATE_PATH;
const disk = statePath && existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, 'utf8'))
  : { version: 1, sessions: {} };
const coldSessions = new Set(Object.keys(disk.sessions));
const runtimes = new Map();
const requests = new Map();
let availableModels = ['test-model', 'test-model-alt'];
const skillContent = new Map([
  ['fixture-report', '# Fixture report\n\nCreate a concise report from the provided fixture data.\n'],
  ['fixture-escape', '# Escaping fixture\n\n<script>globalThis.__fixtureInjected = true</script>\n<img src=x onerror="globalThis.__fixtureInjected = true">\n\nLiteral & "quoted" <tag> text.\n\n  Preserve these leading spaces.\n'],
]);
let approvalMode = process.env.FAKE_APPROVAL_MODE || 'manual';
let fallbackProvider = process.env.FAKE_FALLBACK_PROVIDER || '';
let nextServerRequest = 0;
let shuttingDown = false;

function persist() {
  if (!statePath) return;
  mkdirSync(dirname(statePath), { recursive: true });
  const temporary = `${statePath}.tmp-${process.pid}`;
  // Real Hermes does not store a newly created, still-empty conversation.
  const sessions = Object.fromEntries(Object.entries(disk.sessions)
    .filter(([, session]) => session.messages.length > 0));
  writeFileSync(temporary, JSON.stringify({ ...disk, sessions }), { mode: 0o600 });
  renameSync(temporary, statePath);
}

function write(message) {
  if (!shuttingDown) process.stdout.write(`${JSON.stringify(message)}\n`);
}

function event(type, sessionId, payload = {}) {
  const params = { type, payload };
  if (sessionId !== undefined) params.session_id = sessionId;
  write({ jsonrpc: '2.0', method: 'event', params });
}

function rpcError(code, message) {
  return Object.assign(new Error(message), { code });
}

function runtimeFor(params) {
  if (typeof params.session_id !== 'string') {
    throw rpcError(-32602, 'session_id must be a string');
  }
  const runtime = runtimes.get(params.session_id);
  if (!runtime) throw rpcError(-32001, 'Unknown runtime session');
  return runtime;
}

function connect(stored) {
  const runtime = { id: `fake-runtime-${randomUUID()}`, stored, run: null };
  runtimes.set(runtime.id, runtime);
  return runtime;
}

function sessionResult(runtime) {
  return {
    session_id: runtime.id,
    stored_session_id: runtime.stored.stored_session_id,
    message_count: runtime.stored.messages.length,
    messages: runtime.stored.messages.map((message) => ({ ...message })),
    info: {
      ...(runtime.lazy ? { lazy: true } : {}),
      provider: 'openai-codex',
      model: runtime.stored.model || 'test-model',
      version: 'fake-hermes-1',
      yolo: false,
      approval_mode: approvalMode,
    },
  };
}

function newRun() {
  return {
    settled: false,
    output: '',
    timers: new Set(),
    delayReleases: new Set(),
    releaseSlow: null,
  };
}

function settle(runtime, run, status, text) {
  if (run.settled) return;
  run.settled = true;
  for (const timer of run.timers) clearTimeout(timer);
  run.timers.clear();
  for (const release of run.delayReleases) release();
  run.delayReleases.clear();
  for (const [id, pending] of requests) {
    if (pending.run === run) {
      requests.delete(id);
      pending.resolve({ cancelled: true });
    }
  }
  run.releaseSlow?.();
  runtime.stored.messages.push({ role: 'assistant', text });
  persist();
  event('message.complete', runtime.id, { text, status });
  if (runtime.run === run) runtime.run = null;
}

function delay(run, milliseconds) {
  return new Promise((resolve) => {
    run.delayReleases.add(resolve);
    const timer = setTimeout(() => {
      run.timers.delete(timer);
      run.delayReleases.delete(resolve);
      resolve();
    }, milliseconds);
    run.timers.add(timer);
  });
}

function requestClient(runtime, run, method, fields) {
  return new Promise((resolve, reject) => {
    const id = `srq-${++nextServerRequest}`;
    requests.set(id, { run, resolve, reject });
    write({
      jsonrpc: '2.0',
      id,
      method,
      params: {
        session_id: runtime.id,
        request_id: id,
        ...fields,
      },
    });
  });
}

function prepareResumeRace(runtime) {
  const mode = process.env.FAKE_RESUME_RACE;
  if (!['complete', 'approval'].includes(mode)
      || !coldSessions.delete(runtime.stored.stored_session_id)) return null;
  const run = newRun();
  run.output = 'Recovered prefix';
  runtime.run = run;
  const id = `srq-${nextServerRequest + 1}`;
  const params = {
    session_id: runtime.id,
    request_id: id,
    command: 'test-resume-command',
    choices: ['once', 'deny'],
  };
  // Both frames precede the resume response, when the app cannot yet map this
  // freshly allocated runtime ID. The snapshot repeats the same request.
  event('message.delta', runtime.id, { text: run.output });
  const answer = requestClient(runtime, run, 'approval', {
    command: params.command,
    choices: params.choices,
  });
  runtime.resumeRace = { mode, run, id, emitted: false };
  if (mode === 'approval') {
    void answer.then((result) => {
      if (!run.settled) {
        settle(runtime, run, 'complete', `Recovered; choice=${String(result?.choice)}`);
      }
    }, (error) => settle(runtime, run, 'error', error.message));
  }
  return { id, method: 'approval', params };
}

function emitResumeRace(runtime) {
  const race = runtime.resumeRace;
  if (!race || race.emitted) return;
  race.emitted = true;
  // config.set is deliberately the barrier: resume has answered, but its
  // follow-up configuration RPC has not. No timer makes this race probabilistic.
  if (race.mode === 'complete') {
    event('request.cancel', runtime.id, { id: race.id });
    settle(runtime, race.run, 'complete', 'Recovered completion');
  } else {
    event('message.delta', runtime.id, { text: '; waiting for approval' });
  }
}

async function execute(runtime, run, text) {
  try {
    if (run.settled) return;
    event('message.start', runtime.id, { role: 'assistant' });
    if (text.includes('crash')) {
      // The user message is already persisted; emulate a lost subprocess.
      setTimeout(() => process.exit(17), 10);
      return;
    }

    let answer = `Echo: ${text}`;
    if (text.includes('approval')) {
      const result = await requestClient(runtime, run, 'approval', {
        command: 'test-command',
        choices: ['once', 'deny'],
      });
      if (run.settled) return;
      answer += `; choice=${String(result?.choice)}`;
    }
    if (text.includes('clarify')) {
      const result = await requestClient(runtime, run, 'clarify', {
        question: 'Which fixture answer should be used?',
        choices: ['first', 'second'],
      });
      if (run.settled) return;
      answer += `; answer=${String(result?.answer)}`;
    }
    if (text.includes('slow')) {
      run.output = 'Working slowly';
      event('message.delta', runtime.id, { text: run.output });
      await new Promise((resolve) => { run.releaseSlow = resolve; });
      return;
    }

    const midpoint = Math.max(1, Math.ceil(answer.length / 2));
    for (const part of [answer.slice(0, midpoint), answer.slice(midpoint)]) {
      await delay(run, 5);
      if (run.settled) return;
      run.output += part;
      event('message.delta', runtime.id, { text: part });
    }
    settle(runtime, run, 'complete', run.output);
  } catch (error) {
    if (!run.settled) settle(runtime, run, 'error', error.message);
  }
}

function handle(method, params = {}) {
  switch (method) {
    case 'ping':
      return { pong: true };
    case 'client.capabilities':
      return { accepted: true };
    case 'config.get':
      if (params.key === 'full') {
        return { config: {
          fallback_providers: fallbackProvider
            ? [{ provider: fallbackProvider, model: 'fallback-test-model' }] : [],
          approvals: { mode: approvalMode },
        } };
      }
      if (params.key === 'approvals.mode') return { value: approvalMode };
      if (params.key !== 'provider') throw rpcError(-32602, 'Unsupported config key');
      return {
        model: 'test-model',
        provider: 'openai-codex',
        providers: [{ id: 'openai-codex', authenticated: true }],
      };
    case 'config.set': {
      // Test-only control, unavailable in real Hermes. It lets a policy change
      // between connect and create/submit without restarting the subprocess.
      if (params.key === 'fixture_switch') {
        const value = params.value;
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw rpcError(-32602, 'fixture_switch needs an object');
        }
        if (Object.hasOwn(value, 'approval_mode')) {
          if (typeof value.approval_mode !== 'string') throw rpcError(-32602, 'Invalid approval_mode');
          approvalMode = value.approval_mode;
        }
        if (Object.hasOwn(value, 'fallback_provider')) {
          if (typeof value.fallback_provider !== 'string') throw rpcError(-32602, 'Invalid fallback_provider');
          fallbackProvider = value.fallback_provider;
        }
        if (Object.hasOwn(value, 'models')) {
          if (!Array.isArray(value.models) || value.models.some(model => typeof model !== 'string')) {
            throw rpcError(-32602, 'Invalid fixture models');
          }
          availableModels = [...value.models];
        }
        return { key: params.key, value: { approval_mode: approvalMode, fallback_provider: fallbackProvider } };
      }
      const supported = (params.key === 'yolo' && params.value === 'off')
        || (params.key === 'approval_mode' && params.value === 'manual');
      if (params.scope !== 'session' || !supported) {
        throw rpcError(-32602, 'Only manual session settings are supported');
      }
      const runtime = runtimeFor(params);
      if (params.key === 'yolo') emitResumeRace(runtime);
      return { key: params.key, value: params.value };
    }
    case 'model.options':
      return {
        providers: [{
          slug: 'openai-codex',
          name: 'ChatGPT or Codex Subscription',
          models: [...availableModels],
          authenticated: true,
          featured_models: [...availableModels],
        }],
        provider: 'openai-codex',
        model: 'test-model',
      };
    case 'skills.manage':
      if (params.action !== 'list') throw rpcError(-32602, 'Only installed skills can be listed');
      return { skills: { testing: [...skillContent.keys()] } };
    case 'commands.catalog':
      return {
        pairs: [
          ['/fixture-report', 'Generate a fixture report'],
          ['/fixture-escape', 'Read <script> safely & preserve "quotes"'],
          ['/help', 'Not a skill'],
        ],
        skills: {
          '/fixture-report': { origin: 'bundled', usage: 2 },
          '/fixture-escape': { origin: 'local', usage: 0 },
        },
      };
    case 'learning.detail':
      if (typeof params.id !== 'string' || !skillContent.has(params.id)) {
        return { ok: false, message: 'Skill not found' };
      }
      return { ok: true, kind: 'skill', id: params.id, label: params.id, content: skillContent.get(params.id) };
    case 'session.create': {
      if (params.model && !availableModels.includes(params.model)) throw rpcError(-32602, 'Unavailable fixture model');
      const stored = {
        stored_session_id: `fake-stored-${randomUUID()}`,
        model: params.model || 'test-model',
        cwd: params.cwd,
        messages: [],
      };
      disk.sessions[stored.stored_session_id] = stored;
      persist();
      return sessionResult(connect(stored));
    }
    case 'session.resume': {
      if (typeof params.session_id !== 'string') {
        throw rpcError(-32602, 'session_id must be a stored session id');
      }
      const stored = disk.sessions[params.session_id];
      if (!stored) throw rpcError(4007, 'Unknown stored session');
      const runtime = connect(stored);
      runtime.lazy = params.lazy === true;
      const openRequest = runtime.lazy ? null : prepareResumeRace(runtime);
      const snapshot = sessionResult(runtime);
      if (openRequest) {
        snapshot.running = true;
        snapshot.streaming = true;
        snapshot.inflight = { streaming: true, text: 'Recovered prefix' };
        snapshot.open_requests = [openRequest];
      }
      return snapshot;
    }
    case 'session.activate':
      return sessionResult(runtimeFor(params));
    case 'session.history': {
      const runtime = runtimeFor(params);
      return {
        count: runtime.stored.messages.length,
        messages: runtime.stored.messages.map((message) => ({ ...message })),
      };
    }
    case 'prompt.submit': {
      const runtime = runtimeFor(params);
      if (typeof params.text !== 'string') throw rpcError(-32602, 'text must be a string');
      if (runtime.run) throw rpcError(-32002, 'Session already has an active prompt');
      if (params.text.includes('reject-before-persist')) {
        throw rpcError(-32010, 'Rejected before prompt persistence');
      }
      const run = newRun();
      runtime.run = run;
      runtime.stored.messages.push({ role: 'user', text: params.text });
      persist();
      // Reply to submit before streaming or asking for a client decision.
      setImmediate(() => { void execute(runtime, run, params.text); });
      return { status: 'streaming' };
    }
    case 'session.interrupt': {
      const runtime = runtimeFor(params);
      if (runtime.run) settle(runtime, runtime.run, 'interrupted', runtime.run.output);
      return { interrupted: true, session_id: runtime.id };
    }
    default:
      throw rpcError(-32601, `Unknown method: ${method}`);
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (message === null || typeof message !== 'object' || message.jsonrpc !== '2.0') {
    write({ jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid request' } });
    return;
  }
  if (typeof message.method !== 'string') {
    const pending = requests.get(message.id);
    if (!pending) return;
    requests.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message || 'Client response failed'));
    else pending.resolve(message.result);
    return;
  }
  try {
    const result = handle(message.method, message.params);
    if (Object.hasOwn(message, 'id')) write({ jsonrpc: '2.0', id: message.id, result });
  } catch (error) {
    if (Object.hasOwn(message, 'id')) {
      write({ jsonrpc: '2.0', id: message.id, error: { code: error.code ?? -32603, message: error.message } });
    }
  }
});
input.on('close', () => {
  shuttingDown = true;
  process.exit(0);
});

event('gateway.ready', undefined, { version: 'fake-hermes-1' });
