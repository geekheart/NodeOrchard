import { AssistantModelDiagnostics } from './assistant-model-diagnostics.mjs';
import { AssistantModelProbe } from './assistant-model-probe.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const identifier = { type: 'string', maxLength: 128, pattern: ID.source };
const fail = (message, httpStatus = 400) => { throw Object.assign(new Error(message), { httpStatus }); };
const definition = (name, description, properties, effect = 'read-only') => ({ name, description, effect,
  inputSchema: { type: 'object', properties, additionalProperties: false }, readOnly: effect === 'read-only', availability: 'available',
  annotations: { readOnlyHint: effect === 'read-only', destructiveHint: false, idempotentHint: effect === 'read-only', openWorldHint: false } });
export const ASSISTANT_MODEL_TOOLS = Object.freeze([
  definition('assistant.diagnose', '助手对话失败或超时的首选诊断：一次返回指定会话轮次的所有模型调用时序、输出完整性、字符数、Token覆盖、超时类型和当前等待策略。策略中的期限字段为null表示该期限关闭；整个历史策略为null表示未记录，不能当作零或套用当前默认。省略turnId读取最近失败或已结束轮次。独立助手仅当前工作流，总控需软件日志权限。控制会话不使用session.history；本工具不返回提示词、模型正文或推理。',
    { workflowId: identifier, conversationId: identifier, turnId: identifier }),
  definition('assistant.probe', '单轮最多一次的固定短模型连接探测，等待Hermes或提供商返回结果、错误或用户停止，不设置本地回答时限；不接受prompt/model/provider，不切换模型、不运行工作流、不重试失败请求。不能批量或跨轮缓存；成功仅证明当前短请求可完成，不能证明原复杂任务已恢复。', {}, 'probe'),
]);
const validId = value => typeof value === 'string' && ID.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value);
const plain = (value, names) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !names.includes(key)
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) fail('助手模型诊断参数无效。');
  for (const item of Object.values(value)) if (!validId(item)) fail('助手模型诊断目标无效。');
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
    plain(args, Object.keys(descriptor.inputSchema.properties));
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
    const result = await this.diagnostics.inspect({ ...(workflowId ? { workflowId } : { conversationId }), turn });
    if (context.signal?.aborted) fail('诊断已停止。', 409);
    return { ...result, currentPolicy: this.currentPolicy() };
  }
}
