import { documentFingerprint, applyWorkflowOperations } from '../shared/workflow/workflow-conversation-commands.mjs';
import { runArtifacts, STUDIO_STATUS } from '../shared/workflow/workflow-studio-utils.mjs';
import { conversationTurnGroups, canRetryConversationTurn, parseConversationIssueResolution } from '../shared/workflow/workflow-conversation-issues.mjs';
import { setToolbarControl } from './workflow-toolbar-controls.js';
import { reviewRevisionPolicy } from '../shared/workflow/workflow-review-revision.mjs';
import { bindChatSendShortcut, updateChatShortcutHints } from './keyboard-shortcuts.js';
import { ConversationAttachments } from './conversation-attachments.js';
import { PendingNoticeDismissals, pendingNoticeKey } from './pending-notice-dismissals.js';

export { conversationTurnGroups } from '../shared/workflow/workflow-conversation-issues.mjs';

const clean = value => String(value ?? '').replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[已隐藏密钥]').replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [已隐藏]').replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|authorization)["']?\s*[:=]\s*["']?)([^\s"',;}\]]+)/gi, '$1[已隐藏]');
const element = (tag, className = '', text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = clean(text); return node; };
const button = (label, action, className = 'wf-button') => { const node = element('button', className, label); node.type = 'button'; node.addEventListener('click', action); return node; };
const clone = value => structuredClone(value);
const truncate = (value, size = 70) => { const text = clean(value); return text.length > size ? text.slice(0, size) + '…' : text; };
const valueText = value => typeof value === 'string' ? clean(value) : value === undefined ? '' : clean(JSON.stringify(value, null, 2));
const shortId = value => String(value || '').slice(0, 8);
const PENDING_PREFERENCE = 'workbench.conversation-pending-expanded:';
const settled = turn => ['resolved', 'superseded'].includes(turn?.pendingState?.status);
const turnStatus = turn => settled(turn) && turn.pendingState.label || TURN_STATUS[turn.status] || '已记录';
const contextKey = value => JSON.stringify(Object.fromEntries(Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b))));
const reviewContextKey = value => contextKey(Object.fromEntries(['runId', 'nodeId', 'attempt', 'attemptId'].map(key => [key, value?.[key]])));
const pendingReviewNoticeKey = item => pendingNoticeKey(item.kind === 'review' ? 'review' : 'pending', item.id ?? null,
  ...['runId', 'nodeId', 'attempt', 'attemptId'].map(key => item.context?.[key] ?? null),
  (Array.isArray(item.context?.artifactHashes) ? item.context.artifactHashes : []).map(hash => [hash?.id ?? null, typeof hash?.sha256 === 'string' ? hash.sha256.toLowerCase() : null]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  ...(item.kind === 'review' ? [] : [item.kind ?? null, item.status ?? null, item.updatedAt ?? null, item.version ?? null]));
const pendingTurnNoticeKey = turn => pendingNoticeKey('turn', turn.id, turn.status, turn.updatedAt ?? null, turn.version ?? null);
const pendingFailureNoticeKey = run => pendingNoticeKey('failure', run.id, run.status, run.completedAt ?? null);
const coveredReview = (turn, pending) => {
  const actions = turn.actions || [];
  return actions.length > 0 && actions.every(action => action.kind?.startsWith('review-') && action.context?.runId && action.context?.nodeId
    && Number.isInteger(action.context.attempt) && action.context.attemptId
    && pending.some(item => item.kind === 'review' && ['runId', 'nodeId', 'attempt', 'attemptId'].every(key => item.context?.[key] === action.context[key])));
};
const INTENTS = [['auto', '自动理解'], ['discuss', '对话与咨询'], ['workflow', '搭建 / 修改流程'], ['redo', '重做本次产物'], ['feedback', '记录产物反馈'], ['skill', '改进 Skill']];
const TURN_STATUS = { thinking: '正在思考', queued: '正在准备', proposed: '待应用修改', awaiting_action: '待选择操作', complete: '已记录', error: '处理失败', applied: '已应用', interrupted: '已中断', dismissed: '已结束事项' };
const image = item => /^image\//.test(item.mimeType || '') || /\.(png|jpe?g|webp|gif|svg)$/i.test(item.name || item.path || '');
const safeArtifactURL = value => typeof value === 'string' && /^\/api\/workflow-v2\/artifacts\/[A-Za-z0-9_-]+(?:\?download=1)?$/.test(value) ? value : null;
const duration = milliseconds => { if (milliseconds === null) return '—'; const seconds = Math.floor(Math.max(0, milliseconds || 0) / 1000); return seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分${seconds % 60}秒`; };
const elapsed = (startedAt, end, fallback = 0) => Number.isFinite(Date.parse(startedAt)) && Number.isFinite(end) ? Math.max(0, end - Date.parse(startedAt)) : Math.max(0, Number(fallback) || 0);

// Only stage metadata belongs in the message bubble. Checkpoint results are
// evidence for the broker and may contain large logs or business documents.
export function conversationDiagnosticProgress(turn, at = Date.now()) {
  const progress = turn?.assistant?.progress, checkpoint = turn?.assistant?.checkpoint;
  if (!progress && !checkpoint?.steps?.length) return null;
  const active = ['thinking', 'queued'].includes(turn.status);
  const turnStartedAt = [turn.createdAt, progress?.turnStartedAt, checkpoint?.createdAt].find(value => Number.isFinite(Date.parse(value)));
  const completed = [progress?.completedAt,
    ...(['complete', 'completed', 'error', 'failed', 'interrupted', 'cancelled'].includes(checkpoint?.status) ? [checkpoint.updatedAt] : []),
    ...(!['applied', 'dismissed'].includes(turn.status) ? [turn.updatedAt] : [])]
    .find(value => Number.isFinite(Date.parse(value)) && (!turnStartedAt || Date.parse(value) >= Date.parse(turnStartedAt)));
  const end = active ? at : Date.parse(completed);
  const steps = (checkpoint?.steps || []).slice(-40).map(step => ({ label: clean(step.label || step.tool || step.stage || '检查').slice(0, 240),
    status: step.status, elapsedMs: Number(step.elapsedMs) || 0, ...(step.error ? { error: clean(step.error).slice(0, 400) } : {}) }));
  return { label: clean(progress?.label || steps.at(-1)?.label || '整理诊断结果').slice(0, 240), active,
    elapsedMs: active ? elapsed(progress?.startedAt, at, progress?.elapsedMs) : Number.isFinite(progress?.elapsedMs) ? progress.elapsedMs : elapsed(progress?.startedAt, end),
    turnStartedAt: turnStartedAt || null,
    totalElapsedMs: turnStartedAt && Number.isFinite(end) ? elapsed(turnStartedAt, end) : null,
    modelCalls: Math.max(0, Number(progress?.modelCalls) || 0), toolCalls: Math.max(0, Number(progress?.toolCalls) || 0), steps,
    completed: steps.filter(step => ['complete', 'cached'].includes(step.status)).length,
    failed: steps.filter(step => ['error', 'interrupted'].includes(step.status)).length };
}

// Scope is captured when sending a turn, never read again from the selection
// when an asynchronous answer arrives. Artifact identity is bound to an attempt.
export function conversationContext(document, run, nodeId, attachment = {}) {
  const context = {}, id = attachment.nodeId || nodeId, currentNode = document?.nodes?.find(node => node.id === id), snapshotNode = run?.document?.nodes?.find(node => node.id === id);
  const sameRun = run?.workflowId === document?.id && !run.learningId && !run.memoryScopeId && (!id || snapshotNode && (!currentNode || snapshotNode.type === currentNode.type));
  if (sameRun) context.runId = run.id;
  if (id && (document?.nodes?.some(node => node.id === id) || sameRun && run.document?.nodes?.some(node => node.id === id))) context.nodeId = id;
  const state = sameRun && context.nodeId ? run.nodes?.[context.nodeId] : null;
  if (state) { if (Number.isInteger(state.attempt)) context.attempt = state.attempt; if (typeof state.attemptId === 'string') context.attemptId = state.attemptId; }
  if (sameRun && context.nodeId && Array.isArray(attachment.artifactIds) && attachment.artifactIds.length) {
    const artifacts = state?.artifacts || [], allowed = new Map(artifacts.map(item => [item.id || item.artifactId, item]));
    const ids = [...new Set(attachment.artifactIds)].filter(id => allowed.has(id));
    if (ids.length) { context.artifactIds = ids; const hashes = ids.map(id => ({ id, sha256: allowed.get(id).sha256 })).filter(item => /^[a-f0-9]{64}$/i.test(item.sha256 || '')); if (hashes.length) context.artifactHashes = hashes; }
  }
  return context;
}

export const canDismissConversationTurn = turn => ['proposed', 'error', 'interrupted', 'awaiting_action'].includes(turn?.status) && !settled(turn) && !turn.actions?.some(action => action.kind?.startsWith('review-'));
export const isConversationRunCommand = value => /^(?:(?:请|帮我)\s*)?(?:运行|开始运行|立即运行|直接运行|运行一次|执行|开始执行|直接执行|运行当前流程|运行流程|执行当前流程)[。！!\s]*$/.test(value.trim());

export class WorkflowConversationUI {
  constructor(editor, { api, getBackend = () => null, getPageDiagnostics = () => ({}), getShortcuts = () => undefined, attachmentsClient, attachmentScope = 'workflow' }) {
    this.getPageDiagnostics = getPageDiagnostics;
    this.getShortcuts = getShortcuts;
    this.editor = editor; this.api = api; this.getBackend = getBackend; this.states = new Map(); this.runtime = null; this.workflowId = null; this.attachment = null; this.destroyed = false; this.applied = new Map(); this.actionPending = new Set(); this.documentGeneration = 0; this.detachedWorkflows = new Set();
    this.fileAttachments = new ConversationAttachments(this, { scope: attachmentScope, client: attachmentsClient });
    this.mount(); this.syncWorkflow();
  }
  currentDocument() { return this.editor.documentLoaded === false ? null : this.editor.nodeLibrary?.rootDocument || this.editor.doc; }
  state(id = this.workflowId) {
    if (!this.states.has(id)) {
      let pendingExpanded = false; try { pendingExpanded = localStorage.getItem(PENDING_PREFERENCE + id) === 'true'; } catch { /* Keep the current preference in memory. */ }
      this.states.set(id, { conversation: { workflowId: id, revision: 0, turns: [] }, pending: [], pendingExpanded, draft: '', intent: 'auto', loading: false, loaded: false, sending: false, request: 0, error: '', retry: null, retryOfTurnId: null, retryTarget: null, issueReplyTarget: null, expanded: new Set(), messageEdit: 0 });
    }
    const state = this.states.get(id);
    state.pendingNotices ||= new PendingNoticeDismissals(pendingNoticeKey('conversation', this.fileAttachments?.scope || 'workflow', id));
    return state;
  }
  setPendingExpanded(expanded, id = this.workflowId) {
    this.state(id).pendingExpanded = expanded;
    try { localStorage.setItem(PENDING_PREFERENCE + id, String(expanded)); } catch { /* The memory preference still survives renders and SSE. */ }
  }
  clearRetryTarget(state = this.state()) { state.retryOfTurnId = null; state.retryTarget = null; }
  clearIssueTarget(state = this.state()) { state.issueReplyTarget = null; }
  currentIssueTarget(context = this.getContext(), state = this.state()) {
    const target = state.issueReplyTarget, turn = target && state.conversation.turns.find(item => item.id === target.turnId);
    if (!turn || settled(turn) || !['proposed', 'error', 'interrupted', 'awaiting_action'].includes(turn.status) || target.contextKey !== contextKey(context)) {
      this.clearIssueTarget(state); return null;
    }
    return turn;
  }
  focusIssue(turn) {
    if (!turn?.id) return;
    this.focusContext(turn.user?.context || {});
    this.state().issueReplyTarget = { turnId: turn.id, contextKey: contextKey(this.getContext()) };
    this.render(); this.renderContext(); this.input.focus();
  }
  issueReplyTargetFor(text, context, state = this.state()) {
    const turn = this.currentIssueTarget(context, state), command = parseConversationIssueResolution(text);
    return turn && command?.disposition && command.ordinal === undefined ? turn.id : undefined;
  }
  beginRetry(turn) {
    if (!['error', 'interrupted'].includes(turn?.status) || settled(turn)) return;
    if (turn.user?.revisionRequest) {
      const state = this.state();
      if (!canRetryConversationTurn(turn)) { state.error = '此候选事项不能自动重试，请先核对操作状态。'; this.renderNotice(); return false; }
      // A failed model turn still owns its exact review identity and raw text.
      // Keep this retry outside the unrelated composer, including its context.
      if (state.revisionHandoff?.retryOfTurnId !== turn.id) {
        state.revisionHandoff = { text: turn.user.text, intent: 'auto', context: clone(turn.user.context || {}),
          revisionRequest: clone(turn.user.revisionRequest), ...(turn.user.attachments?.length ? { attachments: this.fileAttachments?.referencesFrom(turn.user.attachments) || [] } : {}), retryOfTurnId: turn.id, clientMessageId: crypto.randomUUID() };
        state.revisionHandoffStatus = '原候选请求、完整修改意见和审核版本已保留，正在重试。';
      }
      this.toggle(true); this.render(); return this.sendArtifactRevision();
    }
    const state = this.state(); this.clearRetryTarget(state); state.draft = turn.user?.text || ''; state.intent = 'auto';
    this.fileAttachments?.restore(turn.user?.attachments || [], state);
    this.focusIssue(turn);
    if (canRetryConversationTurn(turn)) { state.retryOfTurnId = turn.id; state.retryTarget = { text: state.draft.trim(), context: contextKey(this.getContext()) }; }
    this.render(); this.input.focus();
  }
  retryTargetFor(text, context, state = this.state()) {
    if (state.retryOfTurnId && state.retryTarget?.text === text && state.retryTarget.context === contextKey(context)) return state.retryOfTurnId;
    this.clearRetryTarget(state); return undefined;
  }
  mount() {
    const panel = element('aside', 'wf-conversation'); panel.setAttribute('aria-label', '工作流 AI 对话');
    this.resizeHandle = element('div', 'wf-conversation-resize'); this.resizeHandle.tabIndex = 0; this.resizeHandle.setAttribute('role', 'separator'); this.resizeHandle.setAttribute('aria-label', '调整工作流对话宽度'); this.resizeHandle.setAttribute('aria-orientation', 'vertical'); this.resizeHandle.setAttribute('aria-valuemin', '280'); this.resizeHandle.setAttribute('aria-valuemax', '560'); this.resizeHandle.setAttribute('aria-valuenow', '360');
    this.resizeHandle.addEventListener('pointerdown', event => this.beginResize(event)); this.resizeHandle.addEventListener('keydown', event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const width = this.panel.getBoundingClientRect().width; this.setWidth(event.key === 'Home' ? 280 : event.key === 'End' ? 560 : width + (event.key === 'ArrowLeft' ? 20 : -20)); });
    const heading = element('div', 'wf-conversation-heading'), title = element('div'); title.append(element('h2', '', '对话')); this.subtitle = element('p'); title.append(this.subtitle);
    this.refreshButton = button('刷新对话', () => void this.load(true), 'wf-conversation-icon');
    this.closeButton = button('收起对话', () => this.toggle(false), 'wf-conversation-icon'); heading.append(title, this.refreshButton, this.closeButton);
    this.notice = element('div', 'wf-conversation-notice'); this.notice.setAttribute('role', 'status'); this.notice.setAttribute('aria-live', 'polite');
    this.pendingHost = element('section', 'wf-conversation-pending'); this.pendingHost.setAttribute('aria-label', '尚未解决的事项');
    this.messages = element('div', 'wf-conversation-messages'); this.messages.setAttribute('aria-label', '工作流对话记录');
    this.resultHost = element('div', 'wf-conversation-result-host');
    const composer = element('form', 'wf-conversation-composer'); this.contextHost = element('div', 'wf-conversation-context'); this.contextHost.setAttribute('aria-label', '本条消息回复对象');
    this.revisionHandoffHost = element('section', 'wf-conversation-revision-handoff'); this.revisionHandoffHost.setAttribute('aria-label', '待发送的产物修改候选请求');
    const options = element('div', 'wf-conversation-composer-options'), advanced = element('details', 'wf-conversation-advanced');
    advanced.hidden = true;
    advanced.append(element('summary', '', '高级：指定处理方式')); this.intentSelect = element('select'); this.intentSelect.setAttribute('aria-label', '本次对话的修改范围');
    for (const [id, label] of INTENTS) { const option = element('option', '', label); option.value = id; this.intentSelect.append(option); }
    this.intentSelect.addEventListener('change', () => { this.state().intent = this.intentSelect.value; this.renderComposerHelp(); });
    advanced.append(this.intentSelect); this.followSelection = button('使用当前结果', () => { this.attachment = null; this.clearRetryTarget(); this.clearIssueTarget(); this.renderContext(); }, 'wf-conversation-link'); options.append(advanced, this.followSelection);
    this.input = element('textarea'); this.input.rows = 3; this.input.maxLength = 8000; this.input.placeholder = '输入消息'; this.input.setAttribute('aria-label', '给工作流 AI 的消息');
    this.input.addEventListener('input', () => { const state = this.state(); state.draft = this.input.value; state.messageEdit++; this.retryTargetFor(state.draft.trim(), this.getContext(), state); this.updateSendButton(); });
    bindChatSendShortcut(this.input, { getShortcuts: () => this.getShortcuts(), canSend: () => !this.sendButton.disabled, send: () => void this.send() });
    const actions = element('div', 'wf-conversation-composer-actions'), secondary = element('div', 'wf-conversation-composer-secondary'); this.runButton = button('运行当前流程', () => void this.startRun(), 'wf-button'); this.sendButton = element('button', 'wf-button primary', '发送'); this.sendButton.type = 'submit'; this.sendButton.setAttribute('aria-label', '发送工作流消息');
    this.fileAttachments.mount({ input: this.input, dropZone: composer }); secondary.append(this.fileAttachments.control, this.runButton); actions.append(secondary, this.sendButton);
    composer.addEventListener('submit', event => { event.preventDefault(); void this.send(); }); composer.addEventListener('keydown', event => event.stopPropagation()); composer.append(this.revisionHandoffHost, this.contextHost, options, this.input, this.fileAttachments.host, actions);
    panel.append(this.resizeHandle, heading, this.notice, this.pendingHost, this.messages, this.resultHost, composer); this.panel = panel; this.editor.root.querySelector('.wf-body').append(panel);
    this.editor.root.classList.add('wf-chat-enabled');
    this.openButton = button('打开工作流对话', () => this.toggle(true), 'wf-button wf-conversation-open');
    if (this.editor.root.querySelector('.wf-header')) setToolbarControl(this.openButton, { label: '打开工作流对话', icon: 'chat' });
    this.editor.root.querySelector('.wf-header-actions')?.append(this.openButton);
    panel.addEventListener('pointerdown', event => event.stopPropagation()); panel.addEventListener('keydown', event => event.stopPropagation());
    this.toggle(true);
  }
  connectRuntime(runtime) { this.runtime = runtime; this.render(); }
  setWidth(value) { const width = Math.min(560, Math.max(280, Math.round(value))); this.editor.root.style.setProperty('--wf-chat-width', `${width}px`); this.resizeHandle?.setAttribute('aria-valuenow', String(width)); this.editor.onCanvasResize?.(); }
  beginResize(event) {
    if (event.button !== 0) return; event.preventDefault(); event.stopPropagation(); this.finishResize?.(); const start = event.clientX, initial = this.panel.getBoundingClientRect().width;
    const move = next => this.setWidth(initial + start - next.clientX), finish = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', finish); this.finishResize = null; };
    this.finishResize = finish; window.addEventListener('pointermove', move); window.addEventListener('pointerup', finish); window.addEventListener('pointercancel', finish);
  }
  toggle(show = this.panel.hidden) { this.panel.hidden = !show; this.openButton.hidden = show; this.editor.root.classList.toggle('wf-chat-open', show); if (show) { if (!this.editor.selection?.size && !this.editor.selectedEdge && this.editor.settings && !this.editor.settings.propertiesClosed) { this.editor.settings.propertiesClosed = true; this.editor.applySettings?.(); } this.render(); } requestAnimationFrame(() => this.editor.onCanvasResize?.()); }
  syncWorkflow() {
    const id = this.currentDocument()?.id; if (!id) { this.unloadDocument(); return false; }
    if (this.workflowId === id) return false;
    this.detachedWorkflows?.delete(id);
    if (this.panel && this.unloadedPanelHidden !== undefined) {
      this.panel.hidden = this.unloadedPanelHidden; delete this.unloadedPanelHidden;
      this.editor.root?.classList.toggle('wf-chat-open', !this.panel.hidden);
    }
    this.workflowId = id; this.attachment = null; clearTimeout(this.pollTimer); clearTimeout(this.pendingRefreshTimer); if (this.openButton) this.openButton.hidden = !this.panel?.hidden; this.render(); void this.load(); return true;
  }
  unloadDocument() {
    if (this.panel && this.unloadedPanelHidden === undefined) this.unloadedPanelHidden = this.panel.hidden;
    if (this.workflowId) {
      this.detachedWorkflows ||= new Set(); this.detachedWorkflows.add(this.workflowId);
      const state = this.states.get(this.workflowId); if (state) { state.request++; state.loading = false; state.loaded = false; }
    }
    this.documentGeneration = (this.documentGeneration || 0) + 1; this.workflowId = null; this.attachment = null; this.resultOpen = null;
    this.outcomeRequests?.clear();
    for (const timer of ['pollTimer', 'pendingRefreshTimer', 'progressTimer']) { clearTimeout(this[timer]); this[timer] = null; }
    this.finishResize?.(); if (this.panel) this.panel.hidden = true; if (this.openButton) this.openButton.hidden = true;
    this.editor.root?.classList.remove('wf-chat-open');
    for (const host of [this.messages, this.pendingHost, this.resultHost, this.contextHost, this.notice, this.revisionHandoffHost]) host?.replaceChildren?.();
    if (this.input) this.input.value = '';
  }
  accept(snapshot, id = this.workflowId) {
    if (!id || this.detachedWorkflows?.has(id)) return false;
    const conversation = snapshot?.conversation; if (!conversation || conversation.workflowId !== id || !Array.isArray(conversation.turns)) throw new Error('对话记录与当前工作流不匹配。');
    const state = this.state(id); if (Number(conversation.revision || 0) < Number(state.conversation.revision || 0)) return false;
    const previous = new Map(state.conversation.turns.map(turn => [turn.id, turn.outcome])), wasLoaded = state.loaded;
    const outcomes = snapshot.turn ? [snapshot.turn] : wasLoaded ? conversation.turns.filter(turn => turn.outcome?.status === 'complete' && (previous.get(turn.id)?.status !== 'complete' || previous.get(turn.id)?.completedAt !== turn.outcome.completedAt)) : conversation.turns.slice(-1);
    state.conversation = conversation; state.pending = Array.isArray(snapshot.pending) ? snapshot.pending : state.pending; state.loaded = true;
    void this.syncOutcomes(outcomes, id);
    if (this.workflowId === id) { this.render(); this.schedulePoll(); } return true;
  }
  async syncOutcomes(turns, id) {
    if (!this.runtime?.storeRun) return; this.outcomeRequests ||= new Map();
    const generation = this.documentGeneration;
    for (const turn of turns) {
      const outcome = turn.outcome; if (!outcome?.runId || outcome.status !== 'complete') continue;
      const key = `${id}:${turn.id}:${outcome.action}:${outcome.completedAt || ''}`; if (this.outcomeRequests.has(key)) continue;
      this.outcomeRequests.set(key, true);
      const revision = this.runtime.revisions?.get(outcome.runId) || 0;
      try {
        const result = await this.api(`/api/workflow-runs/${encodeURIComponent(outcome.runId)}`), run = result.run || result;
        if (generation !== this.documentGeneration || this.detachedWorkflows?.has(id)) return;
        const member = run.workflowId === id || outcome.rootWorkflowId === id && outcome.workflowId === run.workflowId && Boolean(run.parentRunId) && (!outcome.parentRunId || outcome.parentRunId === run.parentRunId);
        if (run.id !== outcome.runId || !member || run.learningId || run.memoryScopeId) throw new Error('操作返回的运行与对话对象不匹配。');
        // SSE may already have delivered a newer terminal snapshot while this
        // GET was in flight. Reopening is only valid against the cache revision
        // from which the request started, never against a later event.
        if ((this.runtime.revisions?.get(outcome.runId) || 0) !== revision) continue;
        this.runtime.storeRun(run, { allowReopen: true }); if (this.workflowId === id) this.runtime.render?.();
      } catch (error) { this.outcomeRequests.delete(key); if (this.workflowId === id) { this.state(id).error = `操作已记录，运行状态刷新失败：${error.message}。请刷新运行记录确认。`; this.renderNotice(); } }
    }
  }
  async load(force = false) {
    const id = this.workflowId; if (!id || !this.currentDocument()) return;
    const state = this.state(id); if (state.loading || state.loaded && !force) return;
    const request = ++state.request; state.loading = true; if (force) state.error = ''; this.renderNotice();
    try { const snapshot = await this.api(`/api/workflow-conversations/${encodeURIComponent(id)}`); if (request === state.request) this.accept(snapshot, id); }
    catch (error) { if (request === state.request) state.error = `对话读取失败：${error.message}。请点击刷新对话重试。`; }
    finally { if (request === state.request) { state.loading = false; if (this.workflowId === id) this.render(); } }
  }
  schedulePoll() { clearTimeout(this.pollTimer); if (this.destroyed || !this.workflowId || !this.currentDocument() || !this.state().conversation.turns.some(turn => ['thinking', 'queued'].includes(turn.status))) return; this.pollTimer = setTimeout(() => void this.load(true), 3000); }
  scheduleProgressClock() {
    clearTimeout(this.progressTimer);
    if (this.destroyed || !this.workflowId || !this.currentDocument() || this.panel?.hidden || !this.state().conversation.turns.some(turn => ['thinking', 'queued'].includes(turn.status) && turn.assistant?.progress)) return;
    // Update text in place so opening the saved steps does not collapse on a
    // clock tick. This timer never reads the API or starts another model call.
    this.progressTimer = setTimeout(() => {
      for (const clock of this.messages.querySelectorAll('[data-diagnostic-clock]')) {
        clock.textContent = duration(elapsed(clock.dataset.startedAt, Date.now(), clock.dataset.elapsedMs));
      }
      this.scheduleProgressClock();
    }, 1000);
  }
  onEvent(event) {
    if (!this.workflowId || !this.currentDocument()) return;
    if (event?.type === 'workflow.document' || event?.name === 'workflow.document') { const id = (event.payload || event.data)?.workflow?.id; if (id === this.workflowId && !this.state().loaded && !this.state().loading) void this.load(true); return; }
    if (event?.type === 'workflow.run' || event?.name === 'workflow.run') {
      const run = (event.payload || event.data)?.run || event.payload || event.data; if (!run?.id || run.learningId || run.memoryScopeId) return;
      let ancestor = run, member = run.workflowId === this.workflowId; const seen = new Set();
      while (!member && ancestor?.parentRunId && !seen.has(ancestor.id) && seen.size < 32) { seen.add(ancestor.id); ancestor = this.runtime?.runs?.get(ancestor.parentRunId); member = ancestor?.workflowId === this.workflowId; }
      if (!member && !this.state().pending.some(item => item.context?.runId === run.id)) return;
      this.runSignatures ||= new Map(); const signature = JSON.stringify([run.status, Object.entries(run.nodes || {}).filter(([, record]) => record.status === 'waiting_review').map(([id, record]) => [id, record.attempt, record.attemptId])]);
      if (this.runSignatures.get(run.id) !== signature) { this.runSignatures.set(run.id, signature); this.queuePendingRefresh(); } return;
    }
    if (event?.type !== 'workflow.conversation' && event?.name !== 'workflow.conversation') return;
    const snapshot = event.payload || event.data || event, id = snapshot.workflowId || snapshot.conversation?.workflowId; if (!id) return;
    try { this.accept(snapshot, id); } catch { /* A subsequent explicit refresh exposes malformed server state. */ }
  }
  queuePendingRefresh() {
    if (!this.workflowId || !this.currentDocument()) return;
    clearTimeout(this.pendingRefreshTimer); const id = this.workflowId;
    this.pendingRefreshTimer = setTimeout(() => { if (this.destroyed || this.workflowId !== id) return; if (this.state(id).loading) return this.queuePendingRefresh(); void this.load(true); }, 250);
  }
  getContext() {
    const document = this.currentDocument(), attachment = this.attachment?.workflowId === document.id ? this.attachment : null;
    const run = attachment?.runId ? this.runtime?.runs?.get(attachment.runId) : this.runtime?.currentRun?.();
    if (attachment) {
      if (!run && attachment.runId) { const { workflowId, ...captured } = attachment; return clone(captured); }
      // Explicit review cards are immutable targets. Never silently advance an
      // old attachment to the next attempt while the user is composing.
      const captured = conversationContext(document, run, attachment.nodeId, attachment);
      for (const key of ['documentRevision', 'runId', 'nodeId', 'attempt', 'attemptId', 'artifactIds', 'artifactHashes']) if (attachment[key] !== undefined) captured[key] = clone(attachment[key]);
      return captured;
    }
    const selected = this.editor.nodeLibrary?.nested ? null : this.editor.selection?.size === 1 ? [...this.editor.selection][0] : null;
    return conversationContext(document, run, selected);
  }
  focusContext(context = {}, { intent } = {}) { this.clearRetryTarget(); this.clearIssueTarget(); if (INTENTS.some(([id]) => id === intent)) this.state().intent = intent; this.attachment = { ...Object.fromEntries(['documentRevision', 'runId', 'nodeId', 'attempt', 'attemptId', 'artifactIds', 'artifactHashes'].filter(key => context[key] !== undefined).map(key => [key, clone(context[key])])), workflowId: this.currentDocument().id }; this.renderContext(); this.toggle(true); this.render(); this.input.focus(); }
  reviewRevisionForContext(context) {
    const pending = this.state().pending.find(item => item.kind === 'review' && reviewContextKey(item.context) === reviewContextKey(context));
    if (pending?.revision) return pending.revision;
    const run = this.runtime?.runs?.get(context?.runId), record = run?.nodes?.[context?.nodeId];
    return record?.status === 'waiting_review' && record.attempt === context?.attempt && record.attemptId === context?.attemptId ? reviewRevisionPolicy(run, context.nodeId) : null;
  }
  async prepareArtifactRevisionForContext(context, feedback) {
    const workflowId = this.workflowId, cached = this.runtime?.runs?.get(context.runId), result = cached || await this.api(`/api/workflow-runs/${encodeURIComponent(context.runId)}`), run = result.run || result, record = run.nodes?.[context.nodeId];
    if (this.workflowId !== workflowId || !this.currentDocument()) return;
    const hashes = values => JSON.stringify((values || []).map(value => [value.id || value.artifactId, value.sha256]).sort(([a], [b]) => String(a).localeCompare(String(b))));
    if (run.id !== context.runId || record?.attempt !== context.attempt || record?.attemptId !== context.attemptId || hashes(record.artifacts) !== hashes(context.artifactHashes)) throw new Error('审核版本已变化，请刷新后重新填写修改意见。');
    this.prepareArtifactRevision({ run, humanNodeId: context.nodeId, feedback });
    return true;
  }
  prepareArtifactRevision({ run, humanNodeId, feedback }) {
    const record = run?.nodes?.[humanNodeId], policy = reviewRevisionPolicy(run, humanNodeId);
    if (!this.currentDocument() || record?.status !== 'waiting_review' || policy.strategy !== 'proposal') throw new Error('此审核没有可生成的代码或配置修改候选，请刷新审核记录。');
    if (typeof feedback !== 'string' || !feedback.trim() || feedback.length > 8000) throw new Error('请填写不超过8000字的完整修改意见。');
    const artifactHashes = (record.artifacts || []).map(item => ({ id: item.id || item.artifactId, sha256: item.sha256 })), context = {
      runId: run.id, nodeId: humanNodeId, attempt: record.attempt, attemptId: record.attemptId,
      artifactIds: artifactHashes.map(item => item.id), artifactHashes,
    };
    this.state().revisionHandoff = { text: feedback, intent: 'auto', context: clone(context), clientMessageId: crypto.randomUUID(),
      revisionRequest: { runId: run.id, humanNodeId, attempt: record.attempt, attemptId: record.attemptId, artifactHashes: clone(artifactHashes), targetNodeId: policy.targetNodeId } };
    this.state().revisionHandoffStatus = '修改意见和审核版本已保留。';
    this.toggle(true); this.render();
  }
  async requestArtifactRevision(args) { this.prepareArtifactRevision(args); return this.sendArtifactRevision(); }
  async requestArtifactRevisionForContext(context, feedback) { if (!await this.prepareArtifactRevisionForContext(context, feedback)) return false; return this.sendArtifactRevision(); }
  async sendArtifactRevision() {
    const state = this.state(), handoff = state.revisionHandoff; if (!handoff) return false;
    if (state.sending || !state.loaded || state.conversation.turns.some(turn => ['thinking', 'queued'].includes(turn.status))) {
      state.revisionHandoffStatus = state.sending ? '对话正在发送上一条消息，此候选请求已保留，请稍后重试。' : !state.loaded ? '对话尚未读取完成，此候选请求已保留，请稍后重试。' : 'AI 正在回复上一条消息，此候选请求已保留，完成后可重试。'; this.render(); return false;
    }
    if (this.editor.libraryReadOnly || this.editor.nodeLibrary?.nested) { state.revisionHandoffStatus = '当前工作流只读或正在查看内部流程，此候选请求已保留。'; this.render(); return false; }
    state.revisionHandoffStatus = '正在提交修改候选请求…';
    await this.send(handoff);
    if (state.revisionHandoff === handoff && !state.retry && !state.error) state.revisionHandoff = null;
    state.revisionHandoffStatus = state.revisionHandoff ? state.error || '候选请求尚未发送，修改意见和审核版本已保留，请重试。' : '';
    this.render(); return !state.revisionHandoff;
  }
  renderRevisionHandoff() {
    if (!this.revisionHandoffHost) return; const state = this.state(), request = state.revisionHandoff;
    this.revisionHandoffHost.replaceChildren(); this.revisionHandoffHost.hidden = !request; if (!request) return;
    const unconfirmed = state.retry?.clientMessageId === request.clientMessageId, submitting = state.sending && request.document && !unconfirmed;
    this.revisionHandoffHost.append(element('strong', '', `生成修改候选 · ${submitting ? '正在提交' : unconfirmed ? '发送未确认' : '待发送'}`), element('p', 'wf-conversation-message-scope', this.describeContext(request.context).join(' / ')), element('pre', '', request.text),
      element('p', 'wf-conversation-help', '只生成可审阅候选。应用候选与新建运行需要另行操作；下方聊天草稿已保留。'));
    if (state.revisionHandoffStatus) { const status = element('p', 'wf-conversation-help', state.revisionHandoffStatus); status.setAttribute('role', 'status'); this.revisionHandoffHost.append(status); }
    const actions = element('div', 'wf-conversation-actions'), send = button(unconfirmed ? '重试生成修改候选' : '发送并生成修改候选', () => void this.sendArtifactRevision(), 'wf-button primary'), cancel = button('取消此候选请求', () => { state.revisionHandoff = null; this.render(); });
    const thinking = state.conversation.turns.some(turn => ['thinking', 'queued'].includes(turn.status));
    send.disabled = !state.loaded || state.sending || thinking || this.editor.libraryReadOnly || Boolean(this.editor.nodeLibrary?.nested); cancel.disabled = state.sending;
    actions.append(send, cancel); this.revisionHandoffHost.append(actions);
  }
  describeContext(context = {}) {
    const document = this.currentDocument(), run = this.runtime?.runs?.get(context.runId), nodes = run?.document?.nodes || document.nodes || [], node = nodes.find(item => item.id === context.nodeId);
    const labels = [document.title || '当前工作流']; if (context.runId) labels.push(`运行 ${shortId(context.runId)}`); if (context.nodeId) labels.push(node?.title || `节点 ${shortId(context.nodeId)}`); if (context.attempt) labels.push(`第 ${context.attempt} 次`); if (context.artifactIds?.length) labels.push(`${context.artifactIds.length} 项产物`); return labels;
  }
  renderContext() {
    if (!this.contextHost) return; this.contextHost.replaceChildren(); const context = this.getContext();
    for (const label of this.describeContext(context)) { const chip = element('span', 'wf-conversation-chip', label); chip.title = label; this.contextHost.append(chip); }
    const issue = this.currentIssueTarget(context);
    if (issue) { const chip = element('span', 'wf-conversation-chip', `当前问题：${truncate(issue.user?.text || '所选事项', 36)}`); chip.title = clean(issue.user?.text || '所选事项'); this.contextHost.append(chip); }
    this.followSelection.hidden = !this.attachment;
  }
  renderComposerHelp() {
    this.input.placeholder = '输入消息';
  }
  updateShortcutHints() { updateChatShortcutHints(this.input, this.sendButton, this.getShortcuts?.()); }
  updateSendButton() {
    const state = this.state(), thinking = state.conversation.turns.some(turn => ['thinking', 'queued'].includes(turn.status));
    const empty = !this.input.value.trim() && !this.fileAttachments?.references(state).length;
    this.sendButton.disabled = !state.loaded || state.sending || empty || Boolean(this.fileAttachments?.blocked(state)) || thinking || this.editor.libraryReadOnly || Boolean(this.editor.nodeLibrary?.nested);
    this.sendButton.textContent = state.sending ? '发送中…' : thinking ? 'AI 正在回复…' : '发送'; this.updateShortcutHints();
  }
  renderNotice() {
    const state = this.state(); this.notice.replaceChildren(); this.notice.hidden = !(state.error || state.loading && !state.loaded || state.retry);
    if (state.error) this.notice.append(element('p', 'wf-conversation-error', state.error)); else if (state.loading && !state.loaded) this.notice.append(element('p', '', '正在读取已保存的工作流对话…'));
    if (state.retry) this.notice.append(button('核对记录并重试同一条消息', () => void this.send(state.retry), 'wf-button'));
  }
  render() {
    if (!this.panel || !this.workflowId) return;
    const followLatest = this.messages.scrollHeight - this.messages.scrollTop - this.messages.clientHeight < 60;
    const state = this.state(), groups = conversationTurnGroups(state.conversation.turns); this.subtitle.textContent = this.editor.nodeLibrary?.nested ? '内部编辑中' : this.editor.libraryReadOnly ? '只读' : this.getBackend()?.state === 'ready' ? '已连接' : '未连接';
    this.renderNotice(); this.renderPending(groups); this.renderRevisionHandoff(); this.messages.replaceChildren();
    if (!groups.latest) {
      const empty = element('div', 'wf-conversation-empty'); empty.append(element('p', '', '暂无消息')); this.messages.append(empty);
    } else {
      if (groups.history.length) {
        const history = element('div', 'wf-conversation-history');
        for (const turn of groups.history) { const detail = element('details', 'wf-conversation-turn-history'); detail.dataset.turnId = turn.id; detail.open = state.expanded.has(turn.id); const summary = element('summary'); summary.append(element('span', '', truncate(turn.user?.text || '历史对话', 42)), element('span', 'wf-conversation-history-state', turnStatus(turn))); detail.append(summary); if (detail.open) detail.append(this.turnView(turn)); detail.addEventListener('toggle', () => { if (detail.open) { state.expanded.add(turn.id); if (detail.children.length === 1) detail.append(this.turnView(turn)); } else state.expanded.delete(turn.id); }); history.append(detail); }
        this.messages.append(history);
      }
      this.messages.append(this.turnView(groups.latest, true));
    }
    this.renderResult(); this.renderContext(); if (this.input.value !== state.draft) this.input.value = state.draft; this.intentSelect.value = state.intent; this.renderComposerHelp(); this.fileAttachments?.render(); this.updateSendButton();
    this.runButton.disabled = this.editor.libraryReadOnly || Boolean(this.editor.nodeLibrary?.nested) || !this.currentDocument()?.nodes?.length || Boolean(this.runtime?.starting);
    this.refreshButton.disabled = state.loading;
    if (followLatest) this.messages.scrollTop = this.messages.scrollHeight;
    this.scheduleProgressClock();
  }
  diagnosticProgressView(turn) {
    const progress = conversationDiagnosticProgress(turn); if (!progress) return null;
    const box = element('div', 'wf-conversation-diagnostic-progress'), line = element('p', 'wf-conversation-diagnostic-stage');
    line.append(element('span', '', `${progress.active ? '当前阶段' : ['error', 'interrupted'].includes(turn.status) ? '停止位置' : '最后阶段'}：${progress.label}`));
    const clock = element('span', 'wf-conversation-diagnostic-time', duration(progress.elapsedMs));
    if (progress.active && turn.assistant.progress?.startedAt) { clock.dataset.diagnosticClock = 'stage'; clock.dataset.startedAt = turn.assistant.progress.startedAt; clock.dataset.elapsedMs = String(progress.elapsedMs); }
    line.append(clock); box.append(line);
    const metrics = element('p', 'wf-conversation-message-scope'), total = element('span', '', duration(progress.totalElapsedMs));
    if (progress.active && progress.turnStartedAt) { total.dataset.diagnosticClock = 'total'; total.dataset.startedAt = progress.turnStartedAt; total.dataset.elapsedMs = String(progress.totalElapsedMs); }
    metrics.append(element('span', '', '本轮已用 '), total, element('span', '', ` · 模型 ${progress.modelCalls} 次 · 工具 ${progress.toolCalls} 项`)); box.append(metrics);
    if (progress.steps.length) {
      const details = element('details', 'wf-conversation-diagnostic-steps');
      details.append(element('summary', '', `诊断进度 · 已完成 ${progress.completed} 项${progress.failed ? ` · 未完成 ${progress.failed} 项` : ''}`));
      const list = element('ol');
      const statuses = { running: '进行中', complete: '已完成', cached: '已复用', error: '失败', interrupted: '已停止' };
      for (const step of progress.steps) { const item = element('li', ['error', 'interrupted'].includes(step.status) ? 'wf-conversation-error' : ''); item.append(element('span', '', `${step.label} · ${statuses[step.status] || '已记录'}${step.elapsedMs ? ` · ${duration(step.elapsedMs)}` : ''}`)); if (step.error) item.append(element('p', '', step.error)); list.append(item); }
      details.append(list); box.append(details);
    }
    return box;
  }
  turnView(turn, latest = false) {
    const section = element('section', 'wf-conversation-turn' + (latest ? ' is-latest' : '')); section.dataset.turnId = turn.id;
    const user = element('article', 'wf-conversation-message is-user'); user.append(element('div', 'wf-conversation-speaker', '你'), element('p', 'wf-conversation-prose', turn.user?.text || ''));
    if (turn.user?.attachments?.length && this.fileAttachments) user.append(this.fileAttachments.messageView(turn.user.attachments));
    const context = turn.user?.context || {}; const scope = element('p', 'wf-conversation-message-scope', this.describeContext(context).join(' / ')); user.append(scope); section.append(user);
    const assistant = element('article', 'wf-conversation-message is-assistant'), meta = element('div', 'wf-conversation-message-meta'); meta.append(element('span', 'wf-conversation-speaker', 'AI'), element('span', 'wf-conversation-turn-state', turnStatus(turn))); assistant.append(meta);
    const text = turn.assistant?.text || turn.error?.message || (typeof turn.error === 'string' ? turn.error : '') || (['thinking', 'queued'].includes(turn.status) ? '正在生成回复…' : '已记录'); assistant.append(element('p', 'wf-conversation-prose', text));
    const progress = this.diagnosticProgressView(turn); if (progress) assistant.append(progress);
    if (Array.isArray(turn.assistant?.summary) && turn.assistant.summary.length) { const list = element('ul', 'wf-conversation-plan-summary'); for (const item of turn.assistant.summary) list.append(element('li', '', item)); assistant.append(list); }
    if (turn.assistant?.operations?.length) assistant.append(this.proposalView(turn));
    if (turn.assistant?.evidence?.length) {
      const details = element('details', 'wf-conversation-evidence'); details.append(element('summary', '', `已检查 ${turn.assistant.evidence.length} 项证据`));
      for (const receipt of turn.assistant.evidence) {
        details.append(element('p', 'wf-conversation-message-scope', `${receipt.tool} · ${receipt.status === 'error' ? '未完成' : '已完成'}`));
        for (const file of receipt.files || []) if (/^\/api\/app-diagnostics\/captures\/[\w-]+\/[\w.-]+$/.test(file.url || '')) {
          const link = element('a', 'wf-conversation-link', file.name || '查看诊断资料'); link.href = file.url; link.target = '_blank'; link.rel = 'noopener'; details.append(link);
        }
      }
      assistant.append(details);
    }
    if (['thinking', 'queued'].includes(turn.status)) assistant.append(button('停止本次分析', async () => {
      try { this.accept(await this.api(`/api/workflow-conversations/${encodeURIComponent(this.workflowId)}/turns/${encodeURIComponent(turn.id)}/action`, { method: 'POST', body: { action: 'interrupt-turn' } })); }
      catch (error) { this.state().error = error.message; this.renderNotice(); }
    }, 'wf-conversation-link'));
    if (Array.isArray(turn.actions) && turn.actions.length && !turn.outcome && !settled(turn) && !['complete', 'applied', 'dismissed'].includes(turn.status)) {
      const actions = element('div', 'wf-conversation-actions');
      for (const action of turn.actions.filter(item => item.kind !== 'mark-applied')) {
        const revision = action.kind === 'review-revise' ? this.reviewRevisionForContext(action.context) : null, locked = this.actionPending.has(`${this.workflowId}:${turn.id}:${action.id}`) || this.editor.libraryReadOnly || Boolean(this.editor.nodeLibrary?.nested);
        const item = button(action.label || action.kind, () => void this.performAction(turn, action), 'wf-button' + (action.kind === 'review-approve' ? ' primary' : ''));
        item.disabled = locked || action.kind === 'review-revise' && !revision?.canRevise;
        if (action.kind !== 'review-revise' || revision?.canRevise) actions.append(item);
        if (revision) {
          actions.append(element('p', 'wf-conversation-review-count', `已修改 ${revision.used} 次`));
          if (revision.reason) { item.title = revision.reason; actions.append(element('p', 'wf-conversation-help', revision.reason)); }
          if (revision.strategy === 'proposal') {
            const candidate = button('生成修改候选', async () => { const state = this.state(), key = reviewContextKey(action.context); state.reviewErrors ||= new Map(); try { if (await this.requestArtifactRevisionForContext(action.context, action.feedback || turn.user?.text || '')) state.reviewErrors.delete(key); else state.reviewErrors.set(key, state.revisionHandoffStatus || '候选请求尚未发送，请重试。'); } catch (error) { state.reviewErrors.set(key, error.message); } this.render(); });
            candidate.disabled = locked || this.state().sending; actions.append(candidate);
          }
        }
        const reviewError = action.kind?.startsWith('review-') && this.state().reviewErrors?.get(reviewContextKey(action.context));
        if (reviewError) { const error = element('p', 'wf-conversation-error', reviewError); error.setAttribute('role', 'alert'); actions.append(error); }
        if (action.context?.nodeId || action.context?.runId) actions.append(element('p', 'wf-conversation-message-scope', this.describeContext(action.context).join(' / ')));
      }
      if (actions.children.length) assistant.append(actions);
    }
    if (Array.isArray(turn.assistant?.revisionProposals) && !turn.outcome && !settled(turn) && !['complete', 'applied', 'dismissed'].includes(turn.status)) {
      for (const proposal of turn.assistant.revisionProposals) {
        const actions = element('div', 'wf-conversation-actions'), key = reviewContextKey(proposal.context);
        actions.append(element('p', 'wf-conversation-message-scope', this.describeContext(proposal.context).join(' / ')));
        const candidate = button('生成修改候选', async () => {
          const state = this.state(); state.reviewErrors ||= new Map();
          try { if (await this.requestArtifactRevisionForContext(proposal.context, proposal.feedback)) state.reviewErrors.delete(key); else state.reviewErrors.set(key, state.revisionHandoffStatus || '候选请求尚未发送，请重试。'); }
          catch (error) { state.reviewErrors.set(key, error.message); }
          this.render();
        });
        candidate.disabled = this.state().sending || this.editor.libraryReadOnly || Boolean(this.editor.nodeLibrary?.nested); actions.append(candidate);
        const reviewError = this.state().reviewErrors?.get(key); if (reviewError) { const error = element('p', 'wf-conversation-error', reviewError); error.setAttribute('role', 'alert'); actions.append(error); }
        assistant.append(actions);
      }
    }
    if (settled(turn) && turn.actions?.some(action => action.kind?.startsWith('review-'))) assistant.append(element('p', 'wf-conversation-help', '历史审核已结束'));
    if (turn.outcome) { const uncertain = ['rejected', 'unknown', 'started'].includes(turn.outcome.status), outcome = element('p', uncertain ? 'wf-conversation-error' : 'wf-conversation-outcome', uncertain ? turn.outcome.error || '操作结果尚未确认，请核对当前运行状态。系统不会自动重复操作。' : turn.outcome.label || turn.outcome.message || (turn.outcome.action === 'mark-applied' || turn.outcome.applied ? '节点修改已应用，可使用画布撤销。' : '操作已记录。')); assistant.append(outcome); }
    if (['error', 'interrupted'].includes(turn.status) && !settled(turn)) assistant.append(button(turn.user?.revisionRequest ? '重试生成修改候选' : '载入消息重试', () => this.beginRetry(turn), 'wf-button'));
    if (canDismissConversationTurn(turn)) { const dismiss = button('结束此事项', () => void this.dismissTurn(turn), 'wf-conversation-link'); dismiss.disabled = this.actionPending.has(`${this.workflowId}:${turn.id}:dismiss`) || this.editor.libraryReadOnly; assistant.append(dismiss); }
    section.append(assistant); return section;
  }
  proposalView(turn) {
    const box = element('section', 'wf-conversation-proposal'); box.append(element('h3', '', `${turn.assistant.operations.length} 项节点操作`));
    const localReceipt = this.applied.get(`${this.workflowId}:${turn.id}`), applied = localReceipt || turn.outcome?.applied || turn.outcome?.action === 'mark-applied' && turn.outcome.status === 'complete' || ['applied'].includes(turn.status);
    const details = element('details'); details.append(element('summary', '', '查看修改明细'), element('pre', '', JSON.stringify(turn.assistant.operations, null, 2))); box.append(details);
    if (applied) { box.append(element('p', 'wf-conversation-outcome', '已应用到画布')); if (localReceipt?.unconfirmed) box.append(button('重试保存应用记录', () => void this.recordApplied(turn, localReceipt), 'wf-button')); }
    else if (turn.status === 'dismissed') box.append(element('p', 'wf-conversation-help', '已结束'));
    else {
      const stale = documentFingerprint(this.currentDocument()) !== turn.assistant.baseFingerprint;
      const apply = button('应用节点修改', () => void this.applyProposal(turn), 'wf-button primary'); apply.disabled = stale || this.actionPending.has(`${this.workflowId}:${turn.id}:apply`) || this.editor.libraryReadOnly || Boolean(this.editor.nodeLibrary?.nested); box.append(apply);
      if (stale) box.append(element('p', 'wf-conversation-help', '画布已变化，此建议不能直接应用。请描述当前需求重新生成，避免覆盖手动修改。'));
    }
    return box;
  }
  renderPending(groups) {
    this.pendingHost.replaceChildren(); const state = this.state(), pending = state.pending || [], other = groups.unresolved.filter(turn => turn.id !== groups.latest?.id && !['thinking', 'queued'].includes(turn.status) && !coveredReview(turn, pending));
    const failedRun = this.runtime?.currentRun?.(), failure = !failedRun?.importedArchive && failedRun?.workflowId === this.currentDocument()?.id && ['error', 'interrupted', 'unknown'].includes(failedRun.status) ? failedRun : null;
    this.pendingHost.hidden = !pending.length && !other.length && !failure; if (this.pendingHost.hidden) return;
    const owner = this.workflowId, keys = [...pending.map(pendingReviewNoticeKey), ...other.map(pendingTurnNoticeKey), ...(failure ? [pendingFailureNoticeKey(failure)] : [])];
    const hidden = keys.filter(key => state.pendingNotices.isHidden(key)), visible = new Set(keys.filter(key => !state.pendingNotices.isHidden(key)));
    const shownPending = pending.filter(item => visible.has(pendingReviewNoticeKey(item))), shownOther = other.filter(turn => visible.has(pendingTurnNoticeKey(turn)));
    const shownFailure = failure && visible.has(pendingFailureNoticeKey(failure)), reviewCount = shownPending.filter(item => item.kind === 'review').length, contentId = `wf-conversation-pending-${this.workflowId}`;
    const refresh = () => { if (this.workflowId === owner) this.renderPending(conversationTurnGroups(state.conversation.turns)); };
    const closeNotice = (keys, label, group = false) => {
      const control = button('×', () => { state.pendingNotices.hide(keys); refresh(); }, 'wf-conversation-pending-close' + (group ? ' is-group' : ''));
      control.title = label; control.setAttribute('aria-label', label); return control;
    };
    const title = button(`待处理 · ${visible.size}${reviewCount ? ` · 审核 ${reviewCount}` : ''}`, () => {
      this.setPendingExpanded(!state.pendingExpanded); body.hidden = !state.pendingExpanded; title.setAttribute('aria-expanded', String(state.pendingExpanded));
    }, 'wf-conversation-pending-toggle'); title.setAttribute('aria-expanded', String(state.pendingExpanded)); title.setAttribute('aria-controls', contentId);
    title.hidden = !visible.size;
    const body = element('div', 'wf-conversation-pending-body'); body.id = contentId; body.hidden = !state.pendingExpanded || !visible.size; this.pendingHost.append(title, body);
    if (visible.size) this.pendingHost.append(closeNotice(keys, '隐藏当前全部提示', true));
    if (hidden.length) this.pendingHost.append(button(`显示已隐藏 · ${hidden.length}`, () => { state.pendingNotices.restore(hidden); refresh(); }, 'wf-conversation-link wf-conversation-pending-restore'));
    if (shownFailure) {
      const row = element('div', 'wf-conversation-pending-item');
      row.append(button(`运行异常 · ${STUDIO_STATUS[failure.status] || '待核对'} · ${shortId(failure.id)} · 查看并回复`, () => { this.resultOpen = failure.id; this.focusContext({ runId: failure.id }); state.intent = 'auto'; this.render(); }, 'wf-conversation-pending-target'), closeNotice([pendingFailureNoticeKey(failure)], '隐藏此运行异常提示')); body.append(row);
    }
    for (const item of shownPending) {
      const revision = this.reviewRevisionForContext(item.context), reviewKey = reviewContextKey(item.context);
      const row = element('div', 'wf-conversation-pending-item'), selected = this.attachment?.runId === item.context?.runId && this.attachment?.nodeId === item.context?.nodeId && this.attachment?.attempt === item.context?.attempt;
      row.classList.toggle('is-selected', selected); const target = button(item.label || '待审核产物', () => { this.focusContext(item.context); this.activeReview = item.id; this.state().intent = 'auto'; this.render(); }, 'wf-conversation-pending-target'); target.title = this.describeContext(item.context).join(' / '); row.append(target);
      row.append(element('p', 'wf-conversation-message-scope', this.describeContext(item.context).slice(1).join(' / ')));
      if (revision) { row.append(element('p', 'wf-conversation-review-count', `已修改 ${revision.used} 次`)); if (revision.reason) row.append(element('p', 'wf-conversation-help', revision.reason)); }
      const reviewError = state.reviewErrors?.get(reviewKey); if (reviewError) { const failure = element('p', 'wf-conversation-error', reviewError); failure.setAttribute('role', 'alert'); row.append(failure); }
      if (selected || this.activeReview === item.id) {
        if (item.artifacts?.length) row.append(this.artifactGallery(item.artifacts, item.context));
        state.reviewDrafts ||= new Map(); const feedback = element('textarea', 'wf-conversation-review-feedback'); feedback.rows = 3; feedback.maxLength = 8000; feedback.value = state.reviewDrafts.get(reviewKey) || ''; feedback.placeholder = '说明需要修改的内容'; feedback.setAttribute('aria-label', `${item.label || '当前审核'}的修改意见`); feedback.addEventListener('input', () => state.reviewDrafts.set(reviewKey, feedback.value)); row.append(feedback);
        const actions = element('div', 'wf-conversation-actions');
        const approve = button('通过并继续', () => void this.sendReview(item, 'approve'), 'wf-button primary'), revise = button('填写修改意见', () => { if (!revision?.canRevise) return; const text = state.reviewDrafts.get(reviewKey) || ''; if (!text.trim()) return feedback.focus(); void this.sendReview(item, 'revise', text); }), stop = button('停止此审核分支', () => void this.sendReview(item, 'stop'));
        for (const control of [approve, revise, stop]) control.disabled = state.sending || this.editor.libraryReadOnly || Boolean(this.editor.nodeLibrary?.nested);
        revise.disabled ||= !revision?.canRevise; if (revision?.reason) revise.title = revision.reason;
        actions.append(approve); if (revision?.strategy !== 'proposal') actions.append(revise); actions.append(stop); row.append(actions);
        if (revision?.strategy === 'proposal') {
          const candidate = button('生成修改候选', async () => {
            const text = state.reviewDrafts.get(reviewKey) || ''; state.reviewErrors ||= new Map();
            if (!text.trim()) { state.reviewErrors.set(reviewKey, '请先填写需要修改的内容。'); this.render(); return; }
            try {
              if (await this.requestArtifactRevisionForContext(item.context, text)) state.reviewErrors.delete(reviewKey); else state.reviewErrors.set(reviewKey, state.revisionHandoffStatus || '候选请求尚未发送，请重试。'); this.render();
            } catch (error) { state.reviewErrors.set(reviewKey, error.message); this.render(); }
          });
          candidate.disabled = state.sending || this.editor.libraryReadOnly || Boolean(this.editor.nodeLibrary?.nested); actions.append(candidate);
        }
      }
      row.append(closeNotice([pendingReviewNoticeKey(item)], item.kind === 'review' ? '隐藏此审核提示' : '隐藏此待办提示')); body.append(row);
    }
    for (const turn of shownOther) {
      const row = element('div', 'wf-conversation-pending-item'); row.append(button(`${turnStatus(turn)} · ${truncate(turn.user?.text, 30)}`, () => {
        state.expanded.add(turn.id); this.focusIssue(turn); this.render(); this.messages.querySelector(`[data-turn-id="${CSS.escape(turn.id)}"]`)?.scrollIntoView({ block: 'nearest' });
      }, 'wf-conversation-pending-target'));
      if (canDismissConversationTurn(turn)) {
        const actions = element('div', 'wf-conversation-pending-actions');
        for (const label of ['已处理', '不再处理']) { const control = button(label, () => void this.dismissTurn(turn), 'wf-conversation-link');
          control.title = '只结束此对话事项，运行与人工审核状态保持原样。'; control.disabled = this.actionPending.has(`${this.workflowId}:${turn.id}:dismiss`) || this.editor.libraryReadOnly || Boolean(this.editor.nodeLibrary?.nested); actions.append(control); }
        row.append(actions);
      }
      row.append(closeNotice([pendingTurnNoticeKey(turn)], '隐藏此聊天事项提示')); body.append(row);
    }
  }
  artifactGallery(items, context) {
    const gallery = element('div', 'wf-conversation-artifacts');
    for (const item of items) {
      const id = item.id || item.artifactId, endpoint = /^[A-Za-z0-9_-]{1,128}$/.test(id || '') ? `/api/workflow-v2/artifacts/${id}` : null, url = safeArtifactURL(item.previewUrl) || endpoint, download = safeArtifactURL(item.downloadUrl), card = element('figure', 'wf-conversation-artifact');
      if (image(item) && url) { const link = element('a'); link.href = url; link.target = '_blank'; link.rel = 'noopener'; const picture = element('img'); picture.src = url; picture.alt = clean(item.label || item.name || '本次产物'); picture.loading = 'lazy'; link.append(picture); card.append(link); }
      card.append(element('figcaption', '', item.label || item.name || item.path?.split('/').at(-1) || '产物'));
      const footer = element('div', 'wf-conversation-artifact-footer'); if (url || download) { const link = element('a', 'wf-conversation-link', image(item) ? '查看原图' : '打开文件'); link.href = url || download; link.target = '_blank'; link.rel = 'noopener'; footer.append(link); }
      if (id) footer.append(button('回复此产物', () => { const runId = context.nodeId ? context.runId : item.runId || context.runId, run = this.runtime?.runs?.get(runId), record = run?.nodes?.[context.nodeId || item.nodeId], target = { ...context, runId, nodeId: context.nodeId || item.nodeId, ...(record?.attempt !== undefined ? { attempt: record.attempt } : Number.isInteger(item.attempt) ? { attempt: item.attempt } : {}), ...(record?.attemptId ? { attemptId: record.attemptId } : {}) }; this.focusContext({ ...target, artifactIds: [id], ...(item.sha256 ? { artifactHashes: [{ id, sha256: item.sha256 }] } : {}) }); this.state().intent = 'auto'; this.render(); }, 'wf-conversation-link'));
      card.append(footer); gallery.append(card);
    }
    return gallery;
  }
  renderResult() {
    this.resultHost.replaceChildren(); const run = this.runtime?.currentRun?.(); if (!run || run.workflowId !== this.currentDocument()?.id) return;
    const box = element('details', 'wf-conversation-run-result'); box.open = this.resultOpen === run.id; const summary = element('summary', '', `当前运行 · ${STUDIO_STATUS[run.status] || run.status} · ${shortId(run.id)}`); box.append(summary);
    if (box.open) this.fillResult(box, run); box.addEventListener('toggle', () => { this.resultOpen = box.open ? run.id : null; if (box.open && box.children.length === 1) this.fillResult(box, run); }); this.resultHost.append(box);
  }
  fillResult(box, run) {
    const artifacts = runArtifacts(run); const context = { runId: run.id }, records = Object.entries(run.nodes || {});
    if (records.length) {
      const completed = records.filter(([, state]) => state.status === 'complete').length; box.append(element('p', 'wf-conversation-message-scope', `${completed} / ${records.length} 个节点完成 · 点击节点可定向回复`));
      const nodes = element('div', 'wf-conversation-run-nodes');
      for (const [id, state] of records) { const definition = run.document?.nodes?.find(node => node.id === id), row = button('', () => { if (this.editor.doc.nodes.some(node => node.id === id)) this.editor.selectNode?.(id); this.focusContext({ runId: run.id, nodeId: id, ...(Number.isInteger(state.attempt) ? { attempt: state.attempt } : {}), ...(state.attemptId ? { attemptId: state.attemptId } : {}) }); }, 'wf-conversation-run-node'); row.append(element('span', '', definition?.title || id), element('span', ['error', 'blocked'].includes(state.status) ? 'wf-conversation-error' : '', STUDIO_STATUS[state.status] || state.status)); nodes.append(row); }
      box.append(nodes);
    }
    if (run.output !== undefined && run.output !== null) box.append(element('pre', 'wf-conversation-result-text', truncate(valueText(run.output), 5000))); if (run.error) box.append(element('p', 'wf-conversation-error', valueText(run.error)));
    if (artifacts.length) box.append(this.artifactGallery(artifacts.slice(-12), context));
    const actions = element('div', 'wf-conversation-actions'); actions.append(button('回复本次运行', () => { this.focusContext(context); this.state().intent = 'auto'; this.render(); }, 'wf-conversation-link'));
    actions.append(button('查看运行记录与日志', () => this.runtime?.setExpanded(true), 'wf-conversation-link')); box.append(actions);
  }
  async startRun() {
    if (!this.runtime || this.editor.libraryReadOnly || this.editor.nodeLibrary?.nested) return false; const id = this.workflowId; await this.runtime.start(); if (this.workflowId !== id) return false;
    const rejected = this.runtime.notice && !this.runtime.notice.hidden && this.runtime.notice.classList.contains('error');
    if (rejected) this.state(id).error = this.runtime.notice.textContent;
    else { const run = this.runtime.currentRun?.(); if (run?.workflowId === id) { this.runtime.setExpanded(false); this.resultOpen = run.id; this.state(id).error = ''; } }
    this.render(); return !rejected;
  }
  async sendReview(item, action, feedback = '') {
    const state = this.state(), key = reviewContextKey(item.context), text = action === 'approve' ? '通过' : action === 'revise' ? `要求修改：${feedback}` : '停止本次运行';
    state.reviewErrors ||= new Map(); state.reviewErrors.delete(key);
    await this.send({ text, intent: 'feedback', context: clone(item.context), clientMessageId: crypto.randomUUID() });
    if (state.error) state.reviewErrors.set(key, state.error); this.render();
  }
  async send(retry) {
    const id = this.workflowId; if (!id || !this.currentDocument()) return;
    const state = this.state(id), generation = this.documentGeneration; if (state.sending || this.editor.libraryReadOnly || this.editor.nodeLibrary?.nested) return;
    if (!retry && this.fileAttachments?.blocked(state)) { state.error = '附件尚未保存完成，请先选择目标工作流或重试附件。'; this.renderNotice(); return; }
    const attachments = retry ? retry.attachments || [] : this.fileAttachments?.references(state) || [], rawText = (retry?.text ?? state.draft).trim();
    const text = rawText || (attachments.length ? '请查看这些素材。' : ''); if (!text || !state.loaded) return;
    if (state.conversation.turns.some(turn => ['thinking', 'queued'].includes(turn.status))) { state.error = 'AI 正在回复上一条消息，请完成后继续。'; this.renderNotice(); return; }
    if (!retry && !attachments.length && isConversationRunCommand(text)) {
      state.sending = true; const messageEdit = state.messageEdit; this.render();
      try { if (await this.startRun() && state.messageEdit === messageEdit && state.draft.trim() === text) state.draft = ''; }
      catch (error) { state.error = `运行未完成：${error.message}`; }
      finally { state.sending = false; if (this.workflowId === id) this.render(); }
      return;
    }
    const context = retry?.context || clone(this.getContext()), retryOfTurnId = retry?.retryOfTurnId || (!retry ? this.retryTargetFor(text, context, state) : undefined),
      replyToTurnId = retry?.replyToTurnId || (!retry && !attachments.length ? this.issueReplyTargetFor(text, context, state) : undefined), focusedIssueId = state.issueReplyTarget?.turnId || null;
    const request = retry || { text, intent: state.intent, context, page: this.getPageDiagnostics?.() || {}, clientMessageId: crypto.randomUUID(), ...(attachments.length ? { attachments } : {}), ...(retryOfTurnId ? { retryOfTurnId } : {}), ...(replyToTurnId ? { replyToTurnId } : {}) }, messageEdit = state.messageEdit;
    if (!request.document) request.document = clone(this.currentDocument());
    if (!request.revisionRequest) this.fileAttachments?.trackRequest(state, request);
    state.sending = true; state.error = ''; state.retry = null; this.render();
    try {
      const document = request.document; if (document.id !== id || this.currentDocument().id !== id) throw new Error('工作流已切换，请在对应工作流中发送。');
      const snapshot = await this.api(`/api/workflow-conversations/${encodeURIComponent(id)}/messages`, { method: 'POST', body: { ...request, document } });
      if (generation !== this.documentGeneration || this.detachedWorkflows?.has(id)) return;
      const sameIssue = (state.issueReplyTarget?.turnId || null) === focusedIssueId; this.accept(snapshot, id);
      this.fileAttachments?.consumeRequest(state, request);
      if (request.revisionRequest && state.revisionHandoff?.clientMessageId === request.clientMessageId) { state.revisionHandoff = null; state.revisionHandoffStatus = ''; }
      if (!request.revisionRequest && state.messageEdit === messageEdit && state.draft.trim() === text && (state.retryOfTurnId || null) === (request.retryOfTurnId || null) && sameIssue) { state.draft = ''; this.clearRetryTarget(state); }
      if (request.replyToTurnId && sameIssue && !canDismissConversationTurn(state.conversation.turns.find(turn => turn.id === request.replyToTurnId))) this.clearIssueTarget(state);
      state.retry = null;
    } catch (error) { if (generation === this.documentGeneration) { state.error = `发送未确认：${error.message}。原文和回复对象已保留，请核对对话记录后重试。`; state.retry = request; } }
    finally { state.sending = false; if (this.workflowId === id) { this.render(); this.messages.scrollTop = this.messages.scrollHeight; } }
  }
  async applyProposal(turn) {
    const id = this.workflowId, key = `${id}:${turn.id}`, busyKey = key + ':apply'; if (this.applied.has(key) || this.actionPending.has(busyKey) || this.editor.libraryReadOnly || this.editor.nodeLibrary?.nested) return;
    this.actionPending.add(busyKey); this.state(id).error = '';
    try {
      const operations = clone(turn.assistant.operations);
      if (this.currentDocument().id !== id || documentFingerprint(this.currentDocument()) !== turn.assistant.baseFingerprint) throw new Error('画布已变化，请重新生成节点修改建议。');
      const validation = await this.api(`/api/workflow-conversations/${encodeURIComponent(id)}/turns/${encodeURIComponent(turn.id)}/validate-proposal`,
        { method: 'POST', body: { planFingerprint: turn.assistant.baseFingerprint } });
      if (validation?.valid !== true || validation.workflowId !== id || validation.turnId !== turn.id || validation.planFingerprint !== turn.assistant.baseFingerprint) throw new Error('节点修改权限校验未确认，请重新读取当前建议。');
      if (this.workflowId !== id || this.currentDocument().id !== id) throw new Error('工作流已切换，未应用节点修改。');
      if (documentFingerprint(this.currentDocument()) !== turn.assistant.baseFingerprint) throw new Error('画布已变化，请重新生成节点修改建议。');
      if (this.editor.libraryReadOnly || this.editor.nodeLibrary?.nested) throw new Error('当前工作流只读或正在查看嵌入流程，未应用节点修改。');
      const current = this.state(id).conversation.turns.find(item => item.id === turn.id);
      if (current && (settled(current) || current.outcome || current.status !== 'proposed')) throw new Error('此修改事项已结束，请重新读取当前建议。');
      let generated = 0;
      const candidate = applyWorkflowOperations(this.currentDocument(), operations, { idFactory: prefix => `${prefix}-${turn.id}-${++generated}` }).document;
      if (documentFingerprint(candidate) !== validation.resultFingerprint) throw new Error('节点修改内容与权限校验结果不一致，未应用修改。');
      const result = await this.editor.applyConversationOperations(operations, { fingerprint: turn.assistant.baseFingerprint, turnId: turn.id });
      if (this.currentDocument().id !== id) throw new Error('工作流已切换，不能将修改记录写入其他工作流。');
      const receipt = { document: clone(result?.document || this.currentDocument()), planFingerprint: turn.assistant.baseFingerprint, resultFingerprint: documentFingerprint(result?.document || this.currentDocument()), unconfirmed: true }; this.applied.set(key, receipt); await this.recordApplied(turn, receipt, id);
    } catch (error) { this.state(id).error = `节点修改未完成：${error.message}`; }
    finally { this.actionPending.delete(busyKey); if (this.workflowId === id) this.render(); }
  }
  async recordApplied(turn, receipt, id = this.workflowId) {
    try {
      const actionId = turn.actions?.find(item => item.kind === 'mark-applied')?.id;
      const snapshot = await this.api(`/api/workflow-conversations/${encodeURIComponent(id)}/turns/${encodeURIComponent(turn.id)}/action`, { method: 'POST', body: { action: 'mark-applied', ...(actionId ? { actionId } : {}), planFingerprint: receipt.planFingerprint, document: receipt.document } }); this.accept(snapshot, id); receipt.unconfirmed = false;
    } catch (error) { this.state(id).error = `画布修改已应用，应用记录保存未确认：${error.message}。请重试保存记录，不要重复应用。`; }
    if (this.workflowId === id) this.render();
  }
  async performAction(turn, action) {
    const id = this.workflowId, key = `${id}:${turn.id}:${action.id}`, current = this.state(id).conversation.turns.find(item => item.id === turn.id) || turn;
    if (settled(current) || this.actionPending.has(key) || this.editor.libraryReadOnly || this.editor.nodeLibrary?.nested) return;
    this.actionPending.add(key); this.state(id).error = ''; this.render();
    try {
      const snapshot = await this.api(`/api/workflow-conversations/${encodeURIComponent(id)}/turns/${encodeURIComponent(turn.id)}/action`, { method: 'POST', body: { action: action.kind, actionId: action.id, ...(action.context ? { context: action.context } : {}), ...(action.feedback ? { feedback: action.feedback } : {}), document: clone(this.currentDocument()) } }); this.accept(snapshot, id);
      const outcome = snapshot.turn?.outcome || snapshot.conversation?.turns?.find(item => item.id === turn.id)?.outcome;
      if (outcome?.learningId && this.workflowId === id) { const result = await this.api(`/api/workflow-learning/${encodeURIComponent(outcome.learningId)}`), job = result.learning || result.job || result; if (job.id === outcome.learningId && job.workflowId === id) await this.runtime?.onFeedbackLearning?.(job); }
    } catch (error) { const state = this.state(id); state.error = `操作未确认：${error.message}。请刷新对话和运行记录后再决定是否重试。`; if (action.kind?.startsWith('review-')) { state.reviewErrors ||= new Map(); state.reviewErrors.set(reviewContextKey(action.context), state.error); } }
    finally { this.actionPending.delete(key); if (this.workflowId === id) this.render(); }
  }
  async dismissTurn(turn) {
    const id = this.workflowId, key = `${id}:${turn.id}:dismiss`; if (!canDismissConversationTurn(turn) || this.actionPending.has(key) || this.editor.libraryReadOnly) return;
    this.actionPending.add(key);
    try { const snapshot = await this.api(`/api/workflow-conversations/${encodeURIComponent(id)}/turns/${encodeURIComponent(turn.id)}/action`, { method: 'POST', body: { action: 'dismiss-turn' } }); this.accept(snapshot, id); }
    catch (error) { this.state(id).error = `结束事项未确认：${error.message}。对话记录仍保留。`; }
    finally { this.actionPending.delete(key); if (this.workflowId === id) this.render(); }
  }
  destroy() { this.destroyed = true; clearTimeout(this.pollTimer); clearTimeout(this.pendingRefreshTimer); clearTimeout(this.progressTimer); this.finishResize?.(); this.fileAttachments?.destroy(); this.panel?.remove(); this.openButton?.remove(); this.editor.root.classList.remove('wf-chat-enabled', 'wf-chat-open'); }
}
