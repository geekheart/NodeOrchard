import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ApplicationSourceRepairs } from '../src/application-source-repairs.mjs';
import { AssistantDiagnosticTurn } from '../src/assistant-diagnostic-turn.mjs';

const COMPONENTS = {
  'codex-stream': 'agent/codex_runtime.py',
  'provider-call': 'agent/chat_completion_helpers.py',
  'request-client': 'agent/client_lifecycle.py',
  'client-factory': 'agent/agent_runtime_helpers.py',
  'gateway-output': 'tui_gateway/prompt_turn.py',
};
const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'runtime-sources-')), root = join(directory, 'repo'), hermesRoot = join(directory, 'hermes');
  await mkdir(join(root, 'workbench/src'), { recursive: true });
  await writeFile(join(root, 'workbench/src/feature.mjs'), 'export const fixture = true;');
  for (const [component, path] of Object.entries(COMPONENTS)) {
    await mkdir(dirname(join(hermesRoot, path)), { recursive: true });
    await writeFile(join(hermesRoot, path), '# retrying ' + component + '\nvalue = 1\n');
  }
  const db = new DatabaseSync(':memory:'); let sourceRead = true, sourceRepair = false;
  const app = { config: { projectRoot: root, appRoot: join(root, 'workbench'), dataDir: join(directory, 'data'),
    workspaceRoot: join(directory, 'workspace'), workflowRunRoot: join(directory, 'runs'), hermesRoot }, store: { db },
    assistantPermissionSettings: { get: () => ({ supervisor: { sourceRead, sourceRepair } }) } };
  const service = new ApplicationSourceRepairs(app, { readGitState: async () => ({ tracked: ['workbench/src/feature.mjs'], dirty: [] }) });
  const context = { role: 'supervisor', authorize: async () => true };
  t.after(async () => { await service.close(); db.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, root, hermesRoot, service, context, setSourceRead: value => { sourceRead = value; }, setSourceRepair: value => { sourceRepair = value; } };
}

test('fixed Hermes components return original identity and a safe page without accepting an installation path', async t => {
  const f = await fixture(t);
  for (const [component, path] of Object.entries(COMPONENTS)) {
    const result = await f.service.read({ component }, f.context), original = await readFile(join(f.hermesRoot, path));
    assert.equal(result.origin, 'hermes-installed'); assert.equal(result.component, component); assert.equal(result.path, path);
    assert.equal(result.hash, hash(original)); assert.equal(result.content, original.toString('utf8'));
    assert.equal(result.truncated, false); assert.equal(result.nextStartLine, null);
    assert.equal(JSON.stringify(result).includes(f.directory), false);
  }
  assert.equal((await f.service.read({ path: 'workbench/src/feature.mjs' }, f.context)).content, 'export const fixture = true;');
});

test('component search stays within one fixed module and redacts the whole text before selecting context', async t => {
  const f = await fixture(t), path = COMPONENTS['codex-stream'];
  const content = 'token=PRIVATE_SECRET; ' + 'x'.repeat(300) + ' needle a.*[b]\n';
  await writeFile(join(f.hermesRoot, path), content);
  const result = await f.service.search({ component: 'codex-stream', query: 'needle' }, f.context);
  assert.equal(result.origin, 'hermes-installed'); assert.equal(result.scannedFiles, 1); assert.equal(result.scannedBytes, Buffer.byteLength(content));
  assert.equal(result.matches.length, 1); assert.equal(result.matches[0].line, 1); assert.equal(result.matches[0].hash, hash(content));
  assert.equal(result.matches[0].component, 'codex-stream'); assert.equal(result.matches[0].path, path);
  assert.equal(JSON.stringify(result).includes('PRIVATE_SECRET'), false); assert.equal(JSON.stringify(result).includes(f.directory), false);
  assert.equal((await f.service.search({ component: 'codex-stream', query: 'PRIVATE_SECRET' }, f.context)).matches.length, 0);
  assert.equal((await f.service.search({ component: 'codex-stream', query: 'a.*[b]' }, f.context)).matches.length, 1);
});

test('source-only reasoning tag literals cannot erase a later retry branch or disclose credential examples', async t => {
  const f = await fixture(t), content = '# <REASONING_SCRATCHPAD> -> <think> (a source comment)\nclient_kwargs.setdefault("max_retries", 0)\ntoken=PRIVATE_SECRET\n';
  await writeFile(join(f.hermesRoot, COMPONENTS['client-factory']), content); await writeFile(join(f.root, 'workbench/src/feature.mjs'), content);
  for (const args of [{ component: 'client-factory' }, { path: 'workbench/src/feature.mjs' }]) {
    const page = await f.service.read(args, f.context);
    assert.equal(page.content.includes('max_retries'), true); assert.equal(page.sourceMarkupEscaped, true);
    assert.equal(page.content.includes('&lt;think>'), true); assert.equal(page.content.includes('PRIVATE_SECRET'), false);
    assert.equal(page.hash, hash(content)); assert.equal(page.totalLines, 4);
    const turn = new AssistantDiagnosticTurn({ scope: 'source-tags' }); turn.record('app.source.read', args, page, { cacheable: false });
    assert.equal(turn.transcript()[0].result.content, page.content);
  }
  const found = await f.service.search({ component: 'client-factory', query: '<think>' }, f.context);
  assert.equal(found.matches.length, 1); assert.equal(found.matches[0].line, 1); assert(found.matches[0].context.includes('&lt;think>'));
  assert.equal((await f.service.search({ component: 'client-factory', query: '&lt;think>' }, f.context)).matches.length, 0);
});

test('native component identities are exclusive and cannot become arbitrary reads or writes', async t => {
  const f = await fixture(t);
  for (const input of [{}, { path: '', component: 'codex-stream' }, { path: undefined, component: 'codex-stream' },
    { component: 'unknown' }, { component: '__proto__' }, { component: 'constructor' }, { component: '/agent/codex_runtime.py' },
    { component: 'codex-stream', root: f.hermesRoot }, { path: COMPONENTS['codex-stream'] }, { path: join(f.hermesRoot, COMPONENTS['codex-stream']) }]) {
    await assert.rejects(f.service.read(input, f.context));
  }
  for (const input of [{ query: 'retrying', component: 'codex-stream', prefix: '' }, { query: 'retrying', component: 'codex-stream', prefix: undefined },
    { query: 'retrying', component: 'CODEx-stream' }, { query: 'retrying', component: 'codex-stream', path: '/outside' }]) {
    await assert.rejects(f.service.search(input, f.context));
  }
  const accessor = { get component() { throw Error('ACCESSOR_MUST_NOT_RUN'); } };
  await assert.rejects(f.service.read(accessor, f.context), /字段无效/);
  f.setSourceRepair(true); const repairContext = f.context;
  for (const path of [COMPONENTS['codex-stream'], join(f.hermesRoot, COMPONENTS['codex-stream']), 'workbench/src/application-runtime-sources.mjs']) {
    await assert.rejects(f.service.patch({ operationId: 'block-' + Math.random().toString(36).slice(2), summary: 'Must remain read only',
      changes: [{ path, expectedHash: 'missing', content: 'changed' }] }, repairContext), error => /^SOURCE_PATH_/.test(error.code));
  }
  await assert.rejects(f.service.patch({ operationId: 'block-component', summary: 'Must remain read only', changes: [{ component: 'codex-stream', content: 'changed' }] }, repairContext));
});

test('native source rejects file aliases, linked directories, special text and oversized modules', async t => {
  for (const kind of ['file-link', 'directory-link', 'hard-link', 'nul', 'invalid-utf8', 'oversize']) await t.test(kind, async t => {
    const f = await fixture(t), path = join(f.hermesRoot, COMPONENTS['codex-stream']), outside = join(f.directory, 'outside.py');
    await writeFile(outside, 'PRIVATE_OUTSIDE_MUST_NOT_LEAK');
    if (kind === 'file-link') { await rm(path); await symlink(outside, path); }
    if (kind === 'directory-link') { await rename(join(f.hermesRoot, 'agent'), join(f.directory, 'saved-agent')); await symlink(join(f.directory, 'saved-agent'), join(f.hermesRoot, 'agent')); }
    if (kind === 'hard-link') { await rm(path); await link(outside, path); }
    if (kind === 'nul') await writeFile(path, 'source\0private');
    if (kind === 'invalid-utf8') await writeFile(path, Buffer.from([0xc3, 0x28]));
    if (kind === 'oversize') await writeFile(path, 'x'.repeat(256 * 1024 + 1));
    for (const method of ['read', 'search']) await assert.rejects(f.service[method]({ component: 'codex-stream', ...(method === 'search' ? { query: 'PRIVATE' } : {}) }, f.context),
      error => ['SOURCE_LINK_FORBIDDEN', 'SOURCE_TEXT_INVALID', 'SOURCE_FILE_UNAVAILABLE'].includes(error.code) && !error.message.includes(f.directory));
  });
});

test('native read and search revoke their read grant or abort before returning any partial source', async t => {
  for (const method of ['read', 'search']) {
    const f = await fixture(t), args = { component: 'codex-stream', ...(method === 'search' ? { query: 'retrying' } : {}) }; let checks = 0;
    await assert.rejects(f.service[method](args, { role: 'supervisor', authorize: async () => { if (++checks === 8) f.setSourceRead(false); return true; } }), { code: 'SOURCE_REPAIR_FORBIDDEN' });
    f.setSourceRead(true); checks = 0; const controller = new AbortController();
    await assert.rejects(f.service[method](args, { role: 'supervisor', signal: controller.signal, authorize: async () => { if (++checks === 8) controller.abort(); return true; } }), { code: 'SOURCE_REPAIR_CANCELLED' });
  }
});

test('a directory replaced between inspection and open cannot redirect a native read', async t => {
  const f = await fixture(t), outside = join(f.directory, 'outside'), agent = join(f.hermesRoot, 'agent');
  await mkdir(outside); await writeFile(join(outside, 'codex_runtime.py'), 'PRIVATE_RACE_MUST_NOT_LEAK');
  let checks = 0, replaced = false;
  await assert.rejects(f.service.read({ component: 'codex-stream' }, { role: 'supervisor', authorize: async () => {
    if (++checks === 10) { await rename(agent, join(f.directory, 'saved-agent')); await symlink(outside, agent); replaced = true; }
    return true;
  } }), error => ['SOURCE_RUNTIME_CHANGED', 'SOURCE_LINK_FORBIDDEN'].includes(error.code) && !error.message.includes(f.directory));
  assert.equal(replaced, true);
});

test('native short pages and cursors remain identical after real assistant compaction', async t => {
  const f = await fixture(t), content = 'token=PRIVATE_SECRET;'.repeat(200) + '\n' + '😀'.repeat(1500), path = join(f.hermesRoot, COMPONENTS['codex-stream']);
  await writeFile(path, content); let cursor = { startLine: 1, startColumn: 1 }, pages = 0;
  while (cursor) {
    const args = { component: 'codex-stream', ...cursor }, page = await f.service.read(args, f.context);
    const turn = new AssistantDiagnosticTurn({ scope: 'native-pages' }); turn.record('app.source.read', args, page, { cacheable: false });
    assert.equal(turn.transcript()[0].result.content, page.content); assert(page.content.length <= 1800);
    assert.equal(page.hash, hash(content)); assert.equal(page.content.includes('PRIVATE_SECRET'), false);
    cursor = page.truncated ? { startLine: page.nextStartLine, startColumn: page.nextStartColumn } : null; assert(++pages < 20);
  }
  assert(pages > 1);
});
