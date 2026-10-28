import { createWorkflowIcon as icon, setToolbarControl } from './workflow-toolbar-controls.js';
import {
  NODE_GROUPS, NODE_TYPES, createDocument, createNode, getPorts,
  validateConnection, connectNodes, updateNode, removeNodes, removeEdge,
  validateDocument, serializeDocument,
} from '../shared/workflow/workflow-model.mjs';
import { WORKFLOW_TOOLS } from '../shared/workflow/workflow-tools.mjs';
import { builtinNodePresets, instantiatePreset } from '../shared/workflow/workflow-presets.mjs';
import { mainChainSkillNodes, mainChainToolNodes } from './workflow-learning-ui.js';
import { mergeLearningCandidate } from '../shared/workflow/workflow-learning-scope.mjs';
import { WorkflowStudioUI } from './workflow-studio-ui.js';
import { WorkflowNodeLibraryUI } from './workflow-node-library-ui.js';
import { vacantNodePosition, reviewTargetNodes, STUDIO_STATUS, layoutDocument, hasGeneratedNodes } from '../shared/workflow/workflow-studio-utils.mjs';
import { applyWorkflowOperations, documentFingerprint } from '../shared/workflow/workflow-conversation-commands.mjs';
import { workflowInputDefault } from '../shared/workflow/workflow-inputs.mjs';
import { SHORTCUT_ACTIONS, matchesShortcut, shortcutLabel } from '../shared/keyboard-shortcuts.mjs';

const STORAGE_KEY = 'workbench.workflow-editor.v1';
const ACTIVE_KEY = 'workbench.workflow-active.v1';
const DRAFT_PREFIX = 'workbench.workflow-document.v1:';
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const NS = 'http://www.w3.org/2000/svg';
const TYPES = new Map(NODE_TYPES.map(type => [type.type, type]));
const GROUPS = new Map(NODE_GROUPS.map(group => [group.id, group]));
const DATA_TYPES = ['fileRef', 'text', 'number', 'boolean', 'object', 'array', 'any'];
const COPY = {
  input: '输入 / 触发', validation: '校验', skill: 'AI / Skill', tool: '工具 / 代码', subflow: '子流程',
  transform: '数据整理', condition: '条件判断', foreach: '逐项处理', loop: '条件循环',
  human: '人工审核 / 补充', merge: '汇总', output: '产物输出', evaluation: '产物对比', improvement: '学习改进',
};
function svgElement(tag, attrs = {}) { const node = document.createElementNS(NS, tag); for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value); return node; }
function el(tag, className = '', text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function control(label, action, iconName, { compact = false, primary = false } = {}) {
  const node = el('button', compact ? 'wf-icon-button' : 'wf-button' + (primary ? ' primary' : ''));
  node.type = 'button'; node.dataset.action = action; node.setAttribute('aria-label', label); node.title = label;
  if (iconName) node.append(icon(iconName)); if (!compact) node.append(document.createTextNode(label)); return node;
}
function toolbarControl(label, action, glyph, { primary = false } = {}) {
  const button = control(label, action, glyph, { compact: true });
  if (primary) button.classList.add('primary');
  return setToolbarControl(button, { label, icon: glyph });
}
const clone = value => structuredClone(value);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const isTextTarget = target => target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
const near = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < 4;

// Local draft editor only: no Hermes requests, eval, or execution of node contents.
export class WorkflowEditor {
  constructor(container) {
    this.container = container;
    this.selection = new Set(); this.selectedEdge = null; this.history = []; this.future = [];
    this.propertyDrafts = new Map(); this.nodeElements = new Map(); this.edgeElements = new Map(); this.offsets = new Map();
    this.active = false; this.space = false; this.gesture = null; this.pendingConnection = null; this.hoverNode = null;
    this.clipboard = null; this.saveTimer = null; this.toastTimer = null; this.geometryFrame = null;
    this.unsaved = false; this.storageValue = null; this.storageConflict = false; this.corruptDraft = null;
    this.libraryLifecycle = 'active'; this.lifecycleDisabled = new WeakMap(); this.documentLoaded = true;
    this.settings = { snap: true, reduceMotion: false, canvasClosed: false, libraryClosed: true, propertiesClosed: true };
    this.doc = createDocument({ schemaVersion: 2 }); this.doc.viewport = { x: 48, y: 90, zoom: 1 };
    this.restore(); this.mount();
    this.studio = new WorkflowStudioUI(this);
    this.nodeLibrary = new WorkflowNodeLibraryUI(this);
    this.renderLibrary(); this.renderGraph(); this.renderProperties(); this.renderHeader(); this.applySettings();
    this.resizeObserver = new ResizeObserver(() => this.onCanvasResize()); this.resizeObserver.observe(this.canvas);
    window.addEventListener('resize', () => this.applySettings());
    window.addEventListener('keydown', event => this.onKeyDown(event));
    window.addEventListener('keyup', event => { if (event.code === 'Space') { this.space = false; this.canvas.classList.remove('pan-ready'); } });
    window.addEventListener('blur', () => { this.space = false; this.cancelGesture(); this.canvas.classList.remove('pan-ready'); });
    window.addEventListener('storage', event => {
      if (event.key !== (this.storageKey || STORAGE_KEY) || event.newValue === this.storageValue) return;
      clearTimeout(this.saveTimer); this.storageConflict = true; this.renderRecovery(); this.renderHeader();
    });
    window.addEventListener('pagehide', () => { this.cancelGesture(); if (this.unsaved && !this.storageConflict && !this.corruptDraft) this.persist(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) { this.cancelGesture(); this.clearPulses(); } });
  }

  restore() {
    let active;
    try { active = localStorage.getItem(ACTIVE_KEY); } catch { /* Still attempt the original draft if the active pointer is unavailable. */ }
    this.storageKey = typeof active === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(active) ? DRAFT_PREFIX + active : STORAGE_KEY;
    try {
      const raw = localStorage.getItem(this.storageKey); this.storageValue = raw;
      if (!raw) return;
      if (raw.length > MAX_FILE_BYTES * 2) throw new Error('草稿过大');
      const record = JSON.parse(raw);
      if (record.version !== 1) throw new Error('草稿版本不支持');
      this.doc = validateDocument(record.document);
      for (const key of Object.keys(this.settings)) if (typeof record.ui?.[key] === 'boolean') this.settings[key] = record.ui[key];
      this.recordCanvasSize(record.ui?.canvasSize || {});
    } catch {
      try { this.corruptDraft = localStorage.getItem(this.storageKey || STORAGE_KEY); } catch { this.saveError = '浏览器存储不可用，请导出 JSON。'; }
    }
  }

  mount() {
    const root = el('div', 'wf-editor');
    root.innerHTML = `
      <header class="wf-header">
        <div class="wf-heading"><input class="wf-document-title" aria-label="工作流名称" maxlength="120" required /><span class="wf-save-status" role="status"></span></div>
        <div class="wf-header-actions" role="group" aria-label="工作流操作">
          <div class="wf-mode" role="group" aria-label="工作流模式"><button type="button" data-mode="execute">执行</button><button type="button" data-mode="learn">学习</button></div>
        </div>
      </header>
      <div class="wf-recovery" role="status" hidden></div>
      <div class="wf-recovery wf-lifecycle-notice" role="status" hidden></div>
      <section class="wf-unloaded" aria-label="未加载工作流" hidden><div class="wf-unloaded-mark"></div><h2>未加载工作流</h2><div class="wf-unloaded-actions"></div></section>
      <div class="wf-body">
        <aside class="wf-library" aria-label="节点库"><div class="wf-library-head"><div class="wf-panel-heading"><h2>节点库</h2></div><input type="search" class="wf-search" aria-label="搜索节点" placeholder="搜索节点…" /></div><div class="wf-library-items"></div></aside>
        <section class="wf-center" aria-label="流程设计">
          <div class="wf-canvas" role="group" tabindex="0" aria-label="工作流画布">
            <div class="wf-world"><svg class="wf-edges" width="1" height="1" aria-label="节点连线"></svg><div class="wf-nodes"></div></div>
            <div class="wf-canvas-toolbar" role="toolbar" aria-label="画布工具"></div>
            <div class="wf-empty"><div class="wf-empty-mark"></div><h2>暂无节点</h2><div class="wf-empty-actions"></div></div>
            <div class="wf-connection-hint" role="status" hidden></div>
            <div class="wf-selection-box" hidden></div>
            <div class="wf-context-menu" role="dialog" aria-label="添加节点" hidden></div>
            <div class="wf-zoom-controls" role="group" aria-label="画布缩放"></div>
            <div class="wf-toast" role="status" aria-live="polite" hidden></div>
          </div>
        </section>
        <aside class="wf-properties" aria-label="节点属性"></aside>
      </div>
      <footer class="wf-statusbar"><div><span class="wf-count"></span><span class="wf-stage-label">执行模式 · 按连线串行执行</span></div></footer>
      <input type="file" class="wf-file-input" accept=".json,application/json" hidden />
      <dialog class="wf-dialog" aria-label="工作流对话框"></dialog>`;
    this.root = root; this.container.replaceChildren(root);
    const find = selector => root.querySelector(selector);
    this.canvas = find('.wf-canvas'); this.world = find('.wf-world'); this.svg = find('.wf-edges');
    this.nodesLayer = find('.wf-nodes'); this.properties = find('.wf-properties'); this.titleInput = find('.wf-document-title');
    this.contextMenu = find('.wf-context-menu'); this.dialog = find('.wf-dialog');
    find('.wf-empty-mark').append(icon('workflow'));
    find('.wf-unloaded-mark').append(icon('workflow'));
    find('.wf-unloaded-actions').append(control('新建工作流', 'new', 'plus', { primary: true }), control('导入工作流', 'import', 'upload'), control('返回工作流看板', 'board', 'board'));
    const header = find('.wf-header-actions');
    header.append(toolbarControl('返回工作流看板', 'board', 'board'));
    for (const [label, action, glyph] of [['重做', 'redo', 'redo'], ['撤销', 'undo', 'undo']]) header.prepend(toolbarControl(label, action, glyph));
    for (const button of header.querySelectorAll('[data-mode]')) setToolbarControl(button, { label: button.dataset.mode === 'learn' ? '学习模式' : '执行模式', icon: button.dataset.mode === 'learn' ? 'book' : 'workflow' });
    header.append(toolbarControl('新建工作流', 'new', 'plus'), toolbarControl('导入工作流', 'import', 'upload'), toolbarControl('导出工作流', 'export', 'download'), toolbarControl('保存工作流', 'save', 'save'), toolbarControl('打开工作流文件夹', 'open-folder', 'folder'), toolbarControl('定时任务', 'schedules', 'clock'));
    const run = toolbarControl('运行当前流程', 'run', 'play', { primary: true }); run.disabled = true; header.append(run);
    header.append(toolbarControl('隐藏画布', 'toggle-canvas', 'canvas'));
    const libraryToggle = toolbarControl('打开节点库', 'toggle-library', 'library'); libraryToggle.classList.add('wf-library-toggle'); header.append(libraryToggle);
    const toolbar = find('.wf-canvas-toolbar');
    toolbar.append(control('切换节点库', 'toggle-library', 'library', { compact: true }), control('适应画布', 'fit', 'fit', { compact: true }), control('网格吸附', 'snap', 'grid', { compact: true }), el('span', 'wf-toolbar-divider'), control('减少动效', 'motion', 'motion', { compact: true }), control('节点属性', 'toggle-properties', 'panel', { compact: true }), control('快捷键与说明', 'help', 'help', { compact: true }));
    find('.wf-library-head .wf-panel-heading').append(control('收起节点库', 'toggle-library', 'close', { compact: true }));
    find('.wf-empty-actions').append(control('添加输入节点', 'add-input', 'plus'), control('载入示例', 'example', 'workflow'));
    find('.wf-zoom-controls').append(control('缩小画布', 'zoom-out', 'minus', { compact: true }), el('output', 'wf-zoom-value', '100%'), control('放大画布', 'zoom-in', 'plus', { compact: true }), control('恢复 100% 缩放', 'reset-zoom', 'fit', { compact: true }));
    root.addEventListener('click', event => this.onClick(event));
    find('.wf-search').addEventListener('input', () => this.renderLibrary());
    this.bindTitleInput();
    root.addEventListener('pointerdown', event => this.onPointerDown(event));
    root.addEventListener('pointerover', event => this.onHover(event));
    root.addEventListener('pointerout', event => {
      const card = event.target.closest?.('.wf-node');
      if (card && !card.contains(event.relatedTarget)) { this.hoverNode = null; this.highlightEdges(); }
    });
    this.canvas.addEventListener('wheel', event => {
      if (event.target.closest('.wf-context-menu, .wf-canvas-toolbar, .wf-zoom-controls')) return;
      event.preventDefault(); if (this.gesture) return;
      this.zoomAt(this.doc.viewport.zoom * Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY);
    }, { passive: false });
    this.canvas.addEventListener('contextmenu', event => { event.preventDefault(); if (!this.gesture) { this.cancelConnection(); this.openContextMenu(event.clientX, event.clientY); } });
    this.canvas.addEventListener('dblclick', event => { const card = event.target.closest('.wf-node'); if (card) this.selectNode(card.dataset.id); else if (!this.libraryReadOnly && !event.target.closest('button,input,.wf-context-menu')) { const edge = event.target.closest('.wf-edge'); this.studio?.openSearch(event.clientX, event.clientY, null, edge ? this.doc.edges.find(item => item.id === edge.dataset.id) : null); } });
    root.addEventListener('dragover', event => event.preventDefault());
    root.addEventListener('drop', event => event.preventDefault());
    window.addEventListener('pointermove', event => this.onPointerMove(event));
    window.addEventListener('pointerup', event => this.onPointerUp(event));
    window.addEventListener('pointercancel', () => this.cancelGesture());
    find('.wf-file-input').addEventListener('change', async event => {
      const file = event.target.files[0]; if (!file) return;
      if (file.size > MAX_FILE_BYTES) { this.toast('JSON 文件不能超过 2 MB。', true); return; }
      try { this.openLegacyImport(await file.text()); } catch { this.toast('文件无法读取。', true); }
      event.target.value = '';
    });
    this.renderRecovery();
  }

  bindTitleInput() {
    this.titleInput.addEventListener('input', () => { this.titleDraft = { documentId: this.doc.id, value: this.titleInput.value }; });
    const apply = () => { try { this.flushTitleDraft(); } catch (error) { this.toast(error.message, true); } };
    this.titleInput.addEventListener('change', apply); this.titleInput.addEventListener('blur', apply);
    this.titleInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); apply(); } });
  }
  flushTitleDraft() {
    if (this.libraryReadOnly) { if (this.titleInput) this.titleInput.value = this.doc.title; return true; }
    const draft = this.titleDraft; if (!draft || draft.documentId !== this.doc.id) return true;
    const title = draft.value.trim();
    if (!title) { this.titleDraft = null; this.titleInput.value = this.doc.title; this.toast('工作流名称不能为空。', true); return false; }
    this.titleDraft = null;
    try {
      if (title !== this.doc.title) { if (['nodes', 'pan'].includes(this.gesture?.kind)) this.cancelGesture(); this.commit({ ...this.doc, title }, '修改流程名称'); }
      this.titleInput.value = title; return true;
    } catch (error) { this.titleDraft = draft; throw error; }
  }

  activate() { if (this.documentLoaded === false || this.active) return; this.active = true; this.requestGeometry(); }
  deactivate() { if (!this.active) return; this.nodeLibrary?.cancelNested(true); this.active = false; this.cancelGesture(); this.cancelConnection(); this.contextMenu.hidden = true; this.clearPulses(); if (this.dialog.open) this.dialog.close(); }

  captureDocumentState() {
    return { history: clone(this.history), future: clone(this.future), propertyDrafts: clone([...this.propertyDrafts]), validationDraftErrors: clone([...(this.validationDraftErrors || [])]), selection: [...this.selection], selectedEdge: this.selectedEdge };
  }
  useDocument(document, state, { persist = true } = {}) {
    this.nodeLibrary?.cancelNested(true);
    const next = validateDocument(document);
    this.cancelGesture(); this.cancelConnection(); clearTimeout(this.saveTimer);
    this.doc = next; this.documentLoaded = true; this.renderDocumentAvailability(); this.titleDraft = null; this.storageKey = DRAFT_PREFIX + next.id;
    try { this.storageValue = localStorage.getItem(this.storageKey); localStorage.setItem(ACTIVE_KEY, next.id); } catch { this.storageValue = null; }
    this.storageConflict = false; this.corruptDraft = null; this.saveError = ''; this.unsaved = false;
    this.history = clone(state?.history || []); this.future = clone(state?.future || []);
    this.propertyDrafts = new Map(clone(state?.propertyDrafts || [])); this.validationDraftErrors = new Map(clone(state?.validationDraftErrors || [])); this.selection = new Set(state?.selection || []); this.selectedEdge = state?.selectedEdge || null;
    this.runStates = {}; this.canvasSize = null; this.offsets.clear();
    this.pruneSelection(); this.renderGraph(); this.renderProperties(); this.renderHeader(); this.requestGeometry();
    if (persist && !this.libraryReadOnly) this.persist();
  }

  unloadDocument() {
    this.documentLoaded = false; this.active = false;
    this.nodeLibrary?.cancelNested(true); this.cancelGesture(); this.cancelConnection();
    clearTimeout(this.saveTimer); clearTimeout(this.toastTimer);
    if (this.geometryFrame) cancelAnimationFrame(this.geometryFrame);
    this.saveTimer = null; this.toastTimer = null; this.geometryFrame = null;
    if (this.contextMenu) this.contextMenu.hidden = true;
    if (this.dialog?.open) this.dialog.close();
    this.clearPulses();
    this.doc = createDocument({ schemaVersion: 2 });
    this.storageKey = null; this.storageValue = null; this.storageConflict = false; this.corruptDraft = null;
    this.saveError = ''; this.unsaved = false; this.libraryError = ''; this.libraryStatus = ''; this.libraryLifecycle = 'active';
    this.titleDraft = null; this.history = []; this.future = []; this.selection.clear(); this.selectedEdge = null;
    this.propertyDrafts.clear(); this.validationDraftErrors?.clear(); this.runStates = {}; this.canvasSize = null; this.offsets.clear();
    this.clipboard = null; this.hoverNode = null;
    try { localStorage.removeItem(ACTIVE_KEY); } catch { /* Stored drafts remain available when browser storage is unavailable. */ }
    this.renderDocumentAvailability(); this.renderGraph(); this.renderProperties(); this.renderHeader();
  }
  renderDocumentAvailability() {
    const unloaded = this.documentLoaded === false;
    this.root?.classList?.toggle('document-unloaded', unloaded);
    const empty = this.root?.querySelector?.('.wf-unloaded'); if (empty) empty.hidden = !unloaded;
  }

  get libraryReadOnly() { return this.documentLoaded === false || Boolean(this.libraryLifecycle && this.libraryLifecycle !== 'active'); }
  setLibraryLifecycle(lifecycle) {
    if (lifecycle === 'archived') lifecycle = 'trashed';
    if (!['active', 'trashed', 'deleted'].includes(lifecycle)) throw new Error('无效的工作流管理状态。');
    this.nodeLibrary?.cancelNested(true); this.cancelGesture(); this.cancelConnection(); clearTimeout(this.saveTimer);
    this.libraryLifecycle = lifecycle;
    if (this.libraryReadOnly) {
      this.unsaved = false; this.saveError = '';
      if (this.contextMenu) this.contextMenu.hidden = true;
      if (this.dialog?.open) this.dialog.close();
    }
    if (this.root) { if (this.studio) this.renderLibrary(); this.renderProperties(); this.renderHeader(); }
  }
  applyLibraryReadOnly() {
    const readonly = this.libraryReadOnly;
    const notice = this.root?.querySelector?.('.wf-lifecycle-notice');
    if (notice) {
      notice.hidden = !readonly;
      notice.textContent = this.libraryLifecycle === 'deleted' ? '已永久删除 · 只读，本地草稿保留供导出；请返回看板。'
        : '回收站 · 只读，请回看板恢复。';
    }
    this.lifecycleDisabled ||= new WeakMap();
    const selectors = '.wf-document-title, .wf-mode:not(.wf-view-switch) button, .wf-library-item, .wf-port, .wf-property-form input, .wf-property-form select, .wf-property-form textarea, .wf-property-form button, .wf-properties [data-action="duplicate"], .wf-properties [data-action="delete"], .wf-properties [data-action="remove-edge"], [data-action="undo"], [data-action="redo"], [data-action="new"], [data-action="import"], [data-action="save"], [data-action="run"], [data-action="schedules"], [data-action="add-input"], [data-action="example"]';
    const controls = [...(this.root?.querySelectorAll?.(selectors) || []), ...[this.studio?.check, this.studio?.upgrade].filter(Boolean)];
    // The unnamed studio toolbar's layout button is its only graph mutation.
    for (const item of this.root?.querySelectorAll?.('.wf-canvas-toolbar .wf-studio-small') || []) controls.push(item);
    for (const item of controls) {
      if (readonly) { if (!this.lifecycleDisabled.has(item)) this.lifecycleDisabled.set(item, item.disabled); item.disabled = true; }
      else if (this.lifecycleDisabled.has(item)) { item.disabled = this.lifecycleDisabled.get(item); this.lifecycleDisabled.delete(item); }
    }
  }

  renderHeader() {
    this.renderDocumentAvailability(); if (this.documentLoaded === false) return;
    if (document.activeElement !== this.titleInput) this.titleInput.value = this.titleDraft?.documentId === this.doc.id ? this.titleDraft.value : this.doc.title;
    const status = this.root.querySelector('.wf-save-status');
    status.textContent = this.storageConflict ? '另一标签页有更新' : this.corruptDraft ? '原草稿待恢复' : this.saveError || (this.propertyDrafts.size ? `${this.propertyDrafts.size} 个属性待应用` : this.unsaved ? '保存中…' : this.libraryStatus || (this.storageValue ? '已保存 · 此浏览器' : '本浏览器草稿'));
    status.title = this.libraryError || ''; status.dataset.state = this.saveError || this.corruptDraft || this.storageConflict || this.libraryError ? 'error' : 'ready';
    this.root.querySelector('[data-action="undo"]').disabled = !this.history.length;
    this.root.querySelector('[data-action="redo"]').disabled = !this.future.length;
    for (const button of this.root.querySelectorAll('[data-mode]')) { button.setAttribute('aria-pressed', String(button.dataset.mode === this.doc.mode)); }
    this.root.querySelector('.wf-count').textContent = `${this.doc.nodes.length} 个节点 · ${this.doc.edges.length} 条连线`;
    this.root.querySelector('.wf-stage-label').textContent = this.doc.mode === 'learn' ? '学习模式 · 按指定范围改进' : this.doc.schemaVersion === 2 ? `执行模式 · 按依赖并行 · 最多 ${this.doc.settings?.maxConcurrency || 4} 项` : '执行模式 · 按连线串行执行';
    this.studio?.syncDocument();
    this.runtime?.updateRunButton();
    this.applyLibraryReadOnly();
    this.nodeLibrary?.syncHeader();
    this.conversation?.syncWorkflow();
    this.versioning?.syncHeader();
    this.updateShortcutHints();
    this.packages?.renderControls();
  }

  updateShortcutHints() {
    const bindings = this.getShortcuts?.();
    const actions = { save: 'workflow.save', undo: 'workflow.undo', redo: 'workflow.redo', duplicate: 'canvas.duplicate',
      delete: 'canvas.delete', fit: 'canvas.fit', 'toggle-library': 'canvas.toggleLibrary', 'toggle-properties': 'canvas.toggleProperties', help: 'canvas.help' };
    for (const [action, id] of Object.entries(actions)) for (const button of this.root?.querySelectorAll?.(`[data-action="${action}"]`) || []) {
      const previous = button.dataset.shortcutHint, current = button.getAttribute?.('aria-label') || button.title || SHORTCUT_ACTIONS.find(item => item.id === id).label;
      const base = previous && current.endsWith(' · ' + previous) ? current.slice(0, -previous.length - 3) : current;
      const hint = shortcutLabel(id, bindings), label = hint === '未设置' ? base : `${base} · ${hint}`;
      button.dataset.shortcutHint = hint === '未设置' ? '' : hint;
      button.setAttribute('aria-label', label); button.title = label;
      if (button.classList.contains('wf-toolbar-button')) button.dataset.tooltip = label;
    }
  }

  panelSettings() {
    // Running and inspecting a flow should not rewrite the editing layout.
    if (this.studio?.view === 'run') return this.studio.runPanelSettings ||= { libraryClosed: true, propertiesClosed: true };
    return this.settings;
  }
  setPanelClosed(panel, closed) {
    this.panelSettings()[panel + 'Closed'] = closed;
    this.applySettings();
  }
  setCanvasClosed(closed) {
    this.cancelGesture(); this.cancelConnection(); this.settings.canvasClosed = closed;
    this.applySettings(); this.scheduleSave();
    if (!closed) requestAnimationFrame(() => this.onCanvasResize());
  }
  applySettings() {
    const canvasClosed = this.settings.canvasClosed === true, panels = this.panelSettings();
    let libraryClosed = canvasClosed || panels.libraryClosed === true, propertiesClosed = canvasClosed || panels.propertiesClosed === true;
    if (innerWidth <= 780 && !libraryClosed && !propertiesClosed) {
      if (this.selection.size || this.selectedEdge) libraryClosed = true;
      else propertiesClosed = true;
    }
    this.root.classList.toggle('canvas-closed', canvasClosed);
    this.root.classList.toggle('library-closed', libraryClosed);
    this.root.classList.toggle('properties-closed', propertiesClosed);
    this.root.classList.toggle('reduce-motion', this.settings.reduceMotion);
    for (const [action, pressed] of [['toggle-library', !libraryClosed], ['toggle-properties', !propertiesClosed], ['snap', this.settings.snap], ['motion', this.settings.reduceMotion]]) {
      for (const button of this.root.querySelectorAll(`[data-action="${action}"]`)) button.setAttribute('aria-pressed', String(pressed));
    }
    for (const button of this.root.querySelectorAll('[data-action="toggle-canvas"]')) {
      const label = canvasClosed ? '显示画布' : '隐藏画布'; setToolbarControl(button, { label, icon: canvasClosed ? 'canvas-off' : 'canvas' }); button.setAttribute('aria-expanded', String(!canvasClosed));
    }
    for (const button of this.root.querySelectorAll('.wf-library-toggle')) { const label = this.studio?.view === 'run' ? '输入资料' : '节点库'; setToolbarControl(button, { label, icon: 'library' }); }
    this.updateShortcutHints();
    this.requestGeometry();
  }

  togglePanel(panel) {
    const target = this.propertyDocument();
    if (panel === 'properties' && (this.documentLoaded === false || !target?.nodes.some(node => this.selection.has(node.id)) && !target?.edges.some(edge => edge.id === this.selectedEdge))) {
      this.setPanelClosed('properties', true); return;
    }
    const panels = this.panelSettings(), key = panel + 'Closed'; panels[key] = !panels[key];
    if (innerWidth <= 780 && !panels[key]) panels[panel === 'library' ? 'propertiesClosed' : 'libraryClosed'] = true;
    if (panel === 'library' && this.studio?.view === 'run') this.studio.setTab('inputs');
    this.applySettings(); if (this.studio?.view !== 'run') this.scheduleSave();
  }

  renderLibrary() {
    if (this.nodeLibrary) return this.nodeLibrary.render();
    const query = this.root.querySelector('.wf-search').value.trim().toLowerCase(), parent = this.root.querySelector('.wf-library-items'); parent.replaceChildren();
    for (const group of NODE_GROUPS) {
      const types = NODE_TYPES.filter(type => type.category === group.id && `${COPY[type.type]} ${type.type} ${type.description}`.toLowerCase().includes(query));
      if (!types.length) continue;
      const section = el('section', 'wf-library-group'); section.append(el('h3', '', group.label));
      for (const type of types) {
        const item = el('button', 'wf-library-item'); item.type = 'button'; item.dataset.type = type.type; item.dataset.category = type.category;
        if (this.libraryReadOnly || this.studio && !this.studio.executable(type.type)) { item.disabled = true; item.title = this.libraryReadOnly ? '只读工作流' : '此版本暂不支持执行'; }
        item.style.setProperty('--node-color', group.color); item.setAttribute('aria-label', `添加${COPY[type.type]}节点`);
        const typeIcon = el('span', 'wf-type-icon'); typeIcon.append(icon(type.icon));
        const content = el('span'); content.append(el('strong', '', COPY[type.type] || type.label), el('small', 'wf-library-item-description', item.disabled ? '暂不可执行' : type.description));
        item.append(typeIcon, content, el('span', 'wf-drag-grip', '⠿')); section.append(item);
      }
      parent.append(section);
    }
    const toolGroup = GROUPS.get(TYPES.get('tool').category);
    for (const [domain, label] of [['builtin', '内置派生节点']]) {
      const tools = WORKFLOW_TOOLS.filter(tool => `派生节点 ${tool.id} ${tool.label} ${tool.description}`.toLowerCase().includes(query));
      if (!tools.length) continue;
      const section = el('section', 'wf-library-group'); section.append(el('h3', '', label));
      for (const tool of tools) {
        const item = el('button', 'wf-library-item'); item.type = 'button'; item.dataset.type = 'tool'; item.dataset.toolName = tool.id; item.dataset.category = toolGroup.id;
        item.disabled = this.libraryReadOnly || this.doc.schemaVersion !== 2; item.title = item.disabled ? '只读或尚未升级的工作流不可添加能力。' : tool.description; item.style.setProperty('--node-color', toolGroup.color); item.setAttribute('aria-label', `添加${tool.label}能力`);
        const tile = el('span', 'wf-type-icon'); tile.append(icon('code')); const content = el('span'); content.append(el('strong', '', tool.label), el('small', 'wf-library-item-description', item.disabled ? '升级后可添加此能力' : tool.description + (tool.reviewRequired ? ' · 必须人工审核' : '')), el('small', 'wf-preset-parent', '派生自：工具与代码（基础节点）'));
        item.append(tile, content, el('span', 'wf-drag-grip', '⠿')); section.append(item);
      }
      parent.append(section);
    }
    if (!parent.childElementCount) parent.append(el('p', 'wf-library-no-results', '没有匹配的节点。'));
  }

  renderGraph() {
    this.nodesLayer.replaceChildren(); this.nodeElements.clear(); this.offsets.clear();
    if (this.documentLoaded === false) { this.svg.replaceChildren(); this.edgeElements.clear(); return; }
    for (const node of this.doc.nodes) {
      const definition = TYPES.get(node.type), group = GROUPS.get(definition.category);
      const card = el('div', 'wf-node' + (['foreach', 'loop'].includes(node.type) ? ' loop-node' : '') + (node.type === 'subflow' ? ' subflow-node' : ''));
      card.dataset.id = node.id; card.dataset.type = node.type; card.dataset.category = definition.category;
      card.style.setProperty('--node-color', group.color); card.style.left = `${node.x}px`; card.style.top = `${node.y}px`;
      card.tabIndex = 0; card.setAttribute('role', 'group'); card.setAttribute('aria-label', `${COPY[node.type]}：${node.title}`);
      const head = el('div', 'wf-node-header'), tile = el('span', 'wf-type-icon'); tile.append(icon(definition.icon));
      const title = el('span', 'wf-node-title', node.title); title.title = node.title;
      head.append(tile, title, el('span', 'wf-node-kind', node.type === 'skill' ? 'Skill' : node.type === 'tool' ? '工具' : node.type === 'subflow' ? '子流程' : ''));
      card.append(head, el('p', 'wf-node-meta', this.summary(node)));
      const runBadge = el('span', 'wf-node-run-badge'); runBadge.hidden = true; card.append(runBadge);
      const ports = getPorts(node), portArea = el('div', 'wf-node-ports');
      for (const [direction, list] of [['input', ports.inputs], ['output', ports.outputs]]) {
        const column = el('div', 'wf-port-column');
        for (const port of list) {
          const row = el('div', 'wf-port-row'), socket = el('button', 'wf-port');
          socket.type = 'button'; socket.dataset.node = node.id; socket.dataset.port = port.id; socket.dataset.direction = direction;
          socket.disabled = this.libraryReadOnly;
          socket.setAttribute('aria-label', `${node.title} · ${port.label} · ${port.type} · ${direction === 'input' ? '输入端口' : '输出端口'}`);
          socket.title = `${port.label} · ${port.type}（点击或拖动连接）`;
          row.append(socket, el('span', 'wf-port-label', `${port.label} · ${port.type}`)); column.append(row);
        }
        portArea.append(column);
      }
      card.append(portArea);
      if (['foreach', 'loop'].includes(node.type)) {
        const scope = el('div', 'wf-loop-scope'); scope.append(icon(node.type === 'foreach' ? 'list' : 'repeat'), el('span', '', node.config.workflowRef || '在属性中配置循环体引用')); card.append(scope);
      }
      this.nodesLayer.append(card); this.nodeElements.set(node.id, card);
    }
    this.renderEdges(); this.renderSelection(); this.root.querySelector('.wf-empty').hidden = this.doc.nodes.length > 0;
    this.applyViewport(); this.requestGeometry(); this.renderHeader(); this.setRunStates(this.runStates || {}); this.studio?.renderGraph();
  }

  summary(node) {
    const c = node.config;
    if (node.type === 'input') return c.trigger === 'schedule' ? `定时 ${c.schedule} · ${c.timezone}` : c.fieldName || '手动输入';
    if (node.type === 'validation') return `${c.rules?.length || 0} 条规则 · 通过后传递原输入`;
    if (node.type === 'skill') return [c.skillRef || '尚未指定 Skill', c.version || '版本待配置'].join(' · ');
    if (node.type === 'tool') return c.executionMode === 'tool' ? WORKFLOW_TOOLS.find(tool => tool.id === c.toolName)?.label || c.toolName || '请选择内置工具' : `${c.language === 'python' ? 'Python' : 'JavaScript'} · 代码执行`;
    if (node.type === 'subflow') return c.document ? `${c.document.title} · ${c.document.nodes.length} 个内部节点` : c.workflowRef || '尚未指定子流程';
    if (node.type === 'condition') return c.expression || '配置判断表达式';
    if (node.type === 'foreach') return `逐项处理 · 最多 ${c.maxIterations} 项`;
    if (node.type === 'loop') return `逐轮执行 · 最多 ${c.maxIterations} 轮`;
    if (node.type === 'human') return c.prompt ? c.prompt.length > 72 ? c.prompt.slice(0, 72) + '…' : c.prompt : '审核产物 · 通过 / 修改 / 停止';
    if (node.type === 'output') return `${c.stage === 'intermediate' ? '阶段产物' : '最终交付'} · ${c.fileName || '返回结果 / 成果引用'}`;
    if (node.type === 'evaluation') return `${c.comparison === 'model' ? 'AI 评价' : '精确对比'} · ${c.valuePath || '完整连线产物'}`;
    if (node.type === 'improvement') return c.scope === 'workflow' ? '改进整个业务流程' : c.scope === 'tools' ? c.targetNodeIds?.length ? `仅改进 ${c.targetNodeIds.length} 个工具或代码节点` : '明确选择工具或代码节点' : c.targetSkillNodeIds.length ? `仅改进 ${c.targetSkillNodeIds.length} 个 Skill` : '明确选择要改进的 Skill';
    if (node.type === 'merge') return '等待各分支完成 · 汇总具名输入';
    return `${c.language} · 字段映射与格式整理`;
  }

  renderEdges() {
    this.svg.replaceChildren(); this.edgeElements.clear();
    const defs = svgElement('defs'), marker = svgElement('marker', { id: 'wf-arrow', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '5', markerHeight: '5', orient: 'auto-start-reverse', markerUnits: 'strokeWidth' });
    marker.append(svgElement('path', { d: 'M1 1 L9 5 L1 9 Z', fill: 'context-stroke' })); defs.append(marker); this.svg.append(defs);
    for (const edge of this.doc.edges) {
      const source = this.doc.nodes.find(node => node.id === edge.sourceNode), target = this.doc.nodes.find(node => node.id === edge.targetNode);
      const group = svgElement('g', { class: 'wf-edge', 'data-id': edge.id, role: 'button', tabindex: '0', 'aria-label': `连线：${source.title} → ${target.title}` });
      group.append(svgElement('path', { class: 'wf-edge-line', 'marker-end': 'url(#wf-arrow)' }), svgElement('path', { class: 'wf-edge-hit' }));
      this.svg.append(group); this.edgeElements.set(edge.id, group);
    }
    this.draftPath = svgElement('path', { class: 'wf-edge-line draft' }); this.draftPath.style.display = 'none'; this.svg.append(this.draftPath); this.highlightEdges();
  }

  requestGeometry() {
    if (this.geometryFrame) return;
    this.geometryFrame = requestAnimationFrame(() => { this.geometryFrame = null; this.measurePorts(); this.updateGeometry(); });
  }
  recordCanvasSize({ width, height }) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false;
    this.canvasSize = { width, height }; return true;
  }
  onCanvasResize() {
    if (this.studio?.view === 'run' || this.canvas.offsetParent === null) return;
    const previous = this.canvasSize, size = this.canvas.getBoundingClientRect();
    if (this.recordCanvasSize(size) && previous) {
      const dx = (size.width - previous.width) / 2, dy = (size.height - previous.height) / 2;
      if (dx || dy) {
        // Preserve the world point at the viewport centre without changing zoom
        // or node positions. Gesture baselines must retain the same camera shift.
        const views = new Set([this.doc.viewport, this.gesture?.kind === 'pan' ? this.gesture.viewport : null, this.gesture?.kind === 'nodes' ? this.gesture.before?.viewport : null]);
        for (const view of views) if (view) { view.x = clamp(view.x + dx, -100000, 100000); view.y = clamp(view.y + dy, -100000, 100000); }
        this.applyViewport(); this.scheduleSave();
      }
    }
    this.requestGeometry();
  }
  measurePorts() {
    const zoom = this.doc.viewport.zoom;
    for (const [id, card] of this.nodeElements) {
      const rect = card.getBoundingClientRect(); if (!rect.width) continue;
      for (const port of card.querySelectorAll('.wf-port')) {
        const p = port.getBoundingClientRect();
        this.offsets.set(`${id}:${port.dataset.direction}:${port.dataset.port}`, { x: (p.left + p.width / 2 - rect.left) / zoom, y: (p.top + p.height / 2 - rect.top) / zoom });
      }
      this.offsets.set(`${id}:size`, { width: rect.width / zoom, height: rect.height / zoom });
    }
  }
  portPoint(nodeId, direction, portId) {
    const node = this.doc.nodes.find(node => node.id === nodeId); if (!node) return { x: 0, y: 0 };
    const offset = this.offsets.get(`${nodeId}:${direction}:${portId}`) || { x: direction === 'input' ? 0 : 224, y: 90 };
    return { x: node.x + offset.x, y: node.y + offset.y };
  }
  curve(a, b) {
    if (b.x >= a.x + 25) { const d = Math.max(45, (b.x - a.x) * .5); return `M${a.x},${a.y} C${a.x + d},${a.y} ${b.x - d},${b.y} ${b.x},${b.y}`; }
    const detour = Math.max(70, Math.min(180, Math.abs(a.x - b.x) * .35)), middleY = (a.y + b.y) / 2 + (Math.abs(a.y - b.y) < 80 ? 95 : 0);
    return `M${a.x},${a.y} C${a.x + detour},${a.y} ${a.x + detour},${middleY} ${(a.x + b.x) / 2},${middleY} S${b.x - detour},${b.y} ${b.x},${b.y}`;
  }
  updateGeometry() {
    for (const edge of this.doc.edges) {
      const group = this.edgeElements.get(edge.id); if (!group) continue;
      const d = this.curve(this.portPoint(edge.sourceNode, 'output', edge.sourcePort), this.portPoint(edge.targetNode, 'input', edge.targetPort));
      for (const path of group.querySelectorAll('path')) path.setAttribute('d', d);
    }
    this.drawPendingConnection();
  }
  applyViewport() {
    const v = this.doc.viewport; this.world.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`;
    this.canvas.style.setProperty('--wf-grid-size', `${24 * v.zoom}px`); this.canvas.style.setProperty('--wf-grid-x', `${v.x}px`); this.canvas.style.setProperty('--wf-grid-y', `${v.y}px`);
    this.root.querySelector('.wf-zoom-value').value = `${Math.round(v.zoom * 100)}%`;
  }
  worldPoint(clientX, clientY) { const r = this.canvas.getBoundingClientRect(), v = this.doc.viewport; return { x: (clientX - r.left - v.x) / v.zoom, y: (clientY - r.top - v.y) / v.zoom }; }
  zoomAt(zoom, clientX, clientY) {
    zoom = clamp(zoom, .1, 2); const r = this.canvas.getBoundingClientRect();
    this.recordCanvasSize(r);
    const cx = clientX ?? r.left + r.width / 2, cy = clientY ?? r.top + r.height / 2, point = this.worldPoint(cx, cy);
    this.doc.viewport = { x: clamp(cx - r.left - point.x * zoom, -100000, 100000), y: clamp(cy - r.top - point.y * zoom, -100000, 100000), zoom };
    this.applyViewport(); this.scheduleSave();
  }
  fit() {
    this.cancelConnection();
    if (!this.doc.nodes.length) { this.doc.viewport = { x: 48, y: 90, zoom: 1 }; this.applyViewport(); this.scheduleSave(); return; }
    const r = this.canvas.getBoundingClientRect(); if (!r.width || !r.height) return; this.measurePorts();
    this.recordCanvasSize(r);
    let visibleLeft = 0, visibleRight = r.width;
    const panels = this.panelSettings(), canvasLeft = r.left ?? 0, canvasTop = r.top ?? 0;
    for (const [element, closed, side] of [[this.properties, panels.propertiesClosed, 'right'], [this.root?.querySelector?.('.wf-library'), panels.libraryClosed, 'left']]) {
      if (closed) continue;
      const panel = element?.getBoundingClientRect?.();
      if (!(panel?.width > 0 && panel.height > 0 && panel.left < canvasLeft + r.width && panel.right > canvasLeft && panel.top < canvasTop + r.height && panel.bottom > canvasTop)) continue;
      if (side === 'right') visibleRight = Math.min(visibleRight, panel.left - canvasLeft);
      else visibleLeft = Math.max(visibleLeft, panel.right - canvasLeft);
    }
    const visibleWidth = visibleRight - visibleLeft; if (visibleWidth <= 0) return;
    const bounds = this.doc.nodes.map(node => ({ x: node.x, y: node.y, ...this.nodeSize(node.id) }));
    const left = Math.min(...bounds.map(b => b.x)), top = Math.min(...bounds.map(b => b.y)), right = Math.max(...bounds.map(b => b.x + b.width)), bottom = Math.max(...bounds.map(b => b.y + b.height));
    const width = right - left, height = bottom - top, padding = Math.min(32, visibleWidth * .05, r.height * .08), topPadding = Math.min(56, r.height * .2);
    const availableWidth = Math.max(1, visibleWidth - padding * 2), availableHeight = Math.max(1, r.height - topPadding - padding);
    const zoom = clamp(Math.min(availableWidth / width, availableHeight / height, 1), .1, 2), scaledHeight = height * zoom;
    // At the minimum zoom, relax padding before allowing a node to be clipped.
    const y = scaledHeight <= r.height ? clamp(topPadding + (availableHeight - scaledHeight) / 2, 0, r.height - scaledHeight) : (r.height - scaledHeight) / 2;
    this.doc.viewport = { x: clamp(visibleLeft + (visibleWidth - width * zoom) / 2 - left * zoom, -100000, 100000), y: clamp(y - top * zoom, -100000, 100000), zoom };
    this.applyViewport(); this.scheduleSave();
    const v = this.doc.viewport;
    if (left * zoom + v.x < visibleLeft - .5 || right * zoom + v.x > visibleRight + .5 || top * zoom + v.y < -.5 || bottom * zoom + v.y > r.height + .5) this.toast('已缩至当前可用比例，仍有节点超出画布。请平移查看，或收起底部面板后再次适应画布。');
  }
  nodeSize(id) { return this.offsets.get(`${id}:size`) || { width: 224, height: 125 }; }

  renderSelection() {
    for (const [id, card] of this.nodeElements) card.classList.toggle('selected', this.selection.has(id));
    for (const [id, edge] of this.edgeElements) edge.classList.toggle('selected', this.selectedEdge === id);
    for (const socket of this.nodesLayer.querySelectorAll('.wf-port')) {
      const connected = this.doc.edges.some(edge => socket.dataset.direction === 'input' ? edge.targetNode === socket.dataset.node && edge.targetPort === socket.dataset.port : edge.sourceNode === socket.dataset.node && edge.sourcePort === socket.dataset.port);
      socket.classList.toggle('connected', connected);
    }
    this.highlightEdges();
  }
  highlightEdges() { for (const edge of this.doc.edges) this.edgeElements.get(edge.id)?.classList.toggle('related', !this.gesture && Boolean(this.hoverNode && [edge.sourceNode, edge.targetNode].includes(this.hoverNode))); }
  selectNode(id, additive = false) {
    this.selectedEdge = null;
    if (additive && this.selection.has(id)) this.selection.delete(id);
    else { if (!additive) this.selection.clear(); this.selection.add(id); }
    if (!this.settings.canvasClosed) { const panels = this.panelSettings(); panels.propertiesClosed = false; if (innerWidth <= 780) panels.libraryClosed = true; }
    this.applySettings(); this.renderSelection(); this.renderProperties();
    this.runtime?.onSelectionChange?.(this.selection.size === 1 ? [...this.selection][0] : null);
    this.conversation?.render();
    requestAnimationFrame(() => this.ensureVisible(id));
  }
  selectEdge(id) { this.selection.clear(); this.selectedEdge = id; if (!this.settings.canvasClosed) { const panels = this.panelSettings(); panels.propertiesClosed = false; if (innerWidth <= 780) panels.libraryClosed = true; } this.applySettings(); this.renderSelection(); this.renderProperties(); }
  ensureVisible(id) {
    if (this.gesture || !this.active || this.studio?.view === 'run' || this.canvas.offsetParent === null) return;
    const node = this.doc.nodes.find(n => n.id === id); if (!node) return;
    const rect = this.canvas.getBoundingClientRect(), { width, height } = rect, v = this.doc.viewport, size = this.nodeSize(id);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
    this.recordCanvasSize({ width, height });
    const x = node.x * v.zoom + v.x, y = node.y * v.zoom + v.y, nodeWidth = size.width * v.zoom, nodeHeight = size.height * v.zoom;
    let right = width - 30;
    if (!this.settings.propertiesClosed) {
      const panel = this.properties?.getBoundingClientRect?.();
      const left = rect.left ?? 0, top = rect.top ?? 0;
      if (panel?.width > 0 && panel.height > 0 && panel.left < left + width && panel.right > left && panel.top < top + height && panel.bottom > top) {
        right = Math.min(right, panel.left - left - 14);
      }
    }
    // A narrow drawer may leave no room for the node. Keep the user's horizontal
    // camera rather than moving the whole node beyond the left canvas edge.
    if (right - 25 >= nodeWidth) {
      if (x < 25) v.x += 25 - x;
      else if (x + nodeWidth > right) v.x -= x + nodeWidth - right;
    }
    // When the canvas is short, prefer a visible node top to an impossible
    // bottom margin that would place the top above the canvas.
    const top = Math.min(65, Math.max(0, height - nodeHeight)), bottom = Math.max(top, height - 65 - nodeHeight);
    if (y < top) v.y += top - y;
    else if (y > bottom) v.y -= y - bottom;
    v.x = clamp(v.x, -100000, 100000); v.y = clamp(v.y, -100000, 100000);
    this.applyViewport();
  }

  recoverCanvasViewport() {
    if (!this.active || this.studio?.view === 'run' || this.canvas.offsetParent === null || this.gesture) return false;
    const { width, height } = this.canvas.getBoundingClientRect(); if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || !this.doc.nodes.length) return false;
    this.onCanvasResize();
    const v = this.doc.viewport, valid = v && [v.x, v.y, v.zoom].every(Number.isFinite) && v.zoom > 0;
    const visible = valid && this.doc.nodes.some(node => { const size = this.nodeSize(node.id), x = node.x * v.zoom + v.x, y = node.y * v.zoom + v.y, w = size.width * v.zoom, h = size.height * v.zoom; return Math.min(width, x + w) - Math.max(0, x) >= Math.min(60, w, width) && Math.min(height, y + h) - Math.max(0, y) >= Math.min(32, h, height); });
    if (visible) return false;
    this.fit(); return true;
  }

  propertyDocument() {
    const run = this.studio?.view === 'run' ? this.runtime?.currentRun?.() : null;
    return run?.workflowId === this.doc.id ? run.document || this.doc : this.doc;
  }
  renderProperties() {
    const target = this.propertyDocument(), selected = (target?.nodes || []).filter(node => this.selection.has(node.id));
    if (this.documentLoaded === false || !selected.length && !target?.edges.some(edge => edge.id === this.selectedEdge)) {
      this.properties?.replaceChildren();
      if (this.panelSettings().propertiesClosed !== true) this.setPanelClosed('properties', true);
      return;
    }
    const parent = this.properties; parent.replaceChildren();
    const heading = el('div', 'wf-properties-head'); heading.append(el('h2', '', this.selectedEdge ? '连线属性' : '节点属性'), control('关闭属性面板', 'toggle-properties', 'close', { compact: true })); parent.append(heading);
    if (this.selectedEdge) { this.renderEdgeProperties(); this.applyLibraryReadOnly(); return; }
    if (selected.length > 1) {
      parent.append(el('p', 'wf-field-help', `已选中 ${selected.length} 个节点`));
      const row = el('div', 'wf-property-actions'); row.append(control('复制所选节点', 'duplicate', 'copy'), control('删除所选节点', 'delete', 'trash')); parent.append(row); this.nodeLibrary?.renderInspector(selected); this.applyLibraryReadOnly(); return;
    }
    const node = selected[0], definition = TYPES.get(node.type), group = GROUPS.get(definition.category);
    const kind = el('div', 'wf-property-kind'); kind.dataset.category = definition.category; kind.style.setProperty('--node-color', group.color);
    const tile = el('span', 'wf-type-icon'); tile.append(icon(definition.icon)); kind.append(tile, el('strong', '', COPY[node.type] || definition.label), el('span', 'wf-badge', ['evaluation', 'improvement'].includes(node.type) ? '仅学习' : this.doc.schemaVersion === 2 || ['input', 'skill', 'tool', 'output'].includes(node.type) ? '支持执行' : '仅编排')); parent.append(kind);
    if (this.studio?.view === 'run') { this.studio.renderInspectorData(node.id); return; }
    const draft = this.propertyDrafts.get(node.id) || { title: node.title, config: clone(node.config) }, form = el('form', 'wf-property-form'); form.dataset.node = node.id;
    this.field(form, '节点名称', 'title', draft.title, { maxLength: 120, required: true }); const c = draft.config;
    if (node.type === 'input') {
      if (this.doc.schemaVersion !== 2) this.field(form, '启动方式', 'trigger', c.trigger || 'manual', { options: [['manual', '手动输入'], ['schedule', '定时触发']] });
      this.field(form, '输入字段名', 'fieldName', c.fieldName, { maxLength: 128 }); this.field(form, '必填', 'required', c.required, { type: 'checkbox' });
      const fixedInput = workflowInputDefault({ type: 'input', config: c });
      this.field(form, c.outputType === 'text' ? '固定任务说明 / 默认输入' : '默认输入（JSON）', 'defaultValue', fixedInput === undefined ? '' : typeof fixedInput === 'string' ? fixedInput : JSON.stringify(fixedInput, null, 2), { multiline: true, maxLength: 64000, placeholder: c.outputType === 'text' ? '默认输入' : '例如 {"query":"AI","limit":20}' });
      if (this.doc.schemaVersion !== 2) { this.field(form, '每日时间', 'schedule', c.schedule || '09:00', { type: 'time' }); this.field(form, '时区', 'timezone', c.timezone || 'Asia/Shanghai', { maxLength: 128 }); }
    }
    if (node.type === 'skill') {
      if (this.runtime) this.runtime.mountSkillPicker(form, node, draft);
      else {
        this.field(form, 'Skill 引用', 'skillRef', c.skillRef, { maxLength: 1024 });
        this.field(form, '内容指纹', 'version', c.version, { maxLength: 128 });
      }
    }
    const toolFields = node.type === 'tool' ? this.renderToolFields(form, c) : null;
    if (node.type === 'transform') {
      this.field(form, '代码语言', 'language', c.language, { options: [['javascript', 'JavaScript'], ['python', 'Python']] });
      this.field(form, node.type === 'transform' ? '数据整理代码' : '代码', 'code', c.code, { multiline: true, code: true, maxLength: 100000, placeholder: this.doc.schemaVersion === 2 ? '例如 return input' : '代码作为文本配置保存，不会执行' });
    }
    if (['subflow', 'foreach', 'loop'].includes(node.type)) {
      if (this.doc.schemaVersion !== 2) this.field(form, node.type === 'subflow' ? '子流程引用' : '循环体子流程引用', 'workflowRef', c.workflowRef, { placeholder: '工作流标识', maxLength: 1024 });
      if (node.type === 'subflow' && this.doc.schemaVersion !== 2) this.field(form, '版本引用', 'version', c.version, { maxLength: 128 });
      if (node.type !== 'subflow') { this.field(form, node.type === 'foreach' ? '最多处理项数' : '最大轮数', 'maxIterations', c.maxIterations, { type: 'number', min: 1, max: 1000, required: true }); if (this.doc.schemaVersion !== 2) form.append(el('p', 'wf-field-help', '循环范围以子流程引用配置；第一版暂不展开内嵌子图。')); }
    }
    if (['condition', 'loop'].includes(node.type)) this.field(form, node.type === 'loop' ? '每轮完成后的继续条件（可选）' : '判断表达式', 'expression', c.expression, { multiline: true, code: true, maxLength: 4000, placeholder: node.type === 'loop' ? '例如 input.complete !== true；false 时停止' : '例如 input.amount > 5000' });
    if (node.type === 'human') this.field(form, '需要补充的内容', 'prompt', c.prompt, { multiline: true, maxLength: 8000 });
    if (node.type === 'validation') { if (this.nodeLibrary) this.nodeLibrary.renderValidationFields(form, node, c); else this.field(form, '校验规则（JSON）', 'validationRules', this.validationDraftErrors?.get(node.id)?.raw ?? JSON.stringify(c.rules || [], null, 2), { multiline: true, code: true, maxLength: 20000 }); }
    if (node.type === 'output') { if (this.doc.schemaVersion === 2) this.field(form, '用途', 'stage', c.stage || 'final', { options: [['intermediate', '阶段产物 · 保存后继续'], ['final', '最终交付 · 汇总到交付成果']] }); this.field(form, '成果文件名', 'fileName', c.fileName, { placeholder: '例如 report.json', maxLength: 256 }); }
    if (node.type === 'evaluation') this.renderEvaluationFields(form, node, c);
    if (node.type === 'improvement') this.renderImprovementFields(form, c);
    const ports = el('section', 'wf-property-section'); ports.append(el('h3', '', '数据端口'));
    if (Object.hasOwn(c, 'inputType')) this.field(ports, '输入类型', 'inputType', c.inputType, { options: DATA_TYPES, disabled: ['foreach', 'output'].includes(node.type) });
    if (Object.hasOwn(c, 'outputType')) this.field(ports, '输出类型', 'outputType', c.outputType, { options: DATA_TYPES, disabled: node.type === 'foreach' });
    ports.append(el('p', 'wf-field-help', '类型不兼容时保留原连线，请先调整或移除连线。')); form.append(ports);
    if (Object.hasOwn(c, 'timeoutSeconds')) {
      const policy = el('section', 'wf-property-section'); policy.append(el('h3', '', ['skill', 'tool'].includes(node.type) ? '运行策略' : '运行策略（仅配置）'));
      this.field(policy, '超时（秒）', 'timeoutSeconds', c.timeoutSeconds, { type: 'number', min: 1, max: 86400, required: true });
      this.field(policy, '失败策略', 'failurePolicy', c.failurePolicy, { options: [['stop', '停止'], ['retry', '重试（尚未支持）']] }); form.append(policy);
    }
    toolFields?.refresh();
    const feedback = el('p', 'wf-field-feedback'); feedback.setAttribute('role', 'status'); feedback.textContent = this.propertyDrafts.has(node.id) ? '属性有更改，应用后写入草稿。' : '';
    if (this.validationDraftErrors?.has(node.id)) { feedback.textContent = this.validationDraftErrors.get(node.id).message; feedback.classList.add('error'); }
    const actions = el('div', 'wf-property-actions'), apply = el('button', 'wf-button primary', '应用更改'); apply.type = 'submit'; actions.append(apply, control('重置属性', 'reset-properties'));
    form.append(feedback, actions);
    const stash = () => { if (this.libraryReadOnly) return; try { this.propertyDrafts.set(node.id, this.readForm(form, node)); this.validationDraftErrors?.delete(node.id); feedback.textContent = '属性有更改，应用后写入草稿。'; feedback.classList.remove('error'); this.renderHeader(); } catch (error) { if (node.type === 'validation') { this.validationDraftErrors ||= new Map(); this.validationDraftErrors.set(node.id, { raw: form.elements.validationRules.value, message: error.message }); } feedback.textContent = error.message; feedback.classList.add('error'); } };
    form.addEventListener('input', stash); form.addEventListener('change', stash);
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (this.libraryReadOnly) return;
      if (this.runtime?.isSkillSelectionPending?.(node.id)) { feedback.textContent = '正在读取 Skill 固定版本，请稍候再应用。'; feedback.classList.add('error'); return; }
      try { const next = updateNode(this.doc, node.id, this.readForm(form, node)); this.propertyDrafts.delete(node.id); this.validationDraftErrors?.delete(node.id); this.commit(next, '更新节点属性'); this.toast('节点属性已应用。'); }
      catch (error) { feedback.textContent = error.message; feedback.classList.add('error'); this.toast(error.message, true); }
    });
    parent.append(form);
    const links = this.doc.edges.filter(edge => edge.sourceNode === node.id || edge.targetNode === node.id);
    if (links.length) {
      const section = el('section', 'wf-property-section'); section.append(el('h3', '', '关联连线')); const list = el('ul', 'wf-connection-list');
      for (const edge of links) {
        const from = this.doc.nodes.find(n => n.id === edge.sourceNode), to = this.doc.nodes.find(n => n.id === edge.targetNode), item = el('li'), title = el('button', 'wf-connection-label', `${from.title} → ${to.title}`); title.type = 'button';
        title.addEventListener('click', () => this.selectEdge(edge.id)); const remove = control('移除此连线', 'remove-edge', 'close', { compact: true }); remove.dataset.edge = edge.id; item.append(title, remove); list.append(item);
      }
      section.append(list); parent.append(section);
    }
    const actionsBottom = el('div', 'wf-property-actions wf-property-section'); actionsBottom.append(control('复制节点', 'duplicate', 'copy'), control('删除节点', 'delete', 'trash')); parent.append(actionsBottom);
    this.nodeLibrary?.renderInspector(selected);
    if (this.libraryReadOnly) this.studio?.renderInspectorData(node.id); else this.studio?.renderProperties();
    this.refreshPropertyReadiness();
    this.applyLibraryReadOnly();
    this.nodeLibrary?.protectBoundaryInspector(node);
  }
  refreshPropertyReadiness() {
    const form = this.properties?.querySelector?.('.wf-property-form'); if (!form) return;
    const pending = Boolean(this.runtime?.isSkillSelectionPending?.(form.dataset.node)), apply = form.querySelector('button[type="submit"]');
    if (apply) { apply.disabled = this.libraryReadOnly || pending; apply.textContent = pending ? '正在读取 Skill…' : '应用更改'; apply.title = pending ? '固定版本读取后可应用；切换节点会保留本次编辑。' : ''; }
  }

  renderToolFields(form, config) {
    const mode = this.field(form, '执行方式', 'executionMode', config.executionMode || (config.toolName ? 'tool' : 'code'), { options: [['code', '代码'], ['tool', '内置工具']] });
    const toolSection = el('section', 'wf-tool-mode-fields');
    const options = [['', '选择内置工具'], ...WORKFLOW_TOOLS.map(tool => [tool.id, `${tool.label} · ${tool.inputType} → ${tool.outputType}`])];
    if (config.toolName && !WORKFLOW_TOOLS.some(tool => tool.id === config.toolName)) options.push([config.toolName, `${config.toolName}（不支持的旧引用）`]);
    const tool = this.field(toolSection, '内置工具', 'toolName', config.toolName || '', { options });
    const toolHelp = el('p', 'wf-field-help'); toolSection.append(toolHelp, el('p', 'wf-field-help', '这里只调用工作台内置工具；不支持任意 Hermes 或 MCP 工具名称。'));
    const codeSection = el('section', 'wf-code-mode-fields');
    const language = this.field(codeSection, '代码语言', 'language', config.language || 'javascript', { options: [['javascript', 'JavaScript'], ['python', 'Python']] });
    this.field(codeSection, '代码函数体', 'code', config.code || '', { multiline: true, code: true, maxLength: 100000, placeholder: 'return input' });
    const codeHelp = el('p', 'wf-field-help'); codeSection.append(codeHelp, el('p', 'wf-field-help', '代码在本机执行，只运行你信任的代码；此执行环境不是 OS 沙箱。'));
    form.append(toolSection, codeSection);
    let previousMode = mode.value, codeTypes = { inputType: config.inputType, outputType: config.outputType };
    const refresh = () => {
      const ports = [...form.querySelectorAll('select[name="inputType"], select[name="outputType"]')];
      if (previousMode === 'code') for (const port of ports) codeTypes[port.name] = port.value;
      const selected = WORKFLOW_TOOLS.find(item => item.id === tool.value), isTool = mode.value === 'tool';
      toolSection.hidden = !isTool; codeSection.hidden = isTool;
      for (const port of ports) { port.disabled = isTool; if (isTool && selected) port.value = selected[port.name]; else if (!isTool && previousMode !== 'code') port.value = codeTypes[port.name]; }
      toolHelp.textContent = selected ? `${selected.description}\n输入 ${selected.inputType} → 输出 ${selected.outputType}` : '请选择一个已注册的内置工具。';
      codeHelp.textContent = language.value === 'python' ? '填写 def main(input) 的函数体；直接 return 结果，不要再包一层 def main。可用 print 输出日志。' : '填写 async 函数体；input 是上一步结果，可 await，并用 return 返回本步结果。console.log 输出日志。';
      previousMode = mode.value;
    };
    for (const control of [mode, tool, language]) { control.addEventListener('input', refresh); control.addEventListener('change', refresh); }
    return { refresh };
  }

  renderEvaluationFields(form, node, config) {
    const incoming = this.doc.edges.find(edge => edge.targetNode === node.id && edge.targetPort === 'in');
    const source = incoming && this.doc.nodes.find(item => item.id === incoming.sourceNode);
    const sourcePort = source && getPorts(source).outputs.find(port => port.id === incoming.sourcePort);
    const observation = el('section', 'wf-property-section'); observation.append(el('h3', '', '由连线指定的对比产物'), el('p', 'wf-field-help', source ? `${source.title} · ${sourcePort?.label || incoming.sourcePort}` : '请将业务节点的产物输出连接到此节点。')); form.append(observation);
    this.field(form, '取值字段（可选）', 'valuePath', config.valuePath, { maxLength: 4000, placeholder: '留空比较完整产物，例如 acceptance.summary' });
    this.field(form, '比较方式', 'comparison', config.comparison, { options: [['exact', '精确对比'], ['model', 'AI 评价']] });
    form.append(el('p', 'wf-field-help', '字段使用对象点路径，只读取本次真实产物，不执行表达式。已知答案在学习面板提供，只用于评估和训练反馈，不改变业务输入。'));
  }

  renderImprovementFields(form, config) {
    const scope = this.field(form, '改进范围', 'scope', config.scope || 'skills', { options: [['skills', '指定 Skill 正文'], ['tools', '指定工具与代码'], ['workflow', '整个业务工作流']] });
    const section = el('section', 'wf-property-section'), selections = { skills: new Set(config.targetSkillNodeIds || []), tools: new Set(config.targetNodeIds || []) }; let displayed;
    const render = () => {
      if (selections[displayed]) selections[displayed] = new Set([...section.querySelectorAll('input')].filter(input => input.checked).map(input => input.value));
      displayed = scope.value; section.replaceChildren();
      if (displayed === 'workflow') { section.append(el('p', 'wf-field-help', '可调整业务节点与连线；输入输出、评分和现有审核边界固定。')); return; }
      const nodes = displayed === 'tools' ? mainChainToolNodes(this.doc) : mainChainSkillNodes(this.doc), selected = selections[displayed];
      section.append(el('h3', '', displayed === 'tools' ? '选择主链工具与代码' : '选择主链 Skill'));
      for (const node of nodes) {
        const row = el('div', 'wf-field'), label = el('label'), input = el('input');
        input.type = 'checkbox'; input.name = displayed === 'tools' ? 'targetNodeIds' : 'targetSkillNodeIds'; input.value = node.id; input.id = `wf-target-${node.id}`; input.checked = selected.has(node.id); label.htmlFor = input.id;
        const metadata = node.type === 'skill' && this.runtime?.skills?.skills?.find(item => item.name === node.config.skillRef);
        label.textContent = `${node.title}${metadata?.displayName ? ` · ${metadata.displayName}` : ''}`;
        row.append(label, input); section.append(row);
      }
      if (!nodes.length) section.append(el('p', 'wf-field-help', displayed === 'tools' ? '暂无可改进的主链工具或代码节点' : '暂无可改进的主链 Skill'));
      if ([...selected].some(id => !nodes.some(node => node.id === id))) section.append(el('p', 'wf-field-feedback error', '已有目标不在当前主链，应用属性时会移除，请重新检查选择。'));
    };
    scope.addEventListener('change', render); render(); form.append(section);
  }

  field(parent, label, name, value, options = {}) {
    const wrapper = el('div', 'wf-field' + (options.code ? ' code' : '')), caption = el('label', '', label), id = `wf-field-${name}`; caption.htmlFor = id;
    const input = options.options ? el('select') : options.multiline ? el('textarea') : el('input'); input.id = id; input.name = name;
    if (options.options) for (const entry of options.options) { const [key, title] = Array.isArray(entry) ? entry : [entry, entry]; input.append(new Option(title, key)); }
    if (!options.options && !options.multiline) input.type = options.type || 'text';
    if (options.type === 'checkbox') input.checked = Boolean(value); else input.value = String(value ?? '');
    for (const key of ['min', 'max', 'maxLength', 'required', 'disabled', 'placeholder']) if (options[key] !== undefined) input[key] = options[key];
    wrapper.append(caption, input); parent.append(wrapper); return input;
  }
  readForm(form, node) {
    const config = clone(node.config);
    for (const input of form.querySelectorAll('input[name], select[name], textarea[name]')) {
      if (input.name === 'title' || input.name === 'targetSkillNodeIds' || input.name === 'targetNodeIds' || input.name === 'validationRules' || input.name === 'defaultValue' || input.disabled) continue;
      config[input.name] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
    }
    if (node.type === 'input' && form.elements.defaultValue) {
      const raw = form.elements.defaultValue.value;
      delete config.value; delete config.defaultValue;
      if (raw.trim()) {
        if (config.outputType === 'text') config.defaultValue = raw;
        else { try { config.defaultValue = JSON.parse(raw); } catch { if (config.outputType === 'any') config.defaultValue = raw; else throw new Error('默认输入必须是合法的 JSON，并符合输入类型。'); } }
      } else {
        // Config updates merge with the previous snapshot. Keep an explicit
        // empty value so clearing the field cannot revive an older default.
        config.defaultValue = '';
        if (this.doc?.schemaVersion === 2 || Object.hasOwn(node.config, 'value')) config.value = null;
      }
    }
    if (node.type === 'improvement') {
      config.targetSkillNodeIds = config.scope === 'skills' ? [...form.querySelectorAll('input[name="targetSkillNodeIds"]')].filter(input => input.checked).map(input => input.value) : [];
      if (config.scope === 'tools') config.targetNodeIds = [...form.querySelectorAll('input[name="targetNodeIds"]')].filter(input => input.checked).map(input => input.value);
      else delete config.targetNodeIds;
    }
    if (node.type === 'validation') { if (this.nodeLibrary?.validationBuilderErrors?.has(node.id)) throw new Error(this.nodeLibrary.validationBuilderErrors.get(node.id)); try { config.rules = JSON.parse(form.elements.validationRules.value); } catch { throw new Error('校验规则必须是合法的 JSON 数组。'); } if (!Array.isArray(config.rules)) throw new Error('校验规则必须是数组。'); }
    if (node.type === 'tool' && config.executionMode === 'tool') {
      const tool = WORKFLOW_TOOLS.find(item => item.id === config.toolName);
      if (tool) { config.inputType = tool.inputType; config.outputType = tool.outputType; }
    }
    const patch = { title: form.elements.title.value.trim(), config, ...(this.propertyDrafts?.get(node.id)?.ports ? { ports: clone(this.propertyDrafts.get(node.id).ports) } : {}) };
    if (this.doc?.schemaVersion === 2 && node.type === 'tool' && config.executionMode === 'tool') {
      const metadata = WORKFLOW_TOOLS.find(tool => tool.id === config.toolName);
      if (metadata?.ports) patch.ports = clone(metadata.ports);
      if (metadata?.defaultConfig && (node.config.toolName !== config.toolName || node.config.executionMode !== 'tool')) Object.assign(config, clone(metadata.defaultConfig));
      if (metadata?.resource) config.resource = metadata.resource;
    }
    return patch;
  }
  renderEdgeProperties() {
    const edge = this.doc.edges.find(edge => edge.id === this.selectedEdge); if (!edge) return;
    const source = this.doc.nodes.find(node => node.id === edge.sourceNode), target = this.doc.nodes.find(node => node.id === edge.targetNode), out = getPorts(source).outputs.find(p => p.id === edge.sourcePort), input = getPorts(target).inputs.find(p => p.id === edge.targetPort);
    this.properties.append(el('p', 'wf-field-help', '这条连线传递节点数据，不表示已经执行。'));
    for (const [label, value] of [['来源', `${source.title} · ${out.label}`], ['目标', `${target.title} · ${input.label}`], ['类型', `${out.type} → ${input.type}`]]) { const block = el('div', 'wf-field'); block.append(el('span', '', label), el('strong', '', value)); this.properties.append(block); }
    this.properties.append(control('删除连线', 'delete', 'trash'));
  }

  addNode(type, position, { toolName, presetId } = {}) {
    if (this.libraryReadOnly) return;
    if (this.nodeLibrary?.nested && ['input', 'output'].includes(type)) { this.toast('内部编辑保持组合的输入输出接口固定；请返回上层重新封装来调整接口。', true); return; }
    if (presetId) return this.nodeLibrary?.addPreset(presetId, position);
    try {
      if (!this.flushTitleDraft()) return;
      const r = this.canvas.getBoundingClientRect(), point = position || this.worldPoint(r.left + r.width / 2, r.top + r.height / 2), shift = position ? 0 : (this.doc.nodes.length % 4) * 16;
      const sizes = new Map([...this.nodeElements].map(([id, card]) => [id, { width: card.offsetWidth || 270, height: card.offsetHeight || 180 }]));
      const vacant = vacantNodePosition(this.doc.nodes, { x: point.x - 112 + shift, y: point.y - 50 + shift }, sizes);
      let template;
      let overrides = { title: COPY[type] || TYPES.get(type)?.label, ...(this.doc.schemaVersion === 2 && ['input', 'skill'].includes(type) ? { config: { ...(type === 'skill' ? { inputType: 'object' } : {}), outputType: 'object' } } : {}) };
      if (toolName) {
        const tool = WORKFLOW_TOOLS.find(item => item.id === toolName);
        if (type !== 'tool' || !tool) throw new Error('请选择已注册的工具派生节点。');
        if (this.doc.schemaVersion !== 2) throw new Error('专业能力需先升级为并行工作流。');
        template = builtinNodePresets().find(record => record.toolName === toolName);
      }
      if (type === 'output' && this.doc.schemaVersion === 2) overrides.config = { ...overrides.config, stage: 'final' };
      const node = template ? instantiatePreset(template, this.snapPosition(vacant)) : createNode(type, this.snapPosition(vacant), overrides);
      this.commit({ ...this.doc, nodes: [...this.doc.nodes, node] }, '添加节点'); this.selectNode(node.id); this.toast(`已添加${COPY[type]}节点。`); return node;
    } catch (error) { this.toast(error.message, true); }
  }
  snapPosition(point) { const grid = this.settings.snap ? 16 : 1; return { x: clamp(Math.round(point.x / grid) * grid, -100000, 100000), y: clamp(Math.round(point.y / grid) * grid, -100000, 100000) }; }
  commit(next, label, before = this.doc, { autoLayout = true } = {}) {
    if (this.libraryReadOnly) return false;
    let clean = validateDocument(next);
    if (new Blob([serializeDocument(clean)]).size > MAX_FILE_BYTES) throw new Error('草稿不能超过 2 MB，请减少节点内容。');
    if (JSON.stringify(clean) === JSON.stringify(before)) return;
    const generated = autoLayout && hasGeneratedNodes(this.doc, clean);
    if (generated) {
      // Measure the newly rendered cards before recording one atomic edit.
      const current = this.doc;
      try {
        this.doc = clean; this.renderGraph(); this.measurePorts();
        const sizes = new Map(clean.nodes.map(node => [node.id, this.offsets.get(`${node.id}:size`)]));
        clean = validateDocument(layoutDocument(clean, sizes));
        if (new Blob([serializeDocument(clean)]).size > MAX_FILE_BYTES) throw new Error('草稿不能超过 2 MB，请减少节点内容。');
      } catch (error) { this.doc = current; this.renderGraph(); throw error; }
      this.doc = current;
    }
    if (clean.id !== this.doc.id && this.onPersist) {
      this.persist(); this.history = []; this.propertyDrafts.clear();
    } else {
      this.history.push({ document: clone(before), label }); if (this.history.length > 80) this.history.shift();
    }
    this.future = [];
    this.doc = clean; this.pruneSelection(); this.renderGraph(); this.renderProperties(); this.scheduleSave();
    if (generated) {
      const committed = this.doc;
      globalThis.requestAnimationFrame?.(() => { if (this.doc === committed && this.active !== false && this.documentLoaded !== false && !this.settings.canvasClosed) this.fit(); });
    }
  }
  applyConversationOperations(operations, { fingerprint, turnId } = {}) {
    if (this.libraryReadOnly) throw new Error('此工作流只读，请先从看板恢复。');
    if (this.nodeLibrary?.nested) throw new Error('请先应用或取消组合内部修改，再应用对话中的流程修改。');
    if (this.storageConflict || this.corruptDraft) throw new Error('请先处理草稿恢复或其它窗口的编辑冲突。');
    if (this.propertyDrafts.size || this.validationDraftErrors?.size || this.titleDraft) throw new Error('请先应用或取消当前属性与名称修改，再应用对话方案。');
    if (fingerprint && documentFingerprint(this.doc) !== fingerprint) throw new Error('画布已变化，请基于当前流程重新生成修改方案。');
    if (turnId !== undefined && (typeof turnId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(turnId))) throw new Error('对话修改凭据无效。');
    let generated = 0;
    const result = applyWorkflowOperations(this.doc, operations, turnId ? { idFactory: prefix => `${prefix}-${turnId}-${++generated}` } : {});
    this.cancelGesture(); this.cancelConnection();
    this.commit(result.document, '应用对话中的流程修改');
    this.studio?.setView('edit');
    this.renderHeader(); this.fit();
    return { ...result, document: clone(this.doc), fingerprint: documentFingerprint(this.doc) };
  }
  pruneSelection() { const ids = new Set(this.doc.nodes.map(node => node.id)); this.selection = new Set([...this.selection].filter(id => ids.has(id))); if (!this.doc.edges.some(edge => edge.id === this.selectedEdge)) this.selectedEdge = null; for (const id of this.propertyDrafts.keys()) if (!ids.has(id)) this.propertyDrafts.delete(id); for (const id of this.validationDraftErrors?.keys() || []) if (!ids.has(id)) this.validationDraftErrors.delete(id); }
  undo(redo = false) {
    if (this.libraryReadOnly) return;
    this.cancelGesture(); this.cancelConnection(); const from = redo ? this.future : this.history, to = redo ? this.history : this.future, entry = from.pop(); if (!entry) return;
    to.push({ document: clone(this.doc), label: entry.label }); const viewport = this.doc.viewport; this.doc = { ...clone(entry.document), viewport }; this.propertyDrafts.clear(); this.validationDraftErrors?.clear();
    this.pruneSelection(); this.renderGraph(); this.renderProperties(); this.scheduleSave(); this.toast(`${redo ? '重做' : '撤销'}：${entry.label}`);
  }
  deleteSelection() {
    if (this.libraryReadOnly) return;
    if (this.nodeLibrary?.nested && [...this.selection].some(id => this.nodeLibrary.isBoundaryNode(id))) { this.toast('组合的边界输入输出保持固定。请重新封装来调整接口；内部普通节点仍可删除。', true); return; }
    this.cancelConnection();
    if (this.selectedEdge) { this.commit(removeEdge(this.doc, this.selectedEdge), '删除连线'); this.selectedEdge = null; this.renderProperties(); return; }
    if (!this.selection.size) return; const count = this.selection.size; this.commit(removeNodes(this.doc, [...this.selection]), '删除节点'); this.toast(`已删除 ${count} 个节点及关联连线，可撤销。`);
  }
  copySelection() {
    const nodes = this.doc.nodes.filter(node => this.selection.has(node.id)); if (!nodes.length) return false;
    this.clipboard = { nodes: clone(nodes), edges: clone(this.doc.edges.filter(edge => this.selection.has(edge.sourceNode) && this.selection.has(edge.targetNode))) }; return true;
  }
  pasteSelection() {
    if (this.libraryReadOnly) return;
    if (!this.clipboard?.nodes.length) return;
    if (this.nodeLibrary?.nested && this.clipboard.nodes.some(node => ['input', 'output'].includes(node.type))) { this.toast('内部编辑保持输入输出接口固定，请仅复制内部能力节点。', true); return; }
    try {
      const ids = new Map(), nodes = this.clipboard.nodes.map(node => { const copy = createNode(node.type, this.snapPosition({ x: node.x + 32, y: node.y + 32 }), { title: node.title, config: node.config, ...(node.ports ? { ports: node.ports } : {}), ...(node.origin ? { origin: node.origin } : {}) }); ids.set(node.id, copy.id); return copy; });
      let next = { ...this.doc, nodes: [...this.doc.nodes, ...nodes] };
      for (const edge of this.clipboard.edges) next = connectNodes(next, { sourceNode: ids.get(edge.sourceNode), sourcePort: edge.sourcePort, targetNode: ids.get(edge.targetNode), targetPort: edge.targetPort });
      const copiedIds = new Set(ids.values()), externalSkills = new Set(mainChainSkillNodes(this.doc).map(node => node.id)), externalTools = new Set(mainChainToolNodes(this.doc).map(node => node.id)); let cleared = 0;
      next.nodes = next.nodes.map(node => {
        if (!copiedIds.has(node.id)) return node;
        if (node.type === 'human' && node.config.reviewTargetNodeId) {
          const target = node.config.reviewTargetNodeId, mapped = ids.get(target), legalExternal = reviewTargetNodes(next, node.id).some(item => item.id === target);
          if (!mapped && !legalExternal) cleared++;
          return { ...node, config: { ...node.config, reviewTargetNodeId: mapped || (legalExternal ? target : '') } };
        }
        if (node.type === 'improvement') {
          const config = { ...node.config };
          for (const [key, allowed] of [['targetSkillNodeIds', externalSkills], ['targetNodeIds', externalTools]]) if (Object.hasOwn(config, key)) {
            const targets = config[key], mapped = targets.flatMap(id => ids.has(id) ? [ids.get(id)] : allowed.has(id) ? [id] : []); cleared += targets.length - mapped.length; config[key] = mapped;
          }
          return { ...node, config };
        }
        return node;
      });
      this.selection = new Set(nodes.map(node => node.id)); this.selectedEdge = null; this.commit(next, '复制节点'); this.clipboard.edges = clone(next.edges.filter(edge => this.selection.has(edge.sourceNode) && this.selection.has(edge.targetNode)));
      // Subsequent pastes must remap the copied references, not the first graph.
      this.clipboard.nodes = clone(this.doc.nodes.filter(node => this.selection.has(node.id)));
      if (cleared) this.toast(`已复制节点；${cleared} 个失去合法关系的外部审核或 Skill 目标已清空，请重新选择。`);
    } catch (error) { this.toast(error.message, true); }
  }

  onClick(event) {
    if (this.documentLoaded === false) {
      const action = event.target.closest?.('button')?.dataset.action;
      if (action === 'new') this.onCreateWorkflow?.();
      else if (action === 'import') this.openImport();
      else if (action === 'board') this.onReturnToBoard?.();
      return;
    }
    if (event.target !== this.titleInput) { try { if (!this.flushTitleDraft()) return; } catch (error) { this.toast(error.message, true); return; } }
    const button = event.target.closest('button');
    if (this.nodeLibrary?.nested && ['new', 'example', 'import', 'export', 'open-folder', 'run', 'schedules', 'board'].includes(button?.dataset.action)) { this.toast('请先应用或取消子流程内部修改，再操作主流程。', true); return; }
    if (this.libraryReadOnly && (button?.dataset.mode || ['undo', 'redo', 'new', 'example', 'add-input', 'save', 'import', 'run', 'schedules', 'delete', 'duplicate', 'remove-edge', 'reset-properties'].includes(button?.dataset.action))) return;
    if (performance.now() < (this.suppressClickUntil || 0) && button?.matches('.wf-library-item, .wf-port')) return;
    if (button?.classList.contains('wf-port')) { if (event.detail === 0) this.activatePort(this.portDescriptor(button)); return; }
    const edge = event.target.closest?.('.wf-edge'); if (edge) { this.selectEdge(edge.dataset.id); return; }
    if (this.nodeLibrary?.handleClick(button)) return;
    if (button?.dataset.type && button.classList.contains('wf-library-item')) { this.addNode(button.dataset.type, undefined, { toolName: button.dataset.toolName, presetId: button.dataset.presetId }); return; }
    if (button?.dataset.mode) { this.commit({ ...this.doc, mode: button.dataset.mode }, '切换模式配置'); this.runtime?.learning?.setExpanded(); this.toast(button.dataset.mode === 'learn' ? '已切换学习模式，请填写样例与已知答案。' : '已切换执行模式。'); return; }
    switch (button?.dataset.action) {
      case 'undo': this.undo(); break; case 'redo': this.undo(true); break;
      case 'new': if (this.onCreateWorkflow) this.onCreateWorkflow(); else this.openNewDialog(); break;
      case 'example': this.loadExample(); break;
      case 'add-input': this.addNode('input'); break;
      case 'save': this.saveDraft(); break; case 'export': this.exportDocument(); break; case 'import': this.openImport(); break;
      case 'open-folder': void this.packages?.openFolder(); break;
      case 'run': void this.runtime?.start(); break;
      case 'schedules': this.studio?.syncRawInput(); void this.runtime?.schedules?.open(); break;
      case 'board': this.onReturnToBoard?.(); break;
      case 'fit': this.fit(); break;
      case 'zoom-in': this.zoomAt(this.doc.viewport.zoom * 1.2); break; case 'zoom-out': this.zoomAt(this.doc.viewport.zoom / 1.2); break; case 'reset-zoom': this.zoomAt(1); break;
      case 'toggle-canvas': this.setCanvasClosed(!this.settings.canvasClosed); break;
      case 'toggle-library': this.togglePanel('library'); break;
      case 'toggle-properties': this.togglePanel('properties'); break;
      case 'snap': this.settings.snap = !this.settings.snap; this.applySettings(); this.scheduleSave(); break;
      case 'motion': this.settings.reduceMotion = !this.settings.reduceMotion; this.applySettings(); this.clearPulses(); this.scheduleSave(); this.toast(this.settings.reduceMotion ? '已减少动效。只影响视觉反馈。' : '已启用接线确认动效。'); break;
      case 'help': this.openHelp(); break;
      case 'duplicate': if (this.copySelection()) this.pasteSelection(); break; case 'delete': this.deleteSelection(); break;
      case 'remove-edge': this.commit(removeEdge(this.doc, button.dataset.edge), '移除连线'); break;
      case 'reset-properties': for (const id of this.selection) { this.propertyDrafts.delete(id); this.validationDraftErrors?.delete(id); } this.nodeLibrary?.resetValidationDrafts(this.selection); this.renderProperties(); this.renderHeader(); break;
    }
  }

  onPointerDown(event) {
    if (!this.active || this.dialog.open || ![0, 1].includes(event.button)) return;
    if (!this.contextMenu.hidden && !this.contextMenu.contains(event.target)) this.contextMenu.hidden = true;
    const library = event.target.closest('.wf-library-item');
    if (this.libraryReadOnly && library) return;
    if (library?.disabled) return;
    if (library && event.button === 0) { this.cancelConnection(); this.gesture = { kind: 'library', type: library.dataset.type, toolName: library.dataset.toolName, presetId: library.dataset.presetId, start: { x: event.clientX, y: event.clientY }, pointerId: event.pointerId, dragged: false }; library.setPointerCapture(event.pointerId); return; }
    if (!this.canvas.contains(event.target) || event.target.closest('.wf-canvas-toolbar, .wf-zoom-controls, .wf-context-menu, .wf-empty-actions')) return;
    this.canvas.focus({ preventScroll: true }); const socket = event.target.closest('.wf-port');
    if (this.libraryReadOnly && socket) return;
    if (socket && event.button === 0) {
      event.preventDefault(); const port = this.portDescriptor(socket);
      const previousConnection = this.pendingConnection;
      this.pendingConnection = port; this.connectionCursor = this.worldPoint(event.clientX, event.clientY);
      // Finish a click on release: committing on pointerdown replaces the target
      // DOM while its pointerup/click sequence is still being dispatched.
      this.gesture = { kind: 'connect', from: port, previousConnection, start: { x: event.clientX, y: event.clientY }, pointerId: event.pointerId, dragged: false };
      this.canvas.setPointerCapture(event.pointerId); this.refreshPortHints(); this.drawPendingConnection(); return;
    }
    const card = event.target.closest('.wf-node');
    if (event.target.closest('button:not(.wf-port), input, textarea, select')) return;
    if (card && event.button === 0 && !this.space) {
      if (this.libraryReadOnly) { event.preventDefault(); this.selectNode(card.dataset.id, event.shiftKey || event.metaKey || event.ctrlKey); return; }
      event.preventDefault(); this.cancelConnection(); const id = card.dataset.id, modifier = event.shiftKey || event.metaKey || event.ctrlKey;
      if (modifier) { this.selectNode(id, true); if (!this.selection.has(id)) return; }
      else if (!this.selection.has(id)) this.selectNode(id);
      else if (this.selection.size === 1) this.runtime?.onSelectionChange?.(id);
      this.gesture = { kind: 'nodes', start: { x: event.clientX, y: event.clientY }, pointerId: event.pointerId, before: clone(this.doc), positions: new Map(this.doc.nodes.filter(node => this.selection.has(node.id)).map(node => [node.id, { x: node.x, y: node.y }])), dragged: false };
      this.canvas.setPointerCapture(event.pointerId); return;
    }
    if (event.target.closest('.wf-edge, button, input, textarea, select')) return;
    event.preventDefault(); this.cancelConnection();
    this.gesture = { kind: event.shiftKey && !this.space && event.button === 0 ? 'box' : 'pan', start: { x: event.clientX, y: event.clientY }, viewport: clone(this.doc.viewport), pointerId: event.pointerId, dragged: false, previousSelection: new Set(this.selection) };
    this.canvas.classList.toggle('panning', this.gesture.kind === 'pan'); this.canvas.setPointerCapture(event.pointerId);
  }

  onPointerMove(event) {
    const gesture = this.gesture;
    if (!gesture) { if (this.pendingConnection && this.canvas.contains(event.target)) { this.connectionCursor = this.worldPoint(event.clientX, event.clientY); this.drawPendingConnection(); } return; }
    if (gesture.pointerId !== event.pointerId) return;
    const point = { x: event.clientX, y: event.clientY }, dx = point.x - gesture.start.x, dy = point.y - gesture.start.y; if (!near(point, gesture.start)) gesture.dragged = true;
    if (gesture.kind === 'library') {
      if (!gesture.dragged) return;
      if (!this.dragPreview) { const definition = TYPES.get(gesture.type), group = GROUPS.get(definition.category), label = this.nodeLibrary?.records.get(gesture.presetId)?.title || WORKFLOW_TOOLS.find(tool => tool.id === gesture.toolName)?.label || COPY[gesture.type]; this.dragPreview = el('div', 'wf-drag-preview', label); this.dragPreview.style.setProperty('--node-color', group.color); this.root.append(this.dragPreview); }
      this.dragPreview.style.transform = `translate(${point.x + 14}px, ${point.y + 12}px)`;
      const r = this.canvas.getBoundingClientRect(); this.canvas.classList.toggle('drop-ready', point.x >= r.left && point.x <= r.right && point.y >= r.top && point.y <= r.bottom);
    } else if (gesture.kind === 'nodes' && gesture.dragged) {
      for (const node of this.doc.nodes) if (gesture.positions.has(node.id)) {
        const origin = gesture.positions.get(node.id), position = this.snapPosition({ x: origin.x + dx / this.doc.viewport.zoom, y: origin.y + dy / this.doc.viewport.zoom }); node.x = position.x; node.y = position.y;
        const card = this.nodeElements.get(node.id); card.style.left = `${node.x}px`; card.style.top = `${node.y}px`; card.classList.add('dragging');
      }
      this.updateGeometry();
    } else if (gesture.kind === 'pan') {
      this.doc.viewport.x = clamp(gesture.viewport.x + dx, -100000, 100000); this.doc.viewport.y = clamp(gesture.viewport.y + dy, -100000, 100000); this.applyViewport();
    } else if (gesture.kind === 'box') {
      const r = this.canvas.getBoundingClientRect(), box = this.root.querySelector('.wf-selection-box'); box.hidden = false;
      Object.assign(box.style, { left: `${Math.min(gesture.start.x, point.x) - r.left}px`, top: `${Math.min(gesture.start.y, point.y) - r.top}px`, width: `${Math.abs(dx)}px`, height: `${Math.abs(dy)}px` });
    } else if (gesture.kind === 'connect') {
      this.connectionCursor = this.worldPoint(event.clientX, event.clientY); const socket = document.elementFromPoint(event.clientX, event.clientY)?.closest('.wf-port'); this.connectionTarget = socket ? this.portDescriptor(socket) : null;
      this.refreshPortHints(); this.drawPendingConnection();
    }
  }

  onPointerUp(event) {
    const gesture = this.gesture; if (!gesture || gesture.pointerId !== event.pointerId) return;
    this.gesture = null; this.canvas.classList.remove('panning', 'drop-ready'); this.root.querySelector('.wf-selection-box').hidden = true;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    if (gesture.kind === 'library') {
      this.dragPreview?.remove(); this.dragPreview = null;
      if (gesture.dragged) {
        this.suppressClickUntil = performance.now() + 350; const r = this.canvas.getBoundingClientRect();
        if (event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom) this.addNode(gesture.type, this.worldPoint(event.clientX, event.clientY), { toolName: gesture.toolName, presetId: gesture.presetId });
      }
    } else if (gesture.kind === 'nodes' && gesture.dragged) {
      for (const card of this.nodeElements.values()) card.classList.remove('dragging'); this.commit(this.doc, '移动节点', gesture.before);
    } else if (gesture.kind === 'pan') {
      if (!gesture.dragged) { this.selection.clear(); this.selectedEdge = null; this.renderSelection(); this.renderProperties(); } this.scheduleSave();
    } else if (gesture.kind === 'box') {
      const left = Math.min(event.clientX, gesture.start.x), top = Math.min(event.clientY, gesture.start.y), right = Math.max(event.clientX, gesture.start.x), bottom = Math.max(event.clientY, gesture.start.y);
      this.selection = new Set(gesture.previousSelection); this.selectedEdge = null;
      for (const [id, card] of this.nodeElements) { const r = card.getBoundingClientRect(); if (r.left < right && r.right > left && r.top < bottom && r.bottom > top) this.selection.add(id); }
      this.renderSelection(); this.renderProperties();
    } else if (gesture.kind === 'connect') {
      this.suppressClickUntil = performance.now() + 220;
      if (gesture.dragged) { const socket = document.elementFromPoint(event.clientX, event.clientY)?.closest('.wf-port'); if (socket) this.finishConnection(this.portDescriptor(socket)); else if (this.studio) this.studio.openSearch(event.clientX, event.clientY, this.pendingConnection); else this.cancelConnection(); }
      else { this.pendingConnection = gesture.previousConnection || null; this.activatePort(gesture.from); this.connectionCursor = null; this.drawPendingConnection(); this.refreshPortHints(); }
    }
  }

  cancelGesture() {
    const gesture = this.gesture; this.gesture = null;
    if (gesture?.kind === 'nodes' && gesture.dragged) { this.doc = gesture.before; this.renderGraph(); }
    if (gesture?.kind === 'pan') { this.doc.viewport = gesture.viewport; this.applyViewport(); }
    this.dragPreview?.remove(); this.dragPreview = null; this.canvas?.classList.remove('panning', 'drop-ready');
    if (this.root) this.root.querySelector('.wf-selection-box').hidden = true; if (gesture?.kind === 'connect') this.cancelConnection();
  }
  portDescriptor(socket) { return { node: socket.dataset.node, port: socket.dataset.port, direction: socket.dataset.direction }; }
  connection(from, to) { const [source, target] = from.direction === 'output' ? [from, to] : [to, from]; return { sourceNode: source.node, sourcePort: source.port, targetNode: target.node, targetPort: target.port }; }
  activatePort(port) {
    if (this.libraryReadOnly) return;
    if (!this.pendingConnection) { this.pendingConnection = port; this.connectionCursor = null; this.refreshPortHints(); this.drawPendingConnection(); return; }
    if (this.pendingConnection.node === port.node && this.pendingConnection.port === port.port && this.pendingConnection.direction === port.direction) this.cancelConnection(); else this.finishConnection(port);
  }
  finishConnection(port) {
    if (this.libraryReadOnly) return;
    if (!this.pendingConnection) return;
    if (this.pendingConnection.direction === port.direction) { this.toast('请把输出端口连接到输入端口。', true); return; }
    try { const next = connectNodes(this.doc, this.connection(this.pendingConnection, port)), edge = next.edges.at(-1); this.cancelConnection(); this.commit(next, '添加连线'); this.playConnectionPulse(edge.id); this.toast('连线已添加。'); }
    catch (error) { this.toast(error.message, true); this.refreshPortHints(error.message); }
  }
  refreshPortHints(message = '') {
    for (const socket of this.nodesLayer.querySelectorAll('.wf-port')) {
      socket.classList.remove('active', 'compatible', 'incompatible'); if (!this.pendingConnection) continue;
      const other = this.portDescriptor(socket), same = other.node === this.pendingConnection.node && other.port === this.pendingConnection.port && other.direction === this.pendingConnection.direction;
      if (same) { socket.classList.add('active'); continue; }
      if (other.direction !== this.pendingConnection.direction) {
        const node = this.doc.nodes.find(n => n.id === other.node), original = this.doc.nodes.find(n => n.id === this.pendingConnection.node);
        const typeA = getPorts(original)[this.pendingConnection.direction === 'input' ? 'inputs' : 'outputs'].find(p => p.id === this.pendingConnection.port)?.type, typeB = getPorts(node)[other.direction === 'input' ? 'inputs' : 'outputs'].find(p => p.id === other.port)?.type;
        const occupied = other.direction === 'input' && this.doc.edges.some(e => e.targetNode === other.node && e.targetPort === other.port);
        socket.classList.add(other.node !== original.id && !occupied && (typeA === typeB || typeA === 'any' || typeB === 'any') ? 'compatible' : 'incompatible');
      }
    }
    const hint = this.root.querySelector('.wf-connection-hint'); hint.hidden = !this.pendingConnection;
    if (this.pendingConnection) {
      if (!message && this.connectionTarget && this.connectionTarget.direction !== this.pendingConnection.direction) { const result = validateConnection(this.doc, this.connection(this.pendingConnection, this.connectionTarget)); if (!result.ok) message = result.message; }
      hint.textContent = message || '选择相反方向的端口连接 · Esc 取消'; hint.classList.toggle('error', Boolean(message));
    }
  }
  drawPendingConnection() {
    if (!this.pendingConnection || !this.draftPath) { if (this.draftPath) this.draftPath.style.display = 'none'; return; }
    const from = this.pendingConnection, p = this.portPoint(from.node, from.direction, from.port), target = this.connectionCursor || { x: p.x + (from.direction === 'output' ? 90 : -90), y: p.y };
    this.draftPath.style.display = ''; this.draftPath.setAttribute('d', from.direction === 'output' ? this.curve(p, target) : this.curve(target, p));
  }
  cancelConnection() { this.pendingConnection = null; this.connectionTarget = null; this.connectionCursor = null; this.drawPendingConnection(); if (this.root) this.refreshPortHints(); }
  playConnectionPulse(id) { if (this.settings.reduceMotion || matchMedia('(prefers-reduced-motion: reduce)').matches) return; const group = this.edgeElements.get(id); if (group) { group.classList.add('wf-edge-pulse'); setTimeout(() => group.classList.remove('wf-edge-pulse'), 620); } }
  clearPulses() { for (const group of this.edgeElements.values()) group.classList.remove('wf-edge-pulse'); }
  onHover(event) { if (this.gesture || this.pendingConnection) return; const card = event.target.closest?.('.wf-node'); if (card) { this.hoverNode = card.dataset.id; this.highlightEdges(); } }

  onKeyDown(event) {
    if (!this.active || this.documentLoaded === false || this.settings.canvasClosed || event.isComposing || event.keyCode === 229 || event.repeat || event.defaultPrevented) return;
    if (!this.root.contains(event.target)) return;
    if (this.dialog.open || event.target.closest?.('.wf-runtime, .wf-runtime-dialog, .wf-runtime-confirm, .wf-learning, .wf-schedules-dialog, .wf-conversation')) return;
    if (event.key === 'Escape') { this.cancelGesture(); this.cancelConnection(); this.contextMenu.hidden = true; return; }
    if (this.gesture) return;
    const bindings = this.getShortcuts?.(), action = SHORTCUT_ACTIONS.find(item => ['editor', 'canvas'].includes(item.scope) && matchesShortcut(event, item.id, bindings))?.id;
    if (action === 'workflow.save') { event.preventDefault(); if (!this.libraryReadOnly) this.saveDraft(); return; }
    if (isTextTarget(event.target)) return;
    if (this.libraryReadOnly && (['workflow.undo', 'workflow.redo', 'canvas.duplicate', 'canvas.paste', 'canvas.delete'].includes(action)
      || ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key))) { event.preventDefault(); return; }
    if (action === 'workflow.undo' || action === 'workflow.redo') { event.preventDefault(); this.undo(action === 'workflow.redo'); return; }
    // Preserve native activation and navigation for editor controls, including
    // icons inside buttons. Save and editor undo/redo remain available above.
    if (event.target.closest?.('button, a, summary')) return;
    if (event.target.closest?.('.wf-port')) return;
    if (action === 'canvas.selectAll') { event.preventDefault(); this.selection = new Set(this.doc.nodes.map(n => n.id)); this.selectedEdge = null; this.renderSelection(); this.renderProperties(); return; }
    if (action === 'canvas.duplicate') { event.preventDefault(); if (this.copySelection()) this.pasteSelection(); return; }
    if (action === 'canvas.copy') { if (this.copySelection()) { event.preventDefault(); this.toast('已复制节点，可在本编辑器内粘贴。'); } return; }
    if (action === 'canvas.paste') { if (this.clipboard) { event.preventDefault(); this.pasteSelection(); } return; }
    if (action === 'canvas.delete') { event.preventDefault(); this.deleteSelection(); return; }
    if (action === 'canvas.fit') { event.preventDefault(); this.fit(); return; }
    if (action === 'canvas.toggleLibrary') { event.preventDefault(); this.togglePanel('library'); return; }
    if (action === 'canvas.toggleProperties') { event.preventDefault(); this.togglePanel('properties'); return; }
    if (action === 'canvas.help') { event.preventDefault(); this.openHelp(); return; }
    if (event.code === 'Space') { event.preventDefault(); this.space = true; this.canvas.classList.add('pan-ready'); return; }
    const targetNode = event.target.closest?.('.wf-node'), targetEdge = event.target.closest?.('.wf-edge');
    if (event.key === 'Enter' && targetNode) { event.preventDefault(); this.selectNode(targetNode.dataset.id); return; }
    if (event.key === 'Enter' && targetEdge) { event.preventDefault(); this.selectEdge(targetEdge.dataset.id); return; }
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key) && this.selection.size && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault(); const amount = event.shiftKey ? 64 : 16, dx = event.key === 'ArrowLeft' ? -amount : event.key === 'ArrowRight' ? amount : 0, dy = event.key === 'ArrowUp' ? -amount : event.key === 'ArrowDown' ? amount : 0;
      this.commit({ ...this.doc, nodes: this.doc.nodes.map(n => this.selection.has(n.id) ? { ...n, ...this.snapPosition({ x: n.x + dx, y: n.y + dy }) } : n) }, '键盘移动节点');
    }
  }

  openContextMenu(clientX, clientY) {
    if (this.libraryReadOnly) return;
    if (this.studio) return this.studio.openSearch(clientX, clientY);
    const menu = this.contextMenu, r = this.canvas.getBoundingClientRect(), point = this.worldPoint(clientX, clientY);
    menu.replaceChildren(el('strong', '', '添加节点')); const search = el('input'); search.type = 'search'; search.placeholder = '搜索节点…'; search.setAttribute('aria-label', '搜索要添加的节点');
    const list = el('div', 'wf-context-items'); menu.append(search, list);
    const render = () => {
      list.replaceChildren();
      for (const type of NODE_TYPES.filter(t => `${COPY[t.type]} ${t.type}`.toLowerCase().includes(search.value.toLowerCase()))) {
        const item = el('button', '', COPY[type.type]); item.type = 'button'; item.prepend(icon(type.icon)); item.addEventListener('click', () => { menu.hidden = true; this.addNode(type.type, point); }); list.append(item);
      }
    };
    search.addEventListener('input', render); render(); menu.hidden = false;
    menu.style.left = `${clamp(clientX - r.left, 8, Math.max(8, r.width - 236))}px`; menu.style.top = `${clamp(clientY - r.top, 58, Math.max(58, r.height - 390))}px`; search.focus();
  }
  toast(message, error = false) { const node = this.root.querySelector('.wf-toast'); clearTimeout(this.toastTimer); node.textContent = message; node.classList.toggle('error', error); node.hidden = false; this.toastTimer = setTimeout(() => { node.hidden = true; }, error ? 6000 : 2800); }

  scheduleSave() { if (this.libraryReadOnly) { clearTimeout(this.saveTimer); return; } this.unsaved = true; this.renderHeader(); clearTimeout(this.saveTimer); if (this.nodeLibrary?.nested) return; this.saveTimer = setTimeout(() => this.persist(), 350); }
  persist() {
    if (this.nodeLibrary?.nested) { clearTimeout(this.saveTimer); return true; }
    if (this.libraryReadOnly) { clearTimeout(this.saveTimer); return true; }
    clearTimeout(this.saveTimer); if (this.storageConflict || this.corruptDraft) { this.renderHeader(); return false; }
    let document;
    try {
      // A background save must not cancel an in-progress canvas gesture. Its
      // release schedules another save, which can commit the pending title.
      if (!this.gesture && !this.flushTitleDraft()) return false;
      clearTimeout(this.saveTimer);
      // Pointer movement is a preview until release. A pending autosave must never
      // make a position durable that Escape, blur or route switching can cancel.
      const committed = this.gesture?.kind === 'nodes' ? this.gesture.before
        : this.gesture?.kind === 'pan' ? { ...this.doc, viewport: this.gesture.viewport } : this.doc;
      if (this.onPersist && this.storageKey !== DRAFT_PREFIX + committed.id) {
        this.storageKey = DRAFT_PREFIX + committed.id; this.storageValue = localStorage.getItem(this.storageKey); localStorage.setItem(ACTIVE_KEY, committed.id);
      }
      if (localStorage.getItem(this.storageKey || STORAGE_KEY) !== this.storageValue) { this.storageConflict = true; this.renderRecovery(); this.renderHeader(); return false; }
      document = validateDocument(committed);
      const raw = JSON.stringify({ version: 1, document, ui: { ...this.settings, canvasSize: this.canvasSize || null }, savedAt: new Date().toISOString() });
      if (new Blob([raw]).size > MAX_FILE_BYTES) throw new Error('草稿过大');
      localStorage.setItem(this.storageKey || STORAGE_KEY, raw); this.storageValue = raw; this.unsaved = false; this.saveError = ''; this.renderHeader(); return true;
    } catch { this.saveError = '保存失败，请导出 JSON'; this.unsaved = true; this.renderHeader(); return false; }
    finally { if (document) this.onPersist?.(clone(document)); }
  }
  saveDraft() {
    if (this.libraryReadOnly) return;
    if (this.nodeLibrary?.nested) { void this.nodeLibrary.applyNested(); return; }
    try {
      if (this.validationDraftErrors?.size) throw new Error('校验规则有无效的 JSON 或字段配置，请修正后保存。');
      if (!this.flushTitleDraft()) return;
      this.studio?.flushRunSettings();
      if (this.runtime?.isSkillSelectionPending?.()) throw new Error('正在读取 Skill 固定版本，编辑已保留，请稍候再保存。');
      let next = this.doc; for (const [id, patch] of this.propertyDrafts) next = updateNode(next, id, patch);
      if (this.propertyDrafts.size) { this.propertyDrafts.clear(); this.commit(next, '应用节点属性'); }
      if (this.persist()) {
        this.toast(this.onPersist ? '本地草稿已保存，正在同步到工作流看板。' : '草稿已保存到当前浏览器。');
        this.onSaveLibrary?.();
      } else this.toast('草稿尚未保存，请查看提示或导出 JSON。', true);
    } catch (error) { this.toast(`属性未应用：${error.message}`, true); }
  }
  prepareRun({ operation = '运行' } = {}) {
    if (this.documentLoaded === false) throw new Error('未加载工作流，请先从看板打开或新建工作流。');
    if (this.validationDraftErrors?.size) throw new Error(`校验规则有无效的 JSON 或字段配置，请修正后${operation}。`);
    if (this.nodeLibrary?.nested) throw new Error('请先应用或取消子流程内部编辑，再从主流程运行。');
    if (this.libraryReadOnly) throw new Error('此工作流为只读，请先回看板恢复。');
    this.cancelGesture(); this.cancelConnection();
    if (!this.flushTitleDraft()) throw new Error(`请填写工作流名称后再${operation}。`);
    this.studio?.flushRunSettings();
    if (this.runtime?.isSkillSelectionPending?.()) throw new Error(`正在读取 Skill 固定版本，编辑已保留，请稍候再${operation}。`);
    let next = this.doc;
    for (const [id, patch] of this.propertyDrafts) next = updateNode(next, id, patch);
    if (this.propertyDrafts.size) { this.commit(next, `应用${operation}配置`); this.propertyDrafts.clear(); this.renderProperties(); this.renderHeader(); }
    return clone(validateDocument(this.doc));
  }
  applyLearningDocument(document, { baseDocument, trainableNodeIds, scope = 'skills' } = {}) {
    if (this.libraryReadOnly) throw new Error('此工作流为只读，不能应用学习候选。');
    this.cancelGesture(); this.cancelConnection();
    if (this.propertyDrafts.size) throw new Error('草稿已变化，请先恢复对应学习快照。');
    const next = mergeLearningCandidate(this.doc, document, { baseDocument, scope, trainableNodeIds });
    this.commit(next, '应用学习最佳候选'); return clone(this.doc);
  }
  createMinimalFlow() {
    if (this.libraryReadOnly) return;
    this.cancelGesture(); this.cancelConnection();
    let next = createDocument({ title: '我的 Skill 工作流', schemaVersion: 2 });
    const input = createNode('input', { x: 40, y: 100 }, { title: '输入内容', config: { outputType: 'text', fieldName: 'input' } });
    const skill = createNode('skill', { x: 360, y: 100 }, { title: '调用 Skill', config: { inputType: 'text', outputType: 'text', timeoutSeconds: 180 } });
    const output = createNode('output', { x: 680, y: 100 }, { title: '输出结果' });
    next.nodes = [input, skill, output];
    next = connectNodes(next, { sourceNode: input.id, sourcePort: 'out', targetNode: skill.id, targetPort: 'in' });
    next = connectNodes(next, { sourceNode: skill.id, sourcePort: 'out', targetNode: output.id, targetPort: 'in' });
    this.commit(next, '创建最小 Skill 流程'); this.propertyDrafts.clear(); this.runStates = {};
    this.selectNode(skill.id); requestAnimationFrame(() => this.fit());
    this.toast('已创建最小流程。选择已有 Skill，再输入内容执行。');
  }
  insertSkillAfterSelected() { return this.insertCapabilityAfterSelected('skill'); }
  insertToolAfterSelected() { return this.insertCapabilityAfterSelected('tool'); }
  insertCapabilityAfterSelected(type) {
    if (!['skill', 'tool'].includes(type)) throw new Error('只能插入 Skill 或工具 / 代码能力。');
    const label = type === 'skill' ? 'Skill' : '工具 / 代码';
    this.prepareRun();
    const selected = this.selection.size === 1 ? this.doc.nodes.find(node => this.selection.has(node.id)) : null;
    const outputs = this.doc.nodes.filter(node => node.type === 'output');
    let anchor = selected && ['input', 'skill', 'tool'].includes(selected.type) ? selected : null;
    if (!anchor && outputs.length === 1) {
      const incoming = this.doc.edges.filter(edge => edge.targetNode === outputs[0].id);
      if (incoming.length === 1) anchor = this.doc.nodes.find(node => node.id === incoming[0].sourceNode);
    }
    if (!anchor || !['input', 'skill', 'tool'].includes(anchor.type)) throw new Error(`先创建流程，或选中输入 / Skill / 工具节点再添加${label}。`);
    const outgoing = this.doc.edges.filter(edge => edge.sourceNode === anchor.id);
    if (outgoing.length > 1) throw new Error('当前节点有多条分支，请手动整理为单一串联流程。');
    const oldEdge = outgoing[0], target = oldEdge && this.doc.nodes.find(node => node.id === oldEdge.targetNode);
    const sourcePort = getPorts(anchor).outputs.find(port => port.id === (oldEdge?.sourcePort || 'out'));
    const targetPort = target && getPorts(target).inputs.find(port => port.id === oldEdge.targetPort);
    if (!sourcePort || target && !targetPort) throw new Error('节点端口不完整，请先检查连线。');
    const downstream = new Set();
    let cursor = target;
    while (cursor) {
      if (downstream.has(cursor.id) || cursor.id === anchor.id) throw new Error('无法向循环连线中插入能力节点。');
      downstream.add(cursor.id);
      const edges = this.doc.edges.filter(edge => edge.sourceNode === cursor.id);
      if (edges.length > 1) throw new Error('下游存在分支，请手动整理为单一串联流程。');
      cursor = edges[0] && this.doc.nodes.find(node => node.id === edges[0].targetNode);
    }
    const added = createNode(type, this.snapPosition({ x: anchor.x + 320, y: anchor.y }), {
      title: type === 'skill' ? `调用 Skill ${this.doc.nodes.filter(node => node.type === 'skill').length + 1}` : `代码 ${this.doc.nodes.filter(node => node.type === 'tool').length + 1}`,
      config: type === 'skill' ? { inputType: sourcePort.type,
        outputType: targetPort && targetPort.type !== 'any' ? targetPort.type : sourcePort.type, timeoutSeconds: 180 }
        : { executionMode: 'code', inputType: sourcePort.type, outputType: sourcePort.type, language: 'javascript', code: 'return input', timeoutSeconds: 30 },
    });
    let next = { ...this.doc, nodes: [...this.doc.nodes.map(node => downstream.has(node.id)
      ? { ...node, ...this.snapPosition({ x: node.x + 320, y: node.y }) } : node), added],
      edges: this.doc.edges.filter(edge => edge.id !== oldEdge?.id) };
    next = connectNodes(next, { sourceNode: anchor.id, sourcePort: sourcePort.id, targetNode: added.id, targetPort: 'in' });
    if (target) next = connectNodes(next, { sourceNode: added.id, sourcePort: 'out', targetNode: target.id, targetPort: targetPort.id });
    this.commit(next, `插入串联${label}`); this.selectNode(added.id);
    this.toast(type === 'skill' ? '已插入 Skill 并衔接连线。选择已有技能后应用配置。' : '已插入代码节点并衔接连线。默认原样返回输入，可在属性中配置。');
    return added;
  }
  setRunStates(states = {}) {
    this.runStates = states;
    const labels = { ...STUDIO_STATUS, running: '执行中', unknown: '待核对' };
    for (const [id, card] of this.nodeElements) {
      const state = states[id]?.status, badge = card.querySelector('.wf-node-run-badge');
      if (!state) { delete card.dataset.runState; if (badge) badge.hidden = true; continue; }
      card.dataset.runState = state;
      if (badge) { badge.hidden = false; badge.textContent = labels[state] || state; badge.setAttribute('aria-label', `本次运行：${labels[state] || state}`); }
    }
  }
  renderRecovery() {
    const banner = this.root?.querySelector('.wf-recovery'); if (!banner) return; banner.replaceChildren(); banner.hidden = !this.corruptDraft && !this.storageConflict;
    if (this.corruptDraft) {
      banner.append(el('span', '', '原草稿无法读取，原数据已保留。'));
      const backup = el('button', 'wf-button', '下载原始备份'); backup.type = 'button'; backup.addEventListener('click', () => this.download(this.corruptDraft, 'workflow-recovery.json'));
      const reset = el('button', 'wf-button', '使用当前草稿'); reset.type = 'button'; reset.addEventListener('click', () => { this.corruptDraft = null; this.persist(); this.renderRecovery(); }); banner.append(backup, reset);
    } else if (this.storageConflict) {
      banner.append(el('span', '', '另一标签页更新了草稿，已暂停自动覆盖。'));
      const load = el('button', 'wf-button', '载入更新'); load.type = 'button'; load.addEventListener('click', () => {
        try { const raw = localStorage.getItem(this.storageKey || STORAGE_KEY); if (!raw) throw new Error('另一份草稿已移除。'); const data = JSON.parse(raw), next = validateDocument(data.document); this.storageConflict = false; this.storageValue = raw; this.canvasSize = null; this.recordCanvasSize(data.ui?.canvasSize || {}); this.propertyDrafts.clear(); this.commit(next, '载入另一标签页草稿', this.doc, { autoLayout: false }); this.onCanvasResize(); this.renderRecovery(); }
        catch (error) { this.toast(error.message, true); }
      });
      const exportButton = el('button', 'wf-button', '导出 JSON 备份'); exportButton.type = 'button'; exportButton.addEventListener('click', () => this.exportLegacyDocument()); banner.append(load, exportButton);
    }
  }
  exportDocument() {
    if (this.packages) return this.packages.exportCurrent();
    this.toast('工作流打包功能尚未就绪，请稍后重试。', true); return false;
  }
  exportLegacyDocument() {
    try { this.download(serializeDocument(this.doc), `${this.doc.title.replace(/[\\/:*?"<>|]/g, '-').slice(0, 80)}.json`); this.toast(this.propertyDrafts.size ? '已导出已应用的草稿；另有属性尚未应用。' : '已导出当前流程草稿。'); }
    catch (error) { this.toast(error.message, true); }
  }
  download(text, filename) { return this.downloadBlob(new Blob([text], { type: 'application/json;charset=utf-8' }), filename); }
  downloadBlob(blob, filename) { const url = URL.createObjectURL(blob), anchor = el('a'); anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  openDialog(title, description) {
    this.cancelGesture(); this.cancelConnection(); this.contextMenu.hidden = true; if (this.dialog.open) this.dialog.close(); this.dialog.replaceChildren();
    const heading = el('div', 'wf-dialog-header'); heading.append(el('h2', '', title));
    const close = control('关闭对话框', 'dialog-close', 'close', { compact: true }); close.addEventListener('click', () => this.dialog.close()); heading.append(close);
    this.dialog.append(heading); if (description) this.dialog.append(el('p', '', description)); this.dialog.showModal(); return this.dialog;
  }
  openImport(raw) {
    if (raw !== undefined) return this.openLegacyImport(raw);
    if (this.packages) return this.packages.openImportDialog();
    this.toast('工作流导入功能尚未就绪，请稍后重试。', true); return false;
  }
  openLegacyImport(raw = '') {
    if (this.libraryReadOnly) return;
    const dialog = this.openDialog('兼容 JSON 草稿', '仅导入流程定义，将替换当前画布。'), area = el('textarea'); area.setAttribute('aria-label', '工作流 JSON'); area.placeholder = '粘贴工作流 JSON，或选择文件'; area.value = raw;
    const feedback = el('p', 'wf-import-feedback'); feedback.setAttribute('role', 'status');
    const footer = el('div', 'wf-dialog-actions'), choose = el('button', 'wf-button', '选择 JSON 文件'), cancel = el('button', 'wf-button', '取消'), submit = el('button', 'wf-button primary', '导入并替换草稿');
    for (const b of [choose, cancel, submit]) b.type = 'button';
    choose.addEventListener('click', () => this.root.querySelector('.wf-file-input').click()); cancel.addEventListener('click', () => dialog.close());
    submit.addEventListener('click', () => {
      try {
        if (new Blob([area.value]).size > MAX_FILE_BYTES) throw new Error('JSON 不能超过 2 MB。');
        const next = validateDocument(JSON.parse(area.value)); this.commit(next, '导入工作流', this.doc, { autoLayout: false });
        this.propertyDrafts.clear(); this.selection.clear(); this.selectedEdge = null; this.cancelConnection(); this.renderSelection(); this.renderProperties();
        dialog.close(); this.fit(); this.toast(`已导入 ${next.nodes.length} 个节点、${next.edges.length} 条连线。`);
      } catch (error) { feedback.textContent = `导入失败：${error.message}`; feedback.classList.add('error'); }
    });
    footer.append(choose, cancel, submit); dialog.append(area, feedback, footer);
  }
  openNewDialog() {
    if (this.libraryReadOnly) return;
    const dialog = this.openDialog('新建空白流程', '当前草稿会被替换，可通过撤销恢复。需要另存时请先导出 JSON。'), footer = el('div', 'wf-dialog-actions'), cancel = el('button', 'wf-button', '取消'), create = el('button', 'wf-button primary', '新建空白草稿');
    cancel.type = create.type = 'button'; cancel.addEventListener('click', () => dialog.close()); create.addEventListener('click', () => { this.propertyDrafts.clear(); this.selection.clear(); this.selectedEdge = null; this.commit(createDocument({ schemaVersion: 2 }), '新建草稿'); this.fit(); dialog.close(); }); footer.append(cancel, create); dialog.append(footer);
  }
  openHelp() {
    const dialog = this.openDialog('手动编辑工作流', ''), list = el('ul');
    for (const text of ['从节点库拖入节点；点击或 Enter 也可添加。右键画布可搜索节点。', '拖动端口连线，或依次点击两个端口。Esc 取消；类型冲突、占用输入和循环连接会被拒绝。', '拖动空白、按住空格或鼠标中键可平移；滚轮缩放；Shift 拖动空白框选。', 'Shift 点击多选；拖动任一选中节点可整体移动。方向键微调，Shift + 方向键加大步长。', '代码在本机执行，不是 OS 沙箱；只运行你信任的代码。']) list.append(el('li', '', text)); dialog.append(list);
    const shortcuts = el('ul');
    for (const action of SHORTCUT_ACTIONS.filter(item => ['editor', 'canvas'].includes(item.scope))) shortcuts.append(el('li', '', `${action.label}：${shortcutLabel(action.id, this.getShortcuts?.())}`));
    dialog.append(el('h3', '', '当前快捷键'), shortcuts);
  }
  loadExample() {
    if (this.libraryReadOnly) return false;
    if (this.examples) return this.examples.open();
    this.toast('示例目录尚未就绪，请稍后重试。', true); return false;
  }
}

