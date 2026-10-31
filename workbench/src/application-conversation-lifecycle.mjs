import { createHash, randomUUID } from 'node:crypto';

const LEGACY = 'global-application';
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
  && !['__proto__', 'constructor', 'prototype'].includes(value);
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { httpStatus: status }); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const at = () => new Date().toISOString();
const uncertain = new Set(['admitting', 'starting', 'preparing', 'applying', 'running', 'queued', 'thinking', 'unknown', 'partial', 'rollback_partial']);
const maintenanceTools = new Set(['maintenance.task', 'maintenance.experiment']);
function input(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key))
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(field => !Object.hasOwn(field, 'value'))) fail('总控会话生命周期参数无效。');
}

// Only lifecycle metadata is changed. Turn bodies, membership, source-bound
// escalation identities and workflow records retain their original identities.
export class ApplicationConversationLifecycle {
  constructor(app, owner) {
    this.app = app; this.owner = owner; this.db = app.store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS application_conversation_lifecycle(conversation_id TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS application_conversation_creations(client_id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,conversation_id TEXT NOT NULL,archive_id TEXT);
      CREATE TABLE IF NOT EXISTS application_conversation_lifecycle_operations(operation_id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,value TEXT NOT NULL)`);
  }
  table(name) { return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)); }
  assertExists(id) {
    if (!identifier(id)) fail('总控会话编号无效。');
    if (id !== LEGACY && !this.db.prepare('SELECT 1 FROM application_conversations WHERE id=?').get(id)) fail('总控会话不存在。', 404);
  }
  readonly(id) {
    if (this.table('workflow_diagnostic_escalations') && this.db.prepare("SELECT 1 FROM workflow_diagnostic_escalations WHERE json_extract(value,'$.conversationId')=? LIMIT 1").get(id)) return true;
    return Boolean(this.db.prepare(`SELECT 1 FROM application_conversation_turns t LEFT JOIN application_conversation_membership m ON m.turn_id=t.id
      WHERE COALESCE(m.conversation_id,?)=? AND json_extract(t.value,'$.escalation.readOnly')=1 LIMIT 1`).get(LEGACY, id));
  }
  project(id) {
    this.assertExists(id);
    const row = this.db.prepare('SELECT value FROM application_conversation_lifecycle WHERE conversation_id=?').get(id), value = row ? JSON.parse(row.value) : null;
    return { lifecycle: value?.lifecycle === 'archived' ? 'archived' : 'active', lifecycleRevision: value?.revision || 0,
      archivedAt: value?.lifecycle === 'archived' ? value.archivedAt : null, readOnly: this.readonly(id) };
  }
  conversation(id) { return { ...this.owner.assertConversation(id), ...this.project(id) }; }
  matches(id, lifecycle = 'active') {
    if (!['active', 'archived', 'all'].includes(lifecycle)) fail('总控会话筛选范围无效。');
    return lifecycle === 'all' || this.project(id).lifecycle === lifecycle;
  }
  assertWritable(id) {
    if (this.project(id).lifecycle === 'archived') fail('此总控会话已归档，请先恢复或开启新会话。', 409);
  }
  assertIdle(id) {
    if (this.owner.activeConversations?.has(id)) fail('此总控会话仍在回复，请停止或等待结束后再归档。', 409);
    const rows = this.db.prepare(`SELECT t.id,json_extract(t.value,'$.status') AS status,
      json_extract(t.value,'$.assistant.checkpoint.mutationReceipts') AS receipts,json_extract(t.value,'$.outcome.status') AS outcome_status
      FROM application_conversation_turns t LEFT JOIN application_conversation_membership m ON m.turn_id=t.id WHERE COALESCE(m.conversation_id,?)=?`).all(LEGACY, id);
    // Maintenance descriptors also include readbacks. Their rejected lookups
    // can carry a conservative unknown checkpoint without executing anything;
    // durable task/experiment admissions below are the execution authority.
    if (rows.some(row => uncertain.has(row.status) || this.owner.active?.has(row.id) || uncertain.has(row.outcome_status)
      || row.receipts && JSON.parse(row.receipts).some(receipt => !maintenanceTools.has(receipt.tool) && uncertain.has(receipt.status)))) fail('此会话仍有运行中或结果未确认的操作，请先核对原任务。', 409);
    if (this.table('assistant_maintenance_tasks')) {
      const tasks = this.db.prepare('SELECT id,value FROM assistant_maintenance_tasks WHERE conversation_id=?').all(id);
      const ids = new Set(tasks.map(task => task.id));
      if (tasks.some(task => ['running', 'unknown'].includes(JSON.parse(task.value).status))
        || [...(this.owner.maintenance?.active?.values() || [])].some(value => ids.has(value.taskId))) fail('维护任务仍在执行或结果未确认，未归档。', 409);
      if (this.table('assistant_maintenance_experiments') && this.db.prepare(`SELECT 1 FROM assistant_maintenance_experiments e
        JOIN assistant_maintenance_tasks t ON t.id=e.task_id WHERE t.conversation_id=? AND json_extract(e.value,'$.status') IN ('admitting','running','unknown') LIMIT 1`).get(id)) fail('隔离实验结果未确认，未归档。', 409);
    }
    if (this.table('source_repair_records')) {
      const repairs = this.db.prepare("SELECT id,value FROM source_repair_records WHERE json_extract(value,'$.actor.conversationId')=?").all(id);
      if (repairs.some(row => { const record = JSON.parse(row.value); return uncertain.has(record.status) || record.tests?.some(test => uncertain.has(test.status)); })
        || this.table('source_repair_operations') && repairs.some(row => this.db.prepare("SELECT 1 FROM source_repair_operations WHERE repair_id=? AND (result IS NULL OR status IN ('running','unknown','partial','rollback_partial')) LIMIT 1").get(row.id))) fail('源码修复操作结果未确认，未归档。', 409);
    }
    if (this.table('workflow_diagnostic_escalations') && this.db.prepare("SELECT 1 FROM workflow_diagnostic_escalations WHERE json_extract(value,'$.conversationId')=? AND json_extract(value,'$.status') IN ('starting','unknown') LIMIT 1").get(id)) fail('来源诊断结果未确认，未归档。', 409);
  }
  save(id, lifecycle, previous) {
    const value = { version: 1, conversationId: id, lifecycle, revision: previous.lifecycleRevision + 1,
      archivedAt: lifecycle === 'archived' ? at() : null, updatedAt: at() };
    this.db.prepare('INSERT INTO application_conversation_lifecycle VALUES(?,?) ON CONFLICT(conversation_id) DO UPDATE SET value=excluded.value').run(id, JSON.stringify(value));
  }
  changed(id, action) {
    this.app.publish?.('application.conversations.updated', null, { conversationId: id, action, ...this.project(id) });
    try { this.app.logger?.write('info', 'assistant.conversation.lifecycle', { component: 'assistant', conversationId: id, status: this.project(id).lifecycle,
      revision: this.project(id).lifecycleRevision }); } catch { /* Metadata logging does not authorize lifecycle changes. */ }
  }
  create(raw) {
    input(raw, ['clientConversationId', 'title', 'archiveConversationId', 'expectedArchiveRevision']);
    if (typeof raw.clientConversationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(raw.clientConversationId)) fail('会话创建 ID 无效。');
    if (typeof raw.title !== 'string' || !raw.title.trim() || raw.title.length > 120 || /[\x00-\x1f]/.test(raw.title)) fail('请输入最多120字符的总控会话标题。');
    const archiveId = raw.archiveConversationId;
    if (archiveId === undefined ? raw.expectedArchiveRevision !== undefined : !identifier(archiveId) || !Number.isSafeInteger(raw.expectedArchiveRevision) || raw.expectedArchiveRevision < 0) fail('新会话归档目标和版本无效。');
    const title = raw.title.trim(), payload = digest([title, archiveId || null, raw.expectedArchiveRevision ?? null]);
    const prior = this.db.prepare('SELECT * FROM application_conversation_creations WHERE client_id=?').get(raw.clientConversationId);
    if (prior) {
      if (prior.payload_hash !== payload) fail('相同创建 ID 不能更换标题或归档目标。', 409);
      return { conversation: this.conversation(prior.conversation_id), ...(prior.archive_id ? { archivedConversation: this.conversation(prior.archive_id) } : {}), replayed: true };
    }
    const existing = this.db.prepare('SELECT id,title FROM application_conversations WHERE client_id=?').get(raw.clientConversationId);
    if (existing) {
      if (existing.title !== title || archiveId !== undefined) fail('相同创建 ID 已绑定不同的会话或归档操作。', 409);
      return { conversation: this.conversation(existing.id), replayed: true };
    }
    if (this.owner.closed) fail('应用助手已关闭。', 409);
    const id = 'supervisor-' + randomUUID(), createdAt = at();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (archiveId) {
        const previous = this.project(archiveId);
        if (previous.lifecycleRevision !== raw.expectedArchiveRevision) fail('旧会话版本已变化，请刷新后重试。', 409);
        if (previous.lifecycle === 'archived') fail('旧会话已经归档，请刷新后选择新的当前会话。', 409);
        this.assertIdle(archiveId); this.save(archiveId, 'archived', previous);
      }
      this.db.prepare('INSERT INTO application_conversations(id,client_id,title,created_at) VALUES(?,?,?,?)').run(id, raw.clientConversationId, title, createdAt);
      this.db.prepare('INSERT INTO application_conversation_creations VALUES(?,?,?,?)').run(raw.clientConversationId, payload, id, archiveId || null);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    if (archiveId) this.changed(archiveId, 'archive'); this.changed(id, 'create');
    return { conversation: this.conversation(id), ...(archiveId ? { archivedConversation: this.conversation(archiveId) } : {}) };
  }
  change(id, raw) {
    input(raw, ['action', 'operationId', 'expectedRevision']); this.assertExists(id);
    if (!['archive', 'restore'].includes(raw.action) || !identifier(raw.operationId) || !Number.isSafeInteger(raw.expectedRevision) || raw.expectedRevision < 0) fail('总控会话归档操作或版本无效。');
    const payload = digest([id, raw.action, raw.expectedRevision]), previous = this.db.prepare('SELECT * FROM application_conversation_lifecycle_operations WHERE operation_id=?').get(raw.operationId);
    if (previous) {
      if (previous.payload_hash !== payload) fail('此操作 ID 已绑定其它会话归档内容。', 409);
      return { conversation: this.conversation(id), operation: JSON.parse(previous.value), replayed: true };
    }
    if (this.owner.closed) fail('应用助手已关闭。', 409);
    const lifecycle = raw.action === 'archive' ? 'archived' : 'active'; let operation;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.project(id);
      if (current.lifecycleRevision !== raw.expectedRevision) fail('总控会话版本已变化，请刷新后重试。', 409);
      if (lifecycle === 'archived' && current.lifecycle !== lifecycle) this.assertIdle(id);
      if (current.lifecycle !== lifecycle) this.save(id, lifecycle, current);
      operation = { operationId: raw.operationId, action: raw.action, conversationId: id, status: 'complete', ...this.project(id), completedAt: at() };
      this.db.prepare('INSERT INTO application_conversation_lifecycle_operations VALUES(?,?,?)').run(raw.operationId, payload, JSON.stringify(operation));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.changed(id, raw.action); return { conversation: this.conversation(id), operation };
  }
}
