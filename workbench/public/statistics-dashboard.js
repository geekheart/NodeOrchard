const SVG = 'http://www.w3.org/2000/svg';
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const count = value => number(value) ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(value) : '—';
const compact = value => number(value) ? value >= 1000000 ? `${(value / 1000000).toFixed(2)}M` : value >= 10000 ? `${(value / 1000).toFixed(1)}k` : count(value) : '—';
const percentage = value => number(value) ? `${(value * 100).toFixed(value === 0 || value === 1 ? 0 : 1)}%` : '—';
const bytes = value => !number(value) ? '—' : value >= 1048576 ? `${(value / 1048576).toFixed(2)} MB` : value >= 1024 ? `${(value / 1024).toFixed(1)} KB` : `${count(value)} B`;
const duration = value => !number(value) ? '—' : value >= 3600000 ? `${(value / 3600000).toFixed(1)} h` : value >= 60000 ? `${(value / 60000).toFixed(1)} min` : `${(value / 1000).toFixed(1)} s`;
const text = value => String(value ?? '');
const element = (tag, className = '', value) => { const item = document.createElement(tag); if (className) item.className = className; if (value !== undefined) item.textContent = text(value); return item; };
const svgElement = (tag, attributes = {}, value) => { const item = document.createElementNS(SVG, tag); for (const [name, content] of Object.entries(attributes)) item.setAttribute(name, text(content)); if (value !== undefined) item.textContent = text(value); return item; };
const button = (label, handler, className = '') => { const item = element('button', `sd-button ${className}`, label); item.type = 'button'; item.addEventListener('click', handler); return item; };
const STATES = { active: '正常', trashed: '回收站', archived: '回收站', deleted: '已删除' };
const STATUS = { complete: '成功', completed: '成功', error: '失败', failed: '失败', interrupted: '已停止', unknown: '待确认', running: '运行中', waiting: '等待中', waiting_review: '待审核', preparing: '准备中', queued: '排队中', proposed: '待应用', applied: '已应用', dismissed: '已结束', thinking: '正在回复', awaiting_action: '待处理' };
const failStatus = status => ['error', 'failed', 'interrupted', 'unknown'].includes(status);
const time = (value, zone = 'Asia/Shanghai', short = false) => {
  if (!value || !Number.isFinite(new Date(value).valueOf())) return '—';
  try { return new Intl.DateTimeFormat('zh-CN', { timeZone: zone, month: '2-digit', day: '2-digit', ...(short ? {} : { hour: '2-digit', minute: '2-digit', hour12: false }) }).format(new Date(value)); }
  catch { return new Date(value).toISOString().slice(0, short ? 10 : 16).replace('T', ' '); }
};
const values = item => ({ conversation: item?.conversations || {}, execution: item?.execution || {}, usage: item?.usage || {}, artifacts: item?.artifacts || {}, storage: item?.storage || {} });
const lastAt = item => item?.execution?.lastAt || item?.conversations?.lastAt || '';
const coverage = usage => {
  const measured = number(usage?.measuredRuns) ? usage.measuredRuns : 0, partial = number(usage?.partialRuns) ? usage.partialRuns : 0, missing = number(usage?.unmeasuredRuns) ? usage.unmeasuredRuns : 0;
  return measured + partial + missing ? `已采集 ${count(measured + partial)} / ${count(measured + partial + missing)}${partial ? ` · 部分 ${count(partial)}` : ''}` : '尚无用量记录';
};
const contextPercent = context => number(context?.percent) ? context.percent : number(context?.used) && number(context?.max) && context.max > 0 ? context.used / context.max * 100 : null;
const heading = (index, title, note = '') => { const box = element('div', 'sd-section-heading'); box.append(element('span', 'sd-section-index', index), element('h3', '', title)); if (note) box.append(element('span', 'sd-section-note', note)); return box; };

function metric(label, value, note, tone = '') {
  const item = element('div', `sd-readout ${tone}`); item.append(element('span', 'sd-readout-label', label), element('strong', 'sd-readout-value', value), element('span', 'sd-readout-note', note)); return item;
}

function chart(daily, type) {
  const token = type === 'tokens', title = token ? '每日 Token 消耗' : '每日运行结果';
  const series = daily.map(day => {
    const execution = day.execution || {}, usage = day.usage || {};
    if (!token) return { date: day.date, known: number(execution.runs), parts: [execution.complete || 0, execution.failed || 0, Math.max(0, (execution.runs || 0) - (execution.complete || 0) - (execution.failed || 0))] };
    const input = number(usage.input) ? usage.input : 0, output = number(usage.output) ? usage.output : 0;
    return { date: day.date, known: [usage.input, usage.output, usage.total].some(number), parts: [input, output, number(usage.total) ? Math.max(0, usage.total - input - output) : 0] };
  });
  const area = element('div', 'sd-chart-area');
  if (!series.some(day => day.known)) { area.append(element('p', 'sd-chart-empty', token ? '当前范围未采集 Token 数据' : '当前范围没有运行记录')); return area; }
  const maximum = Math.max(1, ...series.map(day => day.parts.reduce((sum, value) => sum + value, 0)));
  const svg = svgElement('svg', { viewBox: '0 0 560 124', role: 'img', 'aria-label': title, preserveAspectRatio: 'none' }); svg.append(svgElement('title', {}, title));
  const left = 40, top = 10, height = 82, width = 508;
  for (const fraction of maximum > 1 ? [0, 0.5, 1] : [0, 1]) {
    const y = top + height - fraction * height;
    svg.append(svgElement('line', { x1: left, y1: y, x2: 548, y2: y, class: 'sd-chart-grid' }), svgElement('text', { x: left - 8, y: y + 4, 'text-anchor': 'end', class: 'sd-axis-label' }, compact(maximum * fraction)));
  }
  const step = width / Math.max(1, series.length), bar = Math.min(24, step * 0.58);
  series.forEach((day, index) => {
    if (!day.known) return;
    const group = svgElement('g'); group.append(svgElement('title', {}, `${day.date} · ${token ? `输入 ${count(daily[index].usage?.input)} / 输出 ${count(daily[index].usage?.output)} / 总计 ${count(daily[index].usage?.total)}` : `运行 ${count(daily[index].execution?.runs)} / 成功 ${count(daily[index].execution?.complete)} / 失败 ${count(daily[index].execution?.failed)}`}`));
    let offset = 0;
    day.parts.forEach((value, part) => {
      if (!(value > 0)) return;
      const h = value / maximum * height;
      group.append(svgElement('rect', { x: left + index * step + (step - bar) / 2, y: top + height - offset - h, width: bar, height: h, class: `sd-bar ${token ? ['input', 'output', 'other'][part] : ['success', 'failure', 'other'][part]}` })); offset += h;
    });
    svg.append(group);
  });
  const indexes = [...new Set([0, Math.floor((series.length - 1) / 2), series.length - 1])];
  for (const index of indexes) if (series[index]) svg.append(svgElement('text', { x: left + index * step + step / 2, y: 118, 'text-anchor': 'middle', class: 'sd-axis-label' }, text(series[index].date).slice(5).replace('-', '/')));
  area.append(svg); return area;
}

export class StatisticsDashboard {
  constructor(root, { onRefresh = () => {} } = {}) {
    Object.assign(this, { root, onRefresh, data: null, loading: false, error: '', days: 7, query: '', filter: 'all', sort: 'activity', selectedWorkflow: null });
    root.className = `${root.className || ''} statistics-dashboard`.trim();
    this.mount(); this.render(null);
  }
  mount() {
    this.header = element('header', 'sd-header');
    const title = element('div', 'sd-header-title'); title.append(element('span', 'sd-eyebrow', 'WORKFLOW / TELEMETRY'), element('h2', '', '运行观测'));
    const status = element('div', 'sd-header-status'); this.updated = element('span', 'sd-updated'); this.updated.setAttribute('role', 'status'); this.refresh = button('刷新数据', () => this.onRefresh(), 'sd-refresh'); status.append(this.updated, this.refresh); this.header.append(title, status);
    this.errorBox = element('p', 'sd-error'); this.errorBox.setAttribute('role', 'alert'); this.errorBox.hidden = true;
    this.readouts = element('section', 'sd-readouts'); this.readouts.setAttribute('aria-label', '统计总览');
    this.trends = element('section', 'sd-trends'); this.trends.setAttribute('aria-label', '每日趋势');
    this.workspace = element('section', 'sd-workspace'); this.tableArea = element('div', 'sd-workflow-area');
    this.tableArea.append(heading('03', '工作流明细'));
    this.controls = element('div', 'sd-controls'); this.search = element('input', 'sd-search'); this.search.type = 'search'; this.search.placeholder = '搜索工作流'; this.search.setAttribute('aria-label', '搜索统计工作流');
    this.search.addEventListener('input', () => { this.query = this.search.value; this.renderTable(); });
    this.lifecycle = element('select'); this.lifecycle.setAttribute('aria-label', '筛选统计工作流');
    for (const [value, label] of [['all', '全部工作流'], ['active', '正常'], ['trashed', '回收站'], ['deleted', '已删除']]) { const option = element('option', '', label); option.value = value; this.lifecycle.append(option); }
    this.lifecycle.addEventListener('change', () => { this.filter = this.lifecycle.value; this.renderTable(); });
    this.sortInput = element('select'); this.sortInput.setAttribute('aria-label', '排序统计工作流');
    for (const [value, label] of [['activity', '最近活动'], ['tokens', 'Token 消耗'], ['runs', '运行次数'], ['failures', '失败次数'], ['conversations', '对话轮次']]) { const option = element('option', '', label); option.value = value; this.sortInput.append(option); }
    this.sortInput.addEventListener('change', () => { this.sort = this.sortInput.value; this.renderTable(); });
    this.controls.append(this.search, this.lifecycle, this.sortInput); this.tableArea.append(this.controls); this.tableSummary = element('p', 'sd-table-summary'); this.tableArea.append(this.tableSummary); this.tableWrap = element('div', 'sd-table-wrap'); this.tableArea.append(this.tableWrap);
    this.inspector = element('aside', 'sd-inspector'); this.inspector.setAttribute('aria-label', '选中工作流统计详情'); this.workspace.append(this.tableArea, this.inspector);
    this.bottom = element('section', 'sd-bottom'); this.root.replaceChildren(this.header, this.errorBox, this.readouts, this.trends, this.workspace, this.bottom);
  }
  render(data, { loading = false, error = '', days = 7 } = {}) {
    if (data !== undefined && !(data === null && (loading || error) && this.data)) this.data = data;
    Object.assign(this, { loading, error, days }); this.root.setAttribute('aria-busy', String(loading)); this.refresh.disabled = loading;
    this.refresh.textContent = loading ? '正在读取…' : '刷新数据'; this.errorBox.hidden = !error; this.errorBox.textContent = error ? `统计读取失败：${error}` : '';
    const zone = this.data?.period?.timeZone || 'Asia/Shanghai';
    this.updated.textContent = this.data ? `${this.data.period?.days || days} 天 · ${zone} · 更新 ${time(this.data.generatedAt, zone)}` : loading ? '正在读取本地统计' : '尚无统计数据';
    const rows = this.data?.workflows || [];
    if (!rows.some(row => row.id === this.selectedWorkflow)) this.selectedWorkflow = rows[0]?.id || null;
    this.renderReadouts(); this.renderTrends(); this.renderTable(); this.renderInspector(); this.renderBottom();
  }
  renderReadouts() {
    const totals = this.data?.totals, { conversation, execution, usage, storage } = values(totals);
    this.readouts.replaceChildren(
      metric('工作流', count(totals?.workflowCount), '含保留的历史工作流'),
      metric('对话轮次', count(conversation.turns), `${count(conversation.modelCalls)} 次模型调用`),
      metric('Token 消耗', compact(usage.total), coverage(usage), 'cyan'),
      metric('运行次数', count(execution.runs), `${count(execution.active)} 次进行中`),
      metric('成功率', percentage(execution.successRate), `${count(execution.complete)} 成功 / ${count(execution.failed)} 失败`, 'success'),
      metric('记录占用', bytes(storage.recordBytes), '已保存的结构化记录'),
    );
  }
  renderTrends() {
    const daily = this.data?.daily || [], source = this.data?.period?.timeZone || 'Asia/Shanghai';
    const activity = element('div', 'sd-trend'); activity.append(heading('01', '运行结果', `${this.days} 天 · ${source}`));
    const runLegend = element('div', 'sd-legend'); for (const [tone, label] of [['success', '成功'], ['failure', '失败'], ['other', '停止 / 其它']]) runLegend.append(element('span', tone, label)); activity.append(runLegend, chart(daily, 'runs'));
    const consumption = element('div', 'sd-trend'); consumption.append(heading('02', 'Token 消耗', coverage(this.data?.totals?.usage)));
    const tokenLegend = element('div', 'sd-legend'); for (const [tone, label] of [['input', '输入'], ['output', '输出'], ['other', '未拆分']]) tokenLegend.append(element('span', tone, label)); consumption.append(tokenLegend, chart(daily, 'tokens'));
    this.trends.replaceChildren(activity, consumption);
  }
  filteredRows() {
    const query = this.query.trim().toLocaleLowerCase();
    return [...(this.data?.workflows || [])].filter(row => (!query || `${row.title} ${row.id} ${(row.models || []).map(model => typeof model === 'string' ? model : `${model.provider || ''} ${model.model || ''}`).join(' ')}`.toLocaleLowerCase().includes(query))
      && (this.filter === 'all' || (row.lifecycle === 'archived' ? 'trashed' : row.lifecycle) === this.filter)).sort((a, b) => {
      const score = row => this.sort === 'tokens' ? row.usage?.total : this.sort === 'runs' ? row.execution?.runs : this.sort === 'failures' ? row.execution?.failed : this.sort === 'conversations' ? row.conversations?.turns : Date.parse(lastAt(row));
      const av = score(a), bv = score(b); return (number(bv) ? bv : -1) - (number(av) ? av : -1) || text(a.title).localeCompare(text(b.title), 'zh-CN');
    });
  }
  renderTable() {
    const rows = this.filteredRows(); this.tableSummary.textContent = `${count(rows.length)} / ${count(this.data?.workflows?.length || 0)} 个工作流`;
    const table = element('table', 'sd-table'); table.setAttribute('aria-label', '每个工作流的运行与用量统计');
    const head = element('thead'), headings = element('tr'); for (const label of ['工作流', '对话', '运行', '成功 / 失败', 'Token', '上下文']) { const th = element('th', '', label); th.scope = 'col'; headings.append(th); } head.append(headings);
    const body = element('tbody'); this.rowButtons = new Map();
    rows.forEach((row, index) => {
      const tr = element('tr', row.id === this.selectedWorkflow ? 'selected' : ''); tr.setAttribute('aria-selected', String(row.id === this.selectedWorkflow));
      const name = element('td', 'sd-workflow-name');
      const choose = button(row.title || '未命名工作流', event => { event.stopPropagation?.(); this.select(row.id); this.rowButtons.get(row.id)?.focus?.(); }, 'sd-workflow-select'); choose.setAttribute('aria-pressed', String(row.id === this.selectedWorkflow)); choose.title = text(row.title); this.rowButtons.set(row.id, choose);
      choose.addEventListener('keydown', event => { if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return; event.preventDefault?.(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))); this.select(rows[next].id); this.rowButtons.get(rows[next].id)?.focus?.(); });
      name.append(choose, element('span', 'sd-workflow-meta', `${STATES[row.lifecycle] || '正常'} · ${row.mode === 'learn' ? '学习' : '执行'}`));
      tr.append(name, element('td', '', count(row.conversations?.turns)), element('td', '', count(row.execution?.runs)));
      const results = element('td', 'sd-run-counts'); results.append(element('span', 'success', count(row.execution?.complete)), element('span', 'sd-count-divider', ' / '), element('span', number(row.execution?.failed) && row.execution.failed > 0 ? 'failure' : '', count(row.execution?.failed))); tr.append(results);
      const tokens = element('td', 'sd-token-cell'); tokens.append(element('strong', '', compact(row.usage?.total)), element('span', 'sd-cell-note', row.usage?.total === null || row.usage?.total === undefined ? '未采集' : coverage(row.usage))); tr.append(tokens);
      const context = element('td', 'sd-context-cell'), ratio = contextPercent(row.context);
      context.append(element('strong', '', ratio === null ? compact(row.context?.used) : `${ratio.toFixed(1)}%`), element('span', 'sd-cell-note', row.context ? ratio === null ? '容量未上报' : `${compact(row.context.used)} / ${compact(row.context.max)}` : '未采集'));
      tr.append(context); tr.addEventListener('click', () => this.select(row.id)); body.append(tr);
    });
    table.append(head, body);
    this.tableWrap.replaceChildren(table, ...(rows.length ? [] : [element('p', 'sd-empty', this.data ? this.query || this.filter !== 'all' ? '没有符合条件的工作流' : '当前范围没有工作流记录' : '等待本地统计数据')]));
  }
  select(id) { this.selectedWorkflow = id; this.renderTable(); this.renderInspector(); }
  pair(label, value, className = '') { const row = element('div', `sd-pair ${className}`); row.append(element('dt', '', label), element('dd', '', value)); return row; }
  renderInspector() {
    const row = this.data?.workflows?.find(item => item.id === this.selectedWorkflow);
    this.inspector.replaceChildren(heading('04', '工作流详情', row ? STATES[row.lifecycle] || '正常' : '未选中'));
    if (!row) { this.inspector.append(element('p', 'sd-empty', '选择工作流查看明细')); return; }
    const { conversation, execution, usage, artifacts, storage } = values(row);
    const title = element('div', 'sd-detail-title'); title.append(element('h3', '', row.title), element('span', 'sd-detail-id', row.id));
    if (row.lifecycle !== 'deleted') { const open = element('a', 'sd-open-link', '打开工作流 ↗'); open.href = `#/workflows/${encodeURIComponent(row.id)}`; title.append(open); } this.inspector.append(title);
    const outcome = element('div', 'sd-outcome'); outcome.append(element('strong', '', percentage(execution.successRate)), element('span', '', '运行成功率'));
    const bar = element('div', 'sd-outcome-bar'); bar.setAttribute('aria-hidden', 'true');
    const runCount = execution.runs || 0; for (const [tone, value] of [['success', execution.complete], ['failure', execution.failed], ['other', Math.max(0, runCount - (execution.complete || 0) - (execution.failed || 0))]]) if (value > 0 && runCount > 0) { const part = element('span', tone); part.style.width = `${value / runCount * 100}%`; bar.append(part); }
    outcome.append(bar); this.inspector.append(outcome);
    const facts = element('dl', 'sd-detail-facts');
    for (const [label, value, tone] of [
      ['成功 / 失败', `${count(execution.complete)} / ${count(execution.failed)}`, ''], ['停止 / 待确认', `${count(execution.interrupted)} / ${count(execution.unknown)}`, ''],
      ['运行 / 节点尝试', `${count(execution.runs)} / ${count(execution.nodeAttempts)}`, ''], ['累计 / 平均耗时', `${duration(execution.totalDurationMs)} / ${duration(execution.averageDurationMs)}`, ''],
      ['学习样本执行', count(execution.learningRuns), ''],
      ['对话轮次 / 待处理', `${count(conversation.turns)} / ${count(conversation.pending)}`, ''], ['模型 / 工具调用', `${count(conversation.modelCalls)} / ${count(conversation.toolCalls)}`, ''],
      ['输入 Token', count(usage.input), 'input'], ['输出 Token', count(usage.output), 'output'], ['累计 Token', count(usage.total), 'cyan'],
      ['已采集模型请求', count(usage.calls), ''],
      ['采集覆盖', coverage(usage), ''], ['登记产物', `${count(artifacts.count)} · ${bytes(artifacts.registeredBytes)}`, ''], ['记录占用', bytes(storage.recordBytes), ''],
    ]) facts.append(this.pair(label, value, tone)); this.inspector.append(facts);
    const context = element('div', 'sd-context-detail'); context.append(heading('', '上下文快照'));
    const ratio = contextPercent(row.context);
    if (!row.context) context.append(element('p', 'sd-empty-inline', '未采集上下文快照'));
    else {
      context.append(element('strong', 'sd-context-value', `${compact(row.context.used)} / ${compact(row.context.max)}`));
      const note = ratio === null ? '模型容量未上报' : `${ratio.toFixed(1)}%${row.context.estimated ? ' · 估算' : ''}`; context.append(element('span', 'sd-cell-note', note));
      if (ratio !== null) { const meter = element('div', 'sd-context-meter'); meter.setAttribute('role', 'meter'); meter.setAttribute('aria-label', '最近上下文占用'); meter.setAttribute('aria-valuemin', '0'); meter.setAttribute('aria-valuemax', '100'); meter.setAttribute('aria-valuenow', text(Math.max(0, Math.min(100, ratio)))); const fill = element('span', ratio >= 85 ? 'attention' : ''); fill.style.width = `${Math.max(0, Math.min(100, ratio))}%`; meter.append(fill); context.append(meter); }
      context.append(element('span', 'sd-cell-note', `${time(row.context.capturedAt, this.data?.period?.timeZone)} · ${row.context.source || '来源未上报'}`));
    }
    this.inspector.append(context);
    const models = element('div', 'sd-models'); models.append(element('span', 'sd-small-label', '模型'));
    for (const model of row.models || []) models.append(element('span', 'sd-model', typeof model === 'string' ? model : [model.provider, model.model].filter(Boolean).join(' / ')));
    if (!row.models?.length) models.append(element('span', 'sd-cell-note', '未记录模型身份')); this.inspector.append(models);
    const recent = element('details', 'sd-detail-recent'); recent.append(element('summary', '', `最近运行 · ${count(row.recentRuns?.length || 0)}`));
    for (const run of (row.recentRuns || []).slice(0, 5)) { const item = element('div', 'sd-mini-run'); item.append(element('span', failStatus(run.status) ? 'failure' : run.status === 'complete' ? 'success' : '', STATUS[run.status] || run.status), element('span', '', time(run.startedAt || run.at, this.data?.period?.timeZone)), element('span', '', duration(run.durationMs))); recent.append(item); }
    if (!row.recentRuns?.length) recent.append(element('p', 'sd-empty-inline', '当前范围无运行')); this.inspector.append(recent);
    const conversationHistory = element('details', 'sd-detail-conversations'); conversationHistory.append(element('summary', '', `最近对话 · ${count(row.recentConversations?.length || 0)}`));
    for (const turn of (row.recentConversations || []).slice(0, 5)) {
      const item = element('div', 'sd-mini-conversation'); item.append(element('span', failStatus(turn.status) ? 'failure' : '', STATUS[turn.status] || turn.status || '—'), element('span', '', time(turn.at || turn.updatedAt, this.data?.period?.timeZone)),
        element('span', '', `模型 ${count(turn.modelCalls)} / 工具 ${count(turn.toolCalls)}`), element('span', '', duration(turn.durationMs))); conversationHistory.append(item);
    }
    if (!row.recentConversations?.length) conversationHistory.append(element('p', 'sd-empty-inline', '当前范围无对话')); this.inspector.append(conversationHistory);
  }
  renderBottom() {
    const supervisor = this.data?.supervisor || {}, turns = supervisor.conversations || {};
    const controls = element('div', 'sd-supervisor'); controls.append(heading('05', '总控助手', `${count(supervisor.conversationCount)} 个主题`));
    const counts = element('div', 'sd-supervisor-counts'); counts.append(metric('对话轮次', count(turns.turns), `${count(turns.pending)} 项待处理`), metric('Token 消耗', compact(supervisor.usage?.total), coverage(supervisor.usage)), metric('模型 / 工具调用', `${count(turns.modelCalls)} / ${count(turns.toolCalls)}`, duration(turns.elapsedMs))); controls.append(counts);
    const activity = element('div', 'sd-activity'); activity.append(heading('06', '最近活动'));
    const entries = this.data?.recentActivity || [];
    for (const entry of entries.slice(0, 8)) { const row = element('div', 'sd-activity-row'); row.append(element('span', 'sd-activity-time', time(entry.at, this.data?.period?.timeZone)), element('span', 'sd-activity-kind', entry.kind === 'run' ? '运行' : '对话'), element('span', 'sd-activity-title', entry.title || entry.workflowId || '总控助手'), element('span', failStatus(entry.status) ? 'failure' : '', STATUS[entry.status] || entry.status || '—')); activity.append(row); }
    if (!entries.length) activity.append(element('p', 'sd-empty-inline', '当前范围没有活动记录'));
    const definitions = element('details', 'sd-definitions'); definitions.append(element('summary', '', '统计口径'));
    definitions.append(element('p', '', '运行按开始时间统计；Token 为已采集的模型用量，缺失值不计为零。上下文是最近快照，不能与累计 Token 等同。记录占用为结构化记录大小，登记产物大小来自产物登记，不代表完整磁盘占用。未采集 CPU、内存或订阅费用。'));
    this.bottom.replaceChildren(controls, activity, definitions);
  }
}
