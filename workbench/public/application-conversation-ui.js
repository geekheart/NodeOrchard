import { WorkflowConversationUI } from './workflow-conversation-ui.js';

// Supervisor topics reuse the workflow conversation view while keeping their
// identities, drafts, pending issues and late responses separate.
export class ApplicationConversationUI extends WorkflowConversationUI {
  constructor(host, { api, getBackend, getPageDiagnostics, conversationId = 'global-application' } = {}) {
    const header = document.createElement('div'); header.className = 'wf-header-actions';
    const body = document.createElement('div'); body.className = 'wf-body'; host.replaceChildren(header, body);
    const facade = { root: host, doc: { id: conversationId, title: conversationId === 'global-application' ? '历史全局对话' : '总控主题', nodes: [], edges: [] }, selection: new Set(), settings: { propertiesClosed: true } };
    const mappedApi = (path, options) => api(path.replace(/^\/api\/workflow-conversations\/([^/]+)/,
      (_, id) => '/api/app-assistant/conversations/' + id), options);
    super(facade, { api: mappedApi, getBackend, getPageDiagnostics });
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
  renderComposerHelp() { if (this.help) { this.help.textContent = '本主题上下文独立。总控可按需查看工作流会话，明确委派独立助手进行只读诊断。说“这个问题解决了”或“不用处理了”结束本主题的事项。'; this.input.placeholder = '例如：检查某个工作流的会话和最近一次错误…'; } }
  onEvent(event) {
    if (event.type !== 'application.conversation') return;
    const id = event.payload?.conversation?.workflowId;
    if (!this.states.has(id)) return;
    try { this.accept(event.payload, id); } catch {}
  }
  async startRun() { this.state().error = '请说明要运行的工作流，或从看板打开它后直接说“运行”。'; this.renderNotice(); return false; }
  render() {
    super.render(); if (!this.panel) return;
    this.runButton.hidden = true;
    const empty = this.messages.querySelector('.wf-conversation-empty');
    if (empty) { empty.querySelector('h3').textContent = '直接描述你遇到的问题'; empty.querySelector('p').textContent = 'AI 可以读取应用状态、运行错误和工具记录，必要时截图或录制复现。'; const suggestion = empty.querySelector('button'); suggestion.textContent = '检查最近一次失败的原因'; suggestion.onclick = null; suggestion.replaceWith(Object.assign(document.createElement('span'), { textContent: '例如：最近一次运行为什么超时？', className: 'wf-conversation-message-scope' })); }
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
