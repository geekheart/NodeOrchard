import { planWorkflow } from '../../shared/workflow/workflow-plan.mjs';

const TERMINAL = new Set(['complete', 'error', 'interrupted', 'unknown']);
const REVISION = /^sha256:[a-f0-9]{64}$/;
const fail = (message, httpStatus = 400) => { throw Object.assign(new Error(message), { httpStatus }); };
const clone = value => JSON.parse(JSON.stringify(value));

function strictObject(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${label}必须是对象。`);
  if (Object.getOwnPropertySymbols(value).length) fail(`${label}不允许 Symbol 字段。`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== fields.length || fields.some(key => !Object.hasOwn(descriptors, key))
    || Object.keys(descriptors).some(key => !fields.includes(key))) fail(`${label}字段不符合要求。`);
  if (Object.values(descriptors).some(descriptor => !Object.hasOwn(descriptor, 'value'))) fail(`${label}不能包含访问器。`);
  return value;
}

function revision(value, label, allowZero = false) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) fail(`${label}必须是${allowZero ? '非负' : '正'}整数。`);
  return value;
}

export class WorkflowFeedback {
  constructor(app) {
    this.app = app;
    this.db = app.store.db;
    // Each save appends an immutable revision. The transaction serializes CAS
    // across windows and server processes without editing the original run.
    this.db.exec(`CREATE TABLE IF NOT EXISTS workflow_feedback (
      run_id TEXT NOT NULL REFERENCES workflow_runs(id), revision INTEGER NOT NULL,
      workflow_id TEXT NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY(run_id, revision)
    );`);
  }

  run(runId) {
    if (typeof runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(runId)) fail('无效的运行 ID。');
    return this.app.workflows.get(runId);
  }

  targets(run) {
    let planned;
    try { planned = planWorkflow(run.document); }
    catch { fail('此运行缺少可核对的执行快照，不能评价 Skill。', 409); }
    if (run.workflowId !== planned.document.id) fail('运行与工作流快照不一致，不能评价 Skill。', 409);
    return planned.skillNodes.flatMap(node => {
      const matches = (run.skills || []).filter(skill => skill.nodeId === node.id);
      if (matches.length !== 1) return [];
      const actual = matches[0];
      if (!REVISION.test(actual.revision || '') || actual.revision !== node.config.version
        || actual.name !== node.config.skillRef) return [];
      return [{ nodeId: node.id,
        title: node.title,
        skillRef: actual.name, version: actual.revision, status: run.nodes?.[node.id]?.status || 'pending' }];
    });
  }

  current(runId) {
    const row = this.db.prepare('SELECT value FROM workflow_feedback WHERE run_id=? ORDER BY revision DESC LIMIT 1').get(runId);
    return row ? JSON.parse(row.value) : null;
  }

  get(runId) {
    const run = this.run(runId);
    const targets = this.targets(run);
    const reason = run.importedArchive ? '导入的历史运行只供查看，请从当前工作流新建运行后再评价。'
      : !TERMINAL.has(run.status) ? '请等待运行结束后再评价 Skill。'
      : run.learningId || run.memoryScopeId || run.document?.mode !== 'execute' ? '学习样例不能作为普通执行反馈，请评价执行模式的运行。'
        : !targets.some(target => target.status === 'complete') ? '此运行没有已完成且版本可核对的 Skill 节点。' : '';
    return { feedback: this.current(runId), targets, canReview: !reason, reason };
  }

  getRevision(runId, feedbackRevision) {
    this.run(runId);
    revision(feedbackRevision, 'feedbackRevision');
    const row = this.db.prepare('SELECT value FROM workflow_feedback WHERE run_id=? AND revision=?').get(runId, feedbackRevision);
    if (!row) fail('此运行的反馈版本不存在。', 404);
    return JSON.parse(row.value);
  }

  assertEvaluable(run) {
    if (run.importedArchive) fail('导入的历史运行只供查看，请从当前工作流新建运行后再评价或学习。', 409);
    if (!TERMINAL.has(run.status)) fail('请等待运行结束后再评价 Skill。', 409);
    if (run.learningId || run.memoryScopeId || run.document?.mode !== 'execute') fail('学习样例不能作为普通执行反馈，请评价执行模式的运行。', 409);
  }

  save(runId, input) {
    const request = strictObject(input, ['expectedRevision', 'comment'], '反馈');
    revision(request.expectedRevision, 'expectedRevision', true);
    if (request.expectedRevision === Number.MAX_SAFE_INTEGER) fail('反馈版本已超出可保存范围。');
    if (typeof request.comment !== 'string' || request.comment.length > 8000) fail('综合反馈必须是最多 8000 个字符的文字。');
    const run = this.run(runId);
    this.assertEvaluable(run);
    const targets = this.targets(run).filter(target => target.status === 'complete');
    if (!targets.length) fail('此运行没有已完成且版本可核对的 Skill 节点。', 409);
    let record;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.current(runId);
      if (request.expectedRevision !== (previous?.revision || 0)) fail('反馈已由其它窗口更新，请重新读取后再保存。', 409);
      const now = new Date().toISOString();
      record = { schemaVersion: 2, runId, workflowId: run.workflowId, revision: request.expectedRevision + 1,
        createdAt: previous?.createdAt || now, updatedAt: now, comment: request.comment, targets };
      this.db.prepare('INSERT INTO workflow_feedback(run_id,revision,workflow_id,value) VALUES(?,?,?,?)')
        .run(runId, record.revision, record.workflowId, JSON.stringify(record));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.app.publish?.('workflow.feedback', null, clone(record));
    return clone(record);
  }

  // Internal conversation entry point. The public comprehensive-feedback save
  // envelope remains unchanged; only explicitly selected declared Skills enter
  // this append-only scope, never every Skill from the same execution.
  saveScoped(runId, input) {
    const request = strictObject(input, ['expectedRevision', 'comment', 'targetNodeIds'], '定向反馈');
    revision(request.expectedRevision, 'expectedRevision', true);
    if (request.expectedRevision === Number.MAX_SAFE_INTEGER) fail('反馈版本已超出可保存范围。');
    if (typeof request.comment !== 'string' || !request.comment.trim() || request.comment.length > 8000 || request.comment.includes('\0')) fail('请填写最多 8000 字的具体改进意见。');
    if (!Array.isArray(request.targetNodeIds) || !request.targetNodeIds.length || request.targetNodeIds.length > 200
      || Object.getOwnPropertySymbols(request.targetNodeIds).length
      || Object.entries(Object.getOwnPropertyDescriptors(request.targetNodeIds)).some(([key, field]) => key !== 'length'
        && (!/^(0|[1-9]\d*)$/.test(key) || !Object.hasOwn(field, 'value')))) fail('定向反馈需要明确的 Skill 节点列表。');
    const ids = [...request.targetNodeIds];
    if (new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id))) fail('定向反馈的 Skill 节点列表无效。');
    const run = this.run(runId); this.assertEvaluable(run);
    let plan;
    try { plan = planWorkflow(run.document); } catch { fail('运行缺少可核对的学习支路。', 409); }
    const allowed = plan.learningBranch?.improvementNode?.config?.targetSkillNodeIds || [];
    if (!allowed.length || ids.some(id => !allowed.includes(id))) fail('所选 Skill 不在工作流明确允许改进的学习支路中。', 409);
    const targets = this.targets(run).filter(target => ids.includes(target.nodeId) && target.status === 'complete');
    if (targets.length !== ids.length) fail('所选 Skill 尚未完成，或其实际执行版本无法核对。', 409);
    let record;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.current(runId);
      if (request.expectedRevision !== (previous?.revision || 0)) fail('反馈已由其它窗口更新，请重新读取后再保存。', 409);
      const now = new Date().toISOString();
      record = { schemaVersion: 3, scope: 'selected', runId, workflowId: run.workflowId, revision: request.expectedRevision + 1,
        createdAt: previous?.createdAt || now, updatedAt: now, comment: request.comment, targets };
      this.db.prepare('INSERT INTO workflow_feedback(run_id,revision,workflow_id,value) VALUES(?,?,?,?)')
        .run(runId, record.revision, record.workflowId, JSON.stringify(record));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.app.publish?.('workflow.feedback', null, clone(record));
    return clone(record);
  }

  learningRequest(runId, input) {
    const request = strictObject(input, ['feedbackRevision'], '反馈学习请求');
    revision(request.feedbackRevision, 'feedbackRevision');
    const run = this.run(runId);
    this.assertEvaluable(run);
    const record = this.current(runId);
    if (!record || record.revision !== request.feedbackRevision) fail('反馈版本已变化，请先读取并保存最新反馈。', 409);
    const targets = new Map(this.targets(run).map(target => [target.nodeId, target]));
    if (record.schemaVersion === 3) {
      if (record.scope !== 'selected' || typeof record.comment !== 'string' || !record.comment.trim()
        || record.comment.length > 8000 || record.comment.includes('\0')) fail('定向反馈缺少具体改进意见。', 409);
      const allowed = planWorkflow(run.document).learningBranch?.improvementNode?.config?.targetSkillNodeIds || [];
      if (!Array.isArray(record.targets) || !record.targets.length || record.targets.length > 200
        || new Set(record.targets.map(target => target?.nodeId)).size !== record.targets.length) fail('定向反馈缺少有效的 Skill 范围。', 409);
      for (const item of record.targets) {
        const actual = targets.get(item?.nodeId);
        if (!actual || actual.status !== 'complete' || !allowed.includes(actual.nodeId)
          || Object.keys(item).length !== Object.keys(actual).length || Object.keys(actual).some(key => item[key] !== actual[key])) {
          fail('定向反馈与原运行 Skill 版本或允许改进的范围不一致，请重新保存反馈。', 409);
        }
      }
      return clone(record);
    }
    if (record.schemaVersion === 2) {
      if (typeof record.comment !== 'string' || !record.comment.trim() || record.comment.length > 8000) fail('请先填写具体问题和期望，再根据反馈改进 Skill。');
      const completed = [...targets.values()].filter(target => target.status === 'complete');
      if (!completed.length || !Array.isArray(record.targets) || record.targets.length !== completed.length
        || record.targets.some((target, index) => !target || Object.keys(completed[index]).some(key => target[key] !== completed[index][key]))) {
        fail('反馈与运行的 Skill 版本不一致，请重新保存综合反馈。', 409);
      }
      return clone(record);
    }
    // Old per-Skill reviews remain readable and usable without rewriting their
    // durable records. The learning controller combines those selected comments.
    const selected = (Array.isArray(record.items) ? record.items : []).filter(item => item.selectedForLearning);
    if (!selected.length) fail('请至少选择一个有具体改进意见的 Skill。');
    for (const item of selected) {
      const target = targets.get(item.nodeId);
      if (!target || target.status !== 'complete' || target.skillRef !== item.skillRef || target.version !== item.version
        || !item.comment.trim()) fail('已选反馈与运行的 Skill 版本不一致，请重新评价。', 409);
    }
    return clone(record);
  }
}
