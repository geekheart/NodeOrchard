import test from 'node:test';
import assert from 'node:assert/strict';
import { SourceRepairUI } from '../public/source-repair-ui.js';

class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.listeners = {}; this.attributes = {}; this.textContent = ''; this.open = false; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  set innerHTML(_value) { assert.fail('Repair metadata must use textContent, never HTML'); }
}
const all = node => [node, ...node.children.flatMap(all)];
const texts = node => all(node).map(child => child.textContent || '').join('\n');
const record = (id = 'repair-one', extra = {}) => ({ id, summary: '修复代理继承', status: 'applied', createdAt: '2026-10-28T01:00:00Z', updatedAt: '2026-10-28T01:01:00Z',
  backupStatus: 'available', files: [{ path: 'src/hermes-adapter.mjs', beforeHash: 'a'.repeat(64), afterHash: 'b'.repeat(64) }],
  tests: [{ status: 'passed', files: ['test/hermes-system-proxy.test.mjs'], exitCode: 0, durationMs: 123 }], ...extra });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(t, api, { readOnly = false, storage = new Map() } = {}) {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document'), previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'), root = new Element();
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { getElementById: id => id === 'source-repair-records' ? root : null, createElement: tag => new Element(tag) } });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } });
  t.after(() => { for (const [key, before] of [['document', previousDocument], ['sessionStorage', previousStorage]]) before ? Object.defineProperty(globalThis, key, before) : delete globalThis[key]; });
  const context = { csrfToken: 'fixture' }, ui = new SourceRepairUI({ api, context: () => context, readOnly });
  return { ui, root, context, storage };
}

test('source repair history reads at most twenty HTTP records and shows real backup, conflict and test metadata as text', async t => {
  const calls = [], rows = Array.from({ length: 25 }, (_, index) => record('repair-' + index, index === 0 ? { summary: '<img src=x onerror=alert(1)>', status: 'conflict' } : {}));
  const { ui, root } = fixture(t, async (path, options) => { calls.push({ path, options }); return { repairs: rows }; });
  assert.equal(calls.length, 0); await ui.refresh(); assert.deepEqual(calls, [{ path: '/api/source-repairs', options: undefined }]);
  assert.equal(ui.repairs.length, 20); const text = texts(root);
  assert.match(text, /<img src=x onerror=alert\(1\)>/); assert.match(text, /冲突/); assert.match(text, /备份.*可用/);
  assert.match(text, /src\/hermes-adapter.mjs/); assert.match(text, /test\/hermes-system-proxy.test.mjs/); assert.match(text, /退出码.*0/); assert.match(text, /123/);
  assert.equal(all(root).filter(node => node.tagName === 'details').length, 20);
});

test('human rollback posts once on an explicit click then refreshes its authoritative receipt', async t => {
  const calls = []; let rolledBack = false;
  const { ui, root } = fixture(t, async (path, options) => {
    calls.push({ path, options }); if (options) { rolledBack = true; return { repair: record('repair-one', { status: 'rolled-back' }) }; }
    return { repairs: [record('repair-one', { status: rolledBack ? 'rolled-back' : 'applied' })] };
  });
  await ui.refresh(); assert.equal(calls.length, 1); await all(root).find(node => node.textContent === '回滚此改动').listeners.click();
  assert.equal(calls[1].path, '/api/source-repairs/repair-one/rollback'); assert.equal(calls[1].options.method, 'POST');
  assert.deepEqual(Object.keys(calls[1].options.body), ['operationId']); assert.match(calls[1].options.body.operationId, /^[a-f\d-]{36}$/i);
  assert.equal(calls[2].path, '/api/source-repairs'); assert.equal(ui.repairs[0].status, 'rolled-back'); assert.match(texts(root), /已回滚/);
  assert.ok(all(root).filter(node => node.tagName === 'button' && /回滚/.test(node.textContent)).every(node => node.disabled));
});

test('an uncertain rollback retry reuses its operation identity even after a panel reload', async t => {
  const calls = [], stored = new Map(); let fail = true;
  const api = async (path, options) => { calls.push({ path, options }); if (options && fail) throw Error('连接中断'); return { repairs: [record()] }; };
  const first = fixture(t, api, { storage: stored }); await first.ui.refresh(); await first.ui.rollback('repair-one');
  const operationId = calls.find(call => call.options)?.options.body.operationId; assert.ok(operationId); assert.match(texts(first.root), /未确认/);
  assert.equal([...stored.values()].join('').includes('src/hermes-adapter.mjs'), false, 'Browser storage keeps IDs only');
  const second = fixture(t, api, { storage: stored }); await second.ui.refresh(); fail = false; await second.ui.rollback('repair-one');
  assert.deepEqual(calls.filter(call => call.options).map(call => call.options.body.operationId), [operationId, operationId]);
  assert.match(texts(second.root), /未确认/, 'An unchanged GET receipt cannot be claimed as a completed rollback');
});

test('busy and duplicate clicks cannot submit extra rollback operations or overlap refresh', async t => {
  const gate = deferred(), calls = []; const { ui, root } = fixture(t, async (path, options) => { calls.push({ path, options }); if (options) await gate.promise; return { repairs: [record()] }; });
  await ui.refresh(); const pending = ui.rollback('repair-one'); await ui.rollback('repair-one'); await ui.refresh();
  assert.equal(calls.filter(call => call.options).length, 1); assert.ok(all(root).filter(node => node.tagName === 'button').every(node => node.disabled));
  gate.resolve(); await pending; assert.equal(calls.filter(call => !call.options).length, 2);
});

test('read-only captures and missing CSRF disable rollback but allow reading records', async t => {
  const calls = [], { ui, root, context } = fixture(t, async (_path, options) => { calls.push(options); return { repairs: [record()] }; }, { readOnly: true });
  await ui.refresh(); assert.match(texts(root), /修复代理继承/); await ui.rollback('repair-one'); assert.deepEqual(calls, [undefined]);
  ui.readOnly = false; context.csrfToken = ''; ui.render(); await ui.rollback('repair-one'); assert.deepEqual(calls, [undefined]);
  assert.ok(all(root).filter(node => node.tagName === 'button' && /回滚/.test(node.textContent)).every(node => node.disabled));
});

test('malformed and oversized metadata is bounded without unsafe IDs or arbitrary HTML', async t => {
  const oversized = record('repair-large', { summary: 'a'.repeat(20000), files: Array.from({ length: 200 }, () => ({ path: 'x'.repeat(20000), beforeHash: 'a'.repeat(64), afterHash: 'b'.repeat(64) })),
    tests: Array.from({ length: 100 }, () => ({ status: 'passed', files: ['x'.repeat(20000)], exitCode: 0, durationMs: 1 })) });
  const { ui, root } = fixture(t, async () => ({ repairs: [{ ...record(), id: '../escape' }, oversized] })); await ui.refresh();
  assert.equal(ui.repairs.length, 1); assert.ok(texts(root).length < 65000); await ui.rollback('../escape');
  assert.equal(ui.repairs[0].id, 'repair-large');
});

test('failed history refresh keeps existing records and reports the error without inventing test success', async t => {
  let fail = false; const { ui, root } = fixture(t, async () => { if (fail) throw Error('读取中断'); return { repairs: [record('repair-one', { backupStatus: 'missing', tests: [{ status: 'unknown', files: [], exitCode: null }] })] }; });
  await ui.refresh(); fail = true; await ui.refresh(); assert.equal(ui.repairs.length, 1); assert.match(texts(root), /读取中断/); assert.match(texts(root), /备份.*缺失/); assert.match(texts(root), /待核对/);
});

test('real service conflict errors survive history reload and test sandbox metadata remains explicit', async t => {
  const repair = record('repair-one', { status: 'applied', backupStatus: 'complete', error: { code: 'SOURCE_ROLLBACK_CONFLICT', message: '源码之后已有修改，未覆盖' },
    tests: [{ status: 'pass', files: ['workbench/test/feature.test.mjs'], exitCode: 0, durationMs: 80, sandbox: { kind: 'macos-seatbelt', status: 'verified' } },
      { status: 'fail', files: [], exitCode: 1, durationMs: 120, sandbox: { kind: 'macos-seatbelt', status: 'unavailable', code: 'sandbox_probe_failed' } },
      { status: 'vendor-pending', files: [], exitCode: null, sandbox: { kind: 'future-sandbox', status: 'vendor-checking' } }] });
  const { ui, root } = fixture(t, async () => ({ repairs: [repair] })); await ui.refresh(); const output = texts(root);
  assert.match(output, /已应用 · 回滚冲突/); assert.match(output, /SOURCE_ROLLBACK_CONFLICT/); assert.match(output, /源码之后已有修改，未覆盖/); assert.match(output, /备份：已完成/);
  assert.match(output, /通过 · 退出码 0/); assert.match(output, /失败 · 退出码 1/); assert.match(output, /沙箱：macos-seatbelt · 已验证/);
  assert.match(output, /沙箱：macos-seatbelt · 不可用 · sandbox_probe_failed/); assert.match(output, /vendor-pending/); assert.match(output, /future-sandbox · vendor-checking/);
});
