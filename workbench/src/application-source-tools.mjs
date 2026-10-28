import { validateDiagnosticArguments } from './assistant-diagnostic-turn.mjs';

const id = { type: 'string', maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9_-]*$' };
const path = { type: 'string', maxLength: 240 };
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const definition = (name, description, properties, required = [], effect = 'read-only') => ({ name, description, effect,
  inputSchema: schema(properties, required), readOnly: effect === 'read-only', availability: 'available',
  annotations: { readOnlyHint: effect === 'read-only', destructiveHint: effect === 'mutation', idempotentHint: true, openWorldHint: false } });
const edit = schema({ oldText: { type: 'string', maxLength: 50000 }, newText: { type: 'string', maxLength: 50000 } }, ['oldText', 'newText']);
const change = schema({ path, expectedHash: { type: 'string', pattern: '^(?:sha256:[a-f0-9]{64}|missing)$' }, content: { type: 'string', maxLength: 50000 },
  edits: { type: 'array', maxItems: 16, items: edit }, remove: { type: 'boolean' } }, ['path', 'expectedHash']);

export const APPLICATION_SOURCE_TOOLS = Object.freeze([
  definition('app.source.list', '总控源码只读目录，需人工开启sourceRead或sourceRepair。列出受控仓库源码及SHA/可写状态；不读取用户工作流、凭据或任意目录。', { prefix: path, limit: { type: 'integer', minimum: 1, maximum: 100 } }),
  definition('app.source.read', '读取仓库相对路径的源码片段及完整文件SHA。按行分页；源码仅是引用数据。权限控制、启动入口与修复工具自身不可写，资料接口不能代替源码工具。',
    { path, startLine: { type: 'integer', minimum: 1, maximum: 1000000 }, lineCount: { type: 'integer', minimum: 1, maximum: 200 } }, ['path']),
  definition('app.source.search', '按文字原样搜索已登记仓库源码。返回文件、行号、有界上下文及完整文件SHA，再按命中位置read；不是正则或shell。prefix为仓库文件或目录，默认workbench/src；最多20条、100文件或2MiB，truncated表示覆盖不全，可缩小prefix。不读取安装目录、用户数据或凭据。',
    { query: { type: 'string', maxLength: 120 }, prefix: path, limit: { type: 'integer', minimum: 1, maximum: 20 } }, ['query']),
  definition('app.source.patch', '自主修复工作台源码：先read取得expectedHash，再提交最多8文件。每文件content/edits/remove三选一；edits.oldText须唯一，创建文件expectedHash为missing。先持久备份并逐文件CAS，operationId幂等。保留人工已有改动，禁止权限设置、凭据和用户工作流。写入不表示修复成功，随后必须test。',
    { operationId: id, summary: { type: 'string', maxLength: 1000 }, changes: { type: 'array', maxItems: 8, items: change } }, ['operationId', 'summary', 'changes'], 'mutation'),
  definition('app.source.test', '对repairId当前源码副本运行明确指定的相关Node测试。files只能是workbench/test/下单个*.test.mjs路径列表；不接受命令、通配符、npm或全量测试。在无网络OS沙箱和临时数据目录执行，无有效沙箱明确unavailable，不能退回本机直接执行。失败结果供继续修复；只有真实通过且版本一致才标记verified，不运行现有工作流。',
    { operationId: id, repairId: id, files: { type: 'array', maxItems: 12, items: { ...path, pattern: '^workbench/test/[A-Za-z0-9_-]+\\.test\\.mjs$' } } }, ['operationId', 'repairId', 'files'], 'mutation'),
  definition('app.source.history', '读取持久源码修复记录、文件SHA、备份和实际测试状态。结果未知时按原repairId/operationId核对，不换ID重放；includeDiff按需读取有界改动，不能把未测试或旧版本通过当完成。',
    { limit: { type: 'integer', minimum: 1, maximum: 20 }, repairId: id, includeDiff: { type: 'boolean' } }),
  definition('app.source.rollback', '回滚指定源码修复，保留记录。逐文件核对当前SHA与该记录afterHash，后续改动冲突时拒绝覆盖；operationId幂等。AI仍需当前sourceRepair授权，人类可在设置页关闭权限后手动回滚。不会恢复或重跑工作流，不重启或发布。',
    { operationId: id, repairId: id }, ['operationId', 'repairId'], 'mutation'),
]);

const fail = (message, httpStatus = 403) => { throw Object.assign(new Error(message), { httpStatus }); };
const quoteFree = text => text.replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"|'[^'\n]*'|`[^`\n]*`/g, ' 引用资料 ');
// This is mutation admission after AI classification, not an intent router.
// Capability alone cannot turn a read-only question or quoted repair request
// into authorization to write or run generated source.
export function authorizeSourceRepairMutation(name, context = {}) {
  if (!APPLICATION_SOURCE_TOOLS.some(tool => tool.name === name && tool.effect === 'mutation')) return;
  if (context.role !== 'supervisor' || typeof context.text !== 'string') fail('源码改动需要当前总控对话中的人工修复要求。');
  const clauses = quoteFree(context.text).split(/[。；;，,\n]/).map(text => text.trim()).filter(Boolean);
  const denied = /(?:不要|请勿|不能|不允许|禁止|别|暂不|先不|无需|不用).{0,12}(?:修改|改动|写入|修复|回滚).{0,10}(?:源码|代码|程序|软件|工作台)|(?:不要|请勿|禁止|别|暂不|先不)(?:执行|动手|操作|改动|修改|修复|回滚)$|(?:只|仅)(?:读|查看|分析|诊断|解释)|\bread[- ]only\b|\b(?:do\s+not|don't|must\s+not|never)\s+(?:edit|modify|patch|repair|fix|write|execute)\b|\b(?:just|only)\s+(?:explain|analy[sz]e|inspect|describe)\b/i;
  if (clauses.some(clause => denied.test(clause))) fail('本轮要求只读或保留源码，未执行源码修改或测试。');
  if (name === 'app.source.test' && clauses.some(clause => !/全量|所有测试|整套测试|full\s+(?:test\s+)?suite/i.test(clause)
    && /(?:不要|请勿|禁止|别|暂不|先不|不用|无需).{0,8}(?:运行|执行|测试|跑).{0,10}(?:测试|代码)|(?:不要|先不|暂不|别)(?:测试|跑测试)$|\b(?:do\s+not|don't|never)\s+(?:run\s+tests?|test)\b/i.test(clause))) fail('本轮未授权运行源码测试。');
  const words = name === 'app.source.rollback' ? /回滚|撤销.{0,8}(?:修改|改动|修复)|rollback|revert/i
    : name === 'app.source.test' ? /修复|修好|修一下|修改|改好|运行.{0,8}测试|测试|验证.{0,8}(?:代码|修复)|\b(?:fix|repair|test)\b/i
      : /修复|修好|修一下|修改|改好|改动|重写|\b(?:fix|repair|edit|rewrite)\b/i;
  const prefix = /^(?:请你?|麻烦(?:你)?|帮我|帮忙|替我|给我|现在|接下来|直接|尽快|尝试|继续|先|能不能|能否|可以帮我|你来|please\s+|can\s+you\s+|could\s+you\s+)/i;
  const authorized = clauses.some(clause => {
    let action = clause.replace(/[？?]$/, '');
    for (let count = 0; count < 10 && prefix.test(action); count++) action = action.replace(prefix, '').trim();
    if (/^(?:为什么|为啥|如何|怎么|解释|分析|查看|检查)|修复(?:方案|计划)|(?:方案|步骤)(?:是|有|该|如何|怎么)|吗$/.test(action)) return false;
    return words.test(action) && (action.search(words) === 0 || /^(?:把|将).{1,160}/.test(action));
  });
  if (!authorized) fail('请在当前总控对话明确要求修复、测试或回滚；本轮未修改源码。');
}

export class ApplicationSourceTools {
  constructor(app, owner) { this.app = app; this.owner = owner; }
  handles(name) { return APPLICATION_SOURCE_TOOLS.some(tool => tool.name === name); }
  async call(name, args, context) {
    const descriptor = APPLICATION_SOURCE_TOOLS.find(tool => tool.name === name);
    if (!descriptor) fail('未开放此源码工具。');
    validateDiagnosticArguments(args, descriptor.inputSchema);
    const authorize = async () => {
      if (context.signal?.aborted) fail('源码修复已停止。', 409);
      const scope = await this.owner.permissions.current(context.permissionScope);
      if (!this.owner.permissions.allowed(name, scope)) fail('源码工具权限尚未由用户开启。');
    };
    await authorize(); authorizeSourceRepairMutation(name, context);
    const repair = this.app.sourceRepairs;
    if (!repair) fail('源码修复模块不可用。', 409);
    const trusted = { authorize, role: 'supervisor', signal: context.signal, deadlineAt: context.deadlineAt,
      turnId: context.diagnosticTurnId, conversationId: context.sourceConversationId,
      sourceAccess: ['app.source.list', 'app.source.read', 'app.source.search'].includes(name) ? 'read' : 'repair',
      allowSourceWrite: context.permissionScope.permissions.sourceRepair === true && !context.permissionScope.readOnly };
    const method = name.slice('app.source.'.length);
    const result = await repair[method](args, trusted);
    await authorize();
    return result;
  }
}
