import { safeText, diagnosticSnapshot } from '../shared/diagnostics.mjs';

// Keep operational evidence, never typed values, request/response bodies,
// headers, cookies, storage, or arbitrary console objects.
export function createAppDiagnosticClient({ window = globalThis.window, document = globalThis.document, getState = () => ({}) } = {}) {
  const events = [], cleanups = []; let closed = false;
  const record = (kind, details) => {
    if (closed) return;
    events.push({ at: new Date().toISOString(), kind, ...diagnosticSnapshot(details).value });
    if (events.length > 80) events.shift();
  };
  const route = () => safeText(window.location?.hash || '#/board').split('?')[0].slice(0, 256);
  const selector = target => {
    const node = target?.closest?.('button,a,summary,input,select,textarea,[role="button"]');
    if (!node) return null;
    const tag = String(node.tagName || '').toLowerCase();
    return { tag, ...(node.id && /^[\w-]{1,128}$/.test(node.id) ? { id: node.id } : {}),
      ...(tag !== 'input' && tag !== 'textarea' && node.getAttribute?.('aria-label') ? { label: safeText(node.getAttribute('aria-label')).slice(0, 120) } : {}) };
  };
  const listen = (host, name, callback) => { host?.addEventListener?.(name, callback, true); cleanups.push(() => host?.removeEventListener?.(name, callback, true)); };
  listen(document, 'click', event => { const target = selector(event.target); if (target) record('click', { route: route(), target }); });
  listen(document, 'change', event => { const target = selector(event.target); if (target) record('change', { route: route(), target, valueOmitted: true }); });
  listen(window, 'hashchange', () => record('navigate', { route: route() }));
  listen(window, 'error', event => record('error', { message: safeText(event.message || '页面资源错误').slice(0, 1200), line: event.lineno, column: event.colno }));
  listen(window, 'unhandledrejection', event => record('promise-error', { message: safeText(typeof event.reason === 'string' ? event.reason : event.reason?.message || '异步请求失败').slice(0, 1200) }));
  return {
    recordRequest(path, status, message = '') {
      if (status >= 400 || status === 0) record('request-error', { path: String(path).split(/[?#]/)[0].slice(0, 256), status, message: safeText(message).slice(0, 800) });
    },
    snapshot() { return diagnosticSnapshot({ source: 'current-application-page', route: route(), capturedAt: new Date().toISOString(),
      viewport: { width: window.innerWidth, height: window.innerHeight }, state: getState(), events: events.slice(-40),
      capture: { currentTabPixels: false, reproductionBrowser: true } }).value; },
    close() { closed = true; for (const cleanup of cleanups) cleanup(); events.length = 0; },
  };
}
