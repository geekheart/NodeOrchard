import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isIP } from 'node:net';

const execute = promisify(execFile);
const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];
const fields = new Set(['HTTPEnable', 'HTTPProxy', 'HTTPPort', 'HTTPSEnable', 'HTTPSProxy', 'HTTPSPort']);
const loopback = ['localhost', '127.0.0.1', '::1'];

async function readSystemProxy() {
  const { stdout } = await execute('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8', timeout: 1000, maxBuffer: 64 * 1024 });
  return stdout;
}

// scutil emits nested dictionaries/arrays, not JSON. Only root static fields
// and the root ExceptionsList array are relevant; PAC/SOCKS settings stay data.
function parseSystemProxy(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 64 * 1024) return null;
  const result = { values: new Map(), exceptions: [] }, stack = [];
  let started = false, closed = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (!started) {
      if (line !== '<dictionary> {') return null;
      started = true; stack.push({ kind: 'dictionary' }); continue;
    }
    if (closed) return null;
    if (line === '}') {
      stack.pop(); closed = stack.length === 0; continue;
    }
    const entry = raw.replace(/^[ \t]*/, '').match(/^([A-Za-z0-9_]+) : (.*)$/);
    if (!entry) return null;
    const [, key, value] = entry, container = value.match(/^<(dictionary|array)> \{$/);
    if (container) { stack.push({ kind: container[1], key }); continue; }
    if (stack.length === 1 && fields.has(key)) {
      if (result.values.has(key)) return null;
      result.values.set(key, value);
    } else if (stack.length === 2 && stack[1].key === 'ExceptionsList' && stack[1].kind === 'array' && /^\d+$/.test(key)) {
      result.exceptions.push(value);
    }
  }
  return started && closed ? result : null;
}

function safeHost(value) {
  if (typeof value !== 'string' || !value || value.length > 253 || !/^[A-Za-z0-9.:[\]-]+$/.test(value)) return null;
  let host = value;
  if (host.startsWith('[') || host.endsWith(']')) {
    if (!host.startsWith('[') || !host.endsWith(']')) return null;
    host = host.slice(1, -1);
    if (isIP(host) !== 6) return null;
  }
  if (host.includes(':')) return isIP(host) === 6 ? { host: host.toLowerCase(), ipv6: true } : null;
  if (isIP(host) === 4) return { host, ipv6: false };
  if (/^[\d.]+$/.test(host)) return null;
  const domain = host.endsWith('.') ? host.slice(0, -1) : host;
  if (!domain.split('.').every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) return null;
  return { host: host.toLowerCase(), ipv6: false };
}

function proxyAddress(values, protocol) {
  if (values.get(protocol + 'Enable') !== '1') return null;
  const host = safeHost(values.get(protocol + 'Proxy')), port = values.get(protocol + 'Port');
  if (!host || !/^\d{1,5}$/.test(port || '') || Number(port) < 1 || Number(port) > 65535) return null;
  // HTTPSProxy is an HTTP CONNECT proxy for HTTPS destinations, rather than a
  // declaration that the connection to the proxy itself uses TLS.
  return 'http://' + (host.ipv6 ? '[' + host.host + ']' : host.host) + ':' + Number(port);
}

function exception(value) {
  if (typeof value !== 'string' || !value || value.length > 260 || /[\s\x00-\x1f\x7f]/.test(value)) return null;
  if (value.includes('/')) {
    const parts = value.split('/');
    if (parts.length !== 2 || !/^(?:0|[1-9]\d{0,2})$/.test(parts[1])) return null;
    let address = parts[0];
    // macOS commonly emits abbreviated IPv4 networks such as 169.254/16.
    // Complete the address for NO_PROXY consumers that require CIDR notation.
    const octets = address.split('.');
    if (octets.length < 4 && octets.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
      address = [...octets.map(Number), ...Array(4 - octets.length).fill(0)].join('.');
    }
    const host = safeHost(address), version = host && isIP(host.host), prefix = Number(parts[1]);
    if (!version || prefix > (version === 4 ? 32 : 128)) return null;
    return host.host + '/' + prefix;
  }
  if (value.startsWith('*.') || value.startsWith('.')) {
    const host = safeHost(value.slice(value.startsWith('*.') ? 2 : 1));
    return host && !host.ipv6 && !isIP(host.host) ? '.' + host.host : null;
  }
  return safeHost(value)?.host || null;
}

// Called for each child spawn with the already merged environment. Nothing is
// cached or written to process.env, system settings, or Hermes configuration.
export async function resolveHermesProxyEnvironment(env, { platform = process.platform, readSystemProxy: read = readSystemProxy } = {}) {
  const child = { ...env };
  if (proxyKeys.some(key => Object.hasOwn(child, key))) return { env: child, diagnostics: { source: 'explicit', status: 'preserved' } };
  if (platform !== 'darwin') return { env: child, diagnostics: { source: 'none', status: 'skipped', code: 'platform_unsupported' } };
  let settings;
  try { settings = parseSystemProxy(await read()); }
  catch { return { env: child, diagnostics: { source: 'none', status: 'unavailable', code: 'system_proxy_read_failed' } }; }
  let count = 0;
  for (const protocol of ['HTTP', 'HTTPS']) {
    const value = settings && proxyAddress(settings.values, protocol);
    if (!value) continue;
    child[protocol + '_PROXY'] = value; child[protocol.toLowerCase() + '_proxy'] = value; count++;
  }
  if (!count) return { env: child, diagnostics: { source: 'none', status: 'skipped', code: 'no_static_proxy' } };
  if (!Object.hasOwn(child, 'NO_PROXY') && !Object.hasOwn(child, 'no_proxy')) {
    child.NO_PROXY = [...new Set([...settings.exceptions.map(exception).filter(Boolean), ...loopback])].join(',');
    child.no_proxy = child.NO_PROXY;
  }
  return { env: child, diagnostics: { source: 'system', status: 'applied', count } };
}
