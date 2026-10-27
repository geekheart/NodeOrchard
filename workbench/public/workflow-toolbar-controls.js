const NS = 'http://www.w3.org/2000/svg';
const PATHS = {
  workflow: 'M4 4h6v6H4zM14 14h6v6h-6zM7 10v7h7M14 4h6v6h-6zM10 7h4',
  'file-input': 'M14 3H5v18h14V8zM14 3v5h5M9 12h7m-3-3 3 3-3 3',
  'file-output': 'M14 3H5v18h14V8zM14 3v5h5M9 13h7m-4-3-3 3 3 3',
  book: 'M12 5c-3-2-7-2-10-1v15c3-1 7-1 10 1 3-2 7-2 10-1V4c-3-1-7-1-10 1zM12 5v15',
  code: 'm8 5-6 7 6 7m8-14 6 7-6 7M14 3l-4 18',
  layers: 'm12 2 10 5-10 5L2 7zM2 12l10 5 10-5M2 17l10 5 10-5',
  sliders: 'M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6m-6 0v6',
  diamond: 'm12 2 10 10-10 10L2 12z',
  list: 'M8 5h13M8 12h13M8 19h13M3 5h.01M3 12h.01M3 19h.01',
  repeat: 'M20 7H7a4 4 0 0 0-4 4m17-4-4-4m4 4-4 4M4 17h13a4 4 0 0 0 4-4M4 17l4 4m-4-4 4-4',
  user: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M4 21v-2a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v2z',
  undo: 'M9 4 3 10l6 6M3 10h11a7 7 0 0 1 7 7v3',
  redo: 'm15 4 6 6-6 6M21 10H10a7 7 0 0 0-7 7v3',
  plus: 'M12 5v14M5 12h14', minus: 'M5 12h14',
  fit: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M8 8h8v8H8z',
  library: 'M3 4h6v16H3zM12 4h4v16h-4zM18 5l3-1 3 15-3 1z',
  panel: 'M3 4h18v16H3zM14 4v16', close: 'm6 6 12 12M6 18 18 6',
  save: 'M4 3h13l4 4v14H3V3zM7 3v6h10V3M7 21v-8h10v8',
  download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  upload: 'M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5',
  folder: 'M3 6h7l2 2h9v12H3zM3 6V4h7l2 2',
  trash: 'M3 6h18M8 6V3h8v3M5 6l1 15h12l1-15M10 10v7m4-7v7',
  copy: 'M8 8h13v13H8zM16 8V3H3v13h5',
  help: 'M9 8a3 3 0 0 1 6 0c0 2-3 2-3 5m0 4h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  motion: 'M3 7h6M2 12h5M3 17h6m6-13 7 8-7 8M10 5l6 7-6 7',
  play: 'm8 4 13 8-13 8z', cursor: 'm4 3 6 18 3-7 7-3z',
  clock: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0M12 6v6l4 2',
  board: 'M3 4h18v16H3zM9 4v16M15 4v16',
  edit: 'm4 16-1 5 5-1L21 7l-5-5zM13 5l6 6',
  activity: 'M3 4h18v16H3zM5 12h4l2-5 3 10 2-5h3',
  canvas: 'M3 4h18v16H3zM7 8h10v8H7z',
  'canvas-off': 'M3 4h18v16H3zM3 3l18 18',
  chat: 'M4 3h16v13H9l-5 5zM8 7h8M8 11h6',
  check: 'M9 12l2 2 5-5M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
};
export function createWorkflowIcon(name) {
  const svg = svgElement('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  svg.dataset.workflowIcon = name;
  svg.append(svgElement('path', { d: PATHS[name] || PATHS.workflow })); return svg;
}
function svgElement(tag, attrs = {}) { const node = document.createElementNS(NS, tag); for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value); return node; }

const positioned = new WeakSet();
function bindTooltip(button) {
  if (positioned.has(button)) return;
  positioned.add(button);
  const position = () => {
    const box = button.getBoundingClientRect(), width = button.ownerDocument.defaultView.innerWidth;
    const side = box.left < 140 ? 'start' : box.right > width - 140 ? 'end' : 'center';
    button.dataset.tooltipAlign = side;
    button.style.setProperty('--wf-toolbar-tip-x', `${Math.max(8, Math.min(width - 8, side === 'start' ? box.left : side === 'end' ? box.right : box.left + box.width / 2))}px`);
    button.style.setProperty('--wf-toolbar-tip-y', `${box.bottom + 7}px`);
    button.dataset.tooltipReady = 'true';
  };
  button.addEventListener('pointerenter', position);
  button.addEventListener('focusin', position);
}

// Updating state must keep the icon, event handler and native disabled guard.
export function setToolbarControl(button, { label, icon, busy = false, pressed } = {}) {
  button.classList.add('wf-toolbar-button');
  button.setAttribute('aria-label', label); button.title = label; button.dataset.tooltip = label;
  button.setAttribute('aria-busy', String(busy));
  if (pressed !== undefined) button.setAttribute('aria-pressed', String(pressed));
  const current = button.querySelector('svg');
  button.replaceChildren(current?.dataset?.workflowIcon === icon ? current : createWorkflowIcon(icon));
  bindTooltip(button);
  return button;
}
