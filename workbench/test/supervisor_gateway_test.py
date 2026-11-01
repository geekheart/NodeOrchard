"""Isolated protocol tests: no Hermes imports, user state, model or network."""
import importlib.util
import base64
import ast
import copy
from contextlib import contextmanager
import json
from pathlib import Path
from types import SimpleNamespace
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
import uuid


SCRIPT = Path(__file__).resolve().parents[1] / "python" / "supervisor_gateway.py"
SPEC = importlib.util.spec_from_file_location("supervisor_gateway", SCRIPT)
gateway = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gateway)


TOOL = {"name": "workflows.list", "description": "Read workflow summaries.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}}
ROUTE = {"name": "conversation.route", "description": "Classify the current human message before using other tools.",
         "inputSchema": {"type": "object", "properties": {"intent": {"enum": ["discuss", "diagnose", "workflow"]}},
                         "required": ["intent"], "additionalProperties": False}}


class Agent:
    def __init__(self, key):
        self.session_id = key
        self.api_mode = "responses"
        self.tools = [{"type": "function", "function": {"name": name, "parameters": {"type": "object"}}}
                      for name in ["terminal", "memory", "skill_view", "delegate_task", "cronjob_manage", "manage_connections"]]
        self.valid_tool_names = {row["function"]["name"] for row in self.tools}
        self.enabled_toolsets = ["hermes-cli"]
        self.ephemeral_system_prompt = "Native startup instructions."
        self._memory_store = object()
        self.context_compressor = object()
        self.calls = []
        self.persisted = []
        self.action = None
        self.before_action = None

    def run_conversation(self, user_message, conversation_history=None, persist_user_message=None):
        self.calls.append(user_message)
        self.persisted.append(persist_user_message)
        if self.before_action:
            self.before_action()
        return self.action() if self.action else {"text": "Native answer"}


class Registry:
    def __init__(self):
        self.entries = {}

    def get_entry(self, name):
        return self.entries.get(name)

    def register(self, **entry):
        self.entries[entry["name"]] = entry


class Server:
    def __init__(self):
        self.rows = {"live-a": {"session_key": "stored-a", "agent": Agent("stored-a"), "cwd": "/tmp", "running": False},
                     "live-b": {"session_key": "stored-b", "agent": Agent("stored-b"), "cwd": "/tmp", "running": False}}
        self._LONG_HANDLERS = frozenset()
        self.methods = {}
        self.wired = []
        self.events = []

    def _emit(self, name, sid, payload):
        self.events.append((name, sid, payload))

    def _sess(self, params, rid):
        row = self.rows.get(params["session_id"])
        return (row, None) if row else (None, self._err(rid, 4001, "missing"))

    def register_method(self, name, fn):
        self.methods[name] = fn

    def _wire_session_agent(self, sid, key, agent):
        self.wired.append((sid, key, agent))
        return True

    def _ok(self, rid, result):
        return {"jsonrpc": "2.0", "id": rid, "result": result}

    def _err(self, rid, code, message):
        return {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}}


class Requests:
    def __init__(self):
        self.sent = []
        self.routing = []
        self.response = {"workflows": [{"id": "synthetic"}]}

    def send(self, method, sid, payload, *, timeout):
        if payload.get("tool") == "conversation.route":
            self.routing.append((method, sid, payload, timeout))
            return {"intent": payload["arguments"].get("intent"), "accepted": True}
        self.sent.append((method, sid, payload, timeout))
        return self.response


def params(sid="live-a", turn="turn-a", tools=None):
    return {"session_id": sid, "turn_id": turn, "capability_token": "host-only-capability-" + sid,
            "tools": [ROUTE, *([TOOL] if tools is None else tools)], "system_prompt": "Use authorized application tools.",
            "isolation": {"verified": True, "kind": "seatbelt"}, "cwd": "/tmp"}


class NativeSupervisorTests(unittest.TestCase):
    def setUp(self):
        self.server, self.registry, self.requests = Server(), Registry(), Requests()
        self.dispatches = []

        def handle(function_name, function_args, task_id=None, **kwargs):
            self.dispatches.append((function_name, function_args, task_id))
            return "native"

        self.model_tools = SimpleNamespace(handle_function_call=handle)
        self.pre_calls = []

        def pre(agent, ref):
            self.pre_calls.append((agent, ref))
            return None, ref.args

        self.tool_executor = SimpleNamespace(_pre_tool_block=pre)
        self.bridge = gateway.NativeSupervisorGateway(self.server, self.registry, self.requests,
            model_tools=self.model_tools, tool_executor=self.tool_executor, isolation_verified=True).install()
        self.agent = self.server.rows["live-a"]["agent"]
        for row in self.server.rows.values():
            agent = row["agent"]
            agent.before_action = lambda agent=agent: self.bridge.invoke(gateway.ROUTE_NAME, {"intent": "discuss"}, session_id=agent.session_id)

    def test_prepare_retains_native_tools_memory_and_compressor_and_appends_real_function_schema(self):
        memory, compressor = self.agent._memory_store, self.agent.context_compressor
        receipt = self.bridge.prepare(params())
        self.assertEqual(receipt["policy"], {"nativeAgent": True, "toolsAllowed": True, "memoryAllowed": True,
            "applicationTools": "native-functions", "isolationVerified": True})
        self.assertTrue({"terminal", "memory", "skill_view", "delegate_task", "nodeorchard_workflows_list"} <= self.agent.valid_tool_names)
        self.assertNotIn("cronjob_manage", self.agent.valid_tool_names)
        self.assertNotIn("manage_connections", self.agent.valid_tool_names)
        self.assertIs(self.agent._memory_store, memory)
        self.assertIs(self.agent.context_compressor, compressor)
        self.assertEqual(self.agent.tools[-1]["function"]["parameters"], TOOL["inputSchema"])
        self.assertEqual(self.registry.entries["nodeorchard_workflows_list"]["schema"]["parameters"], TOOL["inputSchema"])
        self.assertIn("Native startup instructions.", self.agent.ephemeral_system_prompt)

    def test_native_turn_calls_application_handler_without_json_planning_and_preserves_session(self):
        self.bridge.prepare(params())
        handler = self.registry.entries["nodeorchard_workflows_list"]["handler"]
        self.agent.action = lambda: json.loads(handler({}, task_id="stored-a", session_id="stored-a", tool_call_id="call-a"))
        answer = self.agent.run_conversation("List the workflows")
        self.assertEqual(answer, {"workflows": [{"id": "synthetic"}]})
        method, sid, payload, timeout = self.requests.sent[0]
        self.assertEqual((method, sid, timeout), ("workbench.tool.call", "live-a", None))
        self.assertEqual(payload, {"turn_id": "turn-a", "capability_token": "host-only-capability-live-a",
            "tool": "workflows.list", "arguments": {}, "call_id": "call-a"})
        self.bridge.prepare(params(turn="turn-second"))
        self.agent.run_conversation("Continue")
        self.assertEqual(self.agent.calls, ["List the workflows", "Continue"])
        self.assertIs(self.server.rows["live-a"]["agent"], self.agent)
        self.assertEqual(self.requests.sent[-1][2]["turn_id"], "turn-second")
        self.assertEqual(len(self.requests.routing), 2)

    def test_application_handler_scope_cannot_be_selected_with_model_arguments_or_inherited_child(self):
        self.bridge.prepare(params())
        self.bridge.prepare(params("live-b", "turn-b"))
        other = self.server.rows["live-b"]["agent"]
        forged = {"session_id": "stored-a", "turn_id": "forged", "capability_token": "forged"}
        handler = self.registry.entries["nodeorchard_workflows_list"]["handler"]
        other.action = lambda: json.loads(handler(forged, task_id="stored-b", session_id="stored-b"))
        other.run_conversation("Use a tool")
        self.assertEqual(self.requests.sent[-1][1], "live-b")
        self.assertEqual(self.requests.sent[-1][2]["turn_id"], "turn-b")
        self.assertEqual(self.requests.sent[-1][2]["capability_token"], "host-only-capability-live-b")
        self.assertEqual(self.requests.sent[-1][2]["arguments"], forged)
        self.assertEqual(json.loads(handler({}, task_id="unbound-child", session_id="unbound-child"))["code"], "supervisor_scope_denied")
        self.assertEqual(len(self.requests.sent), 1)

    def test_completed_or_cancelled_turn_cannot_replay_a_tool_or_submit_again_without_prepare(self):
        self.bridge.prepare(params())
        handler = self.registry.entries["nodeorchard_workflows_list"]["handler"]
        self.requests.response = None
        self.agent.action = lambda: json.loads(handler({}, task_id="stored-a"))
        answer = self.agent.run_conversation("One operation")
        self.assertEqual(answer["code"], "supervisor_tool_cancelled")
        self.assertEqual(len(self.requests.sent), 1)
        with self.assertRaises(gateway.SupervisorPolicyError):
            self.agent.run_conversation("Replay")
        with self.assertRaises(gateway.SupervisorPolicyError):
            self.bridge.prepare(params())
        self.assertEqual(json.loads(handler({}, task_id="stored-a"))["code"], "supervisor_scope_denied")

    def test_each_prepare_replaces_application_catalog_and_does_not_duplicate_instructions(self):
        self.bridge.prepare(params())
        self.agent.run_conversation("One turn")
        changed = params(turn="new-turn", tools=[])
        changed["system_prompt"] = "Current human scope."
        self.bridge.prepare(changed)
        self.assertNotIn("nodeorchard_workflows_list", self.agent.valid_tool_names)
        self.assertEqual(self.agent.ephemeral_system_prompt, "Native startup instructions.\n\nCurrent human scope.")
        handler = self.registry.entries["nodeorchard_workflows_list"]["handler"]
        self.agent.action = lambda: json.loads(handler({}, task_id="stored-a"))
        self.assertEqual(self.agent.run_conversation("Removed tool")["code"], "supervisor_scope_denied")
        self.assertEqual(self.requests.sent, [])

    def test_model_and_inline_tool_bridges_cannot_restore_denied_background_or_connection_tools(self):
        self.bridge.prepare(params())
        self.agent.run_conversation("Classified turn")
        denied = self.model_tools.handle_function_call("tool_call", {"name": "cronjob_manage", "arguments": {}})
        self.assertEqual(json.loads(denied)["code"], "supervisor_tool_unavailable")
        blocked, _ = self.tool_executor._pre_tool_block(self.agent, SimpleNamespace(name="manage_connections", args={}))
        self.assertIsInstance(blocked, str)
        self.assertEqual(self.model_tools.handle_function_call("terminal", {"command": "echo safe"}), "native")
        self.assertEqual(len(self.dispatches), 1)

    def test_compaction_identity_and_rebuilt_agent_keep_authorized_current_turn(self):
        self.bridge.prepare(params())
        self.agent.session_id = "compacted-id"
        self.tool_executor._pre_tool_block(self.agent, SimpleNamespace(name="memory", args={}))
        self.agent.action = lambda: json.loads(self.bridge.invoke("nodeorchard_workflows_list", {}, session_id="compacted-id"))
        self.agent.run_conversation("Before rebuild")
        rebuilt = Agent("compacted-id")
        rebuilt.before_action = lambda: self.bridge.invoke(gateway.ROUTE_NAME, {"intent": "discuss"}, session_id=rebuilt.session_id)
        self.server.rows["live-a"]["agent"] = rebuilt
        self.server._wire_session_agent("live-a", "stored-a", rebuilt)
        with self.assertRaises(gateway.SupervisorPolicyError):
            rebuilt.run_conversation("No automatic replay")
        self.bridge.prepare(params(turn="after-restart"))
        rebuilt.action = lambda: json.loads(self.bridge.invoke("nodeorchard_workflows_list", {}, session_id="compacted-id"))
        rebuilt.run_conversation("Explicit continuation")
        self.assertEqual(self.requests.sent[-1][2]["turn_id"], "after-restart")

    def test_current_message_must_be_classified_by_ai_before_native_or_application_tools(self):
        self.bridge.prepare(params())
        self.agent.before_action = None

        def action():
            blocked = self.model_tools.handle_function_call("terminal", {"command": "echo safe"}, task_id="stored-a")
            self.assertEqual(json.loads(blocked)["code"], "supervisor_route_required")
            blocked, _ = self.tool_executor._pre_tool_block(self.agent, SimpleNamespace(name="memory", args={}))
            self.assertIn("First classify", blocked)
            blocked = json.loads(self.bridge.invoke("nodeorchard_workflows_list", {}, task_id="stored-a"))
            self.assertEqual(blocked["code"], "supervisor_route_required")
            self.assertEqual(self.requests.sent, [])
            admitted = json.loads(self.bridge.invoke(gateway.ROUTE_NAME, {"intent": "diagnose"}, task_id="stored-a"))
            self.assertEqual(admitted, {"intent": "diagnose", "accepted": True})
            self.assertEqual(self.model_tools.handle_function_call("terminal", {"command": "echo safe"}, task_id="stored-a"), "native")
            return "done"

        self.agent.action = action
        self.assertEqual(self.agent.run_conversation("Why did this fail?"), "done")
        self.assertEqual(len(self.requests.routing), 1)
        self.bridge.prepare(params(turn="second-human-message"))
        blocked = self.model_tools.handle_function_call("terminal", {}, task_id="stored-a")
        self.assertEqual(json.loads(blocked)["code"], "supervisor_route_required")

    def test_rejected_or_wrong_intent_route_does_not_admit_native_tools(self):
        self.bridge.prepare(params())
        self.agent.before_action = None
        original = self.requests.send
        for response in [{"intent": "diagnose", "accepted": False}, {"intent": "discuss", "accepted": True}]:
            self.requests.send = lambda *args, **kwargs: response
            self.agent.action = lambda: self.bridge.invoke(gateway.ROUTE_NAME, {"intent": "diagnose"}, task_id="stored-a")
            with self.assertRaises(gateway.SupervisorPolicyError):
                self.agent.run_conversation("Classify")
            blocked = self.model_tools.handle_function_call("terminal", {}, task_id="stored-a")
            self.assertEqual(json.loads(blocked)["code"], "supervisor_route_required")
            self.bridge.prepare(params(turn="next-" + response["intent"]))
        self.requests.send = original

    def test_native_final_answer_without_intent_admission_is_not_accepted_as_a_completed_turn(self):
        self.bridge.prepare(params())
        self.agent.before_action = None
        with self.assertRaisesRegex(gateway.SupervisorPolicyError, "did not classify"):
            self.agent.run_conversation("A final answer without calling the route tool")
        self.assertEqual(self.requests.sent, [])

    def test_admitted_images_use_native_content_and_persist_once_in_the_same_session(self):
        image = {"mimeType": "image/gif", "data": "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"}
        value = params(); value["images"] = [image]
        self.assertEqual(self.bridge.prepare(value)["attachedImages"], 1)
        self.agent.run_conversation("What is in this image?")
        parts = self.agent.calls[-1]
        self.assertEqual(parts[0], {"type": "text", "text": "What is in this image?"})
        self.assertEqual(parts[1], {"type": "image_url", "image_url": {"url": "data:image/gif;base64," + image["data"]}})
        self.assertEqual(self.agent.persisted[-1], parts)
        self.bridge.prepare(params(turn="no-images-next-turn"))
        self.agent.run_conversation("Continue without resending images")
        self.assertEqual(self.agent.calls[-1], "Continue without resending images")

    def test_native_images_reject_paths_mime_spoofing_invalid_base64_and_size_budgets(self):
        image = {"mimeType": "image/gif", "data": "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"}
        for images in [[{"path": "/private/credentials.png"}], [{**image, "mimeType": "image/png"}],
                       [{**image, "data": "not base64"}], [image] * 5]:
            value = params(); value["images"] = images
            with self.assertRaises(gateway.SupervisorPolicyError):
                self.bridge.prepare(value)
        with patch.object(gateway, "MAX_IMAGE_BYTES", 16):
            with self.assertRaises(gateway.SupervisorPolicyError):
                gateway.image_parts([image])
        with patch.object(gateway, "MAX_TOTAL_IMAGE_BYTES", 64):
            with self.assertRaises(gateway.SupervisorPolicyError):
                gateway.image_parts([image, image])
        self.assertEqual(self.registry.entries, {})

    def test_browser_capture_bytes_become_private_real_files_without_base64_or_host_paths_in_tool_text(self):
        image = {"mimeType": "image/gif", "data": "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"}
        tool = {**TOOL, "name": "browser.capture"}
        self.bridge.prepare(params(tools=[tool]))
        self.requests.response = {"value": {"id": "capture-fixture", "kind": "screenshot"},
                                  "images": ["/host/private/capture.gif"], "_nodeorchard_images": [image]}
        with TemporaryDirectory() as temporary:
            home = Path(temporary).resolve()
            with patch.dict(gateway.os.environ, {"HERMES_HOME": str(home)}):
                self.agent.action = lambda: self.bridge.invoke("nodeorchard_browser_capture", {}, task_id="stored-a")
                output = self.agent.run_conversation("Inspect the page")
            self.assertIsInstance(output, dict)
            self.assertIs(output["_multimodal"], True)
            self.assertEqual(output["content"][0], {"type": "text", "text": output["text_summary"]})
            self.assertEqual(output["content"][1], {"type": "image_url", "image_url": {"url": "data:image/gif;base64," + image["data"]}})
            result = json.loads(output["text_summary"])
            self.assertNotIn("_nodeorchard_images", result)
            self.assertNotIn(image["data"], output["text_summary"])
            self.assertNotIn(image["data"], output["content"][0]["text"])
            self.assertNotIn("/host/private", output["text_summary"])
            self.assertEqual(result["value"]["id"], "capture-fixture")
            self.assertEqual(len(result["images"]), 1)
            path = Path(result["images"][0])
            self.assertEqual(path.parent, home / "cache" / "nodeorchard-captures")
            self.assertEqual(path.suffix, ".gif")
            self.assertEqual(path.read_bytes(), base64.b64decode(image["data"]))
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertIn("read_file", result["readWith"])
            self.assertIn("vision_analyze", result["readWith"])
            # A private file path still requires an actual visual tool read.
            self.assertIn("再判断画面", result["readWith"])

    def test_capture_envelope_passes_installed_hermes_registry_and_native_vision_or_text_fallback(self):
        # Load only the installed source's pure contract functions. No Hermes
        # imports, configuration, providers or model calls run in this test.
        root = Path(gateway.os.environ.get("HERMES_PYTHON_SRC_ROOT", Path.home() / ".hermes" / "hermes-agent"))
        paths = [root / "tools/registry.py", root / "agent/tool_dispatch_helpers.py", root / "agent/vision_message_prep.py"]
        if not all(path.is_file() for path in paths):
            self.skipTest("Installed Hermes pure contract sources unavailable")
        namespace = {"Any": object, "json": json, "logger": SimpleNamespace(debug=lambda *args: None, warning=lambda *args: None)}

        def load(path, names):
            tree = ast.parse(path.read_text(encoding="utf-8"))
            selected = {}
            for node in ast.walk(tree):
                if isinstance(node, ast.FunctionDef) and node.name in names:
                    function = copy.deepcopy(node)
                    function.decorator_list = []
                    selected[node.name] = function
            self.assertEqual(set(selected), set(names), "Hermes contract surface changed")
            executable = ast.fix_missing_locations(ast.Module(body=[selected[name] for name in names], type_ignores=[]))
            exec(compile(executable, str(path), "exec"), namespace)

        load(paths[0], ["_normalize_handler_result"])
        load(paths[1], ["_is_multimodal_tool_result", "_is_text_part", "_multimodal_text_summary"])
        load(paths[2], ["_provider_model_key", "_tool_result_content_for_active_model"])
        image = {"mimeType": "image/gif", "data": "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"}
        with TemporaryDirectory() as temporary, patch.dict(gateway.os.environ, {"HERMES_HOME": str(Path(temporary).resolve())}):
            envelope = gateway._capture_images({"value": {"id": "capture-fixture"}, "_nodeorchard_images": [image]}, "browser.capture")
            self.assertIs(namespace["_normalize_handler_result"]("nodeorchard_browser_capture", envelope), envelope)
            self.assertTrue(namespace["_is_multimodal_tool_result"](envelope))
            self.assertEqual(namespace["_multimodal_text_summary"](envelope), envelope["text_summary"])
            for vision, provider_accepts in [(True, True), (True, False), (False, False)]:
                with self.subTest(vision=vision, provider_accepts=provider_accepts):
                    agent = SimpleNamespace(provider="fixture", model="fixture-vision", _no_list_tool_content_models=set(),
                        _content_has_image_parts=lambda content: any(part.get("type") == "image_url" for part in content),
                        _model_supports_vision=lambda: vision, _provider_supports_vision_tool_messages=lambda: provider_accepts)
                    actual = namespace["_tool_result_content_for_active_model"](agent, "nodeorchard_browser_capture", envelope)
                    if vision and provider_accepts:
                        self.assertIs(actual, envelope["content"])
                        self.assertEqual(actual[1]["image_url"]["url"], "data:image/gif;base64," + image["data"])
                    else:
                        self.assertEqual(actual, envelope["text_summary"])
                        self.assertNotIn(image["data"], actual)
                        self.assertTrue(Path(json.loads(actual)["images"][0]).is_file())
                        self.assertIn("vision_analyze", actual)

    def test_private_capture_channel_is_rejected_for_other_tools_without_writing_or_leaking_bytes(self):
        image = {"mimeType": "image/gif", "data": "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"}
        self.bridge.prepare(params())
        self.requests.response = {"_nodeorchard_images": [image]}
        self.agent.action = lambda: self.bridge.invoke("nodeorchard_workflows_list", {}, task_id="stored-a")
        with TemporaryDirectory() as temporary:
            home = Path(temporary).resolve()
            with patch.dict(gateway.os.environ, {"HERMES_HOME": str(home)}):
                with self.assertRaisesRegex(gateway.SupervisorPolicyError, "trusted capture or MCP broker tool"):
                    self.agent.run_conversation("Inspect")
            self.assertEqual(list(home.iterdir()), [])

    def test_host_desktop_and_mcp_images_use_the_native_capture_envelope(self):
        image = {"mimeType": "image/gif", "data": "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"}
        for tool in ("desktop.call", "mcp.call"):
            with self.subTest(tool=tool), TemporaryDirectory() as temporary:
                with patch.dict(gateway.os.environ, {"HERMES_HOME": str(Path(temporary).resolve())}):
                    result = gateway._capture_images({"captureId": "capture", "_nodeorchard_images": [image]}, tool)
                self.assertTrue(result["_multimodal"])
                self.assertEqual(result["content"][1]["image_url"]["url"], "data:image/gif;base64," + image["data"])
                self.assertNotIn(image["data"], result["text_summary"])

    def test_capture_channel_reuses_signature_count_size_and_total_budgets_before_writing_files(self):
        image = {"mimeType": "image/gif", "data": "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"}
        cases = [[{**image, "mimeType": "image/png"}], [{**image, "data": "not base64"}],
                 [{"mimeType": "image/png", "path": "/host/secret.png"}], [image] * 5]
        for index, images in enumerate(cases):
            with self.subTest(index=index), TemporaryDirectory() as temporary:
                home = Path(temporary).resolve()
                with patch.dict(gateway.os.environ, {"HERMES_HOME": str(home)}):
                    with self.assertRaises(gateway.SupervisorPolicyError):
                        gateway._capture_images({"_nodeorchard_images": images}, "browser.capture")
                self.assertEqual(list(home.iterdir()), [])
        for limit, value, images in [("MAX_IMAGE_BYTES", 16, [image]), ("MAX_TOTAL_IMAGE_BYTES", 64, [image, image])]:
            with self.subTest(limit=limit), TemporaryDirectory() as temporary:
                home = Path(temporary).resolve()
                with patch.dict(gateway.os.environ, {"HERMES_HOME": str(home)}), patch.object(gateway, limit, value):
                    with self.assertRaises(gateway.SupervisorPolicyError):
                        gateway._capture_images({"_nodeorchard_images": images}, "browser.capture")
                self.assertEqual(list(home.iterdir()), [])

    def test_capture_cache_rejects_symlinked_home_or_cache_instead_of_writing_outside(self):
        image = {"mimeType": "image/gif", "data": "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"}
        with TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            home, outside = root / "home", root / "outside"
            home.mkdir(); outside.mkdir(); (home / "cache").symlink_to(outside, target_is_directory=True)
            with patch.dict(gateway.os.environ, {"HERMES_HOME": str(home)}):
                with self.assertRaises(gateway.SupervisorPolicyError):
                    gateway._capture_images({"_nodeorchard_images": [image]}, "browser.capture")
            self.assertEqual(list(outside.iterdir()), [])
            alias = root / "alias"; alias.symlink_to(outside, target_is_directory=True)
            with patch.dict(gateway.os.environ, {"HERMES_HOME": str(alias)}):
                with self.assertRaises(gateway.SupervisorPolicyError):
                    gateway._capture_images({"_nodeorchard_images": [image]}, "browser.capture")
            self.assertEqual(list(outside.iterdir()), [])

    def test_late_capture_result_cannot_materialize_images_for_a_different_prepared_turn(self):
        image = {"mimeType": "image/gif", "data": "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"}
        self.bridge.prepare(params(tools=[{**TOOL, "name": "browser.capture"}]))
        original = self.requests.send

        def response(method, sid, payload, *, timeout):
            if payload.get("tool") == "conversation.route":
                return original(method, sid, payload, timeout=timeout)
            self.bridge.sessions["stored-a"]["turn_id"] = "a-newer-turn"
            return {"_nodeorchard_images": [image]}

        self.requests.send = response
        with TemporaryDirectory() as temporary:
            home = Path(temporary).resolve()
            with patch.dict(gateway.os.environ, {"HERMES_HOME": str(home)}):
                self.agent.action = lambda: json.loads(self.bridge.invoke("nodeorchard_browser_capture", {}, task_id="stored-a"))
                result = self.agent.run_conversation("Capture")
            self.assertEqual(result["code"], "supervisor_tool_cancelled")
            self.assertEqual(list(home.iterdir()), [])

    def test_request_tracing_keeps_one_native_agent_and_rebinds_each_human_request_identity(self):
        tracers = []

        class Tracer:
            def __init__(self, emit, *, request_id=None):
                self.emit, self.request_id, self.attached = emit, request_id, []
                tracers.append(self)

            def attach_agent(self, agent):
                self.attached.append(agent)

            def set_request_id(self, value):
                self.request_id = value

            @contextmanager
            def turn(self):
                self.emit({"requestId": self.request_id, "requestIndex": 1, "status": "complete"})
                yield

        self.bridge.trace_factory = Tracer
        first_id, second_id = str(uuid.uuid4()), str(uuid.uuid4())
        first = params(); first["request_id"] = first_id
        self.assertEqual(self.bridge.prepare(first)["requestId"], first_id)
        self.agent.run_conversation("First private prompt")
        second = params(turn="next-human-turn"); second["request_id"] = second_id
        self.bridge.prepare(second)
        self.agent.run_conversation("Second private prompt")
        self.assertEqual(len(tracers), 1)
        self.assertTrue(all(agent is self.agent for agent in tracers[0].attached))
        self.assertEqual(self.server.events, [
            ("model.request.trace", "live-a", {"trace": {"requestId": first_id, "requestIndex": 1, "status": "complete"}}),
            ("model.request.trace", "live-a", {"trace": {"requestId": second_id, "requestIndex": 1, "status": "complete"}})])
        invalid = params(turn="bad-request-id"); invalid["request_id"] = first_id.upper()
        with self.assertRaises(gateway.SupervisorPolicyError):
            self.bridge.prepare(invalid)

    def test_missing_or_forged_isolation_fails_before_mutating_native_agent(self):
        self.bridge.isolation_verified = False
        with self.assertRaises(gateway.SupervisorPolicyError):
            self.bridge.prepare(params())
        self.assertEqual(self.registry.entries, {})
        self.assertIn("cronjob_manage", self.agent.valid_tool_names)
        self.bridge.isolation_verified = True
        for isolation in [{"verified": False, "kind": "seatbelt"}, {"verified": True, "kind": "host"},
                          {"verified": True, "kind": "seatbelt", "ignored": True}]:
            value = params(); value["isolation"] = isolation
            with self.assertRaises(gateway.SupervisorPolicyError):
                self.bridge.prepare(value)

    def test_bad_catalog_collision_directory_or_busy_session_is_rejected(self):
        for tools in [[TOOL, TOOL], [{**TOOL, "name": "a.b"}, {**TOOL, "name": "a-b"}],
                      [{**TOOL, "inputSchema": []}], [{**TOOL, "permissionScope": {"sourceRepair": True}}]]:
            with self.assertRaises(gateway.SupervisorPolicyError):
                self.bridge.prepare(params(tools=tools))
        invalid = params(); invalid["cwd"] = "/does-not-match"
        with self.assertRaises(gateway.SupervisorPolicyError):
            self.bridge.prepare(invalid)
        self.server.rows["live-a"]["running"] = True
        with self.assertRaises(gateway.SupervisorPolicyError):
            self.bridge.prepare(params())

    def test_missing_session_preserves_native_error_frame_and_install_is_idempotent(self):
        response = self.bridge.prepare_rpc(7, params("missing"))
        self.assertEqual(response, {"jsonrpc": "2.0", "id": 7, "error": {"code": 4001, "message": "missing"}})
        self.bridge.install()
        self.assertEqual(list(self.server.methods), ["workbench.supervisor.prepare"])

    def test_native_resume_helpers_never_schedule_a_crashed_turn_or_consume_its_marker(self):
        server, requests, registry = Server(), Requests(), Registry()
        resumed = []

        def native_auto_continue(sid, session, key):
            resumed.append((sid, key))
            session["running"] = True
            session["marker"] = None
            return {"scheduled": True}

        # Match native method_ctx.rebind: the actual resume helper resolves its
        # scheduler from its own callable globals, which need not be the module
        # attribute a wrapper naively replaces.
        for name in ["_resume_cold", "_resume_eager", "_schedule_resume_hydration"]:
            namespace = {"_maybe_schedule_auto_continue": native_auto_continue}
            exec("def resume(sid, session, key):\n    return _maybe_schedule_auto_continue(sid, session, key)", namespace)
            setattr(server, name, namespace["resume"])
        server._maybe_schedule_auto_continue = native_auto_continue
        server._session_auto_continue = SimpleNamespace(_maybe_schedule_auto_continue=native_auto_continue)
        gateway.NativeSupervisorGateway(server, registry, requests, isolation_verified=True).install()
        marker = {"prompt": "Private interrupted instruction", "attempts": 0}
        session = {"running": False, "marker": marker}
        for helper in [server._maybe_schedule_auto_continue, server._session_auto_continue._maybe_schedule_auto_continue,
                       server._resume_cold, server._resume_eager, server._schedule_resume_hydration]:
            self.assertIsNone(helper("resumed-live", session, "resumed-stored"))
        self.assertEqual(resumed, [])
        self.assertFalse(session["running"])
        self.assertIs(session["marker"], marker)
        self.assertEqual(marker, {"prompt": "Private interrupted instruction", "attempts": 0})

    def test_gateway_wires_a_fresh_admission_guard_before_native_callbacks_can_run_an_agent(self):
        server, requests, registry = Server(), Requests(), Registry()
        agent = server.rows["live-a"]["agent"]
        memory, tools = agent._memory_store, list(agent.tools)
        observations = []

        def native_wire(sid, key, incoming):
            # A native callback trying to continue from a crash cannot enter
            # the model before the application has bound a new human turn.
            with self.assertRaisesRegex(gateway.SupervisorPolicyError, "fresh host preparation"):
                incoming.run_conversation("Replay the interrupted instruction")
            observations.append((sid, key))
            return True

        server._wire_session_agent = native_wire
        bridge = gateway.NativeSupervisorGateway(server, registry, requests, isolation_verified=True).install()
        self.assertTrue(server._wire_session_agent("live-a", "stored-a", agent))
        self.assertEqual(observations, [("live-a", "stored-a")])
        self.assertEqual(agent.calls, [])
        self.assertIs(agent._memory_store, memory)
        self.assertEqual(agent.tools, tools, "constructing a guarded agent does not clear its native capabilities")
        with self.assertRaises(gateway.SupervisorPolicyError):
            agent.run_conversation("Submit without host admission")
        bridge.prepare(params())
        agent.before_action = lambda: bridge.invoke(gateway.ROUTE_NAME, {"intent": "discuss"}, session_id="stored-a")
        self.assertEqual(agent.run_conversation("A newly admitted human message"), {"text": "Native answer"})
        self.assertEqual(agent.calls, ["A newly admitted human message"])
        with self.assertRaises(gateway.SupervisorPolicyError):
            agent.run_conversation("Reuse a consumed preparation")


if __name__ == "__main__":
    unittest.main()
