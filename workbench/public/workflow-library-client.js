import { createDocument, validateDocument } from '../shared/workflow/workflow-model.mjs';

const ACK_KEY = 'workbench.workflow-library-ack.v1';
const DRAFT_PREFIX = 'workbench.workflow-document.v1:';
const copy = value => structuredClone(value);
const signature = document => JSON.stringify(document);
const content = document => JSON.stringify({ ...document, viewport: null });
const unwrap = value => value?.workflow || value;
const lifecycle = record => record?.lifecycle === 'archived' ? 'trashed' : ['active', 'trashed', 'deleted'].includes(record?.lifecycle) ? record.lifecycle : 'active';

// Each asset keeps its own acknowledgement and queue. A late save never changes
// the canvas that the user has since opened, and a conflict never overwrites it.
export class WorkflowLibraryClient {
  constructor(editor, { api, onDocumentChange = () => {}, onSaved = () => {} }) {
    this.editor = editor; this.api = api; this.onDocumentChange = onDocumentChange; this.onSaved = onSaved;
    this.slots = new Map(); this.states = new Map(); this.generation = 0; this.suppressed = false; this.openRequest = null; this.hasLeftEditor = false;
    this.initialDraft = editor.storageValue && !editor.corruptDraft ? copy(editor.doc) : null;
    try { this.acknowledgements = JSON.parse(localStorage.getItem(ACK_KEY) || '{}'); } catch { this.acknowledgements = {}; }
    if (!this.acknowledgements || typeof this.acknowledgements !== 'object' || Array.isArray(this.acknowledgements)) this.acknowledgements = {};
    this.originalAcks = { ...this.acknowledgements };
    editor.onPersist = document => this.queue(document);
  }
  slot(id) {
    if (!this.slots.has(id)) this.slots.set(id, { revision: 0, saved: null, queued: null, pending: null, error: '', lifecycle: 'active', epoch: 0, refreshRequired: false });
    return this.slots.get(id);
  }
  documentId() { return this.editor.nodeLibrary?.rootDocument?.id || this.editor.doc.id; }
  adopt(record) {
    if (!record?.id || record.document?.id !== record.id || !Number.isInteger(record.revision)) throw new Error('工作流保存记录无效。');
    const slot = this.slot(record.id);
    if (record.revision < slot.revision) return record;
    slot.revision = record.revision; slot.saved = signature(record.document); slot.error = ''; slot.lifecycle = lifecycle(record);
    if (slot.lifecycle !== 'active') slot.queued = null;
    // Startup may have queued a draft before writes were ready. An exact server
    // acknowledgement satisfies that draft; a different local draft stays queued.
    if (slot.queued && signature(slot.queued) === slot.saved) slot.queued = null;
    this.acknowledgements[record.id] = record.revision;
    try { localStorage.setItem(ACK_KEY, JSON.stringify(this.acknowledgements)); } catch { /* Browser cache is optional after a database acknowledgement. */ }
    return record;
  }
  setEditorLifecycle(value) {
    if (this.editor.setLibraryLifecycle) this.editor.setLibraryLifecycle(value);
    else this.editor.libraryLifecycle = value;
  }
  async handleLifecycle(payload) {
    const value = unwrap(payload), id = value?.id;
    if (!id) return false;
    const slot = this.slot(id), next = payload?.deleted || value.deleted ? 'deleted' : lifecycle(value);
    if (Number.isInteger(value.revision) && value.revision < slot.revision) return false;
    if (Number.isInteger(value.revision) && value.revision === slot.revision && next === slot.lifecycle && !slot.refreshRequired) return true;
    slot.epoch++; slot.revision = Math.max(slot.revision, value.revision || 0); slot.lifecycle = next; slot.queued = null; slot.error = '';
    slot.refreshRequired = next === 'active'; slot.wasInactive = true;
    if (this.documentId() !== id || (this.openRequest && this.openRequest.id !== id)) return true;
    // A previous canvas remains mounted while navigation loads its replacement.
    // Lifecycle events still update that workflow's slot, but cannot navigate
    // back to it or cancel the controller's newer open request.
    if (next === 'active' && (this.hasLeftEditor || this.editor.active === false)) return true;
    // An active event is only permission to fetch the latest revision, never to
    // publish an old cached draft using its freshly learned acknowledgement.
    this.setEditorLifecycle(next === 'active' ? 'trashed' : next); this.status();
    if (next === 'active') {
      // The current navigation owns its loading indicator. Let its bounded
      // epoch retry fetch this revision without creating a second generation.
      if (this.openRequest?.id === id) return true;
      try { return await this.open(id); }
      catch (error) { this.editor.toast('恢复状态尚未确认，请回看板重新打开。' + error.message, true); return false; }
    }
    return true;
  }
  status() {
    const slot = this.slots.get(this.documentId());
    this.editor.libraryError = slot?.error || '';
    this.editor.libraryStatus = slot?.lifecycle !== undefined && slot.lifecycle !== 'active' ? '只读 · 本地未同步草稿保留'
      : slot?.refreshRequired ? '正在读取恢复后的最新版本…' : slot?.error ? '看板保存失败 · 本地保留' : slot?.queued || slot?.pending ? '正在同步到看板…' : slot?.saved ? '已保存 · 工作流看板' : '';
    this.editor.renderHeader();
  }
  queue(document) {
    if (this.suppressed) return;
    if (this.editor.nodeLibrary?.nested && document.id !== this.documentId()) return;
    const slot = this.slot(document.id), next = signature(document);
    if (slot.lifecycle !== 'active' || slot.refreshRequired || (this.editor.doc.id === document.id && this.editor.libraryLifecycle && this.editor.libraryLifecycle !== 'active')) { slot.queued = null; this.status(); return; }
    this.currentId = document.id;
    if (next === slot.saved && !slot.queued) { this.status(); return; }
    slot.queued = copy(document);
    this.onDocumentChange(document.id);
    if (slot.error) { this.status(); return; }
    void this.flush(document.id).catch(() => {});
  }
  flush(id = this.documentId()) {
    const slot = this.slot(id);
    if (slot.lifecycle !== 'active' || slot.refreshRequired) { slot.queued = null; return slot.pending || Promise.resolve(); }
    if (slot.pending) return slot.pending;
    if (!slot.queued) return Promise.resolve();
    slot.pending = Promise.resolve().then(async () => {
      while (slot.queued) {
        if (slot.lifecycle !== 'active' || slot.refreshRequired) { slot.queued = null; break; }
        const document = slot.queued; slot.queued = null;
        const epoch = slot.epoch;
        try {
          const record = unwrap(await this.api('/api/workflow-library', { method: 'POST', body: { document, expectedRevision: slot.revision } }));
          if (epoch !== slot.epoch || record.revision < slot.revision || slot.lifecycle !== 'active' || slot.refreshRequired) continue;
          this.adopt(record); this.onSaved(record);
        } catch (error) {
          if (epoch !== slot.epoch || slot.lifecycle !== 'active' || slot.refreshRequired) { slot.queued = null; break; }
          if (error.httpStatus === 410) { await this.handleLifecycle({ id, deleted: true }); break; }
          slot.queued ||= document; slot.error = error.message || '同步未确认，请保留本地草稿或导出 JSON。';
          throw error;
        }
      }
    }).finally(() => {
      slot.pending = null;
      // A new draft can arrive after the loop empties but before this promise
      // settles. Start that tail without automatically retrying failed saves.
      if (slot.queued && !slot.error) return this.flush(id);
      this.status();
    });
    this.status(); return slot.pending;
  }
  async initialize() {
    if (this.initializing) return this.initializing;
    this.initializing = this.migrateInitial().catch(error => { this.initializing = null; throw error; });
    return this.initializing;
  }
  async migrateInitial() {
    const document = this.initialDraft; if (!document) return;
    const slot = this.slot(document.id), epoch = slot.epoch;
    let record;
    try { record = unwrap(await this.api(`/api/workflow-library/${encodeURIComponent(document.id)}`)); }
    catch (error) {
      if (error.httpStatus === 410) { await this.handleLifecycle({ id: document.id, deleted: true }); this.use(document, undefined, { persist: false }); return; }
      if (error.httpStatus !== 404) throw error;
    }
    if (slot.epoch !== epoch) return;
    this.use(await this.reconcile(document, record, this.originalAcks[document.id]));
  }
  cached(id) {
    let raw;
    try { raw = localStorage.getItem(DRAFT_PREFIX + id); } catch { return null; }
    if (!raw) return null;
    try {
      const record = JSON.parse(raw), document = validateDocument(record.document);
      if (record.version !== 1 || document.id !== id) throw new Error('文档不匹配');
      return document;
    } catch { throw new Error('这条流程的本地草稿无法读取，已保留原始数据，请先备份本地草稿。'); }
  }
  async reconcile(document, record, acknowledgement) {
    if (record && lifecycle(record) !== 'active') {
      this.adopt(record); this.slot(record.id).wasInactive = true;
      return record.document;
    }
    if (!record || record.origin === 'history' || content(record.document) === content(document) || acknowledgement === record.revision) {
      if (record) this.adopt(record);
      if (!record || record.origin === 'history' || signature(record.document) !== signature(document)) {
        this.slot(document.id).queued = copy(document); await this.flush(document.id);
      }
      return document;
    }
    // Save a divergent draft separately before replacing any browser cache.
    this.adopt(record);
    const recovered = { ...document, id: createDocument().id, title: `${document.title.slice(0, 112)}（本地恢复）` };
    this.slot(recovered.id).queued = recovered; await this.flush(recovered.id);
    try { localStorage.setItem(DRAFT_PREFIX + record.id, JSON.stringify({ version: 1, document: record.document, savedAt: new Date().toISOString() })); } catch { /* The recovered copy is already durable in SQLite. */ }
    this.editor.toast('发现不同的已保存版本，本地草稿已保留为独立恢复副本。');
    return recovered;
  }
  use(document, state, { persist = true } = {}) {
    this.suppressed = true;
    this.setEditorLifecycle(this.slot(document.id).lifecycle);
    try { this.editor.useDocument(document, state, { persist: persist && this.slot(document.id).lifecycle === 'active' }); } finally { this.suppressed = false; }
    this.currentId = document.id; this.status();
  }
  async create() {
    await this.initialize();
    const document = createDocument({ title: '新工作流', schemaVersion: 2 });
    this.slot(document.id).queued = document; await this.flush(document.id);
    return document.id;
  }
  rememberCurrent() {
    this.editor.nodeLibrary?.cancelNestedForExternalChange?.();
    this.editor.cancelGesture(); this.editor.cancelConnection();
    const slot = this.slot(this.editor.doc.id);
    if (slot.lifecycle === 'active' && !slot.refreshRequired && this.editor.persist() === false) {
      const slot = this.slot(this.editor.doc.id);
      slot.queued = copy(this.editor.doc); slot.error ||= '本地缓存尚未确认，当前编辑已保留，请保存或导出。';
    }
    this.states.set(this.editor.doc.id, this.editor.captureDocumentState());
  }
  async open(id) {
    const generation = ++this.generation;
    const request = { id }; this.openRequest = request; this.hasLeftEditor = false;
    try {
      await this.initialize();
      if (generation !== this.generation) return false;
      const same = this.currentId === id && this.editor.doc.id === id;
      if (this.currentId && !same) {
        this.rememberCurrent();
        try { await this.flush(this.editor.doc.id); }
        catch { this.editor.toast('这条流程尚未同步，本地草稿已保留；切回后可继续编辑或导出。', true); }
      }
      if (generation !== this.generation) return false;
      const local = this.slot(id);
      for (let attempt = 0; attempt < 3; attempt++) {
        const acknowledgement = this.acknowledgements[id], epoch = local.epoch;
        let record;
        try { record = unwrap(await this.api(`/api/workflow-library/${encodeURIComponent(id)}`)); }
        catch (error) {
          if (generation !== this.generation) return false;
          // A delayed 410/404 belongs to the revision read before the event.
          // In particular, it cannot turn a freshly restored workflow deleted.
          if (epoch !== local.epoch) continue;
          if (error.httpStatus === 410) {
            const cached = same ? this.editor.doc : this.cached(id);
            await this.handleLifecycle({ id, deleted: true });
            if (generation !== this.generation) return false;
            if (cached) { this.use(cached, undefined, { persist: false }); return true; }
            throw error;
          }
          if (error.httpStatus !== 404 || !this.cached(id)) throw error;
        }
        if (generation !== this.generation) return false;
        if (epoch !== local.epoch) continue;
        if (record && record.revision < local.revision) throw new Error('尚未读到工作流最新版本，请稍后重新打开。');
        if (record && lifecycle(record) !== 'active') {
          this.adopt(record); local.wasInactive = true; local.refreshRequired = false;
          this.use(record.document, undefined, { persist: false }); return true;
        }
        if (local.refreshRequired || local.wasInactive) {
          if (!record) throw new Error('恢复后的工作流文档尚未确认。');
          this.adopt(record); local.refreshRequired = false; local.wasInactive = false;
          this.use(record.document, undefined, { persist: false }); return true;
        }
        if (local.queued && local.error) { this.use(copy(local.queued), this.states.get(id)); return true; }
        if (same && record && record.revision === local.revision) { this.status(); return true; }
        const cached = same ? copy(this.editor.doc) : this.cached(id);
        const document = cached ? await this.reconcile(cached, record, acknowledgement) : this.adopt(record).document;
        if (generation !== this.generation) return false;
        if (epoch !== local.epoch) continue;
        this.use(document, this.states.get(id)); return true;
      }
      throw new Error('工作流状态在打开期间持续变化，请点击重试或回看板重新打开；本地草稿已保留。');
    } finally {
      if (this.openRequest === request) this.openRequest = null;
    }
  }

  leave() {
    this.generation++; this.openRequest = null; this.hasLeftEditor = true;
    if (!this.currentId) return;
    this.rememberCurrent();
  }
}
