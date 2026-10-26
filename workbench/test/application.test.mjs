import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../src/config.mjs';
import { Application } from '../src/application.mjs';
import { createWorkbenchServer } from '../src/server.mjs';
import { redact } from '../src/hermes-adapter.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-hermes.mjs', import.meta.url));

async function setup(t, childEnv = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-test-'));
  const config = { ...readConfig({ WORKBENCH_HERMES_ROOT: join(directory, 'fake-install'), WORKBENCH_HERMES_HOME: join(directory, 'fake-home') }),
    port: 0, dataDir: join(directory, 'db'), workspaceRoot: join(directory, 'workspace'), workflowRunRoot: join(directory, 'runs'),
    command: process.execPath, args: [fixture], childEnv: {
      FAKE_HERMES_STATE_PATH: join(directory, 'hermes.json'),
      FAKE_APPROVAL_MODE: 'manual', FAKE_FALLBACK_PROVIDER: '', FAKE_RESUME_RACE: '', ...childEnv,
    } };
  const app = new Application(config);
  const applications = new Set([app]);
  t.after(async () => {
    for (const application of applications) if (!application.closed) await application.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, config, app, track: application => { applications.add(application); return application; } };
}

function eventAfter(app, predicate, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { app.off('event', onEvent); reject(new Error('Expected event not received')); }, timeout);
    const onEvent = event => {
      if (!predicate(event)) return;
      clearTimeout(timer); app.off('event', onEvent); resolve(event);
    };
    app.on('event', onEvent);
  });
}

function recordRequests(adapter) {
  const methods = [];
  const request = adapter.request.bind(adapter);
  adapter.request = (method, ...args) => {
    methods.push(method);
    return request(method, ...args);
  };
  return methods;
}

test('nested workflow state publishes preserve event order for SSE cursor deduplication', async t => {
  const { app } = await setup(t);
  const delivered = [], accepted = []; let cursor = 0;
  app.on('event', event => {
    if (event.type === 'request.open' || event.type === 'request.cancel') {
      app.publish('workflow.run', event.sessionId, { status: event.type === 'request.open' ? 'waiting' : 'running' });
    }
  });
  app.on('event', event => {
    delivered.push([event.id, event.type]);
    if (event.id > cursor) { accepted.push(event.type); cursor = event.id; }
  });
  app.publish('request.open', 'step-session', { id: 'approval' });
  app.publish('request.cancel', 'step-session', { id: 'approval' });
  assert.deepEqual(accepted, ['request.open', 'workflow.run', 'request.cancel', 'workflow.run']);
  assert.deepEqual(delivered.map(([id]) => id), [1, 2, 3, 4]);
  assert.deepEqual(app.events.map(event => [event.id, event.type]), delivered);
});

test('large learning snapshots bound SSE replay memory while retaining newest ordered events', async t => {
  const { app } = await setup(t);
  const payload = { samples: 'x'.repeat(6 * 1024 * 1024) };
  for (let i = 0; i < 3; i++) app.publish('learning.run', null, payload);
  assert.deepEqual(app.events.map(event => event.id), [2, 3]);
  assert(app.eventBytes <= 16 * 1024 * 1024);
  assert.equal(app.events.at(-1).payload, payload);
  for (let i = 0; i < 1001; i++) app.publish('backend.status', null, { state: 'ready' });
  assert.equal(app.events.length, 1000);
  assert.equal(app.events.at(-1).id, 1004);
  assert(app.events.every((event, index, events) => !index || event.id > events[index - 1].id));
});

const unsafePolicies = [
  {
    name: 'disabled approvals', code: 'POLICY_APPROVAL_REQUIRED',
    env: { FAKE_APPROVAL_MODE: 'off' }, change: { approval_mode: 'off' },
  },
  {
    name: 'a non-subscription fallback', code: 'FALLBACK_PROVIDER_NOT_ALLOWED',
    env: { FAKE_FALLBACK_PROVIDER: 'openai' }, change: { fallback_provider: 'openai' },
  },
];

for (const policy of unsafePolicies) {
  test(`connect refuses ${policy.name}`, async t => {
    const { app } = await setup(t, policy.env);
    await assert.rejects(app.connect(), { code: policy.code });
    assert.equal(app.backend.state, 'error');
    assert.equal(app.store.list().length, 0);
  });

  test(`session creation rechecks ${policy.name} before creating a runtime`, async t => {
    const { app } = await setup(t);
    await app.connect();
    await app.adapter.request('config.set', { key: 'fixture_switch', value: policy.change });
    const methods = recordRequests(app.adapter);
    await assert.rejects(app.createSession(), { code: policy.code });
    assert(!methods.includes('session.create'));
    assert.equal(app.store.list().length, 0);
  });

  test(`prompt submission rechecks ${policy.name} without sending a prompt`, async t => {
    const { app } = await setup(t);
    await app.connect();
    const session = await app.createSession();
    await app.adapter.request('config.set', { key: 'fixture_switch', value: policy.change });
    const methods = recordRequests(app.adapter);
    await assert.rejects(app.submit(session.id, 'must not run'), { code: policy.code });
    assert(!methods.includes('prompt.submit'));
    assert.equal(app.store.runs(session.id).length, 0);
    const history = await app.adapter.request('session.history', { session_id: session.runtimeSessionId });
    assert.deepEqual(history.messages, []);
  });
}

test('stdio → session → streamed response → authoritative Hermes history', async t => {
  const { app } = await setup(t);
  const backend = await app.connect();
  assert.equal(backend.provider, 'openai-codex');
  assert.equal(backend.model, 'test-model');
  assert.equal(backend.authenticated, true);
  const session = await app.createSession({ title: 'protocol test' });
  assert.notEqual(session.runtimeSessionId, session.storedSessionId);
  const completed = eventAfter(app, e => e.type === 'message.complete');
  assert.equal((await app.submit(session.id, 'hello')).status, 'streaming');
  const event = await completed;
  assert.equal(event.payload.status, 'complete');
  assert.equal(app.store.get(session.id).status, 'complete');
  assert(app.events.some(e => e.type === 'message.delta' && e.sessionId === session.id));
  const history = await app.history(session.id);
  assert.deepEqual(history.messages.map(m => m.role), ['user', 'assistant']);
  assert.equal(history.messages[1].text, 'Echo: hello');
  assert.equal(app.store.runs(session.id)[0].status, 'complete');
});

for (const boundary of ['policy', 'runtime']) {
  for (const action of ['stop', 'shutdown']) {
    test(`workflow ${action} during ${boundary} await prevents prompt submission`, async t => {
      const { app } = await setup(t);
      await app.connect();
      const session = await app.createSession();
      let allowed = true, release, reached;
      const blocked = new Promise(resolve => { release = resolve; });
      const entered = new Promise(resolve => { reached = resolve; });
      app.workflows.ownsSession = id => id === session.id;
      app.workflows.allowsSubmit = () => allowed;
      const methods = recordRequests(app.adapter);
      if (boundary === 'policy') {
        const request = app.adapter.request.bind(app.adapter);
        app.adapter.request = async (method, params, ...args) => {
          if (method === 'config.get' && params.key === 'full') { reached(); await blocked; }
          return request(method, params, ...args);
        };
      } else {
        const runtime = app.runtime.bind(app);
        app.runtime = async id => { reached(); await blocked; return runtime(id); };
      }
      const pending = app.submit(session.id, 'must not start after stop', { workflowRunId: 'test-run' });
      const rejected = assert.rejects(pending, action === 'stop' ? /工作流已停止/ : /工作台已关闭/);
      await entered;
      if (action === 'stop') allowed = false;
      else app.closed = true;
      release();
      try { await rejected; } finally { app.closed = false; }
      assert(!methods.includes('prompt.submit'));
      assert.equal(app.store.runs(session.id).length, 0);
      assert.equal(app.busyMutations.has(session.id), false);
    });
  }
}

test('approval waits for explicit reply; broad grants rejected; clarify is bidirectional', async t => {
  const { app } = await setup(t);
  await app.connect();
  const session = await app.createSession();
  const requestEvent = eventAfter(app, e => e.type === 'request.open');
  await app.submit(session.id, 'approval');
  const { payload: request } = await requestEvent;
  assert.equal(app.store.get(session.id).status, 'waiting');
  assert.equal(app.store.runs(session.id)[0].status, 'running');
  assert.throws(() => app.reply(request.id, { choice: 'always' }));
  assert(app.requests.has(request.id));
  const completed = eventAfter(app, e => e.type === 'message.complete');
  app.reply(request.id, { choice: 'deny' });
  assert.match((await completed).payload.text, /choice=deny/);
  const question = eventAfter(app, e => e.type === 'request.open');
  await app.submit(session.id, 'clarify');
  const q = (await question).payload;
  const answered = eventAfter(app, e => e.type === 'message.complete');
  app.reply(q.id, { answer: 'second' });
  assert.match((await answered).payload.text, /answer=second/);
});

test('interrupt is not recorded as success; duplicate concurrent submission is refused', async t => {
  const { app } = await setup(t);
  await app.connect();
  const session = await app.createSession();
  const streamed = eventAfter(app, e => e.type === 'message.delta');
  await app.submit(session.id, 'slow');
  await streamed;
  await assert.rejects(app.submit(session.id, 'duplicate'), /正在执行/);
  const completed = eventAfter(app, e => e.type === 'message.complete');
  await app.interrupt(session.id);
  assert.equal((await completed).payload.status, 'interrupted');
  assert.equal(app.store.runs(session.id)[0].status, 'interrupted');
  assert.equal(app.store.runs(session.id).length, 1);
});

test('subprocess crash preserves durable ID and resumes without replaying a prompt', async t => {
  const { app } = await setup(t);
  await app.connect();
  const session = await app.createSession();
  const disconnected = eventAfter(app, e => e.type === 'backend.status' && e.payload.state === 'disconnected');
  await app.submit(session.id, 'crash');
  await disconnected;
  assert.equal(app.store.runs(session.id)[0].status, 'unknown');
  await app.connect();
  const { session: restored, snapshot } = await app.resume(session.id);
  assert.equal(restored.storedSessionId, session.storedSessionId);
  assert.notEqual(restored.runtimeSessionId, session.runtimeSessionId);
  assert.equal(restored.status, 'unknown');
  assert.equal(app.store.get(session.id).status, 'unknown');
  assert.equal(snapshot.messages.filter(m => m.role === 'user').length, 1);
  assert.equal(app.store.runs(session.id).length, 1);
});

test('application restart restores metadata and reads history from Hermes', async t => {
  const { app, config, track } = await setup(t);
  await app.connect();
  const session = await app.createSession();
  const completed = eventAfter(app, e => e.type === 'message.complete');
  await app.submit(session.id, 'persistent');
  await completed;
  await app.close();
  const restarted = track(new Application(config));
  assert.equal(restarted.store.get(session.id).runtimeSessionId, null);
  await restarted.connect();
  const { session: restored } = await restarted.resume(session.id);
  assert.equal(restored.status, 'complete');
  assert.equal(restarted.store.get(session.id).status, 'complete');
  assert.equal((await restarted.history(session.id)).messages[1].text, 'Echo: persistent');
});

test('cold history restoration for workflow and learning control sessions requests lazy resume without replay', async t => {
  const { app, config, track } = await setup(t); await app.connect();
  const ids = [];
  for (const kind of ['workflow', 'learning']) {
    const session = await app.createSession();
    const completed = eventAfter(app, event => event.type === 'message.complete' && event.sessionId === session.id);
    await app.submit(session.id, 'managed history'); await completed; ids.push(session.id);
    if (kind === 'learning') app.store.db.prepare('INSERT INTO learning_model_sessions(id) VALUES(?)').run(session.id);
    else app.store.db.prepare('INSERT INTO workflow_runs(id,value) VALUES(?,?)').run('managed-fixture', JSON.stringify({ sessionId: session.id, nodes: {} }));
  }
  await app.close();
  const restarted = track(new Application(config)); await restarted.connect();
  const frames = []; const request = restarted.adapter.request.bind(restarted.adapter);
  restarted.adapter.request = (method, params, ...rest) => { frames.push({ method, params }); return request(method, params, ...rest); };
  for (const id of ids) {
    const history = await restarted.history(id);
    assert.equal(history.messages.at(-1).text, 'Echo: managed history');
    assert.deepEqual(await restarted.interrupt(id), { interrupted: false, historyOnly: true });
    await assert.rejects(restarted.submit(id, 'uncontrolled continuation'), /固定运行会话|学习控制会话/);
  }
  assert.equal(frames.filter(frame => frame.method === 'session.resume').length, 2);
  assert(frames.filter(frame => frame.method === 'session.resume').every(frame => frame.params.lazy === true));
  assert.equal(frames.some(frame => frame.method === 'prompt.submit'), false);
  assert.equal(frames.some(frame => frame.method === 'session.interrupt'), false,
    'interrupting a lazy managed history must not build a new writable Hermes agent');
});

test('managed history refuses a backend that does not explicitly confirm lazy recovery', async t => {
  const { app, config, track } = await setup(t); await app.connect();
  const session = await app.createSession();
  const completed = eventAfter(app, event => event.type === 'message.complete' && event.sessionId === session.id);
  await app.submit(session.id, 'private validation history'); await completed;
  app.store.db.prepare('INSERT INTO learning_model_sessions(id) VALUES(?)').run(session.id);
  await app.close();
  const restarted = track(new Application(config)); await restarted.connect();
  const request = restarted.adapter.request.bind(restarted.adapter);
  restarted.adapter.request = async (method, params, ...rest) => {
    const response = await request(method, params, ...rest);
    if (method === 'session.resume') delete response.info.lazy;
    return response;
  };
  await assert.rejects(restarted.history(session.id), /未确认.*只读恢复/);
  assert.equal(restarted.session(session.id).runtimeSessionId, null);
  await assert.rejects(restarted.submit(session.id, 'uncontrolled continuation'), /学习控制会话/);
});

test('first prompt rejected before persistence recovers an empty session without replay', async t => {
  const { app, config, track } = await setup(t);
  await app.connect();
  const original = await app.createSession();
  await assert.rejects(app.submit(original.id, 'reject-before-persist'), /Rejected before prompt persistence/);
  assert.equal(app.store.get(original.id).hasPrompted, false);
  assert.equal(app.store.runs(original.id).length, 1);
  await app.close();

  const restarted = track(new Application(config));
  await restarted.connect();
  const methods = recordRequests(restarted.adapter);
  const { session, snapshot } = await restarted.resume(original.id);
  assert.notEqual(session.storedSessionId, original.storedSessionId);
  assert.equal(session.hasPrompted, false);
  assert.deepEqual(snapshot.messages, []);
  assert.deepEqual((await restarted.history(original.id)).messages, []);
  assert.equal(methods.filter(method => method === 'session.resume').length, 1);
  assert.equal(methods.filter(method => method === 'session.create').length, 1);
  assert(!methods.includes('prompt.submit'));
  assert.equal(restarted.store.runs(original.id).length, 1);
});

for (const mode of ['complete', 'approval']) {
  test(`cold resume preserves ${mode} frames across snapshot and configuration`, async t => {
    const { app, config, track } = await setup(t, { FAKE_RESUME_RACE: mode });
    await app.connect();
    const original = await app.createSession();
    const firstComplete = eventAfter(app, event => event.type === 'message.complete');
    await app.submit(original.id, 'before recovery');
    await firstComplete;
    await app.close();

    const restarted = track(new Application(config));
    await restarted.connect();
    const resuming = restarted.resume(original.id);
    assert.strictEqual(restarted.resume(original.id), resuming, 'resume is single-flight');
    const { session, snapshot } = await resuming;
    assert.notEqual(session.runtimeSessionId, original.runtimeSessionId);
    assert.equal(session.storedSessionId, original.storedSessionId);
    const events = restarted.events.filter(event => event.sessionId === original.id);
    assert(events.some(event => event.type === 'message.delta' && event.payload.text === 'Recovered prefix'));
    assert.equal(events.filter(event => event.type === 'request.open').length, 1, 'snapshot and live request must deduplicate');
    assert.equal(restarted.store.runs(original.id).length, 1, 'recovery does not create a local run');

    if (mode === 'complete') {
      assert.equal(session.status, 'complete');
      assert.equal(restarted.store.get(original.id).status, 'complete');
      assert.equal(snapshot.running, false);
      assert.equal(snapshot.inflight, null);
      assert.deepEqual(snapshot.open_requests, []);
      assert.equal(restarted.requests.size, 0);
      assert.equal(restarted.adapter.serverRequests.size, 0);
      assert(events.some(event => event.type === 'request.cancel'));
      assert(events.some(event => event.type === 'message.complete' && event.payload.status === 'complete'));
    } else {
      assert.equal(session.status, 'waiting');
      assert.equal(snapshot.running, true);
      assert.equal(snapshot.inflight.streaming, true);
      assert.equal(snapshot.open_requests.length, 1);
      assert.equal(restarted.requests.size, 1);
      assert.equal(restarted.adapter.serverRequests.size, 1);
      const request = [...restarted.requests.values()][0];
      const completed = eventAfter(restarted, event => event.type === 'message.complete');
      restarted.reply(request.id, { choice: 'once' });
      assert.match((await completed).payload.text, /choice=once/);
      assert.equal(restarted.store.get(original.id).status, 'complete');
      assert.equal(restarted.requests.size, 0);
    }
  });
}

test('skills stay offline until an explicit connection, then expose installed fixture skills', async t => {
  const { app } = await setup(t);
  const methods = recordRequests(app.adapter);
  const offline = await app.skills();
  assert.equal(offline.connected, false);
  assert.deepEqual(offline.skills, []);
  assert.equal(app.adapter.state, 'stopped');
  assert.equal(app.adapter.proc, undefined);
  assert.deepEqual(methods, [], 'reading the skills page must not contact Hermes while offline');

  await app.connect();
  const result = await app.skills();
  assert.equal(result.connected, true);
  assert.deepEqual(result.skills.map(skill => skill.name).sort(), ['fixture-escape', 'fixture-report']);
  assert(!result.skills.some(skill => skill.name === 'help'), 'ordinary commands are not installed skills');
  const escaped = result.skills.find(skill => skill.name === 'fixture-escape');
  assert.equal(escaped.description, 'Read <script> safely & preserve "quotes"');
  assert.equal(escaped.source, 'local');
  const detail = await app.skill('fixture-escape');
  assert.equal(detail.name, 'fixture-escape');
  assert.equal(detail.source, 'local');
  assert(detail.content.includes('<script>globalThis.__fixtureInjected = true</script>'));
  assert(detail.content.includes('Literal & "quoted" <tag> text.'));
  assert(detail.content.endsWith('  Preserve these leading spaces.\n'));
});

test('unknown or private skill names are rejected before reading any detail', async t => {
  const { app } = await setup(t);
  await app.connect();
  const methods = recordRequests(app.adapter);
  for (const name of ['not-installed', 'memory:private', '../private']) {
    await assert.rejects(async () => app.skill(name), error => error.httpStatus === 404 || error.httpStatus === 400);
  }
  assert(!methods.includes('learning.detail'), 'unlisted names must not reach the detail RPC');
});

test('HTTP bridge enforces origin, CSRF, workspace scope and does not expose auth', async t => {
  const { app, config, directory } = await setup(t);
  const http = createWorkbenchServer(config, app);
  const url = await http.listen();
  t.after(() => http.close());
  const bootstrap = await (await fetch(`${url}/api/bootstrap`)).json();
  assert(Number.isSafeInteger(bootstrap.eventCursor));
  assert(!JSON.stringify(bootstrap).includes('access_token'));
  assert.equal((await fetch(`${url}/api/connect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${url}/api/bootstrap`, { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  const headers = { 'Content-Type': 'application/json', 'X-Workbench-Token': bootstrap.csrfToken };
  const settingsResponse = await fetch(`${url}/api/settings`);
  assert.equal(settingsResponse.status, 200);
  assert.equal((await settingsResponse.json()).preferences.theme, 'system');
  const offlineSkills = await (await fetch(`${url}/api/skills`)).json();
  assert.equal(offlineSkills.connected, false);
  assert.deepEqual(offlineSkills.skills, []);
  assert.equal(app.adapter.state, 'stopped');
  assert.equal((await fetch(`${url}/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preferences: { theme: 'dark' } }) })).status, 403);
  const savedSettings = await fetch(`${url}/api/settings`, { method: 'POST', headers,
    body: JSON.stringify({ preferences: { theme: 'dark' } }) });
  assert.equal(savedSettings.status, 200);
  assert.equal((await savedSettings.json()).preferences.theme, 'dark');
  assert.equal((await fetch(`${url}/api/settings`, { method: 'POST', headers,
    body: JSON.stringify({ preferences: { unexpected: true } }) })).status, 400);
  const statisticsResponse = await fetch(`${url}/api/statistics?days=7`);
  assert.equal(statisticsResponse.status, 200);
  assert.equal((await statisticsResponse.json()).days, 7);
  assert.equal((await fetch(`${url}/api/statistics?days=365`)).status, 400);
  assert.equal((await fetch(`${url}/api/events?after=invalid`)).status, 400);
  assert.equal((await fetch(`${url}/api/connect`, { method: 'POST', headers, body: '{}' })).status, 200);
  const beforeReplay = await (await fetch(`${url}/api/bootstrap`)).json();
  const retained = app.publish('test.cursor-replay', null, { marker: 'retained-before-subscribe' });
  const stream = await fetch(`${url}/api/events?after=${beforeReplay.eventCursor}`, { signal: AbortSignal.timeout(3000) });
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let replayed = '';
  try {
    while (!replayed.includes('retained-before-subscribe')) {
      const { value, done } = await reader.read();
      if (done) break;
      replayed += decoder.decode(value, { stream: true });
    }
    assert(replayed.includes(`id: ${retained.id}\n`));
    assert(replayed.includes('retained-before-subscribe'));
    assert(!replayed.includes('gateway.ready'));
  } finally { await reader.cancel(); }
  const skillsResponse = await fetch(`${url}/api/skills`);
  assert.equal(skillsResponse.status, 200);
  assert.equal((await skillsResponse.json()).skills.length, 2);
  const detailResponse = await fetch(`${url}/api/skills/fixture-escape`);
  assert.equal(detailResponse.status, 200);
  assert.match(detailResponse.headers.get('content-type'), /application\/json/);
  assert((await detailResponse.json()).content.includes('<script>'));
  assert.equal((await fetch(`${url}/api/skills/not-installed`)).status, 404);
  assert.equal((await fetch(`${url}/api/sessions`, { method: 'POST', headers, body: JSON.stringify({ cwd: directory }) })).status, 400);
  const outside = join(directory, 'outside'); await mkdir(outside);
  await symlink(outside, join(config.workspaceRoot, 'escape'));
  assert.throws(() => app.workspace(join(config.workspaceRoot, 'escape')), /符号链接/);
  const created = await fetch(`${url}/api/sessions`, { method: 'POST', headers, body: '{}' });
  assert.equal(created.status, 201);
});

test('workspace escape is rejected before a missing directory is created', async t => {
  const { app, config, directory } = await setup(t);
  const outside = join(directory, 'outside');
  await mkdir(outside);
  await symlink(outside, join(config.workspaceRoot, 'escape'));
  assert.throws(() => app.workspace(join(config.workspaceRoot, 'escape', 'must-not-exist')), /符号链接/);
  await assert.rejects(access(join(outside, 'must-not-exist')), { code: 'ENOENT' });
});

test('stderr diagnostics redact common bearer and JWT credentials', () => {
  const secret = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signature123';
  const output = redact(`Authorization: Bearer tokenvalue access_token=abc123 ${secret} sk-exampleverylongkey`);
  assert(!output.includes(secret));
  assert(!output.includes('abc123'));
  assert(!output.includes('tokenvalue'));
  assert(!output.includes('sk-exampleverylongkey'));
});
