const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_CALLS = 12;
const MAX_BYTES = 16384;
const STATUSES = new Set(['queued', 'thinking', 'running', 'waiting', 'complete', 'completed', 'timeout', 'error', 'failed', 'interrupted', 'cancelled', 'unknown']);
const OWNER_ENDED = new Set(['complete', 'completed', 'error', 'failed', 'interrupted', 'cancelled', 'dismissed', 'applied', 'proposed', 'awaiting_action']);
const STAGES = new Set(['create-session', 'prepare-model', 'prepare-images', 'submit-model', 'model-response', 'model-output', 'read-result']);
const TIMEOUTS = new Set(['first-response', 'output-idle', 'duration', 'total', 'absolute', 'legacy-timeout']);
const ERRORS = new Set(['MODEL_TIMEOUT', 'MODEL_FIRST_RESPONSE_TIMEOUT', 'MODEL_OUTPUT_IDLE_TIMEOUT', 'MODEL_DURATION_TIMEOUT',
  'MODEL_ABORTED', 'MODEL_CLOSED', 'MODEL_DISCONNECTED', 'MODEL_ERROR', 'ABORT_ERR', 'MODEL_FAILED', 'BACKEND_UNAVAILABLE', 'MODEL_RESPONSE_FAILED']);
const own = (value, key) => value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
const object = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const array = value => Array.isArray(value) ? value : [];
const identifier = value => typeof value === 'string' && ID.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value);
const number = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const effort = value => ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(value) ? value : null;
const time = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const delta = (from, to) => from && to ? number(Date.parse(to) - Date.parse(from)) : null;
const parse = value => { try { return JSON.parse(value); } catch { return null; } };
const fail = (message, httpStatus = 400) => { throw Object.assign(new Error(message), { httpStatus }); };
const label = value => typeof value === 'string' && value.length <= 180 && /^[A-Za-z0-9][A-Za-z0-9_./:+-]*$/.test(value)
  && !/^(?:sk-|gh[pousr]_|github_pat_|eyJ)/.test(value) ? value : null;
const first = values => values.filter(Boolean).sort()[0] || null;
const last = values => values.filter(Boolean).sort().at(-1) || null;

function target(input) {
  if (!object(input) || Reflect.ownKeys(input).some(key => typeof key !== 'string' || !['workflowId', 'conversationId', 'turn'].includes(key)
    || !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key), 'value'))) fail('助手诊断只接受已解析的会话轮次和归属。');
  const { workflowId, conversationId, turn } = input;
  if (!object(turn) || !identifier(own(turn, 'id')) || !workflowId && !conversationId) fail('助手诊断缺少有效的会话轮次。');
  if (workflowId !== undefined && !identifier(workflowId) || conversationId !== undefined && !identifier(conversationId)) fail('助手诊断归属身份无效。');
  if (workflowId && own(turn, 'workflowId') !== workflowId || conversationId && own(turn, 'conversationId') !== conversationId) fail('诊断轮次不属于指定会话。', 403);
  return { workflowId, conversationId, turn };
}

function policyView(value) {
  if (!object(value)) return null;
  const result = Object.fromEntries(['firstResponseTimeoutMs', 'outputIdleTimeoutMs', 'maxDurationMs'].map(key => [key, number(own(value, key))]));
  result.deadlineAt = time(own(value, 'deadlineAt'));
  // An explicit all-null record means local deadlines were disabled. Missing
  // legacy metadata stays unknown instead of being reinterpreted as unlimited.
  const disabled = Object.keys(result).every(key => own(value, key) === null);
  return disabled || Object.values(result).some(value => value !== null) ? result : null;
}

function usageView(value, fallback, complete) {
  const usage = own(value, 'usage'), source = own(value, 'source'), recorded = own(value, 'final') === true;
  const state = own(value, 'status');
  const measured = ['measured', 'partial'].includes(state) && object(usage)
    && (complete || ['input', 'output', 'total'].some(key => number(own(usage, key)) > 0));
  const counters = measured ? usage : object(own(fallback, 'usage')) ? own(fallback, 'usage') : null;
  // A zero ticker on an interrupted request is not a measurement of zero cost.
  const hasMeasuredFallback = counters && own(fallback, 'tokensRecorded') !== false && ['input', 'output', 'total'].some(key => number(own(counters, key)) > 0);
  const present = measured || hasMeasuredFallback;
  const completeFallback = hasMeasuredFallback && own(fallback, 'tokensRecorded') === true && own(fallback, 'complete') === true;
  return { status: measured ? state : completeFallback ? 'measured' : hasMeasuredFallback ? 'partial' : 'missing', final: recorded && measured || Boolean(completeFallback),
    source: measured && ['message.complete', 'session.usage', 'session.info', 'session.resume', 'hermes.history'].includes(source) ? source
      : hasMeasuredFallback ? ['hermes.state-db', 'hermes.state-db.metadata', 'session.snapshot'].includes(own(fallback, 'source')) ? own(fallback, 'source') : 'session-metadata' : null,
    inputTokens: present ? number(own(counters, 'input')) : null,
    outputTokens: present ? number(own(counters, 'output')) : null,
    totalTokens: present ? number(own(counters, 'total')) : null,
    contextTokens: present ? number(own(counters, 'context_used')) : null };
}

function metadataView(value) {
  if (!object(value) || own(value, 'found') === false) return null;
  return { promptCharacters: number(own(value, 'promptCharacters')), outputCharacters: number(own(value, 'outputCharacters')),
    partial: typeof own(value, 'partial') === 'boolean' ? own(value, 'partial') : null,
    complete: typeof own(value, 'complete') === 'boolean' ? own(value, 'complete') : null,
    tokensRecorded: typeof own(value, 'tokensRecorded') === 'boolean' ? own(value, 'tokensRecorded') : null,
    source: ['hermes.state-db', 'hermes.state-db.metadata'].includes(own(value, 'source')) ? own(value, 'source') : null,
    usage: Object.fromEntries(['input', 'output', 'total', 'context_used'].map(key => [key, number(own(own(value, 'usage'), key))])) };
}

// This reader never creates a table, changes business state or resumes a Hermes
// session. The caller resolves authorization and supplies one server-owned turn;
// the reader verifies its scope and model-session ownership a second time.
export class AssistantModelDiagnostics {
  constructor(db, { readSessionMetadata } = {}) { this.db = db; this.readSessionMetadata = readSessionMetadata; }
  table(name) { return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name); }
  row(sql, ...parameters) { return this.db.prepare(sql).get(...parameters); }
  value(table, key, id) { return this.table(table) ? parse(this.row(`SELECT value FROM ${table} WHERE ${key}=?`, id)?.value) : null; }
  async sessionMetadata(sessionId) {
    if (typeof this.readSessionMetadata !== 'function') return null;
    let timer;
    try {
      return metadataView(await Promise.race([Promise.resolve().then(() => this.readSessionMetadata(sessionId)), new Promise(resolve => {
        timer = setTimeout(() => resolve(null), 5000); timer.unref?.();
      })]));
    } catch { return null; } finally { clearTimeout(timer); }
  }
  async inspect(input) {
    const { workflowId, conversationId, turn } = target(input), turnId = own(turn, 'id');
    const assistant = own(turn, 'assistant'), progress = own(assistant, 'progress'), checkpoint = own(assistant, 'checkpoint');
    const allSteps = array(own(checkpoint, 'steps')), steps = allSteps.filter(step => STAGES.has(own(step, 'stage')));
    const ids = [...new Set([...array(own(turn, 'modelSessionIds')), own(turn, 'modelSessionId')].filter(value => value !== undefined && value !== null))];
    if (ids.some(value => !identifier(value))) fail('轮次模型会话身份无效。');
    const total = Math.max(ids.length, number(own(progress, 'modelCalls')) || 0, ...steps.map(step => number(own(step, 'modelCall')) || 0));
    const selected = Array.from({ length: Math.min(total, MAX_CALLS) }, (_, offset) => total - Math.min(total, MAX_CALLS) + offset + 1);
    const selectedIds = selected.map(index => ids[index - 1]).filter(Boolean);
    const ownership = this.table('application_model_sessions');
    if (selectedIds.some(sessionId => !ownership || !this.row('SELECT 1 FROM application_model_sessions WHERE id=?', sessionId))) {
      fail('诊断只允许读取此轮已登记的应用模型控制会话。', 403);
    }
    const missing = new Set(), hasLogs = this.table('application_logs');
    const logRows = hasLogs ? this.db.prepare("SELECT id,at,event,context FROM application_logs WHERE event='assistant.turn.state' AND CASE WHEN json_valid(context) THEN json_extract(context,'$.turnId') END=? ORDER BY id DESC LIMIT 257")
      .all(turnId).reverse() : [];
    if (!hasLogs) missing.add('application-logs');
    const logTruncated = logRows.length > 256;
    const logs = logRows.slice(-256).map(row => ({ ...row, context: parse(row.context) })).filter(row => {
      const context = row.context;
      return context && (!workflowId || own(context, 'workflowId') === workflowId)
        && (!conversationId || own(context, 'conversationId') === conversationId);
    });
    const sources = { modelCallRecords: this.table('application_model_calls'), applicationLogs: hasLogs, sessionMetadata: typeof this.readSessionMetadata === 'function' };
    if (!sources.modelCallRecords) missing.add('model-call-records');
    const metadata = new Map(await Promise.all(selectedIds.map(async sessionId => [sessionId, await this.sessionMetadata(sessionId)])));
    const legacyTimeout = own(turn, 'status') === 'error' && /^应用助手调用累计等待 \d+ 秒超时，停止在「[^」]{1,40}」阶段。$/.test(own(assistant, 'text') || '');
    const calls = selected.map(index => {
      const sessionId = ids[index - 1] || null;
      const record = sessionId && sources.modelCallRecords ? this.value('application_model_calls', 'session_id', sessionId) : null;
      const stored = own(record, 'version') === 1 ? record : null;
      const currentSteps = steps.filter(step => own(step, 'modelCall') === index);
      const currentLogs = logs.filter(row => own(row.context, 'modelCalls') === index && (!sessionId || !own(row.context, 'sessionId') || own(row.context, 'sessionId') === sessionId));
      const stageStart = stage => first([...currentSteps.filter(row => own(row, 'stage') === stage).map(row => time(own(row, 'startedAt'))),
        ...currentLogs.filter(row => own(row.context, 'stage') === stage).map(row => time(row.at))]);
      const stageEnd = stage => last(currentSteps.filter(row => own(row, 'stage') === stage).map(row => time(own(row, 'completedAt'))));
      const session = sessionId && this.table('sessions') ? this.row('SELECT model,provider FROM sessions WHERE id=?', sessionId) : null;
      const runs = sessionId && this.table('runs') ? this.db.prepare('SELECT id,status,started_at,completed_at FROM runs WHERE session_id=? ORDER BY rowid LIMIT 3').all(sessionId) : [];
      const run = runs.length === 1 ? runs[0] : null;
      const latest = index === total, info = metadata.get(sessionId);
      if (!stored) missing.add('model-call-records');
      if (!info && !stored) missing.add('session-metadata');
      const startedAt = stored ? time(own(stored, 'startedAt')) : stageStart('create-session') || time(run?.started_at) || first(currentLogs.map(row => time(row.at)));
      const submittedAt = stored ? time(own(stored, 'submittedAt')) : stageStart('model-response') || stageEnd('submit-model');
      const firstOutputAt = stored ? time(own(stored, 'firstOutputAt')) : stageStart('model-output');
      const readResultAt = stageStart('read-result');
      const ownerStatus = STATUSES.has(own(turn, 'status')) || OWNER_ENDED.has(own(turn, 'status')) ? own(turn, 'status') : 'unknown';
      const persistedSnapshotStatus = STATUSES.has(own(stored, 'status')) ? own(stored, 'status') : null;
      const staleRunning = persistedSnapshotStatus === 'running' && OWNER_ENDED.has(ownerStatus);
      // A crash can leave the last phase snapshot running while recovery closes
      // its owning chat. Report that known interruption separately; the chat's
      // update time is not evidence of when the model itself finished.
      const fallbackStatus = STATUSES.has(run?.status) ? run.status
        : latest && STATUSES.has(own(turn, 'status')) ? own(turn, 'status') : readResultAt ? 'complete' : 'unknown';
      const terminalStatus = staleRunning ? ['error', 'failed', 'interrupted', 'cancelled'].includes(ownerStatus) ? ownerStatus : 'unknown'
        : persistedSnapshotStatus || fallbackStatus;
      const statusSource = staleRunning ? 'owner-turn' : stored ? 'model-call-record' : run ? 'local-run' : readResultAt ? 'checkpoint' : 'owner-turn';
      const settled = !['running', 'waiting', 'thinking', 'queued', 'unknown'].includes(terminalStatus);
      const completedAt = stored ? time(own(stored, 'completedAt')) : (settled ? time(run?.completed_at) : null)
        || (settled && latest ? time(own(turn, 'updatedAt')) : null) || stageEnd('read-result');
      const outputCharacters = number(own(stored, 'outputCharacters')) ?? own(info, 'outputCharacters') ?? null;
      const errorCode = ERRORS.has(own(stored, 'errorCode')) ? own(stored, 'errorCode') : null;
      const timeoutKind = TIMEOUTS.has(own(stored, 'timeoutKind')) ? own(stored, 'timeoutKind') : latest && legacyTimeout && !stored ? 'legacy-timeout' : null;
      const complete = ['complete', 'completed'].includes(terminalStatus) && (Boolean(stored) || Boolean(readResultAt) || own(info, 'complete') === true);
      const partial = own(info, 'partial') === true || !complete && (outputCharacters > 0 || Boolean(firstOutputAt));
      const usage = run && this.table('run_usage') ? this.value('run_usage', 'run_id', run.id) : null;
      const snapshot = run && this.table('session_usage') ? this.value('session_usage', 'session_id', sessionId) : null;
      const fallback = info && ['input', 'output', 'total'].some(key => number(own(own(info, 'usage'), key)) > 0) ? info
        : snapshot ? { usage: own(snapshot, 'usage'), source: 'session.snapshot', complete: ['complete', 'completed'].includes(run.status)
          && own(snapshot, 'source') === 'message.complete', tokensRecorded: own(snapshot, 'source') === 'message.complete' ? true : null } : info;
      return { index, sessionId, status: terminalStatus, model: label(session?.model), provider: label(session?.provider),
        requestedReasoningEffort: effort(own(stored, 'requestedReasoningEffort')), reasoningEffort: effort(own(stored, 'reasoningEffort')),
        reasoningEffortWire: effort(own(stored, 'reasoningEffortWire')),
        ownerStatus, ownerUpdatedAt: time(own(turn, 'updatedAt')), persistedSnapshotStatus, statusSource,
        modelTerminalConfirmed: !staleRunning && Boolean(stored && completedAt || !stored && readResultAt),
        startedAt, submittedAt, firstOutputAt, completedAt, waitMs: delta(submittedAt, firstOutputAt || readResultAt || completedAt),
        outputMs: firstOutputAt ? delta(firstOutputAt, readResultAt || completedAt) : null, durationMs: delta(startedAt, completedAt),
        firstOutputObserved: Boolean(firstOutputAt), complete, partial, timeoutKind, errorCode,
        timeoutPolicy: policyView(own(stored, 'timeoutPolicy')), promptCharacters: number(own(stored, 'promptCharacters')) ?? own(info, 'promptCharacters') ?? null,
        outputCharacters, outputCharactersComplete: complete && Boolean(stored),
        usage: usageView(usage, fallback, complete), runningSnapshot: persistedSnapshotStatus === 'running',
        evidenceSource: stored ? 'model-call-record' : currentSteps.length ? 'checkpoint' : currentLogs.length ? 'application-log' : 'unknown' };
    });
    const findings = [];
    for (const call of calls) {
      if (call.waitMs >= 30000 && call.firstOutputObserved) findings.push({ code: 'LATE_FIRST_OUTPUT', call: call.index, waitMs: call.waitMs });
      if (call.timeoutKind) findings.push({ code: 'MODEL_TIMEOUT', call: call.index, timeoutKind: call.timeoutKind });
      if (call.partial && !call.complete) findings.push({ code: 'INCOMPLETE_MODEL_OUTPUT', call: call.index, outputCharacters: call.outputCharacters });
      if (call.runningSnapshot && call.statusSource === 'owner-turn') findings.push({ code: 'STALE_RUNNING_SNAPSHOT', call: call.index, ownerStatus: call.ownerStatus });
      if (call.usage.status === 'missing') missing.add('token-usage');
    }
    if (calls.some(call => call.waitMs === null)) missing.add('model-wait-timing');
    if (calls.some(call => call.timeoutPolicy === null)) missing.add('historical-timeout-policy');
    const toolSteps = allSteps.filter(step => own(step, 'stage') === 'tool-read');
    const toolDurations = toolSteps.map(step => number(own(step, 'elapsedMs')) ?? delta(time(own(step, 'startedAt')), time(own(step, 'completedAt')))).filter(value => value !== null);
    const result = { schemaVersion: 1, target: { ...(workflowId ? { workflowId } : {}), ...(conversationId ? { conversationId } : {}), turnId },
      status: STATUSES.has(own(turn, 'status')) ? own(turn, 'status') : 'unknown',
      createdAt: time(own(turn, 'createdAt')), updatedAt: time(own(turn, 'updatedAt')),
      durationMs: delta(time(own(turn, 'createdAt')), time(own(turn, 'updatedAt'))), totalModelCalls: total,
      toolCalls: number(own(progress, 'toolCalls')),
      observedToolDurationMs: toolDurations.length ? toolDurations.reduce((total, value) => total + value, 0) : null,
      toolDurationCoverage: { observedSteps: toolDurations.length, checkpointTruncated: number(own(progress, 'toolCalls')) > toolSteps.length },
      calls, findings, sources,
      logEvidence: { ids: logs.slice(-64).map(row => number(row.id)).filter(value => value !== null), truncated: logTruncated || logs.length > 64 },
      missingEvidence: [...missing], truncated: total > MAX_CALLS };
    while (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_BYTES && result.logEvidence.ids.length) { result.logEvidence.ids.shift(); result.logEvidence.truncated = true; }
    while (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_BYTES && result.calls.length) {
      result.calls.shift(); result.truncated = true; result.findings = result.findings.filter(row => result.calls.some(call => call.index === row.call));
    }
    return result;
  }
}
