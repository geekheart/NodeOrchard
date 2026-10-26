import { workflowInputFields, workflowInputValue } from './workflow-inputs.mjs';
// Pure presentation helpers. A diagram's position never determines execution.
export const STUDIO_STATUS = Object.freeze({ queued: '排队中', preparing: '准备中', pending: '待依赖', ready: '就绪', running: '运行中', waiting_resource: '等待资源', waiting: '待处理', waiting_review: '待审核', complete: '已完成', error: '失败', blocked: '被阻断', skipped: '已跳过', cancelled: '已取消', interrupted: '已停止', unknown: '待确认' });
export const FIELD_KINDS = Object.freeze([['file', '文件'], ['folder', '文件夹'], ['image', '图片'], ['text', '文本'], ['number', '数字']]);
const BOARD_SOURCE_FIELD = { key: 'sourcePath', label: '原始 EPRO2 工程', kind: 'file', required: true, extensions: ['.epro2'], role: 'source' };
const RELEASE_FIELDS = [{ key: 'productCode', label: '产品型号', kind: 'text', required: true }, { key: 'hardwareVersion', label: '硬件版本', kind: 'text', required: true }, { key: 'releaseDate', label: '发布日期 YYYY-MM-DD', kind: 'text', required: true }];
export const INPUT_FIELD_PRESETS = Object.freeze([
  { label: '板卡资料字段', fields: [BOARD_SOURCE_FIELD, { key: 'frontImage', label: '正面实拍图', kind: 'image', required: true, extensions: ['.png', '.jpg', '.jpeg'], role: 'front' }, { key: 'backImage', label: '背面实拍图', kind: 'image', required: true, extensions: ['.png', '.jpg', '.jpeg'], role: 'back' }, { key: 'pinoutPhotoProfilePath', label: '已审核照片校准', kind: 'file', required: true, extensions: ['.json'], role: 'calibration' }, ...RELEASE_FIELDS] },
  { label: '使用指南资料字段', fields: [BOARD_SOURCE_FIELD, { key: 'frontImage', label: '正面实拍图', kind: 'image', required: true, extensions: ['.png'], role: 'front' }, { key: 'backImage', label: '背面实拍图', kind: 'image', required: true, extensions: ['.png'], role: 'back' }, { key: 'guideProfilePath', label: '已核验指南标注配置', kind: 'file', required: true, extensions: ['.json'], role: 'guideProfile' }, { key: 'fourFilesDirectory', label: '已审核四文件资料目录', kind: 'folder', required: true, role: 'fourFiles' }, ...RELEASE_FIELDS] },
  { label: '完整HDK资料字段', fields: [BOARD_SOURCE_FIELD, { key: 'profilePath', label: '已核验 HDK 发布与测试配置', kind: 'file', required: true, extensions: ['.json'], role: 'hdkProfile' }, ...RELEASE_FIELDS] },
]);
export function mergeInputFields(existing = [], preset = []) {
  const keys = new Set(existing.map(field => field.key));
  return structuredClone([...existing, ...preset.filter(field => !keys.has(field.key))]);
}
export const isV2 = document => document?.schemaVersion === 2;
export function inputEntries(document) { return (document?.nodes || []).filter(node => node.type === 'input').flatMap(node => workflowInputFields(node).map(field => ({ node, field }))); }
export function structuredInput(document, values) {
  const inputs = (document?.nodes || []).filter(node => node.type === 'input');
  if (inputs.length === 1) return { ...(values[inputs[0].id] || {}) };
  return Object.fromEntries(inputs.map(node => [node.config.fieldName || node.id, { ...(values[node.id] || {}) }]));
}
export function valuesFromInput(document, input) {
  const inputs = (document?.nodes || []).filter(node => node.type === 'input');
  return Object.fromEntries(inputs.map(node => { const value = workflowInputValue(document, input, node); return [node.id, { ...(value && typeof value === 'object' && !Array.isArray(value) ? value : {}) }]; }));
}
export function portCompatible(a, b) { return a === b || a === 'any' || b === 'any'; }
export function layoutPositions(document, sizes = new Map()) {
  const nodes = document.nodes || [], ids = new Set(nodes.map(node => node.id));
  const level = new Map(nodes.map(node => [node.id, 0]));
  // Bounded relaxation gives stable levels for the model's acyclic graphs.
  for (let i = 0; i < nodes.length; i++) for (const edge of document.edges || []) if (ids.has(edge.sourceNode) && ids.has(edge.targetNode)) level.set(edge.targetNode, Math.max(level.get(edge.targetNode), level.get(edge.sourceNode) + 1));
  const rows = new Map(), nextRowY = new Map(), positions = new Map(); let businessBottom = 0;
  for (const node of nodes.filter(node => !['evaluation', 'improvement'].includes(node.type))) {
    const column = level.get(node.id), y = nextRowY.get(column) ?? 80, measuredHeight = sizes.get(node.id)?.height;
    const height = Number.isFinite(measuredHeight) && measuredHeight > 0 ? measuredHeight : 180;
    rows.set(column, (rows.get(column) || 0) + 1); positions.set(node.id, { x: 64 + column * 340, y });
    nextRowY.set(column, y + Math.max(310, height + 48)); businessBottom = Math.max(businessBottom, y + height);
  }
  const learningY = Math.max(160 + Math.max(1, ...rows.values()) * 310, businessBottom + 80);
  const learningColumns = new Set(), learning = nodes.filter(node => ['evaluation', 'improvement'].includes(node.type)).sort((a, b) => Number(a.type === 'improvement') - Number(b.type === 'improvement'));
  for (const node of learning) { let column = level.get(node.id); while (learningColumns.has(column)) column++; learningColumns.add(column); positions.set(node.id, { x: 64 + column * 340, y: learningY }); }
  return positions;
}
export function runArtifacts(run) {
  const items = [...(run?.artifacts || []), ...Object.values(run?.nodes || {}).flatMap(node => node.artifacts || [])], seen = new Set(), content = new Map(), result = [];
  const order = new Map((run?.nodeOrder || []).map((id, index) => [id, index]));
  const later = (candidate, previous) => (order.get(candidate.nodeId) ?? -1) > (order.get(previous.nodeId) ?? -1)
    || ((order.get(candidate.nodeId) ?? -1) === (order.get(previous.nodeId) ?? -1) && (candidate.attempt || 0) > (previous.attempt || 0));
  for (const item of items) {
    const id = item?.id || item?.artifactId; if (!id || seen.has(id)) continue; seen.add(id);
    const name = typeof item.name === 'string' && item.name ? item.name : typeof item.path === 'string' ? item.path : '', basename = name.split(/[\\/]/).at(-1), sha = typeof item.sha256 === 'string' ? item.sha256.trim().toLowerCase() : '';
    const key = basename && /^[a-f0-9]{64}$/.test(sha) ? `${basename}\0${sha}` : null;
    if (key && content.has(key)) { const index = content.get(key); if (later(item, result[index])) result[index] = item; }
    else { if (key) content.set(key, result.length); result.push(item); }
  }
  return result;
}
export function orderedNodeStates(run) { const ids = [...new Set([...(run?.nodeOrder || []), ...Object.keys(run?.nodes || {})])]; return ids.filter(id => run.nodes[id]).map(id => [id, run.nodes[id]]); }
export function reviewTargetNodes(document, nodeId) {
  const business = (document?.nodes || []).filter(node => !['evaluation', 'improvement'].includes(node.type)), ids = new Set(business.map(node => node.id)), ancestors = new Set(), pending = [nodeId];
  while (pending.length) { const id = pending.pop(); for (const edge of document?.edges || []) if (edge.targetNode === id && ids.has(edge.sourceNode) && !ancestors.has(edge.sourceNode)) { ancestors.add(edge.sourceNode); pending.push(edge.sourceNode); } }
  return business.filter(node => node.id !== nodeId && ancestors.has(node.id) && ['skill', 'tool', 'transform', 'subflow'].includes(node.type));
}
export function manifestSourceCount(manifest) {
  const entries = Array.isArray(manifest) ? manifest : manifest?.entries || [];
  return entries.reduce((total, entry) => {
    if (typeof entry.path !== 'string' || !entry.path) return total;
    if (['file', 'image'].includes(entry.kind)) return total + 1;
    return total + (entry.kind === 'folder' && Array.isArray(entry.files) ? entry.files.filter(file => typeof file.path === 'string' && file.path).length : 0);
  }, 0);
}
const artifactName = item => String(item.name || item.label || item.path?.split('/').at(-1) || '');
const imageArtifact = item => /^image\//.test(item.mimeType || '') || /\.(png|jpe?g|webp|gif|svg)$/i.test(artifactName(item));
const sourceArtifact = item => /^(photooriginal|photocalibration|source|input|reference|original)(?:$|[-_])/i.test(item.role || '') || item.role === 'photoOriginal' || item.role === 'photoCalibration';
const artifactStem = item => [item.nodeId || '', item.attempt || '', artifactName(item).replace(/\.[^.]+$/, '').toLowerCase()].join(':');
export function groupArtifacts(items) {
  const groups = { images: [], sources: [], other: [], advanced: [] };
  const png = new Set(items.filter(item => /\.png$/i.test(artifactName(item))).map(artifactStem));
  for (const item of items) {
    if (sourceArtifact(item)) groups.sources.push(item);
    else if (/\.json$/i.test(artifactName(item)) || item.mimeType === 'application/json' || (/\.svg$/i.test(artifactName(item)) && png.has(artifactStem(item)))) groups.advanced.push(item);
    else groups[imageArtifact(item) ? 'images' : 'other'].push(item);
  }
  return groups;
}
export function reviewTargetArtifacts(run, nodeId) {
  const items = run?.nodes?.[nodeId]?.artifacts || [], candidates = items.filter(item => imageArtifact(item) && !sourceArtifact(item));
  const distance = new Map([[nodeId, 0]]), pending = [nodeId];
  while (pending.length) { const id = pending.shift(); for (const edge of run.document?.edges || []) if (edge.targetNode === id && !distance.has(edge.sourceNode)) { distance.set(edge.sourceNode, distance.get(id) + 1); pending.push(edge.sourceNode); } }
  const nearest = Math.min(...candidates.map(item => distance.get(item.nodeId) ?? Infinity));
  const selected = Number.isFinite(nearest) ? candidates.filter(item => distance.get(item.nodeId) === nearest) : candidates;
  const png = new Set(selected.filter(item => /\.png$/i.test(artifactName(item))).map(artifactStem));
  return selected.filter(item => !(/\.svg$/i.test(artifactName(item)) && png.has(artifactStem(item))));
}
export function nodeThumbnailArtifact(run, nodeId) {
  const node = run?.document?.nodes?.find(node => node.id === nodeId), state = run?.nodes?.[nodeId]; if (!node || !state) return null;
  const items = ['human', 'merge', 'output'].includes(node.type) ? reviewTargetArtifacts(run, nodeId) : (state.artifacts || []).filter(item => item.nodeId === nodeId && (state.attempt === undefined || item.attempt === state.attempt) && imageArtifact(item) && !sourceArtifact(item));
  return items.find(item => item.previewUrl && /\.png$/i.test(artifactName(item))) || items.find(item => item.previewUrl) || null;
}
export function canRerunNode(run, nodeId) {
  const node = run?.document?.nodes?.find(node => node.id === nodeId), state = run?.nodes?.[nodeId];
  if (run?.document?.schemaVersion !== 2 || !node || !state || node.type === 'input') return false;
  if (['complete', 'error', 'interrupted', 'unknown'].includes(run.status)) return true;
  return run.status === 'waiting_review' && ['skill', 'tool', 'transform', 'subflow', 'foreach', 'loop'].includes(node.type)
    && !['running', 'preparing', 'waiting_review'].includes(state.status)
    && !Object.values(run.nodes || {}).some(record => ['running', 'preparing'].includes(record.status));
}
export function nodeInspectionVersions(record) {
  if (!record) return [];
  const label = (value, fallback) => `第 ${value.attempt || fallback} 次 · ${STUDIO_STATUS[value.status] || value.status || '未记录状态'}`;
  return [{ key: 'current', historical: false, record, label: `当前 · ${label(record, 1)}` }, ...(record.history || []).map((value, index) => ({ key: `history-${index}`, historical: true, record: value, label: `历史 · ${label(value, index + 1)}` })).reverse()];
}
export function shortVersion(version) { return /^sha256:[a-f0-9]{64}$/i.test(version || '') ? version.slice(7, 15) : version || ''; }
export function vacantNodePosition(nodes, preferred, sizes = new Map()) {
  const collides = point => nodes.some(node => { const size = sizes.get(node.id) || { width: 270, height: 180 }; return point.x < node.x + size.width + 24 && point.x + 270 + 24 > node.x && point.y < node.y + size.height + 24 && point.y + 180 + 24 > node.y; });
  if (!collides(preferred)) return preferred;
  for (let ring = 1; ring <= 30; ring++) for (const [dx, dy] of [[0, ring], [ring, 0], [-ring, 0], [0, -ring], [ring, ring], [-ring, ring], [ring, -ring], [-ring, -ring]]) { const point = { x: preferred.x + dx * 320, y: preferred.y + dy * 260 }; if (!collides(point)) return point; }
  return { x: preferred.x, y: preferred.y + 8000 };
}
