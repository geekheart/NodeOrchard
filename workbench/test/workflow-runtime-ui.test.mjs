import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowRuntimeUI, runtimeNodeOrder, runtimeNodeDetails, runtimeResultPreview, workflowSnapshotChanged, workflowNeedsHermes, runtimeCapabilityMetadata, skillDisplayName, skillVersionLabel } from '../public/workflow-runtime-ui.js';
import { createDocument, createNode, connectNodes } from '../shared/workflow/workflow-model.mjs';

function chain(count = 2) {
  let document = createDocument({ title: '多步执行' });
  const nodes = [createNode('input', { x: 0, y: 0 }, { id: 'entry', config: { outputType: 'any' } }),
    ...Array.from({ length: count }, (_, index) => createNode('skill', { x: 200 + index * 250, y: 0 }, {
      id: `skill-${index}`, title: `完整的第 ${index + 1} 项节点名称`, config: { inputType: 'any', outputType: 'any', skillRef: `real-${index}`, version: `sha256:${String(index).repeat(64)}` },
    })), createNode('output', { x: 900, y: 0 }, { id: 'exit' })];
  document.nodes = nodes;
  for (let i = 1; i < nodes.length; i++) document = connectNodes(document, { sourceNode: nodes[i - 1].id, sourcePort: 'out', targetNode: nodes[i].id, targetPort: 'in' });
  return document;
}
function run(document = chain(), overrides = {}) {
  return { id: 'run-a', workflowId: document.id, document, status: 'running', currentNodeId: 'skill-1',
    nodeOrder: ['entry', 'skill-0', 'skill-1', 'exit'], skills: [{ nodeId: 'skill-0', name: 'real-0', revision: `sha256:${'0'.repeat(64)}` }, { nodeId: 'skill-1', name: 'real-1', revision: `sha256:${'1'.repeat(64)}` }],
    input: 'initial input', output: null, outputText: '', partialText: 'second partial', sessionId: 'second-session',
    nodes: { entry: { status: 'complete', output: 'initial input' }, 'skill-0': { status: 'complete', input: 'initial input', output: 0, sessionId: 'first-session' },
      'skill-1': { status: 'running', input: 0, partialText: 'second partial', sessionId: 'second-session' }, exit: { status: 'pending' } }, ...overrides };
}

test('historical order follows snapshot edges rather than node storage order', () => {
  const value = run(); delete value.nodeOrder; value.document.nodes.reverse();
  assert.deepEqual(runtimeNodeOrder(value), ['entry', 'skill-0', 'skill-1', 'exit']);
  assert.equal(runtimeNodeDetails(value, 'skill-0').node.title, '完整的第 1 项节点名称');
});

test('node input/output preserve false, zero, null and empty text independently', () => {
  for (const input of [false, 0, null, '']) for (const output of [false, 0, null, '']) {
    const value = run(); value.nodes['skill-1'] = { status: 'complete', input, output, sessionId: 'second-session' };
    const detail = runtimeNodeDetails(value, 'skill-1');
    assert.equal(detail.hasInput, true); assert.equal(detail.hasOutput, true); assert.equal(detail.input, input); assert.equal(detail.output, output);
    assert.equal(detail.sessionId, 'second-session'); assert.equal(runtimeNodeDetails(value, 'skill-0').sessionId, 'first-session');
  }
});

test('future or skipped nodes never borrow top-level or previous-step I/O', () => {
  const value = run();
  for (const status of ['pending', 'skipped']) {
    value.nodes['skill-1'] = { status }; const detail = runtimeNodeDetails(value, 'skill-1');
    assert.equal(detail.hasInput, false); assert.equal(detail.hasOutput, false); assert.equal(detail.sessionId, '');
    assert.notEqual(runtimeResultPreview(value).kind, 'partial', 'a future node must not display previous top-level fragments');
  }
});

test('downstream failure retains completed upstream output and its own task link', () => {
  const value = run(undefined, { status: 'error', error: 'second failed' }); value.nodes['skill-1'].status = 'error'; value.nodes['skill-1'].error = 'second failed'; value.nodes.exit.status = 'skipped';
  assert.equal(runtimeNodeDetails(value, 'skill-0').output, 0);
  assert.equal(runtimeNodeDetails(value, 'skill-0').status, 'complete');
  assert.equal(runtimeNodeDetails(value, 'skill-0').partialText, '');
  assert.equal(runtimeNodeDetails(value, 'skill-1').partialText, 'second partial');
  assert.equal(runtimeNodeDetails(value, 'exit').hasOutput, false);
  assert.equal(runtimeResultPreview(value).kind, 'partial'); assert.equal(runtimeResultPreview(value).hasValue, false);
});

test('legacy three-node history degrades without inventing a failed middle result', () => {
  const document = chain(1), value = { id: 'old', document, input: false, output: null, outputText: 'null', status: 'complete', sessionId: 'legacy-task', skill: { name: 'real-0', revision: `sha256:${'0'.repeat(64)}` }, nodes: { entry: { status: 'complete' }, 'skill-0': { status: 'complete' }, exit: { status: 'complete' } } };
  assert.deepEqual(runtimeNodeOrder(value), ['entry', 'skill-0', 'exit']);
  assert.equal(runtimeNodeDetails(value, 'skill-0').input, false);
  assert.equal(runtimeNodeDetails(value, 'skill-0').hasOutput, true); assert.equal(runtimeNodeDetails(value, 'skill-0').output, null);
  assert.equal(runtimeNodeDetails(value, 'skill-0').sessionId, 'legacy-task'); assert.equal(runtimeNodeDetails(value, 'exit').sessionId, '');
  value.status = 'error'; value.nodes['skill-0'].status = 'error'; value.nodes.exit.status = 'pending';
  assert.equal(runtimeNodeDetails(value, 'skill-0').hasOutput, false); assert.equal(runtimeNodeDetails(value, 'exit').hasInput, false);
});

test('final output accepts actual null/false/zero and never promotes a partial to success', () => {
  for (const output of [null, false, 0, '']) {
    const preview = runtimeResultPreview(run(undefined, { status: 'complete', output, outputText: undefined }));
    assert.equal(preview.hasValue, true); assert.equal(preview.kind, 'complete'); assert.equal(preview.text, typeof output === 'string' ? output : JSON.stringify(output));
  }
  assert.equal(runtimeResultPreview(run(undefined, { status: 'unknown' })).hasValue, false);
});

test('draft-change indicator ignores viewport/position but detects execution or node-title changes', () => {
  const value = run(), draft = structuredClone(value.document); draft.viewport.x += 50; draft.nodes[0].x += 30;
  assert.equal(workflowSnapshotChanged(value, draft), false);
  draft.nodes[1].config.skillRef = 'different'; assert.equal(workflowSnapshotChanged(value, draft), true);
  const renamed = structuredClone(value.document); renamed.nodes[1].title = 'new title'; assert.equal(workflowSnapshotChanged(value, renamed), true);
});

class FakeElement {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.textContent = ''; this.value = ''; this.disabled = false; this.hidden = false; this.listeners = new Map(); this.classList = { toggle() {} }; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { if (this.children.includes(globalThis.document?.activeElement)) globalThis.document.activeElement = null; this.children = [...items]; }
  setAttribute(key, value) { this.attributes[key] = value; if (key === 'href') this.href = value; }
  getAttribute(key) { return this.attributes[key] ?? null; }
  focus() { if (globalThis.document) globalThis.document.activeElement = this; }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
}
function fakeDOM(t) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const document = { createElement: tag => new FakeElement(tag), activeElement: null };
  Object.defineProperty(globalThis, 'document', { value: document, configurable: true });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'document', descriptor); else delete globalThis.document; }); return document;
}
function headless(value) {
  const instance = Object.create(WorkflowRuntimeUI.prototype); const elementNames = ['recentSelect', 'statusNode', 'summaryNode', 'runInfo', 'error', 'outputLabel', 'output', 'copyButton', 'downloadButton', 'stopButton', 'inputSnapshotDetails', 'inputSnapshot', 'input', 'startButton', 'inputLabel', 'inputHint', 'draftNotice', 'nodeInspection', 'trace', 'nodeTitle', 'nodeStatus', 'nodeMeta', 'nodeError', 'nodeInput', 'nodeOutputLabel', 'nodeOutput', 'nodeTask', 'approval', 'refreshButton', 'connection', 'nodeLogs', 'nodeStdout', 'nodeStderr', 'nodeLogNotice'];
  for (const key of elementNames) instance[key] = new FakeElement(key);
  Object.assign(instance, { editor: { doc: structuredClone(value.document), root: { querySelector: () => null }, setRunStates(states) { instance.paintedStates = states; } }, runs: new Map([[value.id, value]]), revisions: new Map(), revision: 0, currentRunId: value.id, workflowId: value.workflowId, selectedNodeId: null, nodeSelectionPinned: false, traceElements: new Map(), skillPending: new Set(), stopping: new Set(), stopRequested: new Set(), starting: false, loading: false, getBackend: () => ({ state: 'ready' }), getRequests: () => [], taskURL: id => `#/task/${id}`, scheduleRender() {} });
  return instance;
}

test('Skill labels keep capability names separate from learned version identities', () => {
  const skill = { name: 'internal-capability', displayName: '导出与命名' };
  assert.equal(skillDisplayName(skill), '导出与命名');
  assert.equal(skillDisplayName({ name: 'internal-capability' }), 'internal-capability');
  assert.equal(skillVersionLabel(skill), '');
  assert.equal(skillVersionLabel({ ...skill, name: 'wb-learn-reference', source: 'learned', revision: `sha256:${'a'.repeat(64)}` }), '已学习 · aaaaaaaa');
  assert.equal(skillVersionLabel({ name: 'wb-learn-reference', source: 'learned' }), '已学习');
  assert.deepEqual(runtimeCapabilityMetadata({ node: { type: 'skill', config: { skillRef: skill.name } }, skill }), ['Hermes Skill', '导出与命名']);
  assert.equal(skill.name, 'internal-capability');
});

test('learning-only nodes explain their skipped state without borrowing business outputs', () => {
  const value = run(); value.document.nodes.push(createNode('evaluation', { x: 600, y: 200 }, { id: 'evaluation' }));
  value.nodes.evaluation = { status: 'skipped', reason: '执行模式跳过学习支路' };
  const detail = runtimeNodeDetails(value, 'evaluation');
  assert.equal(detail.status, 'skipped'); assert.equal(detail.hasInput, false); assert.equal(detail.hasOutput, false);
  assert.deepEqual(runtimeCapabilityMetadata(detail), ['产物对比', '仅学习', '执行模式跳过学习支路']);
});

test('Skill picker shows and searches aliases while selection and detail requests retain canonical references', async t => {
  fakeDOM(t);
  const base = { name: 'generic-exporter', displayName: '导出与命名', source: 'local', revision: `sha256:${'a'.repeat(64)}` };
  const learned = { name: 'wb-learn-canonical-reference', baseName: base.name, displayName: '导出与命名', source: 'learned', revision: `sha256:${'b'.repeat(64)}` };
  const instance = Object.create(WorkflowRuntimeUI.prototype), calls = [];
  const workflowNode = createNode('skill', { x: 0, y: 0 }, { id: 'picker-skill' }); const pickerDocument = createDocument(); pickerDocument.nodes = [workflowNode];
  Object.assign(instance, { pickers: new Set(), skills: { connected: true, skills: [base, learned] }, skillPending: new Set(),
    editor: { doc: pickerDocument, propertyDrafts: new Map(), renderHeader() {} },
    getBackend: () => ({ state: 'ready' }), updateRunButton() {}, api: async path => { calls.push(path); return path.endsWith(learned.name) ? learned : base; } });
  const form = new FakeElement('form');
  instance.mountSkillPicker(form, workflowNode);
  await new Promise(resolve => setImmediate(resolve));
  const wrapper = form.children[0], [, skillRef, version, search, select] = wrapper.children;
  skillRef.dispatchEvent = () => {};
  assert.deepEqual(select.children.slice(1).map(option => [option.value, option.textContent]), [
    [base.name, '导出与命名'], [learned.name, '导出与命名 · 已学习 · bbbbbbbb'],
  ]);
  search.value = '导出与命名'; search.listeners.get('input')({ stopPropagation() {} });
  assert.equal(select.children.length, 3);
  search.value = learned.name; search.listeners.get('input')({ stopPropagation() {} });
  assert.deepEqual(select.children.slice(1).map(option => option.value), [learned.name]);
  select.value = learned.name; select.listeners.get('change')();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(skillRef.value, learned.name);
  assert.equal(version.value, learned.revision);
  assert.equal(calls.at(-1), '/api/skills/' + learned.name);
});

test('stream updates keep typed input, focus and pinned upstream node details intact', t => {
  const document = fakeDOM(t), value = run(), instance = headless(value); instance.input.value = 'next run draft'; instance.input.selectionStart = 4; document.activeElement = instance.input;
  instance.render(); instance.onSelectionChange('skill-0'); const traceButton = instance.traceElements.get('skill-0').select;
  instance.handleEvent({ type: 'workflow.run', payload: { ...structuredClone(value), partialText: 'new step fragment', nodes: { ...value.nodes, 'skill-1': { ...value.nodes['skill-1'], partialText: 'new step fragment' } } } }); instance.render();
  assert.equal(document.activeElement, instance.input); assert.equal(instance.input.value, 'next run draft'); assert.equal(instance.input.selectionStart, 4);
  assert.equal(instance.selectedNodeId, 'skill-0'); assert.equal(instance.nodeOutput.textContent, '0'); assert.equal(instance.traceElements.get('skill-0').select, traceButton);
  assert.match(instance.output.textContent, /new step fragment/); assert.equal(instance.nodeTask.children.at(-1).href, '#/task/first-session');
  instance.editor.propertyDrafts = new Map([['skill-0', { config: { skillRef: 'unapplied' } }]]);
  instance.updateRunButton(); assert.equal(instance.draftNotice.hidden, false); assert.deepEqual(instance.paintedStates, {});
  instance.editor.propertyDrafts.clear(); instance.updateRunButton(); assert.equal(instance.draftNotice.hidden, true); assert.equal(instance.paintedStates['skill-0'].status, 'complete');
  instance.editor.doc.nodes[1].title = 'edited draft'; instance.render(); assert.equal(instance.draftNotice.hidden, false); assert.deepEqual(instance.paintedStates, {});
});

test('streamed task links retain the focused anchor while approval counts and status change', t => {
  const document = fakeDOM(t), value = run(), instance = headless(value); let requests = [];
  instance.getRequests = () => requests; instance.render();
  const link = instance.nodeTask.children.at(-1), notice = instance.nodeTask.children[0]; link.focus();
  assert.equal(notice.hidden, true); assert.equal(link.href, '#/task/second-session');
  for (const count of [1, 2, 0]) {
    requests = Array.from({ length: count }, () => ({ sessionId: 'second-session' }));
    const update = structuredClone(value); update.nodes['skill-1'].partialText = `fragment ${count}`;
    instance.handleEvent({ type: 'workflow.run', payload: update }); instance.render();
    assert.equal(instance.nodeTask.children.at(-1), link); assert.equal(instance.nodeTask.children[0], notice);
    assert.equal(document.activeElement, link); assert.equal(notice.hidden, count === 0);
    assert.equal(notice.textContent, count ? `${count} 项审批或澄清待处理` : '');
    assert.equal(link.textContent, count ? '打开任务并处理' : '查看该步骤关联任务');
  }
  instance.renderTaskLink(instance.nodeTask, 'second-session', 'waiting');
  assert.equal(instance.nodeTask.children.at(-1), link); assert.equal(document.activeElement, link);
  assert.equal(notice.textContent, '等待人工处理');
  instance.renderTaskLink(instance.nodeTask, null, 'pending'); assert.equal(instance.nodeTask.hidden, true);
  instance.renderTaskLink(instance.nodeTask, 'first-session', 'complete');
  assert.equal(instance.nodeTask.children.at(-1), link); assert.equal(link.href, '#/task/first-session');
});

test('terminal state cannot regress under a late running or conflicting terminal event', () => {
  const value = run(undefined, { status: 'error' }), instance = headless(value);
  instance.storeRun({ ...value, status: 'running' }); assert.equal(instance.runs.get(value.id).status, 'error');
  instance.storeRun({ ...value, status: 'complete' }); assert.equal(instance.runs.get(value.id).status, 'error');
});

test('an actual newer rerun attempt can advance a terminal cache before its chat GET completes', () => {
  const value = run(undefined, { status: 'error' }), id = value.document.nodes.find(item => item.type === 'skill').id;
  value.nodes[id] = { ...value.nodes[id], attempt: 1, attemptId: 'first-attempt', history: [], status: 'error' };
  const instance = headless(value), newer = structuredClone(value);
  newer.status = 'complete'; newer.nodes[id] = { ...newer.nodes[id], attempt: 2, attemptId: 'second-attempt', status: 'complete', history: [structuredClone(value.nodes[id])] };
  instance.storeRun(newer); assert.equal(instance.runs.get(value.id).status, 'complete');
  instance.storeRun({ ...value, status: 'running' }); assert.equal(instance.runs.get(value.id).status, 'complete');
  const foreignDocument = structuredClone(newer); foreignDocument.document.title = 'different snapshot'; foreignDocument.status = 'running'; foreignDocument.nodes[id].history.push({ attempt: 2, attemptId: 'second-attempt' });
  instance.storeRun(foreignDocument); assert.equal(instance.runs.get(value.id).status, 'complete');
});

test('opening scheduled history switches presentation mode without replacing the draft or executing', async () => {
  const value = run(undefined, { status: 'complete', trigger: { type: 'schedule', scheduleId: 'schedule-a' } }), instance = headless(value);
  instance.editor.doc.mode = 'learn'; const nodes = structuredClone(instance.editor.doc.nodes);
  const calls = []; instance.learning = { inspectionRunId: 'previous-case', syncMode: () => calls.push('sync') };
  instance.editor.commit = document => { instance.editor.doc = document; calls.push('mode'); };
  instance.api = async path => { calls.push(path); return value; };
  instance.render = () => calls.push('render'); instance.setExpanded = () => calls.push('expanded');
  await instance.openScheduledRun(value.id);
  assert.equal(instance.editor.doc.mode, 'execute'); assert.deepEqual(instance.editor.doc.nodes, nodes);
  assert.equal(instance.learning.inspectionRunId, null); assert.equal(instance.currentRunId, value.id);
  assert.equal(instance.selectedNodeId, null); assert.deepEqual(calls, ['/api/workflow-runs/run-a', 'mode', 'sync', 'render', 'expanded']);
});

test('scheduled history cannot open a different workflow or overwrite newer streamed state', async () => {
  const value = run(), instance = headless(value); instance.render = () => {}; instance.setExpanded = () => {};
  instance.api = async () => ({ ...value, workflowId: 'different-workflow' });
  await assert.rejects(instance.openScheduledRun(value.id), /不匹配/);
  assert.equal(instance.currentRunId, value.id);
  instance.api = async () => { instance.storeRun({ ...value, status: 'complete', output: 'newest' }); return value; };
  await instance.openScheduledRun(value.id); assert.equal(instance.currentRun().status, 'complete'); assert.equal(instance.currentRun().output, 'newest');
});

test('run control distinguishes preparing, running and waiting on the same node', () => {
  const value = run(), instance = headless(value);
  for (const [status, label] of [['preparing', '准备第 2/2 项'], ['running', '正在执行第 2/2 项'], ['waiting', '第 2/2 项待处理']]) {
    instance.runs.set(value.id, { ...value, status }); instance.updateRunButton(); assert.equal(instance.startButton.textContent, label); assert.equal(instance.startButton.disabled, true);
  }
});

test('late history response cannot overwrite newer per-node SSE data', async t => {
  fakeDOM(t); const value = run(), instance = headless(value); let resolve;
  instance.api = () => new Promise(complete => { resolve = complete; }); instance.showNotice = () => {};
  const loading = instance.loadRecent(); const fresh = structuredClone(value); fresh.nodes['skill-1'] = { status: 'complete', input: 0, output: false, sessionId: 'second-session' }; fresh.currentNodeId = 'exit';
  instance.handleEvent({ type: 'workflow.run', payload: fresh }); resolve({ runs: [value] }); await loading;
  const actual = runtimeNodeDetails(instance.currentRun(), 'skill-1'); assert.equal(actual.status, 'complete'); assert.equal(actual.output, false); assert.equal(instance.currentRun().currentNodeId, 'exit');
});

test('shared multi-Skill plan is used before POST and double start submits only once', async () => {
  const value = run(), instance = headless(value); instance.runs.clear(); instance.input.value = 'false';
  let prepareResolve, postResolve, submits = 0; const prepared = new Promise(resolve => prepareResolve = resolve), posted = new Promise(resolve => postResolve = resolve);
  Object.assign(instance, { setExpanded() {}, syncWorkflow() {}, updateRunButton() {}, showNotice() {}, render() {}, api: async (_path, options) => { submits++; assert.equal(options.body.input, false); assert.equal(options.body.document.nodes.length, 4); return posted; } });
  instance.editor.prepareRun = () => prepared;
  const first = instance.start(); await instance.start(); prepareResolve(value.document); await new Promise(resolve => setImmediate(resolve)); assert.equal(submits, 1);
  instance.handleEvent({ type: 'workflow.run', payload: { ...value, status: 'complete' } }); postResolve(value); await first;
  assert.equal(instance.runs.get(value.id).status, 'complete');
});

test('a chat-started run explains the exact missing preparation instead of pointing to a hidden panel', async () => {
  const document = localDocument(); document.schemaVersion = 2;
  const instance = headless(run(document)); instance.runs.clear(); instance.input.value = 'fixed task';
  let notice = '', submits = 0;
  Object.assign(instance, { setExpanded() {}, syncWorkflow() {}, updateRunButton() {}, render() {},
    showNotice(message) { notice = message; }, api: async () => { submits++; } });
  instance.editor.prepareRun = () => document;
  instance.editor.studio = { syncRawInput() {}, preflight: async () => ({ ok: false,
    errors: [{ label: '输出目录', message: '请选择普通资料目录。' }] }) };
  await instance.start();
  assert.equal(submits, 0);
  assert.match(notice, /输出目录：请选择普通资料目录/);
});

test('adding another Skill remains available during a run and edits only the draft', async () => {
  const value = run(), instance = headless(value); let calls = 0; instance.editor.insertSkillAfterSelected = () => { calls++; return { title: 'new Skill' }; };
  Object.assign(instance, { refreshBackend() {}, showNotice() {}, setExpanded() {} });
  const before = structuredClone(value); await instance.insertSkill(); assert.equal(calls, 1); assert.deepEqual(instance.runs.get(value.id), before);
});

function localDocument() {
  const document = chain(1), old = document.nodes[1];
  document.nodes[1] = createNode('tool', { x: old.x, y: old.y }, { id: old.id, title: '本地代码', config: { executionMode: 'code', inputType: 'any', outputType: 'any', code: 'return input', language: 'python' } });
  return document;
}

test('tool/code steps count as operations and display runtime metadata and their own logs', t => {
  fakeDOM(t); const document = chain(), old = document.nodes[1];
  document.nodes[1] = createNode('tool', { x: 0, y: 0 }, { id: old.id, title: '代码转换', config: { executionMode: 'code', inputType: 'any', outputType: 'any', language: 'python', code: 'return input' } });
  const value = run(document, { currentNodeId: old.id, sessionId: null }); value.nodes[old.id] = { status: 'running', input: false, runtime: { kind: 'code', language: 'python', revision: 'sha256:code' }, logs: { stdout: 'local output', stderr: 'debug trace', stderrTruncated: true } };
  const instance = headless(value); instance.render();
  assert.equal(instance.startButton.textContent, '正在执行第 1/2 项'); assert.equal(instance.summaryNode.textContent, '正在执行第 1/2 项');
  assert.match(instance.nodeMeta.textContent, /代码\nPython\n执行快照 sha256:code/); assert.equal(instance.nodeStdout.textContent, 'local output'); assert.equal(instance.nodeStderr.textContent, 'debug trace');
  assert.equal(instance.nodeLogNotice.textContent, 'stderr 已截断'); assert.equal(instance.nodeTask.hidden, true); assert.equal(instance.approval.hidden, true);
  const detail = runtimeNodeDetails(value, old.id); detail.runtime = { kind: 'tool', toolName: 'text.trim', revision: 'sha256:tool' }; detail.node.config.executionMode = 'tool';
  assert.equal(runtimeCapabilityMetadata(detail)[0], '内置工具');
  assert(!runtimeCapabilityMetadata(detail).includes('Hermes Skill'));
});

test('pure local code can submit while Hermes is offline; mixed Skill flow cannot', async () => {
  const document = localDocument(), value = run(document, { nodeOrder: ['entry', 'skill-0', 'exit'], skills: [], currentNodeId: 'skill-0' });
  assert.equal(workflowNeedsHermes(document), false); assert.equal(workflowNeedsHermes(chain()), true);
  const instance = headless(value); instance.runs.clear(); instance.input.value = 'false'; let posts = 0; let message = '';
  instance.skillPending.add({});
  Object.assign(instance, { getBackend: () => ({ state: 'stopped' }), setExpanded() {}, syncWorkflow() {}, updateRunButton() {}, showNotice(value = '') { message = value; }, render() {},
    api: async (_path, options) => { posts++; assert.equal(options.body.input, false); return { ...value, status: 'complete', output: false }; } });
  instance.editor.prepareRun = () => document; await instance.start(); assert.equal(posts, 1); assert.equal(message, '');
  instance.runs.clear(); instance.skillPending.clear(); instance.editor.doc = chain(); instance.editor.prepareRun = () => instance.editor.doc;
  await instance.start(); assert.equal(posts, 1); assert.match(message, /包含 Skill.*连接 Hermes/);
});

test('adding tool/code during a run edits the draft without replacing the active snapshot', async () => {
  const value = run(), instance = headless(value), before = structuredClone(value); let count = 0;
  instance.editor.insertToolAfterSelected = () => { count++; return { title: '代码' }; };
  Object.assign(instance, { refreshBackend() {}, showNotice() {}, setExpanded() {} });
  await instance.insertTool(); assert.equal(count, 1); assert.deepEqual(instance.runs.get(value.id), before);
});

test('result toolbar feedback entry only opens an eligible review and never submits or changes run input', t => {
  fakeDOM(t); const center = new FakeElement('div'), root = new FakeElement('div'), instance = Object.create(WorkflowRuntimeUI.prototype); root.querySelector = () => center; instance.editor = { root };
  instance.mount(); const calls = []; instance.input.value = 'next input stays'; instance.api = () => { throw new Error('opening feedback must not submit'); };
  instance.feedback = { canOpen: () => false, open: () => calls.push('open') }; instance.setExpanded = () => calls.push('expanded');
  assert.equal(instance.feedbackButton.textContent, '反馈与改进'); assert.equal(instance.feedbackButton.disabled, true);
  instance.feedbackButton.listeners.get('click')(); assert.deepEqual(calls, []);
  instance.feedback.canOpen = () => true; instance.feedbackButton.disabled = false; instance.feedbackButton.listeners.get('click')();
  assert.deepEqual(calls, ['expanded', 'open']); assert.equal(instance.input.value, 'next input stays');
});
