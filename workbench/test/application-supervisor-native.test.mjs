import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Application } from '../src/application.mjs';
import { NativeSupervisor } from '../src/application-supervisor-native.mjs';
import { readConfig } from '../src/config.mjs';
import { readModelRequestTraces } from '../src/model-request-traces.mjs';
import { createDocument } from '../shared/workflow/workflow-model.mjs';

class Offline extends EventEmitter {
  constructor() { super(); this.state = 'ready'; this.serverRequests = new Map(); this.calls = []; }
  async request(method) { this.calls.push(method); throw Error('The fixture must not call Hermes or execute business: ' + method); }
  async stop() {}
}

// These are native wire-shaped frames, including history WITHOUT an info field.
// No stub returns the application controller's imagined response shape.
class NativeTransport extends EventEmitter {
  constructor(f, config) {
    super(); this.f = f; this.config = config; this.state = 'stopped'; this.calls = []; this.frames = [];
    this.serverRequests = new Map(); this.answers = new Map(); this.prepared = new Map(); this.sessions = new Map();
  }
  async start() {
    this.state = 'ready'; this.emit('state', { state: 'ready' });
    await this.f.onStart?.(this);
  }
  async stop() { this.state = 'stopped'; this.emit('state', { state: 'stopped' }); }
  emitEvent(sid, type, payload) { this.emit('event', { type, session_id: sid, ...(payload ? { payload } : {}) }); }
  snapshot(sid, { lazy = false } = {}) {
    const row = this.sessions.get(sid);
    return { session_id: sid, stored_session_id: row.storedId, message_count: row.messages.length, messages: [],
      info: { ...row.route, ...(lazy ? { lazy: true } : { usage: structuredClone(row.usage) }), running: false } };
  }
  async request(method, args) {
    this.calls.push({ method, args: structuredClone(args) });
    if (method === 'config.get' && args.key === 'approvals.mode') return { value: this.f.approvalMode || 'smart' };
    if (method === 'session.create') {
      const sid = 'native-runtime-' + ++this.f.sequence, storedId = 'native-stored-' + this.f.sequence;
      const row = { storedId, route: { provider: args.provider, model: args.model }, messages: [], usage: { input: 0, output: 0, total: 0, calls: 0 } };
      this.sessions.set(sid, row); this.f.durable.set(storedId, row); return this.snapshot(sid, { lazy: true });
    }
    if (method === 'session.resume') {
      const row = this.f.durable.get(args.session_id); assert(row, 'a restart must use a previously persisted Hermes session');
      const sid = 'native-runtime-' + ++this.f.sequence; this.sessions.set(sid, row); return this.snapshot(sid, { lazy: true });
    }
    if (method === 'session.activate') {
      const snapshot = this.snapshot(args.session_id), row = this.sessions.get(args.session_id);
      // Real _live_session_payload does NOT return top-level stored_session_id.
      // It names the durable history in session_key and info.stored_session_id.
      const { stored_session_id, ...live } = snapshot;
      const result = { ...live, session_key: row.storedId, messages_omitted: args.omit_messages === true,
        running: false, status: 'idle', info: { ...snapshot.info,
          ...(this.f.activationInfoId === false ? {} : { stored_session_id: row.storedId }) } };
      (this.activations ||= []).push(result); return result;
    }
    if (method === 'session.history') {
      const messages = this.sessions.get(args.session_id).messages;
      return { count: messages.length, messages: structuredClone(messages) };
    }
    if (method === 'session.usage') return structuredClone(this.sessions.get(args.session_id).usage);
    if (method === 'workbench.supervisor.prepare') {
      this.prepared.set(args.session_id, args);
      const row = this.sessions.get(args.session_id);
      // A real lazy agent publishes session.info while prepare waits for build.
      this.emitEvent(args.session_id, 'session.info', { ...row.route, stored_session_id: row.storedId, usage: structuredClone(row.usage), running: false });
      await this.f.onPrepare?.(this, args);
      return { policy: { nativeAgent: true, toolsAllowed: true, memoryAllowed: true, applicationTools: 'native-functions', isolationVerified: true }, attachedImages: args.images?.length || 0 };
    }
    if (method === 'prompt.submit') {
      const row = this.sessions.get(args.session_id); row.messages.push({ role: 'user', text: args.text });
      setImmediate(() => { Promise.resolve(this.f.onSubmit(this, args)).catch(error => this.emitEvent(args.session_id, 'error', { message: error.message })); });
      if (this.f.submitAcknowledgement) await this.f.submitAcknowledgement;
      return { streaming: true };
    }
    if (method === 'session.interrupt') { this.interrupted = args.session_id; return { interrupted: true }; }
    if (method === 'session.close') return { closed: true };
    throw Error('Unexpected native protocol method ' + method);
  }
  async tool(sid, tool, args = {}, overrides = {}) {
    const prepared = this.prepared.get(sid), id = 'srq-tool-' + randomUUID();
    return this.ask({ jsonrpc: '2.0', id, method: 'workbench.tool.call', params: { session_id: sid,
      turn_id: prepared.turn_id, capability_token: prepared.capability_token, tool, arguments: args, call_id: 'call-' + randomUUID(), ...overrides } });
  }
  async ask(frame) {
    this.frames.push(frame); this.serverRequests.set(String(frame.id), frame);
    const answer = new Promise(resolve => this.answers.set(String(frame.id), resolve)); this.emit('request', frame); return answer;
  }
  toolReply(frame, result, error) {
    this.serverRequests.delete(String(frame.id));
    this.answers.get(String(frame.id))?.(error ? { error: error.message, code: error.code } : result);
    this.answers.delete(String(frame.id));
  }
  reply(id, result) {
    const frame = this.serverRequests.get(String(id)); assert(frame, 'an answer must bind a live native request');
    if (frame.method === 'approval') assert(['once', 'deny'].includes(result.choice));
    this.serverRequests.delete(String(id)); this.answers.get(String(id))?.(result); this.answers.delete(String(id));
  }
  complete(sid, { text = '原生 Hermes 已完成。', usage, status = 'complete', error, partial, storedId, settledInfo = true } = {}) {
    const row = this.sessions.get(sid);
    if (usage) row.usage = structuredClone(usage);
    if (storedId) { this.f.durable.delete(row.storedId); row.storedId = storedId; this.f.durable.set(storedId, row); }
    row.messages.push({ role: 'assistant', text });
    this.emitEvent(sid, 'message.complete', { text, usage: row.usage, status, ...(error ? { error } : {}), ...(partial ? { partial } : {}), reasoning: 'HIDDEN_REASONING_SENTINEL' });
    if (settledInfo) this.emitEvent(sid, 'session.info', { ...row.route, stored_session_id: row.storedId, usage: row.usage, running: false });
  }
}

async function until(read, label = 'native state') {
  for (let index = 0; index < 150; index++) { const value = read(); if (value) return value; await delay(5); }
  assert.fail('Expected ' + label);
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'native-supervisor-test-'));
  const config = { ...readConfig({ WORKBENCH_DATA_DIR: join(directory, 'data'), WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace') }), port: 4318 };
  const offline = new Offline(), app = new Application(config, offline);
  await app.workflowFoldersReady;
  app.captureModelRoute = async () => ({ provider: 'fixture-provider', model: 'fixture-model' });
  const f = { directory, config, app, offline, owner: app.applicationAssistant, sequence: 0, durable: new Map(), adapters: [], launches: [], progress: [], sessions: [], intents: [], proxyClosed: 0 };
  const runtimeRoot = join(directory, 'native-runtime'), work = join(runtimeRoot, 'work'); await mkdir(work, { recursive: true });
  f.dependencies = {
    profileFactory: async () => ({ runtimeRoot, work, profile: join(runtimeRoot, 'profile'), python: '/fixture/venv/bin/python3', dependencyRoots: ['/fixture/venv'], readOnlyRoots: [] }),
    sandboxFactory: async () => ({ status: 'verified', command: '/fixture/sandbox-exec', argsPrefix: ['-p', 'fixture-policy'], env: {} }),
    egressFactory: async () => ({ port: 51111, url: 'http://127.0.0.1:51111', close: async () => { f.proxyClosed++; } }),
    proxyEnvironment: async env => ({ env }),
    adapterFactory: options => { f.launches.push(options); const adapter = new NativeTransport(f, options); f.adapters.push(adapter); return adapter; },
  };
  f.create = title => f.owner.lifecycle.create({ clientConversationId: 'fixture-create-' + randomUUID(), title }).conversation.id;
  f.topic = f.create('隔离的原生总控主题');
  f.open = () => { f.native = new NativeSupervisor(app, f.owner, f.dependencies); return f.native; };
  f.restart = async () => { await f.native.close(); f.open(); };
  f.run = (options = {}) => f.native.run({ conversationId: f.topic, turnId: 'turn-' + randomUUID(), text: '读取工作台状态，保留已有工作流。',
    onProgress: (...args) => f.progress.push(args), onSession: id => f.sessions.push(id), onIntent: intent => f.intents.push(intent), ...options });
  f.onSubmit = async (adapter, { session_id: sid }) => {
    assert.deepEqual(await adapter.tool(sid, 'conversation.route', { intent: 'discuss' }), { accepted: true, intent: 'discuss' });
    adapter.complete(sid);
  };
  f.open();
  t.after(async () => { await f.native.close(); await app.close(); await rm(directory, { recursive: true, force: true }); });
  return f;
}

test('two human turns in a topic reuse a native session and import legacy prose only on the first turn', async t => {
  const f = await fixture(t), history = [{ id: 'legacy-turn', user: { text: 'LEGACY_VISIBLE_REQUEST' }, assistant: { text: 'LEGACY_VISIBLE_ANSWER' }, status: 'complete' }];
  const first = await f.run({ history }); const firstStored = f.native.sessions.get(f.topic).storedSessionId;
  const second = await f.run({ history: [...history, { id: 'latest-old-turn', user: { text: 'MUST_NOT_REINTRODUCE' }, assistant: { text: 'old' } }] });
  assert.equal(first.native.persistent, true); assert.equal(second.native.runtime, 'hermes');
  assert.equal(f.adapters.length, 1);
  const calls = f.adapters[0].calls, preparations = calls.filter(row => row.method === 'workbench.supervisor.prepare');
  assert.equal(calls.filter(row => row.method === 'session.create').length, 1);
  assert.equal(calls.filter(row => row.method === 'session.activate').length, 1);
  assert.equal(calls.find(row => row.method === 'session.activate').args.omit_messages, true);
  assert.equal(Object.hasOwn(f.adapters[0].activations[0], 'stored_session_id'), false);
  assert.equal(f.adapters[0].activations[0].info.stored_session_id, firstStored);
  assert.equal(calls.filter(row => row.method === 'prompt.submit').length, 2);
  assert.equal(preparations[0].args.session_id, preparations[1].args.session_id);
  assert.notEqual(preparations[0].args.capability_token, preparations[1].args.capability_token);
  assert.doesNotMatch(preparations[1].args.system_prompt, /LEGACY_VISIBLE|MUST_NOT_REINTRODUCE/);
  const submissions = calls.filter(row => row.method === 'prompt.submit');
  assert.match(submissions[0].args.text, /LEGACY_VISIBLE_REQUEST/);
  assert.match(submissions[0].args.text, /LEGACY_VISIBLE_ANSWER/);
  assert.match(submissions[0].args.text, /"authorizationRestored":false/);
  assert.doesNotMatch(submissions[1].args.text, /LEGACY_VISIBLE|MUST_NOT_REINTRODUCE/);
  assert.equal(f.native.sessions.get(f.topic).storedSessionId, firstStored);
  assert.deepEqual(f.intents, ['discuss', 'discuss']);
  assert.equal(f.launches[0].childEnv.HERMES_DISABLE_LAZY_INSTALLS, '1');
  assert.equal(f.launches[0].childEnv.WORKBENCH_SUPERVISOR_ISOLATED, '1');
  assert.equal(f.launches[0].args.at(-2), '/fixture/venv/bin/python3');
  assert.deepEqual(f.offline.calls, [], 'the legacy model broker and business runtime are not used');
});

test('restart resumes the stored Hermes session without importing old prose or replaying a completed turn', async t => {
  const f = await fixture(t), turnId = 'one-human-turn'; await f.run({ turnId });
  const stored = f.native.sessions.get(f.topic).storedSessionId;
  await f.restart();
  await assert.rejects(f.run({ turnId }), /已经登记|已经结束|重放/);
  assert.equal(f.adapters.length, 1, 'a replay is rejected before starting another runtime');
  await f.run({ history: [{ id: 'do-not-seed', user: { text: 'OLD_CONTEXT_SENTINEL' } }] });
  await f.run();
  const second = f.adapters[1], resume = second.calls.find(row => row.method === 'session.resume');
  assert.equal(resume.args.session_id, stored); assert.equal(resume.args.inline_images, false); assert.equal(resume.args.lazy, undefined);
  assert.equal(second.calls.filter(row => row.method === 'session.create').length, 0);
  assert.equal(second.calls.filter(row => row.method === 'session.activate').length, 1, 'the resumed session is reusable on the next turn');
  assert.doesNotMatch(second.calls.find(row => row.method === 'workbench.supervisor.prepare').args.system_prompt, /OLD_CONTEXT_SENTINEL/);
});

test('hot activation can retain history through the native session_key fallback without a top-level stored id', async t => {
  const f = await fixture(t); await f.run();
  const stored = f.native.sessions.get(f.topic).storedSessionId;
  f.activationInfoId = false;
  await f.run();
  const activation = f.adapters[0].activations[0];
  assert.equal(Object.hasOwn(activation, 'stored_session_id'), false);
  assert.equal(Object.hasOwn(activation.info, 'stored_session_id'), false);
  assert.equal(activation.session_key, stored);
  assert.equal(f.native.sessions.get(f.topic).storedSessionId, stored);
});

test('native history paginates only the current topic and streams visible prose without restoring old authority', async t => {
  const f = await fixture(t), other = f.create('另一个历史主题'), collected = [];
  const seed = (topic, id, user, assistant) => {
    const at = '2026-10-30T00:00:00.000Z';
    f.owner.insertTurn({ id, user: { text: user, intent: 'workflow', context: { token: 'PRIVATE_SCOPE_SENTINEL' } },
      assistant: { text: assistant, reasoning: 'HIDDEN_REASONING_SENTINEL', operations: [{ authority: 'PRIVATE_ACTION_SENTINEL' }] },
      actions: [{ command: 'PRIVATE_ACTION_SENTINEL' }], permissionScope: { sourceRepair: true, marker: 'PRIVATE_SCOPE_SENTINEL' },
      status: 'complete', createdAt: at, updatedAt: at }, 'fixture-seed-' + id, 'fixture-digest-' + id, topic);
  };
  const oldUser = '创建一个旧测试工作流。' + 'U'.repeat(1200), oldAnswer = 'VISIBLE_BODY_START-' + 'A'.repeat(10000) + '-VISIBLE_BODY_END';
  seed(f.topic, 'history-oldest', oldUser, oldAnswer);
  seed(f.topic, 'history-middle', '当前主题第二条', '当前主题第二条答复');
  seed(f.topic, 'history-latest', '当前主题第三条', '当前主题第三条答复');
  seed(other, 'history-foreign', 'FOREIGN_TOPIC_PRIVATE_USER', 'FOREIGN_TOPIC_PRIVATE_ASSISTANT');
  f.onSubmit = async (adapter, { session_id: sid }) => {
    const beforeRoute = await adapter.tool(sid, 'conversation.history', {}); assert.match(beforeRoute.error, /先通过/);
    await adapter.tool(sid, 'conversation.route', { intent: 'workflow' });
    const first = await adapter.tool(sid, 'conversation.history', { limit: 2 }); collected.push(first);
    assert.equal(first.readOnly, true); assert.equal(first.authorizationRestored, false);
    assert.deepEqual(first.turns.map(row => row.turnId), ['history-latest', 'history-middle']);
    assert.equal(first.nextBeforeTurnId, 'history-middle');
    const second = await adapter.tool(sid, 'conversation.history', { limit: 2, beforeTurnId: first.nextBeforeTurnId }); collected.push(second);
    assert.deepEqual(second.turns.map(row => row.turnId), ['history-oldest']); assert.equal(second.nextBeforeTurnId, null);
    assert.equal(second.turns[0].truncated, true); assert(second.turns[0].user.length <= 800); assert(second.turns[0].assistant.length <= 800);
    const chunks = []; let offset = 0;
    do {
      const part = await adapter.tool(sid, 'conversation.history', { turnId: 'history-oldest', offset }); collected.push(part);
      assert.equal(part.turnId, 'history-oldest'); assert.equal(part.offset, offset); assert(part.text.length <= 8000);
      assert.equal(part.readOnly, true); assert.equal(part.authorizationRestored, false);
      chunks.push(part.text); offset = part.nextOffset;
    } while (offset !== null);
    assert.deepEqual(JSON.parse(chunks.join('')), { user: oldUser, assistant: oldAnswer });
    for (const args of [{ turnId: 'history-foreign' }, { beforeTurnId: 'history-foreign' },
      { conversationId: other }, { turnId: 'history-oldest', beforeTurnId: 'history-middle' },
      { offset: 1 }, { limit: 0 }, { limit: 21 }, { turnId: 'history-oldest', offset: 100001 }]) {
      const declined = await adapter.tool(sid, 'conversation.history', args); collected.push(declined);
      assert.equal(typeof declined.error, 'string');
    }
    // Even a historically authorized request cannot replace the current human
    // request. This call would be structurally valid if authorization were restored.
    const declined = await adapter.tool(sid, 'workflow.create-test', { title: '不能从旧聊天授权创建', expectedRevision: 0, operationId: 'historical-authority-replay' });
    assert.match(declined.error, /没有明确授权/); adapter.complete(sid);
  };
  await f.run({ text: '查看当前主题的历史聊天正文。' });
  assert.equal(f.app.workflowLibrary.list().length, 0);
  assert.doesNotMatch(JSON.stringify(collected), /PRIVATE_SCOPE_SENTINEL|PRIVATE_ACTION_SENTINEL|HIDDEN_REASONING_SENTINEL|FOREIGN_TOPIC_PRIVATE/);
  assert.deepEqual(f.offline.calls, []);
});

test('transport replacement resumes durable history and ignores late frames from the disconnected process', async t => {
  const f = await fixture(t); await f.run();
  const first = f.adapters[0], stored = f.native.sessions.get(f.topic).storedSessionId;
  first.state = 'disconnected'; first.emit('state', { state: 'disconnected' });
  f.onSubmit = async (adapter, { session_id: sid }) => {
    await adapter.tool(sid, 'conversation.route', { intent: 'discuss' });
    // An old emitter must not settle or cancel the new transport's active turn.
    first.emit('state', { state: 'disconnected' });
    first.emitEvent(sid, 'error', { message: 'STALE_TRANSPORT_ERROR' });
    adapter.complete(sid, { text: 'New transport retained the same conversation.' });
  };
  const answer = await f.run();
  assert.equal(answer.text, 'New transport retained the same conversation.');
  assert.equal(f.adapters.length, 2);
  const second = f.adapters[1];
  assert.equal(second.calls.filter(row => row.method === 'session.activate').length, 0, 'a new process cannot activate the previous runtime id');
  assert.equal(second.calls.find(row => row.method === 'session.resume').args.session_id, stored);
  assert.equal(second.calls.filter(row => row.method === 'prompt.submit').length, 1);
  assert.equal(f.native.sessions.get(f.topic).storedSessionId, stored);
});

test('native application callbacks require routing, current turn identity and host permissions', async t => {
  const f = await fixture(t); let result;
  f.onSubmit = async (adapter, { session_id: sid }) => {
    const before = await adapter.tool(sid, 'workflows.list'); assert.match(before.error, /先通过/);
    const forged = await adapter.tool(sid, 'conversation.route', { intent: 'diagnose' }, { capability_token: 'invalid-token' });
    assert.match(forged.error, /不属于/);
    assert.deepEqual(await adapter.tool(sid, 'conversation.route', { intent: 'diagnose' }), { accepted: true, intent: 'diagnose' });
    result = await adapter.tool(sid, 'workflows.list');
    const denied = await adapter.tool(sid, 'app.source.patch', { path: 'src/config.mjs', content: 'malicious' });
    assert.match(denied.error, /没有开放/);
    adapter.complete(sid);
  };
  await f.run();
  assert(result && typeof result === 'object' && !result.error);
  const prepared = f.adapters[0].calls.find(row => row.method === 'workbench.supervisor.prepare').args;
  assert(!prepared.tools.some(tool => tool.name === 'app.source.patch'));
  assert.equal(f.app.assistantPermissionSettings.get().supervisor.sourceRepair, false);
  assert.equal(f.native.requests(f.topic).length, 0, 'capability-bearing callbacks never become browser prompts');
});

test('native browser captures transfer only reauthorized PNG bytes and keep binary data out of later tool evidence', async t => {
  const f = await fixture(t), png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const verifiedPath = join(f.directory, 'verified-capture.png'); await writeFile(verifiedPath, png);
  const sourcePath = '/host-private-browser/screenshot.png', fileRequests = [];
  const originalCall = f.owner.call.bind(f.owner); let captureCalls = 0, laterEvidence, receipt, forbiddenArgument, forbiddenFile;
  f.owner.call = async (name, args, context) => {
    if (name === 'browser.capture') {
      captureCalls++;
      return { value: { id: 'fixture-capture' }, images: [captureCalls === 1 ? sourcePath : '/host-private-browser/secrets.txt'] };
    }
    if (name === 'workflows.list') laterEvidence = structuredClone(context.toolEvidence);
    return originalCall(name, args, context);
  };
  f.app.diagnosticBrowser.file = async (id, filename) => {
    fileRequests.push({ id, filename });
    if (id !== 'fixture-capture' || filename !== 'screenshot.png') throw Error('capture file is not authorized');
    return { path: verifiedPath, mimeType: 'image/png', size: png.length };
  };
  f.onSubmit = async (adapter, { session_id: sid }) => {
    await adapter.tool(sid, 'conversation.route', { intent: 'diagnose' });
    receipt = await adapter.tool(sid, 'browser.capture', { route: '#/board', mode: 'screenshot' });
    assert(!(await adapter.tool(sid, 'workflows.list')).error);
    forbiddenArgument = await adapter.tool(sid, 'browser.capture', { route: '#/board', mode: 'screenshot', path: '/host-private-browser/secrets.txt' });
    forbiddenFile = await adapter.tool(sid, 'browser.capture', { route: '#/board', mode: 'screenshot' });
    adapter.complete(sid);
  };
  await f.run();
  assert.deepEqual(receipt.images, []);
  assert.deepEqual(receipt._nodeorchard_images, [{ mimeType: 'image/png', data: png.toString('base64') }]);
  assert(Buffer.from(receipt._nodeorchard_images[0].data, 'base64').equals(png));
  assert(!JSON.stringify(receipt).includes(sourcePath), 'the claimed host path is replaced with approved file contents');
  assert.deepEqual(fileRequests, [{ id: 'fixture-capture', filename: 'screenshot.png' }, { id: 'fixture-capture', filename: 'secrets.txt' }]);
  assert.equal(captureCalls, 2, 'the model cannot add an arbitrary path to the browser.capture schema');
  assert(forbiddenArgument.error); assert.match(forbiddenFile.error, /not authorized/);
  assert.equal(laterEvidence.length, 1); assert.equal(laterEvidence[0].tool, 'browser.capture');
  assert.deepEqual(laterEvidence[0].result.images, []);
  assert(!JSON.stringify(laterEvidence).includes(png.toString('base64')));
  assert(!Object.hasOwn(laterEvidence[0].result, '_nodeorchard_images'));
  assert.deepEqual(f.offline.calls, []);
});

test('a permission revision change rejects pending tool callbacks without changing the human setting', async t => {
  const f = await fixture(t); let denied;
  f.onSubmit = async (adapter, { session_id: sid }) => {
    await adapter.tool(sid, 'conversation.route', { intent: 'diagnose' });
    const settings = f.app.assistantPermissionSettings.get();
    f.app.assistantPermissionSettings.save({ expectedRevision: settings.revision, workflow: settings.workflow,
      supervisor: { ...settings.supervisor, appLogs: false }, modelExperimentLimits: settings.modelExperimentLimits });
    denied = await adapter.tool(sid, 'app.logs', {}); adapter.complete(sid);
  };
  await f.run(); assert.match(denied.error, /权限已变化/);
  assert.equal(f.app.assistantPermissionSettings.get().supervisor.appLogs, false);
  assert.equal(f.app.assistantPermissionSettings.get().supervisor.sourceRepair, false);
});

test('a discuss intent permits normal inspection but does not admit diagnosis, proposals or application writes', async t => {
  const f = await fixture(t), declined = [];
  f.onSubmit = async (adapter, { session_id: sid }) => {
    await adapter.tool(sid, 'conversation.route', { intent: 'discuss' });
    for (const tool of ['app.logs', 'assistant.diagnose', 'workflow.propose', 'workflow.create-test']) {
      const result = await adapter.tool(sid, tool, {}); declined.push(result);
      assert.equal(result.code, 'SUPERVISOR_INTENT_SCOPE');
      assert.match(result.error, /咨询/);
    }
    assert(!(await adapter.tool(sid, 'workflows.list')).error);
    adapter.complete(sid);
  };
  await f.run(); assert.equal(declined.length, 4);
  assert.equal(f.app.workflowLibrary.list().length, 0);
  assert.deepEqual(f.offline.calls, []);
});

test('equivalent application mutations share a host operation id despite model id or JSON key-order changes', async t => {
  const f = await fixture(t), receipts = [], document = createDocument({ schemaVersion: 2, title: '幂等验证草稿' });
  const reverseKeys = value => Array.isArray(value) ? value.map(reverseKeys) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, reverseKeys(value[key])])) : value;
  f.onSubmit = async (adapter, { session_id: sid }) => {
    await adapter.tool(sid, 'conversation.route', { intent: 'workflow' });
    receipts.push(await adapter.tool(sid, 'workflow.create-test', { title: '幂等校验', expectedRevision: 0,
      document, operationId: 'model-invented-first-id' }));
    receipts.push(await adapter.tool(sid, 'workflow.create-test', { operationId: 'model-invented-second-id',
      document: reverseKeys(document), expectedRevision: 0, title: '幂等校验' }));
    adapter.complete(sid);
  };
  await f.run({ text: '创建一个名为幂等校验的测试工作流，不要运行。' });
  assert.equal(receipts[0].status, 'complete'); assert.equal(receipts[0].runStarted, false);
  assert.deepEqual(receipts[1], receipts[0]);
  assert.equal(f.app.workflowLibrary.list().length, 1, 'retrying equivalent content must not create another workflow');
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS count FROM workflow_runs').get().count, 0);
  assert.deepEqual(f.offline.calls, []);
});

test('manual native approval and clarification stay attached to their topic and expire after completion', async t => {
  const f = await fixture(t), other = f.create('另一个主题'), answers = [];
  f.onSubmit = async (adapter, { session_id: sid }) => {
    await adapter.tool(sid, 'conversation.route', { intent: 'discuss' });
    answers.push(await adapter.ask({ jsonrpc: '2.0', id: 'srq-approval-1', method: 'approval', params: { session_id: sid, request_id: 'native-queue-1', command: 'echo fixture', choices: ['once', 'deny'] } }));
    answers.push(await adapter.ask({ jsonrpc: '2.0', id: 'srq-clarify-1', method: 'clarify', params: { session_id: sid, question: 'Choose a fixture value', choices: ['A', 'B'] } }));
    adapter.complete(sid);
  };
  const pending = f.run(); pending.catch(() => {});
  const approval = await until(() => f.native.requests(f.topic).find(row => row.method === 'approval'), 'approval card');
  assert.equal(f.native.requests(other).length, 0);
  await assert.rejects(f.native.reply(other, approval.id, { choice: 'once' }), /不属于/);
  await f.native.reply(f.topic, approval.id, { choice: 'once' });
  const clarify = await until(() => f.native.requests(f.topic).find(row => row.method === 'clarify'), 'clarification card');
  await f.native.reply(f.topic, clarify.id, { answer: 'A' }); await pending;
  assert.deepEqual(answers, [{ choice: 'once' }, { answer: 'A' }]);
  assert.deepEqual(f.native.requests(f.topic), []);
  await assert.rejects(f.native.reply(f.topic, approval.id, { choice: 'deny' }), /已经结束/);
});

test('stopping a native turn interrupts once and a reconnect never replays its message', async t => {
  const f = await fixture(t), controller = new AbortController(), turnId = 'cancelled-human-turn';
  f.onSubmit = async (adapter, { session_id: sid }) => { await adapter.tool(sid, 'conversation.route', { intent: 'discuss' }); };
  const pending = f.run({ turnId, signal: controller.signal }); pending.catch(() => {});
  await until(() => f.adapters[0]?.calls.some(row => row.method === 'prompt.submit'), 'submitted native turn');
  controller.abort(); await assert.rejects(pending, /已停止/);
  assert.equal(f.adapters[0].calls.filter(row => row.method === 'session.interrupt').length, 1);
  await f.restart(); await assert.rejects(f.run({ turnId }), /已经登记|已经结束|重放/);
  assert.equal(f.adapters.length, 1);
});

test('closing an active native run drains its durable finalization before disconnecting or allowing the store to close', async t => {
  const f = await fixture(t), turnId = 'shutdown-human-turn'; let acknowledge;
  f.submitAcknowledgement = new Promise(resolve => { acknowledge = resolve; });
  f.onSubmit = async (adapter, { session_id: sid }) => { await adapter.tool(sid, 'conversation.route', { intent: 'discuss' }); };
  const pending = f.run({ turnId }); pending.catch(() => {});
  await until(() => f.adapters[0]?.calls.some(row => row.method === 'prompt.submit'), 'native turn waiting for submit acknowledgement');
  let closeSettled = false;
  const closing = f.native.close().then(() => { closeSettled = true; }); closing.catch(() => {});
  let prematurelyClosed;
  try { await delay(10); prematurelyClosed = closeSettled; }
  finally { acknowledge(); }
  await closing;
  const error = await pending.then(() => assert.fail('closing must interrupt the native turn'), error => error);
  assert.equal(prematurelyClosed, false, 'close must wait until the already submitted turn has finished its persistence path');
  assert.match(error.message, /关闭|已停止|连接已断开/);
  assert(['MODEL_ABORTED', 'SUPERVISOR_DISCONNECTED'].includes(error.code));
  assert.doesNotMatch(error.message, /完成事件不属于|database.*closed/i);
  const record = f.native.sessions.get(f.topic);
  assert.equal(record.status, 'interrupted'); assert.equal(record.activeTurnId, null); assert.equal(record.runtimeSessionId, null);
  assert.deepEqual(f.native.requests(f.topic), []);
  assert.equal(f.adapters[0].calls.filter(row => row.method === 'prompt.submit').length, 1);
  await f.restart(); await assert.rejects(f.run({ turnId }), /已经登记|已经结束|重放/);
});

test('concurrent native artifact callbacks reserve the per-turn quota before publishing files', async t => {
  const f = await fixture(t), publications = [], replies = [], visibleArtifacts = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.native.artifacts.publish = async args => {
    const index = publications.length; publications.push(structuredClone(args));
    await gate;
    return { id: 'fixture-artifact-' + index, name: 'result-' + index + '.png', mimeType: 'image/png', size: 12 };
  };
  f.onSubmit = async (adapter, { session_id: sid }) => {
    await adapter.tool(sid, 'conversation.route', { intent: 'discuss' });
    await Promise.all(Array.from({ length: 17 }, (_, index) => adapter.tool(sid, 'conversation.artifact', {
      path: '/fixture-output/result-' + index + '.png',
    }).then(result => { replies[index] = result; })));
    adapter.complete(sid);
  };
  const pending = f.run({ onArtifacts: artifacts => visibleArtifacts.push(structuredClone(artifacts)) }); pending.catch(() => {});
  let admittedBeforeRelease, rejectedBeforeRelease, observationError;
  try {
    await until(() => publications.length + replies.filter(Boolean).length === 17, 'all parallel artifact admission decisions');
    admittedBeforeRelease = publications.length;
    rejectedBeforeRelease = replies.filter(reply => reply?.error).length;
  } catch (error) { observationError = error; }
  finally { release(); }
  const result = await pending;
  if (observationError) throw observationError;
  assert.equal(admittedBeforeRelease, 16, 'an awaited publication must already occupy a quota slot');
  assert.equal(rejectedBeforeRelease, 1, 'the seventeenth callback must be rejected without waiting for file publication');
  assert.equal(publications.length, 16);
  assert.match(replies.find(reply => reply?.error).error, /最多.*16|16个附件/);
  assert.equal(replies.filter(reply => reply.delivered).length, 16);
  assert.equal(result.nativeArtifacts.length, 16);
  assert(visibleArtifacts.every(artifacts => artifacts.length <= 16));
  assert.equal(f.adapters[0].serverRequests.size, 0); assert.equal(f.adapters[0].answers.size, 0);
  assert.deepEqual(f.native.requests(f.topic), []);
});

test('native usage uses session.usage rather than nonexistent history.info and does not double count early snapshots', async t => {
  const f = await fixture(t);
  f.onSubmit = async (adapter, { session_id: sid }) => {
    await adapter.tool(sid, 'conversation.route', { intent: 'discuss' });
    const row = adapter.sessions.get(sid), baseline = row.usage;
    adapter.complete(sid, { usage: { input: baseline.input + 100, output: baseline.output + 20, total: baseline.total + 120, calls: baseline.calls + 2,
      context_used: 3000, context_max: 20000, context_percent: 15, context_source: 'provider_usage', context_estimated: false } });
  };
  await f.run(); await f.restart(); await f.run();
  const secondAdapter = f.adapters[1]; assert(secondAdapter.calls.some(row => row.method === 'session.usage'));
  const usage = f.app.sessionUsage.read(f.sessions.at(-1));
  assert.equal(usage.usage.input, 100); assert.equal(usage.usage.output, 20); assert.equal(usage.usage.total, 120); assert.equal(usage.usage.calls, 2);
  assert.equal(usage.usage.context_used, 3000); assert.equal(usage.usage.context_max, 20000);
  assert.equal(usage.usage.context_source, 'provider_usage'); assert.equal(usage.usage.context_estimated, false);
  const runUsage = f.app.sessionUsage.runs().find(row => row.sessionId === f.sessions.at(-1));
  assert.equal(runUsage.status, 'measured'); assert.equal(runUsage.final, true); assert.equal(runUsage.usage.input, 100);
});

test('native compression persists the new stored identity and hidden reasoning never enters the visible answer', async t => {
  const f = await fixture(t);
  f.onSubmit = async (adapter, { session_id: sid }) => {
    await adapter.tool(sid, 'conversation.route', { intent: 'discuss' });
    adapter.emitEvent(sid, 'reasoning.delta', { text: 'HIDDEN_REASONING_SENTINEL' });
    adapter.emitEvent(sid, 'thinking.delta', { text: 'HIDDEN_REASONING_SENTINEL' });
    adapter.emitEvent(sid, 'message.delta', { text: 'Visible draft' });
    adapter.complete(sid, { text: 'Visible authoritative answer', storedId: 'compressed-native-tip' });
  };
  const result = await f.run(); assert.equal(result.text, 'Visible authoritative answer');
  assert.equal(f.native.sessions.get(f.topic).storedSessionId, 'compressed-native-tip');
  assert(!JSON.stringify([result, f.progress]).includes('HIDDEN_REASONING_SENTINEL'));
  await f.restart(); await f.run();
  assert.equal(f.adapters[1].calls.find(row => row.method === 'session.resume').args.session_id, 'compressed-native-tip');
});

test('a delayed compression identity is accepted from the next authoritative native snapshot', async t => {
  const f = await fixture(t); let count = 0;
  f.onSubmit = async (adapter, { session_id: sid }) => {
    await adapter.tool(sid, 'conversation.route', { intent: 'discuss' });
    adapter.complete(sid, ++count === 1 ? { storedId: 'late-compressed-native-tip', settledInfo: false } : {});
  };
  await f.run();
  await f.run();
  assert.equal(f.native.sessions.get(f.topic).storedSessionId, 'late-compressed-native-tip');
});

test('request traces are bound to the current native call and their metadata projection drops source content', async t => {
  const f = await fixture(t);
  f.onSubmit = async (adapter, { session_id: sid }) => {
    await adapter.tool(sid, 'conversation.route', { intent: 'diagnose' });
    const prepared = adapter.prepared.get(sid), at = new Date().toISOString();
    const raw = { version: 1, traceId: randomUUID(), requestId: prepared.request_id, requestIndex: 1, status: 'complete', startedAt: at, updatedAt: at,
      durationMs: 100, bodyComplete: true, transport: 'httpx', observability: { dns: 'unavailable', connect: 'observed', tls: 'observed', headers: 'observed', sse: 'observed' },
      timings: { connectMs: 10, tlsMs: 20, headersMs: 30 }, http: { status: 200, requestId: 'upstream-fixture', requestIdHeader: 'x-request-id' },
      sse: { events: { 'response.completed': 1 }, otherEvents: 0, truncated: false }, error: { source: null, type: null }, prompt: 'PRIVATE_TRACE_BODY' };
    adapter.emitEvent('foreign-runtime', 'model.request.trace', { trace: raw });
    adapter.emitEvent(sid, 'model.request.trace', { trace: { ...raw, requestId: randomUUID() } });
    adapter.emitEvent(sid, 'model.request.trace', { trace: raw }); adapter.complete(sid);
  };
  await f.run(); const trace = readModelRequestTraces(f.app.store.db, f.sessions[0]);
  assert.equal(trace.requestCount, 1); assert.equal(trace.requests[0].http.requestId, 'upstream-fixture');
  assert(!JSON.stringify(trace).includes('PRIVATE_TRACE_BODY'));
});

test('sandbox unavailability fails closed and startup errors keep their real cause before the model turn exists', async t => {
  await t.test('unavailable isolation never launches a native adapter or legacy model', async sub => {
    const f = await fixture(sub); await f.native.close();
    f.dependencies.sandboxFactory = async () => ({ status: 'unavailable' }); f.open();
    await assert.rejects(f.run(), { code: 'SUPERVISOR_SANDBOX_UNAVAILABLE' });
    assert.equal(f.adapters.length, 0); assert.deepEqual(f.offline.calls, []);
  });
  await t.test('early transport disconnect is not replaced by an undefined reject TypeError', async sub => {
    const f = await fixture(sub); f.onStart = async adapter => { adapter.emit('state', { state: 'disconnected' }); throw Object.assign(Error('fixture transport disconnected'), { code: 'SUPERVISOR_DISCONNECTED' }); };
    await assert.rejects(f.run(), { code: 'SUPERVISOR_DISCONNECTED' });
    assert.equal(f.adapters[0].calls.filter(row => row.method === 'prompt.submit').length, 0);
  });
  await t.test('disabled native approvals fail closed before creating or submitting a model session', async sub => {
    const f = await fixture(sub); f.approvalMode = 'none';
    await assert.rejects(f.run(), { code: 'POLICY_APPROVAL_REQUIRED' });
    const calls = f.adapters[0].calls;
    assert(calls.some(row => row.method === 'config.get' && row.args.key === 'approvals.mode'));
    assert.equal(calls.filter(row => ['session.create', 'session.resume', 'prompt.submit'].includes(row.method)).length, 0);
    assert.deepEqual(f.offline.calls, []);
  });
});
