import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppDiagnosticClient } from '../public/app-diagnostic-client.js';

test('page evidence records the failure and target without typed input, URL secrets or request bodies', () => {
  const window = new EventTarget(), document = new EventTarget(); window.location = { hash: '#/workflows/example?token=PRIVATE_QUERY' }; window.innerWidth = 1440; window.innerHeight = 960;
  const client = createAppDiagnosticClient({ window, document, getState: () => ({ page: 'workflows' }) });
  const change = new Event('change'); Object.defineProperty(change, 'target', { value: { value: 'PRIVATE_INPUT', closest: () => ({ tagName: 'INPUT', id: 'setting', value: 'PRIVATE_INPUT' }) } }); document.dispatchEvent(change);
  client.recordRequest('/api/run?token=PRIVATE_REQUEST', 500, 'api_key=sk-abcdefghijklmnop');
  const snapshot = client.snapshot(), serialized = JSON.stringify(snapshot);
  assert.equal(snapshot.route, '#/workflows/example'); assert.ok(snapshot.events.some(item => item.kind === 'request-error' && item.status === 500));
  for (const secret of ['PRIVATE_QUERY', 'PRIVATE_INPUT', 'PRIVATE_REQUEST', 'sk-abcdefghijklmnop']) assert.equal(serialized.includes(secret), false);
  client.close();
});

test('page trace stays bounded across many failures and disconnects listeners on close', () => {
  const window = new EventTarget(), document = new EventTarget(); window.location = { hash: '#/board' };
  const client = createAppDiagnosticClient({ window, document });
  for (let index = 0; index < 1000; index++) client.recordRequest('/api/run', 500, 'x'.repeat(2000));
  assert.ok(Buffer.byteLength(JSON.stringify(client.snapshot())) < 32768); client.close(); assert.equal(client.snapshot().events.length, 0);
});

test('page failures retain a bounded server request identity without accepting headers or arbitrary correlation text', () => {
  const window = new EventTarget(), document = new EventTarget(); window.location = { hash: '#/statistics' };
  const client = createAppDiagnosticClient({ window, document }), requestId = 'be9aac46-45f3-441c-8a6e-5bcf573d7c3e';
  client.recordRequest('/api/statistics?token=PRIVATE_QUERY', 500, '读取失败', requestId);
  client.recordRequest('/api/statistics', 500, '读取失败', 'Bearer PRIVATE_HEADER');
  const rows = client.snapshot().events.filter(row => row.kind === 'request-error');
  assert.equal(rows[0].requestId, requestId); assert.equal(rows[1].requestId, undefined);
  assert.equal(JSON.stringify(rows).includes('PRIVATE_'), false); client.close();
});
