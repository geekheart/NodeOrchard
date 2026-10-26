import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat, access, rm, link, mkdtemp } from 'node:fs/promises';
import { resolve, dirname, extname, basename as fileBasename, sep, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile as callbackExecFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { runInNewContext } from 'node:vm';

const execFile = promisify(callbackExecFile);
export const OPENPINMAP_COMMIT = 'de6196839c6cf8126f4bf29b9792f73c17013b44';
const WORKBENCH = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_REPOSITORY = join(WORKBENCH, '.local/converters/OpenPinMap');
const DEFAULT_PLAYWRIGHT = join(WORKBENCH, '.local/converters/OpenStep2DWG/node_modules/playwright-core/index.mjs');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function validatePinoutOptions(options = {}) {
  const { projectPath, outputDir, basename, timeoutMs = 180000 } = options;
  if (typeof projectPath !== 'string' || !projectPath || !/\.json$/i.test(projectPath)) throw Error('projectPath must be a local OpenPinMap JSON file');
  if (typeof outputDir !== 'string' || !outputDir) throw Error('outputDir is required');
  if (typeof basename !== 'string' || !basename.trim() || basename.length > 180 || /[\\/\x00-\x1f]/.test(basename) || /^\.{1,2}$/.test(basename)) throw Error('basename must be a safe filename without extension');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw Error('timeoutMs must be between 1000 and 600000');
  return { ...options, projectPath: resolve(projectPath), outputDir: resolve(outputDir), basename, timeoutMs };
}

export function validateBoundProject(raw, modelSource) {
  if (raw?.format !== 'openpinmap' || raw?.version !== 2) throw Error('A bound OpenPinMap version 2 project is required');
  const context = {};
  runInNewContext(modelSource, context, { timeout: 1000 });
  const state = JSON.parse(JSON.stringify(context.OpenPinMapModel.validateProject(raw)));
  const pinCount = state.groups.reduce((total, group) => total + group.pins.length, 0);
  if (!pinCount) throw Error('Pinout project must contain actual pins');
  if (!state.imageData || state.imageData.length > 40000000) throw Error('Pinout image is missing or exceeds the 40 MB project budget');
  // Invalid numeric values are clamped by the editor; unattended conversion must
  // refuse any changed electrical labels or geometry rather than silently fix it.
  for (const key of ['name', 'width', 'height', 'background', 'fontSize', 'fontFamily', 'guides', 'imageX', 'imageY', 'imageScale', 'imageRotation']) {
    if (Object.hasOwn(raw.state, key) && state[key] !== raw.state[key]) throw Error(`Project ${key} would be changed by the upstream validator`);
  }
  if (JSON.stringify(state.groups.map(group => group.pins)) !== JSON.stringify(raw.state.groups.map(group => group.pins))) throw Error('Project pin data would be changed by the upstream validator');
  raw.state.groups.forEach((group, index) => {
    for (const key of ['connector', 'start', 'gap', 'scale', 'layout', 'textDirection', 'labelRotation', 'rotation', 'mirrorX', 'mirrorY']) if (Object.hasOwn(group, key) && !isDeepStrictEqual(group[key], state.groups[index][key])) throw Error(`Project group ${index+1} ${key} would be changed by the upstream validator`);
  });
  return { format: 'openpinmap', version: 2, state };
}

export function inspectPinoutPng(bytes) {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.subarray(12, 16).toString() !== 'IHDR') throw Error('Export is not a PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colorType: bytes[25] };
}

// Self-contained so the same measurement code runs in the isolated renderer.
// Diagnostic metadata never changes the dimensions supplied by OpenPinMap.
export function measurePinoutLabelMetrics(state) {
  const ctx = document.createElement('canvas').getContext('2d');
  return state.groups.map(group => {
    if (group.textDirection !== 'horizontal') throw Error('Prepared Pinout requires horizontal text');
    const fontSize = group.font?.size || state.fontSize;
    ctx.font = `${fontSize}px ${state.fontFamily}`;
    let width = 0, height = 0;
    const measuredLabels = [];
    for (const pin of group.pins) {
      const measured = ctx.measureText(pin.name || ' ');
      const glyphHeight = (measured.actualBoundingBoxAscent || fontSize*.75)+(measured.actualBoundingBoxDescent || 0);
      width = Math.max(width, measured.width); height = Math.max(height, glyphHeight);
      measuredLabels.push({ label: pin.name, glyphHeight });
    }
    return { width: Math.ceil(width)+state.fontSize*2, height: Math.ceil(height || fontSize*.75)+Math.floor(state.fontSize*.4)*2,
      fontSize, glyphHeight: height, heightDrivers: [...new Set(measuredLabels.filter(item => item.glyphHeight === height).map(item => item.label))] };
  });
}

export function resolvePreparedAlignment(project, alignment, metrics) {
  if (alignment?.version !== 1 || !Array.isArray(alignment.anchors) || alignment.anchors.length !== project.state.groups.length || metrics.length !== project.state.groups.length) throw Error('Invalid prepared Pinout alignment');
  const resolved = structuredClone(project), { state } = resolved;
  const image = alignment.image;
  if (!image || !Number.isFinite(image.width) || !Number.isFinite(image.height)) throw Error('Prepared alignment is missing source image dimensions');
  const style = alignment.displayPlan?.style, compact = style?.preset === 'reference-compact';
  const gap = style ? style.labelGapPx : 30;
  if (!Number.isFinite(gap) || gap < 0 || gap > (style ? 8 : 30)) throw Error('Prepared label gap is invalid');
  if (style && (state.background !== style.background || state.guides !== style.guides || state.fontSize !== style.fontSize || !isDeepStrictEqual(state.palette, style.palette))) throw Error('Bound Pinout differs from its validated Skill display plan');
  if (compact) {
    if (state.imageScale !== 100 || state.imageRotation !== 0 || state.groups.some(group => group.layout !== 'vertical' || group.labelRotation !== 0)) throw Error('Compact photograph Pinout requires native-scale upright vertical headers');
    const sizes = metrics.map(metric => metric.width);
    const left = Math.max(0, ...sizes.filter((_, index) => alignment.anchors[index].side === 'left'));
    const right = Math.max(0, ...sizes.filter((_, index) => alignment.anchors[index].side === 'right'));
    if (alignment.anchors.some(anchor => !['left', 'right'].includes(anchor.side))) throw Error('Compact photograph Pinout has an unsupported header side');
    const padding = 12;
    state.imageX = padding+left+gap;
    state.width = Math.ceil(padding*2+left+right+gap*2+image.width);
    state.height = Math.ceil(Math.max(image.height+40, state.width+40));
    state.imageY = Math.floor((state.height-image.height)/2);
  }
  const checked = [];
  state.groups.forEach((group, index) => {
    const anchor = alignment.anchors[index], metric = metrics[index];
    if (anchor.connector !== group.connector || !['left', 'right', 'top', 'bottom'].includes(anchor.side) || !Array.isArray(anchor.firstPadPixel) || anchor.firstPadPixel.length !== 2 || !anchor.firstPadPixel.every(Number.isFinite)) throw Error('Prepared connector anchor mismatch');
    if (!Number.isFinite(metric.width) || !Number.isFinite(metric.height) || metric.width <= 0 || metric.height <= 0 || group.rotation || group.mirrorX || group.mirrorY || group.scale !== 1) throw Error('Prepared Pinout has unsupported label transforms');
    const rotated = [90, 270].includes(group.labelRotation), width = rotated ? metric.height : metric.width, height = rotated ? metric.width : metric.height;
    if (compact && (!Array.isArray(anchor.firstPadImagePixel) || anchor.firstPadImagePixel.length !== 2 || !anchor.firstPadImagePixel.every(Number.isFinite))) throw Error('Compact photo alignment is missing calibrated pad coordinates');
    const [x, y] = compact ? [state.imageX+anchor.firstPadImagePixel[0], state.imageY+anchor.firstPadImagePixel[1]] : anchor.firstPadPixel;
    group.start = anchor.side === 'left' ? [state.imageX - gap - width, y - height/2] : anchor.side === 'right' ? [state.imageX + image.width*state.imageScale/100 + gap, y-height/2] : anchor.side === 'top' ? [x-width/2, state.imageY-gap-height] : [x-width/2, state.imageY+image.height*state.imageScale/100+gap];
    const w = width + (group.layout === 'horizontal' ? (group.pins.length-1)*group.gap : 0), h = height + (group.layout === 'vertical' ? (group.pins.length-1)*group.gap : 0);
    if (group.start[0] < 0 || group.start[1] < 0 || group.start[0]+w > state.width || group.start[1]+h > state.height || group.gap < (group.layout === 'horizontal' ? width : height)) {
      const drivers = Array.isArray(metric.heightDrivers) ? metric.heightDrivers : [];
      const heightDetail = `fontSize ${metric.fontSize ?? state.fontSize ?? 'unknown'} px; capsule height ${height} px / pin pitch ${group.gap} px; maximum glyph-height label(s) ${JSON.stringify(drivers)}${Number.isFinite(metric.glyphHeight) ? ` (${metric.glyphHeight} px glyph height)` : ''}`;
      const advice = group.layout === 'vertical' ? 'labelGapPx controls horizontal spacing and cannot reduce row height. Choose a semantic-preserving display alias from the allowedLabels candidates; the renderer will not change aliases automatically.' : 'Choose a semantic-preserving display alias from the allowedLabels candidates; the renderer will not change aliases automatically.';
      throw Error(`Readable Pinout labels overlap or exceed the prepared canvas (${group.connector}: label ${width}×${height}, pitch ${group.gap}, start ${group.start}, bounds ${state.width}×${state.height}); ${heightDetail}. ${advice}`);
    }
    const expected = group.layout === 'horizontal' ? x : y, actual = group.layout === 'horizontal' ? group.start[0]+width/2 : group.start[1]+height/2;
    if (Math.abs(expected-actual) > 0.01) throw Error('Pinout label center is not aligned to the native first pad');
    let maxAlignmentErrorPx = Math.abs(expected-actual), padCenters = null;
    if (anchor.padImagePixels) {
      if (!Array.isArray(anchor.padImagePixels) || anchor.padImagePixels.length !== group.pins.length || anchor.padImagePixels.some(point => !Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite))) throw Error('Prepared calibrated pad list differs from the source pins');
      padCenters = anchor.padImagePixels.map(point => [state.imageX+point[0]*state.imageScale/100, state.imageY+point[1]*state.imageScale/100]);
      maxAlignmentErrorPx = Math.max(maxAlignmentErrorPx, ...padCenters.map((point, pinIndex) => Math.abs(point[group.layout === 'horizontal' ? 0 : 1]-(actual+pinIndex*group.gap))));
      if (maxAlignmentErrorPx > 1.5) throw Error('Pinout label row differs from an actual calibrated pad by more than 1.5 px');
    }
    checked.push({ connector: group.connector, side: anchor.side, firstPadPixel: [x, y], labelSize: [width, height], labelStart: group.start, pitchPx: group.gap, maxAlignmentErrorPx, edgeGapPx: gap, ...(padCenters ? { padCenters } : {}) });
  });
  return { project: resolved, verification: { sourceSha256: alignment.sourceSha256, pcbUuid: alignment.pcbUuid, imageSha256: alignment.imageSha256, ...(alignment.photograph ? { photograph: structuredClone(alignment.photograph) } : {}), ...(alignment.displayPlan ? { displayPlan: structuredClone(alignment.displayPlan), aliasMapping: structuredClone(alignment.aliasMapping) } : {}), labelCentersResolvedUsingRendererFontMetrics: true, connectors: checked } };
}

export async function checkPinoutDependencies(inputOptions = {}) {
  const repository = resolve(inputOptions.repository || DEFAULT_REPOSITORY), playwrightPath = resolve(inputOptions.playwrightPath || DEFAULT_PLAYWRIGHT);
  const checks = {};
  try { checks.commit = (await execFile('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim(); checks.pinnedCommit = checks.commit === OPENPINMAP_COMMIT; } catch { checks.pinnedCommit = false; }
  try { await execFile('git', ['diff', '--quiet', 'HEAD', '--'], { cwd: repository }); checks.sourceClean = true; } catch { checks.sourceClean = false; }
  try { await verifyRendererSources(repository); checks.dist = true; } catch { checks.dist = false; }
  try { await access('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'); checks.systemChrome = true; } catch { checks.systemChrome = false; }
  try { const module = await import(pathToFileURL(playwrightPath).href); checks.playwrightReady = typeof module.chromium?.launch === 'function'; } catch { checks.playwrightReady = false; }
  return { ready: ['pinnedCommit', 'sourceClean', 'dist', 'systemChrome', 'playwrightReady'].every(key => checks[key] === true), converter: 'OpenPinMap', pinnedCommit: OPENPINMAP_COMMIT, repository, playwrightPath, checks };
}

async function verifyRendererSources(repository) {
  for (const name of ['index.html', 'style.css', 'app.js', 'src/i18n.js', 'src/model.js', 'src/geometry.js', 'src/export.js']) {
    if (!(await readFile(join(repository, name))).equals(await readFile(join(repository, 'dist', name)))) throw Error(`Generated OpenPinMap renderer is stale or modified: ${name}`);
  }
}

async function serve(repository, project) {
  const root = join(repository, 'dist');
  await access(join(root, 'index.html'));
  const { imageData, ...defaults } = project.state;
  const boundDefaults = `window.PIN_DEFAULTS=${JSON.stringify(defaults)};window.PIN_DEFAULT_IMAGE=${JSON.stringify(imageData)};`;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method !== 'GET') { res.writeHead(405).end(); return; }
      if (url.pathname === '/defaults.js') { res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }).end(boundDefaults); return; }
      const file = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
      if (!file.startsWith(root + sep) || !(await stat(file)).isFile()) throw Error('Not found');
      const bytes = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).end(bytes);
    } catch { res.writeHead(404).end('Not found'); }
  });
  await new Promise((ok, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ok); });
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

export async function convertPinout(inputOptions) {
  const options = validatePinoutOptions(inputOptions), repository = resolve(options.repository || DEFAULT_REPOSITORY);
  const progress = options.onProgress || (() => {}), signal = options.signal;
  const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: repository });
  if (stdout.trim() !== OPENPINMAP_COMMIT) throw Error('OpenPinMap checkout differs from the pinned, verified commit');
  await execFile('git', ['diff', '--quiet', 'HEAD', '--'], { cwd: repository });
  await verifyRendererSources(repository);
  const source = await readFile(options.projectPath);
  if (!source.length || source.length > 40000000) throw Error('OpenPinMap project is empty or exceeds 40 MB');
  const raw = JSON.parse(source.toString('utf8'));
  let project = validateBoundProject(raw, await readFile(join(repository, 'src/model.js'), 'utf8')), alignmentVerification = null;
  const pinCount = project.state.groups.reduce((total, group) => total + group.pins.length, 0);
  const sourceHash = hash(source), startedAt = new Date().toISOString();
  const names = [`${options.basename}.png`, `${options.basename}.svg`, `${options.basename}.openpinmap.json`, `${options.basename}.conversion.json`];
  await mkdir(options.outputDir, { recursive: true });
  for (const name of names) try { await access(join(options.outputDir, name)); throw Error(`Refusing to overwrite existing artifact: ${name}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const staging = await mkdtemp(join(options.outputDir, '.openpinmap-'));
  let browser, hosting, published = [], committed = false;
  const aborted = () => { void browser?.close().catch(() => {}); };
  try {
    signal?.throwIfAborted();
    hosting = await serve(repository, project);
    const { chromium } = await import(pathToFileURL(resolve(options.playwrightPath || DEFAULT_PLAYWRIGHT)).href);
    browser = await chromium.launch({ channel: 'chrome', headless: true, timeout: options.timeoutMs });
    signal?.addEventListener('abort', aborted, { once: true });
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
    progress('Loading only the bound OpenPinMap project in an isolated local renderer');
    await page.goto(hosting.origin + '/?lang=en');
    await page.waitForFunction(() => document.querySelector('#source-thumbnail')?.getAttribute('src')?.startsWith('data:image/') && document.querySelector('#preview')?.width > 1);
    if (await page.locator('#project-name').inputValue() !== project.state.name) throw Error('Bound project name was not loaded');
    if (raw.workbenchAlignment) {
      const metrics = await page.evaluate(measurePinoutLabelMetrics, project.state);
      const aligned = resolvePreparedAlignment(project, raw.workbenchAlignment, metrics);
      project = aligned.project; alignmentVerification = aligned.verification;
      await page.locator('#project-file').setInputFiles({ name: 'bound.openpinmap.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)) });
      await page.waitForFunction(() => document.getElementById('toast').textContent === 'Project restored.');
    }
    const savedDownload = page.waitForEvent('download');
    await page.locator('#save-project').click();
    await (await savedDownload).saveAs(join(staging, names[2]));
    const saved = JSON.parse(await readFile(join(staging, names[2]), 'utf8'));
    if (!isDeepStrictEqual(saved, project)) throw Error('Saved OpenPinMap project differs from the bound input');
    await page.locator('#export-png').click();
    for (const format of ['png', 'svg']) {
      progress(`Exporting Pinout ${format.toUpperCase()}`);
      await page.locator('#export-format').selectOption(format);
      // Preserve the exact bound source image in SVG rather than silently
      // replace it with a recompressed WebP asset.
      if (format === 'svg') await page.locator('#export-optimize').uncheck();
      await page.waitForFunction(() => !document.getElementById('download-export').disabled || !!document.getElementById('export-error').textContent);
      const error = await page.locator('#export-error').textContent();
      if (error) throw Error(error);
      const pending = page.waitForEvent('download');
      await page.locator('#download-export').click();
      await (await pending).saveAs(join(staging, `${options.basename}.${format}`));
    }
    const png = inspectPinoutPng(await readFile(join(staging, names[0])));
    if (png.width !== Math.round(project.state.width * project.state.exportSettings.scale) || png.height !== Math.round(project.state.height * project.state.exportSettings.scale)) throw Error('PNG output dimensions differ from the bound project');
    const svg = await readFile(join(staging, names[1]), 'utf8');
    const glyphCount = project.state.groups.reduce((sum, group) => sum + group.pins.reduce((count, pin) => count + (group.textDirection === 'vertical' ? Array.from(pin.name).length : 1), 0), 0);
    if (!svg.startsWith('<svg ') || (svg.match(/<text /g) || []).length !== glyphCount || !svg.includes(project.state.imageData)) throw Error('SVG labels or embedded source image do not match the project');
    if (pageErrors.length || blockedRequests.length) throw Error(`OpenPinMap rendering error: ${pageErrors.join('; ') || 'nonlocal request blocked'}`);
    if (hash(await readFile(options.projectPath)) !== sourceHash) throw Error('Bound OpenPinMap source changed during conversion');
    const artifacts = [];
    for (const name of names.slice(0, 3)) { const bytes = await readFile(join(staging, name)); artifacts.push({ name, path: join(options.outputDir, name), bytes: bytes.length, sha256: hash(bytes) }); }
    const manifest = {
      converter: { name: 'OpenPinMap', version: '1.2.0', repository: 'https://github.com/geekheart/OpenPinMap', commit: OPENPINMAP_COMMIT, license: 'MIT', execution: 'isolated-headless-chrome-local-renderer' },
      source: { path: options.projectPath, name: fileBasename(options.projectPath), bytes: source.length, sha256: sourceHash },
      pinCount, groupCount: project.state.groups.length, canvas: { width: project.state.width, height: project.state.height, paper: project.state.paper },
      verification: { freshContext: true, defaultExampleUsed: false, boundProjectReadbackMatched: true, sourceHashMatched: true, pngDimensionsMatched: true, svgLabelCountMatched: true, svgEmbeddedImageMatched: true, allRequestsLocalGet: requested.every(entry => entry.url.startsWith(hosting.origin + '/') && entry.method === 'GET'), pageErrors: [] },
      alignment: alignmentVerification, startedAt, completedAt: new Date().toISOString(), artifacts,
      limitations: ['Electrical connectivity and pad-to-image alignment must be validated by the upstream epro2 fact preparation; OpenPinMap is a renderer and does not infer them.']
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
  try { const result = process.argv.length === 3 && process.argv[2] === '--check' ? await checkPinoutDependencies() : await convertPinout({ ...cliOptions(process.argv.slice(2)), signal: controller.signal, onProgress: text => process.stderr.write(`[OpenPinMap] ${text}\n`) }); process.stdout.write(JSON.stringify(result) + '\n'); }
  catch (error) { process.stderr.write(`[OpenPinMap] ${error.message}\n`); process.exitCode = 1; }
}
