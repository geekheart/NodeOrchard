"""Opt-in real Hermes MCP smoke: a new HOME/profile, zero model requests.

Run using the installed Hermes interpreter with HERMES_LOCAL_TOOLS_TEST=1,
PYTHONPATH pointing at its source. No original config or workflow is loaded.
"""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import json
import socket
import time

@unittest.skipUnless(os.environ.get('HERMES_LOCAL_TOOLS_TEST') == '1', 'explicit real Hermes smoke only')
class NativeLocalToolsTests(unittest.TestCase):
    def test_native_loopback_http_identity(self):
        with tempfile.TemporaryDirectory(prefix='nodeorchard-mcp-http-') as folder:
            home = Path(folder).resolve()
            with socket.socket() as listener:
                listener.bind(('127.0.0.1', 0)); port = listener.getsockname()[1]
            fixture = Path(__file__).parent / 'fixtures/local-mcp-native-server.py'
            config = {'mcp_servers': {'local-http': {'url': f'http://127.0.0.1:{port}/mcp', 'trust': 'full'}}}
            (home / 'config.yaml').write_text(json.dumps(config))
            env = {**os.environ, 'HERMES_HOME': str(home), 'HERMES_BASE_HOME': str(home), 'HERMES_DISABLE_LAZY_INSTALLS': '1', 'PYTHONDONTWRITEBYTECODE': '1'}
            env['PYTHONPATH'] = str(Path(__file__).parents[1] / 'python') + os.pathsep + env.get('PYTHONPATH', '')
            server_env = {**env, 'LOCAL_MCP_SMOKE_TRANSPORT': 'streamable-http', 'LOCAL_MCP_SMOKE_PORT': str(port)}
            server = subprocess.Popen([sys.executable, str(fixture.resolve())], env=server_env, cwd=home, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
            try:
                deadline = time.monotonic() + 10
                while True:
                    try:
                        with socket.create_connection(('127.0.0.1', port), timeout=0.1): break
                    except OSError:
                        if time.monotonic() >= deadline or server.poll() is not None:
                            self.fail('MCP HTTP fixture did not start: ' + (server.stderr.read() if server.poll() is not None else 'startup deadline'))
                        time.sleep(.1)
                script = '''
import json,os
from local_tools import LocalTools
from tools.mcp_tool_lifecycle import shutdown_mcp_servers
tools=LocalTools()
try:
 catalog=tools.catalog({'server':'local-http'})
 tool=next(row for row in catalog['servers'][0]['tools'] if row['name'].endswith('__identity'))
 assert tool['readOnly'] is True
 scope={'session_id':'http-turn','working_folder':os.environ['HERMES_HOME'],'read_only':True}
 result=tools.mcp({'server':'local-http','tool':tool['name'],'arguments':{'marker':'HTTP_MCP_REAL_8127'},'expected_revision':catalog['revision'],'scope':scope})
 assert 'HTTP_MCP_REAL_8127' in json.dumps(result),result
 print('HTTP_MCP_REAL_8127')
finally:
 tools.close();shutdown_mcp_servers()
'''
                result = subprocess.run([sys.executable, '-c', script], env=env, cwd=home, capture_output=True, text=True, timeout=80)
                self.assertEqual(result.returncode, 0, result.stderr[-5000:] + result.stdout[-3000:])
                self.assertIn('HTTP_MCP_REAL_8127', result.stdout)
                self.assertEqual(json.loads((home / 'config.yaml').read_text()), config)
            finally:
                server.terminate()
                try: server.communicate(timeout=5)
                except subprocess.TimeoutExpired: server.kill();server.communicate(timeout=5)

    def test_native_stdio_identity_and_readonly_write_refusal(self):
        with tempfile.TemporaryDirectory(prefix='nodeorchard-mcp-real-') as folder:
            home = Path(folder).resolve()
            fixture = Path(__file__).parent / 'fixtures/local-mcp-native-server.py'
            config = {'mcp_servers': {'local-smoke': {'command': sys.executable, 'args': [str(fixture.resolve())], 'trust': 'full'}}}
            (home / 'config.yaml').write_text(json.dumps(config))
            env = {**os.environ, 'HERMES_HOME': str(home), 'HERMES_BASE_HOME': str(home), 'HERMES_DISABLE_LAZY_INSTALLS': '1', 'PYTHONDONTWRITEBYTECODE': '1'}
            env['PYTHONPATH'] = str(Path(__file__).parents[1] / 'python') + os.pathsep + env.get('PYTHONPATH', '')
            script = '''
import json,os
from local_tools import LocalTools
from tools.mcp_tool_lifecycle import shutdown_mcp_servers
tools=LocalTools()
try:
 catalog=tools.catalog({'server':'local-smoke'})
 rows=catalog['servers'][0]['tools']
 read=next(row for row in rows if row['name'].endswith('__identity'))
 write=next(row for row in rows if row['name'].endswith('__echo_mutation'))
 assert read['readOnly'] is True and write['readOnly'] is False, rows
 scope={'session_id':'smoke-turn','working_folder':os.environ['HERMES_HOME'],'read_only':True}
 result=tools.mcp({'server':'local-smoke','tool':read['name'],'arguments':{'marker':'LOCAL_MCP_REAL_7219'},'expected_revision':catalog['revision'],'scope':scope})
 assert 'LOCAL_MCP_REAL_7219' in json.dumps(result),result
 try:
  tools.mcp({'server':'local-smoke','tool':write['name'],'arguments':{'value':'NO_WRITE'},'expected_revision':catalog['revision'],'scope':scope})
 except ValueError: pass
 else: raise AssertionError('readonly mutation was admitted')
 print(json.dumps({'nativeTransport':'stdio','readOnly':True,'writeRefused':True,'marker':'LOCAL_MCP_REAL_7219'}))
finally:
 tools.close()
 shutdown_mcp_servers()
'''
            result = subprocess.run([sys.executable, '-c', script], env=env, cwd=home, capture_output=True, text=True, timeout=80)
            self.assertEqual(result.returncode, 0, result.stderr[-5000:] + result.stdout[-3000:])
            self.assertIn('LOCAL_MCP_REAL_7219', result.stdout)
            self.assertEqual(json.loads((home / 'config.yaml').read_text()), config)

@unittest.skipUnless(os.environ.get('HERMES_LOCAL_DESKTOP_TEST') == '1', 'explicit real signed-driver smoke only')
class NativeDesktopTests(unittest.TestCase):
    def test_bounded_signed_driver_roundtrip_without_desktop_actions(self):
        sys.path.insert(0, str(Path(__file__).parents[1] / 'python'))
        from local_tools import LocalTools
        with tempfile.TemporaryDirectory(prefix='nodeorchard-desktop-native-') as folder:
            root = str(Path(folder).resolve())
            tools = LocalTools(dependencies={'cache_root': root})
            try:
                scope = {'session_id': 'native-desktop-test', 'working_folder': root, 'read_only': True, 'allowed_apps': ['com.nodeorchard.Test']}
                result = tools.desktop({'action': 'list_apps', 'app': 'com.nodeorchard.Test', 'scope': scope})
                self.assertEqual(result, {'apps': []})
                backend = tools.backends[scope['session_id']][1]
                daemon = backend._embedded_daemon
                from tools.computer_use.cua_backend_driver import resolve_cua_driver_cmd
                env = {**os.environ, 'CUA_DRIVER_RS_TELEMETRY_ENABLED': '0'}
                status = subprocess.run([resolve_cua_driver_cmd(), 'permissions', 'status', '--json', '--socket', daemon.socket_path], env=env,
                                        capture_output=True, text=True, timeout=10)
                if status.returncode == 0 and status.stdout.lstrip().startswith('{'):
                    value = json.loads(status.stdout)
                    print(json.dumps({'nativeDesktopPermissions': {key: value.get(key) for key in ('accessibility', 'screen_recording', 'screen_recording_capturable', 'status')}}))
            finally:
                tools.close()

if __name__ == '__main__': unittest.main()
