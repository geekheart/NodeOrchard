import { formatDiagnosticEvent } from '../shared/diagnostics.mjs';

export function diagnosticDetails(event, { document = globalThis.document, open = false,
  formatDate = value => value || '', format = formatDiagnosticEvent } = {}) {
  const detail = document.createElement('details'); detail.className = 'event-entry';
  detail.dataset.eventId = String(event.id ?? `${event.type}-${event.at}`);
  const summary = document.createElement('summary');
  const type = document.createElement('span'); type.className = 'event-type'; type.textContent = event.type;
  const time = document.createElement('span'); time.className = 'event-time';
  time.textContent = [formatDate(event.at, true), event.summary, event.preview.truncated ? '诊断已截断' : ''].filter(Boolean).join(' · ');
  summary.append(type, time); detail.append(summary); let pre;
  const render = () => {
    if (!detail.open) { pre?.remove(); pre = undefined; return; }
    if (!pre) { pre = document.createElement('pre'); pre.textContent = format(event); detail.append(pre); }
  };
  detail.addEventListener('toggle', render); detail.open = open;
  if (open) render();
  return detail;
}
