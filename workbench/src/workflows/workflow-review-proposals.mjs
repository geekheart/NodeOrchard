import { isDeepStrictEqual } from 'node:util';
import { reviewRevisionPolicy } from '../../shared/workflow/workflow-review-revision.mjs';

const fail = (message, httpStatus = 400) => { throw Object.assign(new Error(message), { httpStatus }); };
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);
const REQUEST_FIELDS = ['runId', 'humanNodeId', 'attempt', 'attemptId', 'artifactHashes', 'targetNodeId'];
const validIdentifier = value => typeof value === 'string' && ID.test(value) && !RESERVED.has(value);

function exactDataObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).length !== keys.length || Reflect.ownKeys(value).some(key => !keys.includes(key))
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(field => !Object.hasOwn(field, 'value'))) fail(`${label}字段无效。`);
}

function proposalRequest(value) {
  exactDataObject(value, REQUEST_FIELDS, '产物修改请求');
  for (const key of ['runId', 'humanNodeId', 'attemptId', 'targetNodeId']) if (!validIdentifier(value[key])) fail(`${key}无效。`);
  if (!Number.isSafeInteger(value.attempt) || value.attempt < 1) fail('审核尝试次数无效。');
  const items = value.artifactHashes;
  if (!Array.isArray(items) || Object.getPrototypeOf(items) !== Array.prototype || items.length > 64
    || Reflect.ownKeys(items).length !== items.length + 1) fail('产物哈希列表无效。');
  const descriptors = Object.getOwnPropertyDescriptors(items), ids = new Set(), hashes = [];
  for (let i = 0; i < items.length; i++) {
    const descriptor = descriptors[i];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('产物哈希列表必须是完整数据数组。');
    const item = descriptor.value;
    exactDataObject(item, ['id', 'sha256'], '产物哈希');
    if (!validIdentifier(item.id) || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256) || ids.has(item.id)) fail('产物哈希无效或重复。');
    ids.add(item.id); hashes.push({ id: item.id, sha256: item.sha256 });
  }
  return { runId: value.runId, humanNodeId: value.humanNodeId, attempt: value.attempt,
    attemptId: value.attemptId, artifactHashes: hashes, targetNodeId: value.targetNodeId };
}

function assertCurrentHashes(artifacts, requested) {
  if (!Array.isArray(artifacts) || artifacts.length !== requested.length) fail('审核产物哈希集已变化，请重新查看。', 409);
  const current = new Map();
  for (const artifact of artifacts) {
    const id = artifact.id || artifact.artifactId;
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256 || '') || current.has(id)) fail('审核产物版本凭据无效，请重新查看。', 409);
    current.set(id, artifact.sha256);
  }
  const requestedIds = new Set();
  for (const item of requested) {
    if (requestedIds.has(item.id) || current.get(item.id) !== item.sha256) fail('审核产物哈希集已变化，请重新查看。', 409);
    requestedIds.add(item.id);
  }
}

// Binding prepares a draft-edit proposal. It never revises the frozen run.
export function bindArtifactRevisionProposal(app, workflowId, document, request) {
  if (!validIdentifier(workflowId)) fail('工作流 ID 无效。');
  request = proposalRequest(request);
  const run = app.workflows.get(request.runId);
  if (run?.importedArchive) fail('导入的历史审核只供查看，请从当前工作流新建运行后再修改产物。', 409);
  if (document?.id !== workflowId || run?.id !== request.runId || run.workflowId !== workflowId || run.document?.id !== workflowId
    || run.parentRunId || run.learningId || run.memoryScopeId || run.document.mode === 'learn' || document.mode === 'learn') {
    fail('修改候选只能绑定当前工作流的普通顶层运行。', 409);
  }
  const human = run.document.nodes?.find(node => node.id === request.humanNodeId), record = run.nodes?.[request.humanNodeId];
  if (human?.type !== 'human' || record?.status !== 'waiting_review') fail('所选节点没有等待中的人工审核。', 409);
  if (record.attempt !== request.attempt || record.attemptId !== request.attemptId) fail('审核节点尝试已变化，请重新查看。', 409);
  assertCurrentHashes(record.artifacts || [], request.artifactHashes);
  const policy = reviewRevisionPolicy(run, request.humanNodeId, request.targetNodeId);
  if (policy.targetNodeId !== request.targetNodeId || policy.strategy !== 'proposal') fail('此审核不能通过当前节点修改候选处理，请重新选择。', 409);
  const frozen = run.document.nodes.find(node => node.id === policy.targetNodeId);
  const targets = document.nodes?.filter(node => node.id === policy.targetNodeId) || [], target = targets[0];
  if (targets.length !== 1 || target.type !== frozen.type || !isDeepStrictEqual(target.config, frozen.config)) fail('草稿中的修改目标已变化，请先核对当前代码和运行版本。', 409);
  const source = run.nodes?.[target.id];
  if (!Number.isSafeInteger(source?.attempt) || source.attempt < 1 || !validIdentifier(source.attemptId)) fail('生产节点缺少可绑定的尝试版本。', 409);
  const hashes = request.artifactHashes.map(item => ({ id: item.id, sha256: item.sha256 }));
  return { request: { runId: request.runId, humanNodeId: request.humanNodeId, attempt: request.attempt,
    attemptId: request.attemptId, artifactHashes: hashes.map(item => ({ ...item })), targetNodeId: request.targetNodeId },
  context: { runId: run.id, nodeId: request.humanNodeId, attempt: record.attempt, attemptId: record.attemptId,
    artifactIds: hashes.map(item => item.id), artifactHashes: hashes.map(item => ({ ...item })) },
  target: { id: target.id, title: target.title, type: target.type },
  sourceAttempt: { attempt: source.attempt, attemptId: source.attemptId } };
}

// A prose revision of a tool must yield new executable business code. Cosmetic
// edits and reusing the same code do not implement the requested revision.
export function assertArtifactRevisionCodeChange(document, candidate, targetNodeId) {
  const original = document.nodes.find(node => node.id === targetNodeId);
  if (original?.type !== 'tool') return;
  const changed = candidate.nodes.find(node => node.id === targetNodeId);
  const code = value => typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : '';
  if (changed?.type !== 'tool' || changed.config?.executionMode !== 'code' || !code(changed.config.code)
    || code(changed.config.code) === code(original.config?.code)) {
    fail('AI未生成实际的工具代码修改；未重跑旧代码，请重试生成修改候选。', 409);
  }
}
