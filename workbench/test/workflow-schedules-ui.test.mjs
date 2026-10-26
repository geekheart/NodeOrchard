import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowSchedulesUI, parseScheduleInput, scheduleTriggerView, scheduleOnceEnded } from '../public/workflow-schedules-ui.js';
import { createDocument, createNode, connectNodes } from '../shared/workflow/workflow-model.mjs';

class FakeElement {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.listeners = new Map(); this.attributes = {}; this.dataset = {}; this.value = ''; this.type = ''; this.textContent = ''; this.hidden = false; this.disabled = false; this.checked = false; this.open = false;
    const classes = new Set(); this.classList = { toggle(name, force) { if (force ?? !classes.has(name)) classes.add(name); else classes.delete(name); }, contains: name => classes.has(name) };
  }
  append(...items) { for (const item of items) { item.remove?.(); item.parentElement = this; this.children.push(item); } }
  replaceChildren(...items) { if (this.contains(globalThis.document?.activeElement)) globalThis.document.activeElement = null; for (const item of this.children) item.parentElement = null; this.children = []; this.append(...items); }
  contains(item) { return this === item || this.children.some(child => child.contains?.(item)); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(item => item !== this); this.parentElement = null; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener); }
  emit(type, event = {}) { for (const listener of this.listeners.get(type) || []) listener({ target: this, ...event }); }
  focus() { globalThis.document.activeElement = this; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

function fakeDOM(t) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document'), document = { createElement: tag => new FakeElement(tag), activeElement: null };
  Object.defineProperty(globalThis, 'document', { value: document, configurable: true });
  t.after(() => descriptor ? Object.defineProperty(globalThis, 'document', descriptor) : delete globalThis.document);
  return document;
}
function workflow(type = 'any', required = false) {
  let doc = createDocument({ title: '本地定时测试' }); doc.nodes = [createNode('input', { x: 0, y: 0 }, { id: 'input', config: { outputType: type, required } }), createNode('tool', { x: 320, y: 0 }, { id: 'code', config: { inputType: type, outputType: 'any', code: 'return input;' } }), createNode('output', { x: 640, y: 0 }, { id: 'output', config: { inputType: 'any' } })];
  doc = connectNodes(doc, { sourceNode: 'input', sourcePort: 'out', targetNode: 'code', targetPort: 'in' }); return connectNodes(doc, { sourceNode: 'code', sourcePort: 'out', targetNode: 'output', targetPort: 'in' });
}
function schedule(doc, overrides = {}) { return { id: 'schedule-a', workflowId: doc.id, name: '每天整理数据', revision: 1, document: structuredClone(doc), input: false, timing: { kind: 'daily', time: '09:30', timezone: 'Asia/Shanghai' }, enabled: true, nextRunAt: '2030-01-02T01:30:00.000Z', createdAt: '2030-01-01T00:00:00.000Z', updatedAt: '2030-01-01T00:00:00.000Z', lastTrigger: null, ...overrides }; }
function mounted(t, doc = workflow()) {
  const document = fakeDOM(t), calls = [], runtime = { editor: { doc, root: new FakeElement('div'), propertyDrafts: new Map(), cancelGesture() {}, cancelConnection() {} }, input: { value: 'next input' }, runs: new Map(), getBackend: () => ({ state: 'stopped' }), api: async (path, options) => { calls.push({ path, options }); return { schedules: [] }; } };
  const ui = new WorkflowSchedulesUI(runtime); ui.kind.value = 'daily'; ui.daily.value = '09:30'; ui.timezone.value = 'Asia/Shanghai';
  return { ui, runtime, calls, document };
}

test('explicit schedule input formats preserve typed falsy values and optional null for every Input type', () => {
  for (const value of [0, false, null, '', { nested: false }, []]) assert.deepEqual(parseScheduleInput(JSON.stringify(value), 'json', { config: { outputType: 'any', required: false } }), value);
  assert.equal(parseScheduleInput('false', 'text', { config: { outputType: 'text' } }), 'false');
  for (const outputType of ['text', 'number', 'boolean', 'object', 'array']) assert.equal(parseScheduleInput('null', 'json', { config: { outputType, required: false } }), null);
  assert.throws(() => parseScheduleInput('null', 'json', { config: { outputType: 'any', required: true } }), /非空/);
  assert.throws(() => parseScheduleInput('false', 'text', { config: { outputType: 'boolean' } }), /类型不符/);
  assert.throws(() => parseScheduleInput('{', 'json', { config: { outputType: 'any' } }), /有效 JSON/);
});

test('trigger presentation uses the final run status and never calls a missed or unknown trigger successful', () => {
  assert.deepEqual(scheduleTriggerView(null), { text: '尚未触发', state: 'idle' });
  for (const status of ['complete', 'error', 'interrupted', 'waiting', 'unknown']) assert.equal(scheduleTriggerView({ status: 'started', runStatus: status }).state, status);
  assert.match(scheduleTriggerView({ status: 'missed' }).text, /错过.*不补跑/);
  assert.match(scheduleTriggerView({ status: 'offline' }).text, /未连接.*未启动/);
  assert.match(scheduleTriggerView({ status: 'cancelled' }).text, /已取消.*未启动/);
  assert.notEqual(scheduleTriggerView({ status: 'unknown' }).state, 'complete');
});

test('an exhausted once task offers editing instead of a failing resume, without confusing a new paused date', t => {
  const { ui, runtime, calls } = mounted(t), value = schedule(runtime.editor.doc, { enabled: false, nextRunAt: null, timing: { kind: 'once', localDateTime: '2030-01-02T09:30', timezone: 'Asia/Shanghai' }, lastTrigger: { status: 'started', scheduledAt: '2030-01-02T01:30:00.000Z', runStatus: 'complete', runId: 'run-a' } });
  ui.storeSchedule(value); ui.renderList(); const row = ui.rows.get(value.id);
  assert.equal(scheduleOnceEnded(value), true); assert.equal(row.enabled.textContent, '单次已结束'); assert.match(row.next.textContent, /编辑时间/); assert.equal(row.toggle.hidden, true);
  const future = { ...value, timing: { ...value.timing, localDateTime: '2030-01-03T09:30' }, revision: 2 }; ui.storeSchedule(future); ui.renderList(); assert.equal(scheduleOnceEnded(future), false); assert.equal(row.toggle.hidden, false); assert.equal(row.enabled.textContent, '已暂停'); assert.equal(calls.length, 0);
});

test('open loads only the current workflow and repeated same-workflow sync leaves the form intact', async t => {
  const { ui, runtime, calls, document } = mounted(t); await ui.open(); assert.equal(ui.dialog.open, true); assert.match(calls[0].path, new RegExp(encodeURIComponent(runtime.editor.doc.id)));
  ui.input.value = 'typed schedule draft'; ui.input.selectionStart = 8; ui.input.focus();
  for (let i = 0; i < 5; i++) ui.syncWorkflow();
  assert.equal(calls.length, 1); assert.equal(ui.input.value, 'typed schedule draft'); assert.equal(ui.input.selectionStart, 8); assert.equal(document.activeElement, ui.input);
  let stopped = false; ui.dialog.emit('keydown', { stopPropagation() { stopped = true; } }); assert.equal(stopped, true);
  ui.close(); assert.equal(ui.dialog.open, false);
});

test('creating a schedule freezes the current document, submits once and retains JSON false', async t => {
  const { ui, runtime } = mounted(t); ui.format.value = 'json'; ui.input.value = 'false';
  let done, body, count = 0; ui.api = (_path, options) => { count++; body = options.body; return new Promise(resolve => { done = resolve; }); };
  const pending = ui.save(); await ui.save(); assert.equal(count, 1); assert.equal(body.input, false); assert.equal(body.enabled, true); assert.equal(body.document.mode, 'execute');
  runtime.editor.doc.nodes[1].config.code = 'return "new draft";'; assert.equal(body.document.nodes[1].config.code, 'return input;');
  const value = schedule(body.document, { input: false }); done({ schedule: value }); await pending;
  assert.equal(ui.editingId, value.id, 'a second save updates the saved task instead of creating a duplicate'); assert.equal(ui.records.get(value.id).input, false); assert.equal(ui.saving, false);
});

test('learning mode and unapplied properties reject snapshot creation without applying or altering the draft', async t => {
  const { ui, runtime, calls } = mounted(t); const before = structuredClone(runtime.editor.doc);
  runtime.editor.propertyDrafts.set('code', { config: { code: 'return 99;' } }); await ui.save(); assert.equal(calls.length, 0); assert.match(ui.notice.textContent, /尚未应用/); assert.deepEqual(runtime.editor.doc, before); assert.equal(runtime.editor.propertyDrafts.size, 1);
  runtime.editor.propertyDrafts.clear(); runtime.editor.doc.mode = 'learn'; await ui.save(); assert.equal(calls.length, 0); assert.match(ui.notice.textContent, /执行模式/);
});

test('invalid local dates, DST gaps and expired once times fail before POST and remain editable', async t => {
  const { ui, calls } = mounted(t); ui.kind.value = 'once';
  for (const [value, timezone] of [['2030-02-30T09:30', 'UTC'], ['2030-03-10T02:30', 'America/New_York'], ['2000-01-01T09:30', 'UTC']]) {
    ui.once.value = value; ui.timezone.value = timezone; await ui.save(); assert.equal(calls.length, 0); assert.equal(ui.uncertain, false); assert.equal(ui.saving, false);
  }
});

test('schedule events update stable cards without replacing form controls, focus or typed input', async t => {
  const { ui, runtime, document } = mounted(t); const value = schedule(runtime.editor.doc); ui.dialog.showModal(); ui.handleEvent({ type: 'workflow.schedule', payload: { schedule: value } });
  const row = ui.rows.get(value.id), formInput = ui.input; ui.input.value = 'unsaved input'; ui.input.selectionStart = 3; ui.input.focus();
  ui.handleEvent({ type: 'workflow.schedule', payload: { schedule: { ...value, revision: 2, lastTrigger: { status: 'started', runId: 'run-a', runStatus: 'complete', triggeredAt: '2030-01-01T01:30:00.000Z' } } } });
  assert.equal(ui.rows.get(value.id), row); assert.equal(ui.input, formInput); assert.equal(ui.input.value, 'unsaved input'); assert.equal(document.activeElement, formInput); assert.equal(ui.input.selectionStart, 3); assert.match(row.trigger.textContent, /已完成/); assert.equal(row.result.hidden, false);
});

test('late GET and POST snapshots cannot overwrite a newer schedule event or resurrect a deleted task', async t => {
  const { ui, runtime } = mounted(t); const value = schedule(runtime.editor.doc); ui.storeSchedule(value);
  let resolve; ui.api = () => new Promise(done => { resolve = done; }); const loading = ui.loadRecent();
  ui.handleEvent({ type: 'workflow.schedule', payload: { schedule: { ...value, revision: 2, enabled: false } } }); resolve({ schedules: [value] }); await loading; assert.equal(ui.records.get(value.id).enabled, false);
  ui.edit(value.id); const pending = ui.save(); ui.handleEvent({ type: 'workflow.schedule', payload: { schedule: { ...value, revision: 3, name: 'newer event' } } }); resolve({ schedule: { ...value, revision: 2 } }); await pending; assert.equal(ui.records.get(value.id).name, 'newer event');
  ui.handleEvent({ type: 'workflow.schedule', payload: { deleted: true, id: value.id, workflowId: value.workflowId } }); ui.handleEvent({ type: 'workflow.schedule', payload: { schedule: value } }); assert.equal(ui.records.has(value.id), false); assert.match(ui.saveBlockReason(), /不可用/);
});

test('a failed save is never retried automatically and list refresh resolves the uncertain state without dropping input', async t => {
  const { ui } = mounted(t); let count = 0; ui.input.value = 'still editable'; ui.api = async () => { count++; throw new Error('connection interrupted'); };
  await ui.save(); await ui.save(); assert.equal(count, 1); assert.equal(ui.uncertain, true); assert.equal(ui.saveButton.disabled, true);
  ui.api = async () => ({ schedules: [] }); await ui.loadRecent(); assert.equal(ui.uncertain, false); assert.equal(ui.input.value, 'still editable'); assert.equal(ui.saveButton.disabled, false);
});

test('learning mode can pause and delete saved execution schedules but cannot enable one', async t => {
  const { ui, runtime } = mounted(t), value = schedule(runtime.editor.doc), calls = []; ui.storeSchedule(value); runtime.editor.doc.mode = 'learn';
  ui.api = async (path, options) => { calls.push({ path, options }); return path.endsWith('/delete') ? { deleted: true, id: value.id } : { schedule: { ...value, enabled: false, revision: 2 } }; };
  await ui.setEnabled(value.id); assert.equal(calls.length, 1); assert.deepEqual(calls[0].options.body, { enabled: false }); await ui.setEnabled(value.id); assert.equal(calls.length, 1);
  await ui.delete(value.id); assert.equal(calls.length, 2); assert.equal(ui.records.has(value.id), false); assert.match(ui.notice.textContent, /已开始的运行和历史结果保留/);
});

test('viewing a result delegates to the integrated runtime hook and only closes on success', async t => {
  const { ui, runtime } = mounted(t); const value = schedule(runtime.editor.doc, { lastTrigger: { status: 'started', runId: 'run-a', runStatus: 'complete' } }); ui.storeSchedule(value); ui.dialog.showModal();
  runtime.openScheduledRun = async id => { assert.equal(id, 'run-a'); throw new Error('not found'); }; await ui.viewResult(value.id); assert.equal(ui.dialog.open, true); assert.match(ui.notice.textContent, /运行结果读取失败/);
  let viewed = false; runtime.openScheduledRun = async id => { viewed = id === 'run-a'; }; await ui.viewResult(value.id); assert.equal(viewed, true); assert.equal(ui.dialog.open, false);
});

test('new tasks use an Input schedule only as daily defaults and never create a task before explicit save', t => {
  const doc = workflow(); Object.assign(doc.nodes[0].config, { trigger: 'schedule', schedule: '14:20', timezone: 'Asia/Tokyo' });
  const { ui, calls } = mounted(t, doc); ui.resetForm(); assert.equal(ui.kind.value, 'daily'); assert.equal(ui.daily.value, '14:20'); assert.equal(ui.timezone.value, 'Asia/Tokyo'); assert.equal(calls.length, 0); assert.equal(ui.records.size, 0);
});

test('editing saved typed input and switching workflows preserve separate unsaved form drafts', t => {
  const { ui, runtime } = mounted(t); const value = schedule(runtime.editor.doc, { input: null }); ui.storeSchedule(value); ui.edit(value.id); assert.equal(ui.format.value, 'json'); assert.equal(ui.input.value, 'null');
  ui.input.value = '{"own":"draft"}'; const first = runtime.editor.doc; runtime.editor.doc = workflow(); ui.syncWorkflow(); assert.equal(ui.editingId, null); ui.input.value = 'another workflow'; runtime.editor.doc = first; ui.syncWorkflow(); assert.equal(ui.editingId, value.id); assert.equal(ui.input.value, '{"own":"draft"}');
});

test('closing a dialog and changing workflow during save cannot leak the submitted form into the new workflow', async t => {
  const { ui, runtime } = mounted(t), first = runtime.editor.doc; ui.name.value = 'first workflow schedule'; let resolve;
  ui.api = () => new Promise(done => { resolve = done; }); const pending = ui.save();
  runtime.editor.doc = workflow(); runtime.editor.doc.title = 'another workflow'; ui.syncWorkflow(); assert.notEqual(ui.name.value, 'first workflow schedule');
  const secondName = ui.name.value; resolve({ schedule: schedule(first) }); await pending; assert.equal(ui.name.value, secondName); assert.equal(ui.editingId, null);
  runtime.editor.doc = first; ui.syncWorkflow(); assert.equal(ui.name.value, 'first workflow schedule'); assert.equal(ui.editingId, 'schedule-a', 'returning to the acknowledged task edits it instead of duplicating creation');
});
