const GROUPS = [
  { id: 'draft', title: '待完善', hint: '补齐节点与配置' },
  { id: 'ready', title: '可运行', hint: '已具备执行条件' },
  { id: 'running', title: '运行中', hint: '执行或学习正在进行' },
  { id: 'attention', title: '需处理', hint: '检查异常或人工请求' },
];
const STATES = new Set(GROUPS.map(item => item.id));
const LIFECYCLES = [
  { id: 'active', title: '工作流', hint: '可编辑和运行的工作流。先归档，再移入回收站，最后才能永久删除。' },
  { id: 'archived', title: '已归档', hint: '已停用关联定时任务。可恢复到工作流，或移入回收站；历史运行和已生成文件保留。' },
  { id: 'trashed', title: '回收站', hint: '可恢复为已归档，或永久删除流程定义。历史运行和已生成文件保留。' },
];
const LIFECYCLE_ACTIONS = {
  archive: { label: '归档工作流', confirm: '确认归档', target: 'archived', description: '归档后收起此工作流并停用关联定时任务；运行历史和已生成文件保留。恢复时不会自动启用定时任务。', success: '工作流已归档，关联定时任务已停用。' },
  unarchive: { label: '恢复到工作流', confirm: '确认恢复', target: 'active', description: '恢复后可编辑和运行。之前停用的定时任务仍需手动启用。', success: '已恢复到工作流；定时任务保持停用。' },
  trash: { label: '移入回收站', confirm: '移入回收站', target: 'trashed', description: '此工作流已归档。移入回收站后仍可恢复，运行历史和已生成文件保留。', success: '工作流已移入回收站。' },
  restore: { label: '恢复到已归档', confirm: '确认恢复', target: 'archived', description: '恢复为已归档。需要再恢复到工作流，才可编辑和运行；定时任务保持停用。', success: '已恢复到已归档。' },
  purge: { label: '永久删除工作流', confirm: '永久删除', target: 'deleted', description: '永久删除此工作流的流程定义，无法恢复。运行历史和已生成文件保留。', success: '工作流定义已永久删除；运行历史和已生成文件保留。' },
};
const ACTIVE_RUNS = new Set(['queued', 'preparing', 'running', 'waiting_review', 'waiting']);
const ACTIVE_LEARNING = new Set(['queued', 'preparing', 'running', 'waiting', 'waiting_review']);
export function workflowLifecycle(summary) { return summary?.lifecycle === undefined ? 'active' : LIFECYCLES.some(item => item.id === summary?.lifecycle) ? summary.lifecycle : 'unknown'; }
export function workflowLifecycleActions(summary) { const value = workflowLifecycle(summary); return value === 'active' ? ['archive'] : value === 'archived' ? ['unarchive', 'trash'] : value === 'trashed' ? ['restore', 'purge'] : []; }
function busyWorkflow(summary) { return summary?.state === 'running' || ACTIVE_RUNS.has(summary?.latestRun?.status) || ACTIVE_LEARNING.has(summary?.latestLearning?.status); }
const RUN = { queued: '排队中', waiting_review: '待审核', preparing: '准备中', running: '运行中', waiting: '等待人工处理', complete: '已完成', error: '失败', interrupted: '已停止', unknown: '状态待确认' };
const LEARNING = { running: '学习中', waiting: '等待人工处理', complete: '本次达标', exhausted: '未达目标', interrupted: '已停止', unknown: '状态待确认', error: '失败' };
const clean = value => String(value ?? '').replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[已隐藏密钥]').replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [已隐藏]').replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|authorization)["']?\s*[:=]\s*["']?)([^\s"',;}\]]+)/gi, '$1[已隐藏]');
const element = (tag, className = '', value) => { const item = document.createElement(tag); if (className) item.className = className; if (value !== undefined) item.textContent = clean(value); return item; };
const button = (label, action, className = 'button') => { const item = element('button', className, label); item.type = 'button'; item.addEventListener('click', action); return item; };
function icon(name) {
  const paths = { search: 'm21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0', plus: 'M12 5v14M5 12h14', refresh: 'M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0 1 13-3l2 3M4 16l2 3a8 8 0 0 0 13-3', workflow: 'M3 3h6v6H3zM15 15h6v6h-6zM6 9v9h9M15 3h6v6h-6zM9 6h6', clock: 'M12 7v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0' };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); for (const [key, value] of Object.entries({ class: 'icon', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.65', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', paths[name] || paths.workflow); svg.append(path); return svg;
}
function time(value) { if (!value) return ''; const date = new Date(value); if (!Number.isFinite(date.valueOf())) return ''; return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }); }
function count(value, label) { return Number.isInteger(value) && value >= 0 ? `${value} ${label}` : `${label}未采集`; }

export function workflowBoardState(summary) { return STATES.has(summary?.state) ? summary.state : 'attention'; }
export function filterWorkflowBoard(workflows, search = '', state = 'all') {
  const query = search.trim().toLocaleLowerCase();
  return workflows.filter(item => (state === 'all' || workflowBoardState(item) === state) && (!query || `${item.title || ''} ${Array.isArray(item.skillNames) ? item.skillNames.join(' ') : ''}`.toLocaleLowerCase().includes(query)));
}
function eventProjection(event) {
  const payload = event.payload || {};
  if (event.type === 'workflow.lifecycle') return ['lifecycle', payload.workflow?.id || payload.id, JSON.stringify(payload.workflow || payload)];
  if (event.type === 'workflow.document') return ['document', payload.workflow?.id || payload.id, JSON.stringify(payload.workflow || payload)];
  if (event.type === 'workflow.run') { const run = payload.run || payload; return ['run', run.id, JSON.stringify([run.workflowId, run.status, run.error, run.startedAt, run.completedAt])]; }
  if (event.type === 'learning.run') { const job = payload.learning || payload.job || payload; return ['learning', job.id, JSON.stringify([job.workflowId, job.status, job.phase, job.error, job.bestRound, job.bestScore, job.startedAt, job.completedAt])]; }
  if (event.type === 'workflow.schedule') { const schedule = payload.schedule || payload; return ['schedule', schedule.id, JSON.stringify([schedule.deleted, schedule.workflowId, schedule.revision, schedule.enabled, schedule.nextRunAt, schedule.lastTrigger])]; }
  return null;
}

export class WorkflowBoard {
  constructor(container, { api, onOpen, onCreate, getRequests = () => [], taskURL }) {
    this.container = container; this.api = api; this.onOpen = onOpen; this.onCreate = onCreate; this.getRequests = getRequests; this.taskURL = taskURL;
    this.active = false; this.workflows = []; this.cards = new Map(); this.pendingCards = new Map(); this.columns = new Map(); this.projections = new Map();
    this.lifecycle = 'active'; this.lifecycleTabs = new Map(); this.openMenu = null; this.dialog = null;
    this.loading = false; this.loaded = false; this.creating = false; this.opening = new Set(); this.eventRevision = 0; this.requestSequence = 0; this.reloadNeeded = false; this.reloadTimer = null; this.loadPromise = null;
    this.mount(); this.render();
  }
  mount() {
    this.root = element('div', 'workflow-board');
    const header = element('header', 'wf-board-header'), titleGroup = element('div', 'wf-board-title-group'); titleGroup.append(icon('workflow'), element('h1', '', '工作流看板')); this.total = element('span', 'wf-board-total'); titleGroup.append(this.total);
    this.newButton = button('新建工作流', () => void this.create(), 'button primary'); this.newButton.prepend(icon('plus')); header.append(titleGroup, this.newButton);
    this.tabs = element('div', 'wf-board-tabs'); this.tabs.setAttribute('role', 'tablist'); this.tabs.setAttribute('aria-label', '工作流归档与回收站');
    for (const item of LIFECYCLES) {
      const tab = button('', () => this.selectLifecycle(item.id), 'wf-board-tab'); tab.setAttribute('role', 'tab'); const label = element('span', '', item.title), total = element('span', 'wf-board-tab-count', '—'); tab.append(label, total);
      tab.addEventListener('keydown', event => { const index = LIFECYCLES.findIndex(value => value.id === item.id); const next = event.key === 'ArrowRight' ? (index + 1) % LIFECYCLES.length : event.key === 'ArrowLeft' ? (index + LIFECYCLES.length - 1) % LIFECYCLES.length : event.key === 'Home' ? 0 : event.key === 'End' ? LIFECYCLES.length - 1 : -1; if (next < 0) return; event.preventDefault?.(); this.selectLifecycle(LIFECYCLES[next].id); this.lifecycleTabs.get(LIFECYCLES[next].id).tab.focus(); });
      this.tabs.append(tab); this.lifecycleTabs.set(item.id, { tab, total });
    }
    this.lifecycleHint = element('p', 'wf-board-lifecycle-hint');
    const toolbar = element('div', 'wf-board-toolbar'), searchLabel = element('label', 'wf-board-search'); this.search = element('input'); this.search.type = 'search'; this.search.placeholder = '搜索名称或 Skill'; this.search.setAttribute('aria-label', '搜索工作流名称或 Skill'); searchLabel.append(icon('search'), this.search);
    const filterLabel = element('label', 'wf-board-filter'); this.filterLabel = filterLabel; filterLabel.append(element('span', '', '状态')); this.filter = element('select'); this.filter.setAttribute('aria-label', '筛选工作流状态');
    for (const [id, title] of [['all', '全部状态'], ...GROUPS.map(item => [item.id, item.title])]) { const option = element('option', '', title); option.value = id; this.filter.append(option); } this.filter.value = 'all'; filterLabel.append(this.filter);
    this.filterContext = element('div', 'wf-board-filter-context'); this.filterContext.hidden = true;
    this.filterHint = element('span', 'wf-board-filter-hint'); this.clearFilterButton = button('清除筛选', () => this.clearFilters(), 'button small wf-board-clear-filters'); this.clearFilterButton.title = '清空搜索和状态筛选，保留当前页签'; this.filterContext.append(this.filterHint, this.clearFilterButton);
    this.summary = element('p', 'wf-board-summary'); this.summary.setAttribute('role', 'status');
    this.refreshButton = button('刷新', () => void this.load()); this.refreshButton.prepend(icon('refresh')); toolbar.append(searchLabel, filterLabel, this.filterContext, this.summary, this.refreshButton);
    this.notice = element('div', 'wf-board-notice'); this.notice.hidden = true; this.notice.setAttribute('role', 'status'); this.noticeText = element('span'); this.retryButton = button('重试', () => void this.load(), 'button small'); this.notice.append(this.noticeText, this.retryButton);
    this.pending = element('section', 'wf-board-pending'); this.pending.hidden = true; this.pending.setAttribute('aria-label', '待处理审批与澄清'); const pendingHeading = element('div', 'wf-board-pending-heading'); this.pendingTitle = element('h2', '', '待处理'); pendingHeading.append(element('span', 'wf-board-pending-dot'), this.pendingTitle); this.pendingList = element('div', 'wf-board-pending-list'); this.pending.append(pendingHeading, this.pendingList);
    this.empty = element('section', 'wf-board-empty'); this.empty.hidden = true; this.emptyIcon = icon('workflow'); this.emptyTitle = element('h2'); this.emptyText = element('p'); this.emptyCreate = button('新建工作流', () => void this.create(), 'button primary'); this.emptyClear = button('清除搜索与筛选', () => this.clearFilters()); this.empty.append(this.emptyIcon, this.emptyTitle, this.emptyText, this.emptyCreate, this.emptyClear);
    this.viewport = element('div', 'wf-board-viewport'); this.viewport.setAttribute('aria-label', '按实际状态分组的工作流'); this.columnGrid = element('div', 'wf-board-columns');
    for (const group of GROUPS) {
      const column = element('section', 'wf-board-column'); column.dataset.state = group.id; column.setAttribute('aria-label', `${group.title}工作流`);
      const heading = element('div', 'wf-board-column-heading'), title = element('h2', '', group.title), count = element('span', 'wf-board-column-count', '0'); heading.append(element('span', 'wf-board-state-dot'), title, count);
      const hint = element('p', 'wf-board-column-hint', group.hint), list = element('div', 'wf-board-cards'), empty = element('p', 'wf-board-column-empty', '暂无工作流'); list.append(empty); column.append(heading, hint, list); this.columnGrid.append(column); this.columns.set(group.id, { column, count, list, empty });
    }
    this.inactiveList = element('div', 'wf-board-inactive-list'); this.inactiveList.hidden = true; this.viewport.append(this.columnGrid, this.inactiveList);
    this.menu = element('div', 'wf-board-menu'); this.menu.setAttribute('role', 'menu'); this.menu.hidden = true;
    this.root.append(header, this.tabs, this.lifecycleHint, this.pending, toolbar, this.notice, this.empty, this.viewport); this.container.replaceChildren(this.root); (document.body || this.root).append(this.menu);
    this.search.addEventListener('input', () => { this.closeMenu(false); this.render(); }); this.filter.addEventListener('change', () => { this.closeMenu(false); this.render(); });
    this.root.addEventListener('click', event => { if (this.openMenu && !this.menu.contains(event.target) && !this.openMenu.trigger.contains(event.target)) this.closeMenu(false); });
    this.root.addEventListener('keydown', event => { if (event.key === 'Escape' && this.openMenu && !this.dialog) { event.preventDefault?.(); this.closeMenu(); } });
    this.viewport.addEventListener('scroll', () => this.closeMenu(false), true);
    this.menu.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault?.(); event.stopPropagation?.(); this.closeMenu(); return; }
      if (event.key === 'Tab') { this.closeMenu(false); return; }
      const items = Array.from(this.menu.children).filter(item => String(item.tagName).toLowerCase() === 'button' && !item.disabled), index = items.indexOf(document.activeElement);
      const next = event.key === 'ArrowDown' ? (index + 1) % items.length : event.key === 'ArrowUp' ? (index + items.length - 1) % items.length : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1;
      if (next < 0 || !items.length) return; event.preventDefault?.(); items[next]?.focus();
    });
    document.addEventListener?.('click', event => { if (this.openMenu && !this.menu.contains(event.target) && !this.openMenu.trigger.contains(event.target)) this.closeMenu(false); });
  }
  activate() { if (this.active) { this.renderPending(); return; } this.active = true; this.render(); void this.load(); }
  deactivate() { this.active = false; this.closeMenu(false); this.closeDialog(false); if (this.reloadTimer) clearTimeout(this.reloadTimer); this.reloadTimer = null; }
  showNotice(message = '', error = false) { this.noticeText.textContent = clean(message); this.notice.hidden = !message; this.notice.classList.toggle('error', error); this.retryButton.hidden = !error; }
  scheduleLoad() { this.reloadNeeded = true; if (!this.active || this.loading || this.reloadTimer) return; this.reloadTimer = setTimeout(() => { this.reloadTimer = null; void this.load(); }, 150); }
  load() {
    if (this.loading) { this.reloadNeeded = true; return this.loadPromise; }
    if (this.reloadTimer) clearTimeout(this.reloadTimer); this.reloadTimer = null;
    const request = ++this.requestSequence, revision = this.eventRevision; this.loading = true; this.reloadNeeded = false; this.renderControls();
    this.loadPromise = this.api('/api/workflow-library?lifecycle=all').then(result => {
      if (request !== this.requestSequence) return;
      if (revision !== this.eventRevision) { this.reloadNeeded = true; return; }
      if (!Array.isArray(result.workflows) || result.workflows.some(item => !item || typeof item.id !== 'string' || !item.id || typeof item.title !== 'string' || workflowLifecycle(item) === 'unknown') || new Set(result.workflows.map(item => item.id)).size !== result.workflows.length) throw new Error('工作流摘要格式不正确，请重试。');
      this.workflows = result.workflows; this.loaded = true; this.showNotice(); this.render();
    }).catch(error => { if (request === this.requestSequence) this.showNotice(`工作流读取失败：${error.message}`, true); }).finally(() => {
      if (request !== this.requestSequence) return;
      this.loading = false; this.loadPromise = null; this.renderControls(); this.render(); if (this.reloadNeeded && this.active) this.scheduleLoad();
    });
    return this.loadPromise;
  }
  renderControls() {
    this.refreshButton.disabled = this.loading; this.refreshButton.setAttribute('aria-busy', String(this.loading)); this.newButton.disabled = this.emptyCreate.disabled = this.creating;
    this.root.setAttribute('aria-busy', String(this.loading && !this.loaded));
  }
  clearFilters() { this.closeMenu(false); this.search.value = ''; this.filter.value = 'all'; this.render(); this.search.focus({ preventScroll: true }); }
  selectLifecycle(id) {
    if (!LIFECYCLES.some(item => item.id === id)) return;
    this.closeMenu(false); this.lifecycle = id; this.render();
  }
  render() {
    this.renderControls(); this.renderPending();
    const lifecycle = LIFECYCLES.find(item => item.id === this.lifecycle), records = this.workflows.filter(item => workflowLifecycle(item) === this.lifecycle);
    const state = this.lifecycle === 'active' ? this.filter.value || 'all' : 'all', filtered = filterWorkflowBoard(records, this.search.value, state), visible = new Set(filtered.map(item => item.id)), allIds = new Set(this.workflows.map(item => item.id));
    this.total.textContent = this.loaded ? String(this.workflows.length) : '—'; this.total.title = '全部工作流，包含已归档和回收站';
    this.summary.textContent = !this.loaded ? this.loading ? '正在读取…' : '尚未读取' : `${lifecycle.title}中 ${filtered.length} / ${records.length} 个 · 全部 ${this.workflows.length} 个`;
    this.lifecycleHint.textContent = lifecycle.hint; this.filterLabel.hidden = this.lifecycle !== 'active';
    const hasFilter = Boolean(this.search.value || this.filter.value !== 'all'), filters = [];
    if (this.search.value) filters.push(`搜索“${this.search.value}”`);
    if (this.filter.value !== 'all') filters.push(this.lifecycle === 'active' ? `状态：${GROUPS.find(item => item.id === this.filter.value)?.title || '已筛选'}` : '已保留工作流状态筛选（本页不应用）');
    this.filterContext.hidden = !hasFilter; this.clearFilterButton.hidden = !hasFilter; this.filterHint.textContent = clean(`当前筛选：${filters.join(' · ')}`); this.filterHint.title = this.filterHint.textContent;
    this.search.placeholder = `搜索${lifecycle.title}名称或 Skill`;
    for (const [id, row] of this.lifecycleTabs) { row.tab.setAttribute('aria-selected', String(id === this.lifecycle)); row.tab.tabIndex = id === this.lifecycle ? 0 : -1; row.total.textContent = this.loaded ? String(this.workflows.filter(item => workflowLifecycle(item) === id).length) : '—'; }
    this.columnGrid.hidden = this.lifecycle !== 'active'; this.inactiveList.hidden = this.lifecycle === 'active'; this.columnGrid.classList.toggle('is-filtered', state !== 'all');
    this.viewport.setAttribute('aria-label', this.lifecycle === 'active' ? '按实际状态分组的工作流' : `${lifecycle.title}工作流`);
    for (const [id, row] of this.cards) if (!allIds.has(id)) { if (this.openMenu?.id === id) this.closeMenu(false); row.card.remove(); this.cards.delete(id); }
    const sorted = [...this.workflows].sort((a, b) => String((workflowLifecycle(b) === 'trashed' ? b.trashedAt : workflowLifecycle(b) === 'archived' ? b.archivedAt : b.updatedAt) || '').localeCompare(String((workflowLifecycle(a) === 'trashed' ? a.trashedAt : workflowLifecycle(a) === 'archived' ? a.archivedAt : a.updatedAt) || '')) || a.id.localeCompare(b.id));
    for (const workflow of sorted) {
      let row = this.cards.get(workflow.id); if (!row) { row = this.createCard(workflow.id); this.cards.set(workflow.id, row); }
      const parent = workflowLifecycle(workflow) === 'active' ? this.columns.get(workflowBoardState(workflow)).list : this.inactiveList;
      if (row.card.parentElement !== parent) { const focused = row.card.contains(document.activeElement), previous = document.activeElement; parent.append(row.card); if (focused) previous.focus({ preventScroll: true }); }
      row.card.hidden = !visible.has(workflow.id); this.updateCard(row, workflow);
    }
    for (const [id, group] of this.columns) {
      const count = filtered.filter(item => workflowBoardState(item) === id).length; group.count.textContent = this.loaded ? String(count) : '—'; group.empty.hidden = count > 0; group.empty.textContent = !this.loaded ? this.loading ? '正在读取…' : '尚未读取' : '暂无工作流'; group.column.hidden = state !== 'all' && state !== id;
      for (const [index, workflow] of sorted.filter(item => workflowLifecycle(item) === 'active' && workflowBoardState(item) === id).entries()) {
        const card = this.cards.get(workflow.id).card, before = group.list.children[index + 1] || null;
        if (before !== card) { const focused = card.contains(document.activeElement), previous = document.activeElement; group.list.insertBefore(card, before); if (focused) previous.focus({ preventScroll: true }); }
      }
    }
    for (const [index, workflow] of sorted.filter(item => workflowLifecycle(item) !== 'active').entries()) { const card = this.cards.get(workflow.id).card, before = this.inactiveList.children[index] || null; if (before !== card) { const focused = card.contains(document.activeElement), previous = document.activeElement; this.inactiveList.insertBefore(card, before); if (focused) previous.focus({ preventScroll: true }); } }
    const empty = this.loaded && !filtered.length; this.empty.hidden = !empty; this.viewport.hidden = empty;
    this.emptyTitle.textContent = records.length ? '没有匹配的工作流' : this.lifecycle === 'active' ? '创建第一个工作流' : this.lifecycle === 'archived' ? '暂无已归档工作流' : '回收站为空';
    this.emptyText.textContent = records.length ? `搜索仅在${lifecycle.title}中查找，试试其它名称或 Skill。` : this.lifecycle === 'active' ? '先手动搭建节点，再保存为可复用的流程。' : this.lifecycle === 'archived' ? '在工作流卡片的更多操作中归档流程。' : '已归档工作流可移入回收站，再选择恢复或永久删除。';
    this.emptyCreate.hidden = this.lifecycle !== 'active' || records.length > 0; this.emptyClear.hidden = !records.length;
  }
  createCard(id) {
    const card = element('article', 'wf-board-card'); card.dataset.workflowId = id;
    const openButton = button('', () => void this.open(id), 'wf-board-card-open');
    const heading = element('span', 'wf-board-card-heading'), title = element('span', 'wf-board-card-title'), mode = element('span', 'wf-board-card-mode'); heading.append(title, mode);
    const structure = element('span', 'wf-board-card-structure'), skills = element('span', 'wf-board-card-skills'), run = element('span', 'wf-board-card-history'), learning = element('span', 'wf-board-card-history'), reason = element('span', 'wf-board-card-reason');
    const timing = element('span', 'wf-board-card-schedule'); timing.append(icon('clock')); const timingText = element('span'); timing.append(timingText);
    const footer = element('span', 'wf-board-card-footer'), updated = element('span'), open = element('span', '', '打开编辑器 →'); footer.append(updated, open); openButton.append(heading, structure, skills, run, learning, reason, timing, footer);
    const more = button('⋯', event => { event.stopPropagation?.(); this.toggleMenu(id); }, 'wf-board-card-more'); more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false'); card.append(openButton, more);
    return { card, openButton, more, title, mode, structure, skills, run, learning, reason, timingText, updated, open };
  }
  updateCard(row, workflow) {
    const group = workflowBoardState(workflow), latest = workflow.latestRun, learning = workflow.latestLearning;
    const activityTime = value => Math.max(...[value?.startedAt, value?.completedAt].map(at => Number.isFinite(Date.parse(at)) ? Date.parse(at) : 0));
    const recent = [latest, learning].filter(Boolean).sort((a, b) => activityTime(b) - activityTime(a))[0];
    const lifecycle = workflowLifecycle(workflow); row.card.dataset.state = group; row.card.dataset.lifecycle = lifecycle;
    row.card.disabled = row.openButton.disabled = this.opening.has(workflow.id); row.openButton.setAttribute('aria-label', clean(`打开工作流：${workflow.title} · ${GROUPS.find(item => item.id === group).title}`));
    row.more.setAttribute('aria-label', clean(`更多操作：${workflow.title}`)); row.more.disabled = !workflowLifecycleActions(workflow).length || Boolean(this.dialog?.pending);
    row.open.textContent = lifecycle === 'active' ? '打开编辑器 →' : '查看工作流 →';
    row.title.textContent = clean(workflow.title || '未命名流程'); row.title.title = clean(workflow.title);
    row.mode.textContent = workflow.mode === 'learn' ? '学习' : workflow.mode === 'execute' ? '执行' : '模式待确认';
    row.structure.textContent = `${count(workflow.nodeCount, '个节点')} · ${count(workflow.edgeCount, '条连线')}`;
    row.skills.textContent = clean(Array.isArray(workflow.skillNames) ? workflow.skillNames.join(' · ') : ''); row.skills.hidden = !row.skills.textContent; row.skills.title = row.skills.textContent;
    row.run.textContent = latest ? clean(`运行 · ${RUN[latest.status] || '状态待确认'}${time(latest.startedAt) ? ` · ${time(latest.startedAt)}` : ''}`) : '尚无运行记录'; row.run.dataset.status = latest?.status || 'idle';
    row.learning.hidden = !learning; row.learning.textContent = learning ? clean(`学习 · ${LEARNING[learning.status] || '状态待确认'}${typeof learning.bestScore === 'number' ? ` · 最佳 ${learning.bestScore} 分` : ''}`) : ''; row.learning.dataset.status = learning?.status || 'idle';
    const reason = group === 'draft' ? workflow.readiness?.error : group === 'attention' ? recent?.error || (recent?.status === 'waiting' ? '等待审批或澄清' : recent?.status === 'exhausted' ? '本次学习尚未达到目标' : !STATES.has(workflow.state) ? '摘要状态待确认，请刷新检查。' : '打开工作流查看执行与学习记录') : '';
    row.reason.textContent = clean(reason || ''); row.reason.hidden = !reason; row.reason.title = row.reason.textContent;
    row.timingText.textContent = Number.isInteger(workflow.scheduleCount) ? workflow.scheduleCount ? `已启用定时 ${workflow.scheduleCount}${workflow.nextRunAt ? ` · 下次 ${time(workflow.nextRunAt)}` : ' · 暂无下次触发'}` : '暂无已启用定时任务' : '定时信息未采集';
    row.updated.textContent = lifecycle === 'archived' ? `${time(workflow.archivedAt) || '时间未记录'} · 已归档` : lifecycle === 'trashed' ? `${time(workflow.trashedAt) || '时间未记录'} · 已在回收站` : time(workflow.updatedAt) ? `${time(workflow.updatedAt)} 更新` : '更新时间未记录';
    if (lifecycle !== 'active') row.timingText.textContent = '关联定时任务已停用；恢复后需手动启用';
  }
  toggleMenu(id) {
    if (this.openMenu?.id === id) { this.closeMenu(); return; }
    this.closeMenu(false); if (this.dialog) return;
    const workflow = this.workflows.find(item => item.id === id), row = this.cards.get(id); if (!workflow || !row) return;
    this.openMenu = { id, trigger: row.more }; row.more.setAttribute('aria-expanded', 'true'); this.menu.replaceChildren(); this.menu.setAttribute('aria-label', clean(`${workflow.title}的操作`));
    for (const action of workflowLifecycleActions(workflow)) {
      const spec = LIFECYCLE_ACTIONS[action], item = button(spec.label, () => this.openLifecycleDialog(id, action, row.more), `wf-board-menu-item${action === 'purge' ? ' danger' : ''}`); item.setAttribute('role', 'menuitem');
      if (action === 'archive' && busyWorkflow(workflow)) { item.disabled = true; item.title = '请先停止当前运行、审核或学习，再归档。'; this.menu.append(item, element('p', 'wf-board-menu-hint', item.title)); } else this.menu.append(item);
    }
    this.menu.hidden = false;
    const bounds = row.more.getBoundingClientRect?.(); if (bounds) { this.menu.style.left = `${Math.max(8, Math.min(bounds.right - 210, (globalThis.innerWidth || 1280) - 222))}px`; this.menu.style.top = `${Math.max(8, Math.min(bounds.bottom + 5, (globalThis.innerHeight || 800) - 165))}px`; }
    Array.from(this.menu.children).find(item => !item.disabled && String(item.tagName).toLowerCase() === 'button')?.focus();
  }
  closeMenu(restoreFocus = true) { const previous = this.openMenu; this.openMenu = null; this.menu.hidden = true; if (previous) { previous.trigger.setAttribute('aria-expanded', 'false'); if (restoreFocus) previous.trigger.focus({ preventScroll: true }); } }
  openLifecycleDialog(id, action, returnFocus) {
    const workflow = this.workflows.find(item => item.id === id), spec = LIFECYCLE_ACTIONS[action];
    if (this.dialog || !workflow || !spec || !workflowLifecycleActions(workflow).includes(action) || action === 'archive' && busyWorkflow(workflow)) return;
    this.closeMenu(false);
    const overlay = element('div', 'wf-board-dialog-overlay'), panel = element('section', 'wf-board-dialog'); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-labelledby', 'wf-board-dialog-title'); panel.setAttribute('aria-describedby', 'wf-board-dialog-description');
    const title = element('h2', '', spec.label); title.id = 'wf-board-dialog-title'; const name = element('p', 'wf-board-dialog-name', workflow.title), description = element('p', '', spec.description); description.id = 'wf-board-dialog-description'; panel.append(title, name, description);
    let input = null;
    if (action === 'purge') { const label = element('label', 'wf-board-confirm-label', '输入完整工作流名称以确认永久删除'); input = element('input'); input.type = 'text'; input.autocomplete = 'off'; input.setAttribute('aria-label', '确认删除的完整工作流名称'); label.append(input); panel.append(label); }
    const error = element('p', 'wf-board-dialog-error'); error.hidden = true; error.setAttribute('role', 'alert'); const actions = element('div', 'wf-board-dialog-actions'), cancel = button('取消', () => this.closeDialog()), submit = button(spec.confirm, () => void this.submitLifecycle(), action === 'purge' ? 'button wf-board-danger' : 'button primary'); actions.append(cancel, submit); panel.append(error, actions); overlay.append(panel); (document.body || this.root).append(overlay);
    this.dialog = { id, action, workflow: { ...workflow }, spec, overlay, panel, input, error, cancel, submit, returnFocus, pending: false, committed: false };
    input?.addEventListener('input', () => this.renderDialog());
    overlay.addEventListener('click', event => { if (event.target === overlay) this.closeDialog(); });
    overlay.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault?.(); event.stopPropagation?.(); this.closeDialog(); }
      if (event.key === 'Tab') { const items = [input, cancel, submit].filter(item => item && !item.disabled), index = items.indexOf(document.activeElement); event.preventDefault?.(); items[(index + (event.shiftKey ? items.length - 1 : 1)) % items.length]?.focus(); }
    });
    this.renderDialog(); (input || cancel).focus();
  }
  renderDialog() {
    const state = this.dialog; if (!state) return;
    state.panel.setAttribute('aria-busy', String(state.pending)); state.cancel.disabled = state.pending; if (state.input) state.input.disabled = state.pending || state.committed;
    state.submit.disabled = state.pending || !state.committed && state.action === 'purge' && state.input.value !== state.workflow.title;
    state.submit.textContent = state.pending ? '正在处理…' : state.committed ? '重新读取列表' : state.spec.confirm;
  }
  closeDialog(restoreFocus = true) {
    const state = this.dialog; if (!state) return; if (state.pending) { if (!restoreFocus) state.closeAfterPending = true; return; } state.overlay.remove(); this.dialog = null;
    if (restoreFocus) { const row = this.cards.get(state.id), target = row && !row.card.hidden ? state.returnFocus : this.lifecycleTabs.get(this.lifecycle)?.tab; target?.focus({ preventScroll: true }); }
    this.renderControls();
  }
  async submitLifecycle() {
    const state = this.dialog; if (!state || state.pending || !state.committed && state.action === 'purge' && state.input.value !== state.workflow.title) return;
    state.pending = true; state.error.hidden = true; this.renderDialog(); this.render();
    try {
      if (!state.committed) {
        const body = { expectedRevision: state.workflow.revision }; if (state.action === 'purge') body.confirmationTitle = state.input.value;
        const result = await this.api(`/api/workflow-library/${encodeURIComponent(state.id)}/${state.action}`, { method: 'POST', body }); state.committed = true;
        if (state.action === 'purge' ? result.deleted !== true || result.id !== state.id || result.lifecycle !== 'deleted' : result.workflow?.id !== state.id || workflowLifecycle(result.workflow) !== state.spec.target) throw new Error('服务返回的操作确认不完整，请重新读取列表核对。');
      }
      let verified = false;
      for (let attempt = 0; attempt < 3 && !verified; attempt++) { await this.load(); const record = this.workflows.find(item => item.id === state.id); verified = state.spec.target === 'deleted' ? !record : Boolean(record) && workflowLifecycle(record) === state.spec.target; }
      if (!verified) throw new Error('操作已提交，但列表尚未确认新状态。请重新读取列表；不会重复提交操作。');
      state.pending = false; this.closeDialog(); this.showNotice(state.spec.success);
    } catch (error) { state.error.textContent = clean(error.message || '操作失败，请重试。'); state.error.hidden = false; }
    finally { state.pending = false; if (state.closeAfterPending) this.closeDialog(false); this.renderDialog(); this.render(); }
  }
  renderPending() {
    const requests = this.getRequests() || [], ids = new Set(); this.pending.hidden = !requests.length; this.pendingTitle.textContent = `待处理 · ${requests.length}`;
    for (const [index, request] of requests.entries()) {
      const id = String(request.id ?? `${request.sessionId}:${request.method}:${index}`); ids.add(id); let row = this.pendingCards.get(id);
      if (!row) { const card = element('article', 'wf-board-request'), title = element('strong'), description = element('p'), link = element('a', 'wf-board-request-link', '前往处理 →'); card.append(title, description, link); this.pendingList.append(card); row = { card, title, description, link }; this.pendingCards.set(id, row); }
      const params = request.params || {}; row.title.textContent = /approv/i.test(request.method || '') ? '执行审批' : '需要补充信息';
      row.description.textContent = clean(params.description || params.question || params.questions?.[0]?.question || params.command || '打开关联任务处理请求。').slice(0, 240); row.description.title = row.description.textContent;
      row.link.hidden = !request.sessionId; if (request.sessionId) { row.link.href = this.taskURL(request.sessionId); row.link.setAttribute('aria-label', `${row.title.textContent}：${row.description.textContent}`); }
    }
    for (const [id, row] of this.pendingCards) if (!ids.has(id)) { row.card.remove(); this.pendingCards.delete(id); }
  }
  async open(id) { if (this.opening.has(id)) return; this.opening.add(id); this.render(); try { await this.onOpen(id); } catch (error) { this.showNotice(`工作流打开失败：${error.message}`, true); } finally { this.opening.delete(id); this.render(); } }
  async create() { if (this.creating) return; this.creating = true; this.renderControls(); try { await this.onCreate(); } catch (error) { this.showNotice(`工作流创建失败：${error.message}`, true); } finally { this.creating = false; this.renderControls(); } }
  handleEvent(event) {
    if (['request.open', 'request.cancel'].includes(event.type)) { if (this.active) this.renderPending(); return; }
    const projection = eventProjection(event); if (!projection) return; const [kind, id, signature] = projection; if (!id) return;
    const key = `${kind}:${id}`; if (this.projections.get(key) === signature) return; this.projections.set(key, signature); if (this.projections.size > 500) this.projections.delete(this.projections.keys().next().value);
    this.eventRevision++; this.scheduleLoad();
  }
}
