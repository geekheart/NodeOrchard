import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, createNode } from '../shared/workflow/workflow-model.mjs';
import { planWorkflowConversation } from '../src/workflows/workflow-conversation-planner.mjs';

test('an edit receives complete existing business code including the tail that needs correction', async () => {
  const code = Array.from({ length: 120 }, (_, index) => `# Preserve existing business step ${index}: validation and formatting stay unchanged.`).join('\n')
    + "\noutput_dir = context.outputDirectory\nreturn {'path': output_dir}\n";
  const doc = createDocument({ title: '修改现有业务代码', schemaVersion: 2 });
  doc.nodes = [createNode('tool', {}, { id: 'render', config: { executionMode: 'code', language: 'python', code } }),
    createNode('human', {}, { id: 'review', config: { prompt: '检查结果。'.repeat(1000) } })];
  const before = structuredClone(doc), calls = [];
  const app = { learningModel: { generate: async prompt => { calls.push(prompt); return JSON.stringify({ text: '等待预览。', operations: [] }); } } };

  await planWorkflowConversation(app, { document: doc, text: "只把 Python 中 context.outputDirectory 改为 context['outputDirectory']，保留其它代码。" });

  assert.equal(calls.length, 1);
  const source = JSON.parse(calls[0].split('USER_SOURCE_JSON=')[1]);
  const projected = source.workflow.nodes.find(node => node.id === 'render');
  assert.equal(projected.config.code.length, code.length, 'the complete editable source must reach the model');
  assert.equal(projected.config.code, code);
  assert.equal(source.workflow.nodes.find(node => node.id === 'review').config.prompt.length, 3000, 'ordinary prompt fields remain bounded');
  assert.deepEqual(doc, before);
});

test('an oversized complete code context is explicitly rejected before a model call', async () => {
  const doc = createDocument({ title: '完整代码超出一次编辑上限', schemaVersion: 2 });
  doc.nodes = Array.from({ length: 3 }, (_, index) => createNode('tool', {}, { id: 'step-' + index,
    config: { executionMode: 'code', language: 'javascript', code: '// preserved business source\n' + 'x'.repeat(70000) } }));
  const before = structuredClone(doc);
  let calls = 0;
  const app = { learningModel: { generate: async () => { calls++; return JSON.stringify({ text: '候选', operations: [] }); } } };

  await assert.rejects(planWorkflowConversation(app, { document: doc, text: '保留原业务代码，只修复输出目录访问。' }),
    error => error.httpStatus === 413 && /工作流过大，无法一次提交/.test(error.message));

  assert.equal(calls, 0, 'an incomplete code projection must never be submitted');
  assert.deepEqual(doc, before);
});
