import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { StatisticsDashboard } from '../public/statistics-dashboard.js';

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.listeners = new Map(); this.style = {}; this.className = ''; this.textContent = ''; this.value = ''; this.hidden = false; this.disabled = false; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  focus() { this.focused = true; }
  emit(name, event = {}) { return this.listeners.get(name)?.(event); }
}
const flatten = node => [node, ...node.children.flatMap(flatten)];
const contents = node => flatten(node).map(item => item.textContent).join('\n');
const clone = value => structuredClone(value);
const fixtureData = () => {
  const workflow = (id, title, lifecycle, tokens) => ({ id, title, lifecycle, mode: 'execute',
    conversations: { turns: 4, complete: 3, failed: 1, pending: 1, modelCalls: 5, toolCalls: 7, elapsedMs: 30000, lastAt: '2026-10-27T01:00:00Z' },
    execution: { runs: 3, complete: 2, failed: 1, interrupted: 0, unknown: 0, active: 0, successRate: 2 / 3, totalDurationMs: 60000, averageDurationMs: 20000, nodeAttempts: 6, lastAt: '2026-10-27T01:00:00Z' },
    usage: { input: tokens === null ? null : 750, output: tokens === null ? null : 250, total: tokens, calls: 5, measuredRuns: tokens === null ? 0 : 2, unmeasuredRuns: tokens === null ? 3 : 1, partialRuns: 0 },
    context: { used: 2000, max: 8000, percent: 25, estimated: false, source: 'Hermes', capturedAt: '2026-10-27T01:00:00Z', sessionId: 'fixture-session' },
    artifacts: { count: 2, registeredBytes: 1024 }, storage: { recordBytes: 2048 }, models: [{ provider: 'fixture', model: 'model-one' }],
    recentRuns: [{ id: 'run-one', status: 'error', startedAt: '2026-10-27T01:00:00Z', durationMs: 20000 }], recentConversations: [{ id: 'turn-one', status: 'complete', at: '2026-10-27T01:00:00Z', modelCalls: 2, toolCalls: 4, durationMs: 1200 }], daily: [] });
  const first = workflow('workflow-a', '采集 GitHub 排行榜', 'active', 1000), second = workflow('workflow-b', '已回收报告', 'trashed', null), deleted = workflow('workflow-c', '已删除历史', 'deleted', 0);
  second.execution.lastAt = '2026-10-26T01:00:00Z'; deleted.execution.lastAt = '2026-10-25T01:00:00Z';
  return { schemaVersion: 1, generatedAt: '2026-10-27T02:00:00Z', period: { days: 7, timeZone: 'Asia/Shanghai', start: '2026-10-21T00:00:00Z', end: '2026-10-28T00:00:00Z' },
    totals: { workflowCount: 3, conversations: { turns: 12, modelCalls: 15 }, execution: { runs: 9, complete: 6, failed: 3, active: 0, successRate: 2 / 3 }, usage: { input: 750, output: 250, total: 1000, measuredRuns: 2, partialRuns: 1, unmeasuredRuns: 3 }, artifacts: { count: 6, registeredBytes: 3072 }, storage: { recordBytes: 6144 } },
    daily: [{ date: '2026-10-26', execution: { runs: 0, complete: 0, failed: 0 }, usage: { input: null, output: null, total: null } }, { date: '2026-10-27', execution: { runs: 9, complete: 6, failed: 3 }, usage: { input: 750, output: 250, total: 1000 } }],
    workflows: [first, second, deleted], supervisor: { conversationCount: 2, conversations: { turns: 3, pending: 1, modelCalls: 2, toolCalls: 5, elapsedMs: 5000 }, usage: { input: null, output: null, total: null, measuredRuns: 0, partialRuns: 0, unmeasuredRuns: 2 } },
    recentActivity: [{ kind: 'run', id: 'run-one', workflowId: first.id, title: first.title, status: 'error', at: '2026-10-27T01:00:00Z', durationMs: 20000 }] };
};
function fixture(t, options = {}) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: tag => new Element(tag), createElementNS: (_namespace, tag) => new Element(tag) } });
  t.after(() => descriptor ? Object.defineProperty(globalThis, 'document', descriptor) : delete globalThis.document);
  const root = new Element('div'), refreshes = [], ui = new StatisticsDashboard(root, { onRefresh: () => refreshes.push(true), ...options });
  return { root, ui, refreshes };
}

test('dashboard renders real totals, both trend axes, workflow details, and supervisor metrics without mutating source records', t => {
  const f = fixture(t), data = fixtureData(), before = clone(data); f.ui.render(data);
  assert.match(contents(f.ui.readouts), /12/); assert.match(contents(f.ui.readouts), /66\.7%/); assert.match(contents(f.ui.readouts), /6\.0 KB/);
  assert.match(contents(f.ui.trends), /10\/26/); assert.match(contents(f.ui.trends), /10\/27/);
  assert.equal(flatten(f.ui.trends).filter(item => item.tagName === 'svg').length, 2);
  assert.deepEqual(flatten(f.ui.trends).filter(item => item.tagName === 'svg').map(item => item.attributes['aria-label']), ['每日运行结果', '每日 Token 消耗']);
  assert.match(contents(f.ui.inspector), /采集 GitHub 排行榜/); assert.match(contents(f.ui.inspector), /fixture \/ model-one/);
  assert.match(contents(f.ui.inspector), /最近对话 · 1/); assert.match(contents(f.ui.inspector), /模型 2 \/ 工具 4/);
  assert.match(contents(f.ui.bottom), /总控助手/); assert.match(contents(f.ui.bottom), /采集 GitHub 排行榜/);
  assert.doesNotMatch(contents(f.root), /统计口径|不能与累计 Token 等同|未采集 CPU、内存或订阅费用/);
  assert.deepEqual(data, before);
});

test('unknown usage stays unavailable, actual zero remains zero, and partial coverage has an honest denominator', t => {
  const f = fixture(t); f.ui.render(fixtureData());
  assert.match(contents(f.ui.readouts), /已采集 3 \/ 6 · 部分 1/);
  f.ui.select('workflow-b'); assert.match(contents(f.ui.inspector), /累计 Token\n—/); assert.match(contents(f.ui.inspector), /已采集 0 \/ 3/);
  f.ui.select('workflow-c'); assert.match(contents(f.ui.inspector), /累计 Token\n0/);
  const tokens = flatten(f.ui.tableWrap).filter(item => item.className === 'sd-token-cell');
  assert.equal(tokens[1].children[0].textContent, '—'); assert.equal(tokens[2].children[0].textContent, '0');
});

test('unmeasured context never invents a percentage or a capacity and measured snapshots remain distinct from consumption', t => {
  const f = fixture(t), data = fixtureData(); data.workflows[0].context = { used: 2000, max: null, percent: null, source: 'Hermes', capturedAt: data.generatedAt };
  f.ui.render(data);
  assert.match(contents(f.ui.inspector), /2,000 \/ —/); assert.match(contents(f.ui.inspector), /模型容量未上报/);
  assert.equal(flatten(f.ui.inspector).some(item => item.attributes.role === 'meter'), false);
  data.workflows[0].context = null; f.ui.render(data); assert.match(contents(f.ui.inspector), /未采集上下文快照/);
  data.workflows[0].context = { used: 2000, max: 8000, percent: 25, source: 'Hermes', capturedAt: data.generatedAt }; f.ui.render(data);
  const meter = flatten(f.ui.inspector).find(item => item.attributes.role === 'meter'); assert.equal(meter.attributes['aria-valuenow'], '25');
  assert.match(contents(f.ui.inspector), /累计 Token\n1,000/);
});

test('search and lifecycle filters only change the visible comparison and token sorting places missing metrics last', t => {
  const f = fixture(t); f.ui.render(fixtureData());
  f.ui.search.value = 'model-one'; f.ui.search.emit('input'); assert.equal(f.ui.filteredRows().length, 3);
  f.ui.search.value = '已回收'; f.ui.search.emit('input'); assert.deepEqual(f.ui.filteredRows().map(row => row.id), ['workflow-b']);
  f.ui.search.value = ''; f.ui.search.emit('input'); f.ui.lifecycle.value = 'deleted'; f.ui.lifecycle.emit('change'); assert.deepEqual(f.ui.filteredRows().map(row => row.id), ['workflow-c']);
  f.ui.lifecycle.value = 'all'; f.ui.lifecycle.emit('change'); f.ui.sortInput.value = 'tokens'; f.ui.sortInput.emit('change');
  assert.deepEqual(f.ui.filteredRows().map(row => row.id), ['workflow-a', 'workflow-c', 'workflow-b']);
});

test('keyboard workflow selection works without opening a workflow and only a named link opens an active object', t => {
  const f = fixture(t); f.ui.render(fixtureData()); let prevented = false;
  f.ui.rowButtons.get('workflow-a').emit('keydown', { key: 'ArrowDown', preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(f.ui.selectedWorkflow, 'workflow-b'); assert.equal(f.ui.rowButtons.get('workflow-b').focused, true);
  const link = flatten(f.ui.inspector).find(item => item.tagName === 'a'); assert.equal(link.href, '#/workflows/workflow-b');
  f.ui.rowButtons.get('workflow-b').emit('keydown', { key: 'End', preventDefault() {} }); assert.equal(f.ui.selectedWorkflow, 'workflow-c');
  assert.equal(flatten(f.ui.inspector).some(item => item.tagName === 'a'), false);
});

test('period refresh keeps the selected workflow, search, filters, and sorting while a removed selection falls back safely', t => {
  const f = fixture(t), data = fixtureData(); f.ui.render(data); f.ui.select('workflow-b');
  f.ui.search.value = '报告'; f.ui.search.emit('input'); f.ui.sortInput.value = 'tokens'; f.ui.sortInput.emit('change');
  f.ui.render(null, { days: 30, loading: true });
  assert.equal(f.ui.selectedWorkflow, 'workflow-b'); assert.equal(f.ui.data, data);
  f.ui.render(null, { days: 30, error: '新周期读取失败' });
  assert.equal(f.ui.selectedWorkflow, 'workflow-b'); assert.equal(f.ui.data, data);
  const month = clone(data); month.period.days = 30; f.ui.render(month, { days: 30, loading: true });
  assert.equal(f.ui.selectedWorkflow, 'workflow-b'); assert.equal(f.ui.query, '报告'); assert.equal(f.ui.sort, 'tokens'); assert.equal(f.ui.refresh.disabled, true); assert.equal(f.root.attributes['aria-busy'], 'true');
  assert.match(f.ui.updated.textContent, /30 天/); f.ui.render(month, { days: 30 });
  assert.equal(f.ui.refresh.disabled, false); month.workflows = month.workflows.filter(row => row.id !== 'workflow-b'); f.ui.render(month, { days: 30 }); assert.equal(f.ui.selectedWorkflow, 'workflow-a');
});

test('the application renderer preserves selection through an uncached period before its pending request begins', async t => {
  const f = fixture(t), data = fixtureData(); f.ui.render(data); f.ui.select('workflow-b');
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const renderSource = source.slice(source.indexOf('function renderStatistics()'), source.indexOf('function invalidateStatistics()'));
  const state = { stats: new Map(), statsPending: new Set() }, picker = { value: '30' };
  const renderFunction = new Function('$', 'state', 'statisticsDashboard', 'statisticsHistory', renderSource + '\nrenderStatistics();');
  const render = () => renderFunction(() => picker, state, f.ui, { loading: false, status: '', error: false });
  render();
  assert.equal(f.ui.selectedWorkflow, 'workflow-b'); assert.equal(f.ui.data, data);
  state.statsPending.add('30'); render();
  assert.equal(f.ui.selectedWorkflow, 'workflow-b'); assert.equal(f.ui.refresh.disabled, true);
  const monthly = clone(data); monthly.period.days = 30; state.stats.set('30', { dashboard: monthly }); state.statsPending.clear();
  render();
  assert.equal(f.ui.selectedWorkflow, 'workflow-b'); assert.match(f.ui.updated.textContent, /30 天/);
});

test('empty statistics and absent token telemetry never generate synthetic chart marks', t => {
  const f = fixture(t), data = fixtureData(); data.workflows = []; data.daily = [{ date: '2026-10-27', execution: { runs: 0, complete: 0, failed: 0 }, usage: { input: null, output: null, total: null } }];
  f.ui.render(data); assert.match(contents(f.ui.tableWrap), /当前范围没有工作流记录/); assert.match(contents(f.ui.inspector), /选择工作流查看明细/);
  assert.match(contents(f.ui.trends), /当前范围未采集 Token 数据/); assert.equal(flatten(f.ui.trends).filter(item => item.tagName === 'rect').length, 0);
});

test('a known total without input/output breakdown is drawn as unclassified usage rather than fabricated splits', t => {
  const f = fixture(t), data = fixtureData(); data.daily = [{ date: '2026-10-27', execution: { runs: 0, complete: 0, failed: 0 }, usage: { input: null, output: null, total: 1000 } }]; f.ui.render(data);
  const bars = flatten(f.ui.trends).filter(item => item.tagName === 'rect'); assert.equal(bars.length, 1); assert.equal(bars[0].attributes.class, 'sd-bar other');
});

test('refresh errors keep existing data reviewable and the retry action only invokes the caller', t => {
  const f = fixture(t); f.ui.render(fixtureData()); f.ui.select('workflow-b'); f.ui.render(undefined, { error: '连接中断' });
  assert.equal(f.ui.importHistory.hidden, true);
  assert.equal(f.ui.errorBox.hidden, false); assert.match(f.ui.errorBox.textContent, /连接中断/); assert.equal(f.ui.selectedWorkflow, 'workflow-b');
  f.ui.refresh.emit('click'); assert.deepEqual(f.refreshes, [true]); assert.match(contents(f.ui.tableWrap), /采集 GitHub/);
});

test('history import is optional, invokes only its callback, and independently fences duplicate clicks while refresh continues', t => {
  const imports = [], f = fixture(t, { onImportHistory: () => imports.push(true) }); f.ui.render(fixtureData(), { loading: true });
  assert.equal(f.ui.importHistory.hidden, false); assert.equal(f.ui.importHistory.disabled, false); assert.equal(f.ui.refresh.disabled, true);
  f.ui.importHistory.emit('click'); f.ui.importHistory.emit('click');
  assert.deepEqual(imports, [true]); assert.equal(f.ui.importHistory.disabled, true); assert.equal(f.ui.importHistory.textContent, '正在补齐…');
  f.ui.render(undefined, { historyLoading: true, loading: false }); assert.equal(f.ui.importHistory.disabled, true); assert.equal(f.ui.refresh.disabled, false);
  f.ui.render(undefined, { historyStatus: '已补齐 2 条历史记录' });
  assert.equal(f.ui.importHistory.disabled, false); assert.equal(f.ui.historyResult.hidden, false); assert.equal(f.ui.historyResult.attributes.role, 'status'); assert.match(f.ui.historyResult.textContent, /2 条/);
  assert.equal(f.ui.selectedWorkflow, 'workflow-a'); assert.equal(f.ui.data.workflows.length, 3);
});

test('history import failure reports a short alert without replacing existing statistics or changing selection', t => {
  const f = fixture(t, { onImportHistory: () => {} }); f.ui.render(fixtureData()); f.ui.select('workflow-b');
  f.ui.render(undefined, { historyStatus: { message: '历史读取失败', error: true } });
  assert.equal(f.ui.historyResult.attributes.role, 'alert'); assert.equal(f.ui.selectedWorkflow, 'workflow-b'); assert.match(contents(f.ui.tableWrap), /采集 GitHub/);
  f.ui.render(undefined, { historyStatus: '补齐失败', historyError: true }); assert.equal(f.ui.historyResult.attributes.role, 'alert');
});

test('historical request input never becomes current context occupancy, a percentage, or a fabricated sampling timestamp', t => {
  const f = fixture(t), data = fixtureData();
  data.workflows[0].context = { used: 4500, max: null, percent: null, capturedAt: null, historical: true, kind: 'last-request-input', source: 'hermes.persisted-usage-anchor' };
  data.workflows[0].usage.historicalRuns = 2; f.ui.render(data);
  const context = flatten(f.ui.inspector).find(item => item.className === 'sd-context-detail');
  assert.match(contents(f.ui.tableWrap), /历史请求输入/); assert.match(contents(context), /历史上下文/); assert.match(contents(context), /最后请求输入/); assert.match(contents(context), /4,500 tokens/);
  assert.match(contents(context), /模型容量 —/); assert.match(contents(context), /请求时间未记录/);
  assert.doesNotMatch(contents(context), /10:00|10\/27|上下文快照|25\.0%|容量未上报/);
  assert.equal(flatten(context).some(item => item.attributes.role === 'meter'), false);
  assert.match(contents(f.ui.tableWrap), /历史补齐 2/); assert.match(contents(f.ui.inspector), /历史补齐\n2 次运行/);
  data.workflows[0].context.percent = 99; data.workflows[0].context.max = 5000; f.ui.render(data);
  assert.equal(flatten(f.ui.inspector).some(item => item.attributes.role === 'meter'), false); assert.doesNotMatch(contents(f.ui.tableWrap), /99\.0%/);
});

test('titles and errors are text nodes and statistics have no execution, deletion, or writable application requests', async t => {
  const f = fixture(t), data = fixtureData(); data.workflows[0].title = '<img src=x onerror=alert(1)>'; f.ui.render(data, { error: '<script>bad</script>' });
  assert.match(contents(f.root), /<img src=x onerror=alert\(1\)>/); assert.equal(flatten(f.root).some(item => ['img', 'script'].includes(item.tagName)), false);
  const source = await readFile(new URL('../public/statistics-dashboard.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /innerHTML|Math\.random|fetch\(|localStorage|workflow\.start|\/purge|\/trash/);
});

test('HUD styles inherit the workbench theme, permit narrow comparison scrolling, and respect reduced motion', async () => {
  const styles = await readFile(new URL('../public/statistics-dashboard.css', import.meta.url), 'utf8');
  assert.match(styles, /\.statistics-dashboard\{--sd-bg:var\(--bg\)/); assert.match(styles, /--sd-text:var\(--text\)/); assert.match(styles, /color-scheme:inherit/); assert.match(styles, /\.sd-table-wrap\{overflow-x:auto/);
  assert.match(styles, /@media\(max-width:720px\)/); assert.match(styles, /prefers-reduced-motion:reduce/);
  assert.doesNotMatch(styles, /@keyframes|animation:.*infinite|:root\s*\{|color-scheme:dark|#[0-9a-f]{3,8}\b/i);
});
