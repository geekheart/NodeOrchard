import { documentFingerprint } from '../shared/workflow/workflow-conversation-commands.mjs';
import { runArtifacts, STUDIO_STATUS } from '../shared/workflow/workflow-studio-utils.mjs';
import { conversationTurnGroups, canRetryConversationTurn } from '../shared/workflow/workflow-conversation-issues.mjs';

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
const duration = milliseconds => { const seconds = Math.floor(Math.max(0, milliseconds || 0) / 1000); return seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分${seconds % 60}秒`; };
const elapsed = (startedAt, end, fallback = 0) => Number.isFinite(Date.parse(startedAt)) && Number.isFinite(end) ? Math.max(0, end - Date.parse(startedAt)) : Math.max(0, Number(fallback) || 0);

// Only stage metadata belongs in the message bubble. Checkpoint results are
// evidence for the broker and may contain large logs or business documents.
export function conversationDiagnosticProgress(turn, at = Date.now()) {
  const progress = turn?.assistant?.progress, checkpoint = turn?.assistant?.checkpoint;
  if (!progress && !checkpoint?.steps?.length) return null;
  const active = ['thinking', 'queued'].includes(turn.status), end = active ? at : Date.parse(progress?.completedAt || turn.updatedAt);
  const steps = (checkpoint?.steps || []).slice(-40).map(step => ({ label: clean(step.label || step.tool || step.stage || '检查').slice(0, 240),
    status: step.status, elapsedMs: Number(step.elapsedMs) || 0, ...(step.error ? { error: clean(step.error).slice(0, 400) } : {}) }));
  return { label: clean(progress?.label || steps.at(-1)?.label || '整理诊断结果').slice(0, 240), active,
    elapsedMs: active ? elapsed(progress?.startedAt, at, progress?.elapsedMs) : Number.isFinite(progress?.elapsedMs) ? progress.elapsedMs : elapsed(progress?.startedAt, end),
    totalElapsedMs: elapsed(turn.createdAt, active ? at : Date.parse(turn.updatedAt), progress?.elapsedMs),
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
  constructor(editor, { api, getBackend = () => null, getPageDiagnostics = () => ({}) }) {
    this.getPageDiagnostics = getPageDiagnostics;
    this.editor = editor; this.api = api; this.getBackend = getBackend; this.states = new Map(); this.runtime = null; this.workflowId = null; this.attachment = null; this.destroyed = false; this.applied = new Map(); this.actionPending = new Set();
    this.mount(); this.syncWorkflow();
  }
  currentDocument() { return this.editor.nodeLibrary?.rootDocument || this.editor.doc; }
  state(id = this.workflowId) {
    if (!this.states.has(id)) {
      let pendingExpanded = false; try { pendingExpanded = localStorage.getItem(PENDING_PREFERENCE + id) === 'true'; } catch { /* Keep the current preference in memory. */ }
      this.states.set(id, { conversation: { workflowId: id, revision: 0, turns: [] }, pending: [], pendingExpanded, draft: '', intent: 'auto', loading: false, loaded: false, sending: false, request: 0, error: '', retry: null, retryOfTurnId: null, retryTarget: null, expanded: new Set(), messageEdit: 0 });
    }
    return this.states.get(id);
  }
  setPendingExpanded(expanded, id = this.workflowId) {
    this.state(id).pendingExpanded = expanded;
    try { localStorage.setItem(PENDING_PREFERENCE + id, String(expanded)); } catch { /* The memory preference still survives renders and SSE. */ }
  }
  clearRetryTarget(state = this.state()) { state.retryOfTurnId = null; state.retryTarget = null; }
  beginRetry(turn) {
    if (!['error', 'interrupted'].includes(turn?.status) || settled(turn)) return;
    const state = this.state(); this.clearRetryTarget(state); state.draft = turn.user?.text || ''; state.intent = 'auto';
    this.focusContext(turn.user?.context || {});
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
    const heading = element('div', 'wf-conversation-heading'), title = element('div'); title.append(element('h2', '', '对话')); this.subtitle = element('p', '', '搭建、运行与问题处理'); title.append(this.subtitle);
    this.refreshButton = button('刷新对话', () => void this.load(true), 'wf-conversation-icon'); this.refreshButton.title = '刷新已保存的对话';
    this.closeButton = button('收起对话', () => this.toggle(false), 'wf-conversation-icon'); heading.append(title, this.refreshButton, this.closeButton);
    this.notice = element('div', 'wf-conversation-notice'); this.notice.setAttribute('role', 'status'); this.notice.setAttribute('aria-live', 'polite');
    this.pendingHost = element('section', 'wf-conversation-pending'); this.pendingHost.setAttribute('aria-label', '尚未解决的事项');
    this.messages = element('div', 'wf-conversation-messages'); this.messages.setAttribute('aria-label', '工作流对话记录');
    this.resultHost = element('div', 'wf-conversation-result-host');
    const composer = element('form', 'wf-conversation-composer'); this.contextHost = element('div', 'wf-conversation-context'); this.contextHost.setAttribute('aria-label', '本条消息回复对象');
    const options = element('div', 'wf-conversation-composer-options'), advanced = element('details', 'wf-conversation-advanced');
    advanced.hidden = true;
    advanced.append(element('summary', '', '高级：指定处理方式')); this.intentSelect = element('select'); this.intentSelect.setAttribute('aria-label', '本次对话的修改范围');
    for (const [id, label] of INTENTS) { const option = element('option', '', label); option.value = id; this.intentSelect.append(option); }
    this.intentSelect.addEventListener('change', () => { this.state().intent = this.intentSelect.value; this.renderComposerHelp(); });
    advanced.append(this.intentSelect); this.followSelection = button('使用当前结果', () => { this.attachment = null; this.clearRetryTarget(); this.renderContext(); }, 'wf-conversation-link'); options.append(advanced, this.followSelection);
    this.input = element('textarea'); this.input.rows = 3; this.input.maxLength = 8000; this.input.placeholder = '描述任务、回复结果，或直接说“运行”…'; this.input.setAttribute('aria-label', '给工作流 AI 的消息');
    this.input.addEventListener('input', () => { const state = this.state(); state.draft = this.input.value; state.messageEdit++; this.retryTargetFor(state.draft.trim(), this.getContext(), state); this.updateSendButton(); });
    this.input.addEventListener('keydown', event => { event.stopPropagation(); if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void this.send(); } });
    this.help = element('p', 'wf-conversation-help');
    const actions = element('div', 'wf-conversation-composer-actions'); this.runButton = button('运行当前流程', () => void this.startRun(), 'wf-button'); this.sendButton = element('button', 'wf-button primary', '发送'); this.sendButton.type = 'submit'; this.sendButton.setAttribute('aria-label', '发送工作流消息'); actions.append(this.runButton, this.sendButton);
    composer.addEventListener('submit', event => { event.preventDefault(); void this.send(); }); composer.addEventListener('keydown', event => event.stopPropagation()); composer.append(this.contextHost, options, this.input, this.help, actions);
    panel.append(this.resizeHandle, heading, this.notice, this.pendingHost, this.messages, this.resultHost, composer); this.panel = panel; this.editor.root.querySelector('.wf-body').append(panel);
    this.editor.root.classList.add('wf-chat-enabled');
    this.openButton = button('打开工作流对话', () => this.toggle(true), 'wf-button wf-conversation-open'); this.editor.root.querySelector('.wf-header-actions')?.append(this.openButton);
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
    const id = this.currentDocument()?.id; if (!id) return false;
    if (this.workflowId === id) return false;
    this.workflowId = id; this.attachment = null; clearTimeout(this.pollTimer); clearTimeout(this.pendingRefreshTimer); this.render(); void this.load(); return true;
  }
  accept(snapshot, id = this.workflowId) {
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
    for (const turn of turns) {
      const outcome = turn.outcome; if (!outcome?.runId || outcome.status !== 'complete') continue;
      const key = `${id}:${turn.id}:${outcome.action}:${outcome.completedAt || ''}`; if (this.outcomeRequests.has(key)) continue;
      this.outcomeRequests.set(key, true);
      const revision = this.runtime.revisions?.get(outcome.runId) || 0;
      try {
        const result = await this.api(`/api/workflow-runs/${encodeURIComponent(outcome.runId)}`), run = result.run || result;
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
    const id = this.workflowId, state = this.state(id); if (state.loading || state.loaded && !force) return;
    const request = ++state.request; state.loading = true; if (force) state.error = ''; this.renderNotice();
    try { const snapshot = await this.api(`/api/workflow-conversations/${encodeURIComponent(id)}`); if (request === state.request) this.accept(snapshot, id); }
    catch (error) { if (request === state.request) state.error = `对话读取失败：${error.message}。请点击刷新对话重试。`; }
    finally { if (request === state.request) { state.loading = false; if (this.workflowId === id) this.render(); } }
  }
  schedulePoll() { clearTimeout(this.pollTimer); if (this.destroyed || !this.state().conversation.turns.some(turn => ['thinking', 'queued'].includes(turn.status))) return; this.pollTimer = setTimeout(() => void this.load(true), 3000); }
  scheduleProgressClock() {
    clearTimeout(this.progressTimer);
    if (this.destroyed || this.panel?.hidden || !this.state().conversation.turns.some(turn => ['thinking', 'queued'].includes(turn.status) && turn.assistant?.progress)) return;
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
  focusContext(context = {}, { intent } = {}) { this.clearRetryTarget(); if (INTENTS.some(([id]) => id === intent)) this.state().intent = intent; this.attachment = { ...Object.fromEntries(['documentRevision', 'runId', 'nodeId', 'attempt', 'attemptId', 'artifactIds', 'artifactHashes'].filter(key => context[key] !== undefined).map(key => [key, clone(context[key])])), workflowId: this.currentDocument().id }; this.renderContext(); this.toggle(true); this.render(); this.input.focus(); }
  describeContext(context = {}) {
    const document = this.currentDocument(), run = this.runtime?.runs?.get(context.runId), nodes = run?.document?.nodes || document.nodes || [], node = nodes.find(item => item.id === context.nodeId);
    const labels = [document.title || '当前工作流']; if (context.runId) labels.push(`运行 ${shortId(context.runId)}`); if (context.nodeId) labels.push(node?.title || `节点 ${shortId(context.nodeId)}`); if (context.attempt) labels.push(`第 ${context.attempt} 次`); if (context.artifactIds?.length) labels.push(`${context.artifactIds.length} 项产物`); return labels;
  }
  renderContext() {
    if (!this.contextHost) return; this.contextHost.replaceChildren(); const context = this.getContext();
    for (const label of this.describeContext(context)) { const chip = element('span', 'wf-conversation-chip', label); chip.title = label; this.contextHost.append(chip); }
    this.followSelection.hidden = !this.attachment;
  }
  renderComposerHelp() {
    const hints = { auto: '直接描述任务或结果问题；说“运行”开始执行，说“以后都按这个规则”准备可复用改进。修改先预览，应用后可撤销。', discuss: '咨询和讨论；不会自动运行流程或修改 Skill。', workflow: 'AI 提出任务配置，应用后可撤销；随后可直接说“运行”。', redo: '只重跑指定节点及受影响部分；补充要求仅用于本次，不修改 Skill。', feedback: '反馈绑定当前工作流、运行、节点或产物；审核请明确回复“通过”或“要求修改：…”。', skill: '准备以后沿用的规则候选，验证并采用前保留原版本。' };
    const context = this.getContext(), run = this.runtime?.runs?.get(context.runId), record = run?.nodes?.[context.nodeId], node = run?.document?.nodes?.find(item => item.id === context.nodeId);
    const review = node?.type === 'human' && record?.status === 'waiting_review' && (context.attempt === undefined || context.attempt === record.attempt)
      || this.state().pending.some(item => item.kind === 'review' && item.context?.runId === context.runId && item.context?.nodeId === context.nodeId && item.context?.attempt === context.attempt);
    this.help.textContent = review ? '当前对象正在等待审核。回复“通过”继续，或“要求修改：具体意见”退回对应节点。' : hints[this.state().intent] || hints.discuss;
    this.input.placeholder = review ? '回复“通过”，或“要求修改：具体意见”…' : '描述任务、回复结果，或直接说“运行”…';
  }
  updateSendButton() { const state = this.state(), thinking = state.conversation.turns.some(turn => ['thinking', 'queued'].includes(turn.status)); this.sendButton.disabled = !state.loaded || state.sending || !this.input.value.trim() || thinking || this.editor.libraryReadOnly || Boolean(this.editor.nodeLibrary?.nested); this.sendButton.textContent = state.sending ? '发送中…' : thinking ? 'AI 正在回复…' : '发送'; }
  renderNotice() {
    const state = this.state(); this.notice.replaceChildren(); this.notice.hidden = !(state.error || state.loading && !state.loaded || state.retry);
    if (state.error) this.notice.append(element('p', 'wf-conversation-error', state.error)); else if (state.loading && !state.loaded) this.notice.append(element('p', '', '正在读取已保存的工作流对话…'));
    if (state.retry) this.notice.append(button('核对记录并重试同一条消息', () => void this.send(state.retry), 'wf-button'));
  }
  render() {
    if (!this.panel || !this.workflowId) return;
    const followLatest = this.messages.scrollHeight - this.messages.scrollTop - this.messages.clientHeight < 60;
    const state = this.state(), groups = conversationTurnGroups(state.conversation.turns); this.subtitle.textContent = this.editor.nodeLibrary?.nested ? '内部编辑中 · 请先返回主流程' : this.editor.libraryReadOnly ? '工作流只读 · 历史对话可查看' : this.getBackend()?.state === 'ready' ? 'Hermes 已连接 · 对话自动保存' : '对话自动保存 · AI 需要连接 Hermes';
    this.renderNotice(); this.renderPending(groups); this.messages.replaceChildren();
    if (!groups.latest) {
      const empty = element('div', 'wf-conversation-empty'); empty.append(element('span', 'wf-conversation-empty-mark', '↗'), element('h3', '', '从一句描述开始'), element('p', '', '在这里描述任务、确认修改、运行和反馈。固定任务配置一次，之后直接运行；需要时再打开画布查看过程。'));
      empty.append(button('帮我搭建一个文本清理流程', () => { state.intent = 'workflow'; state.draft = '创建一个文本输入 → 去除首尾空白 → 非空文本校验 → 产物输出的工作流。先搭建，不运行。'; this.render(); this.input.focus(); }, 'wf-conversation-suggestion')); this.messages.append(empty);
    } else {
      if (groups.history.length) {
        const history = element('div', 'wf-conversation-history');
        for (const turn of groups.history) { const detail = element('details', 'wf-conversation-turn-history'); detail.dataset.turnId = turn.id; detail.open = state.expanded.has(turn.id); const summary = element('summary'); summary.append(element('span', '', truncate(turn.user?.text || '历史对话', 42)), element('span', 'wf-conversation-history-state', turnStatus(turn))); detail.append(summary); if (detail.open) detail.append(this.turnView(turn)); detail.addEventListener('toggle', () => { if (detail.open) { state.expanded.add(turn.id); if (detail.children.length === 1) detail.append(this.turnView(turn)); } else state.expanded.delete(turn.id); }); history.append(detail); }
        this.messages.append(history);
      }
      this.messages.append(this.turnView(groups.latest, true));
    }
    this.renderResult(); this.renderContext(); if (this.input.value !== state.draft) this.input.value = state.draft; this.intentSelect.value = state.intent; this.renderComposerHelp(); this.updateSendButton();
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
    if (progress.active && turn.createdAt) { total.dataset.diagnosticClock = 'total'; total.dataset.startedAt = turn.createdAt; total.dataset.elapsedMs = String(progress.totalElapsedMs); }
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
    const context = turn.user?.context || {}; const scope = element('p', 'wf-conversation-message-scope', this.describeContext(context).join(' / ')); user.append(scope); section.append(user);
    const assistant = element('article', 'wf-conversation-message is-assistant'), meta = element('div', 'wf-conversation-message-meta'); meta.append(element('span', 'wf-conversation-speaker', 'AI'), element('span', 'wf-conversation-turn-state', turnStatus(turn))); assistant.append(meta);
    const text = turn.assistant?.text || turn.error?.message || (typeof turn.error === 'string' ? turn.error : '') || (['thinking', 'queued'].includes(turn.status) ? '正在结合当前流程和明确选择的对象生成回复…' : '已保存本次对话。'); assistant.append(element('p', 'wf-conversation-prose', text));
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
    if (Array.isArray(turn.actions) && turn.actions.length && !turn.outcome && !settled(turn) && !['complete', 'applied', 'dismissed'].includes(turn.status)) { const actions = element('div', 'wf-conversation-actions'); for (const action of turn.actions.filter(item => item.kind !== 'mark-applied')) { const item = button(action.label || action.kind, () => void this.performAction(turn, action), 'wf-button' + (action.kind === 'review-approve' ? ' primary' : '')); item.disabled = this.actionPending.has(`${this.workflowId}:${turn.id}:${action.id}`) || this.editor.libraryReadOnly || Boolean(this.editor.nodeLibrary?.nested); actions.append(item); if (action.context?.nodeId || action.context?.runId) actions.append(element('p', 'wf-conversation-message-scope', this.describeContext(action.context).join(' / '))); } if (actions.children.length) assistant.append(actions); }
    if (settled(turn) && turn.actions?.some(action => action.kind?.startsWith('review-'))) assistant.append(element('p', 'wf-conversation-help', '此条历史审核入口已结束；如仍需审核，请使用当前待审核卡。'));
    if (turn.outcome) { const uncertain = ['rejected', 'unknown', 'started'].includes(turn.outcome.status), outcome = element('p', uncertain ? 'wf-conversation-error' : 'wf-conversation-outcome', uncertain ? turn.outcome.error || '操作结果尚未确认，请核对当前运行状态。系统不会自动重复操作。' : turn.outcome.label || turn.outcome.message || (turn.outcome.action === 'mark-applied' || turn.outcome.applied ? '节点修改已应用，可使用画布撤销。' : '操作已记录。')); assistant.append(outcome); }
    if (['error', 'interrupted'].includes(turn.status) && !settled(turn)) assistant.append(button('载入消息重试', () => this.beginRetry(turn), 'wf-button'));
    if (canDismissConversationTurn(turn)) { const dismiss = button('结束此事项', () => void this.dismissTurn(turn), 'wf-conversation-link'); dismiss.disabled = this.actionPending.has(`${this.workflowId}:${turn.id}:dismiss`) || this.editor.libraryReadOnly; assistant.append(dismiss); }
    section.append(assistant); return section;
  }
  proposalView(turn) {
    const box = element('section', 'wf-conversation-proposal'); box.append(element('h3', '', `${turn.assistant.operations.length} 项节点操作`));
    const localReceipt = this.applied.get(`${this.workflowId}:${turn.id}`), applied = localReceipt || turn.outcome?.applied || turn.outcome?.action === 'mark-applied' && turn.outcome.status === 'complete' || ['applied'].includes(turn.status);
    const details = element('details'); details.append(element('summary', '', '查看修改明细'), element('pre', '', JSON.stringify(turn.assistant.operations, null, 2))); box.append(details);
    if (applied) { box.append(element('p', 'wf-conversation-outcome', '已应用到画布；运行需单独发起。可使用画布撤销。')); if (localReceipt?.unconfirmed) box.append(button('重试保存应用记录', () => void this.recordApplied(turn, localReceipt), 'wf-button')); }
    else if (turn.status === 'dismissed') box.append(element('p', 'wf-conversation-help', '此修改建议已结束，保留明细供查看。'));
    else {
      const stale = documentFingerprint(this.currentDocument()) !== turn.assistant.baseFingerprint;
      const apply = button('应用节点修改', () => void this.applyProposal(turn), 'wf-button primary'); apply.disabled = stale || this.actionPending.has(`${this.workflowId}:${turn.id}:apply`) || this.editor.libraryReadOnly || Boolean(this.editor.nodeLibrary?.nested); box.append(apply);
      if (stale) box.append(element('p', 'wf-conversation-help', '画布已变化，此建议不能直接应用。请描述当前需求重新生成，避免覆盖手动修改。'));
    }
    return box;
  }
  renderPending(groups) {
    this.pendingHost.replaceChildren(); const state = this.state(), pending = state.pending || [], other = groups.unresolved.filter(turn => turn.id !== groups.latest?.id && !['thinking', 'queued'].includes(turn.status) && !coveredReview(turn, pending));
    const failedRun = this.runtime?.currentRun?.(), failure = failedRun?.workflowId === this.currentDocument()?.id && ['error', 'interrupted', 'unknown'].includes(failedRun.status) ? failedRun : null;
    this.pendingHost.hidden = !pending.length && !other.length && !failure; if (this.pendingHost.hidden) return;
    const reviewCount = pending.filter(item => item.kind === 'review').length, contentId = `wf-conversation-pending-${this.workflowId}`;
    const title = button(`待处理 · ${pending.length + other.length + Number(Boolean(failure))}${reviewCount ? ` · 审核 ${reviewCount}` : ''}`, () => {
      this.setPendingExpanded(!state.pendingExpanded); body.hidden = !state.pendingExpanded; title.setAttribute('aria-expanded', String(state.pendingExpanded));
    }, 'wf-conversation-pending-toggle'); title.setAttribute('aria-expanded', String(state.pendingExpanded)); title.setAttribute('aria-controls', contentId);
    const body = element('div', 'wf-conversation-pending-body'); body.id = contentId; body.hidden = !state.pendingExpanded; this.pendingHost.append(title, body);
    if (failure) body.append(button(`运行异常 · ${STUDIO_STATUS[failure.status] || '待核对'} · ${shortId(failure.id)} · 查看并回复`, () => { this.resultOpen = failure.id; this.focusContext({ runId: failure.id }); state.intent = 'auto'; this.render(); }, 'wf-conversation-pending-target'));
    for (const item of pending) {
      const row = element('div', 'wf-conversation-pending-item'), selected = this.attachment?.runId === item.context?.runId && this.attachment?.nodeId === item.context?.nodeId && this.attachment?.attempt === item.context?.attempt;
      row.classList.toggle('is-selected', selected); const target = button(item.label || '待审核产物', () => { this.focusContext(item.context); this.activeReview = item.id; this.state().intent = 'auto'; this.render(); }, 'wf-conversation-pending-target'); target.title = this.describeContext(item.context).join(' / '); row.append(target);
      row.append(element('p', 'wf-conversation-message-scope', this.describeContext(item.context).slice(1).join(' / ')));
      if (selected || this.activeReview === item.id) {
        if (item.artifacts?.length) row.append(this.artifactGallery(item.artifacts, item.context));
        const actions = element('div', 'wf-conversation-actions');
        const approve = button('通过并继续', () => void this.sendReview(item, 'approve'), 'wf-button primary'), revise = button('填写修改意见', () => { this.focusContext(item.context); state.intent = 'auto'; state.draft = '要求修改：'; this.render(); this.input.focus(); }), stop = button('停止此审核分支', () => void this.sendReview(item, 'stop'));
        for (const control of [approve, revise, stop]) control.disabled = state.sending || this.editor.libraryReadOnly || Boolean(this.editor.nodeLibrary?.nested);
        actions.append(approve, revise, stop); row.append(actions);
      }
      body.append(row);
    }
    for (const turn of other) {
      const row = element('div', 'wf-conversation-pending-item'); row.append(button(`${turnStatus(turn)} · ${truncate(turn.user?.text, 30)}`, () => {
        state.expanded.add(turn.id); this.focusContext(turn.user?.context || {}); this.render(); this.messages.querySelector(`[data-turn-id="${CSS.escape(turn.id)}"]`)?.scrollIntoView({ block: 'nearest' });
      }, 'wf-conversation-pending-target'));
      if (canDismissConversationTurn(turn)) {
        const actions = element('div', 'wf-conversation-pending-actions');
        for (const label of ['已处理', '不再处理']) { const control = button(label, () => void this.dismissTurn(turn), 'wf-conversation-link');
          control.title = '只结束此对话事项，运行与人工审核状态保持原样。'; control.disabled = this.actionPending.has(`${this.workflowId}:${turn.id}:dismiss`) || this.editor.libraryReadOnly || Boolean(this.editor.nodeLibrary?.nested); actions.append(control); }
        row.append(actions);
      }
      body.append(row);
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
  async sendReview(item, action) { const text = action === 'approve' ? '通过' : '停止本次运行'; await this.send({ text, intent: 'feedback', context: clone(item.context), clientMessageId: crypto.randomUUID() }); }
  async send(retry) {
    const id = this.workflowId, state = this.state(id); if (state.sending || this.editor.libraryReadOnly || this.editor.nodeLibrary?.nested) return;
    const text = (retry?.text ?? state.draft).trim(); if (!text || !state.loaded) return;
    if (state.conversation.turns.some(turn => ['thinking', 'queued'].includes(turn.status))) { state.error = 'AI 正在回复上一条消息，请完成后继续。'; this.renderNotice(); return; }
    if (!retry && isConversationRunCommand(text)) {
      state.sending = true; const messageEdit = state.messageEdit; this.render();
      try { if (await this.startRun() && state.messageEdit === messageEdit && state.draft.trim() === text) state.draft = ''; }
      catch (error) { state.error = `运行未完成：${error.message}`; }
      finally { state.sending = false; if (this.workflowId === id) this.render(); }
      return;
    }
    const context = retry?.context || clone(this.getContext()), retryOfTurnId = retry?.retryOfTurnId || (!retry ? this.retryTargetFor(text, context, state) : undefined);
    const request = retry || { text, intent: state.intent, context, page: this.getPageDiagnostics?.() || {}, clientMessageId: crypto.randomUUID(), ...(retryOfTurnId ? { retryOfTurnId } : {}) }, messageEdit = state.messageEdit; if (!request.document) request.document = clone(this.currentDocument()); state.sending = true; state.error = ''; state.retry = null; this.render();
    try {
      const document = request.document; if (document.id !== id || this.currentDocument().id !== id) throw new Error('工作流已切换，请在对应工作流中发送。');
      const snapshot = await this.api(`/api/workflow-conversations/${encodeURIComponent(id)}/messages`, { method: 'POST', body: { ...request, document } }); this.accept(snapshot, id);
      if (state.messageEdit === messageEdit && state.draft.trim() === text && (state.retryOfTurnId || null) === (request.retryOfTurnId || null)) { state.draft = ''; this.clearRetryTarget(state); } state.retry = null;
    } catch (error) { state.error = `发送未确认：${error.message}。原文和回复对象已保留，请核对对话记录后重试。`; state.retry = request; }
    finally { state.sending = false; if (this.workflowId === id) { this.render(); this.messages.scrollTop = this.messages.scrollHeight; } }
  }
  async applyProposal(turn) {
    const id = this.workflowId, key = `${id}:${turn.id}`, busyKey = key + ':apply'; if (this.applied.has(key) || this.actionPending.has(busyKey) || this.editor.libraryReadOnly || this.editor.nodeLibrary?.nested) return;
    this.actionPending.add(busyKey); this.state(id).error = '';
    try {
      if (this.currentDocument().id !== id || documentFingerprint(this.currentDocument()) !== turn.assistant.baseFingerprint) throw new Error('画布已变化，请重新生成节点修改建议。');
      const result = await this.editor.applyConversationOperations(turn.assistant.operations, { fingerprint: turn.assistant.baseFingerprint, turnId: turn.id });
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
    } catch (error) { this.state(id).error = `操作未确认：${error.message}。请刷新对话和运行记录后再决定是否重试。`; }
    finally { this.actionPending.delete(key); if (this.workflowId === id) this.render(); }
  }
  async dismissTurn(turn) {
    const id = this.workflowId, key = `${id}:${turn.id}:dismiss`; if (!canDismissConversationTurn(turn) || this.actionPending.has(key) || this.editor.libraryReadOnly) return;
    this.actionPending.add(key);
    try { const snapshot = await this.api(`/api/workflow-conversations/${encodeURIComponent(id)}/turns/${encodeURIComponent(turn.id)}/action`, { method: 'POST', body: { action: 'dismiss-turn' } }); this.accept(snapshot, id); }
    catch (error) { this.state(id).error = `结束事项未确认：${error.message}。对话记录仍保留。`; }
    finally { this.actionPending.delete(key); if (this.workflowId === id) this.render(); }
  }
  destroy() { this.destroyed = true; clearTimeout(this.pollTimer); clearTimeout(this.pendingRefreshTimer); clearTimeout(this.progressTimer); this.finishResize?.(); this.panel?.remove(); this.openButton?.remove(); this.editor.root.classList.remove('wf-chat-enabled', 'wf-chat-open'); }
}
