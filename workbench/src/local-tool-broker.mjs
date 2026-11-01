import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import { redact } from './hermes-adapter.mjs';

const fail = (message, httpStatus = 409, code = 'LOCAL_TOOL_UNAVAILABLE') => { throw Object.assign(new Error(message), { httpStatus, code }); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : plain(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const inside = (root, value) => { const part = relative(root, value); return part === '' || part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part); };
const observation = new Set(['capture', 'list_apps', 'list_windows', 'status']);
const desktopActions = new Set([...observation, 'click', 'double_click', 'right_click', 'scroll', 'type', 'key', 'set_value']);
function args(value, keys) {
  if (!plain(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key)
    || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) fail('本机工具参数无效。', 400, 'LOCAL_TOOL_ARGUMENTS');
}
async function actual(path) {
  try { return await realpath(path); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return resolve(await actual(dirname(path)), basename(path)); }
}

// Both chat roles and workflow attempts enter the same host dispatcher. A model
// supplies a configured server/tool identity, never a URL, process or permission.
export class LocalToolBroker {
  constructor(app, { authorize, readPolicy = () => ({ desktopApps: [] }) } = {}) {
    this.app = app; this.authorize = authorize; this.readPolicy = readPolicy; this.active = new Map(); this.closed = false;
    this.db = app.store.db;
    this.db.exec('CREATE TABLE IF NOT EXISTS local_tool_operations (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, status TEXT NOT NULL, value TEXT, updated_at TEXT NOT NULL)');
    this.db.prepare("UPDATE local_tool_operations SET status='unknown' WHERE status='pending'").run();
  }
  async current(scope, context = {}) {
    if (this.closed || this.app.closed || context.signal?.aborted) fail('本机工具调用已停止。', 409, 'LOCAL_TOOL_CANCELLED');
    if (!scope || typeof scope.workingFolder !== 'string' || !isAbsolute(scope.workingFolder) || !plain(scope.permissions)) fail('本机工具缺少宿主绑定的权限范围。', 403, 'LOCAL_TOOL_SCOPE');
    if (typeof this.authorize !== 'function') fail('本机工具权限校验不可用。', 503, 'LOCAL_TOOL_SCOPE');
    await this.authorize(scope); await context.authorize?.();
    if (this.closed || this.app.closed || context.signal?.aborted) fail('本机工具调用已停止。', 409, 'LOCAL_TOOL_CANCELLED');
    if (this.app.adapter?.state !== 'ready') fail('Hermes 尚未连接。');
  }
  identity(scope, context) {
    const owner = context.conversationId || context.runId || scope.workflowId;
    const turn = context.turnId || context.attemptId || context.runId;
    if (!id(owner) || !id(turn)) fail('本机工具缺少当前对话轮次或运行身份。', 403, 'LOCAL_TOOL_SCOPE');
    return 'local-' + hash({ owner, turn, revision: scope.revision, folder: scope.workingFolder }).slice(0, 40);
  }
  async inspect(scope, { server, refresh = false } = {}, context = {}) {
    await this.current(scope, context);
    if (server !== undefined && !id(server)) fail('MCP 服务身份无效。', 400, 'LOCAL_TOOL_ARGUMENTS');
    const result = await this.app.adapter.request('workbench.local-tools.catalog', { ...(server ? { server } : {}), refresh: refresh === true, application_port: this.app.config.port });
    if (!plain(result) || !/^sha256:[a-f0-9]{64}$/.test(result.revision || '') || !Array.isArray(result.servers)) fail('Hermes 未确认本机工具目录。', 502);
    const policy = this.readPolicy() || {};
    return { ...result, permissions: { mcpTools: scope.permissions.mcpTools === true, desktopControl: scope.permissions.desktopControl === true,
          capture: scope.permissions.capture === true }, desktop: { ...(result.desktop || {}), allowedApps: Array.isArray(policy.desktopApps) ? [...policy.desktopApps] : [] } };
  }
  async paths(value, scope, key = '', depth = 0) {
    if (depth > 20) fail('MCP 参数层级过深。', 400, 'LOCAL_TOOL_ARGUMENTS');
    if (Array.isArray(value)) { for (const item of value) await this.paths(item, scope, key, depth + 1); return; }
    if (plain(value)) { for (const [name, item] of Object.entries(value)) await this.paths(item, scope, name, depth + 1); return; }
    if (typeof value !== 'string' || !/(?:path|file|folder|directory|cwd|root|destination|output_dir|input_dir)/i.test(key)) return;
    if (!value || value.includes('\0') || /^[A-Za-z]+:\/\//.test(value)) fail('MCP 文件参数必须位于当前工作文件夹。', 403, 'LOCAL_TOOL_PATH');
    const folder = await actual(scope.workingFolder), target = await actual(resolve(folder, value));
    if (!inside(folder, target)) fail('MCP 文件参数超出当前工作文件夹。', 403, 'LOCAL_TOOL_PATH');
    for (const root of [this.app.config?.appRoot, this.app.config?.hermesHome, this.app.config?.dataDir].filter(Boolean)) {
      const protectedRoot = await actual(root);
      if (inside(protectedRoot, target) || inside(target, protectedRoot)) fail('MCP 不可访问工作台源码、配置或原 Hermes 资料。', 403, 'LOCAL_TOOL_PATH');
    }
  }
  async perform(kind, request, scope, context, execute) {
    await this.current(scope, context);
    const identity = this.identity(scope, context), operationId = request.operationId;
    if (!id(operationId)) fail('本机工具操作身份无效。', 400, 'LOCAL_TOOL_ARGUMENTS');
    const fingerprint = hash({ kind, request, identity }), existing = this.db.prepare('SELECT * FROM local_tool_operations WHERE id=?').get(operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) fail('操作身份已用于其它调用。', 409, 'LOCAL_TOOL_CONFLICT');
      if (existing.status === 'complete') return JSON.parse(existing.value);
      if (this.active.has(operationId)) return this.active.get(operationId);
      fail('上次本机工具调用结果未知；请先读取外部状态，不会自动重放。', 409, 'LOCAL_TOOL_OUTCOME_UNKNOWN');
    }
    const now = () => new Date().toISOString();
    this.db.prepare('INSERT INTO local_tool_operations(id,fingerprint,status,updated_at) VALUES(?,?,?,?)').run(operationId, fingerprint, 'pending', now());
    const promise = Promise.resolve().then(async () => {
      let dispatched = false;
      try {
        const value = await execute(identity, async () => { await this.current(scope, context); dispatched = true; });
        this.db.prepare("UPDATE local_tool_operations SET status='complete',value=?,updated_at=? WHERE id=?").run(JSON.stringify(value), now(), operationId);
        return value;
      } catch (error) {
        // A denied action is final for this identity; a transport loss after
        // dispatch is unknown and cannot be turned into an implicit retry.
        this.db.prepare('UPDATE local_tool_operations SET status=?,updated_at=? WHERE id=?').run(dispatched ? 'unknown' : 'rejected', now(), operationId);
        throw error;
      } finally {
        this.active.delete(operationId);
        try { this.app.logEvents?.write('info', 'local.tool.finished', { component: 'integrations', operationId, stage: kind, success: this.db.prepare('SELECT status FROM local_tool_operations WHERE id=?').get(operationId)?.status === 'complete' }); } catch {}
      }
    });
    this.active.set(operationId, promise); return promise;
  }
  async approve(context, description) {
    if (typeof context.approve !== 'function' || await context.approve(description) !== true) fail('此操作未获得本次人工批准。', 403, 'LOCAL_TOOL_APPROVAL_REQUIRED');
  }
  async mcp(input, scope, context = {}) {
    args(input, ['server', 'tool', 'arguments', 'expectedRevision', 'operationId']);
    if (!id(input.server) || !id(input.tool) || !plain(input.arguments) || Buffer.byteLength(JSON.stringify(input.arguments)) > 65536) fail('MCP 调用参数无效。', 400, 'LOCAL_TOOL_ARGUMENTS');
    if (scope?.permissions?.mcpTools !== true) fail('请由用户在设置中开启 MCP 工具权限。', 403, 'LOCAL_TOOL_PERMISSION');
    return this.perform('mcp', input, scope, context, async (sessionId, dispatch) => {
      const catalog = await this.inspect(scope, { server: input.server }, context);
      if (input.expectedRevision !== catalog.revision) fail('MCP 连接或工具版本已变化，请重新读取目录。', 409, 'LOCAL_TOOL_CONFLICT');
      const server = catalog.servers.find(row => row.id === input.server), tool = server?.tools?.find(row => row.name === input.tool);
      if (!tool || server.enabled !== true || server.status === 'blocked') fail('MCP 工具尚未就绪。');
      if ((scope.readOnly || context.readOnlyExternal) && tool.readOnly !== true) fail('只读诊断或咨询不能调用写入或执行类 MCP 工具。', 403, 'LOCAL_TOOL_PERMISSION');
      await this.paths(input.arguments, scope);
      if (tool.readOnly !== true) await this.approve(context, { kind: 'mcp', title: `允许 MCP ${input.server} · ${input.tool} 执行一次`, details: { server: input.server, tool: input.tool, arguments: input.arguments } });
      await dispatch();
      return this.app.adapter.request('workbench.local-tools.mcp', { server: input.server, tool: input.tool, arguments: input.arguments,
        expected_revision: catalog.revision, application_port: this.app.config.port,
        scope: { session_id: sessionId, working_folder: scope.workingFolder, read_only: scope.readOnly === true || context.readOnlyExternal === true }, operation_id: input.operationId }, null);
    });
  }
  async desktop(input, scope, context = {}) {
    args(input, ['action', 'app', 'mode', 'captureId', 'element', 'coordinate', 'text', 'keys', 'direction', 'amount', 'value', 'operationId']);
    if (!desktopActions.has(input.action)) fail('桌面操作类型无效。', 400, 'LOCAL_TOOL_ARGUMENTS');
    const readOnly = observation.has(input.action);
    if (input.action !== 'status' && (readOnly ? scope?.permissions?.capture !== true : scope?.permissions?.desktopControl !== true || scope?.readOnly || context.readOnlyExternal)) fail('当前助手未获准执行此桌面操作。', 403, 'LOCAL_TOOL_PERMISSION');
    const policy = this.readPolicy() || {}, allowedApps = policy.desktopApps;
    if (!Array.isArray(allowedApps) || allowedApps.length > 32 || allowedApps.some(value => !id(value))) fail('桌面应用白名单无效。', 409, 'LOCAL_TOOL_PERMISSION');
    if (input.action !== 'status' && (!id(input.app) || !allowedApps.includes(input.app))) fail('请由用户在设置中批准目标桌面应用。', 403, 'LOCAL_TOOL_PERMISSION');
    const request = { ...input, operationId: input.operationId || (readOnly ? randomUUID() : undefined) };
    return this.perform('desktop', request, scope, context, async (sessionId, dispatch) => {
      if (!readOnly) await this.approve(context, { kind: 'desktop', title: `允许 ${input.app} · ${input.action} 一次`, details: input });
      await dispatch();
      return this.app.adapter.request('workbench.local-tools.desktop', { ...request, capture_id: input.captureId,
        scope: { session_id: sessionId, working_folder: scope.workingFolder, read_only: scope.readOnly === true || context.readOnlyExternal === true,
          allowed_apps: allowedApps }, application_port: this.app.config.port }, null);
    });
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.active.values()]);
    if (this.app.adapter?.state === 'ready') {
      try { await this.app.adapter.request('workbench.local-tools.close', {}, 10000); }
      catch { try { this.app.logEvents?.write('warn', 'local.tool.close.unconfirmed', { component: 'integrations', stage: 'shutdown' }); } catch {} }
    }
  }
}
