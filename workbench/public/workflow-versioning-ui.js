import { validateDocument } from '../shared/workflow/workflow-model.mjs';
import { documentFingerprint } from '../shared/workflow/workflow-conversation-commands.mjs';
import { prepareWorkflowVersion } from '../shared/workflow/workflow-versioning.mjs';
import { setToolbarControl } from './workflow-toolbar-controls.js';

const copy = value => structuredClone(value);
const unwrap = value => value?.workflow || value;
const el = (tag, className = '', text) => { const item = document.createElement(tag); item.className = className; if (text !== undefined) item.textContent = String(text); return item; };
const button = (title, handler, className = 'wf-button') => { const item = el('button', className, title); item.type = 'button'; item.addEventListener('click', handler); return item; };
const lifecycle = record => record?.lifecycle || 'active';

export function assertWorkflowVersionSource(editor) {
  if (!editor?.doc || editor.doc.schemaVersion !== 2) throw new Error('请先升级为并行工作流，再另存为新版。');
  if (editor.libraryReadOnly || (editor.libraryLifecycle || 'active') !== 'active') throw new Error('此工作流只读，请先在看板恢复。');
  if (editor.nodeLibrary?.nested) throw new Error('请先应用或取消组合内部修改，再另存为新版。');
  if (editor.storageConflict || editor.corruptDraft) throw new Error('请先处理草稿恢复或其它窗口的编辑冲突。');
  if (editor.propertyDrafts?.size || editor.validationDraftErrors?.size || editor.nodeLibrary?.validationBuilderErrors?.size || editor.titleDraft) throw new Error('请先应用或取消当前属性与名称修改，再另存为新版。');
  if (editor.libraryError || editor.saveError) throw new Error('原工作流尚未保存成功，请先保存并解决同步问题。');
  return editor.doc;
}

// IDs are allocated once per dialog, including across title/option previews.
// An uncertain POST can therefore be looked up and retried without creating a
// second workflow. This cache is only an identity allocator, never a DB writer.
function stableIds() {
  const pools = new Map(); let counters = new Map();
  return { reset() { counters = new Map(); }, next(prefix) {
    const index = counters.get(prefix) || 0; counters.set(prefix, index + 1);
    if (!pools.has(prefix)) pools.set(prefix, []);
    const pool = pools.get(prefix); if (!pool[index]) pool[index] = `${prefix}-${globalThis.crypto.randomUUID()}`;
    return pool[index];
  } };
}

function savedRecord(value, expectedId) {
  const record = unwrap(value);
  if (!record || record.id !== expectedId || record.document?.id !== expectedId || !Number.isSafeInteger(record.revision) || record.revision < 1) throw new Error('工作流保存记录与当前对象不匹配。');
  if (lifecycle(record) !== 'active') throw new Error('工作流已在回收站，请先从看板恢复。');
  return { ...record, document: validateDocument(record.document) };
}

export class WorkflowVersioningUI {
  constructor(editor, { api, onCreated = () => {} }) {
    this.editor = editor; this.api = api; this.onCreated = onCreated;
    this.sessions = new Map(); this.scopeGeneration = 0; this.lastDocumentId = editor.doc?.id;
    this.mount(); this.syncHeader();
  }
  mount() {
    this.openButton = button('另存为新版', () => void this.open()); this.openButton.dataset.action = 'save-version';
    setToolbarControl(this.openButton, { label: '另存为新版', icon: 'copy' });
    this.editor.root.querySelector('.wf-header-actions').append(this.openButton);
    this.dialog = el('dialog', 'wf-dialog wf-versioning-dialog'); this.dialog.setAttribute('aria-label', '另存为新版工作流');
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.close(); });
    this.dialog.addEventListener('close', () => { if (this.session?.busy && !this.session.finished && !this.dialog.open) this.dialog.showModal(); });
    this.editor.root.append(this.dialog);
  }
  syncHeader() {
    const id = this.editor.doc?.id;
    if (id !== this.lastDocumentId) { this.lastDocumentId = id; this.scopeGeneration++; }
    let reason = ''; try { assertWorkflowVersionSource(this.editor); } catch (error) { reason = error.message; }
    if (this.openButton) { this.openButton.disabled = Boolean(this.session?.busy || reason);
      setToolbarControl(this.openButton, { label: reason ? `另存为新版 · ${reason}` : '另存为新版', icon: 'copy', busy: Boolean(this.session?.busy) }); }
    if (this.session && this.dialog?.open && !this.current(this.session)) {
      this.session.stale = true;
      if (!this.session.busy) this.showStatus(this.session, '当前工作流或编辑内容已变化。请关闭此窗口，保存后重新另存。', true);
    }
  }
  current(session) {
    if (this.session !== session || session.scopeGeneration !== this.scopeGeneration || this.editor.doc?.id !== session.sourceId || this.editor.active === false) return false;
    try { return documentFingerprint(assertWorkflowVersionSource(this.editor)) === session.sourceFingerprint; } catch { return false; }
  }
  assertCurrent(session) { if (!this.current(session) || session.stale) throw new Error('当前工作流或编辑内容已变化，请保存后重新另存为新版。'); }
  visible(session) { return this.session === session && Boolean(this.dialog?.open); }
  showStatus(session, message = '', error = false) {
    session.message = message; session.error = error;
    if (!this.visible(session)) return;
    this.notice.textContent = message; this.notice.classList.toggle('error', error); this.renderControls(session);
  }
  renderControls(session) {
    if (!this.visible(session)) return;
    const frozen = Boolean(session.busy || session.attempted || session.created);
    for (const input of [this.titleInput, ...Object.values(this.options)]) input.disabled = frozen;
    this.cancelButton.disabled = Boolean(session.busy);
    this.submitButton.disabled = Boolean(session.busy || !session.preview || session.stale || !this.current(session));
    this.submitButton.textContent = session.busy ? (session.phase || '正在确认…') : session.created ? '打开已创建新版' : session.attempted && !session.retryAllowed ? '确认保存结果' : session.attempted ? '重试创建同一新版' : '创建新版';
    this.syncButtonOnly();
  }
  syncButtonOnly() { if (this.openButton) this.openButton.disabled = Boolean(this.session?.busy) || (() => { try { assertWorkflowVersionSource(this.editor); return false; } catch { return true; } })(); }
  show(session) {
    this.dialog.replaceChildren(el('h2', '', '另存为新版工作流'));
    const form = el('form', 'wf-component-form'); this.form = form;
    const titleLabel = el('label', 'wf-field'); titleLabel.append(el('span', '', '新版名称'));
    this.titleInput = el('input'); this.titleInput.value = session.title; this.titleInput.name = 'versionTitle'; this.titleInput.required = true; this.titleInput.maxLength = 120; this.titleInput.setAttribute('aria-label', '新版名称'); titleLabel.append(this.titleInput); form.append(titleLabel);
    form.append(el('p', 'wf-field-help', `原版：${session.sourceTitle}`));
    this.options = {};
    for (const [key, caption] of [['upgradeNodes', '登记工具预设来源'], ['addValidation', '增加输入校验'], ['addStageOutputs', '保存审核后阶段成果'], ['copyInputs', '保留已填写输入资料，但需重新预检']]) {
      const label = el('label', 'wf-field wf-versioning-option'), input = el('input'); input.type = 'checkbox'; input.name = key; input.checked = session.options[key]; input.setAttribute('aria-label', caption); label.append(input, el('span', '', caption)); form.append(label); this.options[key] = input;
      input.addEventListener('change', () => { session.options[key] = input.checked; this.updatePreview(session); });
    }
    form.append(el('p', 'wf-field-help', '文件与目录需重新预检。'));
    this.preview = el('section', 'wf-property-section wf-versioning-preview'); this.preview.setAttribute('aria-label', '新版重构预览'); form.append(this.preview);
    form.append(el('p', 'wf-field-help', '新版不含运行、聊天、审核或定时记录。'));
    this.notice = el('p', 'wf-field-feedback'); this.notice.setAttribute('role', 'status');
    const actions = el('div', 'wf-dialog-actions'); this.cancelButton = button('取消', () => this.close()); this.submitButton = el('button', 'wf-button primary', '创建新版'); this.submitButton.type = 'submit'; actions.append(this.cancelButton, this.submitButton); form.append(this.notice, actions); this.dialog.append(form);
    this.titleInput.addEventListener('input', () => { session.title = this.titleInput.value; this.updatePreview(session); });
    form.addEventListener('submit', event => { event.preventDefault(); void this.submit(session); });
    if (!this.dialog.open) this.dialog.showModal();
    this.renderPreview(session); this.showStatus(session, session.message || '', Boolean(session.error)); this.titleInput.focus();
  }
  async open() {
    if (this.session?.busy) return false;
    let document;
    try { document = copy(assertWorkflowVersionSource(this.editor)); }
    catch (error) { this.editor.toast(error.message, true); return false; }
    this.syncHeader();
    const fingerprint = documentFingerprint(document), previous = this.sessions.get(document.id);
    // Reopening an uncertain save explicitly resumes that exact candidate. A
    // change to the source cannot silently create another version with new IDs.
    if (previous?.attempted && !previous.finished) {
      this.session = previous; previous.scopeGeneration = this.scopeGeneration;
      previous.stale = fingerprint !== previous.sourceFingerprint;
      this.show(previous);
      if (previous.stale) this.showStatus(previous, '此新版的保存结果尚未确认，但原版已变化。请在看板查找先前新版；不要重复创建。', true);
      return true;
    }
    const session = { sourceId: document.id, sourceTitle: document.title, sourceFingerprint: fingerprint,
      scopeGeneration: this.scopeGeneration, title: `${document.title.slice(0, 109)} · 节点新版`,
      options: { upgradeNodes: true, addValidation: true, addStageOutputs: true, copyInputs: true },
      ids: stableIds(), busy: true, phase: '正在读取原版…' };
    this.session = session; this.sessions.set(session.sourceId, session); this.show(session);
    try {
      const record = savedRecord(await this.api(`/api/workflow-library/${encodeURIComponent(session.sourceId)}`), session.sourceId);
      this.assertCurrent(session);
      if (documentFingerprint(record.document) !== fingerprint) throw new Error('当前画布与看板保存版本不同，请先保存原版，再另存为新版。');
      session.source = record; this.updatePreview(session);
      this.showStatus(session, `基于已保存原版 v${record.revision} 创建独立新版。`);
    } catch (error) { this.showStatus(session, error.httpStatus === 404 ? '原工作流尚未保存到看板，请先保存，再另存为新版。' : error.message, true); }
    finally { session.busy = false; this.renderControls(session); }
    return Boolean(session.source);
  }
  updatePreview(session) {
    if (session.attempted || session.created) return;
    try {
      if (!session.source) return;
      this.assertCurrent(session); session.ids.reset();
      session.preview = prepareWorkflowVersion(session.source.document, { title: session.title.trim(),
        upgradeNodes: session.options.upgradeNodes, addValidation: session.options.addValidation,
        addStageOutputs: session.options.addStageOutputs, idFactory: prefix => session.ids.next(prefix) });
      this.showStatus(session, '待创建');
    } catch (error) { session.preview = null; this.showStatus(session, error.message, true); }
    this.renderPreview(session); this.renderControls(session);
  }
  renderPreview(session) {
    if (!this.visible(session)) return;
    this.preview.replaceChildren(el('h3', '', '重构详情'));
    if (!session.preview) { this.preview.append(el('p', 'wf-field-help', session.busy ? '正在读取已保存原版…' : '请先确认原版已保存，再重新打开。')); return; }
    const { document, report } = session.preview, list = el('dl', 'wf-node-origin-list');
    for (const [label, value] of [['新版节点', document.nodes.length], ['新版连线', document.edges.length], ['登记工具预设', report.toolPresets], ['新增输入校验', report.validationNodes], ['新增阶段成果', report.stageOutputs], ['保留固定 Skill', report.skillCount], ['保留学习目标', report.learningTargetCount ?? report.learningTargets?.length ?? 0]]) list.append(el('dt', '', label), el('dd', '', value ?? 0));
    this.preview.append(list);
  }
  async confirmSource(session) {
    this.assertCurrent(session);
    const current = savedRecord(await this.api(`/api/workflow-library/${encodeURIComponent(session.sourceId)}`), session.sourceId);
    this.assertCurrent(session);
    if (current.revision !== session.source.revision || documentFingerprint(current.document) !== session.sourceFingerprint) throw new Error('原版保存版本已更新，请关闭窗口并重新预览，再创建新版。');
  }
  candidateRecord(value, session) {
    const record = savedRecord(value, session.candidate.id);
    if (record.id === session.sourceId || documentFingerprint(record.document) !== documentFingerprint(session.candidate)) throw new Error('新版保存回执与本次预览不匹配，请确认保存结果。');
    return record;
  }
  async finish(session, record) {
    session.created = record;
    if (!this.current(session) || session.stale) {
      this.showStatus(session, '新版已保存到看板。当前工作流已变化，因此没有切换画布。');
      this.editor.toast(`新版「${record.document.title}」已保存到看板，当前画布保留。`); return;
    }
    try {
      await this.onCreated(record, { report: session.preview.report, copyInputs: session.options.copyInputs,
        sourceId: session.sourceId, sourceRevision: session.source.revision });
      session.finished = true; this.sessions.delete(session.sourceId);
      // The callback may navigate to the new workflow. Closing belongs to this
      // dialog session only and never dismisses another editor's new dialog.
      if (this.visible(session)) this.dialog.close();
      this.editor.toast('新版工作流已保存；原版与历史记录保留。');
    } catch (error) { this.showStatus(session, `新版已保存，打开失败：${error.message}。可重试打开，不会重复创建。`, true); }
  }
  async confirmSaved(session) {
    try {
      const record = this.candidateRecord(await this.api(`/api/workflow-library/${encodeURIComponent(session.candidate.id)}`), session);
      await this.finish(session, record);
    } catch (error) {
      if (error.httpStatus === 404) { session.retryAllowed = true; this.showStatus(session, '暂未查到此新版。可重试创建同一个新版；不会重新分配节点或工作流 ID。', true); }
      else this.showStatus(session, `保存结果尚未确认：${error.message}。请再次确认，不要重复新建。`, true);
    }
  }
  async submit(session = this.session) {
    if (!session || session.busy || !session.preview || this.session !== session) return false;
    if (session.created) { session.busy = true; try { await this.finish(session, session.created); } finally { session.busy = false; this.renderControls(session); } return; }
    if (session.attempted && !session.retryAllowed) {
      session.busy = true; session.phase = '正在确认保存…'; this.renderControls(session);
      try { await this.confirmSaved(session); } finally { session.busy = false; this.renderControls(session); } return;
    }
    session.busy = true; session.phase = '正在核对原版…'; this.renderControls(session);
    try {
      await this.confirmSource(session);
      // Freeze the exact first POST, including title/options and node IDs.
      // Every retry uses this snapshot, never a newer rendering of the source.
      session.candidate ||= copy(session.preview.document); session.attempted = true; session.retryAllowed = false;
      session.phase = '正在创建新版…'; this.renderControls(session);
      let record;
      try { record = this.candidateRecord(await this.api('/api/workflow-library', { method: 'POST', body: { document: copy(session.candidate), expectedRevision: 0 } }), session); }
      catch (error) { this.showStatus(session, `新版保存尚未确认：${error.message}。请点击“确认保存结果”，原版保持不变。`, true); return false; }
      await this.finish(session, record); return true;
    } catch (error) { session.stale = true; this.showStatus(session, error.message, true); return false; }
    finally { session.busy = false; this.renderControls(session); }
  }
  close() {
    if (this.session?.busy) return false;
    if (this.session && !this.session.attempted) this.sessions.delete(this.session.sourceId);
    if (this.dialog.open) this.dialog.close(); this.syncButtonOnly(); return true;
  }
}
