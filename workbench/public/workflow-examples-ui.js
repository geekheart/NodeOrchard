import { validateDocument } from '../shared/workflow/workflow-model.mjs';
import { documentFingerprint, sameDocumentContent } from '../shared/workflow/workflow-conversation-commands.mjs';

const element = (tag, className = '', text) => { const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node; };
const button = (text, action) => { const node = element('button', 'wf-button', text); node.type = 'button'; node.addEventListener('click', action); return node; };
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);

// Preparation reads the fixed catalog and actual dependencies. Only the user's
// selection commits a draft; loading an example never runs or starts learning.
export class WorkflowExamplesUI {
  constructor(editor, { api, getGeneration = () => editor.libraryClient?.generation ?? 0 } = {}) {
    Object.assign(this, { editor, api, getGeneration }); this.session = null;
  }
  source() {
    const editor = this.editor;
    if (editor.documentLoaded === false || !editor.doc || editor.active === false) throw Error('请先打开空白工作流。');
    if (editor.libraryReadOnly) throw Error('当前工作流只读，不能载入示例。');
    if (editor.nodeLibrary?.nested) throw Error('请先退出子流程内部编辑。');
    if (editor.doc.nodes.length || editor.doc.edges.length) throw Error('请先新建空白工作流，再载入示例。');
    if (editor.propertyDrafts?.size || editor.validationDraftErrors?.size || editor.nodeLibrary?.validationBuilderErrors?.size || editor.titleDraft) throw Error('请先应用或取消当前属性与名称修改。');
    if (editor.storageConflict || editor.corruptDraft || editor.saveError || editor.libraryError) throw Error('请先处理当前草稿的保存问题。');
    return editor.doc;
  }
  capture() {
    const document = this.source();
    return { id: document.id, fingerprint: documentFingerprint(document), generation: this.getGeneration(),
      learningDraft: JSON.stringify(this.editor.runtime?.learning?.saveForm?.() ?? null) };
  }
  current(session) {
    try {
      const next = this.capture();
      return this.session === session && !session.closed && Object.keys(session.source).every(key => session.source[key] === next[key]);
    } catch { return false; }
  }
  visible(session) { return this.session === session && !session.closed && session.dialog.open; }
  assertCurrent(session) { if (!this.current(session)) throw Error('当前工作流或草稿已变化，未载入示例。'); }
  appliedCurrent(session, document) {
    const editor = this.editor;
    return (!session.closed || session.finished) && editor.active !== false && editor.documentLoaded !== false && !editor.libraryReadOnly && !editor.nodeLibrary?.nested
      && !editor.propertyDrafts?.size && !editor.validationDraftErrors?.size && !editor.nodeLibrary?.validationBuilderErrors?.size && !editor.titleDraft
      && !editor.storageConflict && !editor.corruptDraft && !editor.saveError && !editor.libraryError
      && this.session === session && editor.doc?.id === session.source.id && this.getGeneration() === session.source.generation
      && documentFingerprint(editor.doc) === documentFingerprint(document);
  }
  recoverable(session) {
    return session.applied && !session.finished && session.prepared && this.appliedCurrent(session, session.prepared.document)
      && session.recoveryDraft === JSON.stringify(this.editor.runtime?.learning?.saveForm?.() ?? null);
  }
  async open() {
    if (this.session?.busy && this.visible(this.session)) return false;
    let source;
    try { source = this.capture(); } catch (error) { this.editor.toast(error.message, true); return false; }
    const dialog = this.editor.openDialog('载入示例', ''), content = element('div', 'wf-example-catalog');
    const session = { source, dialog, content, closed: false, busy: false, catalog: [], message: '', error: false }; this.session = session;
    dialog.addEventListener('close', () => { session.closed = true; }, { once: true }); dialog.append(content);
    return this.loadCatalog(session);
  }
  async loadCatalog(session) {
    if (!this.visible(session) || session.busy) return false;
    session.busy = true; session.message = '正在读取示例…'; session.error = false; this.render(session);
    try {
      const result = await this.api('/api/workflow-examples');
      this.assertCurrent(session);
      if (!Array.isArray(result.examples) || result.examples.length > 50 || result.examples.some(item => !validId(item.id) || !['execute', 'learn'].includes(item.kind) || typeof item.title !== 'string' || !item.title.trim())) throw Error('示例目录响应无效，请重试。');
      session.catalog = result.examples; session.message = session.catalog.length ? '' : '暂无可用示例。'; return true;
    } catch (error) { if (this.visible(session)) { session.message = error.message; session.error = true; } return false; }
    finally { session.busy = false; this.render(session); }
  }
  render(session) {
    if (!this.visible(session)) return;
    const content = session.content; content.replaceChildren(); content.setAttribute('aria-busy', String(session.busy));
    for (const [kind, label] of [['execute', '执行示例'], ['learn', '学习示例']]) {
      const rows = session.catalog.filter(item => item.kind === kind); if (!rows.length) continue;
      const section = element('section', 'wf-example-group'), list = element('div', 'wf-example-grid'); section.append(element('h3', '', label));
      for (const item of rows) { const choose = button(item.title, () => this.prepare(item.id, session)); choose.disabled = session.busy || Boolean(session.applied && item.id !== session.prepared?.example.id); if (item.description) choose.title = item.description; list.append(choose); }
      section.append(list); content.append(section);
    }
    const status = element('p', session.error ? 'wf-example-status error' : 'wf-example-status', session.message); status.setAttribute('role', 'status'); content.append(status);
    const actions = element('div', 'wf-dialog-actions');
    if (session.error && session.applied && session.prepared) actions.append(button('重试完成配置', () => this.prepare(session.prepared.example.id, session)));
    if (session.error && !session.catalog.length) actions.append(button('重试', () => this.loadCatalog(session)));
    actions.append(button('取消', () => session.dialog.close())); content.append(actions);
  }
  async prepare(id, session = this.session) {
    if (!session || !this.visible(session) || session.busy) return false;
    const recovering = Boolean(session.applied);
    try {
      if (recovering) { if (!this.recoverable(session) || session.prepared.example.id !== id) throw Error('已载入的示例或配置草稿已变化，未重试配置。'); }
      else this.assertCurrent(session);
    } catch (error) { session.message = error.message; session.error = true; this.render(session); return false; }
    const example = session.catalog.find(item => item.id === id); if (!example) return false;
    session.busy = true; session.message = '正在准备示例…'; session.error = false; this.render(session);
    try {
      const result = recovering ? session.prepared : await this.api(`/api/workflow-examples/${encodeURIComponent(id)}/prepare`, { method: 'POST', body: { workflowId: session.source.id } });
      if (!recovering) this.assertCurrent(session);
      let document = validateDocument(result.document);
      if (result.example?.id !== id || result.example.kind !== example.kind || document.id !== session.source.id || document.mode !== example.kind || !document.nodes.length
        || typeof result.ready !== 'boolean' || !Array.isArray(result.requirements) || result.requirements.some(item => typeof item !== 'string')) throw Error('示例准备结果与当前工作流不匹配，未载入。');
      const learning = this.editor.runtime?.learning;
      if (document.mode === 'learn' && (!result.learningConfig || typeof learning?.setConfig !== 'function')) throw Error('学习示例配置尚未就绪，请稍后重试。');
      if (!recovering) {
        session.prepared = { example: { id, kind: example.kind }, document: structuredClone(document),
          learningConfig: structuredClone(result.learningConfig), ready: result.ready, requirements: [...result.requirements] };
        if (this.editor.commit(document, '载入示例') === false) throw Error('示例草稿未保存。');
        session.applied = true;
        if (!sameDocumentContent(this.editor.doc, session.prepared.document)) throw Error('已提交的示例内容发生变化，未应用学习配置。');
        document = structuredClone(this.editor.doc); session.prepared.document = structuredClone(document);
        this.editor.settings.propertiesClosed = true; this.editor.applySettings?.();
      }
      await this.editor.runtime?.syncWorkflow?.();
      if (!this.appliedCurrent(session, document)) return false;
      if (document.mode === 'learn') {
        if (learning.workflowId !== document.id) await learning.syncWorkflow?.();
        if (!this.appliedCurrent(session, document)) return false;
        await learning.setConfig(result.learningConfig, { expand: true });
      } else learning?.syncMode?.();
      if (!this.appliedCurrent(session, document)) return false;
      session.finished = true;
      requestAnimationFrame(() => { if (this.appliedCurrent(session, document)) this.editor.fit(); });
      session.dialog.close();
      this.editor.toast(result.ready ? '已载入示例。' : `已载入草稿；${result.requirements.slice(0, 2).join('；') || '请先补齐运行条件。'}`, !result.ready);
      return true;
    } catch (error) {
      if (session.applied) session.recoveryDraft = JSON.stringify(this.editor.runtime?.learning?.saveForm?.() ?? null);
      if (this.visible(session)) { session.message = session.applied ? `示例已载入，配置未完成：${error.message}` : error.message; session.error = true; this.editor.toast(session.message, true); }
      return false;
    } finally { session.busy = false; this.render(session); }
  }
}
