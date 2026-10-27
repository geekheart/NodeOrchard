import { planWorkflow, learningBranch } from '../shared/workflow/workflow-plan.mjs';
import { parseWorkflowDataset, normalizeWorkflowDataset, summarizeRoundCases } from '../shared/workflow/workflow-dataset.mjs';
import { setToolbarControl } from './workflow-toolbar-controls.js';

const ACTIVE = new Set(['running', 'waiting']);
const TERMINAL = new Set(['complete', 'exhausted', 'interrupted', 'unknown', 'error']);
const STATUS = { running: '学习中', waiting: '等待人工处理', complete: '已达到目标', exhausted: '已结束 · 未达目标', interrupted: '已停止', unknown: '状态待确认', error: '学习失败', pending: '尚未执行', preparing: '准备中' };
const PHASE = { preparing: '准备固定快照', 'preparing-memory': '冻结学习记忆', freezing: '准备固定快照', baseline: '运行基线', executing: '执行样例', evaluating: '评估结果', evaluation: '评估结果', diagnosing: '诊断训练样例', optimizing: '调整 Skill', improving: '调整 Skill', judging: '评价结果', stopping: '等待停止确认', finished: '学习结束', complete: '学习结束' };
const own = (value, key) => value != null && Object.hasOwn(value, key);
const clean = value => String(value ?? '').replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[已隐藏密钥]').replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [已隐藏]').replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|authorization)["']?\s*[:=]\s*["']?)([^\s"',;}\]]+)/gi, '$1[已隐藏]');
function element(tag, className = '', content) { const item = document.createElement(tag); if (className) item.className = className; if (content !== undefined) item.textContent = clean(content); return item; }
function button(label, handler, className = 'wf-button') { const item = element('button', className, label); item.type = 'button'; item.addEventListener('click', handler); return item; }
function display(value) { if (typeof value === 'string') return clean(value); if (value === undefined) return '未记录'; return clean(JSON.stringify(value, null, 2)); }
function score(value) { return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value * 10) / 10} 分` : '尚未评分'; }
function time(value) { const parsed = new Date(value); return Number.isNaN(parsed.valueOf()) ? '时间未记录' : parsed.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }); }
const jobFrom = value => value?.learning || value?.job || value;
const roundName = value => value === 0 ? '基线' : `第 ${value} 次调整`;
const rawDisplay = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const percent = value => typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value * 1000) / 10}%` : null;
const feedbackJob = job => job?.kind === 'feedback';
const statusLabel = job => feedbackJob(job) ? job.status === 'complete' && job.reason === 'feedback-no-change' ? '未形成新候选' : ({ running: '反馈学习中', waiting: '等待人工处理', complete: '候选已生成 · 未验证', error: '反馈学习失败', interrupted: '已停止', unknown: '状态待确认' }[job.status] || '状态待确认') : STATUS[job?.status] || '状态待确认';
const feedbackPhaseLabel = job => job?.phase === 'preparing-memory' ? '准备只读记忆' : job?.phase === 'stopping' ? '等待停止确认' : job?.status === 'waiting' ? '等待人工处理' : '生成定向候选';

// Follow business edges only, so disconnected Skills cannot silently become
// improvement targets while the learning branch is still being constructed.
export function mainChainSkillNodes(document) {
  const nodes = (document?.nodes || []).filter(item => !['evaluation', 'improvement'].includes(item.type));
  const ids = new Set(nodes.map(item => item.id)), inputs = nodes.filter(item => item.type === 'input');
  if (document?.schemaVersion === 2) { const seen = new Set(), pending = inputs.map(node => node.id); while (pending.length) { const id = pending.shift(); if (seen.has(id)) continue; seen.add(id); for (const edge of document.edges || []) if (edge.sourceNode === id && ids.has(edge.targetNode)) pending.push(edge.targetNode); } return nodes.filter(node => node.type === 'skill' && seen.has(node.id)); }
  if (inputs.length !== 1) return [];
  const found = [], seen = new Set(); let current = inputs[0];
  while (current && !seen.has(current.id)) {
    seen.add(current.id); if (current.type === 'skill') found.push(current);
    if (current.type === 'output') return found;
    const edges = (document.edges || []).filter(edge => edge.sourceNode === current.id && ids.has(edge.targetNode));
    if (edges.length !== 1) return found;
    current = nodes.find(item => item.id === edges[0].targetNode);
  }
  return found;
}

export function learningSetupForDocument(document) {
  const branch = learningBranch(document);
  if (!branch) throw new Error('请在画布添加“产物对比”和“Skill 改进”，并连接：业务产物 → 产物对比 → Skill 改进。');
  const plan = planWorkflow({ ...document, mode: 'execute' });
  if (!plan.skillNodes.length) throw new Error('学习需要至少一个真实 Skill；工具与代码保持固定。');
  const ids = [...branch.improvementNode.config.targetSkillNodeIds];
  if (!ids.length) throw new Error('请在“Skill 改进”节点属性中明确勾选至少一个主链 Skill。');
  if (ids.some(id => !plan.skillNodes.some(item => item.id === id))) throw new Error('“Skill 改进”所选目标不属于当前业务主链，请重新选择。');
  return { plan, branch, ids, comparison: branch.evaluationNode.config.comparison };
}

export function learningSourceLabel(document) {
  try {
    const branch = learningBranch(document); if (!branch) return '';
    const source = document.nodes.find(item => item.id === branch.sourceNodeId);
    return `${source?.title || branch.sourceNodeId}${branch.evaluationNode.config.valuePath ? ` · ${branch.evaluationNode.config.valuePath}` : ' · 完整连线数据'}`;
  } catch { return ''; }
}

export function learningMemoryStatus(job) {
  const policy = job?.memoryPolicy;
  if (policy?.mode === 'batch-snapshot' && policy.memoryWriteAllowed === false && policy.externalMemoryAllowed === false) return { kind: 'fixed', label: '同批次固定只读记忆', description: '训练、验证、评价与改写共用本批次的内置记忆快照；不回写记忆，不动态检索外部记忆。' };
  if (policy?.mode === 'legacy' || job && !own(job, 'memoryPolicy') && !own(job, 'memoryScopeId')) return { kind: 'legacy', label: '旧批次未启用完整记忆隔离', description: '旧记录的 Skill 执行与控制会话未统一使用同一份只读记忆快照。' };
  if (policy?.mode === 'pending' && job?.phase === 'preparing-memory' && ACTIVE.has(job.status)) return { kind: 'pending', label: '冻结学习记忆中', description: '尚未确认固定只读记忆策略，等待后端完成冻结。' };
  return { kind: 'unconfirmed', label: '学习记忆策略尚未确认', description: '此记录尚无完整的固定只读记忆确认，不能视为已隔离。' };
}

export function learningDatasetForJob(job) {
  if (feedbackJob(job)) return { trainingCases: [], validationCases: [] };
  const config = job?.config || {}, legacy = !Array.isArray(config.trainingCases);
  const training = legacy ? own(job, 'input') && own(job, 'expected') ? [{ id: 'legacy-train-1', name: '训练样例 1', input: job.input, expected: job.expected }] : [] : config.trainingCases;
  return { trainingCases: training.map((item, index) => ({ ...item, id: item.id || `legacy-train-${index + 1}`, name: item.name || `训练样例 ${index + 1}` })), validationCases: (config.validationCases || []).map((item, index) => ({ ...item, id: item.id || `legacy-validation-${index + 1}`, name: item.name || `验证样例 ${index + 1}` })) };
}
export function learningExpectedCases(job) { const data = learningDatasetForJob(job); return [...data.trainingCases.map(item => ({ ...item, role: 'train' })), ...data.validationCases.map(item => ({ ...item, role: 'validation' }))]; }
export function learningRoundRows(job, round) {
  const expected = learningExpectedCases(job), actual = round?.cases || [];
  if (!expected.length) return actual;
  const legacy = !Array.isArray(job?.config?.trainingCases), byId = new Map(actual.filter(item => item.id || item.caseId).map(item => [item.id || item.caseId, item])), roleIndex = { train: 0, validation: 0 };
  return expected.map(item => { const index = roleIndex[item.role]++; const found = byId.get(item.id) || (legacy ? actual.filter(entry => (entry.role || 'train') === item.role)[index] : null); return found ? { ...item, ...found } : { ...item, status: 'pending', score: null }; });
}
export function learningRoundMetrics(job, round) {
  const expected = learningExpectedCases(job), legacy = !Array.isArray(job?.config?.trainingCases);
  return summarizeRoundCases(legacy ? learningRoundRows(job, round) : round?.cases || [], job?.config?.targetScore ?? 90, expected);
}
export function mergeLearningDatasets(current, incoming) {
  return normalizeWorkflowDataset({ trainingCases: [...(current?.trainingCases || []), ...(incoming?.trainingCases || [])], validationCases: [...(current?.validationCases || []), ...(incoming?.validationCases || [])] }, { requireTraining: false });
}

export function parseLearningExpected(raw, format = 'text') {
  if (format === 'text') return raw;
  if (format !== 'json') throw new Error('请选择已知答案的文本或 JSON 格式。');
  try { return JSON.parse(raw); } catch { throw new Error('已知答案需要有效 JSON；文本答案请选择文本格式。'); }
}
export function parseLearningValidation(raw) {
  if (!raw.trim()) return [];
  let cases; try { cases = JSON.parse(raw); } catch { throw new Error('验证样例需要有效 JSON 数组。'); }
  if (!Array.isArray(cases) || cases.length > 3 || cases.some(item => item === null || typeof item !== 'object' || Array.isArray(item) || !own(item, 'input') || !own(item, 'expected') || Object.keys(item).some(key => !['input', 'expected'].includes(key)))) throw new Error('最多提供 3 条验证样例，每条只含 input 和 expected。');
  return cases;
}
export function learningSnapshotChanged(before, after) {
  if (!before || !after) return true;
  const relevant = value => ({ id: value.id, title: value.title, schemaVersion: value.schemaVersion, settings: value.settings, nodes: (value.nodes || []).map(({ id, type, title, config, ports }) => ({ id, type, title, config, ports })), edges: value.edges || [] });
  return JSON.stringify(relevant(before)) !== JSON.stringify(relevant(after));
}
export function learningBestRound(job) {
  if (feedbackJob(job)) return null;
  const best = job?.rounds?.find(round => round.index === job.bestRound);
  if (best?.status !== 'complete' || typeof best.score !== 'number' || !Number.isFinite(best.score) || !best.cases?.length || !best.cases.every(item => typeof item.score === 'number' && Number.isFinite(item.score)) || !job.bestDocument) return null;
  const metrics = learningRoundMetrics(job, best); return metrics.overall.total > 0 && best.cases.length === metrics.overall.total && metrics.overall.pending === 0 && metrics.overall.evaluated === metrics.overall.total ? best : null;
}
export function learningCaseResult(run) {
  if (!run) return { confirmed: false, label: '实际结果', value: '选择样例后读取实际运行结果。' };
  if (run.status === 'complete') return { confirmed: true, label: '实际结果', value: own(run, 'output') ? display(run.output) : typeof run.outputText === 'string' ? clean(run.outputText) : '该记录未采集正式输出。' };
  return { confirmed: false, label: run.partialText ? '执行片段（未完成）' : '实际结果（未确认）', value: run.partialText ? clean(run.partialText) : run.error ? display(run.error) : '本次执行尚无已确认的正式输出。' };
}

export class WorkflowLearningUI {
  constructor(runtime) {
    this.runtime = runtime; this.editor = runtime.editor; this.api = runtime.api;
    this.jobs = new Map(); this.revisions = new Map(); this.revision = 0; this.jobId = null; this.workflowId = null;
    this.selectedRound = null; this.roundPinned = false; this.selectedCase = 0; this.roundElements = new Map(); this.trainableElements = new Map(); this.drafts = new Map(); this.caseLoads = new Map(); this.caseFailures = new Set();
    this.loading = false; this.starting = false; this.stopping = new Set(); this.stopRequested = new Set(); this.applying = false; this.uncertain = false; this.listRequest = 0; this.formDirty = false; this.renderTimer = null; this.active = false; this.inspectionRunId = null;
    this.dataset = { trainingCases: [], validationCases: [] }; this.caseDraftDirty = false; this.editingCaseId = null; this.pendingImport = null; this.importRevision = 0; this.datasetGroups = new Map(); this.metricCards = new Map(); this.caseRows = new Map();
    this.mount(); this.syncMode();
  }
  mount() {
    this.panel = element('section', 'wf-learning is-collapsed'); this.panel.setAttribute('aria-label', '工作流学习');
    const header = element('div', 'wf-learning-header');
    this.toggle = button('学习面板', () => { this.inspectionRunId = null; this.setExpanded(this.panel.classList.contains('is-collapsed')); this.syncMode(); }, 'wf-runtime-toggle'); this.toggle.setAttribute('aria-expanded', 'false');
    this.status = element('span', 'wf-runtime-status', '尚未开始'); this.summary = element('span', 'wf-runtime-summary');
    this.back = button('返回学习结果', () => this.returnFromInspection(), 'wf-button wf-runtime-small'); this.back.hidden = true;
    this.headerStop = button('停止学习', () => void this.interrupt(), 'wf-button wf-runtime-small'); this.headerStop.hidden = true; header.append(this.toggle, this.status, this.summary, this.back, this.headerStop);
    const body = element('div', 'wf-learning-body'); this.body = body;
    const recent = element('div', 'wf-runtime-recent'); recent.append(element('label', '', '学习记录')); this.recent = element('select'); this.recent.setAttribute('aria-label', '选择学习记录');
    this.recent.addEventListener('change', () => { this.jobId = this.recent.value || null; this.selectedRound = null; this.roundPinned = false; this.selectedCase = 0; this.inspectionRunId = null; this.showNotice(); this.render(); if (this.jobId) void this.loadJob(this.jobId); });
    this.refresh = button('刷新', () => void this.loadRecent(true), 'wf-button wf-runtime-small'); this.restoreButton = button('使用此记录样例与目标', () => { if (this.currentJob() && !this.starting) { this.restoreForm(this.currentJob()); this.formDirty = true; this.showNotice('已载入该记录的样例、评分目标和轮数；比较方式与改进范围仍由当前画布节点决定。'); } }, 'wf-button wf-runtime-small'); recent.append(this.recent, this.refresh, this.restoreButton);
    this.notice = element('p', 'wf-runtime-notice'); this.notice.hidden = true; this.notice.setAttribute('role', 'status');
    this.connection = element('div', 'wf-runtime-connection'); this.connection.append(element('span', '', 'Hermes 未连接'), button('连接 Hermes', () => void this.runtime.connectBackend(), 'wf-button wf-runtime-small'));
    const setup = element('details', 'wf-learning-setup'); setup.open = true; setup.append(element('summary', '', '学习样例与目标')); this.setup = setup;
    const form = element('div', 'wf-learning-form'); const examples = element('div', 'wf-learning-examples');
    this.input = this.field(examples, '样例输入', 'textarea', 'wf-learning-input'); this.input.placeholder = '按 Input 类型填写本次样例输入'; this.input.spellcheck = false;
    const expectedBox = element('div', 'wf-learning-field'); const expectedHeading = element('div', 'wf-learning-field-heading'); const expectedLabel = element('label', '', '已知答案'); expectedLabel.htmlFor = 'wf-learning-expected';
    this.expectedFormat = element('select'); this.expectedFormat.id = 'wf-learning-expected-format'; this.expectedFormat.setAttribute('aria-label', '已知答案格式'); for (const [value, label] of [['text', '文本'], ['json', 'JSON']]) { const option = element('option', '', label); option.value = value; this.expectedFormat.append(option); } this.expectedFormat.value = 'text';
    expectedHeading.append(expectedLabel, this.expectedFormat); this.expected = element('textarea'); this.expected.id = 'wf-learning-expected'; this.expected.setAttribute('aria-label', '已知答案'); this.expected.placeholder = '填写希望流程得到的最终答案'; this.expected.spellcheck = false; expectedBox.append(expectedHeading, this.expected); examples.append(expectedBox);
    this.caseEditor = element('details', 'wf-learning-case-editor'); this.caseEditor.open = true; this.caseEditor.append(element('summary', '', '逐条添加 / 编辑样例'));
    const caseMeta = element('div', 'wf-learning-controls'); this.caseName = this.field(caseMeta, '样例名称', 'input', 'wf-learning-case-name'); this.caseName.maxLength = 120; this.caseName.placeholder = '可选，便于识别';
    this.caseSplit = this.field(caseMeta, '所属集合', 'select', 'wf-learning-case-split'); for (const [value, label] of [['train', '训练集'], ['validation', '验证集']]) { const option = element('option', '', label); option.value = value; this.caseSplit.append(option); } this.caseSplit.value = 'train';
    this.inputFormat = this.field(caseMeta, '输入格式', 'select', 'wf-learning-input-format'); for (const [value, label] of [['text', '文本'], ['json', 'JSON']]) { const option = element('option', '', label); option.value = value; this.inputFormat.append(option); } this.inputFormat.value = 'text';
    const caseActions = element('div', 'wf-learning-actions'); this.saveCaseButton = button('加入样例集', () => this.saveCaseDraft(), 'wf-button'); this.cancelCaseButton = button('清空编辑', () => this.resetCaseEditor(), 'wf-button wf-runtime-small'); this.caseEditStatus = element('span', 'wf-runtime-hint'); caseActions.append(this.saveCaseButton, this.cancelCaseButton, this.caseEditStatus); this.caseEditor.append(caseMeta, examples, caseActions);
    const datasets = this.mountDatasetControls(); const importer = this.mountImporter();
    const controls = element('div', 'wf-learning-controls');
    this.targetScore = this.field(controls, '目标评分（1–100）', 'input', 'wf-learning-score'); this.targetScore.type = 'number'; this.targetScore.min = '1'; this.targetScore.max = '100'; this.targetScore.step = '1'; this.targetScore.value = '90';
    this.maxRounds = this.field(controls, '最多总轮数（含基线）', 'input', 'wf-learning-rounds'); this.maxRounds.type = 'number'; this.maxRounds.min = '1'; this.maxRounds.max = '10'; this.maxRounds.value = '3';
    this.rubric = this.field(form, '评价标准', 'textarea', 'wf-learning-rubric'); this.rubric.placeholder = '说明内容、格式与必须满足的条件，供 AI 评价和 Skill 调整使用'; this.rubric.rows = 2;
    const trainable = element('fieldset', 'wf-learning-trainable'); trainable.append(element('legend', '', '画布指定的学习支路')); this.branchStatus = element('p', 'wf-runtime-hint'); this.branchStatus.setAttribute('role', 'status'); this.trainableList = element('div', 'wf-learning-skill-list'); trainable.append(this.branchStatus, this.trainableList, element('p', 'wf-runtime-hint', '在“产物对比”节点配置比较方式与字段，在“Skill 改进”节点明确勾选主链 Skill。只调整所选 Skill 正文，工具、代码和输入数据保持固定。'));
    this.comparisonHint = element('p', 'wf-runtime-hint');
    const actions = element('div', 'wf-learning-actions'); this.startButton = button('开始学习', () => void this.start(), 'wf-button primary'); actions.append(this.startButton);
    form.append(datasets, this.caseEditor, importer, controls, this.rubric.parentElement, trainable, this.comparisonHint, element('p', 'wf-runtime-hint', '学习会重跑完整流程；停止不能撤销已发生的操作。'), actions); setup.append(form);
    this.modelTask = element('div', 'wf-runtime-approval'); this.modelTask.hidden = true;
    const results = element('section', 'wf-learning-results'); this.results = results; const resultsHead = element('div', 'wf-runtime-section-heading'); resultsHead.append(element('strong', '', '学习结果')); this.best = element('span', 'wf-learning-best'); this.apply = button('应用最佳候选到草稿', () => void this.applyBest(), 'wf-button'); resultsHead.append(this.best, this.apply);
    this.jobInfo = element('p', 'wf-runtime-hint'); this.error = element('p', 'wf-runtime-error');
    this.memoryRecord = element('details', 'wf-learning-memory-record'); this.memoryRecord.setAttribute('aria-label', '本次学习记忆策略'); this.memoryLabel = element('summary'); this.memoryDetails = element('p'); this.memoryRecord.append(this.memoryLabel, this.memoryDetails); this.memoryRecord.hidden = true;
    this.draftNotice = element('p', 'wf-runtime-draft-notice', '草稿已变化。以下结果对应学习开始时的固定快照；请恢复对应流程后再应用候选。'); this.draftNotice.hidden = true;
    const layout = element('div', 'wf-learning-results-layout'); this.resultsLayout = layout; this.rounds = element('ol', 'wf-learning-rounds'); this.rounds.setAttribute('aria-label', '学习轮次');
    const roundDetail = element('section', 'wf-learning-round-detail'); const roundHeading = element('div', 'wf-runtime-section-heading'); this.roundTitle = element('strong'); this.roundScore = element('span'); roundHeading.append(this.roundTitle, this.roundScore);
    this.feedback = element('p', 'wf-learning-feedback'); this.metrics = element('div', 'wf-learning-metrics'); for (const [key, label] of [['overall', '全部样例'], ['train', '训练集'], ['validation', '验证集']]) { const card = element('section', 'wf-learning-metric'), value = element('strong'), detail = element('p'); card.append(element('h4', '', label), value, detail); this.metrics.append(card); this.metricCards.set(key, { card, value, detail }); }
    this.caseTableWrap = element('div', 'wf-learning-table-scroll'); const caseTable = element('table', 'wf-learning-case-table'), caseHead = element('thead'), caseHeader = element('tr'); for (const title of ['样例 / 集合', '状态', '得分', '结果', '数据']) caseHeader.append(element('th', '', title)); caseHead.append(caseHeader); this.caseTableBody = element('tbody'); caseTable.append(caseHead, this.caseTableBody); this.caseTableWrap.append(caseTable);
    const caseRow = element('div', 'wf-learning-case-row'); this.cases = element('select'); this.cases.setAttribute('aria-label', '选择本轮样例'); this.cases.addEventListener('change', () => { this.selectedCase = Number(this.cases.value); this.roundPinned = true; this.renderSelectedRound(); }); this.inspect = button('查看节点执行详情', () => void this.inspectCase(), 'wf-button wf-runtime-small'); caseRow.append(this.cases, this.inspect);
    this.caseScore = element('p', 'wf-runtime-hint'); const io = element('div', 'wf-learning-case-io');
    const actualBox = element('section'); this.actualLabel = element('h4', '', '实际结果'); this.actual = element('pre'); this.actual.tabIndex = 0; actualBox.append(this.actualLabel, this.actual);
    const knownBox = element('section'); knownBox.append(element('h4', '', '本次已知答案')); this.known = element('pre'); this.known.tabIndex = 0; knownBox.append(this.known); io.append(actualBox, knownBox);
    const sample = element('details', 'wf-learning-sample'); sample.append(element('summary', '', '查看本次样例输入')); this.sampleInput = element('pre'); sample.append(this.sampleInput);
    this.changes = element('div', 'wf-learning-changes'); roundDetail.append(roundHeading, this.feedback, this.metrics, this.caseTableWrap, caseRow, this.caseScore, io, sample, this.changes); layout.append(this.rounds, roundDetail);
    this.feedbackResults = element('section', 'wf-learning-feedback-results'); this.feedbackResults.hidden = true; this.feedbackResults.setAttribute('aria-label', '基于综合反馈的 Skill 候选');
    this.feedbackCandidateNotice = element('p', 'wf-learning-feedback-candidate-notice'); this.feedbackCandidateNotice.setAttribute('role', 'status');
    this.feedbackComment = element('div', 'wf-learning-feedback-comment'); this.feedbackChanges = element('div', 'wf-learning-changes'); this.feedbackResults.append(this.feedbackCandidateNotice, this.feedbackComment, this.feedbackChanges);
    results.append(resultsHead, this.jobInfo, this.memoryRecord, this.error, this.draftNotice, this.feedbackResults, layout); body.append(recent, this.notice, this.connection, this.modelTask, results, setup); this.panel.append(header, body);
    this.editor.root.querySelector('.wf-center').append(this.panel);
    this.formControls = [this.input, this.inputFormat, this.expected, this.expectedFormat, this.caseName, this.caseSplit, this.targetScore, this.maxRounds, this.rubric, this.importText, this.importFormat];
    for (const control of this.formControls) control.addEventListener('input', () => { this.formDirty = true; this.renderComparisonHint(); this.renderDatasetSummary(); });
    for (const control of [this.input, this.inputFormat, this.expected, this.expectedFormat, this.caseName, this.caseSplit]) control.addEventListener('input', () => { this.caseDraftDirty = true; this.renderCaseEditStatus(); });
    this.renderComparisonHint();
  }
  field(parent, label, tag, id) { const wrapper = element('div', 'wf-learning-field'), caption = element('label', '', label); caption.htmlFor = id; const control = element(tag); control.id = id; control.setAttribute('aria-label', label); wrapper.append(caption, control); parent.append(wrapper); return control; }
  mountDatasetControls() {
    const section = element('section', 'wf-learning-dataset'); const heading = element('div', 'wf-runtime-section-heading'); heading.append(element('strong', '', '训练与验证样例')); this.datasetSummary = element('span', 'wf-runtime-hint'); heading.append(this.datasetSummary);
    this.datasetHint = element('p', 'wf-runtime-hint'); this.executionEstimate = element('p', 'wf-runtime-hint'); const groups = element('div', 'wf-learning-dataset-groups');
    for (const [key, label] of [['trainingCases', '训练集'], ['validationCases', '验证集']]) { const group = element('section', 'wf-learning-dataset-group'), title = element('h4', '', label), wrap = element('div', 'wf-learning-table-scroll'), table = element('table', 'wf-learning-dataset-table'), head = element('thead'), row = element('tr'); for (const text of ['名称', '输入 → 已知答案', '操作']) row.append(element('th', '', text)); head.append(row); const body = element('tbody'); table.append(head, body); wrap.append(table); group.append(title, wrap); groups.append(group); this.datasetGroups.set(key, { title, body }); }
    section.append(heading, this.datasetHint, this.executionEstimate, groups); return section;
  }
  mountImporter() {
    const details = element('details', 'wf-learning-import'); details.append(element('summary', '', '批量导入 JSON / JSONL / CSV')); this.importDetails = details;
    const controls = element('div', 'wf-learning-import-controls'); this.importFormat = this.field(controls, '导入格式', 'select', 'wf-learning-import-format'); for (const [value, label] of [['json', 'JSON'], ['jsonl', 'JSONL'], ['csv', 'CSV']]) { const option = element('option', '', label); option.value = value; this.importFormat.append(option); } this.importFormat.value = 'json';
    this.importFile = this.field(controls, '选择本地文件', 'input', 'wf-learning-import-file'); this.importFile.type = 'file'; this.importFile.accept = '.json,.jsonl,.ndjson,.csv,application/json,text/csv,text/plain';
    this.importFile.addEventListener('change', () => void this.readImportFile(this.importFile.files?.[0]));
    this.importText = this.field(details, '或粘贴数据', 'textarea', 'wf-learning-import-text'); this.importText.placeholder = '{"trainingCases":[{"name":"样例名称","input":"输入","expected":"答案"}],"validationCases":[]}'; this.importText.spellcheck = false;
    const actions = element('div', 'wf-learning-actions'); this.previewImportButton = button('解析并预览', () => this.previewImport(), 'wf-button'); actions.append(this.previewImportButton, button('下载 JSON 模板', () => this.downloadDatasetTemplate(), 'wf-button wf-runtime-small'));
    this.importMessage = element('p', 'wf-runtime-hint'); this.importMessage.setAttribute('role', 'status'); this.importPreview = element('div', 'wf-learning-import-preview'); this.importPreview.hidden = true; this.importPreviewInfo = element('p'); this.importPreviewRows = element('ul'); const confirmation = element('div', 'wf-learning-actions'); this.addImportButton = button('确认添加到现有样例集', () => this.applyImport('add'), 'wf-button'); this.replaceImportButton = button('确认替换现有样例集', () => this.applyImport('replace'), 'wf-button'); confirmation.append(this.addImportButton, this.replaceImportButton); this.importPreview.append(this.importPreviewInfo, this.importPreviewRows, confirmation);
    details.append(controls, this.importText.parentElement, element('p', 'wf-runtime-hint', 'JSON 可用 trainingCases / validationCases 对象或 split=train|validation 的数组；JSONL 每行一个 split 样例。CSV 需 input、expected 表头，可用 split、id、name、input_format、expected_format；CSV 默认文本，只有显式 json 格式才解析 JSON。'), actions, this.importMessage, this.importPreview);
    for (const control of [this.importText, this.importFormat]) for (const event of ['input', 'change']) control.addEventListener(event, () => { this.importRevision++; this.pendingImport = null; this.renderImportPreview(); });
    return details;
  }
  renderDatasetSummary() {
    const data = this.dataset || { trainingCases: [], validationCases: [] }, train = data.trainingCases.length, validation = data.validationCases.length, total = train + validation;
    if (this.datasetSummary) this.datasetSummary.textContent = `训练 ${train} · 验证 ${validation} · 合计 ${total}/20`;
    if (this.datasetHint) this.datasetHint.textContent = !train ? '请至少添加一条训练样例。' : !validation ? '尚无验证集：本次只能衡量训练样例，未验证泛化效果。' : '';
    const rounds = Number(this.maxRounds?.value); if (this.executionEstimate) this.executionEstimate.textContent = `每轮完整工作流执行 ${total} 次${Number.isInteger(rounds) && rounds >= 1 && rounds <= 10 ? ` · 最多 ${rounds * total} 次（${rounds} 轮，含基线）` : ''}。评估与 Skill 调整还会调用模型，此处不统计模型调用次数。`;
  }
  renderDataset() {
    this.renderDatasetSummary();
    for (const [key, group] of this.datasetGroups || []) { const cases = this.dataset?.[key] || []; group.title.textContent = `${key === 'trainingCases' ? '训练集' : '验证集'} · ${cases.length}`; group.body.replaceChildren();
      if (!cases.length) { const row = element('tr'), cell = element('td', 'wf-runtime-hint', key === 'trainingCases' ? '暂无训练样例' : '暂无验证样例 · 未验证'); cell.colSpan = 3; row.append(cell); group.body.append(row); }
      for (const item of cases) { const row = element('tr'), name = element('td'), preview = element('td'), actions = element('td', 'wf-learning-row-actions'); name.append(element('strong', '', item.name), element('small', '', item.id)); preview.append(element('span', '', display(item.input).slice(0, 100)), element('span', 'wf-runtime-hint', `→ ${display(item.expected).slice(0, 100)}`)); actions.append(button('编辑', () => this.editCase(item.id), 'wf-button wf-runtime-small'), button(key === 'trainingCases' ? '移到验证' : '移到训练', () => this.moveCase(item.id), 'wf-button wf-runtime-small'), button('删除', () => this.deleteCase(item.id), 'wf-button wf-runtime-small')); row.append(name, preview, actions); group.body.append(row); }
    }
  }
  setDataset(dataset) { const next = normalizeWorkflowDataset(dataset, { requireTraining: false }); this.dataset = next; this.formDirty = true; this.renderDataset(); return next; }
  renderCaseEditStatus() { if (this.caseEditStatus) this.caseEditStatus.textContent = this.caseDraftDirty ? '编辑尚未保存到样例集' : this.editingCaseId ? `正在编辑 ${this.editingCaseId}` : ''; if (this.caseEditStatus) this.caseEditStatus.hidden = !this.caseEditStatus.textContent; if (this.saveCaseButton) this.saveCaseButton.textContent = this.editingCaseId ? '保存样例修改' : '加入样例集'; }
  resetCaseEditor() { if (this.starting) return; this.editingCaseId = null; this.input.value = ''; this.expected.value = ''; this.caseName.value = ''; this.caseSplit.value = 'train'; this.expectedFormat.value = 'text'; const type = this.editor.doc?.nodes?.find(item => item.type === 'input')?.config?.outputType; this.inputFormat.value = type && !['text', 'any', 'fileRef'].includes(type) ? 'json' : 'text'; this.caseDraftDirty = false; this.renderCaseEditStatus(); }
  saveCaseDraft() {
    if (this.starting) return;
    try {
      let input; try { input = this.inputFormat.value === 'json' ? JSON.parse(this.input.value) : this.input.value; } catch { throw new Error('样例输入需要有效 JSON，或将输入格式改为文本。'); }
      const current = this.dataset || { trainingCases: [], validationCases: [] }, id = this.editingCaseId || `case-${crypto.randomUUID()}`, split = this.caseSplit.value === 'validation' ? 'validationCases' : 'trainingCases'; const next = { trainingCases: current.trainingCases.filter(item => item.id !== id), validationCases: current.validationCases.filter(item => item.id !== id) };
      const item = { id, name: this.caseName.value.trim() || `${split === 'trainingCases' ? '训练' : '验证'}样例 ${next[split].length + 1}`, input, expected: parseLearningExpected(this.expected.value, this.expectedFormat.value) };
      const originalIndex = current[split].findIndex(entry => entry.id === id); if (originalIndex >= 0) next[split].splice(originalIndex, 0, item); else next[split].push(item);
      this.setDataset(next); this.resetCaseEditor(); this.showNotice('样例已保存到学习数据集。');
    } catch (error) { this.showNotice(`样例未保存：${error.message}`, true); }
  }
  editCase(id) { if (this.starting) return; if (this.caseDraftDirty) { this.showNotice('请先保存或清空正在编辑的样例，再编辑另一条。', true); return; } const data = this.dataset, split = data.trainingCases.some(item => item.id === id) ? 'trainingCases' : 'validationCases', item = data[split].find(item => item.id === id); if (!item) return;
    this.editingCaseId = id; this.caseName.value = item.name; this.caseSplit.value = split === 'trainingCases' ? 'train' : 'validation'; this.inputFormat.value = typeof item.input === 'string' ? 'text' : 'json'; this.input.value = rawDisplay(item.input); this.expectedFormat.value = typeof item.expected === 'string' ? 'text' : 'json'; this.expected.value = rawDisplay(item.expected); this.caseDraftDirty = false; this.caseEditor.open = true; this.renderCaseEditStatus(); this.input.focus?.(); }
  moveCase(id) { if (this.starting) return; try { const data = this.dataset, from = data.trainingCases.some(item => item.id === id) ? 'trainingCases' : 'validationCases', to = from === 'trainingCases' ? 'validationCases' : 'trainingCases', item = data[from].find(item => item.id === id); if (!item) return; const next = { trainingCases: [...data.trainingCases], validationCases: [...data.validationCases] }; next[from] = next[from].filter(item => item.id !== id); next[to].push(item); this.setDataset(next); if (this.editingCaseId === id) this.caseSplit.value = to === 'trainingCases' ? 'train' : 'validation'; } catch (error) { this.showNotice(error.message, true); } }
  deleteCase(id) { if (this.starting) return; try { this.setDataset({ trainingCases: this.dataset.trainingCases.filter(item => item.id !== id), validationCases: this.dataset.validationCases.filter(item => item.id !== id) }); if (this.editingCaseId === id) this.resetCaseEditor(); } catch (error) { this.showNotice(error.message, true); } }
  async readImportFile(file) {
    if (!file || this.starting) return; const revision = ++this.importRevision, workflowId = this.workflowId; this.pendingImport = null; this.renderImportPreview();
    try { if (file.size > 1024 * 1024) throw new Error('导入文件不能超过 1 MiB。'); const content = await file.text(); if (revision !== this.importRevision || workflowId !== this.workflowId) return; const extension = file.name.split('.').at(-1)?.toLowerCase(); if (['json', 'csv', 'jsonl', 'ndjson'].includes(extension)) this.importFormat.value = extension === 'ndjson' ? 'jsonl' : extension; this.importText.value = content; this.formDirty = true; this.previewImport(); }
    catch (error) { if (revision === this.importRevision) { this.importMessage.textContent = clean(`文件未导入：${error.message}`); this.importMessage.classList.toggle('error', true); } }
  }
  previewImport() {
    if (this.starting) return; this.importRevision++; this.pendingImport = null;
    try { const dataset = parseWorkflowDataset(this.importText.value, this.importFormat.value, { requireTraining: false }); if (!dataset.trainingCases.length && !dataset.validationCases.length) throw new Error('导入内容没有样例。'); this.pendingImport = { dataset, text: this.importText.value, format: this.importFormat.value }; this.importMessage.textContent = '解析成功。请核对预览，再选择添加或替换；尚未修改现有样例。'; this.importMessage.classList.toggle('error', false); }
    catch (error) { this.importMessage.textContent = clean(`解析失败：${error.message}，现有样例保持不变。`); this.importMessage.classList.toggle('error', true); }
    this.renderImportPreview();
  }
  renderImportPreview() { const pending = this.pendingImport; this.importPreview.hidden = !pending; this.addImportButton.disabled = this.replaceImportButton.disabled = !pending || this.starting; if (!pending) return; const data = pending.dataset; this.importPreviewInfo.textContent = `预览：训练 ${data.trainingCases.length} 条 · 验证 ${data.validationCases.length} 条 · 合计 ${data.trainingCases.length + data.validationCases.length} 条`; this.importPreviewRows.replaceChildren(); for (const [key, label] of [['trainingCases', '训练'], ['validationCases', '验证']]) for (const item of data[key]) this.importPreviewRows.append(element('li', '', `${label} · ${item.name} (${item.id}) · ${display(item.input).slice(0, 100)} → ${display(item.expected).slice(0, 100)}`)); }
  applyImport(mode) {
    if (this.starting) return; const pending = this.pendingImport; if (!pending || pending.text !== this.importText.value || pending.format !== this.importFormat.value) { this.pendingImport = null; this.renderImportPreview(); this.importMessage.textContent = '导入内容已变化，请重新解析并预览。'; return; }
    try { const next = mode === 'add' ? mergeLearningDatasets(this.dataset, pending.dataset) : normalizeWorkflowDataset(pending.dataset, { requireTraining: false }); this.setDataset(next); this.resetCaseEditor(); this.pendingImport = null; this.renderImportPreview(); this.importMessage.textContent = `已${mode === 'add' ? '添加' : '替换'}学习样例。`; this.importMessage.classList.toggle('error', false); }
    catch (error) { this.importMessage.textContent = clean(`未修改样例：${error.message}。若 ID 重复，请先修改导入数据中的 ID，或确认替换。`); this.importMessage.classList.toggle('error', true); }
  }
  downloadDatasetTemplate() { const template = { trainingCases: [{ id: 'train-1', name: '训练示例（请替换）', input: '训练输入（请替换）', expected: '训练答案（请替换）' }], validationCases: [{ id: 'validation-1', name: '验证示例（请替换）', input: '独立验证输入（请替换）', expected: '验证答案（请替换）' }] }; const url = URL.createObjectURL(new Blob([JSON.stringify(template, null, 2)], { type: 'application/json;charset=utf-8' })), link = element('a'); link.href = url; link.download = 'workflow-learning-template.json'; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  currentJob() { return this.jobs.get(this.jobId) || null; }
  workflowJobs() { return [...this.jobs.values()].filter(job => job.workflowId === this.editor.doc?.id).sort((a, b) => String(b.startedAt || b.times?.startedAt || '').localeCompare(String(a.startedAt || a.times?.startedAt || ''))); }
  activeJob() { return this.workflowJobs().find(job => ACTIVE.has(job.status)); }
  setExpanded(expanded = true) { this.panel.classList.toggle('is-collapsed', !expanded); this.toggle.setAttribute('aria-expanded', String(expanded)); }
  returnFromInspection({ restoreFocus = true } = {}) {
    this.inspectionRunId = null; this.setExpanded(); this.syncMode();
    if (restoreFocus) (this.inspect?.disabled ? this.toggle : this.inspect)?.focus?.();
  }
  showNotice(value = '', error = false) { this.notice.textContent = clean(value); this.notice.hidden = !value; this.notice.classList.toggle('error', error); }
  isInspecting() { return this.editor.doc?.mode === 'learn' && Boolean(this.inspectionRunId); }
  syncMode() {
    if (this.editor.documentLoaded === false) { this.unloadDocument(); return; }
    if (this.editor.nodeLibrary?.nested) { this.panel.hidden = true; this.runtime.panel.hidden = true; return; }
    const learning = this.editor.doc?.mode === 'learn'; this.panel.hidden = !learning; this.runtime.panel.hidden = learning && !this.inspectionRunId;
    this.runtime.panel.classList.toggle('wf-learning-inspection', learning && Boolean(this.inspectionRunId)); this.panel.classList.toggle('is-inspecting', learning && Boolean(this.inspectionRunId)); this.back.hidden = !this.inspectionRunId;
    if (this.workflowId !== this.editor.doc?.id) this.syncWorkflow();
    this.renderTrainable(); this.renderComparisonHint();
    if (learning) { this.updateRunButton(); if (!this.loaded && this.active) void this.loadRecent(); }
  }
  saveForm() { return Object.fromEntries(this.formControls.map(control => [control.id, control.value]).concat([['dataset', structuredClone(this.dataset)], ['editingCaseId', this.editingCaseId], ['caseDraftDirty', this.caseDraftDirty]])); }
  syncWorkflow() {
    if (this.editor.documentLoaded === false) { this.unloadDocument(); return; }
    if (this.editor.nodeLibrary?.nested) return;
    if (this.workflowId) this.drafts.set(this.workflowId, this.saveForm());
    this.workflowId = this.editor.doc?.id; this.jobId = null; this.selectedRound = null; this.selectedCase = 0; this.roundPinned = false; this.inspectionRunId = null; this.loaded = false; this.loading = false; this.listRequest++; this.uncertain = false; this.formDirty = false; this.trainableSignature = null; this.trainableElements.clear(); this.trainableList.replaceChildren();
    const saved = this.drafts.get(this.workflowId); for (const control of this.formControls) control.value = saved?.[control.id] ?? ({ 'wf-learning-score': '90', 'wf-learning-rounds': '3', 'wf-learning-expected-format': 'text', 'wf-learning-input-format': 'text', 'wf-learning-case-split': 'train', 'wf-learning-import-format': 'json' }[control.id] || '');
    this.dataset = structuredClone(saved?.dataset || { trainingCases: [], validationCases: [] }); this.editingCaseId = saved?.editingCaseId || null; this.caseDraftDirty = saved?.caseDraftDirty || false; this.pendingImport = null; this.importRevision++;
    this.expectedFormat.value = saved?.[this.expectedFormat.id] || 'text'; this.showNotice(); this.renderTrainable(); this.renderDataset(); this.renderCaseEditStatus(); this.renderImportPreview(); this.render();
  }
  activate() { if (this.editor.documentLoaded === false) { this.unloadDocument(); return; } this.active = true; this.syncMode(); void this.loadRecent(); }
  deactivate() { this.active = false; }
  unloadDocument() {
    if (this.workflowId) this.drafts.set(this.workflowId, this.saveForm());
    this.deactivate(); clearTimeout(this.renderTimer); this.renderTimer = null;
    this.workflowId = null; this.jobId = null; this.selectedRound = null; this.selectedCase = 0; this.roundPinned = false; this.inspectionRunId = null;
    this.listRequest++; this.loaded = false; this.loading = false; this.panel.hidden = true; this.runtime.panel.hidden = true;
  }
  refreshBackend() { this.connection.hidden = this.runtime.getBackend()?.state === 'ready'; for (const control of this.connection.querySelectorAll('button')) control.disabled = this.runtime.connecting || this.runtime.getBackend()?.state === 'starting'; this.renderTask(); this.syncMode(); }
  updateRunButton() {
    let setupError = ''; try { learningSetupForDocument(this.editor.doc); } catch (error) { setupError = error.message; }
    if (this.editor.libraryLifecycle && this.editor.libraryLifecycle !== 'active') setupError = '此工作流只读，请先在看板恢复后再学习。';
    if (!setupError && this.editor.propertyDrafts?.size) setupError = '请先应用节点属性，再开始学习。';
    const active = this.activeJob(), blocked = this.starting || this.loading || this.applying || this.uncertain || Boolean(active) || this.runtime.skillPending?.size > 0 || Boolean(setupError);
    const label = this.starting ? '正在提交学习…' : this.loading ? '正在同步学习记录…' : this.uncertain ? '请先刷新学习记录' : active ? `${feedbackJob(active) ? feedbackPhaseLabel(active) : PHASE[active.phase] || STATUS[active.status]}…` : '开始学习';
    for (const control of [this.startButton, this.editor.doc?.mode === 'learn' ? this.editor.root.querySelector('[data-action="run"]') : null].filter(Boolean)) {
      if (control === this.startButton) { control.textContent = clean(label); control.setAttribute('aria-label', clean(label)); control.title = setupError || '使用画布学习支路评估产物，并改进明确选择的 Skill'; }
      else {
        const toolbarLabel = label === '开始学习' ? label : `开始学习 · ${clean(label)}`;
        setToolbarControl(control, { label: setupError ? `${toolbarLabel} · ${clean(setupError)}` : toolbarLabel, icon: 'play', busy: Boolean(this.starting || this.loading || this.applying || active) });
      }
      control.disabled = blocked;
    }
    this.headerStop.hidden = !active; this.headerStop.disabled = this.stopping.has(active?.id) || this.stopRequested.has(active?.id); this.headerStop.textContent = this.headerStop.disabled ? '等待停止确认…' : '停止学习';
    for (const control of this.formControls) control.disabled = this.starting;
    for (const control of [this.saveCaseButton, this.cancelCaseButton, this.previewImportButton, this.importFile, this.restoreButton].filter(Boolean)) control.disabled = this.starting;
    if (this.addImportButton) this.addImportButton.disabled = this.replaceImportButton.disabled = !this.pendingImport || this.starting;
    if (this.editor.doc?.mode === 'learn') { this.runtime.startButton.hidden = true; this.runtime.stopButton.hidden = true; }
  }
  renderComparisonHint() {
    let branch; try { branch = learningBranch(this.editor.doc); } catch (error) { this.comparisonHint.textContent = error.message; return; }
    if (!branch) { this.comparisonHint.textContent = '缺少产物对比或 Skill 改进节点'; return; }
    const description = branch.evaluationNode.config.comparison === 'model' ? '逐例 AI 评价，评分是模型估计。' : '精确对比：文本统一换行并忽略首尾空白；JSON 忽略对象键顺序。';
    this.comparisonHint.textContent = `对比产物：${learningSourceLabel(this.editor.doc)} · ${description}`;
  }
  renderTrainable() {
    let setup, error = ''; try { setup = learningSetupForDocument(this.editor.doc); } catch (cause) { error = cause.message; }
    let branch; try { branch = learningBranch(this.editor.doc); } catch { /* Display the setup error below. */ }
    const ids = branch?.improvementNode.config.targetSkillNodeIds || [], skills = mainChainSkillNodes(this.editor.doc).filter(item => ids.includes(item.id));
    if (this.branchStatus) this.branchStatus.textContent = error || `对比：${learningSourceLabel(this.editor.doc)}；仅改进以下 ${setup.ids.length} 个 Skill。`;
    const signature = JSON.stringify([error, skills.map(item => [item.id, item.title, item.config.skillRef, item.config.version])]); if (signature === this.trainableSignature) return;
    this.trainableSignature = signature;
    this.trainableList.replaceChildren(); this.trainableElements.clear();
    for (const skill of skills) { const label = element('div', 'wf-learning-skill'), caption = element('span'); caption.append(element('strong', '', skill.title), element('small', '', skill.config.skillRef || '尚未选择真实 Skill')); label.append(caption); this.trainableList.append(label); this.trainableElements.set(skill.id, { label }); }
    if (!skills.length) this.trainableList.append(element('p', 'wf-runtime-hint', '没有默认改进目标。请到“Skill 改进”节点属性中明确勾选主链 Skill。'));
  }
  async start() {
    if (this.editor.nodeLibrary?.nested) { this.showNotice('请先应用或取消子流程内部编辑，再从主流程开始学习。', true); return; }
    if (this.editor.libraryLifecycle && this.editor.libraryLifecycle !== 'active') { this.showNotice('此工作流只读，请先在看板恢复后再学习。', true); return; }
    this.inspectionRunId = null; this.setExpanded(); this.syncMode();
    if (this.starting || this.loading || this.activeJob() || this.applying || this.uncertain) return;
    this.starting = true; this.updateRunButton(); let body;
    try {
      const document = await this.editor.prepareRun(); if (document.mode !== 'learn') throw new Error('请先切换到学习模式。');
      const { plan, ids, comparison } = learningSetupForDocument(document);
      if (this.runtime.getBackend()?.state !== 'ready') throw new Error('请先连接 Hermes，再开始学习。');
      if (this.runtime.activeRun()) throw new Error('此流程仍有执行中的运行，请结束后再开始学习。');
      const maxRounds = Number(this.maxRounds.value), targetScore = Number(this.targetScore.value); if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 10) throw new Error('最多总轮数需要为 1–10 的整数（含基线）。'); if (!Number.isInteger(targetScore) || targetScore < 1 || targetScore > 100 || !this.targetScore.value.trim()) throw new Error('目标评分需要为 1–100 的整数。');
      if (this.caseDraftDirty) throw new Error('样例编辑尚未保存到数据集，请先保存样例或清空编辑。');
      const dataset = normalizeWorkflowDataset(this.dataset);
      for (const sample of [...dataset.trainingCases, ...dataset.validationCases]) { const value = sample.input, type = plan.inputNode.config.outputType, missing = value == null || typeof value === 'string' && !value.trim(); if (plan.inputNode.config.required && missing) throw new Error(`样例「${sample.name}」需要非空输入。`); const matches = type === 'any' || type === 'text' && typeof value === 'string' || type === 'number' && typeof value === 'number' && Number.isFinite(value) || type === 'boolean' && typeof value === 'boolean' || type === 'array' && Array.isArray(value) || type === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value); if (!matches && !(value == null && !plan.inputNode.config.required)) throw new Error(`样例「${sample.name}」输入与 Input 的 ${type} 类型不符，请编辑样例格式。`); }
      body = { document, trainingCases: dataset.trainingCases, validationCases: dataset.validationCases, comparison, rubric: this.rubric.value, targetScore, maxRounds, trainableNodeIds: ids };
    } catch (error) { this.starting = false; this.updateRunButton(); this.showNotice(error.message, true); return; }
    const revision = this.revision; this.showNotice('正在提交学习快照…');
    try {
      const job = jobFrom(await this.api('/api/workflow-learning', { method: 'POST', body })); if (!job?.id) throw new Error('服务未返回学习标识。');
      if ((this.revisions.get(job.id) || 0) <= revision) this.storeJob(job);
      if (job.workflowId === this.editor.doc?.id) { this.jobId = job.id; this.selectedRound = null; this.roundPinned = false; this.selectedCase = 0; }
      this.showNotice(); this.render();
    } catch (error) { this.uncertain = true; this.showNotice(`提交未确认：${error.message}。不会自动重试，请先刷新学习记录。`, true); }
    finally { this.starting = false; this.updateRunButton(); }
  }
  storeJob(job) { if (!job?.id || !job.workflowId) return; const previous = this.jobs.get(job.id); if (TERMINAL.has(previous?.status) && previous.status !== job.status) return; this.jobs.set(job.id, job); this.revisions.set(job.id, ++this.revision); if (!ACTIVE.has(job.status)) this.stopRequested.delete(job.id); }
  async loadRecent(force = false) {
    if (this.editor.documentLoaded === false) return;
    const id = this.editor.doc?.id; if (!id || this.loading && !force) return; if (force) this.caseFailures.clear(); const request = ++this.listRequest, revision = this.revision; this.loading = true; this.updateRunButton();
    try { const data = await this.api(`/api/workflow-learning?workflowId=${encodeURIComponent(id)}`); if (request !== this.listRequest || id !== this.editor.doc?.id) return;
      for (const job of data.learnings || []) if ((this.revisions.get(job.id) || 0) <= revision) this.storeJob(job);
      const jobs = this.workflowJobs(); if (!this.jobId || !jobs.some(job => job.id === this.jobId)) this.jobId = jobs.find(job => ACTIVE.has(job.status))?.id || jobs[0]?.id || null;
      if (!this.loaded && !this.formDirty && this.currentJob()) this.restoreForm(this.currentJob()); this.loaded = true;
      if (this.uncertain) { this.uncertain = false; this.showNotice('学习记录已刷新，请核对最近记录后再开始新的学习。'); } this.render();
    } catch (error) { if (request === this.listRequest) this.showNotice(`学习记录读取失败：${error.message}`, true); }
    finally { if (request === this.listRequest) { this.loading = false; this.refresh.disabled = false; this.updateRunButton(); } }
  }
  restoreForm(job) {
    if (feedbackJob(job)) { if (this.setup) this.setup.open = false; this.showNotice('反馈学习没有已知答案样例；现有样例草稿已保留。可展开下方设置配置独立验证样例。'); return; }
    this.dataset = structuredClone(learningDatasetForJob(job)); this.resetCaseEditor(); this.renderDataset(); this.pendingImport = null; this.importRevision++; this.renderImportPreview();
    const config = job.config || {}; this.targetScore.value = String(config.targetScore ?? 90); this.maxRounds.value = String(config.maxRounds ?? 3); this.rubric.value = config.rubric || '';
    this.renderTrainable(); this.renderComparisonHint(); this.renderDatasetSummary();
  }
  async loadJob(id) { const revision = this.revisions.get(id) || 0; try { const job = jobFrom(await this.api(`/api/workflow-learning/${encodeURIComponent(id)}`)); if (job.id === id && (this.revisions.get(id) || 0) === revision) this.storeJob(job); if (this.jobId === id) this.render(); } catch (error) { if (this.jobId === id) this.showNotice(`学习详情读取失败：${error.message}`, true); } }
  handleEvent(event) {
    if (event.type === 'learning.run') { const job = jobFrom(event.payload), isNew = !this.jobs.has(job?.id); this.storeJob(job); if (job?.workflowId === this.editor.doc?.id) { if (!this.jobId || isNew && ACTIVE.has(job.status)) { this.jobId = job.id; this.selectedRound = null; this.roundPinned = false; this.selectedCase = 0; } this.scheduleRender(); } }
    else if (event.type === 'workflow.run' && this.selectedCaseData()?.runId === (event.payload?.run || event.payload)?.id) this.scheduleRender();
    else if (['backend.status', 'backend.error', 'request.open', 'request.cancel'].includes(event.type)) this.refreshBackend();
  }
  scheduleRender() { if (this.renderTimer) return; this.renderTimer = setTimeout(() => { this.renderTimer = null; this.render(); }, 100); }
  render() {
    const jobs = this.workflowJobs(), job = this.currentJob(), signature = JSON.stringify(jobs.map(item => [item.id, item.status]));
    if (this.recentSignature !== signature) { this.recent.replaceChildren(); if (!jobs.length) { const option = element('option', '', '暂无学习记录'); option.value = ''; this.recent.append(option); } for (const item of jobs) { const option = element('option', '', `${time(item.startedAt || item.times?.startedAt)} · ${statusLabel(item)}`); option.value = item.id; this.recent.append(option); } this.recentSignature = signature; }
    this.recent.value = job?.id || ''; this.recent.disabled = !jobs.length; this.refresh.disabled = this.loading;
    this.status.textContent = job ? statusLabel(job) : '尚未开始'; this.status.dataset.status = feedbackJob(job) && job.status === 'complete' ? 'pending' : job?.status === 'exhausted' ? 'interrupted' : job?.status || 'idle';
    this.summary.textContent = job ? clean(ACTIVE.has(job.status) ? feedbackJob(job) ? feedbackPhaseLabel(job) : PHASE[job.phase] || job.phase || '执行与评估' : feedbackJob(job) ? job.reason === 'feedback-no-change' ? '未形成新候选' : job.status === 'complete' ? '反馈候选 · 待验证和复评' : '反馈学习已结束' : `最佳 ${score(job.bestScore)}`) : '暂无学习记录'; this.summary.hidden = !this.summary.textContent;
    const reasons = { target: '已通过本次样例评估，可查看并选择应用最佳版本。', maxRounds: '已达到总轮数上限，尚未达到目标；可查看已验证的最佳版本。', noChange: '本轮未形成有效修改，保留已验证结果。', unchanged: '未形成新的有效修改，学习已结束并保留已验证结果。', closed: '应用已关闭，保留结果且未自动继续学习。', restart: '应用重启后保留结果，未自动继续学习。', disconnected: '连接中断后保留结果，未自动继续学习。', 'feedback-candidate-ready': '反馈候选已生成 · 未验证', 'feedback-no-change': '未形成新候选' };
    this.results.hidden = !job; this.error.textContent = job?.error ? display(job.error) : reasons[job?.reason] || ''; this.error.hidden = !this.error.textContent; this.error.classList.toggle('wf-learning-reason', !job?.error);
    const isFeedback = feedbackJob(job), best = learningBestRound(job), bestMetrics = best ? learningRoundMetrics(job, best) : null; this.best.textContent = isFeedback ? '未验证 · 待用户复评' : best ? `最佳通过率 ${percent(bestMetrics.overall.passRate) || '待评估'} · 最低 ${score(best.score)}` : '暂无已验证最佳版本'; const changed = !!job && (learningSnapshotChanged(job.document, this.editor.doc) || this.editor.propertyDrafts?.size > 0);
    const candidateReady = isFeedback && job.status === 'complete' && job.reason !== 'feedback-no-change' && !!job.candidateDocument;
    this.apply.disabled = !(isFeedback ? candidateReady : best) || ACTIVE.has(job?.status) || changed || this.applying; this.apply.textContent = this.applying ? '正在应用…' : isFeedback ? '应用候选到草稿（未验证）' : '应用最佳候选到草稿'; this.draftNotice.hidden = !changed;
    this.jobInfo.textContent = job ? clean(isFeedback ? [`来源运行 ${job.sourceRunId || '未记录'}`, `反馈第 ${job.feedbackRevision ?? '—'} 版`, `检查 ${job.config?.trainableNodeIds?.length || 0} 个允许改进的 Skill`, '未验证'].join(' · ') : [`固定快照 · ${time(job.startedAt || job.times?.startedAt)}`, `${job.rounds?.length || 0}/${job.config?.maxRounds || '—'} 轮（含基线）`, job.config?.comparison === 'model' ? '逐例 AI 评分估计' : '精确对比', `目标 ${score(job.config?.targetScore)}`, `每轮 ${learningExpectedCases(job).length} 次完整流程执行`].join(' · ')) : '';
    if (this.restoreButton) { this.restoreButton.hidden = isFeedback; this.restoreButton.disabled = isFeedback || this.starting; }
    if (this.resultsLayout) this.resultsLayout.hidden = isFeedback;
    if (this.feedbackResults) this.feedbackResults.hidden = !isFeedback;
    this.renderMemoryPolicy(); if (isFeedback) this.renderFeedbackResult(job); else this.renderRounds(); this.renderTask(); this.updateRunButton(); if (this.editor.doc?.mode !== 'learn') this.runtime.updateRunButton?.();
  }
  acceptFeedbackLearning(value) {
    const job = jobFrom(value); if (!feedbackJob(job) || !job?.id || !job.workflowId) throw new Error('服务未返回匹配的反馈学习记录。');
    this.storeJob(job);
    if (job.workflowId !== this.editor.doc?.id) { this.runtime.showNotice?.('反馈学习已在原工作流中启动；切回该工作流后查看学习记录。'); return; }
    const changed = learningSnapshotChanged(job.document, this.editor.doc) || this.editor.propertyDrafts?.size > 0;
    this.inspectionRunId = null;
    if (this.editor.doc.mode !== 'learn') this.editor.commit({ ...this.editor.doc, mode: 'learn' }, '查看反馈学习');
    this.jobId = job.id; this.selectedRound = null; this.roundPinned = false; this.selectedCase = 0; this.loaded = true;
    if (this.setup) this.setup.open = false;
    this.setExpanded(); this.syncMode(); this.render();
    this.showNotice(changed ? '反馈学习已启动，当前草稿已保留。草稿与来源运行快照不同，恢复对应流程前不能应用候选。' : '正在生成反馈候选。', changed);
  }
  renderFeedbackResult(job) {
    if (!this.feedbackResults) return;
    const selected = new Set(job.config?.trainableNodeIds || []), snapshot = job.feedbackSnapshot || {}, items = snapshot.targets || snapshot.items || [], round = job.rounds?.at(-1);
    const comment = typeof snapshot.comment === 'string' ? snapshot.comment : items.filter(item => item.comment?.trim()).map(item => `${item.title || item.nodeId}：${item.comment}`).join('\n\n');
    this.feedbackCandidateNotice.textContent = job.reason === 'feedback-no-change' ? '本次没有形成新候选。' : job.status === 'complete' ? '候选已生成 · 未验证' : ACTIVE.has(job.status) ? '正在生成反馈候选。' : '反馈学习已结束。';
    const signature = JSON.stringify([job.id, comment, items, [...selected]]);
    if (this.feedbackCommentSignature !== signature) {
      this.feedbackCommentSignature = signature; this.feedbackComment.replaceChildren();
      const section = element('section', 'wf-learning-overall-feedback');
      section.append(element('h4', '', '综合反馈'), element('p', 'wf-learning-overall-comment', clean(comment || '未填写反馈')));
      const titles = items.filter(item => selected.has(item.nodeId)).map(item => item.title || job.document?.nodes?.find(node => node.id === item.nodeId)?.title || item.nodeId);
      section.append(element('p', 'wf-runtime-hint', `检查范围：${titles.join('、') || '暂无可改进的 Skill'}。只为相关问题生成修改。`));
      this.feedbackComment.append(section);
    }
    const changes = (round?.changes || []).filter(change => selected.has(change.nodeId)), changeSignature = JSON.stringify([job.id, changes]);
    if (this.feedbackChangesSignature !== changeSignature) {
      this.feedbackChangesSignature = changeSignature; this.feedbackChanges.replaceChildren();
      for (const change of changes) {
        const details = element('details', 'wf-learning-change'), title = items.find(item => item.nodeId === change.nodeId)?.title || job.document?.nodes?.find(node => node.id === change.nodeId)?.title || change.nodeId;
        details.append(element('summary', '', `${title} · ${change.summary || '查看反馈候选正文'}`));
        const compare = element('div', 'wf-learning-change-columns');
        for (const [label, version] of [['原始 Skill', change.before], ['反馈候选（未验证）', change.after]]) { const section = element('section'); section.append(element('h4', '', label), element('p', 'wf-learning-fingerprint', [version?.ref, version?.revision].filter(Boolean).join('\n'))); const content = element('pre', '', own(version, 'content') ? version.content : '该记录未采集正文。'); content.tabIndex = 0; section.append(content); compare.append(section); }
        details.append(compare); this.feedbackChanges.append(details);
      }
      if (!changes.length) this.feedbackChanges.append(element('p', 'wf-runtime-hint', '尚未形成相关 Skill 的候选修改。'));
    }
  }
  renderMemoryPolicy() { const job = this.currentJob(); this.memoryRecord.hidden = !job; if (!job) return; const policy = learningMemoryStatus(job); this.memoryRecord.dataset.state = policy.kind; this.memoryLabel.textContent = policy.label; this.memoryDetails.textContent = policy.description; }
  renderRounds() {
    const job = this.currentJob(), rounds = job?.rounds || []; if (this.roundJobId !== job?.id) { this.rounds.replaceChildren(); this.roundElements.clear(); this.roundJobId = job?.id; this.changesSignature = null; this.casesSignature = null; }
    if (!this.roundPinned || !rounds.some(item => item.index === this.selectedRound)) this.selectedRound = rounds.at(-1)?.index ?? null;
    if (rounds.length && !this.roundElements.size) this.rounds.replaceChildren();
    for (const round of rounds) { let entry = this.roundElements.get(round.index); if (!entry) { const row = element('li'), select = button('', () => { this.selectedRound = round.index; this.roundPinned = true; this.selectedCase = 0; this.renderRounds(); }, 'wf-learning-round'); const label = element('strong'), detail = element('span'); select.append(label, detail); row.append(select); this.rounds.append(row); entry = { select, label, detail }; this.roundElements.set(round.index, entry); }
      const metrics = learningRoundMetrics(job, round); entry.label.textContent = `${roundName(round.index)}${job.bestRound === round.index && learningBestRound(job) ? ' · 最佳' : ''}`; entry.detail.textContent = `${round.status === 'complete' ? '评估完成' : STATUS[round.status] || round.status} · ${percent(metrics.overall.passRate) || '待评估'} · 最低 ${score(round.score)}`; entry.select.classList.toggle('selected', round.index === this.selectedRound); entry.select.setAttribute('aria-pressed', String(round.index === this.selectedRound)); }
    if (!rounds.length && !this.rounds.children.length) this.rounds.append(element('li', 'wf-runtime-hint', '正在冻结记忆或准备基线，尚无轮次结果。'));
    this.renderSelectedRound();
  }
  selectedRoundData() { return this.currentJob()?.rounds?.find(round => round.index === this.selectedRound) || null; }
  renderRoundDataset(job, round, cases) {
    const metrics = learningRoundMetrics(job, round);
    for (const [key, ui] of this.metricCards || []) { const group = metrics[key]; ui.value.textContent = !group.total ? key === 'validation' ? '未验证' : '暂无样例' : percent(group.passRate) || '待评估'; ui.detail.textContent = group.total ? `通过 ${group.passed}/${group.total} · 未通过 ${group.failed} · 待评 ${group.pending}\n${group.pending ? '已评样例' : ''}平均 ${score(group.averageScore)} · 最低 ${score(group.minScore)}` : key === 'validation' ? '本轮没有独立验证样例' : '尚无对应样例'; ui.card.dataset.state = !group.total ? 'empty' : group.pending ? 'pending' : group.failed ? 'failed' : 'passed'; }
    if (!this.caseTableBody) return;
    this.caseRows ||= new Map(); const signature = JSON.stringify([job?.id, round?.index, cases.map(item => item.id)]);
    if (this.caseTableSignature !== signature) { this.caseTableBody.replaceChildren(); this.caseRows.clear(); this.caseTableSignature = signature; for (const [index] of cases.entries()) { const row = element('tr'), name = element('td'), status = element('td'), points = element('td'), resultCell = element('td'), result = element('span', 'wf-learning-case-result'), action = element('td'); resultCell.append(result); action.append(button('查看 I/O', () => { this.selectedCase = index; this.roundPinned = true; this.renderSelectedRound(); this.actual.scrollIntoView?.({ block: 'nearest' }); }, 'wf-button wf-runtime-small')); row.append(name, status, points, resultCell, action); this.caseTableBody.append(row); this.caseRows.set(index, { row, name, status, points, result }); } }
    for (const [index, item] of cases.entries()) { const ui = this.caseRows.get(index), grade = summarizeRoundCases([item], job?.config?.targetScore ?? 90).overall; ui.name.textContent = clean(`${item.name || `样例 ${index + 1}`}\n${item.role === 'validation' ? '验证集' : '训练集'}`); ui.status.textContent = item.status === 'complete' ? '执行完成' : ['error', 'failed'].includes(item.status) ? '执行失败' : STATUS[item.status] || '尚未执行'; ui.points.textContent = score(grade.pending ? null : grade.minScore); ui.result.textContent = grade.pending ? '尚未评估' : grade.passed ? '通过' : '未通过'; ui.row.classList.toggle('selected', index === this.selectedCase); ui.result.dataset.state = grade.pending ? 'pending' : grade.passed ? 'passed' : 'failed'; }
  }
  selectedCaseData() { return learningRoundRows(this.currentJob(), this.selectedRoundData())[this.selectedCase] || null; }
  renderSelectedRound() {
    const job = this.currentJob(), round = this.selectedRoundData(), cases = learningRoundRows(job, round); this.roundTitle.textContent = round ? roundName(round.index) : '等待本轮记录'; this.roundScore.textContent = `最低 ${score(round?.score)}`; this.feedback.textContent = [round?.feedback ? display(round.feedback) : '本轮完成评估后展示反馈。', round?.optimizerContext === 'diagnostics' ? '调整依据：逐例诊断后汇总。' : round?.optimizerContext === 'full' ? '调整依据：全训练样例。' : ''].filter(Boolean).join('\n');
    this.renderRoundDataset(job, round, cases);
    const caseSignature = JSON.stringify([job?.id, round?.index, cases.map(item => [item.id, item.name, item.role])]); if (this.casesSignature !== caseSignature) { this.cases.replaceChildren(); for (const [index, item] of cases.entries()) { const option = element('option', '', `${item.name || `样例 ${index + 1}`} · ${item.role === 'validation' ? '验证' : '训练'}`); option.value = String(index); this.cases.append(option); } this.casesSignature = caseSignature; }
    if (this.selectedCase >= cases.length) this.selectedCase = 0; this.cases.value = String(this.selectedCase); this.cases.disabled = !cases.length;
    const item = this.selectedCaseData(), grade = item ? summarizeRoundCases([item], job?.config?.targetScore ?? 90).overall : null; this.inspect.disabled = !item?.runId; this.caseScore.textContent = item ? clean([score(grade.pending ? null : grade.minScore), grade.pending ? '尚未评估' : grade.passed ? '通过' : '未通过', item.feedback ? display(item.feedback) : '尚无评价反馈'].join(' · ')) : '尚未记录样例执行。';
    this.known.textContent = item && own(item, 'expected') ? display(item.expected) : '尚未记录已知答案。'; this.sampleInput.textContent = item && own(item, 'input') ? display(item.input) : '尚未记录样例输入。';
    const run = item?.runId ? this.runtime.runs.get(item.runId) : null;
    const comparisonOutput = item?.status === 'complete' && own(item, 'output');
    const result = learningCaseResult(comparisonOutput ? { status: 'complete', output: item.output } : run || (item?.error || item?.preview ? { status: item.status, error: item.error, partialText: item.preview } : null));
    const source = learningSourceLabel(round?.document || job?.document);
    this.actualLabel.textContent = comparisonOutput ? `对比产物${source ? ` · ${source}` : ''}` : result.label; this.actual.textContent = result.value; this.actual.classList.toggle('partial', !result.confirmed);
    if (item?.runId && !run && !this.caseLoads.has(item.runId) && !this.caseFailures.has(item.runId)) void this.loadCase(item.runId);
    const changesSignature = JSON.stringify([this.currentJob()?.id, round?.index, round?.changes]); if (this.changesSignature !== changesSignature) { this.changes.replaceChildren(); this.changesSignature = changesSignature; for (const change of round?.changes || []) { const details = element('details', 'wf-learning-change'); const title = this.currentJob()?.document?.nodes?.find(node => node.id === change.nodeId)?.title || change.nodeId; details.append(element('summary', '', `${title} · ${change.summary || '查看 Skill 修改前后正文'}`)); const compare = element('div', 'wf-learning-change-columns'); for (const [name, value] of [['修改前', change.before], ['修改后', change.after]]) { const section = element('section'); section.append(element('h4', '', name), element('p', 'wf-learning-fingerprint', [value?.ref, value?.revision].filter(Boolean).join('\n'))); const content = element('pre', '', own(value, 'content') ? value.content : '该记录未采集正文。'); content.tabIndex = 0; section.append(content); compare.append(section); } details.append(compare); this.changes.append(details); } if (!round?.changes?.length) this.changes.append(element('p', 'wf-runtime-hint', round?.index === 0 ? '基线使用原 Skill，没有正文修改。' : '本轮尚未记录 Skill 修改。')); }
  }
  async loadCase(id) { const revision = this.runtime.revisions.get(id) || 0; const promise = this.api(`/api/workflow-runs/${encodeURIComponent(id)}`).then(value => { const run = value.run || value; if (run.id !== id) throw new Error('服务未返回匹配的运行记录。'); if ((this.runtime.revisions.get(id) || 0) === revision) this.runtime.storeRun(run); this.caseFailures.delete(id); }).catch(error => { this.caseFailures.add(id); if (this.selectedCaseData()?.runId === id) this.showNotice(`样例运行详情读取失败：${error.message}。可点击刷新重试。`, true); }).finally(() => { this.caseLoads.delete(id); if (this.selectedCaseData()?.runId === id) this.renderSelectedRound(); }); this.caseLoads.set(id, promise); return promise; }
  async inspectCase() {
    const id = this.selectedCaseData()?.runId; if (!id) return;
    this.inspectionRunId = id; this.setExpanded(false); this.syncMode(); this.back.focus({ preventScroll: true });
    if (!this.runtime.runs.has(id)) await (this.caseLoads.get(id) || this.loadCase(id));
    if (this.inspectionRunId !== id || this.editor.doc?.mode !== 'learn') return;
    const transferFocus = document.activeElement === this.back;
    if (!this.runtime.runs.has(id)) { this.returnFromInspection({ restoreFocus: transferFocus }); return; }
    this.runtime.currentRunId = id; this.runtime.selectedNodeId = null; this.runtime.nodeSelectionPinned = false; this.runtime.render(); this.runtime.setExpanded();
    if (transferFocus) this.runtime.toggle.focus({ preventScroll: true });
  }
  renderTask() {
    const job = this.activeJob() || this.currentJob(), run = job?.activeRunId ? this.runtime.runs.get(job.activeRunId) : null; const sessionId = job?.modelSessionId || run?.sessionId; this.runtime.renderTaskLink(this.modelTask, sessionId, job?.status); this.modelTask.hidden = !sessionId;
  }
  async interrupt() {
    const job = this.activeJob(); if (!job || this.stopping.has(job.id) || this.stopRequested.has(job.id)) return; this.stopping.add(job.id); this.render(); const revision = this.revisions.get(job.id) || 0;
    try { const result = jobFrom(await this.api(`/api/workflow-learning/${encodeURIComponent(job.id)}/interrupt`, { method: 'POST', body: {} })); if ((this.revisions.get(job.id) || 0) === revision && result?.id) this.storeJob(result); if (ACTIVE.has(this.jobs.get(job.id)?.status)) { this.stopRequested.add(job.id); this.showNotice('停止请求已发送，等待学习任务确认终态；候选不会自动应用。'); } else this.showNotice('学习任务已停止，候选未自动应用。'); }
    catch (error) { this.showNotice(`停止请求失败：${error.message}`, true); } finally { this.stopping.delete(job.id); this.render(); }
  }
  async applyBest() {
    if (this.editor.nodeLibrary?.nested) { this.showNotice('请先返回主流程，再应用学习候选。', true); return; }
    if (feedbackJob(this.currentJob())) return this.applyFeedback();
    const job = this.currentJob(), best = learningBestRound(job); if (!best || ACTIVE.has(job.status) || this.applying) return; if (learningSnapshotChanged(job.document, this.editor.doc) || this.editor.propertyDrafts?.size) { this.showNotice('草稿已变化，请恢复对应学习快照后再应用最佳候选。', true); return; }
    this.applying = true; this.render();
    try { const result = await this.api(`/api/workflow-learning/${encodeURIComponent(job.id)}/apply`, { method: 'POST', body: {} }); if (!result.document || result.learningId !== job.id) throw new Error('服务返回的候选不属于当前学习任务。'); this.editor.applyLearningDocument(result.document, { baseDocument: job.document, trainableNodeIds: job.config?.trainableNodeIds || [] }); await this.runtime.loadSkills(true); this.runtime.refreshBackend(); this.runtime.showNotice(`已将${roundName(result.round)}版本应用到草稿（${score(result.score)}），可撤销。`); this.runtime.setExpanded(); this.editor.toast('已应用最佳候选并切换执行模式，可通过撤销恢复。'); }
    catch (error) { this.showNotice(`候选未应用：${error.message}`, true); }
    finally { this.applying = false; this.render(); this.syncMode(); }
  }
  async applyFeedback() {
    if (this.editor.nodeLibrary?.nested) { this.showNotice('请先返回主流程，再应用反馈候选。', true); return; }
    const job = this.currentJob(); if (!feedbackJob(job) || job.status !== 'complete' || job.reason === 'feedback-no-change' || !job.candidateDocument || this.applying) return;
    if (learningSnapshotChanged(job.document, this.editor.doc) || this.editor.propertyDrafts?.size) { this.showNotice('草稿已变化，请恢复对应运行快照后再应用反馈候选。', true); return; }
    this.applying = true; this.render();
    try {
      const result = await this.api(`/api/workflow-learning/${encodeURIComponent(job.id)}/apply-feedback`, { method: 'POST', body: {} });
      if (!result.document || result.learningId !== job.id || result.validationStatus !== 'not-run' || result.score !== null) throw new Error('服务未返回匹配的未验证反馈候选。');
      this.editor.applyLearningDocument(result.document, { baseDocument: job.document, trainableNodeIds: job.config?.trainableNodeIds || [] });
      let refreshError = ''; try { await this.runtime.loadSkills(true); this.runtime.refreshBackend(); } catch (error) { refreshError = `Skill 列表刷新失败：${error.message}。`; }
      this.runtime.showNotice(`反馈候选已应用到执行草稿，可撤销。尚未验证，请重新运行并评价产物。${refreshError}`); this.runtime.setExpanded(); this.editor.toast('已应用反馈候选；请重新执行并复评。');
    } catch (error) { this.showNotice(`反馈候选未应用：${error.message}`, true); }
    finally { this.applying = false; this.render(); this.syncMode(); }
  }
}
