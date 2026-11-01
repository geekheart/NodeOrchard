import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as httpServer, request as httpRequest } from 'node:http';
import { createServer as tcpServer, connect as netConnect } from 'node:net';
import { connect as tlsConnect, createServer as tlsServer } from 'node:tls';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSupervisorEgress } from '../src/supervisor-egress.mjs';

async function listen(t, server, host = '127.0.0.1') {
  const sockets = new Set(); server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {}); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return server.address().port;
}
async function proxy(t, options = {}) { const service = await createSupervisorEgress(options); t.after(() => service.close()); return service; }
async function socket(port) {
  return await new Promise((resolve, reject) => { const value = netConnect({ host: '127.0.0.1', port }); value.once('error', reject); value.once('connect', () => resolve(value)); });
}
async function request(service, path, options = {}) {
  return await new Promise((resolve, reject) => {
    const sent = httpRequest({ hostname: options.proxyHost || '127.0.0.1', port: service.port, path, method: options.method || 'GET', headers: options.headers || {}, agent: false }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.once('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString(), headers: response.headers }));
    });
    sent.once('error', reject); sent.end(options.body);
  });
}
async function tunnel(service, target = 'public.example:443', proxyHost = '127.0.0.1') {
  return await new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: proxyHost, port: service.port, path: target, method: 'CONNECT', agent: false });
    request.once('error', reject); request.once('connect', (response, stream, head) => { stream.on('error', () => {}); resolve({ status: response.statusCode, stream, head }); }); request.end();
  });
}
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

test('egress rejects private, loopback, metadata, mapped IPv4 and reserved destinations before transport', async t => {
  let connections = 0;
  const service = await proxy(t, { connect: async () => { connections++; throw Error('must not connect'); } });
  for (const host of ['127.0.0.1', '127.1', '2130706433', '10.2.3.4', '100.64.0.1', '169.254.169.254', '172.31.0.1', '192.168.1.1', '192.0.2.1', '198.18.0.1', '224.0.0.1', '[::1]', '[::ffff:127.0.0.1]', '[fc00::1]', '[fe80::1]', '[2001:db8::1]', '[2002:7f00:1::1]']) {
    assert.equal((await request(service, 'http://' + host + '/')).status, 403, host);
  }
  const connect = await tunnel(service, '127.0.0.1:4318'); assert.equal(connect.status, 403); connect.stream.destroy();
  assert.equal(connections, 0);
});

test('all DNS answers must be public and each new connection is revalidated', async t => {
  let answers = [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }], connections = 0;
  const service = await proxy(t, { lookup: async () => answers, connect: async () => { connections++; throw Error('unreachable fixture'); } });
  assert.equal((await request(service, 'http://mixed.example/')).status, 403); assert.equal(connections, 0);
  answers = [{ address: '127.0.0.1', family: 4 }];
  const response = await tunnel(service); assert.equal(response.status, 403); response.stream.destroy(); assert.equal(connections, 0);
});

test('normal HTTP forwards over a pinned public destination and strips proxy credentials', async t => {
  const seen = [], destinations = [];
  const port = await listen(t, httpServer((req, res) => { seen.push({ path: req.url, host: req.headers.host, proxyAuth: req.headers['proxy-authorization'] }); res.end('public-response'); }));
  const service = await proxy(t, { lookup: publicLookup, connect: async destination => { destinations.push(destination); return await socket(port); } });
  const result = await request(service, 'http://public.example/sample?value=one', { headers: { 'Proxy-Authorization': 'secret-to-strip' } });
  assert.equal(result.status, 200); assert.equal(result.text, 'public-response'); assert.equal(destinations[0].address, '93.184.216.34'); assert.equal(destinations[0].port, 80);
  assert.deepEqual(seen, [{ path: '/sample?value=one', host: 'public.example', proxyAuth: undefined }]);
});

test('both loopback address families are owned and CONNECT transfers opaque bytes bidirectionally', async t => {
  const echoPort = await listen(t, tcpServer(stream => stream.pipe(stream)));
  const service = await proxy(t, { lookup: publicLookup, connect: async () => await socket(echoPort) });
  for (const proxyHost of ['127.0.0.1', '::1']) {
    const connected = await tunnel(service, 'public.example:443', proxyHost); assert.equal(connected.status, 200);
    const content = Buffer.from([0x16, 0x03, 0x03, 0, 3, 0xff, 0, 0x42]);
    const received = new Promise((resolve, reject) => { connected.stream.once('data', resolve); connected.stream.once('error', reject); });
    connected.stream.write(content); assert.deepEqual(await received, content); connected.stream.destroy();
  }
});

test('a blocked destination never reaches the local workbench even through a configured upstream proxy', async t => {
  let visits = 0;
  const port = await listen(t, httpServer((_req, res) => { visits++; res.end('do not reach'); }));
  const service = await proxy(t, { upstreamEnv: { HTTPS_PROXY: 'http://127.0.0.1:' + port }, lookup: async () => [{ address: '127.0.0.1', family: 4 }] });
  assert.equal((await request(service, 'http://workbench.example/')).status, 403);
  const connected = await tunnel(service, 'workbench.example:443'); assert.equal(connected.status, 403); connected.stream.destroy(); assert.equal(visits, 0);
});

test('upstream proxy CONNECT receives a pinned IP and can carry a real TLS exchange', async t => {
  const root = await mkdtemp(join(tmpdir(), 'supervisor-egress-tls-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=public.example', '-keyout', join(root, 'key.pem'), '-out', join(root, 'cert.pem')], { stdio: 'ignore' });
  const tlsPort = await listen(t, tlsServer({ key: await readFile(join(root, 'key.pem')), cert: await readFile(join(root, 'cert.pem')) }, stream => stream.once('data', content => stream.end(Buffer.from('reply:' + content.toString())))));
  const seen = [], upstream = httpServer();
  upstream.on('connect', async (req, client, head) => {
    seen.push({ target: req.url, authorization: req.headers['proxy-authorization'] });
    const remote = await socket(tlsPort); remote.on('error', () => client.destroy()); client.on('error', () => remote.destroy());
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) remote.write(head); client.pipe(remote); remote.pipe(client);
  });
  const upstreamPort = await listen(t, upstream);
  const service = await proxy(t, { upstreamEnv: { HTTPS_PROXY: 'http://test-user:test-pass@127.0.0.1:' + upstreamPort }, lookup: publicLookup });
  const connected = await tunnel(service); assert.equal(connected.status, 200);
  const secure = tlsConnect({ socket: connected.stream, servername: 'public.example', rejectUnauthorized: false });
  const reply = await new Promise((resolve, reject) => { secure.once('error', reject); secure.once('secureConnect', () => secure.write('hello')); secure.once('data', chunk => resolve(chunk.toString())); });
  secure.destroy(); assert.equal(reply, 'reply:hello');
  assert.deepEqual(seen, [{ target: '93.184.216.34:443', authorization: 'Basic ' + Buffer.from('test-user:test-pass').toString('base64') }]);
});

test('unsupported schemes, ports, userinfo and malformed CONNECT authorities are denied', async t => {
  let connections = 0;
  const service = await proxy(t, { lookup: publicLookup, connect: async () => { connections++; throw Error('must not connect'); } });
  for (const target of ['ftp://public.example/', 'https://public.example/', 'http://user:password@public.example/', 'http://public.example:4318/']) assert.equal((await request(service, target)).status, 403);
  for (const target of ['public.example:4318', 'public.example:443/path', 'user@public.example:443', 'public.example']) { const value = await tunnel(service, target); assert.equal(value.status, 403); value.stream.destroy(); }
  assert.equal(connections, 0);
});

test('public IPv6 is permitted while Azure platform metadata and special IPv6 ranges remain blocked', async t => {
  const port = await listen(t, httpServer((_req, res) => res.end('v6-public-fixture'))), destinations = [];
  const service = await proxy(t, { connect: async destination => { destinations.push(destination); return await socket(port); } });
  assert.equal((await request(service, 'http://[2001:4860:4860::8888]/')).text, 'v6-public-fixture');
  assert.equal(destinations[0].address, '2001:4860:4860::8888');
  for (const host of ['168.63.129.16', '[64:ff9b::7f00:1]', '[2001:20::1]', '[3fff::1]']) assert.equal((await request(service, 'http://' + host + '/')).status, 403);
  assert.equal(destinations.length, 1);
});

test('closing the egress releases both listeners and cancels pending resolution', async t => {
  let began;
  const started = new Promise(resolve => { began = resolve; });
  const service = await proxy(t, { lookup: async () => { began(); return await new Promise(() => {}); } });
  const pending = request(service, 'http://pending.example/').catch(error => ({ code: error.code }));
  await started; await service.close(); const result = await pending;
  assert.equal(result.code, 'ECONNRESET');
  for (const host of ['127.0.0.1', '::1']) {
    const listener = tcpServer(); await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen({ host, port: service.port, ipv6Only: host === '::1' }, resolve); });
    await new Promise(resolve => listener.close(resolve));
  }
});
