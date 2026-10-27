import { WorkflowEditor } from './workflow-editor.js';
import { StatisticsDashboard } from './statistics-dashboard.js';
import { setToolbarControl } from './workflow-toolbar-controls.js';
import { WorkflowRuntimeUI, skillDisplayName, skillVersionLabel } from './workflow-runtime-ui.js';
import { WorkflowBoard } from './workflow-board.js';
import { WorkflowLibraryClient } from './workflow-library-client.js';
import { WorkflowConversationUI } from './workflow-conversation-ui.js';
import { WorkflowVersioningUI } from './workflow-versioning-ui.js';
import { appendDiagnosticEvent, safeText, redact } from '../shared/diagnostics.mjs';
import { diagnosticDetails } from './diagnostic-events.js';
import { HermesModelUI } from './hermes-model-ui.js';
import { createAppDiagnosticClient } from './app-diagnostic-client.js';
import { ApplicationConversationUI } from './application-conversation-ui.js';
import { AssistantPermissionsUI } from './assistant-permissions-ui.js';
import { ConversationHubUI } from './conversation-hub-ui.js';

const $ = (id) => document.getElementById(id);
let workflowEditor, workflowBoard, workflowLibraryClient, applicationConversation, applicationConversationSelection, conversationHub, routeLoad = 0;
const diagnosticCapture = new URLSearchParams(location.search).get('diagnosticCapture') === 'readonly';
const sidebarMedia = matchMedia('(max-width:720px)');
let sidebarCollapsed = false, sidebarMobileOpen = false;
try { sidebarCollapsed = localStorage.getItem('workbench-sidebar-collapsed') === 'true'; } catch {}
const ui = new Proxy({}, { get: (_, id) => $(id === 'request-list' ? 'task-request-list' : id) });
const state = {
  backend: {}, sessions: [], requests: new Map(), requestDrafts: new Map(), histories: new Map(),
  info: new Map(), runs: new Map(), streams: new Map(), tools: new Map(), events: [], csrfToken: '',
  route: null, selectedId: null, bootstrapped: false, historyLoading: false, historyRevision: new Map(),
  refreshing: false, connecting: false, creating: false, resuming: false, posting: new Set(),
  interrupting: new Set(), replying: new Set(), messageDrafts: new Map(),
  source: null, reconnectTimer: null, retry: 0, transport: 'starting', closed: false,
  newTaskError: '', skills: null, skillDetails: new Map(), skillsLoading: false, skillLoading: null,
  stats: new Map(), statsPending: new Set(), settings: null, settingsLoading: false, saving: false, settingsDirty: false,
  eventRevision: 0, sessionRevision: new Map(), turnRevision: new Map(), messageRevision: new Map(), requestsRevision: 0, backendRevision: 0, lastEventId: null,
};
const appDiagnosticClient = createAppDiagnosticClient({ getState: () => ({ page: state.route?.page,
  workflowId: state.route?.page === 'workflows' ? workflowEditor?.doc?.id : null,
  runId: state.route?.page === 'workflows' ? workflowEditor?.runtime?.currentRun?.()?.id : null,
  canvasClosed: workflowEditor?.settings?.canvasClosed, transport: state.transport, backendState: state.backend?.state }) });
const backendLabels = { stopped: '尚未连接', starting: '连接中', ready: '已连接', error: '连接异常', disconnected: '已断开' };
const sessionLabels = { idle: '空闲', ready: '已就绪', running: '进行中', busy: '进行中', waiting: '待处理', complete: '已完成', completed: '已完成', interrupted: '已停止', stopped: '已停止', unknown: '待确认', error: '失败', failed: '失败', disconnected: '未恢复' };
const pageLabels = { board: '工作流看板', workflows: '节点编辑器', conversations: '对话管理', skills: 'Skills', statistics: '统计', settings: '设置', task: '任务' };
const defaults = { theme: 'system', density: 'comfortable', defaultWorkspace: '.' };
const iconPaths = {
  workflow: 'M3 3h6v6H3zM15 3h6v6h-6zM15 15h6v6h-6zM9 6h6M6 9v9h9',
  home: 'M3 10.5 12 3l9 7.5M5 9v11h5v-6h4v6h5V9',
  folder: 'M3 6h7l2 2h9v12H3zM3 6V4h7l2 2',
  sparkles: 'm12 3 2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z',
  chart: 'M4 3v17h17M8 15v-4m5 4V7m5 8V4',
  settings: 'm9 3-1 3-3 1-2 3 2 2v3l2 2h3l2 2 3-2 1-3 3-1v-4l-3-1-1-3-3-2zM15 11a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  plus: 'M12 5v14M5 12h14', close: 'm6 6 12 12M6 18 18 6',
  'arrow-right': 'M4 12h15m-6-6 6 6-6 6', 'arrow-up': 'M12 20V4m-6 6 6-6 6 6',
  search: 'M16 16l5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  refresh: 'M20 8a8 8 0 1 0 0 8M20 3v5h-5',
  panel: 'M3 4h18v16H3zM15 4v16', stop: 'M6 6h12v12H6z',
  'sidebar-collapse': 'M3 4h18v16H3zM9 4v16m7-11-3 3 3 3',
  'sidebar-expand': 'M3 4h18v16H3zM9 4v16m4-11 3 3-3 3',
  task: 'M7 3h10v3h3v15H4V6h3zM7 3v5h10V3M8 13h8m-8 4h5',
  plug: 'M8 3v5m8-5v5M6 8h12v4a6 6 0 0 1-12 0zM12 18v4',
  model: 'm12 2 9 5v10l-9 5-9-5V7zM3 7l9 5 9-5M12 12v10',
  tool: 'm14 6 4-4a6 6 0 0 1-7 8L4 17a2 2 0 0 0 3 3l7-7a6 6 0 0 0 8-7l-4 4z',
  activity: 'M2 12h5l3-8 4 16 3-8h5', clock: 'M12 7v6l4 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
};
function icon(name) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'icon' })) node.setAttribute(key, value);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', iconPaths[name] || iconPaths.task); node.append(path); return node;
}
for (const node of document.querySelectorAll('[data-icon]')) node.replaceChildren(icon(node.dataset.icon));
function element(tag, className = '', text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = safeText(text); return node; }
function link(href, text, className = '') { const node = element('a', className, text); node.href = href; return node; }
function button(text, handler, className = 'button quiet') { const node = element('button', className, text); node.type = 'button'; node.addEventListener('click', handler); return node; }
function empty(title, description = '', iconName = 'folder', action) { const node = element('div', 'empty-state'); node.append(icon(iconName), element('h3', '', title)); if (description) node.append(element('p', '', description)); if (action) node.append(action); return node; }
function formatDate(value, short = false) { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.valueOf()) ? safeText(value) : date.toLocaleString('zh-CN', short ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false } : { hour12: false }); }
function dirname(cwd) { return String(cwd || '').replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || '未指定目录'; }
function selectedSession() { return state.sessions.find((session) => session.id === state.selectedId); }
function isBusy(id) { return state.streams.has(id) || state.posting.has(id) || ['running', 'busy', 'waiting'].includes(state.sessions.find((session) => session.id === id)?.status); }
function preferences() { return { ...defaults, ...state.settings?.preferences }; }
function notify(text, error = false) { $('notice').hidden = !text; $('notice-text').textContent = safeText(text); $('notice').className = error ? 'notice error' : 'notice'; }
async function api(path, { method = 'GET', body } = {}) {
  const headers = { Accept: 'application/json' };
  if (method !== 'GET') { if (!state.csrfToken) throw new Error('工作台尚未就绪，请刷新后重试。'); headers['Content-Type'] = 'application/json'; headers['X-Workbench-Token'] = state.csrfToken; }
  let response;
  try { response = await fetch(path, { method, headers, credentials: 'same-origin', cache: 'no-store', ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
  catch (error) { appDiagnosticClient.recordRequest(path, 0, error.message); throw error; }
  let result; try { result = await response.json(); } catch { throw new Error(`服务响应无法读取（HTTP ${response.status}）。`); }
  if (!response.ok) { const error = new Error(safeText(result.error || `请求失败（HTTP ${response.status}）。`)); error.httpStatus = response.status; appDiagnosticClient.recordRequest(path, response.status, error.message); throw error; } return result;
}
const hermesModels = new HermesModelUI({
  api, context: () => ({ backend: state.backend, connecting: state.connecting, csrfToken: state.csrfToken }), connect: connectBackend,
  changed: (_data, { applied = false } = {}) => { renderNewTaskState(); if (state.route?.page === 'settings') renderSettings(); if (applied) void Promise.allSettled([synchronize(), loadSettings()]); },
});
const assistantPermissions = new AssistantPermissionsUI({ api, context: () => ({ csrfToken: state.csrfToken }), readOnly: diagnosticCapture });
function upsertSession(session) { if (!session?.id) return; const index = state.sessions.findIndex((item) => item.id === session.id); if (index < 0) state.sessions.unshift(session); else state.sessions[index] = { ...state.sessions[index], ...session }; }
function taskURL(id, tab = 'workspace', panel = '') { return `#/task/${encodeURIComponent(id)}?tab=${tab}${panel ? `&panel=${panel}` : ''}`; }
function readRoute() {
  const [pathname, query = ''] = (location.hash.slice(1) || '/board').split('?'); const parts = pathname.split('/').filter(Boolean);
  const decode = (value) => { try { return decodeURIComponent(value || ''); } catch { return ''; } }; const options = new URLSearchParams(query);
  if (parts[0] === 'task') return { page: 'task', id: decode(parts[1]), tab: ['workspace', 'runs', 'info'].includes(options.get('tab')) ? options.get('tab') : 'workspace', panel: ['execution', 'related'].includes(options.get('panel')) ? options.get('panel') : '' };
  if (parts[0] === 'conversations') return { page: 'conversations', id: decode(parts[1]) };
  if (parts[0] === 'project' || parts[0] === 'projects') return { page: 'conversations', id: '' };
  if (parts[0] === 'skills') return { page: 'skills', name: decode(parts[1]) };
  if (parts[0] === 'workflows') return { page: 'workflows', id: decode(parts[1]) };
  return { page: ['board', 'statistics', 'settings'].includes(parts[0]) ? parts[0] : 'board' };
}
function normalizeRoute() { if (!location.hash || /^#\/workbench(?:[/?]|$)/.test(location.hash)) history.replaceState(null, '', '#/board'); else if (/^#\/projects?(?:[/?]|$)/.test(location.hash)) history.replaceState(null, '', '#/conversations'); }
function navigate(hash) { if (location.hash === hash) void loadRouteData(); else location.hash = hash; }
function selectSession(id) { navigate(taskURL(id)); }
function setTaskQuery({ tab = state.route.tab, panel = state.route.panel } = {}) { navigate(taskURL(state.selectedId, tab, panel)); }
function renderSidebar() {
  const mobile = sidebarMedia.matches, collapsed = mobile ? !sidebarMobileOpen : sidebarCollapsed;
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  const toggle = $('sidebar-toggle'), label = collapsed ? '展开主边栏' : '收起主边栏';
  toggle.setAttribute('aria-expanded', String(!collapsed)); toggle.setAttribute('aria-label', label); toggle.title = label;
  toggle.replaceChildren(icon(collapsed ? 'sidebar-expand' : 'sidebar-collapse'));
  $('sidebar-backdrop').hidden = !mobile || collapsed;
  $('main-shell').inert = mobile && !collapsed;
  for (const nav of document.querySelectorAll('[data-nav]')) {
    const label = nav.dataset.nav === 'board' && state.requests.size
      ? `工作流看板 · ${state.requests.size} 项待处理` : pageLabels[nav.dataset.nav];
    nav.title = label; nav.setAttribute('aria-label', label);
  }
}
function closeMobileSidebar({ focus = false } = {}) {
  sidebarMobileOpen = false; renderSidebar(); if (focus) $('sidebar-toggle').focus();
}
async function routeChanged() {
  const previous = state.route;
  if (previous?.page === 'workflows') workflowLibraryClient?.leave();
  normalizeRoute();
  if (previous?.page === 'task') state.messageDrafts.set(previous.id, $('message-input').value);
  state.route = readRoute(); state.selectedId = state.route.page === 'task' ? state.route.id : null;
  sidebarMobileOpen = false;
  if (previous?.id !== state.selectedId) { state.historyLoading = false; $('message-input').value = state.messageDrafts.get(state.selectedId) || ''; }
  renderShell(); renderPage();
  if (previous?.page !== state.route.page || previous?.id !== state.route.id || previous?.cwd !== state.route.cwd) $('main-content').scrollTop = 0;
  if (state.bootstrapped) {
    if (state.route.page === 'task' && previous?.page === 'task' && previous.id === state.route.id) {
      if (previous.tab !== state.route.tab && state.route.tab === 'runs') await loadRuns(state.selectedId);
    } else await loadRouteData();
  }
}
function renderShell() {
  const route = state.route || { page: 'board' }; const parent = route.page === 'task' ? 'board' : route.page;
  document.body.classList.toggle('workflow-active', route.page === 'workflows');
  document.body.classList.toggle('board-active', route.page === 'board');
  document.body.classList.toggle('conversation-hub-active', route.page === 'conversations');
  const showApplicationChat = route.page === 'conversations' && Boolean(route.id);
  $('global-conversation-root').hidden = !showApplicationChat;
  if (showApplicationChat && state.bootstrapped) {
    if (!applicationConversation) { applicationConversation = new ApplicationConversationUI($('global-conversation-root'), { api, conversationId: route.id, getBackend: () => state.backend, getPageDiagnostics: () => appDiagnosticClient.snapshot() }); if (diagnosticCapture) applicationConversation.schedulePoll = () => {}; }
    if (applicationConversationSelection !== route.id) { applicationConversationSelection = route.id; void applicationConversation.selectConversation(route.id).catch(error => notify(`总控会话打开失败：${error.message}`, true)); }
  }
  renderSidebar();
  for (const nav of document.querySelectorAll('[data-nav]')) { nav.classList.toggle('active', nav.dataset.nav === parent); if (nav.dataset.nav === parent) nav.setAttribute('aria-current', 'page'); else nav.removeAttribute('aria-current'); }
  const crumb = $('breadcrumb'); crumb.replaceChildren(link('#/board', '个人空间'), element('span', 'separator', '/'));
  if (route.page === 'task') crumb.append(link('#/board', '工作流看板'), element('span', 'separator', '/'), element('span', '', selectedSession()?.title || '任务'));
  else if (route.page === 'workflows') crumb.append(link('#/board', '工作流看板'), element('span', 'separator', '/'), element('span', 'truncate', workflowLibraryClient?.currentId === route.id ? workflowEditor.doc.title : '节点编辑器'));
  else crumb.append(element('span', '', pageLabels[route.page]));
  $('details-button').hidden = route.page !== 'task'; $('details-button').setAttribute('aria-expanded', String(Boolean(route.panel)));
  $('inspector').hidden = route.page !== 'task' || !route.panel;
  $('new-task-button').disabled = !state.csrfToken;
  $('new-task-button').hidden = ['board', 'conversations'].includes(route.page);
  if (route.page === 'workflows') setToolbarControl($('new-task-button'), { label: '新建工作流', icon: 'plus' });
  else { $('new-task-button').classList.remove('wf-toolbar-button'); delete $('new-task-button').dataset.tooltip; $('new-task-button').removeAttribute('aria-busy'); $('new-task-button').setAttribute('aria-label', '新建任务'); $('new-task-button').title = '新建任务'; $('new-task-button').replaceChildren(icon('plus'), document.createTextNode('新建任务')); }
  $('nav-pending-count').hidden = !state.requests.size; $('nav-pending-count').textContent = String(state.requests.size);
  $('nav-conversation-count').textContent = conversationHub?.data ? String(conversationHub.data.workflows.length + conversationHub.data.supervisors.length) : '';
  document.title = `${route.page === 'task' ? selectedSession()?.title || '任务' : pageLabels[route.page]} · 个人工作台`;
  renderBackend();
}
function renderBackend() {
  hermesModels.render();
  workflowEditor?.runtime?.refreshBackend();
  const backend = state.backend; const ready = backend.state === 'ready';
  $('connection-label').textContent = ready ? 'Hermes 已连接' : backendLabels[backend.state] || '读取连接状态';
  $('connection-dot').className = `dot ${ready ? 'live' : backend.state === 'error' ? 'error' : backend.state === 'starting' ? 'waiting' : ''}`;
  $('connection-meta').textContent = safeText(ready ? backend.model || backend.provider || '本地运行' : '本地运行 · Hermes');
  const connectionLabel = state.connecting ? '连接中…' : ready ? '查看连接设置' : '连接 Hermes';
  $('sidebar-connect').replaceChildren(element('span', 'connection-action-label', connectionLabel), icon('plug'));
  $('sidebar-connect').setAttribute('aria-label', connectionLabel);
  $('sidebar-connect').title = `${connectionLabel} · ${ready ? backend.model || backend.provider || 'Hermes 已连接' : backendLabels[backend.state] || '读取连接状态'}`;
  $('connection-dot').title = $('connection-label').textContent;
  $('sidebar-connect').disabled = state.connecting || !state.csrfToken;
  $('connect-button').replaceChildren(icon('plug'), document.createTextNode(state.connecting ? '连接中…' : ready ? '重新连接' : '连接后端'));
  $('connect-button').disabled = state.connecting || backend.state === 'starting' || !state.csrfToken;
  $('refresh-button').disabled = state.refreshing;
  $('backend-error').hidden = !backend.lastError; $('backend-error').textContent = safeText(backend.lastError || '');
  $('transport-status').textContent = ({ starting: '正在读取本地服务状态', live: 'SSE 事件连接正常', reconnecting: '事件连接中断，正在重新同步', error: '无法连接本地服务' })[state.transport];
  renderNewTaskState(); renderComposer();
}
function metric(label, value, footnote, iconName) { const card = element('div', 'metric-card'); const title = element('div', 'metric-label', label); if (iconName) title.append(icon(iconName)); card.append(title, element('div', 'metric-value', value), element('p', 'metric-footnote', footnote)); return card; }
function badge(status) { const normalized = ['complete', 'completed'].includes(status) ? 'complete' : ['running', 'busy', 'waiting'].includes(status) ? 'running' : ['error', 'failed'].includes(status) ? 'error' : ''; const node = element('span', `status-badge ${normalized}`); node.append(element('span', `dot ${normalized === 'complete' ? 'live' : normalized === 'running' ? 'waiting' : normalized === 'error' ? 'error' : ''}`), document.createTextNode(sessionLabels[status] || status || '待开始')); return node; }
function sessionsTable(sessions, { showProject = true } = {}) {
  if (!sessions.length) return empty(state.bootstrapped ? '暂无任务' : '正在读取任务…', '', 'task', state.bootstrapped ? button('新建任务', openNewTask, 'button quiet small') : undefined);
  const table = element('table'); const head = element('thead'); const tr = element('tr');
  for (const label of ['任务名称', ...(showProject ? ['项目'] : []), '状态', '最近更新']) tr.append(element('th', '', label)); head.append(tr); table.append(head);
  const body = element('tbody');
  for (const session of [...sessions].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))) {
    const row = element('tr'); const title = link(taskURL(session.id), '', 'task-title-link'); title.append(icon('task'), element('span', 'truncate', session.title || '未命名任务')); title.title = safeText(session.title);
    const titleCell = element('td'); titleCell.append(title); row.append(titleCell);
    if (showProject) { const project = link(`#/project/${encodeURIComponent(session.cwd || '')}`, '', 'project-link'); project.append(icon('folder'), element('span', 'truncate', dirname(session.cwd))); project.title = safeText(session.cwd); const cell = element('td'); cell.append(project); row.append(cell); }
    const status = element('td'); status.append(badge(session.status)); row.append(status, element('td', '', formatDate(session.updatedAt, true))); body.append(row);
  }
  table.append(body); return table;
}
function ensureConversationHub() {
  if (conversationHub) return;
  conversationHub = new ConversationHubUI($('conversation-hub-root'), { api, openSupervisor: id => navigate(`#/conversations/${encodeURIComponent(id)}`),
    getSessions: () => state.sessions, sessionLink: taskURL, readOnly: diagnosticCapture,
    onCount: count => { $('nav-conversation-count').textContent = String(count); } });
}
function ensureWorkflowEditor() {
  if (workflowEditor) return;
  workflowEditor = new WorkflowEditor($('workflow-root'));
  workflowEditor.runtime = new WorkflowRuntimeUI(workflowEditor, {
    api, connect: connectBackend, getBackend: () => state.backend,
    getRequests: () => [...state.requests.values()], taskURL,
  });
  workflowEditor.conversation = new WorkflowConversationUI(workflowEditor, { api, getBackend: () => state.backend, getPageDiagnostics: () => appDiagnosticClient.snapshot() });
  if (diagnosticCapture) workflowEditor.conversation.schedulePoll = () => {};
  workflowEditor.conversation.connectRuntime(workflowEditor.runtime);
  workflowLibraryClient = new WorkflowLibraryClient(workflowEditor, { api,
    onDocumentChange(id) {
      if (!workflowEditor.active || state.route.page !== 'workflows' || workflowEditor.doc.id !== id) return;
      if (state.route.id !== id) { history.replaceState(null, '', `#/workflows/${encodeURIComponent(id)}`); state.route = readRoute(); }
      renderShell();
    },
  });
  workflowEditor.versioning = new WorkflowVersioningUI(workflowEditor, { api,
    onCreated(record, options = {}) {
      if (options.copyInputs) {
        try { workflowEditor.studio.copyInputDrafts(record.document, options.report?.nodeIdMap || {}); }
        catch (error) { workflowEditor.toast(`新版已保存，输入草稿未能复制，请重新准备资料：${error.message}`, true); }
      }
      workflowLibraryClient.adopt(record);
      navigate(`#/workflows/${encodeURIComponent(record.id)}`);
    },
  });
  workflowEditor.onReturnToBoard = () => navigate('#/board');
  workflowEditor.onCreateWorkflow = () => void createWorkflow().catch(error => workflowEditor.toast(`工作流创建失败：${error.message}`, true));
  workflowEditor.onSaveLibrary = () => void workflowLibraryClient.flush().then(() => workflowEditor.toast('已保存到工作流看板。')).catch(error => workflowEditor.toast(`看板保存失败：${error.message}`, true));
  workflowEditor.renderProperties(); workflowEditor.renderHeader();
}
function ensureWorkflowBoard() {
  if (!workflowBoard) workflowBoard = new WorkflowBoard($('workflow-board-root'), {
    api, onOpen: id => navigate(`#/workflows/${encodeURIComponent(id)}`), onCreate: createWorkflow,
    getRequests: () => [...state.requests.values()], taskURL,
  });
}
async function createWorkflow() {
  ensureWorkflowEditor();
  const id = await workflowLibraryClient.create(); navigate(`#/workflows/${encodeURIComponent(id)}`);
}
function workflowLoading(message = '', error = false) {
  const box = $('workflow-load-status'); box.hidden = !message; box.replaceChildren();
  $('workflow-root').inert = Boolean(message); $('workflow-root').classList.toggle('workflow-loading', Boolean(message));
  if (!message) return;
  box.append(element('p', '', message));
  if (error) box.append(button('重试', () => void loadRouteData()), link('#/board', '返回看板', 'button quiet'));
}
function renderPage() {
  for (const page of document.querySelectorAll('[data-page]')) page.hidden = page.dataset.page !== state.route.page;
  if (state.route.page === 'workflows') {
    ensureWorkflowEditor();
    if (state.route.id && workflowLibraryClient.currentId === state.route.id && !$('workflow-load-status').textContent) {
      workflowEditor.activate(); void workflowEditor.runtime.activate();
    } else { workflowEditor.deactivate(); workflowEditor.runtime.deactivate(); workflowLoading('正在打开工作流…'); }
  } else { workflowEditor?.deactivate(); workflowEditor?.runtime?.deactivate(); }
  if (state.route.page === 'board') {
    ensureWorkflowBoard(); if (state.bootstrapped) workflowBoard.activate();
  } else workflowBoard?.deactivate();
  if (state.route.page === 'conversations') { ensureConversationHub(); conversationHub.render(); }
  else conversationHub?.deactivate();
  if (state.route.page === 'skills') renderSkills();
  if (state.route.page === 'statistics') renderStatistics();
  if (state.route.page === 'settings') renderSettings();
  if (state.route.page === 'task') renderTask();
}
function factList(entries) { const list = element('div', 'fact-list'); for (const [label, value] of entries) { const row = element('div', 'fact-row'); row.append(element('span', 'fact-label', label), element('span', 'fact-value', value === undefined || value === null || value === '' ? '—' : value)); list.append(row); } return list; }
function renderTask() {
  const session = selectedSession(); const missing = !session; $('task-missing').hidden = !missing;
  if (missing) $('task-missing').replaceChildren(empty(state.bootstrapped ? '没有找到这项任务' : '正在读取任务…', state.bootstrapped ? '任务可能已移除，请返回看板查看。' : '', 'task', state.bootstrapped ? link('#/board', '返回看板', 'button quiet small') : undefined));
  $('task-title').textContent = safeText(session?.title || (state.bootstrapped ? '任务不存在' : '加载任务…'));
  $('task-project').replaceChildren(session ? link(`#/project/${encodeURIComponent(session.cwd || '')}`, dirname(session.cwd), 'project-link') : element('span'));
  $('task-status').replaceWith(Object.assign(badge(session?.status), { id: 'task-status' }));
  for (const tab of $('task-tabs').querySelectorAll('[data-tab]')) { tab.href = taskURL(state.selectedId, tab.dataset.tab, state.route.panel); tab.classList.toggle('selected', state.route.tab === tab.dataset.tab); tab.setAttribute('aria-selected', String(state.route.tab === tab.dataset.tab)); }
  for (const tab of ['workspace', 'runs', 'info']) $(`task-${tab}`).hidden = missing || state.route.tab !== tab;
  $('task-tabs').hidden = missing; $('resume-button').hidden = missing;
  renderMessages(); renderRequests(); renderTaskRuns(); renderTaskInfo(); renderInspector(); renderComposer();
}
function messageNode(message, streaming = false) {
  const role = message.role || 'assistant'; const node = element('article', `message ${['user', 'assistant', 'system', 'tool'].includes(role) ? role : 'system'}`);
  const avatar = element('span', 'message-avatar', role === 'user' ? '我' : role === 'assistant' ? 'H' : ''); if (role === 'tool') avatar.append(icon('tool')); node.append(avatar);
  const heading = element('div', 'message-heading'); heading.append(element('span', 'message-role', ({ user: '你', assistant: 'Hermes', system: '系统', tool: '工具' })[role] || role)); if (role === 'tool' && message.name) heading.append(element('span', 'mono', message.name)); if (streaming) heading.append(element('span', 'streaming-tag', '生成中…')); if (message.status && !streaming) heading.append(element('span', '', sessionLabels[message.status] || message.status)); node.append(heading);
  if (message.text || streaming) node.append(element('div', 'message-body', message.text || '等待内容…'));
  if (role === 'tool') { if (message.context !== undefined && message.context !== null && message.context !== '') { const context = typeof message.context === 'string' ? message.context : JSON.stringify(redact(message.context), null, 2); if (context !== message.text) node.append(element('div', 'message-body', context)); } if (message.args !== undefined && message.args !== null) { const args = element('details', 'request-diagnostic'); args.append(element('summary', '', '工具参数'), element('pre', '', typeof message.args === 'string' ? message.args : JSON.stringify(redact(message.args), null, 2))); node.append(args); } }
  if (message.error) node.append(element('p', 'message-body message-error', typeof message.error === 'string' ? message.error : JSON.stringify(redact(message.error)))); return node;
}
function renderMessages({ follow = false } = {}) {
  const container = $('messages'); const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100; const oldScroll = container.scrollTop; const fragment = document.createDocumentFragment(); const messages = state.histories.get(state.selectedId) || []; const stream = state.streams.get(state.selectedId);
  for (const message of messages) fragment.append(messageNode(message)); if (stream) fragment.append(messageNode(stream, true));
  if (!messages.length && !stream) fragment.append(empty(state.historyLoading ? '正在读取对话…' : state.backend.state !== 'ready' ? '尚未连接 Hermes' : '暂无消息', '', 'task', state.backend.state !== 'ready' ? button('连接 Hermes', connectBackend, 'button quiet small') : undefined));
  container.replaceChildren(fragment); container.scrollTop = follow || nearBottom ? container.scrollHeight : oldScroll; renderComposer();
}
function renderComposer() {
  const session = selectedSession(); const busy = session ? isBusy(session.id) : false; const ready = state.backend.state === 'ready' && Boolean(state.csrfToken); const pending = [...state.requests.values()].filter((request) => request.sessionId === state.selectedId).length; const tool = state.tools.get(state.selectedId);
  $('resume-button').disabled = !session || !ready || busy || state.resuming || state.historyLoading; $('resume-button').textContent = state.resuming ? '恢复中…' : '恢复会话';
  $('message-input').disabled = !session || !ready || busy || session.workflowManaged || state.resuming || state.historyLoading; $('send-button').disabled = $('message-input').disabled || !$('message-input').value.trim();
  $('message-input').placeholder = session?.workflowManaged ? '工作流运行记录（只读）' : '输入消息';
  $('interrupt-button').disabled = !session || !ready || !busy || state.interrupting.has(session.id);
  $('turn-status').textContent = safeText(!session ? '等待选择任务' : !ready ? '等待后端连接' : pending ? `等待你的处理 · ${pending} 项` : tool ? `工具运行中：${tool}` : busy ? 'Hermes 正在执行…' : state.historyLoading ? '正在读取历史…' : session.workflowManaged ? '工作流运行记录 · 只读' : `${session.model || state.info.get(session.id)?.model || state.backend.model || 'Hermes'} · 就绪`);
  $('turn-indicator').className = `dot ${pending || busy ? 'waiting' : ready && session ? 'live' : ''}`;
}
function renderTaskInfo() { const session = selectedSession(); if (!session) return; const info = state.info.get(session.id) || {}; $('task-info').replaceChildren(element('h2', '', '任务信息'), factList([['任务名称', session.title], ['工作目录', session.cwd], ['运行状态', sessionLabels[session.status] || session.status], ['模型', session.model || info.model], ['提供商', info.provider || session.provider || state.backend.provider], ['创建时间', formatDate(session.createdAt)], ['最近更新', formatDate(session.updatedAt)]])); }
function normalizeRun(run) { return { ...run, startedAt: run.startedAt || run.started_at, completedAt: run.completedAt || run.completed_at }; }
function runsTable(runs, showTask = false) { const table = element('table'); const head = element('thead'); const row = element('tr'); for (const label of [...(showTask ? ['任务'] : []), '执行状态', '开始时间', '结束时间', '结果说明']) row.append(element('th', '', label)); head.append(row); const body = element('tbody'); for (const raw of [...runs].reverse()) { const run = normalizeRun(raw); const tr = element('tr'); if (showTask) { const td = element('td'); td.append(link(taskURL(run.sessionId), run.sessionTitle || '任务', 'truncate')); tr.append(td); } const status = element('td'); status.append(badge(run.status)); tr.append(status, element('td', '', formatDate(run.startedAt, true)), element('td', '', formatDate(run.completedAt, true)), element('td', '', run.error || '—')); body.append(tr); } table.append(head, body); return table; }
function renderTaskRuns() { const runs = state.runs.get(state.selectedId); const node = $('task-runs'); const section = element('section', 'content-section'); section.append(element('h2', '', '执行记录')); if (!runs) section.append(empty('正在读取执行记录…', '', 'clock')); else if (!runs.length) section.append(empty('还没有执行记录', '', 'clock')); else { const wrap = element('div', 'table-wrap'); wrap.append(runsTable(runs)); section.append(wrap); } node.replaceChildren(section); }
function renderInspector() {
  if (state.route.page !== 'task' || !state.route.panel) return;
  for (const tab of $('inspector-tabs').querySelectorAll('button')) tab.classList.toggle('selected', tab.dataset.inspector === state.route.panel);
  const session = selectedSession(); const node = $('inspector-content'); const openKeys = eventOpenKeys(node); const oldScroll = node.scrollTop; if (!session) { node.replaceChildren(); return; }
  if (state.route.panel === 'related') { node.replaceChildren(element('h3', '', '任务关联'), factList([['工作目录', session.cwd], ['工作台任务', session.id], ['Hermes 会话', session.storedSessionId], ['运行会话', session.runtimeSessionId || '尚未恢复']]), element('h3', '', '文件与成果'), element('p', 'helper', '文件预览尚未接入')); return; }
  node.replaceChildren(element('h3', '', '当前执行'), factList([['任务状态', sessionLabels[session.status] || session.status], ['工具', state.tools.get(session.id) || '无正在运行的工具'], ['待处理', [...state.requests.values()].filter((request) => request.sessionId === session.id).length], ['模型', session.model || state.info.get(session.id)?.model || state.backend.model]]), element('h3', '', '诊断事件'));
  const list = element('div', 'event-list'); list.append(eventsFragment(state.events.filter((event) => event.sessionId === session.id), openKeys)); node.append(list); node.scrollTop = oldScroll;
}
function renderRequests() {
  const container = $('task-request-list');
  for (const card of container.querySelectorAll('.request-card')) { const drafts = [...card.querySelectorAll('.question')].map((question) => ({ text: question.querySelector('textarea')?.value || '', selected: [...question.querySelectorAll('input:checked')].map((input) => input.value) })); if (drafts.length) state.requestDrafts.set(card.dataset.requestId, drafts); }
  for (const id of state.requestDrafts.keys()) if (!state.requests.has(id)) state.requestDrafts.delete(id);
  const desired = [...state.requests.values()].filter((request) => request.sessionId === state.selectedId);
  const desiredIds = new Set(desired.map((request) => String(request.id)));
  const existing = new Map([...container.querySelectorAll('.request-card')].map((card) => [card.dataset.requestId, card]));
  for (const [id, card] of existing) if (!desiredIds.has(id)) card.remove();
  for (const request of desired) {
    const id = String(request.id); const card = existing.get(id);
    if (!card) container.append(requestCard(request));
    else for (const control of card.querySelectorAll('button, input, textarea')) control.disabled = state.replying.has(id);
  }
  renderComposer();
}
function requestCard(request) {
  const params = request.params || {};
  const approval = /approv/i.test(request.method || '') || Array.isArray(params.choices) && params.choices.includes('once') && 'command' in params;
  const clarification = /clarif/i.test(request.method || '') || params.question || Array.isArray(params.questions);
  const card = element('article', 'request-card');
  card.dataset.requestId = String(request.id);
  const heading = element('div', 'request-heading');
  heading.append(element('h3', '', approval ? '执行审批' : clarification ? '需要补充信息' : request.method || '待处理请求'));
  const session = state.sessions.find((item) => item.id === request.sessionId);
  const context = element('button', 'button quiet small request-context', session?.title || request.sessionId || '未指定会话');
  context.type = 'button'; context.disabled = !session;
  context.addEventListener('click', () => selectSession(request.sessionId));
  heading.append(context); card.append(heading);
  if (approval) {
    if (params.description) card.append(element('p', 'request-description', params.description));
    if (params.command) card.append(element('pre', 'command', typeof params.command === 'string' ? params.command : JSON.stringify(redact(params.command), null, 2)));
    const actions = element('div', 'request-actions');
    for (const [choice, label, className] of [['once', '仅允许这一次', ''], ['deny', '拒绝', 'danger']]) {
      const button = element('button', `button small ${className}`, label);
      button.type = 'button'; button.disabled = state.replying.has(String(request.id));
      button.addEventListener('click', () => replyRequest(request, { choice }));
      actions.append(button);
    }
    card.append(actions);
  } else if (clarification) {
    const questions = Array.isArray(params.questions) ? params.questions : [{ question: params.question, choices: params.choices, multi_select: params.multi_select }];
    const form = element('form');
    const readers = [];
    for (const [index, question] of questions.entries()) {
      const draft = state.requestDrafts.get(String(request.id))?.[index];
      const fieldset = element('fieldset', 'question');
      fieldset.append(element('legend', '', question.question || `问题 ${index + 1}`));
      const inputs = [];
      if (Array.isArray(question.choices) && question.choices.length) {
        const choices = element('div', 'choice-list');
        for (const choice of question.choices) {
          const label = element('label', 'choice-option');
          const input = document.createElement('input');
          input.type = question.multi_select ? 'checkbox' : 'radio';
          input.name = `question-${index}`; input.value = String(choice);
          input.checked = draft?.selected.includes(String(choice)) || false;
          input.disabled = state.replying.has(String(request.id));
          label.append(input, element('span', '', choice)); choices.append(label); inputs.push(input);
        }
        fieldset.append(choices);
      }
      const answer = document.createElement('textarea');
      answer.rows = 2; answer.placeholder = inputs.length ? '补充说明' : '回答';
      answer.setAttribute('aria-label', `回答：${question.question || `问题 ${index + 1}`}`);
      answer.disabled = state.replying.has(String(request.id));
      const existing = params.answers?.[question.qid];
      if (draft) answer.value = draft.text;
      else if (typeof existing === 'string') answer.value = existing;
      fieldset.append(answer); form.append(fieldset);
      readers.push({ qid: question.qid, answer, read() {
        const typed = answer.value.trim();
        const chosen = inputs.filter((input) => input.checked).map((input) => input.value).join('、');
        return question.multi_select ? [chosen, typed].filter(Boolean).join('\n') : typed || chosen;
      } });
    }
    const button = element('button', 'button primary small', state.replying.has(String(request.id)) ? '提交中…' : '提交回答');
    button.type = 'submit'; button.disabled = state.replying.has(String(request.id)); form.append(button);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const unanswered = readers.find((reader) => !reader.read());
      if (unanswered) { unanswered.answer.focus(); notify('请填写每个问题的回答。', true); return; }
      if (Array.isArray(params.questions)) {
        if (readers.some((reader) => reader.qid === undefined)) { notify('请求缺少问题编号，无法提交；请查看事件日志。', true); return; }
        replyRequest(request, { answers: Object.fromEntries(readers.map((reader) => [reader.qid, reader.read()])) });
      } else replyRequest(request, { answer: readers[0].read() });
    });
    card.append(form);
  } else card.append(element('p', 'request-description', '该请求类型暂未提供交互控件，请查看请求详情。'));
  const diagnostic = element('details', 'request-diagnostic');
  diagnostic.append(element('summary', '', '请求详情'), element('pre', '', JSON.stringify(redact(request), null, 2)));
  card.append(diagnostic);
  return card;
}

async function replyRequest(request, result) {
  const key = String(request.id);
  if (state.replying.has(key)) return;
  state.replying.add(key);
  // Disable in place to retain clarification answers if the network fails.
  const card = [...ui['request-list'].querySelectorAll('.request-card')].find((item) => item.dataset.requestId === key);
  for (const control of card?.querySelectorAll('button, input, textarea') || []) control.disabled = true;
  try {
    await api(`/api/requests/${encodeURIComponent(key)}/reply`, { method: 'POST', body: { result } });
    state.requests.delete(key); notify('已提交处理结果。');
  } catch (error) { notify(`提交失败：${error.message}`, true); }
  finally { state.replying.delete(key); renderRequests(); updateSessionViews(); }
}
function eventOpenKeys(node) { return new Set([...node.querySelectorAll('details[open]')].map((entry) => entry.dataset.eventId)); }
function eventsFragment(events, openKeys = new Set()) { const fragment = document.createDocumentFragment(); for (const event of [...events].reverse()) { const key = String(event.id ?? `${event.type}-${event.at}`); fragment.append(diagnosticDetails(event, { formatDate, open: openKeys.has(key) })); } if (!events.length) fragment.append(element('p', 'helper', '尚未收到事件。')); return fragment; }
function renderEvents() { $('settings-event-count').textContent = `${state.events.length} / 200`; if (state.route.page === 'settings') { const list = $('settings-event-list'); const oldScroll = list.scrollTop; list.replaceChildren(eventsFragment(state.events, eventOpenKeys(list))); list.scrollTop = oldScroll; } renderInspector(); }
function addEvent(event) { state.events = appendDiagnosticEvent(state.events, event, { redact }); renderEvents(); }
function renderNewTaskState() { const ready = state.backend.state === 'ready'; $('create-session-button').disabled = !ready || !state.csrfToken || state.creating; $('create-session-button').textContent = state.creating ? '创建中…' : '创建任务'; $('new-task-model').textContent = safeText(hermesModels.label()); $('new-task-connection').textContent = state.newTaskError || (ready ? '' : '请先连接 Hermes，再创建任务。'); $('new-task-connection').className = state.newTaskError ? 'error-text' : 'helper'; $('new-task-connect').hidden = ready; $('new-task-connect').disabled = state.connecting || !state.csrfToken; }
function openNewTask() { state.newTaskError = ''; $('session-cwd').value = state.route.cwd || preferences().defaultWorkspace || state.backend.cwdDefault || ''; renderNewTaskState(); $('new-task-dialog').showModal(); $('session-title').focus(); }
function applyPreferences(prefs) { document.documentElement.dataset.theme = ['light', 'dark'].includes(prefs.theme) ? prefs.theme : 'system'; document.documentElement.dataset.density = prefs.density === 'compact' ? 'compact' : 'comfortable'; try { localStorage.setItem('workbench-appearance', JSON.stringify({ theme: prefs.theme, density: prefs.density })); } catch {} }
function renderSettings() {
  assistantPermissions.render();
  const settings = state.settings; const runtime = settings?.runtime || {}; const prefs = preferences();
  if (!state.settingsDirty) { $('setting-theme').value = prefs.theme; $('setting-density').value = prefs.density; $('setting-workspace').value = prefs.defaultWorkspace; }
  $('save-preferences').disabled = state.saving || !state.csrfToken || !settings; $('save-preferences').textContent = state.saving ? '保存中…' : '保存偏好';
  for (const id of ['setting-theme', 'setting-density', 'setting-workspace']) $(id).disabled = state.saving || !settings;
  $('runtime-facts').replaceChildren(...factList([['连接状态', backendLabels[state.backend.state] || '尚未检查'], ['提供商', hermesModels.current().provider || state.backend.provider || runtime.provider], ['当前模型', hermesModels.current().model || state.backend.model], ['认证状态', state.backend.authenticated === true ? '已认证' : state.backend.authenticated === false ? '未认证' : '尚未检查'], ['Hermes 版本', state.backend.hermesVersion || runtime.hermesVersion], ['审批模式', settings?.approvalMode === 'manual' ? '手动审批' : settings?.approvalMode === 'smart' ? '智能审批' : '尚未确认']]).children);
  $('runtime-paths').replaceChildren(...factList([['Hermes 程序', runtime.hermesRoot], ['Hermes 目录', runtime.hermesHome], ['工作区根目录', runtime.workspaceRoot]]).children); renderBackend(); renderEvents();
}
function renderSkills() {
  const data = state.skills; $('refresh-skills').disabled = state.skillsLoading; const search = $('skill-search').value.trim().toLowerCase(); const skills = (data?.skills || []).filter((skill) => !search || `${skillDisplayName(skill)} ${skill.name} ${skill.description} ${skill.source}`.toLowerCase().includes(search)); $('skills-count').textContent = data ? `${skills.length} 项技能` : '';
  const list = $('skill-list'); const detail = $('skill-detail');
  if (state.skillsLoading && !data) { list.replaceChildren(empty('正在读取 Skills…', '', 'sparkles')); detail.replaceChildren(); return; }
  if (data && !data.connected) { list.replaceChildren(empty('尚未连接 Hermes', '', 'sparkles', button('连接 Hermes', connectBackend, 'button quiet small'))); detail.replaceChildren(empty('技能说明', '', 'sparkles')); return; }
  if (data?.error) { list.replaceChildren(empty('Skills 暂时无法读取', data.error, 'sparkles', button('重试', () => loadSkills(true), 'button quiet small'))); detail.replaceChildren(); return; }
  const fragment = document.createDocumentFragment(); for (const skill of skills) { const item = link(`#/skills/${encodeURIComponent(skill.name)}`, '', `skill-item${state.route.name === skill.name ? ' selected' : ''}`); const title = element('h3'); title.append(icon('sparkles'), document.createTextNode(safeText(skillDisplayName(skill)))); item.append(title, element('p', '', skill.description || '未提供说明'), element('span', 'skill-source', [`${skill.enabled === true ? '已启用 · ' : skill.enabled === false ? '未启用 · ' : ''}${skill.source || 'Hermes'}`, skillVersionLabel(skill)].filter(Boolean).join(' · '))); fragment.append(item); } if (!skills.length) fragment.append(empty(data ? '没有匹配的技能' : '正在读取 Skills…', '', 'search')); list.replaceChildren(fragment);
  const selected = state.skillDetails.get(state.route.name); if (!state.route.name) detail.replaceChildren(empty('选择一项技能', '', 'sparkles')); else if (!selected) detail.replaceChildren(empty('正在读取技能内容…', '', 'sparkles')); else if (selected.error) detail.replaceChildren(empty('无法读取技能内容', selected.error, 'sparkles')); else detail.replaceChildren(element('h2', '', skillDisplayName(selected)), element('span', 'skill-source mono', [selected.source || 'Hermes', skillVersionLabel(selected), skillDisplayName(selected) !== selected.name ? selected.name : ''].filter(Boolean).join(' · ')), element('p', '', selected.description || ''), element('pre', 'skill-content', selected.content || '这项技能未提供正文。'));
}
let statisticsDashboard, statisticsRefreshTimer;
const statisticsHistory = { loading: false, status: '', error: false };
function renderStatistics() {
  const days = $('statistics-period').value, data = state.stats.get(days);
  statisticsDashboard ||= new StatisticsDashboard($('statistics-content'), { onRefresh: () => void loadStatistics(true), onImportHistory: backfillStatisticsHistory });
  statisticsDashboard.render(data?.dashboard, { days: Number(days), loading: state.statsPending.has(days), error: data?.error || '',
    historyLoading: statisticsHistory.loading, historyStatus: statisticsHistory.status, historyError: statisticsHistory.error });
}
async function backfillStatisticsHistory() {
  if (statisticsHistory.loading) return;
  statisticsHistory.loading = true; statisticsHistory.status = ''; statisticsHistory.error = false; renderStatistics();
  try {
    const result = await api('/api/statistics/history', { method: 'POST', body: {} });
    statisticsHistory.status = `已归属 ${result.attributedRuns ?? 0} 次运行 · ${result.contextSnapshots ?? 0} 个历史上下文`;
    state.stats.clear(); await loadStatistics(true);
  } catch (error) { statisticsHistory.error = true; statisticsHistory.status = `历史补齐失败：${safeText(error.message)}`; }
  finally { statisticsHistory.loading = false; if (state.route.page === 'statistics') renderStatistics(); }
}
function invalidateStatistics() {
  state.stats.clear();
  if (state.route.page !== 'statistics' || statisticsRefreshTimer) return;
  statisticsRefreshTimer = setTimeout(() => { statisticsRefreshTimer = null; if (state.route.page === 'statistics') void loadStatistics(true); }, 3000);
}
async function loadHistory(id, { quiet = false } = {}) {
  if (!id || state.backend.state !== 'ready') return; const revision = (state.historyRevision.get(id) || 0) + 1; state.historyRevision.set(id, revision);
  const messageRevision = state.messageRevision.get(id) || 0;
  if (id === state.selectedId && !quiet) { state.historyLoading = true; renderMessages(); }
  try { const result = await api(`/api/sessions/${encodeURIComponent(id)}/history`); if (state.historyRevision.get(id) !== revision || (state.messageRevision.get(id) || 0) !== messageRevision) return; state.histories.set(id, Array.isArray(result.messages) ? result.messages : []); state.info.set(id, result.info || {}); if (id === state.selectedId) { renderMessages(); renderTaskInfo(); renderInspector(); } }
  catch (error) { if (id === state.selectedId) notify(`读取任务历史失败：${error.message}`, true); }
  finally { if (id === state.selectedId && state.historyRevision.get(id) === revision) { state.historyLoading = false; renderComposer(); } }
}
async function loadRuns(id) { if (!id) return; try { const result = await api(`/api/sessions/${encodeURIComponent(id)}/runs`); state.runs.set(id, result.runs || []); if (id === state.selectedId) renderTaskRuns(); } catch (error) { if (id === state.selectedId) $('task-runs').replaceChildren(empty('无法读取执行记录', error.message, 'clock')); } }
async function loadSettings() { if (state.settingsLoading) return; state.settingsLoading = true; try { state.settings = await api('/api/settings'); applyPreferences(preferences()); if (state.route.page === 'settings') renderSettings(); renderNewTaskState(); } catch (error) { if (state.route.page === 'settings') $('preferences-status').textContent = `设置读取失败：${error.message}`; } finally { state.settingsLoading = false; } }
async function loadSkills(force = false) { if (state.skillsLoading || state.skills && !force) return; state.skillsLoading = true; renderSkills(); try { state.skills = await api('/api/skills'); } catch (error) { state.skills = { connected: state.backend.state === 'ready', skills: [], error: error.message }; } finally { state.skillsLoading = false; if (state.route.page === 'skills') renderSkills(); } }
async function loadSkillDetail(name) { if (!name || state.skillDetails.has(name) || state.skillLoading === name) return; state.skillLoading = name; try { state.skillDetails.set(name, await api(`/api/skills/${encodeURIComponent(name)}`)); } catch (error) { state.skillDetails.set(name, { error: error.message }); } finally { state.skillLoading = null; if (state.route.page === 'skills' && state.route.name === name) renderSkills(); } }
async function loadStatistics(force = false) { const days = $('statistics-period').value; if (state.statsPending.has(days) || state.stats.has(days) && !force) return; state.statsPending.add(days); renderStatistics(); try { state.stats.set(days, await api(`/api/statistics?days=${days}`)); } catch (error) { state.stats.set(days, { error: error.message }); } finally { state.statsPending.delete(days); if (state.route.page === 'statistics') renderStatistics(); } }
async function loadRouteData() {
  const load = ++routeLoad, route = { ...state.route };
  if (route.page === 'board' || route.page === 'workflows') {
    try {
      ensureWorkflowEditor(); await workflowLibraryClient.initialize();
      if (load !== routeLoad || state.route.page !== route.page || state.route.id !== route.id) return;
      if (route.page === 'board') {
        await workflowLibraryClient.flush();
        if (load === routeLoad && state.route.page === 'board') { ensureWorkflowBoard(); await workflowBoard.load(); }
      } else {
        const id = route.id || workflowLibraryClient.currentId;
        if (!id) { navigate('#/board'); return; }
        if (!route.id) { navigate(`#/workflows/${encodeURIComponent(id)}`); return; }
        const opened = await workflowLibraryClient.open(id);
        if (load === routeLoad && state.route.page === 'workflows' && state.route.id === id) {
          if (!opened) { workflowLoading('工作流打开被状态变化中断，请重试；本地草稿已保留。', true); return; }
          if (workflowLibraryClient.currentId !== id) {
            history.replaceState(null, '', `#/workflows/${encodeURIComponent(workflowLibraryClient.currentId)}`); state.route = readRoute();
          }
          workflowLoading(); workflowEditor.activate(); await workflowEditor.runtime.activate(); renderShell();
        }
      }
    } catch (error) {
      if (load !== routeLoad || state.route.page !== route.page) return;
      if (route.page === 'workflows') workflowLoading(`工作流打开失败：${error.message}`, true);
      else notify(`工作流草稿同步失败：${error.message}。本地草稿仍保留，可进入节点编辑器保存或导出。`, true);
    }
  } else if (route.page === 'conversations') { ensureConversationHub(); await conversationHub.activate(route); }
  else if (route.page === 'task') await Promise.allSettled([loadHistory(state.selectedId), loadRuns(state.selectedId)]);
  else if (route.page === 'skills') { await loadSkills(); await loadSkillDetail(route.name); }
  else if (route.page === 'statistics') await loadStatistics();
  else if (route.page === 'settings') await Promise.allSettled([loadSettings(), assistantPermissions.refresh()]);
}
async function synchronize() {
  if (state.refreshing) return false; state.refreshing = true; renderBackend();
  const revision = state.eventRevision;
  try { const result = await api('/api/bootstrap'); const restarted = state.csrfToken && state.csrfToken !== result.csrfToken;
    if (state.lastEventId === null || restarted) state.lastEventId = Number.isFinite(result.eventCursor) ? result.eventCursor : 0;
    if (restarted) { state.streams.clear(); state.tools.clear(); state.posting.clear(); state.requests.clear(); state.sessionRevision.clear(); state.turnRevision.clear(); state.messageRevision.clear(); state.backendRevision = 0; state.requestsRevision = 0; }
    state.csrfToken = result.csrfToken || ''; if (state.backendRevision <= revision || restarted) state.backend = result.backend || {};
    const sessions = new Map((Array.isArray(result.sessions) ? result.sessions : []).map((session) => [session.id, session]));
    for (const session of state.sessions) if ((state.sessionRevision.get(session.id) || 0) > revision && !restarted) sessions.set(session.id, session);
    state.sessions = [...sessions.values()]; if (state.requestsRevision <= revision || restarted) state.requests = new Map((result.requests || []).map((request) => [String(request.id), request])); state.bootstrapped = true;
    for (const id of state.streams.keys()) if (!['running', 'busy', 'waiting'].includes(state.sessions.find((session) => session.id === id)?.status)) { state.streams.delete(id); state.tools.delete(id); state.posting.delete(id); }
    renderShell(); renderPage();
    if (state.route.page === 'board' && workflowBoard?.loaded) void workflowBoard.load();
    if (state.route.page === 'task') await loadHistory(state.selectedId, { quiet: true }); return true;
  } catch (error) { state.transport = 'error'; notify(`无法读取本地服务：${error.message}`, true); return false; } finally { state.refreshing = false; renderBackend(); }
}
function updateSessionViews() { renderShell(); if (state.route.page === 'board') workflowBoard?.renderPending(); if (state.route.page === 'conversations') conversationHub?.renderHistory(); if (state.route.page === 'task') { const session = selectedSession(); $('task-title').textContent = safeText(session?.title || '任务'); $('task-status').replaceWith(Object.assign(badge(session?.status), { id: 'task-status' })); renderTaskInfo(); renderComposer(); renderInspector(); } }
function receiveEvent(event) {
  if (/^(?:workflow\.(?:run|conversation|learning|lifecycle|document|artifact)|application\.conversation|statistics\.history|session\.usage|message\.complete|session\.created|session\.deleted)/.test(event.type)) invalidateStatistics();
  const payload = event.payload || {}; const id = event.sessionId || payload.sessionId; const revision = ++state.eventRevision;
  if (id) state.sessionRevision.set(id, revision);
  if (id && (/^message\./.test(event.type) || /^request\./.test(event.type) || event.type === 'error')) state.turnRevision.set(id, revision);
  if (id && /^message\./.test(event.type)) state.messageRevision.set(id, (state.messageRevision.get(id) || 0) + 1);
  if (/^request\./.test(event.type)) state.requestsRevision = revision;
  if (/^backend\./.test(event.type)) state.backendRevision = revision;
  addEvent(event);
  switch (event.type) {
    case 'backend.status': state.backend = { ...state.backend, ...(payload.backend || payload) }; if (['stopped', 'disconnected', 'error'].includes(state.backend.state)) { state.streams.clear(); state.tools.clear(); state.posting.clear(); if (state.route.page === 'task') renderMessages(); } renderBackend(); if (state.route.page === 'settings') renderSettings(); break;
    case 'models.updated': void hermesModels.refresh({ preserveSelection: hermesModels.nodes.dialog.open }); break;
    case 'backend.error': state.backend = { ...state.backend, state: 'error', lastError: payload.error || payload.message || '后端发生错误。' }; renderBackend(); break;
    case 'settings.updated': if (payload.preferences) { state.settings = { ...(state.settings || {}), preferences: payload.preferences }; applyPreferences(preferences()); renderNewTaskState(); if (state.route.page === 'settings' && !state.saving) renderSettings(); } break;
    case 'session.updated': upsertSession(payload.session || payload); updateSessionViews(); break;
    case 'request.open': { const request = payload.request || payload; if (request.id !== undefined) state.requests.set(String(request.id), { ...request, sessionId: request.sessionId || id }); renderRequests(); updateSessionViews(); break; }
    case 'request.cancel': state.requests.delete(String(payload.id)); renderRequests(); updateSessionViews(); break;
    case 'message.start': if (id) state.streams.set(id, { role: payload.role || 'assistant', text: typeof payload.text === 'string' ? payload.text : '' }); if (id === state.selectedId) renderMessages(); break;
    case 'message.delta': { if (!id) break; const stream = state.streams.get(id) || { role: 'assistant', text: '' }; if (typeof payload.text === 'string') stream.text += payload.text; state.streams.set(id, stream); if (id === state.selectedId) renderMessages(); break; }
    case 'message.complete': { if (!id) break; const stream = state.streams.get(id); const text = typeof payload.text === 'string' ? payload.text : stream?.text || ''; if (text || payload.error) { const messages = state.histories.get(id) || []; messages.push({ role: stream?.role || 'assistant', text, status: payload.status, error: payload.error }); state.histories.set(id, messages); } state.streams.delete(id); state.tools.delete(id); state.posting.delete(id); if (id === state.selectedId) { renderMessages(); void loadRuns(id); } void loadHistory(id, { quiet: true }); updateSessionViews(); break; }
    case 'tool.start': if (id) state.tools.set(id, payload.name || payload.tool_name || payload.tool || '工具'); renderComposer(); renderInspector(); break;
    case 'tool.complete': if (id) state.tools.delete(id); renderComposer(); renderInspector(); break;
    case 'error': if (id) { state.streams.delete(id); state.tools.delete(id); state.posting.delete(id); } notify(`执行错误：${payload.message || payload.error || '请查看执行详情。'}`, true); if (id === state.selectedId) renderMessages(); break;
    default: break;
  }
  if (event.type === 'workflow.lifecycle') workflowLibraryClient?.handleLifecycle(event.payload);
  workflowEditor?.runtime?.handleEvent(event);
  workflowEditor?.conversation?.onEvent(event);
  applicationConversation?.onEvent(event);
  conversationHub?.onEvent(event);
  workflowBoard?.handleEvent(event);
}
function scheduleReconnect() { if (state.closed || state.reconnectTimer) return; state.reconnectTimer = setTimeout(async () => { state.reconnectTimer = null; const ok = await synchronize(); if (ok) openEvents(); else scheduleReconnect(); }, Math.min(1000 * 2 ** state.retry++, 10000)); }
function openEvents() { if (diagnosticCapture) { state.transport = 'diagnostic-readonly'; return; } if (state.closed) return; state.source?.close(); const source = new EventSource(`/api/events?after=${state.lastEventId ?? 0}`); state.source = source; source.onopen = () => { if (state.source !== source) return; state.retry = 0; state.transport = 'live'; renderBackend(); }; source.onmessage = ({ data }) => { if (state.source !== source) return; try { const event = JSON.parse(data); if (typeof event.id === 'number' && event.id <= (state.lastEventId ?? -1)) return; receiveEvent(event); if (typeof event.id === 'number') state.lastEventId = event.id; } catch (error) { notify(`无法处理事件：${error.message}`, true); } }; source.onerror = () => { if (state.source !== source) return; source.close(); state.source = null; state.transport = 'reconnecting'; renderBackend(); scheduleReconnect(); }; }
async function connectBackend() { if (state.connecting) return; state.connecting = true; state.newTaskError = ''; notify(''); renderBackend(); try { const result = await api('/api/connect', { method: 'POST', body: {} }); state.backend = result.backend || result; state.skills = null; await Promise.allSettled([loadSettings(), synchronize(), hermesModels.refresh({ preserveSelection: true })]); await loadRouteData(); notify('Hermes 已连接。'); return true; } catch (error) { notify(`连接失败：${error.message}`, true); if ($('new-task-dialog').open) state.newTaskError = safeText(error.message); return false; } finally { state.connecting = false; renderBackend(); } }

$('new-task-button').addEventListener('click', () => { if (state.route.page === 'workflows') void createWorkflow().catch(error => notify(`工作流创建失败：${error.message}`, true)); else openNewTask(); });
for (const id of ['close-new-task', 'cancel-new-task']) $(id).addEventListener('click', () => $('new-task-dialog').close());
$('sidebar-toggle').addEventListener('click', () => {
  if (sidebarMedia.matches) sidebarMobileOpen = !sidebarMobileOpen;
  else {
    sidebarCollapsed = !sidebarCollapsed;
    try { localStorage.setItem('workbench-sidebar-collapsed', String(sidebarCollapsed)); } catch {}
  }
  renderSidebar();
});
$('sidebar-backdrop').addEventListener('click', () => closeMobileSidebar({ focus: true }));
sidebarMedia.addEventListener('change', () => closeMobileSidebar());
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && sidebarMedia.matches && sidebarMobileOpen) {
    event.preventDefault(); closeMobileSidebar({ focus: true });
  }
});
$('sidebar-connect').addEventListener('click', () => state.backend.state === 'ready' ? navigate('#/settings') : connectBackend());
$('notice-close').addEventListener('click', () => notify(''));
$('connect-button').addEventListener('click', connectBackend);
$('new-task-connect').addEventListener('click', connectBackend);
$('refresh-button').addEventListener('click', async () => { const ok = await synchronize(); await Promise.allSettled([loadSettings(), assistantPermissions.refresh(), hermesModels.refresh({ preserveSelection: true })]); if (ok && !state.source) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; openEvents(); } });
$('details-button').addEventListener('click', () => setTaskQuery({ panel: state.route.panel ? '' : 'execution' }));
$('close-inspector').addEventListener('click', () => setTaskQuery({ panel: '' }));
for (const tab of $('inspector-tabs').querySelectorAll('button')) tab.addEventListener('click', () => setTaskQuery({ panel: tab.dataset.inspector }));
$('skill-search').addEventListener('input', renderSkills);
$('refresh-skills').addEventListener('click', () => { state.skillDetails.clear(); void loadSkills(true).then(() => loadSkillDetail(state.route.name)); });
$('statistics-period').addEventListener('change', () => { renderStatistics(); void loadStatistics(); });
$('preferences-form').addEventListener('input', () => { state.settingsDirty = true; $('preferences-status').textContent = '有未保存的更改'; });
$('preferences-form').addEventListener('submit', async (event) => { event.preventDefault(); if (state.saving) return; state.saving = true; $('preferences-status').textContent = '正在保存…'; renderSettings(); try { const prefs = { theme: $('setting-theme').value, density: $('setting-density').value, defaultWorkspace: $('setting-workspace').value.trim() }; state.settings = await api('/api/settings', { method: 'POST', body: { preferences: prefs } }); state.settingsDirty = false; applyPreferences(preferences()); await synchronize(); $('preferences-status').textContent = '偏好已保存'; } catch (error) { $('preferences-status').textContent = `保存失败：${error.message}`; } finally { state.saving = false; renderSettings(); } });
$('session-form').addEventListener('submit', async (event) => { event.preventDefault(); if (state.creating || state.backend.state !== 'ready') return; state.creating = true; state.newTaskError = ''; renderNewTaskState(); notify(''); try { const result = await api('/api/sessions', { method: 'POST', body: { title: $('session-title').value.trim(), cwd: $('session-cwd').value.trim() } }); const session = result.session || result; upsertSession(session); state.histories.set(session.id, []); state.historyLoading = false; $('session-title').value = ''; $('session-cwd').value = ''; $('new-task-dialog').close(); navigate(taskURL(session.id)); } catch (error) { notify(`创建任务失败：${error.message}`, true); state.newTaskError = safeText(error.message); } finally { state.creating = false; renderNewTaskState(); } });
$('resume-button').addEventListener('click', async () => { const id = state.selectedId; if (!id || state.resuming) return; const turnRevision = state.turnRevision.get(id) || 0; state.resuming = true; state.historyRevision.set(id, (state.historyRevision.get(id) || 0) + 1); notify(''); renderComposer(); try { const result = await api(`/api/sessions/${encodeURIComponent(id)}/resume`, { method: 'POST', body: {} }); if ((state.turnRevision.get(id) || 0) !== turnRevision) { await synchronize(); await loadHistory(id, { quiet: true }); notify('会话已恢复，并同步了较新的执行状态。'); return; } upsertSession(result.session); const snapshot = result.snapshot || {}; state.histories.set(id, snapshot.messages || []); state.info.set(id, snapshot.info || {}); for (const [key, request] of state.requests) if (request.sessionId === id) state.requests.delete(key); for (const request of snapshot.open_requests || []) state.requests.set(String(request.id), { ...request, sessionId: request.sessionId || id }); if (snapshot.inflight?.streaming || snapshot.running || snapshot.inflight === true) { const inflight = Array.isArray(snapshot.inflight) ? snapshot.inflight.at(-1) : snapshot.inflight; state.streams.set(id, { role: 'assistant', text: typeof inflight?.text === 'string' ? inflight.text : typeof inflight?.assistant === 'string' ? inflight.assistant : '' }); } else state.streams.delete(id); renderTask(); await loadHistory(id, { quiet: true }); notify('任务会话已恢复。'); } catch (error) { notify(`恢复失败：${error.message}`, true); } finally { state.resuming = false; renderComposer(); } });
$('message-form').addEventListener('submit', async (event) => { event.preventDefault(); const id = state.selectedId; const text = $('message-input').value.trim(); if (!id || !text || isBusy(id) || state.backend.state !== 'ready') return; state.posting.add(id); state.messageRevision.set(id, (state.messageRevision.get(id) || 0) + 1); notify(''); const message = { role: 'user', text }; const messages = state.histories.get(id) || []; messages.push(message); state.histories.set(id, messages); $('message-input').value = ''; state.messageDrafts.delete(id); renderMessages({ follow: true }); try { await api(`/api/sessions/${encodeURIComponent(id)}/messages`, { method: 'POST', body: { text } }); } catch (error) { const history = state.histories.get(id); const index = history?.indexOf(message) ?? -1; if (index >= 0) history.splice(index, 1); if (state.selectedId === id && !$('message-input').value) $('message-input').value = text; state.messageDrafts.set(id, text); notify(`发送失败：${error.message}`, true); if (id === state.selectedId) renderMessages(); } finally { state.posting.delete(id); updateSessionViews(); } });
$('message-input').addEventListener('input', () => { if (state.selectedId) state.messageDrafts.set(state.selectedId, $('message-input').value); renderComposer(); });
$('message-input').addEventListener('keydown', (event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); if (!$('send-button').disabled) $('message-form').requestSubmit(); } });
$('interrupt-button').addEventListener('click', async () => { const id = state.selectedId; if (!id || state.interrupting.has(id)) return; state.interrupting.add(id); renderComposer(); try { await api(`/api/sessions/${encodeURIComponent(id)}/interrupt`, { method: 'POST', body: {} }); notify('停止请求已发送，等待后端确认。'); } catch (error) { notify(`停止失败：${error.message}`, true); } finally { state.interrupting.delete(id); renderComposer(); } });
$('clear-events-button').addEventListener('click', () => { state.events = []; renderEvents(); });
window.addEventListener('hashchange', routeChanged);
window.addEventListener('pagehide', () => { state.closed = true; state.source?.close(); clearTimeout(state.reconnectTimer); conversationHub?.deactivate(); });
window.addEventListener('pageshow', (event) => { if (event.persisted) { state.closed = false; state.reconnectTimer = null; void synchronize().then((ok) => ok ? openEvents() : scheduleReconnect()); } });
try { const cached = JSON.parse(localStorage.getItem('workbench-appearance')); if (cached) applyPreferences(cached); } catch {}
normalizeRoute();
state.route = readRoute(); state.selectedId = state.route.page === 'task' ? state.route.id : null;
renderShell(); renderPage();
const startup = await Promise.allSettled([synchronize(), loadSettings(), hermesModels.refresh()]);
if (startup[0].status === 'fulfilled' && startup[0].value) { openEvents(); await loadRouteData(); } else scheduleReconnect();
