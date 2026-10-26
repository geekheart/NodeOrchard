import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const REVISION = /^sha256:[a-f0-9]{64}$/;
const MAX_INPUT_BYTES = 64 * 1024;

// Match the gateway's deliberately narrow, metadata-only declaration. Normal
// execution retains its existing Hermes memory/tools policy.
function declaresNoTools(content) {
  const normalized = content.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
  if (!/^---[ \t]*\n/.test(normalized)) return false;
  const closing = /\n---[ \t]*\n/.exec(normalized.slice(3));
  if (!closing) return false;
  const lines = normalized.slice(0, closing.index + closing[0].length + 3).split('\n').slice(1, -2);
  const declarations = lines.filter(line => /^allowed-tools[ \t]*:/.test(line));
  return declarations.length === 1 && /^allowed-tools[ \t]*:[ \t]*\[[ \t]*\][ \t]*(?:#.*)?$/.test(declarations[0]);
}

function jsonInput(value) {
  const inspect = (entry, depth = 0) => {
    if (depth > 50) throw new Error('工作流输入嵌套过深。');
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') return;
    if (typeof entry === 'number' && Number.isFinite(entry)) return;
    if (!entry || typeof entry !== 'object'
      || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(entry))
      || Object.getOwnPropertySymbols(entry).length) throw new Error('工作流输入必须是有效 JSON 数据。');
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(entry))) {
      if (Array.isArray(entry) && key === 'length') continue;
      if (!Object.hasOwn(descriptor, 'value')) throw new Error('工作流输入不能包含访问器。');
      inspect(descriptor.value, depth + 1);
    }
  };
  inspect(value);
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_INPUT_BYTES) throw new Error('工作流输入不能超过 64KB。');
  return JSON.parse(encoded);
}

export async function prepareSkillRun(app, session, skill, options) {
  const { input, skillNode, runId, stepId, nodeId, learningId, memoryScopeId, attemptId } = options;
  const isolated = learningId !== undefined || memoryScopeId !== undefined;
  if (isolated && (!UUID.test(learningId || '') || memoryScopeId !== learningId)) {
    throw new Error('学习 Skill 缺少有效的同批次固定记忆。');
  }
  if (!UUID.test(runId || '') || (stepId !== undefined && !UUID.test(stepId))) {
    throw new Error('无效的工作流运行标识。');
  }
  if (attemptId !== undefined && (attemptId !== stepId || !UUID.test(attemptId))) throw new Error('Skill 尝试标识无效。');
  if (stepId !== undefined && (!NODE_ID.test(nodeId || '') || ['__proto__', 'constructor', 'prototype'].includes(nodeId))) {
    throw new Error('无效的工作流节点标识。');
  }
  const snapshotId = stepId || runId;
  const sessionId = session.runtimeSessionId;
  const outputType = skillNode.config.outputType;
  const preparedInput = jsonInput(input);
  const revision = `sha256:${createHash('sha256').update(skill.content, 'utf8').digest('hex')}`;
  if (skill.revision !== revision || skillNode.config.version !== revision) {
    throw new Error('Skill 内容已变化，请重新选择当前版本。');
  }
  const toolFreeLearning = isolated && declaresNoTools(skill.content);
  const candidate = skill.source === 'learned' || Object.hasOwn(skill, 'baseName') || Object.hasOwn(skill, 'baseRevision');
  if (candidate && (typeof skill.baseName !== 'string' || !skill.baseName.trim() || skill.baseName.length > 256
    || skill.baseName.includes('\0') || !REVISION.test(skill.baseRevision || ''))) {
    throw new Error('学习候选缺少有效的原始 Skill 名称或版本。');
  }
  const baseName = candidate ? skill.baseName : skill.name;
  const prepared = await app.adapter.request('workbench.skill.prepare', {
    session_id: sessionId, skill: baseName, revision, run_id: snapshotId,
    input: preparedInput, output_type: outputType,
    ...(candidate ? { candidate_content: skill.content, source_revision: skill.baseRevision } : {}),
    ...(isolated ? { memory_scope_id: memoryScopeId } : {}),
  });
  if (typeof prepared?.text !== 'string' || !prepared.text.trim()
      || prepared.skill?.name !== baseName || prepared.skill?.revision !== revision
      || (candidate && prepared.skill?.sourceRevision !== skill.baseRevision)
      || prepared.policy?.skillMutationBlocked !== true
      || prepared.policy?.memoryAllowed !== true || prepared.policy?.freeze !== 'bundle-copy') {
    throw new Error('Hermes 未确认本次 Skill 的固定快照与执行策略，未提交模型。');
  }
  if (isolated && (prepared.policy.memoryWriteAllowed !== false || prepared.policy.externalMemoryAllowed !== false
    || prepared.policy.memoryMode !== 'batch-snapshot' || prepared.policy.memoryScopeId !== memoryScopeId)) {
    throw new Error('Hermes 未确认学习 Skill 的固定只读记忆，未提交模型。');
  }
  if (toolFreeLearning && prepared.policy.toolsAllowed !== false) {
    throw new Error('Hermes 未确认此学习规划 Skill 的无工具策略，未提交模型。');
  }
  // Record the chosen skill body and snapshot metadata for local inspection. No auth or
  // provider configuration is copied; the Hermes runtime owns those separately.
  const directory = attemptId ? join(app.config.dataDir, 'workflow-snapshots', runId, 'nodes', nodeId, 'attempts', attemptId) : stepId === undefined
    ? join(app.config.dataDir, 'workflow-snapshots', runId)
    : join(app.config.dataDir, 'workflow-snapshots', runId, 'nodes', nodeId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'skill.json'), JSON.stringify({
    name: skill.name, revision, source: skill.source,
    ...(candidate ? { baseName, baseRevision: skill.baseRevision } : {}),
    snapshot: prepared.snapshot, policy: prepared.policy, content: skill.content,
    ...(stepId === undefined ? {} : { runId, stepId, nodeId }),
    preparedAt: new Date().toISOString(),
  }, null, 2), { mode: 0o600 });
  let finished = false;
  return {
    text: prepared.text,
    skill: { name: skill.name, revision, source: skill.source,
      ...(candidate ? { baseName, baseRevision: skill.baseRevision } : {}),
      bundleHash: prepared.snapshot?.bundleHash, snapshotDirectory: prepared.snapshot?.directory },
    bindInput: async actualInput => {
      if (finished) throw new Error('此 Skill 步骤已经结束，不能再次绑定输入。');
      const result = await app.adapter.request('workbench.skill.input', {
        session_id: sessionId, run_id: snapshotId, input: jsonInput(actualInput), output_type: outputType,
      });
      if (typeof result?.text !== 'string' || !result.text.trim()) {
        throw new Error('Hermes 未返回本步骤的固定 Skill 上下文，未提交模型。');
      }
      return { text: result.text };
    },
    cleanup: async () => {
      const result = await app.adapter.request('workbench.skill.finish', {
        session_id: sessionId, run_id: snapshotId,
      });
      finished = true;
      if (result?.unchanged !== true || result?.snapshotIntact !== true) {
        throw new Error('运行期间 Skill 源文件或固定副本发生变化，本次结果未确认为成功；请检查关联任务。');
      }
    },
  };
}
