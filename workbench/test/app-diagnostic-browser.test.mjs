import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppDiagnosticBrowser, createReadOnlyAppProxy, diagnosticRoute, diagnosticSteps } from '../src/app-diagnostic-browser.mjs';

test('diagnostic navigation and replay stay in the local application without arbitrary script or input entry', () => {
  const origin = 'http://127.0.0.1:4318';
  assert.equal(diagnosticRoute(origin, '/#/workflows/example'), origin + '/?diagnosticCapture=readonly#/workflows/example');
  for (const route of ['https://example.com/', '//example.com/', '/api/bootstrap', '/?token=secret', '/#javascript:alert(1)']) assert.throws(() => diagnosticRoute(origin, route));
  assert.throws(() => diagnosticSteps([{ type: 'evaluate', code: 'fetch("/api/run",{method:"POST"})' }]));
  assert.throws(() => diagnosticSteps([{ type: 'click', selector: 'input[type=password]' }]));
  assert.throws(() => diagnosticSteps([{ type: 'click', selector: '#run', value: 'PRIVATE_INPUT' }]));
  assert.equal(diagnosticSteps([{ type: 'click', selector: '[data-action="toggle-canvas"]' }, { type: 'scroll', deltaY: 500 }]).length, 2);
});

test('the browser-wide proxy blocks writes and other origins before the upstream application sees them', async t => {
  const seen = [], app = createServer((req, res) => { seen.push({ method: req.method, url: req.url }); res.end('local app'); });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => app.close(resolve)));
  const origin = 'http://127.0.0.1:' + app.address().port, proxy = await createReadOnlyAppProxy(origin); t.after(() => proxy.close());
  const { request } = await import('node:http');
  const call = (url, method = 'GET') => new Promise((resolve, reject) => { const req = request({ hostname: '127.0.0.1', port: proxy.port, path: url, method }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.on('error', reject); req.end(); });
  assert.equal(await call(origin + '/api/bootstrap'), 200);
  assert.equal(await call(origin + '/api/connect', 'POST'), 403);
  assert.equal(await call('http://example.invalid/private'), 403);
  assert.equal(await call(origin + '/api/sessions/existing/history'), 403);
  assert.equal(await call(origin + '/api/unknown'), 403);
  assert.deepEqual(seen, [{ method: 'GET', url: '/api/bootstrap' }]); assert.equal(proxy.blockedRequests, 4);
});

test('run and queue JSON omit training scopes and live event streams are blocked in diagnostic captures', async t => {
  const ordinary = { id: 'ordinary', status: 'complete', document: { mode: 'execute' } }, training = { id: 'training', learningId: 'batch', output: 'PRIVATE_TRAINING_ANSWER' };
  const app = createServer((req, res) => {
    if (req.url === '/api/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': first event\n\n'); return; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(req.url === '/api/workflow-runs/training' ? training : { runs: [ordinary, training], queued: [{ id: 'scoped', memoryScopeId: 'scope', input: 'PRIVATE_INPUT' }] }));
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve)); t.after(() => { app.closeAllConnections(); return new Promise(resolve => app.close(resolve)); });
  const origin = 'http://127.0.0.1:' + app.address().port, proxy = await createReadOnlyAppProxy(origin); t.after(() => proxy.close());
  const { request } = await import('node:http');
  const read = path => new Promise((resolve, reject) => { const req = request({ hostname: '127.0.0.1', port: proxy.port, path: origin + path }, res => { const parts = []; res.on('data', chunk => parts.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(parts).toString() })); }); req.on('error', reject); req.end(); });
  const listed = await read('/api/workflow-runs'); assert.deepEqual(JSON.parse(listed.text), { runs: [ordinary], queued: [] }); assert.equal(listed.text.includes('PRIVATE_'), false);
  assert.equal((await read('/api/workflow-runs/training')).status, 403);
  const blocked = await read('/api/events'); assert.equal(blocked.status, 403); assert.match(blocked.text, /request blocked/);
});

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB34AAAAASUVORK5CYII=';
async function fixture(t, custom = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'app-diagnostic-browser-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
  const calls = []; let closed = false;
  const browser = createAppDiagnosticBrowser({ dataDir, ffmpegPath: false, sessionFactory: async options => ({
    blockedRequests: 0, async send(method, params) { calls.push({ method, params, options }); if (method === 'Runtime.evaluate') return { result: { value: { masked: true } } }; if (method === 'Page.captureScreenshot') return { data: png }; return {}; }, async close() { closed = true; },
  }), ...custom }); browser.setOrigin('http://127.0.0.1:4318');
  return { browser, calls, dataDir, closed: () => closed };
}

test('screenshots save actual PNG bytes from CDP and identify their isolated read-only source', async t => {
  const f = await fixture(t), result = await f.browser.capture({ route: '/#/board', mode: 'screenshot' });
  assert.equal(result.kind, 'screenshot'); assert.equal(result.source, 'isolated-readonly-browser'); assert.equal(result.currentUserTab, false);
  assert.deepEqual(await readFile(result.path), Buffer.from(png, 'base64')); assert.equal(f.closed(), true);
  assert.ok(f.calls.some(call => call.method === 'Page.navigate' && call.params.url === 'http://127.0.0.1:4318/?diagnosticCapture=readonly#/board'));
  assert.ok(f.calls.filter(call => call.method === 'Runtime.evaluate').every(call => call.params.expression.includes('app-diagnostic-redaction')));
  assert.equal(result.maskedInputs, true); assert.deepEqual(result.imagePaths, [result.path]);
  const reopened = createAppDiagnosticBrowser({ dataDir: f.dataDir }); assert.equal((await reopened.file(result.id, 'frame-0000.png')).path, await realpath(result.path));
  for (const name of ['../private', 'capture.json', 'missing.png']) await assert.rejects(reopened.file(result.id, name));
});

test('text evidence excludes inputs, private regions and learning answers rather than treating DOM as pixels', async t => {
  const node = (localName, text, attributes = []) => ({ localName, attributes, children: [{ nodeType: 3, nodeValue: text }] });
  const f = await fixture(t, { sessionFactory: async () => ({ async send(method) {
    if (method === 'Runtime.evaluate') return { result: { value: { masked: true } } }; if (method === 'Page.captureScreenshot') return { data: png };
    if (method === 'DOM.getDocument') return { root: { localName: 'html', children: [node('title', 'Fixture title'), node('p', 'Visible diagnostic state'), node('textarea', 'PRIVATE_INPUT'), node('div', 'PRIVATE_BLOCK', ['data-diagnostic-private', '']), node('aside', 'PRIVATE_ANSWER', ['class', 'wf-learning'])] } };
    return {};
  }, async close() {} }) });
  const result = await f.browser.capture({ mode: 'screenshot' }); assert.equal(result.page.title, 'Fixture title'); assert.match(result.page.text, /Visible diagnostic state/); assert.equal(JSON.stringify(result.page).includes('PRIVATE_'), false);
});

test('short recordings return an honest replayable frame manifest when no encoder is available', async t => {
  const f = await fixture(t), result = await f.browser.capture({ route: '/#/board', mode: 'recording', durationSeconds: 0.2 });
  assert.equal(result.kind, 'frames'); assert.equal(result.mimeType, 'application/json'); assert.ok(result.frames.length > 0);
  const manifest = JSON.parse(await readFile(result.path, 'utf8')); assert.equal(manifest.kind, 'frames'); assert.equal(manifest.source, 'isolated-readonly-browser');
  assert.equal(manifest.frames.length, result.frames.length); assert.equal(f.closed(), true);
});

test('invalid screenshot bytes and cancelled sessions fail without claiming a successful image', async t => {
  const f = await fixture(t, { sessionFactory: async () => ({ async send(method) { return method === 'Page.captureScreenshot' ? { data: Buffer.from('not pixels').toString('base64') } : { result: { value: { masked: true } } }; }, async close() {} }) });
  await assert.rejects(f.browser.capture({ mode: 'screenshot' }), /PNG/);
  const controller = new AbortController(); controller.abort(); await assert.rejects(f.browser.capture({ mode: 'screenshot', signal: controller.signal }), /abort/i);
  for (const origin of ['https://example.com', 'http://0.0.0.0:4318', 'file:///tmp/private']) assert.throws(() => f.browser.setOrigin(origin));
});

test('an unconfirmed privacy mask fails before reading screenshot pixels', async t => {
  let screenshots = 0;
  const f = await fixture(t, { sessionFactory: async () => ({ async send(method) {
    if (method === 'Runtime.evaluate') return { result: { value: { masked: false } } };
    if (method === 'Page.captureScreenshot') { screenshots++; return { data: png }; }
    return {};
  }, async close() {} }) });
  await assert.rejects(f.browser.capture({ mode: 'screenshot' }), /隐私遮罩未确认/); assert.equal(screenshots, 0);
});
