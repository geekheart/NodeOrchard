import { randomUUID, createHash } from 'node:crypto';
import { validateDocument, getPorts } from '../../shared/workflow/workflow-model.mjs';
import { planWorkflow, learningBranch } from '../../shared/workflow/workflow-plan.mjs';
import { planWorkflowConversation } from './workflow-conversation-planner.mjs';
import { sanitizeDiagnosticEvidence } from '../app-diagnostics.mjs';
import { documentFingerprint, applyWorkflowOperations } from '../../shared/workflow/workflow-conversation-commands.mjs';
import { redact } from '../hermes-adapter.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);
const ACTIONS = new Set(['review-approve', 'review-revise', 'review-stop', 'rerun', 'record-feedback', 'learn-feedback', 'mark-applied', 'dismiss-turn', 'select-run', 'select-learning-target', 'interrupt-turn']);
const TERMINAL = new Set(['complete', 'error', 'interrupted', 'unknown']);
const clone = value => JSON.parse(JSON.stringify(value));
const fail = (message, httpStatus = 400) => { throw Object.assign(new Error(message), { httpStatus }); };
const now = () => new Date().toISOString();
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function finishDiagnostic(assistant, status, message) {
  const completedAt = now(), elapsed = value => Number.isFinite(Date.parse(value)) ? Math.max(0, Date.parse(completedAt) - Date.parse(value)) : 0;
  if (assistant.progress) assistant.progress = { ...assistant.progress, status, completedAt, elapsedMs: elapsed(assistant.progress.startedAt) };
  if (assistant.checkpoint) assistant.checkpoint = { ...assistant.checkpoint, updatedAt: completedAt,
    steps: (assistant.checkpoint.steps || []).map(step => step.status === 'running' ? { ...step, status, completedAt,
      elapsedMs: elapsed(step.startedAt), ...(message && status !== 'complete' ? { error: message } : {}) } : step) };
}
function identifier(value, label = 'ID') {
  if (typeof value !== 'string' || !ID.test(value) || RESERVED.has(value)) fail(`${label}无效。`);
  return value;
}
function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(key => !keys.includes(key))
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(field => !Object.hasOwn(field, 'value'))) fail(`${label}字段无效。`);
  return value;
}
function text(value, label, { required = true, max = 8000 } = {}) {
  if (typeof value !== 'string' || value.includes('\0') || value.length > max || required && !value.trim()) fail(`${label}必须是${max}字以内的文字。`);
  return value;
}
function contextInput(input = {}) {
  object(input, ['documentRevision', 'runId', 'nodeId', 'attempt', 'attemptId', 'artifactIds', 'artifactHashes'], '对话上下文');
  const result = clone(input);
  for (const key of ['runId', 'nodeId', 'attemptId']) if (result[key] !== undefined && result[key] !== null) identifier(result[key], key);
  for (const key of ['documentRevision', 'attempt']) if (result[key] !== undefined && (!Number.isSafeInteger(result[key]) || result[key] < 0)) fail(`${key}必须是非负整数。`);
  if (result.nodeId && !result.runId && (result.attempt !== undefined || result.attemptId)) fail('节点运行版本需要绑定运行。');
  if (result.artifactIds !== undefined && (!Array.isArray(result.artifactIds) || result.artifactIds.length > 64
    || new Set(result.artifactIds).size !== result.artifactIds.length)) fail('产物 ID 列表无效。');
  for (const id of result.artifactIds || []) identifier(id, '产物 ID');
  if (result.artifactHashes !== undefined) {
    if (!Array.isArray(result.artifactHashes) || result.artifactHashes.length > 64) fail('产物哈希列表无效。');
    for (const item of result.artifactHashes) {
      object(item, ['id', 'sha256'], '产物哈希'); identifier(item.id, '产物 ID');
      if (!/^[a-f0-9]{64}$/.test(item.sha256 || '')) fail('产物哈希无效。');
    }
    if (new Set(result.artifactHashes.map(item => item.id)).size !== result.artifactHashes.length) fail('产物哈希重复。');
  }
  return result;
}
function safeDocument(input, workflowId) {
  let document;
  try { document = validateDocument(input); } catch (error) { fail(error.message); }
  if (document.id !== workflowId) fail('对话文档与当前工作流不一致。', 409);
  if (Buffer.byteLength(JSON.stringify(document)) > 2 * 1024 * 1024) fail('工作流文档过大。', 413);
  return document;
}
function directIntent(value, intent) {
  const input = value.trim().replace(/[。！!]+$/, '');
  if (/^(?:(?:通过|审核通过|批准|同意通过)(?:[，,]?\s*继续(?:执行|汇总(?:验收)?|验收))?|通过[，,]\s*纳入\s*HDK)$/i.test(input)) return { action: 'review-approve' };
  if (/^(?:停止审核|停止本次运行|停止此分支|拒绝并停止|审核不通过并停止)$/.test(input)) return { action: 'review-stop' };
  const revision = input.match(/^(?:需要修改|要求修改|修改意见|重新修改)[：:,，\s]+([\s\S]+)$/);
  if (revision) return { action: 'review-revise', feedback: revision[1].trim() };
  if (intent === 'redo' || /^(?:重做|重跑|重新运行)(?:此节点|这个节点|当前节点|该节点)?(?:[：:,，\s]+[\s\S]+)?$/.test(input)) {
    return { action: 'rerun', feedback: input.replace(/^(?:重做|重跑|重新运行)(?:此节点|这个节点|当前节点|该节点)?[：:,，\s]*/, '').trim() };
  }
  return null;
}
// Automatic routing handles only explicit requests locally. Open questions and
// ambiguous prose stay with the planner; mentioning learning is not permission
// to start a learning batch.
function conversationIntent(value, requested, context = {}) {
  if (requested && requested !== 'auto') return requested;
  const input = value.trim();
  if (/[?？]\s*$|(?:可以|能否|能不能|可不可以|是否|如何|怎么|为什么|为何)/.test(input)
    && !/^(?:请|帮我|把|将)/.test(input)) return 'discuss';
  if (/(?:固定任务|默认输入|默认需求|一键运行|不(?:需要|用).{0,12}输入|无需.{0,12}输入|补全.{0,10}配置)/.test(input)) return 'workflow';
  if (/(?:以后|今后|下次|后续|永久).{0,20}(?:都|按|采用|使用|保持|格式|规则)|(?:改进|优化|训练|学习|修改).{0,20}(?:Skill|技能)|(?:Skill|技能).{0,12}(?:改进|优化|训练|学习)/i.test(input)) return 'skill';
  if (context.runId && !/(?:工作流|流程|节点|连线|默认配置)/.test(input)
    && /(?:结果|产物|表格|Excel|文件|表头|列名|列顺序|字体|颜色|图片)/i.test(input)
    && /(?:改|调整|不对|错误|缺|遗漏|需要|希望)/.test(input)) return 'feedback';
  if (/^(?:反馈|记录反馈|保存反馈|产物反馈)[：:,，\s]|(?:这次|本次|这份|这个).{0,12}(?:结果|产物|表格|Excel|文件).{0,20}(?:不对|问题|需要|希望|改|调整)/i.test(input)) return 'feedback';
  return /^(?:请|帮我|把|将|添加|删除|修改|设置|创建|搭建|调整|改成|改为|配置)/.test(input) ? 'workflow' : 'discuss';
}
const artifactView = artifact => Object.fromEntries(['id', 'name', 'label', 'mimeType', 'sha256', 'size', 'kind', 'nodeId', 'attempt'].filter(key => artifact[key] !== undefined).map(key => [key, artifact[key]]));

// The conversation is an interaction record. Run documents and artifacts remain
// the execution facts; model suggestions never grant operational authority.
export class WorkflowConversations {
  constructor(app, { planner = (app, options) => app.applicationAssistant ? app.applicationAssistant.plan(options) : planWorkflowConversation(app, options) } = {}) {
    this.app = app; this.db = app.store.db; this.planner = planner; this.active = new Map(); this.mutations = new Set(); this.closed = false;
    this.onEvent = event => {
      if (event.type !== 'workflow.lifecycle' || this.closed) return;
      const workflowId = event.payload?.id || event.payload?.workflow?.id;
      if (!workflowId || event.payload?.workflow?.lifecycle === 'active') return;
      for (const [turnId, controller] of this.active) {
        const row = this.db.prepare('SELECT workflow_id FROM workflow_conversation_turns WHERE id=?').get(turnId);
        if (row?.workflow_id === workflowId) controller.abort();
      }
    };
    app.on('event', this.onEvent);
    this.db.exec(`CREATE TABLE IF NOT EXISTS workflow_conversations (workflow_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS workflow_conversation_turns (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, client_message_id TEXT NOT NULL,
      created_at TEXT NOT NULL, value TEXT NOT NULL, private_value TEXT NOT NULL, UNIQUE(workflow_id,client_message_id));`);
    // An unconfirmed external operation must never be replayed after a restart.
    for (const row of this.db.prepare('SELECT id,value FROM workflow_conversation_turns').all()) {
      const turn = JSON.parse(row.value);
      if (turn.status === 'thinking' || turn.outcome?.status === 'started') {
        turn.status = 'interrupted'; turn.updatedAt = now();
        finishDiagnostic(turn.assistant, 'interrupted', '服务重启，未自动重复操作。');
        turn.assistant = { ...turn.assistant, text: turn.outcome?.status === 'started'
          ? '上次操作的最终结果尚未确认，请查看运行状态；系统不会自动重复操作。' : '对话生成因服务重启中断，可以重新发送要求。' };
        if (turn.outcome?.status === 'started') turn.outcome.status = 'unknown';
        this.update(turn);
      }
    }
  }
  assertOpen(workflowId, mutation = false) {
    if (this.closed || this.app.closed) fail('工作台已关闭。', 409);
    identifier(workflowId, '工作流 ID');
    if (mutation) this.app.workflowLibrary.assertRunnable(workflowId);
    else this.app.workflowLibrary.assertAvailable(workflowId);
  }
  readTurn(workflowId, turnId) {
    identifier(turnId, '对话轮次 ID');
    const row = this.db.prepare('SELECT value,private_value FROM workflow_conversation_turns WHERE id=? AND workflow_id=?').get(turnId, workflowId);
    if (!row) fail('此工作流没有该对话轮次。', 404);
    return { turn: JSON.parse(row.value), privateValue: JSON.parse(row.private_value) };
  }
  update(turn, privateValue) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE workflow_conversation_turns SET value=? WHERE id=? AND workflow_id=?').run(JSON.stringify(turn), turn.id, turn.workflowId);
      if (privateValue !== undefined) this.db.prepare('UPDATE workflow_conversation_turns SET private_value=? WHERE id=?').run(JSON.stringify(privateValue), turn.id);
      this.db.prepare('INSERT INTO workflow_conversations(workflow_id,revision) VALUES(?,1) ON CONFLICT(workflow_id) DO UPDATE SET revision=revision+1').run(turn.workflowId);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  emit(workflowId) {
    if (this.closed) return;
    try { this.app.publish?.('workflow.conversation', null, { workflowId, ...this.get(workflowId) }); }
    catch (error) { if (![409, 410].includes(error.httpStatus)) throw error; }
  }
  get(workflowId) {
    this.assertOpen(workflowId);
    const revision = this.db.prepare('SELECT revision FROM workflow_conversations WHERE workflow_id=?').get(workflowId)?.revision || 0;
    const rows = this.db.prepare('SELECT value FROM workflow_conversation_turns WHERE workflow_id=? ORDER BY rowid DESC LIMIT 200').all(workflowId).reverse();
    return { conversation: { workflowId, revision, turns: rows.map(row => JSON.parse(row.value)) }, pending: this.pending(workflowId) };
  }
  childIds(record) {
    return [...new Set([...(Array.isArray(record?.subflowProgress?.childRunIds) ? record.subflowProgress.childRunIds : []),
      record?.subflowProgress?.childRunId, record?.review?.childRunId].filter(value => typeof value === 'string' && ID.test(value)))];
  }
  assertChild(parent, child) {
    if (!child?.id || child.parentRunId !== parent.id || child.learningId || child.memoryScopeId) fail('子运行与当前工作流不一致。', 409);
    const matches = (parent.document?.nodes || []).filter(node => ['subflow', 'foreach', 'loop'].includes(node.type)
      && this.childIds(parent.nodes?.[node.id]).includes(child.id));
    if (matches.length !== 1) fail('子运行不属于父节点的当前版本。', 409);
    const embedded = matches[0].config?.document;
    if (!embedded?.id || child.workflowId !== embedded.id || child.document?.id !== embedded.id) fail('子运行与组合节点的执行快照不一致。', 409);
    // Runtime may force child mode=execute; the remaining logical definition is
    // still frozen. Do not admit an arbitrary run with a copied parentRunId.
    if (documentFingerprint({ ...child.document, mode: embedded.mode }) !== documentFingerprint(embedded)) fail('子运行的流程内容与组合节点不一致。', 409);
    return matches[0];
  }
  assertRunScope(workflowId, run) {
    let current = run; const seen = new Set();
    for (let depth = 0; depth <= 8; depth++) {
      if (!current || seen.has(current.id) || current.learningId || current.memoryScopeId) fail('学习样例或无效子运行不能带入工作流对话。', 409);
      seen.add(current.id);
      if (current.workflowId === workflowId) return;
      if (!current.parentRunId) break;
      const parent = this.app.workflows.get(current.parentRunId); this.assertChild(parent, current); current = parent;
    }
    fail('所选运行不属于此工作流。', 409);
  }
  pending(workflowId) {
    const runs = [], seen = new Set();
    const visit = (run, path = '', depth = 0) => {
      if (depth > 8 || seen.has(run.id) || run.learningId || run.memoryScopeId) return;
      seen.add(run.id); runs.push({ run, path });
      for (const node of run.document?.nodes || []) if (['subflow', 'foreach', 'loop'].includes(node.type)) {
        for (const childId of this.childIds(run.nodes?.[node.id])) {
          try { const child = this.app.workflows.get(childId); this.assertChild(run, child); visit(child, path + node.title + ' / ', depth + 1); }
          catch { /* Invalid historical links never become operational cards. */ }
        }
      }
    };
    for (const run of this.app.workflows.list(workflowId)) visit(run);
    return runs.flatMap(({ run, path }) => (run.document?.nodes || []).flatMap(node => {
      const record = run.nodes?.[node.id];
      if (node.type !== 'human' || record?.status !== 'waiting_review') return [];
      const artifacts = (record.artifacts || []).map(artifactView);
      return [{ id: `${run.id}:${node.id}:${record.attempt}`, kind: 'review', label: path + node.title, status: 'waiting_review',
        context: { runId: run.id, nodeId: node.id, attempt: record.attempt, attemptId: record.attemptId,
          artifactIds: artifacts.map(item => item.id), artifactHashes: artifacts.map(item => ({ id: item.id, sha256: item.sha256 })) }, artifacts }];
    }));
  }
  bindContext(workflowId, input, document, { exact = false, review = false } = {}) {
    const context = contextInput(input);
    if (context.documentRevision !== undefined) {
      let saved;
      try { saved = this.app.workflowLibrary.get(workflowId); } catch (error) { if (error.httpStatus !== 404) throw error; }
      if ((saved?.revision || 0) !== context.documentRevision) fail('工作流保存版本已变化，请刷新上下文。', 409);
    }
    if (!context.runId) {
      if (context.nodeId && !document.nodes.some(node => node.id === context.nodeId)) fail('所选节点不属于当前工作流。', 409);
      if ((context.artifactIds?.length || context.artifactHashes?.length)) fail('产物反馈需要绑定具体运行。');
      if (exact) fail('请先选择具体运行和节点，再执行此操作。', 409);
      return { context };
    }
    const run = this.app.workflows.get(context.runId);
    this.assertRunScope(workflowId, run);
    if (run.learningId || run.memoryScopeId || run.document?.mode === 'learn') fail('学习样例不能带入普通工作流对话，请使用学习面板。', 409);
    if (!context.nodeId) {
      if (exact || context.artifactIds?.length || context.artifactHashes?.length) fail('请明确选择对应节点。', 409);
      return { context, run };
    }
    const node = run.document?.nodes?.find(node => node.id === context.nodeId), record = run.nodes?.[context.nodeId];
    if (!node || !record) fail('所选节点不属于此运行快照。', 409);
    if (exact && (context.attempt === undefined || !context.attemptId)) fail('缺少实际看到的节点版本，请重新选择节点或产物。', 409);
    if (context.attempt !== undefined && context.attempt !== (record.attempt || 0)
      || context.attemptId && context.attemptId !== record.attemptId) fail('节点已生成新版本，请重新查看后回复。', 409);
    if (review && (node.type !== 'human' || record.status !== 'waiting_review')) fail('所选节点没有等待中的人工审核。', 409);
    const artifacts = record.artifacts || [], byId = new Map(artifacts.map(item => [item.id, item]));
    for (const id of context.artifactIds || []) if (!byId.has(id)) fail('所选产物不属于此节点的当前版本。', 409);
    for (const item of context.artifactHashes || []) if (byId.get(item.id)?.sha256 !== item.sha256) fail('所选产物哈希已变化，请重新查看。', 409);
    // Freeze the complete candidate, even when the user selected only one image.
    return { context: { ...context, attempt: record.attempt || 0, attemptId: record.attemptId || null,
      artifactIds: [...(context.artifactIds || [])], artifactHashes: artifacts.map(item => ({ id: item.id, sha256: item.sha256 })) }, run, node, record };
  }
  feedbackRuns(workflowId, context) {
    return this.app.workflows.list(workflowId).filter(run => TERMINAL.has(run.status) && !run.learningId && !run.memoryScopeId
      && run.document?.mode === 'execute' && (!context.nodeId || run.document.nodes.some(node => node.id === context.nodeId)));
  }
  learningTargets(document, context, requestText) {
    const skills = document.nodes.filter(node => node.type === 'skill');
    const selected = document.nodes.find(node => node.id === context.nodeId);
    if (selected?.type === 'skill') return [selected];
    const namedRefs = skills.filter(node => node.config.skillRef && requestText.toLowerCase().includes(node.config.skillRef.toLowerCase()));
    if (namedRefs.length) return namedRefs;
    const namedTitles = skills.filter(node => !/^(?:Skill|AI\s*\/\s*Skill|技能)$/i.test(node.title) && requestText.includes(node.title));
    if (namedTitles.length) return namedTitles;
    const outputs = document.nodes.filter(node => node.type === 'output' && node.config.stage !== 'intermediate');
    const source = selected || (outputs.length === 1 ? outputs[0] : null);
    if (!source) return skills;
    const found = new Map(), seen = new Set(), pending = [source.id];
    while (pending.length) {
      const id = pending.pop(); if (seen.has(id)) continue; seen.add(id);
      const node = document.nodes.find(item => item.id === id);
      if (node?.type === 'skill') { found.set(id, node); continue; }
      for (const edge of document.edges.filter(edge => edge.targetNode === id)) pending.push(edge.sourceNode);
    }
    return [...found.values()];
  }
  prepareLearningScope(turn, document, context) {
    const targets = this.learningTargets(document, context, turn.user.text);
    if (!targets.length) {
      turn.status = 'complete'; turn.actions = [];
      turn.assistant = { text: '这个流程还没有可改进的真实 Skill。请直接在这里描述需要的能力，我会先提出流程配置；应用后点击“运行当前流程”，拿到结果再告诉我具体差异。' }; return;
    }
    if (targets.length !== 1) {
      turn.status = 'awaiting_action'; turn.assistant = { text: '这条流程包含多个能力。请在这里选择希望以后沿用改进规则的能力，其他能力保持原样。' };
      turn.actions = targets.map(node => ({ id: 'action-' + randomUUID(), kind: 'select-learning-target', label: node.title,
        context: { nodeId: node.id } })); return;
    }
    const target = targets[0]; let branch;
    try { branch = learningBranch(document); } catch { branch = null; }
    if (branch && !branch.improvementNode.config.targetSkillNodeIds.includes(target.id)) {
      const operations = [{ op: 'update-node', nodeId: branch.improvementNode.id, config: { targetSkillNodeIds: [target.id] } }];
      const proposal = applyWorkflowOperations(document, operations);
      turn.status = 'proposed'; turn.assistant = { text: `我会将后续改进范围限定为「${target.title}」。应用后重新运行一次，再在这里回复结果；已有运行快照保持原样。`,
        operations, summary: proposal.summary, baseFingerprint: documentFingerprint(document) };
      turn.actions = [{ id: 'action-' + randomUUID(), kind: 'mark-applied', label: '应用任务配置', context }]; return;
    }
    if (branch || document.nodes.some(node => ['evaluation', 'improvement'].includes(node.type))) {
      turn.status = 'complete'; turn.actions = [];
      turn.assistant = { text: '改进配置已保留。请先在这里点击“运行当前流程”获得一份结果，再直接回复具体差异和以后要沿用的规则。已有结果的执行快照不会被新配置改写。' }; return;
    }
    const outputs = document.nodes.filter(node => node.type === 'output' && node.config.stage !== 'intermediate');
    const source = outputs.length === 1 ? outputs[0] : target;
    const ports = getPorts(source).outputs;
    const sourcePort = ports.find(port => port.id === 'learning') || ports.find(port => port.id === 'out') || ports[0];
    if (!sourcePort) {
      turn.status = 'complete'; turn.actions = []; turn.assistant = { text: '当前能力还没有可对比的输出。请在这里描述需要交付的成果，我会先提出输出配置。' }; return;
    }
    const operations = [
      { op: 'add-node', ref: 'feedback-comparison', type: 'evaluation', title: '对比本次结果', config: { comparison: 'model' }, x: source.x + 330, y: source.y + 240 },
      { op: 'add-node', ref: 'feedback-improvement', type: 'improvement', title: '生成改进候选', config: { targetSkillNodeIds: [target.id] }, x: source.x + 660, y: source.y + 240 },
      { op: 'connect', sourceNode: source.id, sourcePort: sourcePort.id, targetNode: 'feedback-comparison', targetPort: 'in' },
      { op: 'connect', sourceNode: 'feedback-comparison', sourcePort: 'out', targetNode: 'feedback-improvement', targetPort: 'in' },
    ];
    const proposal = applyWorkflowOperations(document, operations);
    turn.status = 'proposed'; turn.assistant = { text: `我会仅为「${target.title}」准备可复用的改进范围。应用下面的配置后，直接在这里运行一次，再回复具体差异；原 Skill 与已有结果保留，新候选需验证后采用。`, operations,
      summary: proposal.summary, baseFingerprint: documentFingerprint(document) };
    turn.actions = [{ id: 'action-' + randomUUID(), kind: 'mark-applied', label: '应用任务配置', context }];
  }
  prepareFeedback(turn, document, bound, intent, automatic = false) {
    if (!bound.run || !TERMINAL.has(bound.run.status)) {
      if (intent === 'skill') this.prepareLearningScope(turn, document, bound.context);
      else { turn.status = 'complete'; turn.actions = []; turn.assistant = { text: '当前还没有可关联的已结束结果。请先在这里点击“运行当前流程”；结果出现后，直接回复这段对话即可提出反馈。' }; }
      return;
    }
    if (intent === 'skill' && automatic) {
      if (!bound.node) {
        const targets = this.learningTargets(bound.run.document, bound.context, turn.user.text);
        if (targets.length !== 1) {
          turn.status = 'awaiting_action'; turn.assistant = { text: '请选择这份结果中需要以后沿用改进规则的能力，其余能力保持原样。' };
          turn.actions = targets.map(node => ({ id: 'action-' + randomUUID(), kind: 'select-run', label: node.title,
            context: { ...bound.context, nodeId: node.id } })); return;
        }
        bound = this.bindContext(turn.workflowId, { ...bound.context, nodeId: targets[0].id }, document);
      }
      let branch;
      try { branch = learningBranch(bound.run.document); } catch { branch = null; }
      if (!branch) { this.prepareLearningScope(turn, document, bound.context); return; }
      const eligibility = this.app.feedback.get(bound.run.id);
      if (!eligibility.canReview) { turn.status = 'complete'; turn.actions = []; turn.assistant = { text: eligibility.reason + ' 可以继续在这里描述要调整的任务配置。' }; return; }
      try { this.selectedLearningTargets(bound); }
      catch { this.prepareLearningScope(turn, document, bound.context); return; }
    }
    turn.status = 'awaiting_action';
    turn.assistant = { text: intent === 'skill' ? '已关联这份结果与对应能力。确认后将生成以后可沿用的规则候选，验证并采用前保持原版本。' : '已关联这份结果。反馈只会记录本次问题；如希望以后沿用，请继续说明“以后都按这个规则”。' };
    turn.actions = [{ id: 'action-' + randomUUID(), kind: intent === 'skill' ? 'learn-feedback' : 'record-feedback',
      label: intent === 'skill' ? '生成可复用规则候选' : '保存这份结果的反馈', context: bound.context, feedback: turn.user.text }];
    if (intent === 'feedback' && automatic) {
      const context = this.resultProducerContext(bound);
      if (context) {
        const node = bound.run.document.nodes.find(node => node.id === context.nodeId);
        turn.actions.push({ id: 'action-' + randomUUID(), kind: 'rerun', label: `按反馈重做「${node.title}」`, context, feedback: turn.user.text });
        turn.assistant.text += ' 也可以选择按反馈重做这次结果，原能力版本保持固定。';
      }
    }
  }
  resultProducerContext(bound) {
    const run = bound.run, document = run.document;
    const outputs = document.nodes.filter(node => node.type === 'output' && node.config.stage !== 'intermediate');
    const source = bound.node || (outputs.length === 1 ? outputs[0] : null);
    if (!source) return null;
    const producers = new Set(['skill', 'tool', 'transform', 'subflow', 'foreach', 'loop']), found = new Set(), seen = new Set(), pending = [source.id];
    while (pending.length) {
      const id = pending.pop(); if (seen.has(id)) continue; seen.add(id);
      const node = document.nodes.find(node => node.id === id);
      if (producers.has(node?.type)) { found.add(id); continue; }
      for (const edge of document.edges.filter(edge => edge.targetNode === id)) pending.push(edge.sourceNode);
    }
    if (found.size !== 1) return null;
    const nodeId = [...found][0], record = run.nodes[nodeId];
    // Fixed tools and code do not consume a prose revision. Keep their explicit
    // rerun command available without claiming it will implement new rules.
    if (document.nodes.find(node => node.id === nodeId)?.type !== 'skill') return null;
    if (!record || !Number.isSafeInteger(record.attempt) || record.attempt < 1 || !record.attemptId) return null;
    try {
      return this.bindContext(run.workflowId, { runId: run.id, nodeId, attempt: record.attempt, attemptId: record.attemptId,
        artifactHashes: (record.artifacts || []).map(item => ({ id: item.id, sha256: item.sha256 })) }, document).context;
    } catch { return null; }
  }
  async message(workflowId, input) {
    this.assertOpen(workflowId, true);
    object(input, ['clientMessageId', 'text', 'context', 'document', 'intent', 'page'], '对话请求');
    identifier(input.clientMessageId, '消息幂等 ID'); text(input.text, '消息');
    if (input.intent !== undefined && !['auto', 'workflow', 'redo', 'skill', 'discuss', 'feedback'].includes(input.intent)) fail('对话意图无效。');
    const document = safeDocument(input.document, workflowId), requestDigest = digest(input);
    const existing = this.db.prepare('SELECT id,private_value FROM workflow_conversation_turns WHERE workflow_id=? AND client_message_id=?').get(workflowId, input.clientMessageId);
    if (existing) {
      if (JSON.parse(existing.private_value).requestDigest !== requestDigest) fail('相同消息 ID 不能对应不同内容。', 409);
      return { ...this.get(workflowId), turn: this.readTurn(workflowId, existing.id).turn };
    }
    const requestedContext = contextInput(input.context);
    const intent = conversationIntent(input.text, input.intent, requestedContext), automatic = !input.intent || input.intent === 'auto';
    const candidates = ['feedback', 'skill'].includes(intent) && !requestedContext.runId ? this.feedbackRuns(workflowId, requestedContext) : [];
    const selectedContext = candidates.length === 1 ? { ...requestedContext, runId: candidates[0].id } : requestedContext;
    const bound = this.bindContext(workflowId, selectedContext, document);
    const createdAt = now(), turn = { id: 'turn-' + randomUUID(), workflowId, clientMessageId: input.clientMessageId,
      user: { text: input.text, context: bound.context, intent },
      assistant: { text: '正在整理你的要求…' }, actions: [], status: 'thinking', createdAt, updatedAt: createdAt };
    this.db.prepare('INSERT INTO workflow_conversation_turns(id,workflow_id,client_message_id,created_at,value,private_value) VALUES(?,?,?,?,?,?)')
      .run(turn.id, workflowId, input.clientMessageId, createdAt, JSON.stringify(turn), JSON.stringify({ requestDigest, document, automatic, page: input.page ? sanitizeDiagnosticEvidence(input.page) : null }));
    this.update(turn);
    const direct = directIntent(input.text, intent);
    if (direct) {
      const candidates = direct.action.startsWith('review-') ? this.pending(workflowId) : [];
      const exact = !!bound.node && Number.isSafeInteger(input.context?.attempt) && input.context.attempt > 0
        && typeof input.context?.attemptId === 'string' && !!input.context.attemptId
        && (!direct.action.startsWith('review-') || bound.node.type === 'human' && bound.record.status === 'waiting_review');
      if (exact) {
        turn.status = 'awaiting_action'; turn.assistant.text = '已明确回复对象，正在处理。';
        turn.actions = [{ id: 'action-' + randomUUID(), kind: direct.action, label: direct.action, context: bound.context, feedback: direct.feedback || '' }];
        this.update(turn);
        return this.action(workflowId, turn.id, { action: direct.action, actionId: turn.actions[0].id });
      }
      turn.status = 'awaiting_action'; turn.assistant.text = '请明确选择这条回复对应的运行节点，避免操作其他版本或并行审核。';
      turn.actions = candidates.map(item => ({ id: 'action-' + randomUUID(), kind: direct.action, label: item.label, context: item.context, feedback: direct.feedback || '' }));
      this.update(turn); this.emit(workflowId);
      return { ...this.get(workflowId), turn };
    }
    if (intent === 'feedback' || intent === 'skill') {
      if (candidates.length > 1) {
        turn.status = 'awaiting_action'; turn.assistant = { text: '有多份已结束结果，请在这里选择本条反馈对应的那一份。' };
        turn.actions = candidates.map(run => ({ id: 'action-' + randomUUID(), kind: 'select-run', label: `${run.document.title || '本次结果'} · ${run.startedAt || run.id.slice(0, 8)} · ${run.status}`,
          context: { ...requestedContext, runId: run.id } }));
      } else if (intent === 'feedback' && !automatic && !bound.run) {
        // Existing explicit feedback callers may intentionally record a general
        // workflow note. Automatic result feedback asks for a real result.
        turn.status = 'awaiting_action'; turn.assistant = { text: '这条反馈会关联当前工作流，供后续修改参考。' };
        turn.actions = [{ id: 'action-' + randomUUID(), kind: 'record-feedback', label: '保存反馈', context: bound.context, feedback: input.text }];
      } else this.prepareFeedback(turn, document, bound, intent, automatic);
      this.update(turn); this.emit(workflowId);
    } else {
      this.emit(workflowId);
      const controller = new AbortController(); this.active.set(turn.id, controller);
      void this.generate(turn, document, bound, controller);
    }
    return { ...this.get(workflowId), turn };
  }
  async generate(turn, document, bound, controller) {
    try {
      const previousTurns = this.get(turn.workflowId).conversation.turns.filter(item => item.id !== turn.id && item.status !== 'thinking');
      // The broker validates scope and freshness before reusing read-only facts.
      // A previous checkpoint never authorizes replaying proposals or operations.
      const checkpoint = previousTurns.findLast(item => ['error', 'interrupted'].includes(item.status) && item.assistant?.checkpoint)?.assistant.checkpoint;
      const history = previousTurns.slice(-10)
        .flatMap(item => [{ role: 'user', text: item.user.text.slice(0, 3000) }, { role: 'assistant', text: item.assistant.text.slice(0, 3000) }]);
      // Never send inputs, outputs, artifact contents, training samples or validation
      // records to this planning session. Only the selected execution metadata.
      const context = { ...bound.context, ...(bound.run ? { run: { id: bound.run.id, status: bound.run.status,
        ...(bound.node ? { node: { id: bound.node.id, title: bound.node.title, type: bound.node.type, status: bound.record.status } } : {}) } } : {}) };
      const page = this.readTurn(turn.workflowId, turn.id).privateValue.page;
      const result = await this.planner(this.app, { text: turn.user.text, document, context, history, page, checkpoint, signal: controller.signal,
        onProgress: (message, progress) => { if (!this.closed && !controller.signal.aborted) {
          turn.assistant.text = message; if (progress) turn.assistant.progress = clone(progress);
          turn.updatedAt = now(); this.update(turn); this.emit(turn.workflowId);
        } },
        onCheckpoint: value => { if (!this.closed) {
          turn.assistant.checkpoint = clone(value); turn.assistant.evidence = clone(value.evidence || []);
          turn.updatedAt = now(); this.update(turn); this.emit(turn.workflowId);
        } },
        onSession: sessionId => { if (!this.closed) { turn.modelSessionId = sessionId; turn.modelSessionIds = [...new Set([...(turn.modelSessionIds || []), sessionId])]; this.update(turn); } } });
      if (this.closed || controller.signal.aborted) return;
      this.app.workflowLibrary.assertRunnable(turn.workflowId);
      turn.assistant = { ...turn.assistant, text: text(result.text || result.summary || '已生成建议。', 'AI 回复', { max: 24000 }),
        ...(result.evidence?.length ? { evidence: result.evidence } : {}),
        ...(result.operations?.length ? { operations: clone(result.operations), baseFingerprint: result.baseFingerprint || documentFingerprint(document), summary: result.summary || '' } : {}) };
      turn.status = result.operations?.length ? 'proposed' : 'complete'; turn.updatedAt = now();
      finishDiagnostic(turn.assistant, 'complete');
      if (result.operations?.length) turn.actions = [{ id: 'action-' + randomUUID(), kind: 'mark-applied', label: '应用到画布', context: turn.user.context }];
      this.update(turn); this.emit(turn.workflowId);
    } catch (error) {
      if (!this.closed) {
        turn.status = controller.signal.aborted ? 'interrupted' : 'error';
        turn.assistant = { ...turn.assistant, text: redact(error.message).slice(0, 4000) };
        finishDiagnostic(turn.assistant, turn.status, turn.assistant.text);
        turn.updatedAt = now(); this.update(turn); this.emit(turn.workflowId);
      }
    } finally { this.active.delete(turn.id); }
  }
  selectedLearningTargets(bound) {
    if (!bound.node) return null;
    const plan = planWorkflow(bound.run.document);
    const allowed = new Set(plan.learningBranch?.improvementNode?.config?.targetSkillNodeIds || []);
    const completed = new Map(this.app.feedback.targets(bound.run).filter(target => target.status === 'complete').map(target => [target.nodeId, target]));
    if (bound.node.type === 'skill') {
      if (!allowed.has(bound.node.id) || !completed.has(bound.node.id)) fail('所选 Skill 不在明确允许改进的学习支路中，或缺少已完成的固定版本。', 409);
      return [bound.node.id];
    }
    // Follow data dependencies and stop at the nearest Skill on each branch.
    // A tool/artifact may map to a Skill only when that declared provenance is
    // unique; feedback is never broadened to every Skill in the workflow.
    const found = new Set(), seen = new Set(), pending = [bound.node.id];
    while (pending.length) {
      const id = pending.pop(); if (seen.has(id)) continue; seen.add(id);
      const node = plan.byId?.get(id) || plan.document.nodes.find(node => node.id === id);
      if (node?.type === 'skill') { if (allowed.has(id) && completed.has(id)) found.add(id); continue; }
      for (const edge of plan.document.edges.filter(edge => edge.targetNode === id)) pending.push(edge.sourceNode);
    }
    if (found.size !== 1) fail(found.size > 1 ? '此产物对应多个可改进的 Skill，请先选择具体 Skill 节点再反馈学习。' : '未找到此产物唯一且明确允许改进的上游 Skill，请先选择具体 Skill 节点。', 409);
    return [...found];
  }
  async action(workflowId, turnId, input) {
    this.assertOpen(workflowId, true);
    object(input, ['action', 'actionId', 'context', 'feedback', 'document', 'planFingerprint'], '对话操作');
    if (!ACTIONS.has(input.action)) fail('对话操作无效。');
    const key = workflowId + ':' + turnId;
    if (this.mutations.has(key)) fail('此回复正在处理中，请稍候。', 409);
    const { turn, privateValue } = this.readTurn(workflowId, turnId);
    if (input.action === 'interrupt-turn') { this.active.get(turnId)?.abort(); return { ...this.get(workflowId), turn }; }
    if (input.action === 'dismiss-turn') {
      if (turn.status === 'dismissed') return { ...this.get(workflowId), turn };
      if (!['proposed', 'error', 'interrupted', 'awaiting_action'].includes(turn.status)) fail('只能结束尚未解决的建议或失败事项。', 409);
      if (turn.status === 'awaiting_action' && turn.actions.some(card => card.kind.startsWith('review-'))) fail('人工审核仍在等待，请明确通过、要求修改或停止审核分支。', 409);
      turn.resolution = { kind: 'dismissed', previousStatus: turn.status, at: now() };
      turn.status = 'dismissed'; turn.updatedAt = now();
      // Keep both the request and the original answer/outcome as historical
      // evidence. Dismissing a chat item never changes a run or a human gate.
      this.update(turn); this.emit(workflowId);
      return { ...this.get(workflowId), turn };
    }
    if (turn.status === 'dismissed') fail('此事项已结束，请发送新的要求。', 409);
    if (turn.outcome) {
      if (turn.outcome.action !== input.action || input.actionId && turn.outcome.actionId !== input.actionId) fail('此轮回复已经执行过其他操作。', 409);
      return { ...this.get(workflowId), turn };
    }
    const card = turn.actions.find(item => item.id === input.actionId && item.kind === input.action)
      || (!input.actionId && turn.actions.length === 1 && turn.actions[0].kind === input.action ? turn.actions[0] : null);
    if (!card) fail('请使用当前回复提供的操作入口。', 409);
    const context = input.context === undefined ? card.context : contextInput(input.context);
    if (input.context !== undefined && JSON.stringify(context) !== JSON.stringify(card.context)) fail('回复对象不能在执行时替换，请发送新的消息。', 409);
    const feedback = input.feedback === undefined ? card.feedback || turn.user.text : text(input.feedback, '修改要求', { required: false });
    const document = privateValue.document;
    const checkedContext = input.action === 'mark-applied' ? Object.fromEntries(Object.entries(context).filter(([key]) => key !== 'documentRevision')) : context;
    const bound = input.action === 'mark-applied' ? { context } : this.bindContext(workflowId, checkedContext, document, { exact: input.action.startsWith('review-') || input.action === 'rerun', review: input.action.startsWith('review-') });
    if (input.action === 'select-run' || input.action === 'select-learning-target') {
      turn.selection = { context: bound.context, selectedAt: now() };
      if (input.action === 'select-learning-target') this.prepareLearningScope(turn, document, bound.context);
      else this.prepareFeedback(turn, document, bound, turn.user.intent, privateValue.automatic);
      turn.updatedAt = now(); this.update(turn); this.emit(workflowId);
      return { ...this.get(workflowId), turn };
    }
    if (input.action === 'review-revise' && !feedback.trim()) fail('请填写具体修改要求。');
    if (input.action === 'mark-applied') {
      if (!Array.isArray(turn.assistant.operations) || !turn.assistant.operations.length) fail('此轮没有可应用的流程修改。', 409);
      if (input.planFingerprint !== turn.assistant.baseFingerprint) fail('流程修改计划版本不匹配。', 409);
      let generated = 0;
      const applied = applyWorkflowOperations(document, turn.assistant.operations, { idFactory: prefix => `${prefix}-${turn.id}-${++generated}` });
      const expected = applied.document || applied;
      const actual = safeDocument(input.document, workflowId);
      if (documentFingerprint(expected) !== documentFingerprint(actual)) fail('画布内容与本轮操作计划不一致，请重新生成建议。', 409);
    }
    this.mutations.add(key);
    turn.outcome = { action: input.action, actionId: card.id, status: 'started', startedAt: now() }; turn.updatedAt = now(); this.update(turn);
    try {
      let result = {};
      if (input.action.startsWith('review-')) {
        const run = await this.app.workflows.approve(bound.run.id, { nodeId: bound.node.id, action: input.action.slice(7), feedback,
          expectedAttempt: bound.record.attempt, expectedAttemptId: bound.record.attemptId, expectedArtifactHashes: bound.context.artifactHashes });
        result = { rootWorkflowId: workflowId, workflowId: run.workflowId, ...(run.parentRunId ? { parentRunId: run.parentRunId } : {}), runId: run.id, runStatus: run.status };
      } else if (input.action === 'rerun') {
        const run = await this.app.workflows.rerun(bound.run.id, { nodeIds: [bound.node.id], feedback,
          expectedNodes: [{ nodeId: bound.node.id, attempt: bound.record.attempt, attemptId: bound.record.attemptId, artifactHashes: bound.context.artifactHashes }] });
        result = { rootWorkflowId: workflowId, workflowId: run.workflowId, ...(run.parentRunId ? { parentRunId: run.parentRunId } : {}), runId: run.id, runStatus: run.status };
      } else if (input.action === 'learn-feedback') {
        if (!bound.run || !TERMINAL.has(bound.run.status)) fail('请先选择普通执行模式的已结束运行。', 409);
        const eligibility = this.app.feedback.get(bound.run.id);
        if (!eligibility.canReview) fail(eligibility.reason, 409);
        const targetNodeIds = this.selectedLearningTargets(bound);
        const previous = this.app.feedback.current(bound.run.id);
        const options = { expectedRevision: previous?.revision || 0, comment: feedback };
        const record = targetNodeIds ? this.app.feedback.saveScoped(bound.run.id, { ...options, targetNodeIds })
          : this.app.feedback.save(bound.run.id, options);
        this.app.feedback.learningRequest(bound.run.id, { feedbackRevision: record.revision });
        const learning = await this.app.learning.startFeedback({ runId: bound.run.id, feedbackRevision: record.revision });
        result = { rootWorkflowId: workflowId, workflowId: bound.run.workflowId, runId: bound.run.id, feedbackRevision: record.revision, learningId: learning.id,
          targetNodeIds: learning.config?.trainableNodeIds || targetNodeIds || record.targets.map(target => target.nodeId) };
      } else if (input.action === 'record-feedback') {
        result = { feedback: { id: turn.id, text: feedback, context: bound.context, scope: bound.node ? bound.context.artifactIds?.length ? 'artifact' : 'node' : bound.run ? 'run' : 'workflow' } };
      } else if (input.action === 'mark-applied') result = { documentFingerprint: documentFingerprint(input.document) };
      if (this.closed) return { turn };
      turn.status = 'complete'; turn.assistant.text = ({ 'review-approve': '审核已通过，工作流继续执行。', 'review-revise': '修改意见已记录，正在重做对应产物及其后续节点。', 'review-stop': '已停止此审核分支。', rerun: '已提交所选节点及其后续节点重跑。', 'record-feedback': '反馈已保存，并绑定本轮选择的对象与版本。', 'learn-feedback': '已启动反馈学习，生成的 Skill 候选仍需验证和应用。', 'mark-applied': '本轮节点操作已应用到画布，可继续手动调整或撤销。' })[input.action];
      turn.outcome = { ...turn.outcome, ...result, status: 'complete', completedAt: now() }; turn.updatedAt = now(); this.update(turn);
    } catch (error) {
      if (this.closed) return { turn };
      // A rejected or uncertain request is durable too; a retry never replays an
      // external side effect. A new user turn is needed after inspecting state.
      turn.status = 'error'; turn.assistant.text = redact(error.message).slice(0, 4000);
      turn.outcome = { ...turn.outcome, status: error.httpStatus ? 'rejected' : 'unknown', error: turn.assistant.text, completedAt: now() }; turn.updatedAt = now(); this.update(turn);
    } finally { this.mutations.delete(key); }
    this.emit(workflowId);
    return { ...this.get(workflowId), turn };
  }
  async close() {
    this.closed = true; this.app.off('event', this.onEvent);
    for (const [id, controller] of this.active) {
      controller.abort();
      const row = this.db.prepare('SELECT workflow_id FROM workflow_conversation_turns WHERE id=?').get(id);
      if (!row) continue;
      const { turn } = this.readTurn(row.workflow_id, id); turn.status = 'interrupted'; turn.assistant.text = '对话生成已停止；系统不会自动重放。';
      finishDiagnostic(turn.assistant, 'interrupted', turn.assistant.text); turn.updatedAt = now(); this.update(turn);
    }
    this.active.clear();
  }
}
