const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const STATUSES = new Set(['running', 'complete', 'error', 'cancelled', 'unavailable']);
const ERRORS = new Set(['TimeoutException', 'ConnectTimeout', 'ReadTimeout', 'WriteTimeout', 'PoolTimeout', 'ConnectError', 'ReadError', 'WriteError', 'RemoteProtocolError', 'LocalProtocolError', 'HTTPStatusError', 'CancelledError', 'SDKError', 'TransportError', 'UnknownError']);
const CAUSE_CLASSES = new Set([
  ...['TimeoutException', 'ConnectTimeout', 'ReadTimeout', 'WriteTimeout', 'PoolTimeout', 'ConnectError', 'ReadError', 'WriteError', 'CloseError', 'RemoteProtocolError', 'LocalProtocolError', 'ProxyError', 'DecodingError', 'TransportError', 'HTTPStatusError'].map(type => 'httpx.' + type),
  ...['TimeoutException', 'ConnectTimeout', 'ReadTimeout', 'WriteTimeout', 'PoolTimeout', 'ConnectError', 'ReadError', 'WriteError', 'RemoteProtocolError', 'LocalProtocolError', 'ProxyError', 'ConnectionNotAvailable'].map(type => 'httpcore.' + type),
  ...['SSLError', 'SSLEOFError', 'SSLZeroReturnError', 'SSLCertVerificationError'].map(type => 'ssl.' + type),
  ...['ConnectionResetError', 'ConnectionAbortedError', 'ConnectionRefusedError', 'BrokenPipeError', 'TimeoutError', 'EOFError', 'InterruptedError', 'PermissionError', 'OSError', 'KeyboardInterrupt'].map(type => 'builtins.' + type),
  ...['openai', 'anthropic'].flatMap(sdk => ['APIConnectionError', 'APITimeoutError', 'APIStatusError', 'APIError'].map(type => sdk + '.' + type)),
  'socket.gaierror', 'socket.herror', 'asyncio.CancelledError', 'concurrent.futures.CancelledError', 'unknown',
]);
const OS_CAUSE_CLASSES = new Set(['ConnectionResetError', 'ConnectionAbortedError', 'ConnectionRefusedError', 'BrokenPipeError', 'TimeoutError', 'InterruptedError', 'PermissionError', 'OSError'].map(type => 'builtins.' + type));
const ERRNO_NAMES = new Set(['ECONNRESET', 'ECONNABORTED', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'ENETRESET', 'ENOTCONN', 'ESHUTDOWN', 'EIO', 'EBADF', 'EAGAIN', 'EINTR', 'EACCES', 'EPERM', 'EADDRNOTAVAIL', 'EADDRINUSE', 'ENOBUFS', 'ENOMEM', 'EMFILE', 'ENFILE']);
const ERRNO_VALUES = new Set([1, 4, 5, 9, 11, 12, 13, 23, 24, 32, 35, 48, 49, 50, 51, 52, 53, 54, 55, 57, 58, 60, 61, 65, 98, 99, 100, 101, 102, 103, 104, 105, 107, 108, 110, 111, 113, 10004, 10013, 10024, 10035, 10048, 10049, 10050, 10051, 10052, 10053, 10054, 10055, 10057, 10058, 10060, 10061, 10065]);
const FAILURE_PHASES = new Set(['connection.connect_tcp.failed', 'connection.start_tls.failed', 'proxy.start_tls.failed',
  ...['http11', 'http2'].flatMap(protocol => ['send_request_headers', 'send_request_body', 'receive_response_headers', 'receive_response_body', 'response_closed'].map(stage => protocol + '.' + stage + '.failed'))]);
const CODES = new Set(['TRACE_TRANSPORT_UNAVAILABLE', 'TRACE_CLIENT_UNAVAILABLE', 'TRACE_HOOK_UNAVAILABLE', 'TRACE_REQUEST_LIMIT', 'TRACE_NOT_ACTIVE']);
const EVENTS = new Set(['message', 'error', 'ping', 'done', 'response.created', 'response.in_progress', 'response.queued', 'response.output_item.added', 'response.output_item.done',
  'response.content_part.added', 'response.content_part.done', 'response.output_text.delta', 'response.output_text.done', 'response.completed', 'response.failed', 'response.incomplete',
  'response.refusal.delta', 'response.refusal.done', 'response.reasoning_summary_part.added', 'response.reasoning_summary_part.done', 'response.reasoning_summary_text.delta',
  'response.reasoning_summary_text.done', 'response.reasoning_text.delta', 'response.reasoning_text.done', 'message_start', 'message_delta', 'message_stop', 'content_block_start', 'content_block_delta', 'content_block_stop']);
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
const date = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const integer = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)
  && !/^(?:sk-|gh[pousr]_|github_pat_|eyJ|bearer)/i.test(value) ? value : null;
const get = (value, key) => plain(value) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
const json = value => { try { return JSON.parse(value); } catch { return null; } };

function causeChainView(error) {
  const raw = get(error, 'causeChain');
  if (!Array.isArray(raw)) return { causeChain: null, causeChainTruncated: null };
  const descriptors = Object.getOwnPropertyDescriptors(raw), length = descriptors.length?.value;
  const causeChain = [];
  for (let index = 0; index < Math.min(length, 6); index++) {
    const row = descriptors[index]?.value, kind = CAUSE_CLASSES.has(get(row, 'class')) ? get(row, 'class') : 'unknown';
    const hasErrno = OS_CAUSE_CLASSES.has(kind) && ERRNO_VALUES.has(get(row, 'errno')) && ERRNO_NAMES.has(get(row, 'errnoName'));
    causeChain.push({ class: kind, errno: hasErrno ? get(row, 'errno') : null, errnoName: hasErrno ? get(row, 'errnoName') : null });
  }
  return { causeChain, causeChainTruncated: length > 6 || get(error, 'causeChainTruncated') === true };
}

function transportFailuresView(raw, durationMs) {
  const failures = get(raw, 'transportFailures');
  if (!Array.isArray(failures)) return { transportFailures: null, transportFailuresTruncated: null };
  const descriptors = Object.getOwnPropertyDescriptors(failures), length = descriptors.length?.value;
  const transportFailures = [];
  for (let index = 0; index < Math.min(length, 4); index++) {
    const row = descriptors[index]?.value, phase = get(row, 'phase'), atMs = number(get(row, 'atMs'));
    if (FAILURE_PHASES.has(phase) && atMs !== null && durationMs !== null && atMs <= durationMs) {
      transportFailures.push({ phase, atMs, ...causeChainView(row) });
    }
  }
  return { transportFailures, transportFailuresTruncated: length > 4 || get(raw, 'transportFailuresTruncated') === true };
}

// A second whitelist at the durable boundary. No arbitrary header map, URL,
// request/response body, exception message or reasoning can enter this store.
export function modelRequestTraceView(raw) {
  if (!plain(raw) || get(raw, 'version') !== 1 || !UUID.test(get(raw, 'traceId') || '') || !UUID.test(get(raw, 'requestId') || '')
    || !integer(get(raw, 'requestIndex'), 32) || !STATUSES.has(get(raw, 'status'))) return null;
  const startedAt = date(get(raw, 'startedAt')), updatedAt = date(get(raw, 'updatedAt'));
  if (!startedAt || !updatedAt || updatedAt < startedAt || get(raw, 'requestIndex') === 0 && get(raw, 'status') !== 'unavailable') return null;
  const observability = get(raw, 'observability'), timings = get(raw, 'timings'), http = get(raw, 'http'), sse = get(raw, 'sse'), error = get(raw, 'error');
  const events = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(plain(get(sse, 'events')) ? get(sse, 'events') : {}))) {
    if (EVENTS.has(key) && integer(descriptor.value, 100000000)) events[key] = descriptor.value;
  }
  const durationMs = number(get(raw, 'durationMs')), rawEventTimings = get(sse, 'eventTimings');
  const eventTimings = plain(rawEventTimings) ? {} : null;
  if (eventTimings && get(observability, 'sse') === 'observed' && get(sse, 'truncated') !== true && durationMs !== null) {
    for (const [type, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(rawEventTimings))) {
      if (!EVENTS.has(type) || !(events[type] > 0)) continue;
      const firstMs = number(get(descriptor.value, 'firstMs')), lastMs = number(get(descriptor.value, 'lastMs'));
      if (firstMs !== null && lastMs !== null && firstMs <= lastMs && lastMs <= durationMs) eventTimings[type] = { firstMs, lastMs };
    }
  }
  const header = ['x-request-id', 'request-id'].includes(get(http, 'requestIdHeader')) ? get(http, 'requestIdHeader') : null;
  const retryPolicy = get(raw, 'sdkRetryPolicy');
  const sdkRetryPolicy = get(retryPolicy, 'source') === 'sdk-client' && integer(get(retryPolicy, 'maxRetries'), 100)
    ? { maxRetries: get(retryPolicy, 'maxRetries'), source: 'sdk-client' } : null;
  return { version: 1, traceId: raw.traceId, requestId: raw.requestId, requestIndex: raw.requestIndex, status: raw.status,
    startedAt, updatedAt, durationMs, sdkRetryPolicy, ...transportFailuresView(raw, durationMs), transport: get(raw, 'transport') === 'httpx' ? 'httpx' : 'unavailable',
    observability: Object.fromEntries(['dns', 'connect', 'tls', 'headers', 'sse'].map(key => [key, key !== 'dns' && get(observability, key) === 'observed' ? 'observed' : 'unavailable'])),
    timings: Object.fromEntries(['connectMs', 'tlsMs', 'headersMs', 'firstBodyByteMs', 'lastBodyByteMs'].map(key => [key, number(get(timings, key))])),
    http: { status: integer(get(http, 'status'), 599) && get(http, 'status') >= 100 ? get(http, 'status') : null,
      responseFormat: ['event-stream', 'json', 'other', 'unknown'].includes(get(http, 'responseFormat')) ? get(http, 'responseFormat') : 'unknown',
      contentEncoding: ['identity', 'gzip', 'deflate', 'br', 'zstd', 'other'].includes(get(http, 'contentEncoding')) ? get(http, 'contentEncoding') : null,
      requestId: header ? identifier(get(http, 'requestId')) : null, requestIdHeader: header, retryAfterSeconds: number(get(http, 'retryAfterSeconds')) },
    sse: { events, eventTimings, otherEvents: integer(get(sse, 'otherEvents'), 100000000) ? get(sse, 'otherEvents') : 0, truncated: get(sse, 'truncated') === true,
      unavailableReason: get(observability, 'sse') === 'observed' ? null : ['not-event-stream', 'decoded-stream-unobserved', 'observation-limit', 'parser-error', 'unknown'].includes(get(sse, 'unavailableReason')) ? get(sse, 'unavailableReason') : 'unknown' },
    bodyComplete: typeof get(raw, 'bodyComplete') === 'boolean' ? raw.bodyComplete : null,
    error: { source: ['transport', 'http', 'sdk', 'cancelled'].includes(get(error, 'source')) ? get(error, 'source') : null,
      type: ERRORS.has(get(error, 'type')) ? get(error, 'type') : null, ...causeChainView(error) }, code: CODES.has(get(raw, 'code')) ? raw.code : null };
}

export function readModelRequestTraces(db, sessionId, { afterRequestIndex = 0, limit = 4 } = {}) {
  const empty = { recorded: false, requests: [], requestCount: 0, hasMore: false, nextAfterRequestIndex: null, source: 'request-metadata',
    limitations: ['未记录的历史链路无法补齐；缺失字段保持未知。'] };
  if (!integer(afterRequestIndex, 32) || !Number.isSafeInteger(limit) || limit < 1 || limit > 4) throw Object.assign(new Error('请求链路分页参数无效。'), { httpStatus: 400 });
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='application_model_request_traces'").get()) return empty;
  const rows = db.prepare('SELECT value FROM application_model_request_traces WHERE session_id=? ORDER BY request_index,trace_id LIMIT 33').all(sessionId)
    .map(row => modelRequestTraceView(json(row.value))).filter(Boolean);
  if (!rows.length) return empty;
  const real = rows.filter(row => row.requestIndex > 0), source = real.length ? real : rows.slice(-1);
  const eligible = real.length ? source.filter(row => row.requestIndex > afterRequestIndex) : afterRequestIndex === 0 ? source : [];
  const requests = eligible.slice(0, limit), hasMore = eligible.length > requests.length;
  return { ...empty, recorded: true, requests, requestCount: real.length, hasMore, nextAfterRequestIndex: hasMore ? requests.at(-1).requestIndex : null,
    coverage: { recordedRequests: real.length, highestRecordedRequestIndex: real.at(-1)?.requestIndex ?? null,
      missingEarlierIndexes: real.some((row, index) => row.requestIndex !== index + 1), captureLimitReached: rows.some(row => row.code === 'TRACE_REQUEST_LIMIT'), retentionBounded: true },
    limitations: ['连接阶段可能包含DNS与代理；不推断供应商内部排队或推理耗时。', '传输结束不等于模型已成功完成；SDK读到结束标记后也可正常关闭，bodyComplete=false不能单独判失败。'] };
}

export class ModelRequestTraces {
  constructor(app, { maxEntries = 1000, maxBytes = 4 * 1024 * 1024, maxAgeDays = 14 } = {}) {
    this.app = app; this.db = app.store.db; this.limits = { maxEntries, maxBytes, maxAgeDays };
    try { this.db.exec(`CREATE TABLE IF NOT EXISTS application_model_request_traces (
      session_id TEXT NOT NULL, trace_id TEXT NOT NULL, request_index INTEGER NOT NULL, updated_at TEXT NOT NULL, value TEXT NOT NULL, bytes INTEGER NOT NULL,
      PRIMARY KEY(session_id,trace_id)); CREATE INDEX IF NOT EXISTS application_model_request_traces_at ON application_model_request_traces(updated_at);`);
      this.prune();
    } catch { /* Optional observation storage cannot prevent normal startup. */ }
  }
  prune() {
    const cutoff = new Date(Date.now() - this.limits.maxAgeDays * 86400000).toISOString();
    this.db.prepare('DELETE FROM application_model_request_traces WHERE updated_at<?').run(cutoff);
    let { count, bytes } = this.db.prepare('SELECT count(*) count,coalesce(sum(bytes),0) bytes FROM application_model_request_traces').get();
    for (const row of this.db.prepare('SELECT session_id,trace_id,bytes FROM application_model_request_traces ORDER BY updated_at,trace_id').all()) {
      if (count <= this.limits.maxEntries && bytes <= this.limits.maxBytes) break;
      this.db.prepare('DELETE FROM application_model_request_traces WHERE session_id=? AND trace_id=?').run(row.session_id, row.trace_id); count--; bytes -= row.bytes;
    }
  }
  capture(sessionId, raw) {
    try {
      if (!this.app.assistantModel?.ownsSession(sessionId)) return false;
      const trace = modelRequestTraceView(raw); if (!trace) return false;
      const metric = json(this.db.prepare('SELECT value FROM application_model_calls WHERE session_id=?').get(sessionId)?.value);
      if (metric?.requestId !== trace.requestId) return false;
      const existing = this.db.prepare('SELECT value FROM application_model_request_traces WHERE session_id=? AND trace_id=?').get(sessionId, trace.traceId);
      if (existing) {
        const prior = modelRequestTraceView(json(existing.value));
        if (!prior || prior.requestId !== trace.requestId || prior.requestIndex !== trace.requestIndex || prior.startedAt !== trace.startedAt || prior.updatedAt > trace.updatedAt
          || prior.status !== 'running' && trace.status === 'running') return false;
      } else {
        const collision = this.db.prepare('SELECT 1 FROM application_model_request_traces WHERE session_id=? AND request_index=?').get(sessionId, trace.requestIndex);
        if (collision || this.db.prepare('SELECT count(*) count FROM application_model_request_traces WHERE session_id=?').get(sessionId).count >= 33) return false;
      }
      const value = JSON.stringify(trace), bytes = Buffer.byteLength(value); if (bytes > 8192) return false;
      this.db.prepare('INSERT INTO application_model_request_traces VALUES(?,?,?,?,?,?) ON CONFLICT(session_id,trace_id) DO UPDATE SET updated_at=excluded.updated_at,value=excluded.value,bytes=excluded.bytes')
        .run(sessionId, trace.traceId, trace.requestIndex, trace.updatedAt, value, bytes);
      this.prune();
      this.app.logEvents?.write(trace.status === 'error' ? 'warn' : 'info', 'assistant.request.trace', { component: 'assistant', sessionId, requestId: trace.requestId,
        stage: 'model-request', status: trace.status, httpStatus: trace.http.status, durationMs: trace.durationMs, code: trace.code });
      return true;
    } catch { return false; } // Observation must never alter model execution.
  }
}
