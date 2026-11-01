import dataclasses
import importlib.util
import json
import os
from concurrent.futures import ThreadPoolExecutor
import threading
from pathlib import Path
import tempfile
from types import FunctionType, SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location('workbench_local_tools', Path(__file__).parents[1] / 'python/local_tools.py')
local = importlib.util.module_from_spec(spec)
spec.loader.exec_module(local)


class Backend:
    def __init__(self):
        self._active_pid, self._active_window_id = 12, 34
        self.calls = []
        self.focus = True
        self.label = 'Title'
        self.stopped = False
    def start(self): pass
    def stop(self): self.stopped = True
    def capture(self, **kwargs):
        self.calls.append(('capture', kwargs))
        return {'app': 'Figma', 'window_title': 'Draft', 'elements': [{'index': 1, 'role': 'AXTextField', 'label': self.label, 'attributes': {'focused': self.focus}}]}
    def list_windows(self): return [{'pid': 12, 'window_id': 34}]
    def list_apps(self): return [{'bundle_id': 'com.figma.Desktop', 'pid': 12}]
    def click(self, **kwargs): self.calls.append(('click', kwargs)); return {'ok': True}
    def type_text(self, *args, **kwargs): self.calls.append(('type', args)); return {'ok': True}
    def key(self, *args, **kwargs): self.calls.append(('key', args)); return {'ok': True}


class LocalToolsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = str(Path(self.temp.name).resolve())
        self.config = {'mcp_servers': {'figma': {'command': 'configured-command', 'env': {'TOKEN': 'private-test-token'}},
                                       'workbench': {'url': 'http://127.0.0.1:4318/mcp'}}}
        self.called = []
        self.backend = Backend()
        self.entries = [SimpleNamespace(name='mcp__figma__read', toolset='mcp-figma', schema={'name': 'mcp__figma__read', 'parameters': {}}, description='Read', handler=lambda args, **kw: self.called.append(args) or json.dumps({'ok': True})),
                        SimpleNamespace(name='mcp__figma__write', toolset='mcp-figma', schema={'name': 'mcp__figma__write', 'parameters': {}}, description='Write', handler=lambda args, **kw: self.called.append(args) or json.dumps({'ok': True}))]
        self.discovered = []
        self.tools = local.LocalTools(dependencies={'config': lambda: self.config, 'discover': lambda names: self.discovered.extend(names),
            'status': lambda configured: [{'name': name, 'status': 'connected'} for name in configured], 'entries': lambda: self.entries,
            'readonly': lambda name, entry: entry.name.endswith('__read'), 'desktop_status': lambda: {'installed': True, 'ready': True, 'accessibility': True},
            'backend': lambda path: self.backend, 'cache_root': self.folder}, now=lambda: 1)
        self.addCleanup(self.tools.close)
        self.scope = {'session_id': 'scope-1', 'working_folder': self.folder, 'read_only': False, 'allowed_apps': ['com.figma.Desktop']}
    def call(self, tool='mcp__figma__read', **kwargs):
        return self.tools.mcp({'server': 'figma', 'tool': tool, 'arguments': {'value': 1}, 'expected_revision': self.tools.catalog()['revision'], 'scope': self.scope, **kwargs})
    def capture(self):
        return self.tools.desktop({'action': 'capture', 'app': 'com.figma.Desktop', 'scope': self.scope})['captureId']

    def test_only_explicit_saved_server_is_discovered_and_secrets_are_hidden(self):
        result = self.tools.catalog({'server': 'figma'})
        self.assertEqual(self.discovered, ['figma'])
        self.assertNotIn('private-test-token', json.dumps(result))
        self.assertNotIn('configured-command', json.dumps(result))
        self.assertEqual([row['id'] for row in result['servers']], ['figma'])
        self.assertEqual(result['servers'][0]['tools'][0]['readOnly'], True)

    def test_workbench_and_metadata_endpoints_never_discover(self):
        self.config['mcp_servers']['meta'] = {'url': 'http://169.254.169.254/mcp'}
        result = self.tools.catalog({'refresh': True})
        self.assertEqual(self.discovered, ['figma'])
        self.assertEqual({row['id']: row['status'] for row in result['servers']}['workbench'], 'blocked')

    def test_exact_registry_provenance_is_required_and_native_handler_runs(self):
        self.assertTrue(self.call()['result']['ok'])
        self.assertEqual(self.called, [{'value': 1}])
        self.entries[0].toolset = 'mcp-other'
        with self.assertRaisesRegex(local.LocalToolError, 'absent'):
            self.call()
        self.assertEqual(len(self.called), 1)

    def test_stale_config_and_readonly_write_cannot_dispatch(self):
        revision = self.tools.catalog()['revision']
        self.config['mcp_servers']['figma']['env']['TOKEN'] = 'new'
        with self.assertRaisesRegex(local.LocalToolError, 'changed'):
            self.call(expected_revision=revision)
        self.scope['read_only'] = True
        with self.assertRaisesRegex(local.LocalToolError, 'Read-only'):
            self.call('mcp__figma__write')
        self.assertEqual(self.called, [])

    def test_tool_schema_or_annotation_change_invalidates_previous_admission(self):
        revision = self.tools.catalog()['revision']
        self.entries[0].schema['parameters'] = {'type': 'object', 'properties': {'new': {'type': 'string'}}}
        with self.assertRaisesRegex(local.LocalToolError, 'changed'):
            self.call(expected_revision=revision)
        revision = self.tools.catalog()['revision']
        self.tools.dependencies['readonly'] = lambda name, entry: False
        with self.assertRaisesRegex(local.LocalToolError, 'changed'):
            self.call(expected_revision=revision)

    def test_lookalike_server_tool_or_arbitrary_url_not_accepted(self):
        with self.assertRaises(local.LocalToolError): self.call(server='http://localhost:4318')
        with self.assertRaises(local.LocalToolError): self.call(url='http://localhost:4318')
        self.assertEqual(self.called, [])

    def test_manifest_enforces_app_resources_and_private_files(self):
        self.capture()
        manifest_path = self.tools.backends['scope-1'][2]
        manifest = json.loads(manifest_path.read_text())
        self.assertEqual(manifest['version'], 3)
        self.assertEqual(manifest['resources']['desktop']['display'], False)
        self.assertEqual(manifest['resources']['apps'][0]['bundle_id'], 'com.figma.Desktop')
        self.assertFalse(manifest['resources']['apps'][0]['launch'])
        self.assertNotIn('launch_app', manifest['allow']['tools'])
        # Current Cua folds capture into get_window_state. An obsolete
        # screenshot grant makes the actual daemon reject its entire manifest.
        self.assertNotIn('screenshot', manifest['allow']['tools'])

    def test_desktop_input_binds_exact_capture_and_consumes_it(self):
        capture_id = self.capture()
        params = {'action': 'type', 'app': 'com.figma.Desktop', 'scope': self.scope, 'capture_id': capture_id, 'text': 'Hello'}
        self.assertTrue(self.tools.desktop(params)['ok'])
        self.assertEqual(self.backend.calls[-1], ('type', ('Hello',)))
        with self.assertRaisesRegex(local.LocalToolError, 'Capture'):
            self.tools.desktop(params)

    def test_desktop_focus_unknown_or_console_denies_input(self):
        capture_id = self.capture()
        self.backend.focus = False
        with self.assertRaisesRegex(local.LocalToolError, 'focused control'):
            self.tools.desktop({'action': 'type', 'app': 'com.figma.Desktop', 'scope': self.scope, 'capture_id': capture_id, 'text': 'Hello'})
        self.backend.focus, self.backend.label = True, 'Python Console'
        with self.assertRaisesRegex(local.LocalToolError, 'Scripting/editor'):
            self.tools.desktop({'action': 'type', 'app': 'com.figma.Desktop', 'scope': self.scope, 'capture_id': capture_id, 'text': 'Hello'})
        self.assertFalse(any(row[0] == 'type' for row in self.backend.calls))

    def test_approved_app_cannot_invoke_shell_or_developer_shortcuts(self):
        capture_id = self.capture()
        for extra in ({'action': 'type', 'text': 'import os'}, {'action': 'key', 'keys': 'cmd+shift+p'}):
            with self.assertRaises(local.LocalToolError):
                self.tools.desktop({'app': 'com.figma.Desktop', 'scope': self.scope, 'capture_id': capture_id, **extra})
        self.assertFalse(any(row[0] in {'type', 'key'} for row in self.backend.calls))

    def test_even_allowlisted_system_settings_or_editor_is_refused(self):
        for app in ['com.apple.systempreferences', 'com.microsoft.VSCode', 'com.google.Chrome', 'com.apple.Terminal']:
            with self.assertRaisesRegex(local.LocalToolError, 'scope'):
                self.tools.desktop({'action': 'capture', 'app': app, 'scope': dict(self.scope, allowed_apps=[app])})

    def test_protected_app_names_do_not_block_unrelated_cad_bundle_names(self):
        self.assertIsNone(local.PROTECTED_APPS.search('com.graphisoft.ArchiCAD'))
        self.assertIsNone(local.PROTECTED_APPS.search('org.freecad.FreeCAD'))
        self.assertIsNotNone(local.PROTECTED_APPS.search('com.apple.Terminal'))

    def test_scope_change_stops_old_daemon(self):
        self.capture()
        with self.assertRaisesRegex(local.LocalToolError, 'scope changed'):
            self.tools.desktop({'action': 'capture', 'app': 'com.figma.Desktop', 'scope': dict(self.scope, allowed_apps=['com.figma.Desktop', 'org.blenderfoundation.blender'])})
        self.assertTrue(self.backend.stopped)

    def test_concurrent_native_backends_do_not_replace_shared_config_or_environment(self):
        barrier = threading.Barrier(3)
        release = threading.Event()
        original_cfg = lambda: {'capability_manifest': 'original-profile'}
        original_environment = os.environ.get('HERMES_CUA_DRIVER_CMD')
        def constructor(self, permission_mode='standard'):
            self.manifest = _computer_use_cfg()['capability_manifest']
            self.daemon = _EmbeddedCuaDaemon('', permission_mode, capability_manifest=self.manifest)
            barrier.wait(timeout=3)
            release.wait(timeout=3)
        def starter(self):
            self.binary = os.environ.get('HERMES_CUA_DRIVER_CMD')
            self.contract = cua_driver_runtime_contract_status()
        namespace = {'_computer_use_cfg': original_cfg, '_EmbeddedCuaDaemon': lambda binary, mode, capability_manifest: (binary, mode, capability_manifest),
                     'barrier': barrier, 'release': release, 'os': os, 'cua_driver_runtime_contract_status': lambda: {'ready': False}}
        init = FunctionType(constructor.__code__, namespace, argdefs=constructor.__defaults__, closure=constructor.__closure__)
        start = FunctionType(starter.__code__, namespace)
        native_type = type('NativeBackend', (), {'__init__': init, 'start': start})
        native = SimpleNamespace(CuaDriverBackend=native_type, _EmbeddedCuaDaemon=namespace['_EmbeddedCuaDaemon'],
                                 _computer_use_cfg=original_cfg, cua_driver_runtime_contract_status=lambda binary: {'ready': True, 'binary': binary})
        with ThreadPoolExecutor(max_workers=2) as pool:
            one = pool.submit(local._private_native_backend, native, '/driver-one', Path(self.folder) / 'one.json')
            two = pool.submit(local._private_native_backend, native, '/driver-two', Path(self.folder) / 'two.json')
            try:
                barrier.wait(timeout=3)
                self.assertIs(native._computer_use_cfg, original_cfg)
                self.assertIs(namespace['_computer_use_cfg'], original_cfg)
                self.assertEqual(namespace['_computer_use_cfg']()['capability_manifest'], 'original-profile')
                self.assertEqual(os.environ.get('HERMES_CUA_DRIVER_CMD'), original_environment)
            finally:
                release.set()
            first, second = one.result(timeout=3), two.result(timeout=3)
        self.assertEqual(first.manifest, str(Path(self.folder) / 'one.json'))
        self.assertEqual(second.manifest, str(Path(self.folder) / 'two.json'))
        self.assertEqual(first.daemon, ('/driver-one', 'bounded', first.manifest))
        self.assertEqual(second.daemon, ('/driver-two', 'bounded', second.manifest))
        self.assertEqual(first.binary, '/driver-one')
        self.assertEqual(second.binary, '/driver-two')
        self.assertEqual(os.environ.get('HERMES_CUA_DRIVER_CMD'), original_environment)

    def test_rpc_installs_real_gateway_contract_and_no_traceback(self):
        class Server:
            _LONG_HANDLERS = frozenset()
            def __init__(self): self.methods = {}
            def register_method(self, name, fn): self.methods[name] = fn
            def _ok(self, rid, result): return {'id': rid, 'result': result}
            def _err(self, rid, code, message): return {'id': rid, 'error': {'code': code, 'message': message}}
        server = Server(); self.tools.server = server; self.tools.install()
        self.assertEqual(len(server.methods), 4)
        self.assertIn('servers', server.methods['workbench.local-tools.catalog'](1, {})['result'])
        self.assertEqual(server.methods['workbench.local-tools.mcp'](2, {})['error']['code'], 4120)


if __name__ == '__main__': unittest.main()
