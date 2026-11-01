import { randomUUID } from 'node:crypto';
import { redact } from './hermes-adapter.mjs';

const fail = (message, httpStatus = 409) => Object.assign(new Error(message), { httpStatus });
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const safe = value => {
  const visit = (value, depth = 0) => {
    if (depth > 20) throw fail('工具审批参数层级过深。', 400);
    if (Array.isArray(value)) return value.map(row => visit(row, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      /(?:api[_-]?key|token|password|secret|authorization|cookie|credential|private[_-]?key)/i.test(key) ? '[已隐藏]' : visit(item, depth + 1)]));
    return typeof value === 'string' ? redact(value) : value;
  };
  const text = JSON.stringify(visit(value ?? {})); if (text.length > 20000) throw fail('工具审批参数过长，请拆分操作。', 400); return JSON.parse(text);
};

// An approval authorizes this exact call only. Reconnects retain its receipt,
// never its waiter or authority to execute a previous operation.
export class ApplicationToolApprovals {
  constructor(app) {
    this.app = app; this.db = app.store.db; this.pending = new Map(); this.closed = false;
    this.db.exec('CREATE TABLE IF NOT EXISTS application_tool_approvals (id TEXT PRIMARY KEY, owner TEXT NOT NULL, value TEXT NOT NULL)');
    for (const row of this.db.prepare('SELECT id,value FROM application_tool_approvals').all()) {
      const value = JSON.parse(row.value);
      if (value.status === 'pending') this.save({ ...value, status: 'interrupted', revision: value.revision + 1, completedAt: new Date().toISOString() });
    }
  }
  save(value) { this.db.prepare('INSERT INTO application_tool_approvals(id,owner,value) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(value.id, value.owner, JSON.stringify(value)); }
  requests(owner) {
    if (!identifier(owner)) return [];
    return this.db.prepare('SELECT value FROM application_tool_approvals WHERE owner=? ORDER BY rowid').all(owner)
      .map(row => JSON.parse(row.value)).filter(row => row.status === 'pending' && this.pending.has(row.id));
  }
  emit(owner) {
    if (this.closed || this.app.closed) return;
    try {
      if (this.app.applicationAssistant?.listConversations({ lifecycle: 'all' }).some(row => row.id === owner)) this.app.applicationAssistant.emit(owner);
      else this.app.conversations?.emit(owner);
    } catch { /* A removed or archived owner cannot receive another prompt. */ }
  }
  async request(details, { conversationId, turnId, runId, signal, authorize } = {}) {
    if (this.closed || this.app.closed || signal?.aborted) throw fail('工具调用已停止。');
    if (!identifier(conversationId) || !identifier(turnId || runId) || typeof authorize !== 'function') throw fail('工具审批缺少当前会话身份。', 403);
    await authorize();
    if (this.closed || signal?.aborted) throw fail('工具调用已停止。');
    const value = { id: 'tool-approval-' + randomUUID(), owner: conversationId, ...(turnId ? { turnId } : {}), ...(runId ? { runId } : {}),
      revision: 1, status: 'pending', kind: details.kind, title: redact(String(details.title || '外部工具调用')).slice(0, 200),
      details: safe(details.details), createdAt: new Date().toISOString() };
    return new Promise((resolve, reject) => {
      const abort = () => this.settle(value.id, 'cancelled', reject, fail('工具调用已停止；审批未执行。'));
      this.pending.set(value.id, { value, authorize, resolve, reject, signal, abort });
      signal?.addEventListener('abort', abort, { once: true }); this.save(value); this.emit(conversationId);
      if (signal?.aborted) abort();
    });
  }
  settle(id, status, finish, result) {
    const pending = this.pending.get(id); if (!pending) return;
    this.pending.delete(id); pending.signal?.removeEventListener('abort', pending.abort);
    this.save({ ...pending.value, revision: pending.value.revision + 1, status, completedAt: new Date().toISOString() });
    this.emit(pending.value.owner); finish(result);
  }
  async respond(owner, id, input, { human = false } = {}) {
    if (!human || this.closed || !identifier(owner) || !identifier(id)) throw fail('工具审批只能由用户操作。', 403);
    if (!input || Object.keys(input).some(key => !['expectedRevision', 'choice'].includes(key)) || !['once', 'deny'].includes(input.choice)) throw fail('工具审批内容无效。', 400);
    const pending = this.pending.get(id);
    if (!pending || pending.value.owner !== owner || pending.value.revision !== input.expectedRevision || pending.signal?.aborted) throw fail('工具审批已失效，请刷新记录。');
    try { await pending.authorize(); }
    catch (error) { this.settle(id, 'cancelled', pending.reject, error); throw error; }
    if (this.pending.get(id) !== pending) throw fail('工具审批已失效。');
    this.settle(id, input.choice === 'once' ? 'approved' : 'denied', pending.resolve, input.choice === 'once');
    return { accepted: true, executed: false };
  }
  close() {
    if (this.closed) return; this.closed = true;
    for (const [id, pending] of this.pending) this.settle(id, 'interrupted', pending.reject, fail('工作台已关闭；审批未重放。'));
  }
}
