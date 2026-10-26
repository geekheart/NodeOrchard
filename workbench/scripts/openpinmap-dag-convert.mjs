// The DAG adapter preserves the existing isolated converter. Only a verified
// parent-process layout throw is classified as a correctable display choice.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { convertPinout, resolvePreparedAlignment } from './openpinmap-convert.mjs';

const SOURCE_URL = new URL('./openpinmap-convert.mjs', import.meta.url).href;
const SOURCE = await readFile(fileURLToPath(SOURCE_URL), 'utf8');
const THROW_MARKER = 'throw Error(`Readable Pinout labels overlap or exceed the prepared canvas (';
const throwOffset = SOURCE.indexOf(THROW_MARKER);
const functionBody = resolvePreparedAlignment.toString();
const functionOffset = SOURCE.indexOf(functionBody);
const sourceKnown = throwOffset >= 0 && SOURCE.indexOf(THROW_MARKER, throwOffset + 1) === -1
  && functionOffset >= 0 && functionBody.includes(THROW_MARKER);
const throwLine = sourceKnown ? SOURCE.slice(0, throwOffset).split('\n').length : -1;
const functionFirstLine = sourceKnown ? SOURCE.slice(0, functionOffset).split('\n').length : -1;
const functionLastLine = functionFirstLine + functionBody.split('\n').length - 1;
const escapedURL = SOURCE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const throwFrame = new RegExp('(?:^|[ (])' + escapedURL + ':' + throwLine + ':\\d+\\)?$');
const namedFrame = new RegExp('^\\s*at resolvePreparedAlignment \\(' + escapedURL + ':(\\d+):\\d+\\)$');

export function isPinoutLayoutError(error) {
  if (!sourceKnown || !(error instanceof Error) || error.name !== 'Error'
    || typeof error.message !== 'string'
    || !error.message.startsWith('Readable Pinout labels overlap or exceed the prepared canvas (')
    || !error.message.includes('; capsule height ')
    || !error.message.includes('Choose a semantic-preserving display alias from the allowedLabels candidates;')) return false;
  // Do not inspect browser messages or stderr. The actual JS throw site and
  // enclosing exported function must both be in this imported parent module.
  const frames = String(error.stack || '').split('\n').filter(line => /^\s*at /.test(line));
  if (!frames.length || !throwFrame.test(frames[0])) return false;
  return frames.slice(1).some(frame => {
    const match = namedFrame.exec(frame);
    return !!match && Number(match[1]) >= functionFirstLine && Number(match[1]) <= functionLastLine;
  });
}

export function pinoutDAGFailure(error) {
  return { ok: false, code: isPinoutLayoutError(error) ? 'PINOUT_LAYOUT_INVALID' : 'PINOUT_CONVERSION_FAILED',
    error: String(error?.message || error || 'Pinout conversion failed').slice(0, 16000) };
}

export function validateDAGPinoutRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).length !== 3 || Object.keys(request).some(key => !['projectPath', 'outputDir', 'basename'].includes(key))) throw Error('Expected projectPath, outputDir and basename only');
  for (const key of ['projectPath', 'outputDir', 'basename']) if (typeof request[key] !== 'string' || !request[key].trim()) throw Error(key + ' is required');
  return { projectPath: request.projectPath, outputDir: request.outputDir, basename: request.basename };
}

export async function convertDAGPinout(request, { signal, onProgress } = {}) {
  // All project validation, native font measurement, browser isolation, pinned
  // upstream sources, atomic publication and cleanup remain in the old module.
  return convertPinout({ ...validateDAGPinoutRequest(request), signal, onProgress });
}

export function parseDAGPinoutArguments(argv) {
  const fields = { '--project': 'projectPath', '--output-dir': 'outputDir', '--basename': 'basename' }, request = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = fields[argv[index]];
    if (!key || argv[index + 1] === undefined || Object.hasOwn(request, key)) throw Error('Unknown, repeated, or incomplete argument: ' + argv[index]);
    request[key] = argv[index + 1];
  }
  return validateDAGPinoutRequest(request);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => controller.abort(Error('Conversion cancelled')));
  try {
    let request;
    if (process.argv.length > 2) request = parseDAGPinoutArguments(process.argv.slice(2));
    else {
      const chunks = []; let length = 0;
      for await (const chunk of process.stdin) {
        length += chunk.length;
        if (length > 16384) throw Error('Pinout DAG request exceeds 16 KiB');
        chunks.push(chunk);
      }
      request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    const output = await convertDAGPinout(request, { signal: controller.signal,
      onProgress: text => process.stderr.write('[OpenPinMap] ' + text + '\n') });
    process.stdout.write(JSON.stringify({ ok: true, output }) + '\n');
  } catch (error) {
    // A structured failure remains data for the trusted Python parent, which
    // alone decides whether learning may continue. The old CLI is unchanged.
    process.stdout.write(JSON.stringify(pinoutDAGFailure(error)) + '\n');
  }
}
