import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowConversationUI, conversationContext, conversationTurnGroups, canDismissConversationTurn, conversationDiagnosticProgress } from '../public/workflow-conversation-ui.js';
import { ApplicationConversationUI } from '../public/application-conversation-ui.js';
import { createDocument, createNode } from '../shared/workflow/workflow-model.mjs';
import { documentFingerprint, applyWorkflowOperations } from '../shared/workflow/workflow-conversation-commands.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
function fixture() {
  const document = createDocument({ schemaVersion: 2 }); document.nodes = [createNode('transform', { x: 0, y: 0 }, { id: 'trim', title: '清理文本' })];
  const artifact = { id: 'image-one', nodeId: 'trim', sha256: 'a'.repeat(64), attempt: 2 }, run = { id: 'run-one', workflowId: document.id, document: structuredClone(document), nodes: { trim: { attempt: 2, attemptId: 'attempt-two', artifacts: [artifact] } } }; return { document, run, artifact };
}
function harness() {
  const { document, run } = fixture(), ui = Object.create(WorkflowConversationUI.prototype);
  Object.assign(ui, { editor: { doc: document, selection: new Set(['trim']), libraryReadOnly: false }, workflowId: document.id, states: new Map(), applied: new Map(), actionPending: new Set(), runtime: { runs: new Map([[run.id, run]]), currentRun: () => run }, input: { value: '', focus() {} }, messages: { scrollTop: 0, scrollHeight: 100 }, render() {}, renderNotice() {}, renderContext() {}, toggle() {}, schedulePoll() {} });
  ui.state().loaded = true; return { ui, document, run };
}
const snapshot = (id, revision, turns = []) => ({ conversation: { workflowId: id, revision, turns }, pending: [] });
const validProposal = (id, turn, document) => {
  let generated = 0;
  return { valid: true, workflowId: id, turnId: turn.id, planFingerprint: turn.assistant.baseFingerprint, permissionRevision: 1,
    resultFingerprint: documentFingerprint(applyWorkflowOperations(document, turn.assistant.operations, { idFactory: prefix => `${prefix}-${turn.id}-${++generated}` }).document) };
};

test('unloading conversation clears UI bindings and timers while preserving its draft and rejecting late reads', async t => {
  const { ui, document } = harness(), gate = deferred(), requests = [], callbacks = [];
  ui.api = async (path, options) => { requests.push({ path, options }); return gate.promise; };
  const saved = ui.state(); saved.draft = '保留未发送的说明'; saved.conversation.turns = [{ id: 'running-turn', status: 'thinking' }];
  const reading = ui.load(true); ui.attachment = { workflowId: document.id, nodeId: 'trim' };
  for (const timer of ['pollTimer', 'pendingRefreshTimer', 'progressTimer']) { ui[timer] = setTimeout(() => callbacks.push(timer), 10_000); t.after(() => clearTimeout(ui[timer])); }
  ui.panel = { hidden: false }; ui.openButton = { hidden: false }; ui.editor.root = { classList: { remove() {} } };
  t.after(() => gate.resolve(snapshot(document.id, 2)));
  ui.editor.documentLoaded = false; ui.unloadDocument();
  assert.equal(ui.workflowId, null); assert.equal(ui.attachment, null); assert.equal(ui.panel.hidden, true); assert.equal(ui.openButton.hidden, true);
  assert.equal(saved.draft, '保留未发送的说明'); assert.equal(saved.loading, false);
  assert.equal(saved.conversation.turns[0].status, 'thinking');
  gate.resolve(snapshot(document.id, 2, [{ id: 'late-turn', status: 'complete' }])); await reading;
  assert.equal(saved.conversation.turns[0].id, 'running-turn');
  ui.syncWorkflow(); await ui.load(true); WorkflowConversationUI.prototype.schedulePoll.call(ui); ui.scheduleProgressClock();
  ui.onEvent({ type: 'workflow.conversation', payload: snapshot(document.id, 3, [{ id: 'event-turn' }]) });
  assert.equal(ui.workflowId, null); assert.equal(requests.length, 1); assert(requests.every(request => !request.options?.method));
  assert.equal(saved.conversation.turns[0].id, 'running-turn'); assert.equal(ui.states.has(null), false); assert.deepEqual(callbacks, []);
});

for (const hidden of [false, true]) test(`reloading a conversation restores its ${hidden ? 'collapsed' : 'open'} panel after repeated unloads`, () => {
  const { ui } = harness(), classes = new Set(hidden ? [] : ['wf-chat-open']);
  ui.panel = { hidden }; ui.openButton = { hidden: !hidden }; ui.load = async () => {};
  ui.editor.root = { classList: { remove: name => classes.delete(name), toggle(name, show) { if (show) classes.add(name); else classes.delete(name); } } };
  ui.editor.documentLoaded = false; ui.unloadDocument(); ui.unloadDocument(); ui.syncWorkflow();
  assert.equal(ui.panel.hidden, true); assert.equal(ui.openButton.hidden, true); assert.equal(classes.has('wf-chat-open'), false);
  ui.editor.documentLoaded = true; ui.syncWorkflow();
  assert.equal(ui.panel.hidden, hidden); assert.equal(ui.openButton.hidden, !hidden); assert.equal(classes.has('wf-chat-open'), !hidden);
  // A later manual visibility change becomes the next unload's saved state.
  ui.panel.hidden = !hidden; ui.editor.documentLoaded = false; ui.unloadDocument();
  ui.editor.documentLoaded = true; ui.syncWorkflow();
  assert.equal(ui.panel.hidden, !hidden); assert.equal(ui.openButton.hidden, hidden); assert.equal(classes.has('wf-chat-open'), hidden);
});

test('a message acknowledgement arriving after unload cannot consume its preserved draft or repaint conversation', async () => {
  const { ui, document } = harness(), gate = deferred(); let renders = 0;
  ui.state().draft = '归档前已提交但待确认的原文'; const saved = ui.state(); ui.api = async () => gate.promise;
  const sending = ui.send(); ui.editor.documentLoaded = false; ui.unloadDocument(); ui.render = () => renders++;
  gate.resolve(snapshot(document.id, 2, [{ id: 'late-message', status: 'thinking' }])); await sending;
  assert.equal(saved.draft, '归档前已提交但待确认的原文'); assert.equal(saved.conversation.turns.length, 0); assert.equal(saved.sending, false);
  assert.equal(renders, 0); assert.equal(ui.workflowId, null);
});

test('a natural resolution message targets the focused issue and waits for the server to retire it', async () => {
  const { ui, document, run } = harness(), old = { id: 'focused-issue', status: 'error', user: { text: '采集失败', context: { runId: run.id } }, assistant: { text: '原始错误' } };
  ui.state().conversation.turns = [old]; ui.focusIssue(old); ui.state().draft = '这个问题解决了'; let request;
  ui.api = async (_path, options) => {
    request = options.body;
    assert.equal(ui.state().conversation.turns[0].status, 'error', 'the UI cannot dismiss before the server confirms');
    return snapshot(document.id, 2, [{ ...old, status: 'dismissed' }, { id: 'ack', status: 'complete', assistant: { text: '已结束此聊天事项' } }]);
  };
  await ui.send();
  assert.equal(request.replyToTurnId, old.id); assert.equal(request.text, '这个问题解决了');
  assert.deepEqual(conversationTurnGroups(ui.state().conversation.turns).unresolved, []);
  assert.equal(ui.state().conversation.turns[0].assistant.text, '原始错误');
  assert.equal(ui.state().issueReplyTarget, null);
});

test('changing the focused reply context clears natural-resolution targeting', async () => {
  const { ui, document, run } = harness(), old = { id: 'focused-issue', status: 'error', user: { text: '原问题', context: { runId: run.id } } }; let request;
  ui.state().conversation.turns = [old]; ui.focusIssue(old); ui.focusContext({ runId: run.id, nodeId: 'trim' });
  ui.state().draft = '不用处理了'; ui.api = async (_path, options) => { request = options.body; return snapshot(document.id, 2, [old]); };
  await ui.send(); assert.equal(request.replyToTurnId, undefined); assert.equal(ui.state().issueReplyTarget, null);
});

test('ordinary discussion, questions and ordinal choices do not carry a guessed issue target', async () => {
  const { ui, document, run } = harness(), old = { id: 'focused-issue', status: 'error', user: { text: '原问题', context: { runId: run.id } } }, requests = [];
  ui.state().conversation.turns = [old]; ui.focusIssue(old);
  ui.api = async (_path, options) => { requests.push(options.body); return snapshot(document.id, requests.length + 1, [old]); };
  for (const text of ['是不是解决了？', '如果解决了怎么办', '不要结束', '第1个']) { ui.state().draft = text; await ui.send(); }
  assert.ok(requests.every(request => request.replyToTurnId === undefined));
  assert.equal(ui.state().issueReplyTarget.turnId, old.id, 'unrelated wording does not silently switch the selected issue');
});

test('uncertain resolution delivery preserves its exact issue target and idempotency key', async () => {
  const { ui, document, run } = harness(), old = { id: 'focused-issue', status: 'error', user: { text: '原问题', context: { runId: run.id } } }, requests = [];
  ui.state().conversation.turns = [old]; ui.focusIssue(old); ui.state().draft = '不用处理了';
  ui.api = async (_path, options) => { requests.push(structuredClone(options.body)); if (requests.length === 1) throw Error('fixture disconnected'); return snapshot(document.id, 2, [{ ...old, status: 'dismissed' }]); };
  await ui.send(); ui.focusContext({ nodeId: 'trim' }); await ui.send(ui.state().retry);
  assert.equal(requests[0].replyToTurnId, old.id); assert.equal(requests[1].replyToTurnId, old.id);
  assert.equal(requests[0].clientMessageId, requests[1].clientMessageId);
});

test('a late resolution acknowledgement cannot clear a different issue selected during submission', async () => {
  const { ui, document, run } = harness(), gate = deferred(), first = { id: 'first-issue', status: 'error', user: { text: '第一个问题', context: { runId: run.id } } }, second = { ...first, id: 'second-issue' };
  ui.state().conversation.turns = [first, second]; ui.focusIssue(first); ui.state().draft = '不用处理了'; ui.api = async () => gate.promise;
  const sending = ui.send(); ui.focusIssue(second);
  gate.resolve(snapshot(document.id, 2, [{ ...first, status: 'dismissed' }, second])); await sending;
  assert.equal(ui.state().issueReplyTarget.turnId, second.id); assert.equal(ui.state().draft, '不用处理了');
});

test('a stale callback cannot submit an already processed historical review action', async () => {
  const { ui } = harness(); let posts = 0;
  const old = { id: 'old-review', status: 'awaiting_action', actions: [{ id: 'approve', kind: 'review-approve' }] };
  ui.state().conversation.turns = [{ ...old, pendingState: { status: 'resolved', label: '审核已处理' } }];
  ui.api = async () => { posts++; return snapshot(ui.workflowId, 2); };
  await ui.performAction(old, old.actions[0]);
  assert.equal(posts, 0);
});

class PendingElement {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.listeners = {}; this.dataset = {}; this.hidden = false;
    this.classList = { toggle() {} }; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  focus() {}
}
function pendingDOM(t) {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document'), previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), saved = new Map();
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: tag => new PendingElement(tag) } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) } });
  t.after(() => { for (const [key, descriptor] of [['document', previousDocument], ['localStorage', previousStorage]]) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  return { saved, descendants: node => [node, ...node.children.flatMap(child => typeof child === 'object' ? pendingDOMDescendants(child) : [])] };
}
const pendingDOMDescendants = node => [node, ...(node.children || []).flatMap(child => typeof child === 'object' ? pendingDOMDescendants(child) : [])];

function revisionHandoffFixture() {
  const fixture = harness(), { run } = fixture;
  run.document.nodes.push({ id: 'gate', type: 'human', title: '海报审核', config: { reviewTargetNodeId: 'trim', maxRevisions: 3 } });
  run.document.edges.push({ sourceNode: 'trim', targetNode: 'gate' });
  run.nodes.gate = { status: 'waiting_review', attempt: 2, attemptId: 'human-two', artifacts: run.nodes.trim.artifacts, review: { revisionCount: 1, artifactHashes: [{ id: 'image-one', sha256: 'a'.repeat(64) }] } };
  return fixture;
}

test('artifact revision handoff preserves an unrelated draft and sends exact review identity with complete feedback', async () => {
  const { ui, document, run } = revisionHandoffFixture(), feedback = '横向排列\n保留10项内容；改成蓝色主题'; let request;
  ui.state().draft = '尚未发送的其他问题'; ui.input.value = ui.state().draft;
  ui.prepareArtifactRevision({ run, humanNodeId: 'gate', feedback });
  assert.equal(ui.state().draft, '尚未发送的其他问题'); assert.equal(ui.input.value, '尚未发送的其他问题');
  assert.equal(ui.state().revisionHandoff.text, feedback); assert.equal(ui.state().revisionHandoff.revisionRequest.humanNodeId, 'gate');
  ui.api = async (_path, options) => { request = options.body; return snapshot(document.id, 2); };
  await ui.sendArtifactRevision();
  assert.equal(request.text, feedback); assert.equal(request.intent, 'auto'); assert.equal(request.context.nodeId, 'gate');
  assert.deepEqual(request.revisionRequest, { runId: run.id, humanNodeId: 'gate', attempt: 2, attemptId: 'human-two', artifactHashes: [{ id: 'image-one', sha256: 'a'.repeat(64) }], targetNodeId: 'trim' });
  assert.equal(ui.state().draft, '尚未发送的其他问题'); assert.equal(ui.state().revisionHandoff, null);
});

test('a failed candidate request retries the original identity without consuming another draft', async () => {
  const { ui, document, run } = revisionHandoffFixture(), requests = [], originalContext = structuredClone(ui.getContext());
  ui.state().draft = '保留另外一个问题'; ui.prepareArtifactRevision({ run, humanNodeId: 'gate', feedback: '  请放大标题\n保留全部项目  ' });
  ui.api = async (_path, options) => { requests.push(structuredClone(options.body)); if (requests.length === 1) throw new Error('fixture lost response'); return snapshot(document.id, 2); };
  await ui.sendArtifactRevision();
  assert.equal(ui.state().retry.revisionRequest.attemptId, 'human-two'); assert.ok(ui.state().revisionHandoff);
  run.nodes.gate.attempt = 3; run.nodes.gate.attemptId = 'human-three';
  await ui.send(ui.state().retry);
  assert.equal(requests[0].clientMessageId, requests[1].clientMessageId); assert.deepEqual(requests[1].revisionRequest, requests[0].revisionRequest);
  assert.equal(requests[1].text, '  请放大标题\n保留全部项目  '); assert.equal(ui.state().revisionHandoff, null);
  assert.equal(ui.state().draft, '保留另外一个问题'); assert.deepEqual(ui.getContext(), originalContext);
});

test('pending code review submits a candidate with full feedback in one click while leaving the composer alone', async t => {
  pendingDOM(t); const { ui, document, run } = revisionHandoffFixture(), requests = []; ui.pendingHost = new PendingElement('section');
  ui.api = async (path, options) => { requests.push({ path, body: structuredClone(options.body) }); return { ...snapshot(document.id, 2), pending: structuredClone(ui.state().pending) }; };
  const record = run.nodes.gate, context = { runId: run.id, nodeId: 'gate', attempt: record.attempt, attemptId: record.attemptId, artifactHashes: record.review.artifactHashes };
  ui.state().pending = [{ id: 'code-review', kind: 'review', label: '海报审核', context }]; ui.attachment = { ...context, workflowId: ui.workflowId }; ui.state().draft = '另一个未发送问题';
  ui.renderPending(conversationTurnGroups([])); const all = pendingDOMDescendants(ui.pendingHost), feedback = all.find(item => item.tagName === 'textarea');
  feedback.value = '横向排列\n保持全部数据'; feedback.listeners.input();
  assert.equal(all.some(item => item.textContent === '填写修改意见'), false);
  assert.equal(all.find(item => item.textContent === '通过并继续').disabled, false); assert.equal(all.find(item => item.textContent === '停止此审核分支').disabled, false);
  await all.find(item => item.textContent === '生成修改候选').listeners.click();
  assert.equal(requests.length, 1); assert.equal(requests[0].path, `/api/workflow-conversations/${document.id}/messages`); assert.equal(requests[0].body.text, feedback.value); assert.equal(requests[0].body.intent, 'auto'); assert.equal(requests[0].body.revisionRequest.attemptId, 'human-two'); assert.equal(ui.state().revisionHandoff, null); assert.equal(ui.state().draft, '另一个未发送问题');
  ui.state().revisionHandoff = null; run.nodes.gate.attemptId = 'human-newer';
  await all.find(item => item.textContent === '生成修改候选').listeners.click(); ui.renderPending(conversationTurnGroups([]));
  assert.equal(ui.state().revisionHandoff, null); assert.ok(pendingDOMDescendants(ui.pendingHost).some(item => item.attributes?.role === 'alert' && /审核版本已变化/.test(item.textContent)));
});

test('review action errors stay in the review row after unrelated notice updates', async t => {
  pendingDOM(t); const { ui, run } = revisionHandoffFixture(); ui.pendingHost = new PendingElement('section');
  const context = { runId: run.id, nodeId: 'gate', attempt: 2, attemptId: 'human-two', artifactHashes: run.nodes.gate.review.artifactHashes };
  ui.state().pending = [{ id: 'code-review', kind: 'review', label: '海报审核', context }];
  const action = { id: 'review-action', kind: 'review-approve', context: { ...context, artifactIds: ['image-one'] } }, turn = { id: 'review-turn', status: 'awaiting_action', actions: [action] };
  ui.api = async () => { throw new Error('当前审核已过期'); }; await ui.performAction(turn, action); ui.state().error = ''; ui.renderPending(conversationTurnGroups([]));
  assert.ok(pendingDOMDescendants(ui.pendingHost).some(item => item.attributes?.role === 'alert' && /当前审核已过期/.test(item.textContent)));
});

test('a fixed-code review action offers a candidate without displaying the old direct-redo label', async t => {
  pendingDOM(t); const { ui, document, run } = revisionHandoffFixture(), requests = [], context = { runId: run.id, nodeId: 'gate', attempt: 2, attemptId: 'human-two', artifactHashes: run.nodes.gate.review.artifactHashes };
  ui.api = async (path, options) => { requests.push({ path, body: structuredClone(options.body) }); return snapshot(document.id, 2); };
  const action = { id: 'revise-old-card', kind: 'review-revise', label: '按修改意见重做', context, feedback: '横向排列\n保留全部10项' }, turn = { id: 'revision-turn', status: 'awaiting_action', user: { text: '要求修改海报' }, actions: [action] };
  const all = pendingDOMDescendants(ui.turnView(turn)); assert.equal(all.some(item => item.textContent === action.label), false);
  const candidate = all.find(item => item.textContent === '生成修改候选'); assert.ok(candidate); await candidate.listeners.click();
  assert.equal(requests.length, 1); assert.equal(requests[0].path, `/api/workflow-conversations/${document.id}/messages`); assert.equal(requests[0].body.text, action.feedback); assert.equal(requests[0].body.revisionRequest.attemptId, 'human-two'); assert.equal(ui.state().revisionHandoff, null);
});

test('a failed candidate turn retries once with its complete revision identity without replacing the draft or context', async t => {
  pendingDOM(t); const { ui, document, run } = revisionHandoffFixture(), requests = [], text = '  横向排列\n保留全部项目  ';
  ui.prepareArtifactRevision({ run, humanNodeId: 'gate', feedback: text });
  const original = structuredClone(ui.state().revisionHandoff), failed = { id: 'failed-candidate-turn', status: 'error', user: { text, intent: 'auto', context: original.context, revisionRequest: original.revisionRequest } };
  ui.state().revisionHandoff = null; ui.state().conversation.turns = [failed]; ui.state().draft = '原来未发送的其他问题'; ui.input.value = ui.state().draft; const currentContext = structuredClone(ui.getContext());
  ui.api = async (path, options) => { requests.push({ path, body: structuredClone(options.body) }); return snapshot(document.id, 2, [failed, { id: 'candidate-retry', status: 'complete' }]); };
  const retry = pendingDOMDescendants(ui.turnView(failed)).find(item => item.textContent === '重试生成修改候选'); assert.ok(retry); await retry.listeners.click();
  assert.equal(requests.length, 1); assert.equal(requests[0].path, `/api/workflow-conversations/${document.id}/messages`); assert.equal(requests[0].body.text, text); assert.equal(requests[0].body.intent, 'auto'); assert.equal(requests[0].body.retryOfTurnId, failed.id); assert.deepEqual(requests[0].body.revisionRequest, original.revisionRequest); assert.deepEqual(requests[0].body.context, original.context);
  assert.equal(ui.state().draft, '原来未发送的其他问题'); assert.equal(ui.input.value, '原来未发送的其他问题'); assert.deepEqual(ui.getContext(), currentContext); assert.equal(ui.state().revisionHandoff, null);
});

test('a rejected candidate-turn retry retains the exact request and preserves the unrelated composer for a guarded retry', async () => {
  const { ui, document, run } = revisionHandoffFixture(), requests = [], text = '修改标题'; ui.prepareArtifactRevision({ run, humanNodeId: 'gate', feedback: text });
  const original = structuredClone(ui.state().revisionHandoff), failed = { id: 'interrupted-candidate-turn', status: 'interrupted', user: { text, intent: 'auto', context: original.context, revisionRequest: original.revisionRequest } };
  ui.state().revisionHandoff = null; ui.state().conversation.turns = [failed]; ui.state().draft = '另外的聊天草稿'; const currentContext = structuredClone(ui.getContext()); run.nodes.gate.attemptId = 'newer-review';
  ui.api = async (_path, options) => { requests.push(structuredClone(options.body)); if (requests.length === 1) throw new Error('审核版本已变化或当前权限不允许'); return snapshot(document.id, 2); };
  await ui.beginRetry(failed); assert.equal(requests.length, 1); assert.deepEqual(requests[0].revisionRequest, original.revisionRequest); assert.equal(requests[0].retryOfTurnId, failed.id); assert.ok(ui.state().revisionHandoff); assert.match(ui.state().revisionHandoffStatus, /审核版本已变化/);
  await ui.sendArtifactRevision(); assert.equal(requests.length, 2); assert.equal(requests[0].clientMessageId, requests[1].clientMessageId); assert.deepEqual(requests[1].revisionRequest, original.revisionRequest); assert.equal(ui.state().draft, '另外的聊天草稿'); assert.deepEqual(ui.getContext(), currentContext);
});

test('a classified review proposal prepares its exact candidate without replacing the composer and retains stale-review errors', async t => {
  pendingDOM(t); const { ui, document, run } = revisionHandoffFixture(), requests = [], context = { runId: run.id, nodeId: 'gate', attempt: 2, attemptId: 'human-two', artifactHashes: run.nodes.gate.review.artifactHashes }, feedback = '  改为横向排列\n保留全部10项；放大标题  ';
  const turn = { id: 'classified-revision', status: 'awaiting_action', user: { text: '修改海报' }, assistant: { text: '请先生成修改候选。', revisionProposals: [{ context, feedback, targetNodeId: 'trim' }] }, actions: [] };
  ui.state().draft = '另一个未发送的问题'; const originalContext = structuredClone(ui.getContext()); ui.api = async (path, options) => { requests.push({ path, body: structuredClone(options.body) }); return snapshot(document.id, 2); };
  let all = pendingDOMDescendants(ui.turnView(turn)), candidate = all.find(item => item.textContent === '生成修改候选'); assert.ok(candidate); assert.equal(candidate.disabled, false);
  await candidate.listeners.click(); assert.equal(requests.length, 1); assert.equal(requests[0].path, `/api/workflow-conversations/${document.id}/messages`); assert.equal(requests[0].body.text, feedback); assert.equal(requests[0].body.intent, 'auto'); assert.deepEqual(requests[0].body.revisionRequest, { runId: run.id, humanNodeId: 'gate', attempt: 2, attemptId: 'human-two', artifactHashes: context.artifactHashes, targetNodeId: 'trim' }); assert.equal(ui.state().revisionHandoff, null);
  assert.equal(ui.state().draft, '另一个未发送的问题'); assert.deepEqual(ui.getContext(), originalContext);
  ui.state().revisionHandoff = null; run.nodes.gate.attemptId = 'human-newer'; await candidate.listeners.click(); ui.state().error = '';
  all = pendingDOMDescendants(ui.turnView(turn)); assert.ok(all.some(item => item.attributes?.role === 'alert' && /审核版本已变化/.test(item.textContent))); assert.equal(ui.state().revisionHandoff, null);
  turn.pendingState = { status: 'superseded' }; assert.equal(pendingDOMDescendants(ui.turnView(turn)).some(item => item.textContent === '生成修改候选'), false);
});

test('a busy conversation retains an immediately requested candidate with a clear retry state and preserves the draft', async () => {
  const { ui, document, run } = revisionHandoffFixture(), requests = []; ui.state().draft = '保留原草稿'; ui.state().sending = true;
  ui.api = async (path, options) => { requests.push({ path, body: structuredClone(options.body) }); return snapshot(document.id, 2); };
  await ui.requestArtifactRevision({ run, humanNodeId: 'gate', feedback: '请加大标题' });
  assert.equal(requests.length, 0); assert.equal(ui.state().revisionHandoff.text, '请加大标题'); assert.match(ui.state().revisionHandoffStatus, /稍后|保留|正在/);
  ui.state().sending = false; await ui.sendArtifactRevision(); assert.equal(requests.length, 1); assert.equal(ui.state().revisionHandoff, null); assert.equal(ui.state().draft, '保留原草稿');
});

test('review cards show the count without a ceiling and keep Skill revision actions usable after many modifications', t => {
  pendingDOM(t); const { ui, run } = harness(); ui.pendingHost = new PendingElement('section');
  const context = { runId: run.id, nodeId: 'gate', attempt: 4, attemptId: 'gate-four' };
  ui.attachment = { ...context, workflowId: ui.workflowId };
  ui.state().pending = [{ id: 'quota-review', kind: 'review', label: '审核海报', context,
    revision: { used: 6, limit: null, remaining: null, exhausted: false, targetNodeId: 'trim', strategy: 'revise', canRevise: true, reason: '' } }];
  ui.renderPending(conversationTurnGroups([]));
  const all = pendingDOMDescendants(ui.pendingHost), revise = all.find(item => item.textContent === '填写修改意见');
  assert.ok(all.some(item => item.textContent === '已修改 6 次')); assert.equal(all.some(item => /剩余|修改.*上限|null/.test(item.textContent || '')), false);
  assert.equal(revise.disabled, false); assert.equal(all.find(item => item.textContent === '通过并继续').disabled, false);
  assert.equal(all.find(item => item.textContent === '停止此审核分支').disabled, false);
  const turn = { id: 'many-revisions', status: 'awaiting_action', actions: [{ id: 'more', kind: 'review-revise', label: '继续修改', context, feedback: '标题放大' }] }, turnNodes = pendingDOMDescendants(ui.turnView(turn));
  assert.equal(turnNodes.find(item => item.textContent === '继续修改').disabled, false); assert.ok(turnNodes.some(item => item.textContent === '已修改 6 次')); assert.equal(turnNodes.some(item => /剩余|修改.*上限|null/.test(item.textContent || '')), false);
});

test('global application chat displays the focused issue with a concise composer', t => {
  pendingDOM(t); const { ui } = harness(); Object.setPrototypeOf(ui, ApplicationConversationUI.prototype);
  ui.workflowId = 'global-application'; ui.editor.doc = { id: 'global-application', title: '当前应用', nodes: [], edges: [] };
  const old = { id: 'global-issue', status: 'error', user: { text: '应用页面失败', context: {} } };
  ui.state().conversation.turns = [old]; ui.focusIssue(old);
  ui.contextHost = new PendingElement('div'); ui.followSelection = {};
  WorkflowConversationUI.prototype.renderContext.call(ui);
  assert.ok(ui.contextHost.children.some(node => /当前问题：应用页面失败/.test(node.textContent || '')));
  ApplicationConversationUI.prototype.renderComposerHelp.call(ui);
  assert.equal(ui.input.placeholder, '输入消息');
});

test('pending group starts folded, reports reviews and preserves its workflow preference across rerenders and reloads', t => {
  pendingDOM(t); const { ui, document } = harness(); ui.pendingHost = new PendingElement('section');
  ui.state().pending = [{ id: 'review-one', kind: 'review', label: '待审核', context: { runId: 'run-one', nodeId: 'trim', attempt: 2 } }];
  const turns = [{ id: 'old-error', status: 'error', user: { text: '失败事项' } }, { id: 'latest', status: 'complete' }];
  ui.renderPending(conversationTurnGroups(turns));
  const toggle = ui.pendingHost.children[0], body = ui.pendingHost.children[1];
  assert.equal(toggle.attributes['aria-expanded'], 'false'); assert.match(toggle.textContent, /待处理.*2.*审核.*1/); assert.equal(body.hidden, true);
  toggle.listeners.click(); ui.renderPending(conversationTurnGroups(turns)); assert.equal(ui.pendingHost.children[1].hidden, false);
  const reloaded = harness().ui; reloaded.workflowId = document.id; assert.equal(reloaded.state().pendingExpanded, true);
  reloaded.workflowId = 'another-workflow'; assert.equal(reloaded.state().pendingExpanded, false);
});

test('pending collapse remains usable in memory when browser preference storage is unavailable', t => {
  pendingDOM(t); Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('fixture storage unavailable'); } });
  const { ui } = harness(); ui.pendingHost = new PendingElement('section');
  const turns = [{ id: 'old-error', status: 'error', user: { text: '失败事项' } }, { id: 'latest', status: 'complete' }];
  ui.renderPending(conversationTurnGroups(turns)); ui.pendingHost.children[0].listeners.click();
  ui.renderPending(conversationTurnGroups(turns)); assert.equal(ui.pendingHost.children[1].hidden, false);
});

test('pending rows allow closing chat issues while keeping reviews and failed business runs visible', t => {
  pendingDOM(t); const { ui, run } = harness(); ui.pendingHost = new PendingElement('section'); run.status = 'error';
  ui.state().pending = [{ id: 'review-one', kind: 'review', label: '待审核', context: { runId: run.id, nodeId: 'trim', attempt: 2 } }];
  const turn = { id: 'old-error', status: 'error', user: { text: '失败事项', context: { runId: run.id } } }, closed = [];
  ui.dismissTurn = value => closed.push(value.id); ui.renderPending(conversationTurnGroups([turn, { id: 'latest', status: 'complete' }]));
  const nodes = pendingDOMDescendants(ui.pendingHost);
  assert.ok(nodes.some(node => /^运行异常/.test(node.textContent || '')));
  const close = nodes.filter(node => ['已处理', '不再处理'].includes(node.textContent)); assert.equal(close.length, 2);
  close[0].listeners.click(); assert.deepEqual(closed, [turn.id]);
});

test('pending list counts an exact current review once while unmatched or unknown review attempts remain visible', t => {
  pendingDOM(t); const { ui } = harness(); ui.pendingHost = new PendingElement('section');
  const context = { runId: 'run-one', nodeId: 'trim', attempt: 2, attemptId: 'attempt-two' };
  ui.state().pending = [{ id: 'review-one', kind: 'review', label: '待审核', context }];
  const turn = { id: 'old-review', status: 'awaiting_action', user: { text: '通过' }, actions: [{ kind: 'review-approve', context }] }, latest = { id: 'latest', status: 'complete' };
  ui.renderPending(conversationTurnGroups([turn, latest])); assert.match(ui.pendingHost.children[0].textContent, /待处理 · 1/);
  turn.actions[0].context = { ...context, attemptId: 'different-attempt' };
  ui.renderPending(conversationTurnGroups([turn, latest])); assert.match(ui.pendingHost.children[0].textContent, /待处理 · 2/);
  turn.actions[0].context = { runId: context.runId, nodeId: context.nodeId, attempt: context.attempt };
  ui.renderPending(conversationTurnGroups([turn, latest])); assert.match(ui.pendingHost.children[0].textContent, /待处理 · 2/);
});

test('a review notice can be hidden and restored without approving, stopping, posting or losing feedback', t => {
  pendingDOM(t); const { ui, run } = revisionHandoffFixture(); ui.pendingHost = new PendingElement('section'); ui.editor.libraryReadOnly = true;
  const context = { runId: run.id, nodeId: 'gate', attempt: 2, attemptId: 'human-two', artifactHashes: run.nodes.gate.review.artifactHashes };
  ui.state().pending = [{ id: 'review-one', kind: 'review', label: '审核产物', context }]; ui.attachment = { ...context, workflowId: ui.workflowId };
  ui.state().conversation.turns = [{ id: 'history', status: 'complete', assistant: { text: '保留聊天原文' } }];
  ui.sendReview = () => assert.fail('Hiding a notice cannot review'); ui.dismissTurn = () => assert.fail('Hiding a notice cannot end a turn'); ui.api = () => assert.fail('Hiding a notice cannot call the server');
  ui.renderPending(conversationTurnGroups(ui.state().conversation.turns));
  let all = pendingDOMDescendants(ui.pendingHost); const feedback = all.find(node => node.tagName === 'textarea'); feedback.value = '保留这份修改意见'; feedback.listeners.input();
  const before = structuredClone({ pending: ui.state().pending, turns: ui.state().conversation.turns, run });
  const close = all.find(node => node.attributes['aria-label'] === '隐藏此审核提示'); assert.ok(close); assert.notEqual(close.disabled, true); close.listeners.click();
  all = pendingDOMDescendants(ui.pendingHost); assert.equal(all.some(node => node.textContent === '审核产物'), false);
  assert.equal(ui.pendingHost.hidden, false); const restore = all.find(node => node.textContent === '显示已隐藏 · 1'); assert.ok(restore); restore.listeners.click();
  all = pendingDOMDescendants(ui.pendingHost); assert.equal(all.find(node => node.tagName === 'textarea').value, '保留这份修改意见');
  assert.deepEqual({ pending: ui.state().pending, turns: ui.state().conversation.turns, run }, before);
});

test('hidden review identity survives refresh and sorted artifact hashes but a new attempt or artifact version appears', t => {
  pendingDOM(t); const { ui, document } = harness(); ui.pendingHost = new PendingElement('section');
  const hashes = [{ id: 'b', sha256: 'b'.repeat(64) }, { id: 'a', sha256: 'a'.repeat(64) }];
  const review = { id: 'review-one', kind: 'review', label: '审核产物', context: { runId: 'run-one', nodeId: 'trim', attempt: 2, attemptId: 'attempt-two', artifactHashes: hashes } };
  ui.state().pending = [review]; ui.renderPending(conversationTurnGroups([]));
  pendingDOMDescendants(ui.pendingHost).find(node => node.attributes['aria-label'] === '隐藏此审核提示').listeners.click();
  const reloaded = harness().ui; reloaded.workflowId = document.id; reloaded.editor.doc = document; reloaded.pendingHost = new PendingElement('section');
  reloaded.state().pending = [{ ...structuredClone(review), context: { ...review.context, artifactHashes: [...hashes].reverse().map(hash => ({ ...hash, sha256: hash.sha256.toUpperCase() })) } }]; reloaded.renderPending(conversationTurnGroups([]));
  assert.ok(pendingDOMDescendants(reloaded.pendingHost).some(node => node.textContent === '显示已隐藏 · 1'));
  reloaded.state().pending[0].context.attemptId = 'attempt-three'; reloaded.renderPending(conversationTurnGroups([]));
  assert.ok(pendingDOMDescendants(reloaded.pendingHost).some(node => node.textContent === '审核产物'));
  reloaded.state().pending[0].context = { ...review.context, artifactHashes: [{ id: 'a', sha256: 'c'.repeat(64) }, hashes[0]] }; reloaded.renderPending(conversationTurnGroups([]));
  assert.ok(pendingDOMDescendants(reloaded.pendingHost).some(node => node.textContent === '审核产物'));
});

test('hiding every current notice leaves one recovery control and preserves actual issues, reviews and failed runs', t => {
  pendingDOM(t); const { ui, run } = harness(); ui.pendingHost = new PendingElement('section'); run.status = 'error'; run.completedAt = '2026-10-28T01:00:00Z';
  const turn = { id: 'old-error', status: 'error', updatedAt: '2026-10-28T01:00:00Z', user: { text: '原始事项' } }, latest = { id: 'latest', status: 'complete' };
  ui.state().conversation.turns = [turn, latest]; ui.state().pending = [{ id: 'review', kind: 'review', label: '待审核', context: { runId: run.id, nodeId: 'trim', attempt: 2, attemptId: 'attempt-two' } }];
  const before = structuredClone({ pending: ui.state().pending, turns: ui.state().conversation.turns, run });
  ui.api = () => assert.fail('Local close cannot call any API'); ui.dismissTurn = () => assert.fail('Local close cannot resolve issues'); ui.sendReview = () => assert.fail('Local close cannot review');
  ui.renderPending(conversationTurnGroups(ui.state().conversation.turns));
  const all = pendingDOMDescendants(ui.pendingHost); assert.equal(all.filter(node => /^隐藏此/.test(node.attributes['aria-label'] || '')).length, 3);
  all.find(node => node.attributes['aria-label'] === '隐藏当前全部提示').listeners.click();
  assert.ok(pendingDOMDescendants(ui.pendingHost).some(node => node.textContent === '显示已隐藏 · 3')); assert.equal(ui.pendingHost.children[0].hidden, true);
  assert.deepEqual({ pending: ui.state().pending, turns: ui.state().conversation.turns, run }, before);
  pendingDOMDescendants(ui.pendingHost).find(node => node.textContent === '显示已隐藏 · 3').listeners.click();
  assert.match(ui.pendingHost.children[0].textContent, /待处理 · 3/); assert.equal(ui.pendingHost.children[1].hidden, true, 'Restoring notices keeps the collapse preference');
});

test('hidden chat issues and failures reappear only when their own status or version changes', t => {
  pendingDOM(t); const { ui, run } = harness(); ui.pendingHost = new PendingElement('section'); run.status = 'error'; run.completedAt = '2026-10-28T01:00:00Z';
  const turn = { id: 'old-error', status: 'error', updatedAt: '2026-10-28T01:00:00Z', user: { text: '旧正文不会用作身份' } };
  ui.state().conversation.turns = [turn, { id: 'latest', status: 'complete' }]; ui.renderPending(conversationTurnGroups(ui.state().conversation.turns));
  pendingDOMDescendants(ui.pendingHost).find(node => node.attributes['aria-label'] === '隐藏此聊天事项提示').listeners.click();
  pendingDOMDescendants(ui.pendingHost).find(node => node.attributes['aria-label'] === '隐藏此运行异常提示').listeners.click();
  turn.user.text = '正文不同但仍是同一版本'; ui.renderPending(conversationTurnGroups(ui.state().conversation.turns));
  assert.ok(pendingDOMDescendants(ui.pendingHost).some(node => node.textContent === '显示已隐藏 · 2'));
  turn.updatedAt = '2026-10-28T01:01:00Z'; ui.renderPending(conversationTurnGroups(ui.state().conversation.turns)); assert.match(ui.pendingHost.children[0].textContent, /待处理 · 1/);
  run.completedAt = '2026-10-28T01:02:00Z'; ui.renderPending(conversationTurnGroups(ui.state().conversation.turns)); assert.match(ui.pendingHost.children[0].textContent, /待处理 · 2/);
});

test('hidden current reviews do not expose their duplicate historical review choice and conversation types remain isolated', t => {
  pendingDOM(t); const { ui, document } = harness(); ui.pendingHost = new PendingElement('section');
  const context = { runId: 'run-one', nodeId: 'trim', attempt: 2, attemptId: 'attempt-two' }, review = { id: 'review', kind: 'review', label: '待审核', context };
  const old = { id: 'old-review', status: 'awaiting_action', actions: [{ kind: 'review-approve', context }] };
  ui.state().pending = [review]; ui.state().conversation.turns = [old, { id: 'latest', status: 'complete' }]; ui.renderPending(conversationTurnGroups(ui.state().conversation.turns));
  pendingDOMDescendants(ui.pendingHost).find(node => node.attributes['aria-label'] === '隐藏此审核提示').listeners.click();
  assert.ok(pendingDOMDescendants(ui.pendingHost).some(node => node.textContent === '显示已隐藏 · 1'));
  const supervisor = harness().ui; supervisor.workflowId = document.id; supervisor.editor.doc = document; supervisor.fileAttachments = { scope: 'supervisor' }; supervisor.states.delete(document.id); supervisor.pendingHost = new PendingElement('section');
  supervisor.state().pending = [structuredClone(review)]; supervisor.renderPending(conversationTurnGroups([]));
  assert.ok(pendingDOMDescendants(supervisor.pendingHost).some(node => node.textContent === '待审核'));
});

test('a retry targets its failed turn only while text and captured context remain unchanged', async () => {
  const { ui, document, run } = harness(), failed = { id: 'failed-turn', status: 'error', user: { text: '检查采集失败', context: { runId: run.id, nodeId: 'trim' } } }; let request;
  ui.state().conversation.turns = [failed]; ui.beginRetry(failed);
  ui.api = async (_path, options) => { request = options.body; return snapshot(document.id, 2, [failed, { id: 'next', status: 'complete' }]); };
  await ui.send(); assert.equal(request.retryOfTurnId, failed.id); assert.equal(ui.state().retryOfTurnId, null);
  ui.beginRetry(failed); ui.state().draft = '另一个全新问题'; await ui.send(); assert.equal(request.retryOfTurnId, undefined);
  ui.beginRetry(failed); ui.focusContext({ runId: run.id }); await ui.send(); assert.equal(request.retryOfTurnId, undefined);
});

test('uncertain network delivery retains the exact retry relation and idempotency key', async () => {
  const { ui, document, run } = harness(), failed = { id: 'failed-turn', status: 'error', user: { text: '检查采集失败', context: { runId: run.id } } }, requests = [];
  ui.state().conversation.turns = [failed]; ui.beginRetry(failed);
  ui.api = async (_path, options) => { requests.push(structuredClone(options.body)); if (requests.length === 1) throw new Error('fixture network failure'); return snapshot(document.id, 2); };
  await ui.send(); ui.state().draft = '发送后的草稿'; await ui.send(ui.state().retry);
  assert.equal(requests[0].retryOfTurnId, failed.id); assert.equal(requests[1].retryOfTurnId, failed.id);
  assert.equal(requests[0].clientMessageId, requests[1].clientMessageId); assert.equal(ui.state().draft, '发送后的草稿');
});

test('unconfirmed operation outcomes can load a new question without claiming the old operation was retried', async () => {
  const { ui, document, run } = harness(), failed = { id: 'uncertain-operation', status: 'error', outcome: { action: 'rerun', status: 'unknown' }, user: { text: '检查上次操作', context: { runId: run.id } } }; let request;
  ui.state().conversation.turns = [failed]; ui.beginRetry(failed);
  ui.api = async (_path, options) => { request = options.body; return snapshot(document.id, 2); };
  await ui.send(); assert.equal(request.retryOfTurnId, undefined);
});

test('a successful retry response does not clear another retry selected while it was sending', async () => {
  const { ui, document, run } = harness(), gate = deferred(), original = { id: 'failed-first', status: 'error', user: { text: '检查失败', context: { runId: run.id } } }, next = { ...original, id: 'failed-second' };
  ui.state().conversation.turns = [original, next]; ui.beginRetry(original); ui.api = async () => gate.promise;
  const sending = ui.send(); ui.beginRetry(next); gate.resolve(snapshot(document.id, 2, [original, next])); await sending;
  assert.equal(ui.state().draft, next.user.text); assert.equal(ui.state().retryOfTurnId, next.id);
});

test('a projected handled review remains in history without executable old review or dismissal controls', t => {
  pendingDOM(t); const { ui } = harness(), turn = { id: 'old-review', status: 'awaiting_action', user: { text: '通过' },
    assistant: { text: '请先选择对应审核版本。' }, actions: [{ id: 'approve', kind: 'review-approve', label: '通过并继续' }],
    pendingState: { status: 'resolved', label: '已在其他入口处理' } };
  const view = ui.turnView(turn), nodes = pendingDOMDescendants(view);
  assert.ok(nodes.some(node => node.textContent === turn.assistant.text));
  assert.ok(nodes.some(node => node.textContent === turn.pendingState.label));
  assert.equal(nodes.some(node => ['通过并继续', '结束此事项', '载入消息重试'].includes(node.textContent)), false);
  assert.equal(conversationTurnGroups([turn, { id: 'latest', status: 'complete' }]).unresolved.length, 0);
});

test('diagnostic progress names the stalled stage and freezes its elapsed time after failure', () => {
  const at = Date.parse('2026-01-01T00:00:10.000Z');
  const turn = { status: 'thinking', createdAt: '2026-01-01T00:00:00.000Z', assistant: {
    progress: { stage: 'model-response', label: '等待模型响应', startedAt: '2026-01-01T00:00:05.000Z', modelCalls: 2, toolCalls: 1 },
    checkpoint: { steps: [{ stage: 'tool', label: '读取工作流', status: 'complete', elapsedMs: 30 }, { stage: 'model-response', label: '等待模型响应', status: 'running' }] } } };
  const live = conversationDiagnosticProgress(turn, at);
  assert.equal(live.label, '等待模型响应'); assert.equal(live.elapsedMs, 5000); assert.equal(live.totalElapsedMs, 10000);
  assert.equal(live.modelCalls, 2); assert.equal(live.completed, 1); assert.equal(live.active, true);
  turn.status = 'error'; turn.updatedAt = '2026-01-01T00:03:05.000Z';
  turn.assistant.progress = { ...turn.assistant.progress, status: 'error', completedAt: turn.updatedAt, elapsedMs: 180000 };
  turn.assistant.checkpoint.steps[1].status = 'error';
  const failed = conversationDiagnosticProgress(turn, at + 3600000);
  assert.equal(failed.elapsedMs, 180000); assert.equal(failed.totalElapsedMs, 185000); assert.equal(failed.active, false);
  assert.equal(failed.failed, 1); assert.equal(failed.steps[0].label, '读取工作流');
  assert.equal(conversationDiagnosticProgress({ status: 'error', assistant: { text: '旧版错误' } }), null);
});

test('applying or dismissing a finished proposal cannot extend its immutable diagnostic turn time', () => {
  const turn = { status: 'proposed', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:02:05.000Z', assistant: {
    progress: { label: '检查候选', startedAt: '2026-01-01T00:02:00.000Z', turnStartedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:02:05.000Z', status: 'complete', elapsedMs: 5000, modelCalls: 2 },
  } };
  const at = Date.parse('2026-01-01T01:00:00.000Z');
  for (const status of ['proposed', 'applied', 'dismissed']) {
    turn.status = status; turn.updatedAt = '2026-01-01T00:04:44.000Z';
    const view = conversationDiagnosticProgress(turn, at);
    assert.equal(view.totalElapsedMs, 125000, status); assert.equal(view.elapsedMs, 5000, status); assert.equal(view.active, false);
  }
});

test('diagnostic turn timing uses its original start and completed checkpoint when primary timestamps are unavailable', () => {
  const turn = { status: 'thinking', assistant: { progress: { label: '生成候选', startedAt: '2026-01-01T00:00:05.000Z',
    turnStartedAt: '2026-01-01T00:00:00.000Z', elapsedMs: 5000 } } };
  const live = conversationDiagnosticProgress(turn, Date.parse('2026-01-01T00:00:10.000Z'));
  assert.equal(live.totalElapsedMs, 10000); assert.equal(live.active, true);
  turn.status = 'applied'; turn.updatedAt = '2026-01-01T00:04:44.000Z';
  turn.assistant.progress.completedAt = 'invalid';
  turn.assistant.checkpoint = { status: 'complete', updatedAt: '2026-01-01T00:02:05.000Z' };
  const finished = conversationDiagnosticProgress(turn, Date.parse('2026-01-01T01:00:00.000Z'));
  assert.equal(finished.totalElapsedMs, 125000); assert.equal(finished.active, false);
  delete turn.assistant.checkpoint;
  assert.equal(conversationDiagnosticProgress(turn).totalElapsedMs, null, 'later application time cannot reconstruct an unknown model duration');
});

test('workflow and supervisor bubbles share the frozen turn clock and show unavailable historical durations honestly', t => {
  pendingDOM(t);
  const turn = { status: 'applied', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:04:44.000Z', assistant: {
    progress: { label: '检查候选', startedAt: '2026-01-01T00:02:00.000Z', turnStartedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:02:05.000Z', status: 'complete', elapsedMs: 5000 },
  } };
  for (const prototype of [WorkflowConversationUI.prototype, ApplicationConversationUI.prototype]) {
    const nodes = pendingDOMDescendants(prototype.diagnosticProgressView(turn));
    assert.ok(nodes.some(node => node.textContent === '2分5秒'));
    assert.equal(nodes.some(node => node.textContent === '4分44秒'), false);
    assert.equal(nodes.some(node => node.dataset?.diagnosticClock), false, 'completed bubbles have no live clock');
    const legacy = structuredClone(turn); delete legacy.assistant.progress.completedAt;
    assert.ok(pendingDOMDescendants(prototype.diagnosticProgressView(legacy)).some(node => node.textContent === '—'));
  }
  const active = structuredClone(turn); active.status = 'thinking'; delete active.createdAt; delete active.assistant.progress.completedAt;
  const total = pendingDOMDescendants(WorkflowConversationUI.prototype.diagnosticProgressView(active)).find(node => node.dataset?.diagnosticClock === 'total');
  assert.equal(total.dataset.startedAt, active.assistant.progress.turnStartedAt);
});

test('progress display projects stage metadata without exposing checkpoint tool payloads', () => {
  const view = conversationDiagnosticProgress({ status: 'error', assistant: { progress: { label: '检查结果', elapsedMs: 5 },
    checkpoint: { results: [{ result: { privatePayload: 'must not be displayed' } }], steps: [{ label: '读取记录', status: 'error', error: 'Bearer abcdefghijklmnop' }] } } });
  assert.equal(JSON.stringify(view).includes('privatePayload'), false);
  assert.equal(JSON.stringify(view).includes('abcdefghijklmnop'), false);
});

test('conversation scope captures the chosen node attempt and only attached artifacts for that node', () => {
  const { document, run, artifact } = fixture(); run.artifacts = [{ id: 'unrelated', sha256: 'b'.repeat(64), nodeId: 'another-node' }];
  assert.deepEqual(conversationContext(document, run, 'trim', { artifactIds: [artifact.id, 'unrelated', artifact.id] }), { runId: run.id, nodeId: 'trim', attempt: 2, attemptId: 'attempt-two', artifactIds: [artifact.id], artifactHashes: [{ id: artifact.id, sha256: artifact.sha256 }] });
  assert.deepEqual(conversationContext(document, { ...run, workflowId: 'other-workflow' }, 'trim', { artifactIds: [artifact.id] }), { nodeId: 'trim' });
});

test('artifact feedback entry sets an explicit feedback intent while retaining its fixed target', () => {
  const { ui, run } = harness(); ui.state().intent = 'workflow';
  ui.focusContext({ runId: run.id, nodeId: 'trim', attempt: 2, attemptId: 'attempt-two', artifactIds: ['image-one'] }, { intent: 'feedback' });
  assert.equal(ui.state().intent, 'feedback'); assert.equal(ui.attachment.attemptId, 'attempt-two');
  assert.deepEqual(ui.attachment.artifactIds, ['image-one']);
});

test('a node added after the selected run belongs to the current draft without a false historical run binding', () => {
  const { document, run } = fixture(); document.nodes.push(createNode('validation', { x: 350, y: 0 }, { id: 'new-check' }));
  assert.deepEqual(conversationContext(document, run, 'new-check'), { nodeId: 'new-check' });
  document.nodes[0].type = 'skill'; assert.deepEqual(conversationContext(document, run, 'trim'), { nodeId: 'trim' });
});

test('only the latest pair expands by default while older unresolved turns remain separately addressable', () => {
  const turns = [{ id: 'old-done', status: 'complete' }, { id: 'old-review', status: 'awaiting_action' }, { id: 'old-error', status: 'error' }, { id: 'latest', status: 'thinking' }];
  const groups = conversationTurnGroups(turns); assert.equal(groups.latest.id, 'latest'); assert.deepEqual(groups.history.map(turn => turn.id), ['old-done', 'old-review', 'old-error']); assert.deepEqual(groups.unresolved.map(turn => turn.id), ['old-review', 'old-error', 'latest']);
});

test('an attached review retains its old attempt when new artifacts arrive during composition', () => {
  const { ui, run } = harness(); ui.focusContext({ runId: run.id, nodeId: 'trim', attempt: 2, attemptId: 'attempt-two', artifactIds: ['image-one'], ignoredInternalField: true });
  run.nodes.trim = { attempt: 3, attemptId: 'attempt-three', artifacts: [] };
  assert.deepEqual(ui.getContext(), { runId: run.id, nodeId: 'trim', attempt: 2, attemptId: 'attempt-two', artifactIds: ['image-one'] });
});

test('a late message response stays on its original workflow and preserves text edited while submitting', async () => {
  const { ui, document } = harness(), gate = deferred(); ui.state().draft = '创建流程'; const original = ui.state(); let request;
  ui.api = async (_path, options) => { request = options.body; return gate.promise; }; const sent = ui.send();
  original.draft = '发送之后的新草稿'; original.messageEdit++; ui.editor.doc = createDocument({ schemaVersion: 2 }); ui.workflowId = ui.editor.doc.id;
  gate.resolve(snapshot(document.id, 1, [{ id: 'turn-original', status: 'thinking' }])); await sent;
  assert.equal(request.document.id, document.id); assert.equal(request.context.nodeId, 'trim'); assert.equal(original.conversation.turns[0].id, 'turn-original'); assert.equal(original.draft, '发送之后的新草稿'); assert.equal(ui.state().conversation.turns.length, 0); assert.equal(original.sending, false);
});

test('uncertain message retry retains its idempotency key, captured target and original document', async () => {
  const { ui, document } = harness(), requests = []; ui.state().draft = '修改清理节点'; ui.api = async (_path, options) => { requests.push(structuredClone(options.body)); if (requests.length === 1) throw new Error('连接中断'); return snapshot(document.id, 1); };
  await ui.send(); const retry = ui.state().retry; assert.ok(retry?.clientMessageId); ui.editor.doc.title = '之后手动修改的标题'; ui.editor.selection.clear(); await ui.send(retry);
  assert.equal(requests[1].clientMessageId, requests[0].clientMessageId); assert.deepEqual(requests[1].context, requests[0].context); assert.deepEqual(requests[1].document, requests[0].document); assert.notEqual(requests[1].document.title, ui.editor.doc.title); assert.equal(ui.state().retry, null);
});

test('older snapshots cannot overwrite a newer conversation and cross-workflow records are rejected', () => {
  const { ui, document } = harness(); ui.accept(snapshot(document.id, 5, [{ id: 'newer' }])); assert.equal(ui.accept(snapshot(document.id, 4, [{ id: 'older' }])), false); assert.equal(ui.state().conversation.turns[0].id, 'newer');
  assert.throws(() => ui.accept(snapshot('another-workflow', 6), document.id), /不匹配/);
});

test('direct chat rerun refreshes the matching runtime with allowReopen and deduplicates repeated SSE', async () => {
  const { ui, document, run } = harness(), stored = [], turn = { id: 'rerun-turn', status: 'complete', outcome: { action: 'rerun', status: 'complete', runId: run.id, completedAt: 'now' } }; let reads = 0;
  ui.api = async path => { reads++; assert.match(path, /workflow-runs/); return { run: { ...run, status: 'running' } }; }; ui.runtime.storeRun = (value, options) => stored.push({ value, options }); ui.runtime.render = () => {};
  ui.accept({ ...snapshot(document.id, 1, [turn]), turn }); await new Promise(done => setImmediate(done)); ui.accept(snapshot(document.id, 2, [turn])); await new Promise(done => setImmediate(done));
  assert.equal(reads, 1); assert.equal(stored[0].value.status, 'running'); assert.equal(stored[0].options.allowReopen, true);
});

test('a late running GET after an approval cannot overwrite a newer completed SSE snapshot', async () => {
  const { ui, document, run } = harness(), gate = deferred(); let stores = 0; ui.runtime.revisions = new Map([[run.id, 7]]); ui.runtime.runs.set(run.id, { ...run, status: 'waiting_review' });
  ui.api = async () => gate.promise; ui.runtime.storeRun = value => { stores++; ui.runtime.runs.set(value.id, value); };
  const refresh = ui.syncOutcomes([{ id: 'approved', outcome: { action: 'review-approve', status: 'complete', runId: run.id } }], document.id);
  // This represents runtime.handleEvent receiving the completion while the
  // HTTP response still contains the earlier, already serialized running state.
  ui.runtime.runs.set(run.id, { ...run, status: 'complete' }); ui.runtime.revisions.set(run.id, 8); gate.resolve({ run: { ...run, status: 'running' } }); await refresh;
  assert.equal(stores, 0); assert.equal(ui.runtime.runs.get(run.id).status, 'complete');
});

test('outcome refresh rejects a run from another workflow instead of polluting the runtime cache', async () => {
  const { ui, document, run } = harness(); let writes = 0; ui.runtime.storeRun = () => { writes++; }; ui.api = async () => ({ run: { ...run, workflowId: 'another-workflow' } });
  await ui.syncOutcomes([{ id: 'bad-turn', outcome: { action: 'rerun', status: 'complete', runId: run.id } }], document.id); assert.equal(writes, 0); assert.match(ui.state().error, /不匹配/);
});

test('workflow waiting-review events refresh chat pending cards without a new chat message', () => {
  const { ui, document, run } = harness(); let refreshes = 0; ui.queuePendingRefresh = () => { refreshes++; };
  const waiting = { ...run, status: 'waiting_review', nodes: { human: { status: 'waiting_review', attempt: 1, attemptId: 'review-one' } } };
  ui.onEvent({ type: 'workflow.run', payload: waiting }); ui.onEvent({ type: 'workflow.run', payload: waiting }); assert.equal(refreshes, 1);
  ui.onEvent({ type: 'workflow.run', payload: { ...waiting, status: 'complete' } }); assert.equal(refreshes, 2);
  ui.onEvent({ type: 'workflow.run', payload: { ...waiting, id: 'foreign', workflowId: 'another-workflow' } }); assert.equal(refreshes, 2);
  ui.onEvent({ type: 'workflow.run', payload: { ...waiting, id: 'validation-secret', workflowId: document.id, learningId: 'learning-job' } }); assert.equal(refreshes, 2);
});

test('server-verified nested outcome can refresh the child without replacing the selected root run', async () => {
  const { ui, document, run } = harness(), child = { ...run, id: 'child-run', workflowId: 'embedded-flow', parentRunId: run.id }; let stored;
  ui.runtime.storeRun = value => { stored = value; }; ui.api = async () => ({ run: child });
  await ui.syncOutcomes([{ id: 'child-review', outcome: { action: 'review-approve', status: 'complete', runId: child.id, rootWorkflowId: document.id, workflowId: child.workflowId, parentRunId: run.id } }], document.id);
  assert.equal(stored.id, child.id); assert.equal(ui.runtime.currentRun().id, run.id);
});

test('proposal apply passes the immutable turn ID, records exact action receipt and does not auto-run', async () => {
  const { ui, document } = harness(), operations = [{ op: 'set-title', title: '对话修改的标题' }], turn = { id: 'turn-one', assistant: { operations, baseFingerprint: documentFingerprint(document) }, actions: [{ id: 'apply-one', kind: 'mark-applied' }] }; let calls = 0, posted;
  ui.editor.applyConversationOperations = (commands, options) => { calls++; assert.equal(options.turnId, turn.id); let generated = 0; const result = applyWorkflowOperations(ui.editor.doc, commands, { idFactory: prefix => `${prefix}-${options.turnId}-${++generated}` }); ui.editor.doc = result.document; return result; };
  ui.api = async (path, options) => { if (path.endsWith('/validate-proposal')) { assert.equal(calls, 0); assert.deepEqual(options.body, { planFingerprint: turn.assistant.baseFingerprint }); return validProposal(document.id, turn, document); } posted = options.body; return snapshot(document.id, 1); }; await ui.applyProposal(turn); await ui.applyProposal(turn);
  assert.equal(calls, 1); assert.equal(ui.editor.doc.title, '对话修改的标题'); assert.equal(posted.action, 'mark-applied'); assert.equal(posted.actionId, 'apply-one'); assert.equal(posted.planFingerprint, turn.assistant.baseFingerprint); assert.equal(Object.hasOwn(posted, 'resultFingerprint'), false); assert.equal(ui.applied.get(`${document.id}:${turn.id}`).unconfirmed, false);
});

test('a failed receipt preserves applied changes and retries only saving the receipt', async () => {
  const { ui, document } = harness(), turn = { id: 'turn-failed-receipt', assistant: { operations: [{ op: 'set-title', title: '已应用' }], baseFingerprint: documentFingerprint(document) }, actions: [{ id: 'receipt-one', kind: 'mark-applied' }] }; let edits = 0, posts = 0;
  ui.editor.applyConversationOperations = commands => { edits++; const result = applyWorkflowOperations(ui.editor.doc, commands); ui.editor.doc = result.document; return result; };
  ui.api = async path => { if (path.endsWith('/validate-proposal')) return validProposal(document.id, turn, document); if (++posts === 1) throw new Error('超时'); return snapshot(document.id, 1); }; await ui.applyProposal(turn); const receipt = ui.applied.get(`${document.id}:${turn.id}`);
  assert.equal(receipt.unconfirmed, true); assert.match(ui.state().error, /不要重复应用/); await ui.applyProposal(turn); assert.equal(edits, 1); await ui.recordApplied(turn, receipt); assert.equal(receipt.unconfirmed, false); assert.equal(edits, 1); assert.equal(posts, 2);
});

test('stale plans and archived or nested workflows never invoke the editing command', async () => {
  const { ui, document } = harness(), turn = { id: 'turn-stale', assistant: { operations: [{ op: 'set-title', title: '错误覆盖' }], baseFingerprint: documentFingerprint(document) } }; let calls = 0; ui.editor.applyConversationOperations = () => { calls++; };
  ui.editor.doc.title = '手动修改'; await ui.applyProposal(turn); assert.match(ui.state().error, /画布已变化/); ui.editor.libraryReadOnly = true; await ui.applyProposal(turn); ui.editor.libraryReadOnly = false; ui.editor.nodeLibrary = { nested: {} }; await ui.applyProposal(turn); assert.equal(calls, 0);
});

test('a denied or uncertain proposal validation never edits the canvas or creates an application receipt', async () => {
  for (const failure of ['当前助手权限未开放此工具', '连接超时']) {
    const { ui, document } = harness(), turn = { id: 'blocked-proposal', assistant: { operations: [{ op: 'set-title', title: '不应修改' }], baseFingerprint: documentFingerprint(document) } };
    let edits = 0, posts = 0;
    ui.editor.applyConversationOperations = () => { edits++; };
    ui.api = async path => { posts++; assert(path.endsWith('/validate-proposal')); throw Error(failure); };
    await ui.applyProposal(turn);
    assert.equal(edits, 0); assert.equal(posts, 1); assert.equal(ui.applied.size, 0);
    assert.equal(documentFingerprint(ui.editor.doc), turn.assistant.baseFingerprint); assert.match(ui.state().error, new RegExp(failure));
  }
});

test('proposal validation waits for admission and rechecks canvas and workflow selection before editing', async () => {
  for (const changed of ['canvas', 'workflow', 'readonly', 'dismissed']) {
    const { ui, document } = harness(), gate = deferred(), turn = { id: 'waiting-validation', status: 'proposed', assistant: { operations: [{ op: 'set-title', title: '候选' }], baseFingerprint: documentFingerprint(document) } };
    let edits = 0; ui.editor.applyConversationOperations = () => { edits++; };
    ui.api = async path => { assert(path.endsWith('/validate-proposal')); return gate.promise; };
    const applying = ui.applyProposal(turn); assert.equal(edits, 0);
    if (changed === 'canvas') ui.editor.doc.title = '人工改动';
    if (changed === 'workflow') ui.workflowId = 'another-workflow';
    if (changed === 'readonly') ui.editor.libraryReadOnly = true;
    if (changed === 'dismissed') ui.state().conversation.turns = [{ ...turn, status: 'dismissed' }];
    gate.resolve(validProposal(document.id, turn, document)); await applying;
    assert.equal(edits, 0); assert.equal(ui.applied.size, 0); assert(ui.state(document.id).error);
  }
});

test('a validation reply for another target or different candidate cannot authorize canvas changes', async () => {
  for (const change of [value => ({ ...value, workflowId: 'foreign-workflow' }), value => ({ ...value, resultFingerprint: 'different-candidate' })]) {
    const { ui, document } = harness(), turn = { id: 'mismatched-validation', assistant: { operations: [{ op: 'set-title', title: '不得应用' }], baseFingerprint: documentFingerprint(document) } };
    let edits = 0; ui.editor.applyConversationOperations = () => { edits++; };
    ui.api = async () => change(validProposal(document.id, turn, document));
    await ui.applyProposal(turn); assert.equal(edits, 0); assert.equal(ui.applied.size, 0);
    assert.equal(documentFingerprint(ui.editor.doc), turn.assistant.baseFingerprint);
  }
});

test('a chat-initiated run keeps logs folded and exposes the run result, while preflight errors remain visible in chat', async () => {
  const { ui, run } = harness(); let expanded; ui.runtime.start = async () => {}; ui.runtime.setExpanded = value => { expanded = value; }; await ui.startRun(); assert.equal(expanded, false); assert.equal(ui.resultOpen, run.id);
  ui.runtime.notice = { hidden: false, textContent: '输入资料未准备好', classList: { contains: value => value === 'error' } }; expanded = undefined; await ui.startRun(); assert.equal(expanded, undefined); assert.equal(ui.state().error, '输入资料未准备好');
});

test('ending an old proposal preserves history and cannot dismiss an actual pending review', async () => {
  const { ui, document } = harness(), turn = { id: 'old-proposal', status: 'proposed', assistant: { text: '保留原建议' }, actions: [{ kind: 'mark-applied' }] }; let posts = 0;
  ui.api = async (_path, options) => { posts++; assert.deepEqual(options.body, { action: 'dismiss-turn' }); return snapshot(document.id, 1, [{ ...turn, status: 'dismissed' }]); }; await ui.dismissTurn(turn);
  assert.equal(ui.state().conversation.turns[0].assistant.text, turn.assistant.text); assert.equal(conversationTurnGroups(ui.state().conversation.turns).unresolved.length, 0); assert.equal(canDismissConversationTurn({ status: 'awaiting_action', actions: [{ kind: 'review-approve' }] }), false);
  await ui.dismissTurn({ id: 'review', status: 'awaiting_action', actions: [{ kind: 'review-revise' }] }); assert.equal(posts, 1);
});

test('opening chat closes an empty properties drawer while preserving a selected node inspector', t => {
  const previous = globalThis.requestAnimationFrame; globalThis.requestAnimationFrame = callback => callback(); t.after(() => previous === undefined ? delete globalThis.requestAnimationFrame : globalThis.requestAnimationFrame = previous);
  const { ui } = harness(); ui.panel = { hidden: true }; ui.openButton = { hidden: false }; ui.editor.root = { classList: { toggle() {} } }; ui.editor.settings = { propertiesClosed: false }; ui.editor.selection.clear(); let applied = 0; ui.editor.applySettings = () => { applied++; };
  WorkflowConversationUI.prototype.toggle.call(ui, true); assert.equal(ui.editor.settings.propertiesClosed, true); assert.equal(applied, 1);
  ui.editor.settings.propertiesClosed = false; ui.editor.selection.add('trim'); WorkflowConversationUI.prototype.toggle.call(ui, true); assert.equal(ui.editor.settings.propertiesClosed, false); assert.equal(applied, 1);
});

test('the composer remains concise for a bound review and after it completes', () => {
  const { ui, run } = harness(); ui.editor.doc.nodes[0].type = 'human'; run.document.nodes[0].type = 'human'; run.nodes.trim.status = 'waiting_review'; ui.state().intent = 'discuss'; ui.renderComposerHelp(); assert.equal(ui.input.placeholder, '输入消息');
  run.nodes.trim.status = 'complete'; ui.renderComposerHelp(); assert.equal(ui.input.placeholder, '输入消息');
});

test('the composer defaults to automatic routing and a direct run message uses the existing runtime once', async () => {
  const { ui } = harness(); let started = 0, posts = 0;
  assert.equal(ui.state().intent, 'auto');
  ui.runtime.start = async () => { started++; }; ui.runtime.setExpanded = () => {};
  ui.api = async () => { posts++; throw Error('Run commands must use runtime preflight'); };
  ui.state().draft = '开始运行'; await ui.send();
  assert.equal(started, 1); assert.equal(posts, 0); assert.equal(ui.state().draft, '');
});

test('automatic composer does not turn a question about running into a command', async () => {
  const { ui, document } = harness(); let started = 0, body;
  ui.runtime.start = async () => { started++; }; ui.state().draft = '我可以现在运行吗？';
  ui.api = async (_path, options) => { body = options.body; return snapshot(document.id, 1); };
  await ui.send(); assert.equal(started, 0); assert.equal(body.intent, 'auto');
});
