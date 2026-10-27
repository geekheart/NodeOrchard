import { createWorkflowIcon } from './workflow-toolbar-controls.js';

const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const reference = item => ({ id: item.id, workflowId: item.workflowId });
const identity = item => `${item.workflowId}:${item.id}`;
const fileList = data => Array.from(data?.files || []).length ? Array.from(data.files)
  : Array.from(data?.items || []).filter(item => item.kind === 'file').map(item => item.getAsFile?.()).filter(Boolean);
function localPath(value) {
  if (typeof value !== 'string' || /[\x00\r\n]/.test(value)) return null;
  if (/^file:/i.test(value)) {
    try { const url = new URL(value); if (url.hostname && url.hostname !== 'localhost' || url.search || url.hash) return null; return localPath(decodeURIComponent(url.pathname)); } catch { return null; }
  }
  return /^(?:\/|[A-Za-z]:[\\/])/.test(value) ? value : null;
}
function explicitPaths(data) {
  const types = Array.from(data?.types || []), type = types.includes('text/uri-list') ? 'text/uri-list' : types.includes('Files') ? 'text/plain' : null;
  return type ? String(data.getData?.(type) || '').split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(localPath).filter(Boolean) : [];
}
const element = (tag, className = '', text) => { const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node; };
const button = (label, action, className = 'wf-conversation-link') => { const node = element('button', className, label); node.type = 'button'; node.addEventListener('click', action); return node; };
const image = type => /^image\/(?:png|jpeg|gif|webp|avif|bmp)$/i.test(type || '');
const attachmentURL = item => `/api/workflow-library/${encodeURIComponent(item.workflowId)}/attachments/${encodeURIComponent(item.id)}/content`;

// Draft entries belong to the captured conversation state. A late response can
// finish that entry, but cannot attach it to whichever conversation is now open.
export class ConversationAttachments {
  constructor(owner, { scope = 'workflow', client } = {}) {
    Object.assign(this, { owner, scope, client }); this.metadata = new Map(); this.requests = new WeakMap(); this.workflows = []; this.metadataReads = new Map(); this.previewURLs = new Set();
  }
  getClient() { return this.owner.editor.attachmentsClient || this.client; }
  entries(state = this.owner.state()) { return state.attachmentDrafts ||= []; }
  referencesFrom(attachments = []) { return [...new Map(attachments.filter(item => validId(item.id) && validId(item.workflowId)).map(item => [identity(item), reference(item)])).values()]; }
  references(state = this.owner.state()) {
    return this.referencesFrom(this.entries(state).filter(item => item.status === 'ready').map(item => item.attachment));
  }
  blocked(state = this.owner.state()) { return this.entries(state).some(item => item.status !== 'ready'); }
  trackRequest(state, request) {
    if (this.requests.has(request)) return;
    const references = new Set((request.attachments || []).map(identity));
    this.requests.set(request, new Set(this.entries(state).filter(item => item.status === 'ready' && references.has(identity(item.attachment))).map(item => item.key)));
  }
  consumeRequest(state, request) {
    const keys = this.requests.get(request); if (!keys) return;
    for (const entry of this.entries(state)) if (keys.has(entry.key)) this.releasePreview(entry);
    state.attachmentDrafts = this.entries(state).filter(item => !keys.has(item.key)); this.requests.delete(request); this.changed(state);
  }
  restore(attachments = [], state = this.owner.state()) {
    for (const entry of this.entries(state)) this.releasePreview(entry);
    state.attachmentDrafts = attachments.filter(item => validId(item.id) && validId(item.workflowId)).map(attachment => {
      this.metadata.set(identity(attachment), { ...this.metadata.get(identity(attachment)), ...attachment });
      return { key: crypto.randomUUID(), workflowId: attachment.workflowId, name: attachment.name || this.metadata.get(identity(attachment))?.name || '已保存素材', status: 'ready', attachment: this.metadata.get(identity(attachment)) };
    });
    if (this.scope === 'supervisor' && state.attachmentDrafts.length) state.attachmentWorkflowId = state.attachmentDrafts[0].workflowId;
    this.changed(state);
  }
  remove(key, state = this.owner.state()) {
    this.releasePreview(this.entries(state).find(item => item.key === key));
    state.attachmentDrafts = this.entries(state).filter(item => item.key !== key); this.owner.clearRetryTarget?.(state); this.changed(state);
  }
  async retry(key, state = this.owner.state()) {
    const entry = this.entries(state).find(item => item.key === key);
    if (!entry || !entry.workflowId || entry.status === 'ready' || this.owner.editor.libraryReadOnly || this.owner.editor.nodeLibrary?.nested) return false;
    await this.save(entry, state); return entry.status === 'ready';
  }
  changed(state) {
    if (!this.owner.destroyed && this.owner.workflowId && state === this.owner.state()) { this.render?.(); this.owner.updateSendButton?.(); }
  }
  capture() {
    if (this.owner.destroyed || !this.owner.workflowId || this.owner.editor.libraryReadOnly || this.owner.editor.nodeLibrary?.nested) return null;
    const state = this.owner.state();
    return { state, workflowId: this.scope === 'supervisor' ? state.attachmentWorkflowId || null : this.owner.currentDocument()?.id };
  }
  async loadWorkflows() {
    if (this.loadingWorkflows) return this.loadingWorkflows;
    this.loadingWorkflows = (async () => {
      try {
        const client = this.getClient(); if (!client?.api) throw Error('附件功能尚未就绪，请稍后重试。');
        const result = await client.api('/api/workflow-library');
        this.workflows = (result.workflows || []).filter(item => validId(item.id) && (!item.lifecycle || item.lifecycle === 'active'));
        this.workflowsError = '';
      } catch (error) { this.workflowsError = error.message; }
      finally { this.workflowsLoaded = true; this.loadingWorkflows = null; if (this.owner.workflowId) this.changed(this.owner.state()); }
    })();
    return this.loadingWorkflows;
  }
  async selectWorkflow(id) {
    const captured = this.capture(); if (!captured || this.scope !== 'supervisor') return false;
    const { state } = captured;
    if (!this.workflows.some(item => item.id === id)) return false;
    if (this.entries(state).some(item => item.workflowId && item.workflowId !== id)) return false;
    state.attachmentWorkflowId = id;
    const entries = this.entries(state).filter(item => item.status === 'target');
    for (const entry of entries) entry.workflowId = id;
    this.changed(state); await Promise.all(entries.map(entry => this.save(entry, state))); return true;
  }
  async paste(event) {
    return this.receive(event.clipboardData, event);
  }
  async drop(event) { return this.receive(event.dataTransfer, event); }
  async receive(data, event) {
    if (!this.capture()) return false;
    const files = fileList(data), paths = files.length ? [] : explicitPaths(data); if (!files.length && !paths.length) return false;
    event.preventDefault(); event.stopPropagation?.();
    if (files.length) await this.addFiles(files); else await this.addReferences(paths);
    return true;
  }
  async addFiles(files) {
    return this.add(Array.from(files).map(file => ({ file, path: localPath(file.path), name: file.name || '粘贴的文件' })));
  }
  async addReferences(paths) {
    return this.add(paths.map(localPath).filter(Boolean).map(path => ({ path, name: path.split(/[\\/]/).at(-1) || '本地文件' })));
  }
  async add(sources) {
    const captured = this.capture(); if (!captured) return false;
    const { state, workflowId } = captured;
    this.owner.clearRetryTarget?.(state);
    const entries = sources.map(source => ({ ...source, key: crypto.randomUUID(), operationId: crypto.randomUUID(), workflowId, status: workflowId ? 'uploading' : 'target' }));
    this.entries(state).push(...entries); this.changed(state);
    await Promise.all(entries.filter(item => item.workflowId).map(item => this.save(item, state))); return true;
  }
  async save(entry, state) {
    const attempt = entry.attempt = (entry.attempt || 0) + 1; entry.status = 'uploading'; entry.error = ''; this.changed(state);
    try {
      const client = this.getClient(); if (!client?.binaryRequest) throw Error('附件功能尚未就绪，请稍后重试。');
      const base = `/api/workflow-library/${encodeURIComponent(entry.workflowId)}/attachments`;
      const result = entry.path ? await client.api(base + '/reference', { method: 'POST', body: { path: entry.path, operationId: entry.operationId } })
        : await (await client.binaryRequest(`${base}?filename=${encodeURIComponent(entry.name)}`, {
        method: 'POST', body: entry.file, headers: { 'Content-Type': 'application/octet-stream', 'X-Workflow-Attachment-Id': entry.operationId },
      })).json();
      const attachment = result.attachment || result;
      if (!validId(attachment.id) || attachment.workflowId !== entry.workflowId) throw Error('附件保存结果未确认，请重试同一附件。');
      if (entry.attempt !== attempt || !this.entries(state).includes(entry)) return;
      this.metadata.set(identity(attachment), attachment); entry.attachment = attachment; entry.status = 'ready'; this.releasePreview(entry);
    } catch (error) { if (entry.attempt === attempt && this.entries(state).includes(entry)) { entry.status = 'error'; entry.error = error.message; } }
    finally { this.changed(state); }
  }
  mount({ input, dropZone }) {
    this.host = element('div', 'wf-conversation-attachments'); this.host.setAttribute('aria-label', '消息附件');
    this.control = element('span', 'wf-conversation-attachment-control');
    this.fileInput = element('input'); this.fileInput.type = 'file'; this.fileInput.multiple = true; this.fileInput.hidden = true;
    this.fileInput.setAttribute('aria-label', '选择图片或文件');
    this.fileInput.addEventListener('change', () => { const files = Array.from(this.fileInput.files || []); this.fileInput.value = ''; void this.addFiles(files); });
    this.addButton = button('', () => { if (this.scope === 'supervisor') void this.loadWorkflows(); this.fileInput.click(); }, 'wf-button wf-conversation-attach');
    this.addButton.title = '添加图片或文件'; this.addButton.setAttribute('aria-label', '添加图片或文件'); this.addButton.append(createWorkflowIcon('upload')); this.control.append(this.addButton, this.fileInput);
    input.addEventListener('paste', event => void this.paste(event));
    dropZone.addEventListener('dragover', event => {
      const types = Array.from(event.dataTransfer?.types || []); if (!this.capture() || !types.some(type => ['Files', 'text/uri-list'].includes(type))) return;
      event.preventDefault(); event.stopPropagation?.(); dropZone.classList.add('is-file-dragging');
    });
    dropZone.addEventListener('dragleave', event => { if (!dropZone.contains?.(event.relatedTarget)) dropZone.classList.remove('is-file-dragging'); });
    dropZone.addEventListener('drop', event => { dropZone.classList.remove('is-file-dragging'); void this.drop(event); });
    return this;
  }
  render() {
    if (!this.host || !this.owner.workflowId) return;
    const state = this.owner.state(), entries = this.entries(state), locked = !this.capture();
    this.host.replaceChildren(); this.host.hidden = !entries.length && this.scope !== 'supervisor'; this.addButton.disabled = locked;
    if (this.scope === 'supervisor') {
      const select = element('select', 'wf-conversation-attachment-target'); select.setAttribute('aria-label', '素材保存到工作流');
      const prompt = element('option', '', this.loadingWorkflows ? '正在读取工作流…' : '素材保存到…'); prompt.value = ''; select.append(prompt);
      for (const workflow of this.workflows) { const option = element('option', '', workflow.title || workflow.document?.title || '未命名工作流'); option.value = workflow.id; select.append(option); }
      select.value = state.attachmentWorkflowId || ''; select.disabled = locked || entries.some(item => item.workflowId);
      select.addEventListener('change', () => void this.selectWorkflow(select.value)); this.host.append(select);
      if (this.workflowsError) this.host.append(element('p', 'wf-conversation-error', this.workflowsError));
      if (!this.workflowsLoaded && !this.loadingWorkflows) void this.loadWorkflows();
    }
    for (const entry of entries) {
      const card = entry.status === 'ready' ? this.card(entry.attachment, state) : element('div', 'wf-conversation-attachment');
      if (entry.status !== 'ready') {
        if (image(entry.file?.type) && typeof URL.createObjectURL === 'function') {
          if (!entry.previewURL) { entry.previewURL = URL.createObjectURL(entry.file); this.previewURLs.add(entry.previewURL); }
          const preview = element('img'); preview.src = entry.previewURL; preview.alt = entry.name; card.append(preview);
        }
        card.append(element('span', 'wf-conversation-attachment-name', entry.name), element('span', entry.status === 'error' ? 'wf-conversation-error' : 'wf-conversation-message-scope', entry.status === 'target' ? '请选择保存工作流' : entry.status === 'error' ? entry.error : '正在保存…'));
        if (entry.workflowId) card.append(button('重试保存', () => void this.retry(entry.key, state)));
      }
      const remove = button('×', () => this.remove(entry.key, state), 'wf-conversation-attachment-remove'); remove.title = `移除${entry.name}`; remove.setAttribute('aria-label', remove.title); card.append(remove); this.host.append(card);
    }
  }
  card(attachment, state) {
    const item = { ...this.metadata.get(identity(attachment)), ...attachment }, card = element('div', 'wf-conversation-attachment');
    this.metadata.set(identity(item), item);
    const link = element('a', 'wf-conversation-attachment-name', item.name || '已保存素材'); link.href = attachmentURL(item); link.target = '_blank'; link.rel = 'noopener'; link.title = item.path || item.name || '';
    if (image(item.mimeType)) { const preview = element('img'); preview.src = link.href; preview.alt = item.name || '图片附件'; preview.loading = 'lazy'; card.append(preview); }
    card.append(link);
    const actions = element('div', 'wf-conversation-attachment-actions');
    const copy = button('复制路径', async () => { try { await navigator.clipboard.writeText(item.path); copy.textContent = '已复制'; } catch (error) { this.error(state, `复制路径失败：${error.message}`); } }); copy.disabled = !item.path;
    const use = button('用作输入', async () => { try { await this.owner.editor.useAttachmentAsInput(item); } catch (error) { this.error(state, `绑定输入失败：${error.message}`); } }); use.disabled = !item.path || typeof this.owner.editor.useAttachmentAsInput !== 'function' || !this.capture();
    actions.append(copy, use); card.append(actions);
    if (!item.path) void this.hydrate(item.workflowId, state);
    return card;
  }
  messageView(attachments = [], state = this.owner.state()) {
    const host = element('div', 'wf-conversation-attachments is-message');
    for (const item of attachments) if (validId(item.id) && validId(item.workflowId)) host.append(this.card(item, state));
    return host;
  }
  async hydrate(workflowId, state) {
    const client = this.getClient(); if (!client?.api || this.metadataReads.has(workflowId)) return;
    this.metadataReads.set(workflowId, true);
    try {
      const result = await client.api(`/api/workflow-library/${encodeURIComponent(workflowId)}/attachments`);
      for (const item of result.attachments || []) if (validId(item.id) && item.workflowId === workflowId) this.metadata.set(identity(item), item);
      if (!this.owner.destroyed && this.owner.workflowId && state === this.owner.state()) this.owner.render();
    } catch { /* History references remain visible when metadata is unavailable. */ }
  }
  error(state, message) { state.error = message; if (!this.owner.destroyed && this.owner.workflowId && state === this.owner.state()) this.owner.renderNotice(); }
  releasePreview(entry) { if (entry?.previewURL) { URL.revokeObjectURL(entry.previewURL); this.previewURLs.delete(entry.previewURL); delete entry.previewURL; } }
  destroy() { for (const url of this.previewURLs) URL.revokeObjectURL(url); this.previewURLs.clear(); }
}
