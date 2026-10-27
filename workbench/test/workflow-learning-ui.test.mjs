import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowLearningUI, parseLearningExpected, parseLearningValidation, learningSnapshotChanged, learningBestRound, learningCaseResult, learningDatasetForJob, learningRoundRows, learningRoundMetrics, mergeLearningDatasets, learningMemoryStatus, learningSetupForDocument, learningSourceLabel, mainChainSkillNodes } from '../public/workflow-learning-ui.js';
import { WorkflowEditor } from '../public/workflow-editor.js';
import { WorkflowRuntimeUI } from '../public/workflow-runtime-ui.js';
import { createDocument, createNode, connectNodes } from '../shared/workflow/workflow-model.mjs';

const revision = `sha256:${'a'.repeat(64)}`, nextRevision = `sha256:${'b'.repeat(64)}`;
function document({ branch = true, targets = ['skill'], comparison = 'exact', valuePath = '' } = {}) {
  let value = createDocument({ title: '学习测试' }); value.mode = 'learn';
  value.nodes = [createNode('input', { x: 0, y: 0 }, { id: 'entry', config: { outputType: 'any', required: false } }), createNode('skill', { x: 300, y: 0 }, { id: 'skill', title: '真实 Skill', config: { inputType: 'any', outputType: 'any', skillRef: 'original', version: revision } }), createNode('output', { x: 600, y: 0 }, { id: 'exit' })];
  value = connectNodes(value, { sourceNode: 'entry', sourcePort: 'out', targetNode: 'skill', targetPort: 'in' });
  value = connectNodes(value, { sourceNode: 'skill', sourcePort: 'out', targetNode: 'exit', targetPort: 'in' });
  if (!branch) return value;
  value.nodes.push(createNode('evaluation', { x: 600, y: 220 }, { id: 'evaluation', title: '真实产物对比', config: { comparison, valuePath } }), createNode('improvement', { x: 900, y: 220 }, { id: 'improvement', config: { scope: 'skills', targetSkillNodeIds: targets } }));
  value = connectNodes(value, { sourceNode: 'exit', sourcePort: 'learning', targetNode: 'evaluation', targetPort: 'in' });
  return connectNodes(value, { sourceNode: 'evaluation', sourcePort: 'out', targetNode: 'improvement', targetPort: 'in' });
}
function job(overrides = {}) {
  const before = document(), best = structuredClone(before); best.mode = 'execute'; best.nodes[1].config.skillRef = 'wb-learn-candidate'; best.nodes[1].config.version = nextRevision;
  return { id: 'learning-1', workflowId: before.id, status: 'complete', phase: 'finished', document: before, input: 0, expected: false, config: { comparison: 'exact', targetScore: 90, maxRounds: 3, trainableNodeIds: ['skill'], validationCases: [] }, bestRound: 1, bestScore: 100, bestDocument: best,
    rounds: [{ index: 0, status: 'complete', score: 0, document: { ...before, mode: 'execute' }, cases: [{ runId: 'baseline', input: 0, expected: false, output: 0, status: 'complete', score: 0, role: 'train' }], changes: [] }, { index: 1, status: 'complete', score: 100, document: best, cases: [{ runId: 'candidate', input: 0, expected: false, output: false, status: 'complete', score: 100, role: 'train' }], changes: [] }], ...overrides };
}
class FakeElement {
  constructor() { this.value = ''; this.hidden = false; this.disabled = false; this.children = []; this.dataset = {}; this.attributes = {}; this.listeners = new Map(); this.textContent = ''; this.classList = { toggle() {} }; }
  append(...values) { for (const value of values) { if (value) value.parentElement = this; this.children.push(value); } }
  replaceChildren(...values) { this.children = values; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(name, handler) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(handler); }
  emit(name) { for (const callback of this.listeners.get(name) || []) callback({ target: this }); }
  focus() { if (globalThis.document) globalThis.document.activeElement = this; }
}
function fakeDOM(t) { const old = Object.getOwnPropertyDescriptor(globalThis, 'document'); const value = { createElement: () => new FakeElement(), activeElement: null }; Object.defineProperty(globalThis, 'document', { value, configurable: true }); t.after(() => old ? Object.defineProperty(globalThis, 'document', old) : delete globalThis.document); return value; }
function headless(value = job()) {
  const instance = Object.create(WorkflowLearningUI.prototype), runtime = { editor: { doc: structuredClone(value.document), propertyDrafts: new Map() }, runs: new Map(), revisions: new Map(), skillPending: new Set(), getBackend: () => ({ state: 'ready' }), activeRun: () => null, input: { value: 'execution input must stay unchanged' }, parseInput: WorkflowRuntimeUI.prototype.parseInput, storeRun(run) { this.runs.set(run.id, run); this.revisions.set(run.id, (this.revisions.get(run.id) || 0) + 1); } };
  Object.assign(instance, { runtime, editor: runtime.editor, jobs: new Map([[value.id, value]]), revisions: new Map(), revision: 0, jobId: value.id, workflowId: value.workflowId, loading: false, loaded: true, formDirty: true, starting: false, applying: false, uncertain: false, stopping: new Set(), stopRequested: new Set(), listRequest: 0, caseLoads: new Map(), caseFailures: new Set(), trainableElements: new Map(), roundElements: new Map(), dataset: learningDatasetForJob(value), datasetGroups: new Map(), metricCards: new Map(), caseRows: new Map(), caseDraftDirty: false, editingCaseId: null, importRevision: 0, pendingImport: null, selectedRound: 1, selectedCase: 0, roundPinned: true, inspectionRunId: null, setExpanded() {}, syncMode() {}, updateRunButton() {}, renderTrainable() {}, render() {}, scheduleRender() {}, showNotice(message = '') { this.noticeValue = message; } });
  for (const name of ['input', 'inputFormat', 'expected', 'expectedFormat', 'caseName', 'caseSplit', 'caseEditor', 'caseEditStatus', 'saveCaseButton', 'maxRounds', 'targetScore', 'comparison', 'comparisonHint', 'rubric', 'refresh', 'rounds', 'roundTitle', 'roundScore', 'feedback', 'cases', 'inspect', 'caseScore', 'known', 'sampleInput', 'actualLabel', 'actual', 'changes', 'importText', 'importFormat', 'importPreview', 'importPreviewInfo', 'importPreviewRows', 'addImportButton', 'replaceImportButton', 'importMessage', 'importDetails', 'memoryRecord', 'memoryLabel', 'memoryDetails']) instance[name] = new FakeElement();
  instance.input.value = '0'; instance.expectedFormat.value = 'json'; instance.expected.value = 'false'; instance.maxRounds.value = '3'; instance.targetScore.value = '90'; instance.comparison.value = 'exact';
  runtime.editor.prepareRun = () => structuredClone(runtime.editor.doc); return instance;
}

test('explicit answer formats and validation preserve null, false, zero and empty text', () => {
  assert.equal(parseLearningExpected('', 'text'), ''); assert.equal(parseLearningExpected('null', 'text'), 'null');
  for (const value of [null, false, 0, '', { a: false }, []]) assert.deepEqual(parseLearningExpected(JSON.stringify(value), 'json'), value);
  assert.throws(() => parseLearningExpected('', 'json'), /有效 JSON/);
  assert.deepEqual(parseLearningValidation('[{"input":0,"expected":false},{"input":null,"expected":""}]'), [{ input: 0, expected: false }, { input: null, expected: '' }]);
  assert.throws(() => parseLearningValidation('[{"input":1}]'), /input 和 expected/); assert.throws(() => parseLearningValidation(JSON.stringify(Array(4).fill({ input: 1, expected: 1 }))), /最多/);
});
test('learning panel mounts independent sample controls and an explicit expected format', t => {
  fakeDOM(t); const value = job(), center = new FakeElement(), topRun = new FakeElement();
  const runtime = { editor: { doc: value.document, propertyDrafts: new Map(), root: { querySelector: selector => selector === '.wf-center' ? center : topRun } }, panel: new FakeElement(), startButton: new FakeElement(), stopButton: new FakeElement(), skillPending: new Set(), getBackend: () => ({ state: 'ready' }), renderTaskLink() {}, input: new FakeElement() };
  const instance = new WorkflowLearningUI(runtime); assert.equal(instance.expectedFormat.id, 'wf-learning-expected-format'); assert.equal(instance.expectedFormat.value, 'text'); assert.equal(instance.maxRounds.value, '3'); assert.equal(instance.targetScore.value, '90'); assert.equal(instance.trainableElements.has('skill'), true); assert.equal(instance.comparison, undefined); assert.equal(runtime.panel.hidden, true); assert.equal(topRun.textContent, '开始学习'); assert.equal(topRun.attributes['aria-label'], '开始学习'); assert.notEqual(instance.input, runtime.input);
  assert.equal(instance.memoryRecord.hidden, true);
  instance.jobs.set(value.id, { ...value, status: 'running', phase: 'optimizing' }); instance.updateRunButton(); assert.equal(topRun.textContent, '调整 Skill…'); assert.equal(topRun.attributes['aria-label'], '调整 Skill…');
  instance.jobs.set(value.id, { ...value, status: 'running', phase: 'preparing-memory', memoryPolicy: { mode: 'pending', memoryWriteAllowed: null, externalMemoryAllowed: null } }); instance.updateRunButton(); assert.equal(topRun.textContent, '冻结学习记忆…'); assert.equal(topRun.attributes['aria-label'], '冻结学习记忆…');
});

function mountedInspection() {
  const value = job(), center = new FakeElement(), topRun = new FakeElement();
  const runtime = { editor: { doc: structuredClone(value.document), propertyDrafts: new Map(), root: { querySelector: selector => selector === '.wf-center' ? center : topRun } },
    panel: new FakeElement(), toggle: new FakeElement(), startButton: new FakeElement(), stopButton: new FakeElement(), input: new FakeElement(),
    runs: new Map(), revisions: new Map(), skillPending: new Set(), getBackend: () => ({ state: 'ready' }), renderTaskLink() {},
    render() { this.renderCount = (this.renderCount || 0) + 1; }, setExpanded(expanded = true) { this.expanded = expanded; } };
  const instance = new WorkflowLearningUI(runtime); instance.jobs.set(value.id, value); instance.jobId = value.id; instance.selectedRound = 1; instance.selectedCase = 0;
  instance.caseLoads.set('candidate', Promise.resolve()); instance.render(); instance.caseLoads.delete('candidate');
  return { instance, runtime };
}

test('opening a cached sample transfers focus to its runtime and returning restores the inspect control', async t => {
  const dom = fakeDOM(t), { instance, runtime } = mountedInspection();
  runtime.runs.set('candidate', { id: 'candidate', status: 'complete', output: false }); instance.inspect.focus();
  await instance.inspectCase();
  assert.equal(runtime.currentRunId, 'candidate'); assert.equal(runtime.expanded, true);
  assert.ok(dom.activeElement === runtime.toggle, 'details receive keyboard focus'); assert.equal(instance.back.hidden, false); assert.equal(runtime.panel.hidden, false);
  instance.back.focus(); instance.back.emit('click');
  assert.equal(instance.inspectionRunId, null); assert.equal(instance.back.hidden, true); assert.equal(runtime.panel.hidden, true);
  assert.equal(instance.toggle.attributes['aria-expanded'], 'true'); assert.ok(dom.activeElement === instance.inspect, 'return restores the selected sample control');
});

test('late sample loads respect a return action or changed keyboard focus and restore focus after failure', async t => {
  const dom = fakeDOM(t);
  for (const outcome of ['return', 'moved-focus', 'missing']) {
    const { instance, runtime } = mountedInspection(); let finish;
    instance.loadCase = () => new Promise(resolve => { finish = () => { if (outcome !== 'missing') runtime.runs.set('candidate', { id: 'candidate', status: 'complete', output: false }); resolve(); }; });
    instance.inspect.focus(); const pending = instance.inspectCase();
    assert.ok(dom.activeElement === instance.back, 'loading keeps the return action reachable'); assert.equal(instance.back.hidden, false);
    if (outcome === 'return') instance.back.emit('click');
    if (outcome === 'moved-focus') { instance.headerStop.hidden = false; instance.headerStop.focus(); }
    finish(); await pending;
    if (outcome === 'moved-focus') {
      assert.equal(runtime.currentRunId, 'candidate'); assert.equal(runtime.expanded, true); assert.ok(dom.activeElement === instance.headerStop, 'a late response does not steal focus');
    } else {
      assert.equal(instance.inspectionRunId, null); assert.equal(runtime.currentRunId, undefined);
      assert.equal(instance.back.hidden, true); assert.equal(runtime.panel.hidden, true); assert.ok(dom.activeElement === instance.inspect, 'return or failed loading restores the sample control');
    }
  }
});
test('best candidate requires a complete scored round and every validation score', () => {
  const value = job(); assert.equal(learningBestRound(value).index, 1); value.rounds[1].cases.push({ score: null }); assert.equal(learningBestRound(value), null);
  value.rounds[1].cases.pop(); value.rounds[1].status = 'error'; assert.equal(learningBestRound(value), null);
});
test('learn snapshot comparison ignores mode and viewport but detects node or configuration edits', () => {
  const before = document(), after = structuredClone(before); after.mode = 'execute'; after.viewport.x += 12; after.nodes[1].x += 50; assert.equal(learningSnapshotChanged(before, after), false);
  after.nodes[1].config.version = nextRevision; assert.equal(learningSnapshotChanged(before, after), true);
});
test('case results never promote partials and preserve exact typed output', () => {
  for (const output of [0, false, null, '']) { const result = learningCaseResult({ status: 'complete', output }); assert.equal(result.confirmed, true); assert.equal(result.value, typeof output === 'string' ? output : JSON.stringify(output)); }
  assert.equal(learningCaseResult({ status: 'unknown', partialText: 'not complete' }).confirmed, false); assert.match(learningCaseResult({ status: 'unknown', partialText: 'not complete' }).label, /未完成/);
});
test('learning submit freezes independent samples, submits once and preserves newer SSE over ACK', async () => {
  const value = job(), instance = headless(value); instance.jobs.clear(); let finishPrepare, finishPost, count = 0;
  instance.editor.prepareRun = () => new Promise(resolve => { finishPrepare = resolve; }); instance.api = async (path, options) => { count++; assert.equal(path, '/api/workflow-learning'); assert.equal(options.body.trainingCases[0].input, 0); assert.equal(options.body.trainingCases[0].expected, false); assert.equal(Object.hasOwn(options.body, 'input'), false); assert.equal(Object.hasOwn(options.body, 'expected'), false); assert.equal(Object.hasOwn(options.body, 'memoryPolicy'), false); assert.equal(Object.hasOwn(options.body, 'memoryScopeId'), false); assert.equal(options.body.document.mode, 'learn'); return new Promise(resolve => { finishPost = resolve; }); };
  const first = instance.start(); await instance.start(); finishPrepare(value.document); await new Promise(resolve => setImmediate(resolve)); assert.equal(count, 1); assert.equal(instance.runtime.input.value, 'execution input must stay unchanged');
  instance.handleEvent({ type: 'learning.run', payload: value }); finishPost({ ...value, status: 'running', rounds: [] }); await first;
  assert.equal(instance.currentJob().status, 'complete'); assert.equal(instance.currentJob().rounds.length, 2);
});
test('learning form validation rejects out-of-contract scores and no Skill selection before POST', async () => {
  const instance = headless(); instance.jobs.clear(); let calls = 0; instance.api = async () => { calls++; };
  for (const value of ['0', '90.5', '101']) { instance.targetScore.value = value; await instance.start(); assert.match(instance.noticeValue, /1–100/); }
  instance.targetScore.value = '90'; instance.editor.doc.nodes.find(node => node.type === 'improvement').config.targetSkillNodeIds = []; await instance.start(); assert.match(instance.noticeValue, /勾选/); assert.equal(calls, 0);
});

test('learning configuration is bound to graph nodes, not old panel controls or implicit all-Skill targets', async () => {
  const value = job(), instance = headless(value); instance.jobs.clear();
  const evaluation = instance.editor.doc.nodes.find(node => node.type === 'evaluation'); evaluation.config.comparison = 'model'; evaluation.config.valuePath = 'receipt.acceptance';
  instance.comparison.value = 'exact'; instance.trainableElements.set('unrelated-legacy-control', { input: { checked: true } });
  const before = structuredClone(instance.dataset); let submitted;
  instance.api = async (_path, options) => { submitted = options.body; return value; };
  await instance.start();
  assert.equal(submitted.comparison, 'model'); assert.deepEqual(submitted.trainableNodeIds, ['skill']);
  assert.equal(submitted.document.nodes.find(node => node.type === 'evaluation').config.valuePath, 'receipt.acceptance');
  assert.deepEqual(submitted.trainingCases, before.trainingCases); assert.deepEqual(submitted.validationCases, before.validationCases);
  assert.deepEqual(instance.dataset, before); assert.equal(instance.runtime.input.value, 'execution input must stay unchanged');
});

test('missing, incomplete or unselected learning branches fail before submission with no automatic target selection', async () => {
  const instance = headless(); instance.jobs.clear(); let calls = 0; instance.api = async () => { calls++; };
  for (const doc of [document({ branch: false }), document({ targets: [] }), document({ targets: ['entry'] })]) {
    instance.editor.doc = doc; await instance.start(); assert.match(instance.noticeValue, /产物对比|勾选|主链/);
  }
  const incomplete = document(); incomplete.edges = incomplete.edges.filter(edge => edge.targetNode !== 'improvement');
  instance.editor.doc = incomplete; await instance.start(); assert.match(instance.noticeValue, /完整连接/); assert.equal(calls, 0);
  assert.throws(() => learningSetupForDocument(document({ targets: [] })), /明确勾选/);
});

test('learning setup shows the explicit intermediate comparison source and excludes disconnected Skills', () => {
  let doc = document({ valuePath: 'receipt.acceptance' }); doc.edges = doc.edges.filter(edge => edge.targetNode !== 'evaluation');
  doc = connectNodes(doc, { sourceNode: 'skill', sourcePort: 'out', targetNode: 'evaluation', targetPort: 'in' });
  const setup = learningSetupForDocument(doc);
  assert.equal(setup.branch.sourceNodeId, 'skill'); assert.equal(setup.branch.sourcePort, 'out');
  assert.equal(learningSourceLabel(doc), '真实 Skill · receipt.acceptance');
  doc.nodes.push(createNode('skill', { x: 0, y: 500 }, { id: 'disconnected' }));
  assert.deepEqual(mainChainSkillNodes(doc).map(node => node.id), ['skill']);
});

test('both learning run buttons stay disabled until a complete branch explicitly selects targets', t => {
  fakeDOM(t); const { instance, runtime } = mountedInspection(), topRun = runtime.editor.root.querySelector('[data-action="run"]');
  for (const doc of [document({ branch: false }), document({ targets: [] })]) {
    runtime.editor.doc = doc; instance.syncMode();
    assert.equal(instance.startButton.disabled, true); assert.equal(topRun.disabled, true);
    assert.match(instance.branchStatus.textContent, /产物对比|勾选/); assert.equal(instance.trainableElements.size, 0);
  }
  runtime.editor.doc = document(); instance.syncMode();
  assert.equal(instance.startButton.disabled, false); assert.equal(topRun.disabled, false);
  assert.equal(instance.trainableElements.has('skill'), true);
  assert.equal(instance.trainableElements.get('skill').input, undefined, 'panel selection is a read-only graph summary');
  assert.match(instance.comparisonHint.textContent, /对比产物/);
});

test('restoring historical samples never overwrites current comparison or improvement node settings', t => {
  fakeDOM(t); const { instance, runtime } = mountedInspection();
  runtime.editor.doc.nodes.find(node => node.type === 'evaluation').config.comparison = 'model';
  runtime.editor.doc.nodes.find(node => node.type === 'improvement').config.targetSkillNodeIds = [];
  const before = structuredClone(runtime.editor.doc); instance.restoreForm(job());
  assert.deepEqual(runtime.editor.doc, before);
  assert.equal(instance.trainableElements.size, 0); assert.match(instance.branchStatus.textContent, /明确勾选/);
});

test('learning results prefer the evaluated case value over unrelated final run output', t => {
  fakeDOM(t); const value = job(), instance = headless(value);
  value.document.nodes.find(node => node.type === 'evaluation').config.valuePath = 'acceptance.summary';
  value.rounds[1].document.nodes.find(node => node.type === 'evaluation').config.valuePath = 'acceptance.summary';
  value.rounds[1].cases[0].output = false;
  instance.runtime.runs.set('candidate', { id: 'candidate', status: 'complete', output: { unrelatedFinalPayload: 'not the compared value' } });
  instance.renderSelectedRound();
  assert.equal(instance.actual.textContent, 'false'); assert.match(instance.actualLabel.textContent, /对比产物.*acceptance.summary/);
});
test('history loaded before a newer SSE cannot regress a learning job', async () => {
  const value = job({ status: 'running' }), instance = headless(value); let resolve; instance.api = () => new Promise(done => { resolve = done; });
  const pending = instance.loadRecent(); instance.handleEvent({ type: 'learning.run', payload: { ...value, status: 'complete' } }); resolve({ learnings: [value] }); await pending; assert.equal(instance.currentJob().status, 'complete');
  instance.storeJob({ ...value, status: 'error' }); assert.equal(instance.currentJob().status, 'complete');
});
test('stop ACK is not terminal and terminal SSE wins over stale stop response', async () => {
  const value = job({ status: 'running' }), instance = headless(value); let resolve; instance.api = () => new Promise(done => { resolve = done; });
  const stop = instance.interrupt(); resolve(value); await stop; assert.equal(instance.currentJob().status, 'running'); assert.equal(instance.stopRequested.has(value.id), true);
  instance.stopRequested.clear(); const again = instance.interrupt(); instance.handleEvent({ type: 'learning.run', payload: { ...value, status: 'interrupted' } }); resolve(value); await again; assert.equal(instance.currentJob().status, 'interrupted'); assert.equal(instance.stopRequested.has(value.id), false);
});
test('round and case refresh preserve form focus, typed draft and selected previous round', t => {
  const dom = fakeDOM(t), value = job(), instance = headless(value); dom.activeElement = instance.expected; instance.expected.value = 'draft answer'; instance.expected.selectionStart = 4; instance.selectedRound = 0; instance.runtime.runs.set('baseline', { id: 'baseline', status: 'complete', output: 0 });
  instance.renderRounds(); assert.equal(instance.actual.textContent, '0'); assert.equal(instance.known.textContent, 'false'); assert.equal(instance.sampleInput.textContent, '0');
  instance.jobs.set(value.id, { ...value, rounds: [...value.rounds, { index: 2, status: 'running', cases: [], changes: [] }] }); instance.renderRounds();
  assert.equal(instance.selectedRound, 0); assert.equal(dom.activeElement, instance.expected); assert.equal(instance.expected.value, 'draft answer'); assert.equal(instance.expected.selectionStart, 4); assert.match(instance.roundElements.get(0).detail.textContent, /评估完成 · 0% · 最低 0 分/);
});
test('failed case GET stops until explicit refresh rather than auto-retrying', async t => {
  fakeDOM(t); const instance = headless(); let calls = 0; instance.api = async () => { calls++; throw new Error('offline'); };
  await instance.loadCase('candidate'); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1); assert.equal(instance.caseFailures.has('candidate'), true); instance.renderSelectedRound(); assert.equal(calls, 1);
});
test('an old selected learning case stays pinned in a full runtime cache without repeated GET', async t => {
  fakeDOM(t); const instance = headless(), runtime = Object.create(WorkflowRuntimeUI.prototype); let calls = 0;
  Object.assign(runtime, { runs: new Map(Array.from({ length: 100 }, (_, index) => [`recent-${index}`, { id: `recent-${index}`, workflowId: instance.workflowId, status: 'complete', startedAt: `2026-10-${String(index % 20 + 1).padStart(2, '0')}` }])), revisions: new Map(), revision: 0, stopRequested: new Set(), currentRunId: 'recent-99', learning: instance });
  instance.runtime = runtime; instance.api = async () => { calls++; return { id: 'candidate', workflowId: instance.workflowId, status: 'complete', startedAt: '2000-01-01', output: false }; };
  await instance.loadCase('candidate'); await new Promise(resolve => setImmediate(resolve)); instance.renderSelectedRound();
  assert.equal(runtime.runs.size, 100); assert.equal(runtime.runs.get('candidate').output, false); assert.equal(instance.actual.textContent, 'false'); assert.equal(calls, 1);
});
test('applying a verified candidate changes only chosen references, preserves layout and is one undo', () => {
  const value = job(), instance = Object.create(WorkflowEditor.prototype); Object.assign(instance, { doc: structuredClone(value.document), propertyDrafts: new Map(), history: [], future: [], cancelGesture() {}, cancelConnection() {}, pruneSelection() {}, renderGraph() {}, renderProperties() {}, scheduleSave() {} });
  instance.doc.nodes[1].x = 444; instance.doc.viewport.x = 123; const before = structuredClone(instance.doc); const response = instance.applyLearningDocument(value.bestDocument, { baseDocument: value.document, trainableNodeIds: ['skill'] });
  assert.equal(response.mode, 'execute'); assert.equal(response.nodes[1].config.skillRef, 'wb-learn-candidate'); assert.equal(response.nodes[1].x, 444); assert.equal(response.viewport.x, 123); assert.equal(instance.history.length, 1); assert.deepEqual(instance.history[0].document, before);
  const stale = structuredClone(value.document); stale.nodes[1].config.timeoutSeconds += 1; instance.doc = stale; const snapshot = structuredClone(instance.doc); assert.throws(() => instance.applyLearningDocument(value.bestDocument, { baseDocument: value.document, trainableNodeIds: ['skill'] }), /草稿已变化/); assert.deepEqual(instance.doc, snapshot);
});
test('apply response rechecks draft changes that occurred while awaiting the server', async () => {
  const value = job(), instance = headless(value); let resolve, applied = false; instance.api = () => new Promise(done => { resolve = done; }); instance.editor.cancelGesture = () => {}; instance.editor.cancelConnection = () => {}; instance.editor.applyLearningDocument = WorkflowEditor.prototype.applyLearningDocument; instance.editor.commit = () => { applied = true; };
  const pending = instance.applyBest(); instance.editor.doc.nodes[1].config.skillRef = 'edited-while-waiting'; resolve({ document: value.bestDocument, learningId: value.id, round: 1, score: 100 }); await pending; assert.equal(applied, false); assert.match(instance.noticeValue, /草稿已变化/);
});

function multiJob() {
  const value = job(); value.config.trainingCases = [{ id: 'train-a', name: '空值输入', input: null, expected: false }, { id: 'train-b', name: '零值输入', input: 0, expected: 0 }]; value.config.validationCases = [{ id: 'check-a', name: '独立验证', input: { different: true }, expected: '' }];
  value.rounds[1].cases = [{ id: 'train-a', name: '空值输入', role: 'train', runId: 'candidate', status: 'complete', input: null, expected: false, output: false, score: 100 }]; return value;
}
test('old records restore one training row while new records preserve both independent datasets', () => {
  const old = job(); old.input = false; old.expected = null; old.config.validationCases = [{ input: 'independent', expected: 0 }]; const restored = learningDatasetForJob(old);
  assert.equal(restored.trainingCases.length, 1); assert.equal(restored.trainingCases[0].input, false); assert.equal(restored.trainingCases[0].expected, null); assert.equal(restored.validationCases[0].input, 'independent');
  const value = multiJob(), instance = headless(value); instance.restoreForm(value); assert.deepEqual(instance.dataset.trainingCases, value.config.trainingCases); assert.deepEqual(instance.dataset.validationCases, value.config.validationCases); assert.equal(instance.caseDraftDirty, false); assert.equal(instance.input.value, '');
});
test('missing future cases count as pending and cannot show a premature 100 percent or best candidate', () => {
  const value = multiJob(), round = value.rounds[1], rows = learningRoundRows(value, round), metrics = learningRoundMetrics(value, round);
  assert.equal(rows.length, 3); assert.equal(rows[0].input, null); assert.equal(rows[1].input, 0); assert.equal(rows[1].status, 'pending'); assert.equal(rows[2].role, 'validation');
  assert.equal(metrics.overall.total, 3); assert.equal(metrics.overall.passed, 1); assert.equal(metrics.overall.pending, 2); assert.equal(metrics.overall.passRate, null); assert.equal(metrics.train.passRate, null); assert.equal(metrics.validation.passRate, null); assert.equal(learningBestRound(value), null);
  round.cases.push({ ...rows[1], status: 'complete', score: 100, output: 0 }, { ...rows[2], status: 'complete', score: 0, output: 'mismatch' }); assert.equal(learningRoundMetrics(value, round).overall.passRate, 2 / 3); assert.equal(learningRoundMetrics(value, round).validation.passRate, 0);
  const legacy = job(); assert.equal(learningRoundMetrics(legacy, legacy.rounds[1]).validation.passRate, null);
});
test('single-row editing, moving and deleting keep explicit JSON values and allow temporary empty training', () => {
  const instance = headless(); instance.input.value = 'null'; instance.inputFormat.value = 'json'; instance.expected.value = 'false'; instance.expectedFormat.value = 'json'; instance.caseName.value = '新增验证'; instance.caseSplit.value = 'validation'; instance.caseDraftDirty = true;
  instance.saveCaseDraft(); assert.equal(instance.dataset.validationCases[0].input, null); assert.equal(instance.dataset.validationCases[0].expected, false); assert.equal(instance.caseDraftDirty, false);
  const id = instance.dataset.validationCases[0].id; instance.editCase(id); assert.equal(instance.input.value, 'null'); assert.equal(instance.inputFormat.value, 'json'); instance.input.value = 'false'; instance.expected.value = '0'; instance.saveCaseDraft(); assert.equal(instance.dataset.validationCases[0].input, false); assert.equal(instance.dataset.validationCases[0].expected, 0);
  instance.moveCase(id); assert.equal(instance.dataset.trainingCases.length, 2); assert.equal(instance.dataset.validationCases.length, 0); instance.deleteCase(id); instance.moveCase(instance.dataset.trainingCases[0].id); assert.equal(instance.dataset.trainingCases.length, 0); assert.equal(instance.dataset.validationCases.length, 1);
});
test('pasted import previews without mutation, and changed text or format cannot confirm an old preview', t => {
  fakeDOM(t); const instance = headless(), before = structuredClone(instance.dataset); instance.importText.value = '{"trainingCases":[{"id":"extra","input":2,"expected":false}],"validationCases":[]}'; instance.importFormat.value = 'json';
  instance.previewImport(); assert.equal(instance.pendingImport.dataset.trainingCases[0].input, 2); assert.deepEqual(instance.dataset, before);
  instance.importText.value = 'changed'; instance.applyImport('replace'); assert.equal(instance.pendingImport, null); assert.deepEqual(instance.dataset, before); assert.match(instance.importMessage.textContent, /重新解析/);
  instance.importText.value = '{"trainingCases":[{"input":3,"expected":0}]}'; instance.previewImport(); instance.importFormat.value = 'csv'; instance.applyImport('replace'); assert.equal(instance.pendingImport, null); assert.deepEqual(instance.dataset, before);
});
test('an actual file selection reads CSV with explicit JSON types and only imports on confirmation', async t => {
  fakeDOM(t); const instance = headless(), before = structuredClone(instance.dataset), file = new File(['input,expected,split,input_format,expected_format\n2,false,train,json,json\n'], 'typed.csv', { type: 'text/csv' });
  await instance.readImportFile(file); assert.equal(instance.importFormat.value, 'csv'); assert.equal(instance.pendingImport.dataset.trainingCases[0].input, 2); assert.equal(instance.pendingImport.dataset.trainingCases[0].expected, false); assert.deepEqual(instance.dataset, before);
  instance.applyImport('add'); assert.equal(instance.dataset.trainingCases.length, 2); assert.equal(instance.dataset.trainingCases[1].input, 2); assert.equal(instance.pendingImport, null);
});
test('invalid imports, duplicate IDs and duplicate cross-set inputs never overwrite existing samples', t => {
  fakeDOM(t); const instance = headless(), before = structuredClone(instance.dataset); instance.importFormat.value = 'json'; instance.importText.value = '{invalid'; instance.previewImport(); assert.equal(instance.pendingImport, null); assert.deepEqual(instance.dataset, before);
  instance.importText.value = JSON.stringify({ trainingCases: [{ id: before.trainingCases[0].id, input: 'different', expected: false }] }); instance.previewImport(); instance.applyImport('add'); assert.deepEqual(instance.dataset, before); assert.match(instance.importMessage.textContent, /id/);
  assert.throws(() => mergeLearningDatasets(before, { trainingCases: [], validationCases: [{ id: 'different', input: 0, expected: false }] }), /重复/); assert.deepEqual(instance.dataset, before);
});
test('stale file reads cannot overwrite newer pasted contents or a different workflow', async t => {
  fakeDOM(t); const instance = headless(); let resolve; const file = { name: 'data.json', size: 10, text: () => new Promise(done => { resolve = done; }) };
  const pending = instance.readImportFile(file); instance.importText.value = 'new paste'; instance.importRevision++; resolve('{"trainingCases":[{"input":1,"expected":2}]}'); await pending; assert.equal(instance.importText.value, 'new paste'); assert.equal(instance.pendingImport, null);
  const second = instance.readImportFile(file); instance.workflowId = 'another-workflow'; resolve('{}'); await second; assert.equal(instance.importText.value, 'new paste');
});
test('editing a sample but not saving prevents submission and existing dataset input is not guessed', async () => {
  const value = multiJob(), instance = headless(value); instance.jobs.clear(); instance.caseDraftDirty = true; let count = 0; instance.api = async () => { count++; return value; }; await instance.start(); assert.equal(count, 0); assert.match(instance.noticeValue, /尚未保存/);
  instance.caseDraftDirty = false; instance.dataset = { trainingCases: [{ id: 'text-zero', name: '文本零', input: '0', expected: false }], validationCases: [] }; instance.api = async (_path, options) => { count++; assert.equal(options.body.trainingCases[0].input, '0'); assert.deepEqual(options.body.validationCases, []); assert.equal(Object.hasOwn(options.body, 'input'), false); return value; }; await instance.start(); assert.equal(count, 1);
});
test('metric cards, pending rows and selected case controls stay stable under streamed updates', t => {
  const dom = fakeDOM(t), value = multiJob(), instance = headless(value); instance.caseTableBody = new FakeElement(); for (const key of ['overall', 'train', 'validation']) instance.metricCards.set(key, { card: new FakeElement(), value: new FakeElement(), detail: new FakeElement() }); instance.runtime.runs.set('candidate', { id: 'candidate', status: 'complete', output: false }); dom.activeElement = instance.expected; instance.expected.value = 'next answer'; instance.expected.selectionStart = 3;
  instance.renderSelectedRound(); const button = instance.caseRows.get(1).row.children.at(-1).children[0]; assert.equal(instance.metricCards.get('overall').value.textContent, '待评估'); assert.equal(instance.caseRows.get(1).result.textContent, '尚未评估'); assert.equal(instance.caseRows.get(2).name.textContent, '独立验证\n验证集');
  const updated = structuredClone(value); updated.rounds[1].cases.push({ ...value.config.trainingCases[1], role: 'train', status: 'complete', output: 0, score: 100 }); instance.jobs.set(value.id, updated); instance.renderSelectedRound(); assert.equal(instance.caseRows.get(1).row.children.at(-1).children[0], button); assert.equal(instance.metricCards.get('overall').value.textContent, '待评估'); assert.equal(instance.metricCards.get('train').value.textContent, '100%'); assert.equal(dom.activeElement, instance.expected); assert.equal(instance.expected.value, 'next answer'); assert.equal(instance.expected.selectionStart, 3);
});
test('unscored failures show zero consistently while complete results awaiting a valid grade stay pending', t => {
  fakeDOM(t);
  for (const status of ['error', 'failed']) { const value = multiJob(), instance = headless(value); instance.caseTableBody = new FakeElement(); value.rounds[1].cases = [{ ...value.config.trainingCases[0], role: 'train', status, score: null, error: 'format failure' }, { ...value.config.trainingCases[1], role: 'train', status: 'complete', output: 0, score: null }];
    instance.selectedCase = 0; instance.renderSelectedRound(); assert.equal(instance.caseRows.get(0).status.textContent, '执行失败'); assert.equal(instance.caseRows.get(0).points.textContent, '0 分'); assert.equal(instance.caseRows.get(0).result.textContent, '未通过'); assert.match(instance.caseScore.textContent, /^0 分 · 未通过/);
    instance.selectedCase = 1; instance.renderSelectedRound(); assert.equal(instance.caseRows.get(1).points.textContent, '尚未评分'); assert.equal(instance.caseRows.get(1).result.textContent, '尚未评估'); assert.match(instance.caseScore.textContent, /^尚未评分 · 尚未评估/);
  }
});

test('memory isolation is confirmed only by batch-snapshot with both explicit write and external denials', () => {
  const policy = { mode: 'batch-snapshot', memoryWriteAllowed: false, externalMemoryAllowed: false }; assert.equal(learningMemoryStatus({ memoryPolicy: policy }).kind, 'fixed');
  for (const field of ['memoryWriteAllowed', 'externalMemoryAllowed']) for (const value of [true, null, undefined, 'false']) { const changed = { ...policy, [field]: value }; assert.equal(learningMemoryStatus({ memoryPolicy: changed }).kind, 'unconfirmed'); }
  for (const memoryPolicy of [null, {}, { mode: 'future-isolation', memoryWriteAllowed: false, externalMemoryAllowed: false }]) assert.equal(learningMemoryStatus({ memoryPolicy }).kind, 'unconfirmed');
  assert.equal(learningMemoryStatus({ memoryScopeId: 'opaque-without-confirmation' }).kind, 'unconfirmed');
});

test('legacy batches are identified separately from a pending or failed memory freeze', () => {
  assert.equal(learningMemoryStatus(job()).kind, 'legacy'); assert.match(learningMemoryStatus({ memoryPolicy: { mode: 'legacy', memoryWriteAllowed: null, externalMemoryAllowed: null } }).label, /旧批次未启用完整记忆隔离/);
  const pending = { status: 'running', phase: 'preparing-memory', memoryPolicy: { mode: 'pending', memoryWriteAllowed: null, externalMemoryAllowed: null } }; assert.equal(learningMemoryStatus(pending).kind, 'pending'); assert.match(learningMemoryStatus(pending).label, /冻结学习记忆中/);
  for (const status of ['error', 'interrupted', 'unknown']) assert.equal(learningMemoryStatus({ ...pending, status }).kind, 'unconfirmed');
});

test('streamed memory confirmation updates a stable record without exposing opaque scope or moving input focus', t => {
  const dom = fakeDOM(t), scope = '8e4ef36b-dce8-486a-b09b-bf6866aa9fa8', value = job({ status: 'running', phase: 'preparing-memory', memoryScopeId: scope, memoryPolicy: { mode: 'pending', memoryWriteAllowed: null, externalMemoryAllowed: null } }), instance = headless(value), record = instance.memoryRecord;
  instance.expected.value = '正在编辑的下一轮答案'; instance.expected.selectionStart = 4; dom.activeElement = instance.expected; instance.renderMemoryPolicy(); assert.equal(record.hidden, false); assert.equal(record.dataset.state, 'pending');
  instance.storeJob({ ...value, phase: 'executing', memoryPolicy: { mode: 'batch-snapshot', memoryWriteAllowed: false, externalMemoryAllowed: false, content: 'MUST_NOT_RENDER_MEMORY' } }); instance.renderMemoryPolicy();
  assert.equal(instance.memoryRecord, record); assert.equal(record.dataset.state, 'fixed'); assert.equal(instance.memoryLabel.textContent, '同批次固定只读记忆'); assert.equal(dom.activeElement, instance.expected); assert.equal(instance.expected.selectionStart, 4); assert.equal(instance.expected.value, '正在编辑的下一轮答案'); assert.equal((instance.memoryLabel.textContent + instance.memoryDetails.textContent).includes(scope), false); assert.equal(instance.memoryDetails.textContent.includes('MUST_NOT_RENDER_MEMORY'), false);
  instance.storeJob({ ...value, memoryPolicy: { mode: 'legacy', memoryWriteAllowed: null, externalMemoryAllowed: null } }); instance.renderMemoryPolicy(); assert.equal(record.dataset.state, 'legacy'); assert.match(instance.memoryLabel.textContent, /旧批次/);
  instance.jobId = null; instance.renderMemoryPolicy(); assert.equal(record.hidden, true);
});

test('first round removes the memory-preparation placeholder and subsequent updates retain round controls', t => {
  const dom = fakeDOM(t), value = job(), instance = headless({ ...value, status: 'running', phase: 'preparing-memory', rounds: [] }); instance.runtime.runs.set('baseline', { id: 'baseline', status: 'complete', output: 0 }); instance.runtime.runs.set('candidate', { id: 'candidate', status: 'complete', output: false });
  dom.activeElement = instance.expected; instance.expected.value = 'still editing'; instance.expected.selectionStart = 3; instance.renderRounds(); const placeholder = instance.rounds.children[0]; assert.equal(placeholder.textContent, '正在冻结记忆或准备基线，尚无轮次结果。'); instance.renderRounds(); assert.equal(instance.rounds.children[0], placeholder); assert.equal(instance.rounds.children.length, 1);
  instance.jobs.set(value.id, { ...value, status: 'running', rounds: [value.rounds[0]] }); instance.renderRounds(); const first = instance.roundElements.get(0).select; assert.equal(instance.rounds.children.includes(placeholder), false); assert.equal(instance.rounds.children.length, 1);
  instance.selectedRound = 0; instance.roundPinned = true; instance.jobs.set(value.id, value); instance.renderRounds(); assert.equal(instance.rounds.children.length, 2); assert.equal(instance.roundElements.get(0).select, first); assert.equal(instance.selectedRound, 0); assert.equal(dom.activeElement, instance.expected); assert.equal(instance.expected.value, 'still editing'); assert.equal(instance.expected.selectionStart, 3);
});

function feedbackLearning(overrides = {}) {
  const value = job(), candidate = structuredClone(value.bestDocument); candidate.mode = 'learn';
  return { ...value, kind: 'feedback', sourceRunId: 'actual-run', feedbackRevision: 4, input: null, expected: null, config: { trainableNodeIds: ['skill'] }, bestRound: null, bestScore: null, bestDocument: null, candidateDocument: candidate, validationStatus: 'not-run', reason: 'feedback-candidate-ready',
    feedbackSnapshot: { schemaVersion: 2, comment: '测试固件缺少 USB 错误原因，请补足诊断步骤。其它内容保持。', targets: [{ nodeId: 'skill', title: '测试固件' }, { nodeId: 'not-selected', title: '导出与命名' }] },
    rounds: [{ index: 0, status: 'complete', score: null, cases: [], changes: [{ nodeId: 'skill', before: { ref: 'original', revision, content: '原始正文' }, after: { ref: 'wb-learn-candidate', revision: nextRevision, content: '增加明确错误原因' }, summary: '补足诊断步骤' }] }], ...overrides };
}

test('feedback learning never fabricates legacy null examples or a verified best round', () => {
  const value = feedbackLearning();
  assert.deepEqual(learningDatasetForJob(value), { trainingCases: [], validationCases: [] }); assert.deepEqual(learningRoundRows(value, value.rounds[0]), []); assert.equal(learningBestRound(value), null);
  const instance = headless(value); instance.dataset = { trainingCases: [{ id: 'preserved', name: '独立样例', input: 1, expected: 2 }], validationCases: [] }; const before = structuredClone(instance.dataset), answer = instance.expected.value;
  instance.restoreForm(value); assert.deepEqual(instance.dataset, before); assert.equal(instance.expected.value, answer); assert.match(instance.noticeValue, /现有样例草稿已保留/);
});

test('feedback results show one overall comment and pending validation without ratings or sample pass rates', t => {
  fakeDOM(t); const { instance } = mountedInspection(), value = feedbackLearning(); value.workflowId = instance.workflowId; value.document.id = instance.workflowId; value.candidateDocument.id = instance.workflowId;
  instance.jobs.set(value.id, value); instance.jobId = value.id; instance.editor.doc = structuredClone(value.document); instance.render();
  assert.equal(instance.status.textContent, '候选已生成 · 未验证'); assert.equal(instance.status.dataset.status, 'pending'); assert.equal(instance.resultsLayout.hidden, true); assert.equal(instance.feedbackResults.hidden, false); assert.equal(instance.restoreButton.hidden, true);
  assert.equal(instance.best.textContent, '未验证 · 待用户复评'); assert.equal(instance.apply.textContent, '应用候选到草稿（未验证）'); assert.equal(instance.apply.disabled, false);
  assert.equal(instance.feedbackComment.children.length, 1); assert.equal(instance.feedbackComment.children[0].children[0].textContent, '综合反馈'); assert.equal(instance.feedbackComment.children[0].children[1].textContent, value.feedbackSnapshot.comment); assert.equal(instance.feedbackComment.children[0].children.length, 3); assert.match(instance.feedbackComment.children[0].children[2].textContent, /检查范围：测试固件/); assert.doesNotMatch(instance.feedbackComment.children[0].children[2].textContent, /导出与命名/);
  assert.match(instance.feedbackCandidateNotice.textContent, /未验证/); assert.equal(instance.feedbackChanges.children.length, 1); assert.match(instance.feedbackChanges.children[0].children[0].textContent, /测试固件/);
  instance.jobs.set(value.id, { ...value, kind: undefined }); instance.render(); assert.equal(instance.feedbackResults.hidden, true); assert.equal(instance.resultsLayout.hidden, false);
});

test('old feedback learning displays historical comments as one overall text without rating controls', t => {
  fakeDOM(t); const { instance } = mountedInspection(), value = feedbackLearning({ feedbackSnapshot: { items: [
    { nodeId: 'skill', title: '测试固件', score: 0, comment: '增加 USB 错误原因', selectedForLearning: true },
    { nodeId: 'not-selected', title: '导出与命名', score: 99, comment: '日期统一', selectedForLearning: false },
  ] } });
  instance.renderFeedbackResult(value);
  assert.equal(instance.feedbackComment.children.length, 1);
  assert.equal(instance.feedbackComment.children[0].children[1].textContent, '测试固件：增加 USB 错误原因\n\n导出与命名：日期统一');
  assert.equal(instance.feedbackComment.children[0].children.length, 3);
  assert.match(instance.feedbackChanges.children[0].children[0].textContent, /测试固件/);
});

test('feedback that made no changes and active preparation use no baseline or success claims', t => {
  fakeDOM(t); const { instance } = mountedInspection(), value = feedbackLearning({ reason: 'feedback-no-change', candidateDocument: null }); value.workflowId = instance.workflowId; value.document.id = instance.workflowId; instance.editor.doc = structuredClone(value.document); instance.jobs.set(value.id, value); instance.jobId = value.id; instance.render();
  assert.equal(instance.status.textContent, '未形成新候选'); assert.equal(instance.apply.disabled, true); assert.match(instance.feedbackCandidateNotice.textContent, /没有形成新候选/); assert.equal(instance.summary.textContent, '未形成新候选');
  instance.jobs.set(value.id, { ...value, status: 'running', phase: 'preparing-memory' }); instance.render(); assert.equal(instance.summary.textContent, '准备只读记忆');
  instance.jobs.set(value.id, { ...value, status: 'running', phase: 'optimizing' }); instance.render(); assert.equal(instance.summary.textContent, '生成定向候选'); assert.equal(instance.startButton.textContent, '生成定向候选…');
});

test('feedback learning entry preserves edited workflow and sample drafts while switching presentation mode', t => {
  fakeDOM(t); const { instance, runtime } = mountedInspection(), value = feedbackLearning(); value.workflowId = instance.workflowId; value.document.id = instance.workflowId;
  runtime.editor.doc.mode = 'execute'; runtime.editor.doc.nodes[1].title = '我的未保存修改'; runtime.editor.commit = document => { runtime.editor.doc = document; };
  instance.dataset = { trainingCases: [{ id: 'sample', name: '保留', input: 'a', expected: 'b' }], validationCases: [] }; instance.expected.value = '尚未保存的答案'; const before = structuredClone(runtime.editor.doc), dataBefore = structuredClone(instance.dataset);
  instance.acceptFeedbackLearning(value);
  assert.deepEqual(runtime.editor.doc, { ...before, mode: 'learn' }); assert.deepEqual(instance.dataset, dataBefore); assert.equal(instance.expected.value, '尚未保存的答案'); assert.equal(instance.jobId, value.id); assert.equal(instance.setup.open, false); assert.equal(instance.apply.disabled, true); assert.match(instance.notice.textContent, /当前草稿已保留/);
});

test('feedback apply explicitly uses its endpoint and only selected Skill refs with no quality score', async () => {
  const value = feedbackLearning(), instance = headless(value); let request, applied, notice;
  instance.api = async (path, options) => { request = { path, options }; return { document: { ...value.candidateDocument, mode: 'execute' }, learningId: value.id, score: null, validationStatus: 'not-run' }; };
  instance.editor.applyLearningDocument = (document, options) => { applied = { document, options }; }; instance.editor.toast = () => {};
  Object.assign(instance.runtime, { loadSkills: async () => {}, refreshBackend() {}, showNotice: message => { notice = message; }, setExpanded() {} });
  await instance.applyBest(); assert.equal(request.path, '/api/workflow-learning/learning-1/apply-feedback'); assert.deepEqual(request.options.body, {}); assert.deepEqual(applied.options.trainableNodeIds, ['skill']); assert.deepEqual(applied.options.baseDocument, value.document); assert.match(notice, /尚未验证/);
});

test('feedback apply rechecks drafts changed while awaiting response and refuses a falsely scored candidate', async () => {
  for (const change of ['draft', 'claimed-score']) {
    const value = feedbackLearning(), instance = headless(value); let finish, applied = false;
    instance.api = () => new Promise(resolve => { finish = resolve; }); instance.editor.cancelGesture = () => {}; instance.editor.cancelConnection = () => {}; instance.editor.applyLearningDocument = WorkflowEditor.prototype.applyLearningDocument; instance.editor.commit = () => { applied = true; };
    const pending = instance.applyFeedback(); if (change === 'draft') instance.editor.doc.nodes[1].config.skillRef = 'edited-during-request';
    finish({ document: { ...value.candidateDocument, mode: 'execute' }, learningId: value.id, score: change === 'claimed-score' ? 100 : null, validationStatus: 'not-run' }); await pending;
    assert.equal(applied, false); assert.match(instance.noticeValue, change === 'draft' ? /草稿已变化/ : /未验证反馈候选/);
  }
});
