const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };

export class ToolApprovalsUI {
  constructor(chat) { this.chat = chat; this.rows = new Map(); this.settled = new Set(); this.host = el('section', undefined, 'wf-conversation-pending'); this.host.setAttribute('aria-label', '外部工具审批'); this.host.hidden = true; }
  render() {
    const chat = this.chat, owner = chat.workflowId; if (!owner) { this.host.hidden = true; return; }
    const state = chat.state(owner), requests = (state.toolRequests || []).filter(row => row.owner === owner && row.status === 'pending' && !this.settled.has(row.id));
    const cards = requests.slice(0, 16).map(request => {
      const available = () => {
        const current = chat.state(owner);
        return chat.workflowId === owner && !chat.editor?.libraryReadOnly && current.conversation.lifecycle !== 'archived' && current.conversation.readOnly !== true
          && (current.toolRequests || []).some(row => row.id === request.id && row.revision === request.revision && row.status === 'pending')
          && (!request.turnId || current.conversation.turns.some(turn => turn.id === request.turnId && ['thinking', 'queued'].includes(turn.status)));
      };
      const key = owner + ':' + request.id + ':' + request.revision; let row = this.rows.get(key);
      if (row) { for (const control of row.approvalControls || []) control.disabled = !available() || row.approvalSending === true; return row; }
      row = el('article', undefined, 'wf-conversation-pending-item'); row.append(el('strong', request.title || '外部工具调用'));
      const details = el('details', undefined, 'wf-tool-approval-details'); details.append(el('summary', '操作参数'), el('pre', JSON.stringify(request.details || {}, null, 2))); row.append(details);
      const actions = el('div', undefined, 'wf-conversation-actions'), status = el('p');
      const controls = [];
      for (const [choice, label] of [['once', '仅允许这一次'], ['deny', '拒绝']]) {
        const control = el('button', label, 'wf-button'); control.type = 'button'; controls.push(control);
        control.addEventListener('click', async () => {
          if (!available() || controls.some(button => button.disabled)) return; row.approvalSending = true; controls.forEach(button => { button.disabled = true; }); status.textContent = '';
          try { await chat.api(`/api/tool-approvals/${encodeURIComponent(owner)}/${encodeURIComponent(request.id)}`, { method: 'POST', body: { expectedRevision: request.revision, choice } }); this.settled.add(request.id); }
          catch (error) { status.textContent = error.message; }
          finally { row.approvalSending = false; controls.forEach(button => { button.disabled = !available(); }); }
          if (chat.workflowId === owner) { this.render(); void chat.load(true); }
        }); actions.append(control);
      }
      row.approvalControls = controls; for (const control of controls) control.disabled = !available();
      row.append(actions, status); this.rows.set(key, row); return row;
    });
    this.host.replaceChildren(...cards); this.host.hidden = cards.length === 0;
  }
}
