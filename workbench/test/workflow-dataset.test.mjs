import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWorkflowDataset, parseWorkflowDataset, summarizeRoundCases, WORKFLOW_DATASET_LIMITS } from '../shared/workflow/workflow-dataset.mjs';

const sample = (input, expected = 'answer', extra = {}) => ({ input, expected, ...extra });

test('dataset normalization preserves typed JSON, stable IDs, names and caller data', () => {
  const input = { trainingCases: [sample(0, false), sample(false, null), sample(null, []), sample([], { answer: 0 })],
    validationCases: [sample({ z: false }, '0')] };
  const before = structuredClone(input), value = normalizeWorkflowDataset(input);
  assert.deepEqual(value.trainingCases.map(item => item.input), [0, false, null, []]);
  assert.deepEqual(value.trainingCases.map(item => item.expected), [false, null, [], { answer: 0 }]);
  assert.deepEqual(value.trainingCases.map(item => item.id), ['train-1', 'train-2', 'train-3', 'train-4']);
  assert.deepEqual(value.validationCases[0], { id: 'validation-1', name: '验证样例 1', input: { z: false }, expected: '0' });
  assert.equal(value.trainingCases[0].name, '训练样例 1');
  assert.deepEqual(input, before);
  assert.deepEqual(normalizeWorkflowDataset(input), value);
  value.trainingCases[3].expected.answer = 9;
  assert.deepEqual(input, before);
});

test('flat arrays default to train and reserve explicitly supplied IDs across splits', () => {
  const value = normalizeWorkflowDataset([sample('one'), sample('two', 0, { id: 'train-1', name: 'Named' }),
    sample('three', false, { split: 'validation' })]);
  assert.deepEqual(value.trainingCases.map(item => item.id), ['train-2', 'train-1']);
  assert.equal(value.trainingCases[1].name, 'Named');
  assert.equal(value.validationCases[0].id, 'validation-1');
  assert.throws(() => normalizeWorkflowDataset([sample('a', 1, { id: 'same' }), sample('b', 2, { split: 'validation', id: 'same' })]), /全局唯一/);
  assert.throws(() => normalizeWorkflowDataset([sample('a', 1, { split: 'test' })]), /split/);
});

test('duplicates compare canonical JSON across splits and distinguish conflicting answers', () => {
  assert.throws(() => normalizeWorkflowDataset({ trainingCases: [sample({ a: 1, nested: { b: false, c: [] } })],
    validationCases: [sample({ nested: { c: [], b: false }, a: 1 })] }), /input 重复.*验证/);
  assert.throws(() => normalizeWorkflowDataset([sample({ b: 2, a: 1 }, 'first'), sample({ a: 1, b: 2 }, 'second')]), /相同 input.*不同答案/);
  const text = normalizeWorkflowDataset([sample('text'), sample(' text'), sample('text\n'), sample('text\r\n'), sample('0'), sample(0)]);
  assert.equal(text.trainingCases.length, 6, 'text bytes and JSON types are not normalized or guessed');
});

test('JSON and JSONL import preserve strings and report the actual source line', () => {
  const value = parseWorkflowDataset('\ufeff' + JSON.stringify([sample('false', '0'), sample(0, false, { split: 'validation' })]));
  assert.equal(value.trainingCases[0].input, 'false');
  assert.equal(value.trainingCases[0].expected, '0');
  assert.equal(value.validationCases[0].input, 0);
  const jsonl = parseWorkflowDataset('\ufeff' + JSON.stringify(sample(false, null)) + '\r\n\r\n' +
    JSON.stringify(sample([], {}, { split: 'validation' })) + '\r\n', 'jsonl');
  assert.equal(jsonl.trainingCases[0].input, false);
  assert.deepEqual(jsonl.validationCases[0].input, []);
  assert.throws(() => parseWorkflowDataset('{"input":1,"expected":2}\n\n{"input":', 'jsonl'), /JSONL 第 3 行/);
  assert.throws(() => parseWorkflowDataset('{"input":1,"expected":2}\n{"input":3,"unexpected":4}', 'jsonl'), /JSONL 第 2 行.*未知字段/);
  assert.throws(() => parseWorkflowDataset('null', 'jsonl'), /JSONL 第 1 行/);
  assert.throws(() => parseWorkflowDataset('[]', 'yaml'), /导入格式/);
  assert.throws(() => parseWorkflowDataset('{'), /JSON 解析失败/);
});

test('CSV handles escaped quotes, commas, physical multiline text, CRLF and BOM', () => {
  const value = parseWorkflowDataset('\ufeffinput,expected,split,id,name\r\n"hello, ""world""","line one\r\nline two",,custom,"a,b"\r\n" 0 ",false,validation,,\r\n', 'csv');
  assert.equal(value.trainingCases[0].input, 'hello, "world"');
  assert.equal(value.trainingCases[0].expected, 'line one\r\nline two');
  assert.equal(value.trainingCases[0].id, 'custom');
  assert.equal(value.trainingCases[0].name, 'a,b');
  assert.equal(value.validationCases[0].input, ' 0 ');
  assert.equal(value.validationCases[0].expected, 'false');
});

test('CSV converts only explicitly JSON-formatted cells, including false, zero, null and arrays', () => {
  const value = parseWorkflowDataset('input,expected,input_format,expected_format,split\n0,false,json,json,train\nnull,[],json,json,validation\n"""0""",null,json,text,train', 'csv');
  assert.equal(value.trainingCases[0].input, 0);
  assert.equal(value.trainingCases[0].expected, false);
  assert.equal(value.validationCases[0].input, null);
  assert.deepEqual(value.validationCases[0].expected, []);
  assert.equal(value.trainingCases[1].input, '0');
  assert.equal(value.trainingCases[1].expected, 'null');
  assert.throws(() => parseWorkflowDataset('input,expected,input_format\nx,y,number', 'csv'), /第 2 行.*input_format/);
  assert.throws(() => parseWorkflowDataset('input,expected,expected_format\nx,not-json,json', 'csv'), /第 2 行.*expected.*JSON/);
});

test('CSV rejects duplicate/unknown/missing headers, malformed quoting and incorrect columns with line numbers', () => {
  const invalid = [
    ['input,input,expected\nx,y,z', /第 1 行.*重复/],
    ['input,expected,command\nx,y,z', /第 1 行.*未知字段/],
    ['input,name\nx,y', /第 1 行.*input.*expected/],
    ['input,expected\nx,y,z', /第 2 行.*列数/],
    ['input,expected\n"one\ntwo",answer\nlast', /第 4 行.*列数/],
    ['input,expected\n"not\nclosed,answer', /第 3 行.*引号未闭合.*第 2 行/],
    ['input,expected\n"a"garbage,b', /第 2 行.*结束引号/],
    ['input,expected\na"b,c', /第 2 行.*引号/],
    ['input,expected,split\na,b,test', /第 2 行.*split/],
  ];
  for (const [text, error] of invalid) assert.throws(() => parseWorkflowDataset(text, 'csv'), error);
});

test('CSV and JSONL semantic errors retain physical source lines, including leakage across splits', () => {
  assert.throws(() => parseWorkflowDataset('input,expected,split\n"first\nline",one,train\n"first\nline",two,validation', 'csv'), /CSV 第 4 行.*第 2 行.*不同答案/);
  assert.throws(() => parseWorkflowDataset('input,expected,name\none,two,' + 'x'.repeat(121), 'csv'), /CSV 第 2 行.*名称/);
  assert.throws(() => parseWorkflowDataset('input,expected,id\none,two,same\nthree,four,same', 'csv'), /CSV 第 3 行.*id.*第 2 行/);
  const lines = [sample({ a: 1, b: 2 }), sample({ b: 2, a: 1 }, 'answer', { split: 'validation' })].map(JSON.stringify);
  assert.throws(() => parseWorkflowDataset(lines.join('\n\n'), 'jsonl'), /JSONL 第 3 行.*第 1 行.*重复输入/);
});

test('explicit preview options allow empty training without weakening duplicate, size or shape validation', () => {
  const preview = { requireTraining: false };
  assert.deepEqual(normalizeWorkflowDataset({ trainingCases: [], validationCases: [] }, preview), { trainingCases: [], validationCases: [] });
  const value = parseWorkflowDataset('[{"split":"validation","input":false,"expected":0}]', 'json', preview);
  assert.equal(value.trainingCases.length, 0);
  assert.equal(value.validationCases[0].id, 'validation-1');
  assert.throws(() => normalizeWorkflowDataset(value), /至少需要 1 条训练/);
  assert.throws(() => normalizeWorkflowDataset({ trainingCases: [], validationCases: [sample(0), sample(0)] }, preview), /重复/);
  assert.throws(() => normalizeWorkflowDataset({ trainingCases: [], validationCases: [sample('x'.repeat(65535))] }, preview), /64 KiB/);
  assert.throws(() => normalizeWorkflowDataset({ train: [] }, preview), /未知字段/);
  assert.throws(() => normalizeWorkflowDataset([], { requireTraining: 'false' }), /布尔值/);
});

test('dataset limits enforce count, UTF8 byte budgets, names and IDs before returning a result', () => {
  assert.equal(WORKFLOW_DATASET_LIMITS.cases, 20);
  assert.equal(normalizeWorkflowDataset(Array.from({ length: 20 }, (_, index) => sample(index))).trainingCases.length, 20);
  assert.throws(() => normalizeWorkflowDataset(Array.from({ length: 21 }, (_, index) => sample(index))), /20 条/);
  assert.throws(() => normalizeWorkflowDataset({ trainingCases: [], validationCases: [sample(1)] }), /至少需要 1 条训练/);
  assert.throws(() => normalizeWorkflowDataset([sample(1, 2, { name: 'x'.repeat(121) })]), /名称/);
  assert.throws(() => normalizeWorkflowDataset([sample(1, 2, { id: 'x'.repeat(129) })]), /id/);
  assert.throws(() => normalizeWorkflowDataset([sample('中'.repeat(22000))]), /64 KiB/);
  assert.throws(() => normalizeWorkflowDataset(Array.from({ length: 5 }, (_, index) => sample(index, 'x'.repeat(60000)))), /256 KiB/);
  assert.throws(() => parseWorkflowDataset(' '.repeat(256 * 1024 + 1)), /256 KiB/);
  const bounded = normalizeWorkflowDataset([sample('x'.repeat(65534))]);
  assert.equal(bounded.trainingCases[0].input.length, 65534);
});

test('normalization rejects unknown structure and non-JSON values without executing getters or changing input', () => {
  let reads = 0;
  const getter = { get value() { reads++; return 'secret'; } };
  const hole = new Array(1), extra = []; extra.note = 'lost by JSON';
  const cycle = {}; cycle.self = cycle;
  for (const value of [undefined, NaN, Infinity, 1n, new Date(), hole, extra, cycle, getter]) {
    assert.throws(() => normalizeWorkflowDataset([sample(value)]));
  }
  assert.equal(reads, 0);
  assert.throws(() => normalizeWorkflowDataset({ trainingCases: [sample(1)], extra: [] }), /未知字段/);
  assert.throws(() => normalizeWorkflowDataset([sample(1, 2, { role: 'train' })]), /未知字段/);
  assert.throws(() => normalizeWorkflowDataset([{ input: 1 }]), /input.*expected/);
  const source = [sample('same'), sample('same')], before = structuredClone(source);
  assert.throws(() => normalizeWorkflowDataset(source), /重复/);
  assert.deepEqual(source, before);
  const prototypeInput = JSON.parse('{"__proto__":{"polluted":true},"constructor":"literal"}');
  assert.deepEqual(normalizeWorkflowDataset([sample(prototypeInput)]).trainingCases[0].input, prototypeInput);
  assert.equal({}.polluted, undefined);
});

test('round summaries include missing expected cases and keep incomplete pass rates unavailable', () => {
  const expected = normalizeWorkflowDataset({ trainingCases: [sample(1), sample(2)], validationCases: [sample(3)] });
  const cases = [{ id: 'train-1', role: 'train', status: 'complete', output: false, score: 95 }];
  const result = summarizeRoundCases(cases, 90, expected);
  assert.deepEqual(result.train, { total: 2, passed: 1, failed: 0, pending: 1, evaluated: 1,
    passRate: null, averageScore: 95, minScore: 95 });
  assert.equal(result.validation.total, 1);
  assert.equal(result.validation.pending, 1);
  assert.equal(result.validation.averageScore, null);
  assert.equal(result.overall.total, 3);
  assert.equal(result.overall.passRate, null);
  assert.deepEqual(cases, [{ id: 'train-1', role: 'train', status: 'complete', output: false, score: 95 }]);
});

test('completed round summaries compute per-split rates and count failed or absent outputs as zero', () => {
  const value = summarizeRoundCases([
    { id: 'a', role: 'train', status: 'complete', output: 0, score: 100 },
    { id: 'b', role: 'train', status: 'complete', score: 100 },
    { id: 'c', role: 'validation', status: 'error', output: 'untrusted partial', score: 100 },
    { id: 'd', role: 'validation', status: 'complete', output: null, score: 80 },
  ], 80);
  assert.deepEqual(value.train, { total: 2, passed: 1, failed: 1, pending: 0, evaluated: 2,
    passRate: 0.5, averageScore: 50, minScore: 0 });
  assert.equal(value.validation.passRate, 0.5);
  assert.equal(value.validation.averageScore, 40);
  assert.equal(value.overall.passed, 2);
  assert.equal(value.overall.failed, 2);
  assert.equal(value.overall.passRate, 0.5);
  assert.equal(value.overall.averageScore, 45);
});

test('interrupted, unknown, skipped and unscored successful cases remain pending; empty validation is N/A', () => {
  const result = summarizeRoundCases([
    { status: 'interrupted', output: 'partial', score: 100 },
    { status: 'unknown', output: 'unconfirmed', score: 100 },
    { status: 'skipped', score: 100 },
    { status: 'complete', output: [] },
    { status: 'running', output: false, score: 100 },
  ]);
  assert.equal(result.train.pending, 5);
  assert.equal(result.train.failed, 0);
  assert.equal(result.overall.passRate, null);
  assert.deepEqual(result.validation, { total: 0, passed: 0, failed: 0, pending: 0, evaluated: 0,
    passRate: null, averageScore: null, minScore: null });
  assert.equal(summarizeRoundCases([]).overall.passRate, null);
});

test('round matching follows stable IDs rather than order and rejects foreign or duplicate cases', () => {
  const expected = [{ id: 'first', role: 'train' }, { id: 'heldout', role: 'validation' }];
  const cases = [{ id: 'heldout', role: 'validation', status: 'complete', output: [], score: 100 },
    { id: 'first', role: 'train', status: 'complete', output: null, score: 90 }];
  const result = summarizeRoundCases(cases, 90, expected);
  assert.equal(result.overall.passRate, 1);
  assert.equal(result.overall.averageScore, 95);
  assert.throws(() => summarizeRoundCases([...cases, cases[0]], 90, expected), /id 重复/);
  assert.throws(() => summarizeRoundCases([{ id: 'foreign', status: 'complete', output: 1, score: 100 }], 90, expected), /不属于/);
  assert.throws(() => summarizeRoundCases([{ ...cases[0], role: 'train' }], 90, expected), /不属于/);
  assert.throws(() => summarizeRoundCases([], Infinity), /目标分数/);
});

test('legacy round cases without IDs use per-split position, including explicit expected IDs', () => {
  const expected = [{ id: 'train-custom', role: 'train' }, { id: 'validation-custom', role: 'validation' },
    { id: 'train-next', role: 'train' }];
  const value = summarizeRoundCases([
    { role: 'train', status: 'complete', output: false, score: 100 },
    { role: 'validation', status: 'complete', output: [], score: 90 },
    { role: 'train', status: 'complete', output: 0, score: 80 },
  ], 90, expected);
  assert.equal(value.overall.total, 3);
  assert.equal(value.overall.pending, 0);
  assert.equal(value.overall.passRate, 2 / 3);
  assert.equal(value.validation.passRate, 1);
});
