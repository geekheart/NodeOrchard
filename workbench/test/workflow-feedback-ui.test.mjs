import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowFeedbackUI, feedbackComment, validateFeedbackComment, feedbackRunReason } from '../public/workflow-feedback-ui.js';

class FakeElement {
  constructor(tagName) { this.tagName = tagName; this.children = []; this.dataset = {}; this.attributes = {}; this.textContent = ''; this.value = ''; this.disabled = false; this.hidden = false; this.listeners = new Map(); this.classList = { toggle() {} }; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = [...items]; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  input(value) { this.value = value; this.listeners.get('input')?.(); }
}
const terminalRun = (id = 'run-a', overrides = {}) => ({ id, workflowId: 'workflow-a', status: 'complete', document: { mode: 'execute' }, ...overrides });
const targets = [
  { nodeId: 'export', title: '导出与命名', skillRef: 'export-skill', version: 'sha256:a', status: 'complete' },
  { nodeId: 'process', title: '工艺要求', skillRef: 'process-skill', version: 'sha256:b', status: 'complete' },
  { nodeId: 'firmware', title: '测试固件', skillRef: 'firmware-skill', version: 'sha256:c', status: 'complete' },
  { nodeId: 'sop', title: '测试说明', skillRef: 'sop-skill', version: 'sha256:d', status: 'complete' },
];
const response = (feedback = null, overrides = {}) => ({ feedback, targets: structuredClone(targets), canReview: true, reason: '', ...overrides });
const record = (runId = 'run-a', revision = 1, comment = '') => ({ schemaVersion: 2, runId, revision, comment, targets: structuredClone(targets) });
function setup(t, api = async () => response(), run = terminalRun()) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: tag => new FakeElement(tag) } });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'document', descriptor); else delete globalThis.document; });
  const runtime = { api, currentRun: () => run }, host = new FakeElement('div');
  const ui = new WorkflowFeedbackUI(runtime, host); return { ui, runtime };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function open(ui, run = terminalRun()) { ui.render(run); await tick(); }
const elements = root => [root, ...root.children.flatMap(elements)];

test('one comprehensive comment accepts 8000 characters, requires concrete text for learning, and reads old prose without scores', () => {
  assert.equal(validateFeedbackComment(''), ''); assert.equal(validateFeedbackComment('x'.repeat(8000)).length, 8000);
  assert.throws(() => validateFeedbackComment('x'.repeat(8001)), /8000/); assert.throws(() => validateFeedbackComment(' \n ', { learn: true }), /具体问题和期望/);
  assert.equal(feedbackComment({ comment: '', items: [{ comment: 'legacy ignored' }] }), '');
  assert.equal(feedbackComment({ items: [{ nodeId: 'export', score: 0, selectedForLearning: true, comment: '日期错误' }, { nodeId: 'sop', score: 100, comment: ' ' }, { nodeId: 'process', title: '工艺要求', score: 87, comment: '补充板厚' }] }, targets), '导出与命名：日期错误\n\n工艺要求：补充板厚');
});

test('only terminal ordinary runs and completed versioned targets are eligible for feedback learning', async t => {
  for (const status of ['complete', 'error', 'interrupted', 'unknown']) assert.equal(feedbackRunReason(terminalRun('a', { status })), '');
  assert.match(feedbackRunReason(terminalRun('a', { status: 'running' })), /尚未结束/);
  assert.match(feedbackRunReason(terminalRun('a', { document: { mode: 'learn' } })), /学习运行/);
  const { ui } = setup(t, async () => response(null, { targets: [{ ...targets[0], status: 'skipped' }, { ...targets[1], version: '' }, targets[2]] })); await open(ui);
  assert.deepEqual(ui.eligibleTargets(ui.currentState()).map(item => item.nodeId), ['firmware']); assert.equal(ui.targetsHint.textContent, '本次已完成的 Skill：测试固件');
});

test('form has exactly one empty textarea and no score, category fields or checkboxes', async t => {
  const { ui } = setup(t); await open(ui); const all = elements(ui.panel);
  assert.equal(all.filter(item => item.tagName === 'textarea').length, 1); assert.equal(all.filter(item => item.tagName === 'input').length, 0);
  assert.equal(ui.comment.value, ''); assert.equal(ui.comment.maxLength, 8000); assert.equal(ui.saveButton.textContent, '保存反馈'); assert.equal(ui.saveButton.disabled, false);
  for (const target of targets) assert.match(ui.targetsHint.textContent, new RegExp(target.title));
  assert.equal(all.map(item => item.textContent).join(' ').includes('评分'), false);
});

test('switching runs keeps separate unsaved comprehensive drafts and refresh does not overwrite them', async t => {
  const { ui } = setup(t, async path => response(record(path.includes('run-b') ? 'run-b' : 'run-a', 1)));
  await open(ui); ui.comment.input('A 的真实问题'); await open(ui, terminalRun('run-b')); assert.equal(ui.comment.value, ''); ui.comment.input('B 的问题');
  await open(ui); assert.equal(ui.comment.value, 'A 的真实问题'); await ui.load('run-a', true); assert.equal(ui.comment.value, 'A 的真实问题'); assert.equal(ui.currentState().dirty, true);
  await open(ui, terminalRun('run-b')); assert.equal(ui.comment.value, 'B 的问题');
});

test('a late response updates its own run and cannot paint the next run', async t => {
  let resolveA;
  const { ui } = setup(t, path => path.includes('run-a') ? new Promise(resolve => { resolveA = resolve; }) : Promise.resolve(response(record('run-b', 2, 'B'))));
  ui.render(terminalRun()); await open(ui, terminalRun('run-b')); resolveA(response(record('run-a', 1, 'A'))); await tick();
  assert.equal(ui.currentState().runId, 'run-b'); assert.equal(ui.comment.value, 'B'); await open(ui); assert.equal(ui.comment.value, 'A');
});

test('refresh preserves the focused textarea and requires explicit conflict reconciliation', async t => {
  let revision = 1;
  const { ui } = setup(t, async () => response(record('run-a', revision, '服务器意见')));
  await open(ui); const input = ui.comment; input.input('我的新草稿'); revision = 2; await ui.load('run-a', true);
  assert.equal(ui.comment, input); assert.equal(input.value, '我的新草稿'); assert.equal(ui.currentState().revision, 1); assert.equal(ui.currentState().conflict, true); assert.equal(ui.saveButton.disabled, true); assert.equal(ui.serverFeedback.textContent, '服务器意见');
  ui.rebase(); assert.equal(ui.currentState().revision, 2); assert.equal(ui.currentState().dirty, true); assert.equal(input.value, '我的新草稿'); assert.equal(ui.saveButton.disabled, false);
});

test('save plus learning uses only expectedRevision and comment, then saved revision, with double-submit protection', async t => {
  const calls = [], jobs = []; let resolveSave;
  const { ui, runtime } = setup(t, async (path, options) => {
    if (!options) return response(record('run-a', 2)); calls.push({ path, body: structuredClone(options.body) });
    if (path.endsWith('/feedback/learn')) return { id: 'learning-a', kind: 'feedback' };
    return new Promise(resolve => { resolveSave = () => resolve({ feedback: record('run-a', 3, options.body.comment) }); });
  }); runtime.onFeedbackLearning = async job => jobs.push(job);
  await open(ui); ui.comment.input('USB 检查需增加失败原因，测试说明增加接线照片');
  const first = ui.submit(true); await ui.submit(true); assert.equal(calls.length, 1); assert.equal(ui.comment.disabled, true); resolveSave(); await first;
  assert.equal(calls.length, 2); assert.deepEqual(calls[0].body, { expectedRevision: 2, comment: 'USB 检查需增加失败原因，测试说明增加接线照片' });
  assert.deepEqual(calls[1].body, { feedbackRevision: 3 }); assert.equal(jobs[0].id, 'learning-a'); assert.equal(ui.currentState().dirty, false); assert.match(ui.notice.textContent, /已启动/);
});

test('save failures retain editable comprehensive drafts and manual retry preserves the exact text', async t => {
  let fail = true, posts = 0;
  const { ui } = setup(t, async (_path, options) => { if (!options) return response(); posts++; if (fail) throw new Error('网络中断'); return { feedback: record('run-a', 1, options.body.comment) }; });
  await open(ui); ui.comment.input('接线步骤缺少照片\n请补充 USB 排查'); await ui.submit();
  assert.equal(ui.currentState().dirty, true); assert.equal(ui.comment.value, '接线步骤缺少照片\n请补充 USB 排查'); assert.equal(ui.saveButton.disabled, false); assert.match(ui.notice.textContent, /网络中断/);
  fail = false; await ui.submit(); assert.equal(posts, 2); assert.equal(ui.currentState().dirty, false); assert.equal(ui.currentState().feedback.comment, '接线步骤缺少照片\n请补充 USB 排查');
});

test('CAS rejection keeps the draft and blocks writes until latest revision is read and accepted', async t => {
  let latest = 1, posts = 0;
  const { ui } = setup(t, async (_path, options) => { if (!options) return response(record('run-a', latest)); posts++; const error = new Error('反馈已更新'); error.httpStatus = 409; throw error; });
  await open(ui); ui.comment.input('保留这条'); await ui.submit(); await ui.submit(); assert.equal(posts, 1); assert.equal(ui.currentState().conflict, true); assert.match(ui.notice.textContent, /版本发生冲突/); assert.equal(ui.rebaseButton.disabled, true);
  latest = 2; await ui.load('run-a', true); ui.rebase(); assert.equal(ui.currentState().revision, 2); assert.equal(ui.comment.value, '保留这条');
});

test('learning requires a nonempty comprehensive comment and has no per-category selection step', async t => {
  let posts = 0;
  const { ui } = setup(t, async (_path, options) => { if (options) posts++; return response(); }); await open(ui);
  ui.comment.input('   '); await ui.submit(true); assert.equal(posts, 0); assert.match(ui.notice.textContent, /具体问题和期望/);
  ui.comment.input('x'.repeat(8001)); await ui.submit(); assert.equal(posts, 0); assert.match(ui.notice.textContent, /8000/);
});

test('unreviewable history and active or learning runs do not offer feedback learning', async t => {
  let gets = 0;
  const { ui } = setup(t, async () => { gets++; return response(null, { targets: [], canReview: false, reason: '旧运行缺少 Skill 内容快照。' }); });
  await open(ui); assert.equal(ui.saveButton.disabled, true); assert.match(ui.notice.textContent, /缺少 Skill/);
  await open(ui, terminalRun('running', { status: 'running' })); assert.equal(gets, 1); assert.equal(ui.saveButton.disabled, true); assert.match(ui.notice.textContent, /尚未结束/);
  await open(ui, terminalRun('learning', { document: { mode: 'learn' } })); assert.equal(gets, 1); assert.equal(ui.learnButton.disabled, true);
});

test('failed initial reads wait for an explicit retry rather than retrying on each runtime render', async t => {
  let gets = 0, fail = true;
  const { ui } = setup(t, async () => { gets++; if (fail) throw new Error('离线'); return response(); }); await open(ui);
  assert.match(ui.notice.textContent, /读取失败/); assert.equal(ui.refreshButton.disabled, false); ui.render(terminalRun()); ui.render(terminalRun()); await tick(); assert.equal(gets, 1);
  fail = false; await ui.load('run-a', true); assert.equal(gets, 2); assert.equal(ui.saveButton.disabled, false);
});

test('a save response after switching runs never reuses old feedback for the next run', async t => {
  let resolve, learnedRun;
  const { ui } = setup(t, async (path, options) => {
    if (!options) return response(); if (path.endsWith('/learn')) { learnedRun = path; return { id: 'learning-a', kind: 'feedback' }; }
    return new Promise(done => { resolve = () => done({ feedback: record('run-a', 1, options.body.comment) }); });
  });
  await open(ui); ui.comment.input('A 问题'); const saving = ui.submit(true); await open(ui, terminalRun('run-b')); ui.comment.input('B 问题'); resolve(); await saving;
  assert.equal(learnedRun, '/api/workflow-runs/run-a/feedback/learn'); assert.equal(ui.currentState().runId, 'run-b'); assert.equal(ui.comment.value, 'B 问题'); assert.equal(ui.currentState().feedback, null);
});

test('opening feedback scrolls to panel start and focuses its heading without submitting or editing', async t => {
  let posts = 0; const { ui, runtime } = setup(t, async (_path, options) => { if (options) posts++; return response(); }); runtime.feedbackButton = new FakeElement('button');
  await open(ui); ui.comment.input('未保存的真实反馈'); const calls = []; ui.panel.scrollIntoView = options => calls.push(['scroll', options]); ui.heading.focus = options => calls.push(['focus', options]);
  assert.equal(runtime.feedbackButton.disabled, false); ui.open(); assert.deepEqual(calls, [['scroll', { block: 'start', behavior: 'smooth' }], ['focus', { preventScroll: true }]]); assert.equal(posts, 0); assert.equal(ui.comment.value, '未保存的真实反馈');
  await open(ui, terminalRun('active', { status: 'running' })); assert.equal(runtime.feedbackButton.disabled, true); ui.open(); assert.equal(calls.length, 2);
});

test('legacy comments are readable in one field and over-limit legacy content is retained until explicitly shortened', async t => {
  const legacy = { runId: 'run-a', revision: 1, items: [{ nodeId: 'export', title: '导出与命名', score: 0, comment: 'a'.repeat(4000) }, { nodeId: 'process', title: '工艺要求', score: 100, comment: 'b'.repeat(4000) }] };
  const { ui } = setup(t, async () => response(legacy)); await open(ui);
  assert.equal(ui.comment.value, feedbackComment(legacy, targets)); assert.ok(ui.comment.value.length > 8000); assert.match(ui.lengthHint.textContent, /旧反馈内容超过新上限/);
  await ui.submit(); assert.match(ui.notice.textContent, /请精简后再保存/); assert.equal(ui.currentState().feedback, legacy);
});
