import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path';
import { validateDocument } from '../../shared/workflow/workflow-model.mjs';
import { workflowInputFields } from '../../shared/workflow/workflow-inputs.mjs';
import { normalizeAttachmentRegistry, attachmentEntries, attachmentMetadata } from './workflow-attachments.mjs';
import { validateConversationContext } from './workflow-conversation-context.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_RECORD_BYTES = 512 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/, FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const ACTIVE = new Set(['preparing', 'queued', 'ready', 'running', 'waiting', 'waiting_review', 'waiting_resource', 'publishing', 'pending']);
const STATUSES = new Set([...ACTIVE, 'complete', 'completed', 'error', 'failed', 'interrupted', 'stopped', 'cancelled', 'skipped', 'blocked', 'unknown', 'exhausted']);
const CONTROL = new Set(['sessionId', 'sessionIds', 'modelSessionId', 'modelSessionIds', 'runtimeSessionId', 'storedSessionId',
  'session_id', 'session_ids', 'model_session_id', 'runtime_session_id', 'stored_session_id', 'controllerId', 'controllerSessionId',
  'checkpoint', 'actions', 'outcome', 'revisionRequest', 'revisionProposals', 'expectedAttempt', 'expectedAttemptId', 'expectedArtifactHashes',
  'learningId', 'memoryScopeId', 'memoryPolicy', 'trigger', 'scheduleId', 'permissionScope', 'mutationReceipts', 'resumeToken']);
const OPAQUE = new Set(['code', 'prompt', 'text', 'content', 'outputText', 'partialText', 'stdout', 'stderr', 'error', 'reason', 'summary']);
const PATHS = new Set(['path', 'directory', 'outputDirectory', 'deliveryDirectory', 'cwd', 'snapshotPath', 'packageRoot', 'manifestPath',
  'receiptPath', 'sourceDirectory', 'inputDirectory', 'sessionDirectory', 'runOutputDirectory', 'resolvedPath']);
const fail = (message, httpStatus = 400) => { throw Object.assign(new Error(message), { httpStatus }); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identifier = value => {
  if (typeof value !== 'string' || !ID.test(value) || FORBIDDEN.has(value)) fail('工作流包包含无效 ID。');
  return value;
};
function plain(value, depth = 0, state = { count: 0, bytes: 0 }) {
  if (++state.count > 5000000 || depth > 64) fail('工作流包记录过多或嵌套过深。', 413);
  state.bytes += typeof value === 'string' ? Buffer.byteLength(value) : 8;
  if (state.bytes > MAX_RECORD_BYTES) fail('工作流包历史记录过大。', 413);
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object' || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value))) fail('工作流包记录必须是普通 JSON 数据。');
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (Array.isArray(value) && key === 'length') continue;
    if (FORBIDDEN.has(key) || !Object.hasOwn(descriptor, 'value')) fail('工作流包记录包含不安全字段。');
    state.bytes += Buffer.byteLength(key); plain(descriptor.value, depth + 1, state);
  }
  if (Object.getOwnPropertySymbols(value).length) fail('工作流包记录包含不安全字段。');
}
const sourcePath = value => typeof value === 'string' && (isAbsolute(value) || win32.isAbsolute(value));
const style = value => win32.isAbsolute(value) && !isAbsolute(value) ? win32 : posix;
const normalizedSource = value => style(value).normalize(value);
const sourceKey = value => { const path = normalizedSource(value); return style(value) === win32 ? 'windows:' + path.toLowerCase() : 'posix:' + path; };
const inside = (root, target) => { const part = relative(root, target); return part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part); };

function safeRelative(value, allowEmpty = false) {
  if (typeof value !== 'string' || (!value && !allowEmpty) || value.length > 4096 || /[\\\x00-\x1f:]/.test(value)
    || value.startsWith('/') || value.split('/').some(part => part === '.' || part === '..' || !part && value)) fail('工作流包文件映射路径无效。');
  return value;
}

function mappingIndex(files, directory) {
  if (!files || !Array.isArray(files.entries) || !Array.isArray(files.directories)
    || files.entries.length > 10000 || files.directories.length > 10000) fail('工作流包文件映射格式无效。');
  const sources = new Map(), destinations = new Map(), directories = [];
  const admit = (entry, folder) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !sourcePath(entry.source) || entry.source.includes('\0')) fail('工作流包文件来源映射无效。');
    const path = safeRelative(entry.path, folder), target = resolve(directory, ...path.split('/'));
    if (!inside(directory, target) || !folder && target === directory) fail('工作流包文件映射越界。');
    if (!folder && entry.sha256 !== undefined && !HASH.test(entry.sha256)) fail('工作流包文件哈希无效。');
    const destinationKey = target.normalize('NFC').toLowerCase(), prior = destinations.get(destinationKey);
    if (prior && (prior.target !== target || prior.folder !== folder || !folder && prior.sha256 !== entry.sha256)) fail('工作流包文件映射发生冲突。');
    const value = { ...entry, target, folder };
    destinations.set(destinationKey, value);
    const key = sourceKey(entry.source); if (!sources.has(key)) sources.set(key, []); sources.get(key).push(value);
    if (folder) directories.push(value);
  };
  files.entries.forEach(entry => admit(entry, false)); files.directories.forEach(entry => admit(entry, true));
  function select(rows, { sha256, runId, folder } = {}) {
    rows = rows.filter(row => folder === undefined || row.folder === folder);
    if (sha256) rows = rows.filter(row => row.sha256 === sha256);
    if (runId && rows.some(row => row.runId === runId)) rows = rows.filter(row => row.runId === runId);
    else if (!runId && rows.some(row => !row.runId)) rows = rows.filter(row => !row.runId);
    if (!rows.length || new Set(rows.map(row => row.target)).size > 1 && new Set(rows.map(row => row.sha256 || row.target)).size > 1) return null;
    return rows[0];
  }
  return (value, options = {}) => {
    if (typeof value !== 'string' || !value) return null;
    if (sourcePath(value)) {
      const exact = select(sources.get(sourceKey(value)) || [], options); if (exact) return exact;
      if (options.exact) return null;
      for (const entry of [...directories].sort((left, right) => right.source.length - left.source.length)) {
        if (style(value) !== style(entry.source)) continue;
        const path = style(value).relative(normalizedSource(entry.source), normalizedSource(value));
        if (path === '..' || path.startsWith('..' + style(value).sep) || style(value).isAbsolute(path)) continue;
        const target = resolve(entry.target, ...path.split(style(value).sep));
        if (!inside(directory, target)) continue;
        if (options.folder || destinations.has(target.normalize('NFC').toLowerCase())) return { ...entry, target };
      }
      return null;
    }
    try {
      const target = resolve(directory, ...safeRelative(value).split('/'));
      const found = destinations.get(target.normalize('NFC').toLowerCase());
      return found && (options.folder === undefined || options.folder === found.folder) ? found : null;
    } catch { return null; }
  };
}

function cleanDocument(value) {
  try { return validateDocument(value); } catch (error) { fail('工作流包流程定义无效：' + error.message); }
}

// Convert imported records without admitting any source-machine execution or
// review identity. The caller owns extraction, atomic persistence and raw audit.
export function prepareImportedWorkflowRecords(input, { idFactory } = {}) {
  plain(input);
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('工作流包转换请求格式无效。');
  if (Object.keys(input).some(key => !['sourceWorkflowId', 'targetWorkflowId', 'directory', 'document', 'conversation', 'conversationContext', 'runs', 'fileRuns', 'artifacts', 'files', 'attachments'].includes(key))) fail('工作流包转换请求包含未知字段。');
  const { sourceWorkflowId, targetWorkflowId, document: sourceDocument, directory: requestedDirectory,
    conversation, runs: sourceRuns = [], fileRuns: sourceFileRuns = [], artifacts: sourceArtifacts = [], files = { entries: [], directories: [] } } = input;
  identifier(sourceWorkflowId); identifier(targetWorkflowId);
  if (sourceWorkflowId === targetWorkflowId || typeof requestedDirectory !== 'string' || !isAbsolute(requestedDirectory) || requestedDirectory.includes('\0')) fail('导入必须使用新的工作流 ID 与独立绝对目录。');
  const directory = resolve(requestedDirectory), document = cleanDocument(sourceDocument), warnings = new Set();
  if (document.id !== sourceWorkflowId) fail('工作流包主流程身份不一致。');
  if (![sourceRuns, sourceFileRuns, sourceArtifacts].every(Array.isArray) || sourceRuns.length > 1000 || sourceFileRuns.length > 1000 || sourceArtifacts.length > 10000) fail('工作流包运行记录格式或数量无效。', 413);
  const mapPath = mappingIndex(files, directory), workflowIds = new Map([[sourceWorkflowId, targetWorkflowId]]), generated = new Set([targetWorkflowId]);
  const sourceAttachments = input.attachments ? normalizeAttachmentRegistry(input.attachments, sourceWorkflowId) : { version: 1, workflowId: sourceWorkflowId, entries: [], operations: [] };
  const attachments = input.attachments ? { ...normalizeAttachmentRegistry(sourceAttachments, targetWorkflowId), operations: [] } : null;
  for (const entry of attachments?.entries || []) { if (generated.has(entry.id)) fail('导入的素材 ID 必须唯一。'); generated.add(entry.id); }
  const sourceIds = new Set([sourceWorkflowId]);
  const reserveIds = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string' && (key === 'id' || key.endsWith('Id'))) sourceIds.add(item);
      else if (item && typeof item === 'object') reserveIds(item);
    }
  };
  // Reserve every original identity before generating any replacement, including
  // later chat turns and nested attempts. A caller-supplied factory must not alias.
  reserveIds({ document: sourceDocument, conversation, runs: sourceRuns, fileRuns: sourceFileRuns, artifacts: sourceArtifacts, attachments: sourceAttachments });
  if (sourceIds.has(targetWorkflowId)) fail('导入的工作流 ID 不能复用源编号。');
  const generate = prefix => {
    const value = idFactory ? idFactory(prefix) : prefix === 'artifact' ? randomUUID() : `${prefix}-${randomUUID()}`;
    identifier(value); if (prefix === 'artifact' && !UUID.test(value)) fail('新产物 ID 必须使用 UUID。');
    if (generated.has(value) || sourceIds.has(value)) fail('导入生成的 ID 必须唯一且不能复用源编号。'); generated.add(value); return value;
  };
  const originalRuns = new Map();
  for (const row of sourceRuns) {
    if (!row || typeof row !== 'object' || originalRuns.has(identifier(row.id))) fail('工作流包运行 ID 重复或无效。');
    identifier(row.workflowId); if (!STATUSES.has(row.status)) fail('工作流包运行状态无效。');
    originalRuns.set(row.id, row); sourceIds.add(row.id);
  }
  for (const row of sourceArtifacts) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) fail('工作流包产物记录格式无效。');
    identifier(row.id || row.artifactId); sourceIds.add(row.id || row.artifactId);
  }
  if (sourceFileRuns.some(row => !row || typeof row !== 'object' || Array.isArray(row))) fail('工作流包文件运行记录格式无效。');
  const ignored = new Set(sourceRuns.filter(row => row.learningId || row.memoryScopeId || row.document?.mode === 'learn').map(row => row.id));
  for (let changed = true; changed;) { changed = false; for (const row of sourceRuns) if (ignored.has(row.parentRunId) && !ignored.has(row.id)) { ignored.add(row.id); changed = true; } }
  if (ignored.size) warnings.add('学习样例运行只保留原始文件，不恢复到可执行运行索引。');
  const rows = sourceRuns.filter(row => !ignored.has(row.id)), runIds = new Map(rows.map(row => [row.id, generate('run')]));
  let graphCount = 0;
  const discover = (graph, depth = 0) => {
    if (depth > 8 || ++graphCount > 10000) fail('工作流包嵌入流程数量或层级超过上限。', 413);
    sourceIds.add(graph.id);
    if (!workflowIds.has(graph.id)) workflowIds.set(graph.id, generate('workflow'));
    for (const node of graph.nodes) if (node.config.document) discover(node.config.document, depth + 1);
  };
  discover(document);
  // Historical root snapshots can contain an embedded graph removed later.
  for (const row of rows.filter(row => row.workflowId === sourceWorkflowId)) {
    const graph = cleanDocument(row.document); if (graph.id !== row.workflowId) fail('运行与冻结流程身份不一致。'); discover(graph);
  }
  for (const row of rows) {
    const visited = new Set(); let current = row;
    while (current.parentRunId) {
      if (visited.has(current.id)) fail('工作流包父子运行存在循环。'); visited.add(current.id);
      const parent = originalRuns.get(current.parentRunId);
      if (!parent || !runIds.has(parent.id)) fail('工作流包父运行不属于当前包。'); current = parent;
    }
    if (current.workflowId !== sourceWorkflowId) fail('工作流包运行跨越主工作流范围。');
  }
  // Only graphs declared by already-owned frozen parents extend the scope.
  for (let index = 0; index <= rows.length; index++) {
    let changed = false;
    for (const row of rows) if (workflowIds.has(row.workflowId)) {
      const graph = cleanDocument(row.document); if (graph.id !== row.workflowId) fail('运行与冻结流程身份不一致。');
      const before = workflowIds.size; discover(graph); changed ||= before !== workflowIds.size;
    }
    if (!changed) break;
  }
  for (const row of rows) {
    if (!workflowIds.has(row.workflowId)) fail('工作流包子运行没有对应的嵌入流程。');
    if (row.parentRunId) {
      const parent = cleanDocument(originalRuns.get(row.parentRunId).document);
      if (!parent.nodes.some(node => node.config.document?.id === row.workflowId || node.config.workflowRef === row.workflowId)) fail('工作流包子运行不属于其冻结父流程。');
    }
  }
  const rebase = (value, options = {}) => {
    if (typeof value !== 'string' || !value) return value;
    const mapped = mapPath(value, options); if (mapped) return mapped.target;
    if (options.required) fail('工作流包产物缺少匹配的文件与哈希映射。');
    warnings.add('未打包或无法唯一绑定的资料路径已清空，请在新工作流中重新选择。'); return '';
  };
  const transformDocument = (source, depth = 0) => {
    if (depth > 8) fail('工作流包嵌入流程层级超过上限。', 413);
    const next = cleanDocument(source); if (!workflowIds.has(next.id)) fail('冻结流程不在工作流包范围内。'); next.id = workflowIds.get(next.id);
    if (next.settings) next.settings.outputDirectory = '';
    for (const node of next.nodes) {
      if (node.config.path) node.config.path = rebase(node.config.path, { folder: node.config.sourceKind === 'folder' });
      if (node.config.document) node.config.document = transformDocument(node.config.document, depth + 1);
      if (node.config.workflowRef) {
        if (workflowIds.has(node.config.workflowRef)) node.config.workflowRef = workflowIds.get(node.config.workflowRef);
        else { node.config.workflowRef = ''; warnings.add('未打包的子流程引用已清空，请重新选择对应流程。'); }
      }
      if (node.type !== 'input') continue;
      const fields = workflowInputFields(node), material = field => ['file', 'folder', 'image'].includes(field.kind);
      if (Object.hasOwn(node.config, 'defaultValue')) {
        const value = node.config.defaultValue;
        if (fields.length === 1 && material(fields[0]) && (typeof value !== 'object' || value === null || Array.isArray(value))) {
          node.config.defaultValue = typeof value === 'string' ? rebase(value, { folder: fields[0].kind === 'folder' }) : value;
        } else if (value && typeof value === 'object' && !Array.isArray(value)) {
          for (const field of fields.filter(material)) if (typeof value[field.key] === 'string') value[field.key] = rebase(value[field.key], { folder: field.kind === 'folder' });
        } else if (typeof value === 'string') {
          const mapped = mapPath(value); if (mapped) node.config.defaultValue = mapped.target;
          else if (['fileRef', 'folderRef', 'image'].includes(node.config.outputType) && sourcePath(value)) node.config.defaultValue = rebase(value);
        }
      }
    }
    return cleanDocument(next);
  };
  const importedDocument = transformDocument(document), artifactIds = new Map(), artifactsBySource = new Map();
  for (const row of sourceArtifacts) {
    const oldId = row.id || row.artifactId;
    if (ignored.has(row.runId)) continue;
    if (artifactIds.has(oldId) || !runIds.has(row.runId) || row.id && row.artifactId && row.id !== row.artifactId) fail('工作流包产物身份或运行归属无效。');
    if (!HASH.test(row.sha256 || '') || !Number.isSafeInteger(row.size) || row.size < 0) fail('工作流包产物哈希或大小无效。');
    const owner = originalRuns.get(row.runId), graph = cleanDocument(owner.document);
    if (!graph.nodes.some(node => node.id === row.nodeId) || !Number.isSafeInteger(row.attempt) || row.attempt < 1) fail('工作流包产物节点或尝试版本无效。');
    const mapped = mapPath(row.path, { sha256: row.sha256, runId: row.runId, folder: false, exact: true });
    if (!mapped || mapped.sha256 !== row.sha256 || mapped.size !== undefined && mapped.size !== row.size) fail('工作流包产物缺少匹配的文件与哈希映射。');
    artifactIds.set(oldId, generate('artifact')); artifactsBySource.set(oldId, row);
  }
  const attemptIds = new Map(), convertedArtifacts = new Map();
  const idReference = (value, table, label) => { if (!table.has(value)) fail(`工作流包${label}引用不属于当前包。`); return table.get(value); };
  const rewrite = (value, context = {}, key = '') => {
    if (typeof value === 'string') {
      if (OPAQUE.has(key)) return value;
      if (['runId', 'parentRunId', 'childRunId'].includes(key)) return idReference(value, runIds, '运行');
      if (key === 'workflowId' || key === 'folderWorkflowId') return idReference(value, workflowIds, '工作流');
      if (['artifactId', 'manifestArtifactId'].includes(key)) return idReference(value, artifactIds, '产物');
      if (key === 'attemptId') { if (!attemptIds.has(value)) attemptIds.set(value, generate('attempt')); return attemptIds.get(value); }
      if (key === 'previewUrl' || key === 'downloadUrl') {
        const matched = value.match(/^\/api\/workflow-v2\/artifacts\/([A-Za-z0-9_-]+)(?:\?download=1)?$/);
        if (matched) return '/api/workflow-v2/artifacts/' + idReference(matched[1], artifactIds, '产物') + (key === 'downloadUrl' ? '?download=1' : '');
      }
      if (PATHS.has(key)) return rebase(value, { ...context, folder: key !== 'path' && !key.endsWith('Path') || context.kind === 'folder' });
      const mapped = mapPath(value, context); return mapped ? mapped.target : value;
    }
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(item => rewrite(item, context, key));
    const scoped = { ...context, ...(value.runId ? { runId: value.runId } : {}), ...(value.sha256 ? { sha256: value.sha256 } : {}), ...(value.kind ? { kind: value.kind } : {}) };
    if ((value.artifactId || value.id && artifactsBySource.has(value.id)) && key !== 'artifact-record') {
      const oldId = value.artifactId || value.id;
      if (!artifactIds.has(oldId)) fail('工作流包产物引用缺少登记。');
      const record = artifactsBySource.get(oldId);
      if (value.sha256 && value.sha256 !== record.sha256 || value.runId && value.runId !== record.runId) fail('工作流包产物引用与登记不一致。');
    }
    const result = {};
    for (const [field, item] of Object.entries(value)) {
      if (CONTROL.has(field) || field === 'privateValue') continue;
      if (field === 'id' && artifactIds.has(item)) result[field] = artifactIds.get(item);
      else result[field] = rewrite(item, scoped, field);
    }
    return result;
  };
  for (const [oldId, source] of artifactsBySource) {
    const value = rewrite(source, { runId: source.runId }, 'artifact-record');
    value.id = value.artifactId = artifactIds.get(oldId);
    value.path = rebase(source.path, { sha256: source.sha256, runId: source.runId, folder: false, exact: true, required: true });
    value.previewUrl = '/api/workflow-v2/artifacts/' + value.id; value.downloadUrl = value.previewUrl + '?download=1';
    convertedArtifacts.set(oldId, value);
  }
  const transformNode = (node, context) => {
    if (!node || typeof node !== 'object' || Array.isArray(node) || !STATUSES.has(node.status)) fail('工作流包节点运行记录格式无效。');
    const result = rewrite(node, context);
    if (ACTIVE.has(node.status)) result.status = node.status === 'pending' ? 'skipped' : 'interrupted';
    if (result.review) { result.review.originalDecision = result.review.decision || null; result.review.decision = 'imported'; }
    if (result.subflowProgress && ACTIVE.has(result.subflowProgress.status)) result.subflowProgress.status = 'interrupted';
    if (node.history !== undefined) {
      if (!Array.isArray(node.history) || node.history.length > 10000) fail('工作流包节点历史数量无效。');
      result.history = node.history.map(item => transformNode(item, context));
    }
    return result;
  };
  const runOutputRoots = new Map();
  for (const source of rows) {
    if (source.folderWorkflowId && source.folderWorkflowId !== sourceWorkflowId) fail('工作流包运行文件夹归属跨越主工作流。');
    const mapped = mapPath(source.outputDirectory, { runId: source.id, folder: true, exact: true });
    const first = mapped && relative(directory, mapped.target).split(sep)[0];
    const outputRoot = mapped && ['runs', 'outputs'].includes(first) ? mapped.target : join(directory, 'runs', runIds.get(source.id), 'files');
    for (const artifact of convertedArtifacts.values()) if (artifact.runId === runIds.get(source.id) && !inside(outputRoot, artifact.path)) fail('工作流包产物缺少对应运行目录映射。');
    runOutputRoots.set(source.id, outputRoot);
  }
  const importedRuns = rows.map(source => {
    const { document: frozen, nodes, ...metadata } = source;
    if (!nodes || typeof nodes !== 'object' || Array.isArray(nodes)) fail('工作流包运行节点记录格式无效。');
    const result = rewrite(metadata, { runId: source.id });
    result.id = runIds.get(source.id); result.workflowId = workflowIds.get(source.workflowId); result.document = transformDocument(frozen);
    result.nodes = Object.fromEntries(Object.entries(nodes).map(([id, record]) => {
      if (!result.document.nodes.some(node => node.id === id)) fail('工作流包运行节点不属于冻结流程。');
      return [id, transformNode(record, { runId: source.id })];
    }));
    result.importedArchive = true; result.sourceRunId = source.id; result.originalStatus = source.status; result.folderWorkflowId = targetWorkflowId;
    result.status = source.status === 'complete' || source.status === 'completed' ? source.status : 'interrupted';
    result.activeNodeIds = []; result.currentNodeId = null;
    if (result.delivery && ACTIVE.has(result.delivery.status)) result.delivery.status = 'interrupted';
    result.outputDirectory = runOutputRoots.get(source.id);
    const containNodeOutput = (nodeId, record) => {
      if (!record.outputDirectory || !inside(result.outputDirectory, record.outputDirectory)) record.outputDirectory = join(result.outputDirectory, nodeId, '版本-' + (record.attempt || 1));
      for (const historical of record.history || []) containNodeOutput(nodeId, historical);
    };
    for (const [nodeId, record] of Object.entries(result.nodes)) {
      containNodeOutput(nodeId, record);
    }
    if (result.settings) result.settings.outputDirectory = '';
    return result;
  });
  const fileRuns = sourceFileRuns.filter(row => !ignored.has(row.runId || row.id)).map(source => {
    const oldRunId = source.runId || source.id; if (!runIds.has(oldRunId)) fail('工作流包文件运行记录没有对应运行。');
    const result = rewrite(source, { runId: oldRunId });
    if (source.id === oldRunId) result.id = runIds.get(oldRunId);
    result.runId = runIds.get(oldRunId); result.workflowId = workflowIds.get(originalRuns.get(oldRunId).workflowId);
    result.outputDirectory = runOutputRoots.get(oldRunId); result.importedArchive = true;
    if (result.manifest) result.manifest.sha256 = digest(result.manifest.entries || []);
    return result;
  });
  let chat = conversation?.conversation || conversation || { turns: [] };
  if (Array.isArray(chat)) chat = { turns: chat };
  if (!chat || typeof chat !== 'object' || !Array.isArray(chat.turns) || chat.turns.length > 50000 || chat.workflowId && chat.workflowId !== sourceWorkflowId
    || chat.version !== undefined && chat.version !== 1) fail('工作流包聊天记录格式或归属无效。');
  if (chat.turns.length * (Buffer.byteLength(JSON.stringify(importedDocument)) + 256) > MAX_RECORD_BYTES) fail('工作流包聊天恢复后的索引超过大小上限。', 413);
  const historicalProgress = new Map();
  if (input.conversationContext !== undefined) {
    if (!Number.isSafeInteger(chat.revision) || chat.revision < 0) fail('工作流包聊天上下文缺少有效版本。');
    validateConversationContext(input.conversationContext, { version: 1, workflowId: sourceWorkflowId, revision: chat.revision, turns: chat.turns });
    const knownTurns = new Set(chat.turns.map(turn => turn?.id));
    for (const row of input.conversationContext.diagnosticProgress) {
      if (!knownTurns.has(row.sourceTurnId)) fail('工作流包聊天诊断进度不属于当前会话。');
      const entries = historicalProgress.get(row.sourceTurnId) || [];
      entries.push({ stage: row.stage, label: row.label, status: row.status }); historicalProgress.set(row.sourceTurnId, entries);
    }
  }
  const turnIds = new Set(), clientIds = new Set();
  const turns = chat.turns.map(source => {
    if (!source || typeof source !== 'object' || source.workflowId && source.workflowId !== sourceWorkflowId || typeof source.user?.text !== 'string'
      || typeof source.assistant?.text !== 'string' || turnIds.has(identifier(source.id)) || clientIds.has(identifier(source.clientMessageId))) fail('工作流包聊天轮次格式或归属无效。');
    turnIds.add(source.id); clientIds.add(source.clientMessageId); sourceIds.add(source.id); sourceIds.add(source.clientMessageId);
    const turn = { id: generate('turn'), workflowId: targetWorkflowId, clientMessageId: generate('message'), status: 'complete', actions: [],
      user: { text: source.user.text, ...(typeof source.user.intent === 'string' ? { intent: source.user.intent } : {}), context: {},
        ...(source.user.attachments !== undefined ? { attachments: attachmentEntries(sourceAttachments, source.user.attachments, sourceWorkflowId).map(entry => {
          const target = attachments?.entries.find(item => item.aliases.includes(entry.id));
          if (!target) fail('聊天素材引用没有对应的导入登记。');
          return attachmentMetadata(targetWorkflowId, target, directory);
        }) } : {}) },
      assistant: { text: source.assistant.text }, importedArchive: true, sourceTurnId: source.id, originalStatus: source.originalStatus || source.status || 'complete',
      ...(source.createdAt ? { createdAt: source.createdAt } : {}), ...(source.updatedAt ? { updatedAt: source.updatedAt } : {}) };
    if (historicalProgress.has(source.id)) turn.assistant.historicalProgress = historicalProgress.get(source.id).map(row => ({ ...row, sourceTurnId: turn.id }));
    return { turn, privateValue: { document: importedDocument, automatic: true, imported: true,
      requestDigest: digest({ sourceTurnId: source.id, targetWorkflowId, turnId: turn.id, text: turn.user.text, attachments: turn.user.attachments || [] }) } };
  });
  return { document: importedDocument, turns, runs: importedRuns, fileRuns, artifacts: [...convertedArtifacts.values()], warnings: [...warnings], ...(attachments ? { attachments } : {}) };
}
