import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Application } from '../src/application.mjs';
import { createWorkbenchServer } from '../src/server.mjs';
import { readConfig } from '../src/config.mjs';
import { createDocument } from '../shared/workflow/workflow-model.mjs';

class Offline extends EventEmitter {
  constructor() { super(); this.state = 'stopped'; this.serverRequests = new Map(); this.calls = []; }
  async request(name) { this.calls.push(name); throw Error('Attachment HTTP tests never use Hermes'); }
  async stop() {}
}
async function fixture(t) {
  const directory = await mkdtemp('/private/tmp/workflow-attachments-http-'), adapter = new Offline();
  const config = { ...readConfig({ WORKBENCH_DATA_DIR: join(directory, 'data'), WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace') }), port: 0 };
  const app = new Application(config, adapter); await app.workflowFoldersReady;
  const bridge = createWorkbenchServer(config, app), origin = await bridge.listen();
  t.after(async () => { await bridge.close(); assert.deepEqual(adapter.calls, []); await rm(directory, { recursive: true, force: true }); });
  const bootstrap = await (await fetch(origin + '/api/bootstrap')).json(), document = createDocument({ schemaVersion: 2 });
  return { app, origin, document, token: bootstrap.csrfToken, base: origin + '/api/workflow-library/' + document.id + '/attachments' };
}

test('attachment HTTP accepts only same-origin csrf binary uploads and serves non-raster files as inert verified downloads', async t => {
  const f = await fixture(t), operationId = randomUUID(), body = Buffer.from('<script>window.EXECUTED=true</script>');
  const upload = headers => fetch(f.base + '?filename=example.html', { method: 'POST', headers, body });
  assert.equal((await upload({ 'Content-Type': 'application/octet-stream', 'X-Workflow-Attachment-Id': operationId })).status, 403);
  assert.equal((await upload({ 'Content-Type': 'application/octet-stream', 'X-Workbench-Token': f.token, 'X-Workflow-Attachment-Id': operationId, Origin: 'https://evil.example' })).status, 403);
  assert.equal((await upload({ 'Content-Type': 'text/html', 'X-Workbench-Token': f.token, 'X-Workflow-Attachment-Id': operationId })).status, 415);
  const headers = { 'Content-Type': 'application/octet-stream', 'X-Workbench-Token': f.token, 'X-Workflow-Attachment-Id': operationId };
  const response = await upload(headers); assert.equal(response.status, 201);
  const { attachment } = await response.json(); assert.equal(attachment.workflowId, f.document.id);
  assert.equal(f.app.workflowLibrary.list().length, 0);
  assert.deepEqual((await (await fetch(f.base)).json()).attachments, [attachment]);
  assert.equal((await upload(headers)).status, 201);
  const content = await fetch(f.origin + attachment.url);
  assert.equal(content.status, 200); assert.match(content.headers.get('content-disposition'), /^attachment/);
  assert.equal(content.headers.get('content-type'), 'application/octet-stream'); assert.match(content.headers.get('content-security-policy'), /sandbox/);
  assert.equal(await content.text(), body.toString());
  await writeFile(attachment.path, 'changed'); assert.equal((await fetch(f.origin + attachment.url)).status, 409);
});

test('attachment references are csrf protected, scoped, strict and blocked after trash', async t => {
  const f = await fixture(t), source = join(f.app.config.workspaceRoot, 'user-input.txt'); await writeFile(source, 'reference');
  const post = (body, csrf = true) => fetch(f.base + '/reference', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-Workbench-Token': f.token } : {}) }, body: JSON.stringify(body) });
  assert.equal((await post({ path: source, operationId: randomUUID() }, false)).status, 403);
  assert.equal((await post({ path: source, operationId: randomUUID(), workflowId: 'foreign' })).status, 400);
  const stored = await post({ path: source, operationId: randomUUID() }); assert.equal(stored.status, 201);
  const { attachment } = await stored.json(); assert.notEqual(attachment.path, source);
  assert.equal((await fetch(f.base + '?path=' + encodeURIComponent(source))).status, 400);
  const foreign = createDocument({ schemaVersion: 2 });
  assert.equal((await fetch(f.origin + '/api/workflow-library/' + foreign.id + '/attachments/' + attachment.id + '/content')).status, 404);
  f.app.workflowLibrary.save({ document: f.document, expectedRevision: 0 }); f.app.workflowLibrary.transition(f.document.id, 'trash', { expectedRevision: 1 });
  assert.equal((await post({ path: source, operationId: randomUUID() })).status, 409);
});

test('raw uploads enforce the HTTP size limit, serve verified raster bytes inline and survive a real portable package round trip', async t => {
  const f = await fixture(t), headers = { 'Content-Type': 'application/octet-stream', 'X-Workbench-Token': f.token };
  const oversized = await fetch(f.base + '?filename=too-big.bin', { method: 'POST', headers: { ...headers, 'X-Workflow-Attachment-Id': randomUUID() }, body: Buffer.alloc(32 * 1024 * 1024 + 1) });
  assert.equal(oversized.status, 413); assert.deepEqual((await (await fetch(f.base)).json()).attachments, []);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV3sAAAAASUVORK5CYII=', 'base64');
  const response = await fetch(f.base + '?filename=pasted.png', { method: 'POST', headers: { ...headers, 'X-Workflow-Attachment-Id': randomUUID() }, body: png });
  assert.equal(response.status, 201); const { attachment } = await response.json();
  const image = await fetch(f.origin + attachment.url); assert.equal(image.headers.get('content-type'), 'image/png'); assert.match(image.headers.get('content-disposition'), /^inline/);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  f.app.workflowLibrary.save({ document: f.document, expectedRevision: 0 });
  const exported = await f.app.workflowPackages.export(f.document.id, { expectedRevision: 1 });
  const imported = await f.app.workflowPackages.import(exported.data, { filename: exported.filename, operationId: randomUUID() });
  const metadata = f.app.workflowAttachments.list(imported.workflow.id)[0]; assert.notEqual(metadata.id, attachment.id);
  const resolved = await f.app.workflowAttachments.resolve(imported.workflow.id, [{ id: attachment.id, workflowId: imported.workflow.id }]);
  assert.deepEqual(resolved, [metadata]); assert.deepEqual((await f.app.workflowAttachments.content(imported.workflow.id, metadata.id)).data, png);
  assert.equal((await fetch(f.origin + '/conversation-attachments.js')).status, 200);
});
