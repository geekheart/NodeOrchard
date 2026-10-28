import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, createNode, connectNodes } from '../shared/workflow/workflow-model.mjs';
import { structuredInput, valuesFromInput, layoutPositions, needsAutoLayout, runArtifacts, portCompatible, shortVersion, inputEntries, vacantNodePosition, reviewTargetArtifacts, groupArtifacts, orderedNodeStates, manifestSourceCount, nodeThumbnailArtifact, canRerunNode, nodeInspectionVersions, reviewTargetNodes, INPUT_FIELD_PRESETS, mergeInputFields } from '../shared/workflow/workflow-studio-utils.mjs';
import { WorkflowStudioUI, inlineInputFields, nodePreviewArtifacts, nodeShowsCanvasPreview } from '../public/workflow-studio-ui.js';
import { WorkflowRuntimeUI, workflowSnapshotChanged, mergeSkillSelectionDraft } from '../public/workflow-runtime-ui.js';
import { WorkflowEditor } from '../public/workflow-editor.js';
import { WORKFLOW_TOOLS } from '../shared/workflow/workflow-tools.mjs';
import { learningSnapshotChanged } from '../public/workflow-learning-ui.js';
import { planWorkflow } from '../shared/workflow/workflow-plan.mjs';

function documentWithInputs(count = 1) { const doc = createDocument({ schemaVersion: 2 }); doc.nodes = Array.from({ length: count }, (_, index) => createNode('input', { x: 0, y: 0 }, { id: `input-${index}`, config: { outputType: 'object', fieldName: `source${index}`, fields: [{ key: 'path', label: '工程', kind: 'file', required: true }, { key: 'count', label: '数量', kind: 'number', required: true }] } })); return doc; }

test('structured input preserves separate sources and falsey numeric values without path inference', () => {
  const doc = documentWithInputs(2), values = { 'input-0': { path: '/a.epro2', count: 0 }, 'input-1': { path: '/b.epro2', count: 2 } };
  const value = structuredInput(doc, values); assert.deepEqual(value, { source0: values['input-0'], source1: values['input-1'] }); assert.deepEqual(valuesFromInput(doc, value), values); assert.equal(inputEntries(doc).length, 4);
});

test('single input restores both direct and server-normalized wrapped values', () => {
  const doc = documentWithInputs(), source = { path: '/input.epro2', count: 0 };
  assert.deepEqual(structuredInput(doc, { 'input-0': source }), source);
  assert.deepEqual(valuesFromInput(doc, source), { 'input-0': source });
  assert.deepEqual(valuesFromInput(doc, { source0: source }), { 'input-0': source });
});

test('guide and full-HDK field presets define the exact preparation contracts and preserve matching custom definitions', () => {
  const guide = INPUT_FIELD_PRESETS.find(preset => preset.label === '使用指南资料字段'), hdk = INPUT_FIELD_PRESETS.find(preset => preset.label === '完整HDK资料字段');
  assert.deepEqual(guide.fields.map(field => [field.key, field.kind]), [['sourcePath', 'file'], ['frontImage', 'image'], ['backImage', 'image'], ['guideProfilePath', 'file'], ['fourFilesDirectory', 'folder'], ['productCode', 'text'], ['hardwareVersion', 'text'], ['releaseDate', 'text']]); assert.deepEqual(guide.fields.find(field => field.key === 'frontImage').extensions, ['.png']); assert.deepEqual(hdk.fields.map(field => field.key), ['sourcePath', 'profilePath', 'productCode', 'hardwareVersion', 'releaseDate']);
  const existing = [{ key: 'sourcePath', label: '我的工程路径', kind: 'file', required: false, extensions: ['.custom'], role: 'custom' }, { key: 'notes', label: '个人备注', kind: 'text', required: false }], before = structuredClone(existing), presetsBefore = structuredClone(INPUT_FIELD_PRESETS), merged = mergeInputFields(existing, guide.fields);
  assert.deepEqual(merged.slice(0, 2), existing); assert.deepEqual(mergeInputFields(merged, guide.fields), merged, 'reapplying a preset never duplicates or changes fields'); merged[0].extensions.push('.another'); assert.deepEqual(existing, before); assert.deepEqual(INPUT_FIELD_PRESETS, presetsBefore);
});

test('prepared input drafts survive reload without claiming that the files have passed admission', t => {
  const previous = globalThis.localStorage, saved = new Map(); globalThis.localStorage = { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value) }; t.after(() => { if (previous) globalThis.localStorage = previous; else delete globalThis.localStorage; });
  const document = documentWithInputs(), original = Object.create(WorkflowStudioUI.prototype); original.editor = { doc: document }; original.runtime = { input: {} }; original.values = { 'input-0': { path: '/workspace/project.epro2', count: 0 } }; original.syncRawInput();
  const reloaded = Object.create(WorkflowStudioUI.prototype); Object.assign(reloaded, { editor: { doc: document, root: { dataset: {} }, renderLibrary() {} }, upgrade: {}, check: {}, renderInputs() {}, renderGraph() {}, setTab() {}, setView() {} }); reloaded.syncDocument(); assert.deepEqual(reloaded.values, original.values); assert.equal(reloaded.preflightResult, null); assert.deepEqual(JSON.parse(original.runtime.input.value), { path: '/workspace/project.epro2', count: 0 });
});

test('saving a new workflow version copies prepared input values under remapped IDs without copying preflight evidence', t => {
  const previous = globalThis.localStorage, saved = new Map(); globalThis.localStorage = { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value) };
  t.after(() => { if (previous) globalThis.localStorage = previous; else delete globalThis.localStorage; });
  const source = documentWithInputs(), target = documentWithInputs(); target.nodes[0].id = 'new-input';
  const studio = Object.create(WorkflowStudioUI.prototype); studio.editor = { doc: source };
  studio.values = { 'input-0': { path: '/project.epro2', count: 0, enabled: false } }; studio.preflightResult = { ok: true, manifest: { privateRun: 'original' } };
  assert.deepEqual(studio.copyInputDrafts(target, { 'input-0': 'new-input' }), { copiedInputs: 1 });
  assert.deepEqual(JSON.parse(saved.get('workbench.workflow-inputs.v2:' + target.id)), { 'new-input': studio.values['input-0'] });
  assert.equal(saved.size, 1); assert.ok(![...saved.values()].some(value => value.includes('privateRun')));
  assert.throws(() => studio.copyInputDrafts(source, {}), /独立的工作流/);
});

test('dependency layout keeps independent tasks parallel and puts learning below business nodes', () => {
  const doc = { nodes: [{ id: 'input' }, { id: 'cad' }, { id: 'pinout' }, { id: 'join' }, { id: 'review', type: 'evaluation' }, { id: 'improve', type: 'improvement' }], edges: [{ sourceNode: 'input', targetNode: 'cad' }, { sourceNode: 'input', targetNode: 'pinout' }, { sourceNode: 'cad', targetNode: 'join' }, { sourceNode: 'pinout', targetNode: 'join' }, { sourceNode: 'join', targetNode: 'review' }, { sourceNode: 'review', targetNode: 'improve' }] };
  const layout = layoutPositions(doc); assert.equal(layout.get('cad').x, layout.get('pinout').x); assert.notEqual(layout.get('cad').y, layout.get('pinout').y); assert.ok(layout.get('join').x > layout.get('cad').x); assert.ok(layout.get('review').y > layout.get('pinout').y);
});

test('automatic layout detects changed connections but ignores manual positions and edge identities', () => {
  let before = createDocument({ schemaVersion: 2 }); before.nodes = [createNode('input', {}, { id: 'input', config: { outputType: 'object' } }), createNode('tool', {}, { id: 'tool' }), createNode('output', {}, { id: 'output' })];
  before = connectNodes(before, { sourceNode: 'input', sourcePort: 'out', targetNode: 'tool', targetPort: 'in' });
  const added = connectNodes(before, { sourceNode: 'tool', sourcePort: 'out', targetNode: 'output', targetPort: 'in' });
  assert.equal(needsAutoLayout(before, added), true); assert.equal(needsAutoLayout(added, before), true);
  assert.equal(needsAutoLayout(before, { ...before, edges: [{ ...before.edges[0], targetNode: 'output' }] }), true);
  assert.equal(needsAutoLayout(before, { ...before, edges: [{ ...before.edges[0], targetPort: 'named-input' }] }), true);
  assert.equal(needsAutoLayout(added, { ...added, edges: added.edges.map(edge => ({ ...edge, id: 'new-' + edge.id })).reverse() }), false);
  const moved = structuredClone(before); moved.nodes[0].x = 1700; moved.nodes[1].y = 1300; moved.title = '仅改配置与位置';
  assert.equal(needsAutoLayout(before, moved), false);
  assert.equal(needsAutoLayout(before, { ...added, id: 'opened-workflow' }), false);
  assert.equal(needsAutoLayout(before, { ...before, nodes: [...before.nodes, createNode('input', {}, { id: 'new-node' })] }), true);
});

test('automatic layout separates unconnected learning nodes so mouse hits cannot reach the wrong overlaid port', () => {
  const doc = { nodes: [{ id: 'input', type: 'input' }, { id: 'verify', type: 'tool' }, { id: 'improvement', type: 'improvement' }, { id: 'evaluation', type: 'evaluation' }], edges: [{ sourceNode: 'input', targetNode: 'verify' }] }, before = structuredClone(doc), positions = layoutPositions(doc);
  assert.equal(positions.get('evaluation').y, positions.get('improvement').y); assert.ok(positions.get('evaluation').x + 270 < positions.get('improvement').x, 'the full 270px node and port hit areas must be disjoint before any learning edge exists');
  const connected = layoutPositions({ ...doc, edges: [...doc.edges, { sourceNode: 'evaluation', targetNode: 'improvement' }] }); assert.deepEqual(connected.get('input'), positions.get('input')); assert.deepEqual(connected.get('verify'), positions.get('verify')); assert.ok(connected.get('evaluation').x + 270 < connected.get('improvement').x); assert.deepEqual(doc, before);
});

test('dependency layout keeps tall parallel preview cards apart and learning below their actual bottoms', () => {
  const doc = { nodes: [{ id: 'input' }, { id: 'front' }, { id: 'back' }, { id: 'join' }, { id: 'evaluate', type: 'evaluation' }, { id: 'improve', type: 'improvement' }],
    edges: [{ sourceNode: 'input', targetNode: 'front' }, { sourceNode: 'input', targetNode: 'back' }, { sourceNode: 'front', targetNode: 'join' }, { sourceNode: 'back', targetNode: 'join' }] };
  const sizes = new Map([['input', { height: 520 }], ['front', { height: 350 }], ['back', { height: 650 }]]), before = structuredClone(doc), positions = layoutPositions(doc, sizes);
  assert.equal(positions.get('front').x, positions.get('back').x);
  assert.ok(positions.get('back').y >= positions.get('front').y + 350 + 48);
  const businessBottom = Math.max(...doc.nodes.filter(node => !['evaluation', 'improvement'].includes(node.type)).map(node => positions.get(node.id).y + (sizes.get(node.id)?.height || 180)));
  assert.ok(positions.get('evaluate').y >= businessBottom + 80); assert.equal(positions.get('improve').y, positions.get('evaluate').y);
  assert.deepEqual(doc, before);
  assert.deepEqual(layoutPositions(doc, new Map([['front', { height: NaN }], ['back', { height: -20 }]])), layoutPositions(doc));
});

test('the automatic-layout button refreshes actual card measurements before positioning nodes', t => {
  const previous = globalThis.requestAnimationFrame; globalThis.requestAnimationFrame = callback => callback();
  t.after(() => { if (previous) globalThis.requestAnimationFrame = previous; else delete globalThis.requestAnimationFrame; });
  const studio = Object.create(WorkflowStudioUI.prototype), doc = { ...createDocument({ schemaVersion: 2 }), nodes: [createNode('input', {}, { id: 'input' }), createNode('tool', {}, { id: 'first' }), createNode('tool', {}, { id: 'second' })],
    edges: [{ id: 'first-edge', sourceNode: 'input', sourcePort: 'out', targetNode: 'first', targetPort: 'in' }, { id: 'second-edge', sourceNode: 'input', sourcePort: 'out', targetNode: 'second', targetPort: 'in' }] };
  let measured = false, fitted = false;
  studio.editor = { doc, offsets: new Map(), measurePorts() { measured = true; this.offsets.set('first:size', { width: 270, height: 400 }); },
    commit(next, label) { assert.equal(measured, true); assert.equal(label, '按依赖自动布局'); this.doc = next; }, fit() { fitted = true; } };
  studio.autoLayout(); const first = studio.editor.doc.nodes.find(node => node.id === 'first'), second = studio.editor.doc.nodes.find(node => node.id === 'second');
  assert.ok(second.y >= first.y + 400 + 48); assert.equal(fitted, true); assert.deepEqual(studio.editor.doc.edges, doc.edges);
  assert.deepEqual(studio.editor.doc.nodes.map(({ x, y, ...rest }) => rest), doc.nodes.map(({ x, y, ...rest }) => rest));
});

test('adding nodes finds a clear nearby position using the actual tall input card dimensions', () => {
  const nodes = [{ id: 'input', x: 0, y: 0 }], sizes = new Map([['input', { width: 270, height: 410 }]]);
  assert.deepEqual(vacantNodePosition(nodes, { x: 0, y: 0 }, sizes), { x: 320, y: 0 });
  const clear = { x: 700, y: 120 }; assert.deepEqual(vacantNodePosition(nodes, clear, sizes), clear);
});

test('upgrading the active document refreshes disabled node-library capabilities once', () => {
  const studio = Object.create(WorkflowStudioUI.prototype); let refreshed = 0; studio.editor = { doc: createDocument(), root: { dataset: {} }, renderLibrary: () => { refreshed++; } }; studio.upgrade = {}; studio.check = {}; studio.renderInputs = () => {}; studio.renderGraph = () => {}; studio.setTab = () => {}; studio.setView = () => {};
  studio.syncDocument(); assert.equal(refreshed, 1); studio.syncDocument(); assert.equal(refreshed, 1);
  studio.editor.doc = { ...studio.editor.doc, schemaVersion: 2, settings: { maxConcurrency: 4, outputDirectory: '' } }; studio.syncDocument(); assert.equal(refreshed, 2); assert.equal(studio.upgrade.hidden, true); assert.equal(studio.executable('human'), true);
});

test('artifact presentation includes completed intermediate outputs and deduplicates only the same opaque id', () => {
  const first = { id: 'artifact-a', name: 'front.png' }, second = { id: 'artifact-b', name: 'back.png' };
  assert.deepEqual(runArtifacts({ status: 'waiting_review', artifacts: [first], nodes: { front: { status: 'complete', artifacts: [first] }, back: { status: 'complete', artifacts: [second] } } }), [first, second]);
  assert.equal(portCompatible('image', 'object'), false); assert.equal(portCompatible('image', 'any'), true); assert.equal(shortVersion(`sha256:${'a'.repeat(64)}`), 'aaaaaaaa');
});

test('overview merges equal basename and SHA copies and keeps the downstream producer regardless of discovery order', () => {
  const branch = { id: 'branch', nodeId: 'render', attempt: 3, name: 'Pinout.png', sha256: 'a'.repeat(64), previewUrl: '/branch' }, final = { ...branch, id: 'final', nodeId: 'verify', attempt: 1, name: '/delivery/Pinout.png', previewUrl: '/final' };
  const forward = { nodeOrder: ['render', 'verify'], artifacts: [branch], nodes: { render: { artifacts: [branch] }, verify: { artifacts: [final] } } };
  const reverse = { nodeOrder: ['render', 'verify'], artifacts: [final], nodes: { verify: { artifacts: [final] }, render: { artifacts: [branch] } } };
  assert.deepEqual(runArtifacts(forward), [final]); assert.deepEqual(runArtifacts(reverse), [final]);
});

test('overview preserves same-name files with different SHA and differently named files with equal SHA', () => {
  const first = { id: 'first', nodeId: 'render', name: 'Pinout.png', sha256: 'a'.repeat(64) }, revised = { ...first, id: 'revised', nodeId: 'verify', sha256: 'b'.repeat(64) }, renamed = { ...first, id: 'renamed', nodeId: 'verify', name: 'Pinout-back.png' };
  assert.deepEqual(runArtifacts({ nodeOrder: ['render', 'verify'], artifacts: [first, revised, renamed] }), [first, revised, renamed]);
});

test('overview never content-merges distinct artifacts without a complete SHA', () => {
  const items = [{ id: 'missing-a', name: 'SCH.pdf' }, { id: 'missing-b', name: 'SCH.pdf' }, { id: 'empty-a', name: 'SCH.pdf', sha256: '' }, { id: 'empty-b', name: 'SCH.pdf', sha256: '' }, { id: 'partial-a', name: 'SCH.pdf', sha256: '1234' }, { id: 'partial-b', name: 'SCH.pdf', sha256: '1234' }];
  assert.deepEqual(runArtifacts({ artifacts: items }), items);
});

test('run-state labels follow the persisted dependency order rather than insertion order', () => {
  const states = { human: { status: 'waiting_review' }, output: { status: 'pending' }, input: { status: 'complete' }, render: { status: 'complete' } };
  assert.deepEqual(orderedNodeStates({ nodeOrder: ['input', 'render', 'human', 'output'], nodes: states }).map(([id]) => id), ['input', 'render', 'human', 'output']);
});

test('source-file counts read manifest entries and count folder files separately from parameter fields', () => {
  assert.equal(manifestSourceCount({ entries: [{ kind: 'file', path: '/source.epro2' }, { kind: 'image', path: '/front.png' }, { kind: 'image', path: '/back.png' }, { kind: 'file', path: '/profile.json' }, { kind: 'text', value: 'P4C61-TINY' }, { kind: 'text', value: '1.0' }, { kind: 'text', value: '2026-10-25' }] }), 4);
  assert.equal(manifestSourceCount({ entries: [{ kind: 'folder', path: '/资料', files: [{ path: '/资料/a' }, { path: '/资料/b' }, { path: '/资料/c' }] }, { kind: 'file', path: '/source.epro2' }, { kind: 'number', value: 3 }, { kind: 'text', path: '/a-text-is-not-a-file', value: 'parameter' }] }), 4); assert.equal(manifestSourceCount(undefined), 0);
});

test('node-version options list the current attempt and newest history first without changing their values', () => {
  const first = { attempt: 1, status: 'error', input: 0, output: false }, second = { attempt: 2, status: 'complete', output: null }, current = { attempt: 3, status: 'waiting_review', history: [first, second] }, before = JSON.stringify(current);
  const versions = nodeInspectionVersions(current); assert.deepEqual(versions.map(version => version.key), ['current', 'history-1', 'history-0']); assert.match(versions[0].label, /当前.*3.*待审核/); assert.match(versions[2].label, /历史.*1.*失败/); assert.equal(versions[1].record.output, null); assert.equal(versions[2].record.output, false); assert.equal(JSON.stringify(current), before);
});

test('changes to named port mappings or execution settings invalidate runtime and learning snapshots', () => {
  const before = documentWithInputs(), after = structuredClone(before); after.settings.maxConcurrency = 2;
  assert.equal(workflowSnapshotChanged({ document: before }, after), true); assert.equal(learningSnapshotChanged(before, after), true);
  after.settings = before.settings; after.nodes[0].ports = { inputs: [], outputs: [{ id: 'image', label: '照片', type: 'image', valuePath: 'frontImage' }] };
  assert.equal(workflowSnapshotChanged({ document: before }, after), true); assert.equal(learningSnapshotChanged(before, after), true);
});

test('v2 manual execution never submits a run if actual file preflight fails', async () => {
  let document = documentWithInputs(); document.nodes.push(createNode('tool', { x: 300, y: 0 }, { id: 'code', config: { code: 'return input' } }), createNode('output', { x: 600, y: 0 }, { id: 'output' }));
  document = connectNodes(document, { sourceNode: 'input-0', sourcePort: 'out', targetNode: 'code', targetPort: 'in' }); document = connectNodes(document, { sourceNode: 'code', sourcePort: 'out', targetNode: 'output', targetPort: 'in' });
  let submitted = 0, checks = 0; const runtime = Object.create(WorkflowRuntimeUI.prototype);
  Object.assign(runtime, { editor: { doc: document, prepareRun: () => document, studio: { syncRawInput() {}, preflight: async () => { checks++; return { ok: false, errors: [{ code: 'missing', message: '工程未准备好' }] }; } } }, input: { value: JSON.stringify({ path: '/missing.epro2', count: 0 }) }, skillPending: new Set(), setExpanded() {}, syncWorkflow() {}, updateRunButton() {}, activeRun: () => null, showNotice(message) { this.noticeText = message; }, getBackend: () => ({ state: 'offline' }), api: async () => { submitted++; } });
  await runtime.start(); assert.equal(checks, 1); assert.equal(submitted, 0); assert.match(runtime.noticeText, /工程未准备好/); assert.equal(runtime.starting, false);
});

test('v2 manual execution posts the preflight-normalized input exactly once', async () => {
  let document = documentWithInputs(); document.nodes.push(createNode('tool', { x: 300, y: 0 }, { id: 'code', config: { code: 'return input' } }), createNode('output', { x: 600, y: 0 }, { id: 'output' }));
  document = connectNodes(document, { sourceNode: 'input-0', sourcePort: 'out', targetNode: 'code', targetPort: 'in' }); document = connectNodes(document, { sourceNode: 'code', sourcePort: 'out', targetNode: 'output', targetPort: 'in' });
  const normalized = { source0: { path: '/valid.epro2', count: 0 } }; let submitted;
  const runtime = Object.create(WorkflowRuntimeUI.prototype); Object.assign(runtime, { editor: { doc: document, prepareRun: () => document, studio: { syncRawInput() {}, preflight: async () => ({ ok: true, input: normalized }), setView() {} } }, input: { value: JSON.stringify({ path: '/valid.epro2', count: 0 }) }, skillPending: new Set(), revisions: new Map(), revision: 0, setExpanded() {}, syncWorkflow() {}, updateRunButton() {}, activeRun: () => null, showNotice() {}, getBackend: () => ({ state: 'offline' }), api: async (url, options) => { submitted = options.body; return { run: { id: 'real-run', workflowId: document.id, status: 'queued', document } }; }, storeRun() {}, render() {} });
  await runtime.start(); assert.deepEqual(submitted.input, normalized); assert.equal(runtime.currentRunId, 'real-run');
});

test('only an explicit rerun response can reopen a terminal run in the UI cache', () => {
  const runtime = Object.create(WorkflowRuntimeUI.prototype); runtime.runs = new Map([['run', { id: 'run', status: 'complete', workflowId: 'workflow' }]]); runtime.revisions = new Map(); runtime.revision = 0; runtime.stopRequested = new Set();
  const resumed = { id: 'run', workflowId: 'workflow', status: 'running', nodes: { render: { status: 'running', attempt: 2 } } };
  runtime.storeRun(resumed); assert.equal(runtime.runs.get('run').status, 'complete');
  runtime.storeRun(resumed, { allowReopen: true }); assert.equal(runtime.runs.get('run').status, 'running'); assert.equal(runtime.runs.get('run').nodes.render.attempt, 2);
});

test('a newly queued task does not steal the run being reviewed', () => {
  const document = documentWithInputs(), current = { id: 'reviewed', workflowId: document.id, document, status: 'waiting_review' }, next = { id: 'queued', workflowId: document.id, document, status: 'queued' }; const runtime = Object.create(WorkflowRuntimeUI.prototype);
  Object.assign(runtime, { editor: { doc: document }, currentRunId: current.id, runs: new Map([[current.id, current]]), revisions: new Map(), revision: 0, stopRequested: new Set(), scheduleRender() {} });
  runtime.handleEvent({ type: 'workflow.run', payload: next }); assert.equal(runtime.currentRunId, current.id); assert.equal(runtime.runs.get(next.id).status, 'queued');
});

class FakeElement { constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.value = ''; this.attributes = {}; this.isConnected = true; } append(...children) { this.children.push(...children); } replaceChildren(...children) { this.children = children; } insertBefore(child) { this.children.push(child); } querySelector() { return null; } querySelectorAll() { return []; } get childElementCount() { return this.children.length; } showModal() { this.open = true; } close() { this.open = false; } addEventListener(name, handler) { this.listeners[name] = handler; } dispatchEvent(event) { this.listeners[event.type]?.(event); } setAttribute(name, value) { this.attributes[name] = value; } }

test('run locations distinguish authoritative originals, delivery copies and unchanged historical storage', async t => {
  const previous = globalThis.document; globalThis.document = { createElement: tag => new FakeElement(tag) }; t.after(() => { if (previous) globalThis.document = previous; else delete globalThis.document; });
  const studio = Object.create(WorkflowStudioUI.prototype), calls = []; studio.editor = { toast(message) { throw new Error(message); } }; studio.api = async (path, options) => { calls.push({ path, body: options.body }); };
  const run = { id: 'run-separated', storageVersion: 2, outputDirectory: '/local/runs/run-separated', deliveryDirectory: '/user/outputs/run-separated', document: { settings: { outputDirectory: '/user/outputs' } } };
  let locations = studio.renderRunLocations(run);
  assert.ok(locations.children.some(item => item.textContent === '执行原件目录：/local/runs/run-separated'));
  assert.ok(locations.children.some(item => item.textContent === '交付副本目录：/user/outputs/run-separated'));
  assert.ok(locations.children.some(item => /运行完成后再保存交付副本/.test(item.textContent)));
  await locations.children.find(item => item.textContent === '打开执行原件目录').listeners.click();
  assert.deepEqual(calls, [{ path: '/api/workflow-v2/open-directory', body: { runId: run.id, kind: 'original' } }]);
  locations = studio.renderRunLocations({ ...run, delivery: { status: 'complete', directory: '/user/completed/run-separated' } });
  assert.ok(locations.children.some(item => item.textContent === '交付副本目录：/user/completed/run-separated'));
  assert.ok(locations.children.some(item => /交付副本已保存/.test(item.textContent)));
  locations = studio.renderRunLocations({ id: 'old-run', outputDirectory: '/user/old-run', document: {} });
  assert.ok(locations.children.some(item => item.textContent === '历史运行输出目录：/user/old-run'));
  assert.equal(locations.children.some(item => /执行原件目录|交付副本目录/.test(item.textContent)), false);
});

test('delivery retry republishes only the completed run and blocks duplicate clicks without executing nodes', async t => {
  const previous = globalThis.document; globalThis.document = { createElement: tag => new FakeElement(tag) }; t.after(() => { if (previous) globalThis.document = previous; else delete globalThis.document; });
  const run = { id: 'run-delivery', storageVersion: 2, outputDirectory: '/local/run', deliveryDirectory: '/user/run', delivery: { status: 'error', error: '输出目录不可访问。' } }, studio = Object.create(WorkflowStudioUI.prototype), calls = [], stored = []; let finish, renders = 0;
  studio.editor = { toast(message) { throw new Error(message); } }; studio.runtime = { storeRun(...args) { stored.push(args); }, render() { renders++; } }; studio.api = (path, options) => { calls.push({ path, body: options.body }); return new Promise(resolve => { finish = resolve; }); };
  const locations = studio.renderRunLocations(run), retry = locations.children.find(item => item.textContent === '重试保存交付副本');
  assert.ok(locations.children.some(item => /执行原件已保留/.test(item.textContent)));
  const pending = retry.listeners.click(); await retry.listeners.click(); assert.equal(retry.disabled, true); assert.equal(calls.length, 1);
  const completed = { ...run, delivery: { status: 'complete', directory: '/user/run' } }; finish({ run: completed }); await pending;
  assert.deepEqual(calls, [{ path: '/api/workflow-runs/run-delivery/publish', body: {} }]);
  assert.deepEqual(stored, [[completed, { allowReopen: true }]]); assert.equal(renders, 1); assert.equal(retry.disabled, false);
  studio.api = async () => { throw new Error('目录仍不可访问'); }; const failures = []; studio.editor.toast = (...args) => failures.push(args); await retry.listeners.click();
  assert.deepEqual(failures, [['目录仍不可访问', true]]); assert.equal(stored.length, 1); assert.equal(retry.disabled, false);
});

test('inline input preparation keeps every file, folder and image visible even after three parameters', () => {
  const fields = [...['product', 'version', 'date'].map(key => ({ key, label: key, kind: 'text' })),
    ...['source', 'front', 'back', 'profile', 'directory'].map((key, index) => ({ key, label: key, kind: index === 4 ? 'folder' : index === 1 || index === 2 ? 'image' : 'file' }))];
  const node = createNode('input', {}, { config: { outputType: 'object', fields } }), before = structuredClone(node);
  assert.deepEqual(inlineInputFields(node).visible.map(field => field.key), ['source', 'front', 'back', 'profile', 'directory']);
  assert.equal(inlineInputFields(node).remaining, 3); assert.deepEqual(node, before);
  const legacyPath = createNode('input', {}, { title: '原始工程', config: { sourceKind: 'file', extensions: ['.epro2'] } });
  assert.deepEqual(inlineInputFields(legacyPath).visible.map(field => [field.key, field.kind]), [['path', 'file']]);
});

function nodeGraphFixture(t, nodes, selectedRun = null) {
  const previous = globalThis.document; globalThis.document = { activeElement: null, createElement: tag => new FakeElement(tag) };
  t.after(() => { if (previous) globalThis.document = previous; else delete globalThis.document; });
  const descendants = item => [item, ...(item.children || []).flatMap(descendants)], cards = new Map(nodes.map(node => {
    const card = new FakeElement('article'); card.contains = () => false;
    card.querySelector = selector => selector === '.wf-studio-node-content' ? card.children.find(item => item.className === selector.slice(1)) : null;
    return [node.id, card];
  }));
  const studio = Object.create(WorkflowStudioUI.prototype), doc = { ...createDocument({ schemaVersion: 2 }), nodes };
  Object.assign(studio, { values: {}, runtime: { currentRun: () => selectedRun, setExpanded(value) { this.expanded = value; } },
    editor: { doc, nodeElements: cards, settings: {}, requestGeometry() { this.geometryRequests = (this.geometryRequests || 0) + 1; }, selectNode(id) { this.selected = id; }, applySettings() {} },
    setView(view) { this.view = view; }, setTab(tab) { this.tab = tab; }, invalidatePreflight() { this.invalidated = true; }, syncRawInput() {}, renderInputs() {} });
  return { studio, doc, cards, descendants };
}

test('input cards display readable filenames, preserve full editable paths, and use the real path picker', t => {
  const node = createNode('input', {}, { id: 'source', title: '工程资料', config: { outputType: 'object', fields: structuredClone(INPUT_FIELD_PRESETS[1].fields) } });
  const { studio, cards, descendants } = nodeGraphFixture(t, [node]);
  studio.values.source = { sourcePath: '/fixtures/example/很长的工作目录/原始工程.epro2', guideProfilePath: '/fixtures/example/指南配置.json', fourFilesDirectory: '/fixtures/example/四文件目录' };
  studio.pickPath = (field, previous, done) => { assert.equal(field.key, 'sourcePath'); assert.equal(previous, studio.values.source.sourcePath); done('/fixtures/example/新工程.epro2'); };
  studio.renderGraph();
  const elements = descendants(cards.get(node.id)), control = elements.find(item => item.attributes['aria-label'] === '工程资料 · 原始 EPRO2 工程');
  assert.equal(elements.filter(item => item.tag === 'input').length, 5, 'all five path fields remain directly editable');
  assert.ok(elements.some(item => item.textContent === '原始工程.epro2' && item.title === control.value));
  assert.equal(control.title, control.value); assert.equal(control.value, studio.values.source.sourcePath);
  elements.find(item => item.attributes['aria-label'] === '工程资料 · 选择原始 EPRO2 工程').listeners.click();
  assert.equal(studio.values.source.sourcePath, '/fixtures/example/新工程.epro2'); assert.equal(control.title, studio.values.source.sourcePath);
  assert.ok(elements.some(item => item.textContent === '新工程.epro2')); assert.equal(studio.invalidated, true);
  assert.ok(elements.some(item => /准备全部 8 项资料/.test(item.textContent))); assert.ok(studio.editor.geometryRequests >= 2);
});

test('an unrun output card keeps a preview placeholder and a working run-record entry without inventing artifacts', t => {
  const node = createNode('output', {}, { id: 'delivery', title: '交付成果', config: { stage: 'final' } });
  const { studio, cards, descendants } = nodeGraphFixture(t, [node]); studio.renderGraph();
  const elements = descendants(cards.get(node.id));
  assert.ok(elements.some(item => item.attributes['aria-label'] === '交付成果 · 图片预览占位'));
  assert.ok(elements.some(item => /尚未运行/.test(item.textContent))); assert.equal(elements.filter(item => item.tag === 'img').length, 0);
  elements.find(item => item.attributes['aria-label'] === '交付成果 · 查看运行').listeners.click();
  assert.equal(studio.view, 'run'); assert.equal(studio.editor.selected, 'delivery'); assert.equal(studio.runtime.expanded, true); assert.equal(studio.editor.geometryRequests, 1);
});

function previewRunFixture() {
  const artifact = (id, nodeId, name, extra = {}) => ({ id, runId: 'run', nodeId, attempt: 1, name, mimeType: 'image/png', sha256: 'a'.repeat(64), previewUrl: `/api/workflow-v2/artifacts/${id}`, ...extra });
  const first = artifact('front-png', 'front', 'front.png'), second = artifact('back-png', 'back', 'back.png');
  return { id: 'run', workflowId: 'workflow', document: { id: 'workflow', nodes: [{ id: 'front', type: 'tool' }, { id: 'back', type: 'tool' }, { id: 'delivery', type: 'output' }] },
    nodes: { front: { attempt: 1 }, back: { attempt: 1 }, delivery: { status: 'complete', attempt: 1, artifacts: [first, second,
      artifact('source-photo', 'front', 'original.png', { role: 'photoOriginal' }),
      artifact('stale', 'front', 'old.png', { attempt: 2 }), artifact('foreign', 'back', 'foreign.png', { runId: 'another-run' }),
      artifact('unsafe', 'back', 'unsafe.png', { previewUrl: '/api/workflow-v2/artifacts/another-id' }),
      artifact('path-only', 'back', 'path.png', { previewUrl: undefined, path: '/tmp/path.png' })] } } };
}

test('canvas previews focus on image-producing capabilities, review gates and final delivery', () => {
  for (const toolName of ['hdk.four.pinout-front', 'hdk.four.pinout-back', 'hdk.guide.drawio', 'hdk.guide.annotate-back-en', 'hdk.full.native', 'hdk.full.process', 'hdk.full.sop']) {
    assert.equal(nodeShowsCanvasPreview({ type: 'tool', config: { executionMode: 'tool', toolName } }), true, toolName);
  }
  for (const toolName of ['hdk.four.native', 'hdk.four.verify', 'hdk.pinout.verify', 'hdk.guide.import-four', 'hdk.guide.assemble', 'hdk.full.verify-delivery']) {
    assert.equal(nodeShowsCanvasPreview({ type: 'tool', config: { executionMode: 'tool', toolName } }), false, toolName);
  }
  assert.equal(nodeShowsCanvasPreview({ type: 'human' }), true);
  assert.equal(nodeShowsCanvasPreview({ type: 'output' }), true, 'legacy final outputs keep their delivery overview');
  assert.equal(nodeShowsCanvasPreview({ type: 'output', config: { stage: 'intermediate' } }), false);
  assert.equal(nodeShowsCanvasPreview({ type: 'tool', config: { executionMode: 'code', reviewImages: true } }), true);
  for (const type of ['input', 'merge', 'validation', 'evaluation']) assert.equal(nodeShowsCanvasPreview({ type, config: { reviewImages: true } }), false, type);
});

test('inherited and copied images do not create canvas previews on transit nodes or stage manifests', t => {
  const run = previewRunFixture();
  const nodes = [createNode('merge', {}, { id: 'merged', title: '汇总图片' }),
    createNode('tool', {}, { id: 'checked', title: '验收图片', config: { executionMode: 'tool', toolName: 'hdk.pinout.verify' } }),
    createNode('output', {}, { id: 'stage', title: '审核成果清单', config: { stage: 'intermediate' } })];
  for (const node of nodes) {
    run.document.nodes.push(node);
    const artifacts = structuredClone(run.nodes.delivery.artifacts);
    if (node.type === 'tool') for (const artifact of artifacts) artifact.nodeId = node.id;
    run.nodes[node.id] = { status: 'complete', attempt: 1, artifacts };
  }
  const { studio, doc, cards, descendants } = nodeGraphFixture(t, nodes, run); doc.id = 'workflow'; studio.renderGraph();
  for (const node of nodes) {
    assert.deepEqual(nodePreviewArtifacts(run, 'workflow', node.id), []);
    assert.equal(descendants(cards.get(node.id)).some(item => item.tag === 'img' || item.className === 'wf-studio-node-preview-empty'), false, node.title);
  }
  assert.ok(descendants(cards.get('stage')).some(item => item.attributes['aria-label'] === '审核成果清单 · 查看运行'), 'stage files remain accessible');
});

test('node preview candidates require the exact workflow, run, current producer attempt, SHA and opaque artifact URL', () => {
  const run = previewRunFixture(), before = structuredClone(run);
  assert.deepEqual(nodePreviewArtifacts(run, 'workflow', 'delivery').map(item => item.id), ['front-png', 'back-png']);
  assert.deepEqual(nodePreviewArtifacts(run, 'new-workflow', 'delivery'), []);
  assert.deepEqual(nodePreviewArtifacts({ ...run, document: { ...run.document, id: 'another' } }, 'workflow', 'delivery'), []);
  run.nodes.delivery.artifacts[0].sha256 = ''; assert.deepEqual(nodePreviewArtifacts(run, 'workflow', 'delivery').map(item => item.id), ['back-png']);
  run.nodes.delivery.artifacts[0].sha256 = before.nodes.delivery.artifacts[0].sha256; assert.deepEqual(run, before);
});

test('output cards show multiple registered images with original-size links and refresh their geometry after image load', t => {
  const node = createNode('output', {}, { id: 'delivery', title: '交付成果', config: { stage: 'final' } }), run = previewRunFixture();
  const { studio, doc, cards, descendants } = nodeGraphFixture(t, [node], run); doc.id = 'workflow'; studio.renderGraph();
  const elements = descendants(cards.get(node.id)), images = elements.filter(item => item.tag === 'img');
  assert.deepEqual(images.map(item => item.src), ['/api/workflow-v2/artifacts/front-png', '/api/workflow-v2/artifacts/back-png']);
  assert.deepEqual(elements.filter(item => item.tag === 'a').map(item => [item.href, item.target, item.rel]), images.map(item => [item.src, '_blank', 'noopener']));
  assert.ok(elements.some(item => /所选运行 run · 已完成/.test(item.textContent)));
  images[0].listeners.load(); assert.equal(studio.editor.geometryRequests, 2);
});

function preflightFixture(t, preset = '使用指南资料字段') {
  const previous = globalThis.document, make = tag => { const item = new FakeElement(tag); item.dataset = {}; item.classes = new Set(); item.classList = { toggle(name, yes) { if (yes) item.classes.add(name); else item.classes.delete(name); } }; item.remove = () => { item.removed = true; }; return item; };
  globalThis.document = { createElement: make }; t.after(() => { if (previous) globalThis.document = previous; else delete globalThis.document; });
  const create = label => { const doc = createDocument({ schemaVersion: 2 }); doc.nodes = [createNode('input', { x: 0, y: 0 }, { id: 'shared-input-id', config: { outputType: 'object', fields: structuredClone(INPUT_FIELD_PRESETS.find(item => item.label === label).fields) } })]; return doc; };
  const studio = Object.create(WorkflowStudioUI.prototype), descendants = item => [item, ...(item.children || []).flatMap(descendants)];
  Object.assign(studio, { values: {}, check: make('button'), upgrade: {}, inputs: make('div'), inputNotice: make('p'), runtime: { input: make('textarea') }, renderGraph() {}, setTab(tab) { this.tab = tab; }, setView() {} });
  studio.inputs.querySelectorAll = selector => selector === '.wf-studio-input-error' ? descendants(studio.inputs).filter(item => item.className === selector.slice(1) && !item.removed) : [];
  studio.editor = { doc: create(preset), root: { dataset: {} }, settings: {}, renderLibrary() {}, applySettings() {}, commit(doc) { this.doc = doc; studio.syncDocument(); } };
  studio.syncDocument();
  const result = (files = 4) => ({ ok: true, input: { frozen: 'server-admitted-input' }, manifest: { entries: Array.from({ length: files }, (_, index) => ({ kind: 'file', path: `/file-${index}` })) } });
  return { studio, create, result, descendants, make };
}

test('cross-workflow preparation never reuses the previous green notice, counts or field errors', async t => {
  const { studio, create, result, make } = preflightFixture(t);
  studio.api = async () => result(21); await studio.preflight({ quiet: true, input: {} });
  assert.match(studio.inputNotice.textContent, /8 项输入.*21 项来源文件/);
  const oldError = make('p'); oldError.className = 'wf-studio-input-error'; studio.inputs.append(oldError);
  studio.editor.doc = create('板卡资料字段'); studio.syncDocument();
  assert.equal(studio.preflightResult, null); assert.equal(studio.inputNotice.textContent, ''); assert.equal(studio.inputNotice.hidden, true); assert.equal(studio.inputNotice.classes.has('error'), false); assert.equal(oldError.removed, true);
  studio.api = async () => result(); await studio.preflight({ quiet: true, input: {} }); assert.match(studio.inputNotice.textContent, /7 项输入.*4 项来源文件/);
});

test('late preflight for another workflow returns its frozen result without changing the newer form or request', async t => {
  const { studio, create, result } = preflightFixture(t); let first, second;
  studio.api = () => new Promise(resolve => { if (!first) first = resolve; else second = resolve; });
  const originalDocument = structuredClone(studio.editor.doc), frozenInput = { sourcePath: '/old-source.epro2' }, older = studio.preflight({ quiet: true, document: originalDocument, input: frozenInput });
  studio.editor.doc = create('板卡资料字段'); studio.syncDocument(); const latest = studio.preflight({ quiet: true, input: { sourcePath: '/current.epro2' } });
  const oldResult = result(21); first(oldResult); assert.equal(await older, oldResult); assert.equal(studio.preflightResult, null); assert.equal(studio.inputNotice.textContent, ''); assert.equal(studio.check.disabled, true, 'old finally must not re-enable the newer request');
  const newestResult = result(); second(newestResult); await latest;
  assert.equal(studio.preflightResult, newestResult); assert.match(studio.inputNotice.textContent, /7 项输入.*4 项来源文件/); assert.equal(studio.check.disabled, false); assert.equal(frozenInput.sourcePath, '/old-source.epro2'); assert.deepEqual(originalDocument.nodes[0].config.fields, INPUT_FIELD_PRESETS.find(item => item.label === '使用指南资料字段').fields);
});

test('editing a prepared field invalidates its admission immediately and ignores the in-flight old response', async t => {
  const { studio, result, descendants } = preflightFixture(t, '板卡资料字段'); studio.api = async () => result(); await studio.preflight({ quiet: true, input: {} });
  let finish; studio.api = () => new Promise(resolve => { finish = resolve; }); const pending = studio.preflight({ quiet: true, input: { sourcePath: '/previous.epro2' } });
  const field = descendants(studio.inputs).find(item => item.dataset?.inputKey === 'sourcePath'); field.value = '/new-source.epro2'; field.dispatchEvent({ type: 'input' });
  assert.equal(studio.preflightResult, null); assert.equal(studio.inputNotice.textContent, ''); assert.equal(studio.inputNotice.hidden, true);
  const oldResult = { ok: false, errors: [{ key: 'sourcePath', message: 'old missing file' }] }; finish(oldResult); assert.equal(await pending, oldResult);
  assert.equal(studio.values['shared-input-id'].sourcePath, '/new-source.epro2'); assert.equal(studio.inputNotice.textContent, ''); assert.equal(studio.inputs.querySelectorAll('.wf-studio-input-error').length, 0);
});

test('a late failure from an older check cannot replace the latest successful admission', async t => {
  const { studio, result } = preflightFixture(t); let failFirst, finishSecond, calls = 0;
  studio.api = () => ++calls === 1 ? new Promise((resolve, reject) => { failFirst = reject; }) : new Promise(resolve => { finishSecond = resolve; });
  const older = studio.preflight({ quiet: true, input: {} }), latest = studio.preflight({ quiet: true, input: {} }), admitted = result(); finishSecond(admitted); await latest;
  const notice = studio.inputNotice.textContent; failFirst(new Error('stale request failed')); assert.equal((await older).ok, false);
  assert.equal(studio.preflightResult, admitted); assert.equal(studio.inputNotice.textContent, notice); assert.equal(studio.inputNotice.classes.has('error'), false); assert.equal(studio.check.disabled, false);
});

test('restoring input, editing its schema and changing the unblurred output root all invalidate preparation only', async t => {
  const { studio, result } = preflightFixture(t); studio.api = async () => result();
  for (const change of [() => studio.restoreInput({ sourcePath: '/restored.epro2' }), () => { const next = structuredClone(studio.editor.doc); next.nodes[0].config.fields[0].required = false; studio.editor.doc = next; studio.syncDocument(); }, () => { studio.outputDirectoryInput.value = '/next-output'; studio.flushRunSettings(); }]) {
    await studio.preflight({ quiet: true, input: {} }); assert.ok(studio.preflightResult); change(); assert.equal(studio.preflightResult, null); assert.equal(studio.inputNotice.hidden, true); assert.equal(studio.inputNotice.textContent, '');
  }
  assert.equal(studio.editor.doc.settings.outputDirectory, '/next-output');
});

test('all three visible field-preset buttons merge the latest schema while leaving prepared input drafts untouched', t => {
  const previous = globalThis.document; globalThis.document = { createElement: tag => new FakeElement(tag) }; t.after(() => { if (previous) globalThis.document = previous; else delete globalThis.document; });
  const node = { id: 'input', type: 'input', config: { fields: [{ key: 'releaseDate', label: '自定义日期', kind: 'text', required: false }, { key: 'custom', label: '备注', kind: 'text', required: false }] } }, studio = Object.create(WorkflowStudioUI.prototype); let applied = 0;
  Object.assign(studio, { editor: { doc: { nodes: [node] }, properties: new FakeElement('aside'), settings: {}, applySettings() { applied++; } }, values: { input: { releaseDate: '2026-10-25', custom: '已准备的值' } }, runtime: { input: { value: '{"preserved":true}' } }, setTab(tab) { this.tab = tab; }, updateConfig(id, config) { const current = this.editor.doc.nodes.find(item => item.id === id); current.config = { ...current.config, ...config }; return true; } }); const before = structuredClone(studio.values);
  studio.renderFieldSchema(node); const section = studio.editor.properties.children[0], buttons = section.children.filter(item => item.tag === 'button'), press = label => buttons.find(item => item.textContent === label).listeners.click();
  press('使用指南资料字段'); assert.equal(node.config.fields.length, 9); press('完整HDK资料字段'); press('板卡资料字段'); press('使用指南资料字段');
  assert.equal(node.config.fields.length, 11); assert.equal(new Set(node.config.fields.map(field => field.key)).size, 11); assert.deepEqual(node.config.fields[0], { key: 'releaseDate', label: '自定义日期', kind: 'text', required: false }); assert.equal(node.config.outputType, 'object'); assert.deepEqual(studio.values, before); assert.equal(studio.runtime.input.value, '{"preserved":true}'); assert.equal(applied, 4); assert.equal(studio.tab, 'inputs'); assert.ok(section.children.some(item => /提前准备.*匹配.*资料目录/.test(item.textContent)));
});

test('review target options contain only true upstream retryable capabilities and warn without rewriting an old invalid target', t => {
  const previous = globalThis.document, previousOption = globalThis.Option; globalThis.document = { createElement: tag => new FakeElement(tag) }; globalThis.Option = function (label, value) { return { textContent: label, value }; }; t.after(() => { if (previous) globalThis.document = previous; else delete globalThis.document; if (previousOption) globalThis.Option = previousOption; else delete globalThis.Option; });
  const nodes = [{ id: 'input', type: 'input' }, { id: 'plan', type: 'skill', title: '规划' }, { id: 'merge', type: 'merge' }, { id: 'render', type: 'tool', title: '绘图' }, { id: 'sibling', type: 'tool', title: '其它分支' }, { id: 'gate', type: 'human', config: { reviewTargetNodeId: 'sibling', maxRevisions: 3 } }, { id: 'later', type: 'subflow', title: '后续流程' }, { id: 'isolated', type: 'transform', title: '未连线' }], edges = [['input', 'plan'], ['input', 'sibling'], ['plan', 'merge'], ['merge', 'render'], ['render', 'gate'], ['gate', 'later']].map(([sourceNode, targetNode]) => ({ sourceNode, targetNode })), doc = { nodes, edges }, before = structuredClone(doc), studio = Object.create(WorkflowStudioUI.prototype);
  studio.editor = { doc, properties: new FakeElement('aside') }; const calls = []; studio.updateConfig = (id, config) => calls.push([id, config]);
  assert.deepEqual(reviewTargetNodes(doc, 'gate').map(node => node.id), ['plan', 'render']); studio.renderReviewConfig(nodes.find(node => node.id === 'gate'));
  const section = studio.editor.properties.children[0], select = section.children.find(item => item.tag === 'select'); assert.deepEqual(select.children.map(option => option.value), ['', 'plan', 'render']); assert.equal(select.value, ''); assert.ok(section.children.some(item => /原修改目标.*重新选择/.test(item.textContent))); assert.deepEqual(doc, before); assert.equal(calls.length, 0);
  assert.equal(section.children.some(item => item.attributes?.['aria-label'] === '最多修改次数' || /最多修改次数|1–3/.test(item.textContent || '')), false);
  select.value = 'plan'; select.listeners.change(); assert.deepEqual(calls, [['gate', { reviewTargetNodeId: 'plan' }]]);
});

test('overview identifies retained producers while node and historical galleries keep every original reference', t => {
  const previous = globalThis.document; globalThis.document = { createElement: tag => new FakeElement(tag) }; t.after(() => { if (previous) globalThis.document = previous; else delete globalThis.document; });
  const first = { id: 'render-copy', nodeId: 'render', attempt: 2, name: 'Pinout.png', sha256: 'a'.repeat(64), mimeType: 'image/png', previewUrl: '/render', downloadUrl: '/render?download=1' }, final = { ...first, id: 'verify-copy', nodeId: 'verify', attempt: 1, previewUrl: '/verify' }, changed = { ...first, id: 'changed', sha256: 'b'.repeat(64), attempt: 1 };
  const run = { nodeOrder: ['render', 'verify'], document: { nodes: [{ id: 'render', title: '正面 Pinout' }, { id: 'verify', title: '最终交付检查' }] }, nodes: { render: { artifacts: [first], history: [{ attempt: 1, artifacts: [changed] }] }, verify: { artifacts: [first, final, changed] } } }, before = structuredClone(run), studio = Object.create(WorkflowStudioUI.prototype), descendants = item => [item, ...(item.children || []).flatMap(descendants)];
  const overview = descendants(studio.artifactGallery(runArtifacts(run), { run, showOrigin: true }));
  assert.equal(overview.filter(item => item.tag === 'article').length, 2); assert.ok(overview.some(item => item.textContent === '来源：最终交付检查 · 第 1 次尝试')); assert.ok(overview.some(item => item.textContent === '来源：正面 Pinout · 第 1 次尝试'));
  const nodeGallery = descendants(studio.artifactGallery(run.nodes.verify.artifacts)), historyGallery = descendants(studio.artifactGallery(run.nodes.render.history[0].artifacts));
  assert.equal(nodeGallery.filter(item => item.tag === 'article').length, 3); assert.equal(historyGallery.filter(item => item.tag === 'article').length, 1); assert.ok(historyGallery.some(item => item.href === changed.downloadUrl)); assert.deepEqual(run, before);
});

function reviewFixture() {
  const original = { id: 'original', nodeId: 'facts', name: 'front-original.png', mimeType: 'image/png', role: 'photoOriginal', previewUrl: '/original', attempt: 1 };
  const png = { id: 'front-png', nodeId: 'render', name: 'board_Pinout.png', mimeType: 'image/png', previewUrl: '/generated-png', downloadUrl: '/generated-png?download=1', attempt: 2 };
  const svg = { id: 'front-svg', nodeId: 'render', name: 'board_Pinout.svg', mimeType: 'image/svg+xml', previewUrl: '/generated-svg', attempt: 2 };
  const json = { id: 'project', nodeId: 'render', name: 'board_Pinout.json', mimeType: 'application/json', previewUrl: '/project', attempt: 2 };
  for (const [index, artifact] of [original, png, svg, json].entries()) artifact.sha256 = String(index + 1).repeat(64);
  const run = { id: 'run', document: { nodes: [{ id: 'facts', title: '针脚事实', type: 'tool' }, { id: 'render', title: '生成正面 Pinout', type: 'tool' }, { id: 'gate', title: '审核正面 Pinout', type: 'human', config: { prompt: '核对标注' } }], edges: [{ sourceNode: 'facts', targetNode: 'render' }, { sourceNode: 'render', targetNode: 'gate' }] }, nodes: { gate: { status: 'waiting_review', attempt: 3, artifacts: [original, png, svg, json] } } };
  run.nodes.gate.attemptId = 'gate-three';
  return { run, original, png, svg, json };
}

test('review targets select the bound generated PNG and leave originals, duplicate SVG and JSON accessible separately', () => {
  const { run, original, png, svg, json } = reviewFixture(); assert.deepEqual(reviewTargetArtifacts(run, 'gate'), [png]); const groups = groupArtifacts(run.nodes.gate.artifacts); assert.deepEqual(groups.images, [png]); assert.deepEqual(groups.sources, [original]); assert.deepEqual(groups.advanced, [svg, json]); assert.equal(Object.values(groups).flat().length, 4);
});

test('node thumbnails prefer their current generated attempt and never display inherited original photos', () => {
  const { run, original, png } = reviewFixture(), old = { ...png, id: 'old', attempt: 1, previewUrl: '/old-png' };
  run.nodes.render = { attempt: 2, artifacts: [original, old, png] }; run.nodes.facts = { attempt: 1, artifacts: [original] };
  assert.equal(nodeThumbnailArtifact(run, 'render'), png); assert.equal(nodeThumbnailArtifact(run, 'facts'), null); assert.equal(nodeThumbnailArtifact(run, 'gate'), png);
  run.document.nodes.push({ id: 'merge', type: 'merge' }); run.document.edges.push({ sourceNode: 'gate', targetNode: 'merge' }); run.nodes.merge = { attempt: 1, artifacts: [original, png] }; assert.equal(nodeThumbnailArtifact(run, 'merge'), png);
});

test('a completed capability can rerun during a human wait only when no node is still executing', () => {
  const { run } = reviewFixture(); run.status = 'waiting_review'; run.document.schemaVersion = 2; run.nodes.facts = { status: 'complete' };
  assert.equal(canRerunNode(run, 'facts'), true); assert.equal(canRerunNode(run, 'gate'), false); run.nodes.render = { status: 'running' }; assert.equal(canRerunNode(run, 'facts'), false); run.nodes.render.status = 'preparing'; assert.equal(canRerunNode(run, 'facts'), false); run.nodes.render.status = 'complete'; assert.equal(canRerunNode(run, 'facts'), true);
  run.status = 'queued'; assert.equal(canRerunNode(run, 'facts'), false);
});

test('waiting-run inspector exposes optional rerun feedback and submits it only for the selected node', async t => {
  const old = globalThis.document; globalThis.document = { createElement: tag => new FakeElement(tag) }; t.after(() => { if (old) globalThis.document = old; else delete globalThis.document; });
  const { run } = reviewFixture(); run.status = 'waiting_review'; run.document.schemaVersion = 2; run.nodes.facts = { status: 'complete', input: {}, output: {}, artifacts: [] };
  const studio = Object.create(WorkflowStudioUI.prototype); studio.editor = { properties: new FakeElement('aside') }; studio.runtime = { currentRun: () => run }; studio.renderInspectorData('facts');
  const section = studio.editor.properties.children[0], controls = section.children.find(item => item.className === 'wf-studio-rerun'), input = controls.children.find(item => item.tag === 'textarea'); assert.equal(input.attributes['aria-label'], '本次重跑补充要求');
  let submitted; studio.rerun = (id, feedback) => { submitted = { id, feedback }; }; input.value = '使用 VO4；移除 MAIN 前缀'; controls.children.at(-1).listeners.click(); assert.deepEqual(submitted, { id: 'facts', feedback: '使用 VO4；移除 MAIN 前缀' });
});

test('rerun posts feedback for this run without modifying the saved Skill definition', async () => {
  const { run } = reviewFixture(), before = JSON.stringify(run.document), studio = Object.create(WorkflowStudioUI.prototype); let submitted, stored;
  studio.runtime = { currentRun: () => run, storeRun(value, options) { stored = { value, options }; }, render() {} }; studio.editor = { toast(message) { throw new Error(message); } }; studio.api = async (path, options) => { submitted = { path, body: options.body }; return { run: { ...run, status: 'running' } }; };
  await studio.rerun('facts', '使用 VO4；移除 MAIN 前缀'); assert.deepEqual(submitted, { path: '/api/workflow-runs/run/rerun', body: { nodeIds: ['facts'], feedback: '使用 VO4；移除 MAIN 前缀' } }); assert.equal(JSON.stringify(run.document), before); assert.equal(stored.options.allowReopen, true);
  await studio.rerun('facts', ''); assert.deepEqual(submitted.body, { nodeIds: ['facts'] });
});

test('saved review requests remain visible after cancellation and historical selection shows only that version feedback', t => {
  const old = globalThis.document; globalThis.document = { createElement: tag => new FakeElement(tag) }; t.after(() => { if (old) globalThis.document = old; else delete globalThis.document; });
  const { run } = reviewFixture(); run.status = 'cancelled'; run.document.schemaVersion = 2;
  run.nodes.gate = { attempt: 2, status: 'cancelled', review: { decision: 'revision_requested', feedback: '图片横着摆\nDrawIO按之前源文件改为当前板' }, history: [{ attempt: 1, status: 'complete', review: { decision: 'approved', feedback: '旧版审核意见' } }] };
  const studio = Object.create(WorkflowStudioUI.prototype); studio.editor = { properties: new FakeElement('aside') }; studio.runtime = { currentRun: () => run };
  const collect = item => [item, ...(item.children || []).flatMap(collect)];
  studio.renderInspectorData('gate'); let section = studio.editor.properties.children.at(-1);
  assert.ok(collect(section).some(item => item.tag === 'pre' && item.textContent === '图片横着摆\nDrawIO按之前源文件改为当前板'));
  const picker = section.children.find(item => item.className === 'wf-studio-version-picker').children[1]; picker.value = 'history-0'; picker.listeners.change(); section = studio.editor.properties.children.at(-1);
  assert.ok(collect(section).some(item => item.tag === 'pre' && item.textContent === '旧版审核意见'));
  assert.equal(collect(section).some(item => item.textContent?.includes('DrawIO按之前源文件')), false);
});

test('Skill inspector exposes the revision feedback actually used by its fixed-version run', t => {
  const old = globalThis.document; globalThis.document = { createElement: tag => new FakeElement(tag) }; t.after(() => { if (old) globalThis.document = old; else delete globalThis.document; });
  const { run } = reviewFixture(); run.nodes.render = { status: 'complete', reviewFeedback: 'VO4；去除 MAIN' };
  const studio = Object.create(WorkflowStudioUI.prototype); studio.editor = { properties: new FakeElement('aside') }; studio.runtime = { currentRun: () => run }; studio.renderInspectorData('render');
  const section = studio.editor.properties.children.at(-1); assert.ok(section.children.some(item => item.tag === 'pre' && item.textContent === 'VO4；去除 MAIN'));
});

test('human review displays its current PNG before feedback and actions, with node and attempt identity', t => {
  const old = globalThis.document; globalThis.document = { createElement: tag => new FakeElement(tag) }; t.after(() => { if (old) globalThis.document = old; else delete globalThis.document; });
  const { run } = reviewFixture(), studio = Object.create(WorkflowStudioUI.prototype); const box = studio.reviewControls(run, 'gate'), pictures = box.children.find(item => item.className === 'wf-studio-review-pictures'), feedback = box.children.find(item => item.tag === 'textarea');
  assert.match(box.children[0].textContent, /审核正面 Pinout.*3/); assert.ok(box.children.indexOf(pictures) < box.children.indexOf(feedback)); const figure = pictures.children[0]; assert.equal(figure.children[0].href, '/generated-png'); assert.equal(figure.children[0].children[0].src, '/generated-png'); assert.match(figure.children[1].textContent, /生成正面 Pinout.*2/); assert.equal(box.children.at(-1).children[0].textContent, '通过并继续');
});

test('historical inspector shows that attempt IO, logs, original-size images and downloads while approval remains latest', async t => {
  const oldDocument = globalThis.document; globalThis.document = { createElement: tag => new FakeElement(tag) }; t.after(() => { if (oldDocument) globalThis.document = oldDocument; else delete globalThis.document; });
  const { run, png } = reviewFixture(), historicalImage = { ...png, id: 'old-png', attempt: 1, previewUrl: '/old-png-original-size', downloadUrl: '/old-png-download' };
  run.document.schemaVersion = 2; run.nodes.gate.history = [{ attempt: 1, status: 'complete', input: 'old input', output: 'old output', logs: { stdout: 'old stdout', stderr: 'old stderr' }, artifacts: [historicalImage] }];
  const parent = new FakeElement('aside'), studio = Object.create(WorkflowStudioUI.prototype); let submitted;
  studio.editor = { properties: parent }; studio.runtime = { currentRun: () => run, storeRun() {}, render() {} }; studio.api = async (path, options) => { submitted = { path, body: options.body }; return { run }; };
  studio.renderInspectorData('gate'); const picker = parent.children.at(-1).children.find(item => item.className === 'wf-studio-version-picker').children[1]; picker.value = 'history-0'; picker.listeners.change();
  const section = parent.children.at(-1), descendants = item => [item, ...(item.children || []).flatMap(descendants)], all = descendants(section), messages = all.map(item => item.textContent || '').join('\n');
  assert.match(messages, /历史版本 · 只读/); for (const text of ['old input', 'old output', 'old stdout', 'old stderr']) assert.match(messages, new RegExp(text));
  assert.ok(all.some(item => item.tag === 'a' && item.href === '/old-png-original-size')); assert.ok(all.some(item => item.tag === 'a' && item.href === '/old-png-download' && item.textContent === '下载'));
  const latestReview = section.children.at(-1); assert.equal(latestReview.className, 'wf-studio-review is-compact'); assert.ok(descendants(latestReview).some(item => item.tag === 'img' && item.src === '/generated-png')); assert.equal(descendants(latestReview).some(item => item.tag === 'img' && item.src === '/old-png-original-size'), false);
  await latestReview.children.at(-1).children[0].listeners.click(); assert.deepEqual(submitted, { path: '/api/workflow-runs/run/review', body: { nodeId: 'gate', action: 'approve', feedback: '', expectedAttempt: 3, expectedAttemptId: 'gate-three', expectedArtifactHashes: run.nodes.gate.artifacts.map(item => ({ id: item.id, sha256: item.sha256 })) } }); assert.equal(run.nodes.gate.artifacts[1], png); assert.equal(run.nodes.gate.attempt, 3);
});

test('delegated subflow waits open the actual child review and never approve the parent capability node', async t => {
  const old = globalThis.document; globalThis.document = { createElement: tag => new FakeElement(tag) }; t.after(() => { if (old) globalThis.document = old; else delete globalThis.document; });
  const parent = { id: 'parent', document: { nodes: [{ id: 'subflow', title: '批量出图', type: 'foreach' }] }, nodes: { subflow: { status: 'waiting_review', review: { delegated: true, childRunId: 'child' } } } }, child = reviewFixture().run; child.id = 'child'; child.parentRunId = 'parent';
  const studio = Object.create(WorkflowStudioUI.prototype); let route; studio.api = async path => { route = path; return { run: child }; }; studio.runtime = { storeRun() {} }; studio.renderRuntime = () => {}; studio.editor = { toast(message) { throw new Error(message); } };
  let box = studio.reviewControls(parent, 'subflow'); assert.equal(box.children.filter(item => item.tag === 'button').length, 1); assert.equal(box.children.at(-1).textContent, '查看子流程审核'); assert.equal(box.children.some(item => item.tag === 'textarea'), false); await box.children.at(-1).listeners.click(); assert.equal(route, '/api/workflow-runs/child'); box = studio.reviewControls(parent, 'subflow'); const nested = box.children.at(-1); assert.match(nested.children[0].textContent, /审核正面/); assert.equal(nested.children.at(-1).children[0].textContent, '通过并继续');
});

test('entering run view closes editing panels without changing the editing layout preferences', () => {
  const studio = Object.create(WorkflowStudioUI.prototype); studio.view = 'edit'; studio.viewSwitch = { children: [new FakeElement('button'), new FakeElement('button')] }; studio.editor = { root: { dataset: {} }, settings: { libraryClosed: false, propertiesClosed: false }, applySettings() {} }; studio.runSurface = {}; studio.setTab = () => {}; studio.renderRuntime = () => {}; studio.setView('run');
  assert.deepEqual(studio.panelSettings(), { libraryClosed: true, propertiesClosed: true }); assert.equal(studio.runSurface.hidden, false); assert.deepEqual(studio.editor.settings, { libraryClosed: false, propertiesClosed: false });
  studio.panelSettings().libraryClosed = false; studio.setView('edit'); assert.equal(studio.panelSettings(), studio.editor.settings); studio.setView('run'); assert.equal(studio.panelSettings().libraryClosed, false);
});

test('fixed raw inputs ignore empty browser drafts, preserve explicit overrides and stay isolated between workflows', t => {
  const { studio, descendants } = preflightFixture(t), previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), saved = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else delete globalThis.localStorage; });
  const create = (id, value) => ({ ...createDocument({ schemaVersion: 2 }), id, nodes: [createNode('input', {}, { id: 'requirements', config: { outputType: 'text', defaultValue: value } })] });
  const first = create('fixed-first', '固定任务 A'), second = create('fixed-second', '固定任务 B'); saved.set('workbench.workflow-raw-input.v2:' + first.id, '  ');
  studio.editor.doc = first; studio.syncDocument(); assert.equal(studio.rawPreparationInput.value, '固定任务 A'); assert.equal(studio.runtime.input.value, '固定任务 A');
  assert.ok(descendants(studio.inputs).some(item => /已配置默认输入/.test(item.textContent || '')));
  studio.rawPreparationInput.value = '本次覆盖'; studio.rawPreparationInput.listeners.input(); studio.renderInputs(); assert.equal(studio.rawPreparationInput.value, '本次覆盖');
  first.nodes[0].config.defaultValue = '修改后的固定任务 A'; studio.renderInputs(); assert.equal(studio.rawPreparationInput.value, '本次覆盖');
  studio.editor.doc = second; studio.syncDocument(); assert.equal(studio.rawPreparationInput.value, '固定任务 B');
  studio.editor.doc = first; studio.syncDocument(); assert.equal(studio.rawPreparationInput.value, '本次覆盖');
  studio.rawPreparationInput.value = ''; studio.rawPreparationInput.listeners.input(); studio.renderInputs(); assert.equal(studio.rawPreparationInput.value, '修改后的固定任务 A');
});

test('JSON and falsey fixed defaults appear as valid raw input rather than being dropped', t => {
  const { studio } = preflightFixture(t);
  for (const [outputType, value, expected] of [['object', { query: 'AI', limit: 20 }, '{\n  "query": "AI",\n  "limit": 20\n}'], ['boolean', false, 'false'], ['number', 0, '0']]) {
    const doc = createDocument({ schemaVersion: 2 }); doc.nodes = [createNode('input', {}, { config: { outputType, defaultValue: value } })]; studio.editor.doc = doc; studio.syncDocument(); assert.equal(studio.rawPreparationInput.value, expected); assert.equal(studio.runtime.input.value, expected);
  }
});

test('structured preparation displays per-entry defaults and keeps explicit user overrides', t => {
  const { studio, descendants } = preflightFixture(t), doc = createDocument({ schemaVersion: 2 });
  doc.nodes = ['first', 'second'].map((id, index) => createNode('input', {}, { id, config: { outputType: 'object', fieldName: id,
    defaultValue: { query: index ? 'tools' : 'AI', limit: 20 }, fields: [{ key: 'query', label: '检索条件', kind: 'text' }, { key: 'limit', label: '数量', kind: 'number' }] } }));
  studio.editor.doc = doc; studio.syncDocument();
  const field = (nodeId, key) => descendants(studio.inputs).find(item => item.dataset?.nodeId === nodeId && item.dataset?.inputKey === key);
  assert.equal(field('first', 'query').value, 'AI'); assert.equal(field('second', 'query').value, 'tools');
  studio.values.first = { query: 'my query', limit: 0 }; studio.renderInputs();
  assert.equal(field('first', 'query').value, 'my query'); assert.equal(field('first', 'limit').value, 0);
  doc.nodes[0].config.defaultValue.query = 'changed default'; doc.nodes[1].config.defaultValue.query = 'updated tools'; studio.renderInputs();
  assert.equal(field('first', 'query').value, 'my query'); assert.equal(field('second', 'query').value, 'updated tools');
});

test('preflight, save and run snapshots flush the latest unblurred output-root control', async () => {
  const editor = Object.create(WorkflowEditor.prototype), initial = createDocument({ schemaVersion: 2 }), studio = Object.create(WorkflowStudioUI.prototype); Object.assign(editor, { doc: initial, propertyDrafts: new Map(), cancelGesture() {}, cancelConnection() {}, commit(doc) { this.doc = doc; }, persist() { this.saved = this.doc.settings.outputDirectory; this.savedConcurrency = this.doc.settings.maxConcurrency; return true; }, toast() {} }); studio.editor = editor; editor.studio = studio; studio.outputDirectoryInput = { isConnected: true, value: '/workspace/first-output' }; studio.concurrencyInput = { isConnected: true, value: '7' };
  const snapshot = editor.prepareRun(); assert.equal(snapshot.settings.outputDirectory, '/workspace/first-output'); assert.equal(snapshot.settings.maxConcurrency, 7); assert.equal(initial.settings.outputDirectory, ''); assert.equal(initial.settings.maxConcurrency, 4);
  studio.outputDirectoryInput.value = '/workspace/saved-output'; studio.concurrencyInput.value = '3'; editor.saveDraft(); assert.equal(editor.saved, '/workspace/saved-output'); assert.equal(editor.savedConcurrency, 3);
  studio.outputDirectoryInput.value = '/workspace/checked-output'; studio.check = {}; studio.inputs = new FakeElement('div'); studio.showInputNotice = () => {}; studio.setTab = () => {}; editor.settings = {}; editor.applySettings = () => {}; let checked;
  studio.concurrencyInput.value = '2'; studio.api = async (path, options) => { checked = options.body.document; return { ok: true, input: {} }; }; await studio.preflight({ quiet: true, input: {} }); assert.equal(checked.settings.outputDirectory, '/workspace/checked-output'); assert.equal(checked.settings.maxConcurrency, 2);
});

test('file browser navigates to the typed directory with its button, then chooses the actual returned file', async t => {
  const old = globalThis.document; globalThis.document = { createElement: tag => new FakeElement(tag) }; t.after(() => { if (old) globalThis.document = old; else delete globalThis.document; });
  const directory = '/fixtures/documents/reference-materials', file = directory + '/project.epro2', requests = []; let chosen;
  const studio = Object.create(WorkflowStudioUI.prototype); studio.fileDialog = new FakeElement('dialog'); studio.api = async url => { const query = new URL(url, 'http://localhost').searchParams; requests.push({ directory: query.get('directory'), kind: query.get('kind'), extensions: query.get('extensions') }); return query.get('directory') === directory ? { directory, parent: '/fixtures/documents', roots: [], entries: [{ name: 'project.epro2', path: file, kind: 'file', selectable: true }] } : { directory: '', roots: [{ label: '工作区', path: '/workspace' }], entries: [] }; };
  await studio.pickPath({ kind: 'file', label: '原始 EPRO2 工程', extensions: ['.epro2'] }, '', value => { chosen = value; });
  const [, location, nav, list] = studio.fileDialog.children; location.value = directory;
  await nav.children.find(item => item.textContent === '前往目录').listeners.click();
  assert.equal(requests.at(-1).directory, directory); assert.equal(requests.at(-1).extensions, '.epro2'); assert.equal(location.value, directory); assert.equal(list.children[0].textContent, '□ project.epro2');
  await list.children[0].listeners.click(); assert.equal(chosen, file); assert.equal(studio.fileDialog.open, false);
});

test('file browser folder selection uses the directory reached by the explicit navigation button', async t => {
  const old = globalThis.document; globalThis.document = { createElement: tag => new FakeElement(tag) }; t.after(() => { if (old) globalThis.document = old; else delete globalThis.document; });
  const studio = Object.create(WorkflowStudioUI.prototype); studio.fileDialog = new FakeElement('dialog'); studio.api = async url => { const directory = new URL(url, 'http://localhost').searchParams.get('directory') || ''; return { directory, parent: '/', roots: [], entries: [] }; }; let chosen;
  await studio.pickPath({ kind: 'folder', label: '资料目录' }, '', path => { chosen = path; }); const [, location, nav, , , choose] = studio.fileDialog.children;
  location.value = '/workspace/materials'; await nav.children.find(item => item.textContent === '前往目录').listeners.click(); assert.equal(choose.disabled, false); await choose.listeners.click(); assert.equal(chosen, '/workspace/materials');
});

test('a late directory response cannot replace the newer folder the user navigated to', async t => {
  const old = globalThis.document; globalThis.document = { createElement: tag => new FakeElement(tag) }; t.after(() => { if (old) globalThis.document = old; else delete globalThis.document; });
  const pending = new Map(), studio = Object.create(WorkflowStudioUI.prototype); studio.fileDialog = new FakeElement('dialog'); studio.api = url => { const directory = new URL(url, 'http://localhost').searchParams.get('directory'); return directory ? new Promise(resolve => pending.set(directory, resolve)) : Promise.resolve({ directory: '', roots: [], entries: [] }); };
  await studio.pickPath({ kind: 'folder' }, '', () => {}); const [, location, nav] = studio.fileDialog.children;
  location.value = '/slow'; const first = nav.children.find(item => item.textContent === '前往目录').listeners.click(); location.value = '/new'; const second = nav.children.find(item => item.textContent === '前往目录').listeners.click();
  pending.get('/new')({ directory: '/new', roots: [], entries: [] }); await second; pending.get('/slow')({ directory: '/slow', roots: [], entries: [] }); await first; assert.equal(location.value, '/new');
});

test('foreach and loop are available and their real saved-flow picker embeds an immutable usable snapshot', async t => {
  const previousDocument = globalThis.document, previousOption = globalThis.Option; globalThis.document = { createElement: tag => new FakeElement(tag) }; globalThis.Option = function (text, value) { const option = new FakeElement('option'); option.textContent = text; option.value = value; return option; }; t.after(() => { if (previousDocument) globalThis.document = previousDocument; else delete globalThis.document; if (previousOption) globalThis.Option = previousOption; else delete globalThis.Option; });
  for (const type of ['foreach', 'loop']) {
    const child = createDocument({ schemaVersion: 2, title: '固定处理能力' }); child.nodes = [createNode('input', { x: 0, y: 0 }, { id: 'child-input', config: { outputType: 'object' } }), createNode('tool', { x: 0, y: 0 }, { id: 'child-task', config: { code: 'return input' } }), createNode('output', { x: 0, y: 0 }, { id: 'child-output' })]; child.edges = [{ id: 'child-edge-1', sourceNode: 'child-input', sourcePort: 'out', targetNode: 'child-task', targetPort: 'in' }, { id: 'child-edge-2', sourceNode: 'child-task', sourcePort: 'out', targetNode: 'child-output', targetPort: 'in' }];
    let parent = createDocument({ schemaVersion: 2 }), selected = createNode(type, { x: 300, y: 0 }, { id: 'repeat', config: { maxIterations: 3, ...(type === 'loop' ? { expression: 'input.complete !== true' } : {}) } }); parent.nodes = [createNode('input', { x: 0, y: 0 }, { id: 'source', config: { outputType: type === 'foreach' ? 'array' : 'object' } }), selected, createNode('output', { x: 600, y: 0 }, { id: 'result' })]; parent = connectNodes(parent, { sourceNode: 'source', sourcePort: 'out', targetNode: 'repeat', targetPort: 'in' }); parent = connectNodes(parent, { sourceNode: 'repeat', sourcePort: 'out', targetNode: 'result', targetPort: 'in' });
    const properties = new FakeElement('aside'), studio = Object.create(WorkflowStudioUI.prototype); studio.editor = { doc: parent, properties, commit(doc) { this.doc = doc; }, toast(message) { throw new Error(message); } }; studio.api = async url => url === '/api/workflow-library' ? { workflows: [{ id: child.id, title: child.title }] } : { workflow: { document: child } };
    assert.equal(studio.executable(type), true); studio.renderSubflowPicker(selected); await Promise.resolve();
    const section = properties.children[0], select = section.children[1]; select.value = child.id; await select.listeners.change();
    const configured = studio.editor.doc.nodes.find(node => node.id === 'repeat'); assert.equal(configured.config.workflowRef, child.id); assert.equal(configured.config.document.title, '固定处理能力'); assert.equal(Object.hasOwn(configured.config, 'version'), false); assert.equal(planWorkflow(studio.editor.doc).document.schemaVersion, 2);
    child.title = '原子流程后来改名'; assert.equal(configured.config.document.title, '固定处理能力');
    if (type === 'loop') assert.match(section.children[3].textContent, /false 时停止/);
  }
});

test('named-port editor renders usable labelled controls and applies field mappings and additional ports', t => {
  const old = globalThis.document; globalThis.document = { createElement: tag => new FakeElement(tag) }; t.after(() => { if (old) globalThis.document = old; else delete globalThis.document; });
  const studio = Object.create(WorkflowStudioUI.prototype), parent = new FakeElement('aside'), applied = []; studio.editor = { properties: parent }; studio.applyPorts = (id, ports) => applied.push({ id, ports: structuredClone(ports) });
  studio.renderPortSchema(createNode('merge', { x: 0, y: 0 }, { id: 'join', ports: { inputs: [{ id: 'front', label: '正面', type: 'artifactRef', required: true }], outputs: [{ id: 'pictures', label: '图片', type: 'artifactBundle', valuePath: 'images' }] } }));
  const section = parent.children[0]; assert.equal(section.open, true); const [inputs, outputs] = section.children.filter(item => item.className === 'wf-studio-port-group'), outputRow = outputs.children[1];
  const path = outputRow.children.find(item => item.attributes?.['aria-label'] === '输出 pictures 字段路径'); assert.equal(path.value, 'images'); path.value = 'files.images'; path.listeners.change();
  section.children.at(-1).listeners.click(); assert.equal(applied.at(-1).ports.outputs[0].valuePath, 'files.images');
  inputs.children.at(-1).listeners.click(); assert.equal(studio.editor.propertyDrafts.get('join').ports.inputs.length, 2); assert.equal(studio.editor.propertyDrafts.get('join').ports.inputs[1].required, true);
});

test('port add and type changes collect all unblurred fields instead of discarding the port draft', t => {
  const old = globalThis.document; globalThis.document = { createElement: tag => new FakeElement(tag) }; t.after(() => { if (old) globalThis.document = old; else delete globalThis.document; });
  const node = createNode('merge', { x: 0, y: 0 }, { id: 'join' }), document = createDocument({ schemaVersion: 2 }); document.nodes = [node]; const parent = new FakeElement('aside'), studio = Object.create(WorkflowStudioUI.prototype);
  studio.editor = { doc: document, propertyDrafts: new Map(), properties: parent, renderHeader() {}, toast(message) { throw new Error(message); }, commit(value) { this.doc = value; }, renderProperties() { parent.replaceChildren(); studio.renderPortSchema(this.doc.nodes[0]); } };
  studio.editor.renderProperties(); let section = parent.children[0], inputs = section.children.find(item => item.className === 'wf-studio-port-group'), first = inputs.children[1];
  first.children[1].value = 'front'; first.children[2].value = '正面 Pinout'; inputs.children.at(-1).listeners.click();
  section = parent.children[0]; inputs = section.children.find(item => item.className === 'wf-studio-port-group'); first = inputs.children[1]; const second = inputs.children[2];
  assert.equal(first.children[1].value, 'front'); assert.equal(first.children[2].value, '正面 Pinout'); second.children[1].value = 'back'; second.children[2].value = '背面 Pinout'; second.children[3].value = 'object'; second.children[3].listeners.change(); section.children.at(-1).listeners.click();
  assert.deepEqual(studio.editor.doc.nodes[0].ports.inputs.map(port => [port.id, port.label, port.type]), [['front', '正面 Pinout', 'object'], ['back', '背面 Pinout', 'object']]); assert.equal(studio.editor.propertyDrafts.size, 0);
});

test('late Skill selection merges only the reference into the latest renamed and timed draft after switching nodes', async t => {
  const old = globalThis.document; globalThis.document = { createElement: tag => new FakeElement(tag) }; t.after(() => { if (old) globalThis.document = old; else delete globalThis.document; });
  const skill = createNode('skill', { x: 0, y: 0 }, { id: 'skill' }), document = createDocument({ schemaVersion: 2 }); document.nodes = [skill]; const runtime = Object.create(WorkflowRuntimeUI.prototype); let resolveRead;
  Object.assign(runtime, { editor: { doc: document, propertyDrafts: new Map(), renderHeader() {} }, pickers: new Set(), skillPending: new Set(), skills: { connected: true, skills: [{ name: 'learned-pinout', displayName: 'Pinout 标签与排版规划' }] }, loadSkills() { return Promise.resolve(this.skills); }, getBackend: () => ({ state: 'ready' }), updateRunButton() {}, api: () => new Promise(resolve => { resolveRead = resolve; }) });
  const form = new FakeElement('form'); runtime.mountSkillPicker(form, skill); await Promise.resolve(); const wrapper = form.children[0], select = wrapper.children[4]; select.value = 'learned-pinout'; select.listeners.change(); assert.equal(runtime.isSkillSelectionPending('skill'), true);
  runtime.editor.propertyDrafts.set('skill', { title: 'Pinout 排版规划', config: { ...skill.config, skillRef: 'learned-pinout', version: '', timeoutSeconds: 300 } }); wrapper.isConnected = false;
  resolveRead({ name: 'learned-pinout', revision: `sha256:${'a'.repeat(64)}`, displayName: 'Pinout 标签与排版规划' }); await new Promise(resolve => setImmediate(resolve));
  const draft = runtime.editor.propertyDrafts.get('skill'); assert.equal(draft.title, 'Pinout 排版规划'); assert.equal(draft.config.timeoutSeconds, 300); assert.equal(draft.config.skillRef, 'learned-pinout'); assert.equal(draft.config.version, `sha256:${'a'.repeat(64)}`); assert.equal(runtime.isSkillSelectionPending('skill'), false); assert.equal(document.nodes[0].config.skillRef, '');
});

test('pending Skill reads disable applying and cannot overwrite a different workflow', () => {
  const apply = {}, form = { dataset: { node: 'skill' }, querySelector: () => apply }, editor = Object.create(WorkflowEditor.prototype); editor.properties = { querySelector: () => form }; editor.runtime = { isSkillSelectionPending: () => true }; editor.refreshPropertyReadiness(); assert.equal(apply.disabled, true); assert.match(apply.textContent, /读取/);
  editor.runtime.isSkillSelectionPending = () => false; editor.refreshPropertyReadiness(); assert.equal(apply.disabled, false);
  editor.doc = { id: 'new-workflow', nodes: [] }; editor.propertyDrafts = new Map(); assert.equal(mergeSkillSelectionDraft(editor, 'old-workflow', 'skill', 'old-ref', `sha256:${'b'.repeat(64)}`), false); assert.equal(editor.propertyDrafts.size, 0);
});

test('mandatory image tools expose a checked disabled review control and merge summaries contain no undefined text', t => {
  const old = globalThis.document; globalThis.document = { createElement: tag => new FakeElement(tag) }; t.after(() => { if (old) globalThis.document = old; else delete globalThis.document; });
  const metadata = WORKFLOW_TOOLS.find(tool => tool.reviewRequired); assert.ok(metadata); const parent = new FakeElement('aside'), studio = Object.create(WorkflowStudioUI.prototype); studio.editor = { properties: parent }; studio.renderCapabilityConfig(createNode('tool', { x: 0, y: 0 }, { config: { executionMode: 'tool', toolName: metadata.id, reviewImages: false } })); const label = parent.children[0].children[1], checkbox = label.children[0]; assert.equal(checkbox.checked, true); assert.equal(checkbox.disabled, true);
  const summary = WorkflowEditor.prototype.summary(createNode('merge')); assert.match(summary, /汇总/); assert.doesNotMatch(summary, /undefined/);
});
test('human review requires revise feedback and sends approve/revise/stop through the actual review route', async t => {
  const old = globalThis.document; globalThis.document = { createElement: tag => new FakeElement(tag) }; t.after(() => { if (old) globalThis.document = old; else delete globalThis.document; });
  const run = revisionReviewFixture(); run.id = 'run-1'; const calls = [], messages = []; const studio = Object.create(WorkflowStudioUI.prototype); studio.editor = { toast: message => messages.push(message) }; studio.runtime = { storeRun() {}, render() {} }; studio.api = async (path, options) => { calls.push({ path, body: options.body }); return { run }; };
  let controls = studio.reviewControls(run, 'gate'), actions = controls.children.at(-1).children; await actions[1].listeners.click(); assert.equal(calls.length, 0); assert.match(messages.at(-1), /填写/);
  const feedback = controls.children.find(item => item.tag === 'textarea'); feedback.value = '标签请加大'; feedback.dispatchEvent({ type: 'input' }); await actions[1].listeners.click(); assert.deepEqual(calls.at(-1), { path: '/api/workflow-runs/run-1/review', body: { nodeId: 'gate', action: 'revise', feedback: '标签请加大', expectedAttempt: 1, expectedAttemptId: 'gate-1', expectedArtifactHashes: run.nodes.gate.review.artifactHashes } });
  for (const [index, action] of [[0, 'approve'], [2, 'stop']]) { controls = studio.reviewControls(run, 'gate'); await controls.children.at(-1).children[index].listeners.click(); assert.equal(calls.at(-1).body.action, action); }
});

function revisionReviewFixture({ used = 0, code = false } = {}) {
  const artifact = { id: 'poster', nodeId: 'render', attempt: used + 1, sha256: 'a'.repeat(64), mimeType: 'image/png' };
  return { id: 'review-run', status: 'waiting_review', workflowId: 'workflow', document: { id: 'workflow', schemaVersion: 2, nodes: [
    { id: 'render', type: code ? 'tool' : 'skill', title: '生成海报', config: { executionMode: code ? 'code' : 'skill', language: 'python', code: 'return input' } },
    { id: 'gate', type: 'human', title: '审核海报', config: { reviewTargetNodeId: 'render', maxRevisions: 3 } },
  ], edges: [{ sourceNode: 'render', targetNode: 'gate' }] }, nodes: {
    render: { status: 'complete', attempt: used + 1, attemptId: `render-${used + 1}`, artifacts: [artifact] },
    gate: { status: 'waiting_review', attempt: used + 1, attemptId: `gate-${used + 1}`, artifacts: [artifact], review: { revisionCount: used, artifactHashes: [{ id: artifact.id, sha256: artifact.sha256 }] } },
  } };
}

test('review counts stay visible and Skill revisions remain available beyond the old limit after pending releases', t => {
  const previous = globalThis.document; globalThis.document = { createElement: tag => new FakeElement(tag) }; t.after(() => { if (previous) globalThis.document = previous; else delete globalThis.document; });
  const run = revisionReviewFixture({ used: 6 }), studio = Object.create(WorkflowStudioUI.prototype); studio.editor = {};
  const box = studio.reviewControls(run, 'gate'), actions = box.children.at(-1).children;
  assert.ok(box.children.some(item => item.textContent === '已修改 6 次')); assert.equal(box.children.some(item => /剩余|修改.*上限|6\s*\//.test(item.textContent || '')), false);
  assert.equal(actions[1].disabled, false); assert.equal(actions[0].disabled, false); assert.equal(actions[2].disabled, false);
  studio.setReviewPending(`${run.id}:gate`, true); studio.setReviewPending(`${run.id}:gate`, false);
  assert.equal(actions[1].disabled, false); assert.equal(actions[0].disabled, false); assert.equal(actions[2].disabled, false);
});

test('fixed code review requests a full-feedback candidate once and locks repeat clicks instead of posting review', async t => {
  const previous = globalThis.document; globalThis.document = { createElement: tag => new FakeElement(tag) }; t.after(() => { if (previous) globalThis.document = previous; else delete globalThis.document; });
  const run = revisionReviewFixture({ used: 6, code: true }), studio = Object.create(WorkflowStudioUI.prototype), handoffs = [], requests = [];
  let release; const pending = new Promise(resolve => { release = resolve; }); studio.editor = { conversation: { requestArtifactRevision: value => { handoffs.push(value); return pending; }, focusContext() {} } }; studio.api = async (...args) => requests.push(args);
  const box = studio.reviewControls(run, 'gate'), feedback = box.children.find(item => item.tag === 'textarea');
  feedback.value = '横向排列\n保留全部项目；字号放大'; feedback.dispatchEvent({ type: 'input' });
  assert.deepEqual(box.children.at(-1).children.map(item => item.textContent), ['通过并继续', '停止本次运行', '生成修改候选']);
  const candidate = box.children.at(-1).children.find(item => item.textContent === '生成修改候选'); assert.ok(candidate);
  const sending = candidate.listeners.click(); assert.equal(candidate.disabled, true); await candidate.listeners.click(); assert.equal(requests.length, 0); assert.equal(handoffs.length, 1); release(); await sending;
  assert.equal(candidate.disabled, false); assert.equal(box.children.at(-1).children.find(item => item.textContent === '通过并继续').disabled, false); assert.equal(box.children.at(-1).children.find(item => item.textContent === '停止本次运行').disabled, false);
  assert.equal(handoffs[0].run, run); assert.equal(handoffs[0].humanNodeId, 'gate'); assert.equal(handoffs[0].feedback, feedback.value);
});

test('review requests bind the displayed attempt and hashes while errors persist on the card', async t => {
  const previous = globalThis.document; globalThis.document = { createElement: tag => new FakeElement(tag) }; t.after(() => { if (previous) globalThis.document = previous; else delete globalThis.document; });
  const run = revisionReviewFixture(), studio = Object.create(WorkflowStudioUI.prototype); let body;
  studio.editor = { toast() {} }; studio.api = async (_path, options) => { body = options.body; throw new Error('版本已变化，请刷新'); };
  let box = studio.reviewControls(run, 'gate'); await box.children.at(-1).children[0].listeners.click();
  assert.deepEqual({ expectedAttempt: body.expectedAttempt, expectedAttemptId: body.expectedAttemptId, expectedArtifactHashes: body.expectedArtifactHashes }, { expectedAttempt: 1, expectedAttemptId: 'gate-1', expectedArtifactHashes: run.nodes.gate.review.artifactHashes });
  box = studio.reviewControls(run, 'gate'); assert.ok(box.children.some(item => item.attributes.role === 'alert' && /版本已变化/.test(item.textContent || '')));
});
