import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

export const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const projectRoot = dirname(appRoot);

export function defaultWorkflowRunRoot(env = process.env, platform = process.platform, home = homedir()) {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'PersonalAgentWorkbench', 'runs');
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'PersonalAgentWorkbench', 'runs');
  return join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'personal-agent-workbench', 'runs');
}

export function readConfig(env = process.env) {
  const hermesRoot = resolve(env.WORKBENCH_HERMES_ROOT || join(homedir(), '.hermes/hermes-agent'));
  const dataDir = resolve(env.WORKBENCH_DATA_DIR || join(appRoot, '.local'));
  const workspaceRoot = resolve(env.WORKBENCH_WORKSPACE_ROOT || join(projectRoot, 'workflow'));
  // Explicit isolated data/workspace environments keep runs alongside that
  // environment, rather than accidentally using a real user's local store.
  const workflowRunRoot = resolve(env.WORKBENCH_RUN_ROOT || (env.WORKBENCH_DATA_DIR ? join(dataDir, 'workflow-runs')
    : env.WORKBENCH_WORKSPACE_ROOT ? join(workspaceRoot, '.workbench-runs') : defaultWorkflowRunRoot(env)));
  let hermesVersion = 'unknown';
  try { hermesVersion = readFileSync(join(hermesRoot, 'pyproject.toml'), 'utf8').match(/^version\s*=\s*"([^"]+)"/m)?.[1] || 'unknown'; } catch {}
  return {
    appRoot,
    projectRoot,
    host: '127.0.0.1',
    port: Number(env.WORKBENCH_PORT || 4318),
    dataDir,
    workspaceRoot,
    workspaceRootConfigured: Boolean(env.WORKBENCH_WORKSPACE_ROOT),
    workflowRunRoot,
    hermesRoot,
    hermesPython: env.WORKBENCH_HERMES_PYTHON || join(hermesRoot, 'venv/bin/python'),
    hermesHome: env.WORKBENCH_HERMES_HOME || join(homedir(), '.hermes'),
    hermesVersion,
  };
}
