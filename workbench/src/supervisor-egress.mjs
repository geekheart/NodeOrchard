import { createServer, request as httpRequest, Agent } from 'node:http';
import { connect as netConnect, isIP } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { lookup as dnsLookup } from 'node:dns/promises';

const LIMITS = Object.freeze({ requests: 32, requestBytes: 16 * 1024 * 1024, responseBytes: 64 * 1024 * 1024, tunnelBytes: 512 * 1024 * 1024, connectMs: 15000 });
const blocked = () => Object.assign(new Error('Supervisor egress destination is unavailable.'), { statusCode: 403 });
const hops = new Set(['connection', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const hostName = value => value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
function publicAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || address === '168.63.129.16' || a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254
      || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2) || b === 88 && c === 99)
      || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  if (family !== 6) return false;
  // Restrict IPv6 to global unicast. This excludes mapped IPv4, NAT64, ULA,
  // link-local, multicast and loopback without relying on textual prefixes.
  const [left, right = ''] = address.toLowerCase().split('::'), front = left ? left.split(':') : [], back = right ? right.split(':') : [];
  if ([...front, ...back].some(word => word.includes('.'))) return false;
  const words = [...front, ...Array(8 - front.length - back.length).fill('0'), ...back].map(word => parseInt(word, 16));
  if (words.length !== 8 || (words[0] & 0xe000) !== 0x2000) return false;
  return !(words[0] === 0x2002 || words[0] === 0x2001 && (words[1] === 0 || words[1] === 0xdb8 || words[1] >= 0x10 && words[1] <= 0x2f || words[1] === 2 && words[2] === 0)
    || words[0] === 0x3fff && words[1] < 0x1000);
}
function proxyURL(env, secure) {
  const raw = secure ? env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy : env.HTTP_PROXY || env.http_proxy || env.HTTPS_PROXY || env.https_proxy;
  if (!raw) return null;
  let parsed; try { parsed = new URL(raw); } catch { throw blocked(); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.pathname !== '/' || parsed.search || parsed.hash) throw blocked();
  return parsed;
}
function authority(host, port) { return (isIP(host) === 6 ? '[' + host + ']' : host) + ':' + port; }
function boundedLookup(factory, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', failed); };
    const failed = () => { cleanup(); reject(blocked()); };
    if (signal.aborted) return failed();
    timer = setTimeout(failed, LIMITS.connectMs); timer.unref?.(); signal.addEventListener('abort', failed, { once: true });
    Promise.resolve().then(factory).then(value => { cleanup(); resolve(value); }, failed);
  });
}
async function openSocket(options) {
  if (options.signal?.aborted) throw blocked();
  return await new Promise((resolve, reject) => {
    const socket = options.secure ? tlsConnect({ host: options.host, port: options.port, servername: isIP(options.host) ? undefined : options.host }) : netConnect({ host: options.host, port: options.port });
    let timer;
    const cleanup = () => { clearTimeout(timer); socket.off('error', failed); options.signal?.removeEventListener('abort', failed); };
    const failed = () => { cleanup(); socket.destroy(); reject(blocked()); };
    timer = setTimeout(failed, LIMITS.connectMs); timer.unref?.();
    socket.on('error', () => {}); socket.once('error', failed); options.signal?.addEventListener('abort', failed, { once: true });
    socket.once(options.secure ? 'secureConnect' : 'connect', () => { cleanup(); resolve(socket); });
  });
}
async function connectTransport({ address, port, upstream, signal }) {
  if (!upstream) return await openSocket({ host: address, port, signal });
  const socket = await openSocket({ host: hostName(upstream.hostname), port: Number(upstream.port) || (upstream.protocol === 'https:' ? 443 : 80), secure: upstream.protocol === 'https:', signal });
  const destination = authority(address, port);
  let auth = '';
  if (upstream.username || upstream.password) {
    let user, password; try { user = decodeURIComponent(upstream.username); password = decodeURIComponent(upstream.password); } catch { socket.destroy(); throw blocked(); }
    auth = 'Proxy-Authorization: Basic ' + Buffer.from(user + ':' + password).toString('base64') + '\r\n';
  }
  return await new Promise((resolve, reject) => {
    let response = Buffer.alloc(0);
    const timer = setTimeout(failed, LIMITS.connectMs); timer.unref?.();
    function cleanup() { clearTimeout(timer); socket.off('data', data); socket.off('error', failed); socket.off('end', failed); signal?.removeEventListener('abort', failed); }
    function failed() { cleanup(); socket.destroy(); reject(blocked()); }
    function data(chunk) {
      response = Buffer.concat([response, chunk]);
      if (response.length > 16384) return failed();
      const boundary = response.indexOf('\r\n\r\n'); if (boundary < 0) return;
      if (!/^HTTP\/1\.[01] 200(?: |\r)/.test(response.toString('latin1', 0, boundary))) return failed();
      cleanup(); const rest = response.subarray(boundary + 4); if (rest.length) socket.unshift(rest); resolve(socket);
    }
    socket.on('data', data); socket.once('error', failed); socket.once('end', failed); signal?.addEventListener('abort', failed, { once: true });
    if (signal?.aborted) return failed();
    socket.write('CONNECT ' + destination + ' HTTP/1.1\r\nHost: ' + destination + '\r\n' + auth + '\r\n');
  });
}
function headers(input) {
  const excluded = new Set([...hops, ...String(input.connection || '').split(',').map(value => value.trim().toLowerCase())]);
  return Object.fromEntries(Object.entries(input).filter(([name]) => !excluded.has(name.toLowerCase())));
}

// The native process may reach only this localhost listener. DNS and sockets
// originate in the host; the resolved public address is pinned for each request.
// An established CONNECT tunnel has no model-response deadline or idle timer.
export async function createSupervisorEgress({ upstreamEnv = {}, lookup = dnsLookup, connect = connectTransport } = {}) {
  if (!upstreamEnv || typeof upstreamEnv !== 'object' || typeof lookup !== 'function' || typeof connect !== 'function') throw blocked();
  const upstreams = { http: proxyURL(upstreamEnv, false), https: proxyURL(upstreamEnv, true) };
  const sockets = new Set(), controller = new AbortController(); let inflight = 0, closed = false;
  const track = socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); return socket; };
  async function target(host, port) {
    if (!host || ![80, 443].includes(port) || /[\x00-\x20]/.test(host)) throw blocked();
    const literal = isIP(host), answers = literal ? [{ address: host, family: literal }] : await boundedLookup(() => lookup(host, { all: true, verbatim: true }), controller.signal);
    if (!Array.isArray(answers) || !answers.length || answers.length > 32 || answers.some(row => !row || !publicAddress(row.address))) throw blocked();
    const address = answers.find(row => isIP(row.address) === 4)?.address || answers[0].address;
    return { address, port };
  }
  function admit(socket) {
    if (closed || inflight >= LIMITS.requests) throw blocked();
    inflight++; let done = false;
    const release = () => { if (!done) { done = true; inflight--; } };
    socket.once('close', release); return release;
  }
  function refuse(response, code = 403) {
    if (response.destroyed || response.writableEnded) return;
    if (response.headersSent) { response.destroy(); return; }
    response.writeHead(code, { 'Content-Type': 'text/plain', Connection: 'close' }); response.end('Supervisor egress request denied.');
  }
  const server = createServer({ maxHeaderSize: 16384, requestTimeout: 30000, headersTimeout: 10000 }, async (request, response) => {
    let release, remote, outgoing, agent;
    try {
      release = admit(request.socket); response.once('close', release);
      const url = new URL(request.url);
      if (url.protocol !== 'http:' || url.username || url.password || url.hash) throw blocked();
      const destination = await target(hostName(url.hostname), Number(url.port) || 80);
      remote = track(await connect({ ...destination, upstream: upstreams.http, signal: controller.signal }));
      if (closed || request.destroyed) { remote.destroy(); release(); return; }
      agent = new Agent({ keepAlive: false }); agent.createConnection = () => remote;
      outgoing = httpRequest({ hostname: destination.address, port: destination.port, path: url.pathname + url.search, method: request.method,
        headers: { ...headers(request.headers), host: url.host }, agent }, incoming => {
        let received = 0;
        response.writeHead(incoming.statusCode, headers(incoming.headers));
        incoming.on('data', chunk => { received += chunk.length; if (received > LIMITS.responseBytes) { incoming.destroy(); response.destroy(); } });
        incoming.on('error', () => response.destroy()); incoming.pipe(response);
      });
      outgoing.on('error', () => { if (!response.destroyed) refuse(response, 502); });
      // A connected HTTP model request can legitimately wait without output.
      // Stop/close and bounded concurrency govern its lifetime, not an idle cap.
      let sent = 0;
      request.on('data', chunk => { sent += chunk.length; if (sent > LIMITS.requestBytes) { request.unpipe(outgoing); outgoing.destroy(); refuse(response, 413); request.resume(); } });
      request.once('aborted', () => outgoing.destroy()); response.once('close', () => { outgoing.destroy(); agent.destroy(); });
      request.pipe(outgoing);
    } catch { remote?.destroy(); release?.(); refuse(response); }
  });
  server.maxRequestsPerSocket = 100;
  server.on('connection', track); server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  server.on('connect', async (request, client, head) => {
    let release, remote;
    try {
      release = admit(client);
      const parsed = /^(?:\[([0-9a-fA-F:.]+)\]|([^:/?#@\s]+)):(\d{1,5})$/.exec(request.url || '');
      if (!parsed) throw blocked();
      const destination = await target(parsed[1] || parsed[2], Number(parsed[3]));
      remote = track(await connect({ ...destination, upstream: upstreams.https, signal: controller.signal }));
      if (closed || client.destroyed) { remote.destroy(); release(); return; }
      const stop = () => { remote.destroy(); client.destroy(); release(); };
      client.once('error', stop); remote.once('error', stop); client.once('close', () => remote.destroy()); remote.once('close', () => { client.destroy(); release(); });
      let bytes = head.length;
      const count = chunk => { bytes += chunk.length; if (bytes > LIMITS.tunnelBytes) stop(); };
      client.on('data', count); remote.on('data', count);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) remote.write(head);
      client.pipe(remote); remote.pipe(client);
    } catch { remote?.destroy(); release?.(); if (!client.destroyed) client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const port = server.address().port;
  const server6 = createServer({ maxHeaderSize: 16384, requestTimeout: 30000, headersTimeout: 10000 }, server.listeners('request')[0]);
  server6.maxRequestsPerSocket = server.maxRequestsPerSocket;
  server6.on('connection', track);
  for (const event of ['clientError', 'connect']) for (const listener of server.listeners(event)) server6.on(event, listener);
  try {
    await new Promise((resolve, reject) => { server6.once('error', reject); server6.listen({ port, host: '::1', ipv6Only: true }, () => { server6.off('error', reject); resolve(); }); });
  } catch {
    closed = true; controller.abort(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); throw blocked();
  }
  return { url: 'http://127.0.0.1:' + port, port, async close() {
    if (closed) return; closed = true; controller.abort(); for (const socket of sockets) socket.destroy();
    await Promise.all([server, server6].map(listener => new Promise(resolve => listener.close(resolve))));
  } };
}
