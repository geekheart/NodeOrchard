import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowConversationUI } from '../public/workflow-conversation-ui.js';
import { ApplicationConversationUI } from '../public/application-conversation-ui.js';
import { ConversationAttachments } from '../public/conversation-attachments.js';
import { createDocument } from '../shared/workflow/workflow-model.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const file = name => Object.assign(new Blob(['bytes'], { type: 'image/png' }), { name });
const metadata = (workflowId, id = 'attachment-a') => ({ id, workflowId, name: '素材.png', path: '/fixture/inputs/素材.png', mimeType: 'image/png' });
const snapshot = id => ({ conversation: { workflowId: id, revision: 1, turns: [] }, pending: [] });
function fixture({ supervisor = false } = {}) {
  const doc = createDocument(), ui = Object.create(supervisor ? ApplicationConversationUI.prototype : WorkflowConversationUI.prototype), requests = [];
  if (supervisor) doc.id = 'supervisor-a';
  Object.assign(ui, { editor: { doc, selection: new Set(), libraryReadOnly: false }, workflowId: doc.id, states: new Map(), input: { value: '', focus() {} },
    messages: { scrollTop: 0, scrollHeight: 10 }, render() {}, renderNotice() {}, renderContext() {}, toggle() {}, schedulePoll() {}, updateSendButton() {},
    api: async (_path, options) => { requests.push(options.body); return snapshot(doc.id); },
  });
  ui.state().loaded = true;
  const client = { binaryRequest: async () => new Response(JSON.stringify({ attachment: metadata(supervisor ? 'workflow-owned' : doc.id) })) };
  ui.fileAttachments = new ConversationAttachments(ui, { scope: supervisor ? 'supervisor' : 'workflow', client });
  return { ui, doc, requests, client };
}

test('attachment-only messages wait for ready files and send bounded references with the shared default text', async () => {
  const { ui, doc, requests, client } = fixture(), gate = deferred();
  client.binaryRequest = async () => gate.promise; const uploading = ui.fileAttachments.addFiles([file('素材.png')]);
  ui.state().draft = '分析素材'; await ui.send(); assert.equal(requests.length, 0); assert.equal(ui.state().draft, '分析素材');
  gate.resolve(new Response(JSON.stringify({ attachment: metadata(doc.id) }))); await uploading;
  ui.state().draft = ''; await ui.send();
  assert.equal(requests.length, 1); assert.equal(requests[0].text, '请查看这些素材。');
  assert.deepEqual(requests[0].attachments, [{ id: 'attachment-a', workflowId: doc.id }]); assert.deepEqual(ui.fileAttachments.references(), []);
});

test('loading a failed message restores its saved attachments and sends references rather than filesystem metadata', async () => {
  const { ui, doc, requests } = fixture(), failed = { id: 'failed-a', status: 'error', user: { text: '看看这张图', context: {}, attachments: [metadata(doc.id)] }, assistant: {} };
  ui.state().conversation.turns = [failed]; ui.beginRetry(failed); await ui.send();
  assert.equal(requests[0].text, '看看这张图'); assert.equal(requests[0].retryOfTurnId, 'failed-a');
  assert.deepEqual(requests[0].attachments, [{ id: 'attachment-a', workflowId: doc.id }]);
});

test('ready attachment-only drafts enable Send while unfinished files keep the button disabled', () => {
  const { ui, doc } = fixture(); ui.sendButton = {}; ui.updateShortcutHints = () => {};
  ui.fileAttachments.restore([metadata(doc.id)]); WorkflowConversationUI.prototype.updateSendButton.call(ui); assert.equal(ui.sendButton.disabled, false);
  ui.fileAttachments.entries().push({ key: 'unfinished', status: 'uploading' }); WorkflowConversationUI.prototype.updateSendButton.call(ui); assert.equal(ui.sendButton.disabled, true);
});

test('messages containing attachments keep exact run and resolution wording on the AI classification path', async () => {
  const { ui, doc, requests } = fixture(); let runs = 0;
  ui.startRun = async () => { runs++; return true; };
  for (const text of ['运行', '这个问题解决了']) {
    ui.fileAttachments.restore([metadata(doc.id)]); ui.state().draft = text;
    ui.issueReplyTargetFor = () => 'must-not-select-resolution-shortcut'; await ui.send();
  }
  assert.equal(runs, 0); assert.equal(requests.length, 2);
  assert(requests.every(request => request.intent === 'auto' && request.attachments.length === 1 && request.replyToTurnId === undefined));
});

test('an uncertain send retries the original attachment references while preserving text and files pasted afterwards', async () => {
  const { ui, doc, requests } = fixture(); ui.state().draft = '原消息'; ui.fileAttachments.restore([metadata(doc.id)]);
  ui.api = async (_path, options) => { requests.push(structuredClone(options.body)); if (requests.length === 1) throw Error('断线'); return snapshot(doc.id); };
  await ui.send(); const retry = ui.state().retry; ui.state().draft = '发送后的新草稿';
  await ui.fileAttachments.addFiles([file('新粘贴.png')]); await ui.send(retry);
  assert.equal(requests[0].clientMessageId, requests[1].clientMessageId); assert.deepEqual(requests[0].attachments, requests[1].attachments);
  assert.equal(ui.state().draft, '发送后的新草稿'); assert.equal(ui.fileAttachments.entries().length, 1); assert.equal(ui.fileAttachments.entries()[0].name, '新粘贴.png');
});

test('supervisor messages refer to the selected workflow materials while retaining a separate topic identity', async () => {
  const { ui, requests } = fixture({ supervisor: true }); ui.fileAttachments.restore([metadata('workflow-owned')]);
  await ui.send(); assert.equal(requests[0].document.id, 'supervisor-a');
  assert.deepEqual(requests[0].attachments, [{ id: 'attachment-a', workflowId: 'workflow-owned' }]);
});

test('a historical candidate retry keeps unrelated composer attachments even when both refer to the same saved file', async () => {
  const { ui, doc, requests } = fixture(); ui.state().draft = '另一个问题'; ui.fileAttachments.restore([metadata(doc.id)]);
  const attachments = ui.fileAttachments.references();
  await ui.send({ text: '原候选修改意见', intent: 'auto', context: {}, revisionRequest: { runId: 'run-old' }, attachments, clientMessageId: 'candidate-retry' });
  assert.deepEqual(requests[0].attachments, attachments); assert.equal(ui.state().draft, '另一个问题'); assert.deepEqual(ui.fileAttachments.references(), attachments);
});
