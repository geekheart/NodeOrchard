import { WorkflowConversationUI } from './workflow-conversation-ui.js';
import { projectMaintenanceTask } from './maintenance-task-ui.js';

// Supervisor topics reuse the workflow conversation view while keeping their
// identities, drafts, pending issues and late responses separate.
export class ApplicationConversationUI extends WorkflowConversationUI {
  constructor(host, { api, getBackend, getPageDiagnostics, getShortcuts, attachmentsClient, useAttachmentAsInput, conversationId = 'global-application' } = {}) {
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
  }
  async selectConversation(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw new Error('总控会话编号无效。');
    if (this.workflowId !== id) {
      this.editor.doc = { id, title: this.states.get(id)?.conversation?.title || (id === 'global-application' ? '历史全局对话' : '总控主题'), nodes: [], edges: [] };
      this.syncWorkflow();
    }
    this.toggle(true);
    if (!this.state(id).loading) await this.load();
  }
  accept(snapshot, id = this.workflowId) {
    const accepted = super.accept(snapshot, id);
    if (id === this.workflowId && snapshot.conversation?.title) { this.editor.doc.title = snapshot.conversation.title; this.renderContext(); }
    return accepted;
  }
  describeContext() { return [this.editor.doc.title || '总控主题']; }
  getContext() { return {}; }
  isMaintenanceSupervisor() { return true; }
  renderComposerHelp() { this.input.placeholder = '输入消息'; }
  async load(force = false) {
    const id = this.workflowId, state = id && this.state(id); if (!state || state.loading) return;
    const refresh = force || state.maintenancePermissionsDirty === true; state.maintenancePermissionsDirty = false;
    try { return await super.load(refresh); }
    finally { if (state.maintenancePermissionsDirty && this.workflowId === id && !state.loading) void this.load(true); }
  }
  onEvent(event) {
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
  }
  proposalView(turn) {
    const conversationId = this.workflowId;
    const box = document.createElement('section'); box.className = 'wf-conversation-proposal';
    const details = document.createElement('details'), summary = document.createElement('summary'), code = document.createElement('pre');
    summary.textContent = '查看工作流修改'; code.textContent = JSON.stringify(turn.assistant.operations, null, 2); details.append(summary, code); box.append(details);
    const button = document.createElement('button'); button.className = 'wf-button primary'; button.type = 'button'; button.textContent = turn.outcome?.applied ? '已应用' : '应用工作流修改'; button.disabled = turn.status !== 'proposed';
    button.addEventListener('click', async () => { button.disabled = true; try { this.accept(await this.api(`/api/workflow-conversations/${encodeURIComponent(conversationId)}/turns/${turn.id}/action`, { method: 'POST', body: { action: 'mark-applied' } }), conversationId); } catch (error) { this.state(conversationId).error = error.message; if (this.workflowId === conversationId) this.renderNotice(); button.disabled = false; } }); box.append(button);
    if (turn.assistant.targetWorkflowId) { const link = document.createElement('a'); link.className = 'wf-conversation-link'; link.href = `#/workflows/${encodeURIComponent(turn.assistant.targetWorkflowId)}`; link.textContent = '查看工作流'; box.append(link); }
    return box;
  }
}
