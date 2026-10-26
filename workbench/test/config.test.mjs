import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { appRoot, projectRoot, defaultWorkflowRunRoot, readConfig } from '../src/config.mjs';

const isolated = { WORKBENCH_HERMES_ROOT: '/missing-test-hermes' };

test('default authoritative run storage uses local application state outside the workspace', () => {
  const config = readConfig(isolated);
  assert.equal(config.workflowRunRoot, resolve(defaultWorkflowRunRoot(isolated)));
  assert.notEqual(config.workflowRunRoot, join(config.workspaceRoot, 'outputs'));
  assert.equal(projectRoot, dirname(appRoot));
  assert.equal(config.projectRoot, projectRoot);
  assert.equal(config.workspaceRoot, join(projectRoot, 'workflow'));
  assert.equal(config.workspaceRootConfigured, false);
  if (process.platform === 'darwin') assert.equal(config.workflowRunRoot, join(homedir(), 'Library', 'Application Support', 'PersonalAgentWorkbench', 'runs'));
});

test('platform run-storage defaults respect local state conventions', () => {
  assert.equal(defaultWorkflowRunRoot({}, 'darwin', '/home/person'), join('/home/person', 'Library', 'Application Support', 'PersonalAgentWorkbench', 'runs'));
  assert.equal(defaultWorkflowRunRoot({ LOCALAPPDATA: '/local-app-data' }, 'win32', '/home/person'), join('/local-app-data', 'PersonalAgentWorkbench', 'runs'));
  assert.equal(defaultWorkflowRunRoot({}, 'win32', '/home/person'), join('/home/person', 'AppData', 'Local', 'PersonalAgentWorkbench', 'runs'));
  assert.equal(defaultWorkflowRunRoot({ XDG_STATE_HOME: '/local-state' }, 'linux', '/home/person'), join('/local-state', 'personal-agent-workbench', 'runs'));
  assert.equal(defaultWorkflowRunRoot({}, 'linux', '/home/person'), join('/home/person', '.local', 'state', 'personal-agent-workbench', 'runs'));
});

test('an explicit run root takes precedence over custom data and workspace roots', () => {
  const env = { ...isolated, WORKBENCH_DATA_DIR: '/tmp/data-fixture', WORKBENCH_WORKSPACE_ROOT: '/tmp/workspace-fixture', WORKBENCH_RUN_ROOT: '/tmp/run-fixture' };
  const before = structuredClone(env), config = readConfig(env);
  assert.equal(config.workflowRunRoot, '/tmp/run-fixture');
  assert.equal(config.dataDir, '/tmp/data-fixture');
  assert.equal(config.workspaceRoot, '/tmp/workspace-fixture');
  assert.equal(config.workspaceRootConfigured, true);
  assert.deepEqual(env, before);
});

test('custom data environments isolate authoritative runs rather than falling back to the real user store', () => {
  const config = readConfig({ ...isolated, WORKBENCH_DATA_DIR: '/tmp/data-fixture', WORKBENCH_WORKSPACE_ROOT: '/tmp/workspace-fixture' });
  assert.equal(config.workflowRunRoot, '/tmp/data-fixture/workflow-runs');
});

test('a custom workspace alone isolates authoritative runs within that environment', () => {
  const config = readConfig({ ...isolated, WORKBENCH_WORKSPACE_ROOT: '/tmp/workspace-fixture' });
  assert.equal(config.workflowRunRoot, '/tmp/workspace-fixture/.workbench-runs');
});

test('an explicitly configured default-looking workspace retains its explicit policy', () => {
  const root = join(projectRoot, 'workflow');
  const config = readConfig({ ...isolated, WORKBENCH_WORKSPACE_ROOT: root });
  assert.equal(config.workspaceRoot, root);
  assert.equal(config.workspaceRootConfigured, true);
  assert.equal(config.workflowRunRoot, join(root, '.workbench-runs'));
});
