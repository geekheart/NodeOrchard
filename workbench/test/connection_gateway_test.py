import copy
import importlib.util
import json
from pathlib import Path
import threading
import unittest

SPEC = importlib.util.spec_from_file_location("connection_gateway", Path(__file__).resolve().parents[1] / "python/connection_gateway.py")
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)


class Operation:
    def __init__(self):
        self.settled = False
        self.done = threading.Event()
        self.value = {"op_id": "native-op", "seq": 1, "targets": [{"name": "fixture", "kind": "mcp", "action": "install", "state": "pending",
            "required_env": [{"name": "FIXTURE_API_KEY", "secret": True, "required": True, "default": "must-not-leak"}]}]}

    def snapshot(self):
        return copy.deepcopy(self.value)


class Runtime:
    def __init__(self):
        self.rev = "sha256:" + "1" * 64
        self.op = Operation()
        self.started = threading.Event()
        self.answers = []
        self.calls = []

    def revision(self): return self.rev
    def inventory(self): return {"mcp": [], "catalog": [{"name": "fixture"}], "hosted": [], "hostedAvailable": False}
    def manage(self, args, session_id, callback):
        self.calls.append((args, session_id))
        callback(self.op.snapshot())
        self.started.set()
        if not self.op.done.wait(3): raise TimeoutError("fixture hung")
        return {**self.op.snapshot(), "settled": True}
    def operation(self, sid, op_id):
        return self.op if op_id == "native-op" else None
    def answer(self, op, body):
        self.answers.append(body)
        if body.get("targets"):
            op.value["targets"][0]["state"] = "connected" if body["targets"][0]["status"] == "approved" else "skipped"
            op.settled = True
            op.done.set()
    def cancel(self, op):
        op.settled = True
        op.value["targets"][0]["state"] = "skipped"
        op.done.set()


class ConnectionTests(unittest.TestCase):
    def setUp(self):
        self.runtime = Runtime()
        self.events = []
        self.service = bridge.HermesConnections(self.runtime, lambda *args: self.events.append(args))
        self.request = {"operation_id": "operation-one", "conversation_id": "supervisor-one", "turn_id": "turn-one",
            "expected_revision": self.runtime.rev, "action": "install", "connectors": [{"name": "fixture", "mcp": True}]}

    def start(self):
        self.result = []
        self.thread = threading.Thread(target=lambda: self.result.append(self.service.manage(self.request)))
        self.thread.start()
        self.assertTrue(self.runtime.started.wait(1))
        self.addCleanup(lambda: self.runtime.op.done.set())
        self.addCleanup(lambda: self.thread.join(3))

    def test_inspection_has_native_revision_without_commands_credentials(self):
        result = self.service.inspect({})
        self.assertTrue(result["native"])
        self.assertEqual(result["revision"], self.runtime.rev)
        with self.assertRaises(bridge.ConnectionPolicyError): self.service.inspect({"path": "/outside"})

    def test_native_tool_waits_for_exact_human_card_and_hides_secret_defaults(self):
        self.start()
        card = self.events[0][1]
        self.assertEqual(card["conversation_id"], "supervisor-one")
        self.assertEqual(card["snapshot"]["targets"][0]["required_env"][0]["default"], "")
        self.assertEqual(self.runtime.answers, [])
        result = self.service.respond({"operation_id": "operation-one", "result": {"targets": [{"name": "fixture", "status": "approved", "env": {"FIXTURE_API_KEY": "private-value"}}]}})
        self.assertTrue(result["settled"])
        self.thread.join(2)
        self.assertEqual(self.runtime.answers[0]["targets"][0]["env"]["FIXTURE_API_KEY"], "private-value")
        self.assertNotIn("private-value", json.dumps(self.result + self.events))
        self.assertNotIn("required_env", json.dumps(self.result))

    def test_model_cannot_inject_url_command_permission_or_credentials(self):
        for patch in ({"connectors": [{"name": "fixture", "mcp": True, "command": "rm"}]}, {"action": "disable"}, {"permission": True}, {"force": True}):
            with self.subTest(patch=patch), self.assertRaises(bridge.ConnectionPolicyError): self.service.manage({**self.request, **patch})
        self.assertFalse(self.runtime.started.is_set())

    def test_stale_configuration_does_not_start_native_operation(self):
        self.runtime.rev = "sha256:" + "2" * 64
        with self.assertRaisesRegex(bridge.ConnectionPolicyError, "changed"): self.service.manage(self.request)
        self.assertEqual(self.runtime.calls, [])

    def test_unknown_or_cross_target_answers_cannot_approve(self):
        self.start()
        for body in ({"targets": [{"name": "other", "status": "approved"}]}, {"targets": [{"name": "fixture", "status": "connected"}]},
                     {"targets": [{"name": "fixture", "status": "approved", "env": {"PATH": "outside"}}]}, {"targets": [{"name": "fixture", "status": "approved"}]}):
            with self.subTest(body=body), self.assertRaises(bridge.ConnectionPolicyError): self.service.respond({"operation_id": "operation-one", "result": body})
        self.assertEqual(self.runtime.answers, [])
        self.service.cancel({"operation_id": "operation-one"})

    def test_revision_changed_after_card_blocks_approval_but_allows_cancel(self):
        self.start()
        self.runtime.rev = "sha256:" + "2" * 64
        with self.assertRaisesRegex(bridge.ConnectionPolicyError, "changed"):
            self.service.respond({"operation_id": "operation-one", "result": {"targets": [{"name": "fixture", "status": "approved", "env": {"FIXTURE_API_KEY": "value"}}]}})
        self.assertTrue(self.service.cancel({"operation_id": "operation-one"})["cancelled"])
        self.thread.join(2)
        with self.assertRaises(bridge.ConnectionPolicyError): self.service.respond({"operation_id": "operation-one", "result": {}})

    def test_auth_links_are_browser_only_and_native_error_text_is_not_forwarded(self):
        raw = {"targets": [{"name": "fixture", "state": "initiated", "connect_url": "https://auth.invalid/?oneuse=opaque", "detail": "secret=private-value", "connection_id": "account"}], "error": "Bearer private-value"}
        self.assertIn("connect_url", bridge._public(raw, browser=True)["targets"][0])
        text = json.dumps(bridge._public(raw))
        for secret in ("opaque", "private-value", "connection_id"): self.assertNotIn(secret, text)

    def test_parallel_operations_are_refused_and_cancel_before_card_is_safe(self):
        self.start()
        with self.assertRaisesRegex(bridge.ConnectionPolicyError, "active"): self.service.manage({**self.request, "operation_id": "operation-two"})
        self.service.cancel({"operation_id": "operation-one"})
        self.thread.join(2)
        self.assertEqual(len(self.runtime.calls), 1)


if __name__ == "__main__": unittest.main()
