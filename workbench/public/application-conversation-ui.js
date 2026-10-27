import { WorkflowConversationUI } from './workflow-conversation-ui.js';

// Reuse the same conversation component outside the editor. There is no
// second assistant, mode picker, or separate diagnostic feedback form.
export class ApplicationConversationUI extends WorkflowConversationUI {
  constructor(host, { api, getBackend, getPageDiagnostics } = {}) {
    const header = document.createElement('div'); header.className = 'wf-header-actions';
    const body = document.createElement('div'); body.className = 'wf-body'; host.replaceChildren(header, body);
    const facade = { root: host, doc: { id: 'global-application', title: '当前应用', nodes: [], edges: [] }, selection: new Set(), settings: { propertiesClosed: true } };
    const mappedApi = (path, options) => api(path.replace('/api/workflow-conversations/global-application', '/api/app-assistant'), options);
    super(facade, { api: mappedApi, getBackend, getPageDiagnostics });
    this.panel.setAttribute('aria-label', '总控助手对话'); this.panel.querySelector('h2').textContent = '总控助手';
    this.input.setAttribute('aria-label', '给总控助手的消息'); this.runButton.hidden = true;
  }
  describeContext() { return ['当前应用']; }
  getContext() { return {}; }
  renderComposerHelp() { if (this.help) { this.help.textContent = '总控助手会按当前权限读取跨工作流状态、运行记录及页面证据。说“这个问题解决了”或“不用处理了”结束对应聊天事项。'; this.input.placeholder = '例如：帮我检查最近一次运行为什么失败…'; } }
  onEvent(event) { if (event.type === 'application.conversation') { try { this.accept(event.payload); } catch {} } }
  async startRun() { this.state().error = '请说明要运行的工作流，或从看板打开它后直接说“运行”。'; this.renderNotice(); return false; }
  render() {
    super.render(); if (!this.panel) return;
    this.runButton.hidden = true;
    const empty = this.messages.querySelector('.wf-conversation-empty');
    if (empty) { empty.querySelector('h3').textContent = '直接描述你遇到的问题'; empty.querySelector('p').textContent = 'AI 可以读取应用状态、运行错误和工具记录，必要时截图或录制复现。'; const suggestion = empty.querySelector('button'); suggestion.textContent = '检查最近一次失败的原因'; suggestion.onclick = null; suggestion.replaceWith(Object.assign(document.createElement('span'), { textContent: '例如：最近一次运行为什么超时？', className: 'wf-conversation-message-scope' })); }
  }
  proposalView(turn) {
    const box = document.createElement('section'); box.className = 'wf-conversation-proposal';
    const details = document.createElement('details'), summary = document.createElement('summary'), code = document.createElement('pre');
    summary.textContent = '查看工作流修改'; code.textContent = JSON.stringify(turn.assistant.operations, null, 2); details.append(summary, code); box.append(details);
    const button = document.createElement('button'); button.className = 'wf-button primary'; button.type = 'button'; button.textContent = turn.outcome?.applied ? '已应用' : '应用工作流修改'; button.disabled = turn.status !== 'proposed';
    button.addEventListener('click', async () => { button.disabled = true; try { this.accept(await this.api(`/api/workflow-conversations/global-application/turns/${turn.id}/action`, { method: 'POST', body: { action: 'mark-applied' } })); } catch (error) { this.state().error = error.message; this.renderNotice(); button.disabled = false; } }); box.append(button);
    if (turn.assistant.targetWorkflowId) { const link = document.createElement('a'); link.className = 'wf-conversation-link'; link.href = `#/workflows/${encodeURIComponent(turn.assistant.targetWorkflowId)}`; link.textContent = '查看工作流'; box.append(link); }
    return box;
  }
}
