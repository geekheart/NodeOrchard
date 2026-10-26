import test from 'node:test';
import assert from 'node:assert/strict';
import { DIAGNOSTIC_LIMITS, diagnosticEvent, appendDiagnosticEvent, formatDiagnosticEvent } from '../shared/diagnostics.mjs';
import { diagnosticDetails } from '../public/diagnostic-events.js';

test('large workflow diagnostics are bounded and redacted while the live event stays unchanged', () => {
  const output = 'large fixture '.repeat(80_000), event = { id: 17, type: 'workflow.run', sessionId: 'session',
    payload: { status: 'running', currentNodeId: 'build', api_key: 'private-key-fixture', output }, at: '2026-01-01T00:00:00Z' };
  const record = diagnosticEvent(event), formatted = formatDiagnosticEvent(record);
  assert.equal(event.payload.output, output); assert.equal(event.payload.api_key, 'private-key-fixture');
  assert.equal(record.at, event.at); assert.match(record.summary, /running.*build/);
  assert.ok(record.preview.truncated); assert.match(formatted, /诊断预览已截断/);
  assert.ok(Buffer.byteLength(formatted) <= DIAGNOSTIC_LIMITS.eventBytes);
  assert.ok(!formatted.includes('private-key-fixture')); assert.match(formatted, /已隐藏/);
  assert.ok(record.preview.value.payload.output.length < 2200);
});

test('deep, circular, binary and data URL values are summarized without invoking accessors', () => {
  let nested = { end: 'deep fixture' }; for (let index = 0; index < 50; index++) nested = { child: nested };
  const payload = { nested, binary: new Uint8Array(1024 * 1024), image: 'data:image/png;base64,' + 'A'.repeat(100_000) };
  payload.self = payload;
  Object.defineProperty(payload, 'getter', { enumerable: true, get() { throw Error('must not execute a getter'); } });
  const record = diagnosticEvent({ type: 'fixture', payload });
  const text = formatDiagnosticEvent(record);
  assert.match(text, /嵌套层级上限/); assert.match(text, /二进制/); assert.match(text, /循环或重复引用/);
  assert.match(text, /未读取访问器/); assert.ok(!text.includes('A'.repeat(100)));
  assert.ok(Buffer.byteLength(text) <= DIAGNOSTIC_LIMITS.eventBytes);
});

test('many multibyte fields and broad arrays fit the diagnostic byte limit', () => {
  const sharedText = '测试😀'.repeat(1000);
  const payload = Array.from({ length: 5000 }, (_, index) => ({ index, text: sharedText }));
  const record = diagnosticEvent({ type: 'fixture', payload });
  const text = formatDiagnosticEvent(record);
  assert.ok(Buffer.byteLength(text) <= DIAGNOSTIC_LIMITS.eventBytes);
  assert.match(text, /截断/); assert.ok(!text.includes('\uFFFD'));
  assert.equal(payload.length, 5000); assert.equal(payload[0].text.length, 4000);
});

test('the diagnostic ring obeys count and total retained-byte limits without retaining raw events', () => {
  let events = [];
  const payload = { fields: Array.from({ length: 35 }, () => 'bounded fixture '.repeat(200)) };
  for (let id = 0; id < 260; id++) events = appendDiagnosticEvent(events, { id, type: 'workflow.run', payload });
  assert.ok(events.length <= DIAGNOSTIC_LIMITS.eventCount);
  assert.ok(events.reduce((total, event) => total + event.preview.retainedBytes, 0) <= DIAGNOSTIC_LIMITS.bufferBytes);
  assert.equal(events.at(-1).id, 259); assert.notEqual(events.at(-1).preview.value.payload, payload);
});

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.listeners = {}; this.open = false; }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
}
test('collapsed events allocate no pre and format lazily once per expansion, removing hidden body on collapse', () => {
  const document = { createElement: tag => new Element(tag) }, record = diagnosticEvent({ id: 1, type: 'fixture', payload: { value: 3 } });
  let formatted = 0;
  const detail = diagnosticDetails(record, { document, format: () => { formatted++; return 'small diagnostic'; } });
  assert.equal(formatted, 0); assert.deepEqual(detail.children.map(child => child.tagName), ['summary']);
  detail.open = true; detail.listeners.toggle(); detail.listeners.toggle();
  assert.equal(formatted, 1); assert.equal(detail.children[1].textContent, 'small diagnostic');
  detail.open = false; detail.listeners.toggle();
  assert.deepEqual(detail.children.map(child => child.tagName), ['summary']);
  detail.open = true; detail.listeners.toggle(); assert.equal(formatted, 2);
});
