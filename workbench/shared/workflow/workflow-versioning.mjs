// Prepare a new editable version without saving, running, or archiving anything.
// The ordinary editor/library action owns those user-visible operations.
import { createNode, getPorts, validateDocument } from './workflow-model.mjs';
import { builtinNodePresets } from './workflow-presets.mjs';
import { workflowInputFields } from './workflow-inputs.mjs';
import { layoutPositions } from './workflow-studio-utils.mjs';
import { planWorkflow } from './workflow-plan.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const learningTypes = new Set(['evaluation', 'improvement']);
const textKinds = new Set(['text', 'file', 'folder', 'image']);
const fail = message => { throw new Error(message); };
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
  && !['__proto__', 'prototype', 'constructor'].includes(value);

function collectIds(document, ids) {
  ids.add(document.id);
  for (const node of document.nodes) {
    ids.add(node.id);
    if (node.config.document) collectIds(node.config.document, ids);
  }
  for (const edge of document.edges) ids.add(edge.id);
}

function inputRules(node) {
  return workflowInputFields(node).filter(field => field.required).flatMap(field => {
    const rules = [{ valuePath: field.key, check: 'required', message: `请准备${field.label}。` },
      { valuePath: field.key, check: 'type', expectedType: field.kind === 'number' ? 'number' : 'text',
        message: `${field.label}应为${field.kind === 'number' ? '数字' : '文本或文件路径'}。` }];
    if (textKinds.has(field.kind)) rules.push({ valuePath: field.key, check: 'nonempty', message: `${field.label}不能为空。` });
    return rules;
  });
}

function filename(title) {
  return `${title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim() || '人工审核'}-已审核阶段成果.json`;
}

/**
 * Clone a v2 graph into a new version using the existing node contracts.
 * Professional tools remain ordinary configured tool nodes. Stage outputs save
 * their received receipt/manifest value; they do not re-export upstream images.
 */
export function prepareWorkflowVersion(document, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('新版工作流选项必须是对象。');
  for (const key of Object.keys(options)) if (!['title', 'upgradeNodes', 'addValidation', 'addStageOutputs', 'idFactory'].includes(key)) fail(`未知新版选项：${key}。`);
  const { upgradeNodes = true, addValidation = true, addStageOutputs = true, idFactory } = options;
  for (const [key, value] of Object.entries({ upgradeNodes, addValidation, addStageOutputs })) if (typeof value !== 'boolean') fail(`${key} 必须是布尔值。`);
  if (idFactory !== undefined && typeof idFactory !== 'function') fail('idFactory 必须是函数。');
  const source = validateDocument(document);
  if (source.schemaVersion !== 2) fail('新版节点升级仅支持 v2 并行工作流。');
  const title = options.title ?? `${source.title.slice(0, 110)} · 新节点版`;
  if (typeof title !== 'string' || !title.trim() || title.length > 120 || title.includes('\0')) fail('新版工作流名称必须为 1–120 个字符。');
  const reserved = new Set(); collectIds(source, reserved);
  const fresh = prefix => {
    const id = idFactory ? idFactory(prefix) : `${prefix}-${globalThis.crypto.randomUUID()}`;
    if (!validId(id) || reserved.has(id)) fail('新版 ID 必须有效、唯一，且不能沿用旧版 ID。');
    reserved.add(id); return id;
  };
  const presets = new Map(builtinNodePresets().map(preset => [preset.toolName, preset]));
  const report = {
    sourceId: source.id, sourceTitle: source.title, toolPresets: 0, validationNodes: 0, stageOutputs: 0,
    skillCount: 0, learningTargets: [], learningTargetCount: 0, documentCount: 0,
    nodeCount: 0, edgeCount: 0, outputStages: 0, nodeIdMap: {}, workflowIdMap: {},
    layout: { nodeWidth: 270, nodeHeight: 180, columnGap: 340, rowGap: 310 },
    details: { toolPresets: [], validationNodes: [], stageOutputs: [], learningTargets: [], nodeMappings: [] },
    notes: ['阶段输出保存本次已审核回执或清单引用，不会重新导出上游图片。',
      'Skill 固定版本、人工审核、学习目标和原有业务端口保持；不封装同次运行凭据链。',
      '输入校验检查必填值与数据类型；文件存在、格式和来源匹配仍由输入准备及对应工具核验。'],
  };

  function cloneGraph(original, outer = false) {
    if (original.schemaVersion !== 2) fail('内嵌流程也必须为 v2，无法安全复制旧版子流程。');
    const next = copy(original), mapping = new Map(original.nodes.map(node => [node.id, fresh('node')]));
    next.id = fresh('workflow'); report.workflowIdMap[original.id] = next.id;
    report.documentCount++;
    if (outer) next.title = title.trim();
    for (const node of next.nodes) {
      const oldId = node.id; node.id = mapping.get(oldId);
      if (outer) report.nodeIdMap[oldId] = node.id;
      report.details.nodeMappings.push({ sourceWorkflowId: original.id, workflowId: next.id, sourceNodeId: oldId, nodeId: node.id });
      if (node.config.reviewTargetNodeId && mapping.has(node.config.reviewTargetNodeId)) node.config.reviewTargetNodeId = mapping.get(node.config.reviewTargetNodeId);
      if (node.config.targetSkillNodeIds) node.config.targetSkillNodeIds = node.config.targetSkillNodeIds.map(id => mapping.get(id) || id);
      if (node.config.document) {
        const child = cloneGraph(node.config.document);
        node.config.document = child.document;
        for (const port of node.ports?.outputs || []) {
          if (typeof port.valuePath !== 'string') continue;
          const [head, ...tail] = port.valuePath.split('.');
          if (child.mapping.has(head)) port.valuePath = [child.mapping.get(head), ...tail].join('.');
        }
      }
      if (node.type === 'skill') report.skillCount++;
      if (node.type === 'improvement') for (const id of node.config.targetSkillNodeIds || []) {
        report.learningTargets.push(id);
        report.details.learningTargets.push({ workflowId: next.id, nodeId: node.id, targetNodeId: id });
      }
      if (upgradeNodes && node.type === 'tool' && node.config.executionMode === 'tool' && !node.origin) {
        const preset = presets.get(node.config.toolName);
        if (preset) {
          node.origin = { kind: 'preset', id: preset.id, version: preset.version, title: preset.title, baseType: 'tool' };
          report.toolPresets++;
          report.details.toolPresets.push({ workflowId: next.id, nodeId: node.id, toolName: node.config.toolName, presetId: preset.id, version: preset.version });
        }
      }
    }
    next.edges = next.edges.map(edge => ({ ...edge, id: fresh('edge'), sourceNode: mapping.get(edge.sourceNode), targetNode: mapping.get(edge.targetNode) }));
    for (const node of next.nodes.filter(node => node.type === 'output' && node.config.stage === undefined)) {
      const isIntermediate = next.edges.some(edge => edge.sourceNode === node.id && edge.sourcePort !== 'learning'
        && !learningTypes.has(next.nodes.find(target => target.id === edge.targetNode)?.type));
      node.config.stage = isIntermediate ? 'intermediate' : 'final'; report.outputStages++;
    }
    if (addValidation) for (const input of [...next.nodes].filter(node => node.type === 'input')) {
      const rules = inputRules(input); if (!rules.length) continue;
      const output = getPorts(input).outputs.find(port => port.id === 'out');
      if (!output || output.valuePath) fail('带必填字段的输入需使用未投影的 out 端口，才能安全加入字段校验。');
      const outgoing = next.edges.filter(edge => edge.sourceNode === input.id && edge.sourcePort === 'out');
      let previous = input.id;
      // Validation nodes accept at most 32 rules. Large input forms keep every
      // declared rule by using a short chain rather than silently dropping any.
      for (let offset = 0; offset < rules.length; offset += 32) {
        const suffix = rules.length > 32 ? ` · ${Math.floor(offset / 32) + 1}` : '';
        const validation = createNode('validation', { x: input.x + 340, y: input.y }, { id: fresh('node'), title: `校验${input.title}`.slice(0, 115) + suffix,
          config: { inputType: output.type, outputType: output.type, rules: rules.slice(offset, offset + 32) } });
        next.nodes.push(validation);
        next.edges.push({ id: fresh('edge'), sourceNode: previous, sourcePort: 'out', targetNode: validation.id, targetPort: 'in' });
        previous = validation.id; report.validationNodes++;
        report.details.validationNodes.push({ workflowId: next.id, nodeId: validation.id, inputNodeId: input.id, rules: validation.config.rules.length });
      }
      for (const edge of outgoing) edge.sourceNode = previous;
    }
    if (addStageOutputs) for (const human of [...next.nodes].filter(node => node.type === 'human')) {
      const output = getPorts(human).outputs.find(port => port.id === 'out'); if (!output) continue;
      const hasStage = next.edges.some(edge => edge.sourceNode === human.id && edge.sourcePort === 'out'
        && next.nodes.some(node => node.id === edge.targetNode && node.type === 'output' && node.config.stage === 'intermediate'));
      if (hasStage) continue;
      const stage = createNode('output', { x: human.x + 340, y: human.y + 310 }, {
        id: fresh('node'), title: `${human.title.slice(0, 110)} · 阶段成果`, config: { stage: 'intermediate', fileName: filename(human.title) },
      });
      next.nodes.push(stage);
      next.edges.push({ id: fresh('edge'), sourceNode: human.id, sourcePort: 'out', targetNode: stage.id, targetPort: 'in' });
      report.stageOutputs++;
      report.details.stageOutputs.push({ workflowId: next.id, nodeId: stage.id, reviewNodeId: human.id, fileName: stage.config.fileName, content: 'receipt-manifest-reference' });
    }
    // Runtime initially focuses the last output. Keep the final deliverables
    // last without changing any dependency or the order among final outputs.
    next.nodes = [...next.nodes.filter(node => node.type !== 'output' || node.config.stage !== 'final'),
      ...next.nodes.filter(node => node.type === 'output' && node.config.stage === 'final')];
    const clean = validateDocument(next);
    // The run endpoint accepts execute snapshots only. Preserve the author's
    // mode while checking the same business DAG and its learning branch.
    planWorkflow({ ...clean, mode: 'execute' });
    const positions = layoutPositions(clean);
    for (const node of clean.nodes) Object.assign(node, positions.get(node.id));
    clean.viewport = { x: 0, y: 0, zoom: 1 };
    report.nodeCount += clean.nodes.length; report.edgeCount += clean.edges.length;
    return { document: clean, mapping };
  }
  const result = cloneGraph(source, true).document;
  report.learningTargets = [...new Set(report.learningTargets)]; report.learningTargetCount = report.learningTargets.length;
  report.rootNodeCount = result.nodes.length; report.rootEdgeCount = result.edges.length;
  report.planValidated = true;
  return { document: result, report };
}
