import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Application } from '../src/application.mjs';
import { readConfig } from '../src/config.mjs';
import { createDocument, createNode } from '../shared/workflow/workflow-model.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=', 'base64');
const sha = data => createHash('sha256').update(data).digest('hex');
const ref = ({ id, workflowId }) => ({ id, workflowId });
const terminal = turn => turn && !['thinking', 'queued'].includes(turn.status);
async function until(read) {
  for (let index = 0; index < 500; index++) { const value = read(); if (value) return value; await delay(2); }
  assert.fail('Attachment conversation fixture did not settle');
}
const source = prompt => JSON.parse(prompt.split('\nSOURCE_JSON=')[1].split('\nTOOL_RESULTS_JSON=')[0]);
const proposalSource = prompt => JSON.parse(prompt.split('\nUSER_SOURCE_JSON=')[1]);
class Offline extends EventEmitter {
  constructor() { super(); this.state = 'stopped'; this.serverRequests = new Map(); this.calls = []; }
  async request(name) { this.calls.push(name); throw new Error('No Hermes or business execution in attachment fixtures'); }
  async stop() {}
}
async function fixture(t) {
  const directory = await mkdtemp('/private/tmp/conversation-attachment-integration-');
  const config = { ...readConfig({ WORKBENCH_DATA_DIR: join(directory, 'data'), WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace') }), workflowRunRoot: join(directory, 'runs') };
  const adapter = new Offline(), app = new Application(config, adapter), f = { directory, config, app, adapter, calls: [], intent: 'discuss' };
  app.captureModelRoute = async () => ({ provider: 'fixture-provider', model: 'fixture-model' }); app.skills = async () => ({ skills: [] });
  const readCapability = app.applicationAssistant.capabilities.read.bind(app.applicationAssistant.capabilities);
  app.applicationAssistant.capabilities.read = (name, ...args) => name === 'runtime.inspect'
    ? { language: 'python', available: false, modules: [], reason: 'Fixture does not probe external runtimes' } : readCapability(name, ...args);
  app.assistantModel.generate = async (prompt, options) => {
    f.calls.push({ prompt, options });
    assert.equal(options.modelRoute.provider, 'fixture-provider');
    if (options.title === '应用对话 · 任务意图分类') {
      await f.classifying?.(); return JSON.stringify({ intent: f.intent });
    }
    await f.answering?.();
    return JSON.stringify(prompt.includes('\nUSER_SOURCE_JSON=')
      ? { text: '仅准备输入素材的草稿候选。', operations: f.operations || [{ op: 'set-title', title: '附件输入草稿' }] }
      : { text: '已读取当前消息允许的素材，尚未运行工作流。' });
  };
  await app.workflowFoldersReady;
  f.documents = ['当前附件流程', '另一个附件流程'].map(title => {
    const document = createDocument({ schemaVersion: 2, title });
    document.nodes = [createNode('input', {}, { id: 'input', config: { outputType: 'text', required: false } })];
    app.workflowLibrary.save({ document, expectedRevision: 0 }); return document;
  });
  f.upload = (name, data, document = f.documents[0]) => app.workflowAttachments.upload(document.id, { name, operationId: randomUUID() }, data);
  f.body = (attachments, extra = {}) => ({ clientMessageId: randomUUID(), text: '请查看这些已选素材', document: f.documents[0], intent: 'auto', attachments: attachments.map(ref), ...extra });
  f.finish = id => until(() => { const turn = app.conversations.get(f.documents[0].id).conversation.turns.find(row => row.id === id); return terminal(turn) && turn; });
  f.send = async body => { const response = await app.conversations.message(f.documents[0].id, body); return f.finish(response.turn.id); };
  t.after(async () => { await app.close(); assert.deepEqual(adapter.calls, []); await rm(directory, { recursive: true, force: true }); });
  return f;
}
function settings(app, change) {
  const current = app.assistantPermissionSettings.get(), request = { expectedRevision: current.revision,
    workflow: { ...current.workflow }, supervisor: { ...current.supervisor } };
  change(request); app.assistantPermissionSettings.save(request);
}

test('workflow attachment refs persist canonical metadata and full folder chat history, including attachment-only messages', async t => {
  const f = await fixture(t), bytes = Buffer.from('需求正文：保留原文件。'), item = await f.upload('需求.md', bytes);
  const turn = await f.send(f.body([item], { text: '' }));
  assert.equal(turn.status, 'complete'); assert.equal(turn.user.text, '请查看这些素材。');
  assert.deepEqual(turn.user.attachments, [item]); assert.equal(turn.user.attachments[0].sha256, sha(bytes));
  const mirror = JSON.parse(await readFile(join(f.app.workflowFolders.directory(f.documents[0].id), 'conversation.json'), 'utf8'));
  assert.equal(mirror.workflowId, f.documents[0].id); assert.deepEqual(mirror.turns[0].user.attachments, [item]);
  assert.equal(mirror.turns[0].assistant.text, turn.assistant.text);
  assert.equal(f.app.conversations.get(f.documents[0].id).conversation.turns.length, 1);
  assert.equal(f.app.workflows.list(f.documents[0].id).length, 0);
  await assert.rejects(f.app.conversations.message(f.documents[0].id, f.body([item], { attachments: [{ ...ref(item), path: '/forged/path', sha256: 'f'.repeat(64) }] })), /引用|格式/);
});

test('AI classification stays first and small while planning receives bounded text, binary metadata and real image options', async t => {
  const f = await fixture(t), text = 'TEXT_PREVIEW_MARKER\n' + '有界资料'.repeat(12000), binary = Buffer.from('BINARY_PRIVATE_MARKER'.repeat(20000));
  const note = await f.upload('说明.txt', Buffer.from(text)), image = await f.upload('参考.png', png), pdf = await f.upload('图纸.pdf', binary);
  const turn = await f.send(f.body([note, image, pdf])); assert.equal(turn.status, 'complete');
  assert.equal(f.calls.length, 2); assert.equal(f.calls[0].options.title, '应用对话 · 任务意图分类');
  assert(f.calls[0].prompt.length < 4000); assert.equal(f.calls[0].options.userImages, undefined);
  assert.equal(f.calls[0].prompt.includes(note.path), false); assert.equal(f.calls[0].prompt.includes('TEXT_PREVIEW_MARKER'), false);
  const planned = f.calls[1], payload = source(planned.prompt), attachments = payload.attachments;
  assert.equal(attachments.length, 3); assert.match(attachments[0].textPreview, /^TEXT_PREVIEW_MARKER/);
  assert(attachments[0].textPreview.length <= 2048); assert.equal(attachments[0].truncated, true);
  assert.equal(attachments[2].contentAvailable, false); assert.equal(attachments[2].textPreview, undefined);
  assert.deepEqual(planned.options.userImages, [image.path]); assert.equal(planned.options.attachmentRoot, f.app.workflowFolders.directory(f.documents[0].id));
  for (const call of f.calls) {
    assert.equal(call.prompt.includes('BINARY_PRIVATE_MARKER'), false); assert.equal(call.prompt.includes(png.toString('base64')), false);
    assert.equal(call.prompt.includes(text), false);
  }
});

test('direct workflow candidates receive validated material paths and native image sources without applying or running', async t => {
  const f = await fixture(t), note = await f.upload('说明.md', Buffer.from('CANDIDATE_SOURCE_MARKER')), image = await f.upload('参考.png', png);
  f.intent = 'workflow'; const before = f.app.workflowLibrary.get(f.documents[0].id);
  const turn = await f.send(f.body([note, image], { text: '把这些素材配置为工作流默认输入，先给候选' }));
  assert.equal(turn.status, 'proposed'); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].options.title, '应用对话 · 任务意图分类');
  const candidate = f.calls[1], payload = proposalSource(candidate.prompt);
  assert.deepEqual(payload.attachments.map(row => row.path), [note.path, image.path]);
  assert.equal(payload.attachments[0].textPreview, 'CANDIDATE_SOURCE_MARKER');
  assert.deepEqual(candidate.options.userImages, [image.path]); assert.equal(candidate.options.attachmentRoot, f.app.workflowFolders.directory(f.documents[0].id));
  assert.deepEqual(f.app.workflowLibrary.get(f.documents[0].id), before); assert.deepEqual(f.app.workflows.list(f.documents[0].id), []);
});

test('independent messages reject foreign refs, denied workspace reads and stale material SHA before any AI or chat write', async t => {
  const f = await fixture(t), own = await f.upload('本流程.txt', Buffer.from('original')), foreign = await f.upload('另一流程.txt', Buffer.from('foreign'), f.documents[1]);
  await assert.rejects(f.app.conversations.message(f.documents[0].id, f.body([foreign])), error => error.httpStatus === 403);
  settings(f.app, request => { request.workflow.workspaceRead = false; });
  await assert.rejects(f.app.conversations.message(f.documents[0].id, f.body([own])), error => error.httpStatus === 403 && /权限|获准/.test(error.message));
  settings(f.app, request => { request.workflow.workspaceRead = true; }); await writeFile(own.path, 'tampered');
  await assert.rejects(f.app.conversations.message(f.documents[0].id, f.body([own])), /哈希|变化|大小/);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.app.conversations.get(f.documents[0].id).conversation.turns, []);
});

test('a material changed after classification cannot reach the planning model', async t => {
  const f = await fixture(t), own = await f.upload('会变更.txt', Buffer.from('before'));
  f.classifying = () => writeFile(own.path, 'after!');
  const turn = await f.send(f.body([own])); assert.equal(turn.status, 'error'); assert.match(turn.assistant.text, /哈希|变化|大小/);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options.title, '应用对话 · 任务意图分类');
  assert.equal(f.app.workflows.list(f.documents[0].id).length, 0);
});

test('supervisor topics bind their explicitly selected workflow and retain separate attachment contexts', async t => {
  const f = await fixture(t), assistant = f.app.applicationAssistant;
  const a = assistant.createConversation({ clientConversationId: randomUUID(), title: '主题 A' }).conversation.id;
  const b = assistant.createConversation({ clientConversationId: randomUUID(), title: '主题 B' }).conversation.id;
  const own = await f.upload('A.txt', Buffer.from('TOPIC_A_MATERIAL')), other = await f.upload('B.txt', Buffer.from('TOPIC_B_MATERIAL'), f.documents[1]);
  const send = async (id, item, workflowId, clientMessageId = randomUUID()) => {
    const response = await assistant.message({ clientMessageId, attachments: [ref(item)], context: { workflowId } }, id);
    return until(() => { const turn = assistant.get(id).conversation.turns.find(row => row.id === response.turn.id); return terminal(turn) && turn; });
  };
  const first = await send(a, own, f.documents[0].id, 'same-client-message'), second = await send(b, other, f.documents[1].id, 'same-client-message');
  assert.equal(first.status, 'complete'); assert.equal(second.status, 'complete');
  assert.equal(first.user.text, '请查看这些素材。'); assert.equal(first.user.context.workflowId, f.documents[0].id);
  assert.deepEqual(first.user.attachments, [own]); assert.deepEqual(second.user.attachments, [other]);
  assert.equal(assistant.get(a).conversation.turns.length, 1); assert.equal(assistant.get(b).conversation.turns.length, 1);
  const planned = f.calls.filter(row => row.options.title !== '应用对话 · 任务意图分类');
  assert.deepEqual(source(planned[0].prompt).attachments.map(row => row.id), [own.id]);
  assert.deepEqual(source(planned[1].prompt).attachments.map(row => row.id), [other.id]);
  assert.equal(planned[0].prompt.includes('TOPIC_B_MATERIAL'), false); assert.equal(planned[1].prompt.includes('TOPIC_A_MATERIAL'), false);
  await assert.rejects(send(a, own, f.documents[1].id), error => error.httpStatus === 403);
  await assert.rejects(assistant.message({ clientMessageId: randomUUID(), attachments: [ref(own)], context: { workflowId: a } }, a), error => error.httpStatus === 403);
  assert.equal(assistant.get(a).conversation.turns.length, 1);
});

test('attachment tools expose actual read-only schemas, enforce scope and return text slices or binary metadata', async t => {
  const f = await fixture(t), assistant = f.app.applicationAssistant, document = f.documents[0];
  const own = await f.upload('可读取.txt', Buffer.from('0123456789')), binary = await f.upload('仅元数据.pdf', Buffer.from('BINARY_CONTENT'));
  const foreign = await f.upload('其他范围.txt', Buffer.from('foreign'), f.documents[1]);
  const permissionScope = await assistant.permissions.bind({ role: 'workflow', workflowId: document.id, document });
  const context = { workflowId: document.id, document, permissionScope, text: '读取本流程素材' };
  const tools = assistant.permissions.tools(assistant.tools(), permissionScope);
  for (const name of ['workflow.attachments', 'workflow.attachment.read']) {
    const descriptor = tools.find(row => row.name === name); assert(descriptor); assert.equal(descriptor.readOnly, true);
    assert.equal(descriptor.inputSchema.additionalProperties, false);
  }
  assert.equal(tools.find(row => row.name === 'workflow.attachment.read').inputSchema.properties.limit.maximum, 8192);
  const listed = await assistant.call('workflow.attachments', {}, context); assert.deepEqual(listed.attachments.map(row => row.id), [own.id, binary.id]);
  const part = await assistant.call('workflow.attachment.read', { id: own.id, offset: 2, limit: 4 }, context);
  assert.equal(part.text, '2345'); assert.equal(part.truncated, true); assert.equal(part.contentAvailable, true);
  const meta = await assistant.call('workflow.attachment.read', { id: binary.id }, context);
  assert.equal(meta.contentAvailable, false); assert.equal(meta.text, undefined); assert.equal(meta.attachment.sha256, binary.sha256);
  await assert.rejects(assistant.call('workflow.attachments', { workflowId: f.documents[1].id }, context), error => error.httpStatus === 403);
  await assert.rejects(assistant.call('workflow.attachment.read', { id: foreign.id }, context), /登记|当前|素材/);
  await assert.rejects(assistant.call('workflow.attachment.read', { id: own.id, path: foreign.path }, context), /字段|参数/);
  await assert.rejects(assistant.call('workflow.attachment.read', { id: own.id, limit: 8193 }, context), /范围|8KB/);
  settings(f.app, request => { request.workflow.workspaceRead = false; });
  const denied = await assistant.permissions.bind({ role: 'workflow', workflowId: document.id, document });
  assert.equal(assistant.permissions.tools(assistant.tools(), denied).some(row => /^workflow\.attachment/.test(row.name)), false);
  await assert.rejects(assistant.call('workflow.attachments', {}, { ...context, permissionScope: denied }), error => error.httpStatus === 403);
  assert.deepEqual(f.calls, []);
});

test('unknown message delivery and explicit safe retries retain exact refs without duplicating turns or model calls', async t => {
  const f = await fixture(t), one = await f.upload('one.txt', Buffer.from('one')), two = await f.upload('two.txt', Buffer.from('two'));
  f.answering = async () => { throw new Error('Fixture model connection lost'); };
  const body = f.body([one]), [first, duplicate] = await Promise.all([
    f.app.conversations.message(f.documents[0].id, body), f.app.conversations.message(f.documents[0].id, structuredClone(body)),
  ]);
  assert.equal(first.turn.id, duplicate.turn.id); const failed = await f.finish(first.turn.id); assert.equal(failed.status, 'error');
  assert.equal(f.calls.length, 2); assert.equal(f.app.conversations.get(f.documents[0].id).conversation.turns.length, 1);
  await assert.rejects(f.app.conversations.message(f.documents[0].id, { ...body, attachments: [ref(two)] }), /相同消息/);
  for (const attachments of [[], [ref(two)]]) await assert.rejects(f.app.conversations.message(f.documents[0].id,
    f.body([one], { text: body.text, retryOfTurnId: failed.id, attachments })), /保留.*素材引用/);
  f.answering = null; const retry = f.body([one], { text: body.text, retryOfTurnId: failed.id });
  const [retried, repeated] = await Promise.all([f.app.conversations.message(f.documents[0].id, retry), f.app.conversations.message(f.documents[0].id, structuredClone(retry))]);
  assert.equal(retried.turn.id, repeated.turn.id); assert.notEqual(retried.turn.id, failed.id);
  const complete = await f.finish(retried.turn.id); assert.equal(complete.status, 'complete'); assert.deepEqual(complete.user.attachments, [one]);
  const readback = await f.app.conversations.message(f.documents[0].id, retry); assert.equal(readback.turn.id, retried.turn.id);
  assert.equal(f.calls.length, 4); assert.equal(f.app.conversations.get(f.documents[0].id).conversation.turns.length, 2);
  assert.deepEqual(f.app.workflows.list(f.documents[0].id), []);
});

test('supervisor duplicate delivery and retry preserve target and refs within their topic identity', async t => {
  const f = await fixture(t), assistant = f.app.applicationAssistant, item = await f.upload('全局主题资料.txt', Buffer.from('topic reference'));
  const id = assistant.createConversation({ clientConversationId: randomUUID(), title: '附件重试主题' }).conversation.id;
  f.answering = async () => { throw new Error('Fixture answer delivery unknown'); };
  const body = { clientMessageId: randomUUID(), text: '只读查看这个文件', context: { workflowId: f.documents[0].id }, attachments: [ref(item)] };
  const [first, repeated] = await Promise.all([assistant.message(body, id), assistant.message(structuredClone(body), id)]);
  assert.equal(first.turn.id, repeated.turn.id);
  const finish = turnId => until(() => { const turn = assistant.get(id).conversation.turns.find(row => row.id === turnId); return terminal(turn) && turn; });
  const failed = await finish(first.turn.id); assert.equal(failed.status, 'error'); assert.equal(f.calls.length, 2);
  await assert.rejects(assistant.message({ ...body, clientMessageId: randomUUID(), attachments: [], retryOfTurnId: failed.id }, id), /保留.*素材引用/);
  f.answering = null;
  const retry = { ...body, clientMessageId: randomUUID(), retryOfTurnId: failed.id };
  const [next, duplicate] = await Promise.all([assistant.message(retry, id), assistant.message(structuredClone(retry), id)]);
  assert.equal(next.turn.id, duplicate.turn.id); const done = await finish(next.turn.id); assert.equal(done.status, 'complete');
  assert.equal(done.user.context.workflowId, f.documents[0].id); assert.deepEqual(done.user.attachments, [item]);
  assert.equal(assistant.get(id).conversation.turns.length, 2); assert.equal(f.calls.length, 4);
});
