"""Workflow callbacks through the same guard used by real native execution."""
import base64
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
import workflow_local_tools as local
import workflow_gateway as gateway
from workflow_gateway_test import FakeAgent, FakeServer, fake_skills, fake_tool_modules

REVISION = 'sha256:' + '1' * 64
PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY1kAAAAASUVORK5CYII='


class Requests:
    def __init__(self):
        self.calls = []
        self.result = {'ok': True}
        self.before_return = lambda: None

    def send(self, name, sid, params, timeout):
        self.calls.append((name, sid, params, timeout))
        self.before_return()
        return self.result


class Integrations:
    def import_image(self, run, result):
        return None

    def required(self, names, expected=None):
        tools = {'computer_use': ['computer_use'], 'mcp-fixture': ['mcp__fixture__read']}
        return sorted(names), sorted(name for group in names for name in tools.get(group, []))

    def definitions(self, groups, names):
        return [{'type': 'function', 'function': {'name': name, 'parameters': {'type': 'object', 'properties': {'native_old': {'type': 'string'}}}}} for name in names]


class WorkflowLocalToolTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve(); self.workspace = self.root / 'workspace'; self.workspace.mkdir()
        source = self.root / 'skill'; source.mkdir(); (source / 'SKILL.md').write_text('---\nname: Example Skill\n---\nA fixture.\n')
        self.agent = FakeAgent(); self.agent.tools += [{'function': {'name': name}} for name in ('computer_use', 'mcp__fixture__read', 'manage_connections', 'image_generate', 'browser_exec')]
        self.agent.valid_tool_names.update(row['function']['name'] for row in self.agent.tools)
        self.server = FakeServer(self.workspace, self.agent)
        self.tools, self.executor, self.native_calls = fake_tool_modules(); self.requests = Requests()
        self.bridge = gateway.WorkflowGateway(self.server, fake_skills(source), self.tools, self.executor, workspace_root=self.workspace,
            integrations=Integrations(), local_tools=local.WorkflowLocalTools(self.requests)).install()
        self.params = {'session_id': 'runtime-session', 'skill': 'Example Skill', 'revision': gateway.skill_revision((source / 'SKILL.md').read_bytes()),
            'run_id': str(uuid.uuid4()), 'input': None, 'output_type': 'object', 'local_tool_token': str(uuid.uuid4())}

    def execute(self, name, args=None):
        return self.tools._execute_tool(name, args or {}, {}, SimpleNamespace(session_id='stored-session', task_id='stored-session', tool_call_id='native-call-one'),
            user_task=None, enabled_tools=None, skip_tool_execution_middleware=True)

    def prepare(self, required=None):
        params = self.params if required is None else self.params | {'required_toolsets': required, 'capability_revision': REVISION}
        return self.bridge.prepare(params)

    def test_desktop_and_mcp_use_the_exact_host_attempt_callback(self):
        self.prepare(['computer_use', 'mcp-fixture'])
        self.assertTrue(json.loads(self.execute('computer_use', {'action': 'capture', 'app': 'com.blenderfoundation.blender'}))['ok'])
        self.assertTrue(json.loads(self.execute('mcp__fixture__read', {'path': 'fixture.txt'}))['ok'])
        self.assertEqual(self.native_calls, [])
        name, sid, params, timeout = self.requests.calls[0]
        self.assertEqual(name, 'workbench.local-tools.call'); self.assertEqual(sid, 'runtime-session'); self.assertIsNone(timeout)
        self.assertEqual(params['attempt_id'], self.params['run_id']); self.assertEqual(params['capability_token'], self.params['local_tool_token'])
        self.assertEqual(params['call_id'], 'native-call-one'); self.assertEqual(params['tool'], 'computer_use')

    def test_missing_token_or_finished_attempt_never_runs_native_external_tool(self):
        del self.params['local_tool_token']; self.prepare()
        for name in ('computer_use', 'mcp__fixture__read'):
            self.assertNotIn(name, self.agent.valid_tool_names)
            self.assertEqual(json.loads(self.execute(name))['code'], 'workbench_local_tool_blocked')
        self.assertEqual(self.native_calls, []); self.assertEqual(self.requests.calls, [])
        self.bridge.runs[self.params['run_id']]['local_tool_token'] = str(uuid.uuid4())
        self.bridge.finish({'session_id': 'runtime-session', 'run_id': self.params['run_id']})
        self.assertEqual(json.loads(self.execute('computer_use'))['code'], 'workbench_local_tool_blocked')

    def test_declared_toolsets_still_exclude_other_mcp_and_desktop_tools(self):
        self.prepare(['mcp-fixture'])
        for name in ('computer_use', 'mcp__other__read'):
            self.assertEqual(json.loads(self.execute(name))['code'], 'workbench_integration_tool_blocked')
        self.assertEqual(self.requests.calls, [])

    def test_workflow_cannot_manage_connections_directly_or_deferred(self):
        self.prepare()
        self.assertNotIn('manage_connections', self.agent.valid_tool_names)
        for name, args in [('manage_connections', {}), ('tool_call', {'name': 'manage_connections', 'arguments': {}}), ('tool_call', {'calls': [{'tool_name': 'manage_connections', 'arguments': {}}]})]:
            self.assertEqual(json.loads(self.execute(name, args))['code'], 'workbench_connection_management_blocked')
            self.assertEqual(json.loads(self.tools.handle_function_call(name, args, session_id='stored-session'))['code'], 'workbench_connection_management_blocked')
        self.assertEqual(self.native_calls, [])

    def test_workflow_schema_matches_broker_and_mcp_schema_is_preserved(self):
        self.prepare(['computer_use', 'mcp-fixture'])
        rows = {row['function']['name']: row['function'] for row in self.agent.tools}
        self.assertEqual(rows['computer_use']['parameters'], local.DESKTOP_SCHEMA)
        self.assertEqual(rows['mcp__fixture__read']['parameters']['properties'], {'native_old': {'type': 'string'}})
        described = json.loads(self.tools.handle_function_call('tool_describe', {'name': 'computer_use'}, session_id='stored-session'))
        self.assertEqual(described['parameters'], local.DESKTOP_SCHEMA)

    def test_native_image_and_browser_dispatch_are_unchanged(self):
        self.prepare()
        self.execute('image_generate', {'prompt': 'fixture'}); self.execute('browser_exec', {'code': 'fixture'})
        self.assertEqual([row[0] for row in self.native_calls], ['image_generate', 'browser_exec']); self.assertEqual(self.requests.calls, [])

    def test_multimodal_capture_stays_in_current_attempt_not_shared_hermes_profile(self):
        self.prepare(['computer_use'])
        self.requests.result = {'captureId': 'capture-one', '_nodeorchard_images': [{'mimeType': 'image/png', 'data': PNG}]}
        result = self.execute('computer_use', {'action': 'capture', 'app': 'approved-app'})
        self.assertTrue(result['_multimodal']); self.assertNotIn(PNG, result['text_summary'])
        content = json.loads(result['text_summary']); path = Path(content['images'][0])
        self.assertTrue(path.is_relative_to(self.workspace / '.workbench-artifacts' / self.params['run_id']))
        self.assertEqual(path.read_bytes(), base64.b64decode(PNG))

    def test_bound_mcp_images_cross_the_host_callback_as_native_multimodal_content(self):
        self.prepare(['mcp-fixture'])
        self.requests.result = {'_nodeorchard_images': [{'mimeType': 'image/png', 'data': PNG}]}
        result = self.execute('mcp__fixture__read')
        self.assertTrue(result['_multimodal']); self.assertNotIn(PNG, result['text_summary'])
        path = Path(json.loads(result['text_summary'])['images'][0])
        self.assertTrue(path.is_relative_to(self.workspace / '.workbench-artifacts' / self.params['run_id']))
        self.assertEqual(path.read_bytes(), base64.b64decode(PNG))

    def test_mcp_image_signature_and_mime_must_match_before_files_are_written(self):
        self.prepare(['mcp-fixture'])
        for image in [{'mimeType': 'image/jpeg', 'data': PNG}, {'mimeType': 'image/png', 'data': base64.b64encode(b'not-an-image').decode()}, {'mimeType': 'image/png', 'data': 'invalid base64'}]:
            with self.subTest(image=image):
                self.requests.result = {'_nodeorchard_images': [image]}
                self.assertEqual(json.loads(self.execute('mcp__fixture__read'))['code'], 'workbench_local_image_rejected')
        self.assertFalse((self.workspace / '.workbench-artifacts').exists())

    def test_model_arguments_cannot_select_the_host_image_result_channel(self):
        self.prepare(['mcp-fixture'])
        result = self.execute('mcp__fixture__read', {'_nodeorchard_images': [{'mimeType': 'image/png', 'data': PNG}]})
        self.assertEqual(json.loads(result), {'ok': True})
        self.assertFalse((self.workspace / '.workbench-artifacts').exists())

    def test_unbound_native_and_child_sessions_cannot_execute_local_tools_directly_or_deferred(self):
        calls = [('computer_use', {'action': 'capture', 'app': 'approved-app'}), ('mcp__fixture__read', {}),
            ('tool_call', {'name': 'computer_use', 'arguments': {}}), ('tool_call', {'calls': [{'tool_name': 'mcp__fixture__read', 'arguments': {}}]})]
        child = FakeAgent(); child.session_id = 'unbound-child'
        for name, arguments in calls:
            with self.subTest(tool=name, arguments=arguments):
                self.assertEqual(json.loads(self.execute(name, arguments))['code'], 'workbench_local_tool_blocked')
                self.assertEqual(json.loads(self.tools.handle_function_call(name, arguments, session_id='unbound-child', task_id='unbound-child'))['code'], 'workbench_local_tool_blocked')
                error, _ = self.executor._pre_tool_block(child, SimpleNamespace(name=name, args=arguments))
                self.assertIn('host-admitted workflow attempt', error)
        self.assertEqual(self.native_calls, []); self.assertEqual(self.requests.calls, [])

    def test_unbound_native_and_child_sessions_cannot_manage_connections_directly_or_deferred(self):
        child = FakeAgent(); child.session_id = 'unbound-child'
        for name, arguments in [('manage_connections', {'action': 'install'}), ('tool_call', {'name': 'manage_connections', 'arguments': {}}),
            ('tool_call', {'calls': [{'tool_name': 'manage_connections', 'arguments': {}}]})]:
            self.assertEqual(json.loads(self.execute(name, arguments))['code'], 'workbench_connection_management_blocked')
            self.assertEqual(json.loads(self.tools.handle_function_call(name, arguments, session_id='unbound-child', task_id='unbound-child'))['code'], 'workbench_connection_management_blocked')
            error, _ = self.executor._pre_tool_block(child, SimpleNamespace(name=name, args=arguments))
            self.assertIn('cannot manage connections', error)
        self.assertEqual(self.native_calls, []); self.assertEqual(self.requests.calls, [])

    def test_unbound_native_image_and_browser_tools_keep_their_original_dispatch(self):
        self.execute('image_generate', {'prompt': 'fixture'}); self.execute('browser_exec', {'code': 'fixture'})
        self.assertEqual([row[0] for row in self.native_calls], ['image_generate', 'browser_exec'])

    def test_cancel_or_late_native_result_is_not_replayed_or_published(self):
        self.prepare(['computer_use'])
        self.requests.result = None
        self.assertEqual(json.loads(self.execute('computer_use'))['code'], 'workbench_local_tool_cancelled')
        self.requests.result = {'ok': True}; self.requests.before_return = lambda: self.bridge.runs[self.params['run_id']].update(finished=True)
        self.assertEqual(json.loads(self.execute('computer_use'))['code'], 'workbench_local_tool_cancelled')
        self.assertEqual(len(self.requests.calls), 2)

    def test_tokens_are_canonical_and_not_in_model_prepare_receipt(self):
        for value in ('arbitrary', self.params['local_tool_token'].upper(), None):
            with self.subTest(token=value), self.assertRaises(gateway.WorkflowPolicyError): self.bridge.prepare(self.params | {'local_tool_token': value})
        result = self.prepare()
        self.assertNotIn(self.params['local_tool_token'], json.dumps(result))


if __name__ == '__main__': unittest.main()
