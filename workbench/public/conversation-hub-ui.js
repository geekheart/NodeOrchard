import { safeText } from '../shared/diagnostics.mjs';

const clean = value => safeText(String(value ?? ''));
const node = (tag, className = '', text) => { const value = document.createElement(tag); if (className) value.className = className; if (text !== undefined) value.textContent = clean(text); return value; };
const button = (text, callback, className = 'button quiet') => { const value = node('button', className, text); value.type = 'button'; value.addEventListener('click', callback); return value; };
const link = (href, text, className = '') => { const value = node('a', className, text); value.href = href; return value; };
const count = value => Math.max(0, Number(value) || 0);
const excerpt = value => clean(typeof value === 'string' ? value : value?.text || value?.user?.text || value?.assistant?.text || '').replace(/\s+/g, ' ').slice(0, 180);
const date = value => { const time = new Date(value); return value && !Number.isNaN(time.valueOf()) ? time.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : ''; };
const STATUS = { thinking: '正在回复', queued: '正在准备', proposed: '待应用修改', awaiting_action: '待处理', error: '处理失败', interrupted: '已中断', complete: '已记录', applied: '已应用', dismissed: '已结束事项' };
const summary = row => row.conversation || row;
const visibleConversation = row => row.lifecycle === undefined || row.lifecycle === 'active';

export function filterHubConversations(rows, { query = '', filter = 'all' } = {}) {
  const needle = String(query).trim().toLocaleLowerCase();
  return rows.filter(row => {
    if (!visibleConversation(row)) return false;
    const item = summary(row);
    if (filter === 'pending' && !item.active && !count(item.pendingCount)) return false;
    if (filter === 'active' && !item.active) return false;
    return !needle || [row.title, row.workflowId, row.id, excerpt(item.lastMessage)].some(value => String(value || '').toLocaleLowerCase().includes(needle));
  });
}

// This directory reads existing identities. Opening it never creates a chat,
// changes a workflow, resumes a model, or copies messages between conversations.
export class ConversationHubUI {
  constructor(root, { api, openSupervisor, getSessions = () => [], sessionLink = id => `#/task/${encodeURIComponent(id)}`, onCount = () => {}, readOnly = false } = {}) {
    Object.assign(this, { root, api, openSupervisor, getSessions, sessionLink, onCount, readOnly });
    this.data = null; this.active = false; this.loading = false; this.refreshAgain = false; this.creating = false; this.error = ''; this.query = ''; this.filter = 'all'; this.selected = null; this.createRequest = null; this.timer = null;
    this.mount(); this.render();
  }
  mount() {
    this.toolbar = node('div', 'conversation-hub-toolbar');
    const search = node('label', 'search-field'); this.search = node('input'); this.search.type = 'search'; this.search.placeholder = '搜索工作流或会话'; this.search.setAttribute('aria-label', '搜索对话'); search.append(this.search);
    this.search.addEventListener('input', () => { this.query = this.search.value; this.renderLists(); });
    this.filterInput = node('select'); this.filterInput.setAttribute('aria-label', '筛选对话');
    for (const [value, label] of [['all', '全部'], ['pending', '待处理'], ['active', '正在回复']]) { const option = node('option', '', label); option.value = value; this.filterInput.append(option); }
    this.filterInput.addEventListener('change', () => { this.filter = this.filterInput.value; this.renderLists(); });
    this.refreshButton = button('刷新目录', () => void this.refresh()); this.toolbar.append(search, this.filterInput, this.refreshButton);
    this.status = node('p', 'helper'); this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
    this.supervisorSection = node('section', 'conversation-hub-section'); const supervisorHeading = node('div', 'section-heading'); supervisorHeading.append(node('h2', '', '总控会话'));
    this.createForm = node('form', 'conversation-hub-create'); this.titleInput = node('input'); this.titleInput.maxLength = 120; this.titleInput.placeholder = '会话主题'; this.titleInput.setAttribute('aria-label', '总控会话主题'); this.titleInput.required = true;
    this.createButton = node('button', 'button primary', '新建总控会话'); this.createButton.type = 'submit'; this.createForm.append(this.titleInput, this.createButton); this.createForm.addEventListener('submit', event => { event.preventDefault(); void this.create(); });
    this.supervisorList = node('div', 'conversation-hub-list'); this.supervisorList.setAttribute('aria-label', '总控会话列表'); this.supervisorSection.append(supervisorHeading, this.createForm, this.supervisorList);
    this.workflowSection = node('section', 'conversation-hub-section'); const workflowHeading = node('div', 'section-heading'); workflowHeading.append(node('h2', '', '工作流独立会话'));
    this.workflowList = node('div', 'conversation-hub-list'); this.workflowList.setAttribute('aria-label', '工作流独立会话列表'); this.workflowSection.append(workflowHeading, this.workflowList);
    this.history = node('details', 'conversation-hub-history'); this.historySummary = node('summary', '', '历史任务'); this.historyList = node('div', 'conversation-hub-history-list'); this.history.append(this.historySummary, this.historyList);
    this.root.replaceChildren(this.toolbar, this.status, this.supervisorSection, this.workflowSection, this.history);
  }
  async activate(route = {}) { this.active = true; this.selected = route.id || null; this.render(); await this.refresh({ chooseDefault: !route.id }); }
  deactivate() { this.active = false; clearTimeout(this.timer); this.timer = null; }
  async refresh({ chooseDefault = false } = {}) {
    if (this.loading) { this.refreshAgain = true; return; }
    this.loading = true; this.error = ''; this.render();
    try {
      const result = await this.api('/api/conversation-hub');
      if (!Array.isArray(result?.workflows) || !Array.isArray(result?.supervisors)) throw new Error('对话目录响应不完整。');
      this.data = { ...result, workflows: result.workflows.filter(visibleConversation) };
      this.onCount(this.data.workflows.length + this.data.supervisors.length);
      if (chooseDefault && this.active && !this.selected) {
        const recent = result.supervisors.find(item => !item.legacy) || result.supervisors.find(item => item.legacy && count(item.turnCount));
        if (recent?.id) { this.selected = recent.id; this.openSupervisor(recent.id); }
      }
    } catch (error) { this.error = `目录读取失败：${error.message}`; }
    finally { this.loading = false; this.render(); if (this.refreshAgain && this.active) { this.refreshAgain = false; void this.refresh(); } }
  }
  async create() {
    if (this.readOnly || this.creating) return;
    const title = this.titleInput.value.trim(); if (!title || title.length > 120) return;
    if (!this.createRequest || this.createRequest.title !== title) this.createRequest = { clientConversationId: crypto.randomUUID(), title };
    this.creating = true; this.error = ''; this.render();
    try {
      const result = await this.api('/api/app-assistant/conversations', { method: 'POST', body: { ...this.createRequest } });
      const id = result?.conversation?.id; if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('新会话身份未确认，请按原主题重试。');
      this.titleInput.value = ''; this.createRequest = null; this.selected = id;
      if (this.active) this.openSupervisor(id);
      await this.refresh();
    } catch (error) { this.error = `会话创建未确认：${error.message}`; }
    finally { this.creating = false; this.render(); }
  }
  onEvent(event) {
    if (!this.active || !/^(?:workflow\.|application\.conversation|application\.conversations)/.test(event?.type || '')) return;
    clearTimeout(this.timer); this.timer = setTimeout(() => { this.timer = null; void this.refresh(); }, 180);
  }
  card(row, workflow = false) {
    const item = summary(row), card = node('article', 'conversation-hub-card' + (!workflow && this.selected === row.id ? ' selected' : ''));
    const heading = node('div', 'conversation-hub-card-heading');
    const title = workflow ? link(`#/workflows/${encodeURIComponent(row.workflowId)}`, row.title || '未命名工作流', 'conversation-hub-title')
      : button(row.title || '未命名总控会话', () => { this.selected = row.id; this.openSupervisor(row.id); this.renderLists(); }, 'conversation-hub-title');
    if (!workflow) title.setAttribute('aria-pressed', String(this.selected === row.id));
    heading.append(title);
    const state = item.active ? '正在回复' : count(item.pendingCount) ? `${count(item.pendingCount)} 项待处理` : count(item.turnCount) ? STATUS[item.status] || '已记录' : '尚未开始';
    heading.append(node('span', `status-badge${item.active ? ' running' : count(item.pendingCount) ? ' error' : ''}`, state));
    const meta = node('p', 'conversation-hub-meta', `${workflow ? '独立助手' : row.legacy ? '旧全局记录' : '总控助手'} · ${count(item.turnCount)} 条交流${date(item.updatedAt) ? ' · ' + date(item.updatedAt) : ''}`);
    card.append(heading, meta);
    const message = excerpt(item.lastMessage); if (message) card.append(node('p', 'conversation-hub-excerpt', message));
    if (workflow) card.append(link(`#/workflows/${encodeURIComponent(row.workflowId)}`, '进入独立会话 →', 'conversation-hub-open'));
    return card;
  }
  renderLists() {
    const data = this.data || { workflows: [], supervisors: [] }, options = { query: this.query, filter: this.filter };
    const supervisors = filterHubConversations(data.supervisors, options), workflows = filterHubConversations(data.workflows, options);
    this.supervisorList.replaceChildren(...(supervisors.length ? supervisors.map(row => this.card(row)) : [node('p', 'conversation-hub-empty', this.data ? this.query || this.filter !== 'all' ? '没有符合条件的总控会话。' : '暂无总控会话。' : '正在读取总控会话…')]));
    this.workflowList.replaceChildren(...(workflows.length ? workflows.map(row => this.card(row, true)) : [node('p', 'conversation-hub-empty', this.data ? this.query || this.filter !== 'all' ? '没有符合条件的工作流会话。' : '暂无工作流会话。' : '正在读取工作流会话…')]));
    this.renderHistory();
  }
  renderHistory() {
    const sessions = this.getSessions().filter(session => !session.workflowManaged);
    this.historySummary.textContent = `历史任务 · ${sessions.length}`;
    this.historyList.replaceChildren(...(sessions.length ? sessions.map(session => {
      const row = node('div', 'conversation-hub-history-row'); row.append(link(this.sessionLink(session.id), session.title || '未命名任务'), node('span', 'helper', date(session.updatedAt))); return row;
    }) : [node('p', 'helper', '没有普通任务记录。')]));
  }
  render() {
    this.refreshButton.disabled = this.loading; this.refreshButton.textContent = this.loading ? '正在读取…' : '刷新目录';
    this.titleInput.disabled = this.readOnly || this.creating; this.createButton.disabled = this.readOnly || this.creating; this.createButton.textContent = this.creating ? '创建中…' : '新建总控会话';
    this.status.textContent = this.error || (this.loading ? '正在同步会话目录…' : this.data ? `${this.data.workflows.length} 个工作流独立会话 · ${this.data.supervisors.length} 个总控主题` : '会话目录尚未读取。'); this.status.className = this.error ? 'error-text' : 'helper';
    this.renderLists();
  }
}
