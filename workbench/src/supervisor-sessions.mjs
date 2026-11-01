import { createHash } from 'node:crypto';

const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
  && !['__proto__', 'constructor', 'prototype'].includes(value);
const fail = (message, httpStatus = 400) => { throw Object.assign(new Error(message), { httpStatus }); };
const terminal = new Set(['complete', 'error', 'interrupted']);
const fingerprint = value => 'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex');
function plain(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key))
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(field => !Object.hasOwn(field, 'value'))) fail('总控原生会话参数无效。');
}
function route(value) {
  plain(value, ['provider', 'model']);
  if (!['provider', 'model'].every(key => typeof value[key] === 'string' && value[key].trim() === value[key] && value[key].length > 0 && value[key].length <= 240
    && !/[\x00-\x1f]/.test(value[key]))) fail('总控会话模型身份无效。');
  return { provider: value.provider, model: value.model };
}
const sameRoute = (a, b) => a.provider === b.provider && a.model === b.model;

// A one-time legacy introduction contains only visible prose. Historical text
// remains data: it restores neither tool results nor operation authorizations.
export function boundedSupervisorHistory(turns) {
  if (!Array.isArray(turns)) fail('旧总控聊天记录必须是列表。');
  const messages = [], selected = turns.slice(-6); let remaining = 12000, truncated = turns.length > selected.length;
  for (const turn of [...selected].reverse()) {
    const pair = [];
    for (const [role, source] of [['assistant', turn?.assistant?.text], ['user', turn?.user?.text]]) {
      if (typeof source !== 'string' || !source.trim()) continue;
      const max = Math.min(1600, remaining), text = source.slice(0, max); if (text.length < source.length) truncated = true;
      if (text) { pair.unshift({ role, ...(identifier(turn.id) ? { turnId: turn.id } : {}), text }); remaining -= text.length; }
    }
    messages.unshift(...pair);
  }
  const value = { version: 1, kind: 'historical-data', readOnly: true, authorizationRestored: false, sourceTurns: turns.length,
    includedTurns: new Set(messages.map(message => message.turnId)).size, characters: 12000 - remaining, truncated, messages };
  return { ...value, sha256: fingerprint(value) };
}

// This module owns only native-session metadata. Application chat bodies and
// workflow records are never read or changed here. Hermes owns native history.
export class SupervisorSessions {
  constructor({ db, readConversation, now = () => new Date().toISOString() }) {
    if (!db?.prepare || typeof readConversation !== 'function' || typeof now !== 'function') fail('总控会话存储依赖无效。');
    this.db = db; this.readConversation = readConversation; this.now = now;
    db.exec(`CREATE TABLE IF NOT EXISTS supervisor_native_sessions (
      conversation_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, stored_session_id TEXT UNIQUE, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS supervisor_native_turns (conversation_id TEXT NOT NULL,turn_id TEXT NOT NULL,request_id TEXT NOT NULL,
        PRIMARY KEY(conversation_id,turn_id),UNIQUE(conversation_id,request_id))`);
    this.resetRuntime('runtime-restart');
  }
  conversation(id, writable = false) {
    if (!identifier(id)) fail('总控会话编号无效。');
    const topic = this.readConversation(id);
    if (!topic || typeof topic !== 'object') fail('总控会话不存在。', 404);
    if (writable && (topic.lifecycle === 'archived' || topic.archived === true)) fail('此总控会话已归档，不能继续原生执行。', 409);
    if (writable && topic.readOnly === true) fail('来源绑定的只读总控会话不能取得原生执行能力。', 403);
    return topic;
  }
  get(id) {
    this.conversation(id);
    const row = this.db.prepare('SELECT value FROM supervisor_native_sessions WHERE conversation_id=?').get(id);
    return row ? JSON.parse(row.value) : null;
  }
  current(id, expectedRevision, { writable = true } = {}) {
    this.conversation(id, writable);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail('总控原生会话预期版本无效。');
    const value = this.get(id);
    if ((value?.revision || 0) !== expectedRevision) fail('总控原生会话版本已变化。', 409);
    return value;
  }
  save(value, expectedRevision) {
    const previous = this.db.prepare('SELECT revision FROM supervisor_native_sessions WHERE conversation_id=?').get(value.conversationId);
    if ((previous?.revision || 0) !== expectedRevision) fail('总控原生会话版本已变化。', 409);
    const next = { ...value, revision: expectedRevision + 1, updatedAt: this.now() };
    if (next.storedSessionId) {
      const owner = this.db.prepare('SELECT conversation_id FROM supervisor_native_sessions WHERE stored_session_id=?').get(next.storedSessionId);
      if (owner && owner.conversation_id !== value.conversationId) fail('原生会话历史已归属其它总控主题。', 409);
    }
    if (previous) {
      const result = this.db.prepare('UPDATE supervisor_native_sessions SET revision=?,stored_session_id=?,value=? WHERE conversation_id=? AND revision=?')
        .run(next.revision, next.storedSessionId || null, JSON.stringify(next), next.conversationId, expectedRevision);
      if (!result.changes) fail('总控原生会话版本已变化。', 409);
    } else {
      try { this.db.prepare('INSERT INTO supervisor_native_sessions VALUES(?,?,?,?)').run(next.conversationId, next.revision, next.storedSessionId || null, JSON.stringify(next)); }
      catch (error) { if (String(error.code).includes('CONSTRAINT')) fail('总控原生会话已由另一请求绑定。', 409); throw error; }
    }
    return structuredClone(next);
  }
  begin(id, input) {
    plain(input, ['expectedRevision', 'turnId', 'requestId', 'modelRoute']);
    if (!identifier(input.turnId) || !identifier(input.requestId)) fail('总控原生轮次身份无效。');
    const current = this.current(id, input.expectedRevision), modelRoute = input.modelRoute === undefined ? current?.modelRoute : route(input.modelRoute);
    if (!modelRoute) fail('首次总控会话必须固定模型身份。');
    if (current?.modelRoute && !sameRoute(current.modelRoute, modelRoute)) fail('总控原生会话模型已固定，请开启新主题。', 409);
    if (current?.activeTurnId) fail('此总控会话已有一轮正在进行。', 409);
    if (current?.lastTurnId === input.turnId || current?.lastRequestId === input.requestId) fail('此总控轮次已经结束，不能自动重放。', 409);
    if (this.db.prepare('SELECT 1 FROM supervisor_native_turns WHERE conversation_id=? AND (turn_id=? OR request_id=?)').get(id, input.turnId, input.requestId)) fail('此总控轮次已经登记，不能自动重放。', 409);
    const at = this.now(); this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO supervisor_native_turns VALUES(?,?,?)').run(id, input.turnId, input.requestId);
      const result = this.save({ version: 1, conversationId: id, storedSessionId: null, runtimeSessionId: null, createdAt: at, ...current,
        modelRoute, archived: false, status: 'running', activeTurnId: input.turnId, activeRequestId: input.requestId, startedAt: at, interruptionReason: null }, input.expectedRevision);
      this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  bind(id, input) {
    plain(input, ['expectedRevision', 'turnId', 'storedSessionId', 'runtimeSessionId', 'modelRoute', 'previousStoredSessionId', 'legacyContextDigest']);
    if (!identifier(input.storedSessionId) || !identifier(input.runtimeSessionId) || input.turnId !== undefined && !identifier(input.turnId)
      || input.previousStoredSessionId !== undefined && !identifier(input.previousStoredSessionId)
      || input.legacyContextDigest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(input.legacyContextDigest)) fail('总控原生会话绑定身份无效。');
    const current = this.current(id, input.expectedRevision), modelRoute = route(input.modelRoute);
    if (!current) fail('绑定原生会话前必须先登记人工轮次。', 409);
    if (current.activeTurnId && current.activeTurnId !== input.turnId) fail('原生会话绑定不属于当前轮次。', 409);
    if (!sameRoute(current.modelRoute, modelRoute)) fail('原生会话模型与已固定身份不一致。', 409);
    if (current.storedSessionId && current.storedSessionId !== input.storedSessionId && current.storedSessionId !== input.previousStoredSessionId) fail('更换原生会话必须明确匹配原会话身份。', 409);
    if (current.legacyContextDigest && input.legacyContextDigest && current.legacyContextDigest !== input.legacyContextDigest) fail('旧聊天引入内容已固定，不能重复导入其它历史。', 409);
    return this.save({ ...current, storedSessionId: input.storedSessionId, runtimeSessionId: input.runtimeSessionId,
      ...(current.storedSessionId && current.storedSessionId !== input.storedSessionId ? { previousStoredSessionId: current.storedSessionId } : {}),
      ...(input.legacyContextDigest ? { legacyContextDigest: input.legacyContextDigest } : {}) }, input.expectedRevision);
  }
  finish(id, input) {
    plain(input, ['turnId', 'requestId', 'status']);
    if (!identifier(input.turnId) || input.requestId !== undefined && !identifier(input.requestId) || !terminal.has(input.status)) fail('总控原生轮次完成状态无效。');
    const current = this.get(id);
    if (!current?.activeTurnId || current.activeTurnId !== input.turnId || input.requestId !== undefined && current.activeRequestId !== input.requestId) fail('完成事件不属于当前总控轮次。', 409);
    return this.save({ ...current, status: input.status, lastTurnId: current.activeTurnId, lastRequestId: current.activeRequestId,
      activeTurnId: null, activeRequestId: null, completedAt: this.now() }, current.revision);
  }
  archive(id, input = {}) {
    plain(input, ['expectedRevision']);
    const current = this.current(id, input.expectedRevision, { writable: false });
    if (!current) return null;
    if (current.activeTurnId) fail('总控原生轮次仍在进行，请停止后再归档。', 409);
    return this.save({ ...current, archived: true, runtimeSessionId: null }, current.revision);
  }
  resetRuntime(reason) {
    for (const row of this.db.prepare('SELECT value FROM supervisor_native_sessions').all()) {
      const current = JSON.parse(row.value);
      if (!current.runtimeSessionId && !current.activeTurnId) continue;
      this.save({ ...current, runtimeSessionId: null, ...(current.activeTurnId ? { status: 'interrupted', lastTurnId: current.activeTurnId,
        lastRequestId: current.activeRequestId, activeTurnId: null, activeRequestId: null, completedAt: this.now(), interruptionReason: reason } : {}) }, current.revision);
    }
  }
  disconnect() { this.resetRuntime('runtime-disconnected'); }
}
