import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WorkflowStudioUI, reviewFileGroups, runProgress } from '../public/workflow-studio-ui.js';

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.attributes = {}; this.value = ''; this.isConnected = true; this.dataset = {}; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
}
const all = node => [node, ...(node.children || []).flatMap(all)];
const artifact = (id, producer, name, mimeType = 'application/octet-stream') => ({ id, runId: 'run', nodeId: producer, name, mimeType,
  sha256: id.padEnd(64, 'a'), attempt: 3, previewUrl: '/preview/' + id, downloadUrl: '/download/' + id });
function fixture(t) {
  const previous = globalThis.document; globalThis.document = { createElement: tag => new Element(tag), activeElement: null };
  t.after(() => { if (previous) globalThis.document = previous; else delete globalThis.document; });
  const picture = artifact('picture', 'sop', 'wiring.png', 'image/png'), workbook = artifact('workbook', 'sop', 'process.xlsx'),
    pdf = artifact('pdf', 'sop', 'print.pdf', 'application/pdf'), sop = artifact('sop', 'sop', '操作说明.md', 'text/plain'),
    index = artifact('index', 'sop', '源文件索引.md', 'text/plain'), old = artifact('old-build', 'build', 'old-build.bin');
  const run = { id: 'run', status: 'waiting_review', document: { mode: 'execute', nodes: [
    { id: 'build', type: 'tool', title: '上游资料' }, { id: 'sop', type: 'skill', title: '本次文档', config: {} },
    { id: 'gate', type: 'human', title: '审核文档', config: { prompt: '查看原件后决定', reviewTargetNodeId: 'sop' } },
    { id: 'other-gate', type: 'human', title: '其它审核', config: {} }], edges: [{ sourceNode: 'sop', targetNode: 'gate' }] },
    nodes: { sop: { status: 'complete', attempt: 3, artifacts: [picture, workbook, pdf, sop, index] }, gate: { status: 'waiting_review', attempt: 2, input: { userData: true },
      artifacts: [picture, workbook, pdf, sop, index, old], review: {} }, 'other-gate': { status: 'waiting_review', review: {} } } };
  const calls = [], messages = [], studio = Object.create(WorkflowStudioUI.prototype);
  studio.editor = { toast: message => messages.push(message) }; studio.runtime = { storeRun() {}, render() {} };
  studio.api = async (path, options) => { calls.push({ path, body: options.body }); return { run }; };
  return { run, studio, calls, messages, picture, workbook, pdf, sop, index, old };
}

test('pending review separates direct current originals from inherited files and excludes displayed pictures', t => {
  const { run, picture, workbook, pdf, sop, index, old } = fixture(t), before = JSON.stringify(run);
  const groups = reviewFileGroups(run, 'gate', [picture]);
  assert.equal(groups.exact, false); assert.deepEqual(groups.current, [workbook, pdf, sop, index]); assert.deepEqual(groups.references, [old]);
  run.nodes.gate.input = { nodeId: 'build', runId: 'run' }; assert.deepEqual(reviewFileGroups(run, 'gate', [picture]).current, [workbook, pdf, sop, index]);
  run.nodes.gate.input = { userData: true }; assert.equal(JSON.stringify(run), before);
});

test('recorded approval files require both exact artifact ID and SHA, never basename or upstream inference', t => {
  const { run, picture, workbook, pdf, sop, index, old } = fixture(t);
  run.nodes.gate.review.artifactHashes = [{ id: workbook.id, sha256: workbook.sha256 }, { id: pdf.id, sha256: 'changed' }];
  const groups = reviewFileGroups(run, 'gate', [picture]);
  assert.equal(groups.exact, true); assert.deepEqual(groups.current, [workbook]); assert.deepEqual(groups.references, [pdf, sop, index, old]);
});

test('review shows original XLSX PDF SOP and source index links after preview with actual producer and attempt', t => {
  const { run, studio, picture, workbook, pdf, sop, index, old } = fixture(t), box = studio.reviewControls(run, 'gate'), nodes = all(box);
  const pictures = box.children.find(item => item.className === 'wf-studio-review-pictures'), groups = box.children.filter(item => item.className === 'wf-studio-review-files');
  assert.equal(groups.length, 2); assert.ok(box.children.indexOf(pictures) < box.children.indexOf(groups[0]));
  assert.match(groups[0].children[0].textContent, /当前审核输入文件.*待决定.*4/); assert.match(groups[1].children[0].textContent, /上游参考文件.*1/);
  for (const item of [workbook, pdf, sop, index]) assert.ok(all(groups[0]).some(node => node.tag === 'a' && node.href === item.downloadUrl), item.name);
  assert.equal(all(groups[0]).some(node => node.href === old.downloadUrl), false);
  assert.equal(nodes.filter(node => node.tag === 'img' && node.src === picture.previewUrl).length, 1);
  assert.ok(all(groups[0]).some(node => node.textContent?.includes('本次文档 · 第 3 次尝试')));
});

test('overview and inspector share latest draft and submit that value from either action group', async t => {
  const { run, studio, calls } = fixture(t), main = studio.reviewControls(run, 'gate'), compact = studio.reviewControls(run, 'gate', { compact: true }), other = studio.reviewControls(run, 'other-gate');
  const field = box => box.children.find(node => node.tag === 'textarea'), edit = (box, value) => { field(box).value = value; field(box).listeners.input(); };
  edit(main, '先看原始XLSX'); assert.equal(field(compact).value, '先看原始XLSX');
  edit(compact, '最新意见：对照源文件调整文档'); assert.equal(field(main).value, field(compact).value); assert.equal(field(other).value, '');
  // Even a stale DOM value must not replace the latest shared input draft.
  field(main).value = 'stale DOM value';
  await main.children.at(-1).children[1].listeners.click();
  assert.equal(calls.length, 1); assert.equal(calls[0].body.feedback, '最新意见：对照源文件调整文档'); assert.equal(calls[0].body.action, 'revise');
});

test('review pending state disables both copies and prevents duplicate submissions, then restores after error', async t => {
  const { run, studio, calls, messages } = fixture(t), main = studio.reviewControls(run, 'gate'), compact = studio.reviewControls(run, 'gate', { compact: true });
  let reject; studio.api = (path, options) => { calls.push({ path, body: options.body }); return new Promise((_, fail) => { reject = fail; }); };
  const mainActions = main.children.at(-1).children, compactActions = compact.children.at(-1).children;
  const pending = mainActions[0].listeners.click();
  assert.ok([...mainActions, ...compactActions].every(item => item.disabled));
  await compactActions[0].listeners.click(); assert.equal(calls.length, 1);
  reject(new Error('模拟保存失败')); await pending;
  assert.ok([...mainActions, ...compactActions].every(item => !item.disabled)); assert.match(messages[0], /保存失败/);
});

test('execution progress excludes learning only and never counts failures or blocked nodes as completed', () => {
  const nodes = Array.from({ length: 25 }, (_, index) => ({ id: 'n' + index, type: index === 23 ? 'evaluation' : index === 24 ? 'improvement' : 'tool' }));
  const run = { document: { mode: 'execute', nodes }, nodes: Object.fromEntries(nodes.map((node, index) => [node.id, { status: index < 18 ? 'complete' : index < 21 ? 'waiting_review' : index < 23 ? 'pending' : 'skipped' }])) };
  assert.deepEqual(runProgress(run), { completed: 18, total: 23, running: 0, skippedLearning: 2 });
  run.nodes.n18.status = 'error'; run.nodes.n19.status = 'blocked'; assert.equal(runProgress(run).completed, 18);
  for (const node of nodes.slice(0, 23)) run.nodes[node.id].status = 'complete';
  assert.deepEqual(runProgress(run), { completed: 23, total: 23, running: 0, skippedLearning: 2 });
  run.document.mode = 'learn'; assert.equal(runProgress(run).total, 25); assert.equal(runProgress(run).skippedLearning, 0);
});

test('run overview uses business progress while preserving all 25 step inspection controls', t => {
  const { studio } = fixture(t), definitions = Array.from({ length: 25 }, (_, index) => ({ id: 'n' + index, type: index < 23 ? 'tool' : 'evaluation', title: '节点 ' + index }));
  const run = { id: 'run', status: 'complete', document: { mode: 'execute', nodes: definitions }, nodes: Object.fromEntries(definitions.map((node, index) => [node.id, { status: index < 23 ? 'complete' : 'skipped' }])) };
  studio.runtime.currentRun = () => run; studio.runSurface = new Element('section'); studio.editor.selection = new Set(); studio.editor.settings = { propertiesClosed: true }; studio.renderGraph = () => {};
  studio.renderRuntime(); const nodes = all(studio.runSurface), progress = nodes.find(node => node.tag === 'progress'), steps = nodes.find(node => node.className === 'wf-studio-run-steps');
  assert.equal(progress.max, 23); assert.equal(progress.value, 23); assert.equal(steps.children.length, 25);
  assert.ok(nodes.some(node => node.textContent?.includes('23 / 23 业务节点完成') && node.textContent.includes('2 个学习节点已跳过')));
});

test('desktop grid and narrow property drawer breakpoints do not overlap at 1000–1050px', () => {
  const studio = readFileSync(new URL('../public/workflow-studio-ui.css', import.meta.url), 'utf8'), editor = readFileSync(new URL('../public/workflow-editor.css', import.meta.url), 'utf8');
  const gridMinimums = [...studio.matchAll(/@media\s*\(min-width:\s*(\d+)px\)\s*\{[^@]*?grid-template-columns/g)].map(match => Number(match[1]));
  assert.deepEqual(gridMinimums, [1051]); assert.match(editor, /@media\s*\(max-width:\s*1050px\)[\s\S]*?\.wf-properties\s*\{\s*position:\s*absolute/);
  for (const width of [999, 1000, 1024, 1050, 1051]) assert.equal(width >= gridMinimums[0] && width <= 1050, false, `No reserved grid plus overlaid drawer at ${width}px`);
});


test('pending review never treats another run or a stale producer attempt as its current input', t => {
  const { run, workbook, pdf } = fixture(t);
  workbook.runId = 'other-run'; pdf.attempt = 2;
  const groups = reviewFileGroups(run, 'gate');
  assert.equal(groups.current.includes(workbook), false); assert.equal(groups.current.includes(pdf), false);
  assert.ok(groups.references.includes(workbook)); assert.ok(groups.references.includes(pdf));
  // Forged business data cannot name a producer from another graph branch.
  run.nodes.gate.input = { nodeId: 'build', runId: 'run', kind: 'custom-receipt' };
  assert.equal(reviewFileGroups(run, 'gate').current.some(item => item.nodeId === 'build'), false);
});

test('pending review follows registered files through a code step that only passes values through', t => {
  const { run, workbook } = fixture(t);
  run.document.nodes.push({ id: 'normalize', type: 'tool', config: { executionMode: 'code' } });
  run.document.edges = [{ sourceNode: 'sop', targetNode: 'normalize' }, { sourceNode: 'normalize', targetNode: 'gate' }];
  run.nodes.normalize = { status: 'complete', attempt: 1, artifacts: [] };
  assert.ok(reviewFileGroups(run, 'gate').current.includes(workbook));
});
