import { createNode, getPorts, connectNodes, validateDocument, updateNode, NODE_TYPES } from '../shared/workflow/workflow-model.mjs';
import { FIELD_KINDS, INPUT_FIELD_PRESETS, mergeInputFields, STUDIO_STATUS, isV2, inputEntries, structuredInput, valuesFromInput, portCompatible, layoutPositions, runArtifacts, shortVersion, reviewTargetArtifacts, groupArtifacts, orderedNodeStates, manifestSourceCount, canRerunNode, nodeInspectionVersions, reviewTargetNodes } from '../shared/workflow/workflow-studio-utils.mjs';
import { WORKFLOW_TOOLS } from '../shared/workflow/workflow-tools.mjs';

const element = (tag, cls = '', value) => { const item = document.createElement(tag); item.className = cls; if (value !== undefined) item.textContent = String(value); return item; };
const button = (label, handler, cls = 'wf-button') => { const item = element('button', cls, label); item.type = 'button'; item.addEventListener('click', handler); return item; };
const display = value => String(value === undefined ? '尚无数据' : typeof value === 'string' ? value : JSON.stringify(value, null, 2)).replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[已隐藏密钥]').replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [已隐藏]');
const active = status => ['queued', 'preparing', 'running', 'waiting', 'waiting_review'].includes(status);
const INPUT_STORAGE_PREFIX = 'workbench.workflow-inputs.v2:';
const RAW_INPUT_STORAGE_PREFIX = 'workbench.workflow-raw-input.v2:';
const pathField = field => ['file', 'folder', 'image'].includes(field.kind);
const pathName = value => typeof value === 'string' && value ? value.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || value : '尚未选择';

export function inlineInputFields(node) {
  const fields = inputEntries({ nodes: [node] }).map(entry => entry.field), paths = fields.filter(pathField);
  const visible = [...paths, ...fields.filter(field => !pathField(field)).slice(0, Math.max(0, 3 - paths.length))];
  return { visible, total: fields.length, remaining: fields.length - visible.length };
}

export function nodeShowsCanvasPreview(node) {
  if (node?.type === 'human') return true;
  if (node?.type === 'output') return node.config?.stage !== 'intermediate';
  if (!['skill', 'tool', 'transform', 'subflow', 'foreach', 'loop'].includes(node?.type)) return false;
  return node.config?.reviewImages === true || node.type === 'tool' && node.config?.executionMode === 'tool'
    && WORKFLOW_TOOLS.some(tool => tool.id === node.config.toolName && tool.reviewRequired);
}

// Preview only registered artifacts from the selected workflow's exact run and
// current producer attempt. A local path never becomes a preview URL.
export function nodePreviewArtifacts(run, workflowId, nodeId) {
  if (!run?.id || run.workflowId !== workflowId || run.document?.id !== workflowId) return [];
  const node = run.document.nodes?.find(item => item.id === nodeId), state = run.nodes?.[nodeId];
  if (!nodeShowsCanvasPreview(node) || !state) return [];
  const candidates = node.type === 'output' ? groupArtifacts(state.artifacts || []).images
    : node.type === 'human' ? reviewTargetArtifacts(run, nodeId)
      : groupArtifacts((state.artifacts || []).filter(item => item.nodeId === nodeId)).images;
  return runArtifacts({ nodeOrder: run.nodeOrder, artifacts: candidates.filter(item => {
    const id = item.id || item.artifactId, producer = run.nodes?.[item.nodeId];
    return typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id) && item.runId === run.id
      && /^[a-f0-9]{64}$/i.test(item.sha256 || '') && Number.isSafeInteger(item.attempt) && item.attempt > 0
      && producer?.attempt === item.attempt && run.document.nodes.some(definition => definition.id === item.nodeId)
      && item.previewUrl === `/api/workflow-v2/artifacts/${id}`;
  }) });
}

// The approval snapshot is authoritative when present. A pending gate has no
// approved hashes yet: show its direct receipt files separately from references.
export function reviewFileGroups(run, nodeId, pictures = []) {
  const state = run?.nodes?.[nodeId] || {}, items = state.artifacts || [], displayed = new Set(pictures.map(item => item.id || item.artifactId));
  const hashes = state.review?.artifactHashes, exact = Array.isArray(hashes), bound = new Set((hashes || []).map(item => `${item.id}\0${item.sha256}`)), producers = new Set();
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (['hdk-node-receipt', 'hdk-node-receipt-ref'].includes(value.kind) && value.runId === run.id && typeof value.nodeId === 'string') { producers.add(value.nodeId); return; }
    for (const child of Object.values(value)) visit(child);
  };
  if (!exact) visit(state.input);
  const current = [], references = [];
  for (const item of items) {
    if (displayed.has(item.id || item.artifactId)) continue;
    const included = exact ? bound.has(`${item.id || item.artifactId}\0${item.sha256}`) : producers.has(item.nodeId);
    (included ? current : references).push(item);
  }
  return { current, references, exact };
}

export function runProgress(run) {
  const states = orderedNodeStates(run), definitions = new Map((run.document?.nodes || []).map(node => [node.id, node]));
  const learning = id => ['evaluation', 'improvement'].includes(definitions.get(id)?.type), execute = run.document?.mode !== 'learn';
  const counted = execute ? states.filter(([id]) => !learning(id)) : states;
  return { completed: counted.filter(([, state]) => state.status === 'complete').length, total: counted.length,
    running: counted.filter(([, state]) => state.status === 'running').length,
    skippedLearning: execute ? states.filter(([id, state]) => learning(id) && state.status === 'skipped').length : 0 };
}

export function subflowRunIds(state) {
  return [...new Set([...(Array.isArray(state?.subflowProgress?.childRunIds) ? state.subflowProgress.childRunIds : []), state?.subflowProgress?.childRunId, state?.review?.childRunId].filter(value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)))];
}

export function assertChildRunBinding(parent, nodeId, state, child) {
  const definition = parent?.document?.nodes?.find(node => node.id === nodeId);
  if (!definition || !['subflow', 'foreach', 'loop'].includes(definition.type) || !child?.id || child.parentRunId !== parent.id || !subflowRunIds(state).includes(child.id)) throw new Error('子流程记录与此父运行、节点或尝试不匹配。');
  const workflowId = definition.config?.document?.id;
  if (workflowId && (child.workflowId !== workflowId || child.document?.id !== workflowId)) throw new Error('子流程执行快照与此组合节点不匹配。');
  return child;
}

// Show only the final receipt's own files, never the output node's inherited
// artifact collection. URLs remain the existing opaque artifact endpoints.
export function deliveryResults(run) {
  if (run?.status !== 'complete' || run.learningId || run.document?.mode === 'learn') return [];
  const definitions = run.document?.nodes || [], results = [], seen = new Set();
  for (const output of definitions.filter(node => node.type === 'output')) {
    const state = run.nodes?.[output.id], token = state?.output;
    if (state?.status !== 'complete' || token?.kind !== 'hdk-node-receipt' || token.runId !== run.id
      || !['hdk.full.verify', 'hdk.full.archive-delivery'].includes(token.operation) || token.status !== 'complete' || token.qualified !== true
      || !/^[a-f0-9]{64}$/.test(token.receiptSha256 || '')) continue;
    const producer = definitions.find(node => node.id === token.nodeId), current = run.nodes?.[token.nodeId];
    if (producer?.type !== 'tool' || producer.config?.executionMode !== 'tool' || producer.config?.toolName !== token.operation
      || !WORKFLOW_TOOLS.some(tool => tool.id === token.operation) || current?.status !== 'complete'
      || !Number.isSafeInteger(current.attempt) || current.attempt < 1 || typeof current.attemptId !== 'string' || !current.attemptId
      || !/^[A-Za-z0-9_-]+$/.test(token.nodeId) || typeof run.outputDirectory !== 'string'
      || current.outputDirectory !== `${run.outputDirectory}/${token.nodeId}/版本-${current.attempt}`
      || token.receiptPath !== `${current.outputDirectory}/receipt.json`
      || JSON.stringify(current.output) !== JSON.stringify(token) || !Array.isArray(token.artifacts) || token.artifacts.length < 2 || token.artifacts.length > 64) continue;
    const artifacts = []; let valid = true;
    for (const reference of token.artifacts) {
      if (!reference || typeof reference !== 'object' || typeof reference.path !== 'string' || !reference.path.startsWith(current.outputDirectory + '/')
        || reference.path.split('/').some(part => part === '.' || part === '..') || !/^[a-f0-9]{64}$/.test(reference.sha256 || '')) { valid = false; break; }
      const matches = (Array.isArray(current.artifacts) ? current.artifacts : []).filter(item => item.runId === run.id && item.nodeId === producer.id && item.attempt === current.attempt
        && item.path === reference.path && item.sha256 === reference.sha256 && typeof (item.id || item.artifactId) === 'string');
      const item = matches[0], id = item?.id || item?.artifactId, endpoint = id ? `/api/workflow-v2/artifacts/${encodeURIComponent(id)}` : '';
      if (!item || item.previewUrl !== endpoint || item.downloadUrl !== endpoint + '?download=1') { valid = false; break; }
      artifacts.push(item);
    }
    if (!valid || !artifacts.some(item => item.role === 'full-hdk-delivery' && /\.zip$/i.test(item.path))
      || !artifacts.some(item => ['full-hdk-verification', 'archive-verification'].includes(item.role) && /\.json$/i.test(item.path))) continue;
    const key = `${token.nodeId}:${token.receiptSha256}`; if (seen.has(key)) continue; seen.add(key);
    results.push({ output, producer, token, artifacts });
  }
  return results;
}

export class WorkflowStudioUI {
  constructor(editor) {
    this.editor = editor; this.view = 'edit'; this.tab = 'nodes'; this.values = {}; this.inputsFor = null; this.runtime = null; this.reviewDrafts = new Map(); this.delegatedRuns = new Map();
    this.mount(); this.syncDocument();
  }
  mount() {
    const editor = this.editor;
    this.viewSwitch = element('div', 'wf-mode wf-view-switch'); this.viewSwitch.setAttribute('aria-label', '编辑或运行视图');
    this.viewSwitch.append(button('编辑', () => this.setView('edit')), button('运行', () => this.setView('run')));
    editor.root.querySelector('.wf-header-actions').prepend(this.viewSwitch);
    this.check = button('检查输入', () => void this.preflight()); editor.root.querySelector('.wf-header-actions').append(this.check);
    this.upgrade = button('升级为并行工作流', () => this.upgradeDocument()); editor.root.querySelector('.wf-header-actions').append(this.upgrade);
    const toolbar = editor.root.querySelector('.wf-canvas-toolbar'); toolbar.append(button('自动布局', () => this.autoLayout(), 'wf-button wf-studio-small'));
    this.tabs = element('div', 'wf-studio-tabs');
    for (const [id, label] of [['nodes', '节点库'], ['inputs', '输入资料'], ['queue', '任务队列']]) { const item = button(label, () => this.setTab(id)); item.dataset.studioTab = id; this.tabs.append(item); }
    const library = editor.root.querySelector('.wf-library'); library.prepend(this.tabs);
    this.inputs = element('div', 'wf-studio-inputs'); this.queue = element('div', 'wf-studio-queue'); library.append(this.inputs, this.queue);
    this.inputNotice = element('p', 'wf-studio-notice'); this.inputNotice.setAttribute('role', 'status');
    this.runSurface = element('section', 'wf-studio-run-surface'); this.runSurface.setAttribute('aria-label', '本次运行概览'); editor.root.querySelector('.wf-center').append(this.runSurface);
    this.fileDialog = element('dialog', 'wf-dialog wf-studio-file-dialog'); this.fileDialog.setAttribute('aria-label', '选择工作流文件或文件夹'); editor.root.append(this.fileDialog);
    this.fileDialog.addEventListener('keydown', event => event.stopPropagation());
    this.setView('edit'); this.setTab('nodes');
  }
  attachRuntime(runtime) { this.runtime = runtime; if (!inputEntries(this.editor.doc).length && this.rawInputDocumentId === this.editor.doc.id) runtime.input.value = this.rawInputValue || ''; if (this.rawInputControl !== runtime.input) { this.rawInputControl?.removeEventListener?.('input', this.rawInputChanged); this.rawInputControl = runtime.input; this.rawInputChanged = () => { this.invalidatePreflight(); if (!inputEntries(this.editor.doc).length) { this.rawInputValue = runtime.input.value; if (this.rawPreparationInput && document.activeElement !== this.rawPreparationInput) this.rawPreparationInput.value = runtime.input.value; try { localStorage.setItem(RAW_INPUT_STORAGE_PREFIX + this.editor.doc.id, runtime.input.value); } catch { /* The current raw input is still available in memory. */ } } }; runtime.input?.addEventListener?.('input', this.rawInputChanged); } this.syncDocument(); this.renderInputs(); this.renderRuntime(); void this.editor.nodeLibrary?.refresh(); }
  api(path, options) { if (!this.runtime) return Promise.reject(new Error('运行服务尚未就绪，请稍后再试。')); return this.runtime.api(path, options); }
  inputDefinitionSignature(doc = this.editor.doc) { return JSON.stringify([doc.id, doc.schemaVersion, doc.nodes.filter(node => node.type === 'input').map(node => [node.id, node.config])]); }
  preflightDocumentSignature(doc = this.editor.doc) { return JSON.stringify([this.inputDefinitionSignature(doc), doc.settings || {}]); }
  preflightDraftSignature() { return JSON.stringify([this.preflightDocumentSignature(), this.values || {}, inputEntries(this.editor.doc).length ? null : this.runtime?.input?.value, this.outputDirectoryInput?.isConnected ? this.outputDirectoryInput.value.trim() : null]); }
  invalidatePreflight() {
    this.preflightRequest = (this.preflightRequest || 0) + 1; this.preflightResult = null;
    if (this.inputNotice) this.showInputNotice('', false);
    for (const error of this.inputs?.querySelectorAll('.wf-studio-input-error') || []) error.remove();
    if (this.check) this.check.disabled = false;
    return this.preflightRequest;
  }
  syncDocument() {
    const doc = this.editor.doc, changedDocument = this.inputsFor !== doc.id, definition = this.inputDefinitionSignature(doc), settings = JSON.stringify(doc.settings || {});
    if (changedDocument || this.inputSignature !== definition || this.preflightSettingsSignature !== settings) this.invalidatePreflight();
    this.preflightSettingsSignature = settings;
    if (changedDocument) { this.inputsFor = doc.id; this.values = {}; try { const raw = localStorage.getItem(INPUT_STORAGE_PREFIX + doc.id); if (raw && raw.length <= 262144) { const saved = JSON.parse(raw); if (saved && typeof saved === 'object' && !Array.isArray(saved)) this.values = saved; } } catch { /* A browser draft is optional; file admission always happens on the server. */ } this.renderInputs(); }
    this.upgrade.hidden = isV2(doc); this.check.hidden = !isV2(doc); this.editor.root.dataset.schema = String(doc.schemaVersion);
    if (this.currentSchema !== doc.schemaVersion) { this.currentSchema = doc.schemaVersion; this.editor.renderLibrary(); }
    this.editor.root.dataset.structuredInputs = String(isV2(doc) && inputEntries(doc).length > 0);
    if (this.inputSignature !== definition) this.renderInputs();
    this.renderGraph(); this.setTab(this.tab); this.setView(this.view);
  }
  setView(view) {
    if (view === 'run' && this.editor.nodeLibrary?.nested) { this.editor.toast('请先应用或取消子流程内部修改，再运行主流程。', true); return; }
    const changed = this.view !== view;
    this.view = view; this.editor.root.dataset.studioView = view;
    [...this.viewSwitch.children].forEach((item, index) => item.setAttribute('aria-pressed', String(index === (view === 'edit' ? 0 : 1))));
    this.runSurface.hidden = view !== 'run';
    if (view === 'run' && changed) { this.editor.settings.libraryClosed = false; this.editor.settings.propertiesClosed = true; this.setTab('inputs'); this.editor.applySettings(); this.renderRuntime(); }
    // Inspector-only DOM from run view must not survive an edit-view switch.
    // Unchanged view syncs leave a focused property form and its draft intact.
    if (changed) this.editor.renderProperties?.();
    if (changed && view === 'edit') globalThis.requestAnimationFrame?.(() => { if (this.view === 'edit') this.editor.recoverCanvasViewport?.(); });
  }
  setTab(tab) {
    this.tab = tab; for (const item of this.tabs.children) item.setAttribute('aria-pressed', String(item.dataset.studioTab === tab));
    const library = this.editor.root.querySelector('.wf-library'); library.dataset.tab = tab; this.inputs.hidden = tab !== 'inputs'; this.queue.hidden = tab !== 'queue';
    for (const part of library.querySelectorAll('.wf-library-head,.wf-library-items')) part.hidden = tab !== 'nodes';
    if (tab === 'queue') void this.renderQueue();
  }
  upgradeDocument() {
    try { const doc = validateDocument({ ...this.editor.doc, schemaVersion: 2, settings: { maxConcurrency: 4, outputDirectory: '' } }); this.editor.commit(doc, '升级为并行工作流'); this.editor.toast('已升级。旧节点和连线已保留，可添加具名端口与输入字段。'); }
    catch (error) { this.editor.toast(error.message, true); }
  }
  renderInputs() {
    const doc = this.editor.doc; this.inputs.replaceChildren(); const rows = inputEntries(doc); this.inputSignature = this.inputDefinitionSignature(doc);
    this.inputs.append(element('h3', '', '运行前准备'), element('p', 'wf-field-help', '选择文件与参数，检查后提交。已启动运行使用固定输入；此处编辑用于下一次运行。定时任务可采用相同资料。'));
    if (!isV2(doc)) this.inputs.append(element('p', 'wf-field-help', '旧流程继续使用运行面板的原始输入。升级后可配置文件选择表单。'));
    if (isV2(doc) && !rows.length) {
      const entry = doc.nodes.find(node => node.type === 'input'), type = entry?.config.outputType || 'any';
      if (this.rawInputDocumentId !== doc.id) { this.rawInputDocumentId = doc.id; this.rawInputValue = ''; try { const saved = localStorage.getItem(RAW_INPUT_STORAGE_PREFIX + doc.id); if (typeof saved === 'string' && saved.length <= 262144) this.rawInputValue = saved; } catch { /* Browser drafts are optional. */ } if (this.runtime?.input) this.runtime.input.value = this.rawInputValue; }
      const row = element('div', 'wf-studio-input-row'), label = element('label', '', entry?.config.fieldName || '运行输入'), control = element('textarea', 'wf-studio-raw-input'); control.id = 'wf-studio-raw-input'; label.htmlFor = control.id; control.setAttribute('aria-label', '本次运行输入'); control.rows = 8; control.spellcheck = false; control.value = this.runtime?.input?.value ?? this.rawInputValue ?? ''; control.placeholder = type === 'text' ? '填写本次要处理的文本' : ['object', 'array', 'number', 'boolean'].includes(type) ? '填写符合入口类型的 JSON' : '填写文本、JSON 或文件路径'; control.disabled = Boolean(this.editor.nodeLibrary?.nested); this.rawPreparationInput = control;
      control.addEventListener('input', () => { this.rawInputValue = control.value; this.invalidatePreflight(); if (this.runtime?.input) { this.runtime.input.value = control.value; this.runtime.input.dispatchEvent?.(new Event('input', { bubbles: true })); } try { localStorage.setItem(RAW_INPUT_STORAGE_PREFIX + doc.id, control.value); } catch { /* Keep the value in memory when browser storage is unavailable. */ } });
      const formats = { text: '文本', object: 'JSON 对象', array: 'JSON 数组', number: 'JSON 数字', boolean: 'true / false', any: '文本或 JSON' }; row.append(label, control, element('small', 'wf-field-help', `输入格式：${formats[type] || type}，跟随输入节点类型${entry?.config.required ? ' · 必填' : ''}。`)); this.inputs.append(row);
      this.inputs.append(element('p', 'wf-field-help', '也可在输入节点属性中添加文件、图片或参数字段，生成资料准备表单。'));
    } else this.rawPreparationInput = null;
    for (const { node, field } of rows) {
      const row = element('div', 'wf-studio-input-row'); const label = element('label', '', `${field.label}${field.required ? ' *' : ''}`); const id = `studio-input-${node.id}-${field.key}`; label.htmlFor = id;
      const control = element('input'); control.id = id; control.dataset.nodeId = node.id; control.dataset.inputKey = field.key; control.type = field.kind === 'number' ? 'number' : 'text'; control.value = this.values[node.id]?.[field.key] ?? ''; control.placeholder = ['file', 'folder', 'image'].includes(field.kind) ? '选择本机文件或文件夹' : field.label;
      control.addEventListener('input', () => { this.values[node.id] ||= {}; this.values[node.id][field.key] = field.kind === 'number' && control.value !== '' ? Number(control.value) : control.value; this.invalidatePreflight(); this.syncRawInput(); this.renderGraph(); });
      const controls = element('div', 'wf-studio-input-control'); controls.append(control);
      if (['file', 'folder', 'image'].includes(field.kind)) controls.append(button('选择', () => void this.pickPath(field, control.value, path => { control.value = path; control.dispatchEvent(new Event('input', { bubbles: true })); })));
      row.append(label, controls, element('small', 'wf-field-help', [node.title, field.match ? `匹配 ${field.match}` : '', field.extensions?.join(', ')].filter(Boolean).join(' · '))); this.inputs.append(row);
    }
    if (isV2(doc)) {
      const concurrency = element('div', 'wf-studio-input-row'), concurrencyLabel = element('label', '', '最大并行节点数'), concurrencyInput = element('input'); concurrencyInput.type = 'number'; concurrencyInput.min = '1'; concurrencyInput.max = '16'; concurrencyInput.value = doc.settings?.maxConcurrency || 4; concurrencyInput.setAttribute('aria-label', '最大并行节点数'); this.concurrencyInput = concurrencyInput; for (const event of ['input', 'change']) concurrencyInput.addEventListener(event, () => { try { this.flushRunSettings(); } catch (error) { this.editor.toast(error.message, true); } }); concurrency.append(concurrencyLabel, concurrencyInput); this.inputs.append(concurrency);
      const output = element('div', 'wf-studio-input-row'), label = element('label', '', '输出根目录'); const control = element('input'); control.placeholder = '留空使用默认交付目录'; control.value = doc.settings?.outputDirectory || ''; control.setAttribute('aria-label', '输出根目录');
      this.outputDirectoryInput = control;
      for (const event of ['input', 'change']) control.addEventListener(event, () => { try { this.flushRunSettings(); } catch (error) { this.editor.toast(error.message, true); } });
      const controls = element('div', 'wf-studio-input-control'); controls.append(control, button('选择', () => void this.pickPath({ kind: 'folder', label: '输出根目录' }, control.value, path => { control.value = path; control.dispatchEvent(new Event('change')); }))); output.append(label, controls, element('small', 'wf-field-help', '执行原件保存在本机；此目录用于保存完成后的交付副本。')); this.inputs.append(output);
      this.inputs.append(this.inputNotice, button('检查资料是否齐全', () => void this.preflight(), 'wf-button primary'));
    }
  }
  copyInputDrafts(targetDocument, nodeIdMap) {
    if (!targetDocument?.id || targetDocument.id === this.editor.doc.id) throw new Error('新版输入资料需要独立的工作流。');
    const values = {}, allowed = new Set(targetDocument.nodes.filter(node => node.type === 'input').map(node => node.id));
    for (const node of this.editor.doc.nodes.filter(node => node.type === 'input')) {
      const mapped = nodeIdMap[node.id];
      if (allowed.has(mapped) && Object.hasOwn(this.values || {}, node.id)) values[mapped] = structuredClone(this.values[node.id]);
    }
    // Only draft values move. Admission manifests, file hashes and approval
    // state belong to their original run and must be checked again.
    if (Object.keys(values).length) localStorage.setItem(INPUT_STORAGE_PREFIX + targetDocument.id, JSON.stringify(values));
    if (!inputEntries(this.editor.doc).length) {
      const raw = this.rawInputDocumentId === this.editor.doc.id ? this.rawInputValue : this.runtime?.input?.value;
      if (typeof raw === 'string') localStorage.setItem(RAW_INPUT_STORAGE_PREFIX + targetDocument.id, raw);
    }
    return { copiedInputs: Object.keys(values).length };
  }
  syncRawInput() { if (inputEntries(this.editor.doc).length) { if (this.runtime) this.runtime.input.value = JSON.stringify(structuredInput(this.editor.doc, this.values), null, 2); try { localStorage.setItem(INPUT_STORAGE_PREFIX + this.editor.doc.id, JSON.stringify(this.values)); } catch { /* Input values remain usable in memory when browser storage is unavailable. */ } } }
  flushRunSettings() { if (!isV2(this.editor.doc)) return; const current = this.editor.doc.settings, outputDirectory = this.outputDirectoryInput?.isConnected ? this.outputDirectoryInput.value.trim() : current.outputDirectory || '', maxConcurrency = this.concurrencyInput?.isConnected ? Number(this.concurrencyInput.value) : current.maxConcurrency; if (outputDirectory !== current.outputDirectory || maxConcurrency !== current.maxConcurrency) { this.invalidatePreflight(); this.editor.commit({ ...this.editor.doc, settings: { ...current, outputDirectory, maxConcurrency } }, '设置运行目录与并行上限'); } }
  restoreInput(input) { this.invalidatePreflight(); this.values = valuesFromInput(this.editor.doc, input); if (!inputEntries(this.editor.doc).length) { this.rawInputDocumentId = this.editor.doc.id; this.rawInputValue = typeof input === 'string' ? input : JSON.stringify(input, null, 2); if (this.runtime?.input) this.runtime.input.value = this.rawInputValue; } this.renderInputs(); this.syncRawInput(); }
  async preflight({ quiet = false, document = this.editor.doc, input } = {}) {
    if (this.editor.nodeLibrary?.nested && document === this.editor.doc) { if (!quiet) this.editor.toast('请先应用或取消子流程内部修改，再检查主流程输入。', true); return { ok: false, errors: [{ message: '子流程内部编辑尚未结束。' }] }; }
    if (document === this.editor.doc) { this.flushRunSettings(); document = this.editor.doc; }
    if (!isV2(document)) return { ok: true, input };
    const visible = this.preflightDocumentSignature(document) === this.preflightDocumentSignature(), ticket = visible ? this.invalidatePreflight() : null, draft = this.preflightDraftSignature();
    const current = () => visible && ticket === this.preflightRequest && draft === this.preflightDraftSignature();
    if (input === undefined) { this.syncRawInput(); try { input = this.runtime.parseInput(document.nodes.find(node => node.type === 'input')); } catch (error) { if (current()) this.showInputNotice(error.message, true); return { ok: false, errors: [{ message: error.message }] }; } }
    try {
      if (current()) this.check.disabled = true; const result = await this.api('/api/workflow-v2/preflight', { method: 'POST', body: { document, input, outputDirectory: document.settings?.outputDirectory || undefined } });
      // The caller may still use its immutable run snapshot. Only the current
      // preparation form may display this request's admission result.
      if (!current()) return result;
      this.preflightResult = result;
      const fields = inputEntries(document).length, sourceCount = manifestSourceCount(result.manifest); this.showInputNotice(result.ok ? `资料检查通过${fields ? ` · ${fields} 项输入` : ''}${sourceCount ? ` · ${sourceCount} 项来源文件` : ''}。可以运行。` : '资料未准备好，请按下方提示补齐。', !result.ok);
      for (const old of this.inputs.querySelectorAll('.wf-studio-input-error')) old.remove();
      for (const error of result.errors || []) { const line = element('p', 'wf-studio-input-error', `${error.label || error.key || ''}：${error.message}`); const target = [...this.inputs.querySelectorAll('[data-input-key]')].find(item => item.dataset.inputKey === error.key && item.dataset.nodeId === error.nodeId); (target?.closest('.wf-studio-input-row') || this.inputs).append(line); }
      if (!quiet || !result.ok) { this.editor.settings.libraryClosed = false; this.editor.applySettings(); this.setTab('inputs'); }
      return result;
    } catch (error) { if (current()) this.showInputNotice(`资料检查失败：${error.message}`, true); return { ok: false, errors: [{ message: error.message }] }; }
    finally { if (ticket === this.preflightRequest) this.check.disabled = false; }
  }
  showInputNotice(message, error) { this.inputNotice.textContent = message; this.inputNotice.classList.toggle('error', Boolean(error)); this.inputNotice.hidden = !message; }
  async pickPath(field, initial, done) {
    const dialog = this.fileDialog; let current = initial && initial.includes('/') ? initial.substring(0, initial.lastIndexOf('/')) || '/' : '';
    dialog.replaceChildren(); const heading = element('div', 'wf-dialog-header'); heading.append(element('h2', '', `选择${field.label || (field.kind === 'folder' ? '文件夹' : '文件')}`), button('关闭', () => dialog.close()));
    const location = element('input'); location.setAttribute('aria-label', '浏览目录'); location.placeholder = '输入目录路径'; const nav = element('div', 'wf-studio-file-nav'), list = element('div', 'wf-studio-file-list'), notice = element('p', 'wf-field-help');
    let selected = '', request = 0; const choose = button('选择此文件夹', () => { done(selected || current); dialog.close(); }, 'wf-button primary'); choose.hidden = field.kind !== 'folder';
    const load = async directory => {
      const ticket = ++request; current = directory; selected = ''; choose.disabled = true; list.replaceChildren(element('p', '', '正在读取本机目录…')); notice.textContent = '';
      try { const query = new URLSearchParams({ kind: field.kind, ...(directory ? { directory } : {}), ...(field.extensions?.length ? { extensions: field.extensions.join(',') } : {}) }); const result = await this.api(`/api/workflow-v2/files?${query}`); if (ticket !== request) return; current = result.directory || ''; location.value = current; list.replaceChildren();
        choose.disabled = !current; nav.replaceChildren(button('前往目录', () => load(location.value.trim())), button('常用位置', () => load('')), button('上一级', () => load(result.parent || '')));
        for (const root of result.roots || []) nav.append(button(root.label, () => load(root.path), 'wf-button wf-studio-small'));
        for (const entry of result.entries || []) { const row = button(`${entry.kind === 'folder' ? '▸' : '□'} ${entry.name}`, () => { if (entry.kind === 'folder') void load(entry.path); else if (entry.selectable) { done(entry.path); dialog.close(); } }, 'wf-studio-file-entry'); row.disabled = entry.kind !== 'folder' && !entry.selectable; list.append(row); }
        if (!list.childElementCount) list.append(element('p', 'wf-field-help', '此位置没有匹配文件。')); if (result.truncated) notice.textContent = '目录条目较多，仅显示前部分；请进入更具体的文件夹。';
      } catch (error) { if (ticket !== request) return; list.replaceChildren(); notice.textContent = error.message; choose.disabled = true; }
    };
    location.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void load(location.value.trim()); } });
    dialog.append(heading, location, nav, list, notice, choose); if (!dialog.open) dialog.showModal(); await load(current);
  }
  renderGraph() {
    for (const node of this.editor.doc.nodes) { const card = this.editor.nodeElements.get(node.id); if (!card) continue;
      if (card.contains(document.activeElement) && document.activeElement?.classList.contains('wf-studio-node-input')) continue;
      const ports = getPorts(node), palette = { text: '#fbbf24', number: '#fbbf24', boolean: '#fb7185', object: '#a78bfa', array: '#34d399', fileRef: '#22d3ee', folderRef: '#22d3ee', image: '#34d399', artifactRef: '#22d3ee', artifactBundle: '#22d3ee' };
      for (const socket of card.querySelectorAll('.wf-port')) { const port = ports[socket.dataset.direction === 'input' ? 'inputs' : 'outputs'].find(port => port.id === socket.dataset.port); socket.style.setProperty('--port-color', palette[port?.type] || '#94a3b8'); }
      card.querySelector('.wf-studio-node-content')?.remove(); const content = element('div', 'wf-studio-node-content');
      if (node.type === 'input') {
        const { visible, total, remaining } = inlineInputFields(node);
        for (const field of visible) {
          const value = this.values[node.id]?.[field.key], isPath = pathField(field);
          const label = element('label', 'wf-studio-node-field'), caption = element('span', value === undefined || value === '' ? 'is-missing' : '', `${field.label}${field.required ? ' *' : ''}`);
          label.append(caption);
          const filename = isPath ? element('span', 'wf-studio-node-path-name', pathName(value)) : null;
          if (filename) { filename.title = typeof value === 'string' ? value : ''; label.append(filename); }
          const row = element('div', 'wf-studio-input-control'), control = element('input', 'wf-studio-node-input');
          control.type = field.kind === 'number' ? 'number' : 'text'; control.value = value ?? ''; control.placeholder = isPath ? '选择或输入完整路径' : '待准备';
          control.title = isPath ? String(value ?? '') : field.label; control.setAttribute('aria-label', `${node.title} · ${field.label}`);
          for (const event of ['input', 'change']) control.addEventListener(event, () => {
            this.values[node.id] ||= {}; this.values[node.id][field.key] = field.kind === 'number' && control.value !== '' ? Number(control.value) : control.value;
            if (filename) { filename.textContent = pathName(control.value); filename.title = control.value; control.title = control.value; }
            caption.className = control.value === '' ? 'is-missing' : ''; this.invalidatePreflight(); this.syncRawInput(); this.renderInputs(); this.editor.requestGeometry?.();
          });
          row.append(control);
          if (isPath) { const choose = button('选择', () => void this.pickPath(field, control.value, path => { control.value = path; control.dispatchEvent(new Event('change')); }), 'wf-studio-node-action'); choose.setAttribute('aria-label', `${node.title} · 选择${field.label}`); row.append(choose); }
          label.append(row); content.append(label);
        }
        if (remaining) content.append(button(`准备全部 ${total} 项资料 · 另 ${remaining} 项参数`, () => { this.editor.settings.libraryClosed = false; this.editor.applySettings(); this.setTab('inputs'); }, 'wf-studio-node-action'));
      }
      if (node.type === 'skill') { const meta = card.querySelector('.wf-node-meta'); if (meta) { const found = this.runtime?.skills?.skills?.find(item => item.name === node.config.skillRef || item.ref === node.config.skillRef); meta.textContent = [found?.displayName || found?.name || node.config.skillRef || '选择 Skill', shortVersion(node.config.version)].filter(Boolean).join(' · '); } }
      if (node.type === 'tool') content.append(button('配置代码 / 工具', () => this.editor.selectNode(node.id), 'wf-studio-node-action'));
      const selectedRun = this.editor.nodeLibrary?.nested ? null : this.runtime?.currentRun();
      const run = selectedRun?.workflowId === this.editor.doc.id && selectedRun.document?.id === this.editor.doc.id ? selectedRun : null;
      const state = run?.nodes?.[node.id], artifacts = state?.artifacts || [], pictures = nodePreviewArtifacts(run, this.editor.doc.id, node.id);
      if (pictures.length) {
        const previews = element('div', 'wf-studio-node-previews'); previews.setAttribute('aria-label', `${node.title} · 产物图片`);
        for (const picture of pictures.slice(0, node.type === 'output' ? 4 : 1)) {
          const link = element('a', 'wf-studio-node-preview-link'); link.href = picture.previewUrl; link.target = '_blank'; link.rel = 'noopener'; link.title = `打开原图：${picture.label || picture.name || '产物'}`;
          link.addEventListener('pointerdown', event => event.stopPropagation());
          const img = element('img', 'wf-studio-node-preview'); img.src = picture.previewUrl; img.alt = picture.label || picture.name || '本节点产物'; img.loading = 'lazy';
          img.addEventListener('load', () => this.editor.requestGeometry?.()); img.addEventListener('error', () => this.editor.requestGeometry?.());
          link.append(img, element('span', '', picture.label || picture.name || '打开原图')); previews.append(link);
        }
        content.append(previews, element('small', 'wf-studio-node-run-source', `所选运行 ${run.id.slice(0, 8)} · ${STUDIO_STATUS[state?.status] || state?.status || '已记录'}${pictures.length > 4 && node.type === 'output' ? ` · 预览 4 / ${pictures.length} 张` : ''}`));
      } else if (node.type === 'output' && nodeShowsCanvasPreview(node)) {
        const placeholder = element('div', 'wf-studio-node-preview-empty'); placeholder.setAttribute('aria-label', `${node.title} · 图片预览占位`);
        placeholder.append(element('strong', '', '图片预览'), element('span', '', !run ? '尚未运行，运行后在此预览产物' : !state || state.status !== 'complete' ? '等待本节点产物，可先查看运行进度' : '本次输出暂无可预览图片，请查看产物文件'));
        content.append(placeholder);
      }
      if (node.type === 'output' || pictures.length) {
        const inspect = button(node.type === 'output' ? '查看运行' : `查看 ${artifacts.length} 项产物`, () => { this.setView('run'); this.editor.selectNode(node.id); this.runtime?.setExpanded(true); if (!run) this.runtime?.recentSelect?.focus?.(); }, 'wf-studio-node-action');
        inspect.setAttribute('aria-label', `${node.title} · 查看运行`); content.append(inspect);
      }
      if (content.childElementCount) card.insertBefore(content, card.querySelector('.wf-node-ports'));
    }
    this.editor.requestGeometry?.();
  }
  renderProperties() {
    const editor = this.editor, node = editor.doc.nodes.find(item => editor.selection.has(item.id)); if (editor.selection.size !== 1 || !node) return;
    if (isV2(editor.doc)) { if (node.type === 'input') this.renderFieldSchema(node); this.renderPortSchema(node); if (node.type === 'human') this.renderReviewConfig(node); if (['subflow', 'foreach', 'loop'].includes(node.type)) this.renderSubflowPicker(node); if (['tool', 'skill', 'transform', 'subflow', 'foreach', 'loop'].includes(node.type)) this.renderCapabilityConfig(node); }
    this.renderInspectorData(node.id);
  }
  renderFieldSchema(node) {
    const section = element('section', 'wf-property-section wf-studio-field-schema'); section.append(element('h3', '', '运行输入表单'), element('p', 'wf-field-help', '字段定义准备清单。文件哈希由系统计算。'));
    for (const preset of INPUT_FIELD_PRESETS) section.append(button(preset.label, () => {
      const current = this.editor.doc.nodes.find(item => item.id === node.id); if (!current) return;
      if (!this.updateConfig(node.id, { outputType: 'object', fields: mergeInputFields(current.config.fields, preset.fields) })) return;
      this.setTab('inputs'); this.editor.settings.libraryClosed = false; this.editor.applySettings();
    }, 'wf-button'));
    section.append(element('p', 'wf-field-help', '预设只补齐缺少的字段，保留已有配置和自定义字段。请提前准备与当前工程匹配的已核验配置文件、实拍照片和资料目录。'));
    for (const [index, field] of (node.config.fields || []).entries()) { const row = element('div', 'wf-studio-schema-row'); row.append(element('strong', '', field.label), element('small', '', `${field.key} · ${FIELD_KINDS.find(kind => kind[0] === field.kind)?.[1] || field.kind}${field.required ? ' · 必填' : ''}`), button('删除', () => this.updateConfig(node.id, { fields: node.config.fields.filter((_, i) => i !== index) }), 'wf-button wf-studio-small')); section.append(row); }
    const label = element('input'); label.placeholder = '例如 正面照片'; label.setAttribute('aria-label', '新输入字段名称'); const key = element('input'); key.placeholder = '字段键，例如 frontImage'; key.setAttribute('aria-label', '新输入字段键'); const kind = element('select'); kind.setAttribute('aria-label', '新输入字段类型'); for (const [value, name] of FIELD_KINDS) { const option = element('option', '', name); option.value = value; kind.append(option); }
    const extensions = element('input'); extensions.placeholder = '扩展名，例如 .png,.jpg（可选）'; extensions.setAttribute('aria-label', '输入允许扩展名');
    const required = element('input'); required.type = 'checkbox'; required.checked = true; const requiredLabel = element('label', 'wf-studio-checkbox'); requiredLabel.append(required, element('span', '', '必填'));
    const match = element('input'); match.placeholder = '文件夹匹配，例如 *.epro2（可选）'; match.setAttribute('aria-label', '输入文件夹匹配'); const role = element('input'); role.placeholder = '资料角色，例如 source（可选）'; role.setAttribute('aria-label', '输入资料角色');
    section.append(label, key, kind, extensions, match, role, requiredLabel, button('添加输入字段', () => { const name = key.value.trim(); if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) return this.editor.toast('字段键需以英文字母开头，仅含字母、数字和下划线。', true); if ((node.config.fields || []).some(field => field.key === name)) return this.editor.toast('字段键已存在。', true); this.updateConfig(node.id, { fields: [...(node.config.fields || []), { key: name, label: label.value.trim() || name, kind: kind.value, required: required.checked, ...(extensions.value.trim() ? { extensions: extensions.value.split(',').map(value => value.trim()).filter(Boolean) } : {}), ...(match.value.trim() ? { match: match.value.trim() } : {}), ...(role.value.trim() ? { role: role.value.trim() } : {}) }] }); })); this.editor.properties.insertBefore(section, this.editor.properties.querySelector('.wf-property-form'));
  }
  updateConfig(id, config) { try { this.editor.commit(updateNode(this.editor.doc, id, { config }), '更新节点配置'); return true; } catch (error) { this.editor.toast(error.message, true); return false; } }
  renderPortSchema(node) {
    if (['evaluation', 'improvement'].includes(node.type)) return;
    const editor = this.editor; editor.propertyDrafts ||= new Map();
    const ports = structuredClone(editor.propertyDrafts.get(node.id)?.ports || getPorts(node));
    const section = element('details', 'wf-property-section wf-studio-port-schema');
    section.append(element('summary', '', '具名数据端口'), element('p', 'wf-field-help', '修改暂存；增加或删除端口会保留全部填写内容，应用后更新画布。'));
    section.open = node.type === 'merge' || ports.inputs.length > 1 || ports.outputs.filter(port => port.id !== 'learning').length > 1;
    const controls = { inputs: [], outputs: [] };
    const collect = () => Object.fromEntries(['inputs', 'outputs'].map(direction => [direction, controls[direction].map(({ port, id, label, type, required, path }) => ({ ...port, id: id.value.trim(), label: label.value, type: type.value, ...(direction === 'inputs' ? { required: required.checked } : { valuePath: path.value }) }))]));
    const stash = value => {
      const draft = editor.propertyDrafts.get(node.id) || { title: node.title, config: structuredClone(node.config) };
      editor.propertyDrafts.set(node.id, { ...draft, ports: structuredClone(value) }); editor.renderHeader?.();
    };
    for (const direction of ['inputs', 'outputs']) {
      const box = element('div', 'wf-studio-port-group'); box.append(element('h4', '', direction === 'inputs' ? '输入端口' : '输出端口'));
      for (const [index, port] of ports[direction].entries()) {
        const row = element('div', 'wf-studio-port-edit');
        const id = element('input'); id.value = port.id; id.setAttribute('aria-label', `${direction} ${port.id} 标识`);
        const label = element('input'); label.value = port.label; label.setAttribute('aria-label', `${direction} ${port.id} 名称`);
        const type = element('select'); type.setAttribute('aria-label', `${direction} ${port.id} 类型`);
        for (const name of ['any', 'text', 'number', 'boolean', 'object', 'array', 'fileRef', 'folderRef', 'image', 'artifactRef', 'artifactBundle']) { const option = element('option', '', name); option.value = name; type.append(option); }
        type.value = port.type; row.append(element('code', '', port.id), id, label, type);
        const required = element('input'); required.type = 'checkbox'; required.checked = port.required !== false;
        const path = element('input'); path.value = port.valuePath || ''; path.placeholder = '输出字段路径（留空=完整结果）'; path.setAttribute('aria-label', `输出 ${port.id} 字段路径`);
        if (direction === 'inputs') { const caption = element('label', 'wf-studio-checkbox'); caption.append(required, element('span', '', '必需输入')); row.append(caption); } else row.append(path);
        controls[direction].push({ port, id, label, type, required, path });
        for (const control of [id, label, type, required, path]) for (const event of ['input', 'change']) control.addEventListener(event, () => stash(collect()));
        row.append(button('删除端口', () => { const next = collect(); next[direction].splice(index, 1); stash(next); editor.renderProperties?.(); }, 'wf-button wf-studio-small')); box.append(row);
      }
      box.append(button(direction === 'inputs' ? '增加输入端口' : '增加输出端口', () => {
        const next = collect(), prefix = direction === 'inputs' ? 'in' : 'out'; let index = next[direction].length + 1;
        while (next[direction].some(port => port.id === `${prefix}_${index}`)) index++;
        next[direction].push({ id: `${prefix}_${index}`, label: `${direction === 'inputs' ? '输入' : '输出'} ${index}`, type: 'any', ...(direction === 'inputs' ? { required: true } : {}) });
        stash(next); editor.renderProperties?.();
      })); section.append(box);
    }
    section.append(button('应用端口配置', () => { const next = collect(); stash(next); this.applyPorts(node.id, next); }, 'wf-button primary')); editor.properties.append(section);
  }
  applyPorts(id, ports) {
    try { const draft = this.editor.propertyDrafts?.get(id) || {}; const next = updateNode(this.editor.doc, id, { ...draft, ports }); this.editor.propertyDrafts?.delete(id); this.editor.commit(next, '配置具名端口'); }
    catch (error) { this.editor.toast(error.message, true); }
  }
  renderReviewConfig(node) {
    const section = element('section', 'wf-property-section'); section.append(element('h3', '', '要求修改时返回')); const select = element('select'); select.setAttribute('aria-label', '审核修改目标节点'); select.append(new Option('选择上游能力节点', ''));
    const targets = reviewTargetNodes(this.editor.doc, node.id), valid = targets.some(item => item.id === node.config.reviewTargetNodeId);
    for (const item of targets) select.append(new Option(item.title, item.id)); select.value = valid ? node.config.reviewTargetNodeId : ''; select.addEventListener('change', () => this.updateConfig(node.id, { reviewTargetNodeId: select.value })); section.append(select);
    section.append(element('p', node.config.reviewTargetNodeId && !valid ? 'wf-studio-input-error' : 'wf-field-help', node.config.reviewTargetNodeId && !valid ? '原修改目标已不在此审核节点的上游，请重新选择；原配置尚未更改。' : targets.length ? '只列出沿当前连线可返回重试的上游能力。' : '先连接上游能力，再选择要求修改时返回的节点。'));
    const label = element('label', 'wf-field-help', '最多修改次数（1–3）'), max = element('input'); max.type = 'number'; max.min = '1'; max.max = '3'; max.value = node.config.maxRevisions ?? 3; max.setAttribute('aria-label', '最多修改次数'); max.addEventListener('change', () => this.updateConfig(node.id, { maxRevisions: Number(max.value) })); section.append(label, max); this.editor.properties.append(section);
  }
  renderCapabilityConfig(node) { const section = element('section', 'wf-property-section'); section.append(element('h3', '', '产物审核')); const required = node.type === 'tool' && WORKFLOW_TOOLS.find(tool => tool.id === node.config.toolName)?.reviewRequired === true; const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.checked = required || Boolean(node.config.reviewImages); checkbox.disabled = required; checkbox.addEventListener('change', () => { if (!required) this.updateConfig(node.id, { reviewImages: checkbox.checked }); }); const label = element('label', 'wf-studio-checkbox'); label.append(checkbox, element('span', '', '图片需要人工审核')); section.append(label, element('p', 'wf-field-help', required ? '此图片工具必须经过人工审核，请在下游连接人工审核节点。' : '开启后，下游必须经过显式的人工审核节点；实际新生成的图片同样需要审核。')); this.editor.properties.append(section); }
  renderSubflowPicker(node) {
    const label = node.type === 'foreach' ? '选择逐项处理子流程' : node.type === 'loop' ? '选择每轮执行子流程' : '选择已保存子流程';
    const section = element('section', 'wf-property-section'); section.append(element('h3', '', label)); const select = element('select'); select.setAttribute('aria-label', label); select.append(new Option('正在读取…', '')); const message = element('p', 'wf-field-help', node.config.document ? `已固定快照 · ${node.config.document.title}${node.config.version ? ` · ${shortVersion(node.config.version)}` : ''}` : '选择后保存固定快照；后续编辑原流程不改变这份快照。'); section.append(select, message);
    if (node.type === 'foreach') section.append(element('p', 'wf-field-help', '输入为数组。每项依次作为子流程输入；按输入顺序汇总结果数组。超过最多项数会停止，不会静默截断。'));
    if (node.type === 'loop') section.append(element('p', 'wf-field-help', '先执行一轮，把该轮输出作为下一轮输入。每轮结束后判断继续条件；false 时停止，true 时继续，最多运行指定轮数。留空条件则运行到轮数上限。'));
    const depth = element('input'); depth.type = 'number'; depth.min = '1'; depth.max = '8'; depth.value = node.config.maxDepth || 4; depth.setAttribute('aria-label', '子流程最大嵌套深度'); depth.addEventListener('change', () => this.updateConfig(node.id, { maxDepth: Number(depth.value) })); section.append(element('label', 'wf-field-help', '最大嵌套深度（1–8）'), depth);
    this.editor.properties.insertBefore(section, this.editor.properties.querySelector('.wf-property-form'));
    void this.api('/api/workflow-library').then(result => { if (!select.isConnected) return; select.replaceChildren(new Option('选择工作流', '')); for (const item of result.workflows || []) if (item.id !== this.editor.doc.id) select.append(new Option(item.title, item.id)); select.value = node.config.workflowRef || ''; }).catch(error => { message.textContent = error.message; });
    select.addEventListener('change', async () => { if (!select.value) return; try { select.disabled = true; const record = await this.api(`/api/workflow-library/${encodeURIComponent(select.value)}`), doc = (record.workflow || record).document; if (doc?.schemaVersion !== 2) throw new Error('请先将子流程升级为并行工作流并保存。'); if (doc.id === this.editor.doc.id) throw new Error('不能选择当前工作流自身作为子流程。'); const config = { workflowRef: doc.id, document: structuredClone(doc) }; if (node.type === 'subflow') { const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(doc))); config.version = 'sha256:' + [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join(''); } if (!this.updateConfig(node.id, config)) select.disabled = false; } catch (error) { message.textContent = error.message; select.disabled = false; } });
  }
  renderInspectorData(id) {
    this.editor.properties.querySelector('.wf-studio-inspector-data')?.remove();
    if (this.editor.nodeLibrary?.nested) return;
    const run = this.runtime?.currentRun(), current = run?.nodes?.[id]; if (!current) return;
    this.inspectionVersions ||= new Map(); const key = `${run.id}:${id}`, versions = nodeInspectionVersions(current);
    const selected = versions.find(version => version.key === this.inspectionVersions.get(key)) || versions[0], state = selected.record;
    const section = element('section', 'wf-property-section wf-studio-inspector-data');
    section.append(element('h3', '', `${selected.historical ? '历史节点' : '本次节点'} · ${STUDIO_STATUS[state.status] || state.status}`));
    const picker = element('div', 'wf-studio-version-picker'), label = element('label', '', '查看节点版本'), select = element('select');
    select.id = `wf-inspect-version-${id}`; label.htmlFor = select.id; select.setAttribute('aria-label', '查看节点版本');
    for (const version of versions) { const option = element('option', '', version.label); option.value = version.key; select.append(option); }
    select.value = selected.key; select.addEventListener('change', () => { this.inspectionVersions.set(key, select.value); this.renderInspectorData(id); }); picker.append(label, select); section.append(picker);
    section.append(element('p', selected.historical ? 'wf-studio-history-notice' : 'wf-field-help', selected.historical ? '历史版本，仅供查看。下方展示这一版本的输入、输出、日志和产物；审核卡始终针对当前最新版本。' : '以下来自所选运行的固定快照；编辑用于下一次运行。'));
    if (!selected.historical && canRerunNode(run, id)) {
      this.rerunDrafts ||= new Map(); const controls = element('div', 'wf-studio-rerun');
      const feedback = element('textarea'); feedback.value = this.rerunDrafts.get(key) || ''; feedback.maxLength = 8000; feedback.placeholder = '可选：说明这次重跑需要满足的要求'; feedback.setAttribute('aria-label', '本次重跑补充要求'); feedback.addEventListener('input', () => this.rerunDrafts.set(key, feedback.value));
      controls.append(element('label', '', '本次重跑补充要求（可选）'), feedback, element('p', 'wf-field-help', '只附加到本次受影响 Skill 的重跑提示，不修改 Skill 正文；留空沿用已有要求。'));
      const start = button('重跑此节点及下游', () => void this.rerun(id, feedback.value)); start.disabled = Boolean(this.rerunning?.has(key)); controls.append(start); section.append(controls);
    }
    for (const [label, value] of [['实际输入', state.input], ['实际输出', Object.hasOwn(state, 'output') ? state.output : state.partialText]]) { const details = element('details'); details.open = true; details.append(element('summary', '', label), element('pre', '', display(value))); section.append(details); }
    if (state.review?.feedback) {
      const decisions = { approved: '已通过', revision_requested: '要求修改', stopped: '已停止' };
      section.append(element('h4', '', `审核意见 · ${decisions[state.review.decision] || '已记录'}`), element('pre', 'wf-studio-review-feedback', state.review.feedback));
    }
    if (state.reviewFeedback) section.append(element('h4', '', '本版本采用的修改要求'), element('pre', 'wf-studio-review-feedback', state.reviewFeedback));
    const logs = element('details', 'wf-studio-version-logs'); logs.append(element('summary', '', '本版本日志'), element('h4', '', 'stdout'), element('pre', '', display(state.logs?.stdout || '（无 stdout）')), element('h4', '', 'stderr'), element('pre', '', display(state.logs?.stderr || '（无 stderr）'))); section.append(logs);
    if (state.error) section.append(element('p', 'wf-studio-input-error', display(state.error)));
    if (state.artifacts?.length) section.append(this.artifactGallery(state.artifacts));
    const definition = run.document?.nodes?.find(node => node.id === id); if (['subflow', 'foreach', 'loop'].includes(definition?.type)) section.append(this.subflowHistory(run, id, state));
    if (current.status === 'waiting_review') { section.append(element('h3', '', `当前最新版本审核 · 第 ${current.attempt || 1} 次尝试`), this.reviewControls(run, id, { compact: true })); }
    this.editor.properties.append(section);
  }
  subflowHistory(parent, nodeId, state, depth = 0) {
    const section = element('section', 'wf-studio-subflow-history'), ids = subflowRunIds(state), definition = parent.document.nodes.find(node => node.id === nodeId);
    section.append(element('h4', '', '内部执行记录'));
    if (!ids.length) { section.append(element('p', 'wf-field-help', '此历史记录尚未保留内部运行索引；查看操作不会自动重跑。')); return section; }
    if (depth >= 8) { section.append(element('p', 'wf-field-help', '已达到内部记录展示层级上限。')); return section; }
    this.subflowInspectionRuns ||= new Map();
    ids.forEach((childId, index) => {
      const key = `${parent.id}:${nodeId}:${state.attempt || 1}:${childId}`, slot = element('div', 'wf-studio-subflow-entry'), content = element('div', 'wf-studio-subflow-content');
      const prefix = definition.type === 'foreach' ? `第 ${index + 1} 项` : definition.type === 'loop' ? `第 ${index + 1} 轮` : ids.length > 1 ? `第 ${index + 1} 次` : '';
      const open = button(`${prefix ? prefix + ' · ' : ''}查看子流程运行`, async () => {
        if (open.disabled) return; open.disabled = true;
        try {
          const result = await this.api(`/api/workflow-runs/${encodeURIComponent(childId)}`), child = result.run || result; assertChildRunBinding(parent, nodeId, state, child); if (child.id !== childId) throw new Error('服务未返回指定子流程记录。');
          this.subflowInspectionRuns.set(key, child); content.replaceChildren(this.childRunTree(child, depth + 1)); open.textContent = `${prefix ? prefix + ' · ' : ''}刷新子流程运行`;
        } catch (error) { content.replaceChildren(element('p', 'wf-studio-input-error', error.message)); }
        finally { open.disabled = false; }
      });
      const cached = this.subflowInspectionRuns.get(key); if (cached) { try { assertChildRunBinding(parent, nodeId, state, cached); content.append(this.childRunTree(cached, depth + 1)); } catch { this.subflowInspectionRuns.delete(key); } }
      slot.append(open, content); section.append(slot);
    });
    return section;
  }
  childRunTree(run, depth = 1) {
    const tree = element('section', 'wf-studio-child-run'); tree.setAttribute('aria-label', '子流程只读执行记录');
    tree.append(element('h4', '', `${run.document?.title || '子流程'} · ${STUDIO_STATUS[run.status] || run.status}`), element('p', 'wf-field-help', '固定执行记录，仅供查看。不会改变当前画布或重新执行。'));
    const progress = runProgress(run); tree.append(element('p', 'wf-field-help', `${progress.completed} / ${progress.total} 个内部节点完成`));
    for (const [label, value] of [['子流程输入', run.input], ['子流程输出', run.output]]) { const details = element('details', 'wf-studio-child-values'); details.append(element('summary', '', label), element('pre', '', display(value))); tree.append(details); }
    for (const [id, state] of orderedNodeStates(run)) {
      const definition = run.document?.nodes?.find(node => node.id === id), item = element('details', 'wf-studio-child-node'); item.dataset.status = state.status; item.append(element('summary', '', `${definition?.title || '未命名节点'} · ${STUDIO_STATUS[state.status] || state.status}`));
      for (const [label, value] of [['实际输入', state.input], ['实际输出', Object.hasOwn(state, 'output') ? state.output : state.partialText]]) item.append(element('h5', '', label), element('pre', '', display(value)));
      if (state.error) item.append(element('p', 'wf-studio-input-error', display(state.error))); if (state.review?.feedback) item.append(element('h5', '', '审核反馈'), element('pre', '', display(state.review.feedback)));
      if (state.status === 'waiting_review') item.append(element('p', 'wf-field-help', '此节点正在等待审核，请在父流程的当前审核卡中处理。'));
      if (state.artifacts?.length) item.append(this.artifactGallery(state.artifacts));
      if (['subflow', 'foreach', 'loop'].includes(definition?.type)) item.append(this.subflowHistory(run, id, state, depth));
      tree.append(item);
    }
    return tree;
  }
  async rerun(id, feedback = '') {
    const current = this.runtime.currentRun(), key = `${current.id}:${id}`; this.rerunning ||= new Set(); if (this.rerunning.has(key)) return; this.rerunning.add(key);
    try { const body = { nodeIds: [id], ...(feedback.trim() ? { feedback: feedback.trim() } : {}) }; const result = await this.api(`/api/workflow-runs/${encodeURIComponent(current.id)}/rerun`, { method: 'POST', body }); const run = result.run || result; this.runtime.storeRun(run, { allowReopen: true }); this.runtime.currentRunId = run.id; }
    catch (error) { this.editor.toast(error.message, true); }
    finally { this.rerunning.delete(key); this.runtime.render(); }
  }
  reviewControls(run, id, { compact = false } = {}) {
    this.reviewDrafts ||= new Map(); const key = `${run.id}:${id}`, state = run.nodes?.[id] || {}, definition = run.document.nodes.find(node => node.id === id);
    const box = element('section', 'wf-studio-review' + (compact ? ' is-compact' : ''));
    box.append(element('h4', '', `${definition?.title || '人工审核'} · 第 ${state.attempt || 1} 次尝试`));
    if (state.review?.delegated || (definition?.type !== 'human' && state.subflowProgress?.childRunId)) {
      const childId = state.review?.childRunId || state.subflowProgress.childRunId;
      box.append(element('p', '', '子流程正在等待人工审核。请查看子流程中的实际产物并处理真实审核节点。'));
      box.append(button('查看子流程审核', async () => {
        try { const result = await this.api(`/api/workflow-runs/${encodeURIComponent(childId)}`), child = result.run || result; if (child.id !== childId || child.parentRunId !== run.id) throw new Error('子流程审核记录与父运行不匹配。'); this.delegatedRuns ||= new Map(); this.delegatedRuns.set(childId, child); this.runtime.storeRun(child); this.renderRuntime(); }
        catch (error) { this.editor.toast(error.message, true); }
      }, 'wf-button primary'));
      const child = this.delegatedRuns?.get(childId);
      if (child) { let waiting = false; for (const [childNodeId, record] of Object.entries(child.nodes || {})) if (record.status === 'waiting_review') { waiting = true; box.append(this.reviewControls(child, childNodeId, { compact })); } if (!waiting) box.append(element('p', 'wf-field-help', `子流程当前状态：${STUDIO_STATUS[child.status] || child.status}`)); }
      return box;
    }
    const prompt = definition?.config.prompt; if (prompt) box.append(element('p', '', prompt));
    if (this.editor?.conversation) box.append(button('在对话中回复此审核', () => this.editor.conversation.focusContext({
      runId: run.id, nodeId: id, attempt: state.attempt, attemptId: state.attemptId,
      artifactIds: (state.artifacts || []).map(item => item.id || item.artifactId),
    }, { intent: 'feedback' })));
    if (state.review?.feedback && state.review.revisionCount) box.append(element('p', 'wf-studio-review-revision', `第 ${state.review.revisionCount} 次修改要求：${state.review.feedback}`));
    const targets = reviewTargetArtifacts(run, id);
    if (targets.length) {
      const pictures = element('div', 'wf-studio-review-pictures');
      for (const artifact of targets) {
        const figure = element('figure', 'wf-studio-review-picture'), link = element('a'); link.href = artifact.previewUrl; link.target = '_blank'; link.rel = 'noopener'; link.title = '打开原尺寸图片';
        const img = element('img'); img.src = artifact.previewUrl; img.alt = artifact.label || artifact.name || '本次待审核图片'; link.append(img); figure.append(link);
        const producer = run.document.nodes.find(node => node.id === artifact.nodeId); figure.append(element('figcaption', '', `${artifact.label || artifact.name || '待审核图片'} · ${producer?.title || '本次生成'} · 第 ${artifact.attempt || 1} 次尝试`));
        const original = element('a', 'wf-button', '打开原尺寸'); original.href = artifact.previewUrl; original.target = '_blank'; original.rel = 'noopener'; figure.append(original); pictures.append(figure);
      }
      box.append(pictures);
    } else if (state.artifacts?.length) box.append(element('p', 'wf-field-help', '此审核节点没有可直接展示的生成图片，请先查看下方审核输入文件。'));
    const files = reviewFileGroups(run, id, targets);
    for (const [items, title, help] of [[files.current, files.exact ? '精确绑定的审核文件' : '当前审核输入文件（待决定）', files.exact ? '按本节点已记录的产物 ID 与 SHA 匹配；不改变原审核决定。' : '来自本次输入回执的直接生产节点；尚未获得本次批准。'], [files.references, '上游参考文件', '保留上游资料的访问入口；展示这些文件不代表对其作出独立批准。']]) {
      if (!items.length) continue;
      const details = element('details', 'wf-studio-review-files'); details.append(element('summary', '', `${title} · ${items.length} 项`), element('p', 'wf-field-help', help), this.artifactGallery(items, { run, showOrigin: true })); box.append(details);
    }
    const feedback = element('textarea'); feedback.value = this.reviewDrafts.get(key) || ''; feedback.placeholder = '说明需要修改的内容'; feedback.setAttribute('aria-label', '审核反馈'); feedback.addEventListener('input', () => this.setReviewDraft(key, feedback.value)); box.append(feedback);
    const actions = element('div', 'wf-studio-inline-actions');
    for (const [action, label] of [['approve', '通过并继续'], ['revise', '要求修改'], ['stop', '停止本次运行']]) actions.append(button(label, async () => {
      if (this.reviewPending?.has(key)) return;
      const latest = (this.reviewDrafts.get(key) || '').trim();
      if (action === 'revise' && !latest) return this.editor.toast('请先填写需要修改的内容。', true);
      try { this.setReviewPending(key, true); const result = await this.api(`/api/workflow-runs/${encodeURIComponent(run.id)}/review`, { method: 'POST', body: { nodeId: id, action, feedback: latest } }); const next = result.run || result; if (this.delegatedRuns?.has(next.id)) this.delegatedRuns.set(next.id, next); this.runtime.storeRun(next); this.runtime.render(); }
      catch (error) { this.editor.toast(error.message, true); }
      finally { this.setReviewPending(key, false); }
    }, action === 'approve' ? 'wf-button primary' : 'wf-button'));
    this.reviewFields ||= new Map(); const fields = this.reviewFields.get(key) || new Set();
    for (const field of fields) if (!field.feedback.isConnected) fields.delete(field);
    fields.add({ feedback, actions }); this.reviewFields.set(key, fields);
    for (const item of actions.children) item.disabled = Boolean(this.reviewPending?.has(key));
    box.append(actions); return box;
  }
  setReviewDraft(key, value) {
    this.reviewDrafts ||= new Map(); this.reviewDrafts.set(key, value);
    for (const field of this.reviewFields?.get(key) || []) if (field.feedback.isConnected && field.feedback.value !== value) field.feedback.value = value;
  }
  setReviewPending(key, pending) {
    this.reviewPending ||= new Set(); if (pending) this.reviewPending.add(key); else this.reviewPending.delete(key);
    for (const field of this.reviewFields?.get(key) || []) if (field.feedback.isConnected) for (const item of field.actions.children) item.disabled = pending;
  }
  artifactGallery(items, options = {}) {
    const groups = groupArtifacts(items), gallery = element('div', 'wf-studio-artifact-gallery');
    for (const [key, title] of [['images', '生成图片'], ['sources', '源资料'], ['other', '其它产物']]) if (groups[key].length) { const section = element('section', 'wf-studio-artifact-section'); section.append(element('h4', '', `${title} · ${groups[key].length}`), this.artifactCards(groups[key], options)); gallery.append(section); }
    if (groups.advanced.length) { const details = element('details', 'wf-studio-artifact-advanced'); details.append(element('summary', '', `高级产物 · ${groups.advanced.length} 项（SVG / JSON 等）`), this.artifactCards(groups.advanced, options)); gallery.append(details); }
    return gallery;
  }
  artifactCards(items, { run, showOrigin = false } = {}) {
    const list = element('div', 'wf-studio-artifacts');
    for (const item of items) { const card = element('article', 'wf-studio-artifact'); const preview = item.previewUrl; if (preview && /^image\//.test(item.mimeType || '')) { const link = element('a'); link.href = preview; link.target = '_blank'; link.rel = 'noopener'; const img = element('img'); img.src = preview; img.alt = item.label || item.name || '产物预览'; img.loading = 'lazy'; link.append(img); card.append(link); }
      card.append(element('strong', '', item.label || item.name || '产物'), element('small', '', [item.mimeType, Number.isFinite(item.size) ? `${Math.max(1, Math.round(item.size / 1024))} KB` : ''].filter(Boolean).join(' · '))); if (showOrigin) { const producer = run?.document?.nodes?.find(node => node.id === item.nodeId); card.append(element('small', '', `来源：${producer?.title || item.nodeId || '未记录节点'} · 第 ${item.attempt || 1} 次尝试`)); } const actions = element('div', 'wf-studio-inline-actions'); if (preview) { const link = element('a', 'wf-button', '预览'); link.href = preview; link.target = '_blank'; link.rel = 'noopener'; actions.append(link); } if (item.downloadUrl) { const link = element('a', 'wf-button', '下载'); link.href = item.downloadUrl; link.download = item.name || ''; actions.append(link); } if (run && this.editor?.conversation) actions.append(button('反馈此产物', () => this.editor.conversation.focusContext({ runId: run.id, nodeId: item.nodeId, attempt: item.attempt, attemptId: run.nodes?.[item.nodeId]?.attemptId, artifactIds: [item.id || item.artifactId] }, { intent: 'feedback' }))); card.append(actions); list.append(card); }
    return list;
  }
  renderDeliveries(run) {
    const results = deliveryResults(run); if (!results.length) return null;
    const section = element('section', 'wf-studio-deliveries'); section.setAttribute('aria-label', '本次交付成果'); section.append(element('h3', '', '本次交付成果'));
    for (const { output, producer, token, artifacts } of results) {
      const card = element('article', 'wf-studio-delivery'); card.append(element('h4', '', output.title || '最终输出'), element('p', 'wf-field-help', `来自本次固定回执：${producer.title || producer.id} · 第 ${run.nodes[producer.id].attempt} 次尝试`));
      if (typeof token.packagePath === 'string' && token.packagePath) { const label = element('label', 'wf-studio-delivery-path'); label.append(element('span', '', '成果包原件目录')); const path = element('input'); path.type = 'text'; path.readOnly = true; path.value = token.packagePath; path.setAttribute('aria-label', '本次成果包原件目录'); label.append(path); card.append(label); }
      const checks = token.qualitySummary?.checks, entries = checks && typeof checks === 'object' && !Array.isArray(checks) ? Object.values(checks) : [], notes = [];
      if (entries.length) notes.push(`固定回执检查 ${entries.filter(value => value === true).length} / ${entries.length} 通过`);
      if (token.physicalTestStatus === 'not-run') notes.push('未进行实板测试'); if (token.releaseQualified === false) notes.push('未发布放行');
      if (Array.isArray(token.unresolved) && token.unresolved.length) notes.push(`${token.unresolved.length} 项待确认事项`);
      if (notes.length) card.append(element('p', 'wf-studio-delivery-status', notes.join(' · ')));
      card.append(this.artifactCards(artifacts, { run, showOrigin: true })); section.append(card);
    }
    return section;
  }
  renderRunLocations(run) {
    const locations = element('div', 'wf-studio-run-locations');
    const separated = run.storageVersion === 2 || Object.hasOwn(run, 'deliveryDirectory') || Boolean(run.delivery);
    locations.append(element('p', '', `本次冻结的输出根目录：${run.document?.settings?.outputDirectory || '默认交付目录'}`),
      element('p', '', `${separated ? '执行原件目录' : '历史运行输出目录'}：${run.outputDirectory || '等待服务确认'}`));
    if (separated) {
      const directory = run.delivery?.directory || run.deliveryDirectory;
      locations.append(element('p', '', `交付副本目录：${directory || '完成后保存到输出根目录'}`));
      if (run.delivery?.status === 'error') {
        locations.append(element('p', 'wf-studio-input-error', `交付副本保存失败：${display(run.delivery.error || '请检查输出目录是否可访问。')} 执行原件已保留，可从原件目录取回。`));
      } else locations.append(element('p', 'wf-field-help', run.delivery?.status === 'complete' ? '交付副本已保存；预览与审核继续使用本机执行原件。' : run.delivery?.status === 'publishing' ? '正在保存交付副本，执行原件已保存在本机。' : '执行原件保存在本机，运行完成后再保存交付副本。'));
      if (['error', 'complete'].includes(run.delivery?.status)) {
        const retry = button(run.delivery.status === 'error' ? '重试保存交付副本' : '检查并补齐交付副本', async () => {
          if (retry.disabled) return; retry.disabled = true;
          try { const result = await this.api(`/api/workflow-runs/${encodeURIComponent(run.id)}/publish`, { method: 'POST', body: {} }); this.runtime.storeRun(result.run || result, { allowReopen: true }); this.runtime.render(); }
          catch (error) { this.editor.toast(error.message, true); }
          finally { retry.disabled = false; }
        }); locations.append(retry);
      }
      if (run.outputDirectory) locations.append(button('打开执行原件目录', async () => { try { await this.api('/api/workflow-v2/open-directory', { method: 'POST', body: { runId: run.id, kind: 'original' } }); } catch (error) { this.editor.toast(error.message, true); } }));
    }
    return locations;
  }
  renderRuntime() {
    if (!this.runtime) return;
    const focused = document.activeElement;
    if (focused?.matches?.('.wf-studio-review textarea,.wf-studio-rerun textarea') && this.editor.root.contains(focused)) { if (!this.runtimeRenderDeferred) { this.runtimeRenderDeferred = true; focused.addEventListener('blur', event => { this.runtimeRenderDeferred = false; if (!event.relatedTarget?.closest('.wf-studio-review,.wf-studio-rerun')) this.renderRuntime(); }, { once: true }); } return; }
    const run = this.runtime.currentRun(); this.runSurface.replaceChildren();
    const heading = element('div', 'wf-studio-run-heading'); heading.append(element('h2', '', run ? STUDIO_STATUS[run.status] || run.status : '准备运行')); const actions = element('div', 'wf-studio-inline-actions'); actions.append(button('查看节点画布', () => this.setView('edit'))); if (run && active(run.status)) actions.append(button(run.status === 'queued' ? '取消排队' : '停止本次运行', () => void this.runtime.interrupt())); if (run?.status === 'complete') actions.append(button('反馈与改进', () => this.editor.conversation ? this.editor.conversation.focusContext({ runId: run.id }, { intent: 'feedback' }) : this.runtime.openFeedback())); heading.append(actions); this.runSurface.append(heading);
    if (!run) this.runSurface.append(element('p', 'wf-field-help', '在左侧选择输入资料，检查通过后点击运行。'));
    else { this.runSurface.append(this.renderRunLocations(run)); const states = orderedNodeStates(run), { completed, total, running, skippedLearning } = runProgress(run); this.runSurface.append(element('p', 'wf-field-help', `${completed} / ${total} ${run.document?.mode === 'learn' ? '节点' : '业务节点'}完成 · ${running} 项同时运行${skippedLearning ? ` · ${skippedLearning} 个学习节点已跳过` : ''}${run.queuePosition ? ` · 队列位置 ${run.queuePosition}` : ''}`)); const progress = element('progress'); progress.max = Math.max(1, total); progress.value = completed; this.runSurface.append(progress);
      const steps = element('div', 'wf-studio-run-steps'); for (const [id, state] of states) { const item = button(`${run.document.nodes.find(node => node.id === id)?.title || id} · ${STUDIO_STATUS[state.status] || state.status}`, () => { this.editor.selectNode(id); this.renderInspectorData(id); }, 'wf-studio-run-step'); item.dataset.status = state.status; steps.append(item); } this.runSurface.append(steps);
      const deliveries = this.renderDeliveries(run); if (deliveries) this.runSurface.append(deliveries);
      for (const [id, state] of states) if (state.status === 'waiting_review') this.runSurface.append(this.reviewControls(run, id)); const artifacts = runArtifacts(run); if (artifacts.length) { this.runSurface.append(element('h3', '', '全部产物'), this.artifactGallery(artifacts, { run, showOrigin: true }), button('打开本次输出目录', async () => { try { await this.api('/api/workflow-v2/open-directory', { method: 'POST', body: { runId: run.id } }); } catch (error) { this.editor.toast(error.message, true); } })); }
      if (run.error) this.runSurface.append(element('p', 'wf-studio-input-error', display(run.error)));
    }
    const selected = [...this.editor.selection].find(id => run?.nodes?.[id]); if (selected) this.renderInspectorData(selected); else if (this.view === 'run' && !this.editor.settings.propertiesClosed) { this.editor.settings.propertiesClosed = true; this.editor.applySettings(); } if (this.tab === 'queue') void this.renderQueue(); this.renderGraph();
  }
  async renderQueue() {
    if (!this.runtime || this.queueLoading) return; this.queueLoading = true;
    try { const result = await this.api('/api/workflow-v2/queue'); const runs = result.runs || result.queue || result.items || [...(result.running || []), ...(result.queued || [])]; this.queue.replaceChildren(element('h3', '', '运行队列')); if (!runs.length) this.queue.append(element('p', 'wf-field-help', '暂无排队任务。')); for (const run of runs) this.queue.append(button(`${run.document?.title || run.title || run.workflowId || run.id} · ${STUDIO_STATUS[run.status] || run.status}`, async () => { if (run.workflowId && run.workflowId !== this.editor.doc.id) { window.location.hash = `#/workflows/${encodeURIComponent(run.workflowId)}`; return; } if (run.id) { this.runtime.currentRunId = run.id; await this.runtime.loadRun(run.id); this.setView('run'); this.runtime.render(); } }, 'wf-studio-queue-item')); }
    catch (error) { this.queue.replaceChildren(element('p', 'wf-studio-input-error', error.message), button('刷新队列', () => void this.renderQueue())); } finally { this.queueLoading = false; }
  }
  autoLayout() {
    this.editor.measurePorts?.();
    const sizes = new Map(this.editor.doc.nodes.map(node => [node.id, this.editor.offsets?.get(`${node.id}:size`)]));
    const positions = layoutPositions(this.editor.doc, sizes);
    this.editor.commit({ ...this.editor.doc, nodes: this.editor.doc.nodes.map(node => ({ ...node, ...positions.get(node.id) })) }, '按依赖自动布局');
    requestAnimationFrame(() => this.editor.fit());
  }
  executable(type) { return isV2(this.editor.doc) || ['input', 'skill', 'tool', 'output', 'evaluation', 'improvement'].includes(type); }
  openSearch(clientX, clientY, origin = null, edge = null) {
    if (this.editor.nodeLibrary) return this.editor.nodeLibrary.openSearch(clientX, clientY, origin, edge);
    const editor = this.editor, menu = editor.contextMenu, bounds = editor.canvas.getBoundingClientRect(), point = editor.worldPoint(clientX, clientY); editor.cancelConnection(); menu.replaceChildren(element('strong', '', edge ? '在线中插入节点' : origin ? '连接兼容节点' : '添加节点'));
    const search = element('input'); search.type = 'search'; search.placeholder = '搜索节点…'; search.setAttribute('aria-label', '搜索要添加的节点'); const list = element('div', 'wf-context-items'); menu.append(search, list);
    const sourceNode = origin && editor.doc.nodes.find(node => node.id === origin.node), sourcePort = sourceNode && getPorts(sourceNode)[origin.direction === 'output' ? 'outputs' : 'inputs'].find(port => port.id === origin.port);
    const render = () => { list.replaceChildren(); for (const type of NODE_TYPES.filter(type => this.executable(type.type) && `${type.label} ${type.type} ${type.type === 'human' ? '人工审核' : ''}`.toLowerCase().includes(search.value.toLowerCase()))) { let candidate = createNode(type.type, point, { ...(isV2(editor.doc) && ['input', 'skill'].includes(type.type) ? { config: { outputType: 'object', ...(type.type === 'skill' ? { inputType: 'object' } : {}) } } : {}) }); if (isV2(editor.doc)) candidate = validateDocument({ ...editor.doc, nodes: [...editor.doc.nodes, candidate] }).nodes.at(-1); const direction = origin?.direction === 'output' ? 'inputs' : 'outputs'; if (origin && !getPorts(candidate)[direction].some(port => port.id !== 'learning' && portCompatible(port.type, sourcePort.type))) continue;
        if (edge) { const source = getPorts(editor.doc.nodes.find(node => node.id === edge.sourceNode)).outputs.find(port => port.id === edge.sourcePort), target = getPorts(editor.doc.nodes.find(node => node.id === edge.targetNode)).inputs.find(port => port.id === edge.targetPort), ports = getPorts(candidate); if (!ports.inputs.some(port => portCompatible(source.type, port.type)) || !ports.outputs.some(port => port.id !== 'learning' && portCompatible(port.type, target.type))) continue; }
        list.append(button(type.type === 'human' ? '人工审核' : type.label, () => { try { let next = { ...editor.doc, nodes: [...editor.doc.nodes, candidate] }; if (origin) { const port = getPorts(candidate)[direction].find(port => port.id !== 'learning' && portCompatible(port.type, sourcePort.type)); next = connectNodes(next, origin.direction === 'output' ? { sourceNode: origin.node, sourcePort: origin.port, targetNode: candidate.id, targetPort: port.id } : { sourceNode: candidate.id, sourcePort: port.id, targetNode: origin.node, targetPort: origin.port }); }
          if (edge) { const ports = getPorts(candidate); next.edges = next.edges.filter(item => item.id !== edge.id); const source = getPorts(editor.doc.nodes.find(node => node.id === edge.sourceNode)).outputs.find(port => port.id === edge.sourcePort), target = getPorts(editor.doc.nodes.find(node => node.id === edge.targetNode)).inputs.find(port => port.id === edge.targetPort); next = connectNodes(next, { sourceNode: edge.sourceNode, sourcePort: edge.sourcePort, targetNode: candidate.id, targetPort: ports.inputs.find(port => portCompatible(source.type, port.type)).id }); next = connectNodes(next, { sourceNode: candidate.id, sourcePort: ports.outputs.find(port => port.id !== 'learning' && portCompatible(port.type, target.type)).id, targetNode: edge.targetNode, targetPort: edge.targetPort }); } editor.commit(next, '添加并连接节点'); editor.selectNode(candidate.id); menu.hidden = true; } catch (error) { editor.toast(error.message, true); } }, 'wf-button')); }
      if (!list.childElementCount) list.append(element('p', 'wf-field-help', '没有兼容节点。可先添加节点再配置端口。'));
    }; search.addEventListener('input', render); render(); menu.hidden = false; menu.style.left = `${Math.max(8, Math.min(clientX - bounds.left, bounds.width - 260))}px`; menu.style.top = `${Math.max(54, Math.min(clientY - bounds.top, bounds.height - 400))}px`; search.focus();
  }
}
