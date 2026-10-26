import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat, access, rm, link, mkdtemp } from 'node:fs/promises';
import { resolve, dirname, extname, basename as fileBasename, sep, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile as callbackExecFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';

const execFile = promisify(callbackExecFile);
export const OPENINTERFACEMARK_COMMIT = 'f8f92636b2eb87ac956997e77c9239cf483913fc';
const WORKBENCH = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_REPOSITORY = join(WORKBENCH, '.local/converters/OpenInterfaceMark');
const DEFAULT_PLAYWRIGHT = join(WORKBENCH, '.local/converters/OpenStep2DWG/node_modules/playwright-core/index.mjs');
const RENDERER_FILES = ['index.html', 'src/app.js', 'src/core.js', 'src/i18n.js', 'src/styles.css', 'public/demo-board.png', 'LICENSE'];
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function validateInterfaceMarkOptions(options = {}) {
  const { projectPath, outputDir, basename, timeoutMs = 180000 } = options;
  if (typeof projectPath !== 'string' || !projectPath || !/\.json$/i.test(projectPath)) throw Error('projectPath must be a local OpenInterfaceMark JSON file');
  if (typeof outputDir !== 'string' || !outputDir) throw Error('outputDir is required');
  if (typeof basename !== 'string' || !basename.trim() || basename.length > 180 || /[\\/\x00-\x1f]/.test(basename) || /^\.{1,2}$/.test(basename)) throw Error('basename must be a safe filename without extension');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw Error('timeoutMs must be between 1000 and 600000');
  return { ...options, projectPath: resolve(projectPath), outputDir: resolve(outputDir), basename, timeoutMs };
}

// The upstream validator owns geometry and style validation. Refuse silently
// discarded fields so a renderer cannot repair or alter a caller's plan.
export function validateInterfaceMarkProject(raw, validateProject) {
  if (raw?.format !== 'open-interface-mark' || raw?.version !== 1) throw Error('An OpenInterfaceMark version 1 project is required');
  if (!Array.isArray(raw.regions) || !raw.regions.length) throw Error('The project must contain actual planned annotation regions');
  if (!raw.exportSettings) throw Error('Explicit exportSettings are required');
  const normalized = { format: 'open-interface-mark', version: 1, ...validateProject(raw) };
  if (!isDeepStrictEqual(normalized, raw)) throw Error('The upstream validator would change or discard project data');
  return normalized;
}

export function inspectInterfaceMarkPng(bytes) {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.subarray(12, 16).toString() !== 'IHDR') throw Error('Export is not a PNG');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width > 16000 || height > 16000 || width * height > 32000000) throw Error('PNG dimensions exceed OpenInterfaceMark raster limits');
  return { width, height, colorType: bytes[25] };
}

async function verifyRendererSources(repository) {
  const sourceFiles = {};
  for (const name of RENDERER_FILES) {
    const bytes = await readFile(join(repository, name));
    if (!bytes.equals(await readFile(join(repository, 'dist', name)))) throw Error(`Generated OpenInterfaceMark renderer is stale or modified: ${name}`);
    sourceFiles[name] = hash(bytes);
  }
  return sourceFiles;
}

export async function checkInterfaceMarkDependencies(inputOptions = {}) {
  const repository = resolve(inputOptions.repository || DEFAULT_REPOSITORY), playwrightPath = resolve(inputOptions.playwrightPath || DEFAULT_PLAYWRIGHT);
  const checks = {};
  try { checks.commit = (await execFile('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim(); checks.pinnedCommit = checks.commit === OPENINTERFACEMARK_COMMIT; } catch { checks.pinnedCommit = false; }
  try { await execFile('git', ['diff', '--quiet', 'HEAD', '--'], { cwd: repository }); checks.sourceClean = true; } catch { checks.sourceClean = false; }
  try { await verifyRendererSources(repository); checks.dist = true; } catch { checks.dist = false; }
  try { await access('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'); checks.systemChrome = true; } catch { checks.systemChrome = false; }
  try { const module = await import(pathToFileURL(playwrightPath).href); checks.playwrightReady = typeof module.chromium?.launch === 'function'; } catch { checks.playwrightReady = false; }
  return { ready: ['pinnedCommit', 'sourceClean', 'dist', 'systemChrome', 'playwrightReady'].every(key => checks[key] === true), converter: 'OpenInterfaceMark', pinnedCommit: OPENINTERFACEMARK_COMMIT, repository, playwrightPath, checks };
}

async function serve(repository) {
  const root = join(repository, 'dist');
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method !== 'GET') { res.writeHead(405).end(); return; }
      const file = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
      if (!file.startsWith(root + sep) || !(await stat(file)).isFile()) throw Error('Not found');
      const bytes = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).end(bytes);
    } catch { res.writeHead(404).end('Not found'); }
  });
  await new Promise((ok, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ok); });
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

export async function convertInterfaceMark(inputOptions) {
  const options = validateInterfaceMarkOptions(inputOptions), repository = resolve(options.repository || DEFAULT_REPOSITORY);
  const progress = options.onProgress || (() => {}), signal = options.signal;
  signal?.throwIfAborted();
  const source = await readFile(options.projectPath);
  if (!source.length || source.length > 160000000) throw Error('OpenInterfaceMark project is empty or exceeds 160 MB');
  let raw;
  try { raw = JSON.parse(source.toString('utf8')); } catch { throw Error('OpenInterfaceMark project is not valid JSON'); }
  if (raw?.format !== 'open-interface-mark' || raw?.version !== 1) throw Error('An OpenInterfaceMark version 1 project is required');
  const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: repository });
  if (stdout.trim() !== OPENINTERFACEMARK_COMMIT) throw Error('OpenInterfaceMark checkout differs from the pinned, verified commit');
  await execFile('git', ['diff', '--quiet', 'HEAD', '--'], { cwd: repository });
  const rendererSources = await verifyRendererSources(repository);
  const core = await import(pathToFileURL(join(repository, 'src/core.js')).href);
  const project = validateInterfaceMarkProject(raw, core.validateProject);
  const sourceHash = hash(source), startedAt = new Date().toISOString();
  const sourceImage = Buffer.from(project.image.src.split(',')[1], 'base64');
  if (sourceImage.length > 32000000) throw Error('Embedded image exceeds the 32 MB upstream import limit');
  const names = [`${options.basename}.png`, `${options.basename}.svg`, `${options.basename}.oim.json`, `${options.basename}.conversion.json`];
  await mkdir(options.outputDir, { recursive: true });
  for (const name of names) try { await access(join(options.outputDir, name)); throw Error(`Refusing to overwrite existing artifact: ${name}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const staging = await mkdtemp(join(options.outputDir, '.openinterfacemark-'));
  let browser, hosting, published = [], committed = false;
  const aborted = () => { void browser?.close().catch(() => {}); };
  try {
    signal?.throwIfAborted();
    hosting = await serve(repository);
    const { chromium } = await import(pathToFileURL(resolve(options.playwrightPath || DEFAULT_PLAYWRIGHT)).href);
    browser = await chromium.launch({ channel: 'chrome', headless: true, timeout: options.timeoutMs });
    signal?.addEventListener('abort', aborted, { once: true });
    signal?.throwIfAborted();
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 960 }, serviceWorkers: 'block' });
    const requested = [], blockedRequests = [], pageErrors = [];
    await context.route('**/*', route => {
      const request = route.request(), entry = { url: request.url(), method: request.method() };
      requested.push(entry);
      if (entry.url.startsWith(hosting.origin + '/') && entry.method === 'GET') void route.continue();
      else { blockedRequests.push(entry); void route.abort(); }
    });
    const page = await context.newPage();
    page.setDefaultTimeout(options.timeoutMs);
    page.on('pageerror', error => pageErrors.push(error.message));
    progress('Importing the bound annotation plan into an isolated OpenInterfaceMark renderer');
    await page.goto(hosting.origin + '/?lang=en');
    await page.waitForFunction(() => !document.getElementById('export-button').disabled && !!document.getElementById('canvas-caption').textContent);
    await page.locator('#project-input').setInputFiles({ name: 'bound.oim.json', mimeType: 'application/json', buffer: source });
    await page.waitForFunction(name => !document.getElementById('export-button').disabled && document.getElementById('canvas-caption').textContent === name, project.name);
    await page.evaluate(() => document.fonts.ready);
    const displayImage = await page.locator('#image-name').textContent();
    if (displayImage !== project.image.name) throw Error('The bound source image was not loaded');
    await page.locator('#project-button').click();
    const savedDownload = page.waitForEvent('download');
    await page.locator('#save-project').click();
    await (await savedDownload).saveAs(join(staging, names[2]));
    const saved = JSON.parse(await readFile(join(staging, names[2]), 'utf8'));
    if (!isDeepStrictEqual(saved, project)) throw Error('Saved OpenInterfaceMark project differs from the bound input');
    await page.locator('#project-dialog button.close').click();
    let expectedRaster;
    for (const format of ['png', 'svg']) {
      progress(`Exporting annotated ${format.toUpperCase()}`);
      await page.locator('#export-button').click();
      await page.locator(`input[name="format"][value="${format}"]`).check();
      const size = { width: Number(await page.locator('#export-width').inputValue()), height: Number(await page.locator('#export-height').inputValue()) };
      if (!size.width || !size.height) throw Error('The renderer returned invalid export bounds');
      if (format === 'png') expectedRaster = size;
      const pending = page.waitForEvent('download');
      await page.locator('#download-export').click();
      await (await pending).saveAs(join(staging, `${options.basename}.${format}`));
      await page.waitForFunction(() => !document.getElementById('export-dialog').open);
    }
    const png = inspectInterfaceMarkPng(await readFile(join(staging, names[0])));
    if (png.width !== expectedRaster.width || png.height !== expectedRaster.height) throw Error('PNG dimensions differ from the actual renderer bounds');
    const svg = await readFile(join(staging, names[1]), 'utf8');
    if (!svg.startsWith('<?xml') || (svg.match(/<text /g) || []).length !== project.regions.length || !svg.includes(project.image.src)) throw Error('SVG regions or embedded source image do not match the project');
    for (const region of project.regions) {
      if (!svg.includes(`>${core.escapeXML(region.code)}</tspan>`) || !svg.includes(`>${core.escapeXML(region.title)}</tspan>`)) throw Error(`SVG is missing a bound annotation label: ${region.id}`);
    }
    if (pageErrors.length || blockedRequests.length) throw Error(`OpenInterfaceMark rendering error: ${pageErrors.join('; ') || 'nonlocal request blocked'}`);
    if (hash(await readFile(options.projectPath)) !== sourceHash) throw Error('Bound OpenInterfaceMark source changed during conversion');
    const artifacts = [];
    for (const name of names.slice(0, 3)) { const bytes = await readFile(join(staging, name)); artifacts.push({ name, path: join(options.outputDir, name), bytes: bytes.length, sha256: hash(bytes) }); }
    const manifest = {
      converter: { name: 'OpenInterfaceMark', version: '1.0.2', repository: 'https://github.com/geekheart/OpenInterfaceMark', commit: OPENINTERFACEMARK_COMMIT, license: 'MIT', execution: 'isolated-headless-chrome-local-renderer', sourceFiles: rendererSources },
      source: { path: options.projectPath, name: fileBasename(options.projectPath), bytes: source.length, sha256: sourceHash, embeddedImage: { name: project.image.name, bytes: sourceImage.length, sha256: hash(sourceImage), width: project.image.width, height: project.image.height } },
      regionCount: project.regions.length, regions: project.regions.map(({ id, code, title, x, y, w, h }) => ({ id, code, title, x, y, w, h })), png,
      verification: { freshContext: true, defaultExampleExported: false, boundProjectReadbackMatched: true, imageDecodedDimensionsMatched: true, sourceHashMatched: true, pngDimensionsMatched: true, svgLabelCountMatched: true, svgEmbeddedImageMatched: true, allRequestsLocalGet: requested.every(entry => entry.url.startsWith(hosting.origin + '/') && entry.method === 'GET'), pageErrors: [] },
      startedAt, completedAt: new Date().toISOString(), artifacts,
      limitations: ['Annotation identities and image-to-component coordinates are supplied and reviewed upstream; OpenInterfaceMark renders this plan and does not infer hardware features.', 'SVG uses the selected system fonts unless the caller embeds licensed local fonts; raster PNG is the portable document illustration.']
    };
    await writeFile(join(staging, names[3]), JSON.stringify(manifest, null, 2) + '\n');
    signal?.throwIfAborted();
    for (const name of names) { const target = join(options.outputDir, name); await link(join(staging, name), target); published.push(target); }
    committed = true;
    return { ...manifest, pngPath: join(options.outputDir, names[0]), svgPath: join(options.outputDir, names[1]), projectPath: join(options.outputDir, names[2]), manifestPath: join(options.outputDir, names[3]) };
  } finally {
    signal?.removeEventListener('abort', aborted);
    await browser?.close().catch(() => {});
    await new Promise(ok => hosting?.server ? hosting.server.close(ok) : ok());
    if (!committed) for (const target of published) await rm(target, { force: true });
    await rm(staging, { recursive: true, force: true });
  }
}

function cliOptions(argv) {
  const fields = { '--project': 'projectPath', '--output-dir': 'outputDir', '--basename': 'basename', '--timeout-ms': 'timeoutMs' }, options = {};
  for (let i = 0; i < argv.length; i += 2) { const key = fields[argv[i]]; if (!key || argv[i + 1] === undefined || Object.hasOwn(options, key)) throw Error(`Unknown, repeated, or incomplete argument: ${argv[i]}`); options[key] = key === 'timeoutMs' ? Number(argv[i + 1]) : argv[i + 1]; }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => controller.abort(Error('Conversion cancelled')));
  try { const result = process.argv.length === 3 && process.argv[2] === '--check' ? await checkInterfaceMarkDependencies() : await convertInterfaceMark({ ...cliOptions(process.argv.slice(2)), signal: controller.signal, onProgress: text => process.stderr.write(`[OpenInterfaceMark] ${text}\n`) }); process.stdout.write(JSON.stringify(result) + '\n'); }
  catch (error) { process.stderr.write(`[OpenInterfaceMark] ${error.message}\n`); process.exitCode = 1; }
}
