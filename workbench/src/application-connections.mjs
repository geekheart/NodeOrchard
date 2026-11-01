import { createHash } from 'node:crypto';
import { validateDiagnosticArguments } from './assistant-diagnostic-turn.mjs';

const identifier = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$', maxLength: 128 };
const slug = { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,79}$', maxLength: 80 };
const target = { anyOf: [slug, { type: 'object', properties: { name: slug, mcp: { type: 'boolean' } }, required: ['name'], additionalProperties: false }] };
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const descriptor = (name, description, properties, required = [], effect = 'read-only') => ({ name, description, effect,
  inputSchema: schema(properties, required), roles: ['supervisor'], availability: 'available', readOnly: effect === 'read-only',
  annotations: { readOnlyHint: effect === 'read-only', destructiveHint: false, idempotentHint: true, openWorldHint: true } });

export const APPLICATION_CONNECTION_TOOLS = Object.freeze([
  descriptor('connections.list', '读取Hermes原生连接状态、已配置MCP和可安装目录及revision；不返回端点、命令或凭据。启用不等于工具可用，实际依赖需调用验证。', {}),
  descriptor('connections.manage', '总控调用Hermes原生连接管理：connect/reconnect连接托管账号；install安装目录MCP；enable启用已配置MCP；authorize发起其OAuth。先list取得expectedRevision。原生授权卡由用户确认或填写凭据，AI不可代批或读取凭据。连接不运行工作流，不修改权限；断开/删除由用户在Hermes管理。', {
    action: { type: 'string', enum: ['connect', 'reconnect', 'install', 'enable', 'authorize'] },
    connectors: { type: 'array', minItems: 1, maxItems: 10, items: target }, force: { type: 'boolean' },
    expectedRevision: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' }, operationId: identifier,
  }, ['action', 'connectors', 'expectedRevision', 'operationId'], 'mutation'),
]);

const fail = (message, httpStatus = 409) => { throw Object.assign(new Error(message), { httpStatus }); };
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) && !['constructor', 'prototype', '__proto__'].includes(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const fresh = () => new Date().toISOString();

function projectSnapshot(raw, browser = false) {
  if (!raw || typeof raw !== 'object') return { targets: [] };
  const snapshot = Object.fromEntries(['op_id', 'seq', 'deadline_at', 'timeout_seconds', 'settled', 'settled_at', 'settled_by', 'status']
    .filter(key => typeof raw[key] === 'string' || typeof raw[key] === 'number' || typeof raw[key] === 'boolean' || raw[key] === null).map(key => [key, raw[key]]));
  snapshot.targets = (Array.isArray(raw.targets) ? raw.targets : []).slice(0, 10).filter(row => row && typeof row.name === 'string').map(row => {
    const result = Object.fromEntries(['name', 'kind', 'action', 'state', 'detail', 'discovery_error'].filter(key => typeof row[key] === 'string').map(key => [key, row[key].slice(0, 500)]));
    if (Array.isArray(row.tools)) result.tools = row.tools.filter(validId).slice(0, 256);
    if (browser) {
      if (typeof row.connect_url === 'string' && row.connect_url.length <= 8192) {
        try { const url = new URL(row.connect_url); if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) result.connect_url = url.href; } catch {}
      }
      if (Array.isArray(row.required_env)) result.required_env = row.required_env.slice(0, 32).filter(field => field && /^[A-Z][A-Z0-9_]{0,127}$/.test(field.name || '')).map(field => ({
        name: field.name, prompt: String(field.prompt || field.name).slice(0, 300), required: field.required === true, secret: field.secret === true,
        default: field.secret ? '' : String(field.default || '').slice(0, 1000),
      }));
    }
    return result;
  });
  return snapshot;
}

// This host module owns admission and topic binding. Hermes owns connector
// authorization, credential storage, MCP installation and outcome evidence.
export class ApplicationConnections {
  constructor(app) {
    this.app = app; this.db = app.store.db; this.pending = new Map(); this.closed = false;
    this.db.exec(`CREATE TABLE IF NOT EXISTS application_connection_operations (
      operation_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL,
      request_hash TEXT NOT NULL, status TEXT NOT NULL, result TEXT, updated_at TEXT NOT NULL)`);
    this.db.prepare("UPDATE application_connection_operations SET status='unknown' WHERE status='pending'").run();
    this.onEvent = event => this.observe(event);
    app.adapter.on('event', this.onEvent);
  }
  tools() { return structuredClone(APPLICATION_CONNECTION_TOOLS); }
  handles(name) { return APPLICATION_CONNECTION_TOOLS.some(row => row.name === name); }
  async authorize(context, mutation = false) {
    if (this.closed || context.signal?.aborted) fail('连接管理已停止。');
    if (context.role !== 'supervisor' || mutation && context.readOnly === true) fail('连接管理仅供总控会话调用。', 403);
    if (typeof context.authorize !== 'function') fail('连接管理缺少服务端权限范围。', 403);
    await context.authorize();
  }
  async call(name, args = {}, context = {}) {
    const tool = APPLICATION_CONNECTION_TOOLS.find(row => row.name === name);
    if (!tool) fail('连接工具不存在。', 404);
    validateDiagnosticArguments(args, tool.inputSchema);
    await this.authorize(context, name === 'connections.manage');
    if (this.app.adapter.state !== 'ready') fail('Hermes 未连接。');
    if (name === 'connections.list') {
      const raw = await this.app.adapter.request('workbench.connections.inspect', {});
      await this.authorize(context);
      if (raw?.native !== true || !/^sha256:[a-f0-9]{64}$/.test(raw.revision || '')) fail('Hermes 未确认原生连接目录。', 502);
      const names = rows => (Array.isArray(rows) ? rows : []).slice(0, 200).filter(row => row && typeof row.name === 'string' && /^[a-z0-9][a-z0-9_-]{0,79}$/.test(row.name));
      return { native: true, revision: raw.revision,
        mcp: names(raw.mcp).map(row => ({ name: row.name, enabled: row.enabled === true, transport: row.transport === 'http' ? 'http' : 'stdio' })),
        catalog: names(raw.catalog).map(row => ({ name: row.name, description: String(row.description || '').slice(0, 500), installed: row.installed === true })),
        hostedAvailable: raw.hostedAvailable === true, hostedStatusUnavailable: raw.hostedStatusUnavailable === true,
        hosted: (Array.isArray(raw.hosted) ? raw.hosted : []).slice(0, 200).map(row => ({ connector: String(row.connector || '').slice(0, 80), enabled: row.enabled === true,
          connected: row.connected === true, connection_status: ['pending', 'active', 'failed', 'expired', 'revoked', 'inactive'].includes(row.connection_status) ? row.connection_status : null })),
      };
    }
    const conversationId = context.sourceConversationId || context.conversationId, turnId = context.diagnosticTurnId || context.turnId;
    if (!validId(conversationId) || !validId(turnId)) fail('连接管理必须绑定当前人工对话与轮次。', 403);
    const fingerprint = hash([conversationId, turnId, args]), previous = this.db.prepare('SELECT * FROM application_connection_operations WHERE operation_id=?').get(args.operationId);
    if (previous) {
      if (previous.request_hash !== fingerprint) fail('连接操作身份已绑定其它内容。');
      if (previous.result) return JSON.parse(previous.result);
      if (this.pending.has(args.operationId)) return this.pending.get(args.operationId).promise;
      return { operationId: args.operationId, status: 'unknown', replayed: false, reason: '此前连接结果未确认；请读取状态，不自动重发。' };
    }
    await this.authorize(context, true);
    const row = { conversationId, turnId, context, snapshot: null };
    this.db.prepare('INSERT INTO application_connection_operations VALUES(?,?,?,?,?,?,?)').run(args.operationId, conversationId, turnId, fingerprint, 'pending', null, fresh());
    this.pending.set(args.operationId, row);
    const cancel = () => { void this.app.adapter.request('workbench.connections.cancel', { operation_id: args.operationId }).catch(() => {}); };
    context.signal?.addEventListener('abort', cancel, { once: true });
    row.promise = (async () => {
      let result;
      try {
        const raw = await this.app.adapter.request('workbench.connections.manage', { operation_id: args.operationId, conversation_id: conversationId, turn_id: turnId,
          expected_revision: args.expectedRevision, action: args.action, connectors: args.connectors, force: args.force || false }, null);
        if (raw?.native !== true) fail('Hermes 未确认连接操作。', 502);
        result = { operationId: args.operationId, native: true, ...projectSnapshot(raw),
          status: raw.error ? 'error' : 'settled', revision: /^sha256:[a-f0-9]{64}$/.test(raw.revision || '') ? raw.revision : null };
        this.app.skillIntegrations?.invalidate();
      } catch {
        result = { operationId: args.operationId, native: true, status: 'unknown', replayed: false, reason: '连接结果未确认；请重新读取连接状态，不自动重发。' };
      } finally {
        context.signal?.removeEventListener('abort', cancel);
        this.pending.delete(args.operationId);
      }
      this.db.prepare('UPDATE application_connection_operations SET status=?,result=?,updated_at=? WHERE operation_id=?').run(result.status, JSON.stringify(result), fresh(), args.operationId);
      this.publish(conversationId);
      return result;
    })();
    return row.promise;
  }
  observe(event) {
    if (!/^workbench\.connections\.(?:request|update|complete)$/.test(event?.type || '')) return;
    const payload = event.payload, row = this.pending.get(payload?.operation_id);
    if (!row || payload.conversation_id !== row.conversationId || payload.turn_id !== row.turnId) return;
    if (row.context.signal?.aborted) return;
    const snapshot = projectSnapshot(payload.snapshot, true);
    if (row.snapshot && Number.isFinite(row.snapshot.seq) && snapshot.seq < row.snapshot.seq) return;
    row.snapshot = snapshot.settled === true ? null : snapshot;
    this.publish(row.conversationId);
  }
  publish(conversationId) {
    this.app.publish('connections.updated', null, { conversationId, connectionRequests: this.requests(conversationId) });
    this.app.applicationAssistant?.emit(conversationId);
  }
  requests(conversationId) {
    return [...this.pending.entries()].filter(([_id, row]) => row.conversationId === conversationId && row.snapshot).map(([operationId, row]) => ({
      id: operationId, turnId: row.turnId, method: 'connection', params: structuredClone(row.snapshot),
    }));
  }
  async respond(conversationId, operationId, body, { human, authorize } = {}) {
    if (human !== true || typeof authorize !== 'function') fail('连接授权只能由用户在界面确认。', 403);
    await authorize();
    const row = this.pending.get(operationId);
    if (!row || row.conversationId !== conversationId || !row.snapshot || row.context.signal?.aborted) fail('此连接请求已结束。');
    await this.authorize(row.context, true);
    // Validation and credential scope are repeated in the Python native bridge.
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['targets', 'settled_by'].includes(key))
      || body.settled_by !== undefined && body.settled_by !== 'continue' || body.targets !== undefined && (!Array.isArray(body.targets) || body.targets.length > 10)) fail('连接授权答复无效。', 400);
    const result = await this.app.adapter.request('workbench.connections.respond', { operation_id: operationId, result: body });
    await authorize();
    if (result?.accepted !== true) fail('Hermes 未接受连接答复。', 502);
    return { accepted: true, settled: result.settled === true };
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.app.adapter.off('event', this.onEvent);
    await Promise.allSettled([...this.pending.keys()].map(operationId => this.app.adapter.request('workbench.connections.cancel', { operation_id: operationId })));
    await Promise.allSettled([...this.pending.values()].map(row => row.promise));
    this.pending.clear();
  }
}
