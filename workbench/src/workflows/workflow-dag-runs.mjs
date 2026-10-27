// Version 2 dataflow runner. Version 1 remains in workflow-runs.mjs.
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, copyFile, realpath, stat, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, isAbsolute, relative, dirname } from 'node:path';
import { planWorkflow, requiresImageReview, assertImageReviewPaths } from '../../shared/workflow/workflow-plan.mjs';
import { getPorts } from '../../shared/workflow/workflow-model.mjs';
import { withWorkflowInputDefaults } from '../../shared/workflow/workflow-inputs.mjs';
import { WORKFLOW_TOOLS } from '../../shared/workflow/workflow-tools.mjs';
import { validateNodeValue } from '../../shared/workflow/workflow-validation.mjs';
import { redact } from '../hermes-adapter.mjs';
import { stageSubflowArtifacts } from './workflow-subflow-artifacts.mjs';

const TERMINAL = new Set(['complete', 'error', 'interrupted', 'unknown']);
const NODE_DONE = new Set(['complete', 'error', 'blocked', 'skipped', 'cancelled', 'unknown']);
const LEARNING = new Set(['evaluation', 'improvement']);
const RECEIPT_TOOLS = new Set(WORKFLOW_TOOLS.filter(tool => tool.id.startsWith('hdk.')).map(tool => tool.id));
const isReceiptTool = node => node?.type === 'tool' && node.config.executionMode === 'tool' && RECEIPT_TOOLS.has(node.config.toolName);
const clone = value => JSON.parse(JSON.stringify(value));
const fail = (text, status = 400, details) => Object.assign(new Error(text), { httpStatus: status, ...(details ? { details } : {}) });
const errorText = value => redact(String(value?.message || value || '节点执行失败。')).slice(0, 4000);
const now = () => new Date().toISOString();
const fresh = () => ({ status: 'pending', attempt: 0, attemptId: null, input: null, output: null,
  outputText: '', partialText: '', error: '', sessionId: null, startedAt: null, completedAt: null,
  artifacts: [], history: [], logs: { stdout: '', stderr: '' } });

// Conversation replies retain the version actually presented to the user.
// Recheck this snapshot inside the mutation lock and after asynchronous I/O.
export function assertExpectedNodeSnapshot(run, expected) {
  if (!expected || typeof expected.nodeId !== 'string' || !Number.isSafeInteger(expected.attempt) || expected.attempt < 0
    || !Object.hasOwn(expected, 'attemptId') || (expected.attemptId !== null && typeof expected.attemptId !== 'string')
    || !Array.isArray(expected.artifactHashes) || expected.artifactHashes.length > 10000) throw fail('节点版本凭据无效。');
  const record = run?.nodes?.[expected.nodeId];
  if (!record || record.attempt !== expected.attempt || record.attemptId !== expected.attemptId) throw fail('节点尝试已变化，请查看新版本后回复。', 409);
  const hashes = items => {
    const result = new Map();
    for (const item of items) {
      const id = item.id || item.artifactId;
      if (typeof id !== 'string' || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256) || result.has(id)) throw fail('产物版本凭据无效。');
      result.set(id, item.sha256);
    }
    return result;
  };
  const actual = hashes(record.artifacts || []), wanted = hashes(expected.artifactHashes);
  if (actual.size !== wanted.size || [...wanted].some(([id, hash]) => actual.get(id) !== hash)) throw fail('产物版本已变化，请查看新版本后回复。', 409);
  return true;
}

function json(value) {
  const visit = (item, depth = 0, seen = new Set()) => {
    if (depth > 50) throw fail('节点数据嵌套过深。');
    if (item === null || ['string', 'boolean'].includes(typeof item) || (typeof item === 'number' && Number.isFinite(item))) return;
    if (!item || typeof item !== 'object' || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(item)) || seen.has(item)) throw fail('节点必须传递有效 JSON 数据。');
    seen.add(item);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
      if (Array.isArray(item) && key === 'length') continue;
      if (!Object.hasOwn(descriptor, 'value')) throw fail('节点数据不允许访问器。'); visit(descriptor.value, depth + 1, seen);
    }
    seen.delete(item);
  };
  visit(value); const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > 65536) throw fail('节点数据超过 64KB，请通过产物引用传递文件。', 413);
  return JSON.parse(encoded);
}

function matches(value, type) {
  if (type === 'any') return true;
  if (['fileRef', 'folderRef', 'image', 'artifactRef'].includes(type)) return typeof value === 'string' || (!!value && typeof value === 'object' && !Array.isArray(value));
  if (type === 'artifactBundle') return Array.isArray(value) || (!!value && typeof value === 'object');
  if (type === 'text') return typeof value === 'string';
  if (type === 'object') return !!value && typeof value === 'object' && !Array.isArray(value);
  if (type === 'array') return Array.isArray(value);
  return typeof value === type;
}

export function dagPath(value, path = '') {
  if (!path) return value;
  const keys = path.split('.');
  if (keys.length > 50 || keys.some(key => !/^[\p{L}\p{N}_$-]+$/u.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key))) throw fail('端口字段路径无效。');
  for (const key of keys) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) throw fail('输出缺少端口字段：' + path);
    value = value[key];
  }
  return value;
}

export function validateDAGInput(input, plan) {
  input = withWorkflowInputDefaults(plan.document, input);
  const value = json(input === undefined ? null : input);
  for (const node of plan.inputNodes) {
    const key = node.config.fieldName || node.id;
    const selected = value && typeof value === 'object' && Object.hasOwn(value, key) ? value[key] : plan.inputNodes.length === 1 ? value : undefined;
    if (node.config.required && (selected === undefined || selected === null || selected === '')) throw fail('请准备输入：' + node.title);
    if (selected !== undefined && selected !== null && !matches(selected, node.config.outputType)) throw fail(node.title + ' 的输入类型应为 ' + node.config.outputType);
  }
  return value;
}

export class WorkflowDAGRuns {
  constructor(owner) {
    this.owner = owner; this.app = owner.app; this.db = owner.db; this.active = new Map(); this.queue = [];
    this.sessions = new Map(); this.closed = false; this.resources = new Map(); this.pumpingQueue = false; this.mutations = new Set(); this.publications = new Map();
    this.resourceLimits = { default: 4, model: 2, eda: 1, browser: 2, drawio: 1, memory: 1, build: 1 };
    this.maxActiveRuns = 2;
    for (const row of this.db.prepare("SELECT value FROM workflow_runs WHERE json_extract(value,'$.schemaVersion')=2 AND json_extract(value,'$.status') NOT IN ('complete','error','interrupted','unknown')").all()) {
      const run = JSON.parse(row.value);
      if (!run.modelRoute && this.app.recoverModelRoute) {
        run.modelRoute = this.app.recoverModelRoute(Object.values(run.nodes).map(node => node.sessionId));
      }
      if (run.delivery?.status === 'publishing' && Object.values(run.nodes).every(node => NODE_DONE.has(node.status))) {
        run.delivery.status = 'error'; run.delivery.error = '应用在保存交付副本时退出；本机原件已保留，请仅重试保存副本。';
        run.status = 'error'; run.error = run.delivery.error; run.completedAt = now(); this.save(run); continue;
      }
      // No in-flight effect is replayed. A pure human wait needs no worker/model.
      const inflight = Object.values(run.nodes).filter(node => ['running', 'preparing'].includes(node.status));
      for (const node of inflight) Object.assign(node, { status: 'unknown', error: '应用重启，运行结果未确认；请核验后显式重跑。', completedAt: now() });
      if (inflight.length) { run.status = 'unknown'; run.error = '应用重启，未自动重放能力。'; run.completedAt = now(); this.save(run); continue; }
      const state = this.state(run); this.active.set(run.id, state);
      this.owner.locks.set(run.workflowId, 'dag');
      if (run.status === 'queued') this.queue.push(run.id);
      else { run.status = 'waiting_review'; this.owner.locks.set(run.workflowId, 'dag'); this.save(run); }
    }
    queueMicrotask(() => {
      if (this.closed) return;
      for (const state of this.active.values()) for (const node of state.plan.nodes.filter(node => ['subflow', 'foreach', 'loop'].includes(node.type))) {
        const record = state.run.nodes[node.id];
        if (record.status !== 'waiting_review' || !record.subflowProgress?.childRunId) continue;
        const step = { node, token: record.attemptId, terminal: false, submitted: false, controller: new AbortController() };
        state.steps.set(node.id, step);
        void this.runSubflow(state, step, record.input).catch(error => {
          if (!this.closed && !state.halted && !step.terminal) return this.failNode(state, step, errorText(error));
        });
      }
      void this.dispatch();
    });
  }

  state(run) { return { run, plan: planWorkflow(run.document), steps: new Map(), running: new Set(), halted: false, pumping: false, depth: run.depth || 0 }; }
  save(run) { run.activeNodeIds = Object.entries(run.nodes).filter(([, node]) => ['running', 'preparing', 'waiting'].includes(node.status)).map(([id]) => id); this.owner.save(run); }
  has(id) { return this.active.has(id) || !!this.db.prepare("SELECT 1 FROM workflow_runs WHERE id=? AND json_extract(value,'$.schemaVersion')=2").get(id); }
  get(id) { const state = this.active.get(id); const row = state ? null : this.db.prepare('SELECT value FROM workflow_runs WHERE id=?').get(id); if (!state && !row) throw fail('工作流运行不存在。', 404); return clone(state?.run || JSON.parse(row.value)); }
  queueStatus() { return { maxActiveRuns: this.maxActiveRuns, resourceLimits: { ...this.resourceLimits },
    running: [...this.active.values()].filter(state => state.run.status !== 'queued').map(state => this.get(state.run.id)),
    queued: this.queue.map(id => this.get(id)) }; }
  allowsSubmit(sessionId, runId) { const binding = this.sessions.get(sessionId); return !!binding && binding.state.run.id === runId && !this.closed && !binding.state.halted && binding.step.submitted && !binding.step.terminal; }

  async start({ document, input, outputDirectory: requestedDirectory }, options = {}) {
    if (this.closed) throw fail('执行管理器已关闭。', 503);
    let plan = planWorkflow(document);
    const checkLifecycle = () => {
      this.app.workflowLibrary?.assertRunnable?.(plan.document.id);
      for (const node of plan.document.nodes.filter(node => ['subflow', 'foreach', 'loop'].includes(node.type))) {
        if (node.config.workflowRef) this.app.workflowLibrary?.assertRunnable?.(node.config.workflowRef);
        if (node.config.document?.id) this.app.workflowLibrary?.assertRunnable?.(node.config.document.id);
      }
    };
    checkLifecycle();
    const parent = options.parentRunId ? this.active.get(options.parentRunId) : null;
    if (options.parentRunId && (!parent || parent.halted)) throw fail('父流程已停止。', 409);
    if (options.learningId && !this.app.learning?.allowsWorkflow(parent?.run.workflowId || plan.document.id, options.learningId, options.memoryScopeId)) throw fail('学习批次未确认只读记忆。', 409);
    if (!options.learningId && this.app.learning?.isLocked(plan.document.id)) throw fail('此工作流正在学习，请等待当前批次。', 409);
    if (options.canStart && !options.canStart()) throw fail('定时触发已取消。', 409);
    const depth = parent ? parent.depth + 1 : 0;
    if (depth > 8) throw fail('子流程超过最大嵌套深度。');
    // Freeze referenced subflow documents in the run, never resolve latest mid-run.
    const frozen = clone(plan.document);
    for (const node of frozen.nodes.filter(node => ['subflow', 'foreach', 'loop'].includes(node.type))) {
      if (!node.config.document) {
        const record = this.app.workflowLibrary?.get(node.config.workflowRef) || this.app.workflowsLibrary?.get(node.config.workflowRef) || this.app.workflowDocuments?.get(node.config.workflowRef);
        if (!record) throw fail('子流程不存在，请嵌入已保存的流程快照。');
        const doc = record.document || record;
        const hash = 'sha256:' + createHash('sha256').update(JSON.stringify(doc)).digest('hex');
        if (!node.config.version || node.config.version !== hash) throw fail('子流程版本已变化，请重新选择固定版本。', 409);
        node.config.document = clone(doc);
      }
      if (node.config.document.schemaVersion !== 2) throw fail('节点子流程需要第二版数据流，请先升级。');
    }
    plan = planWorkflow(frozen);
    let value = validateDAGInput(input, plan);
    const id = randomUUID();
    const prepared = this.app.workflowFiles?.prepareRun ? await this.app.workflowFiles.prepareRun({ document: plan.document, input: value, runId: id,
      outputDirectory: requestedDirectory || plan.document.settings.outputDirectory }) : null;
    if (prepared?.ok === false) throw fail('输入尚未准备好，请按清单补齐资料。', 400, prepared.errors);
    if (prepared) value = validateDAGInput(prepared.input, plan);
    // Pin the main model once per admitted graph, including later/revised nodes
    // and embedded subflows. Credentials and fallback remain Hermes-owned.
    const modelRoute = options.modelRoute || (parent ? parent.run.modelRoute
      : await this.app.captureModelRoute?.({ optional: !plan.skillNodes.length }));
    const details = {};
    for (const node of plan.skillNodes) {
      const detail = await this.app.skill(node.config.skillRef);
      if (detail.name !== node.config.skillRef || detail.revision !== node.config.version) throw fail('Skill 版本已变化，请重新选择后运行。', 409);
      details[node.id] = clone(detail);
    }
    checkLifecycle();
    if (options.canStart && !options.canStart()) throw fail('定时触发已取消。', 409);
    const outputDirectory = prepared?.outputDirectory || join(this.app.config?.dataDir || this.app.config?.workspaceRoot || process.cwd(), 'workflow-artifacts', id);
    if (!isAbsolute(outputDirectory)) throw fail('输出目录必须是绝对路径。');
    await mkdir(outputDirectory, { recursive: true });
    checkLifecycle();
    const run = { schemaVersion: 2, id, workflowId: plan.document.id, title: plan.document.title, status: 'queued', document: plan.document,
      nodeOrder: plan.nodeOrder, currentNodeId: null, activeNodeIds: [], input: value, output: null, outputs: {}, outputText: '', partialText: '', error: '',
      outputDirectory, ...(prepared?.deliveryDirectory && prepared.deliveryDirectory !== outputDirectory ? { storageVersion: 2, deliveryDirectory: prepared.deliveryDirectory } : {}),
      sourceManifest: prepared?.manifest || [], settings: plan.document.settings, skills: plan.skillNodes.map(node => ({ nodeId: node.id, name: node.config.skillRef, revision: node.config.version, source: details[node.id].source })),
      frozenSkillDetails: details, startedAt: now(), completedAt: null, sessionId: null, depth,
      ...(modelRoute ? { modelRoute: clone(modelRoute) } : {}),
      ...(parent ? { parentRunId: parent.run.id } : {}), ...(options.scheduleId ? { trigger: { type: 'schedule', scheduleId: options.scheduleId, scheduledAt: options.scheduledAt, scheduleName: options.scheduleName } } : {}),
      ...(options.learningId ? { learningId: options.learningId, memoryScopeId: options.memoryScopeId, memoryPolicy: { mode: 'batch-snapshot', memoryWriteAllowed: false, externalMemoryAllowed: false } } : {}),
      nodes: Object.fromEntries(plan.document.nodes.map(node => [node.id, LEARNING.has(node.type) ? { ...fresh(), status: 'skipped', reason: options.learningId ? '由学习控制器管理' : '执行模式跳过学习支路' } : fresh()])),
    };
    run.skill = run.skills[0] || null;
    const state = this.state(run); this.active.set(id, state); this.queue.push(id); this.owner.locks.set(run.workflowId, 'dag');
    options.onCreated?.(clone(run)); this.save(run); this.updateQueue(); void this.dispatch(); return this.get(id);
  }

  updateQueue() { this.queue.forEach((id, index) => { const state = this.active.get(id); if (state) { state.run.queuePosition = index + 1; this.save(state.run); } }); }
  async dispatch() {
    if (this.closed || this.pumpingQueue) return; this.pumpingQueue = true;
    try {
      for (const id of [...this.queue]) {
        const state = this.active.get(id); if (!state) { this.queue.splice(this.queue.indexOf(id), 1); continue; }
        if (state.plan.skillNodes.length) {
          // The adapter publishes ready before Application finishes loading its
          // Hermes model inventory. Admit the whole graph only when the
          // same readiness check used by createSession succeeds.
          let ready = true;
          try {
            if (typeof this.app.checkReady === 'function') this.app.checkReady();
            else if (this.app.backend && this.app.backend.state !== 'ready') ready = false;
          } catch { ready = false; }
          if (!ready) { state.run.queueReason = '等待 Hermes 连接与模型准备'; this.save(state.run); continue; }
        }
        const running = [...this.active.values()].filter(item => !['queued', 'waiting_review'].includes(item.run.status) && !item.run.parentRunId).length;
        if (!state.run.parentRunId && running >= this.maxActiveRuns) continue;
        this.queue.splice(this.queue.indexOf(id), 1); state.run.queuePosition = null; state.run.queueReason = ''; state.run.status = 'running'; this.save(state.run);
        void this.pump(state);
      }
      this.updateQueue();
    } finally { this.pumpingQueue = false; }
  }

  inputValue(state, node) {
    if (node.type === 'input') {
      const key = node.config.fieldName || node.id; const input = state.run.input;
      return json(input && typeof input === 'object' && Object.hasOwn(input, key) ? input[key] : state.plan.inputNodes.length === 1 ? input : null);
    }
    const inputs = getPorts(node).inputs; const values = {}; const references = {};
    for (const port of inputs) {
      const edge = state.plan.incoming.get(node.id).find(item => item.targetPort === port.id);
      if (!edge) continue;
      const source = state.run.nodes[edge.sourceNode];
      if (source.status !== 'complete' || (source.selectedPort && source.selectedPort !== edge.sourcePort)) continue;
      const sourcePort = getPorts(state.plan.byId.get(edge.sourceNode)).outputs.find(item => item.id === edge.sourcePort);
      const value = dagPath(source.output, sourcePort?.valuePath);
      if (!matches(value, port.type)) throw fail(node.title + ' 的端口 ' + port.label + ' 类型不符：' + port.type);
      values[port.id] = json(value);
      // Only a direct, registered capability receipt can use this explicit
      // transport reference. Skill projections and arbitrary JSON stay intact.
      const producer = state.plan.byId.get(edge.sourceNode);
      if (isReceiptTool(node) && isReceiptTool(producer) && value === source.output
          && value?.kind === 'hdk-node-receipt' && value.runId === state.run.id && value.nodeId === producer.id
          && value.operation === producer.config.toolName && /^[a-f0-9]{64}$/.test(value.receiptSha256)
          && Number.isSafeInteger(source.attempt) && source.attempt > 0 && typeof source.attemptId === 'string' && source.attemptId
          && source.outputDirectory === join(state.run.outputDirectory, producer.id, '版本-' + source.attempt)
          && value.receiptPath === join(source.outputDirectory, 'receipt.json')) {
        references[port.id] = { kind: 'hdk-node-receipt-ref', runId: value.runId, nodeId: value.nodeId,
          operation: value.operation, receiptPath: value.receiptPath, receiptSha256: value.receiptSha256,
          attempt: source.attempt, attemptId: source.attemptId };
      }
    }
    const assembled = inputs.length === 1 && inputs[0].id === 'in' ? values.in ?? null : values;
    if (Buffer.byteLength(JSON.stringify(assembled)) <= 65536) return json(assembled);
    // Keep the same size limit and the producer's complete durable output.
    // Python resolves references against that exact current attempt before I/O.
    const compact = { ...values, ...references };
    return json(inputs.length === 1 && inputs[0].id === 'in' ? compact.in ?? null : compact);
  }

  readiness(state, node) {
    const incoming = state.plan.incoming.get(node.id);
    if (!incoming.every(edge => NODE_DONE.has(state.run.nodes[edge.sourceNode].status))) return 'pending';
    for (const port of getPorts(node).inputs) {
      if (port.required === false) continue;
      const edge = incoming.find(item => item.targetPort === port.id);
      const source = edge && state.run.nodes[edge.sourceNode];
      if (!source || source.status !== 'complete') return source?.status === 'skipped' ? 'skipped' : 'blocked';
      if (source.selectedPort && source.selectedPort !== edge.sourcePort) return 'skipped';
    }
    return 'ready';
  }
  resource(node) {
    if (['input', 'validation', 'output', 'human', 'merge', 'subflow', 'foreach', 'loop'].includes(node.type)) return null;
    if (node.type === 'skill') return 'model';
    const registered = node.type === 'tool' && node.config.executionMode === 'tool' ? WORKFLOW_TOOLS.find(tool => tool.id === node.config.toolName) : null;
    return registered?.resource || (node.config.resource && node.config.resource !== 'default' ? node.config.resource : 'default');
  }
  acquire(node) { const key = this.resource(node); if (!key) return true; const count = this.resources.get(key) || 0; const limit = Math.min(this.resourceLimits[key] || 1, node.config.resourceLimit || 16); if (count >= limit) return false; this.resources.set(key, count + 1); return true; }
  releaseResource(step) { if (step?.resourceReleased) return; if (step) step.resourceReleased = true; const key = step && this.resource(step.node); if (key) this.resources.set(key, Math.max(0, (this.resources.get(key) || 1) - 1)); }

  async pump(state) {
    if (state.halted || state.pumping || this.closed || state.run.status === 'queued') return; state.pumping = true;
    try {
      let changed = true;
      while (changed && !state.halted) {
        changed = false;
        for (const id of state.plan.nodeOrder) {
          const node = state.plan.byId.get(id); const record = state.run.nodes[id];
          if (!['pending', 'ready', 'waiting_resource'].includes(record.status)) continue;
          const readiness = this.readiness(state, node);
          if (['blocked', 'skipped'].includes(readiness)) { Object.assign(record, { status: readiness, completedAt: now(), error: readiness === 'blocked' ? '上游节点未成功，此分支未执行。' : '' }); this.save(state.run); changed = true; continue; }
          if (readiness !== 'ready') continue;
          if (state.running.size >= state.run.settings.maxConcurrency || !this.acquire(node)) { record.status = 'waiting_resource'; continue; }
          state.running.add(id); record.status = 'preparing'; changed = true;
          void this.launch(state, node);
        }
      }
      this.updateRun(state);
    } finally { state.pumping = false; }
  }

  updateRun(state) {
    if (state.halted || state.finalizing) return;
    const records = state.plan.nodes.map(node => state.run.nodes[node.id]);
    if (records.every(node => NODE_DONE.has(node.status))) {
      const failures = state.plan.nodes.filter(node => ['error', 'unknown', 'cancelled'].includes(state.run.nodes[node.id].status));
      const failed = failures.length ? state.run.nodes[failures[0].id] : records.find(node => node.status === 'blocked');
      state.run.status = failed ? records.some(node => node.status === 'unknown') ? 'unknown' : 'error' : 'complete';
      state.run.failedNodeIds = failures.map(node => node.id);
      state.run.error = failures.length ? failures.map(node => node.title + '：' + state.run.nodes[node.id].error).join('\n').slice(0, 8000) : failed?.error || '';
      const finalNodes = state.plan.finalOutputNodes || state.plan.outputNodes;
      state.run.completedAt = now(); state.run.currentNodeId = failures[0]?.id || (failed ? state.plan.nodes.find(node => state.run.nodes[node.id] === failed)?.id : finalNodes.at(-1)?.id) || null;
      const outputs = Object.fromEntries(state.plan.outputNodes.filter(node => state.run.nodes[node.id].status === 'complete').map(node => [node.id, state.run.nodes[node.id].output]));
      const finalOutputs = Object.fromEntries(finalNodes.filter(node => Object.hasOwn(outputs, node.id)).map(node => [node.id, outputs[node.id]]));
      state.run.outputs = outputs;
      state.run.stageOutputs = Object.fromEntries(state.plan.outputNodes.filter(node => node.config.stage === 'intermediate' && Object.hasOwn(outputs, node.id)).map(node => [node.id, outputs[node.id]]));
      state.run.output = finalNodes.length === 1 ? finalOutputs[finalNodes[0].id] ?? null : finalOutputs;
      state.run.outputText = typeof state.run.output === 'string' ? state.run.output : JSON.stringify(state.run.output);
      if (!failed && state.run.deliveryDirectory && this.app.workflowFiles?.publishRun) {
        state.run.status = 'running'; state.run.completedAt = null;
        state.run.delivery = { status: 'publishing', directory: state.run.deliveryDirectory };
        this.save(state.run);
        state.finalizing = this.finishDelivery(state);
      } else this.finishRun(state);
      return;
    }
    const waiting = records.some(node => node.status === 'waiting_review');
    const wasWaiting = state.run.status === 'waiting_review';
    state.run.status = waiting && !state.running.size ? 'waiting_review' : 'running';
    this.save(state.run);
    if (!wasWaiting && state.run.status === 'waiting_review') void this.dispatch();
  }
  finishRun(state) {
    state.halted = true; this.save(state.run); this.active.delete(state.run.id);
    this.releaseWorkflow(state.run.workflowId); void this.dispatch();
  }
  async finishDelivery(state) {
    try {
      for (const record of Object.values(state.run.nodes)) await this.verifyArtifacts(record.artifacts || []);
      const delivery = await this.app.workflowFiles.publishRun(state.run.id);
      state.run.delivery = { ...delivery, status: 'complete' };
      state.run.status = 'complete'; state.run.error = '';
    } catch (error) {
      state.run.delivery = { status: 'error', directory: state.run.deliveryDirectory, error: errorText(error) };
      state.run.status = 'error'; state.run.error = '节点执行已完成，保存交付副本失败：' + errorText(error);
    }
    state.run.completedAt = now(); this.finishRun(state);
  }
  async publishDelivery(id) {
    if (this.closed) throw fail('执行管理器已关闭。', 503);
    if (this.mutations.has(id) || this.active.has(id)) throw fail('本次运行仍在执行或保存交付副本，请稍候。', 409);
    this.mutations.add(id);
    const publication = this.publishStoredDelivery(id); this.publications.set(id, publication);
    try { return await publication; }
    finally { this.publications.delete(id); this.mutations.delete(id); }
  }
  async publishStoredDelivery(id) {
      const run = this.get(id); this.app.workflowLibrary?.assertRunnable?.(run.workflowId);
      if (!run.deliveryDirectory || !this.app.workflowFiles?.publishRun) throw fail('历史运行没有独立交付副本，仍可打开原输出目录。', 409);
      if (Object.values(run.nodes).some(record => !['complete', 'skipped'].includes(record.status))) throw fail('请先完成全部节点及人工审核。', 409);
      for (const record of Object.values(run.nodes)) await this.verifyArtifacts(record.artifacts || []);
      if (this.closed) throw fail('执行管理器正在关闭，交付副本尚未开始保存。', 503);
      this.app.workflowLibrary?.assertRunnable?.(run.workflowId);
      run.delivery = { status: 'publishing', directory: run.deliveryDirectory }; run.status = 'running'; run.completedAt = null; this.save(run);
      try {
        const delivery = await this.app.workflowFiles.publishRun(id);
        run.delivery = { ...delivery, status: 'complete' }; run.status = 'complete'; run.error = '';
      } catch (error) {
        run.delivery = { status: 'error', directory: run.deliveryDirectory, error: errorText(error) };
        run.status = 'error'; run.error = '节点执行已完成，保存交付副本失败：' + errorText(error);
      }
      run.completedAt = now(); this.save(run); return this.get(id);
  }
  releaseWorkflow(id) { if (![...this.active.values()].some(state => state.run.workflowId === id) && this.owner.locks.get(id) === 'dag') this.owner.locks.delete(id); }
  wake() { for (const state of this.active.values()) if (state.run.status !== 'queued') void this.pump(state); }

  async launch(state, node) {
    const record = state.run.nodes[node.id]; const step = { node, token: randomUUID(), terminal: false, submitted: false, controller: new AbortController() };
    state.steps.set(node.id, step); record.attempt++; record.attemptId = step.token; record.startedAt = now(); record.completedAt = null; record.error = ''; record.logs = { stdout: '', stderr: '' };
    const current = () => !this.closed && !state.halted && state.steps.get(node.id) === step && !step.terminal;
    try {
      await this.verifySources(state);
      await this.verifyArtifacts(this.upstreamArtifacts(state, node));
      if (!current()) return;
      const input = this.inputValue(state, node); record.input = clone(input); record.status = 'running'; state.run.currentNodeId = node.id; this.save(state.run);
      const cwd = this.app.workflowFiles?.nodeDirectory ? await this.app.workflowFiles.nodeDirectory({ runId: state.run.id, nodeId: node.id, attempt: record.attempt }) : join(state.run.outputDirectory, node.id, String(record.attempt));
      await mkdir(cwd, { recursive: true }); record.outputDirectory = cwd;
      this.save(state.run);
      if (!current()) return;
      if (node.type === 'human') {
        record.artifacts = this.upstreamArtifacts(state, node); record.review ||= { revisionCount: 0, feedback: '', decision: null };
        record.status = 'waiting_review'; step.terminal = true; this.finishSlot(state, step); return;
      }
      if (node.type === 'input' || node.type === 'merge') { await this.complete(state, step, input); return; }
      if (node.type === 'validation') {
        record.validation = validateNodeValue(input, node.config.rules, node.title);
        await this.complete(state, step, input); return;
      }
      if (node.type === 'output') {
        let name = node.config.fileName || (typeof input === 'string' ? '结果.txt' : '结果.json');
        if (!/\.(?:txt|json|md)$/i.test(name)) name += typeof input === 'string' ? '.txt' : '.json';
        const path = join(cwd, name); await writeFile(path, typeof input === 'string' ? input : JSON.stringify(input, null, 2), { flag: 'wx' });
        record.savedPath = path; record.outputStage = node.config.stage || 'final';
        await this.complete(state, step, input, [{ path, label: name, role: node.config.stage === 'intermediate' ? 'stage-result' : 'saved-result' }]); return;
      }
      if (['subflow', 'foreach', 'loop'].includes(node.type)) { await this.runSubflow(state, step, input); return; }
      const timeout = (node.config.timeoutSeconds || 120) * 1000;
      step.timer = setTimeout(() => { void this.failNode(state, step, '节点运行超时，未自动重试。', 'unknown', true); }, timeout); step.timer.unref?.();
      if (node.type === 'skill') {
        if (this.app.recoverModelRoute && !state.run.modelRoute) throw fail('此旧运行未记录主模型，无法安全继续 Skill；请保留现有产物并新建一次运行。');
        const detail = state.run.frozenSkillDetails[node.id];
        const sessionPath = join(this.app.config.workspaceRoot, 'workflow-sessions', state.run.id, node.id, step.token);
        const sessionDirectory = this.app.workspace ? this.app.workspace(sessionPath) : sessionPath;
        await mkdir(sessionDirectory, { recursive: true }); step.sessionDirectory = sessionDirectory; record.sessionDirectory = sessionDirectory;
        const session = await this.app.createSession({ title: '工作流 · ' + state.run.title + ' · ' + node.title + ' · ' + record.attempt, cwd: sessionDirectory,
          ...(state.run.modelRoute ? { modelRoute: state.run.modelRoute } : {}) });
        if (!current()) return; step.session = session; record.sessionId = session.id; this.sessions.set(session.id, { state, step });
        step.prepared = await this.owner.prepareSkill(this.app, session, detail, { input, skillNode: node,
          inputNode: state.plan.inputNode, outputNode: state.plan.outputNode, runId: state.run.id, stepId: step.token, attemptId: step.token, nodeId: node.id, workflowId: state.run.workflowId,
          ...(state.run.learningId ? { learningId: state.run.learningId, memoryScopeId: state.run.memoryScopeId } : {}) });
        if (!current()) { await step.prepared?.cleanup?.(); return; }
        if (step.prepared?.skill?.revision !== node.config.version) throw fail('Skill 固定版本准备不一致。', 409);
        record.skill = { name: node.config.skillRef, revision: node.config.version,
          ...Object.fromEntries(['bundleHash', 'snapshotDirectory'].filter(key => typeof step.prepared.skill[key] === 'string').map(key => [key, step.prepared.skill[key]])) };
        const bound = step.prepared.bindInput ? await step.prepared.bindInput(input) : { text: step.prepared.text };
        if (!current()) return;
        const locations = '\nController artifact locations: ' + JSON.stringify({ sessionDirectory, outputDirectory: cwd,
          fileContract: 'Keep the requested output schema. When producing files, save real files in your session directory and return their actual paths in artifacts/files/path or declared file/image output ports. Workbench deterministically copies those files into the selected output directory and registers their hashes. Do not claim a file exists before creating it.' });
        const feedback = record.reviewFeedback ? '\nExplicit human request for this one revision (do not modify Skill):\n' + record.reviewFeedback : '';
        step.submitted = true; this.save(state.run); await this.app.submit(session.id, bound.text + locations + feedback, { workflowRunId: state.run.id }); return;
      }
      const config = { ...node.config, inputType: 'any', outputType: 'any' };
      if (node.type === 'condition') Object.assign(config, { executionMode: 'code', language: 'javascript', code: 'return Boolean(' + node.config.expression + ');' });
      else if (node.type === 'transform') Object.assign(config, { executionMode: 'code', language: node.config.language || 'javascript' });
      const result = await this.owner.executeOperation({ node: { ...node, type: 'tool', config }, input, cwd, signal: step.controller.signal,
        pythonPath: this.app.config?.hermesPython, context: { runId: state.run.id, workflowId: state.run.workflowId, nodeId: node.id, attemptId: step.token,
          outputDirectory: cwd, runOutputDirectory: state.run.outputDirectory, attempt: record.attempt,
          workspaceRoot: this.app.config?.workspaceRoot,
          databasePath: join(this.app.config?.dataDir || process.cwd(), 'workbench.sqlite'),
          reviewFeedback: record.reviewFeedback || '', ...(state.run.learningId ? { learningId: state.run.learningId } : {}) },
        onLog: log => { if (!current() || !['stdout', 'stderr'].includes(log?.stream)) return; record.logs[log.stream] = (record.logs[log.stream] + String(log.text)).slice(-32768); this.save(state.run); } });
      if (!current()) return;
      if (!result || !Object.hasOwn(result, 'output')) throw fail('能力节点没有正式输出。');
      if (node.type === 'condition') { record.selectedPort = result.output ? 'yes' : 'no'; await this.complete(state, step, input); }
      else { record.runtime = result.runtime || null; await this.complete(state, step, result.output, result.artifacts); }
    } catch (error) {
      if (current()) {
        if (error?.validation) record.validation = clone(error.validation);
        if (state.run.learningId && node.type === 'tool' && node.config.executionMode === 'tool'
          && node.config.toolName.startsWith('hdk.') && error?.code === 'LEARNING_INVALID_PLAN') {
          record.errorCode = 'LEARNING_INVALID_PLAN'; record.learningRecoverable = true;
        }
        await this.failNode(state, step, errorText(error));
      }
    }
  }

  upstreamArtifacts(state, node) { const ids = new Set(); const values = []; for (const edge of state.plan.incoming.get(node.id)) for (const artifact of state.run.nodes[edge.sourceNode].artifacts || []) if (!ids.has(artifact.id)) { ids.add(artifact.id); values.push(clone(artifact)); } return values; }
  async artifacts(state, node, value, explicit, staged = []) {
    const rows = [...(Array.isArray(explicit) ? explicit : []), ...(Array.isArray(value?.artifacts) ? value.artifacts : []), ...(Array.isArray(value?.files) ? value.files : [])];
    if (typeof value?.path === 'string') rows.push({ path: value.path });
    for (const port of getPorts(node).outputs.filter(port => ['image', 'fileRef', 'artifactRef', 'artifactBundle'].includes(port.type))) {
      const item = dagPath(value, port.valuePath); rows.push(...(Array.isArray(item) ? item : [typeof item === 'string' ? { path: item } : item]));
    }
    const records = this.upstreamArtifacts(state, node);
    for (const artifact of staged) if (!records.some(item => item.id === artifact.id)) records.push(clone(artifact));
    const paths = new Set(records.map(row => row.path));
    for (const row of rows) {
      if (typeof row?.path !== 'string' || !isAbsolute(row.path) || paths.has(row.path)) continue;
      const rel = relative(state.run.outputDirectory, row.path); if (rel.startsWith('..') || isAbsolute(rel)) continue;
      if (this.app.workflowFiles?.registerArtifact) {
        const artifact = await this.app.workflowFiles.registerArtifact({ runId: state.run.id, nodeId: node.id, attempt: state.run.nodes[node.id].attempt,
          path: row.path, label: row.label || row.name, role: row.role || row.kind, kind: row.kind }); records.push(artifact); paths.add(row.path);
      }
    }
    return records;
  }
  async complete(state, step, raw, artifacts) {
    if (step.terminal || state.halted) return;
    const record = state.run.nodes[step.node.id];
    let value = json(raw);
    if (step.sessionDirectory) value = await this.stageSkillArtifacts(state, step, value);
    if (step.node.type !== 'condition') for (const port of getPorts(step.node).outputs.filter(port => port.id !== 'learning')) {
      const selected = dagPath(value, port.valuePath); if (!matches(selected, port.type)) throw fail(step.node.title + ' 输出端口 ' + port.label + ' 类型不符。');
    }
    if (step.childArtifacts?.length) await this.verifyArtifacts(step.childArtifacts);
    const registered = await this.artifacts(state, step.node, value, artifacts, step.childArtifacts);
    const images = registered.filter(item => String(item.mimeType || '').startsWith('image/'));
    const producedImages = images.filter(item => item.runId === state.run.id && item.nodeId === step.node.id);
    if (requiresImageReview(step.node) && !producedImages.length && !step.childArtifacts?.some(item => String(item.mimeType || '').startsWith('image/'))) throw fail('需要人工审核的产图节点没有保存可核对的真实图片产物。');
    const customProducer = step.node.type === 'skill' || step.node.type === 'transform' || (step.node.type === 'tool' && step.node.config.executionMode === 'code');
    if (requiresImageReview(step.node) || (customProducer && producedImages.length)) assertImageReviewPaths(state.plan, step.node.id);
    if (state.halted || step.terminal) return;
    step.terminal = true; Object.assign(record, { status: 'complete', output: value, outputText: typeof value === 'string' ? value : JSON.stringify(value), artifacts: registered, completedAt: now() });
    this.finishSlot(state, step);
  }
  async stageSkillArtifacts(state, step, value) {
    const rows = [...(Array.isArray(value?.artifacts) ? value.artifacts : []), ...(Array.isArray(value?.files) ? value.files : [])];
    if (typeof value?.path === 'string') rows.push(value);
    for (const port of getPorts(step.node).outputs.filter(port => ['image', 'fileRef', 'artifactRef', 'artifactBundle'].includes(port.type))) {
      const item = dagPath(value, port.valuePath); rows.push(...(Array.isArray(item) ? item : [typeof item === 'string' ? { path: item } : item]));
    }
    const sourceRoot = await realpath(step.sessionDirectory); const replacements = new Map(); const record = state.run.nodes[step.node.id];
    for (const row of rows) {
      if (!row || typeof row.path !== 'string' || !isAbsolute(row.path) || replacements.has(row.path)) continue;
      const source = await realpath(row.path); const rel = relative(sourceRoot, source);
      if (rel.startsWith('..') || isAbsolute(rel)) continue;
      const info = await stat(source); if (!info.isFile() || info.size > 512 * 1024 * 1024) throw fail('Skill 产物必须是最多 512MiB 的普通文件。');
      const target = join(record.outputDirectory, 'generated', rel); await mkdir(dirname(target), { recursive: true });
      const before = createHash('sha256').update(await readFile(source)).digest('hex');
      await copyFile(source, target, constants.COPYFILE_EXCL);
      const after = createHash('sha256').update(await readFile(target)).digest('hex');
      if (before !== after) throw fail('Skill 产物复制时内容发生变化，未传给下游。');
      replacements.set(row.path, target); (record.stagedArtifacts ||= []).push({ source, path: target, sha256: after });
    }
    if (!replacements.size) return value;
    record.modelOutput = clone(value);
    const replace = item => typeof item === 'string' ? replacements.get(item) || item : Array.isArray(item) ? item.map(replace) : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).map(([key, child]) => [key, replace(child)])) : item;
    return json(replace(value));
  }
  finishSlot(state, step) { clearTimeout(step.timer); state.running.delete(step.node.id); if (step.session) this.sessions.delete(step.session.id); this.releaseResource(step); this.save(state.run); queueMicrotask(() => { if (!this.closed) { this.wake(); this.updateRun(state); } }); }
  async failNode(state, step, text, status = 'error', interrupt = false) {
    if (step.terminal || state.halted) return; step.terminal = true; step.controller.abort();
    if (interrupt && step.session && step.submitted) { try { await this.app.interrupt(step.session.id); } catch {} }
    try { await step.prepared?.cleanup?.(); } catch (error) { text += ' Skill 收尾校验失败：' + errorText(error); }
    Object.assign(state.run.nodes[step.node.id], { status, error: text, completedAt: now() }); this.finishSlot(state, step);
  }

  handleEvent(event) {
    if (this.closed || !event || event.type === 'workflow.run') return;
    if (event.type === 'backend.status' && event.payload?.state === 'ready') { void this.dispatch(); return; }
    if (event.type === 'backend.status' && ['disconnected', 'error', 'stopped'].includes(event.payload?.state)) {
      for (const { state, step } of this.sessions.values()) void this.failNode(state, step, 'Hermes 连接中断，未重放此能力。', 'unknown'); return;
    }
    const binding = this.sessions.get(event.sessionId); if (!binding) return;
    const { state, step } = binding; if (step.terminal || state.halted || !step.submitted) return;
    const record = state.run.nodes[step.node.id];
    if (event.type === 'message.delta') { record.partialText = (record.partialText + String(event.payload?.text || '')).slice(-262144); this.save(state.run); }
    else if (event.type === 'request.open') { record.status = 'waiting'; this.save(state.run); }
    else if (event.type === 'request.cancel') { record.status = 'running'; this.save(state.run); }
    else if (event.type === 'error') void this.failNode(state, step, errorText(event.payload?.message));
    else if (event.type === 'message.complete') {
      if (event.payload?.status !== 'complete' || event.payload?.partial || event.payload?.error) { void this.failNode(state, step, errorText(event.payload?.error || 'Hermes 未确认成功。'), event.payload?.status === 'interrupted' ? 'cancelled' : 'error'); return; }
      if (step.finalizing) return;
      step.finalizing = (async () => {
        try {
          const history = await this.app.history(step.session.id); if (step.terminal || state.halted) return;
          const last = history.messages?.filter(message => message.role === 'assistant').at(-1);
          if (!last || last.partial || last.tool_calls?.length || last.toolCalls?.length) throw fail('Hermes 没有完整最终结果。');
          let value = last.text;
          if (step.node.config.outputType !== 'text') { try { value = JSON.parse(last.text); } catch { if (step.node.config.outputType !== 'any') throw fail('Skill 最终结果不是有效的 JSON。'); } }
          await step.prepared?.cleanup?.(); await this.complete(state, step, value);
        } catch (error) { await this.failNode(state, step, errorText(error)); }
      })();
    }
  }

  async verifyArtifacts(records) { const checked = await this.app.workflowFiles?.verifyArtifacts?.(records); if (checked?.ok === false) throw fail('已保存的产物发生变化，审核或复用已失效。', 409, checked.errors); }
  async verifySources(state) {
    let run = state.run; const seen = new Set();
    while (run && !seen.has(run.id)) {
      seen.add(run.id); const validity = await this.app.workflowFiles?.verifyInputs?.(run.id);
      if (validity?.ok === false) throw fail('运行资料已变化，请重新准备输入。', 409, validity.errors);
      run = run.parentRunId ? this.get(run.parentRunId) : null;
    }
  }
  async approve(id, { nodeId, action, feedback = '', targetNodeId, expectedAttempt, expectedAttemptId, expectedArtifactHashes } = {}) {
    if (this.mutations.has(id)) throw fail('此运行正在处理审核或重跑，请稍候。', 409);
    this.mutations.add(id);
    try {
    const state = this.active.get(id); const node = state?.plan.byId.get(nodeId); const record = state?.run.nodes[nodeId];
    if (!state || node?.type !== 'human' || record?.status !== 'waiting_review') throw fail('此节点没有等待中的人工审核。', 409);
    const expected = expectedAttempt !== undefined || expectedAttemptId !== undefined || expectedArtifactHashes !== undefined
      ? { nodeId, attempt: expectedAttempt, attemptId: expectedAttemptId, artifactHashes: expectedArtifactHashes } : null;
    if (expected) assertExpectedNodeSnapshot(state.run, expected);
    if (action !== 'stop') this.app.workflowLibrary?.assertRunnable?.(state.run.workflowId);
    if (!['approve', 'revise', 'stop'].includes(action) || typeof feedback !== 'string' || feedback.length > 8000) throw fail('审核操作或反馈无效。');
    if (action !== 'stop') {
      if (state.run.learningId) await this.app.learning?.prepareReviewResume?.(state.run.learningId);
      await this.verifyArtifacts(record.artifacts);
    }
    if (this.closed || this.active.get(id) !== state || state.halted || state.run.nodes[nodeId] !== record || record.status !== 'waiting_review') throw fail('审核候选已变化或运行已停止，请刷新后重试。', 409);
    if (expected) assertExpectedNodeSnapshot(state.run, expected);
    if (action !== 'stop') this.app.workflowLibrary?.assertRunnable?.(state.run.workflowId);
    if (action === 'approve') { Object.assign(record, { status: 'complete', output: clone(record.input), outputText: JSON.stringify(record.input), completedAt: now() }); record.review = { ...record.review, decision: 'approved', feedback, reviewedAt: now(), artifactHashes: record.artifacts.map(item => ({ id: item.id, sha256: item.sha256 })) }; }
    else if (action === 'stop') { Object.assign(record, { status: 'error', error: feedback || '用户停止了此审核分支。', completedAt: now() }); record.review = { ...record.review, decision: 'stopped', feedback, reviewedAt: now() }; }
    else {
      if (!feedback.trim()) throw fail('请填写本次修改要求。');
      const target = targetNodeId || node.config.reviewTargetNodeId;
      if (!target || (node.config.reviewTargetNodeId && target !== node.config.reviewTargetNodeId)) throw fail('请选择审核节点声明的修改目标。');
      const ancestors = this.ancestors(state, nodeId);
      if (!ancestors.has(target) || !['skill', 'tool', 'transform', 'subflow'].includes(state.plan.byId.get(target)?.type)) throw fail('只能修改此审核节点的上游生产能力。');
      if ((record.review?.revisionCount || 0) >= (node.config.maxRevisions || 3)) throw fail('已达到人工修改次数上限。', 409);
      const review = { ...record.review, revisionCount: (record.review?.revisionCount || 0) + 1, decision: 'revision_requested', feedback, reviewedAt: now() };
      this.reset(state, new Set([target, ...this.descendants(state, target)]));
      state.run.nodes[nodeId].review = review; state.run.nodes[target].reviewFeedback = feedback;
    }
    // Human waits release run admission slots. Continuing joins the same queue
    // as new work instead of jumping ahead or exceeding the active-run limit.
    this.resume(state, state.run.status === 'waiting_review');
    return this.get(id);
    } finally { this.mutations.delete(id); }
  }
  ancestors(state, id) { const result = new Set(); const pending = state.plan.incoming.get(id).map(edge => edge.sourceNode); while (pending.length) { const next = pending.pop(); if (result.has(next)) continue; result.add(next); pending.push(...state.plan.incoming.get(next).map(edge => edge.sourceNode)); } return result; }
  descendants(state, id) { const result = new Set(); const pending = state.plan.outgoing.get(id).map(edge => edge.targetNode); while (pending.length) { const next = pending.pop(); if (result.has(next)) continue; result.add(next); pending.push(...state.plan.outgoing.get(next).map(edge => edge.targetNode)); } return result; }
  reset(state, ids) {
    if ([...ids].some(id => state.running.has(id) || (state.steps.get(id) && !state.steps.get(id).terminal))) throw fail('相关节点仍在执行或等待子流程，请先停止运行。', 409);
    for (const id of ids) {
      const previous = state.run.nodes[id]; if (!previous || state.plan.byId.get(id)?.type === 'input') continue;
      state.run.nodes[id] = { ...fresh(), attempt: previous.attempt, history: [...(previous.history || []), { ...clone(previous), history: undefined }].map(item => { delete item.history; return item; }) };
      state.steps.delete(id);
    }
    state.halted = false; state.run.completedAt = null; state.run.error = ''; state.run.output = null; state.run.outputs = {};
    delete state.run.delivery;
  }
  resume(state, needsAdmission) {
    if (needsAdmission) {
      state.run.status = 'queued';
      if (!this.queue.includes(state.run.id)) this.queue.push(state.run.id);
      this.save(state.run); this.updateQueue(); void this.dispatch();
    } else { state.run.status = 'running'; this.save(state.run); void this.pump(state); }
  }
  async rerun(id, { nodeIds, feedback, expectedNodes } = {}) {
    if (this.mutations.has(id)) throw fail('此运行正在处理审核或重跑，请稍候。', 409);
    this.mutations.add(id);
    try {
    let state = this.active.get(id); const run = state?.run || this.get(id);
    this.app.workflowLibrary?.assertRunnable?.(run.workflowId);
    const wasActive = !!state;
    if (run.learningId) throw fail('学习中的局部重跑由学习控制器管理，请勿改变样例执行。', 409);
    if (this.app.learning?.isLocked(run.workflowId)) throw fail('此工作流正在学习，不能局部重跑旧运行。', 409);
    if (!Array.isArray(nodeIds) || !nodeIds.length || nodeIds.length > 200) throw fail('请选择需要重跑的节点。');
    const assertExpected = () => {
      if (expectedNodes === undefined) return;
      if (!Array.isArray(expectedNodes) || expectedNodes.length !== new Set(nodeIds).size
        || new Set(expectedNodes.map(item => item?.nodeId)).size !== expectedNodes.length
        || expectedNodes.some(item => !nodeIds.includes(item?.nodeId))) throw fail('重跑节点版本凭据不完整。');
      for (const expected of expectedNodes) assertExpectedNodeSnapshot(run, expected);
    };
    assertExpected();
    if (feedback !== undefined && (typeof feedback !== 'string' || feedback.length > 8000)) throw fail('重跑补充要求必须是最多 8000 字的文本。');
    if (!state) state = this.state(run);
    const ids = new Set();
    for (const nodeId of nodeIds) {
      const node = state.plan.byId.get(nodeId); if (!node || node.type === 'input') throw fail('输入变更请创建一次新运行。');
      ids.add(nodeId); for (const child of this.descendants(state, nodeId)) ids.add(child);
    }
    for (const [nodeId, record] of Object.entries(run.nodes)) if (!ids.has(nodeId) && record.status === 'complete') await this.verifyArtifacts(record.artifacts || []);
    const valid = await this.app.workflowFiles?.verifyInputs?.(id); if (valid?.ok === false) throw fail('原输入已变化，请创建新运行。', 409, valid.errors);
    this.app.workflowLibrary?.assertRunnable?.(run.workflowId);
    if (this.closed || state.halted || state.finalizing || (wasActive ? this.active.get(id) !== state : this.active.has(id))) throw fail('运行状态已变化或正在保存交付副本，请刷新后重试。', 409);
    assertExpected();
    const needsAdmission = !wasActive || ['queued', 'waiting_review'].includes(run.status);
    // Selected producers receive the request too (e.g. an image tool adapter).
    // Omitted feedback retains existing requests; no Skill or code is rewritten.
    const requestTargets = new Set(nodeIds.filter(nodeId => ['skill', 'tool', 'transform', 'subflow'].includes(state.plan.byId.get(nodeId)?.type)));
    const skillFeedback = new Map([...ids].filter(nodeId => requestTargets.has(nodeId) || state.plan.byId.get(nodeId)?.type === 'skill')
      .map(nodeId => [nodeId, feedback ?? state.run.nodes[nodeId].reviewFeedback ?? '']));
    this.reset(state, ids);
    for (const [nodeId, request] of skillFeedback) state.run.nodes[nodeId].reviewFeedback = request;
    this.active.set(id, state); this.owner.locks.set(run.workflowId, 'dag'); this.resume(state, needsAdmission); return this.get(id);
    } finally { this.mutations.delete(id); }
  }

  async runSubflow(state, step, input) {
    const node = step.node; const limit = node.config.maxIterations || 1;
    await this.verifySources(state);
    if (state.depth >= (node.config.maxDepth || 4)) throw fail('子流程达到嵌套上限。');
    const values = node.type === 'foreach' ? input : [input];
    if (!Array.isArray(values) || values.length > limit) throw fail('逐项处理的输入不是数组或超过次数上限。');
    const record = state.run.nodes[node.id];
    const progress = record.subflowProgress ||= { index: 0, current: clone(input), results: [], childRunId: null, childRunIds: [] };
    let current = progress.current;
    const count = node.type === 'loop' ? limit : values.length;
    for (let index = progress.index; index < count; index++) {
      if (step.terminal || state.halted) return;
      const child = progress.childRunId ? this.get(progress.childRunId) : await this.start({ document: { ...clone(node.config.document), mode: 'execute' }, input: node.type === 'loop' ? current : values[index] }, {
        parentRunId: state.run.id, ...(state.run.learningId ? { learningId: state.run.learningId, memoryScopeId: state.run.memoryScopeId } : {}) });
      if (child.parentRunId !== state.run.id) throw fail('子流程回执不属于此父运行。');
      // Keep the admitted children after the active slot is cleared. History
      // inspection must not rely on an in-flight pointer or replay the child.
      if (!Array.isArray(progress.childRunIds)) progress.childRunIds = [];
      if (!progress.childRunIds.includes(child.id)) progress.childRunIds.push(child.id);
      progress.childRunId = child.id; this.save(state.run);
      const result = await this.waitForChild(child.id, step.controller.signal, childRun => {
        if (state.halted || step.terminal || this.closed) return;
        if (childRun.status === 'waiting_review') { record.status = 'waiting_review'; record.review = { delegated: true, childRunId: child.id }; state.running.delete(node.id); }
        else { record.status = 'running'; state.running.add(node.id); }
        this.updateRun(state);
      }, step);
      if (result.status !== 'complete') throw fail('子流程未成功：' + result.error);
      let childOutput = result.output, childArtifacts = [];
      if (this.app.workflowFiles) {
        step.childStaging = stageSubflowArtifacts(this.app.workflowFiles, { parent: state.run, nodeId: node.id, child: result,
          saveProgress: () => this.save(state.run),
          isCurrent: () => !this.closed && !state.halted && !step.terminal && !step.controller.signal.aborted
            && this.active.get(state.run.id) === state && state.steps.get(node.id) === step });
        try {
          const staged = await step.childStaging;
          childOutput = staged.output; childArtifacts = staged.artifacts;
        } finally { step.childStaging = null; }
      }
      step.childArtifacts ||= [];
      for (const artifact of childArtifacts) if (!step.childArtifacts.some(item => item.id === artifact.id)) step.childArtifacts.push(clone(artifact));
      record.childArtifacts = [...(record.childArtifacts || []), ...step.childArtifacts.filter(item => !(record.childArtifacts || []).some(previous => previous.id === item.id))];
      progress.results.push(childOutput); json(progress.results); current = childOutput;
      progress.current = clone(current); progress.index = index + 1; progress.childRunId = null; record.review = null; this.save(state.run);
      if (node.type === 'loop' && node.config.expression) {
        const check = await this.owner.executeOperation({ node: { type: 'tool', config: { executionMode: 'code', language: 'javascript', code: 'return Boolean(' + node.config.expression + ');', inputType: 'any', outputType: 'any', timeoutSeconds: 30 } }, input: current, cwd: state.run.nodes[node.id].outputDirectory, signal: step.controller.signal });
        if (!check.output) break;
      }
    }
    // Earlier iterations remain in durable progress when a later image waits.
    for (const previous of record.childArtifacts || []) if (!step.childArtifacts?.some(item => item.id === previous.id)) (step.childArtifacts ||= []).push(previous);
    record.childArtifacts = clone(step.childArtifacts || []);
    await this.complete(state, step, node.type === 'foreach' ? progress.results : current);
  }
  waitForChild(id, signal, onProgress = () => {}, step) {
    const existing = this.get(id); onProgress(existing); if (TERMINAL.has(existing.status)) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const end = () => { this.app.off('event', onEvent); signal?.removeEventListener('abort', abort); };
      const abort = () => { end(); void this.interrupt(id); reject(fail('父流程已停止。')); };
      const onEvent = event => { if (event.type !== 'workflow.run' || event.payload?.id !== id) return; onProgress(event.payload); if (TERMINAL.has(event.payload.status)) { end(); resolve(clone(event.payload)); } };
      if (step) step.waitEnd = end;
      this.app.on('event', onEvent); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    });
  }

  async interrupt(id) {
    const state = this.active.get(id); if (!state) return this.get(id);
    if (state.finalizing) { await state.finalizing; return this.get(id); }
    state.halted = true; this.queue = this.queue.filter(value => value !== id);
    for (const step of state.steps.values()) {
      clearTimeout(step.timer); step.controller.abort(); if (step.session && step.submitted && !step.terminal) { try { await this.app.interrupt(step.session.id); } catch {} }
      if (step.childStaging) { try { await step.childStaging; } catch { /* Wait for cancelled I/O before returning. */ } }
      try { await step.prepared?.cleanup?.(); } catch {} this.releaseResource(step); if (step.session) this.sessions.delete(step.session.id);
    }
    for (const node of Object.values(state.run.nodes)) if (!NODE_DONE.has(node.status)) Object.assign(node, { status: 'cancelled', completedAt: now() });
    Object.assign(state.run, { status: 'interrupted', error: '用户已停止本次工作流。', completedAt: now() }); this.save(state.run);
    this.active.delete(id); this.releaseWorkflow(state.run.workflowId); this.updateQueue(); void this.dispatch(); this.wake(); return this.get(id);
  }
  async close() {
    if (this.closed) return; this.closed = true;
    await Promise.allSettled([...this.publications.values()]);
    for (const state of this.active.values()) {
      if (state.finalizing) { await state.finalizing; continue; }
      for (const step of state.steps.values()) {
        clearTimeout(step.timer);
        if (['subflow', 'foreach', 'loop'].includes(step.node.type) && state.run.nodes[step.node.id].status === 'waiting_review') { step.waitEnd?.(); continue; }
        step.controller.abort(); if (step.session) { try { await this.app.interrupt(step.session.id); } catch {} } try { await step.prepared?.cleanup?.(); } catch {}
        if (step.childStaging) { try { await step.childStaging; } catch { /* Interrupted copies are not replayed. */ } }
      }
      for (const id of state.running) Object.assign(state.run.nodes[id], { status: 'unknown', error: '应用关闭，执行结果未确认。', completedAt: now() });
      if (state.running.size) Object.assign(state.run, { status: 'unknown', error: '应用关闭，未重放能力。', completedAt: now() });
      this.save(state.run);
    }
  }
}
