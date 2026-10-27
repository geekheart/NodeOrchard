import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validateDocument } from '../../shared/workflow/workflow-model.mjs';
import { planWorkflow } from '../../shared/workflow/workflow-plan.mjs';
import { normalizeWorkflowDataset } from '../../shared/workflow/workflow-dataset.mjs';
import { validateWorkflowInput } from './workflow-runs.mjs';
import { redact } from '../hermes-adapter.mjs';

const CATALOG = Object.freeze([
  { id: 'local-data', title: '本地数据 · 工具与代码', kind: 'execute', description: '使用内置 JSON 数据完成清理、解析与校验，无需模型或外部服务。', requiresModel: false },
  { id: 'document-review', title: '文档整理 · 条件分支', kind: 'execute', description: '用本地代码整理内置文字；资料缺失时进入人工核对分支。', requiresModel: false },
  { id: 'publication-review', title: '文稿发布 · 人工审核', kind: 'execute', description: '整理内置演示文稿，等待人工确认后保存结果。', requiresModel: false },
  { id: 'humanizer', title: '文本润色 · 单 Skill', kind: 'execute', description: '使用当前已安装的 humanizer 处理内置演示文字。', requiresModel: true },
  { id: 'multi-skill', title: '会议记录 · 串联 Skill', kind: 'execute', description: '润色演示会议记录，再提取待办；使用当前已安装的两个 Skill。', requiresModel: true },
  { id: 'mixed-capabilities', title: '混合能力 · 记录到待办', kind: 'execute', description: '串联本地工具、JavaScript 与两个真实 Skill。', requiresModel: true },
  { id: 'learning-text', title: '学习入门 · 英文短语', kind: 'learn', description: '完整五节点学习支路，预填一条训练和一条验证样例，最多两轮。', requiresModel: true },
  { id: 'multi-example-learning', title: '多样例学习 · 英文短语', kind: 'learn', description: '完整五节点学习支路，预填三条训练和两条验证样例，最多两轮。', requiresModel: true },
].map(row => Object.freeze(row)));
const byId = new Map(CATALOG.map(row => [row.id, row]));
const revision = /^sha256:[a-f0-9]{64}$/;
const fail = (message, httpStatus = 400) => { throw Object.assign(new Error(message), { httpStatus }); };
const documentId = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) fail('示例需要有效的当前工作流 ID。');
  return value;
};
const read = async (id, suffix) => JSON.parse(await readFile(new URL('../../examples/' + id + suffix, import.meta.url), 'utf8'));

// Preparation only returns a draft. It cannot save, execute, learn, install a
// Skill or accept a filesystem path from the caller.
export class WorkflowExamples {
  constructor(app) { this.app = app; }
  list() { return structuredClone(CATALOG); }
  async prepare(id, request) {
    if (this.app.closed) fail('工作台已关闭，无法准备示例。', 503);
    const example = byId.get(id); if (!example) fail('示例不存在。', 404);
    if (!request || typeof request !== 'object' || Array.isArray(request) || ![Object.prototype, null].includes(Object.getPrototypeOf(request))
      || Reflect.ownKeys(request).some(key => key !== 'workflowId')
      || Object.values(Object.getOwnPropertyDescriptors(request)).some(field => !Object.hasOwn(field, 'value'))) fail('示例准备参数只接受 workflowId 字段。');
    const workflowId = documentId(request.workflowId); this.app.workflowLibrary?.assertRunnable(workflowId);
    const document = validateDocument(await read(id, '.workflow.json')); document.id = workflowId;
    const requirements = [], skills = document.nodes.filter(node => node.type === 'skill');
    const connected = this.app.adapter ? this.app.adapter.state === 'ready' && (!this.app.backend || this.app.backend.state === 'ready') : this.app.backend?.state === 'ready';
    if (example.requiresModel && !connected) requirements.push('请先连接 Hermes，才能使用此示例的模型与 Skill。');
    else if (example.requiresModel && this.app.backend?.authenticated === false) requirements.push('当前 Hermes 提供商尚未完成认证。');
    if (skills.length && connected) {
      const resolved = await Promise.allSettled([...new Set(skills.map(node => node.config.skillRef))].map(async name => {
        const lookup = this.app.skillDetail || this.app.skill;
        if (typeof lookup !== 'function') fail('应用暂未提供真实 Skill 读取能力。', 503);
        const skill = await lookup.call(this.app, name);
        if (skill?.name !== name || !revision.test(skill.revision || '') || typeof skill.content === 'string'
          && 'sha256:' + createHash('sha256').update(skill.content).digest('hex') !== skill.revision) fail('Skill 来源或正文版本未通过核对。', 409);
        return skill;
      }));
      const names = [...new Set(skills.map(node => node.config.skillRef))];
      for (let index = 0; index < names.length; index++) {
        const result = resolved[index], name = names[index];
        if (result.status === 'fulfilled') for (const node of skills.filter(node => node.config.skillRef === name)) node.config.version = result.value.revision;
        else requirements.push(result.reason?.httpStatus === 404 ? `未找到已启用的 Skill：${name}。` : `Skill ${name} 尚不可用：${redact(result.reason?.message || '读取失败').slice(0, 200)}`);
      }
    }
    const plan = planWorkflow({ ...document, mode: 'execute' }); validateWorkflowInput(undefined, plan);
    let learningConfig;
    if (example.kind === 'learn') {
      const config = await read(id, '.config.json'), dataset = normalizeWorkflowDataset({ trainingCases: config.trainingCases, validationCases: config.validationCases });
      if (!plan.learningBranch) fail('学习示例缺少完整的对比与改进支路。', 500);
      learningConfig = { ...dataset, comparison: plan.learningBranch.evaluationNode.config.comparison, rubric: config.rubric,
        targetScore: config.targetScore, maxRounds: config.maxRounds, trainableNodeIds: [...plan.learningBranch.improvementNode.config.targetSkillNodeIds] };
    }
    const ready = requirements.length === 0;
    this.app.logEvents?.write('info', 'workflow.example.prepared', { component: 'workflow', workflowId, count: document.nodes.length, status: ready ? 'ready' : 'blocked' });
    return { example: structuredClone(example), document, ...(learningConfig ? { learningConfig } : {}), ready, requirements };
  }
}
