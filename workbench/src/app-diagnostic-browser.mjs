import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const fail = message => Object.assign(new Error(message), { code: 'DIAGNOSTIC_CAPTURE_UNAVAILABLE' });
const privateText = value => String(value || '').replace(/\b(?:sk-[\w-]{8,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, '[REDACTED]').replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]').replace(/((?:access_token|refresh_token|api_key|authorization|password)\s*[=:]\s*)[^\s,}]+/gi, '$1[REDACTED]').slice(0, 12000);
const READ_API = /^\/api\/(?:bootstrap|settings|models|statistics|skills(?:\/[A-Za-z0-9_-]+)?|workflow-node-presets(?:\/[A-Za-z0-9_-]+)?|workflow-library(?:\/[A-Za-z0-9_-]+)?|workflow-conversations\/[A-Za-z0-9_-]+|workflow-schedules(?:\/[A-Za-z0-9_-]+)?|workflow-runs(?:\/[A-Za-z0-9_-]+(?:\/feedback)?)?|workflow-v2\/queue|workflow-v2\/artifacts\/[A-Za-z0-9_-]+|app-assistant)$/;
const READ_ASSET = /^\/(?:[A-Za-z0-9_./-]+\.(?:js|mjs|css|svg|png|jpg|jpeg|webp|gif|ico|woff2?))?$/;
// This constant is application-owned privacy protection, never model-supplied
// JavaScript. The capture API does not expose an evaluate/script operation.
const MASK_SCRIPT = `(() => { const id = 'app-diagnostic-redaction', selector = 'input,textarea,select,[contenteditable="true"],[data-diagnostic-private],.wf-properties,.wf-learning,.wf-node[data-type="evaluation"],.wf-node[data-type="improvement"]'; if (!document.getElementById(id)) { const style = document.createElement('style'); style.id = id; style.textContent = selector + '{visibility:hidden!important}'; (document.head || document.documentElement)?.append(style); } const nodes = [...document.querySelectorAll(selector)]; return { masked: nodes.length <= 2000 && nodes.every(node => getComputedStyle(node).visibility === 'hidden'), count: nodes.length }; })()`;
function withoutLearningRuns(value, depth = 0) {
  if (depth > 40) throw fail('诊断运行记录过深，已拒绝读取。');
  if (!value || typeof value !== 'object') return value;
  if (value.learningId || value.memoryScopeId || value.document?.mode === 'learn') return undefined;
  if (Array.isArray(value)) return value.map(item => withoutLearningRuns(item, depth + 1)).filter(item => item !== undefined);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withoutLearningRuns(item, depth + 1)]).filter(([, item]) => item !== undefined));
}
function appOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw fail('诊断浏览器只允许本机应用地址。');
  return url.origin;
}

export function diagnosticRoute(origin, route = '/#/board') {
  origin = appOrigin(origin);
  if (typeof route !== 'string' || route.length > 1024 || !route.startsWith('/') || route.startsWith('//') || /[\x00-\x20\\]/.test(route)) throw fail('诊断只能导航到本应用页面。');
  const url = new URL(route, origin);
  if (url.origin !== origin || url.pathname !== '/' || url.search || url.hash && !/^#\/[A-Za-z0-9_/-]*$/.test(url.hash)) throw fail('诊断只能使用本应用的页面路由。');
  url.searchParams.set('diagnosticCapture', 'readonly');
  return url.href;
}

export function diagnosticSteps(steps = []) {
  if (!Array.isArray(steps) || steps.length > 12) throw fail('复现步骤最多为 12 项。');
  return steps.map(step => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) throw fail('复现步骤格式无效。');
    const keys = step.type === 'click' ? ['type', 'selector'] : step.type === 'scroll' ? ['type', 'deltaY', 'deltaX', 'x', 'y'] : step.type === 'navigate' ? ['type', 'route'] : [];
    if (!keys.length || Object.keys(step).some(key => !keys.includes(key))) throw fail('复现只支持受限点击、滚动和应用页面导航。');
    if (step.type === 'click' && (typeof step.selector !== 'string' || step.selector.length > 200 || !/^(?:#[A-Za-z][\w-]*|\.[A-Za-z][\w-]*|\[(?:data-action|data-studio-tab|aria-label)="[^"\x00-\x1f]{1,120}"\])$/.test(step.selector))) throw fail('复现点击需要一个明确的应用按钮选择器。');
    if (step.type === 'scroll') for (const key of ['deltaY', 'deltaX', 'x', 'y']) if (step[key] !== undefined && (!Number.isFinite(step[key]) || Math.abs(step[key]) > 2000)) throw fail('复现滚动参数超出范围。');
    return { ...step };
  });
}

// Chromium's proxy applies to workers, popups and new targets as well as the
// main page. A fresh diagnostic profile cannot bypass the read-only boundary
// by opening another target before a page-level CDP interception is attached.
export async function createReadOnlyAppProxy(origin) {
  origin = appOrigin(origin); let blockedRequests = 0; const networkFailures = [];
  const failure = item => { networkFailures.push(item); if (networkFailures.length > 30) networkFailures.shift(); };
  const server = createServer((req, res) => {
    let target;
    try { target = new URL(req.url, origin); } catch {}
    if (!target || target.origin !== origin || req.method !== 'GET' || target.username || target.password || !(target.pathname.startsWith('/api/') ? READ_API.test(target.pathname) : READ_ASSET.test(target.pathname))) {
      blockedRequests++; failure({ method: req.method, status: 403, blocked: true }); res.writeHead(403, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end('Read-only diagnostic browser: request blocked.'); return;
    }
    const headers = { host: target.host, accept: req.headers.accept || '*/*', 'x-nodeorchard-diagnostic': 'readonly' };
    if (req.headers['last-event-id']) headers['last-event-id'] = req.headers['last-event-id'];
    const upstream = request(target, { method: 'GET', headers }, response => {
      if (response.statusCode >= 400) failure({ method: 'GET', path: target.pathname.slice(0, 200), status: response.statusCode });
      // Buffer only bounded run/queue JSON. EventSource and assets remain
      // streaming; training/validation run payloads never reach this browser.
      if (/^\/api\/(?:workflow-runs(?:\/|$)|workflow-v2\/)/.test(target.pathname) && String(response.headers['content-type']).includes('application/json')) {
        const chunks = []; let bytes = 0, rejected = false;
        const deny = () => { if (rejected) return; rejected = true; blockedRequests++; failure({ method: 'GET', path: target.pathname.slice(0, 200), status: 403, blocked: true }); if (!res.headersSent) res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end('{"error":"Learning evidence is private in diagnostic captures."}'); };
        response.on('data', chunk => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) { deny(); upstream.destroy(); } else chunks.push(chunk); });
        response.on('end', () => {
          if (rejected) return;
          try {
            const original = JSON.parse(Buffer.concat(chunks).toString('utf8')), clean = withoutLearningRuns(original);
            if (clean === undefined || original?.run && clean.run === undefined) { deny(); return; }
            const body = JSON.stringify(clean), outgoing = { ...response.headers, 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' }; delete outgoing.etag;
            res.writeHead(response.statusCode || 200, outgoing); res.end(body);
          } catch { deny(); }
        }); return;
      }
      res.writeHead(response.statusCode || 502, response.headers); response.pipe(res);
    });
    upstream.on('error', () => { failure({ method: 'GET', path: target.pathname.slice(0, 200), status: 502 }); if (!res.headersSent) res.writeHead(502); res.end(); });
    res.on('close', () => upstream.destroy()); upstream.end();
  });
  // Chrome may reset a rejected CONNECT/upgrade socket while shutting down.
  // Those sockets leave Node's HTTP parser; their errors must stay local to
  // this diagnostic request rather than terminating the application process.
  server.on('connection', socket => socket.on('error', () => {}));
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('connect', (_req, socket) => { blockedRequests++; socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); });
  server.on('upgrade', (_req, socket) => { blockedRequests++; socket.destroy(); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { port: server.address().port, networkFailures, get blockedRequests() { return blockedRequests; }, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

async function executable(candidates) {
  for (const path of candidates.filter(Boolean)) { try { await access(path, constants.X_OK); return path; } catch {} }
  return null;
}

class CDP {
  constructor(socket, signal) {
    this.socket = socket; this.signal = signal; this.pending = new Map(); this.nextId = 0;
    socket.addEventListener('message', event => {
      let frame; try { frame = JSON.parse(event.data); } catch { return; }
      if (frame.method) { this.onEvent?.(frame); return; }
      const call = this.pending.get(frame.id); if (!call) return;
      this.pending.delete(frame.id); clearTimeout(call.timer); frame.error ? call.reject(fail('诊断浏览器命令失败。')) : call.resolve(frame.result || {});
    });
    socket.addEventListener('close', () => this.rejectAll(fail('诊断浏览器连接已关闭。')));
    this.abort = () => { this.rejectAll(signal.reason || new Error('Capture aborted')); socket.close(); }; signal.addEventListener('abort', this.abort, { once: true });
  }
  rejectAll(error) { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); } this.pending.clear(); }
  send(method, params = {}, sessionId) {
    this.signal.throwIfAborted(); const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(fail('诊断浏览器命令超时。')); }, 10000);
      this.pending.set(id, { resolve, reject, timer }); this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() { this.signal.removeEventListener('abort', this.abort); this.rejectAll(fail('诊断已结束。')); this.socket.close(); }
}

async function launchSession({ chromePath, browserRoot, origin, signal }) {
  await mkdir(browserRoot, { recursive: true, mode: 0o700 });
  const profile = await mkdtemp(join(browserRoot, 'session-')), proxy = await createReadOnlyAppProxy(origin);
  const child = spawn(chromePath, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions', '--disable-default-apps', '--disable-features=MediaRouter', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--window-size=1440,960', '--proxy-server=http://127.0.0.1:' + proxy.port, '--proxy-bypass-list=<-loopback>', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  let launchError, cdp, closing; child.on('error', error => { launchError = error; });
  const close = async () => {
    if (closing) return closing;
    closing = (async () => {
    cdp?.close();
    if (child.exitCode === null && !launchError) { child.kill('SIGTERM'); await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(1500)]); if (child.exitCode === null) child.kill('SIGKILL'); }
    await proxy.close(); await rm(profile, { recursive: true, force: true });
    })(); return closing;
  };
  try {
    let port;
    for (let attempt = 0; attempt < 150; attempt++) {
      signal.throwIfAborted(); if (launchError || child.exitCode !== null) throw fail('无法启动独立诊断 Chrome。');
      try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); if (port > 0) break; } catch {}
      await delay(70, undefined, { signal });
    }
    if (!port) throw fail('诊断 Chrome 启动超时。');
    const info = await (await fetch('http://127.0.0.1:' + port + '/json/version', { signal })).json();
    const endpoint = new URL(info.webSocketDebuggerUrl);
    if (endpoint.hostname !== '127.0.0.1' || Number(endpoint.port) !== port) throw fail('诊断 Chrome 返回了无效控制地址。');
    const socket = new WebSocket(endpoint); await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', () => reject(fail('无法连接诊断 Chrome。')), { once: true }); signal.addEventListener('abort', () => { socket.close(); reject(signal.reason); }, { once: true }); });
    cdp = new CDP(socket, signal);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }), { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const consoleErrors = [];
    cdp.onEvent = frame => {
      if (frame.sessionId !== sessionId) return;
      let message;
      if (frame.method === 'Runtime.consoleAPICalled' && frame.params.type === 'error') message = frame.params.args?.filter(item => typeof item.value === 'string').map(item => item.value).join(' ').slice(0, 1000) || 'console.error';
      if (frame.method === 'Runtime.exceptionThrown') message = frame.params.exceptionDetails?.exception?.description || frame.params.exceptionDetails?.text || 'Uncaught application error';
      if (message) { consoleErrors.push({ message: /\b(?:headers?|body|payload)\b/i.test(message) ? '[Private request details omitted]' : privateText(message).slice(0, 1000) }); if (consoleErrors.length > 20) consoleErrors.shift(); }
    };
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    // This owned browser only runs fixed application code. Inspector-injected
    // privacy styles must also work on the app's strict style-src policy.
    await cdp.send('Page.setBypassCSP', { enabled: true }, sessionId);
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: MASK_SCRIPT }, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false }, sessionId);
    return { send: (method, params) => cdp.send(method, params, sessionId), consoleErrors, networkFailures: proxy.networkFailures, get blockedRequests() { return proxy.blockedRequests; }, close };
  } catch (error) { await close(); throw error; }
}

async function replay(session, step, origin, signal) {
  signal.throwIfAborted();
  if (step.type === 'navigate') return session.send('Page.navigate', { url: diagnosticRoute(origin, step.route) });
  if (step.type === 'scroll') return session.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.max(0, Math.min(1439, step.x ?? 720)), y: Math.max(0, Math.min(959, step.y ?? 480)), deltaX: step.deltaX || 0, deltaY: step.deltaY || 0 });
  const { root } = await session.send('DOM.getDocument', {}), { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector: step.selector });
  if (!nodeId) throw fail('复现目标在当前页面不存在。');
  const { node } = await session.send('DOM.describeNode', { nodeId }), attributes = Object.fromEntries(Array.from({ length: (node.attributes || []).length / 2 }, (_, i) => [node.attributes[i * 2], node.attributes[i * 2 + 1]]));
  if (!['button', 'summary', 'a'].includes(node.localName) || attributes.type === 'submit' || attributes['data-action'] && !['toggle-canvas', 'toggle-library', 'toggle-properties', 'fit', 'zoom-in', 'zoom-out', 'reset-zoom', 'help'].includes(attributes['data-action'])) throw fail('诊断复现不点击输入、提交或业务操作控件。');
  if (node.localName === 'a') diagnosticRoute(origin, attributes.href?.startsWith('#') ? '/' + attributes.href : attributes.href || '');
  const { model } = await session.send('DOM.getBoxModel', { nodeId }), quad = model.border;
  const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4, y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function encodeVideo(ffmpeg, directory, fps, signal) {
  if (!ffmpeg) return null;
  const path = join(directory, 'recording.mp4');
  const child = spawn(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-framerate', String(fps), '-i', join(directory, 'frame-%04d.png'), '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path], { stdio: 'ignore' });
  let killTimer; const abort = () => { child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 1000); killTimer.unref(); }; signal.addEventListener('abort', abort, { once: true });
  try { const code = await new Promise(resolve => { child.once('error', () => resolve(-1)); child.once('exit', resolve); }); signal.throwIfAborted(); return code === 0 && (await stat(path)).size > 0 ? path : null; }
  finally { clearTimeout(killTimer); signal.removeEventListener('abort', abort); }
}

async function pageSnapshot(session) {
  try {
    const { root } = await session.send('DOM.getDocument', { depth: -1 }), result = { title: '', text: '' };
    let count = 0;
    const visit = (node, title = false) => {
      const attributes = Object.fromEntries(Array.from({ length: (node.attributes || []).length / 2 }, (_, i) => [node.attributes[i * 2], node.attributes[i * 2 + 1]]));
      if (++count > 20000 || result.text.length > 12000 || ['script', 'style', 'textarea', 'input', 'select', 'option'].includes(node.localName) || Object.hasOwn(attributes, 'data-diagnostic-private') || /(?:^|\s)wf-(?:properties|learning|learning-inspection)(?:\s|$)/.test(attributes.class || '') || ['evaluation', 'improvement'].includes(attributes['data-type'])) return;
      if (node.nodeType === 3 && node.nodeValue?.trim()) { if (title) result.title += node.nodeValue.slice(0, 160); else result.text += node.nodeValue.trim() + '\n'; }
      for (const child of node.children || []) visit(child, title || node.localName === 'title');
    };
    if (root) visit(root); return { title: privateText(result.title).slice(0, 160), text: privateText(result.text) };
  } catch { return { title: '', text: '', available: false }; }
}

export function createAppDiagnosticBrowser({ dataDir, chromePath, ffmpegPath, sessionFactory = launchSession } = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw fail('诊断存储目录尚未配置。');
  const root = resolve(dataDir, 'diagnostics'), active = new Set(), sessions = new Set(); let origin, closed = false;
  async function capabilities() {
    const chrome = await executable(chromePath ? [chromePath] : ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']);
    const ffmpeg = ffmpegPath === false ? null : await executable(ffmpegPath ? [ffmpegPath] : ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']);
    const available = Boolean(chrome && typeof WebSocket === 'function');
    return { available, screenshot: available, recording: available, video: available && Boolean(ffmpeg), replay: available, source: 'isolated-readonly-browser', currentUserTab: false, chromePath: chrome, ffmpegPath: ffmpeg, reason: available ? null : '需要可用的本机 Chrome 与 Node WebSocket。' };
  }
  return {
    setOrigin(value) { origin = appOrigin(value); }, capabilities,
    async close() { closed = true; for (const controller of active) controller.abort(new Error('Diagnostic capture aborted by shutdown')); await Promise.allSettled([...sessions].map(session => session.close())); },
    async file(id, filename) {
      if (!/^[a-f0-9-]{36}$/.test(id || '') || !/^(?:frame-\d{4}\.png|recording\.mp4|frames\.json)$/.test(filename || '')) throw fail('无效的诊断附件。');
      const directory = await realpath(join(root, 'captures', id)); if (!directory.startsWith((await realpath(join(root, 'captures'))) + '/')) throw fail('诊断附件位置无效。');
      const manifest = JSON.parse(await readFile(join(directory, 'capture.json'), 'utf8'));
      if (!manifest.files?.includes(filename)) throw fail('诊断附件未登记。');
      const path = await realpath(join(directory, filename)); if (!path.startsWith((await realpath(directory)) + '/')) throw fail('诊断附件位置无效。');
      const info = await stat(path); if (!info.isFile() || info.size > 80 * 1024 * 1024) throw fail('诊断附件不可读取。');
      return { path, size: info.size, mimeType: filename.endsWith('.png') ? 'image/png' : filename.endsWith('.mp4') ? 'video/mp4' : 'application/json' };
    },
    async capture({ route = '/#/board', mode = 'screenshot', durationSeconds = 3, steps = [], signal } = {}) {
      if (!origin) throw fail('应用监听地址尚未就绪。');
      if (closed) throw fail('诊断浏览器已关闭。');
      if (!['screenshot', 'recording'].includes(mode)) throw fail('只支持真实截图或短录制。');
      const url = diagnosticRoute(origin, route), checked = diagnosticSteps(steps);
      if (!Number.isFinite(durationSeconds) || durationSeconds < 0.1 || durationSeconds > 10) throw fail('短录制时长须在 0.1 至 10 秒之间。');
      const controller = new AbortController(), bounded = AbortSignal.any([controller.signal, AbortSignal.timeout(50000), ...(signal ? [signal] : [])]); bounded.throwIfAborted();
      const capability = await capabilities(); if (!capability.available && sessionFactory === launchSession) throw fail(capability.reason);
      const id = randomUUID(), directory = join(root, 'captures', id); await mkdir(directory, { recursive: true, mode: 0o700 });
      active.add(controller); let session;
      try { session = await sessionFactory({ chromePath: capability.chromePath, browserRoot: join(root, 'browser'), origin, signal: bounded }); }
      catch (error) { active.delete(controller); throw error; }
      sessions.add(session);
      try {
        await session.send('Page.navigate', { url }); if (sessionFactory === launchSession) await delay(1000, undefined, { signal: bounded });
        const frames = [], startedAt = Date.now(), fps = 3;
        const frame = async () => {
          bounded.throwIfAborted(); const mask = await session.send('Runtime.evaluate', { expression: MASK_SCRIPT, returnByValue: true });
          if (mask.result?.value?.masked !== true) throw fail('页面隐私遮罩未确认生效，已停止截图。');
          const { data } = await session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
          const bytes = Buffer.from(data || '', 'base64'); if (!bytes.subarray(0, 8).equals(PNG)) throw fail('诊断浏览器没有返回有效 PNG 像素。');
          const name = 'frame-' + String(frames.length).padStart(4, '0') + '.png', path = join(directory, name); await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); frames.push({ name, path, atMs: Date.now() - startedAt });
        };
        const replayed = [];
        if (mode === 'screenshot') { for (const step of checked) { await replay(session, step, origin, bounded); replayed.push({ type: step.type }); if (sessionFactory === launchSession) await delay(150, undefined, { signal: bounded }); } await frame(); }
        else {
          const end = startedAt + durationSeconds * 1000; let nextStep = 0;
          do {
            if (nextStep < checked.length) { await replay(session, checked[nextStep], origin, bounded); replayed.push({ type: checked[nextStep++].type, atMs: Date.now() - startedAt }); }
            await frame(); if (Date.now() < end) await delay(Math.min(1000 / fps, end - Date.now()), undefined, { signal: bounded });
          } while (Date.now() < end);
          if (nextStep < checked.length) throw fail('短录制内未能完成所有复现步骤，请减少步骤或增加时长。');
        }
        const metadata = { id, source: 'isolated-readonly-browser', currentUserTab: false, maskedInputs: true, route: new URL(url).hash || '#/board', width: 1440, height: 960, durationMs: Date.now() - startedAt, blockedRequests: session.blockedRequests || 0, consoleErrors: session.consoleErrors || [], networkFailures: session.networkFailures || [], page: await pageSnapshot(session), replayed };
        bounded.throwIfAborted();
        if (mode === 'screenshot') { const result = { ...metadata, kind: 'screenshot', mimeType: 'image/png', path: frames[0].path, imagePaths: [frames[0].path] }; await writeFile(join(directory, 'capture.json'), JSON.stringify({ ...result, files: [frames[0].name] }), { flag: 'wx', mode: 0o600 }); return result; }
        const video = await encodeVideo(capability.ffmpegPath, directory, fps, bounded);
        const manifest = { ...metadata, kind: 'frames', fps, frames: frames.map(({ name, atMs }) => ({ name, atMs })) };
        const path = join(directory, 'frames.json'); await writeFile(path, JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
        const keyFrames = [...new Set(Array.from({ length: Math.min(4, frames.length) }, (_, index) => Math.round(index * (frames.length - 1) / Math.max(1, Math.min(4, frames.length) - 1))))].map(index => frames[index].path);
        const result = { ...metadata, kind: video ? 'video' : 'frames', mimeType: video ? 'video/mp4' : 'application/json', path: video || path, frames, imagePaths: keyFrames, manifestPath: path };
        await writeFile(join(directory, 'capture.json'), JSON.stringify({ ...result, files: [...frames.map(frame => frame.name), 'frames.json', ...(video ? ['recording.mp4'] : [])] }), { flag: 'wx', mode: 0o600 }); return result;
      } finally { active.delete(controller); sessions.delete(session); await session.close(); }
    },
  };
}
