import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { planWorkflow } from '../../shared/workflow/workflow-plan.mjs';
import { prepareSkillRun } from './workflow-skill.mjs';
import { executeOperation, validateOperationNode } from './workflow-operations.mjs';
import { redact } from '../hermes-adapter.mjs';
import { WorkflowDAGRuns, validateDAGInput } from './workflow-dag-runs.mjs';

const TERMINAL = new Set(['complete', 'error', 'interrupted', 'unknown']);
const REVISION = /^sha256:[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const PARTIAL_LIMIT = 256 * 1024;
const LOG_LIMIT = 32 * 1024;
const INTERRUPT_CONFIRM_MS = 1500;
const LEARNING_NODE_TYPES = new Set(['evaluation', 'improvement']);
const clone = value => JSON.parse(JSON.stringify(value));
const failure = (message, httpStatus = 400) => Object.assign(new Error(message), { httpStatus });
const errorText = error => redact(error?.message || error || '工作流执行失败。').slice(0, 4000);
const nodeState = () => ({
  status: 'pending', outputText: '', partialText: '', error: '',
  sessionId: null, startedAt: null, completedAt: null,
  logs: { stdout: '', stderr: '' },
});
const learningNodeState = learningId => ({
  ...nodeState(), status: 'skipped',
  reason: learningId ? '由学习控制器管理' : '执行模式跳过学习支路',
});

function jsonValue(value, depth = 0) {
  if (depth > 100) throw failure('输入嵌套过深。');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw failure('输入必须是有效 JSON 数据。');
  }
  if (Object.getOwnPropertySymbols(value).length) throw failure('输入必须是有效 JSON 数据。');
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (Array.isArray(value) && key === 'length') continue;
    if (!Object.hasOwn(descriptor, 'value')) throw failure('输入不能包含访问器。');
    jsonValue(descriptor.value, depth + 1);
  }
}

function matches(value, type) {
  if (type === 'any') return true;
  if (type === 'text') return typeof value === 'string';
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function transferValue(value, type, optional = false) {
  jsonValue(value);
  if (!(optional && value === null) && !matches(value, type)) throw failure('输入必须是 ' + type + ' 类型。');
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > 64 * 1024) throw failure('输入不能超过 64KB JSON。', 413);
  return JSON.parse(serialized);
}

export function validateWorkflowInput(input, planned) {
  if (planned.document?.schemaVersion === 2) return validateDAGInput(input, planned);
  const missing = input === undefined || input === null;
  if (planned.inputNode.config.required && (missing || (typeof input === 'string' && !input.trim()))) {
    throw failure('请提供工作流所需的输入。');
  }
  const optional = missing && !planned.inputNode.config.required;
  const value = transferValue(input === undefined ? null : input, planned.inputNode.config.outputType, optional);
  return transferValue(value, planned.operationNodes[0].config.inputType, optional);
}

function appendPartial(previous, text, limit = PARTIAL_LIMIT) {
  const remaining = limit - Buffer.byteLength(previous, 'utf8');
  if (remaining <= 0) return previous;
  return previous + new StringDecoder('utf8').write(Buffer.from(text.slice(0, remaining)).subarray(0, remaining));
}

function resultValue(text, type) {
  if (type === 'text') return text;
  let value;
  try { value = JSON.parse(text); }
  catch {
    if (type === 'any') return text;
    throw failure('Skill 最终结果不是有效的 ' + type + ' JSON。');
  }
  jsonValue(value);
  if (!matches(value, type)) throw failure('Skill 最终结果必须是 ' + type + ' 类型。');
  return value;
}

function normalize(run) {
  const nodes = run.document?.nodes || [];
  const skillNodes = nodes.filter(node => node.type === 'skill');
  const operationNodes = nodes.filter(node => ['skill', 'tool'].includes(node.type));
  const legacy = !run.skills || !run.nodeOrder;
  if (!run.nodeOrder) {
    try { run.nodeOrder = planWorkflow(run.document).nodeOrder; }
    catch { run.nodeOrder = nodes.map(node => node.id); }
  }
  if (!run.skills) run.skills = run.skill && skillNodes[0] ? [{ nodeId: skillNodes[0].id, ...run.skill }] : [];
  if (!run.currentNodeId) run.currentNodeId = operationNodes.find(node => ['running', 'waiting'].includes(run.nodes?.[node.id]?.status))?.id
    || operationNodes.at(-1)?.id || null;
  for (const node of nodes) {
    if (LEARNING_NODE_TYPES.has(node.type)) {
      // These are controller actions, never operations inside a business run.
      // Normalize old pending entries without borrowing any business I/O.
      run.nodes[node.id] = learningNodeState(run.learningId);
      continue;
    }
    const previous = run.nodes?.[node.id] || {};
    run.nodes[node.id] = { ...nodeState(), ...previous };
    if (node.type === 'input' && !Object.hasOwn(previous, 'input')) run.nodes[node.id].input = clone(run.input);
    if (legacy && node.type === 'skill' && skillNodes.length === 1) {
      if (!run.nodes[node.id].sessionId) run.nodes[node.id].sessionId = run.sessionId;
      if (['running', 'waiting', 'complete'].includes(previous.status) && !Object.hasOwn(previous, 'input')) {
        run.nodes[node.id].input = clone(run.input);
      }
      if (previous.status === 'complete' && run.status === 'complete') {
        run.nodes[node.id].outputText = previous.outputText || run.outputText || '';
        if (!Object.hasOwn(previous, 'output') && Object.hasOwn(run, 'output')) run.nodes[node.id].output = clone(run.output);
      }
    }
    if (node.type === 'output' && previous.status === 'complete' && !Object.hasOwn(previous, 'input')) {
      run.nodes[node.id].input = clone(run.output);
    }
    if (legacy && node.type === 'output' && previous.status === 'complete' && run.status === 'complete') {
      if (!Object.hasOwn(previous, 'output') && Object.hasOwn(run, 'output')) run.nodes[node.id].output = clone(run.output);
      run.nodes[node.id].outputText = previous.outputText || run.outputText || '';
    }
  }
  return run;
}

export class WorkflowRuns {
  constructor(app, { prepareSkill = prepareSkillRun, executeOperation: execute = executeOperation,
    validateOperationNode: validate = validateOperationNode } = {}) {
    this.app = app;
    this.db = app.store.db;
    this.prepareSkill = prepareSkill;
    this.executeOperation = execute;
    this.validateOperationNode = validate;
    this.active = new Map();
    this.locks = new Map();
    this.closed = false;
    this.db.exec('CREATE TABLE IF NOT EXISTS workflow_runs (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.write = this.db.prepare('INSERT INTO workflow_runs(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value');
    this.dag = new WorkflowDAGRuns(this);
    for (const row of this.db.prepare("SELECT value FROM workflow_runs WHERE coalesce(json_extract(value,'$.schemaVersion'),1)=1 AND json_extract(value,'$.status') IN ('preparing','running','waiting')").all()) {
      const run = normalize(JSON.parse(row.value));
      this.commitFailure(run, 'unknown', '应用重启；请恢复会话核对，未自动重放工作流。', run.currentNodeId, false);
    }
    this.onEvent = event => this.handleEvent(event);
    app.on('event', this.onEvent);
  }

  save(run, publish = true) {
    this.write.run(run.id, JSON.stringify(run));
    if (publish && !this.closed) this.app.publish('workflow.run', run.sessionId || null, clone(run));
  }

  get(id) {
    if (this.dag.has(id)) return this.dag.get(id);
    const active = this.active.get(id)?.run;
    const row = active ? null : this.db.prepare('SELECT value FROM workflow_runs WHERE id=?').get(id);
    if (!active && !row) throw failure('工作流运行不存在。', 404);
    return clone(active || normalize(JSON.parse(row.value)));
  }

  list(workflowId) {
    if (workflowId !== undefined && typeof workflowId !== 'string') throw failure('无效的工作流 ID。');
    const rows = workflowId === undefined
      ? this.db.prepare("SELECT value FROM workflow_runs ORDER BY json_extract(value,'$.startedAt') DESC,rowid DESC LIMIT 20").all()
      : this.db.prepare("SELECT value FROM workflow_runs WHERE json_extract(value,'$.workflowId')=? ORDER BY json_extract(value,'$.startedAt') DESC,rowid DESC LIMIT 20").all(workflowId);
    return rows.map(row => {
      const run = JSON.parse(row.value);
      return run.schemaVersion === 2 ? this.dag.get(run.id) : clone(this.active.get(run.id)?.run || normalize(run));
    });
  }

  ownsSession(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    return !!this.db.prepare(
      "SELECT 1 FROM workflow_runs AS runs WHERE json_extract(runs.value,'$.sessionId')=? OR EXISTS "
      + "(SELECT 1 FROM json_each(runs.value,'$.nodes') AS node WHERE json_extract(node.value,'$.sessionId')=?) LIMIT 1"
    ).get(sessionId, sessionId);
  }

  allowsSubmit(sessionId, runId) {
    if (this.dag.allowsSubmit(sessionId, runId)) return true;
    const state = this.active.get(runId);
    const step = state?.steps[state.currentIndex];
    return typeof sessionId === 'string' && !!step && step.node.type === 'skill'
      && !this.closed && !state.halted && !state.stopRequested && !step.terminalReceived
      && state.run.currentNodeId === step.node.id && step.session?.id === sessionId && step.submitted
      && ['preparing', 'running'].includes(state.run.status);
  }

  async start({ document, input, outputDirectory } = {}, { learningId, memoryScopeId, scheduleId, scheduledAt, scheduleName, canStart, onCreated } = {}) {
    if (document?.schemaVersion === 2) return this.dag.start({ document, input, outputDirectory }, { learningId, memoryScopeId, scheduleId, scheduledAt, scheduleName, canStart, onCreated });
    if (this.closed) throw failure('执行管理器已关闭。', 503);
    const checkAdmission = () => {
      this.app.workflowLibrary?.assertRunnable?.(document?.id);
      if (canStart && !canStart()) throw failure('定时任务已暂停、修改、删除或调度器已关闭，未启动新运行。', 409);
    };
    checkAdmission();
    if (scheduleId && (!UUID.test(scheduleId) || learningId || typeof scheduledAt !== 'string'
      || !Number.isFinite(Date.parse(scheduledAt)) || typeof scheduleName !== 'string' || scheduleName.length > 120)) {
      throw failure('定时运行来源无效。');
    }
    const planned = planWorkflow(document);
    planned.operationNodes ||= planned.skillNodes;
    for (const node of planned.operationNodes) if (node.type !== 'skill') this.validateOperationNode(node);
    const value = validateWorkflowInput(input, planned);
    const workflowId = planned.document.id;
    if ((learningId || memoryScopeId) && (!UUID.test(learningId || '') || memoryScopeId !== learningId)) {
      throw failure('学习运行缺少有效的同批次固定记忆。', 409);
    }
    if (learningId && !this.app.learning?.allowsWorkflow(workflowId, learningId, memoryScopeId)) {
      throw failure('学习批次已停止，未创建新的流程运行。', 409);
    }
    if (this.app.learning?.isLocked(workflowId) && !this.app.learning.allowsWorkflow(workflowId, learningId, memoryScopeId)) {
      throw failure('此工作流正在学习，请先停止学习后再执行。', 409);
    }
    if (this.locks.has(workflowId)) throw failure('此工作流已有正在准备或执行的运行。', 409);
    const lease = {};
    this.locks.set(workflowId, lease);
    let state;
    try {
      const details = new Map();
      for (const node of planned.skillNodes) {
        const skill = await this.app.skill(node.config.skillRef);
        if (this.closed) throw failure('执行管理器已关闭。', 503);
        checkAdmission();
        if (skill.name !== node.config.skillRef || !REVISION.test(skill.revision) || skill.revision !== node.config.version) {
          throw failure('Skill 版本已变化，请重新选择后运行。', 409);
        }
        details.set(node.id, skill);
      }
      if (learningId && !this.app.learning?.allowsWorkflow(workflowId, learningId, memoryScopeId)) {
        throw failure('学习批次已停止，未创建新的流程运行。', 409);
      }
      checkAdmission();
      const cwd = planned.operationNodes.some(node => node.type !== 'skill')
        ? this.app.workspace(this.app.preferences?.defaultWorkspace || '.') : null;
      const now = new Date().toISOString();
      const run = {
        id: randomUUID(), workflowId, title: planned.document.title, status: 'preparing',
        document: planned.document, nodeOrder: planned.nodeOrder, currentNodeId: planned.operationNodes[0].id,
        skills: planned.skillNodes.map(node => {
          const skill = details.get(node.id);
          return { nodeId: node.id, name: skill.name, revision: skill.revision, source: skill.source };
        }),
        input: value, output: null, outputText: '', partialText: '', error: '', sessionId: null,
        startedAt: now, completedAt: null,
        ...(scheduleId ? { trigger: { type: 'schedule', scheduleId, scheduledAt, scheduleName } } : {}),
        ...(learningId ? { learningId, memoryScopeId,
          memoryPolicy: { mode: 'pending', memoryWriteAllowed: null, externalMemoryAllowed: null } } : {}),
        nodes: Object.fromEntries(planned.document.nodes.map(node => [node.id,
          LEARNING_NODE_TYPES.has(node.type) ? learningNodeState(learningId) : nodeState()])),
      };
      run.skill = run.skills[0] || null;
      run.nodes[planned.inputNode.id] = {
        ...nodeState(), status: 'complete', input: clone(value), output: clone(value), startedAt: now, completedAt: now,
      };
      state = {
        run, planned, cwd, currentIndex: -1, epoch: 0, halted: false, stopRequested: false, requests: new Set(), lateAudits: new Map(),
        steps: planned.operationNodes.map((node, index) => ({ node, index, detail: details.get(node.id), stepId: randomUUID(), submitted: false })),
      };
      this.active.set(run.id, state);
      this.locks.set(workflowId, run.id);
      onCreated?.(clone(run));
      this.save(run);
      // Freeze every Skill before executing any model, code or tool operation.
      for (const step of state.steps) {
        if (step.node.type !== 'skill') continue;
        if (this.closed || state.halted) return this.closed ? clone(run) : this.get(run.id);
        run.currentNodeId = step.node.id;
        run.sessionId = null;
        const session = await this.app.createSession({ title: '工作流 · ' + run.title + ' · ' + (step.index + 1) + '/' + state.steps.length + ' ' + step.node.title,
          ...(cwd ? { cwd } : {}) });
        step.session = session;
        run.nodes[step.node.id].sessionId = session.id;
        run.sessionId = session.id;
        if (this.closed) return clone(run);
        this.save(run);
        if (state.halted) return this.get(run.id);
        if (state.stopRequested) throw failure('准备期间已停止。');
        const prepared = await this.prepareSkill(this.app, session, step.detail, {
          input: step.index === 0 ? clone(value) : null, inputNode: planned.inputNode, skillNode: step.node,
          outputNode: planned.outputNode, runId: run.id, stepId: step.stepId, nodeId: step.node.id, workflowId,
          ...(learningId ? { learningId, memoryScopeId } : {}),
        });
        step.prepared = prepared;
        if (this.closed || state.halted) {
          try { await this.cleanupStep(step); }
          catch (cause) {
            if (!this.closed) {
              const audit = 'Skill 收尾校验失败（' + step.node.title + '）：' + errorText(cause);
              state.lateAudits.set(step.node.id, audit);
              state.run.error = [state.run.error, audit].filter(Boolean).join(' ');
              const node = state.run.nodes[step.node.id];
              node.error = [node.error, audit].filter(Boolean).join(' ');
              this.save(state.run);
            }
          }
          return this.closed ? clone(run) : this.get(run.id);
        }
        if (prepared?.skill?.name !== step.detail.name || prepared.skill.revision !== step.detail.revision) {
          throw failure('Skill 准备版本与已选择版本不一致。');
        }
        if (state.steps.length > 1 && typeof prepared.bindInput !== 'function') throw failure('串联执行需要从固定快照绑定每一步输入。');
        for (const key of ['bundleHash', 'snapshotDirectory']) {
          if (typeof prepared.skill[key] === 'string') run.skills.find(skill => skill.nodeId === step.node.id)[key] = prepared.skill[key];
        }
        this.save(run);
        if (state.stopRequested) throw failure('准备期间已停止。');
      }
      if (learningId) {
        run.memoryPolicy = { mode: 'batch-snapshot', memoryWriteAllowed: false, externalMemoryAllowed: false };
        this.save(run);
      }
      await this.launchStep(state, 0, value);
      return this.closed ? clone(run) : this.get(run.id);
    } catch (error) {
      if (!state) throw error;
      if (!state.halted) await this.terminate(state, state.stopRequested ? 'interrupted' : 'error', errorText(error));
      return this.closed ? clone(state.run) : this.get(state.run.id);
    } finally {
      if (this.locks.get(workflowId) === lease) this.locks.delete(workflowId);
    }
  }

  isCurrent(state, step, epoch) {
    return !this.closed && !state.halted && !TERMINAL.has(state.run.status)
      && state.currentIndex === step.index && state.epoch === epoch && state.run.currentNodeId === step.node.id;
  }

  async launchStep(state, index, input) {
    if (this.closed || state.halted) return;
    const step = state.steps[index];
    const epoch = ++state.epoch;
    state.currentIndex = index;
    state.requests.clear();
    step.terminalReceived = false;
    const { run } = state;
    const node = run.nodes[step.node.id];
    run.currentNodeId = step.node.id;
    run.sessionId = step.session?.id || null;
    run.partialText = '';
    run.status = 'running';
    node.status = 'running';
    node.input = clone(input);
    node.startedAt = new Date().toISOString();
    this.save(run);
    if (!this.isCurrent(state, step, epoch)) return;
    try {
      transferValue(input, step.node.config.inputType, index === 0 && input === null && !state.planned.inputNode.config.required);
      if (state.stopRequested) { await this.terminate(state, 'interrupted', '已请求停止本次工作流。'); return; }
      if (step.node.type !== 'skill') {
        node.runtime = step.node.config.executionMode === 'code'
          ? { kind: 'code', language: step.node.config.language }
          : { kind: 'tool', toolName: step.node.config.toolName };
        step.controller = new AbortController();
        step.submitted = true;
        step.timer = setTimeout(() => { void this.requestInterrupt(state, true); }, step.node.config.timeoutSeconds * 1000);
        step.timer.unref?.();
        // The HTTP acknowledgment must not wait for a worker or the rest of the chain.
        step.executionPromise = this.executeStep(state, step, epoch, clone(input));
        return;
      }
      const bound = typeof step.prepared.bindInput === 'function'
        ? await step.prepared.bindInput(clone(input)) : { text: step.prepared.text };
      if (!this.isCurrent(state, step, epoch)) return;
      if (state.stopRequested) { await this.terminate(state, 'interrupted', '已请求停止本次工作流。'); return; }
      if (typeof bound?.text !== 'string' || !bound.text.trim() || bound.text.length > 200000) {
        throw failure('Skill 准备结果缺少有效的执行指令。');
      }
      step.timer = setTimeout(() => { void this.requestInterrupt(state, true); }, step.node.config.timeoutSeconds * 1000);
      step.timer.unref?.();
      step.submitted = true;
      await this.app.submit(step.session.id, bound.text, { workflowRunId: run.id });
    } catch (error) {
      if (this.isCurrent(state, step, epoch) && !step.terminalReceived) {
        await this.terminate(state, step.submitted ? 'unknown' : 'error', errorText(error));
      }
    }
  }

  scheduleSave(state) {
    if (state.publishTimer) return;
    state.publishTimer = setTimeout(() => {
      state.publishTimer = null;
      if (!this.closed && !state.halted) this.save(state.run);
    }, 100);
    state.publishTimer.unref?.();
  }

  async executeStep(state, step, epoch, input) {
    try {
      if (!this.isCurrent(state, step, epoch) || state.stopRequested) return;
      const result = await this.executeOperation({ node: step.node, input, cwd: state.cwd,
        context: { runId: state.run.id, workflowId: state.run.workflowId, nodeId: step.node.id,
          ...(state.run.learningId ? { learningId: state.run.learningId } : {}) },
        signal: step.controller.signal, pythonPath: this.app.config?.hermesPython,
        onLog: log => {
          if (!this.isCurrent(state, step, epoch) || state.stopRequested || step.terminalReceived || !log
            || !['stdout', 'stderr'].includes(log.stream) || typeof log.text !== 'string') return;
          const logs = state.run.nodes[step.node.id].logs;
          const previous = logs[log.stream];
          logs[log.stream] = appendPartial(previous, log.text, LOG_LIMIT);
          if (log.truncated || Buffer.byteLength(previous, 'utf8') + Buffer.byteLength(log.text, 'utf8') > LOG_LIMIT) {
            logs[log.stream + 'Truncated'] = true;
          }
          this.scheduleSave(state);
        },
      });
      if (!this.isCurrent(state, step, epoch) || state.stopRequested) return;
      if (!result || !Object.hasOwn(result, 'output')) throw failure('能力节点没有返回正式输出。');
      const value = transferValue(result.output, step.node.config.outputType);
      const outputText = typeof result.outputText === 'string' ? result.outputText
        : typeof value === 'string' ? value : JSON.stringify(value);
      const node = state.run.nodes[step.node.id];
      if (result.runtime) { jsonValue(result.runtime); node.runtime = clone(result.runtime); }
      step.terminalReceived = true;
      this.clearStepTimers(step);
      await this.confirmStep(state, step, epoch, value, outputText);
    } catch (error) {
      if (this.isCurrent(state, step, epoch)) {
        await this.terminate(state, state.stopRequested && !state.timedOut ? 'interrupted' : 'error', errorText(error));
      }
    }
  }

  handleEvent(event) {
    this.dag.handleEvent(event);
    if (this.closed || !event || event.type === 'workflow.run') return;
    if (event.type === 'backend.status' && ['disconnected', 'error', 'stopped'].includes(event.payload?.state)) {
      for (const state of this.active.values()) {
        if (!state.halted && state.planned.skillNodes.length) void this.terminate(state, 'unknown', 'Hermes 连接中断；未自动重放工作流。');
      }
      return;
    }
    const state = [...this.active.values()].find(item => item.currentIndex >= 0 && item.run.sessionId
      && item.run.sessionId === event.sessionId);
    const step = state?.steps[state.currentIndex];
    if (!step || state.halted || step.terminalReceived || TERMINAL.has(state.run.status)) return;
    const { run } = state;
    const node = run.nodes[step.node.id];
    const payload = event.payload || {};
    if (!step.submitted && ['message.complete', 'message.delta', 'request.open', 'request.cancel'].includes(event.type)) return;
    if (event.type === 'message.complete') {
      step.terminalReceived = true;
      this.clearStepTimers(step);
      if (state.publishTimer) clearTimeout(state.publishTimer);
      state.publishTimer = null;
      const success = payload.status === 'complete' && !payload.partial && !payload.error;
      if (success) {
        step.finalizing = this.completeStep(state, step, state.epoch);
      } else {
        const reason = payload.error || payload.failure_reason || (state.timedOut ? '运行已超时并请求中断。'
          : payload.status === 'interrupted' ? 'Hermes 已中断本次运行。' : 'Hermes 未确认成功：' + (payload.status || '未知状态') + '。');
        void this.terminate(state, payload.status === 'interrupted' ? 'interrupted' : 'error', errorText(reason));
      }
    } else if (event.type === 'error') {
      void this.terminate(state, 'error', errorText(payload.message || 'Hermes 执行失败。'));
    } else if (event.type === 'request.open') {
      state.requests.add(String(payload.id));
      run.status = 'waiting'; node.status = 'waiting';
      this.save(run);
    } else if (event.type === 'request.cancel') {
      state.requests.delete(String(payload.id));
      if (!state.requests.size && run.status === 'waiting') {
        run.status = 'running'; node.status = 'running';
        this.save(run);
      }
    } else if (event.type === 'message.delta' && typeof payload.text === 'string') {
      const text = appendPartial(node.partialText, payload.text);
      if (text === node.partialText) return;
      node.partialText = text; run.partialText = text;
      this.scheduleSave(state);
    }
  }

  async completeStep(state, step, epoch) {
    try {
      const history = await this.app.history(step.session.id);
      if (!this.isCurrent(state, step, epoch)) return;
      const last = (history.messages || []).filter(message => message.role === 'assistant').at(-1);
      if (!last || typeof last.text !== 'string' || last.partial || last.tool_calls?.length || last.toolCalls?.length) {
        throw failure('Hermes 历史中没有已完成的最终助手结果。');
      }
      const value = transferValue(resultValue(last.text, step.node.config.outputType), step.node.config.outputType);
      try { await this.cleanupStep(step); }
      catch (cause) { throw failure('Skill 收尾校验失败：' + errorText(cause)); }
      if (!this.isCurrent(state, step, epoch)) return;
      await this.confirmStep(state, step, epoch, value, last.text);
    } catch (error) {
      if (this.isCurrent(state, step, epoch)) await this.terminate(state, 'error', errorText(error));
    }
  }

  async confirmStep(state, step, epoch, value, outputText) {
    if (!this.isCurrent(state, step, epoch)) return;
    if (state.publishTimer) clearTimeout(state.publishTimer);
    state.publishTimer = null;
    const node = state.run.nodes[step.node.id];
    Object.assign(node, { status: 'complete', output: clone(value), outputText, completedAt: new Date().toISOString() });
    this.save(state.run);
    if (!this.isCurrent(state, step, epoch)) return;
    if (state.stopRequested) { await this.terminate(state, 'interrupted', '已请求停止，未继续调度后续节点。', null); return; }
    if (step.index + 1 < state.steps.length) {
      await this.launchStep(state, step.index + 1, value);
    } else {
      const output = state.run.nodes[state.planned.outputNode.id];
      const now = new Date().toISOString();
      Object.assign(output, { status: 'complete', input: clone(value), output: clone(value), outputText, startedAt: now, completedAt: now });
      Object.assign(state.run, { status: 'complete', currentNodeId: state.planned.outputNode.id,
        output: clone(value), outputText, completedAt: now, error: '' });
      state.halted = true; state.epoch++;
      this.save(state.run);
      this.release(state);
    }
  }

  clearStepTimers(step) {
    for (const key of ['timer', 'confirmTimer']) {
      if (step[key]) clearTimeout(step[key]);
      step[key] = null;
    }
  }

  cleanupStep(step) {
    if (!step.cleanupPromise && typeof step.prepared?.cleanup === 'function') {
      step.cleanupPromise = Promise.resolve().then(() => step.prepared.cleanup());
    }
    return step.cleanupPromise || Promise.resolve();
  }

  async cleanupAll(state) {
    const results = await Promise.allSettled(state.steps.map(step => this.cleanupStep(step)));
    return results.filter(result => result.status === 'rejected').map(result => 'Skill 收尾校验失败：' + errorText(result.reason));
  }

  terminate(state, status, error, nodeId = state.run.currentNodeId) {
    if (state.halted) return state.finishing || Promise.resolve();
    state.halted = true; state.epoch++;
    for (const step of state.steps) {
      this.clearStepTimers(step);
      step.controller?.abort();
    }
    if (state.publishTimer) clearTimeout(state.publishTimer);
    state.publishTimer = null;
    state.finishing = (async () => {
      const cleanupErrors = await this.cleanupAll(state);
      this.commitFailure(state.run, status, [...new Set([error, ...cleanupErrors, ...state.lateAudits.values()].filter(Boolean))].join(' '), nodeId);
      this.release(state);
    })();
    return state.finishing;
  }

  commitFailure(run, status, error, nodeId, publish = true) {
    const now = new Date().toISOString();
    Object.assign(run, { status, error, output: null, outputText: '', completedAt: now });
    for (const definition of run.document.nodes) {
      const node = run.nodes[definition.id];
      if (LEARNING_NODE_TYPES.has(definition.type)) {
        run.nodes[definition.id] = learningNodeState(run.learningId);
        continue;
      }
      if (definition.type === 'input' || node.status === 'complete') continue;
      Object.assign(node, { status: ['skill', 'tool'].includes(definition.type) && definition.id === nodeId ? status : 'skipped',
        completedAt: now, error: definition.id === nodeId ? error : '' });
    }
    this.save(run, publish);
  }

  release(state) {
    this.active.delete(state.run.id);
    if (this.locks.get(state.run.workflowId) === state.run.id) this.locks.delete(state.run.workflowId);
  }

  async requestInterrupt(state, timedOut = false) {
    if (this.closed || state.halted || TERMINAL.has(state.run.status)) return this.get(state.run.id);
    if (state.stopRequested) return this.get(state.run.id);
    state.stopRequested = true; state.timedOut = timedOut;
    const step = state.steps[state.currentIndex];
    if (!step || !step.submitted) {
      await this.terminate(state, 'interrupted', '准备期间已停止。');
      return this.get(state.run.id);
    }
    if (step.node.type !== 'skill') {
      step.controller?.abort();
      await this.terminate(state, timedOut ? 'error' : 'interrupted', timedOut
        ? '能力节点运行超时，已停止本地执行，未继续调度后续节点。' : '已停止本地执行，未继续调度后续节点。');
      return this.get(state.run.id);
    }
    this.clearStepTimers(step);
    if (step.terminalReceived) return this.get(state.run.id);
    const epoch = state.epoch;
    step.confirmTimer = setTimeout(() => {
      if (this.isCurrent(state, step, epoch) && !step.terminalReceived) void this.terminate(state, 'unknown', timedOut
        ? '运行超时，中断结果尚未确认；未自动重试。' : '中断结果尚未确认；请恢复会话核对。');
    }, INTERRUPT_CONFIRM_MS);
    step.confirmTimer.unref?.();
    try { await this.app.interrupt(step.session.id); }
    catch (error) {
      if (this.isCurrent(state, step, epoch) && !step.terminalReceived) await this.terminate(state, 'unknown', errorText(error));
    }
    return this.closed ? clone(state.run) : this.get(state.run.id);
  }

  interrupt(id) {
    if (this.dag.has(id)) return this.dag.interrupt(id);
    const run = this.get(id);
    if (TERMINAL.has(run.status)) return Promise.resolve(run);
    const state = this.active.get(id);
    return state ? this.requestInterrupt(state) : Promise.resolve(run);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.app.off('event', this.onEvent);
    await this.dag.close();
    await Promise.allSettled([...this.active.values()].map(state => this.terminate(state, 'unknown', '应用关闭；请恢复会话核对，未自动重放工作流。')));
    this.locks.clear();
  }

  approve(id, request) { return this.dag.approve(id, request); }
  rerun(id, request) { return this.dag.rerun(id, request); }
  publishDelivery(id) { return this.dag.publishDelivery(id); }
  queueStatus() { return this.dag.queueStatus(); }
}

