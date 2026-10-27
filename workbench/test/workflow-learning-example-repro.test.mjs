import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { WorkflowLearningUI, learningSetupForDocument } from '../public/workflow-learning-ui.js';
import { createDocument, createNode, connectNodes } from '../shared/workflow/workflow-model.mjs';

const json = async name => JSON.parse(await readFile(new URL('../examples/' + name, import.meta.url), 'utf8'));
function fiveNodeDocument() {
  let document = createDocument({ schemaVersion: 2, title: '五节点学习契约 fixture' }); document.mode = 'learn';
  document.nodes = [
    createNode('input', {}, { id: 'input', config: { outputType: 'text', required: true } }),
    createNode('skill', {}, { id: 'skill', config: { inputType: 'text', outputType: 'text', skillRef: 'fixture-real-skill', version: 'sha256:' + 'a'.repeat(64) } }),
    createNode('output', {}, { id: 'output' }),
    createNode('evaluation', {}, { id: 'evaluation', config: { comparison: 'exact', valuePath: '' } }),
    createNode('improvement', {}, { id: 'improvement', config: { scope: 'skills', targetSkillNodeIds: ['skill'] } }),
  ];
  for (const [sourceNode, sourcePort, targetNode] of [['input', 'out', 'skill'], ['skill', 'out', 'output'], ['output', 'learning', 'evaluation'], ['evaluation', 'out', 'improvement']]) {
    document = connectNodes(document, { sourceNode, sourcePort, targetNode, targetPort: 'in' });
  }
  return document;
}
function configPanel(document = fiveNodeDocument()) {
  const ui = Object.assign(Object.create(WorkflowLearningUI.prototype), {
    editor: { doc: document, documentLoaded: true }, workflowId: document.id, drafts: new Map(), starting: false, applying: false,
    uncertain: false, activeJob: () => null, importRevision: 0, pendingImport: { old: true }, formDirty: false,
    dataset: { trainingCases: [], validationCases: [] }, datasetGroups: new Map(), setup: { open: false },
    importPreview: {}, addImportButton: {}, replaceImportButton: {}, updateRunButton() {},
    setExpanded(value) { this.expanded = value; }, render() {}, showNotice(message) { this.notice = message; },
  });
  const names = { input: 'wf-learning-input', expected: 'wf-learning-expected', caseName: 'wf-learning-case-name',
    caseSplit: 'wf-learning-case-split', inputFormat: 'wf-learning-input-format', expectedFormat: 'wf-learning-expected-format',
    targetScore: 'wf-learning-score', maxRounds: 'wf-learning-rounds', rubric: 'wf-learning-rubric' };
  ui.formControls = Object.entries(names).map(([key, id]) => ui[key] = { id, value: '' });
  return ui;
}

test('shipped learning workflows expose a usable explicit learning branch instead of failing before any model call', async () => {
  for (const name of ['learning-text.workflow.json', 'multi-example-learning.workflow.json']) {
    const document = await json(name);
    assert.doesNotThrow(() => learningSetupForDocument(document), name);
    assert.equal(document.schemaVersion, 2, name);
    assert.equal(document.nodes.length, 5, name);
  }
});

test('shipped learning configs fill and expand the panel through the full-config adapter without changing workflow identity', async () => {
  for (const name of ['learning-text', 'multi-example-learning']) {
    const document = await json(name + '.workflow.json'), config = await json(name + '.config.json'), before = structuredClone(document), ui = configPanel(document);
    ui.setConfig(config, { expand: true });
    assert(ui.dataset.trainingCases.length > 0); assert(ui.dataset.validationCases.length > 0);
    assert.equal(ui.rubric.value, config.rubric); assert.equal(ui.targetScore.value, String(config.targetScore)); assert.equal(ui.maxRounds.value, String(config.maxRounds));
    assert.equal(ui.expanded, true); assert.equal(ui.setup.open, true); assert.equal(ui.formDirty, true);
    assert.equal(ui.pendingImport, null); assert.equal(ui.importRevision, 1);
    assert.deepEqual(ui.drafts.get(document.id).dataset, ui.dataset); assert.deepEqual(document, before); assert.equal(ui.workflowId, document.id);
  }
});

test('config adaptation supports legacy one-case values and rejects mismatched or malformed settings atomically', () => {
  const ui = configPanel(), config = { input: 'HELLO', expected: 'hello', comparison: 'exact', trainableNodeIds: ['skill'],
    validationCases: [{ input: 'WORLD', expected: 'world' }], rubric: '仅返回小写', targetScore: 100, maxRounds: 2 };
  const original = structuredClone(config); ui.setConfig(config);
  assert.equal(ui.dataset.trainingCases[0].input, 'HELLO'); assert.equal(ui.dataset.trainingCases[0].expected, 'hello');
  assert.deepEqual(config, original); assert.equal(ui.caseDraftDirty, false);
  const snapshot = ui.saveForm();
  for (const invalid of [ { ...config, comparison: 'model' }, { ...config, trainableNodeIds: ['other'] }, { ...config, targetScore: 0 },
    { ...config, maxRounds: 11 }, { ...config, rubric: 'x'.repeat(8001) }, { ...config, document: ui.editor.doc },
    { ...config, trainingCases: [{ input: 'a', expected: 'b' }] } ]) {
    assert.throws(() => ui.setConfig(invalid)); assert.deepEqual(ui.saveForm(), snapshot);
  }
  ui.starting = true; assert.throws(() => ui.setConfig(config), /正在|学习|配置/);
});

test('the dataset JSON importer continues rejecting a full learning API config', async () => {
  const ui = Object.assign(Object.create(WorkflowLearningUI.prototype), { starting: false, importRevision: 0, pendingImport: null,
    importText: { value: JSON.stringify(await json('learning-text.config.json')) }, importFormat: { value: 'json' },
    importMessage: { textContent: '', classList: { toggle() {} } }, renderImportPreview() {} });
  ui.previewImport(); assert.equal(ui.pendingImport, null); assert.match(ui.importMessage.textContent, /未知字段/);
});

test('loading a config invalidates a late dataset file and prevents older job history from restoring over it', async () => {
  const ui = configPanel(), config = { input: 'CURRENT', expected: 'current', validationCases: [{ input: 'CHECK', expected: 'check' }],
    rubric: '当前规则', targetScore: 100, maxRounds: 2 };
  ui.importText = { value: '保留导入文本' }; ui.importFormat = { value: 'json' };
  let finishFile; const reading = ui.readImportFile({ size: 100, name: 'older.json', text: () => new Promise(resolve => { finishFile = resolve; }) });
  Object.assign(ui, { loaded: false, loading: false, listRequest: 0, revision: 0, revisions: new Map(), jobs: new Map(), stopRequested: new Set(), refresh: {} });
  let finishHistory; ui.api = () => new Promise(resolve => { finishHistory = resolve; });
  const history = ui.loadRecent();
  ui.setConfig(config); const configured = structuredClone(ui.dataset);
  finishFile(JSON.stringify({ trainingCases: [{ input: 'OLD_FILE', expected: 'old_file' }] })); await reading;
  finishHistory({ learnings: [{ id: 'old-job', workflowId: ui.workflowId, status: 'complete', startedAt: '2026-01-01T00:00:00Z', rounds: [],
    config: { trainingCases: [{ input: 'OLD_JOB', expected: 'old_job' }], validationCases: [] } }] }); await history;
  assert.deepEqual(ui.dataset, configured); assert.equal(ui.rubric.value, '当前规则'); assert.equal(ui.formDirty, true);
  assert.equal(ui.importText.value, '保留导入文本'); assert.equal(ui.pendingImport, null); assert.equal(ui.loaded, true);
});

test('five schema2 nodes provide complete graph-owned comparison and improvement targets', () => {
  const document = fiveNodeDocument();
  const setup = learningSetupForDocument(document);
  assert.deepEqual(setup.ids, ['skill']); assert.equal(setup.comparison, 'exact');
  assert.equal(setup.branch.sourceNodeId, 'output'); assert.equal(setup.branch.sourcePort, 'learning');
  assert.deepEqual(setup.plan.nodeOrder, ['input', 'skill', 'output']);
});

test('a prefilled panel submits complete learning config with graph-derived target IDs and no extra input editing', async () => {
  const document = fiveNodeDocument(), posted = [];
  const dataset = { trainingCases: [{ id: 'train-one', name: '训练短语', input: 'HELLO WORLD', expected: 'hello world' }],
    validationCases: [{ id: 'validation-one', name: '独立验证', input: 'GOOD MORNING', expected: 'good morning' }] };
  const ui = Object.assign(Object.create(WorkflowLearningUI.prototype), {
    editor: { doc: document, prepareRun: () => structuredClone(document) }, runtime: { getBackend: () => ({ state: 'ready' }), activeRun: () => null },
    dataset, caseDraftDirty: false, starting: false, loading: false, applying: false, uncertain: false,
    targetScore: { value: '100' }, maxRounds: { value: '2' }, rubric: { value: '提取英文短语并仅返回小写，不翻译、不解释，不硬编码样例。' },
    revision: 0, revisions: new Map(), jobs: new Map(), stopRequested: new Set(), activeJob: () => null,
    setExpanded() { this.expanded = true; }, syncMode() {}, updateRunButton() {}, render() {}, showNotice(text) { this.notice = text; },
    async api(path, options) { posted.push({ path, body: options.body }); return { id: 'fixture-learning', workflowId: document.id, status: 'running', rounds: [] }; },
  });
  await ui.start(); assert.equal(posted.length, 1, ui.notice); assert.equal(posted[0].path, '/api/workflow-learning');
  const config = posted[0].body;
  assert.equal(config.document.mode, 'learn'); assert.equal(config.comparison, 'exact');
  assert.deepEqual(config.trainableNodeIds, ['skill']); assert.equal(config.targetScore, 100); assert.equal(config.maxRounds, 2);
  assert.deepEqual(config.trainingCases, dataset.trainingCases); assert.deepEqual(config.validationCases, dataset.validationCases);
  assert.equal(config.rubric, ui.rubric.value); assert.equal(ui.expanded, true);
  assert.equal(Object.hasOwn(config, 'input'), false); assert.equal(Object.hasOwn(config, 'expected'), false);
});
