// Historical schema-1 fixtures only. Production workflows are edited through the app.
import { createDocument, createNode, connectNodes, validateDocument } from '../../shared/workflow/workflow-model.mjs';
import { planWorkflow } from '../../shared/workflow/workflow-plan.mjs';
import { fileURLToPath } from 'node:url';

export function createPinoutWorkflow({ skillRevision, previous, pipelinePath = fileURLToPath(new URL('../../hdk/pinout_pipeline.py', import.meta.url)) }) {
  let document = createDocument({ title: '实拍 Pinout · 排版 / 对比 / Skill 学习' });
  document.id = 'workflow-pinout';
  document.mode = 'execute';
  const prior = previous?.nodes.find(node => node.id === 'pinout-plan-skill' && node.type === 'skill');
  const tool = (operation, title, x, y, timeoutSeconds) => createNode('tool', { x, y }, {
    id: 'pinout-' + operation, title,
    config: {
      inputType: 'object', outputType: 'object', executionMode: 'code', language: 'python',
      code: `import importlib.util\nspec = importlib.util.spec_from_file_location('pinout_pipeline', ${JSON.stringify(pipelinePath)})\npipeline = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(pipeline)\nreturn pipeline.run_stage(${JSON.stringify(operation)}, input)`,
      timeoutSeconds, failurePolicy: 'stop',
    },
  });
  document.nodes = [
    createNode('input', { x: 70, y: 90 }, {
      id: 'pinout-input', title: '工程 / 正反面实拍 / 已核验编号证据',
      config: { fieldName: 'request', outputType: 'object', required: true },
    }),
    tool('prepare', '原始网络 / 照片孔位 / 版本核验', 420, 90, 180),
    createNode('skill', { x: 770, y: 90 }, {
      id: 'pinout-plan-skill', title: 'Pinout 标签与排版规划',
      config: {
        inputType: 'object', outputType: 'object',
        skillRef: prior?.config.skillRef || 'board-pinout',
        version: prior?.config.version || skillRevision,
        timeoutSeconds: 600, failurePolicy: 'stop',
      },
    }),
    tool('render', 'OpenPinMap · 真实实拍 Pinout 导出', 770, 380, 600),
    tool('verify', '针脚 / 引线 / 文字 / 最终图片检查', 420, 380, 180),
    createNode('output', { x: 70, y: 380 }, { id: 'pinout-output', title: 'Pinout 图片 / 可编辑工程 / 检查报告' }),
    createNode('evaluation', { x: 420, y: 670 }, {
      id: 'pinout-evaluation', title: 'S31 参考样式与实际产物指标对比',
      config: { comparison: 'model', valuePath: 'learningComparison' },
    }),
    createNode('improvement', { x: 770, y: 670 }, {
      id: 'pinout-improvement', title: '改进 Pinout Skill',
      config: { scope: 'skills', targetSkillNodeIds: ['pinout-plan-skill'] },
    }),
  ];
  for (let index = 1; index < 6; index++) {
    document = connectNodes(document, {
      sourceNode: document.nodes[index - 1].id, sourcePort: 'out',
      targetNode: document.nodes[index].id, targetPort: 'in',
    });
  }
  document = connectNodes(document, { sourceNode: 'pinout-verify', sourcePort: 'out', targetNode: 'pinout-evaluation', targetPort: 'in' });
  document = connectNodes(document, { sourceNode: 'pinout-evaluation', sourcePort: 'out', targetNode: 'pinout-improvement', targetPort: 'in' });
  document = validateDocument(document);
  planWorkflow(document);
  return document;
}

export function createPinoutLearningConfig({ request, expected }) {
  return {
    trainingCases: [{
      id: 'p4c61-front-pinout', name: 'P4C61 正面 · 实拍 Pinout 排版训练',
      input: { ...request, viewSides: ['front'] }, expected,
    }],
    validationCases: [{
      id: 'p4c61-back-pinout', name: '同一 P4C61 背面 · 独立视图验证（非独立硬件）',
      input: { ...request, viewSides: ['back'] }, expected,
    }],
    comparison: 'model', targetScore: 95, maxRounds: 5,
    trainableNodeIds: ['pinout-plan-skill'],
    rubric: '比较 actual 中由固定工具重新读取真实导出产物得到的指标、标签映射、排版计划与 expected。先核对 qualitySummary.checks；任何检查不是 true、存在 diagnostics 或报告未完成，都必须低于 95 分。不得凭 Skill 自报通过替代真实工具检查。全部检查通过后，再核对简洁标签、主控归属、特殊信号说明、透明竖版、照片与标签比例、文字可读性及引线实际到达孔心；符合参考通用样式且无实质缺口才可达到 95。实际固定工具负责原始网络/针号/照片/校准绑定及最终 SVG/PNG 检查，评分模型仅收到文本证据和图像指标，没有看到 PNG；不要声称视觉识别通过。只允许修改 Pinout Skill 正文，禁止修改工具、流程、源针脚、校准、样例、参考或验收规则。参考仅供评价，不得要求复制 S31 的硬件引脚或在 Skill 中硬编码 P4C61 名称和逐针答案。正面用于训练，背面用于验证；两者为同一硬件，不得宣称独立板卡泛化，验证集的输入、输出和反馈不得进入优化提示或持久记忆。根据训练中真实渲染缺陷改进通用标签/排版策略，使后续执行只依赖固定原始事实输入即可独立生成结果。',
  };
}

