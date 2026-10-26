import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadPreferences } from './preferences.mjs';

const MIGRATION = 'project-workflow-workspace-v1';

// The project workspace holds user inputs and delivery copies. Existing state,
// historical workspace paths, and authoritative run originals stay in place.
export function initializeWorkspace(config, store) {
  mkdirSync(config.workspaceRoot, { recursive: true });
  const saved = store.preferences();
  const preferences = loadPreferences(saved, config.workspaceRoot);
  const projectRoot = config.projectRoot || dirname(config.appRoot);
  const defaultLayout = !config.workspaceRootConfigured
    && resolve(config.workspaceRoot) === resolve(projectRoot, 'workflow')
    && resolve(config.dataDir) === resolve(config.appRoot, '.local');

  if (defaultLayout) {
    store.db.exec('CREATE TABLE IF NOT EXISTS workbench_migrations (id TEXT PRIMARY KEY)');
    if (!store.db.prepare('SELECT id FROM workbench_migrations WHERE id=?').get(MIGRATION)) {
      // Only the former built-in default is translated. User-chosen relative
      // directories and all explicitly configured workspace roots are retained.
      if (saved?.defaultWorkspace === 'default') {
        preferences.defaultWorkspace = '.';
        store.savePreferences(preferences);
      }
      store.db.prepare('INSERT INTO workbench_migrations(id) VALUES(?)').run(MIGRATION);
    }
  }

  mkdirSync(join(config.workspaceRoot, 'artifacts'), { recursive: true });
  mkdirSync(join(config.workspaceRoot, 'outputs'), { recursive: true });
  return preferences;
}
