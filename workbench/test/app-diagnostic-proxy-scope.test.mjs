import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppDiagnosticBrowser, createReadOnlyAppProxy } from '../src/app-diagnostic-browser.mjs';

async function fixture(t, handler, policy) {
  const app = createServer(handler); await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + app.address().port, proxy = await createReadOnlyAppProxy(origin, policy);
  t.after(async () => { await proxy.close(); app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); });
  return { proxy, read: (path, method = 'GET') => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: proxy.port, path: origin + path, method }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    }); req.on('error', reject); req.end();
  }) };
}

test('trusted request scope rejects foreign workflow IDs before any upstream read', async t => {
  const seen = [], admitted = [];
  const { read, proxy } = await fixture(t, (req, res) => { seen.push(req.url); res.end('owned'); }, {
    requestPolicy: async url => { admitted.push(url.pathname); if (url.searchParams.has('forbidden')) throw new Error('PRIVATE_REASON'); return !url.pathname.startsWith('/api/workflow-library/') || url.pathname.endsWith('/owned'); },
  });
  assert.equal((await read('/api/workflow-library/owned')).status, 200);
  assert.equal((await read('/api/workflow-library/foreign')).status, 403);
  const failed = await read('/api/workflow-library/owned?forbidden=1'); assert.equal(failed.status, 403); assert.equal(failed.text.includes('PRIVATE_REASON'), false);
  assert.deepEqual(seen, ['/api/workflow-library/owned']); assert.equal(admitted.length, 3); assert.equal(proxy.blockedRequests, 2);
});

test('all scoped API JSON is projected and private learning evidence is removed before and after projection', async t => {
  const projected = [], training = { id: 'training', learningId: 'batch', output: 'PRIVATE_ANSWER' };
  const { read } = await fixture(t, (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json', ETag: 'old' }); res.write(JSON.stringify({ global: 'PRIVATE_GLOBAL', workflows: [{ id: 'owned' }, { id: 'foreign' }], runs: [training] })); res.end(); }, {
    requestPolicy: async () => true,
    responseProject: async (url, json) => { projected.push({ path: url.pathname, json }); return { workflows: json.workflows.filter(item => item.id === 'owned'), injectedTraining: training }; },
  });
  for (const path of ['/api/bootstrap', '/api/workflow-library', '/api/workflow-conversations/owned', '/api/settings', '/api/app-assistant']) {
    const result = await read(path); assert.equal(result.status, 200); assert.deepEqual(JSON.parse(result.text), { workflows: [{ id: 'owned' }] });
    assert.equal(result.text.includes('PRIVATE_'), false); assert.equal(result.headers.etag, undefined); assert.equal(result.headers['transfer-encoding'], undefined);
    assert.equal(Number(result.headers['content-length']), Buffer.byteLength(result.text)); assert.equal(result.headers['cache-control'], 'no-store');
  }
  assert.equal(projected.length, 5); assert.ok(projected.every(item => item.json.runs.length === 0));
});

test('projection rejection, malformed JSON and oversized API responses fail closed', async t => {
  const oversized = 'x'.repeat(8 * 1024 * 1024 + 1); let projections = 0;
  const { read, proxy } = await fixture(t, (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('/malformed')) res.end('PRIVATE_MALFORMED');
    else if (req.url.endsWith('/huge')) res.end(JSON.stringify({ text: oversized }));
    else if (req.url.endsWith('/huge-chunked')) { res.writeHead(200); res.write(JSON.stringify({ text: oversized })); res.end(); }
    else res.end('{"PRIVATE":"DATA"}');
  }, { responseProject: async url => { projections++; if (url.pathname.endsWith('/throw')) throw new Error('PRIVATE_REASON'); if (url.pathname.endsWith('/huge-projection')) return { text: oversized }; return undefined; } });
  for (const id of ['throw', 'empty', 'malformed', 'huge', 'huge-chunked', 'huge-projection']) {
    const result = await read('/api/workflow-library/' + id); assert.equal(result.status, 403); assert.equal(result.text.includes('PRIVATE'), false);
  }
  assert.equal(projections, 3); assert.equal(proxy.blockedRequests, 6);
});

test('scope callbacks cannot grant writes, permission API reads or unknown API access; assets still load', async t => {
  const seen = [], projected = [];
  const { read } = await fixture(t, (req, res) => { seen.push(req.url); res.setHeader('Content-Type', 'text/javascript'); res.end('export const ready = true;'); }, {
    requestPolicy: async () => true, responseProject: async url => { projected.push(url); return {}; },
  });
  assert.equal((await read('/assistant-permissions-ui.js')).status, 200);
  assert.equal((await read('/api/assistant-permissions')).status, 403);
  assert.equal((await read('/api/settings', 'PUT')).status, 403);
  assert.equal((await read('/api/anything')).status, 403);
  assert.deepEqual(seen, ['/assistant-permissions-ui.js']); assert.deepEqual(projected, []);
});

test('capture passes trusted callbacks unchanged to its browser session', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'diagnostic-scope-capture-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
  const requestPolicy = async () => true, responseProject = async (_url, value) => value; let options;
  const browser = createAppDiagnosticBrowser({ dataDir, ffmpegPath: false, sessionFactory: async input => {
    options = input; return { async send(method) {
      if (method === 'Runtime.evaluate') return { result: { value: { masked: true } } };
      if (method === 'Page.captureScreenshot') return { data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB34AAAAASUVORK5CYII=' };
      return {};
    }, async close() {} };
  } });
  browser.setOrigin('http://127.0.0.1:4318'); await browser.capture({ route: '/#/workflows/owned', requestPolicy, responseProject });
  assert.equal(options.requestPolicy, requestPolicy); assert.equal(options.responseProject, responseProject);
  await assert.rejects(browser.capture({ requestPolicy: {} }), /权限回调无效/);
  await assert.rejects(createReadOnlyAppProxy('http://127.0.0.1:4318', { responseProject: 'model supplied code' }), /权限回调无效/);
});
