import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveHermesProxyEnvironment } from '../src/hermes-system-proxy.mjs';

const system = (fields = {}, exceptions = []) => '<dictionary> {\n' + Object.entries(fields).map(([key, value]) => `  ${key} : ${value}\n`).join('')
  + (exceptions.length ? '  ExceptionsList : <array> {\n' + exceptions.map((value, index) => `    ${index} : ${value}\n`).join('') + '  }\n' : '') + '}\n';
const settings = system({ HTTPEnable: 1, HTTPProxy: 'proxy.example.test', HTTPPort: 8080, HTTPSEnable: 1, HTTPSProxy: '127.0.0.1', HTTPSPort: 7890 });
const read = value => async () => value;
const options = value => ({ platform: 'darwin', readSystemProxy: read(value) });
const noRead = async () => assert.fail('Explicit configuration and unsupported platforms must not inspect system proxy settings');

test('macOS system proxies reach the child environment when the merged parent environment contains no proxy', async () => {
  const env = Object.freeze({ PATH: '/fixture/bin', APP_MODE: 'test' });
  const result = await resolveHermesProxyEnvironment(env, options(settings));
  assert.equal(result.env.HTTP_PROXY, 'http://proxy.example.test:8080');
  assert.equal(result.env.HTTPS_PROXY, 'http://127.0.0.1:7890');
  assert.equal(result.env.http_proxy, result.env.HTTP_PROXY); assert.equal(result.env.https_proxy, result.env.HTTPS_PROXY);
  assert.equal(result.env.NO_PROXY, 'localhost,127.0.0.1,::1'); assert.equal(result.env.no_proxy, result.env.NO_PROXY);
  assert.equal(result.env.APP_MODE, 'test'); assert.notEqual(result.env, env); assert.deepEqual(env, { PATH: '/fixture/bin', APP_MODE: 'test' });
  assert.deepEqual(result.diagnostics, { source: 'system', status: 'applied', count: 2 });
});

test('every explicit uppercase or lowercase proxy key, including empty and undefined values, takes precedence', async () => {
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) for (const value of ['', undefined, 'http://explicit.example.test:81']) {
    const env = { [key]: value, PRESERVED: 'yes' }, result = await resolveHermesProxyEnvironment(env, { platform: 'darwin', readSystemProxy: noRead });
    assert.deepEqual(result.env, env); assert.notEqual(result.env, env);
    assert.deepEqual(result.diagnostics, { source: 'explicit', status: 'preserved' });
  }
});

test('non-macOS platforms preserve a copied environment and never query scutil', async () => {
  for (const platform of ['linux', 'win32']) {
    const env = { PATH: '/fixture/bin' }, result = await resolveHermesProxyEnvironment(env, { platform, readSystemProxy: noRead });
    assert.deepEqual(result.env, env); assert.notEqual(result.env, env);
    assert.deepEqual(result.diagnostics, { source: 'none', status: 'skipped', code: 'platform_unsupported' });
  }
});

test('only enabled static HTTP and HTTPS proxies are inherited, without assuming SOCKS or evaluating PAC/WPAD', async () => {
  for (const fields of [{}, { HTTPEnable: 0, HTTPProxy: 'proxy.example.test', HTTPPort: 8080 },
    { HTTPSEnable: 0, HTTPSProxy: 'proxy.example.test', HTTPSPort: 8080 },
    { ProxyAutoConfigEnable: 1, ProxyAutoConfigURLString: 'https://pac.example.test/setup.pac', ProxyAutoDiscoveryEnable: 1 },
    { SOCKSEnable: 1, SOCKSProxy: 'socks.example.test', SOCKSPort: 1080 }]) {
    const result = await resolveHermesProxyEnvironment({}, options(system(fields)));
    assert.deepEqual(result.env, {}); assert.deepEqual(result.diagnostics, { source: 'none', status: 'skipped', code: 'no_static_proxy' });
  }
  const partial = await resolveHermesProxyEnvironment({}, options(system({ HTTPEnable: 1, HTTPProxy: 'proxy.example.test', HTTPPort: 8080, HTTPSEnable: 0 })));
  assert.equal(partial.env.HTTP_PROXY, 'http://proxy.example.test:8080'); assert.equal(Object.hasOwn(partial.env, 'HTTPS_PROXY'), false);
  assert.deepEqual(partial.diagnostics, { source: 'system', status: 'applied', count: 1 });
});

test('malformed hosts, credentials, URL fragments and invalid ports cannot enter proxy URLs', async () => {
  for (const host of ['user:password@proxy.example.test', 'http://proxy.example.test', 'proxy.example.test/path', 'proxy.example.test?secret',
    'proxy.example.test#secret', 'proxy.example.test\\escape', 'proxy.example.test bad', 'proxy.example.test\tbad', '[::1]@evil.example.test', '999.999.999.999', '::not-ip']) {
    const result = await resolveHermesProxyEnvironment({}, options(system({ HTTPEnable: 1, HTTPProxy: host, HTTPPort: 8080 })));
    assert.deepEqual(result.env, {}, host); assert.equal(result.diagnostics.code, 'no_static_proxy');
  }
  for (const port of ['', 0, -1, 65536, '80.5', '80@evil.example.test', '80/path']) {
    const result = await resolveHermesProxyEnvironment({}, options(system({ HTTPEnable: 1, HTTPProxy: 'proxy.example.test', HTTPPort: port })));
    assert.deepEqual(result.env, {}, String(port));
  }
});

test('a bad protocol configuration does not suppress the other valid static proxy', async () => {
  const result = await resolveHermesProxyEnvironment({}, options(system({ HTTPEnable: 1, HTTPProxy: 'bad@host', HTTPPort: 80, HTTPSEnable: 1, HTTPSProxy: 'secure.example.test', HTTPSPort: 8443 })));
  assert.equal(Object.hasOwn(result.env, 'HTTP_PROXY'), false); assert.equal(result.env.HTTPS_PROXY, 'http://secure.example.test:8443');
  assert.equal(result.diagnostics.count, 1);
});

test('IPv6 static proxy hosts are bracketed safely exactly once', async () => {
  for (const host of ['::1', '[::1]', '2001:db8::7', '[2001:db8::7]']) {
    const result = await resolveHermesProxyEnvironment({}, options(system({ HTTPEnable: 1, HTTPProxy: host, HTTPPort: 8080 })));
    assert.equal(result.env.HTTP_PROXY, `http://[${host.replace(/^\[|\]$/g, '')}]:8080`);
  }
  for (const host of ['[::1', '::1]', '[::1]:8080', 'fe80::1%en0']) {
    const result = await resolveHermesProxyEnvironment({}, options(system({ HTTPEnable: 1, HTTPProxy: host, HTTPPort: 8080 })));
    assert.deepEqual(result.env, {});
  }
});

test('safe system exceptions are normalized and loopback is preserved without widening unsupported patterns', async () => {
  const exceptions = ['*.local', 'service.example.test', '10.20.30.40', '169.254/16', '10.0.0.0/8', '2001:db8::/32', '[::1]',
    'localhost', '*.local', '<local>', '192.168.*', '*', 'https://secret.example.test', 'user:password@private.example.test', 'bad.example.test\tsecret'];
  const result = await resolveHermesProxyEnvironment({}, options(system({ HTTPEnable: 1, HTTPProxy: 'proxy.example.test', HTTPPort: 8080, ExcludeSimpleHostnames: 1 }, exceptions)));
  assert.equal(result.env.NO_PROXY, '.local,service.example.test,10.20.30.40,169.254.0.0/16,10.0.0.0/8,2001:db8::/32,::1,localhost,127.0.0.1');
  assert.equal(result.env.no_proxy, result.env.NO_PROXY);
  assert.equal(JSON.stringify(result.diagnostics).includes('proxy.example.test'), false); assert.equal(JSON.stringify(result.diagnostics).includes('secret'), false);
});

test('an explicit NO_PROXY or no_proxy, even empty, is preserved without system exception additions', async () => {
  for (const key of ['NO_PROXY', 'no_proxy']) for (const value of ['', 'custom.example.test']) {
    const result = await resolveHermesProxyEnvironment({ [key]: value }, options(settings));
    assert.equal(result.env[key], value); assert.equal(Object.hasOwn(result.env, key === 'NO_PROXY' ? 'no_proxy' : 'NO_PROXY'), false);
  }
});

test('scutil failures produce a fixed diagnostic without exposing errors, stderr, addresses or credentials', async () => {
  const env = { KEEP: 'value' }, result = await resolveHermesProxyEnvironment(env, { platform: 'darwin', readSystemProxy: async () => {
    throw Object.assign(new Error('private-user:secret@192.168.99.10'), { stderr: 'proxy credentials private-user:secret' });
  } });
  assert.deepEqual(result.env, env); assert.deepEqual(result.diagnostics, { source: 'none', status: 'unavailable', code: 'system_proxy_read_failed' });
  assert.equal(JSON.stringify(result).includes('secret'), false); assert.equal(JSON.stringify(result).includes('192.168.99.10'), false);
});

test('invalid or nested scutil output is ignored rather than interpreted as static proxy settings', async () => {
  for (const value of [null, { stdout: settings }, 'HTTPEnable : 1\nHTTPProxy : proxy.example.test\nHTTPPort : 8080',
    '<dictionary> {\n  Nested : <dictionary> {\n    HTTPEnable : 1\n    HTTPProxy : proxy.example.test\n    HTTPPort : 8080\n  }\n}\n',
    'x'.repeat(65537)]) {
    const result = await resolveHermesProxyEnvironment({}, options(value)); assert.deepEqual(result.env, {});
  }
});

test('each invocation reads current macOS proxy settings and never mutates the caller environment', async () => {
  let calls = 0; const env = Object.freeze({ APP_MODE: 'test' });
  const readSystemProxy = async () => system({ HTTPEnable: 1, HTTPProxy: 'proxy.example.test', HTTPPort: ++calls === 1 ? 8080 : 9090 });
  const first = await resolveHermesProxyEnvironment(env, { platform: 'darwin', readSystemProxy });
  const second = await resolveHermesProxyEnvironment(env, { platform: 'darwin', readSystemProxy });
  assert.equal(first.env.HTTP_PROXY, 'http://proxy.example.test:8080'); assert.equal(second.env.HTTP_PROXY, 'http://proxy.example.test:9090');
  assert.equal(calls, 2); assert.deepEqual(env, { APP_MODE: 'test' });
});
