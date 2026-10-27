import { planWorkflow } from '../shared/workflow/workflow-plan.mjs';
import { WORKFLOW_TOOLS } from '../shared/workflow/workflow-tools.mjs';
import { WorkflowLearningUI } from './workflow-learning-ui.js';
import { WorkflowSchedulesUI } from './workflow-schedules-ui.js';
import { WorkflowFeedbackUI } from './workflow-feedback-ui.js';
import { STUDIO_STATUS, isV2, inputEntries } from '../shared/workflow/workflow-studio-utils.mjs';
import { workflowInputDefault } from '../shared/workflow/workflow-inputs.mjs';
import { setToolbarControl } from './workflow-toolbar-controls.js';

const ACTIVE = new Set(['queued', 'preparing', 'running', 'waiting', 'waiting_review']);
const TERMINAL = new Set(['complete', 'error', 'interrupted', 'unknown']);
const STATUS = { ...STUDIO_STATUS, preparing: '准备中', running: '运行中', waiting: '等待人工处理', complete: '已完成', error: '运行失败', interrupted: '已停止', unknown: '状态待确认', pending: '尚未执行', skipped: '已跳过' };
const INPUT_TYPES = { text: '文本', object: 'JSON 对象', array: 'JSON 数组', number: '数字', boolean: '布尔值', any: '文本或 JSON', fileRef: '文件引用（暂不支持）' };

function text(value) {
  return String(value ?? '').replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[已隐藏密钥]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [已隐藏]')
    .replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|authorization)["']?\s*[:=]\s*["']?)([^\s"',;}\]]+)/gi, '$1[已隐藏]');
}
function node(tag, className = '', value) { const item = document.createElement(tag); if (className) item.className = className; if (value !== undefined) item.textContent = text(value); return item; }
function button(label, handler, className = 'wf-button') { const item = node('button', className, label); item.type = 'button'; item.addEventListener('click', handler); return item; }
function date(value) { const parsed = new Date(value); return Number.isNaN(parsed.valueOf()) ? '' : parsed.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }); }
function display(value) { if (typeof value === 'string') return text(value); if (value === undefined) return ''; try { return text(JSON.stringify(value, null, 2)); } catch { return text(value); } }
function runLabel(run) { return `${date(run.startedAt) || '时间未记录'}${run.trigger?.type === 'schedule' ? ' · 定时' : ''} · ${STATUS[run.status] || '状态待确认'}`; }
const own = (value, key) => value != null && Object.hasOwn(value, key);

export function runtimeRunCountLabel(run, { summary = false } = {}) {
  if (!run) return '';
  if (run.schemaVersion === 2 || run.document?.schemaVersion === 2) {
    const nodes = (run.document?.nodes || []).filter(node => !['evaluation', 'improvement'].includes(node.type)), completed = nodes.filter(node => run.nodes?.[node.id]?.status === 'complete').length, skipped = nodes.filter(node => run.nodes?.[node.id]?.status === 'skipped').length;
    return `${completed} / ${nodes.length} 个业务节点${summary ? '' : '完成'}${skipped ? ` · ${skipped} 个跳过` : ''}`;
  }
  return `${(run.document?.nodes || []).filter(node => ['skill', 'tool'].includes(node.type)).length} 项能力`;
}

export function skillDisplayName(skill) {
  return typeof skill?.displayName === 'string' && skill.displayName.trim() ? skill.displayName.trim() : skill?.name || '';
}
export function skillVersionLabel(skill) {
  if (skill?.source !== 'learned' && !skill?.baseName) return '';
  const revision = /^sha256:[a-f0-9]{64}$/i.test(skill?.revision || '') ? skill.revision.slice(7, 15) : '';
  return ['已学习', revision].filter(Boolean).join(' · ');
}
// A late Skill read may update its reference only. Text edited in the inspector
// meanwhile belongs to the current draft, including when another node is open.
export function mergeSkillSelectionDraft(editor, workflowId, nodeId, name, revision) {
  if (editor.doc.id !== workflowId) return false;
  const item = editor.doc.nodes.find(node => node.id === nodeId && node.type === 'skill'); if (!item) return false;
  const latest = editor.propertyDrafts.get(nodeId) || { title: item.title, config: structuredClone(item.config) };
  editor.propertyDrafts.set(nodeId, { ...latest, config: { ...latest.config, skillRef: name, version: revision } }); editor.renderHeader(); return true;
}

// Historical inspection reads the run snapshot; it never plans or executes an old run.
export function runtimeNodeOrder(run) {
  const nodes = run?.document?.nodes || [], ids = new Set(nodes.map(item => item.id));
  if (Array.isArray(run?.nodeOrder)) return [...new Set([...run.nodeOrder.filter(id => ids.has(id)), ...nodes.map(item => item.id)])];
  const order = [], seen = new Set(); let next = nodes.find(item => item.type === 'input')?.id;
  while (next && ids.has(next) && !seen.has(next)) { order.push(next); seen.add(next); next = run.document.edges?.find(edge => edge.sourceNode === next)?.targetNode; }
  return [...order, ...nodes.filter(item => !seen.has(item.id)).map(item => item.id)];
}
export function runtimeNodeDetails(run, id) {
  const item = run?.document?.nodes?.find(entry => entry.id === id); if (!item) return null;
  const state = run.nodes?.[id] || {}, status = state.status || 'pending';
  const soleSkill = (run.document.nodes || []).filter(entry => entry.type === 'skill').length === 1;
  const legacy = !Array.isArray(run.nodeOrder) && !Array.isArray(run.skills) && soleSkill;
  const details = { node: item, status, hasInput: own(state, 'input'), input: state.input, hasOutput: own(state, 'output'), output: state.output,
    outputText: state.outputText, partialText: typeof state.partialText === 'string' ? state.partialText : '', error: state.error || '',
    sessionId: state.sessionId || '', startedAt: state.startedAt || '', completedAt: state.completedAt || '',
    skill: (run.skills || []).find(skill => skill.nodeId === id) || (legacy && item.type === 'skill' ? run.skill : null),
    runtime: state.runtime || null, logs: state.logs || null, reason: state.reason || '', legacy };
  if (item.type === 'input' && !details.hasInput && own(run, 'input')) { details.hasInput = true; details.input = run.input; }
  if (item.type === 'input' && !details.hasOutput && own(run, 'input') && status === 'complete') { details.hasOutput = true; details.output = run.input; }
  if (legacy && item.type === 'skill') {
    details.sessionId ||= run.sessionId || '';
    if (!['pending', 'skipped'].includes(status) && !details.hasInput && own(run, 'input')) { details.hasInput = true; details.input = run.input; }
    if (status === 'complete' && run.status === 'complete' && !details.hasOutput && own(run, 'output')) { details.hasOutput = true; details.output = run.output; details.outputText = run.outputText; }
    if (!details.partialText && !['pending', 'skipped', 'complete'].includes(status)) details.partialText = run.partialText || '';
    if (!details.error && ['error', 'unknown', 'interrupted'].includes(status)) details.error = run.error || '';
  }
  if (legacy && item.type === 'output' && status === 'complete' && run.status === 'complete' && own(run, 'output')) {
    if (!details.hasInput) { details.hasInput = true; details.input = run.output; }
    if (!details.hasOutput) { details.hasOutput = true; details.output = run.output; details.outputText = run.outputText; }
  }
  return details;
}
export function workflowSnapshotChanged(run, document) {
  if (!run?.document || !document) return false;
  const execution = source => ({ id: source.id, mode: source.mode, title: source.title, schemaVersion: source.schemaVersion, settings: source.settings,
    nodes: (source.nodes || []).map(({ id, type, title, config, ports }) => ({ id, type, title, config, ports })), edges: source.edges || [] });
  return JSON.stringify(execution(run.document)) !== JSON.stringify(execution(document));
}
export function workflowRunAttemptAdvanced(previous, next) {
  if (!previous?.document || !next?.document || previous.id !== next.id || previous.workflowId !== next.workflowId
    || workflowSnapshotChanged(previous, next.document)) return false;
  return Object.entries(next.nodes || {}).some(([id, record]) => {
    const before = previous.nodes?.[id];
    if (!before || typeof before.attemptId !== 'string' || !before.attemptId || !Number.isSafeInteger(before.attempt)
      || !Number.isSafeInteger(record.attempt) || record.attempt < before.attempt) return false;
    const retained = record.history || [];
    return retained.length > (before.history || []).length && retained.some(item => item.attempt === before.attempt && item.attemptId === before.attemptId);
  });
}
export function runtimeResultPreview(run) {
  if (!run) return { kind: 'empty', label: '最终结果', text: '暂无结果', hasValue: false };
  if (run.status === 'complete') {
    const hasValue = own(run, 'output') || typeof run.outputText === 'string';
    return { kind: 'complete', label: '最终结果', hasValue, text: typeof run.outputText === 'string' && run.outputText !== '' ? run.outputText : own(run, 'output') ? display(run.output) : run.outputText || '' };
  }
  const current = run.nodes?.[run.currentNodeId], partial = current && ['pending', 'skipped'].includes(current.status) ? '' : typeof current?.partialText === 'string' ? current.partialText : run.partialText;
  const title = run.document?.nodes?.find(item => item.id === run.currentNodeId)?.title;
  if (typeof partial === 'string' && partial !== '') return { kind: 'partial', label: title ? `当前步骤预览 · ${title}（未完成）` : '当前步骤预览（未完成）', hasValue: false, text: partial };
  return { kind: 'pending', label: '最终结果', hasValue: false, text: ACTIVE.has(run.status) ? '等待流程完成' : '流程未确认成功' };
}
export function workflowNeedsHermes(document) { return Boolean(document?.nodes?.some(item => item.type === 'skill')); }
export function runtimeCapabilityMetadata(detail) {
  if (!detail) return [];
  if (detail.node.type === 'input') return ['Input'];
  if (detail.node.type === 'output') return ['Output'];
  if (detail.node.type === 'skill') return ['Hermes Skill', skillDisplayName(detail.skill) || detail.node.config?.skillRef || '', detail.skill?.revision ? `内容指纹 ${detail.skill.revision}` : '', detail.skill?.source ? `来源 ${detail.skill.source}` : ''].filter(Boolean);
  if (['evaluation', 'improvement'].includes(detail.node.type)) return [detail.node.type === 'evaluation' ? '产物对比' : 'Skill 改进', '仅学习', detail.reason].filter(Boolean);
  if (detail.node.type !== 'tool') return [detail.node.type, '仅编排'];
  const config = detail.node.config || {}, runtime = detail.runtime || {}, mode = runtime.kind || config.executionMode || (config.toolName ? 'tool' : 'code');
  const toolName = runtime.toolName || config.toolName;
  return [mode === 'tool' ? '内置工具' : '代码', mode === 'tool' ? WORKFLOW_TOOLS.find(tool => tool.id === toolName)?.label || toolName || '未选择工具' : (runtime.language || config.language) === 'python' ? 'Python' : 'JavaScript',
    runtime.revision ? `执行快照 ${runtime.revision}` : ''].filter(Boolean);
}
function stepLabel(run) {
  if (!run) return '';
  if (run.schemaVersion === 2 || run.document?.schemaVersion === 2) { const running = Object.values(run.nodes || {}).filter(node => node.status === 'running').length; return run.status === 'queued' ? `排队中${run.queuePosition ? ` · 第 ${run.queuePosition} 项` : ''}` : run.status === 'waiting_review' ? '等待审核，可查看已生成产物' : `${running} 项同时运行`; }
  const operations = runtimeNodeOrder(run).filter(id => ['skill', 'tool'].includes(run.document?.nodes?.find(item => item.id === id)?.type));
  const index = operations.indexOf(run.currentNodeId), position = index >= 0 ? `第 ${index + 1}/${operations.length} 项` : '';
  if (run.status === 'preparing') return position ? `准备${position}` : '准备流程';
  if (run.status === 'waiting') return position ? `${position}待处理` : '流程待处理';
  return position ? `正在执行${position}` : '流程执行中';
}

export class WorkflowRuntimeUI {
  constructor(editor, { api, connect, getBackend, getRequests, taskURL }) {
    this.editor = editor; this.api = api; this.connect = connect; this.getBackend = getBackend; this.getRequests = getRequests; this.taskURL = taskURL;
    this.active = false; this.runs = new Map(); this.revisions = new Map(); this.revision = 0; this.currentRunId = null; this.workflowId = null;
    this.selectedNodeId = null; this.nodeSelectionPinned = false; this.traceElements = new Map(); this.traceRunId = null;
    this.starting = false; this.submissionUncertain = false; this.stopping = new Set(); this.stopRequested = new Set(); this.loading = false; this.listRequest = 0; this.renderTimer = null;
    this.skills = null; this.skillsPromise = null; this.pickers = new Set(); this.skillPending = new Set();
    this.mount(); this.learning = new WorkflowLearningUI(this); this.onFeedbackLearning = job => this.learning.acceptFeedbackLearning(job); this.feedback = new WorkflowFeedbackUI(this, this.feedbackHost); editor.runtime = this; this.schedules = new WorkflowSchedulesUI(this); editor.studio?.attachRuntime(this); this.refreshBackend();
  }

  mount() {
    const panel = node('section', 'wf-runtime is-collapsed'); panel.setAttribute('aria-label', '工作流执行');
    const header = node('div', 'wf-runtime-header');
    const toggle = button('运行记录与日志', () => this.setExpanded(panel.classList.contains('is-collapsed')), 'wf-runtime-toggle'); toggle.setAttribute('aria-expanded', 'false');
    this.statusNode = node('span', 'wf-runtime-status', '尚未运行');
    this.summaryNode = node('span', 'wf-runtime-summary');
    this.minimalButton = button('创建最小流程', () => void this.createMinimalFlow(), 'wf-button wf-runtime-small');
    this.addSkillButton = button('添加 Skill', () => void this.insertSkill(), 'wf-button wf-runtime-small');
    this.addToolButton = button('添加工具 / 代码', () => void this.insertTool(), 'wf-button wf-runtime-small');
    header.append(toggle, this.statusNode, this.summaryNode);
    const body = node('div', 'wf-runtime-body');
    const recent = node('div', 'wf-runtime-recent'); const recentLabel = node('label', '', '运行记录');
    this.recentSelect = node('select'); this.recentSelect.setAttribute('aria-label', '选择运行记录');
    this.recentSelect.addEventListener('change', () => { this.currentRunId = this.recentSelect.value || null; this.selectedNodeId = null; this.nodeSelectionPinned = false; this.render(); if (this.currentRunId) void this.loadRun(this.currentRunId); });
    this.refreshButton = button('刷新', () => void this.loadRecent(true), 'wf-button wf-runtime-small');
    recent.append(recentLabel, this.recentSelect, this.refreshButton);
    const quickActions = node('div', 'wf-runtime-quick-actions'); quickActions.setAttribute('role', 'group'); quickActions.setAttribute('aria-label', '流程快捷操作');
    quickActions.append(this.addSkillButton, this.addToolButton, this.minimalButton);
    this.notice = node('p', 'wf-runtime-notice'); this.notice.setAttribute('role', 'status'); this.notice.hidden = true;
    this.connection = node('div', 'wf-runtime-connection');
    this.connection.append(node('span', '', '连接 Hermes 后可运行包含 Skill 的流程。'), button('连接 Hermes', () => void this.connectBackend(), 'wf-button wf-runtime-small'));
    const columns = node('div', 'wf-runtime-columns');
    const inputSection = node('section', 'wf-runtime-input'); const inputHeading = node('div', 'wf-runtime-section-heading');
    this.inputLabel = node('label', '', '下次运行输入'); this.inputLabel.htmlFor = 'wf-runtime-input'; this.inputHint = node('span', 'wf-runtime-hint'); inputHeading.append(this.inputLabel, this.inputHint);
    this.input = node('textarea'); this.input.id = 'wf-runtime-input'; this.input.placeholder = '输入交给第一个能力节点处理的内容'; this.input.setAttribute('aria-label', '工作流运行输入'); this.input.spellcheck = false;
    const inputActions = node('div', 'wf-runtime-input-actions');
    this.startButton = button('运行流程', () => void this.start(), 'wf-button primary');
    this.stopButton = button('停止', () => void this.interrupt(), 'wf-button'); this.stopButton.hidden = true;
    inputActions.append(this.startButton, this.stopButton);
    inputSection.append(inputHeading, this.input, inputActions);
    const outputSection = node('section', 'wf-runtime-output'); const outputHeading = node('div', 'wf-runtime-section-heading');
    this.outputLabel = node('strong', '', '运行结果'); const outputActions = node('div', 'wf-runtime-output-actions');
    this.copyButton = button('复制', () => void this.copyOutput(), 'wf-button wf-runtime-small');
    this.downloadButton = button('下载', () => this.downloadOutput(), 'wf-button wf-runtime-small');
    this.feedbackButton = button('在对话中反馈', () => this.openFeedback(), 'wf-button wf-runtime-small'); this.feedbackButton.disabled = true;
    outputActions.append(this.feedbackButton, this.copyButton, this.downloadButton); outputHeading.append(this.outputLabel, outputActions);
    this.runInfo = node('p', 'wf-runtime-run-info');
    this.error = node('p', 'wf-runtime-error'); this.error.setAttribute('role', 'status');
    this.approval = node('div', 'wf-runtime-approval');
    this.output = node('pre', 'wf-runtime-output-text', '暂无结果'); this.output.tabIndex = 0; this.output.setAttribute('aria-label', '所选运行的结果');
    const inputSnapshot = node('details', 'wf-runtime-input-snapshot'); inputSnapshot.append(node('summary', '', '查看本次实际输入'));
    this.inputSnapshot = node('pre'); inputSnapshot.append(this.inputSnapshot); this.inputSnapshotDetails = inputSnapshot;
    outputSection.append(outputHeading, this.runInfo, this.error, this.approval, this.output, inputSnapshot);
    this.draftNotice = node('p', 'wf-runtime-draft-notice', '草稿与当前运行快照不同。'); this.draftNotice.hidden = true;
    this.nodeInspection = node('details', 'wf-runtime-node-inspection'); this.nodeInspection.open = true; this.nodeInspection.append(node('summary', '', '节点执行轨迹与数据'));
    const nodeLayout = node('div', 'wf-runtime-node-layout'); this.trace = node('ol', 'wf-runtime-trace'); this.trace.setAttribute('aria-label', '本次运行的有序节点');
    const detail = node('section', 'wf-runtime-node-detail'); detail.setAttribute('aria-label', '所选节点运行详情');
    const detailHeading = node('div', 'wf-runtime-section-heading'); this.nodeTitle = node('strong'); this.nodeStatus = node('span', 'wf-runtime-status'); detailHeading.append(this.nodeTitle, this.nodeStatus);
    this.nodeMeta = node('p', 'wf-runtime-node-meta'); this.nodeTask = node('div', 'wf-runtime-approval'); this.nodeError = node('p', 'wf-runtime-error');
    const metadata = node('details', 'wf-runtime-node-metadata'); metadata.append(node('summary', '', '能力版本与运行时间'), this.nodeMeta);
    const nodeIO = node('div', 'wf-runtime-node-io'); const inputData = node('section'), outputData = node('section');
    inputData.append(node('h4', '', '该节点实际输入')); this.nodeInput = node('pre'); this.nodeInput.tabIndex = 0; this.nodeInput.setAttribute('aria-label', '所选节点实际输入'); inputData.append(this.nodeInput);
    this.nodeOutputLabel = node('h4', '', '该节点输出'); this.nodeOutput = node('pre'); this.nodeOutput.tabIndex = 0; this.nodeOutput.setAttribute('aria-label', '所选节点输出'); outputData.append(this.nodeOutputLabel, this.nodeOutput); nodeIO.append(inputData, outputData);
    this.nodeLogs = node('details', 'wf-runtime-node-logs'); this.nodeLogs.append(node('summary', '', '本节点执行日志'));
    const stdoutLabel = node('h4', '', 'stdout'), stderrLabel = node('h4', '', 'stderr'); this.nodeStdout = node('pre'); this.nodeStderr = node('pre'); this.nodeStdout.tabIndex = 0; this.nodeStdout.setAttribute('aria-label', '所选节点 stdout'); this.nodeStderr.tabIndex = 0; this.nodeStderr.setAttribute('aria-label', '所选节点 stderr');
    this.nodeLogNotice = node('p', 'wf-runtime-hint'); this.nodeLogs.append(stdoutLabel, this.nodeStdout, stderrLabel, this.nodeStderr, this.nodeLogNotice);
    detail.append(detailHeading, this.nodeError, nodeIO, this.nodeTask, metadata, this.nodeLogs); nodeLayout.append(this.trace, detail); this.nodeInspection.append(nodeLayout);
    this.feedbackHost = node('div', 'wf-runtime-feedback');
    columns.append(inputSection, outputSection); body.append(recent, this.notice, this.connection, this.draftNotice, this.nodeInspection, columns, this.feedbackHost, quickActions); panel.append(header, body);
    this.panel = panel; this.toggle = toggle; this.editor.root.querySelector('.wf-center').append(panel);
    this.confirmDialog = node('dialog', 'wf-dialog wf-runtime-confirm'); this.confirmDialog.setAttribute('aria-label', '创建最小流程'); this.editor.root.append(this.confirmDialog);
  }

  setExpanded(expanded = true) { this.panel.classList.toggle('is-collapsed', !expanded); this.toggle.setAttribute('aria-expanded', String(expanded)); }
  openFeedback() {
    if (this.editor.conversation?.focusContext) {
      const run = this.currentRun();
      if (!run) return;
      const nodeId = this.selectedNodeId, record = run.nodes?.[nodeId];
      const context = { runId: run.id, ...(record ? { nodeId, attempt: record.attempt || 0, attemptId: record.attemptId || null,
        artifactIds: (record.artifacts || []).map(item => item.id), artifactHashes: (record.artifacts || []).map(item => ({ id: item.id, sha256: item.sha256 })) } : {}) };
      this.editor.conversation.focusContext(context, { intent: 'auto' });
      return;
    }
    if (!this.feedback?.canOpen()) return;
    this.setExpanded(); this.feedback.open();
  }
  showNotice(message = '', error = false) { this.notice.textContent = text(message); this.notice.hidden = !message; this.notice.classList.toggle('error', error); }
  currentRun() { return this.runs.get(this.currentRunId) || null; }
  currentDocument() { return this.editor.nodeLibrary?.rootDocument || this.editor.doc; }
  workflowRuns() { return [...this.runs.values()].filter(run => run.workflowId === this.currentDocument()?.id).sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || ''))); }
  activeRun() { return this.workflowRuns().find(run => ACTIVE.has(run.status)); }

  activate() {
    this.active = true; this.syncWorkflow(); this.refreshBackend(); this.learning?.activate(); void this.loadRecent();
  }
  deactivate() { this.active = false; this.learning?.deactivate(); this.schedules?.close(); if (this.confirmDialog.open) this.confirmDialog.close(); }
  syncWorkflow() {
    this.schedules?.syncWorkflow();
    const id = this.currentDocument()?.id;
    if (this.workflowId === id) return false;
    this.workflowId = id; this.currentRunId = null; this.selectedNodeId = null; this.nodeSelectionPinned = false; this.submissionUncertain = false; this.listRequest++; this.loading = false; this.refreshButton.disabled = false; this.showNotice(); this.render(); return true;
  }
  refreshBackend() {
    const changed = this.syncWorkflow(); const ready = this.getBackend()?.state === 'ready', becameReady = ready && !this.backendReady; this.backendReady = ready; this.connection.hidden = ready || !workflowNeedsHermes(this.currentDocument());
    for (const control of this.connection.querySelectorAll('button')) control.disabled = this.connecting || this.getBackend()?.state === 'starting';
    this.updateRunButton(); this.renderApproval();
    this.learning?.refreshBackend();
    if (becameReady) void this.loadSkills(true).then(() => { for (const picker of this.pickers) if (picker.wrapper.isConnected) picker.refreshDetail?.(); });
    if (changed && this.active) void this.loadRecent();
  }
  updateRunButton() {
    if (this.editor.nodeLibrary?.nested) {
      for (const control of [this.startButton, this.editor.root.querySelector('[data-action="run"]')].filter(Boolean)) {
        if (control === this.startButton) { control.textContent = '内部编辑中'; control.setAttribute('aria-label', '内部编辑中'); control.title = '请先应用或取消内部修改，再从主流程运行。'; }
        else setToolbarControl(control, { label: '运行当前流程 · 内部编辑中', icon: 'play' });
        control.disabled = true;
      }
      return;
    }
    if (this.editor.libraryLifecycle && this.editor.libraryLifecycle !== 'active') {
      for (const control of [this.startButton, this.editor.root.querySelector('[data-action="run"]')].filter(Boolean)) {
        if (control === this.startButton) { control.textContent = '只读工作流'; control.setAttribute('aria-label', '只读工作流'); control.title = '请先在看板恢复工作流，再运行或学习。'; }
        else setToolbarControl(control, { label: '运行当前流程 · 只读工作流', icon: 'play' });
        control.disabled = true;
      }
      return;
    }
    this.editor.refreshPropertyReadiness?.();
    this.schedules?.syncWorkflow();
    if (this.workflowId !== this.currentDocument()?.id) { this.syncWorkflow(); if (this.active) void this.loadRecent(); return; }
    this.learning?.syncMode();
    const learning = this.currentDocument()?.mode === 'learn', pendingSkill = workflowNeedsHermes(this.currentDocument()) && this.skillPending.size > 0;
    if (learning && this.learning) { this.learning.updateRunButton(); this.syncDraftState(); return; }
    if (this.startButton) this.startButton.hidden = false;
    const activeLearning = this.learning?.activeJob();
    const v2 = isV2(this.currentDocument());
    const busy = this.starting || this.loading || this.submissionUncertain || !v2 && Boolean(this.activeRun()) || Boolean(activeLearning) || pendingSkill;
    const label = learning ? '请打开学习面板' : this.starting ? '正在提交…' : this.loading ? '正在同步运行记录…' : this.submissionUncertain ? '请先刷新运行记录' : activeLearning ? '学习进行中 · 切换学习查看' : this.activeRun() ? v2 ? '加入运行队列' : stepLabel(this.activeRun()) : pendingSkill ? '正在读取 Skill…' : '运行当前流程';
    for (const control of [this.startButton, this.editor.root.querySelector('[data-action="run"]')].filter(Boolean)) {
      if (control === this.startButton) { control.textContent = label; control.setAttribute('aria-label', label);
        control.title = learning ? '学习模式' : this.getBackend()?.state === 'ready' || !workflowNeedsHermes(this.currentDocument()) ? '运行当前流程' : '未连接 Hermes'; }
      else setToolbarControl(control, { label: label === '运行当前流程' ? label : `运行当前流程 · ${label}`, icon: 'play',
        busy: Boolean(this.starting || this.loading || activeLearning || pendingSkill || !v2 && this.activeRun()) });
      control.disabled = learning || busy;
    }
    const entry = this.currentDocument()?.nodes?.find(item => item.type === 'input');
    this.inputLabel.textContent = text(entry?.config?.fieldName ? `下次运行输入 · ${entry.config.fieldName}` : '下次运行输入');
    this.inputHint.textContent = INPUT_TYPES[entry?.config?.outputType] || '按入口类型解析';
    this.connection.hidden = this.getBackend()?.state === 'ready' || !workflowNeedsHermes(this.currentDocument());
    this.syncDraftState();
  }
  syncDraftState() {
    if (this.editor.nodeLibrary?.nested) { this.editor.setRunStates?.({}); return; }
    const run = this.currentRun(), draft = this.currentDocument();
    const comparableDraft = this.learning?.isInspecting() ? { ...draft, mode: 'execute' } : draft;
    const changed = !!run && (workflowSnapshotChanged(run, comparableDraft) || this.editor.propertyDrafts?.size > 0);
    if (this.draftNotice) this.draftNotice.hidden = !changed;
    const currentIds = new Set((draft?.nodes || []).map(item => item.id));
    const states = run && run.workflowId === draft?.id && !changed
      ? Object.fromEntries(Object.entries(run.nodes || {}).filter(([id]) => currentIds.has(id))) : {};
    this.editor.setRunStates?.(states);
  }

  async connectBackend() {
    if (this.connecting) return; this.connecting = true; this.refreshBackend(); this.showNotice('正在连接 Hermes…');
    try { await this.connect(); this.refreshBackend(); this.showNotice('Hermes 已连接'); await this.loadSkills(); }
    catch (error) { this.showNotice(`连接失败：${error.message}`, true); }
    finally { this.connecting = false; this.refreshBackend(); }
  }

  parseInput(entry, raw = this.input.value) {
    const type = entry.config.outputType;
    const saved = workflowInputDefault(entry);
    if (!raw.trim() && saved !== undefined) {
      if (type === 'text' && typeof saved !== 'string') throw new Error('固定任务的默认输入需要文本。');
      raw = type === 'text' ? saved : JSON.stringify(saved);
    }
    if (entry.config.required && !raw.trim()) throw new Error('请输入本次运行的数据。');
    if (type === 'fileRef' && !isV2(this.currentDocument())) throw new Error('首版暂不接收文件引用。请将 Input 和 Skill 输入类型改为 text，或创建最小流程。');
    if (['fileRef', 'file', 'folder', 'image'].includes(type) && isV2(this.currentDocument())) { try { return JSON.parse(raw); } catch { return raw; } }
    if (type === 'text') return raw;
    let value; try { value = JSON.parse(raw); } catch { if (type === 'any') return raw; throw new Error(`输入需要有效的${INPUT_TYPES[type] || ' JSON'}。`); }
    if (type === 'object' && (value === null || typeof value !== 'object' || Array.isArray(value))) throw new Error('输入需要 JSON 对象。');
    if (type === 'array' && !Array.isArray(value)) throw new Error('输入需要 JSON 数组。');
    if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error('输入需要有限数字。');
    if (type === 'boolean' && typeof value !== 'boolean') throw new Error('输入需要 true 或 false。');
    if (!['any', 'object', 'array', 'number', 'boolean'].includes(type)) throw new Error('入口数据类型暂不支持。');
    return value;
  }
  async start() {
    if (this.editor.nodeLibrary?.nested) { this.showNotice('请先应用或取消子流程内部修改，再从主流程运行。', true); return; }
    if (this.editor.libraryLifecycle && this.editor.libraryLifecycle !== 'active') { this.showNotice('此工作流只读，请先在看板恢复。', true); return; }
    if (this.currentDocument()?.mode === 'learn' && this.learning) return this.learning.start();
    this.setExpanded(); this.syncWorkflow();
    if (this.currentDocument()?.mode === 'learn') { this.showNotice('学习面板未加载，请刷新页面后重试。', true); return; }
    if (this.starting || this.loading || !isV2(this.currentDocument()) && this.activeRun() || workflowNeedsHermes(this.currentDocument()) && this.skillPending.size || this.submissionUncertain) return;
    this.starting = true; this.updateRunButton(); let document, input;
    try {
      document = await this.editor.prepareRun();
      this.editor.studio?.syncRawInput();
      if (workflowNeedsHermes(document) && this.getBackend()?.state !== 'ready') throw new Error('此流程包含 Skill，请先连接 Hermes。纯工具 / 代码流程可离线运行。');
      input = this.parseInput(planWorkflow(document).inputNode);
      if (isV2(document)) {
        const prepared = await this.editor.studio.preflight({ quiet: true, document, input });
        if (!prepared.ok) {
          const issues = (prepared.errors || []).filter(issue => issue.message).map(issue => `${issue.label ? issue.label + '：' : ''}${issue.message}`);
          throw new Error(issues.length ? '运行前还需要处理：' + issues.join('；') : '本次运行资料尚未准备好，请查看输入检查结果。');
        }
        input = prepared.input;
      }
    } catch (error) { this.starting = false; this.updateRunButton(); this.showNotice(error.message, true); return; }
    this.showNotice('正在提交本次流程快照…'); const revision = this.revision;
    try {
      const result = await this.api('/api/workflow-runs', { method: 'POST', body: { document, input } }); const run = result.run || result;
      if (!run?.id) throw new Error('服务未返回运行标识，请刷新运行记录确认状态。');
      if ((this.revisions.get(run.id) || 0) <= revision) this.storeRun(run);
      if (run.workflowId === this.currentDocument()?.id && this.currentRunId !== run.id) { this.currentRunId = run.id; this.selectedNodeId = null; this.nodeSelectionPinned = false; } this.showNotice(); this.editor.studio?.setView('run'); this.render();
    } catch (error) { this.submissionUncertain = true; this.showNotice(`提交未确认：${error.message}。请求不会自动重试，请先刷新运行记录。`, true); }
    finally { this.starting = false; this.updateRunButton(); }
  }
  async interrupt() {
    const run = ACTIVE.has(this.currentRun()?.status) ? this.currentRun() : this.activeRun(); if (!run || !ACTIVE.has(run.status) || this.stopping.has(run.id) || this.stopRequested.has(run.id)) return;
    this.stopping.add(run.id); this.render(); const revision = this.revisions.get(run.id) || 0;
    try { const result = await this.api(`/api/workflow-runs/${encodeURIComponent(run.id)}/interrupt`, { method: 'POST', body: {} }); const next = result.run || result;
      if ((this.revisions.get(run.id) || 0) === revision && next?.id) this.storeRun(next);
      if (ACTIVE.has(this.runs.get(run.id)?.status)) { this.stopRequested.add(run.id); this.showNotice('停止请求已发送，等待后端确认终态。'); }
      else this.showNotice('后端已确认本次运行终态。');
    } catch (error) { this.showNotice(`停止请求失败：${error.message}`, true); }
    finally { this.stopping.delete(run.id); this.render(); }
  }

  storeRun(run, { allowReopen = false } = {}) {
    if (!run?.id || !run.workflowId) return;
    const previous = this.runs.get(run.id);
    if (!allowReopen && TERMINAL.has(previous?.status) && previous.status !== run.status && !workflowRunAttemptAdvanced(previous, run)) return;
    this.runs.set(run.id, run); this.revisions.set(run.id, ++this.revision);
    if (!ACTIVE.has(run.status)) this.stopRequested.delete(run.id);
    if (this.runs.size > 100) { const learningCase = this.learning?.selectedCaseData()?.runId, inspectedCase = this.learning?.inspectionRunId; const oldest = [...this.runs.values()].sort((a, b) => String(a.startedAt || '').localeCompare(String(b.startedAt || ''))).find(item => !ACTIVE.has(item.status) && item.id !== this.currentRunId && item.id !== learningCase && item.id !== inspectedCase); if (oldest) { this.runs.delete(oldest.id); this.revisions.delete(oldest.id); } }
  }
  async loadRecent(force = false) {
    const workflowId = this.currentDocument()?.id; if (!workflowId || this.loading && !force) return;
    const request = ++this.listRequest, revision = this.revision; this.loading = true; this.refreshButton.disabled = true; this.updateRunButton();
    try {
      const result = await this.api(`/api/workflow-runs?workflowId=${encodeURIComponent(workflowId)}`);
      if (request !== this.listRequest || workflowId !== this.currentDocument()?.id) return;
      for (const run of result.runs || []) if ((this.revisions.get(run.id) || 0) <= revision) this.storeRun(run);
      const records = this.workflowRuns(); if (!this.currentRunId || !records.some(run => run.id === this.currentRunId)) this.currentRunId = records.find(run => ACTIVE.has(run.status))?.id || records[0]?.id || null;
      if (this.submissionUncertain) { this.submissionUncertain = false; this.showNotice('运行记录已刷新，请确认最近记录后再决定是否开始新的运行。'); }
      this.loading = false;
      this.render();
    } catch (error) { if (request === this.listRequest) this.showNotice(`运行记录读取失败：${error.message}`, true); }
    finally { if (request === this.listRequest) { this.loading = false; this.refreshButton.disabled = false; this.updateRunButton(); } }
  }
  async loadRun(id) {
    const revision = this.revisions.get(id) || 0;
    try { const result = await this.api(`/api/workflow-runs/${encodeURIComponent(id)}`); const run = result.run || result;
      if (run.id === id && (this.revisions.get(id) || 0) === revision) this.storeRun(run);
      if (this.currentRunId === id) this.render();
    } catch (error) { if (this.currentRunId === id) this.showNotice(`运行详情读取失败：${error.message}`, true); }
  }
  async openScheduledRun(id) {
    const workflowId = this.currentDocument()?.id, revision = this.revisions.get(id) || 0;
    const result = await this.api(`/api/workflow-runs/${encodeURIComponent(id)}`), run = result.run || result;
    if (run.id !== id || run.workflowId !== workflowId || this.currentDocument()?.id !== workflowId) throw new Error('运行记录与当前工作流不匹配。');
    if ((this.revisions.get(id) || 0) === revision) this.storeRun(run);
    if (this.learning) this.learning.inspectionRunId = null;
    if (this.currentDocument()?.mode !== 'execute') this.editor.commit({ ...this.currentDocument(), mode: 'execute' }, '查看定时运行');
    this.learning?.syncMode();
    this.currentRunId = id; this.selectedNodeId = null; this.nodeSelectionPinned = false;
    this.render(); this.setExpanded();
  }
  handleEvent(event) {
    if (event.type === 'workflow.run') {
      const run = event.payload?.run || event.payload; if (!run?.id) return; const isNew = !this.runs.has(run.id); this.storeRun(run);
      if (this.editor.studio?.delegatedRuns?.has(run.id)) { this.editor.studio.delegatedRuns.set(run.id, run); this.scheduleRender(); }
      if (this.editor.studio?.tab === 'queue') void this.editor.studio.renderQueue();
      if (run.workflowId === this.currentDocument()?.id) { if (!this.learning?.isInspecting() && (!this.currentRunId || isNew && ACTIVE.has(run.status) && this.currentRun()?.status !== 'waiting_review')) { this.currentRunId = run.id; this.selectedNodeId = null; this.nodeSelectionPinned = false; } this.scheduleRender(); }
    } else if (['backend.status', 'backend.error', 'request.open', 'request.cancel'].includes(event.type)) this.refreshBackend();
    this.learning?.handleEvent(event);
    this.schedules?.handleEvent(event);
  }
  scheduleRender() {
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => { this.renderTimer = null; this.render(); }, 80);
  }
  render() {
    const records = this.workflowRuns(), run = this.currentRun();
    const recentSignature = JSON.stringify(records.map(item => [item.id, item.status, item.startedAt]));
    if (recentSignature !== this.recentSignature) {
      this.recentSelect.replaceChildren();
      if (!records.length) { const option = node('option', '', this.loading ? '正在读取…' : '暂无运行记录'); option.value = ''; this.recentSelect.append(option); }
      for (const item of records) { const option = node('option', '', runLabel(item)); option.value = item.id; this.recentSelect.append(option); }
      this.recentSignature = recentSignature;
    }
    this.recentSelect.value = this.currentRunId || ''; this.recentSelect.disabled = !records.length;
    this.statusNode.textContent = run ? STATUS[run.status] || STATUS.unknown : '尚未运行'; this.statusNode.dataset.status = run?.status || 'idle';
    const countLabel = runtimeRunCountLabel(run);
    this.summaryNode.textContent = run ? text(ACTIVE.has(run.status) ? stepLabel(run) : runtimeRunCountLabel(run, { summary: true })) : '';
    this.runInfo.textContent = run ? text([countLabel, date(run.startedAt), run.trigger?.type === 'schedule' ? `定时任务：${run.trigger.scheduleName || '按计划执行'} · 计划 ${date(run.trigger.scheduledAt)}` : ''].filter(Boolean).join(' · ')) : '';
    this.error.textContent = run?.error ? display(run.error) : run?.status === 'unknown' ? '后端尚未确认结果，请刷新运行记录或打开关联任务检查。' : ''; this.error.hidden = !this.error.textContent;
    const preview = runtimeResultPreview(run); this.outputLabel.textContent = text(preview.label); this.output.textContent = text(preview.text);
    this.output.classList.toggle('partial', preview.kind === 'partial');
    this.copyButton.disabled = !preview.hasValue; this.downloadButton.disabled = !preview.hasValue;
    const interruptRun = this.activeRun();
    this.stopButton.hidden = !interruptRun; this.stopButton.disabled = this.stopping.has(interruptRun?.id) || this.stopRequested.has(interruptRun?.id); this.stopButton.textContent = this.stopping.has(interruptRun?.id) ? '停止请求中…' : this.stopRequested.has(interruptRun?.id) ? '等待停止确认…' : '停止当前运行';
    this.inputSnapshotDetails.hidden = !run; this.inputSnapshot.textContent = run ? display(run.input) : '';
    this.input.disabled = this.starting; this.renderApproval(); this.updateRunButton(); this.renderTrace();
    if (!this.editor.conversation) this.feedback?.render(run);
    else if (this.feedbackButton) this.feedbackButton.disabled = !run;
    if (this.feedbackHost) this.feedbackHost.hidden = Boolean(this.editor.conversation);
    this.editor.studio?.renderRuntime(); this.editor.conversation?.render();
  }
  renderApproval() {
    const run = this.currentRun(); const current = runtimeNodeDetails(run, run?.currentNodeId);
    this.renderTaskLink(this.approval, current?.node.type === 'tool' ? current.sessionId : current?.sessionId || run?.sessionId, current?.status || run?.status);
    if (this.nodeTask) { const selected = runtimeNodeDetails(run, this.selectedNodeId); this.renderTaskLink(this.nodeTask, selected?.sessionId, selected?.status); }
  }
  renderTaskLink(container, sessionId, status) {
    container.hidden = !sessionId; if (!sessionId) { container.classList.toggle('waiting', false); return; }
    const requests = (this.getRequests() || []).filter(request => request.sessionId === sessionId), waiting = requests.length > 0 || status === 'waiting';
    this.taskLinks ||= new WeakMap();
    let parts = this.taskLinks.get(container);
    if (!parts) {
      parts = { notice: node('span'), link: node('a', 'wf-runtime-task-link') };
      container.append(parts.notice, parts.link); this.taskLinks.set(container, parts);
    }
    parts.notice.hidden = !waiting;
    const notice = waiting ? requests.length ? `${requests.length} 项审批或澄清待处理` : '等待人工处理' : '';
    const label = waiting ? '打开任务并处理' : '查看该步骤关联任务', href = this.taskURL(sessionId);
    if (parts.notice.textContent !== notice) parts.notice.textContent = notice;
    if (parts.link.textContent !== label) parts.link.textContent = label;
    if (parts.link.getAttribute('href') !== href) parts.link.setAttribute('href', href);
    container.classList.toggle('waiting', waiting);
  }
  renderTrace() {
    const run = this.currentRun(); this.nodeInspection.hidden = !run; if (!run) { this.trace.replaceChildren(); this.traceElements.clear(); this.traceRunId = null; return; }
    const order = runtimeNodeOrder(run);
    if (!this.nodeSelectionPinned || !order.includes(this.selectedNodeId)) this.selectedNodeId = order.includes(run.currentNodeId) ? run.currentNodeId : this.selectedNodeId && order.includes(this.selectedNodeId) ? this.selectedNodeId : order[0] || null;
    if (this.traceRunId !== run.id || [...this.traceElements.keys()].join('\0') !== order.join('\0')) {
      this.trace.replaceChildren(); this.traceElements.clear(); this.traceRunId = run.id;
      for (const [index, id] of order.entries()) {
        const row = node('li'); const select = button('', () => { this.selectedNodeId = id; this.nodeSelectionPinned = true; this.renderTrace(); }, 'wf-runtime-step');
        const number = node('span', 'wf-runtime-step-number', String(index + 1)), title = node('span', 'wf-runtime-step-title'), status = node('span', 'wf-runtime-step-status');
        select.append(number, title, status); row.append(select); this.trace.append(row); this.traceElements.set(id, { select, title, status });
      }
    }
    for (const id of order) {
      const detail = runtimeNodeDetails(run, id), row = this.traceElements.get(id);
      row.title.textContent = text(detail.node.title); row.status.textContent = STATUS[detail.status] || STATUS.unknown; row.select.dataset.status = detail.status;
      row.select.classList.toggle('selected', this.selectedNodeId === id); row.select.setAttribute('aria-pressed', String(this.selectedNodeId === id)); row.select.setAttribute('aria-label', text(`${detail.node.title} · ${STATUS[detail.status] || STATUS.unknown}`));
    }
    const selected = runtimeNodeDetails(run, this.selectedNodeId); if (!selected) return;
    this.nodeTitle.textContent = text(selected.node.title); this.nodeStatus.textContent = STATUS[selected.status] || STATUS.unknown; this.nodeStatus.dataset.status = selected.status;
    const metadata = runtimeCapabilityMetadata(selected);
    if (selected.startedAt) metadata.push(`开始 ${date(selected.startedAt)}`); if (selected.completedAt) metadata.push(`结束 ${date(selected.completedAt)}`);
    if (selected.legacy) metadata.push('旧记录：仅展示已记录或能从单步链确认的数据');
    this.nodeMeta.textContent = text(metadata.filter(Boolean).join('\n'));
    this.nodeError.textContent = display(selected.error); this.nodeError.hidden = !selected.error;
    this.nodeInput.textContent = selected.hasInput ? display(selected.input) : selected.status === 'skipped' ? '本节点已跳过，没有执行输入。' : selected.status === 'pending' ? '尚未执行，输入尚未传入。' : selected.status === 'preparing' ? '准备中，输入尚未传入。' : selected.legacy ? '该历史记录未采集此节点输入。' : '本次运行尚未记录该节点输入。';
    const partial = !['complete', 'pending', 'skipped'].includes(selected.status) && selected.partialText;
    this.nodeOutputLabel.textContent = partial ? '该节点未完成片段' : selected.status === 'complete' ? '该节点正式输出' : selected.hasOutput ? '该节点记录的输出（未确认）' : '该节点输出';
    this.nodeOutput.textContent = selected.status === 'pending' ? '尚未执行，没有输出。' : selected.status === 'skipped' ? '已跳过，没有输出。' : partial ? text(selected.partialText) : selected.hasOutput ? display(selected.output) : selected.status === 'complete' && typeof selected.outputText === 'string' ? text(selected.outputText) : selected.status === 'complete' ? '该历史记录未采集此节点输出。' : '该节点尚无已确认输出。';
    this.nodeOutput.classList.toggle('partial', selected.status !== 'complete');
    if (this.nodeLogs) {
      this.nodeLogs.hidden = selected.node.type !== 'tool';
      this.nodeStdout.textContent = text(selected.logs?.stdout || '（无 stdout）'); this.nodeStderr.textContent = text(selected.logs?.stderr || '（无 stderr）');
      this.nodeLogNotice.textContent = [selected.logs?.stdoutTruncated ? 'stdout 已截断' : '', selected.logs?.stderrTruncated ? 'stderr 已截断' : ''].filter(Boolean).join(' · '); this.nodeLogNotice.hidden = !this.nodeLogNotice.textContent;
    }
    this.renderTaskLink(this.nodeTask, selected.sessionId, selected.status);
  }
  onSelectionChange(id) {
    if (this.editor.nodeLibrary?.nested) return;
    if (!id || !runtimeNodeDetails(this.currentRun(), id)) return;
    this.selectedNodeId = id; this.nodeSelectionPinned = true; this.nodeInspection.open = true; this.renderTrace();
    this.editor.studio?.renderInspectorData(id);
  }
  async insertSkill() {
    try { const added = await this.editor.insertSkillAfterSelected(); this.refreshBackend(); this.showNotice(`已添加${added?.title ? `「${added.title}」` : ' Skill'}。`); this.setExpanded(); }
    catch (error) { this.showNotice(error.message, true); this.setExpanded(); }
  }
  async insertTool() {
    try { const added = await this.editor.insertToolAfterSelected(); this.refreshBackend(); this.showNotice(`已添加${added?.title ? `「${added.title}」` : '工具 / 代码'}。`); this.setExpanded(); }
    catch (error) { this.showNotice(error.message, true); this.setExpanded(); }
  }
  async copyOutput() {
    if (this.currentRun()?.status !== 'complete') return;
    try { await navigator.clipboard.writeText(this.output.textContent); this.showNotice('结果已复制。'); }
    catch { this.showNotice('浏览器未允许复制，可在结果区域手动选择文本。', true); }
  }
  downloadOutput() {
    const run = this.currentRun(); if (run?.status !== 'complete') return;
    const json = own(run, 'output') && typeof run.output !== 'string';
    const value = json ? display(run.output) : this.output.textContent;
    const url = URL.createObjectURL(new Blob([value], { type: json ? 'application/json;charset=utf-8' : 'text/plain;charset=utf-8' }));
    const link = node('a'); link.href = url; link.download = `workflow-result-${String(run.id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80)}.${json ? 'json' : 'txt'}`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.showNotice('已通过浏览器下载结果；流程没有自动写入工作区文件。');
  }
  async createMinimalFlow() {
    if (this.activeRun() || this.starting) { this.showNotice('本次运行仍在进行，可完成后再创建最小流程。'); this.setExpanded(); return; }
    if (this.currentDocument()?.nodes?.length && !await this.confirmReplacement()) return;
    try { await this.editor.createMinimalFlow(); this.syncWorkflow(); this.refreshBackend(); this.setExpanded(); this.showNotice('已创建文本 Input → Skill → Output，请选择真实 Skill 并填写输入。'); }
    catch (error) { this.showNotice(error.message, true); }
  }
  confirmReplacement() {
    return new Promise(resolve => {
      const dialog = this.confirmDialog; dialog.replaceChildren(); dialog.append(node('h2', '', '创建最小流程'), node('p', '', '这会将当前画布替换为三个相连的文本节点，可通过撤销恢复。当前运行记录会保留。'));
      const actions = node('div', 'wf-dialog-actions'); let agreed = false;
      actions.append(button('取消', () => dialog.close()), button('替换画布', () => { agreed = true; dialog.close(); }, 'wf-button primary')); dialog.append(actions);
      dialog.addEventListener('close', () => resolve(agreed), { once: true }); dialog.showModal(); actions.firstElementChild.focus();
    });
  }

  async loadSkills(force = false) {
    if (this.skillsPromise) return this.skillsPromise;
    if (this.skills && !force) return this.skills;
    this.skillsPromise = this.api('/api/skills').then(result => { this.skills = result; return result; }).catch(error => {
      this.skills = { connected: this.getBackend()?.state === 'ready', skills: [], error: error.message }; return this.skills;
    }).finally(() => { this.skillsPromise = null; for (const picker of this.pickers) if (picker.wrapper.isConnected) picker.render(); else this.pickers.delete(picker); });
    return this.skillsPromise;
  }
  mountSkillPicker(form, workflowNode, draft) {
    for (const picker of this.pickers) if (!picker.wrapper.isConnected) this.pickers.delete(picker);
    const config = draft?.config || draft || workflowNode.config || {};
    const wrapper = node('div', 'wf-skill-picker wf-field'); const label = node('label', '', '真实 Skill');
    const skillRef = node('input'); skillRef.type = 'hidden'; skillRef.hidden = true; skillRef.name = 'skillRef'; skillRef.value = config.skillRef || '';
    const version = node('input'); version.type = 'hidden'; version.hidden = true; version.name = 'version'; version.value = config.version || '';
    const search = node('input'); search.type = 'search'; search.placeholder = '搜索已安装的 Skill…'; search.setAttribute('aria-label', '搜索真实 Skill');
    const select = node('select'); select.id = `wf-skill-select-${workflowNode.id}`; label.htmlFor = select.id; select.size = 4; select.setAttribute('aria-label', '选择真实 Skill');
    const details = node('p', 'wf-skill-picker-details'); const revision = node('p', 'wf-skill-picker-revision');
    const actions = node('div', 'wf-skill-picker-actions'); const refresh = button('刷新技能', () => { void this.loadSkills(true).then(() => { if (skillRef.value && this.skills?.connected) void choose(skillRef.value, false); }); }, 'wf-button wf-runtime-small');
    const connect = button('连接 Hermes', () => void this.connectBackend(), 'wf-button wf-runtime-small');
    const update = button('更新内容指纹', () => void choose(skillRef.value, true), 'wf-button wf-runtime-small'); update.hidden = true;
    const versionDetails = node('details', 'wf-skill-version-details'); versionDetails.append(node('summary', '', '固定版本与来源'), revision);
    actions.append(refresh, connect, update); wrapper.append(label, skillRef, version, search, select, details, versionDetails, actions); form.append(wrapper);
    const state = { wrapper, render: null }; this.pickers.add(state); let selectionRequest = 0; let currentDetail = null;
    const workflowId = this.editor.doc.id, selectionKey = `${workflowId}:${workflowNode.id}`; this.skillSelectionRequests ||= new Map();
    const changed = () => { skillRef.dispatchEvent(new Event('input', { bubbles: true })); this.updateRunButton(); };
    const describe = () => {
      if (!currentDetail) return;
      details.textContent = text([currentDetail.description || '未提供说明', currentDetail.source ? `来源：${currentDetail.source}` : ''].filter(Boolean).join('\n'));
      revision.textContent = text(version.value ? `内容指纹 ${version.value}` : '尚未记录内容指纹');
      const differs = Boolean(version.value && currentDetail.revision && version.value !== currentDetail.revision);
      update.hidden = !differs; if (differs) revision.textContent += ' · 内容已有更新，重新运行前请更新引用。';
    };
    const choose = async (name, apply) => {
      const request = ++selectionRequest; currentDetail = null; update.hidden = true;
      const generation = (this.skillSelectionRequests.get(selectionKey) || 0) + 1; this.skillSelectionRequests.set(selectionKey, generation);
      for (const pending of this.skillPending) if (pending.selectionKey === selectionKey) this.skillPending.delete(pending);
      if (!name) { skillRef.value = ''; version.value = ''; details.textContent = '请选择一项真实 Skill。'; revision.textContent = ''; changed(); return; }
      const ticket = { selectionKey, workflowId, nodeId: workflowNode.id, generation, apply }; this.skillPending.add(ticket);
      if (apply) { skillRef.value = name; version.value = ''; changed(); }
      this.updateRunButton(); details.textContent = '正在读取技能内容指纹…';
      try {
        const result = await this.api(`/api/skills/${encodeURIComponent(name)}`);
        if (request !== selectionRequest || this.skillSelectionRequests.get(selectionKey) !== generation || this.editor.doc.id !== workflowId) return;
        currentDetail = { name: result.name, displayName: result.displayName, description: result.description, source: result.source, revision: result.revision };
        if (result.name !== name || typeof result.revision !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(result.revision)) throw new Error('服务未返回匹配的 Skill 内容指纹。');
        if (apply) { version.value = result.revision; mergeSkillSelectionDraft(this.editor, workflowId, workflowNode.id, name, result.revision); }
        describe();
      } catch (error) { if (request === selectionRequest && this.skillSelectionRequests.get(selectionKey) === generation && this.editor.doc.id === workflowId) { details.textContent = text(`技能读取失败：${error.message}`); revision.textContent = version.value ? text(`保留引用 ${version.value}`) : '内容指纹尚未记录，不能运行。'; } }
      finally { this.skillPending.delete(ticket); this.updateRunButton(); }
    };
    state.render = () => {
      const data = this.skills, query = search.value.trim().toLowerCase(); const skills = (data?.skills || []).filter(skill => !query || `${skillDisplayName(skill)} ${skill.name} ${skill.description || ''} ${skill.source || ''}`.toLowerCase().includes(query));
      select.replaceChildren(); const placeholder = node('option', '', data?.connected ? '选择一项 Skill' : '连接后读取真实 Skills'); placeholder.value = ''; select.append(placeholder);
      if (skillRef.value && !skills.some(skill => skill.name === skillRef.value)) { const selected = node('option', '', `${skillDisplayName(currentDetail) || skillRef.value} · ${query ? '当前选择' : '引用待确认'}`); selected.value = skillRef.value; select.append(selected); }
      for (const skill of skills) { const option = node('option', '', [skillDisplayName(skill), skillVersionLabel(skill)].filter(Boolean).join(' · ')); option.value = skill.name; option.title = text(skill.description || ''); select.append(option); }
      select.value = skillRef.value; select.disabled = !data?.connected || Boolean(data?.error); refresh.disabled = Boolean(this.skillsPromise); connect.hidden = this.getBackend()?.state === 'ready';
      if (data?.error) details.textContent = text(`技能列表读取失败：${data.error}`); else if (!data?.connected) details.textContent = '连接 Hermes 后选择实际安装的技能。'; else if (!skillRef.value) details.textContent = skills.length ? '选择后记录内容指纹，运行时使用固定快照。' : '没有匹配的技能。'; else describe();
    };
    state.refreshDetail = () => { if (skillRef.value && this.skills?.connected) void choose(skillRef.value, !version.value); };
    search.addEventListener('input', event => { event.stopPropagation(); state.render(); }); select.addEventListener('change', () => void choose(select.value, true));
    state.render(); void this.loadSkills().then(() => { if (!wrapper.isConnected) return; state.render(); if (skillRef.value && this.skills?.connected) void choose(skillRef.value, !version.value); });
  }
  isSkillSelectionPending(nodeId) { return [...this.skillPending].some(ticket => ticket.apply && ticket.workflowId === this.editor.doc.id && (!nodeId || ticket.nodeId === nodeId) && this.skillSelectionRequests?.get(ticket.selectionKey) === ticket.generation); }
}
