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
  constructor(app, { timeoutMs = 180000 } = {}) {
    this.app = app; this.timeoutMs = timeoutMs; this.active = new Map(); this.pending = new Set(); this.closed = false;
    this.memoryScopes = new Set();
    this.db = app.store.db;
    this.db.exec('CREATE TABLE IF NOT EXISTS learning_model_sessions (id TEXT PRIMARY KEY)');
    this.onEvent = event => this.handleEvent(event);
    app.on('event', this.onEvent);
  }
  ownsSession(id) { return typeof id === 'string' && !!this.db.prepare('SELECT 1 FROM learning_model_sessions WHERE id=?').get(id); }
  allowsSubmit(id, requestId) {
    const state = this.active.get(id);
    return !!state && !this.closed && !state.done && !state.terminal && state.submitting && state.requestId === requestId && !state.signal?.aborted;
  }
  async createMemoryScope({ id, signal, onSession, persist = false, modelRoute } = {}) {
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
      this.db.prepare('INSERT INTO learning_model_sessions(id) VALUES(?)').run(session.id);
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
  async generate(prompt, { signal, onSession, memoryScopeId, modelRoute, title = '学习 · 评价 / 调整 Skill' } = {}) {
    if (this.closed || signal?.aborted) throw fail('学习模型调用已停止。');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 200000) throw fail('学习模型指令超过长度限制。');
    if (typeof title !== 'string' || !title.trim() || title.length > 120) throw fail('模型会话名称无效。');
    if (memoryScopeId !== undefined && !UUID.test(memoryScopeId || '')) throw fail('无效的学习记忆范围标识。');
    let state;
    const result = new Promise((resolve, reject) => {
      state = { id: null, requestId: randomUUID(), signal, resolve, reject, done: false, terminal: false, submitting: false };
      this.pending.add(state);
      state.abort = () => this.finish(state, fail('学习模型调用已停止。'), true);
      signal?.addEventListener('abort', state.abort, { once: true });
      state.timer = setTimeout(() => this.finish(state, fail('学习模型调用超时，已停止。'), true), this.timeoutMs);
      state.timer.unref?.();
    });
    // Attach the rejection handler before awaiting preparation or the submit ACK.
    result.catch(() => {});
    void (async () => { try {
      const session = await this.app.createSession({ title, ...(modelRoute ? { modelRoute } : {}) });
      // Creation can outlive abort or close. Never touch a closed database; while
      // still open, retain ownership of even an unused late session.
      if (this.closed) return;
      state.id = session.id;
      this.db.prepare('INSERT INTO learning_model_sessions(id) VALUES(?)').run(session.id);
      if (state.done || signal?.aborted) { void this.app.interrupt(session.id).catch(() => {}); return; }
      this.active.set(session.id, state);
      onSession?.(session.id);
      if (signal?.aborted || this.closed || state.done) { state.abort(); return; }
      const prepared = await this.app.adapter.request('workbench.learning.prepare', { session_id: session.runtimeSessionId,
        ...(memoryScopeId ? { memory_scope_id: memoryScopeId } : {}) });
      if (state.done || signal?.aborted || this.closed) { state.abort(); return; }
      if (prepared?.policy?.toolsAllowed !== false || prepared.policy.skillMutationBlocked !== true
        || prepared.policy.memoryAllowed !== true || prepared.policy.memoryWriteAllowed !== false) {
        throw fail('Hermes 未确认学习评价会话的无工具策略与记忆只读策略。');
      }
      if (memoryScopeId && !scopeConfirmed(prepared.policy, memoryScopeId)) throw fail('Hermes 未确认本次调用使用同批次固定记忆。');
      state.submitting = true;
      await this.app.submit(session.id, prompt, { learningRequestId: state.requestId });
    } catch (error) {
      // A confirmed terminal frame can arrive before a lost submit ACK.
      if (!state.terminal) this.finish(state, error, true);
    } })();
    return result;
  }
  handleEvent(event) {
    if (this.closed) return;
    if (event.type === 'backend.status' && ['error', 'stopped', 'disconnected'].includes(event.payload?.state)) {
      for (const state of this.pending) this.finish(state, fail('Hermes 连接中断；未重放学习模型调用。'));
      return;
    }
    const state = this.active.get(event.sessionId);
    if (!state || state.done || state.terminal || !state.submitting) return;
    if (event.type === 'request.open') this.finish(state, fail('学习评价会话意外请求了工具或交互，已停止。'), true);
    if (event.type === 'error') this.finish(state, fail(redact(event.payload?.message || '学习模型调用失败。')), true);
    if (event.type !== 'message.complete') return;
    state.terminal = true;
    const payload = event.payload || {};
    if (payload.status !== 'complete' || payload.partial || payload.error) {
      this.finish(state, fail(redact(payload.error || '学习模型未确认成功。'))); return;
    }
    void (async () => {
      try {
        const history = await this.app.history(state.id);
        if (state.done || state.signal?.aborted || this.closed) return;
        const final = history.messages?.filter(message => message.role === 'assistant').at(-1);
        if (!final || typeof final.text !== 'string' || final.partial || final.tool_calls?.length || final.toolCalls?.length) throw fail('学习模型历史中缺少完整结果。');
        if (Buffer.byteLength(final.text, 'utf8') > 100000) throw fail('学习模型返回内容超过限制。');
        this.finish(state, null, false, final.text);
      } catch (error) { this.finish(state, error); }
    })();
  }
  finish(state, error, interrupt = false, value) {
    if (state.done) return;
    state.done = true; clearTimeout(state.timer); state.signal?.removeEventListener('abort', state.abort);
    this.active.delete(state.id); this.pending.delete(state);
    if (interrupt && state.id) void this.app.interrupt(state.id).catch(() => {});
    if (error && state.scopeId) void this.releaseMemoryScope(state.scopeId).catch(() => {});
    if (error) state.reject(error); else state.resolve(value);
  }
  async close() {
    this.closed = true;
    this.app.off('event', this.onEvent);
    for (const state of this.pending) this.finish(state, fail('工作台已关闭；学习模型调用已停止。'), true);
    for (const id of [...this.memoryScopes]) void this.releaseMemoryScope(id).catch(() => {});
  }
}
