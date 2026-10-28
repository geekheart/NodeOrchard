import { AssistantModelDiagnostics } from './assistant-model-diagnostics.mjs';
import { AssistantModelProbe } from './assistant-model-probe.mjs';
import { AssistantModelExperiment } from './assistant-model-experiment.mjs';
import { readModelRequestTraces } from './model-request-traces.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const identifier = { type: 'string', maxLength: 128, pattern: ID.source };
const fail = (message, httpStatus = 400) => { throw Object.assign(new Error(message), { httpStatus }); };
const definition = (name, description, properties, effect = 'read-only', required = []) => ({ name, description, effect,
  inputSchema: { type: 'object', properties, additionalProperties: false, ...(required.length ? { required } : {}) }, readOnly: effect === 'read-only', availability: 'available',
  annotations: { readOnlyHint: effect === 'read-only', destructiveHint: false, idempotentHint: effect === 'read-only', openWorldHint: false } });
export const ASSISTANT_MODEL_TOOLS = Object.freeze([
  definition('assistant.diagnose', '助手对话失败或超时的首选诊断：一次返回指定会话轮次的所有模型调用时序、输出完整性、字符数、Token覆盖、超时类型和当前等待策略。策略中的期限字段为null表示该期限关闭；整个历史策略为null表示未记录，不能当作零或套用当前默认。省略turnId读取最近失败或已结束轮次。独立助手仅当前工作流，总控需软件日志权限。控制会话不使用session.history；本工具不返回提示词、模型正文或推理。',
    { workflowId: identifier, conversationId: identifier, turnId: identifier }),
  definition('assistant.probe', '单轮最多一次的固定短模型连接探测，等待Hermes或提供商返回结果、错误或用户停止，不设置本地回答时限；不接受prompt/model/provider，不切换模型、不运行工作流、不重试失败请求。不能批量或跨轮缓存；成功仅证明当前短请求可完成，不能证明原复杂任务已恢复。', {}, 'probe'),
  definition('assistant.trace', '分页读取指定已归属模型调用的请求级上游时序、HTTP状态及允许的脱敏请求标识。只读取已保存数字与枚举，不发请求或返回端点、头、正文、提示词。先用assistant.diagnose取得调用序号。',
    { workflowId: identifier, conversationId: identifier, turnId: identifier, callIndex: { type: 'integer', minimum: 1, maximum: 10000 },
      afterRequestIndex: { type: 'integer', minimum: 0, maximum: 32 }, limit: { type: 'integer', minimum: 1, maximum: 4 } }, 'read-only', ['callIndex']),
  definition('assistant.experiment', '人工开启后，每轮总控最多一次合成模型实验。明确turnId和callIndex，以已确认的历史路由、推理配置和相同输入字符规模创建无业务工具的新请求；只使用合成填充，不读取或重跑原任务。次数和输入受人工额度限制，输出仅固定短JSON软约束，无token硬上限，可能产生真实模型消耗。不能批量、缓存或自动重试；缺少配置证据或超额度时明确不可用。',
    { workflowId: identifier, conversationId: identifier, turnId: identifier, callIndex: { type: 'integer', minimum: 1, maximum: 10000 } }, 'experiment', ['turnId', 'callIndex']),
]);
const validId = value => typeof value === 'string' && ID.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value);
const plain = (value, schema) => {
  const names = Object.keys(schema.properties);
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !names.includes(key)
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) fail('助手模型诊断参数无效。');
  for (const key of schema.required || []) if (!Object.hasOwn(value, key)) fail('助手模型诊断缺少明确调用身份。');
  for (const [key, item] of Object.entries(value)) {
    const field = schema.properties[key];
    if (field.type === 'integer' ? !Number.isSafeInteger(item) || item < field.minimum || item > field.maximum : !validId(item)) fail('助手模型诊断目标无效。');
  }
};

// Resolve a conversation turn before reading numeric control-session evidence.
// No model parameter can select a session, database, prompt, or model route.
export class AssistantModelTools {
  constructor(app, owner) {
    this.app = app; this.owner = owner; this.db = app.store.db; this.probed = new Set();
    this.diagnostics = new AssistantModelDiagnostics(this.db, { readSessionMetadata: async id => {
      const session = this.app.store.get?.(id);
      if (!session?.storedSessionId || !this.app.adapter?.request) return null;
      const result = await this.app.adapter.request('workbench.assistant.diagnostics', { stored_session_ids: [session.storedSessionId] }, 5000);
      if (result?.schemaVersion !== 1 || !Array.isArray(result.sessions) || result.sessions.length !== 1
        || result.sessions[0]?.storedSessionId !== session.storedSessionId) return null;
      return result.sessions[0];
    } });
    this.probe = new AssistantModelProbe(app);
  }
  handles(name) { return ASSISTANT_MODEL_TOOLS.some(tool => tool.name === name); }
  currentPolicy() {
    const model = this.app.assistantModel, bounded = value => Number.isSafeInteger(value) && value > 0 ? value : null;
    return { scope: 'current-defaults', firstResponseTimeoutMs: bounded(model?.timeoutMs), outputIdleTimeoutMs: bounded(model?.outputIdleTimeoutMs),
      maxDurationMs: bounded(model?.maxDurationMs), automaticRetry: false, arbitrarySourceMutation: false, businessReplay: false };
  }
  async call(name, args, context) {
    const descriptor = ASSISTANT_MODEL_TOOLS.find(tool => tool.name === name);
    if (!descriptor) fail('未开放此模型诊断工具。', 403);
    plain(args, descriptor.inputSchema);
    const scope = await this.owner.permissions.current(context.permissionScope);
    if (!this.owner.permissions.allowed(name, scope)) fail('当前助手权限未开放此工具。', 403);
    if (context.signal?.aborted) fail('诊断已停止。', 409);
    if (name === 'assistant.probe') {
      if (!validId(context.diagnosticTurnId)) fail('模型探测需要服务端诊断轮次身份。', 403);
      const key = (context.sourceConversationId || scope.workflowId || 'supervisor') + ':' + context.diagnosticTurnId;
      if (this.probed.has(key)) fail('每轮诊断最多进行一次固定模型探测，未重复请求。', 409);
      this.probed.add(key); while (this.probed.size > 1000) this.probed.delete(this.probed.values().next().value);
      return this.probe.run({ signal: context.signal, deadlineAt: context.deadlineAt, modelRoute: context.modelRoute, onSession: context.onSession, onProgress: context.onProgress,
        trace: { ...(scope.workflowId ? { workflowId: scope.workflowId } : {}),
          ...(context.sourceConversationId ? { conversationId: context.sourceConversationId } : {}), turnId: context.diagnosticTurnId } });
    }
    if (name === 'assistant.experiment') {
      if (!this.owner.permissions.allowed('assistant.diagnose', scope)) fail('模型实验需要读取目标诊断元数据的权限。', 403);
      if (!validId(context.diagnosticTurnId) || args.turnId === context.diagnosticTurnId) fail('模型实验需要服务端轮次和已结束的历史目标。', 403);
    }
    const target = await this.resolveTarget(args, context, scope);
    if (name === 'assistant.trace') {
      const call = this.diagnostics.sessionForCall(target, args.callIndex);
      if (context.signal?.aborted) fail('诊断已停止。', 409);
      return { target: { ...(target.workflowId ? { workflowId: target.workflowId } : { conversationId: target.conversationId }), turnId: target.turn.id },
        callIndex: call.index, sessionId: call.sessionId,
        trace: readModelRequestTraces(this.db, call.sessionId, { afterRequestIndex: args.afterRequestIndex, limit: args.limit }) };
    }
    const result = await this.diagnostics.inspect(target, name === 'assistant.experiment' ? { callIndex: args.callIndex } : undefined);
    if (context.signal?.aborted) fail('诊断已停止。', 409);
    if (name === 'assistant.experiment') {
      const call = result.calls.find(row => row.index === args.callIndex);
      if (!call?.sessionId) fail('指定模型调用不存在或未登记归属。', 404);
      this.experiment ||= new AssistantModelExperiment(this.app);
      return this.experiment.run({ reference: { ...result.target, callIndex: call.index, sessionId: call.sessionId,
        provider: call.provider, model: call.model, reasoningEffort: call.reasoningEffort, reasoningEffortWire: call.reasoningEffortWire,
        promptCharacters: call.promptCharacters, modelTerminalConfirmed: call.modelTerminalConfirmed },
      conversationId: context.sourceConversationId || 'global-application', turnId: context.diagnosticTurnId, permissionRevision: scope.revision,
      signal: context.signal, onSession: context.onSession, onProgress: context.onProgress,
      authorize: async () => { const current = await this.owner.permissions.current(scope);
        if (!this.owner.permissions.allowed('assistant.experiment', current) || !this.owner.permissions.allowed('assistant.diagnose', current)) fail('模型实验权限已关闭。', 403); },
      });
    }
    return { ...result, currentPolicy: this.currentPolicy() };
  }
  async resolveTarget(args, context, scope) {
    if (args.workflowId && args.conversationId) fail('只能指定一种助手诊断目标。');
    const workflowId = args.workflowId || (!args.conversationId ? scope.workflowId : null);
    const conversationId = args.conversationId || (!workflowId ? context.sourceConversationId : null);
    let turn;
    if (workflowId) {
      this.owner.permissions.workflow(workflowId, scope); this.app.workflowLibrary.get(workflowId);
      const row = args.turnId
        ? this.db.prepare('SELECT value FROM workflow_conversation_turns WHERE workflow_id=? AND id=?').get(workflowId, args.turnId)
        : this.db.prepare(`SELECT value FROM workflow_conversation_turns WHERE workflow_id=? AND id<>? AND json_extract(value,'$.status') NOT IN ('thinking','queued')
            ORDER BY CASE WHEN json_extract(value,'$.status') IN ('error','interrupted') THEN 0 ELSE 1 END,rowid DESC LIMIT 1`)
          .get(workflowId, context.diagnosticTurnId || '');
      if (!row) fail('该工作流没有对应的助手诊断轮次。', 404);
      turn = JSON.parse(row.value);
    } else {
      if (!conversationId || scope.role !== 'supervisor' || !scope.permissions.appLogs) fail('总控会话诊断需要明确目标及软件日志权限。', 403);
      if (conversationId !== context.sourceConversationId && !scope.permissions.crossWorkflowRead) fail('当前总控没有跨会话读取权限。', 403);
      this.owner.assertConversation(conversationId);
      const row = args.turnId ? { id: args.turnId }
        : this.db.prepare(`SELECT t.id FROM application_conversation_turns t LEFT JOIN application_conversation_membership m ON m.turn_id=t.id
            WHERE COALESCE(m.conversation_id,'global-application')=? AND t.id<>? AND json_extract(t.value,'$.status') NOT IN ('thinking','queued')
            ORDER BY CASE WHEN json_extract(t.value,'$.status') IN ('error','interrupted') THEN 0 ELSE 1 END,t.rowid DESC LIMIT 1`)
          .get(conversationId, context.diagnosticTurnId || '');
      if (!row) fail('该总控会话没有对应的助手诊断轮次。', 404);
      turn = { ...this.owner.readTurn(row.id, conversationId), conversationId };
    }
    return { ...(workflowId ? { workflowId } : { conversationId }), turn };
  }
}
