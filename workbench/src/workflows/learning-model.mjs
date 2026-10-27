import { randomUUID } from 'node:crypto';
import { redact } from '../hermes-adapter.mjs';

const fail = message => new Error(message);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const scopeConfirmed = (policy, id) => policy?.memoryAllowed === true && policy.memoryWriteAllowed === false
  && policy.externalMemoryAllowed === false && policy.memoryMode === 'batch-snapshot' && policy.memoryScopeId === id;

// A model call is a normal authenticated Hermes session, but with no callable
// tools or memory writes. Existing builtin memory context remains readable.
// Only the controller can submit to these durable, inspectable sessions.
export class LearningModel {
  constructor(app, { timeoutMs = 180000, purpose = 'learning' } = {}) {
    if (!['learning', 'assistant'].includes(purpose)) throw fail('模型控制用途无效。');
    this.purpose = purpose;
    this.subject = purpose === 'assistant' ? '应用助手' : '学习模型';
    this.sessionTable = purpose === 'assistant' ? 'application_model_sessions' : 'learning_model_sessions';
    this.app = app; this.timeoutMs = timeoutMs; this.active = new Map(); this.pending = new Set(); this.closed = false;
    this.memoryScopes = new Set();
    this.db = app.store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${this.sessionTable} (id TEXT PRIMARY KEY)`);
    this.onEvent = event => this.handleEvent(event);
    app.on('event', this.onEvent);
  }
  ownsSession(id) { return typeof id === 'string' && !!this.db.prepare(`SELECT 1 FROM ${this.sessionTable} WHERE id=?`).get(id); }
  allowsSubmit(id, requestId) {
    const state = this.active.get(id);
    return !!state && !this.closed && !state.done && !state.terminal && state.submitting && state.requestId === requestId && !state.signal?.aborted;
  }
  async createMemoryScope({ id, signal, onSession, persist = false, modelRoute } = {}) {
    if (this.purpose !== 'learning') throw fail('应用助手不能访问学习记忆。');
    if (!UUID.test(id || '')) throw fail('无效的学习记忆范围标识。');
    if (this.closed || signal?.aborted) throw fail('学习记忆准备已停止。');
    this.memoryScopes.add(id);
    let state;
    const result = new Promise((resolve, reject) => {
      state = { id: null, scopeId: id, signal, resolve, reject, done: false, terminal: false, submitting: false };
      this.pending.add(state);
      state.abort = () => this.finish(state, fail('学习记忆准备已停止。'), true);
      signal?.addEventListener('abort', state.abort, { once: true });
      state.timer = setTimeout(() => this.finish(state, fail('学习记忆准备超时，已停止。'), true), this.timeoutMs);
      state.timer.unref?.();
    });
    result.catch(() => {});
    void (async () => { try {
      const session = await this.app.createSession({ title: '学习 · 固定记忆快照', ...(modelRoute ? { modelRoute } : {}) });
      if (this.closed) return;
      state.id = session.id;
      this.db.prepare(`INSERT OR IGNORE INTO ${this.sessionTable}(id) VALUES(?)`).run(session.id);
      if (state.done || signal?.aborted) { void this.app.interrupt(session.id).catch(() => {}); return; }
      this.active.set(session.id, state);
      onSession?.(session.id);
      if (state.done || signal?.aborted || this.closed) { state.abort(); return; }
      const prepared = await this.app.adapter.request('workbench.learning.memory.capture', {
        session_id: session.runtimeSessionId, memory_scope_id: id,
        ...(persist ? { persist: true } : {}),
      });
      if (state.done || signal?.aborted || this.closed) { void this.releaseMemoryScope(id).catch(() => {}); return; }
      if (!scopeConfirmed(prepared?.policy, id) || prepared.policy.toolsAllowed !== false || prepared.policy.skillMutationBlocked !== true) {
        throw fail('Hermes 未确认整批学习的固定记忆与只读策略。');
      }
      this.finish(state, null, false, { id, mode: 'batch-snapshot', memoryWriteAllowed: false, externalMemoryAllowed: false,
        ...(prepared.snapshot ? { snapshot: prepared.snapshot } : {}) });
    } catch (error) {
      if (state.done) void this.releaseMemoryScope(id).catch(() => {});
      else this.finish(state, error, true);
    } })();
    return result;
  }
  async releaseMemoryScope(id) {
    if (!UUID.test(id || '')) throw fail('无效的学习记忆范围标识。');
    this.memoryScopes.delete(id);
    // Release is idempotent and also tombstones an admission whose ACK is late.
    return this.app.adapter.request('workbench.learning.memory.release', { memory_scope_id: id }, 5000);
  }
  suspendMemoryScope(id) { this.memoryScopes.delete(id); }
  async restoreMemoryScope({ id, snapshot, signal } = {}) {
    if (!UUID.test(id || '') || snapshot?.scopeId !== id || snapshot?.version !== 1 || !/^sha256:[a-f0-9]{64}$/.test(snapshot?.digest || '')) throw fail('原学习记忆快照凭据无效，不能恢复。');
    if (this.closed || signal?.aborted) throw fail('学习恢复已停止。');
    const prepared = await this.app.adapter.request('workbench.learning.memory.restore', { snapshot });
    if (this.closed || signal?.aborted) throw fail('学习恢复已停止。');
    if (!scopeConfirmed(prepared?.policy, id) || prepared.policy.toolsAllowed !== false || prepared.policy.skillMutationBlocked !== true
      || prepared.snapshot?.scopeId !== id || prepared.snapshot?.digest !== snapshot.digest || prepared.snapshot?.version !== 1) throw fail('Hermes 未确认恢复原批次记忆，未继续执行。');
    this.memoryScopes.add(id);
    return { id, mode: 'batch-snapshot', memoryWriteAllowed: false, externalMemoryAllowed: false, snapshot: { ...snapshot } };
  }
  async generate(prompt, { signal, onSession, onProgress, memoryScopeId, modelRoute, images = [], title = '学习 · 评价 / 调整 Skill' } = {}) {
    if (this.purpose === 'assistant' && memoryScopeId !== undefined) throw fail('应用助手不能访问学习记忆。');
    if (!Array.isArray(images) || images.length > 4 || images.some(path => typeof path !== 'string') || images.length && this.purpose !== 'assistant') throw fail('模型图像输入无效。');
    if (this.closed || signal?.aborted) throw fail(`${this.subject}调用已停止。`);
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 200000) throw fail(`${this.subject}指令超过长度限制。`);
    if (typeof title !== 'string' || !title.trim() || title.length > 120) throw fail('模型会话名称无效。');
    if (memoryScopeId !== undefined && !UUID.test(memoryScopeId || '')) throw fail('无效的学习记忆范围标识。');
    let state;
    const result = new Promise((resolve, reject) => {
      state = { id: null, requestId: randomUUID(), signal, resolve, reject, done: false, terminal: false, submitting: false,
        onProgress, startedAtMs: Date.now() };
      this.pending.add(state);
      state.abort = () => this.finish(state, fail(`${this.subject}调用已停止。`), true);
      signal?.addEventListener('abort', state.abort, { once: true });
      state.timer = setTimeout(() => {
        const elapsedMs = Math.max(0, Date.now() - state.startedAtMs);
        const message = this.purpose === 'assistant'
          ? `应用助手调用累计等待 ${Math.ceil(elapsedMs / 1000)} 秒超时，停止在「${state.phaseLabel}」阶段。`
          : '学习模型调用超时，已停止。';
        this.finish(state, Object.assign(fail(message), { code: 'MODEL_TIMEOUT', phase: state.phase, phaseLabel: state.phaseLabel, elapsedMs }), true);
      }, this.timeoutMs);
      state.timer.unref?.();
      this.progress(state, 'create-session', '创建模型会话');
    });
    // Attach the rejection handler before awaiting preparation or the submit ACK.
    result.catch(() => {});
    void (async () => { try {
      const session = await this.app.createSession({ title, ...(this.purpose === 'assistant' ? { managedPurpose: 'assistant' } : {}), ...(modelRoute ? { modelRoute } : {}) });
      // Creation can outlive abort or close. Never touch a closed database; while
      // still open, retain ownership of even an unused late session.
      if (this.closed) return;
      state.id = session.id;
      this.db.prepare(`INSERT OR IGNORE INTO ${this.sessionTable}(id) VALUES(?)`).run(session.id);
      if (state.done || signal?.aborted) { void this.app.interrupt(session.id).catch(() => {}); return; }
      this.active.set(session.id, state);
      onSession?.(session.id);
      if (signal?.aborted || this.closed || state.done) { state.abort(); return; }
      this.progress(state, 'prepare-model', '确认模型权限与配置');
      const prepared = await this.app.adapter.request(this.purpose === 'assistant' ? 'workbench.assistant.prepare' : 'workbench.learning.prepare', { session_id: session.runtimeSessionId,
        ...(memoryScopeId ? { memory_scope_id: memoryScopeId } : {}) });
      if (state.done || signal?.aborted || this.closed) { state.abort(); return; }
      if (this.purpose === 'assistant' ? prepared?.policy?.toolsAllowed !== false || prepared.policy.applicationTools !== 'broker-only'
        || prepared.policy.sourceMutationBlocked !== true || prepared.policy.skillMutationBlocked !== true
        || prepared.policy.memoryAllowed !== false || prepared.policy.memoryWriteAllowed !== false
        : prepared?.policy?.toolsAllowed !== false || prepared.policy.skillMutationBlocked !== true
        || prepared.policy.memoryAllowed !== true || prepared.policy.memoryWriteAllowed !== false) {
        if (this.purpose === 'assistant') throw fail('Hermes 未确认应用助手的受限工具与源码保护策略。');
        throw fail('Hermes 未确认学习评价会话的无工具策略与记忆只读策略。');
      }
      if (memoryScopeId && !scopeConfirmed(prepared.policy, memoryScopeId)) throw fail('Hermes 未确认本次调用使用同批次固定记忆。');
      if (this.purpose === 'assistant' && images.length) {
        this.progress(state, 'prepare-images', '提交诊断图像');
        const attached = await this.app.adapter.request('workbench.assistant.images', { session_id: session.runtimeSessionId, images });
        if (attached?.attached !== images.length || attached.mode !== 'native-content') throw fail('Hermes 未确认接收诊断关键帧，未提交分析。');
        if (state.done || signal?.aborted || this.closed) { state.abort(); return; }
      }
      state.submitting = true;
      this.progress(state, 'submit-model', '提交模型请求');
      await this.app.submit(session.id, prompt, { [this.purpose === 'assistant' ? 'assistantRequestId' : 'learningRequestId']: state.requestId });
      // A stream or terminal event may precede the submit ACK. Never replace a
      // confirmed output/readback phase with an earlier waiting phase.
      if (!state.terminal && state.phase === 'submit-model') this.progress(state, 'model-response', '等待模型响应');
    } catch (error) {
      // A confirmed terminal frame can arrive before a lost submit ACK.
      if (!state.terminal) this.finish(state, error, true);
    } })();
    return result;
  }
  progress(state, stage, label) {
    if (state.done || state.phase === stage) return;
    state.phase = stage; state.phaseLabel = label;
    const value = { stage, label, startedAt: new Date(state.startedAtMs).toISOString(), elapsedMs: Math.max(0, Date.now() - state.startedAtMs) };
    // Observers are telemetry, never part of admission or completion. Neither a
    // throwing callback nor its rejected promise can change the model result.
    try { Promise.resolve(state.onProgress?.(value)).catch(() => {}); } catch { /* Keep the controller authoritative. */ }
  }
  handleEvent(event) {
    if (this.closed) return;
    if (event.type === 'backend.status' && ['error', 'stopped', 'disconnected'].includes(event.payload?.state)) {
      for (const state of this.pending) this.finish(state, fail(`Hermes 连接中断；未重放${this.subject}调用。`));
      return;
    }
    const state = this.active.get(event.sessionId);
    if (!state || state.done || state.terminal || !state.submitting) return;
    if (event.type === 'message.delta') this.progress(state, 'model-output', '接收模型输出');
    if (event.type === 'request.open') this.finish(state, fail(`${this.purpose === 'assistant' ? '应用助手' : '学习评价'}会话意外请求了工具或交互，已停止。`), true);
    if (event.type === 'error') this.finish(state, fail(redact(event.payload?.message || `${this.subject}调用失败。`)), true);
    if (event.type !== 'message.complete') return;
    state.terminal = true;
    const payload = event.payload || {};
    if (payload.status !== 'complete' || payload.partial || payload.error) {
      this.finish(state, fail(redact(payload.error || `${this.subject}未确认成功。`))); return;
    }
    this.progress(state, 'read-result', '确认模型完整结果');
    void (async () => {
      try {
        const history = await this.app.history(state.id);
        if (state.done || state.signal?.aborted || this.closed) return;
        const final = history.messages?.filter(message => message.role === 'assistant').at(-1);
        if (!final || typeof final.text !== 'string' || final.partial || final.tool_calls?.length || final.toolCalls?.length) throw fail(`${this.subject}历史中缺少完整结果。`);
        if (Buffer.byteLength(final.text, 'utf8') > 100000) throw fail(`${this.subject}返回内容超过限制。`);
        this.finish(state, null, false, final.text);
      } catch (error) { this.finish(state, error); }
    })();
  }
  finish(state, error, interrupt = false, value) {
    if (state.done) return;
    if (error && state.startedAtMs !== undefined) {
      error.phase ??= state.phase; error.phaseLabel ??= state.phaseLabel;
      error.elapsedMs ??= Math.max(0, Date.now() - state.startedAtMs);
    }
    state.done = true; clearTimeout(state.timer); state.signal?.removeEventListener('abort', state.abort);
    this.active.delete(state.id); this.pending.delete(state);
    if (interrupt && state.id) void this.app.interrupt(state.id).catch(() => {});
    if (error && state.scopeId) void this.releaseMemoryScope(state.scopeId).catch(() => {});
    if (error) state.reject(error); else state.resolve(value);
  }
  async close() {
    this.closed = true;
    this.app.off('event', this.onEvent);
    for (const state of this.pending) this.finish(state, fail(`工作台已关闭；${this.subject}调用已停止。`), true);
    for (const id of [...this.memoryScopes]) void this.releaseMemoryScope(id).catch(() => {});
  }
}
