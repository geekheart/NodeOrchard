import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Application } from '../src/application.mjs';
import { ModelRequestTraces, readModelRequestTraces, modelRequestTraceView } from '../src/model-request-traces.mjs';

function fixture(t, limits) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('CREATE TABLE application_model_calls(session_id TEXT PRIMARY KEY,value TEXT); CREATE TABLE business_records(value TEXT); INSERT INTO business_records VALUES(\'unchanged\')');
  const requestId = randomUUID(), logs = [], app = { store: { db }, assistantModel: { ownsSession: id => id === 'owned' }, logEvents: { write: (...args) => logs.push(args) } };
  db.prepare('INSERT INTO application_model_calls VALUES(?,?)').run('owned', JSON.stringify({ version: 1, requestId }));
  const traces = new ModelRequestTraces(app, limits);
  const raw = (overrides = {}) => ({ version: 1, traceId: randomUUID(), requestId, requestIndex: 1, status: 'running', startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), durationMs: 100, transport: 'httpx', observability: { dns: 'observed', connect: 'observed', tls: 'observed', headers: 'observed', sse: 'observed' },
    timings: { connectMs: 10, tlsMs: 20, headersMs: 50, firstBodyByteMs: 60, lastBodyByteMs: 100 }, http: { status: 200, requestId: 'req-upstream-fixture', requestIdHeader: 'x-request-id', retryAfterSeconds: null },
    sse: { events: { 'response.created': 1, 'response.output_text.delta': 4 }, otherEvents: 0, truncated: false }, error: { source: null, type: null }, ...overrides });
  return { db, requestId, logs, app, traces, raw };
}

test('only an owned control request is recorded and metadata projection drops bodies, arbitrary headers and private event strings', t => {
  const f = fixture(t), raw = f.raw();
  raw.headers = { Authorization: 'PRIVATE_TOKEN' }; raw.prompt = 'PRIVATE_PROMPT'; raw.error.message = 'PRIVATE_ERROR';
  raw.sse.events.PRIVATE_REASONING = 5; raw.http.cookie = 'PRIVATE_COOKIE';
  assert.equal(f.traces.capture('foreign', raw), false);
  assert.equal(f.traces.capture('owned', { ...raw, requestId: randomUUID() }), false);
  assert.equal(f.traces.capture('owned', raw), true);
  const result = readModelRequestTraces(f.db, 'owned'); assert.equal(result.recorded, true); assert.equal(result.requestCount, 1);
  assert.equal(result.requests[0].observability.dns, 'unavailable'); assert.equal(result.requests[0].http.requestId, 'req-upstream-fixture');
  assert(!JSON.stringify([result, f.logs, f.db.prepare('SELECT value FROM application_model_request_traces').all()]).includes('PRIVATE_'));
  assert.equal(f.db.prepare('SELECT value FROM business_records').get().value, 'unchanged');
});

test('terminal traces cannot regress or be rebound to a new request index and old snapshots cannot overwrite new timing', t => {
  const f = fixture(t), raw = f.raw(); assert(f.traces.capture('owned', raw));
  const terminal = { ...raw, status: 'complete', bodyComplete: true, updatedAt: new Date(Date.now() + 100).toISOString() };
  assert(f.traces.capture('owned', terminal)); assert.equal(f.traces.capture('owned', raw), false);
  assert.equal(f.traces.capture('owned', { ...terminal, requestIndex: 2 }), false);
  assert.equal(f.traces.capture('owned', { ...terminal, traceId: randomUUID() }), false);
  assert.equal(readModelRequestTraces(f.db, 'owned').requests[0].bodyComplete, true);
});

test('request traces paginate without losing attempts and unavailable preparation does not invent an HTTP request', t => {
  const f = fixture(t);
  assert(f.traces.capture('owned', f.raw({ requestIndex: 0, status: 'unavailable', code: 'TRACE_CLIENT_UNAVAILABLE' })));
  assert.equal(readModelRequestTraces(f.db, 'owned').requestCount, 0);
  for (let index = 1; index <= 5; index++) assert(f.traces.capture('owned', f.raw({ requestIndex: index, status: 'complete' })));
  const first = readModelRequestTraces(f.db, 'owned', { limit: 2 }); assert.deepEqual(first.requests.map(row => row.requestIndex), [1, 2]);
  assert.equal(first.requestCount, 5); assert.equal(first.nextAfterRequestIndex, 2); assert.equal(first.hasMore, true);
  const last = readModelRequestTraces(f.db, 'owned', { afterRequestIndex: first.nextAfterRequestIndex, limit: 4 });
  assert.deepEqual(last.requests.map(row => row.requestIndex), [3, 4, 5]); assert.equal(last.hasMore, false);
  assert.throws(() => readModelRequestTraces(f.db, 'owned', { limit: 50 }), { httpStatus: 400 });
});

test('historical absence and bounded retention are explicit, and malformed or secret-like upstream IDs never leak', t => {
  const f = fixture(t, { maxEntries: 2 }); assert.equal(readModelRequestTraces(f.db, 'owned').recorded, false);
  assert.equal(modelRequestTraceView(f.raw({ traceId: '../invalid' })), null);
  const secret = f.raw(); secret.http.requestId = 'sk-private-credential'; assert(f.traces.capture('owned', secret));
  assert.equal(readModelRequestTraces(f.db, 'owned').requests[0].http.requestId, null);
  for (let index = 2; index <= 4; index++) assert(f.traces.capture('owned', f.raw({ requestIndex: index,
    updatedAt: new Date(Date.now() + index * 100).toISOString() })));
  assert.equal(f.db.prepare('SELECT count(*) count FROM application_model_request_traces').get().count, 2);
  const retained = readModelRequestTraces(f.db, 'owned');
  assert.equal(retained.coverage.missingEarlierIndexes, true); assert.equal(retained.coverage.retentionBounded, true);
  assert.equal(retained.coverage.recordedRequests, 2);
  assert.equal(f.db.prepare('SELECT value FROM business_records').get().value, 'unchanged');
});

test('the gateway ingestion path stores a safe trace without publishing the raw native payload to browser history', t => {
  const f = fixture(t), app = Object.create(Application.prototype), published = [];
  Object.assign(app, { closed: false, resumes: new Map(), store: { byRuntime: () => ({ id: 'owned' }) }, modelRequestTraces: f.traces, publish: (...args) => published.push(args) });
  app.onGatewayEvent({ type: 'model.request.trace', session_id: 'native-owned', payload: { trace: f.raw(), body: 'PRIVATE_NATIVE_BODY' } });
  assert.equal(readModelRequestTraces(f.db, 'owned').requestCount, 1); assert.deepEqual(published, []);
});

test('an unavailable metadata write sink never changes application admission or business data', t => {
  const f = fixture(t); f.db.exec('PRAGMA query_only=ON');
  let observer; assert.doesNotThrow(() => { observer = new ModelRequestTraces(f.app); });
  assert.equal(observer.capture('owned', f.raw()), false);
  assert.equal(f.db.prepare('SELECT value FROM business_records').get().value, 'unchanged');
});

test('format and encoding are whitelisted header classifications and missing legacy observability stays unknown', t => {
  const f = fixture(t), raw = f.raw();
  raw.observability.sse = 'unavailable'; raw.http.responseFormat = 'json'; raw.http.contentEncoding = 'gzip'; raw.sse.unavailableReason = 'not-event-stream';
  assert(f.traces.capture('owned', raw)); const value = readModelRequestTraces(f.db, 'owned').requests[0];
  assert.equal(value.http.responseFormat, 'json'); assert.equal(value.http.contentEncoding, 'gzip'); assert.equal(value.sse.unavailableReason, 'not-event-stream');
  delete raw.http.responseFormat; delete raw.http.contentEncoding; delete raw.sse.unavailableReason;
  const legacy = modelRequestTraceView(raw); assert.equal(legacy.http.responseFormat, 'unknown'); assert.equal(legacy.http.contentEncoding, null); assert.equal(legacy.sse.unavailableReason, 'unknown');
  raw.http.responseFormat = 'PRIVATE_HEADER'; raw.http.contentEncoding = 'PRIVATE_HEADER'; raw.sse.unavailableReason = 'PRIVATE_ERROR';
  assert(!JSON.stringify(modelRequestTraceView(raw)).includes('PRIVATE_'));
});

test('SSE type timings preserve observed intervals, reject invalid ranges and leave historical timing unknown', t => {
  const f = fixture(t), raw = f.raw();
  raw.sse.eventTimings = {
    'response.created': { firstMs: 1, lastMs: 2 },
    'response.output_text.delta': { firstMs: 60, lastMs: 95 },
    'response.completed': { firstMs: 96, lastMs: 98 },
    PRIVATE_EVENT: { firstMs: 3, lastMs: 4 },
  };
  assert(f.traces.capture('owned', raw));
  assert.deepEqual(readModelRequestTraces(f.db, 'owned').requests[0].sse.eventTimings, {
    'response.created': { firstMs: 1, lastMs: 2 },
    'response.output_text.delta': { firstMs: 60, lastMs: 95 },
  }, 'only intervals for actually counted, permitted event types survive');
  for (const interval of [{ firstMs: -1, lastMs: 2 }, { firstMs: 5, lastMs: 4 },
    { firstMs: 2, lastMs: 101 }, { firstMs: 'PRIVATE_TIME', lastMs: 2 }]) {
    raw.sse.eventTimings = { 'response.created': interval };
    assert.deepEqual(modelRequestTraceView(raw).sse.eventTimings, {});
  }
  delete raw.sse.eventTimings;
  assert.equal(modelRequestTraceView(raw).sse.eventTimings, null);
  assert(!JSON.stringify(readModelRequestTraces(f.db, 'owned')).includes('PRIVATE_'));
});

test('SDK retry policy is an observed SDK-client value and missing or invalid values remain unknown', t => {
  const f = fixture(t), raw = f.raw();
  assert.equal(modelRequestTraceView(raw).sdkRetryPolicy, null);
  raw.sdkRetryPolicy = { maxRetries: 0, source: 'sdk-client', config: 'PRIVATE_CONFIG' };
  assert(f.traces.capture('owned', raw));
  assert.deepEqual(readModelRequestTraces(f.db, 'owned').requests[0].sdkRetryPolicy, { maxRetries: 0, source: 'sdk-client' });
  for (const policy of [{ maxRetries: -1, source: 'sdk-client' }, { maxRetries: 101, source: 'sdk-client' },
    { maxRetries: 0, source: 'PRIVATE_SOURCE' }, { maxRetries: 'PRIVATE_RETRY', source: 'sdk-client' }]) {
    assert.equal(modelRequestTraceView({ ...raw, sdkRetryPolicy: policy }).sdkRetryPolicy, null);
  }
  assert(!JSON.stringify(readModelRequestTraces(f.db, 'owned')).includes('PRIVATE_'));
});

test('transport cause chains retain only bounded class identities and OS error metadata without error text', t => {
  const f = fixture(t), raw = f.raw();
  raw.error = { source: 'transport', type: 'ReadError', message: 'PRIVATE_MESSAGE', causeChainTruncated: false,
    causeChain: [{ class: 'httpx.ReadError', errno: null, errnoName: null },
      { class: 'httpcore.ReadError', errno: null, errnoName: null },
      { class: 'builtins.ConnectionResetError', errno: 54, errnoName: 'ECONNRESET', message: 'PRIVATE_OS_ERROR' }] };
  assert(f.traces.capture('owned', raw));
  const received = readModelRequestTraces(f.db, 'owned').requests[0].error;
  assert.deepEqual(received.causeChain, raw.error.causeChain.map(({ class: kind, errno, errnoName }) => ({ class: kind, errno, errnoName })));
  assert.equal(received.causeChainTruncated, false);
  raw.error.causeChain = [{ class: 'PRIVATE_CLASS', errno: 54, errnoName: 'ECONNRESET' },
    { class: 'ssl.SSLError', errno: 54, errnoName: 'ECONNRESET' },
    { class: 'builtins.OSError', errno: 99999, errnoName: 'ECONNRESET' },
    { class: 'builtins.OSError', errno: 54, errnoName: 'PRIVATE_ERRNO' }];
  assert.deepEqual(modelRequestTraceView(raw).error.causeChain, [
    { class: 'unknown', errno: null, errnoName: null },
    { class: 'ssl.SSLError', errno: null, errnoName: null },
    { class: 'builtins.OSError', errno: null, errnoName: null },
    { class: 'builtins.OSError', errno: null, errnoName: null },
  ]);
  raw.error.causeChain = Array.from({ length: 10 }, () => ({ class: 'httpx.ReadError' }));
  assert.equal(modelRequestTraceView(raw).error.causeChain.length, 6);
  assert.equal(modelRequestTraceView(raw).error.causeChainTruncated, true);
  delete raw.error.causeChain; delete raw.error.causeChainTruncated;
  assert.equal(modelRequestTraceView(raw).error.causeChain, null);
  assert.equal(modelRequestTraceView(raw).error.causeChainTruncated, null);
  assert(!JSON.stringify(readModelRequestTraces(f.db, 'owned')).includes('PRIVATE_'));
});

test('failed transport phases stay separate from the final exception chain and are bounded metadata', t => {
  const f = fixture(t), raw = f.raw();
  raw.transportFailures = [{ phase: 'http11.receive_response_body.failed', atMs: 90, causeChainTruncated: false,
    causeChain: [{ class: 'httpcore.ReadError', errno: null, errnoName: null },
      { class: 'builtins.ConnectionResetError', errno: 54, errnoName: 'ECONNRESET' }], message: 'PRIVATE_PHASE' }];
  raw.transportFailuresTruncated = false;
  assert(f.traces.capture('owned', raw));
  const received = readModelRequestTraces(f.db, 'owned').requests[0];
  assert.equal(received.transportFailures[0].phase, 'http11.receive_response_body.failed');
  assert.equal(received.transportFailures[0].atMs, 90);
  assert.equal(received.transportFailures[0].causeChain[1].errnoName, 'ECONNRESET');
  assert.equal(received.error.causeChain, null, 'phase errors cannot be invented as the final suppressed cause');
  assert.equal(received.transportFailuresTruncated, false);
  for (const failure of [{ ...raw.transportFailures[0], phase: 'PRIVATE_PHASE' },
    { ...raw.transportFailures[0], atMs: -1 }, { ...raw.transportFailures[0], atMs: 101 }]) {
    assert.deepEqual(modelRequestTraceView({ ...raw, transportFailures: [failure] }).transportFailures, []);
  }
  const capped = modelRequestTraceView({ ...raw, transportFailures: Array.from({ length: 10 }, () => raw.transportFailures[0]) });
  assert(capped.transportFailures.length <= 4); assert.equal(capped.transportFailuresTruncated, true);
  delete raw.transportFailures; delete raw.transportFailuresTruncated;
  assert.equal(modelRequestTraceView(raw).transportFailures, null);
  assert.equal(modelRequestTraceView(raw).transportFailuresTruncated, null);
  assert(!JSON.stringify(readModelRequestTraces(f.db, 'owned')).includes('PRIVATE_'));
});
