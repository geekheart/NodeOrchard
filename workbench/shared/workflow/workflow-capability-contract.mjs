import { NODE_TYPES, createNode, getPorts, nodeConfigurationContract, CODE_LANGUAGES } from './workflow-model.mjs';
import { WORKFLOW_TOOLS } from './workflow-tools.mjs';
import { WORKFLOW_CONVERSATION_MAX_OPERATIONS } from './workflow-conversation-commands.mjs';

const conversationExcluded = new Set(['document', 'trigger', 'schedule', 'timezone']);
export const WORKFLOW_EDIT_OPERATIONS = Object.freeze(['add-node', 'update-node', 'connect', 'remove-edge', 'remove-node', 'set-title']);

export function codeRuntimeContract(schemaVersion = 2) {
  if (![1, 2].includes(schemaVersion)) throw new Error('仅支持 schemaVersion 1 或 2。');
  return { languages: [...CODE_LANGUAGES], mode: 'code', registrationRequired: false,
    input: { name: 'input', format: 'JSON', maxBytes: 65536 }, output: { statement: 'return', format: 'JSON', maxBytes: 65536 },
    python: { sourceFormat: 'function-body', wrapper: 'def main(input, context=None):', contextType: 'dict',
      objectAccess: { required: "value['key']", optional: "value.get('key')" },
      inputRule: 'input 按 JSON 解码：对象为普通 dict，数组为 list；先检查输入形状，对象字段用 input[\'key\'] 或 input.get(\'key\')，不支持 input.key。context 也是普通 dict，字段不能按属性访问。',
      example: "if not isinstance(input, dict):\n    raise ValueError('输入必须是对象')\nreturn {'data': input}" },
    javascript: { sourceFormat: 'async-function-body', parameters: ['input', 'context'], contextType: 'object', example: 'return { data: input };' },
    context: schemaVersion === 2 ? ['runId', 'workflowId', 'nodeId', 'attemptId', 'attempt', 'outputDirectory', 'runOutputDirectory', 'workspaceRoot', 'reviewFeedback'] : ['runId', 'workflowId', 'nodeId'],
    files: schemaVersion === 2 ? { supported: true, directory: { javascript: 'context.outputDirectory', python: "context['outputDirectory']" },
      outputExamples: [{ path: '<本次输出目录中的真实绝对路径>' }, { files: [{ path: '<本次输出目录中的真实绝对路径>' }] }],
      registration: 'DAG 从 path/files/artifacts 或文件输出端口登记真实文件并校验哈希。',
      ports: 'schema2 可显式声明 fileRef 输出端口；代码 config.outputType 使用 object/any，直接工具校验仅接收 JSON 类型。',
      fileName: 'output.config.fileName 不能将 JSON 转成真正的 XLSX；必须先实际生成工作簿。' } : { supported: false, reason: 'schema1 仅提供 JSON 返回契约；生成文件请使用 schema2。' },
    failures: { python: 'raise ValueError(message)', javascript: 'throw new Error(message)',
      returnedErrorObject: '仅 return {error:...} 仍是正常 JSON 输出；需要异常或明确业务校验阻止下游。' },
    dependencies: { inspectTool: 'runtime.inspect', rule: '按真实代码解释器检查模块；Hermes 的可用工具或另一Python环境不证明代码节点能导入库。' },
    policy: { subprocessIsOsSandbox: false, mayGenerateBusinessCodeCandidate: true, mayModifyApplicationSource: false,
      automaticExecutionAvailable: false, candidateRequiresExplicitApply: true } };
}

export function workflowNodeContract(type, { schemaVersion = 2 } = {}) {
  const metadata = NODE_TYPES.find(row => row.type === type);
  if (!metadata) throw new Error('未知的基础节点类型。');
  const configuration = nodeConfigurationContract(type, { schemaVersion });
  const defaults = Object.fromEntries(Object.entries(configuration.defaults).filter(([key]) => !conversationExcluded.has(key)));
  const config = { ...configuration, defaults,
    allowedConfigKeys: configuration.allowedConfigKeys.filter(key => !conversationExcluded.has(key)),
    excludedConversationKeys: [...conversationExcluded] };
  const node = createNode(type);
  return { ...metadata, ...config, ports: getPorts(node),
    ...(type === 'tool' ? { modes: [
      { mode: 'code', registrationRequired: false, languages: [...CODE_LANGUAGES], description: '编写业务 Python/JavaScript 函数体，无需先注册一个固定工具。' },
      { mode: 'tool', registrationRequired: true, description: '通过 toolName 选择已注册的固定工作台工具。' },
    ], runtime: codeRuntimeContract(schemaVersion) } : {}),
    ...(type === 'transform' ? { runtime: codeRuntimeContract(schemaVersion) } : {}),
    ...(type === 'output' ? { note: '负责保存和交付已产生的文件；文件名后缀不执行格式转换。' } : {}),
    ...(type === 'skill' ? { note: '需要真实 skillRef 与固定内容版本；requiredToolsets 可声明 image_gen、browser、computer_use 或已配置的 mcp-* 工具集，只检查并绑定人工配置的能力，不授予权限。图片从原生工具真实文件归集，必须经人工审核；创建 Skill 与图片提供商选择是人工界面入口。仅在工具调用与业务输出确认后视为成功。',
      integrations: { inspectTool: 'workbench.inspect', section: 'integrations', declarationGrantsPermission: false, imageReviewRequired: true } } : {}) };
}

export function workflowEditContract() {
  return { operations: [...WORKFLOW_EDIT_OPERATIONS], maxOperations: WORKFLOW_CONVERSATION_MAX_OPERATIONS,
    updateNodeFields: ['nodeId', 'title', 'config', 'ports', 'x', 'y'], canChangeNodeTypeInPlace: false,
    replacement: { preservesNodeId: false, rebuildTarget: '保留原位置与等效上下游连线；这是提案目标，必须通过编辑器校验，不是已提供的原位换型操作。',
      recipe: ['记录旧节点位置和上下游端口。', '添加目标类型节点，填写真实代码/配置及兼容端口。', '移除旧连线并将原上下游连接到新节点。', '移除旧节点，整批通过编辑器校验后提供候选。'],
      note: '用户要求替换 Skill 为 Python 时应替换生产能力，不能只加前置校验就声称完成。' },
    stages: ['生成候选', '用户在同一聊天应用', '运行前检查', '实际运行与产物验收'],
    preflightIsExecution: false, versionGuard: 'baseFingerprint 与保存版本防止覆盖已变化的草稿；不改写历史运行。' };
}

export function workflowCapabilityManifest({ schemaVersion = 2, section = 'overview' } = {}) {
  if (![1, 2].includes(schemaVersion)) throw new Error('仅支持 schemaVersion 1 或 2。');
  if (!['overview', 'nodes', 'operations', 'runtime', 'tools'].includes(section)) throw new Error('能力目录分区无效。');
  if (section === 'nodes') return { schemaVersion, nodes: NODE_TYPES.map(({ type }) => workflowNodeContract(type, { schemaVersion })) };
  if (section === 'operations') return { schemaVersion, editing: workflowEditContract() };
  if (section === 'runtime') return { schemaVersion, runtime: codeRuntimeContract(schemaVersion) };
  if (section === 'tools') return { schemaVersion, tools: WORKFLOW_TOOLS.map(({ id, label, description, inputType, outputType, ports, reviewRequired }) => ({
    id, label, description, inputType, outputType, ...(ports ? { ports } : {}), reviewRequired: !!reviewRequired })) };
  return { schemaVersion, nodeTypes: NODE_TYPES.map(({ type, label, description }) => ({ type, label, description })),
    code: { languages: [...CODE_LANGUAGES], registrationRequired: false, supportsFileOutputs: schemaVersion === 2, inspectTool: 'node.describe', runtimeProbe: 'runtime.inspect' },
    editing: { operations: [...WORKFLOW_EDIT_OPERATIONS], canReplaceByReconnect: true, canChangeNodeTypeInPlace: false },
    limits: { sourceWritesAllowed: false, automaticCodeExecutionAvailable: false, businessCodeCandidatesAllowed: true } };
}
