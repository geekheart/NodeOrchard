import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

if (process.env.WORKBENCH_RUN_REAL_SMOKE !== '1') {
  throw new Error('Set WORKBENCH_RUN_REAL_SMOKE=1 to run two real Hermes subscription calls.');
}
const base = 'http://127.0.0.1:4318';
const bootstrap = await (await fetch(base + '/api/bootstrap')).json();
const headers = { 'Content-Type': 'application/json', 'X-Workbench-Token': bootstrap.csrfToken };
async function api(path, body) {
  const response = await fetch(base + path, body === undefined ? {} : { method: 'POST', headers, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}
if (bootstrap.sessions.some(session => ['running', 'waiting'].includes(session.status))) throw new Error('Wait until existing tasks finish.');
if (bootstrap.backend.state !== 'ready') await api('/api/connect', {});
const doc = JSON.parse(await readFile(new URL('../examples/humanizer.workflow.json', import.meta.url), 'utf8'));
doc.title = '会议记录 · 润色与待办';
const first = doc.nodes.find(node => node.type === 'skill');
const output = doc.nodes.find(node => node.type === 'output');
const second = structuredClone(first);
second.id = 'node-' + randomUUID(); second.title = '提取待办'; second.x = 680;
second.config.skillRef = 'meeting-action-items'; output.x = 1000;
for (const node of [first, second]) node.config.version = (await api('/api/skills/' + node.config.skillRef)).revision;
doc.nodes.splice(doc.nodes.indexOf(output), 0, second);
const edge = doc.edges.find(item => item.sourceNode === first.id);
edge.targetNode = second.id;
doc.edges.push({ id: 'edge-' + randomUUID(), sourceNode: second.id, sourcePort: 'out', targetNode: output.id, targetPort: 'in' });
doc.viewport = { x: 12, y: 18, zoom: 0.5 };
await writeFile(new URL('../examples/multi-skill.workflow.json', import.meta.url), JSON.stringify(doc, null, 2) + '\n');
const input = '请润色以下会议记录，保留全部事实和处理范围。松果计划会议记录，2026年10月24日：张宁负责在11月2日前提交工作台联调报告；李越负责在11月5日前核对导出功能。处理范围：仅根据本段文字整理纪要和待办清单，不查询外部记录，不创建工单，不发送消息，不联网，不写文件。';
let run = await api('/api/workflow-runs', { document: doc, input });
console.log(JSON.stringify({ runId: run.id, status: run.status }));
let previous = '';
const deadline = Date.now() + 8 * 60 * 1000;
while (!['complete', 'error', 'interrupted', 'unknown'].includes(run.status)) {
  if (Date.now() > deadline) throw new Error('Smoke deadline reached; inspect the existing run before retrying.');
  await new Promise(resolve => setTimeout(resolve, 1500));
  run = await api('/api/workflow-runs/' + run.id);
  const progress = JSON.stringify({ status: run.status, nodes: run.nodeOrder.map(id => ({ title: doc.nodes.find(node => node.id === id).title, status: run.nodes[id].status })) });
  if (progress !== previous) { console.log(progress); previous = progress; }
  if (run.status === 'waiting') console.log('Open the linked task to handle its request.');
}
await mkdir(new URL('../.local/', import.meta.url), { recursive: true });
const reportURL = new URL('../.local/workflow-chain-smoke-report.json', import.meta.url);
await writeFile(reportURL, JSON.stringify({ run, checkedAt: new Date().toISOString() }, null, 2));
assert.equal(run.status, 'complete', run.error);
assert.deepEqual(run.nodes[second.id].input, run.nodes[first.id].output);
assert.deepEqual(run.output, run.nodes[second.id].output);
assert(run.nodes[first.id].completedAt <= run.nodes[second.id].startedAt);
assert.notEqual(run.nodes[first.id].sessionId, run.nodes[second.id].sessionId);
const histories = [];
for (const node of [first, second]) {
  assert.equal(run.nodes[node.id].status, 'complete');
  assert.equal(run.nodes[node.id].error, '');
  const history = await api('/api/sessions/' + run.nodes[node.id].sessionId + '/history');
  const final = history.messages.filter(message => message.role === 'assistant' && typeof message.text === 'string').at(-1);
  assert.equal(final?.text, run.nodes[node.id].outputText);
  histories.push({ nodeId: node.id, sessionId: run.nodes[node.id].sessionId, authoritativeOutputMatches: true });
}
await writeFile(reportURL, JSON.stringify({ run, checks: { exactHandoff: true, serialOrder: true, separateSessions: true, allNodesComplete: run.nodeOrder.every(id => run.nodes[id].status === 'complete'), histories }, checkedAt: new Date().toISOString() }, null, 2));
console.log(JSON.stringify({ runId: run.id, verified: true, output: run.output }));
