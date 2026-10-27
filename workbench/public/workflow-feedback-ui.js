const TERMINAL = new Set(['complete', 'error', 'interrupted', 'unknown']);
const clean = value => String(value ?? '').replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[已隐藏密钥]').replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [已隐藏]').replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|authorization)["']?\s*[:=]\s*["']?)([^\s"',;}\]]+)/gi, '$1[已隐藏]');
const element = (tag, className = '', value) => { const item = document.createElement(tag); if (className) item.className = className; if (value !== undefined) item.textContent = clean(value); return item; };
const button = (label, action, className = 'wf-button') => { const item = element('button', className, label); item.type = 'button'; item.addEventListener('click', action); return item; };
const recordRevision = feedback => Number.isInteger(feedback?.revision) ? feedback.revision : 0;

export function feedbackRunReason(run) {
  if (!run) return '选择一次运行后，可填写产物反馈。';
  if (run.document?.mode !== 'execute') return '学习运行保留对比和改进记录；请对普通执行产生的实际成果填写反馈。';
  if (!TERMINAL.has(run.status)) return '本次运行尚未结束。结束后可对已实际完成的成果填写反馈。';
  return '';
}

// Older records remain readable as prose. Historical scores and selections do
// not become controls or inferred opinions in the simpler feedback form.
export function feedbackComment(feedback, targets = []) {
  if (typeof feedback?.comment === 'string') return feedback.comment;
  return (feedback?.items || []).filter(item => typeof item.comment === 'string' && item.comment.trim()).map(item => {
    const title = item.title || targets.find(target => target.nodeId === item.nodeId)?.title || item.nodeId || '反馈';
    return `${title}：${item.comment}`;
  }).join('\n\n');
}

export function validateFeedbackComment(comment, { learn = false } = {}) {
  if (typeof comment !== 'string') throw new Error('请填写文本反馈。');
  if (comment.length > 8000) throw new Error('综合反馈不能超过 8000 字，请精简后再保存。');
  if (learn && !comment.trim()) throw new Error('请先填写具体问题和期望，再根据反馈改进 Skill。');
  return comment;
}

// Drafts, requests and revisions belong to a run, never to whichever run happens
// to be visible when an asynchronous response arrives.
export class WorkflowFeedbackUI {
  constructor(runtime, host) {
    this.runtime = runtime; this.api = runtime.api; this.states = new Map(); this.run = null;
    this.mount(host);
  }
  mount(host) {
    this.panel = element('section', 'wf-feedback'); this.panel.setAttribute('aria-label', '反馈与改进');
    const heading = element('div', 'wf-feedback-heading'); this.heading = element('h3', '', '反馈与改进'); this.heading.tabIndex = -1; heading.append(this.heading);
    this.badge = element('span', 'wf-feedback-state', '尚未反馈');
    this.refreshButton = button('刷新反馈', () => { const state = this.currentState(); if (state) void this.load(state.runId, true); }, 'wf-button wf-runtime-small');
    heading.append(this.badge, this.refreshButton);
    this.scope = element('p', 'wf-feedback-scope');
    this.notice = element('p', 'wf-feedback-notice'); this.notice.setAttribute('role', 'status'); this.notice.setAttribute('aria-live', 'polite');
    this.targetsHint = element('p', 'wf-feedback-targets');
    const commentLabel = element('label', 'wf-feedback-comment-label'); commentLabel.append(element('span', '', '综合反馈'));
    this.comment = element('textarea'); this.comment.rows = 6; this.comment.maxLength = 8000; this.comment.placeholder = '填写反馈'; this.comment.setAttribute('aria-label', '本次运行的综合反馈'); commentLabel.append(this.comment);
    this.comment.addEventListener('input', () => { const state = this.currentState(); if (state) this.setDraft(state, this.comment.value); });
    this.lengthHint = element('p', 'wf-feedback-length');
    this.conflict = element('div', 'wf-feedback-conflict'); this.conflict.hidden = true;
    this.conflictText = element('p'); this.serverFeedback = element('pre', 'wf-feedback-server-record');
    this.rebaseButton = button('保留草稿，基于最新反馈继续', () => this.rebase());
    this.conflict.append(this.conflictText, this.serverFeedback, this.rebaseButton);
    const actions = element('div', 'wf-feedback-actions');
    this.saveButton = button('保存反馈', () => void this.submit(false));
    this.learnButton = button('根据反馈改进 Skill', () => void this.submit(true), 'wf-button primary');
    this.actionsHint = element('span', 'wf-feedback-action-hint'); actions.append(this.saveButton, this.learnButton, this.actionsHint);
    this.panel.append(heading, this.scope, this.notice, this.targetsHint, commentLabel, this.lengthHint, this.conflict, actions); host.append(this.panel);
    this.panel.addEventListener('keydown', event => event.stopPropagation());
  }
  state(runId) {
    if (!this.states.has(runId)) this.states.set(runId, { runId, targets: [], feedback: null, revision: 0, draft: '', dirty: false, editRevision: 0, loaded: false, attempted: false, loading: false, busy: false, canReview: false, reason: '', notice: '', error: false, conflict: false, remote: null, loadRequest: 0 });
    return this.states.get(runId);
  }
  currentState() { return this.run?.id ? this.state(this.run.id) : null; }
  eligibleTargets(state) { return state.targets.filter(target => target.status === 'complete' && target.version); }
  canOpen() { const state = this.currentState(); return !!this.run && !feedbackRunReason(this.run) && !!state?.loaded && !!state.canReview && this.eligibleTargets(state).length > 0; }
  open() { if (!this.canOpen()) return; this.panel.scrollIntoView?.({ block: 'start', behavior: 'smooth' }); this.heading.focus?.({ preventScroll: true }); }
  setDraft(state, comment) {
    state.draft = comment; state.dirty = true; state.editRevision++;
    state.notice = ''; state.error = false; this.renderState();
  }
  readRecord(state, feedback) {
    state.draft = feedbackComment(feedback, state.targets);
    state.feedback = feedback || null; state.revision = recordRevision(feedback); state.dirty = false; state.conflict = false; state.remote = null;
  }
  async load(runId, force = false) {
    const state = this.state(runId); if (state.loading || state.busy || state.attempted && !force) return;
    const request = ++state.loadRequest; state.attempted = true; state.loading = true; state.notice = '正在读取本次运行的反馈…'; state.error = false; this.renderState();
    try {
      const result = await this.api(`/api/workflow-runs/${encodeURIComponent(runId)}/feedback`);
      if (request !== state.loadRequest) return;
      if (result.feedback?.runId && result.feedback.runId !== runId) throw new Error('服务返回了其他运行的反馈，本次草稿已保留。');
      const revision = recordRevision(result.feedback);
      if (revision < state.revision) { state.notice = '服务返回了较旧的反馈，本地内容已保留。'; return; }
      state.targets = Array.isArray(result.targets) ? result.targets : []; state.canReview = result.canReview === true; state.reason = result.reason || ''; state.loaded = true;
      if (!state.dirty) this.readRecord(state, result.feedback);
      else if (revision !== state.revision) { state.conflict = true; state.remote = result.feedback || null; }
      state.notice = state.conflict ? '服务器上已有更新的反馈。你的草稿已保留，请对照最新记录后再决定是否继续保存。' : state.dirty ? '已刷新；当前未保存草稿已保留。' : '';
    } catch (error) { if (request === state.loadRequest) { state.notice = `反馈读取失败：${error.message}。可点击刷新反馈重试。`; state.error = true; } }
    finally { if (request === state.loadRequest) { state.loading = false; if (this.run?.id === runId) this.renderState(); } }
  }
  rebase() {
    const state = this.currentState(); if (!state?.conflict || !state.remote || state.loading || state.busy) return;
    state.feedback = state.remote; state.revision = recordRevision(state.remote); state.remote = null; state.conflict = false;
    state.notice = '草稿已保留。再次保存将以当前草稿更新刚才显示的服务器反馈。'; state.error = false; this.renderState();
  }
  async submit(learn = false) {
    const state = this.currentState(), run = this.run;
    if (!state || state.busy || state.loading || !state.loaded || !state.canReview || feedbackRunReason(run) || state.conflict) return;
    let comment;
    try {
      if (!this.eligibleTargets(state).length) throw new Error('本次运行没有可改进的已完成 Skill。');
      comment = validateFeedbackComment(state.draft, { learn });
    } catch (error) { state.notice = error.message; state.error = true; this.renderState(); return; }
    const runId = state.runId, editRevision = state.editRevision;
    state.busy = true; state.notice = '正在保存本次反馈…'; state.error = false; this.renderState();
    try {
      const result = await this.api(`/api/workflow-runs/${encodeURIComponent(runId)}/feedback`, { method: 'POST', body: { expectedRevision: state.revision, comment } });
      if (!Number.isInteger(result.feedback?.revision) || result.feedback.revision <= state.revision || result.feedback.runId && result.feedback.runId !== runId) throw new Error('服务未确认匹配的反馈修订，请刷新反馈核对；草稿已保留。');
      state.loadRequest++; state.feedback = result.feedback; state.revision = result.feedback.revision; state.remote = null; state.conflict = false;
      if (state.editRevision === editRevision) this.readRecord(state, result.feedback);
      if (!learn) { state.notice = state.dirty ? '提交时的反馈已保存；之后编辑的草稿仍未保存。' : '反馈已保存。'; return; }
      state.notice = '反馈已保存，正在启动基于综合反馈的 Skill 学习…'; this.renderState();
      const job = await this.api(`/api/workflow-runs/${encodeURIComponent(runId)}/feedback/learn`, { method: 'POST', body: { feedbackRevision: state.revision } });
      if (!job?.id) throw new Error('服务未返回学习记录，请刷新学习记录确认后再重试。');
      state.notice = '反馈学习已启动。';
      try { await this.runtime.onFeedbackLearning?.(job); } catch { state.notice = '反馈学习已启动；学习面板暂未打开，请刷新学习记录查看。'; }
    } catch (error) {
      state.error = true;
      if (error.httpStatus === 409) { state.conflict = true; state.notice = `反馈版本发生冲突：${error.message}。草稿已保留，请刷新反馈并对照服务器记录。`; }
      else state.notice = `${learn && !state.dirty ? '反馈已保存，学习启动未确认' : '提交未确认'}：${error.message}。草稿保留，请核对记录后重试。`;
    } finally { state.busy = false; if (this.run?.id === runId) this.renderState(); }
  }
  render(run = this.runtime.currentRun()) {
    this.run = run || null; this.renderState();
    if (run?.id && !feedbackRunReason(run)) void this.load(run.id);
  }
  renderState() {
    const run = this.run, state = this.currentState(), runReason = feedbackRunReason(run);
    this.panel.hidden = !run;
    this.scope.textContent = run ? clean(`运行 ${run.id}`) : '';
    const canReview = !!state?.canReview && !runReason, eligible = state ? this.eligibleTargets(state) : [], blocked = !canReview || !eligible.length || state?.busy || state?.loading || !state?.loaded || state?.conflict;
    if (this.runtime.feedbackButton) this.runtime.feedbackButton.disabled = !this.canOpen();
    this.badge.textContent = state?.dirty ? '草稿未保存' : state?.feedback ? `已保存 · 第 ${state.revision} 版` : '尚未反馈';
    this.notice.textContent = clean(runReason || state?.notice || state?.reason || (state?.loaded && !eligible.length ? '此历史记录没有完整的 Skill 版本与执行成果，不能提交反馈学习。' : ''));
    this.notice.hidden = !this.notice.textContent; this.notice.classList.toggle('error', !!state?.error);
    this.refreshButton.disabled = !state || !!runReason || state.loading || state.busy; this.refreshButton.textContent = state?.loading ? '读取中…' : '刷新反馈';
    this.saveButton.disabled = blocked; this.learnButton.disabled = blocked;
    this.saveButton.textContent = state?.busy ? '提交中…' : '保存反馈'; this.learnButton.textContent = state?.busy ? '请等待提交完成…' : '根据反馈改进 Skill';
    this.actionsHint.textContent = state?.dirty ? '草稿未保存' : '';
    this.actionsHint.hidden = !this.actionsHint.textContent;
    this.conflict.hidden = !state?.conflict;
    this.conflictText.textContent = state?.remote ? `服务器最新反馈：第 ${recordRevision(state.remote)} 版。下方仅供对照，当前未保存的综合反馈仍然保留。` : '请先刷新反馈，读取服务器最新修订。';
    this.serverFeedback.textContent = state?.remote ? clean(feedbackComment(state.remote, state.targets) || '未填写反馈') : '';
    this.serverFeedback.hidden = !state?.remote; this.rebaseButton.disabled = !state?.remote || state.loading || state.busy;
    this.targetsHint.textContent = eligible.length ? clean(`本次已完成的 Skill：${eligible.map(target => target.title || target.skillRef).join(' · ')}`) : '';
    this.targetsHint.hidden = !eligible.length;
    if (this.comment.value !== (state?.draft || '')) this.comment.value = state?.draft || '';
    this.comment.disabled = !canReview || !eligible.length || !state?.loaded || state.busy || state.loading;
    this.lengthHint.textContent = `${state?.draft.length || 0}/8000 字${state?.draft.length > 8000 ? ' · 旧反馈内容超过新上限，请精简后保存' : ''}`;

  }
}
