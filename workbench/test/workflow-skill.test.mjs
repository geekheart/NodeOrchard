import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareSkillRun } from '../src/workflows/workflow-skill.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const policy = { skillMutationBlocked: true, memoryAllowed: true, freeze: 'bundle-copy' };
const capabilityRevision = 'sha256:' + 'c'.repeat(64);

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'workflow-skill-bridge-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const content = '---\nname: fixture-skill\n---\nReturn the requested result.\n';
  const revision = `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
  const calls = [];
  const app = {
    config: { dataDir },
    skill: () => { throw new Error('Binding must never reload live Skills.'); },
    adapter: {
      async request(method, params) {
        calls.push([method, copy(params)]);
        if (app.onRequest) {
          const result = await app.onRequest(method, params);
          if (result !== undefined) return result;
        }
        if (method === 'workbench.skill.prepare') return {
          text: `native prepared ${params.run_id}: ${JSON.stringify(params.input)}`,
          skill: { name: params.skill, revision: params.revision,
            ...(params.source_revision ? { sourceRevision: params.source_revision } : {}) }, policy,
          snapshot: { directory: `/fixture/.workbench-skills/${params.run_id}`,
            bundleHash: `sha256:${'b'.repeat(64)}`, sourceBundleHash: `sha256:${'b'.repeat(64)}` },
        };
        if (method === 'workbench.skill.input') return { text: `native bound ${params.run_id}: ${JSON.stringify(params.input)}` };
        if (method === 'workbench.skill.finish') return { unchanged: true, snapshotIntact: true };
        throw new Error(`Unexpected RPC: ${method}`);
      },
    },
  };
  return { app, calls, dataDir, skill: { name: 'fixture-skill', source: 'local', content, revision },
    session: { runtimeSessionId: 'runtime-first' },
    options: { input: null, skillNode: { id: 'skill-first', config: { version: revision, outputType: 'object' } }, runId: randomUUID() } };
}

test('each Skill step gets a distinct RPC snapshot and per-node metadata under one workflow run', async t => {
  const { app, calls, dataDir, skill, session, options } = await fixture(t);
  const firstId = randomUUID();
  const secondId = randomUUID();
  const first = await prepareSkillRun(app, session, skill, { ...options, stepId: firstId, nodeId: 'first-skill' });
  const second = await prepareSkillRun(app, { runtimeSessionId: 'runtime-second' }, skill,
    { ...options, stepId: secondId, nodeId: 'second-skill' });
  assert.equal(calls[0][1].run_id, firstId);
  assert.equal(calls[1][1].run_id, secondId);
  assert.notEqual(first.skill.snapshotDirectory, second.skill.snapshotDirectory);
  const metadata = nodeId => readFile(join(dataDir, 'workflow-snapshots', options.runId, 'nodes', nodeId, 'skill.json'), 'utf8').then(JSON.parse);
  const firstMetadata = await metadata('first-skill');
  const secondMetadata = await metadata('second-skill');
  assert.equal(firstMetadata.stepId, firstId);
  assert.equal(secondMetadata.stepId, secondId);
  assert.equal(firstMetadata.runId, options.runId);
  assert.equal(firstMetadata.content, skill.content);
  await assert.rejects(readFile(join(dataDir, 'workflow-snapshots', options.runId, 'skill.json')), { code: 'ENOENT' });
  const firstInput = { onlyFirst: true, false: false, zero: 0, null: null };
  const secondInput = { onlySecond: [false, 0, null] };
  assert.match((await first.bindInput(firstInput)).text, /onlyFirst/);
  assert.match((await second.bindInput(secondInput)).text, /onlySecond/);
  assert.deepEqual(calls[2], ['workbench.skill.input', { session_id: 'runtime-first', run_id: firstId, input: firstInput, output_type: 'object' }]);
  assert.deepEqual(calls[3], ['workbench.skill.input', { session_id: 'runtime-second', run_id: secondId, input: secondInput, output_type: 'object' }]);
  await first.cleanup();
  await second.cleanup();
  assert.deepEqual(calls.slice(-2).map(call => call[1].run_id), [firstId, secondId]);
});

test('legacy single-step preparation keeps its original metadata path and run identity', async t => {
  const { app, calls, dataDir, skill, session, options } = await fixture(t);
  const prepared = await prepareSkillRun(app, session, skill, options);
  const metadata = JSON.parse(await readFile(join(dataDir, 'workflow-snapshots', options.runId, 'skill.json'), 'utf8'));
  assert.equal(metadata.name, skill.name);
  assert.equal(metadata.stepId, undefined);
  assert.equal(calls[0][1].run_id, options.runId);
  await prepared.bindInput({ initial: true });
  await prepared.cleanup();
  assert.equal(calls[1][1].run_id, options.runId);
  assert.equal(calls[2][1].run_id, options.runId);
});

test('requested Skill toolsets require an exact native acknowledgement and retain their frozen binding', async t => {
  const { app, calls, dataDir, skill, session, options } = await fixture(t);
  options.skillNode.config.requiredToolsets = ['image_gen'];
  let acknowledged = false;
  app.onRequest = (method, params) => {
    if (method === 'workbench.tools.catalog') return { revision: capabilityRevision, toolsets: [{ id: 'image_gen', label: 'Images', available: true, enabled: true, tools: ['image_generate'] }] };
    if (method === 'workbench.skill.prepare') return { text: 'bound image Skill', skill: { name: skill.name, revision: skill.revision },
      policy: { ...policy, ...(acknowledged ? { requiredToolsets: ['image_gen'], toolNames: ['image_generate'], capabilityRevision } : {}) } };
  };
  await assert.rejects(prepareSkillRun(app, session, skill, options), /工具能力/);
  assert.deepEqual(await readdir(dataDir), []);
  acknowledged = true;
  const prepared = await prepareSkillRun(app, session, skill, options);
  assert.deepEqual(calls.filter(([method]) => method === 'workbench.skill.prepare').at(-1)[1].required_toolsets, ['image_gen']);
  assert.deepEqual(prepared.capabilities, { requiredToolsets: ['image_gen'], toolNames: ['image_generate'], revision: capabilityRevision });
  assert.equal(calls.filter(([method]) => method === 'workbench.skill.prepare').at(-1)[1].capability_revision, capabilityRevision);
  const metadata = JSON.parse(await readFile(join(dataDir, 'workflow-snapshots', options.runId, 'skill.json'), 'utf8'));
  assert.deepEqual(metadata.capabilities, prepared.capabilities);
  options.skillNode.config.requiredToolsets.push('computer_use');
  assert.deepEqual(prepared.capabilities.requiredToolsets, ['image_gen']);
  await prepared.cleanup();
});

test('unavailable or changed toolsets refuse preparation rather than granting a different tool list', async t => {
  const { app, calls, skill, session, options } = await fixture(t);
  options.skillNode.config.requiredToolsets = ['image_gen'];
  for (const change of [{ available: false }, { enabled: false }, { tools: [] }]) {
    app.onRequest = method => method === 'workbench.tools.catalog' ? { revision: capabilityRevision, toolsets: [{ id: 'image_gen', available: true, enabled: true, tools: ['image_generate'], ...change }] } : undefined;
    await assert.rejects(prepareSkillRun(app, session, skill, options), /工具能力不可用/);
  }
  assert.equal(calls.some(([method]) => method === 'workbench.skill.prepare'), false);
  app.onRequest = method => method === 'workbench.tools.catalog' ? { revision: capabilityRevision, toolsets: [{ id: 'image_gen', available: true, enabled: true, tools: ['image_generate'] }] }
    : method === 'workbench.skill.prepare' ? { text: 'changed tools', skill: { name: skill.name, revision: skill.revision },
      policy: { ...policy, requiredToolsets: ['image_gen'], toolNames: ['image_generate', 'computer_use'], capabilityRevision } } : undefined;
  await assert.rejects(prepareSkillRun(app, session, skill, options), /准确确认/);
});

test('a repeated Skill attempt refuses changed native capabilities instead of silently switching the image provider', async t => {
  const { app, calls, skill, session, options } = await fixture(t);
  options.skillNode.config.requiredToolsets = ['image_gen']; let revision = capabilityRevision;
  app.onRequest = method => method === 'workbench.tools.catalog' ? { revision, toolsets: [{ id: 'image_gen', available: true, enabled: true, tools: ['image_generate'] }] }
    : method === 'workbench.skill.prepare' ? { text: 'bound image Skill', skill: { name: skill.name, revision: skill.revision },
      policy: { ...policy, requiredToolsets: ['image_gen'], toolNames: ['image_generate'], capabilityRevision: revision } } : undefined;
  const first = await prepareSkillRun(app, session, skill, options); await first.cleanup();
  revision = 'sha256:' + 'd'.repeat(64);
  const prepares = calls.filter(([method]) => method === 'workbench.skill.prepare').length;
  await assert.rejects(prepareSkillRun(app, session, skill, { ...options, expectedCapabilities: first.capabilities }), /工具能力.*变化.*新建运行/);
  assert.equal(calls.filter(([method]) => method === 'workbench.skill.prepare').length, prepares);
});

test('runtime Skill capability IDs accept the same configured MCP names as the shared node contract', async t => {
  for (const id of ['mcp-Figma.Desktop', 'mcp-' + 'A'.repeat(96)]) await t.test(id, async sub => {
    const { app, skill, session, options } = await fixture(sub);
    options.skillNode.config.requiredToolsets = [id];
    app.onRequest = method => method === 'workbench.tools.catalog' ? { revision: capabilityRevision,
      toolsets: [{ id, available: true, enabled: true, tools: ['mcp__Figma_V2_read'] }] }
      : method === 'workbench.skill.prepare' ? { text: 'configured MCP Skill', skill: { name: skill.name, revision: skill.revision },
        policy: { ...policy, requiredToolsets: [id], toolNames: ['mcp__Figma_V2_read'], capabilityRevision } } : undefined;
    const prepared = await prepareSkillRun(app, session, skill, options);
    assert.deepEqual(prepared.capabilities.requiredToolsets, [id]);
    await prepared.cleanup();
  });
});

test('media wire types remain JSON and native image receipts are returned by the integrity cleanup', async t => {
  const { app, calls, skill, session, options } = await fixture(t);
  options.skillNode.config.outputType = 'image';
  const artifacts = [{ path: '/fixture/.workbench-artifacts/image.png', sourcePath: '/fixture/cache/image.png',
    sha256: 'a'.repeat(64), mimeType: 'image/png', toolName: 'image_generate' }];
  app.onRequest = method => method === 'workbench.skill.finish' ? { unchanged: true, snapshotIntact: true, artifacts } : undefined;
  const prepared = await prepareSkillRun(app, session, skill, options);
  assert.equal(calls[0][1].output_type, 'object');
  await prepared.bindInput(null); assert.equal(calls[1][1].output_type, 'object');
  assert.deepEqual(await prepared.cleanup(), { artifacts });
});

test('a no-tools learning Skill cannot request image-generation capabilities', async t => {
  const { app, calls, skill, session, options } = await fixture(t);
  skill.content = '---\nname: fixture-skill\nallowed-tools: []\n---\nPlan.\n';
  skill.revision = `sha256:${createHash('sha256').update(skill.content).digest('hex')}`;
  options.skillNode.config = { ...options.skillNode.config, version: skill.revision, requiredToolsets: ['image_gen'] };
  const id = randomUUID();
  await assert.rejects(prepareSkillRun(app, session, skill, { ...options, learningId: id, memoryScopeId: id }), /无工具.*工具能力/);
  assert.equal(calls.length, 0);
});

test('binding retains typed JSON values and captured step configuration without live Skill reloads', async t => {
  const { app, calls, skill, session, options } = await fixture(t);
  const prepared = await prepareSkillRun(app, session, skill, options);
  skill.content = 'changed live object that must never be reread';
  options.skillNode.config.outputType = 'text';
  session.runtimeSessionId = 'changed external session object';
  for (const value of [false, 0, null, { typed: [false, 0, null] }]) {
    const result = await prepared.bindInput(value);
    const last = calls.at(-1);
    assert.equal(last[0], 'workbench.skill.input');
    assert.deepEqual(last[1].input, value);
    assert.equal(last[1].session_id, 'runtime-first');
    assert.equal(last[1].output_type, 'object');
    assert.ok(result.text.endsWith(JSON.stringify(value)));
  }
  assert.equal(calls.filter(call => call[0] === 'workbench.skill.prepare').length, 1);
});

test('unsafe multi-step node IDs fail before RPCs or metadata writes', async t => {
  const { app, calls, dataDir, skill, session, options } = await fixture(t);
  for (const nodeId of ['../escape', 'a/b', 'a\\b', '', '.', '__proto__', 'constructor', 'prototype', 'x'.repeat(129)]) {
    await assert.rejects(prepareSkillRun(app, session, skill, { ...options, stepId: randomUUID(), nodeId }), /节点标识/);
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(await readdir(dataDir), []);
  await assert.rejects(prepareSkillRun(app, session, skill, { ...options, stepId: '../bad', nodeId: 'valid' }), /运行标识/);
});

test('preparation and binding enforce the full JSON UTF-8 64KB boundary without invoking accessors', async t => {
  const { app, calls, skill, session, options } = await fixture(t);
  await assert.rejects(prepareSkillRun(app, session, skill, { ...options, input: '界'.repeat(21845) }), /64KB/);
  assert.equal(calls.length, 0);
  const prepared = await prepareSkillRun(app, session, skill, options);
  await prepared.bindInput('x'.repeat(64 * 1024 - 2));
  const count = calls.length;
  let getterCalled = false;
  const accessor = { get value() { getterCalled = true; return 'forbidden'; } };
  for (const value of ['x'.repeat(64 * 1024 - 1), '界'.repeat(21845), NaN, undefined, accessor, { method() {} }]) {
    await assert.rejects(prepared.bindInput(value), /64KB|JSON|访问器/);
  }
  assert.equal(getterCalled, false);
  assert.equal(calls.length, count);
});

test('binding rejects absent native context and cannot bind after pending-step cleanup', async t => {
  const { app, calls, skill, session, options } = await fixture(t);
  const prepared = await prepareSkillRun(app, session, skill, { ...options, stepId: randomUUID(), nodeId: 'pending-step' });
  app.onRequest = method => method === 'workbench.skill.input' ? { text: '' } : undefined;
  await assert.rejects(prepared.bindInput({ example: true }), /固定 Skill 上下文/);
  await prepared.cleanup();
  const count = calls.length;
  await assert.rejects(prepared.bindInput(null), /已经结束/);
  assert.equal(calls.length, count);
});

test('cleanup audit failures remain failures and close the local input binding', async t => {
  const { app, calls, skill, session, options } = await fixture(t);
  const prepared = await prepareSkillRun(app, session, skill, options);
  app.onRequest = method => method === 'workbench.skill.finish' ? { unchanged: false, snapshotIntact: true } : undefined;
  await assert.rejects(prepared.cleanup(), /发生变化/);
  const count = calls.length;
  await assert.rejects(prepared.bindInput(false), /已经结束/);
  assert.equal(calls.length, count);
});

test('learned candidates execute against their installed base while retaining the local reference and body revision', async t => {
  const { app, calls, dataDir, skill: original, session, options } = await fixture(t);
  const content = original.content.replace('Return the requested result.', 'Use the improved candidate instructions.');
  const skill = { name: `wb-learn-${randomUUID()}`, baseName: original.name, baseRevision: original.revision,
    content, revision: `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`, source: 'learned' };
  const stepId = randomUUID();
  const node = { ...options.skillNode, config: { ...options.skillNode.config, version: skill.revision } };
  const prepared = await prepareSkillRun(app, session, skill, { ...options, skillNode: node, stepId, nodeId: 'candidate-node' });
  assert.equal(calls[0][1].skill, original.name);
  assert.equal(calls[0][1].revision, skill.revision);
  assert.equal(calls[0][1].candidate_content, skill.content);
  assert.equal(calls[0][1].source_revision, original.revision);
  assert.equal(prepared.skill.name, skill.name);
  assert.equal(prepared.skill.baseName, original.name);
  assert.equal(prepared.skill.baseRevision, original.revision);
  const metadata = JSON.parse(await readFile(join(dataDir, 'workflow-snapshots', options.runId, 'nodes', 'candidate-node', 'skill.json'), 'utf8'));
  assert.equal(metadata.name, skill.name);
  assert.equal(metadata.baseName, original.name);
  assert.equal(metadata.baseRevision, original.revision);
  assert.equal(metadata.content, content);
  await prepared.bindInput({ typed: [false, 0, null] });
  await prepared.cleanup();
  assert.deepEqual(calls.slice(-2).map(call => call[1].run_id), [stepId, stepId]);
});

test('candidate preparation refuses missing provenance and mismatched base acknowledgments', async t => {
  const { app, calls, skill: original, session, options } = await fixture(t);
  for (const source of [
    { source: 'learned' }, { source: 'learned', baseName: original.name, baseRevision: 'latest' },
    { source: 'learned', baseName: '', baseRevision: original.revision },
  ]) await assert.rejects(prepareSkillRun(app, session, { ...original, ...source }, options), /原始 Skill/);
  assert.equal(calls.length, 0);
  const skill = { ...original, name: `wb-learn-${randomUUID()}`, baseName: original.name, baseRevision: original.revision, source: 'learned' };
  app.onRequest = (_method, params) => ({ text: 'native message', skill: { name: skill.name, revision: params.revision,
    sourceRevision: params.source_revision }, policy });
  await assert.rejects(prepareSkillRun(app, session, skill, options), /固定快照与执行策略/);
  app.onRequest = (_method, params) => ({ text: 'native message', skill: { name: original.name, revision: params.revision,
    sourceRevision: `sha256:${'f'.repeat(64)}` }, policy });
  await assert.rejects(prepareSkillRun(app, session, skill, options), /固定快照与执行策略/);
});

test('learning Skill preparation requires the admitted batch snapshot and records its acknowledged policy', async t => {
  const { app, calls, dataDir, skill, session, options } = await fixture(t);
  const id = randomUUID();
  const learningOptions = { ...options, learningId: id, memoryScopeId: id };
  await assert.rejects(prepareSkillRun(app, session, skill, learningOptions), /固定只读记忆/);
  assert.equal(calls[0][1].memory_scope_id, id);
  assert.deepEqual(await readdir(dataDir), [], 'an unconfirmed isolation policy must not be recorded as prepared');
  app.onRequest = (method, params) => method === 'workbench.skill.prepare' ? {
    text: 'isolated Skill context', skill: { name: skill.name, revision: skill.revision },
    policy: { ...policy, memoryWriteAllowed: false, externalMemoryAllowed: false,
      memoryMode: 'batch-snapshot', memoryScopeId: params.memory_scope_id },
  } : undefined;
  const prepared = await prepareSkillRun(app, session, skill, learningOptions);
  const metadata = JSON.parse(await readFile(join(dataDir, 'workflow-snapshots', options.runId, 'skill.json'), 'utf8'));
  assert.equal(metadata.policy.memoryScopeId, id); assert.equal(metadata.policy.memoryWriteAllowed, false);
  await prepared.bindInput('validation input'); await prepared.cleanup();
  const ordinary = await prepareSkillRun(app, session, skill, options);
  assert.equal(calls.at(-1)[1].memory_scope_id, undefined, 'ordinary execution does not request isolated memory');
  await ordinary.cleanup();
});

test('invalid or mismatched learning memory scopes fail before a Skill RPC', async t => {
  const { app, calls, skill, session, options } = await fixture(t), id = randomUUID();
  for (const changes of [{ learningId: id }, { memoryScopeId: id }, { learningId: id, memoryScopeId: randomUUID() },
    { learningId: '../invalid', memoryScopeId: '../invalid' }]) {
    await assert.rejects(prepareSkillRun(app, session, skill, { ...options, ...changes }), /固定记忆/);
  }
  assert.equal(calls.length, 0);
});

test('declared tool-free learning Skills require an explicit false ACK before recording or binding', async t => {
  const { app, calls, dataDir, skill, session, options } = await fixture(t);
  skill.content = '---\nname: fixture-skill\nallowed-tools: []\n---\nPlan from supplied input.\n';
  skill.revision = `sha256:${createHash('sha256').update(skill.content).digest('hex')}`;
  options.skillNode.config.version = skill.revision;
  const id = randomUUID(), isolated = { ...options, learningId: id, memoryScopeId: id };
  let toolsAllowed;
  app.onRequest = (method, params) => method === 'workbench.skill.prepare' ? {
    text: 'fixed planning Skill', skill: { name: skill.name, revision: skill.revision },
    policy: { ...policy, memoryWriteAllowed: false, externalMemoryAllowed: false,
      memoryMode: 'batch-snapshot', memoryScopeId: params.memory_scope_id,
      ...(toolsAllowed === undefined ? {} : { toolsAllowed }) },
  } : undefined;
  for (const value of [undefined, true, null, 0, 'false']) {
    toolsAllowed = value;
    await assert.rejects(prepareSkillRun(app, session, skill, isolated), /无工具策略/);
    assert.deepEqual(await readdir(dataDir), [], 'unacknowledged no-tools policy must not produce prepared metadata');
  }
  assert.ok(calls.every(([method]) => method === 'workbench.skill.prepare'));
  toolsAllowed = false;
  const prepared = await prepareSkillRun(app, session, skill, isolated);
  const metadata = JSON.parse(await readFile(join(dataDir, 'workflow-snapshots', options.runId, 'skill.json'), 'utf8'));
  assert.equal(metadata.policy.toolsAllowed, false);
  assert.equal(metadata.policy.memoryWriteAllowed, false);
  await prepared.bindInput({ facts: 'supplied only' });
  await prepared.cleanup();
  assert.deepEqual(calls.slice(-2).map(([method]) => method), ['workbench.skill.input', 'workbench.skill.finish']);
});

test('no-tools acknowledgement detection is limited to a single empty list in frontmatter', async t => {
  const declarations = [
    ['body text', '---\nname: fixture-skill\n---\nallowed-tools: []\n', false],
    ['empty metadata followed by body fence', '---\n---\nallowed-tools: []\n---\nPlan.\n', false],
    ['quoted string', '---\nname: fixture-skill\nallowed-tools: "[]"\n---\nPlan.\n', false],
    ['nonempty list', '---\nname: fixture-skill\nallowed-tools: [terminal]\n---\nPlan.\n', false],
    ['block list', '---\nname: fixture-skill\nallowed-tools:\n  - terminal\n---\nPlan.\n', false],
    ['indented description', '---\nname: fixture-skill\ndescription: |\n  allowed-tools: []\n---\nPlan.\n', false],
    ['duplicate declaration', '---\nname: fixture-skill\nallowed-tools: []\nallowed-tools: [terminal]\n---\nPlan.\n', false],
    ['normalized frontmatter', '\uFEFF---\r\nname: fixture-skill\r\nallowed-tools : [ ] # pure planning\r\n---\r\nPlan.\r\n', true],
  ];
  for (const [label, content, empty] of declarations) await t.test(label, async sub => {
    const { app, skill, session, options } = await fixture(sub);
    skill.content = content;
    skill.revision = `sha256:${createHash('sha256').update(content).digest('hex')}`;
    options.skillNode.config.version = skill.revision;
    const id = randomUUID();
    app.onRequest = (method, params) => method === 'workbench.skill.prepare' ? {
      text: 'isolated Skill', skill: { name: skill.name, revision: skill.revision },
      policy: { ...policy, memoryWriteAllowed: false, externalMemoryAllowed: false,
        memoryMode: 'batch-snapshot', memoryScopeId: params.memory_scope_id },
    } : undefined;
    if (empty) await assert.rejects(prepareSkillRun(app, session, skill, { ...options, learningId: id, memoryScopeId: id }), /无工具策略/);
    else await (await prepareSkillRun(app, session, skill, { ...options, learningId: id, memoryScopeId: id })).cleanup();
  });
});

test('empty-tools metadata leaves ordinary preparation unchanged and is enforced for learned planning candidates', async t => {
  const { app, calls, skill, session, options } = await fixture(t);
  skill.content = '---\nname: fixture-skill\nallowed-tools: []\n---\nPlan using supplied facts.\n';
  skill.revision = `sha256:${createHash('sha256').update(skill.content).digest('hex')}`;
  options.skillNode.config.version = skill.revision;
  const ordinary = await prepareSkillRun(app, session, skill, options);
  assert.equal(calls[0][1].memory_scope_id, undefined);
  await ordinary.cleanup();
  const candidateContent = skill.content.replace('Plan using supplied facts.', 'Plan improved paths using supplied facts.');
  const candidate = { ...skill, name: 'wb-learn-planning-fixture', source: 'learned', baseName: skill.name,
    baseRevision: skill.revision, content: candidateContent,
    revision: `sha256:${createHash('sha256').update(candidateContent).digest('hex')}` };
  const id = randomUUID();
  const learning = { ...options, runId: randomUUID(), learningId: id, memoryScopeId: id,
    skillNode: { ...options.skillNode, config: { ...options.skillNode.config, version: candidate.revision } } };
  let toolsAllowed;
  app.onRequest = (method, params) => method === 'workbench.skill.prepare' ? {
    text: 'learned planning candidate', skill: { name: skill.name, revision: candidate.revision, sourceRevision: skill.revision },
    policy: { ...policy, memoryWriteAllowed: false, externalMemoryAllowed: false,
      memoryMode: 'batch-snapshot', memoryScopeId: params.memory_scope_id,
      ...(toolsAllowed === undefined ? {} : { toolsAllowed }) },
  } : undefined;
  await assert.rejects(prepareSkillRun(app, session, candidate, learning), /无工具策略/);
  toolsAllowed = false;
  await (await prepareSkillRun(app, session, candidate, learning)).cleanup();
  const request = calls.find(([method, params]) => method === 'workbench.skill.prepare' && params.candidate_content)?.[1];
  assert.equal(request.skill, skill.name);
  assert.equal(request.source_revision, skill.revision);
  assert.equal(request.candidate_content, candidateContent);
});

test('no-tools ACK requirement uses the revision-checked body captured before the asynchronous RPC', async t => {
  const { app, dataDir, skill, session, options } = await fixture(t);
  skill.content = '---\nname: fixture-skill\nallowed-tools: []\n---\nPlan.\n';
  skill.revision = `sha256:${createHash('sha256').update(skill.content).digest('hex')}`;
  options.skillNode.config.version = skill.revision;
  const id = randomUUID();
  app.onRequest = (_method, params) => {
    skill.content = 'External object changed while the RPC was pending.';
    return { text: 'fixed Skill', skill: { name: skill.name, revision: params.revision },
      policy: { ...policy, memoryWriteAllowed: false, externalMemoryAllowed: false,
        memoryMode: 'batch-snapshot', memoryScopeId: params.memory_scope_id } };
  };
  await assert.rejects(prepareSkillRun(app, session, skill, { ...options, learningId: id, memoryScopeId: id }), /无工具策略/);
  assert.deepEqual(await readdir(dataDir), []);
});
