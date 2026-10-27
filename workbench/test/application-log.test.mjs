import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ApplicationLog, APPLICATION_LOG_LEVELS, validateApplicationLogFilters } from '../src/application-log.mjs';

function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:'), logger = new ApplicationLog(db, options);
  t.after(() => db.close()); return { db, logger };
}
const rows = db => db.prepare('SELECT * FROM application_logs ORDER BY id').all();

test('the five levels have a stable threshold and preserve only admitted metadata', t => {
  const { logger } = fixture(t);
  assert.deepEqual(APPLICATION_LOG_LEVELS, ['debug', 'info', 'warn', 'error', 'fatal']);
  assert.equal(logger.debug('assistant.step', { stage: 'inspect' }), null);
  for (const level of APPLICATION_LOG_LEVELS.slice(1)) assert.equal(logger[level]('workflow.run', { component: 'workflow.runner', workflowId: 'workflow-a', runId: 'run-a', status: 'running', count: 1 }).level, level);
  const result = logger.read();
  assert.equal(result.enabledLevel, 'info'); assert.equal(result.persistence.filtered, 1);
  assert.deepEqual(result.entries.map(row => row.level), ['info', 'warn', 'error', 'fatal']);
  assert.equal(result.entries[0].component, 'workflow.runner'); assert.equal(result.entries[0].context.workflowId, 'workflow-a');
  const debug = new ApplicationLog(logger.db, { level: 'debug' });
  assert.equal(debug.debug('assistant.step', { stage: 'inspect' }).level, 'debug');
});

test('durable IDs and boot identities survive reopening the same isolated database', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'application-log-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'logs.sqlite'), firstDb = new DatabaseSync(path), first = new ApplicationLog(firstDb);
  const original = first.info('application.start', { component: 'application' }); first.close(); firstDb.close();
  const nextDb = new DatabaseSync(path); t.after(() => nextDb.close()); const next = new ApplicationLog(nextDb);
  const second = next.info('application.start', { component: 'application' });
  assert(second.id > original.id); assert.notEqual(second.bootId, original.bootId);
  assert.deepEqual(next.read({ afterId: 0 }).entries.map(row => row.id), [original.id, second.id]);
});

test('forward cursors, severity, identity, component and inclusive date filters use the same admitted rows', t => {
  let now = new Date('2026-10-27T01:00:00Z'); const { logger } = fixture(t, { level: 'debug', now: () => now });
  const first = logger.info('http.request', { component: 'http', requestId: 'request-one', workflowId: 'workflow-a' });
  now = new Date('2026-10-27T01:01:00Z'); const second = logger.warn('workflow.wait', { component: 'workflow', workflowId: 'workflow-a', runId: 'run-a' });
  now = new Date('2026-10-27T01:02:00Z'); const third = logger.error('workflow.failed', { component: 'workflow', workflowId: 'workflow-b', runId: 'run-b' });
  now = new Date('2026-10-27T01:03:00Z'); logger.debug('assistant.stage', { component: 'assistant', turnId: 'turn-one' });
  const page = logger.read({ afterId: 0, limit: 2 });
  assert.deepEqual(page.entries.map(row => row.id), [first.id, second.id]); assert.equal(page.hasMore, true); assert.equal(page.direction, 'forward');
  assert.equal(page.nextAfterId, second.id);
  assert.deepEqual(logger.read({ afterId: page.nextAfterId, minLevel: 'error' }).entries.map(row => row.id), [third.id]);
  assert.deepEqual(logger.read({ component: 'workflow', workflowId: 'workflow-a', minLevel: 'warn' }).entries.map(row => row.id), [second.id]);
  assert.deepEqual(logger.read({ requestId: 'request-one' }).entries.map(row => row.id), [first.id]);
  assert.deepEqual(logger.read({ turnId: 'turn-one' }).entries.map(row => row.level), ['debug']);
  assert.deepEqual(logger.read({ from: '2026-10-27T09:01:00+08:00', to: '2026-10-27T01:02:00Z' }).entries.map(row => row.id), [second.id, third.id]);
  const tail = logger.read({ limit: 2 }); assert.deepEqual(tail.entries.map(row => row.id), [third.id, 4]); assert.equal(tail.direction, 'latest');
});

test('unknown fields, credentials, prompts, arbitrary objects and accessors never enter persistent logs', t => {
  const { logger, db } = fixture(t, { level: 'debug' }); let reads = 0;
  const values = { component: 'assistant', workflowId: 'workflow-a', status: 'password=SHOULD_NOT_PERSIST',
    code: 'sk-shouldnotpersistsecret12345', errorCode: 'ETIMEDOUT', errorName: 'TimeoutError',
    model: 'eyJabcdefghi.abcdefghijkl.abcdefghijklm', provider: 'Bearer SHOULD_NOT_PERSIST', tool: 'token=SHOULD_NOT_PERSIST',
    route: '/api/workflow-runs?access_token=SHOULD_NOT_PERSIST#secret', method: 'POST', durationMs: 25,
    prompt: 'PRIVATE_PROMPT', text: 'PRIVATE_CHAT', messages: [{ content: 'PRIVATE_CHAT' }], input: 'PRIVATE_INPUT', output: 'PRIVATE_OUTPUT',
    path: '/private/fixture-source', error: Error('PRIVATE_ERROR'), stack: 'PRIVATE_STACK', message: 'PRIVATE_MESSAGE',
    password: 'SHOULD_NOT_PERSIST', token: 'SHOULD_NOT_PERSIST', apiKey: 'SHOULD_NOT_PERSIST', get stage() { reads++; return 'SECRET_GETTER'; } };
  values.context = values;
  assert(logger.error('assistant.failed', values)); assert.equal(reads, 0);
  const serialized = JSON.stringify({ stored: rows(db), returned: logger.read() });
  for (const forbidden of ['SHOULD_NOT_PERSIST', 'shouldnotpersist', 'PRIVATE_', 'SECRET_GETTER', 'eyJabcdefghi', '/private/fixture-source']) assert.equal(serialized.includes(forbidden), false, forbidden);
  assert.match(serialized, /ETIMEDOUT/); assert.match(serialized, /TimeoutError/);
  assert.equal(logger.read().entries[0].context.route, '/api/workflow-runs');
  assert.equal(logger.warn('http.request', { route: '/api/[unmatched]' }).context.route, '/api/[unmatched]');
  assert.equal(logger.warn('http.request', { route: '/api/workflows/:workflowId' }).context.route, '/api/workflows/:workflowId');
  assert.equal(logger.write('info', 'not a stable user sentence'), null);
  assert.equal(logger.write('info', 'sk-thisisnotasafelogevent'), null);
  const unsafeComponent = logger.info('application.start', { component: 'sk-thisisnotasafecomponent' }); assert.equal(unsafeComponent.component, 'application');
  assert.equal(logger.write('info', 'workflow.failed', { get component() { reads++; return 'PRIVATE'; } }).component, 'workflow'); assert.equal(reads, 0);
});

test('read applies the allowlist again to stored context and never writes or prunes history', t => {
  let now = new Date('2026-10-20T01:00:00Z'); const { logger, db } = fixture(t, { now: () => now, maxAgeDays: 1 });
  const first = logger.info('workflow.saved', { workflowId: 'workflow-a' });
  db.prepare('UPDATE application_logs SET context=? WHERE id=?').run(JSON.stringify({ workflowId: 'workflow-a', prompt: 'PRIVATE_OLD_PROMPT', status: 'secret=PRIVATE_SECRET' }), first.id);
  const before = rows(db); assert.deepEqual(logger.read().entries[0].context, { workflowId: 'workflow-a' }); assert.deepEqual(rows(db), before);
  db.prepare('UPDATE application_logs SET boot_id=? WHERE id=?').run('sk-corruptedstoredcredential', first.id);
  assert.deepEqual(logger.read().entries, []);
  db.prepare('UPDATE application_logs SET boot_id=? WHERE id=?').run(first.bootId, first.id);
  const stored = rows(db);
  now = new Date('2026-10-23T01:00:00Z'); assert.deepEqual(logger.read().entries, []); assert.deepEqual(rows(db), stored);
});

test('source locations keep relative application files while excluding private, absolute and traversing paths', t => {
  const { logger } = fixture(t);
  const location = logger.error('application.failed', { file: 'src/application.mjs', line: 42, column: 17, functionName: 'Application.connect' });
  assert.deepEqual(location.context, { functionName: 'Application.connect', line: 42, column: 17, file: 'src/application.mjs' });
  const windows = logger.error('application.failed', { file: 'src\\application.mjs', line: 42 }); assert.equal(windows.context.file, 'src/application.mjs');
  for (const file of ['/private/fixture-source.mjs', 'C:\\private\\source.mjs', '../src/application.mjs', 'src/../private.mjs', 'src/./private.mjs',
    'workflow/private.mjs', 'src/.env', 'src/secret.json', 'src/application.mjs?token=PRIVATE']) {
    assert.equal(Object.hasOwn(logger.error('application.failed', { file }).context, 'file'), false, file);
  }
  const invalid = logger.error('application.failed', { line: -1, column: Infinity, functionName: 'private token=SECRET' }); assert.deepEqual(invalid.context, {});
  assert.deepEqual(logger.error('application.failed', { line: 1.5, column: 2.5 }).context, {});
});

test('count retention evicts only old log entries and reports a lost cursor without reusing IDs', t => {
  const { logger, db } = fixture(t, { maxEntries: 2 }); db.exec('CREATE TABLE business(id TEXT PRIMARY KEY,value TEXT); INSERT INTO business VALUES(\'preserve\',\'ORIGINAL\')');
  const first = logger.info('application.start'); logger.info('workflow.saved'); logger.warn('workflow.wait'); const last = logger.error('workflow.failed');
  const result = logger.read({ afterId: first.id });
  assert.deepEqual(result.entries.map(row => row.id), [3, last.id]); assert.equal(result.cursorExpired, true); assert.equal(result.truncated, true);
  assert.equal(result.oldestId, 3); assert.equal(result.latestId, 4); assert.equal(rows(db).length, 2);
  assert.equal(db.prepare('SELECT value FROM business WHERE id=?').get('preserve').value, 'ORIGINAL');
});

test('byte and age retention remain bounded on writes and on a new logger', t => {
  let now = new Date('2026-10-20T01:00:00Z'); const { logger, db } = fixture(t, { maxEntries: 1000, maxBytes: 1100, maxAgeDays: 2, now: () => now });
  for (let i = 0; i < 20; i++) logger.info('workflow.saved', { workflowId: 'workflow-' + i, model: 'x'.repeat(175), requestId: 'request-' + i });
  assert(db.prepare('SELECT sum(bytes) total FROM application_logs').get().total <= 1100); assert(rows(db).length < 20);
  const previousLast = rows(db).at(-1).id; now = new Date('2026-10-23T01:00:00Z');
  const fresh = new ApplicationLog(db, { maxAgeDays: 2, now: () => now }); assert.equal(rows(db).length, 0);
  assert(fresh.info('application.start').id > previousLast);
});

test('an oversized line is bounded independently of total retention without losing the diagnostic event', t => {
  const { logger, db } = fixture(t, { maxBytes: 100000 });
  const values = Object.fromEntries(['workflowId', 'runId', 'nodeId', 'sessionId', 'conversationId', 'turnId', 'requestId', 'operationId', 'learningId', 'scheduleId', 'attemptId',
    'stage', 'phase', 'status', 'code', 'errorType', 'errorName', 'errorCode', 'model', 'provider', 'tool', 'mode', 'source', 'reason'].map(key => [key, 'x'.repeat(128)]));
  const entry = logger.info('workflow.diagnostic', values); assert(entry); assert.equal(entry.event, 'workflow.diagnostic');
  assert(db.prepare('SELECT bytes FROM application_logs').get().bytes <= 4096);
  assert(Buffer.byteLength(JSON.stringify(entry), 'utf8') <= 4096);
  const longEvent = logger.info('x'.repeat(96)); assert(longEvent); assert.equal(logger.read().entries.at(-1).event, 'x'.repeat(96));
});

test('filter validation rejects unsafe values before any database access and keeps omitted cursor semantics', t => {
  assert.deepEqual(validateApplicationLogFilters({}), { limit: 40 });
  assert.deepEqual(validateApplicationLogFilters({ afterId: 0, from: '2026-10-27T08:00:00+08:00' }), { limit: 40, afterId: 0, from: '2026-10-27T00:00:00.000Z' });
  let reads = 0;
  for (const input of [null, [], 'x', { path: '/private' }, { minLevel: 'trace' }, { limit: 0 }, { limit: 101 }, { afterId: -1 }, { afterId: 1.5 },
    { component: '../secret' }, { workflowId: 'x OR 1=1' }, { from: 'yesterday' }, { to: '2026-10-27' }, { from: '2026-02-30T00:00:00Z' },
    { from: '2026-02-29T00:00:00Z' }, { from: '2026-10-27T24:00:00Z' }, { from: '2026-10-28T00:00:00Z', to: '2026-10-27T00:00:00Z' },
    { get limit() { reads++; return 1; } }, { [Symbol('private')]: 1 }]) assert.throws(() => validateApplicationLogFilters(input), { httpStatus: 400 });
  assert.equal(reads, 0); const { logger, db } = fixture(t); const before = rows(db);
  const dangerous = { toString() { reads++; throw Error('must not evaluate'); } };
  assert.throws(() => logger.read({ minLevel: dangerous }), { httpStatus: 400 }); assert.equal(logger.write(dangerous, 'application.start'), null); assert.equal(reads, 0);
  assert.throws(() => logger.read({ arbitrary: true }), { httpStatus: 400 }); assert.deepEqual(rows(db), before);
});

test('logging failures, closing and nested transactions cannot change a business outcome', t => {
  const { logger, db } = fixture(t); db.exec('CREATE TABLE business(id INTEGER PRIMARY KEY,value TEXT)');
  db.exec('BEGIN'); db.prepare('INSERT INTO business(value) VALUES(?)').run('committed');
  assert(logger.info('workflow.saved', { workflowId: 'workflow-a' })); db.exec('COMMIT');
  assert.equal(db.prepare('SELECT value FROM business').get().value, 'committed');
  db.exec('DROP TABLE application_logs'); assert.doesNotThrow(() => logger.error('workflow.failed')); assert.equal(logger.read().persistence.available, false);
  assert.equal(db.prepare('SELECT value FROM business').get().value, 'committed');
  const closed = fixture(t).logger; closed.close(); assert.equal(closed.info('application.closed'), null); assert.equal(closed.read().persistence.closed, true);
  const unavailable = new ApplicationLog({ exec() { throw Error('PRIVATE_STORAGE_SECRET'); } });
  assert.equal(unavailable.info('application.start'), null); assert.equal(unavailable.read().persistence.available, false);
  assert.equal(JSON.stringify(unavailable.read()).includes('PRIVATE_STORAGE_SECRET'), false);
});
