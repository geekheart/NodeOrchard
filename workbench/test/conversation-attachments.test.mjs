import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationAttachments } from '../public/conversation-attachments.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const file = (name = '素材.png') => Object.assign(new Blob(['original image bytes'], { type: 'image/png' }), { name });
const metadata = (workflowId = 'workflow-a', id = 'attachment-a') => ({ id, workflowId, name: '素材.png', path: `/fixture/${workflowId}/inputs/素材.png`, relativePath: 'inputs/素材.png', sha256: 'a'.repeat(64), size: 20, mimeType: 'image/png', url: `/api/workflow-library/${workflowId}/attachments/${id}/content` });
function fixture({ scope = 'workflow' } = {}) {
  const states = new Map(), calls = [], owner = { workflowId: scope === 'supervisor' ? 'supervisor-a' : 'workflow-a', editor: {},
    state(id = this.workflowId) { if (!states.has(id)) states.set(id, { draft: '保留正文', loaded: true }); return states.get(id); },
    currentDocument() { return { id: this.workflowId }; }, updateSendButton() {}, clearRetryTarget() {}, renderNotice() {}, render() {},
  };
  const client = { api: async (path, options) => { calls.push({ path, options }); return { workflows: [{ id: 'workflow-a', title: '流程 A' }] }; },
    binaryRequest: async (path, options) => { calls.push({ path, options }); return new Response(JSON.stringify({ attachment: metadata() })); },
  };
  const attachments = new ConversationAttachments(owner, { scope, client });
  return { owner, states, calls, client, attachments };
}

test('pasted files retain their original bytes and finish in the state where the upload began', async () => {
  const f = fixture(), gate = deferred(), original = f.owner.state(), source = file(); let prevented = false;
  f.client.binaryRequest = async (path, options) => { f.calls.push({ path, options }); return gate.promise; };
  const pasting = f.attachments.paste({ clipboardData: { files: [source] }, preventDefault() { prevented = true; }, stopPropagation() {} });
  f.owner.workflowId = 'workflow-b'; gate.resolve(new Response(JSON.stringify({ attachment: metadata() }))); await pasting;
  assert.equal(prevented, true); assert.equal(f.calls[0].options.body, source); assert.match(f.calls[0].path, /workflow-a\/attachments\?filename=/);
  assert.deepEqual(f.attachments.references(original), [{ id: 'attachment-a', workflowId: 'workflow-a' }]);
  assert.deepEqual(f.attachments.references(f.owner.state()), []); assert.equal(original.draft, '保留正文');
});

test('supervisor attachments wait for an explicit workflow target and never use the topic identity as a folder', async () => {
  const f = fixture({ scope: 'supervisor' }); await f.attachments.addFiles([file()]);
  assert.equal(f.calls.length, 0); assert.equal(f.attachments.entries()[0].status, 'target');
  await f.attachments.loadWorkflows(); await f.attachments.selectWorkflow('workflow-a');
  assert.deepEqual(f.attachments.references(), [{ id: 'attachment-a', workflowId: 'workflow-a' }]);
  assert(f.calls.every(call => !call.path.includes('supervisor-a')));
});

test('ordinary path text stays editable while explicit local file items and native file paths use the reference endpoint', async () => {
  const f = fixture(); let prevented = 0;
  const event = (types, text) => ({ clipboardData: { types, files: [], getData: () => text }, preventDefault() { prevented++; }, stopPropagation() {} });
  assert.equal(await f.attachments.paste(event(['text/plain'], '/fixture/notes.md')), false);
  assert.equal(await f.attachments.paste(event(['text/uri-list'], 'https://example.com/file.png')), false);
  assert.equal(prevented, 0); assert.equal(f.calls.length, 0);
  f.client.api = async (path, options) => { f.calls.push({ path, options }); return { attachment: metadata() }; };
  assert.equal(await f.attachments.paste(event(['text/uri-list'], 'file:///fixture/%E7%B4%A0%E6%9D%90.png')), true);
  assert.equal(f.calls[0].options.body.path, '/fixture/素材.png'); assert.match(f.calls[0].path, /attachments\/reference$/);
  await f.attachments.drop({ dataTransfer: { files: [Object.assign(file(), { path: '/fixture/already-owned.png' })] }, preventDefault() { prevented++; }, stopPropagation() {} });
  assert.equal(f.calls[1].options.body.path, '/fixture/already-owned.png'); assert.equal(prevented, 2);
  assert.equal(await f.attachments.paste(event(['Files', 'text/plain'], '/fixture/explicit-file-item.png')), true);
  assert.equal(f.calls[2].options.body.path, '/fixture/explicit-file-item.png');
});

test('unknown uploads retry with the same identity, block sending until ready, and acknowledgement consumes only the captured draft entries', async () => {
  const f = fixture(), uploads = []; let fail = true;
  f.client.binaryRequest = async (_path, options) => { uploads.push(options); if (fail) throw Error('断线'); return new Response(JSON.stringify({ attachment: metadata() })); };
  await f.attachments.addFiles([file()]); const entry = f.attachments.entries()[0];
  assert.equal(f.attachments.blocked(), true); assert.equal(entry.status, 'error'); assert.equal(f.owner.state().draft, '保留正文');
  fail = false; await f.attachments.retry(entry.key); assert.equal(f.attachments.blocked(), false);
  assert.equal(uploads[0].headers['X-Workflow-Attachment-Id'], uploads[1].headers['X-Workflow-Attachment-Id']);
  const request = { attachments: f.attachments.references() }; f.attachments.trackRequest(f.owner.state(), request);
  await f.attachments.addFiles([file('发送之后的新粘贴.png')]); f.attachments.consumeRequest(f.owner.state(), request);
  assert.equal(f.attachments.entries().length, 1); assert.equal(f.attachments.entries()[0].name, '发送之后的新粘贴.png');
  f.attachments.remove(f.attachments.entries()[0].key); assert.deepEqual(f.attachments.references(), []);
  assert(uploads.every(options => options.method === 'POST')); assert.equal(f.calls.length, 0);
});

test('retrying an upload in progress ignores its older response and removed drafts never reappear', async () => {
  const f = fixture(), first = deferred(), second = deferred(), requests = [];
  f.client.binaryRequest = async (_path, options) => { requests.push(options); return requests.length === 1 ? first.promise : second.promise; };
  const original = f.attachments.addFiles([file()]), entry = f.attachments.entries()[0], retry = f.attachments.retry(entry.key);
  second.resolve(new Response(JSON.stringify({ attachment: metadata('workflow-a', 'confirmed') }))); assert.equal(await retry, true);
  f.attachments.remove(entry.key); first.resolve(new Response(JSON.stringify({ attachment: metadata('workflow-a', 'late') }))); await original;
  assert.deepEqual(f.attachments.references(), []); assert.equal(f.attachments.entries().length, 0);
  assert.equal(requests[0].headers['X-Workflow-Attachment-Id'], requests[1].headers['X-Workflow-Attachment-Id']);
});

test('attachment controls expose file selection, safe image previews, copy path, input binding and draft-only removal', async t => {
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.attributes = {}; this.dataset = {}; this.classList = { add() {}, remove() {}, toggle() {} }; }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = items; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    click() { return this.listeners.click?.(); }
  }
  const doc = Object.getOwnPropertyDescriptor(globalThis, 'document'), clipboard = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: tag => new Element(tag), createElementNS: (_ns, tag) => new Element(tag) } });
  let copied;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async value => { copied = value; } } } });
  t.after(() => { for (const [name, value] of [['document', doc], ['navigator', clipboard]]) value ? Object.defineProperty(globalThis, name, value) : delete globalThis[name]; });
  const all = node => [node, ...node.children.flatMap(all)], f = fixture(), input = new Element('textarea'), dropZone = new Element('form'); let bound;
  f.owner.editor.useAttachmentAsInput = async attachment => { bound = attachment; };
  f.attachments.mount({ input, dropZone }); await f.attachments.addFiles([file()]);
  assert.equal(f.attachments.fileInput.type, 'file'); assert.equal(f.attachments.fileInput.multiple, true);
  assert.equal(f.attachments.addButton.attributes['aria-label'], '添加图片或文件'); assert(input.listeners.paste && dropZone.listeners.drop);
  const nodes = all(f.attachments.host); assert.equal(nodes.find(node => node.tagName === 'img').src, '/api/workflow-library/workflow-a/attachments/attachment-a/content');
  await nodes.find(node => node.textContent === '复制路径').click(); assert.equal(copied, metadata().path);
  await nodes.find(node => node.textContent === '用作输入').click(); assert.equal(bound.id, 'attachment-a');
  nodes.find(node => node.attributes['aria-label'] === '移除素材.png').click(); assert.equal(f.attachments.entries().length, 0);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options.method, 'POST');
  const history = f.attachments.messageView([metadata()]); assert(!all(history).some(node => node.attributes['aria-label']?.startsWith('移除')));
});
