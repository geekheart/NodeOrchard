import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readConfig } from '../src/config.mjs';

// Opt-in only: this script performs real subscription inference and writes a test artifact.
if (process.env.WORKBENCH_RUN_REAL_SMOKE !== '1') {
  console.error('真实测试会使用 ChatGPT 订阅额度。显式设置 WORKBENCH_RUN_REAL_SMOKE=1 后再运行。');
  process.exit(2);
}
const config = readConfig();
const base = process.env.WORKBENCH_URL || `http://127.0.0.1:${config.port}`;
const boot = await (await fetch(`${base}/api/bootstrap`)).json();
const headers = { 'Content-Type': 'application/json', 'X-Workbench-Token': boot.csrfToken };
async function api(path, body) {
  const response = await fetch(`${base}${path}`, body === undefined ? {} : { method: 'POST', headers, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}
const backend = await api('/api/connect', {});
console.log(`Hermes ${backend.hermesVersion}; provider=${backend.provider}; model=${backend.model}; authenticated=${backend.authenticated}`);
if (backend.provider !== 'openai-codex') throw new Error('拒绝测试非订阅路由。');
const session = await api('/api/sessions', { title: '真实架构验收', cwd: backend.cwdDefault });
const token = `WORKBENCH_${randomUUID()}`;
const events = [];
let finish;
const completed = new Promise(resolve => { finish = resolve; });
const abort = new AbortController();
const streamTask = (async () => {
  const response = await fetch(`${base}/api/events`, { signal: abort.signal });
  const reader = response.body.getReader();
  const decoder = new TextDecoder(); let buffer = '';
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
      const data = frame.split('\n').find(line => line.startsWith('data: '));
      if (!data) continue;
      const event = JSON.parse(data.slice(6));
      if (event.sessionId !== session.id) continue;
      events.push(event);
      if (['message.start', 'tool.start', 'tool.complete', 'request.open', 'message.complete'].includes(event.type)) {
        console.log(event.type, event.type === 'message.complete' ? event.payload.status : event.payload.tool_name || event.payload.name || event.payload.method || '');
      }
      if (event.type === 'request.open') console.log('需人工处理：请在验证页处理该请求。');
      if (event.type === 'message.complete') finish(event.payload);
    }
  }
})().catch(error => { if (error.name !== 'AbortError') throw error; });
try {
  await api(`/api/sessions/${session.id}/messages`, {
    text: `这是本地应用架构验收。请使用 terminal 或文件工具，在当前工作目录创建 artifacts/architecture-smoke.txt，内容仅为 ${token}。随后用工具读回文件核对。不联网、不操作其它目录。成功后只回复 ${token}。`,
  });
  const timeout = setTimeout(() => finish({ status: 'timeout', error: '180 秒内未完成，请查看会话。' }), 180000);
  const result = await completed; clearTimeout(timeout);
  if (result.status !== 'complete' || result.error || result.partial) throw new Error(`真实推理未完成：${result.error || result.status}`);
  const artifactPath = join(session.cwd, 'artifacts/architecture-smoke.txt');
  const artifact = (await readFile(artifactPath, 'utf8')).trim();
  if (artifact !== token) throw new Error('文件读回与本次随机标记不一致。');
  if (!events.some(e => e.type === 'tool.complete')) throw new Error('没有收到真实工具完成事件。');
  if (!events.some(e => e.type === 'message.delta')) throw new Error('没有收到文字流事件。');
  const history = await api(`/api/sessions/${session.id}/history`);
  if (!history.messages.some(m => m.role === 'assistant' && m.text?.includes(token))) throw new Error('Hermes 持久历史未包含验收结果。');
  const report = { checkedAt: new Date().toISOString(), mode: 'real-subscription', provider: backend.provider,
    model: backend.model, hermesVersion: backend.hermesVersion, appSessionId: session.id,
    storedSessionId: session.storedSessionId, artifactPath, token, toolCompletions: events.filter(e => e.type === 'tool.complete').length,
    streaming: true, outcome: result.status, historyVerified: true };
  await mkdir(config.dataDir, { recursive: true });
  await writeFile(join(config.dataDir, 'smoke-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  abort.abort(); await streamTask;
}
