import { validateDocument } from '../shared/workflow/workflow-model.mjs';

const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;
const copy = value => structuredClone(value);
const signature = value => JSON.stringify({ ...validateDocument(value), viewport: null });
const fileName = value => String(value || '工作流').replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').slice(0, 80).replace(/\.workflow$/i, '') + '.workflow';
const element = (tag, className = '', text) => { const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node; };
const button = (label, click, className = 'wf-button') => { const node = element('button', className, label); node.type = 'button'; node.addEventListener('click', click); return node; };

function downloadName(response, title) {
  const value = response.headers?.get('Content-Disposition') || '';
  let name;
  try { name = decodeURIComponent(value.match(/filename\*=UTF-8''([^;]+)/i)?.[1] || ''); } catch { /* Use a safe local filename. */ }
  name ||= value.match(/filename="([^"]+)"/i)?.[1];
  return fileName(name && /\.workflow$/i.test(name) ? name : title);
}
async function isZip(blob) {
  const prefix = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  return prefix.length === 4 && prefix[0] === 0x50 && prefix[1] === 0x4b && prefix[2] === 3 && prefix[3] === 4;
}

// Packaging never invokes an executor. All writes are existing library saves or
// the explicit import request; an imported copy is opened only in its own scope.
export class WorkflowPackageUI {
  constructor(editor, { api, binaryRequest, libraryClient, onOpened = () => {} } = {}) {
    Object.assign(this, { editor, api, binaryRequest, libraryClient, onOpened }); this.pending = false; this.importRequest = null;
  }
  context() { return { id: this.editor.documentLoaded === false ? null : this.editor.doc?.id,
    generation: this.libraryClient.generation, loaded: this.editor.documentLoaded !== false,
    nested: Boolean(this.editor.nodeLibrary?.nested), readonly: Boolean(this.editor.libraryReadOnly) }; }
  sameContext(context) { const current = this.context(); return Object.keys(context).every(key => current[key] === context[key]); }
  assertUsable({ importing = false } = {}) {
    if (!this.libraryClient || typeof this.binaryRequest !== 'function') throw Error('工作流文件功能尚未就绪，请稍后重试。');
    if (this.editor.nodeLibrary?.nested) throw Error('请先应用或取消子流程内部修改，再操作工作流文件。');
    if (!importing && this.editor.documentLoaded === false) throw Error('请先加载工作流。');
    if (importing && this.editor.documentLoaded !== false && this.editor.libraryReadOnly) throw Error('当前工作流为只读，请先返回看板。');
    if (this.editor.active === false && this.editor.documentLoaded !== false) throw Error('请先打开节点编辑器。');
  }
  renderControls() {
    for (const node of this.editor.root?.querySelectorAll?.('[data-action="export"], [data-action="import"], [data-action="open-folder"]') || []) {
      const importing = node.dataset.action === 'import';
      node.disabled = this.pending || Boolean(this.editor.nodeLibrary?.nested)
        || (!importing && this.editor.documentLoaded === false)
        || (importing && this.editor.documentLoaded !== false && this.editor.libraryReadOnly);
      node.setAttribute?.('aria-busy', String(this.pending));
    }
  }
  async operation(action) {
    if (this.pending) return false;
    this.pending = true; this.renderControls();
    try { return await action(); }
    catch (error) { this.status(error.message, true); return false; }
    finally { this.pending = false; this.renderControls(); }
  }
  status(message, error = false) {
    if (this.dialogStatus?.isConnected) { this.dialogStatus.textContent = message; this.dialogStatus.classList.toggle('error', error); }
    this.editor.toast(message, error);
  }
  async saveSnapshot({ properties = false } = {}) {
    const context = this.context(), prepared = properties ? this.editor.prepareRun({ operation: '导出' }) : copy(this.editor.doc);
    const document = this.editor.persistenceDocument?.(prepared) || validateDocument(prepared);
    if (this.editor.persist() === false) throw Error('当前草稿未保存，请先处理本地保存错误；不会导出旧版本。');
    this.libraryClient.queue(document); await this.libraryClient.flush(document.id);
    if (!this.sameContext(context) || signature(this.editor.doc) !== signature(document) || properties && this.editor.propertyDrafts?.size) throw Error('工作流草稿已变化，当前编辑已保留，请重新导出。');
    const slot = this.libraryClient.slot(document.id);
    if (slot.error || !Number.isInteger(slot.revision) || slot.revision < 1) throw Error(slot.error || '工作流保存尚未确认，请稍后重试。');
    return { document, revision: slot.revision, context };
  }
  async exportCurrent() {
    return this.operation(async () => {
      this.assertUsable();
      let saved;
      if (this.editor.libraryReadOnly) {
        const context = this.context(), value = await this.api(`/api/workflow-library/${encodeURIComponent(context.id)}`), record = value.workflow || value;
        if (!this.sameContext(context) || record.id !== context.id || record.document?.id !== record.id) throw Error('工作流已切换，请重新导出。');
        if (!Number.isInteger(record.revision) || record.revision < 1) throw Error('工作流保存版本尚未确认，请稍后重试。');
        saved = { document: validateDocument(record.document), revision: record.revision, context };
      } else saved = await this.saveSnapshot({ properties: true });
      const response = await this.binaryRequest(`/api/workflow-library/${encodeURIComponent(saved.document.id)}/export?expectedRevision=${saved.revision}`);
      const blob = await response.blob();
      if (!this.sameContext(saved.context) || !this.editor.libraryReadOnly && signature(this.editor.doc) !== signature(saved.document)) throw Error('工作流已变化，当前编辑已保留，请重新导出。');
      if (!await isZip(blob)) throw Error('服务未返回有效的工作流压缩包，未下载或回退为 JSON。');
      this.editor.downloadBlob(blob, downloadName(response, saved.document.title)); this.status('已导出工作流文件夹。'); return true;
    });
  }
  async openFolder() {
    return this.operation(async () => {
      this.assertUsable(); let context = this.context();
      if (!this.editor.libraryReadOnly) ({ context } = await this.saveSnapshot());
      if (!this.sameContext(context)) throw Error('工作流已切换，请重新打开文件夹。');
      const result = await this.api(`/api/workflow-library/${encodeURIComponent(context.id)}/folder/open`, { method: 'POST', body: {} });
      if (result.workflowId !== context.id || result.opened !== true) throw Error('文件夹打开结果未确认。');
      if (result.inputSync?.status === 'error') this.status('已打开工作流文件夹；输入素材未完全归集，请检查素材来源。', true);
      else this.status('已打开工作流文件夹。');
      return true;
    });
  }
  async importFile(file) {
    return this.operation(async () => {
      this.assertUsable({ importing: true });
      if (!file || !/\.workflow$/i.test(file.name || '')) throw Error('请选择 .workflow 工作流包。');
      if (file.size > MAX_PACKAGE_BYTES) throw Error('工作流包不能超过 256 MB。');
      if (!await isZip(file)) throw Error('所选文件不是有效的 ZIP 工作流包。');
      const context = this.context(), dialog = this.dialogSession;
      if (context.loaded) { this.libraryClient.rememberCurrent(); await this.libraryClient.flush(context.id); }
      if (!this.sameContext(context)) throw Error('当前工作流已切换，未提交导入。');
      if (this.importRequest?.file !== file) this.importRequest = { file, id: crypto.randomUUID() };
      const request = this.importRequest;
      if (!request.record) {
        this.status('正在导入工作流包…');
        let result;
        try {
          const response = await this.binaryRequest(`/api/workflow-packages/import?filename=${encodeURIComponent(file.name)}`, {
            method: 'POST', body: file, headers: { 'X-Workflow-Import-Id': request.id },
          });
          result = await response.json();
        } catch (error) {
          if (!error.httpStatus || error.httpStatus >= 500) throw Error(`导入结果未确认：${error.message}。可用同一请求重试，当前草稿已保留。`);
          throw error;
        }
        const record = result.workflow;
        if (!record?.id || record.document?.id !== record.id || !Number.isInteger(record.revision) || record.revision < 1) throw Error('导入结果未确认，请使用相同文件重试。');
        validateDocument(record.document);
        if (record.id === context.id) throw Error('导入没有创建独立副本，未替换当前画布。');
        request.record = record; request.warnings = result.warnings || [];
      }
      if (!this.sameContext(context) || dialog?.closed) { this.status('工作流包已导入，可从看板打开新副本。'); return false; }
      this.libraryClient.adopt(request.record);
      if (!await this.libraryClient.open(request.record.id)) { this.status('工作流包已导入，请从看板打开新副本。', true); return false; }
      this.onOpened(request.record.id);
      this.editor.dialog?.close?.(); this.status(request.warnings.length ? `已导入工作流；${request.warnings.join('；')}` : '已导入工作流文件夹并载入新副本。');
      this.importRequest = null; return true;
    });
  }
  openImportDialog() {
    try { this.assertUsable({ importing: true }); } catch (error) { this.status(error.message, true); return false; }
    const dialog = this.editor.openDialog('导入工作流', ''), session = { closed: false }; this.dialogSession = session;
    dialog.addEventListener('close', () => { session.closed = true; }, { once: true });
    const input = element('input'); input.type = 'file'; input.accept = '.workflow'; input.hidden = true; input.setAttribute('aria-label', '选择 .workflow 文件');
    const status = element('p', 'wf-import-feedback'); status.setAttribute('role', 'status'); this.dialogStatus = status;
    const retry = button('重试导入', async () => { if (this.importRequest?.file) await this.importFile(this.importRequest.file); }); retry.hidden = true;
    input.addEventListener('change', async () => { const file = input.files?.[0]; if (!file) return; const ok = await this.importFile(file); retry.hidden = ok || !this.importRequest; input.value = ''; });
    const footer = element('div', 'wf-dialog-actions');
    footer.append(button('兼容 JSON 草稿', () => this.editor.openLegacyImport()), button('取消', () => dialog.close()), retry, button('选择 .workflow 文件', () => input.click(), 'wf-button primary'));
    dialog.append(element('p', '', '载入为新副本，当前工作流保留。'), input, status, footer); return true;
  }
}
