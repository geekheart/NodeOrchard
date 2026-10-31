import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, realpath, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, relative, isAbsolute, basename } from 'node:path';
import { sanitizeDiagnosticText } from './app-diagnostics.mjs';
import { runMaintenanceReproduction } from './application-maintenance-reproduction.mjs';
import { validateDiagnosticArguments } from './assistant-diagnostic-turn.mjs';
import { applyWorkflowOperations } from '../shared/workflow/workflow-conversation-commands.mjs';

const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
  && !['__proto__', 'constructor', 'prototype'].includes(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clean = (value, size = 1800) => sanitizeDiagnosticText(String(value || '')).slice(0, size);
const now = () => new Date().toISOString();
const fail = (message, httpStatus = 400) => { throw Object.assign(new Error(message), { httpStatus }); };
const idField = { type: 'string', maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' };
const definition = (name, description, properties, required) => ({ name, description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false }, effect: 'mutation', readOnly: false,
  roles: ['supervisor'], availability: 'available', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } });
export const APPLICATION_MAINTENANCE_TOOLS = Object.freeze([
  definition('maintenance.task', '总控维护任务：start登记本轮目标；inspect读取任务，bind-target绑定已选工作流；checkpoint保存发现；request-source-repair只请求人工开关；continue续接，stop停止。权限不由此修改，未知操作不重放。', {
    action: { enum: ['start', 'inspect', 'bind-target', 'checkpoint', 'request-source-repair', 'continue', 'stop'] }, taskId: idField, operationId: idField,
    expectedRevision: { type: 'integer', minimum: 1 }, workflowId: idField, runId: idField,
    goal: { type: 'string', maxLength: 2000 }, note: { type: 'string', maxLength: 1800 },
  }, ['action']),
  definition('maintenance.experiment', '维护任务的隔离复现/只读相关测试及回读。reproduce仅执行已保存节点快照，verify只运行明确测试副本；必须真实OS沙箱，无源码写权也可验证。status/read-output读原回执，不重放；不运行原工作流、不调用业务模型或代批审核。', {
    action: { enum: ['reproduce', 'verify', 'status', 'read-output'] }, taskId: idField, operationId: idField, expectedRevision: { type: 'integer', minimum: 1 },
    experimentId: idField, nodeId: idField, inputSource: { enum: ['defaults', 'run'] },
    variant: { enum: ['source', 'proposal'] },
    files: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 180, pattern: '^workbench/test/[A-Za-z0-9_-]+\\.test\\.mjs$' } },
    offset: { type: 'integer', minimum: 0 }, stream: { enum: ['stdout', 'stderr', 'result'] }, artifactId: idField,
  }, ['action', 'taskId']),
]);
export const MAINTENANCE_LIMITS = Object.freeze({ segments: 4, activeExperiments: 2, outputCharacters: 1800, artifactBytes: 32 * 1024 * 1024 });

function parameters(args, name) {
  const schema = APPLICATION_MAINTENANCE_TOOLS.find(tool => tool.name === name)?.inputSchema;
  if (!schema || !args || typeof args !== 'object' || Array.isArray(args) || ![Object.prototype, null].includes(Object.getPrototypeOf(args))
    || Reflect.ownKeys(args).some(key => typeof key !== 'string' || !Object.hasOwn(schema.properties, key))
    || Object.values(Object.getOwnPropertyDescriptors(args)).some(field => !Object.hasOwn(field, 'value'))) fail('维护参数无效。');
  const plain = (value, depth = 0) => {
    if (depth > 8) fail('维护参数嵌套过深。');
    if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) return;
    if (!value || typeof value !== 'object' || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value))
      || Object.getOwnPropertySymbols(value).length || Object.values(Object.getOwnPropertyDescriptors(value)).some(field => !Object.hasOwn(field, 'value'))) fail('维护参数必须是纯JSON数据。');
    if (Array.isArray(value) && Object.keys(value).length !== value.length) fail('维护参数不能包含稀疏数组。');
    for (const item of Object.values(value)) plain(item, depth + 1);
  };
  plain(args); validateDiagnosticArguments(args, schema);
  for (const key of schema.required) if (!Object.hasOwn(args, key)) fail('维护参数缺少必要字段。');
  for (const key of ['taskId', 'workflowId', 'runId', 'experimentId', 'operationId', 'nodeId', 'artifactId']) if (args[key] !== undefined && !identifier(args[key])) fail('维护对象身份无效。');
  if (!schema.properties.action.enum.includes(args.action) || args.expectedRevision !== undefined && (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 1)
    || ['goal', 'note'].some(key => args[key] !== undefined && (typeof args[key] !== 'string' || args[key].includes('\0') || args[key].length > schema.properties[key].maxLength))) fail('维护操作或版本无效。');
  return args;
}

export class ApplicationMaintenance {
  constructor(app, owner, { reproduce = runMaintenanceReproduction } = {}) {
    this.app = app; this.owner = owner; this.db = app.store.db; this.reproduce = reproduce; this.active = new Map(); this.closed = false;
    this.root = join(app.config?.dataDir || resolve(app.config?.workspaceRoot || '.', '.maintenance-data'), 'diagnostics', 'maintenance');
    this.db.exec(`CREATE TABLE IF NOT EXISTS assistant_maintenance_tasks(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,source_turn_id TEXT UNIQUE NOT NULL,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assistant_maintenance_experiments(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,admission_key TEXT UNIQUE NOT NULL,value TEXT NOT NULL)`);
    for (const row of this.db.prepare('SELECT id,value FROM assistant_maintenance_experiments').all()) {
      const value = JSON.parse(row.value);
      if (['admitting', 'running'].includes(value.status)) { value.status = 'unknown'; value.updatedAt = now(); this.saveExperiment(value); }
    }
    for (const row of this.db.prepare('SELECT value FROM assistant_maintenance_tasks').all()) {
      const task = JSON.parse(row.value);
      if (task.status === 'running') { task.status = 'unknown'; task.note = '服务重启保留了任务，未重放未确认操作。'; this.save(task); }
    }
  }
  handles(name) { return APPLICATION_MAINTENANCE_TOOLS.some(tool => tool.name === name); }
  read(id) { const row = this.db.prepare('SELECT value FROM assistant_maintenance_tasks WHERE id=?').get(id); if (!row) fail('维护任务不存在。', 404); return JSON.parse(row.value); }
  readExperiment(id) { const row = this.db.prepare('SELECT value FROM assistant_maintenance_experiments WHERE id=?').get(id); if (!row) fail('维护实验不存在。', 404); return JSON.parse(row.value); }
  save(task) { task.updatedAt = now(); this.db.prepare('UPDATE assistant_maintenance_tasks SET value=? WHERE id=?').run(JSON.stringify(task), task.id); }
  saveExperiment(value) { value.updatedAt = now(); this.db.prepare('UPDATE assistant_maintenance_experiments SET value=? WHERE id=?').run(JSON.stringify(value), value.id); }
  latest(conversationId) { const row = this.db.prepare('SELECT value FROM assistant_maintenance_tasks WHERE conversation_id=? ORDER BY rowid DESC LIMIT 1').get(conversationId); return row ? JSON.parse(row.value) : null; }
  forTurn(turnId, conversationId) {
    const row = this.db.prepare("SELECT value FROM assistant_maintenance_tasks WHERE conversation_id=? AND (source_turn_id=? OR json_extract(value,'$.activeTurnId')=?) ORDER BY rowid DESC LIMIT 1").get(conversationId, turnId, turnId);
    return row ? JSON.parse(row.value) : null;
  }
  project(task) {
    if (!task) return null;
    const flags = this.app.assistantPermissionSettings?.get?.()?.supervisor || {}, sourceEnabled = flags.sourceRepair === true;
    return { id: task.id, revision: task.revision, conversationId: task.conversationId, sourceTurnId: task.sourceTurnId, workflowId: task.workflowId,
      goal: clean(task.goal, 600), status: task.status, stage: task.stage, note: clean(task.note), summary: clean(task.summary),
      ...(task.lastExperimentId ? { lastExperiment: this.experimentView(this.readExperiment(task.lastExperimentId)) } : {}),
      ...(task.permissionRequested ? { permissionRequest: { permission: 'supervisor.sourceRepair', enabled: sourceEnabled, settingsUrl: '#/settings',
        reason: clean(task.permissionReason || '此步骤需要修改工作台源码，当前没有源码写权限。', 600) } } : {}),
      canContinue: (!this.owner.lifecycle || this.owner.lifecycle.project(task.conversationId).lifecycle === 'active' && !this.owner.lifecycle.project(task.conversationId).readOnly) && flags.workflowRead === true && flags.appLogs === true && (['ready', 'waiting_continue', 'failed', 'candidate_verified', 'verified'].includes(task.status) || task.status === 'waiting_permission' && sourceEnabled),
      canStop: task.status !== 'stopped', originalWorkflowModified: false, originalWorkflowExecuted: false,
      evidenceCount: task.evidence?.length || 0, recentEvidence: (task.evidence || []).slice(-6).map(({ tool, status, at, finding }) => ({ tool, status, at, finding })),
      segment: task.segment || 1, createdAt: task.createdAt, updatedAt: task.updatedAt };
  }
  experimentView(value) {
    return { id: value.id, kind: value.kind, status: value.status, snapshotHash: value.result?.snapshotHash || null,
      sandbox: value.result?.sandbox ? { kind: value.result.sandbox.kind, status: value.result.sandbox.status, code: value.result.sandbox.code } : null,
      ...(value.result?.sourceMatchesSnapshot !== undefined ? { sourceMatchesSnapshot: value.result.sourceMatchesSnapshot } : {}),
      code: value.result?.code || value.result?.errorCode || null, durationMs: value.result?.durationMs || null,
      scope: value.kind === 'verify' ? 'isolated-source-tests' : 'isolated-node-reproduction',
      artifacts: (value.result?.artifacts || []).slice(0, 40).map((item, index) => ({ id: 'artifact-' + digest([value.id, index, item.sha256]).slice(0, 32),
        name: clean(item.name || basename(item.path || item.relativePath || 'artifact'), 180), size: item.size, sha256: item.sha256,
        url: `/api/maintenance/experiments/${value.id}/artifacts/artifact-${digest([value.id, index, item.sha256]).slice(0, 32)}` })),
      replayed: value.replayed === true, createdAt: value.createdAt, updatedAt: value.updatedAt };
  }
  emit(task) {
    this.app.publish?.('application.maintenance', null, { conversationId: task.conversationId, task: this.project(task) });
    try { this.app.logger?.write('info', 'maintenance.task.state', { component: 'maintenance', conversationId: task.conversationId,
      turnId: task.activeTurnId, workflowId: task.workflowId || undefined, operationId: task.id, status: task.status, stage: task.stage, revision: task.revision }); } catch { /* Observation only. */ }
    this.synchronizeTurn(task);
  }
  synchronizeTurn(task) {
    for (const id of [...new Set([task.sourceTurnId, task.activeTurnId])]) {
      try { const turn = this.owner.readTurn(id, task.conversationId); turn.assistant.maintenanceTask = this.project(task); this.owner.save(turn); this.owner.emit(task.conversationId); } catch { /* No foreign or absent chat is created. */ }
    }
  }
  async scope(context, task, { mutation = false, stop = false } = {}) {
    const scope = await this.owner.permissions.current(context.permissionScope);
    if (scope.role !== 'supervisor' || !stop && (!scope.permissions.workflowRead || !scope.permissions.appLogs)) fail('当前总控没有维护读取权限。', 403);
    if (task) {
      if (mutation && !stop) this.owner.lifecycle?.assertWritable(task.conversationId);
      if (scope.workflowBound && (!task.workflowId || task.workflowId !== scope.workflowId)) fail('此维护任务不属于来源工作流。', 403);
      if (task.workflowId) this.owner.permissions.workflow(task.workflowId, scope);
      if (mutation && context.sourceConversationId !== task.conversationId) fail('请在原总控主题继续该维护任务。', 403);
      if (mutation && context.maintenanceTaskId && context.maintenanceTaskId !== task.id) fail('本轮只能推进已绑定的维护任务。', 403);
    }
    return scope;
  }
  source(context, { allowArchived = false } = {}) {
    if (!allowArchived) this.owner.lifecycle?.assertWritable(context.sourceConversationId);
    if (!identifier(context.sourceConversationId) || !identifier(context.diagnosticTurnId)) fail('维护操作缺少真实会话来源。', 403);
    const turn = this.owner.readTurn(context.diagnosticTurnId, context.sourceConversationId);
    if (turn.user?.intent !== 'diagnose' || context.maintenanceAuthorized !== true) fail('只有当前人工排错请求可启动或推进维护。', 403);
    return turn;
  }
  target(context, taskId) {
    const task = taskId ? this.read(taskId) : this.latest(context.sourceConversationId);
    if (!task) fail('当前主题没有维护任务。', 404);
    return task;
  }
  assertTaskContext(taskId, conversationId) { if (!identifier(taskId) || this.read(taskId).conversationId !== conversationId) fail('维护任务不属于此总控主题。', 403); }
  async call(name, raw, context) {
    const args = parameters(raw, name);
    if (name === 'maintenance.task') return this.task(args, context);
    return this.experiment(args, context);
  }
  async refreshVerification(experiment, task, scope, context) {
    if (experiment.kind !== 'verify' || !['pass', 'fail'].includes(experiment.status)) return;
    const result = await this.app.sourceRepairs.verifyReadOnlyTests({ operationId: 'maintenance-' + experiment.admissionKey, files: experiment.files }, {
      role: 'supervisor', existingOnly: true, taskId: task.id, turnId: context.diagnosticTurnId, conversationId: task.conversationId, signal: context.signal,
      authorize: async () => { await this.owner.permissions.current(scope); return true; } });
    experiment.result = result; experiment.status = result.status; this.saveExperiment(experiment);
    if (result.status !== 'pass' && task.lastExperimentId === experiment.id && task.status === 'verified') {
      task.status = 'waiting_continue'; task.note = '源码已变化或验证结果不再适用于当前版本，请核对原回执。'; task.revision++; this.save(task); this.emit(task);
    }
  }
  async task(args, context) {
    const scope = await this.scope(context);
    if (args.action === 'start') {
      const source = this.source(context), workflowId = args.workflowId || context.workflowId || null, runId = args.runId || context.runId || null;
      if (!identifier(args.operationId)) fail('开始维护需要稳定操作ID。');
      if (workflowId) { this.owner.permissions.workflow(workflowId, scope); const record = this.app.workflowLibrary.get(workflowId); if (record.document.mode === 'learn') fail('维护不读取学习材料。', 403); }
      if (runId) { const run = this.owner.permissions.run(runId, scope); if (!workflowId || run.workflowId !== workflowId || run.learningId || run.memoryScopeId || run.parentRunId) fail('复现运行归属或类型无效。', 403); }
      const content = { workflowId, runId, goal: args.goal || source.user.text }, hash = digest(content);
      const previous = this.db.prepare('SELECT value FROM assistant_maintenance_tasks WHERE source_turn_id=?').get(source.id);
      if (previous) { const task = JSON.parse(previous.value); if (task.requestHash !== hash) fail('此来源已有不同维护任务，请读取原任务。', 409); return { task: this.project(task), replayed: true }; }
      const record = workflowId ? this.app.workflowLibrary.get(workflowId) : null, at = now();
      const task = { id: 'maintenance-' + randomUUID(), revision: 1, sourceTurnId: source.id, activeTurnId: source.id, conversationId: context.sourceConversationId,
        workflowId, runId, workflowRevision: record?.revision || null, requestHash: hash, goal: clean(content.goal), status: 'ready', stage: 'diagnose',
        cycle: 1, segment: 1, evidence: [], evidenceVersion: 0, summary: '', sourceEpoch: '', createdAt: at, updatedAt: at };
      this.db.prepare('INSERT INTO assistant_maintenance_tasks VALUES(?,?,?,?)').run(task.id, task.conversationId, source.id, JSON.stringify(task));
      this.emit(task); return { task: this.project(task) };
    }
    const task = this.target(context, args.taskId); await this.scope(context, task, { mutation: args.action !== 'inspect', stop: args.action === 'stop' });
    if (args.action === 'inspect') return { task: this.project(task) };
    this.source(context, { allowArchived: args.action === 'stop' });
    if (args.expectedRevision !== task.revision) fail('维护任务版本已变化，请先读取最新状态。', 409);
    if (args.action === 'stop') return { task: await this.stop(task.id, context.sourceConversationId) };
    if (args.action === 'bind-target') {
      if (task.lastExperimentId || task.candidate || task.workflowId && task.workflowId !== args.workflowId) fail('已绑定的维护目标不能更换，请另起维护任务。', 409);
      if (!identifier(args.workflowId)) fail('请指定实际工作流身份。');
      this.owner.permissions.workflow(args.workflowId, scope);
      const record = this.app.workflowLibrary.get(args.workflowId);
      if (record.document.mode === 'learn') fail('维护不读取学习材料。', 403);
      if (args.runId) { const run = this.owner.permissions.run(args.runId, scope); if (run.workflowId !== args.workflowId || run.learningId || run.memoryScopeId || run.parentRunId) fail('复现运行归属或类型无效。', 403); }
      task.workflowId = args.workflowId; task.workflowRevision = record.revision; task.runId = args.runId || null;
    } else if (args.action === 'request-source-repair') {
      task.permissionRequested = true; task.permissionReason = clean(args.note || '需要修改工作台实现才能修复此问题。', 600);
      task.status = 'waiting_permission'; task.stage = 'repair'; task.note = '请由用户在设置中手动开启源码自修复，再明确继续。';
    } else if (args.action === 'continue') {
      if (['unknown', 'running'].includes(task.status)) fail('结果未确认，只能回读状态，不能重放。', 409);
      if (task.permissionRequested && (!scope.permissions.sourceRepair || scope.readOnly)) fail('源码修复仍不可用，请手动开启后在总控明确继续。', 403);
      if (task.activeTurnId !== context.diagnosticTurnId) { task.cycle++; task.segment = 1; }
      task.activeTurnId = context.diagnosticTurnId; task.status = 'ready'; task.note = '';
    } else if (args.action === 'checkpoint') { task.summary = clean(args.note); }
    task.revision++; this.save(task); this.emit(task); return { task: this.project(task) };
  }
  async experiment(args, context) {
    const task = this.target(context, args.taskId), scope = await this.scope(context, task, { mutation: ['reproduce', 'verify'].includes(args.action) });
    if (['status', 'read-output'].includes(args.action)) {
      if (!args.experimentId && !task.lastExperimentId) fail('此任务还没有隔离实验。', 404);
      const experiment = this.readExperiment(args.experimentId || task.lastExperimentId);
      if (experiment.taskId !== task.id) fail('实验不属于此维护任务。', 403);
      if (!scope.permissions.workspaceRead || experiment.kind === 'verify' && !scope.permissions.sourceRead) fail('实验回读需要当前资料或源码读取权限。', 403);
      await this.refreshVerification(experiment, task, scope, context);
      if (args.action === 'status') return { task: this.project(task), experiment: this.experimentView(experiment) };
      if (args.artifactId) {
        const file = await this.artifact(experiment.id, args.artifactId);
        const value = { task: this.project(task), experiment: this.experimentView(experiment), artifact: { name: file.name, mime: file.mime, size: file.bytes.length } };
        return ['image/png', 'image/jpeg', 'image/webp'].includes(file.mime) ? { value, images: [file.path] } : value;
      }
      const stream = args.stream || 'result', offset = args.offset || 0;
      if (!['stdout', 'stderr', 'result'].includes(stream) || !Number.isSafeInteger(offset) || offset < 0) fail('实验回读参数无效。');
      const result = experiment.result || {}, value = stream === 'result' ? JSON.stringify({ status: result.status, source: result.source, snapshotHash: result.snapshotHash,
        inputHash: result.inputHash, nodeResults: result.nodeResults, files: result.files, sandbox: result.sandbox, code: result.code || result.errorCode })
        : result.logs?.[stream] || result[stream] || '';
      const safe = clean(value, 30000), text = safe.slice(offset, offset + MAINTENANCE_LIMITS.outputCharacters);
      return { task: this.project(task), experiment: this.experimentView(experiment), stream, text, hasMore: offset + text.length < safe.length, nextOffset: offset + text.length };
    }
    this.source(context);
    if (!identifier(args.operationId) || args.expectedRevision !== task.revision) fail('实验需要稳定操作ID与当前任务版本。', 409);
    if (['stopped', 'unknown', 'waiting_permission'].includes(task.status)) fail('维护任务尚不能继续执行，请先核对或完成人工权限步骤。', 409);
    if (!scope.permissions.workspaceRead || args.action === 'verify' && !scope.permissions.sourceRead) fail('隔离验证需要当前资料读取权限；源码测试另需源码只读权限。', 403);
    if (args.action === 'reproduce' && (!task.workflowId || !identifier(args.nodeId))) fail('复现需要绑定工作流和单个节点。');
    if (args.action === 'verify' && (!Array.isArray(args.files) || !args.files.length || args.files.length > 12
      || args.files.some(file => typeof file !== 'string' || !/^workbench\/test\/[A-Za-z0-9_-]+\.test\.mjs$/.test(file)))) fail('请选择明确的相关测试文件。');
    const inputSource = args.inputSource || (task.runId ? 'run' : 'defaults');
    if (!['run', 'defaults'].includes(inputSource) || inputSource === 'run' && !task.runId) fail('没有已绑定的普通运行输入。');
    const variant = args.variant || 'source';
    if (variant === 'proposal' && (!task.candidate || !task.candidate.nodeIds.includes(args.nodeId))) fail('此任务没有已校验的节点修改候选。', 409);
    const payload = { kind: args.action, nodeId: args.nodeId || null, inputSource, variant, candidateHash: variant === 'proposal' ? task.candidate.hash : null, files: args.files ? [...new Set(args.files)].sort() : null,
      cycle: task.cycle, sourceEpoch: task.sourceEpoch }, admissionKey = digest([task.id, payload]);
    const existing = this.db.prepare('SELECT value FROM assistant_maintenance_experiments WHERE admission_key=?').get(admissionKey);
    if (existing) { const value = JSON.parse(existing.value); await this.refreshVerification(value, task, scope, context); value.replayed = true; return { task: this.project(this.read(task.id)), experiment: this.experimentView(value) }; }
    if (this.active.size >= MAINTENANCE_LIMITS.activeExperiments || [...this.active.values()].some(value => value.taskId === task.id)) fail('已有隔离实验正在执行，请读取原回执。', 409);
    const id = 'experiment-' + randomUUID(), directory = join(this.root, task.id, id), at = now();
    const experiment = { id, taskId: task.id, kind: args.action, admissionKey, ...(payload.files ? { files: payload.files } : {}), status: 'admitting', directory, result: null, createdAt: at, updatedAt: at };
    this.db.prepare('INSERT INTO assistant_maintenance_experiments VALUES(?,?,?,?)').run(id, task.id, admissionKey, JSON.stringify(experiment));
    task.lastExperimentId = id; task.status = 'running'; task.stage = args.action === 'verify' ? 'verify' : 'reproduce'; task.activeTurnId = context.diagnosticTurnId;
    task.revision++; this.save(task); this.emit(task);
    const controller = new AbortController(), signal = context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal;
    let checking = false;
    const timer = setInterval(async () => { if (checking) return; checking = true; try { await this.owner.permissions.current(scope); } catch { controller.abort(); } finally { checking = false; } }, 250); timer.unref?.();
    const work = (async () => {
      try {
        experiment.status = 'running'; this.saveExperiment(experiment); await mkdir(directory, { recursive: true, mode: 0o700 });
        if (signal.aborted) throw Object.assign(new Error('隔离实验已停止。'), { code: 'ABORTED' });
        experiment.result = args.action === 'verify'
          ? await this.app.sourceRepairs.verifyReadOnlyTests({ operationId: 'maintenance-' + admissionKey, files: payload.files }, {
            role: 'supervisor', taskId: task.id, turnId: context.diagnosticTurnId, conversationId: task.conversationId, signal,
            authorize: async () => { await this.owner.permissions.current(scope); return true; } })
          : await this.reproduce(this.app, { snapshot: { workflowId: task.workflowId, expectedRevision: task.workflowRevision,
            ...(task.runId ? { runId: task.runId } : {}), nodeIds: [args.nodeId] }, inputSource, materials: [] }, { directory, signal,
              ...(variant === 'proposal' ? { trustedCandidate: { document: task.candidate.document } } : {}) });
        experiment.status = signal.aborted ? 'cancelled' : experiment.result.status;
      } catch (error) { experiment.status = signal.aborted ? 'cancelled' : 'failed'; experiment.result = { status: experiment.status, code: error.code || 'MAINTENANCE_FAILED', error: clean(error.message, 600) }; }
      finally {
        clearInterval(timer); this.active.delete(id);
        if (!this.closed) {
          this.saveExperiment(experiment); const latest = this.read(task.id);
          if (latest.status !== 'stopped') {
            const success = ['passed', 'pass'].includes(experiment.status) && experiment.result?.sandbox?.status === 'verified';
            latest.status = success ? variant === 'proposal' ? 'candidate_verified' : 'verified' : ['unknown', 'running'].includes(experiment.status) ? 'unknown' : 'waiting_continue';
            latest.note = success ? '仅所列隔离范围已通过；原工作流未应用或运行。' : clean(experiment.result?.error || experiment.result?.code || experiment.result?.errorCode || experiment.status, 600);
            latest.evidence = [...latest.evidence, { tool: 'maintenance.experiment', key: id, status: experiment.status, at: now() }].slice(-40);
            latest.evidenceVersion = (latest.evidenceVersion || 0) + 1;
            latest.revision++; this.save(latest); this.emit(latest);
          }
        }
      }
      return experiment;
    })();
    this.active.set(id, { taskId: task.id, controller, work });
    await work; await this.owner.permissions.current(scope);
    return { task: this.project(this.read(task.id)), experiment: this.experimentView(experiment) };
  }
  observe(context, tool, args, result) {
    const task = context.maintenanceTaskId ? this.read(context.maintenanceTaskId) : this.forTurn(context.diagnosticTurnId, context.sourceConversationId);
    if (!task || ['stopped', 'waiting_permission'].includes(task.status)) return;
    const key = digest([tool, args]);
    if (!task.evidence.some(row => row.key === key)) {
      task.evidence.push({ tool, key, at: now(), status: clean(result?.status || result?.value?.status || 'observed', 40),
        finding: clean(result?.error || result?.summary || result?.code || result?.value?.summary || '', 240) });
      task.evidenceVersion = (task.evidenceVersion || 0) + 1;
    }
    task.evidence = task.evidence.slice(-40);
    if (tool === 'app.source.patch' && result?.status === 'applied') {
      const epoch = digest(result.files || result.operationId);
      if (epoch !== task.sourceEpoch) {
        task.sourceEpoch = epoch; task.status = 'ready'; task.stage = 'verify'; task.note = '源码已变化，等待重新验证。'; task.revision++;
        this.save(task); this.emit(task); return;
      }
    }
    this.save(task);
  }
  recordCandidate(context, proposal) {
    const task = context.maintenanceTaskId ? this.read(context.maintenanceTaskId) : this.forTurn(context.diagnosticTurnId, context.sourceConversationId);
    if (!task?.workflowId || !proposal.operations?.length) return null;
    const base = this.app.workflowLibrary.get(task.workflowId);
    if (base.revision !== task.workflowRevision || proposal.targetWorkflowId && proposal.targetWorkflowId !== task.workflowId) fail('维护候选的工作流版本已变化。', 409);
    const document = applyWorkflowOperations(base.document, proposal.operations).document;
    const nodeIds = document.nodes.filter(node => ['tool', 'transform', 'condition'].includes(node.type)
      && JSON.stringify(node.config) !== JSON.stringify(base.document.nodes.find(original => original.id === node.id)?.config)).map(node => node.id);
    task.candidate = { document, hash: digest(document), nodeIds }; task.status = 'ready'; task.stage = 'repair'; task.revision++;
    this.save(task); this.emit(task); return { task: this.project(task), nodeIds };
  }
  finishSegment(conversationId, summary, { segment = 1, taskId } = {}) {
    const task = taskId ? this.read(taskId) : this.latest(conversationId); if (!task) return null;
    if (task.conversationId !== conversationId) fail('维护任务不属于此主题。', 403);
    task.summary = clean(summary); task.segment = segment;
    if (task.status === 'ready') task.status = 'waiting_continue';
    task.revision++; this.save(task); this.emit(task); return this.project(task);
  }
  async stop(id, conversationId) {
    const task = this.read(id); if (task.conversationId !== conversationId) fail('维护任务不属于此主题。', 403);
    for (const value of this.active.values()) if (value.taskId === id) value.controller.abort();
    task.status = 'stopped'; task.revision++; this.save(task); this.emit(task); return this.project(task);
  }
  async stopForTurn(turnId, conversationId) { for (const row of this.db.prepare('SELECT value FROM assistant_maintenance_tasks WHERE conversation_id=?').all(conversationId)) { const task = JSON.parse(row.value); if ([task.sourceTurnId, task.activeTurnId].includes(turnId) && !['verified', 'stopped'].includes(task.status)) await this.stop(task.id, conversationId); } }
  async artifact(experimentId, artifactId) {
    const experiment = this.readExperiment(experimentId), projected = this.experimentView(experiment), index = projected.artifacts.findIndex(item => item.id === artifactId);
    if (index < 0) fail('实验产物不存在。', 404);
    const entry = experiment.result.artifacts[index], file = resolve(experiment.directory, entry.path || entry.relativePath || '');
    const base = await realpath(experiment.directory), actual = await realpath(file), difference = relative(base, actual);
    if (!difference || difference.startsWith('..') || isAbsolute(difference) || (await lstat(file)).isSymbolicLink()) fail('实验产物路径无效。', 403);
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try { const info = await handle.stat(); if (!info.isFile() || info.size > MAINTENANCE_LIMITS.artifactBytes || info.size !== entry.size) fail('实验产物大小已变化。', 409);
      const bytes = await handle.readFile(); if (createHash('sha256').update(bytes).digest('hex') !== String(entry.sha256).replace(/^sha256:/, '')) fail('实验产物版本已变化。', 409);
      return { bytes, path: file, name: projected.artifacts[index].name, mime: /\.png$/i.test(file) ? 'image/png' : /\.jpe?g$/i.test(file) ? 'image/jpeg' : /\.gif$/i.test(file) ? 'image/gif' : /\.webp$/i.test(file) ? 'image/webp' : 'application/octet-stream' };
    } finally { await handle.close(); }
  }
  async close() { if (this.closed) return; for (const value of this.active.values()) value.controller.abort(); await Promise.allSettled([...this.active.values()].map(value => value.work)); this.closed = true; }
}
