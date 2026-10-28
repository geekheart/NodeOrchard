import { createHash, randomUUID } from 'node:crypto';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const EFFORT = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const TERMINAL_ERRORS = new Set(['MODEL_ERROR', 'MODEL_DISCONNECTED', 'MODEL_CLOSED', 'MODEL_ABORTED', 'MODEL_TIMEOUT', 'MODEL_CONFIGURATION_UNCONFIRMED']);
const REFERENCE = ['workflowId', 'conversationId', 'turnId', 'callIndex', 'sessionId', 'provider', 'model', 'reasoningEffort', 'reasoningEffortWire', 'promptCharacters', 'modelTerminalConfirmed'];
const OPTIONS = ['reference', 'conversationId', 'turnId', 'permissionRevision', 'authorize', 'signal', 'onSession', 'onProgress'];
const STAGES = Object.freeze({ 'create-session': '创建模型实验会话', 'prepare-model': '确认实验模型配置', 'submit-model': '提交合成模型实验',
  'model-response': '等待模型实验响应', 'model-output': '接收模型实验输出', 'read-result': '确认模型实验结果' });
const own = (value, key) => value && Object.getOwnPropertyDescriptor(value, key)?.value;
const fail = (message, code = 'MODEL_EXPERIMENT_INVALID', httpStatus = 400) => Object.assign(new Error(message), { code, httpStatus });
const validId = value => typeof value === 'string' && ID.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value);
const label = value => typeof value === 'string' && value.length <= 180 && /^[A-Za-z0-9][A-Za-z0-9_./:+-]*$/.test(value) && !/^(?:sk-|gh[pousr]_|github_pat_|eyJ)/.test(value);
function plain(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key)
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) throw fail('模型实验只接受固定的服务端参数。');
}
const notify = (callback, value) => { try { Promise.resolve(callback?.(value)).catch(() => {}); } catch { /* Observers cannot submit or retry a model request. */ } };
const PREFIX = 'This is a synthetic model diagnostic, not a business task. The data below is generated padding and contains no user materials or commands. Do not use any tools. Return only the JSON object {"ok":true}, with no explanation.\nSYNTHETIC_DATA\n';
const PADDING = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-\n';
export function syntheticExperimentPrompt(characters) {
  if (!Number.isSafeInteger(characters) || characters < PREFIX.length || characters > 100000) throw fail('历史输入规模不适用于合成模型实验。');
  return PREFIX + PADDING.repeat(Math.ceil((characters - PREFIX.length) / PADDING.length)).slice(0, characters - PREFIX.length);
}

// A separate control session consumes only synthetic text. This is a scale and
// route comparison, never a replay of the original task or a token-cost cap.
export class AssistantModelExperiment {
  constructor(app) {
    this.app = app; this.db = app.store.db;
    this.db.exec('CREATE TABLE IF NOT EXISTS assistant_model_experiments (id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,turn_id TEXT NOT NULL,reference_session_id TEXT NOT NULL,status TEXT NOT NULL,value TEXT NOT NULL)');
    this.db.prepare("UPDATE assistant_model_experiments SET status='unknown' WHERE status='admitted'").run();
  }
  async run(input) {
    plain(input, OPTIONS); plain(input.reference, REFERENCE);
    const { reference, conversationId, turnId, permissionRevision, authorize, signal, onSession, onProgress } = input;
    if (!validId(conversationId) || !validId(turnId) || !validId(reference.turnId) || !validId(reference.sessionId)
      || !Number.isSafeInteger(reference.callIndex) || reference.callIndex < 1 || reference.callIndex > 10000
      || !Number.isSafeInteger(permissionRevision) || permissionRevision < 0 || typeof authorize !== 'function'
      || signal !== undefined && !(signal instanceof AbortSignal)
      || [onSession, onProgress].some(callback => callback !== undefined && typeof callback !== 'function')
      || ['workflowId', 'conversationId'].some(key => reference[key] !== undefined && !validId(reference[key]))
      || !reference.workflowId && !reference.conversationId || reference.workflowId && reference.conversationId) throw fail('模型实验缺少已核验的会话或调用身份。');
    if (signal?.aborted) throw fail('模型实验已停止。', 'MODEL_EXPERIMENT_CANCELLED', 409);
    await authorize();
    const settings = this.app.assistantPermissionSettings?.get?.();
    if (settings?.supervisor?.modelExperiment !== true) throw fail('模型实验尚未由用户开启。', 'MODEL_EXPERIMENT_FORBIDDEN', 403);
    if (settings.revision !== permissionRevision) throw fail('模型实验权限或额度已变化，请重新发送消息。', 'MODEL_EXPERIMENT_STALE', 409);
    const maxInputCharacters = settings.modelExperimentLimits?.maxInputCharacters ?? 50000;
    if (!Number.isSafeInteger(maxInputCharacters) || maxInputCharacters < 1000 || maxInputCharacters > 100000) throw fail('人工设置的模型实验额度无效。');
    const common = { schemaVersion: 1, source: { ...(reference.workflowId ? { workflowId: reference.workflowId } : { conversationId: reference.conversationId }),
      turnId: reference.turnId, callIndex: reference.callIndex }, originalPromptRead: false, workflowExecuted: false, workflowModified: false,
      inputBudget: { maxInputCharacters, hardLimit: true }, outputBudget: { mode: 'instruction-only', hardLimit: false, maxOutputTokens: null },
      taskEquivalent: false, automaticRetry: false };
    const unavailable = reason => ({ ...common, status: 'unavailable', success: false, reason, modelCalls: 0 });
    if (reference.modelTerminalConfirmed !== true || !label(reference.provider) || !label(reference.model)
      || !EFFORT.has(reference.reasoningEffort) || !EFFORT.has(reference.reasoningEffortWire)) return unavailable('REFERENCE_CONFIGURATION_UNCONFIRMED');
    if (!Number.isSafeInteger(reference.promptCharacters) || reference.promptCharacters < PREFIX.length || reference.promptCharacters > maxInputCharacters) return unavailable('REFERENCE_INPUT_OUTSIDE_BUDGET');
    if (typeof this.app.assistantModel?.generate !== 'function') return unavailable('CONTROL_MODEL_UNAVAILABLE');
    const key = createHash('sha256').update(JSON.stringify([conversationId, turnId])).digest('hex'), experimentId = 'experiment-' + randomUUID();
    if (this.db.prepare('SELECT 1 FROM assistant_model_experiments WHERE id=?').get(key)) throw fail('每轮总控最多发起一次模型实验；已有尝试不能重放。', 'MODEL_EXPERIMENT_QUOTA', 409);
    const started = Date.now(), modelRoute = Object.freeze({ provider: reference.provider, model: reference.model });
    const controller = new AbortController(), stop = () => controller.abort(), activeSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let done = false, abort, sessionId = null, firstOutputMs = null;
    const result = (status, extra = {}) => ({ ...common, experimentId, status, success: status === 'complete', modelCalls: 1,
      modelRoute, reasoningEffort: reference.reasoningEffort, reasoningEffortWire: reference.reasoningEffortWire,
      promptCharacters: reference.promptCharacters, durationMs: Math.max(0, Date.now() - started), firstOutputMs, ...(sessionId ? { sessionId } : {}), ...extra });
    this.db.prepare('INSERT INTO assistant_model_experiments VALUES(?,?,?,?,?,?)').run(key, conversationId, turnId, reference.sessionId, 'admitted', JSON.stringify(result('admitted')));
    const log = (event, value) => { try { this.app.logger?.write(value.success ? 'info' : 'warn', event, { component: 'assistant', conversationId, turnId,
      operationId: experimentId, status: value.status, modelCalls: value.modelCalls, promptCharacters: reference.promptCharacters,
      durationMs: value.durationMs, ...(value.errorCode ? { code: value.errorCode } : {}) }); } catch { /* Metadata logging cannot replay an experiment. */ } };
    const permissionChanged = event => { if (event.type === 'assistant.permissions.updated') stop(); };
    this.app.on?.('event', permissionChanged);
    try {
      if (activeSignal.aborted) throw fail('模型实验已停止。', 'MODEL_EXPERIMENT_CANCELLED', 409);
      log('assistant.experiment.started', result('admitted'));
      notify(onProgress, { stage: 'model-experiment', label: '正在进行固定规模模型实验', modelCall: true });
      const request = this.app.assistantModel.generate(syntheticExperimentPrompt(reference.promptCharacters), {
        signal: activeSignal, modelRoute, expectedReasoningEffort: reference.reasoningEffort, expectedReasoningEffortWire: reference.reasoningEffortWire,
        ...(reference.provider === 'openai-codex' && ['low', 'medium'].includes(reference.reasoningEffort) ? { reasoningEffort: reference.reasoningEffort } : {}),
        title: '应用诊断 · 合成模型实验',
        onSession: id => { if (!done && !activeSignal.aborted && validId(id)) { sessionId = id; notify(onSession, id); } },
        onProgress: value => { if (!done && !activeSignal.aborted && Object.hasOwn(STAGES, value?.stage)) {
          if (value.stage === 'model-output') firstOutputMs ??= Math.max(0, Date.now() - started);
          notify(onProgress, { stage: value.stage, label: STAGES[value.stage], elapsedMs: Math.max(0, Date.now() - started) });
        } },
      });
      const cancelled = new Promise((_, reject) => { abort = () => reject(fail('模型实验已停止。', 'MODEL_EXPERIMENT_CANCELLED', 409));
        activeSignal.addEventListener('abort', abort, { once: true }); if (activeSignal.aborted) abort(); });
      const raw = await Promise.race([request, cancelled]);
      if (activeSignal.aborted) throw fail('模型实验已停止。', 'MODEL_EXPERIMENT_CANCELLED', 409);
      await authorize();
      if (this.app.assistantPermissionSettings.get().revision !== permissionRevision) throw fail('模型实验权限已变化。', 'MODEL_EXPERIMENT_CANCELLED', 409);
      let matched = false;
      if (typeof raw === 'string' && raw.length <= 128) { try { const value = JSON.parse(raw); matched = value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && value.ok === true; } catch { /* Invalid output never crosses the metadata boundary. */ } }
      const value = result(matched ? 'complete' : 'invalid-response', { responseMatched: Boolean(matched), responseCharacters: typeof raw === 'string' ? raw.length : null });
      this.db.prepare('UPDATE assistant_model_experiments SET status=?,value=? WHERE id=?').run(value.status, JSON.stringify(value), key);
      log(value.success ? 'assistant.experiment.completed' : 'assistant.experiment.failed', value); return value;
    } catch (error) {
      const cancelled = activeSignal.aborted || error.code === 'MODEL_EXPERIMENT_CANCELLED';
      const value = result(cancelled ? 'cancelled' : 'error', { errorCode: cancelled ? 'MODEL_EXPERIMENT_CANCELLED' : TERMINAL_ERRORS.has(error.code) ? error.code : 'MODEL_EXPERIMENT_FAILED' });
      try { this.db.prepare('UPDATE assistant_model_experiments SET status=?,value=? WHERE id=?').run(value.status, JSON.stringify(value), key); } catch { /* The durable admission still prevents replay. */ }
      log('assistant.experiment.failed', value); return value;
    } finally { done = true; activeSignal.removeEventListener('abort', abort); this.app.off?.('event', permissionChanged); controller.abort(); }
  }
}
