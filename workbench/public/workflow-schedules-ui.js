import { planWorkflow } from '../shared/workflow/workflow-plan.mjs';
import { validateScheduleTiming, nextScheduleOccurrence } from '../shared/workflow/workflow-schedule-time.mjs';
import { isV2, inputEntries, STUDIO_STATUS } from '../shared/workflow/workflow-studio-utils.mjs';

const RUN_STATUS = { ...STUDIO_STATUS, preparing: '准备中', running: '运行中', waiting: '等待人工处理', complete: '已完成', error: '运行失败', interrupted: '已停止', unknown: '状态待确认' };
const TRIGGER_STATUS = { claimed: '已到期，等待启动', started: '已启动，结果待确认', missed: '已错过，不补跑', offline: 'Hermes 未连接，未启动', busy: '流程忙碌，未启动', cancelled: '已取消，未启动', error: '触发失败', unknown: '状态待确认' };
const own = (value, key) => value != null && Object.hasOwn(value, key);
const clean = value => String(value ?? '').replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[已隐藏密钥]').replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [已隐藏]').replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|authorization)["']?\s*[:=]\s*["']?)([^\s"',;}\]]+)/gi, '$1[已隐藏]');
const element = (tag, className = '', value) => { const item = document.createElement(tag); if (className) item.className = className; if (value !== undefined) item.textContent = clean(value); return item; };
const button = (label, action, className = 'wf-button') => { const item = element('button', className, label); item.type = 'button'; item.addEventListener('click', action); return item; };
const display = value => typeof value === 'string' ? clean(value) : clean(JSON.stringify(value, null, 2));
const responseSchedule = value => value?.schedule || value;

export function parseScheduleInput(raw, format, inputNode) {
  let value;
  if (format === 'text') value = raw;
  else if (format === 'json') { try { value = JSON.parse(raw); } catch { throw new Error('运行输入需要有效 JSON；普通文本请选择文本格式。'); } }
  else throw new Error('请选择文本或 JSON 输入格式。');
  const config = inputNode?.config || {}, type = config.outputType || 'any';
  if (config.required && (value == null || typeof value === 'string' && !value.trim())) throw new Error('此流程要求非空运行输入。');
  if (value == null && !config.required) return value;
  const matches = type === 'any' || type === 'text' && typeof value === 'string' || type === 'number' && typeof value === 'number' && Number.isFinite(value) || type === 'boolean' && typeof value === 'boolean' || type === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value) || type === 'array' && Array.isArray(value);
  if (!matches) throw new Error(`运行输入与 Input 的 ${type} 类型不符，请调整输入或格式。`);
  return value;
}

export function scheduleTriggerView(trigger) {
  if (!trigger) return { text: '尚未触发', state: 'idle' };
  if (trigger.status === 'started' && RUN_STATUS[trigger.runStatus]) return { text: RUN_STATUS[trigger.runStatus], state: trigger.runStatus };
  return { text: TRIGGER_STATUS[trigger.status] || '状态待确认', state: ['claimed', 'started'].includes(trigger.status) ? 'running' : ['error', 'unknown'].includes(trigger.status) ? 'error' : 'idle' };
}

function timezoneDefault() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } }
function dateTime(value, timezone) {
  if (!value) return '尚无记录';
  const date = new Date(value); if (!Number.isFinite(date.valueOf())) return '时间待确认';
  try { return new Intl.DateTimeFormat('zh-CN', { timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date); }
  catch { return date.toISOString(); }
}
function localDateTime(value, timezone) {
  const date = new Date(value);
  try { const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).map(item => [item.type, item.value])); return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`; }
  catch { return ''; }
}
function nextLocalDateTime(timezone) { return localDateTime(Date.now() + 60 * 60 * 1000, timezone); }
export function scheduleOnceEnded(record) {
  if (record?.timing?.kind !== 'once' || record.enabled || record.nextRunAt || !record.lastTrigger) return false;
  // An edited date can be a new, paused occurrence while its previous trigger is
  // retained as history. Do not mislabel that future occurrence as exhausted.
  if (record.lastTrigger.scheduledAt) return localDateTime(record.lastTrigger.scheduledAt, record.timing.timezone) === record.timing.localDateTime;
  return true;
}
function snapshotLabel(document) { return `${document?.title || '未命名流程'} · ${document?.nodes?.length || 0} 个节点 · ${document?.edges?.length || 0} 条连线`; }
function snapshotSignature(document) { return JSON.stringify({ id: document?.id, title: document?.title, schemaVersion: document?.schemaVersion, settings: document?.settings, nodes: document?.nodes?.map(({ id, type, title, config, ports }) => ({ id, type, title, config, ports })), edges: document?.edges }); }

export class WorkflowSchedulesUI {
  constructor(runtime) {
    this.runtime = runtime; this.editor = runtime.editor; this.api = runtime.api;
    this.records = new Map(); this.revisions = new Map(); this.revision = 0; this.rows = new Map(); this.drafts = new Map(); this.deleted = new Set();
    this.workflowId = null; this.editingId = null; this.formRevision = 0; this.loading = false; this.saving = false; this.pending = new Set(); this.uncertain = false; this.listRequest = 0;
    this.mount(); this.syncWorkflow();
  }
  mount() {
    this.dialog = element('dialog', 'wf-dialog wf-schedules-dialog'); this.dialog.setAttribute('aria-labelledby', 'wf-schedules-title');
    const heading = element('div', 'wf-dialog-header'), title = element('h2', '', '定时任务'); title.id = 'wf-schedules-title';
    this.closeButton = button('关闭', () => this.dialog.close(), 'wf-button'); heading.append(title, this.closeButton);
    this.workflowLabel = element('p', 'wf-schedules-workflow');
    this.guidance = element('p', 'wf-schedules-guidance', '工作台服务运行且电脑唤醒时触发；迟到超过 1 分钟或服务停机时错过的时间不补跑。暂停或删除任务不会停止已经开始的执行。');
    this.backendHint = element('p', 'wf-schedules-backend-hint');
    this.notice = element('p', 'wf-schedules-notice'); this.notice.hidden = true; this.notice.setAttribute('role', 'status');
    this.modeNotice = element('p', 'wf-schedules-mode-notice'); this.modeNotice.setAttribute('role', 'status');
    const layout = element('div', 'wf-schedules-layout');
    const listSection = element('section', 'wf-schedules-list-section'); listSection.setAttribute('aria-label', '当前工作流定时任务');
    const listHeading = element('div', 'wf-schedules-section-heading'); this.count = element('h3', '', '已保存的任务');
    this.refreshButton = button('刷新', () => void this.loadRecent(), 'wf-button'); listHeading.append(this.count, this.refreshButton);
    this.list = element('div', 'wf-schedules-list'); this.empty = element('p', 'wf-schedules-empty', '暂无定时任务。新建并保存后，才会按指定时间执行。'); listSection.append(listHeading, this.empty, this.list);
    this.form = element('form', 'wf-schedules-form'); const formHeading = element('div', 'wf-schedules-section-heading'); this.formTitle = element('h3', '', '新建定时任务');
    this.newButton = button('新建任务', () => this.resetForm(), 'wf-button'); formHeading.append(this.formTitle, this.newButton);
    this.snapshotNote = element('p', 'wf-schedules-snapshot-note');
    this.name = this.field('任务名称', 'input', 'wf-schedule-name'); this.name.maxLength = 120; this.name.required = true;
    this.kind = this.field('触发方式', 'select', 'wf-schedule-kind'); for (const [value, label] of [['once', '单次指定时间'], ['daily', '每天固定时间']]) { const option = element('option', '', label); option.value = value; this.kind.append(option); }
    this.once = this.field('日期与时间（按下方时区）', 'input', 'wf-schedule-once'); this.once.type = 'datetime-local'; this.once.step = '60';
    this.daily = this.field('每天时间（按下方时区）', 'input', 'wf-schedule-daily'); this.daily.type = 'time'; this.daily.step = '60';
    this.timezone = this.field('IANA 时区', 'input', 'wf-schedule-timezone'); this.timezone.placeholder = '例如 Asia/Shanghai'; this.timezone.maxLength = 100; this.timezone.required = true;
    this.format = this.field('运行输入格式', 'select', 'wf-schedule-format'); for (const [value, label] of [['text', '文本'], ['json', 'JSON（保留数字、布尔值和 null）']]) { const option = element('option', '', label); option.value = value; this.format.append(option); }
    this.input = this.field('固定运行输入', 'textarea', 'wf-schedule-input'); this.input.spellcheck = false; this.input.rows = 5;
    this.structured = element('section', 'wf-schedules-structured'); this.structuredSummary = element('pre'); this.structured.append(element('strong', '', '固定输入资料'), this.structuredSummary, button('采用左侧当前资料', () => { this.editor.studio?.syncRawInput(); this.format.value = 'json'; this.input.value = this.runtime.input.value; this.formRevision++; this.renderFormState(); }), button('返回准备资料', () => { this.close(); this.editor.setCanvasClosed?.(false); this.editor.studio?.setTab('inputs'); if (this.editor.setPanelClosed) this.editor.setPanelClosed('library', false); else { this.editor.settings.libraryClosed = false; this.editor.applySettings(); } }));
    const enabledLabel = element('label', 'wf-schedules-enabled'); this.enabled = element('input'); this.enabled.type = 'checkbox'; this.enabled.id = 'wf-schedule-enabled'; enabledLabel.append(this.enabled, element('span', '', '保存后启用任务'));
    this.inputHint = element('p', 'wf-schedules-input-hint');
    this.saveButton = element('button', 'wf-button primary', '保存定时任务'); this.saveButton.type = 'submit';
    const actions = element('div', 'wf-schedules-form-actions'); actions.append(this.saveButton);
    this.formControls = [this.name, this.kind, this.once, this.daily, this.timezone, this.format, this.input, this.enabled];
    this.form.append(formHeading, this.snapshotNote, this.name.parentElement, this.kind.parentElement, this.once.parentElement, this.daily.parentElement, this.timezone.parentElement, this.structured, this.format.parentElement, this.input.parentElement, this.inputHint, enabledLabel, actions);
    this.form.addEventListener('submit', event => { event.preventDefault(); void this.save(); });
    for (const control of this.formControls) control.addEventListener('input', () => { this.formRevision++; this.renderFormState(); });
    this.kind.addEventListener('change', () => this.renderFormState());
    // Native dialog behavior still handles Escape; canvas shortcuts must not see it.
    this.dialog.addEventListener('keydown', event => event.stopPropagation());
    layout.append(listSection, this.form); this.dialog.append(heading, this.workflowLabel, this.guidance, this.backendHint, this.notice, this.modeNotice, layout); this.editor.root.append(this.dialog);
  }
  field(label, tag, id) { const wrapper = element('div', 'wf-field'), caption = element('label', '', label), control = element(tag); caption.htmlFor = id; control.id = id; wrapper.append(caption, control); return control; }
  showNotice(message = '', error = false) { this.notice.textContent = clean(message); this.notice.hidden = !message; this.notice.classList.toggle('error', error); }
  formValues() { return { editingId: this.editingId, values: this.formControls.map(control => control.type === 'checkbox' ? control.checked : control.value) }; }
  restoreForm(draft) { this.editingId = draft.editingId; this.formControls.forEach((control, index) => { if (control.type === 'checkbox') control.checked = draft.values[index]; else control.value = draft.values[index]; }); this.formRevision++; this.renderFormState(); }
  resetForm({ force = false } = {}) {
    if (this.saving && !force) return;
    const entry = this.editor.doc?.nodes?.find(item => item.type === 'input'), config = entry?.config || {};
    this.editingId = null; this.name.value = `${this.editor.doc?.title || '工作流'} · 定时运行`.slice(0, 120); this.timezone.value = config.timezone || timezoneDefault();
    this.kind.value = config.trigger === 'schedule' ? 'daily' : 'once'; this.daily.value = /^\d{2}:\d{2}$/.test(config.schedule || '') ? config.schedule : '09:00'; this.once.value = nextLocalDateTime(this.timezone.value);
    this.format.value = ['object', 'array', 'number', 'boolean'].includes(config.outputType) ? 'json' : 'text'; this.input.value = this.runtime.input?.value || ''; this.enabled.checked = true;
    this.formRevision++; this.showNotice(); this.renderFormState();
  }
  syncWorkflow() {
    const id = this.editor.nodeLibrary?.rootDocument?.id || this.editor.doc?.id || null;
    if (this.workflowId !== id) {
      if (this.workflowId) this.drafts.set(this.workflowId, this.formValues());
      this.workflowId = id; this.listRequest++; this.loading = false; this.uncertain = false; this.rows.clear(); this.list.replaceChildren();
      const draft = this.drafts.get(id); if (draft) this.restoreForm(draft); else this.resetForm({ force: true });
      if (this.dialog.open) void this.loadRecent();
    }
    this.renderFormState(); if (this.dialog.open) this.renderList();
  }
  async open() {
    if (this.editor.nodeLibrary?.nested) { this.editor.toast?.('请先应用或取消子流程内部编辑，再设置主流程定时任务。', true); return; }
    this.editor.cancelGesture?.(); this.editor.cancelConnection?.(); this.syncWorkflow();
    if (!this.dialog.open) this.dialog.showModal();
    this.renderList(); this.renderFormState(); await this.loadRecent();
  }
  close() { if (this.dialog.open) this.dialog.close(); }
  saveBlockReason() {
    if (this.editor.nodeLibrary?.nested) return '请先应用或取消子流程内部编辑，再保存定时任务。';
    if (!this.workflowId) return '请先创建工作流。';
    if (this.editor.doc?.mode !== 'execute') return '学习模式可以查看、暂停和删除定时任务。请切换到执行模式后保存或启用任务。';
    if (this.editor.propertyDrafts?.size) return '节点属性尚未应用。请先应用或重置属性，再保存定时任务快照。';
    if (this.uncertain) return '上次修改尚未确认，请先刷新任务列表，核对后再继续。';
    if (this.editingId && !this.records.has(this.editingId)) return '正在编辑的任务已不可用，请刷新列表或点击“新建任务”。';
    return '';
  }
  renderFormState() {
    const reason = this.saveBlockReason(), record = this.records.get(this.editingId);
    this.workflowLabel.textContent = clean(`当前工作流：${this.editor.doc?.title || '未命名流程'}`); this.modeNotice.textContent = reason; this.modeNotice.hidden = !reason;
    const needsHermes = [this.editor.doc, ...this.schedules().map(item => item.document)].some(document => document?.nodes?.some(item => item.type === 'skill'));
    const backend = this.runtime.getBackend?.() || {}; this.backendHint.hidden = !needsHermes || backend.state === 'ready' && backend.authenticated !== false;
    this.backendHint.textContent = '含 Skill 的任务到点需要 Hermes 已连接且订阅认证可用。当前连接尚未就绪；离线时会记录未启动，不会自动连接或补跑。';
    this.formTitle.textContent = this.editingId ? '编辑定时任务' : '新建定时任务';
    this.snapshotNote.textContent = clean(this.editingId ? `保存更新会采用当前草稿替换此任务的固定流程快照与输入。${record && snapshotSignature(record.document) !== snapshotSignature(this.editor.doc) ? '已保存快照与当前草稿不同。' : ''}` : '保存时固定当前草稿与输入；之后编辑画布不会自动更新此任务。入口的定时配置仅作建议，保存任务后才会启用。');
    this.once.parentElement.hidden = this.kind.value !== 'once'; this.daily.parentElement.hidden = this.kind.value !== 'daily';
    const structured = isV2(this.editor.doc) && inputEntries(this.editor.doc).length > 0;
    if (this.structured) { this.structured.hidden = !structured; this.format.parentElement.hidden = Boolean(structured); this.input.parentElement.hidden = Boolean(structured); this.structuredSummary.textContent = this.input.value || '尚未准备资料。请回到左侧选择文件。'; }
    const entry = this.editor.doc?.nodes?.find(item => item.type === 'input'); this.inputHint.textContent = clean(`当前 Input 类型：${entry?.config?.outputType || '未配置'}。JSON 格式保留 0、false 和 null；必填输入不接受 null。`);
    for (const control of this.formControls) control.disabled = this.saving;
    this.newButton.disabled = this.saving; this.saveButton.disabled = this.saving || Boolean(reason); this.saveButton.textContent = this.saving ? '正在保存…' : this.editingId ? '采用当前草稿并保存更新' : '保存定时任务';
    this.refreshButton.disabled = this.loading || this.saving;
  }
  schedules() { return [...this.records.values()].filter(item => item.workflowId === this.workflowId).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))); }
  storeSchedule(value) { const record = responseSchedule(value), previous = this.records.get(record?.id); if (!record?.id || !record.workflowId || this.deleted.has(record.id) || Number.isInteger(previous?.revision) && Number.isInteger(record.revision) && record.revision < previous.revision) return false; this.records.set(record.id, record); this.revisions.set(record.id, ++this.revision); return true; }
  removeSchedule(id) { this.records.delete(id); this.deleted.add(id); this.revisions.set(id, ++this.revision); }
  async loadRecent() {
    const workflowId = this.workflowId; if (!workflowId || this.loading || this.saving) return;
    const request = ++this.listRequest, revision = this.revision; this.loading = true; this.renderFormState();
    try {
      const result = await this.api(`/api/workflow-schedules?workflowId=${encodeURIComponent(workflowId)}`);
      if (request !== this.listRequest || workflowId !== this.workflowId) return;
      const records = result.schedules || [], ids = new Set(records.map(item => item.id));
      for (const record of records) if ((this.revisions.get(record.id) || 0) <= revision) this.storeSchedule(record);
      for (const record of this.schedules()) if (!ids.has(record.id) && (this.revisions.get(record.id) || 0) <= revision) this.removeSchedule(record.id);
      if (this.uncertain) { this.uncertain = false; this.showNotice('已刷新任务列表，请核对任务及其启用状态后继续。'); }
      this.renderList();
    } catch (error) { if (request === this.listRequest) this.showNotice(`任务列表读取失败：${error.message}`, true); }
    finally { if (request === this.listRequest) { this.loading = false; this.renderFormState(); this.renderList(); } }
  }
  renderList() {
    const records = this.schedules(), ids = new Set(records.map(item => item.id));
    this.count.textContent = `已保存的任务（${records.length}）`; this.empty.hidden = records.length > 0; this.empty.textContent = this.loading ? '正在读取定时任务…' : '暂无定时任务。新建并保存后，才会按指定时间执行。';
    for (const [id, row] of this.rows) if (!ids.has(id)) { row.card.remove(); this.rows.delete(id); }
    for (const record of records) {
      let row = this.rows.get(record.id); if (!row) { row = this.createRow(record.id); this.rows.set(record.id, row); this.list.append(row.card); }
      const timing = record.timing || {}, trigger = record.lastTrigger, view = scheduleTriggerView(trigger), ended = scheduleOnceEnded(record);
      row.name.textContent = clean(record.name); row.enabled.textContent = record.enabled ? '已启用' : ended ? '单次已结束' : '已暂停'; row.enabled.dataset.state = record.enabled ? 'enabled' : 'paused';
      row.timing.textContent = clean(`${timing.kind === 'daily' ? `每天 ${timing.time || '时间待确认'}` : `单次 ${(timing.localDateTime || '时间待确认').replace('T', ' ')}`} · ${timing.timezone || '时区待确认'}`);
      row.next.textContent = clean(record.enabled && record.nextRunAt ? `下次：${dateTime(record.nextRunAt, timing.timezone)}` : record.enabled ? '下次时间待确认' : ended ? '编辑时间可再次启用' : '已暂停，暂无下次执行');
      row.snapshotTitle.textContent = clean(`固定流程快照 · ${snapshotLabel(record.document)}`);
      row.snapshotBody.textContent = clean([`保存于 ${dateTime(record.updatedAt || record.createdAt, timing.timezone)}`, (record.document?.nodes || []).map(item => `${item.title}（${item.type}）${item.type === 'skill' ? ` · ${item.config?.skillRef || ''} · ${item.config?.version || ''}` : ''}`).join('\n'), '固定输入：', own(record, 'input') ? display(record.input) : '该记录未采集输入。'].join('\n'));
      row.trigger.textContent = clean(`最近触发：${view.text}${trigger?.triggeredAt ? ` · ${dateTime(trigger.triggeredAt, timing.timezone)}` : ''}`); row.trigger.dataset.state = view.state;
      row.error.textContent = trigger?.error ? clean(trigger.error) : ''; row.error.hidden = !row.error.textContent;
      row.result.hidden = !trigger?.runId; row.result.disabled = this.pending.has(`view:${record.id}`); row.result.textContent = row.result.disabled ? '正在读取运行…' : '查看运行结果';
      const busy = this.pending.has(record.id) || this.saving || this.uncertain;
      row.edit.disabled = busy; row.toggle.disabled = busy || !record.enabled && this.editor.doc?.mode !== 'execute'; row.delete.disabled = row.confirm.disabled = busy;
      row.toggle.textContent = record.enabled ? '暂停' : '恢复'; row.toggle.hidden = ended;
    }
  }
  createRow(id) {
    const card = element('article', 'wf-schedule-card'), heading = element('div', 'wf-schedules-section-heading'), name = element('h4'), enabled = element('span', 'wf-schedule-enabled-state'); heading.append(name, enabled);
    const timing = element('p', 'wf-schedule-timing'), next = element('p', 'wf-schedule-next'), snapshot = element('details', 'wf-schedule-snapshot'), snapshotTitle = element('summary'), snapshotBody = element('pre'); snapshotBody.tabIndex = 0; snapshot.append(snapshotTitle, snapshotBody);
    const trigger = element('p', 'wf-schedule-trigger'), error = element('p', 'wf-schedule-trigger-error'), actions = element('div', 'wf-schedules-row-actions');
    const edit = button('编辑', () => this.edit(id)), toggle = button('暂停', () => void this.setEnabled(id)), result = button('查看运行结果', () => void this.viewResult(id));
    const confirmation = element('div', 'wf-schedules-delete-confirm'); confirmation.hidden = true; confirmation.append(element('p', '', '删除后不再触发；已开始的运行和历史结果会保留。'));
    const confirm = button('确认删除', () => void this.delete(id), 'wf-button danger'), cancel = button('取消', () => { confirmation.hidden = true; }); confirmation.append(confirm, cancel);
    const remove = button('删除', () => { confirmation.hidden = false; }, 'wf-button danger'); actions.append(edit, toggle, result, remove); card.append(heading, timing, next, trigger, error, snapshot, actions, confirmation);
    return { card, name, enabled, timing, next, snapshotTitle, snapshotBody, trigger, error, edit, toggle, result, delete: remove, confirm, confirmation };
  }
  edit(id) {
    const record = this.records.get(id); if (!record || this.saving) return;
    this.editingId = id; this.name.value = record.name; this.kind.value = record.timing.kind; this.timezone.value = record.timing.timezone;
    this.once.value = record.timing.kind === 'once' ? record.timing.localDateTime : nextLocalDateTime(record.timing.timezone); this.daily.value = record.timing.kind === 'daily' ? record.timing.time : '09:00';
    this.format.value = typeof record.input === 'string' ? 'text' : 'json'; this.input.value = typeof record.input === 'string' ? record.input : JSON.stringify(record.input, null, 2); this.enabled.checked = Boolean(record.enabled);
    this.formRevision++; this.showNotice('编辑将采用当前草稿替换已保存快照；原任务会在保存成功前保持原配置。'); this.renderFormState(); this.name.focus(); this.form.scrollIntoView?.({ block: 'nearest' });
  }
  async save() {
    if (this.saving) return; const reason = this.saveBlockReason(); if (reason) { this.showNotice(reason, true); return; }
    let body;
    try {
      this.editor.studio?.flushRunSettings();
      const plan = planWorkflow(structuredClone(this.editor.doc)), timing = { kind: this.kind.value, timezone: this.timezone.value.trim() };
      if (!timing.timezone) throw new Error('请填写 IANA 时区。');
      if (timing.kind === 'once') { timing.localDateTime = this.once.value; if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(timing.localDateTime)) throw new Error('请填写单次执行的完整日期与时间。'); }
      else if (timing.kind === 'daily') { timing.time = this.daily.value; if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(timing.time)) throw new Error('请填写每天执行的时间。'); }
      else throw new Error('请选择单次或每天触发。');
      const checkedTiming = validateScheduleTiming(timing);
      if (timing.kind === 'once' && nextScheduleOccurrence(checkedTiming) === null) throw new Error('单次执行时间必须晚于当前时间，请重新选择时间。');
      const name = this.name.value.trim(); if (!name || name.length > 120) throw new Error('任务名称需要为 1–120 个字符。');
      let input = parseScheduleInput(this.input.value, this.format.value, plan.inputNode);
      if (isV2(plan.document)) { const result = await this.api('/api/workflow-v2/preflight', { method: 'POST', body: { document: plan.document, input } }); if (!result.ok) throw new Error(`输入未准备好：${(result.errors || []).map(error => error.message).join('；')}`); input = result.input; }
      body = { name, document: plan.document, input, timing: checkedTiming, enabled: Boolean(this.enabled.checked) };
    } catch (error) { this.showNotice(error.message, true); return; }
    const workflowId = this.workflowId, editingId = this.editingId, formRevision = this.formRevision, revision = this.revision, submittedForm = this.formValues();
    this.saving = true; this.renderFormState(); this.renderList(); this.showNotice('正在保存固定流程快照…');
    try {
      const value = responseSchedule(await this.api(`/api/workflow-schedules${editingId ? `/${encodeURIComponent(editingId)}` : ''}`, { method: 'POST', body }));
      if (!value?.id || value.workflowId !== workflowId) throw new Error('服务未返回匹配的定时任务，请刷新确认。');
      if ((this.revisions.get(value.id) || 0) <= revision) this.storeSchedule(value);
      if (this.workflowId !== workflowId && this.records.has(value.id) && JSON.stringify(this.drafts.get(workflowId)) === JSON.stringify(submittedForm)) this.drafts.set(workflowId, { ...submittedForm, editingId: value.id });
      if (this.workflowId === workflowId && this.formRevision === formRevision) { this.editingId = this.records.has(value.id) ? value.id : null; this.showNotice(this.records.has(value.id) ? '定时任务已保存；后续编辑画布不会自动改变这份快照。' : '任务已有较新变更，请以列表状态为准。'); }
    } catch (error) { if (this.workflowId === workflowId) { this.uncertain = true; this.showNotice(`保存未确认：${error.message}。不会自动重试，请先刷新列表，避免重复创建。`, true); } }
    finally { this.saving = false; this.renderFormState(); this.renderList(); }
  }
  async setEnabled(id) {
    if (this.editor.nodeLibrary?.nested) { this.showNotice('请先返回主流程，再调整定时任务。', true); return; }
    const record = this.records.get(id); if (!record || this.pending.has(id) || this.saving || this.uncertain) return;
    if (scheduleOnceEnded(record)) { this.showNotice('单次任务已结束，请编辑新的日期时间后保存。', true); return; }
    if (!record.enabled && this.editor.doc?.mode !== 'execute') { this.showNotice('请切换到执行模式后恢复定时任务。', true); return; }
    const revision = this.revision; this.pending.add(id); this.renderList();
    try { const value = responseSchedule(await this.api(`/api/workflow-schedules/${encodeURIComponent(id)}/enabled`, { method: 'POST', body: { enabled: !record.enabled } })); if (value?.id !== id) throw new Error('服务未返回匹配任务。'); if ((this.revisions.get(id) || 0) <= revision) this.storeSchedule(value); this.showNotice(record.enabled ? '已暂停后续触发；已开始的执行继续运行。' : '已恢复任务，将按已保存的固定快照触发。'); }
    catch (error) { this.uncertain = true; this.showNotice(`任务状态未确认：${error.message}。请刷新列表核对。`, true); }
    finally { this.pending.delete(id); this.renderFormState(); this.renderList(); }
  }
  async delete(id) {
    if (!this.records.has(id) || this.pending.has(id) || this.saving || this.uncertain) return;
    this.pending.add(id); this.renderList();
    try { const result = await this.api(`/api/workflow-schedules/${encodeURIComponent(id)}/delete`, { method: 'POST', body: {} }); if (result.deleted !== true || result.id !== id) throw new Error('服务未确认删除。'); this.removeSchedule(id); if (this.editingId === id) this.resetForm(); this.showNotice('定时任务已删除；已开始的运行和历史结果保留。'); }
    catch (error) { this.uncertain = true; this.showNotice(`删除未确认：${error.message}。请刷新列表核对。`, true); }
    finally { this.pending.delete(id); this.renderFormState(); this.renderList(); }
  }
  async viewResult(id) {
    const runId = this.records.get(id)?.lastTrigger?.runId; if (!runId || this.pending.has(`view:${id}`)) return;
    this.pending.add(`view:${id}`); this.renderList();
    try {
      if (typeof this.runtime.openScheduledRun === 'function') await this.runtime.openScheduledRun(runId);
      else {
        if (this.editor.doc?.mode !== 'execute') throw new Error('请先切换到执行模式，再查看运行结果。');
        await this.runtime.loadRun(runId); if (!this.runtime.runs.has(runId)) throw new Error('运行记录尚未读取，请刷新后重试。');
        this.runtime.currentRunId = runId; this.runtime.selectedNodeId = null; this.runtime.nodeSelectionPinned = false; this.runtime.render(); this.runtime.setExpanded();
      }
      this.close();
    } catch (error) { this.showNotice(`运行结果读取失败：${error.message}`, true); }
    finally { this.pending.delete(`view:${id}`); this.renderList(); }
  }
  handleEvent(event) {
    if (event.type !== 'workflow.schedule') return;
    const payload = event.payload || {};
    if (payload.deleted === true && payload.id) { this.removeSchedule(payload.id); if (this.editingId === payload.id) this.showNotice('正在编辑的定时任务已删除。草稿保留；请点击“新建任务”重新创建。', true); }
    else this.storeSchedule(payload.schedule || payload);
    if (this.dialog.open) { this.renderList(); this.renderFormState(); }
  }
}
