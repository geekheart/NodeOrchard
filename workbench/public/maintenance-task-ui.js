const STATUS = { ready: '待继续', running: '进行中', waiting_permission: '等待权限', waiting_continue: '待继续', unknown: '待确认', stopped: '已停止', verified: '所列范围通过', candidate_verified: '候选验证通过', failed: '未通过' };
const STAGE = { diagnose: '诊断', reproduce: '复现', repair: '修复', verify: '验证' };
const RESULT = { pass: '通过', passed: '通过', fail: '未通过', failed: '未通过', verified: '通过', unavailable: '不可用', unknown: '待确认', timeout: '超时', stale: '源码已变化', cancelled: '已停止' };
const SCOPE = { 'isolated-source-tests': '源码副本相关测试', 'isolated-node-reproduction': '单节点隔离复现' };
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
const text = (value, limit = 600) => (typeof value === 'string' ? value : '').replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[已隐藏密钥]').replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [已隐藏]')
  .replace(/((?:api[_ -]?key|token|password|secret|authorization)["']?\s*[:=]\s*["']?)[^\s"',;}\]]+/gi, '$1[已隐藏]').slice(0, limit);
const element = (tag, className, value) => { const node = document.createElement(tag); if (className) node.className = className; if (value) node.textContent = text(value); return node; };

export function projectMaintenanceTask(value) {
  if (!value || !identifier(value.id) || !identifier(value.conversationId) || !identifier(value.sourceTurnId)
    || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Object.hasOwn(STATUS, value.status) || !Object.hasOwn(STAGE, value.stage)
    || value.workflowId != null && !identifier(value.workflowId)) return null;
  const result = { id: value.id, revision: value.revision, conversationId: value.conversationId, sourceTurnId: value.sourceTurnId,
    workflowId: value.workflowId || null, status: value.status, stage: value.stage, summary: text(value.summary || value.goal), note: text(value.note),
    canContinue: value.canContinue === true, canStop: value.canStop === true };
  if (value.permissionRequest?.permission === 'supervisor.sourceRepair') result.permissionRequest = {
    permission: 'supervisor.sourceRepair', enabled: value.permissionRequest.enabled === true, settingsUrl: '#/settings', reason: text(value.permissionRequest.reason),
  };
  if (value.lastExperiment && typeof value.lastExperiment === 'object') result.lastExperiment = {
    status: text(value.lastExperiment.status, 40), summary: text(value.lastExperiment.summary, 300),
    scope: Object.hasOwn(SCOPE, value.lastExperiment.scope) ? value.lastExperiment.scope : null,
  };
  return result;
}

export function rememberMaintenanceTask(state, value, { supervisor = false, conversationId, workflowId } = {}) {
  const task = projectMaintenanceTask(value);
  if (!task || (supervisor ? task.conversationId !== conversationId : task.workflowId !== workflowId)) return null;
  state.maintenanceTasks ||= new Map(); const previous = state.maintenanceTasks.get(task.id);
  if (!previous || previous.revision <= task.revision) state.maintenanceTasks.set(task.id, task);
  return state.maintenanceTasks.get(task.id);
}

export function renderMaintenanceTask(value, { supervisor = false, busy = false, continueDisabled = false, onContinue, onStop } = {}) {
  const task = projectMaintenanceTask(value); if (!task) return null;
  const card = element('section', 'wf-conversation-proposal wf-maintenance-task'); card.setAttribute('aria-label', '维护任务'); card.dataset.maintenanceTaskId = task.id;
  const heading = element('div', 'wf-conversation-message-meta');
  heading.append(element('strong', '', `维护 · ${STAGE[task.stage]}`), element('span', 'wf-conversation-turn-state', STATUS[task.status])); card.append(heading);
  if (task.summary) card.append(element('p', 'wf-conversation-prose', task.summary));
  if (task.note && task.note !== task.summary) card.append(element('p', 'wf-conversation-message-scope', task.note));
  if (task.lastExperiment?.status) card.append(element('p', 'wf-conversation-message-scope', `${SCOPE[task.lastExperiment.scope] || '最近验证'}：${RESULT[task.lastExperiment.status] || text(task.lastExperiment.status, 40)}${task.lastExperiment.summary ? ' · ' + task.lastExperiment.summary : ''}`));
  const actions = element('div', 'wf-conversation-actions');
  if (!supervisor) {
    const link = element('a', 'wf-conversation-link', '打开总控对话'); link.href = '#/conversations/' + encodeURIComponent(task.conversationId); actions.append(link);
  } else {
    if (task.permissionRequest && !task.permissionRequest.enabled) {
      if (task.permissionRequest.reason) card.append(element('p', 'wf-conversation-message-scope', task.permissionRequest.reason));
      const link = element('a', 'wf-conversation-link', '打开权限设置'); link.href = '#/settings'; actions.append(link);
    }
    const proceed = element('button', 'wf-button primary', '继续维护'); proceed.type = 'button'; proceed.disabled = busy || continueDisabled || !task.canContinue;
    proceed.addEventListener('click', () => { if (!proceed.disabled) return onContinue?.(task); }); actions.append(proceed);
    if (task.canStop) {
      const stop = element('button', 'wf-button', '停止维护'); stop.type = 'button'; stop.disabled = busy;
      stop.addEventListener('click', () => { if (!stop.disabled) return onStop?.(task); }); actions.append(stop);
    }
  }
  card.append(actions); return card;
}
