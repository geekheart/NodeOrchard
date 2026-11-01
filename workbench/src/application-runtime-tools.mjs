import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { validateDiagnosticArguments } from './assistant-diagnostic-turn.mjs';
import { mkdir, mkdtemp, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';

const text = { type: 'string', maxLength: 160 };
const schema = (name, description, properties, required = [], effect = 'read-only') => ({ name, description, effect, availability: 'available', readOnly: effect === 'read-only',
  annotations: { readOnlyHint: effect === 'read-only', destructiveHint: effect === 'mutation', idempotentHint: effect === 'read-only', openWorldHint: true },
  inputSchema: { type: 'object', properties, required, additionalProperties: false } });
export const APPLICATION_RUNTIME_TOOLS = Object.freeze([
  schema('mcp.servers', '读取Hermes已人工配置MCP的真实工具、参数、就绪状态和revision，包含本机和私网；不返回凭据、连接命令或任意URL。', { server: text, refresh: { type: 'boolean' } }),
  schema('mcp.call', '调用已登记MCP工具；先用mcp.servers读取准确名称、参数及expectedRevision。参数文件限定当前工作文件夹，写入或执行类调用在聊天中逐次人工确认。', {
    server: text, tool: text, arguments: { type: 'object' }, expectedRevision: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' }, operationId: text,
  }, ['server', 'tool', 'arguments', 'expectedRevision', 'operationId'], 'mutation'),
  schema('desktop.status', '读取本机桌面驱动与系统屏幕录制、辅助功能授权状态，及人工允许的应用；不截取屏幕、不改变权限。', {}),
  schema('desktop.call', '操作人工允许的应用：先capture获取当前窗口图像、元素和captureId，再引用该captureId执行点击/输入等动作。系统授权与应用白名单由用户设置；每次修改动作需要确认，过期画面必须重新截图。', {
    action: { enum: ['capture', 'list_apps', 'list_windows', 'click', 'double_click', 'right_click', 'scroll', 'type', 'key', 'set_value'] }, app: text,
    mode: { enum: ['som', 'ax', 'vision'] }, captureId: text, element: { type: 'integer', minimum: 0 },
    coordinate: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'integer', minimum: 0, maximum: 32768 } }, text: { type: 'string', maxLength: 4000 },
    keys: text, direction: { enum: ['up', 'down', 'left', 'right'] }, amount: { type: 'integer', minimum: 1, maximum: 20 }, value: { type: 'string', maxLength: 1000 }, operationId: text,
  }, ['action', 'app', 'operationId'], 'mutation'),
]);
const fail = message => Object.assign(new Error(message), { httpStatus: 403 });
const same = (left, right) => typeof left === 'string' && typeof right === 'string' && left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));

// One dispatcher serves both chat roles and the native tools inside a running
// workflow. The model never supplies its role, directory, run or human grant.
export class ApplicationRuntimeTools {
  constructor(app) { this.app = app; this.attempts = new Map(); this.inflight = new Set(); this.closed = false; }
  handles(name) { return APPLICATION_RUNTIME_TOOLS.some(tool => tool.name === name); }
  context(scope, context) {
    const conversationId = context.sourceConversationId || context.conversationId || scope.workflowId;
    const turnId = context.diagnosticTurnId || context.turnId;
    const authorize = async () => {
      if (this.closed || context.signal?.aborted) throw fail('外部工具调用已停止。');
      await this.app.applicationAssistant.permissions.current(scope);
      if (scope.role === 'supervisor') { if (!context.inspectOnly) this.app.applicationAssistant.lifecycle.assertWritable(conversationId); }
      else this.app.workflowLibrary.assertRunnable(scope.workflowId);
      await context.authorize?.();
    };
    return { ...context, conversationId, turnId, authorize,
      approve: details => this.app.toolApprovals.request(details, { conversationId, turnId, runId: context.runId, signal: context.signal, authorize }) };
  }
  async call(name, args, context) {
    const definition = APPLICATION_RUNTIME_TOOLS.find(tool => tool.name === name); if (!definition) throw fail('外部工具不存在。');
    validateDiagnosticArguments(args, definition.inputSchema);
    const scope = context.permissionScope, bound = this.context(scope, { ...context, inspectOnly: name === 'mcp.servers' || name === 'desktop.status' });
    if (name === 'mcp.servers' || name === 'desktop.status') {
      const status = await this.app.localTools.inspect(scope, name === 'mcp.servers' ? { ...args, refresh: args.refresh ?? true } : {}, bound);
      return name === 'desktop.status' ? { desktop: status.desktop, permissions: status.permissions } : status;
    }
    if (name === 'mcp.call') return this.app.localTools.mcp(args, scope, bound);
    return this.app.localTools.desktop(args, scope, bound);
  }
  async stageImages(result) {
    const raw = result?._nodeorchard_images;
    if (!Array.isArray(raw) || !raw.length || raw.length > 4) throw fail('外部工具图像回执无效。');
    let total = 0;
    const images = raw.map(image => {
      if (typeof image?.data !== 'string' || image.data.length > 12 * 1024 * 1024) throw fail('外部工具图像过大。');
      const bytes = Buffer.from(image.data, 'base64');
      const mime = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
        : bytes.subarray(0, 3).equals(Buffer.from([255,216,255])) ? 'image/jpeg'
          : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP' ? 'image/webp'
            : ['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString()) ? 'image/gif' : null;
      total += bytes.length;
      if (bytes.toString('base64') !== image.data || image.mimeType !== mime || !mime || bytes.length > 8 * 1024 * 1024 || total > 16 * 1024 * 1024) throw fail('外部工具图像内容或大小未通过校验。');
      return { bytes, extension: mime.split('/')[1] };
    });
    const root = join(this.app.config.dataDir, 'diagnostics'); await mkdir(root, { recursive: true, mode: 0o700 });
    if ((await lstat(root)).isSymbolicLink()) throw fail('外部工具图像目录无效。');
    const directory = await mkdtemp(join(root, 'local-tool-'));
    const paths = [];
    for (const [index, image] of images.entries()) { const path = join(directory, index + '.' + image.extension); await writeFile(path, image.bytes, { flag: 'wx', mode: 0o600 }); paths.push(path); }
    return paths;
  }
  async bindAttempt({ session, runId, nodeId, snapshotId, capabilities }) {
    const run = this.app.workflows.get(runId), workflowId = run.workflowId;
    const permissionScope = await this.app.applicationAssistant.permissions.bind({ role: 'workflow', workflowId, document: run.document });
    if (capabilities?.requiredToolsets.some(name => name.startsWith('mcp-')) && !permissionScope.permissions.mcpTools) throw fail('请在设置中允许工作流调用 MCP 工具。');
    if (capabilities?.requiredToolsets.includes('computer_use') && (!permissionScope.permissions.desktopControl || !permissionScope.permissions.capture)) throw fail('请在设置中允许工作流桌面操作及截图。');
    const key = session.runtimeSessionId + ':' + snapshotId;
    if (this.attempts.has(key)) throw fail('工作流工具尝试身份已经绑定。');
    const token = randomUUID(), controller = new AbortController();
    const row = { sessionId: session.id, runtimeId: session.runtimeSessionId, runId, workflowId, nodeId, snapshotId, token, permissionScope, controller, capabilities };
    this.attempts.set(key, row);
    return { token, release: () => { if (this.attempts.get(key) === row) this.attempts.delete(key); controller.abort(); } };
  }
  handle(frame) {
    const pending = this.dispatchFrame(frame); this.inflight.add(pending); void pending.finally(() => this.inflight.delete(pending)); return pending;
  }
  async dispatchFrame(frame) {
    const params = frame.params || {}, row = this.attempts.get(params.session_id + ':' + params.attempt_id);
    const reply = (result, error) => { try { this.app.adapter.send({ jsonrpc: '2.0', id: frame.id, ...(error ? { error: { code: -32003, message: error.message } } : { result }) }); this.app.adapter.serverRequests.delete(String(frame.id)); } catch {} };
    try {
      if (Object.keys(params).some(key => !['session_id', 'attempt_id', 'capability_token', 'tool', 'arguments', 'call_id'].includes(key))
        || typeof params.call_id !== 'string' || !params.call_id || params.call_id.length > 256 || !params.arguments || typeof params.arguments !== 'object' || Array.isArray(params.arguments)
        || typeof params.tool !== 'string' || !(params.tool === 'computer_use' || params.tool.startsWith('mcp__'))) throw fail('工作流工具回调格式无效。');
      if (!row || !same(params.capability_token, row.token) || row.controller.signal.aborted) throw fail('本机工具请求不属于当前工作流尝试。');
      if (row.capabilities && !row.capabilities.toolNames.includes(params.tool)) throw fail('此工具未包含在本次工作流的固定能力中。');
      const authorize = async () => {
        if (row.controller.signal.aborted || this.attempts.get(params.session_id + ':' + params.attempt_id) !== row) throw fail('工作流尝试已结束。');
        const current = this.app.workflows.get(row.runId), node = row.nodeId ? current.nodes?.[row.nodeId] : null;
        if (!['running', 'preparing', 'waiting'].includes(current.status) || row.nodeId && (!node || node.attemptId && node.attemptId !== row.snapshotId || !['running', 'preparing', 'waiting'].includes(node.status))) throw fail('工作流运行或节点尝试已变化。');
        await this.app.applicationAssistant.permissions.current(row.permissionScope);
      };
      await authorize();
      const context = this.context(row.permissionScope, { conversationId: row.workflowId, runId: row.runId, attemptId: row.snapshotId, signal: row.controller.signal, authorize });
      const operationId = 'workflow-tool-' + createHash('sha256').update(JSON.stringify([row.runId, row.snapshotId, params.call_id, params.tool, params.arguments])).digest('hex');
      let result;
      if (params.tool === 'computer_use') {
        result = await this.app.localTools.desktop({ ...params.arguments, operationId }, row.permissionScope, context);
      } else {
        const catalog = await this.app.localTools.inspect(row.permissionScope, { refresh: true }, context);
        const matches = catalog.servers.flatMap(server => server.tools.filter(tool => tool.name === params.tool).map(tool => ({ server: server.id, tool: tool.name })));
        if (matches.length !== 1) throw fail('MCP工具名称未唯一登记。');
        result = await this.app.localTools.mcp({ ...matches[0], arguments: params.arguments, expectedRevision: catalog.revision, operationId }, row.permissionScope, context);
      }
      await authorize(); reply(result);
    } catch (error) { reply(null, error); }
  }
  async close() { this.closed = true; for (const row of this.attempts.values()) row.controller.abort(); this.attempts.clear(); await Promise.allSettled([...this.inflight]); }
}
