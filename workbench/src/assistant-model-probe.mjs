export const ASSISTANT_MODEL_PROBE_LIMITS = Object.freeze({ durationMs: 30000, firstResponseMs: 30000, outputIdleMs: 10000 });
const PROMPT = '这是工作台固定的模型连接探测。只需确认你可以正常返回结构化响应。只返回一个 JSON 对象 {"ok":true}，不要附加解释，不调用任何工具。';
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const OPTIONS = ['signal', 'deadlineAt', 'modelRoute', 'onSession', 'onProgress', 'trace'];
const TRACE = ['workflowId', 'conversationId', 'turnId'];
const STAGES = Object.freeze({ 'create-session': '创建探测会话', 'prepare-model': '确认探测权限', 'submit-model': '提交固定模型探测',
  'model-response': '等待探测模型响应', 'model-output': '接收探测模型输出', 'read-result': '确认探测完整结果' });
const own = (value, key) => value && Object.getOwnPropertyDescriptor(value, key)?.value;
const invalid = () => { throw Object.assign(new Error('模型探测仅接受固定诊断参数。'), { httpStatus: 400 }); };
const plain = (value, names) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !names.includes(key)
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) invalid();
};
const notify = (callback, value) => {
  try { Promise.resolve(callback?.(value)).catch(() => {}); } catch { /* An observer cannot change the probe outcome. */ }
};
function argumentsView(input) {
  plain(input, OPTIONS);
  const signal = own(input, 'signal'), deadlineAt = own(input, 'deadlineAt');
  if (signal !== undefined && !(signal instanceof AbortSignal)) invalid();
  if (deadlineAt !== undefined && (!Number.isSafeInteger(deadlineAt) || deadlineAt < 0)) invalid();
  if (own(input, 'modelRoute') !== undefined) {
    const route = own(input, 'modelRoute'); plain(route, ['provider', 'model']);
    if (['provider', 'model'].some(key => typeof own(route, key) !== 'string' || !own(route, key).trim() || own(route, key).length > 180)) invalid();
  }
  for (const name of ['onSession', 'onProgress']) if (own(input, name) !== undefined && typeof own(input, name) !== 'function') invalid();
  const trace = own(input, 'trace') === undefined ? {} : own(input, 'trace');
  plain(trace, TRACE);
  if (Object.values(trace).some(value => typeof value !== 'string' || !ID.test(value)
    || ['__proto__', 'constructor', 'prototype'].includes(value))) invalid();
  return { ...input, trace: { ...trace } };
}
const timeout = () => Object.assign(new Error('固定模型探测达到等待上限。'), { code: 'MODEL_PROBE_TIMEOUT' });
const cancelled = () => Object.assign(new Error('固定模型探测已停止。'), { code: 'MODEL_PROBE_CANCELLED' });
const timeoutError = error => ['MODEL_PROBE_TIMEOUT', 'MODEL_TIMEOUT', 'ASSISTANT_TURN_TIMEOUT',
  'MODEL_FIRST_RESPONSE_TIMEOUT', 'MODEL_OUTPUT_IDLE_TIMEOUT', 'MODEL_TOTAL_TIMEOUT'].includes(own(error, 'code'));

// A single fixed request through the existing protected assistant controller.
// This does not run business tools, resume a failed turn or choose another model.
export class AssistantModelProbe {
  constructor(app) { this.app = app; }
  async run(input = {}) {
    const { signal, deadlineAt: parentDeadline, modelRoute: pinnedRoute, onSession, onProgress, trace } = argumentsView(input);
    const start = Date.now(), deadlineAt = Math.min(start + ASSISTANT_MODEL_PROBE_LIMITS.durationMs, parentDeadline ?? Infinity);
    const controller = new AbortController(), activeSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let done = false, timedOut = false, timer, abort, sessionId = null, firstOutputMs = null, modelCalls = 0;
    const elapsed = () => Math.max(0, Date.now() - start);
    const log = (level, event, status, code) => {
      try { Promise.resolve(this.app.logger?.write(level, event, { component: 'assistant', ...trace, ...(sessionId ? { sessionId } : {}),
        status, durationMs: elapsed(), modelCalls, readOnly: true, ...(code ? { code } : {}) })).catch(() => {}); }
      catch { /* Logging is independent of probe execution. */ }
    };
    const result = (status, fields = {}) => ({ available: true, source: 'fixed-model-probe', status, success: status === 'complete',
      responseMatched: false, modelCalls, sessionId, firstOutputMs, durationMs: elapsed(),
      workflowExecuted: false, workflowModified: false, retryPerformed: false,
      limitations: ['仅验证当前固定短请求；不能证明原复杂请求已恢复。'], ...fields });
    log('info', 'assistant.probe.started', 'started');
    try {
      if (signal?.aborted) throw cancelled();
      if (deadlineAt <= Date.now()) throw timeout();
      if (typeof this.app.assistantModel?.generate !== 'function' || typeof this.app.captureModelRoute !== 'function') {
        const value = result('unavailable', { available: false, errorCode: 'MODEL_PROBE_UNAVAILABLE' });
        log('warn', 'assistant.probe.failed', value.status, value.errorCode); return value;
      }
      const request = async () => {
        const modelRoute = pinnedRoute || await this.app.captureModelRoute();
        if (activeSignal.aborted) throw signal?.aborted ? cancelled() : timeout();
        if (deadlineAt <= Date.now()) throw timeout();
        modelCalls = 1;
        notify(onProgress, { stage: 'model-probe', label: '检查模型响应（固定短请求）', modelCall: true });
        const raw = await this.app.assistantModel.generate(PROMPT, { signal: activeSignal, deadlineAt, modelRoute,
          firstResponseTimeoutMs: ASSISTANT_MODEL_PROBE_LIMITS.firstResponseMs,
          outputIdleTimeoutMs: ASSISTANT_MODEL_PROBE_LIMITS.outputIdleMs,
          title: '应用对话 · 固定模型探测',
          onSession: value => {
            if (done || activeSignal.aborted || typeof value !== 'string' || !ID.test(value)) return;
            sessionId = value; notify(onSession, value);
          },
          onProgress: value => {
            if (done || activeSignal.aborted) return;
            const stage = own(value, 'stage');
            if (!Object.hasOwn(STAGES, stage)) return;
            if (stage === 'model-output' && firstOutputMs === null) firstOutputMs = elapsed();
            notify(onProgress, { stage, label: STAGES[stage], elapsedMs: elapsed() });
          },
        });
        if (activeSignal.aborted) throw signal?.aborted ? cancelled() : timeout();
        if (deadlineAt <= Date.now()) throw timeout();
        let matched = false;
        if (typeof raw === 'string' && raw.length <= 256) {
          try { const value = JSON.parse(raw); matched = !!value && !Array.isArray(value) && typeof value === 'object'
            && Object.keys(value).length === 1 && value.ok === true; } catch { /* Invalid output is classified, never returned. */ }
        }
        return result(matched ? 'complete' : 'invalid-response', { responseMatched: matched,
          responseCharacters: typeof raw === 'string' ? raw.length : null });
      };
      const stopped = new Promise((_, reject) => {
        timer = setTimeout(() => { timedOut = true; controller.abort(); reject(timeout()); }, Math.max(0, deadlineAt - Date.now()));
        abort = () => reject(cancelled());
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
      const value = await Promise.race([request(), stopped]);
      log(value.success ? 'info' : 'warn', value.success ? 'assistant.probe.completed' : 'assistant.probe.failed', value.status,
        value.success ? undefined : 'MODEL_PROBE_INVALID_RESPONSE');
      return value;
    } catch (error) {
      const status = signal?.aborted || own(error, 'code') === 'MODEL_PROBE_CANCELLED' ? 'cancelled' : timedOut || timeoutError(error) ? 'timeout' : 'error';
      const errorCode = status === 'cancelled' ? 'MODEL_PROBE_CANCELLED' : status === 'timeout' ? 'MODEL_PROBE_TIMEOUT' : 'MODEL_PROBE_FAILED';
      log(status === 'error' ? 'error' : 'warn', 'assistant.probe.failed', status, errorCode);
      return result(status, { errorCode });
    } finally {
      done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort();
    }
  }
}
