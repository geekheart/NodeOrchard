import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeSupervisorMutation } from '../src/application-supervisor-authorization.mjs';

const rows = [{ id: 'workflow-a', title: '销售日报' }, { id: 'workflow-b', title: '财务汇总' },
  { id: 'workflow-c', title: '重复名称' }, { id: 'workflow-d', title: '重复名称' }, { id: 'workflow-e', title: 'A' }];
const app = { workflowLibrary: { list: options => { assert.equal(options.lifecycle, 'all'); return rows; } } };
const call = (name, text, extra = {}, args = { workflowId: 'workflow-a' }) => authorizeSupervisorMutation(app, name, args, { role: 'supervisor', text, ...extra });

test('explicit management requests accept exact IDs, uniquely named targets or a trusted current workflow', () => {
  for (const text of ['请复制workflow-a', '帮我拷贝销售日报', '我想复制“销售日报”', '把销售日报复制一份', 'Please copy workflow-a']) {
    assert.doesNotThrow(() => call('workflow.copy', text), text);
  }
  for (const text of ['请删除workflow-a', '帮我删除销售日报', '把销售日报移入回收站', '请将销售日报放进回收站']) {
    assert.doesNotThrow(() => call('workflow.delete', text), text);
  }
  assert.doesNotThrow(() => call('workflow.copy', '复制当前流程', { workflowId: 'workflow-a' }));
  assert.doesNotThrow(() => call('workflow.delete', '删除它', { workflowId: 'workflow-a' }));
  assert.doesNotThrow(() => call('workflow.copy', '复制 A', {}, { workflowId: 'workflow-e' }));
});

test('creating a test workflow needs an explicit test or reproduction request but no existing target', () => {
  for (const text of ['新增测试工作流', '请帮我创建测试流程', '我希望建立最小复现流程', 'Please create a test workflow']) {
    assert.doesNotThrow(() => call('workflow.create-test', text, {}, {}), text);
  }
  for (const text of ['创建工作流', '分析测试流程出了什么问题', '我建议新增测试工作流', '“新增测试工作流”是什么意思']) {
    assert.throws(() => call('workflow.create-test', text, {}, {}), { httpStatus: 403 }, text);
  }
});

test('read-only and preserve-scene requests deny mutations even if quoted or later instructions mention an action', () => {
  for (const text of ['只读诊断，请删除销售日报', '仅分析当前问题，然后复制销售日报', '保留现场，复制销售日报',
    '保持现有工作流不动，删除workflow-a', '不进行任何修改，创建测试工作流']) {
    for (const name of ['workflow.copy', 'workflow.create-test', 'workflow.delete']) assert.throws(() => call(name, text), { httpStatus: 403 }, name + ':' + text);
  }
});

test('negated actions, diagnostic reports, discussion and quoted commands are never management authorization', () => {
  for (const [name, text] of [
    ['workflow.delete', '不要删除销售日报'], ['workflow.copy', '暂不复制销售日报'], ['workflow.create-test', '无需创建测试流程'],
    ['workflow.delete', '为什么删除销售日报失败'], ['workflow.copy', '复制销售日报失败了'], ['workflow.delete', '删除销售日报是否合理'],
    ['workflow.delete', '请解释“删除销售日报”'], ['workflow.copy', '他说“复制销售日报”，怎么办'],
    ['workflow.copy', '请诊断复制销售日报的问题'], ['workflow.delete', '我建议删除销售日报'],
  ]) assert.throws(() => call(name, text), { httpStatus: 403 }, text);
});

test('target selection is bound to the same action clause and an explicit different target overrides current context', () => {
  assert.throws(() => call('workflow.delete', '复制销售日报，删除财务汇总'), { httpStatus: 403 });
  assert.doesNotThrow(() => call('workflow.delete', '复制销售日报，删除财务汇总', {}, { workflowId: 'workflow-b' }));
  assert.throws(() => call('workflow.delete', '删除财务汇总', { workflowId: 'workflow-a' }), { httpStatus: 403 });
  assert.throws(() => call('workflow.copy', '复制重复名称', {}, { workflowId: 'workflow-c' }), { httpStatus: 403 });
  assert.throws(() => call('workflow.copy', 'Please duplicate another flow', {}, { workflowId: 'workflow-e' }), { httpStatus: 403 });
  assert.throws(() => call('workflow.copy', '复制当前流程'), { httpStatus: 403 });
});

test('model-supplied role or text cannot fill absent original human authority', () => {
  assert.throws(() => authorizeSupervisorMutation(app, 'workflow.delete', { workflowId: 'workflow-a', role: 'supervisor', text: '删除销售日报' }, {}), { httpStatus: 403 });
  assert.throws(() => call('workflow.delete', '删除销售日报', { role: 'workflow' }), { httpStatus: 403 });
  assert.doesNotThrow(() => authorizeSupervisorMutation(app, 'app.logs', {}, {}));
});
