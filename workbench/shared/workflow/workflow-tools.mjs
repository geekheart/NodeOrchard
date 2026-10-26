// Browser-safe metadata and validation shared by the planner and local executor.
const capability = (domain, [id,label,resource,timeoutSeconds,inputs,projection,reviewRequired=false]) => ({
  id:`hdk.${domain}.${id}`, label, description:label+'；当前运行独立保存来源、产物和核验回执。',
  inputType:'object',outputType:'object',resource,reviewRequired,
  defaultConfig:{resource,timeoutSeconds,reviewImages:reviewRequired},
  ports:{inputs:inputs.map(([id,label,required=true])=>({id,label,type:'object',required})),
    outputs:[{id:'out',label:'成果回执',type:'object'},...(projection?[{id:projection[0],label:projection[1],type:'object',valuePath:projection[2]}]:[])]},
});
export const WORKFLOW_TOOLS = Object.freeze([
  { id: 'text.trim', label: '去除首尾空白', description: '去掉文本两端的空白字符。', inputType: 'text', outputType: 'text' },
  { id: 'text.uppercase', label: '转换大写', description: '将文本转换为大写。', inputType: 'text', outputType: 'text' },
  { id: 'json.parse', label: '解析 JSON', description: '将 JSON 文本解析为真实数据。', inputType: 'text', outputType: 'any' },
  { id: 'json.stringify', label: '生成 JSON 文本', description: '将数据编码为 JSON 文本。', inputType: 'any', outputType: 'text' },
  { id: 'json.keys', label: '读取对象字段', description: '返回对象自身的字段名数组。', inputType: 'object', outputType: 'array' },
  ...[
    ['prepare', '核验板卡资料', '核验 epro2、正反面实拍照片与已审核校准，自动计算来源哈希。', 'default', 180],
    ['native', '导出 SCH 与 STEP', '通过本机 EDA 从当前工程原生导出，不改动源工程。', 'eda', 600],
    ['cad', 'STEP 转 CAD', '使用 OpenStep2DWG 转换并独立验证 CAD 几何。', 'browser', 1800],
    ['pin-facts', '提取 Pinout 事实', '核对实际针号、网络与照片孔位，输出 Skill 规划输入。', 'default', 180],
    ['pinout-front', '生成正面 Pinout', '按 Skill 计划在正面实拍图上出图；必须经过人工审核。', 'browser', 600],
    ['pinout-back', '生成背面 Pinout', '按 Skill 计划在背面实拍图上出图；必须经过人工审核。', 'browser', 600],
    ['verify', '汇总四文件与验收', '接收原生、CAD、已审核正反面成果，检查并保存交付文件。', 'default', 180],
  ].map(([id,label,description,resource,timeoutSeconds])=>({id:'hdk.four.'+id,label,description,inputType:'object',outputType:'object',resource,
    reviewRequired:id.startsWith('pinout-'),
    defaultConfig:{resource,timeoutSeconds,reviewImages:id.startsWith('pinout-')},
    ports:{inputs:id.startsWith('pinout-')?[{id:'facts',label:'针脚与照片事实',type:'object',required:true},{id:'plan',label:'Skill 排版计划',type:'object',required:true}]
      :id==='verify'?[{id:'native',label:'原生 SCH / STEP',type:'object',required:true},{id:'cad',label:'CAD 成果',type:'object',required:true},{id:'images',label:'已审核正反面',type:'object',required:true}]
      :[{id:'in',label:id==='prepare'?'板卡资料':id==='cad'?'STEP 与原生证据':'上游成果',type:'object',required:true}],
      outputs:[{id:'out',label:id==='pin-facts'?'针脚事实':id==='prepare'?'已核验资料':'成果',type:'object'},...(id==='pin-facts'?[{id:'plan-input',label:'Skill 规划输入',type:'object',valuePath:'skillInput'}]:[])]}})),
  ...[
    ['prepare','核验使用指南资料','default',180,[['in','工程、照片与指南配置']]],
    ['import-four','导入已审核四文件','default',180,[['prepared','已核验指南资料']]],
    ['facts','提取指南事实与接口','default',180,[['prepared','已核验资料'],['engineering','已审核四文件']],['annotation-input','标注 Skill 输入','annotationInput']],
    ['drawio','DrawIO 功能框图','drawio',600,[['facts','指南事实']],null,true],
    ...[['front-zh','正面中文'],['front-en','正面英文'],['back-zh','背面中文'],['back-en','背面英文']].map(([id,label])=>['annotate-'+id,'OpenInterfaceMark · '+label,'browser',600,[['facts','指南事实'],['plan','标注 Skill 计划']],null,true]),
    ['author-input','准备已审图片与正文资料','default',180,[['facts','指南事实'],['images','已审核接口标注'],['diagram','已审核中英框图',false]],['skill-input','指南编写 Skill 输入','skillInput']],
    ['assemble','组装中英文指南与附件','default',300,[['author','已审正文资料'],['plan','指南 Skill 内容']]],
    ['verify','验收中英文指南','default',180,[['bundle','指南与附件']]],
    ['package','补齐指南附件并校验交付','default',900,[['in','已验收指南或回执路径']]],
  ].map(row=>capability('guide',row)),
  ...[
    ['prepare','核验 HDK 发布资料','default',180,[['in','原始工程与发布配置']]],
    ['export-plan-input','准备导出与命名资料','default',180,[['facts','板级事实']],['skill-input','导出与命名 Skill 输入','skillInput']],
    ['native','导出制造资料与命名','eda',1800,[['facts','板级事实'],['plan','导出与命名计划']],null,true],
    ['process-input','准备工艺要求资料','default',180,[['facts','板级事实']],['skill-input','工艺要求 Skill 输入','skillInput']],
    ['process','填写工艺要求与预览','default',600,[['facts','板级事实'],['plan','工艺 Skill 计划']],null,true],
    ['firmware-input','准备测试固件资料','default',180,[['facts','板级事实']],['skill-input','测试固件 Skill 输入','skillInput']],
    ['build-legacy','构建主芯片测试固件','build',3600,[['facts','板级事实'],['plan','固件 Skill 计划']]],
    ['build-v3','构建 P4 新版本固件','build',3600,[['facts','板级事实'],['plan','固件 Skill 计划']]],
    ['build-c61','构建 C61 配套固件','build',3600,[['facts','板级事实']]],
    ['firmware-aggregate','汇总固件与构建证据','default',300,[['facts','板级事实'],['legacy','主芯片构建'],['modern','P4 新版本构建'],['c61','C61 构建']]],
    ['sop-input','准备测试说明资料','default',180,[['facts','板级事实'],['firmware','已核验编译固件']],['skill-input','测试说明 Skill 输入','skillInput']],
    ['sop','生成测试说明与接线图','default',600,[['facts','板级事实'],['firmware','已核验编译固件'],['plan','测试说明 Skill 计划']],null,true],
    ['datasheets','整理重要器件手册','default',300,[['facts','板级事实']]],
    ['verify','汇总并验收完整 HDK','default',600,[['facts','板级事实'],['native','已审核制造资料'],['process','已审核工艺要求'],['firmware','已核验编译固件'],['sop','已审核测试说明'],['datasheets','器件手册']]],
    ['assemble','组装 HDK 目录','default',600,[['facts','板级事实'],['native','已审核制造资料'],['process','已审核工艺要求'],['firmware','已核验编译固件'],['sop','已审核测试说明'],['datasheets','器件手册']]],
    ['verify-delivery','验收 HDK 交付目录','default',600,[['in','已组装 HDK 目录']]],
    ['archive-delivery','生成 HDK 交付压缩包','default',600,[['in','已验收 HDK 目录']]],
  ].map(row=>capability('full',row)),
  capability('pinout',['verify','验收实拍 Pinout','default',180,[['images','已审核正反面 Pinout']]]),
].map(row => Object.freeze({ ...row, ...(row.id.startsWith('hdk.') ? { runBoundInputs: true } : {}) })));

const TYPES = new Set(['any', 'text', 'number', 'boolean', 'object', 'array']);
const TOOL_BY_ID = new Map(WORKFLOW_TOOLS.map(tool => [tool.id, tool]));

export function validateWorkflowToolConfig(node) {
  if (node?.type !== 'tool' || !node.config || typeof node.config !== 'object' || Array.isArray(node.config)) {
    throw new Error('工具执行器需要工具与代码节点配置。');
  }
  const config = node.config;
  const mode = config.executionMode;
  if (!['code', 'tool'].includes(mode)) throw new Error('请选择代码或工具执行模式。');
  for (const key of ['inputType', 'outputType']) {
    if (config[key] !== undefined && !TYPES.has(config[key])) throw new Error('工具与代码节点仅支持文本和 JSON 数据端口。');
  }
  if (config.timeoutSeconds !== undefined && (!Number.isInteger(config.timeoutSeconds)
    || config.timeoutSeconds < 1 || config.timeoutSeconds > 86400)) {
    throw new Error('执行超时必须是 1–86400 秒的整数。');
  }
  if (mode === 'code') {
    if (!['javascript', 'python'].includes(config.language)) throw new Error('代码语言仅支持 JavaScript 或 Python。');
    if (typeof config.code !== 'string' || !config.code.trim() || config.code.length > 100000 || config.code.includes('\0')) {
      throw new Error('请输入非空代码函数体，最多 100000 个字符，且不能包含空字符。');
    }
    return { kind: 'code', language: config.language };
  }
  const tool = TOOL_BY_ID.get(config.toolName);
  if (!tool) throw new Error('请选择已支持的工作台工具；当前不能直接调用 Hermes 或 MCP 工具。');
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
