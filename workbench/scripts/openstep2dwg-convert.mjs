import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat, access, rm, link, mkdtemp } from 'node:fs/promises';
import { resolve, dirname, extname, basename as pathBasename, sep, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile as callbackExecFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(callbackExecFile);
export const OPENSTEP2DWG_COMMIT = 'afd6a844e39ba0a205918dc866b60211f978b2b9';
const WORKBENCH = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_REPOSITORY = join(WORKBENCH, '.local/converters/OpenStep2DWG');
const DEFAULT_QA_PYTHON = join(WORKBENCH, '.local/converters/qa-python/bin/python');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.step': 'application/step' };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function validateCadOptions(options = {}) {
  const { inputStep, outputDir, basename, title = basename, drawingNumber = title, revision = 'V1.0', date, rotation = 0, layout = 'inspection', detail = 'full', timeoutMs = 900000 } = options;
  if (typeof inputStep !== 'string' || !/\.(step|stp)$/i.test(inputStep)) throw Error('inputStep must be a STEP/STP file');
  if (typeof outputDir !== 'string' || !outputDir) throw Error('outputDir is required');
  if (typeof basename !== 'string' || !basename.trim() || basename.length > 180 || /[\\/\x00-\x1f]/.test(basename) || /^\.{1,2}$/.test(basename)) throw Error('basename must be a safe filename without extension');
  for (const [key, value, limit] of [['title', title, 120], ['drawingNumber', drawingNumber, 120], ['revision', revision, 20]]) if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\x00-\x1f]/.test(value)) throw Error(`${key} is invalid`);
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(new Date(date + 'T00:00:00Z').getTime()) || new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date) throw Error('date must be a valid YYYY-MM-DD');
  if (![0, 90, 180, 270].includes(rotation)) throw Error('rotation must be 0, 90, 180 or 270');
  if (!['inspection', 'first-angle'].includes(layout)) throw Error('layout must be inspection or first-angle');
  if (!['full', 'mechanical'].includes(detail)) throw Error('detail must be full or mechanical');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1800000) throw Error('timeoutMs must be between 1000 and 1800000');
  return { ...options, inputStep: resolve(inputStep), outputDir: resolve(outputDir), basename, title, drawingNumber, revision, date, rotation, layout, detail, timeoutMs };
}

export async function cadDependenciesStatus(options = {}) {
  const repository = resolve(options.repository || DEFAULT_REPOSITORY), verificationPython = resolve(options.verificationPython || DEFAULT_QA_PYTHON);
  const checks = { node24: Number(process.versions.node.split('.')[0]) >= 24 };
  for (const [key, file] of Object.entries({ browser: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', playwright: join(repository, 'node_modules/playwright-core/index.mjs'), occt: join(repository, 'dist/vendor/occt/occt.wasm.gz'), dwg: join(repository, 'dist/engine/pkg/dwg_bg.wasm'), qaPython: verificationPython })) checks[key] = await access(file).then(() => true, () => false);
  try { const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: repository }); checks.pinnedCommit = stdout.trim() === OPENSTEP2DWG_COMMIT; await execFile('git', ['diff', '--quiet', 'HEAD', '--'], { cwd: repository }); checks.trackedSourceClean = true; } catch { checks.pinnedCommit ??= false; checks.trackedSourceClean = false; }
  try { const { stdout } = await execFile(verificationPython, ['-c', 'import ezdxf; print(ezdxf.__version__)']); checks.ezdxf143 = stdout.trim() === '1.4.3'; } catch { checks.ezdxf143 = false; }
  return { ready: Object.values(checks).every(Boolean), checks, repository, commit: OPENSTEP2DWG_COMMIT, verificationPython };
}

function entityCounts(text) {
  const rows = text.split(/\r?\n/), counts = {};
  let section = '', entities = false;
  for (let i = 0; i + 1 < rows.length; i += 2) {
    const code = Number(rows[i]), value = rows[i + 1].trim();
    if (code === 0 && value === 'SECTION') { section = 'pending'; continue; }
    if (section === 'pending' && code === 2) { section = value; entities = value === 'ENTITIES'; continue; }
    if (code === 0 && value === 'ENDSEC') { entities = false; section = ''; }
    else if (entities && code === 0) counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

// The upstream CAD encoder and decoder remain replaceable browser Worker modules.
const ROUNDTRIP_WORKER = `import init,{dwg_to_dxf} from '/engine/pkg/dwg.js';
self.onmessage=async({data})=>{try{await init();const bytes=dwg_to_dxf(data);self.postMessage({bytes},[bytes.buffer]);}catch(error){self.postMessage({error:error.message||String(error)});}};`;

async function serve(repository) {
  const root = join(repository, 'dist');
  await access(join(root, 'vendor/occt/occt.wasm.gz'));
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method !== 'GET') { res.writeHead(405).end(); return; }
      if (url.pathname === '/__workbench-roundtrip-worker.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(ROUNDTRIP_WORKER); return; }
      const file = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
      if (!file.startsWith(root + sep) || !(await stat(file)).isFile()) throw Error('Not found');
      const bytes = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Content-Length': bytes.length, 'X-Content-Type-Options': 'nosniff' }).end(bytes);
    } catch { res.writeHead(404).end('Not found'); }
  });
  await new Promise((ok, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ok); });
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

export async function convertStepToCad(inputOptions) {
  const options = validateCadOptions(inputOptions), repository = resolve(options.repository || DEFAULT_REPOSITORY);
  const progress = options.onProgress || (() => {}), signal = options.signal;
  signal?.throwIfAborted();
  const source = await readFile(options.inputStep);
  if (!source.length || source.length > 150 * 1024 * 1024 || !source.subarray(0, 200).toString().includes('ISO-10303-21')) throw Error('STEP file is empty, invalid, or exceeds the upstream 150 MB limit');
  const dependencies = await cadDependenciesStatus(options);
  if (!dependencies.ready) throw Error(`CAD dependencies not ready: ${Object.entries(dependencies.checks).filter(([, ready]) => !ready).map(([name]) => name).join(', ')}`);
  const sourceHash = hash(source), startedAt = new Date().toISOString();
  const formats = ['dwg', 'dxf', 'svg', 'png'];
  const names = [...formats.map(format => `${options.basename}.${format}`), `${options.basename}.openstep2dwg.json`, `${options.basename}.roundtrip.dxf`, `${options.basename}.cad-verification.json`, `${options.basename}.conversion.json`];
  await mkdir(options.outputDir, { recursive: true });
  for (const name of names) try { await access(join(options.outputDir, name)); throw Error(`Refusing to overwrite existing artifact: ${name}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const staging = await mkdtemp(join(options.outputDir, '.openstep-'));
  let browser, hosting, published = [], committed = false;
  const aborted = () => { void browser?.close().catch(() => {}); };
  try {
    signal?.throwIfAborted();
    hosting = await serve(repository);
    const { chromium } = await import(pathToFileURL(join(repository, 'node_modules/playwright-core/index.mjs')).href);
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    signal?.addEventListener('abort', aborted, { once: true });
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 960 } });
    const requested = [], pageErrors = [];
    await context.route('**/*', route => {
      const request = route.request(); requested.push({ url: request.url(), method: request.method() });
      if ((request.url().startsWith(hosting.origin + '/') || request.url().startsWith('blob:')) && request.method() === 'GET') void route.continue();
      else void route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.addInitScript(() => { window.workbenchConversions = []; window.addEventListener('conversion-complete', event => window.workbenchConversions.push(event.detail)); });
    await page.goto(hosting.origin + '/?lang=en');
    await page.locator('#paper svg').waitFor({ state: 'visible' });
    await page.getByRole('button', { name: `${options.rotation}°`, exact: true }).click();
    await page.locator('#detail').selectOption(options.detail);
    await page.locator('#view-layout').selectOption(options.layout);
    await page.exposeFunction('reportConversionStage', text => progress(text));
    await page.evaluate(() => { const label = document.getElementById('progress-label'); new MutationObserver(() => window.reportConversionStage(label.textContent)).observe(label, { childList: true }); });
    progress('Importing fresh source STEP using OpenCascade browser Worker');
    await page.locator('#step-file').setInputFiles(options.inputStep);
    await page.waitForFunction(() => ['Conversion complete', 'Conversion failed'].includes(document.getElementById('save-state').textContent), null, { timeout: options.timeoutMs });
    const error = await page.locator('#conversion-error').textContent();
    if (error || (await page.locator('#save-state').textContent()) !== 'Conversion complete') throw Error(error || 'STEP projection did not complete');
    const conversion = await page.evaluate(() => window.workbenchConversions.at(-1));
    if (!conversion || conversion.cached) throw Error('Expected a fresh STEP conversion, not a cached projection');
    await page.locator('#project-name').fill(options.title);
    await page.getByRole('button', { name: 'Drawing settings', exact: true }).click();
    for (const [id, value] of [['drawing-number', options.drawingNumber], ['revision', options.revision], ['drawing-date', options.date]]) { await page.locator('#' + id).fill(value); await page.locator('#' + id).press('Tab'); }
    const projectDownload = page.waitForEvent('download');
    await page.locator('#save-project').click();
    const projectPath = join(staging, `${options.basename}.openstep2dwg.json`);
    await (await projectDownload).saveAs(projectPath);
    const project = JSON.parse(await readFile(projectPath, 'utf8'));
    if (project.source?.sha256 !== sourceHash || project.source?.size !== source.length) throw Error('Saved projection provenance does not match the input STEP');
    if (project.geometry?.views?.length !== 3 || project.geometry.views.some(view => !view.entities?.length)) throw Error('A required projected view is empty');
    const expectedViews = options.layout === 'inspection' ? ['top', 'bottom', 'front'] : ['top', 'front', 'left'];
    if (project.geometry.unit !== 'mm' || project.geometry.options?.rotation !== options.rotation || project.geometry.options?.detail !== options.detail || JSON.stringify(project.geometry.options?.views) !== JSON.stringify(expectedViews)) throw Error('Projection settings or CAD units differ from the requested settings');
    if (project.settings.date !== options.date || project.settings.revision !== options.revision || project.settings.drawingNumber !== options.drawingNumber || project.name !== options.title) throw Error('Drawing metadata was not applied');
    await page.locator('#export').click();
    await page.waitForFunction(() => !document.getElementById('download-export').disabled || !document.getElementById('export-error').hidden);
    if (!(await page.locator('#export-info').textContent()).includes('DWG roundtrip verified')) throw Error(await page.locator('#export-error').textContent() || 'Upstream DWG roundtrip verification failed');
    for (const format of formats) {
      progress(`Exporting ${format.toUpperCase()}`);
      await page.locator('#export-format').selectOption(format);
      await page.waitForFunction(() => !document.getElementById('download-export').disabled || !document.getElementById('export-error').hidden);
      if (await page.locator('#export-error').isVisible()) throw Error(await page.locator('#export-error').textContent());
      const download = page.waitForEvent('download');
      await page.locator('#download-export').click();
      await (await download).saveAs(join(staging, `${options.basename}.${format}`));
    }
    const dwg = await readFile(join(staging, `${options.basename}.dwg`));
    if (dwg.subarray(0, 6).toString() !== 'AC1015') throw Error('Export is not an AutoCAD 2000 DWG');
    const roundtrip = await page.evaluate(async base64 => {
      const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
      return await new Promise((ok, reject) => { const worker = new Worker('/__workbench-roundtrip-worker.js', { type: 'module' }); const timer = setTimeout(() => { worker.terminate(); reject(Error('DWG backread timeout')); }, 60000); worker.onerror = error => { clearTimeout(timer); worker.terminate(); reject(Error(error.message)); }; worker.onmessage = ({ data }) => { clearTimeout(timer); worker.terminate(); data.error ? reject(Error(data.error)) : ok(new TextDecoder().decode(data.bytes)); }; worker.postMessage(bytes, [bytes.buffer]); });
    }, dwg.toString('base64'));
    await writeFile(join(staging, `${options.basename}.roundtrip.dxf`), roundtrip);
    const dxf = await readFile(join(staging, `${options.basename}.dxf`), 'utf8');
    const before = entityCounts(dxf), after = entityCounts(roundtrip);
    if (!Object.keys(before).length) throw Error('Exported DXF has no model-space entities');
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      if (Object.keys(before).length !== Object.keys(after).length || Object.entries(before).some(([key, value]) => after[key] !== value)) throw Error('Final DWG model-space entity counts differ from exported DXF');
    }
    progress('Independent ezdxf geometric signature and CAD audit');
    const verificationPath = join(staging, `${options.basename}.cad-verification.json`);
    await execFile(dependencies.verificationPython, [join(repository, 'scripts/verify-dxf.py'), join(staging, `${options.basename}.dxf`), join(staging, `${options.basename}.roundtrip.dxf`), verificationPath], { timeout: 120000, maxBuffer: 1048576, signal });
    const independentVerification = JSON.parse(await readFile(verificationPath, 'utf8'));
    if (!independentVerification.passed || independentVerification.mismatched_entities !== 0 || independentVerification.audit_errors !== 0 || independentVerification.units !== 4) throw Error('Independent CAD geometry, dimension, or millimetre verification failed');
    independentVerification.source = join(options.outputDir, `${options.basename}.dxf`);
    independentVerification.roundtrip = join(options.outputDir, `${options.basename}.roundtrip.dxf`);
    await writeFile(verificationPath, JSON.stringify(independentVerification, null, 2) + '\n');
    if (pageErrors.length) throw Error(`Conversion page error: ${pageErrors.join('; ')}`);
    if (hash(await readFile(options.inputStep)) !== sourceHash) throw Error('Input STEP changed during conversion');
    const artifacts = [];
    for (const name of names.filter(name => !name.endsWith('.conversion.json'))) { const bytes = await readFile(join(staging, name)); artifacts.push({ name, path: join(options.outputDir, name), bytes: bytes.length, sha256: hash(bytes) }); }
    const manifest = {
      converter: { name: 'OpenStep2DWG', version: '1.0.1', repository: 'https://github.com/geekheart/OpenStep2DWG', commit: OPENSTEP2DWG_COMMIT, license: 'MIT', geometryKernel: 'opencascade.js@2.0.0-beta.b5ff984', dwgKernel: 'acadrust@0.5.5', execution: 'isolated-headless-chrome-browser-workers' },
      source: { path: options.inputStep, name: pathBasename(options.inputStep), bytes: source.length, sha256: sourceHash },
      options: { rotation: options.rotation, layout: options.layout, detail: options.detail, toleranceMm: 0.01, title: options.title, drawingNumber: options.drawingNumber, revision: options.revision, date: options.date },
      projection: { envelope: project.geometry.envelope, unit: project.geometry.unit, views: project.geometry.views.map(view => ({ id: view.id, entityCount: view.entities.length, bounds: view.bounds, isolated: view.isolated === true })), approximatedCurves: project.geometry.approximated, removedThinDetails: project.geometry.removed },
      verification: { freshConversion: true, sourceHashMatched: true, dwgHeader: 'AC1015', roundtripEntityCountsMatched: true, entityCounts: before, independentGeometryPassed: true, mismatchedEntities: 0, auditErrors: 0, dimensionValuesMm: independentVerification.dimension_values_mm, allRequestsLocalGet: requested.every(request => request.url.startsWith(hosting.origin + '/') && request.method === 'GET'), pageErrors: [] },
      conversion, startedAt, completedAt: new Date().toISOString(), artifacts,
      limitations: ['2D engineering drawing; no 3D ACIS solids', 'Automatic dimensions represent envelope dimensions; no inferred tolerances or datum requirements', ...(project.geometry.approximated ? ['Some curves are discretized at 0.01 mm tolerance; see approximatedCurves'] : [])]
    };
    await writeFile(join(staging, names.at(-1)), JSON.stringify(manifest, null, 2) + '\n');
    signal?.throwIfAborted();
    for (const name of names) { const target = join(options.outputDir, name); await link(join(staging, name), target); published.push(target); }
    committed = true;
    return { ...manifest, manifestPath: join(options.outputDir, names.at(-1)) };
  } finally {
    signal?.removeEventListener('abort', aborted);
    await browser?.close().catch(() => {});
    await new Promise(ok => hosting?.server ? hosting.server.close(ok) : ok());
    if (!committed) for (const target of published) await rm(target, { force: true });
    await rm(staging, { recursive: true, force: true });
  }
}

function cliOptions(argv) {
  const fields = { '--input': 'inputStep', '--output-dir': 'outputDir', '--basename': 'basename', '--title': 'title', '--drawing-number': 'drawingNumber', '--revision': 'revision', '--date': 'date', '--rotation': 'rotation', '--layout': 'layout', '--detail': 'detail', '--timeout-ms': 'timeoutMs' }, options = {};
  for (let i = 0; i < argv.length; i += 2) { const key = fields[argv[i]]; if (!key || argv[i + 1] === undefined || Object.hasOwn(options, key)) throw Error(`Unknown, repeated, or incomplete argument: ${argv[i]}`); options[key] = ['rotation', 'timeoutMs'].includes(key) ? Number(argv[i + 1]) : argv[i + 1]; }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => controller.abort(Error('Conversion cancelled')));
  try {
    if (process.argv.length === 3 && process.argv[2] === '--check') { const result = await cadDependenciesStatus(); process.stdout.write(JSON.stringify(result) + '\n'); if (!result.ready) process.exitCode = 1; }
    else { const result = await convertStepToCad({ ...cliOptions(process.argv.slice(2)), signal: controller.signal, onProgress: text => process.stderr.write(`[OpenStep2DWG] ${text}\n`) }); const summary = JSON.stringify(result); if (Buffer.byteLength(summary) > 65536) throw Error('Conversion summary exceeds 64 KiB; inspect the manifest file'); process.stdout.write(summary + '\n'); }
  }
  catch (error) { process.stderr.write(`[OpenStep2DWG] ${error.message}\n`); process.exitCode = 1; }
}
