// Browser-safe metadata and validation shared by the planner and local executor.
import { CODE_LANGUAGES, TOOL_EXECUTION_MODES } from './workflow-model.mjs';
export const WORKFLOW_TOOLS = Object.freeze([
  { id: 'text.trim', label: '去除首尾空白', description: '去掉文本两端的空白字符。', inputType: 'text', outputType: 'text' },
  { id: 'text.uppercase', label: '转换大写', description: '将文本转换为大写。', inputType: 'text', outputType: 'text' },
  { id: 'json.parse', label: '解析 JSON', description: '将 JSON 文本解析为真实数据。', inputType: 'text', outputType: 'any' },
  { id: 'json.stringify', label: '生成 JSON 文本', description: '将数据编码为 JSON 文本。', inputType: 'any', outputType: 'text' },
  { id: 'json.keys', label: '读取对象字段', description: '返回对象自身的字段名数组。', inputType: 'object', outputType: 'array' },
].map(row => Object.freeze(row)));

const TYPES = new Set(['any', 'text', 'number', 'boolean', 'object', 'array']);
const TOOL_BY_ID = new Map(WORKFLOW_TOOLS.map(tool => [tool.id, tool]));

export function validateWorkflowToolConfig(node) {
  if (node?.type !== 'tool' || !node.config || typeof node.config !== 'object' || Array.isArray(node.config)) {
    throw new Error('工具执行器需要工具与代码节点配置。');
  }
  const config = node.config;
  const mode = config.executionMode;
  if (!TOOL_EXECUTION_MODES.includes(mode)) throw new Error('请选择代码或工具执行模式。');
  for (const key of ['inputType', 'outputType']) {
    if (config[key] !== undefined && !TYPES.has(config[key])) throw new Error('工具与代码节点仅支持文本和 JSON 数据端口。');
  }
  if (config.timeoutSeconds !== undefined && (!Number.isInteger(config.timeoutSeconds)
    || config.timeoutSeconds < 1 || config.timeoutSeconds > 86400)) {
    throw new Error('执行超时必须是 1–86400 秒的整数。');
  }
  if (mode === 'code') {
    if (!CODE_LANGUAGES.includes(config.language)) throw new Error('代码语言仅支持 JavaScript 或 Python。');
    if (typeof config.code !== 'string' || !config.code.trim() || config.code.length > 100000 || config.code.includes('\0')) {
      throw new Error('请输入非空代码函数体，最多 100000 个字符，且不能包含空字符。');
    }
    return { kind: 'code', language: config.language };
  }
  const tool = TOOL_BY_ID.get(config.toolName);
  if (!tool) throw new Error(`所需工具未安装或已移除：${config.toolName || '未指定'}。请通过已配置的 Skill 或代码节点接入外部能力。`);
  const inputType = config.inputType ?? tool.inputType;
  const outputType = config.outputType ?? tool.outputType;
  if (tool.inputType !== 'any' && inputType !== 'any' && inputType !== tool.inputType) {
    throw new Error(`此工具的输入端口需要 ${tool.inputType} 或 any。`);
  }
  if (tool.outputType !== 'any' && outputType !== 'any' && outputType !== tool.outputType) {
    throw new Error(`此工具的输出端口需要 ${tool.outputType} 或 any。`);
  }
  return { kind: 'tool', toolName: tool.id };
}
