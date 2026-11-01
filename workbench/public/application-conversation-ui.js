import { WorkflowConversationUI } from './workflow-conversation-ui.js';
import { projectMaintenanceTask } from './maintenance-task-ui.js';
import { ConversationReferencesUI } from './conversation-references-ui.js';

const nativeText = value => String(value ?? '').replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[已隐藏密钥]').replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [已隐藏]').replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|authorization)["']?\s*[:=]\s*["']?)([^\s"',;}\]]+)/gi, '$1[已隐藏]').slice(0, 8000);
const nativeElement = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = nativeText(text); return node; };
const nativeIdentifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const nativeActive = (state, request) => state.conversation.turns.some(turn => ['thinking', 'queued'].includes(turn.status) && (!request.turnId || turn.id === request.turnId));

// Supervisor topics reuse the workflow conversation view while keeping their
// identities, drafts, pending issues and late responses separate.
export class ApplicationConversationUI extends WorkflowConversationUI {
  constructor(host, { api, getBackend, getPageDiagnostics, getShortcuts, attachmentsClient, useAttachmentAsInput, conversationId = 'global-application', onNewConversation } = {}) {
    const header = document.createElement('div'); header.className = 'wf-header-actions';
    const body = document.createElement('div'); body.className = 'wf-body'; host.replaceChildren(header, body);
    const facade = { root: host, doc: { id: conversationId, title: conversationId === 'global-application' ? '历史全局对话' : '总控主题', nodes: [], edges: [] }, selection: new Set(), settings: { propertiesClosed: true }, attachmentsClient, useAttachmentAsInput };
    const mappedApi = (path, options) => api(path.replace(/^\/api\/workflow-conversations\/([^/]+)/,
      (_, id) => '/api/app-assistant/conversations/' + id), options);
    super(facade, { api: mappedApi, getBackend, getPageDiagnostics, getShortcuts, attachmentsClient, attachmentScope: 'supervisor' });
    this.panel.setAttribute('aria-label', '总控助手对话'); this.panel.querySelector('h2').textContent = '总控助手';
    this.input.setAttribute('aria-label', '给总控助手的消息'); this.runButton.hidden = true;
    this.sendButton.setAttribute('aria-label', '发送总控消息'); this.messages.setAttribute('aria-label', '总控主题对话记录');
    this.openButton.textContent = '打开总控对话';
    this.onNewConversation = onNewConversation; this.newConversationButton = document.createElement('button'); this.newConversationButton.type = 'button'; this.newConversationButton.className = 'wf-conversation-icon'; this.newConversationButton.textContent = '新会话'; this.newConversationButton.title = '开启新会话并归档当前会话'; this.newConversationButton.addEventListener('click', () => { if (!this.newConversationButton.disabled) void this.onNewConversation?.(this.workflowId); }); this.panel.querySelector('.wf-conversation-heading')?.append(this.newConversationButton);
    this.referencePicker = new ConversationReferencesUI(this); const composer = this.panel.querySelector('.wf-conversation-composer'); if (composer?.insertBefore) composer.insertBefore(this.referencePicker.element, this.input); else composer?.append(this.referencePicker.element);
    this.nativeRequestsHost = nativeElement('section', 'wf-conversation-pending'); this.nativeRequestsHost.setAttribute('aria-label', 'Hermes 待处理请求'); this.nativeRequestsHost.hidden = true;
    if (composer && this.panel.insertBefore) this.panel.insertBefore(this.nativeRequestsHost, composer); else this.panel.append(this.nativeRequestsHost);
    this.renderNativeRequests();
  }
  state(id = this.workflowId) { const state = super.state(id); state.nativeRequests ||= []; state.nativeRequestRows ||= new Map(); state.nativeRequestSettled ||= new Set(); return state; }
  async selectConversation(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw new Error('总控会话编号无效。');
    if (this.workflowId !== id) {
      this.editor.doc = { id, title: this.states.get(id)?.conversation?.title || (id === 'global-application' ? '历史全局对话' : '总控主题'), nodes: [], edges: [] };
      this.syncWorkflow();
    }
    const current = this.state(id).conversation; this.editor.libraryReadOnly = current.lifecycle === 'archived' || current.readOnly === true;
    this.toggle(true);
    if (!this.state(id).loading) await this.load();
  }
  accept(snapshot, id = this.workflowId) {
    if ((snapshot.conversation?.lifecycleRevision || 0) < Math.max(this.state(id).conversation.lifecycleRevision || 0, this.state(id).expectedLifecycleRevision || 0)) return false;
    const accepted = super.accept(snapshot, id), state = this.state(id);
    if (accepted && Array.isArray(snapshot.nativeRequests) && (snapshot.nativeRequestsRevision === undefined || snapshot.nativeRequestsRevision >= (state.nativeRequestsRevision || 0))) {
      state.nativeRequests = snapshot.nativeRequests.filter(request => nativeIdentifier(request?.id) && ['approval', 'clarify'].includes(request.method)).slice(0, 16);
      if (Number.isSafeInteger(snapshot.nativeRequestsRevision)) state.nativeRequestsRevision = snapshot.nativeRequestsRevision;
    }
    if (accepted && id === this.workflowId) { this.editor.libraryReadOnly = snapshot.conversation?.lifecycle === 'archived' || snapshot.conversation?.readOnly === true; this.render(); this.renderNativeRequests(); }
    if (id === this.workflowId && snapshot.conversation?.title) { this.editor.doc.title = snapshot.conversation.title; this.renderContext(); }
    return accepted;
  }
  messageExtras(state) { const references = this.referencePicker?.references(state) || []; return references.length ? { conversationReferences: references } : {}; }
  consumeMessageExtras(state, request) { this.referencePicker?.consume(state, request); }
  restoreMessageExtras(turn, state) { this.referencePicker?.restore(turn, state); }
  messageExtrasView(turn) { return turn.user?.conversationReferences?.length ? this.referencePicker?.messageView(turn.user.conversationReferences) : null; }
  nativeArtifactsView(turn, conversationId = this.workflowId) {
    if (!nativeIdentifier(conversationId) || !nativeIdentifier(turn?.id) || !Array.isArray(turn.assistant?.nativeArtifacts)) return null;
    const host = nativeElement('div', 'wf-conversation-artifacts'), seen = new Set();
    for (const artifact of turn.assistant.nativeArtifacts.slice(0, 16)) {
      if (!/^artifact-[a-f0-9]{64}$/.test(artifact?.id || '') || seen.has(artifact.id) || !/^[a-f0-9]{64}$/.test(artifact.sha256 || '') || !Number.isSafeInteger(artifact.size) || artifact.size < 0 || artifact.size > 25 * 1024 * 1024) continue;
      const url = `/api/app-assistant/conversations/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(turn.id)}/artifacts/${artifact.id}`;
      if (artifact.url !== url) continue; seen.add(artifact.id);
      const filename = nativeText(artifact.name || '产物文件').slice(0, 180), card = nativeElement('figure', 'wf-conversation-artifact');
      if (['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(artifact.mimeType)) {
        const preview = nativeElement('a'), image = nativeElement('img'); preview.setAttribute('href', url); preview.setAttribute('target', '_blank'); preview.setAttribute('rel', 'noopener'); image.setAttribute('src', url); image.setAttribute('alt', filename); image.setAttribute('loading', 'lazy'); image.setAttribute('decoding', 'async'); preview.append(image); card.append(preview);
      }
      card.append(nativeElement('figcaption', '', filename));
      const footer = nativeElement('div', 'wf-conversation-artifact-footer'), download = nativeElement('a', 'wf-conversation-link', '下载'); download.setAttribute('href', url); download.setAttribute('download', filename); footer.append(download); card.append(footer); host.append(card);
    }
    return host.children.length ? host : null;
  }
  turnView(turn, latest = false) {
    const node = super.turnView(turn, latest), artifacts = this.nativeArtifactsView(turn);
    if (artifacts) (node.querySelector('.wf-conversation-message.is-assistant') || node).append(artifacts);
    return node;
  }
  describeContext() { return [this.editor.doc.title || '总控主题']; }
  getContext() { return {}; }
  isMaintenanceSupervisor() { return true; }
  renderComposerHelp() { this.input.placeholder = '输入消息'; }
  async load(force = false) {
    const id = this.workflowId, state = id && this.state(id); if (!state) return; if (state.loading) { if (force) state.forceConversationRefresh = true; return; }
    const refresh = force || state.maintenancePermissionsDirty === true || state.forceConversationRefresh === true; state.maintenancePermissionsDirty = false; state.forceConversationRefresh = false;
    try { return await super.load(refresh); }
    finally { if ((state.maintenancePermissionsDirty || state.forceConversationRefresh) && this.workflowId === id && !state.loading) void this.load(true); }
  }
  onEvent(event) {
    if (event.type === 'application.conversations.updated') { const id = event.payload?.conversationId; if (this.states.has(id)) { const state = this.state(id); const revision = event.payload.lifecycleRevision || 0; if (revision < Math.max(state.expectedLifecycleRevision || 0, state.conversation.lifecycleRevision || 0)) return; state.expectedLifecycleRevision = revision; if (['active', 'archived'].includes(event.payload.lifecycle)) state.conversation = { ...state.conversation, lifecycle: event.payload.lifecycle, lifecycleRevision: revision, archivedAt: event.payload.archivedAt || null, ...(typeof event.payload.readOnly === 'boolean' ? { readOnly: event.payload.readOnly } : {}) }; state.forceConversationRefresh = true; if (id === this.workflowId) { this.editor.libraryReadOnly = state.conversation.lifecycle === 'archived' || state.conversation.readOnly === true; this.render(); void this.load(true); } } return; }
    if (event.type === 'application.maintenance') { this.acceptMaintenanceEvent(event.payload); return; }
    if (event.type === 'assistant.permissions.updated') {
      for (const state of this.states.values()) if (state.maintenanceTasks?.size || state.conversation.turns.some(turn => turn.assistant?.maintenanceTask)) state.maintenancePermissionsDirty = true;
      if (this.workflowId && this.state().maintenancePermissionsDirty) void this.load(true);
      return;
    }
    if (event.type !== 'application.conversation') return;
    const id = event.payload?.conversation?.workflowId;
    if (!this.states.has(id)) return;
    try { this.accept(event.payload, id); } catch {}
  }
  currentMaintenanceTask(value) {
    if (value.conversationId !== this.workflowId || !this.states.has(value.conversationId)) return null;
    const state = this.state(value.conversationId), task = projectMaintenanceTask(state.maintenanceTasks?.get(value.id)
      || state.conversation.turns.find(turn => turn.assistant?.maintenanceTask?.id === value.id)?.assistant.maintenanceTask);
    return task?.conversationId === value.conversationId && task.revision === value.revision ? task : null;
  }
  async continueMaintenanceTask(value) {
    const task = this.currentMaintenanceTask(value); if (!task?.canContinue) return false;
    const state = this.state();
    if (state.sending || !state.loaded || this.editor.libraryReadOnly || state.conversation.turns.some(turn => ['thinking', 'queued'].includes(turn.status))) return false;
    const retry = state.retry?.context?.maintenanceTaskId === task.id ? state.retry : null;
    const request = retry || { clientMessageId: crypto.randomUUID(), intent: 'auto',
      text: `继续修复维护任务 ${task.id}；仅在当前权限内推进，保留原工作流`, context: { maintenanceTaskId: task.id }, page: this.getPageDiagnostics?.() || {} };
    await this.send(request); return !state.retry;
  }
  async stopMaintenanceTask(value, turnId) {
    const task = this.currentMaintenanceTask(value); if (!task?.canStop || this.editor.libraryReadOnly) return false;
    const id = task.conversationId, key = `${id}:${task.id}:stop-maintenance`; if (this.actionPending.has(key)) return false;
    this.actionPending.add(key); this.state(id).error = ''; this.render();
    try {
      const result = await this.api(`/api/workflow-conversations/${encodeURIComponent(id)}/turns/${encodeURIComponent(turnId || task.sourceTurnId)}/action`, {
        method: 'POST', body: { action: 'stop-maintenance', taskId: task.id, expectedRevision: task.revision },
      });
      if (result?.conversation) this.accept(result, id);
      else if (result?.task) this.acceptMaintenanceEvent({ conversationId: id, task: result.task });
      else throw new Error('维护状态未确认，请刷新对话。');
      return true;
    } catch (error) { this.state(id).error = error.message; if (this.workflowId === id) this.renderNotice(); return false; }
    finally { this.actionPending.delete(key); if (this.workflowId === id) this.render(); }
  }
  async startRun() { this.state().error = '请先打开要运行的工作流。'; this.renderNotice(); return false; }
  render() {
    super.render(); if (!this.panel) return;
    this.runButton.hidden = true;
    const state = this.state(), locked = this.editor.libraryReadOnly === true;
    this.input.disabled = locked; this.fileAttachments.control.hidden = locked; this.referencePicker?.render();
    if (this.newConversationButton) this.newConversationButton.disabled = state.sending || state.conversation.turns.some(turn => ['thinking', 'queued'].includes(turn.status));
    if (state.conversation.lifecycle === 'archived') this.subtitle.textContent = '已归档';
    this.renderNativeRequests();
  }
  renderNativeRequests() {
    if (!this.nativeRequestsHost || !this.workflowId) return;
    const owner = this.workflowId, state = this.state(owner), requests = state.nativeRequests.filter(request => !state.nativeRequestSettled.has(request.id)), ids = new Set(requests.map(request => request.id));
    for (const id of state.nativeRequestRows.keys()) if (!ids.has(id)) state.nativeRequestRows.delete(id);
    const cards = [];
    for (const request of requests) {
      const signature = JSON.stringify([request.method, request.params || {}, request.turnId || null]); let row = state.nativeRequestRows.get(request.id);
      if (!row || row.signature !== signature) { row = this.nativeRequestView(request, owner); row.signature = signature; state.nativeRequestRows.set(request.id, row); }
      const disabled = state.conversation.lifecycle === 'archived' || state.conversation.readOnly === true || !nativeActive(state, request) || this.actionPending.has(`${owner}:native:${request.id}`);
      for (const control of row.controls) control.disabled = disabled || control.nativeUnavailable === true;
      cards.push(row.card);
    }
    const previous = this.nativeRequestsHost.nativeCards || [];
    if (cards.length !== previous.length || cards.some((card, index) => card !== previous[index])) { this.nativeRequestsHost.replaceChildren(...cards); this.nativeRequestsHost.nativeCards = cards; }
    this.nativeRequestsHost.hidden = cards.length === 0;
  }
  nativeRequestView(request, owner = this.workflowId) {
    const params = request.params || {}, card = nativeElement('article', 'wf-conversation-pending-item'), controls = [];
    card.setAttribute('aria-label', request.method === 'approval' ? '执行审批' : '需要补充信息');
    card.append(nativeElement('strong', '', request.method === 'approval' ? '执行审批' : '需要补充信息'));
    const action = (label, run, className = 'wf-button') => { const control = nativeElement('button', className, label); control.type = 'button'; control.addEventListener('click', run); controls.push(control); return control; };
    if (request.method === 'approval') {
      if (params.description) card.append(nativeElement('p', 'wf-conversation-prose', params.description));
      if (params.command !== undefined) { const command = typeof params.command === 'string' ? params.command : JSON.stringify(params.command, null, 2); card.append(nativeElement('pre', 'wf-conversation-prose', command)); }
      const actions = nativeElement('div', 'wf-conversation-actions');
      for (const [choice, label] of [['once', '仅允许这一次'], ['deny', '拒绝']]) {
        const control = action(label, () => { if (!control.disabled) void this.replyNativeRequest(owner, request.id, { choice }); });
        control.nativeUnavailable = Array.isArray(params.choices) && !params.choices.includes(choice); actions.append(control);
      }
      card.append(actions);
    } else {
      const form = nativeElement('form'), readers = [], questions = Array.isArray(params.questions) ? params.questions.slice(0, 16) : [{ question: params.question, choices: params.choices, multi_select: params.multi_select }];
      for (const [index, question] of questions.entries()) {
        const fieldset = nativeElement('fieldset', 'question'), text = question.question || `问题 ${index + 1}`; fieldset.append(nativeElement('legend', '', text));
        const selections = [];
        if (Array.isArray(question.choices)) for (const choice of question.choices.slice(0, 24)) {
          const label = nativeElement('label', 'choice-option'), input = nativeElement('input'); input.type = question.multi_select ? 'checkbox' : 'radio'; input.name = `native-${request.id}-${index}`; input.value = String(choice); controls.push(input); selections.push(input); label.append(input, nativeElement('span', '', choice)); fieldset.append(label);
        }
        const answer = nativeElement('textarea'); answer.rows = 2; answer.maxLength = 8000; answer.placeholder = selections.length ? '补充说明' : '回答'; answer.setAttribute('aria-label', `回答：${text}`);
        if (typeof params.answers?.[question.qid] === 'string') answer.value = params.answers[question.qid]; controls.push(answer); fieldset.append(answer); form.append(fieldset);
        readers.push({ qid: question.qid, answer, read() { const typed = answer.value.trim(), chosen = selections.filter(input => input.checked).map(input => input.value).join('、'); return question.multi_select ? [chosen, typed].filter(Boolean).join('\n') : typed || chosen; } });
      }
      const submit = nativeElement('button', 'wf-button primary', '提交回答'); submit.type = 'submit'; controls.push(submit); form.append(submit);
      form.addEventListener('submit', event => {
        event.preventDefault(); event.stopPropagation?.(); if (submit.disabled) return;
        if (!readers.length || readers.some(reader => !reader.read()) || Array.isArray(params.questions) && readers.some(reader => !nativeIdentifier(reader.qid))) { this.state(owner).error = '请填写每个问题的回答。'; if (owner === this.workflowId) this.renderNotice(); return; }
        void this.replyNativeRequest(owner, request.id, Array.isArray(params.questions) ? { answers: Object.fromEntries(readers.map(reader => [reader.qid, reader.read()])) } : { answer: readers[0].read() });
      });
      card.append(form);
    }
    return { card, controls };
  }
  async replyNativeRequest(owner, requestId, body) {
    if (owner !== this.workflowId || !nativeIdentifier(requestId)) return false;
    const state = this.state(owner), request = state.nativeRequests.find(value => value.id === requestId), key = `${owner}:native:${requestId}`;
    if (!request || state.nativeRequestSettled.has(requestId) || state.conversation.lifecycle === 'archived' || state.conversation.readOnly === true || !nativeActive(state, request) || this.actionPending.has(key)) return false;
    this.actionPending.add(key); state.error = ''; this.renderNativeRequests();
    try {
      const result = await this.api(`/api/app-assistant/conversations/${encodeURIComponent(owner)}/requests/${encodeURIComponent(requestId)}`, { method: 'POST', body });
      if (!result?.conversation || result.conversation.workflowId !== owner) throw new Error('请求状态未确认，请刷新对话。');
      state.nativeRequestSettled.add(requestId); this.accept(result, owner); return true;
    } catch (error) { state.error = nativeText(error.message); if (owner === this.workflowId) this.renderNotice(); return false; }
    finally { this.actionPending.delete(key); if (owner === this.workflowId) this.renderNativeRequests(); }
  }
  proposalView(turn) {
    const conversationId = this.workflowId;
    const box = document.createElement('section'); box.className = 'wf-conversation-proposal';
    const details = document.createElement('details'), summary = document.createElement('summary'), code = document.createElement('pre');
    summary.textContent = '查看工作流修改'; code.textContent = JSON.stringify(turn.assistant.operations, null, 2); details.append(summary, code); box.append(details);
    const button = document.createElement('button'); button.className = 'wf-button primary'; button.type = 'button'; button.textContent = turn.outcome?.applied ? '已应用' : '应用工作流修改'; button.disabled = turn.status !== 'proposed' || this.editor.libraryReadOnly;
    button.addEventListener('click', async () => { button.disabled = true; try { this.accept(await this.api(`/api/workflow-conversations/${encodeURIComponent(conversationId)}/turns/${turn.id}/action`, { method: 'POST', body: { action: 'mark-applied' } }), conversationId); } catch (error) { this.state(conversationId).error = error.message; if (this.workflowId === conversationId) this.renderNotice(); button.disabled = false; } }); box.append(button);
    if (turn.assistant.targetWorkflowId) { const link = document.createElement('a'); link.className = 'wf-conversation-link'; link.href = `#/workflows/${encodeURIComponent(turn.assistant.targetWorkflowId)}`; link.textContent = '查看工作流'; box.append(link); }
    return box;
  }
}
