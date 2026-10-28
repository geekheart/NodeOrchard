import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { redact } from '../hermes-adapter.mjs';

const fail = message => new Error(message);
// null is an intentional unlimited wait, not zero or an absent measurement.
// An explicitly bounded controller may still narrow its own requests.
const modelWaitLimit = (configured, requested) => requested == null ? configured
  : configured === null ? requested : Math.min(configured, requested);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const reasoningMetadata = (session, key) => {
  const value = session && Object.getOwnPropertyDescriptor(session, key)?.value;
  return REASONING_EFFORTS.has(value) ? value : null;
};
const scopeConfirmed = (policy, id) => policy?.memoryAllowed === true && policy.memoryWriteAllowed === false
  && policy.externalMemoryAllowed === false && policy.memoryMode === 'batch-snapshot' && policy.memoryScopeId === id;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024, MAX_IMAGE_TOTAL_BYTES = 16 * 1024 * 1024;
const inside = (root, target) => { const path = relative(root, target); return path && path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path); };

// The native bridge keeps its fixed diagnostic root. User materials cross that
// gate only as a bounded, ephemeral copy from the caller's bound workflow root.
async function stageUserImages(app, paths, root) {
  let temporary;
  try {
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw fail('附件工作流目录无效。');
    const canonicalRoot = await realpath(root), workspace = await realpath(app.config.workspaceRoot);
    if (canonicalRoot !== join(workspace, 'workflows', basename(root))) throw fail('附件工作流目录不能通过链接访问其他位置。');
    const admitted = []; let total = 0;
    for (const source of paths) {
      const target = resolve(source);
      if (!inside(root, target)) throw fail('附件图片不属于当前工作流目录。');
      let part = root;
      for (const name of relative(root, target).split(sep)) {
        part = join(part, name);
        if ((await lstat(part)).isSymbolicLink()) throw fail('附件图片不能通过链接读取。');
      }
      if (!inside(canonicalRoot, await realpath(target))) throw fail('附件图片越过当前工作流目录。');
      const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size > MAX_IMAGE_BYTES) throw fail('附件图片必须是最多 8 MiB 的普通文件。');
        const buffer = Buffer.alloc(before.size + 1); let length = 0;
        while (length < buffer.length) {
          const result = await handle.read(buffer, length, buffer.length - length, null);
          if (!result.bytesRead) break; length += result.bytesRead;
        }
        const after = await handle.stat();
        if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
          || !inside(canonicalRoot, await realpath(target))) throw fail('附件图片在读取期间发生变化，请重新上传。');
        const data = buffer.subarray(0, length);
        const format = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'png'
          : data.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ? 'jpg'
            : data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP' ? 'webp'
              : ['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString()) ? 'gif' : null;
        if (!format) throw fail('附件图片仅支持 PNG、JPEG、WebP 或 GIF；其他文件请通过资料读取工具查看。');
        total += length; if (total > MAX_IMAGE_TOTAL_BYTES) throw fail('附件图片合计不能超过 16 MiB。');
        admitted.push({ data, format });
      } finally { await handle.close(); }
    }
    const diagnosticRoot = join(app.config.dataDir, 'diagnostics'); await mkdir(diagnosticRoot, { recursive: true });
    temporary = await mkdtemp(join(diagnosticRoot, 'assistant-materials-'));
    const images = [];
    for (const [index, image] of admitted.entries()) {
      const path = join(temporary, index + '.' + image.format); await writeFile(path, image.data, { flag: 'wx', mode: 0o600 }); images.push(path);
    }
    return { images, cleanup: () => rm(temporary, { recursive: true, force: true }) };
  } catch (error) {
    if (temporary) await rm(temporary, { recursive: true, force: true });
    throw fail(error.code ? '附件图片不存在、不可访问或已发生变化。' : error.message);
  }
}

// A model call is a normal authenticated Hermes session, but with no callable
// tools or memory writes. Existing builtin memory context remains readable.
// Only the controller can submit to these durable, inspectable sessions.
export class LearningModel {
  constructor(app, { timeoutMs = null, purpose = 'learning', outputIdleTimeoutMs = timeoutMs === null ? null : Math.min(timeoutMs, 60000),
    maxDurationMs = timeoutMs === null ? null : purpose === 'assistant' ? Math.min(timeoutMs * 2, 360000) : timeoutMs } = {}) {
    if (!['learning', 'assistant'].includes(purpose)) throw fail('模型控制用途无效。');
    if ([timeoutMs, outputIdleTimeoutMs, maxDurationMs].some(value => value !== null && (!Number.isSafeInteger(value) || value < 1 || value > 2147483647))) throw fail('模型等待时限无效。');
    this.purpose = purpose;
    this.subject = purpose === 'assistant' ? '应用助手' : '学习模型';
    this.sessionTable = purpose === 'assistant' ? 'application_model_sessions' : 'learning_model_sessions';
    this.app = app; this.timeoutMs = timeoutMs; this.outputIdleTimeoutMs = outputIdleTimeoutMs;
    this.maxDurationMs = purpose === 'assistant' ? maxDurationMs : timeoutMs;
    this.active = new Map(); this.pending = new Set(); this.closed = false;
    this.memoryScopes = new Set();
    this.db = app.store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${this.sessionTable} (id TEXT PRIMARY KEY)`);
    if (this.purpose === 'assistant') this.db.exec('CREATE TABLE IF NOT EXISTS application_model_calls (session_id TEXT PRIMARY KEY, value TEXT NOT NULL)');
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
      if (this.timeoutMs !== null) {
        state.timer = setTimeout(() => this.finish(state, fail('学习记忆准备超时，已停止。'), true), this.timeoutMs);
        state.timer.unref?.();
      }
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
  async generate(prompt, { signal, onSession, onProgress, memoryScopeId, modelRoute, deadlineAt, firstResponseTimeoutMs,
    outputIdleTimeoutMs, reasoningEffort, images = [], userImages = [], attachmentRoot, title = '学习 · 评价 / 调整 Skill' } = {}) {
    if (this.purpose === 'assistant' && memoryScopeId !== undefined) throw fail('应用助手不能访问学习记忆。');
    if (reasoningEffort !== undefined && (this.purpose !== 'assistant' || !['low', 'medium'].includes(reasoningEffort))) throw fail('仅应用助手控制调用可指定 low 或 medium 推理强度。');
    if (![images, userImages].every(Array.isArray) || images.length + userImages.length > 4
      || images.some(path => typeof path !== 'string') || userImages.some(path => typeof path !== 'string' || !isAbsolute(path) || path.includes('\0'))
      || (images.length || userImages.length || attachmentRoot !== undefined) && this.purpose !== 'assistant') throw fail('模型图像输入无效。');
    images = [...images]; userImages = [...userImages];
    if (userImages.length) {
      if (typeof attachmentRoot !== 'string' || !isAbsolute(attachmentRoot) || attachmentRoot.includes('\0')
        || typeof this.app.config?.dataDir !== 'string' || typeof this.app.config?.workspaceRoot !== 'string' || typeof this.app.workflowFolders?.directory !== 'function'
        || resolve(attachmentRoot) !== resolve(this.app.workflowFolders.directory(basename(resolve(attachmentRoot))))) throw fail('附件图片需要绑定当前工作流目录。');
      attachmentRoot = resolve(attachmentRoot);
    }
    if (this.closed || signal?.aborted) throw fail(`${this.subject}调用已停止。`);
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 200000) throw fail(`${this.subject}指令超过长度限制。`);
    if (typeof title !== 'string' || !title.trim() || title.length > 120) throw fail('模型会话名称无效。');
    if (deadlineAt !== undefined && deadlineAt !== null && (!Number.isSafeInteger(deadlineAt) || deadlineAt < 1 || deadlineAt > 8640000000000000)) throw fail('模型调用截止时间无效。');
    if ([firstResponseTimeoutMs, outputIdleTimeoutMs].some(value => value !== undefined && value !== null && (!Number.isSafeInteger(value) || value < 1 || value > 2147483647))) throw fail('模型等待时限无效。');
    if (memoryScopeId !== undefined && !UUID.test(memoryScopeId || '')) throw fail('无效的学习记忆范围标识。');
    let state;
    const result = new Promise((resolve, reject) => {
      state = { id: null, requestId: randomUUID(), signal, resolve, reject, done: false, terminal: false, submitting: false,
        onProgress, startedAtMs: Date.now(), promptCharacters: prompt.length, outputCharacters: 0,
        firstResponseTimeoutMs: modelWaitLimit(this.timeoutMs, firstResponseTimeoutMs),
        outputIdleTimeoutMs: modelWaitLimit(this.outputIdleTimeoutMs, outputIdleTimeoutMs) };
      state.deadlineAtMs = Math.min(this.maxDurationMs === null ? Infinity : state.startedAtMs + this.maxDurationMs, deadlineAt ?? Infinity);
      this.pending.add(state);
      state.abort = () => this.finish(state, Object.assign(fail(`${this.subject}调用已停止。`), { code: 'MODEL_ABORTED' }), true);
      signal?.addEventListener('abort', state.abort, { once: true });
      this.progress(state, 'create-session', '创建模型会话');
      this.scheduleTimeout(state);
    });
    // Attach the rejection handler before awaiting preparation or the submit ACK.
    result.catch(() => {});
    if (state.done) return result;
    void (async () => { try {
      const session = await this.app.createSession({ title, ...(this.purpose === 'assistant' ? { managedPurpose: 'assistant' } : {}),
        ...(reasoningEffort !== undefined ? { assistantReasoningEffort: reasoningEffort } : {}), ...(modelRoute ? { modelRoute } : {}) });
      // Creation can outlive abort or close. Never touch a closed database; while
      // still open, retain ownership of even an unused late session.
      if (this.closed) return;
      state.id = session.id;
      if (this.purpose === 'assistant') {
        state.requestedReasoningEffort = reasoningMetadata(session, 'requestedReasoningEffort');
        state.reasoningEffort = reasoningMetadata(session, 'reasoningEffort');
        state.reasoningEffortWire = reasoningMetadata(session, 'reasoningEffortWire');
      }
      this.db.prepare(`INSERT OR IGNORE INTO ${this.sessionTable}(id) VALUES(?)`).run(session.id);
      if (state.done || signal?.aborted) { void this.app.interrupt(session.id).catch(() => {}); return; }
      this.persistMetrics(state);
      this.active.set(session.id, state);
      onSession?.(session.id);
      if (signal?.aborted || this.closed || state.done) { state.abort(); return; }
      this.progress(state, 'prepare-model', '确认模型权限与配置');
      const prepared = await this.app.adapter.request(this.purpose === 'assistant' ? 'workbench.assistant.prepare' : 'workbench.learning.prepare', { session_id: session.runtimeSessionId,
        ...(memoryScopeId ? { memory_scope_id: memoryScopeId } : {}) });
      if (state.done || signal?.aborted || this.closed) { state.abort(); return; }
      if (this.purpose === 'assistant') {
        // Lazy native sessions may publish their actual configuration only when
        // preparation builds the agent. This is observation, never an override.
        const info = this.app.sessionInfo?.get(session.runtimeSessionId);
        state.reasoningEffort = reasoningMetadata(info, 'reasoning_effort') ?? state.reasoningEffort;
        state.reasoningEffortWire = reasoningMetadata(info, 'reasoning_effort_wire') ?? state.reasoningEffortWire;
      }
      if (this.purpose === 'assistant' ? prepared?.policy?.toolsAllowed !== false || prepared.policy.applicationTools !== 'broker-only'
        || prepared.policy.sourceMutationBlocked !== true || prepared.policy.skillMutationBlocked !== true
        || prepared.policy.memoryAllowed !== false || prepared.policy.memoryWriteAllowed !== false
        : prepared?.policy?.toolsAllowed !== false || prepared.policy.skillMutationBlocked !== true
        || prepared.policy.memoryAllowed !== true || prepared.policy.memoryWriteAllowed !== false) {
        if (this.purpose === 'assistant') throw fail('Hermes 未确认应用助手的受限工具与源码保护策略。');
        throw fail('Hermes 未确认学习评价会话的无工具策略与记忆只读策略。');
      }
      if (memoryScopeId && !scopeConfirmed(prepared.policy, memoryScopeId)) throw fail('Hermes 未确认本次调用使用同批次固定记忆。');
      if (this.purpose === 'assistant' && (images.length || userImages.length)) {
        this.progress(state, 'prepare-images', userImages.length ? '提交附件与参考图像' : '提交诊断图像');
        let staged;
        try {
          staged = userImages.length ? await stageUserImages(this.app, userImages, attachmentRoot) : null;
          if (state.done || signal?.aborted || this.closed) { state.abort(); return; }
          const batch = [...(staged?.images || []), ...images];
          const attached = await this.app.adapter.request('workbench.assistant.images', { session_id: session.runtimeSessionId, images: batch });
          if (attached?.attached !== batch.length || attached.mode !== 'native-content') throw fail(userImages.length
            ? 'Hermes 未确认接收附件图像，未提交分析。' : 'Hermes 未确认接收诊断关键帧，未提交分析。');
          if (state.done || signal?.aborted || this.closed) { state.abort(); return; }
        } finally { await staged?.cleanup(); }
      }
      state.submitting = true;
      state.submittedAtMs = Date.now();
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
    if (this.purpose === 'assistant') { value.metrics = this.metrics(state); this.persistMetrics(state); }
    // Observers are telemetry, never part of admission or completion. Neither a
    // throwing callback nor its rejected promise can change the model result.
    try { Promise.resolve(state.onProgress?.(value)).catch(() => {}); } catch { /* Keep the controller authoritative. */ }
  }
  metrics(state) {
    const date = value => Number.isFinite(value) ? new Date(value).toISOString() : null;
    return { version: 1, status: state.callStatus || 'running', startedAt: date(state.startedAtMs),
      submittedAt: date(state.submittedAtMs), firstOutputAt: date(state.firstOutputAtMs), lastOutputAt: date(state.lastOutputAtMs),
      completedAt: date(state.completedAtMs), promptCharacters: state.promptCharacters, outputCharacters: state.outputCharacters,
      timeoutKind: state.timeoutKind || null, errorCode: state.errorCode || null,
      requestedReasoningEffort: state.requestedReasoningEffort ?? null, reasoningEffort: state.reasoningEffort ?? null,
      reasoningEffortWire: state.reasoningEffortWire ?? null,
      timeoutPolicy: { firstResponseTimeoutMs: state.firstResponseTimeoutMs, outputIdleTimeoutMs: state.outputIdleTimeoutMs,
        maxDurationMs: this.maxDurationMs, deadlineAt: date(state.deadlineAtMs) } };
  }
  persistMetrics(state) {
    if (this.purpose !== 'assistant' || !state.id || state.startedAtMs === undefined) return;
    // Observability never changes model admission/completion. Stream chunks only
    // update memory; durable rows are written at phase transitions and terminal.
    try { this.db.prepare('INSERT INTO application_model_calls(session_id,value) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET value=excluded.value')
      .run(state.id, JSON.stringify(this.metrics(state))); } catch { /* Preserve the authoritative model result. */ }
    try { this.app.logger?.write(state.callStatus === 'error' ? 'error' : ['timeout', 'interrupted'].includes(state.callStatus) ? 'warn' : 'info',
      'assistant.model.state', { component: 'assistant', sessionId: state.id, stage: state.phase, status: state.callStatus || 'running',
        durationMs: Math.max(0, (state.completedAtMs ?? Date.now()) - state.startedAtMs),
        ...(state.firstOutputAtMs !== undefined ? { waitMs: state.firstOutputAtMs - state.startedAtMs,
          outputMs: Math.max(0, (state.completedAtMs ?? Date.now()) - state.firstOutputAtMs) } : {}),
        promptCharacters: state.promptCharacters, outputCharacters: state.outputCharacters, timeoutKind: state.timeoutKind,
        requestedReasoningEffort: state.requestedReasoningEffort, reasoningEffort: state.reasoningEffort, reasoningEffortWire: state.reasoningEffortWire,
        errorCode: state.errorCode, firstResponseTimeoutMs: state.firstResponseTimeoutMs,
        outputIdleTimeoutMs: state.outputIdleTimeoutMs, maxDurationMs: this.maxDurationMs }); } catch { /* Logging never changes model control. */ }
  }
  scheduleTimeout(state) {
    if (state.done) return;
    clearTimeout(state.timer);
    const absolute = state.deadlineAtMs;
    const responseLimit = this.purpose === 'assistant' ? state.firstResponseTimeoutMs : this.timeoutMs;
    const response = responseLimit === null ? Infinity : state.startedAtMs + responseLimit;
    const activity = state.responseAtMs ?? state.lastOutputAtMs;
    const phaseDeadline = this.purpose === 'assistant' && activity !== undefined
      ? state.outputIdleTimeoutMs === null ? Infinity : activity + state.outputIdleTimeoutMs : response;
    const next = Math.min(absolute, phaseDeadline);
    state.nextDeadlineAtMs = next;
    // Normal model waits have no application deadline. Keep cancellation and
    // native terminal/error events authoritative; never schedule Infinity/0.
    if (!Number.isFinite(next)) return;
    const kind = this.purpose === 'learning' || absolute <= phaseDeadline ? 'absolute' : activity === undefined ? 'first-response' : 'output-idle';
    const timeout = () => {
      const elapsedMs = Math.max(0, Date.now() - state.startedAtMs);
      const message = this.purpose === 'assistant'
        ? `应用助手调用累计等待 ${Math.ceil(elapsedMs / 1000)} 秒超时，停止在「${state.phaseLabel}」阶段（${{ 'first-response': '等待首次输出', 'output-idle': '输出或结果读取停滞', absolute: '达到总截止时间' }[kind]}）。`
        : '学习模型调用超时，已停止。';
      state.timeoutKind = kind;
      this.finish(state, Object.assign(fail(message), { code: 'MODEL_TIMEOUT', timeoutKind: kind, phase: state.phase, phaseLabel: state.phaseLabel, elapsedMs,
        ...(this.purpose === 'assistant' ? { metrics: this.metrics(state) } : {}) }), true);
    };
    if (next <= Date.now()) { timeout(); return; }
    state.timer = setTimeout(timeout, next - Date.now()); state.timer.unref?.();
  }
  handleEvent(event) {
    if (this.closed) return;
    if (event.type === 'backend.status' && ['error', 'stopped', 'disconnected'].includes(event.payload?.state)) {
      for (const state of this.pending) this.finish(state, Object.assign(fail(`Hermes 连接中断；未重放${this.subject}调用。`), { code: 'MODEL_DISCONNECTED' }));
      return;
    }
    const state = this.active.get(event.sessionId);
    if (!state || state.done || state.terminal || !state.submitting) return;
    // An overdue timer can still be queued behind an incoming frame. Check the
    // previous deadline before allowing that frame to renew the output window.
    if (state.nextDeadlineAtMs <= Date.now()) { this.scheduleTimeout(state); return; }
    if (event.type === 'message.delta' && typeof event.payload?.text === 'string' && event.payload.text.length) {
      state.firstOutputAtMs ??= Date.now(); state.lastOutputAtMs = Date.now();
      state.outputCharacters += event.payload.text.length;
      this.scheduleTimeout(state);
      this.progress(state, 'model-output', '接收模型输出');
    }
    if (event.type === 'request.open') this.finish(state, fail(`${this.purpose === 'assistant' ? '应用助手' : '学习评价'}会话意外请求了工具或交互，已停止。`), true);
    if (event.type === 'error') this.finish(state, fail(redact(event.payload?.message || `${this.subject}调用失败。`)), true);
    if (event.type !== 'message.complete') return;
    state.terminal = true;
    const payload = event.payload || {};
    if (payload.status !== 'complete' || payload.partial || payload.error) {
      this.finish(state, fail(redact(payload.error || `${this.subject}未确认成功。`))); return;
    }
    state.responseAtMs = Date.now(); this.scheduleTimeout(state);
    if (state.done) return;
    this.progress(state, 'read-result', '确认模型完整结果');
    void (async () => {
      try {
        const history = await this.app.history(state.id);
        if (state.done || state.signal?.aborted || this.closed) return;
        const final = history.messages?.filter(message => message.role === 'assistant').at(-1);
        if (!final || typeof final.text !== 'string' || final.partial || final.tool_calls?.length || final.toolCalls?.length) throw fail(`${this.subject}历史中缺少完整结果。`);
        if (Buffer.byteLength(final.text, 'utf8') > 100000) throw fail(`${this.subject}返回内容超过限制。`);
        state.outputCharacters = Math.max(state.outputCharacters, final.text.length);
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
    state.completedAtMs = Date.now();
    state.callStatus = !error ? 'complete' : error.code === 'MODEL_TIMEOUT' ? 'timeout'
      : ['MODEL_ABORTED', 'MODEL_CLOSED'].includes(error.code) ? 'interrupted' : 'error';
    state.errorCode = !error ? null : ['MODEL_TIMEOUT', 'MODEL_ABORTED', 'MODEL_CLOSED', 'MODEL_DISCONNECTED'].includes(error.code) ? error.code : 'MODEL_ERROR';
    this.persistMetrics(state);
    if (error && this.purpose === 'assistant' && state.startedAtMs !== undefined) error.metrics = this.metrics(state);
    this.active.delete(state.id); this.pending.delete(state);
    if (interrupt && state.id) void this.app.interrupt(state.id).catch(() => {});
    if (error && state.scopeId) void this.releaseMemoryScope(state.scopeId).catch(() => {});
    if (error) state.reject(error); else state.resolve(value);
  }
  async close() {
    this.closed = true;
    this.app.off('event', this.onEvent);
    for (const state of this.pending) this.finish(state, Object.assign(fail(`工作台已关闭；${this.subject}调用已停止。`), { code: 'MODEL_CLOSED' }), true);
    for (const id of [...this.memoryScopes]) void this.releaseMemoryScope(id).catch(() => {});
  }
}
