import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const scripts = ['native_export.js', 'native_four_files.js'];
function fixture(environment) {
  const calls = [];
  const eda = {
    sys_Environment: Object.fromEntries(['isClient', 'isOnlineMode', 'isHalfOfflineMode', 'isOfflineMode']
      .map(key => [key, async () => environment[key]])),
    sys_FileSystem: { async readFileFromFileSystem(path) { calls.push(['read', path]); return { size: 1 }; } },
    sys_FileManager: { async importProjectByProjectFile(...args) { calls.push(['import', args]); return { uuid: 'synthetic-local-project' }; } },
  };
  return { calls, eda };
}

for (const name of scripts) {
  test(`${name} checks environment without reading a file or importing a project`, async () => {
    const run = new AsyncFunction('eda', '__CLI__', await readFile(new URL('../hdk/exporter/' + name, import.meta.url), 'utf8'));
    const environment = { isClient: true, isOnlineMode: true, isHalfOfflineMode: false, isOfflineMode: false };
    const f = fixture(environment);
    assert.deepEqual(await run(f.eda, { args: { action: 'environment' } }), environment);
    assert.deepEqual(f.calls, []);
  });

  test(`${name} refuses online, browser and malformed environment flags before touching input files`, async () => {
    const run = new AsyncFunction('eda', '__CLI__', await readFile(new URL('../hdk/exporter/' + name, import.meta.url), 'utf8'));
    for (const environment of [
      { isClient: true, isOnlineMode: true, isHalfOfflineMode: false, isOfflineMode: false },
      { isClient: false, isHalfOfflineMode: true }, { isClient: 1, isOfflineMode: true },
    ]) {
      const f = fixture(environment);
      await assert.rejects(run(f.eda, { args: { action: 'import', filePath: '/fixture/input.epro2', folderPath: '/fixture/native' } }), /environment:.*半离线.*全离线/);
      assert.deepEqual(f.calls, []);
    }
  });

  test(`${name} permits half/full offline imports only through the explicitly local destination`, async () => {
    const run = new AsyncFunction('eda', '__CLI__', await readFile(new URL('../hdk/exporter/' + name, import.meta.url), 'utf8'));
    for (const mode of ['isHalfOfflineMode', 'isOfflineMode']) {
      const f = fixture({ isClient: true, [mode]: true });
      assert.deepEqual(await run(f.eda, { args: { action: 'import', filePath: '/fixture/input.epro2', folderPath: '/fixture/native' } }), { uuid: 'synthetic-local-project' });
      assert.equal(f.calls.length, 2);
      assert.deepEqual(f.calls[1][1][3], { operation: 'Offline Client Local Path', folderPath: '/fixture/native' });
    }
  });
}
