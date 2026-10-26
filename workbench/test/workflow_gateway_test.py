"""Pure stdlib tests: no Hermes imports, credentials, gateway, or model calls."""

from contextlib import contextmanager
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace, ModuleType
import unittest
from unittest.mock import patch
import uuid


_SCRIPT = Path(__file__).resolve().parents[1] / "python" / "workflow_gateway.py"
_SPEC = importlib.util.spec_from_file_location("workbench_workflow_gateway", _SCRIPT)
gateway = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(gateway)


class FakeMemoryStore:
    def __init__(self):
        self.blocks = {"memory": "preexisting synthetic memory", "user": "preexisting synthetic profile"}
        self.loads = 0
        self.writes = []

    def format_for_system_prompt(self, target):
        return self.blocks.get(target)

    def load_from_disk(self):
        self.loads += 1

    def add(self, target, content):
        self.writes.append((target, content))


class FakeMemoryManager:
    def __init__(self):
        self.calls = []

    def shutdown_all(self):
        self.calls.append(("shutdown",))

    def get_all_tool_names(self):
        return {"provider_recall", "provider_write"}

    def on_session_end(self, messages):
        self.calls.append(("session_end", messages))

    def sync_all(self, user, assistant):
        self.calls.append(("sync", user, assistant))


class FakeAgent:
    def __init__(self):
        self.session_id = "stored-session"
        self.tools = [{"function": {"name": name}} for name in ("memory", "terminal", "read_file", "write_file", "skill_manage", "tool_call")]
        self.valid_tool_names = {tool["function"]["name"] for tool in self.tools}
        self._skill_nudge_interval = 10
        self.review_calls = []
        self.skip_background_review = False
        self.memory_manager = object()
        self._memory_store = FakeMemoryStore()
        self._memory_manager = FakeMemoryManager()
        self._memory_nudge_interval = 10
        self._user_turn_count = 0
        self._memory_enabled = True
        self._user_profile_enabled = True
        self._cached_system_prompt = "initial live memory block"
        self._cached_system_prompt_static = "initial static prefix"

    def _spawn_background_review(self, messages_snapshot, review_memory=False, review_skills=False, focus=None, explicit=False):
        self.review_calls.append(("queued", review_memory, review_skills))

    def _spawn_background_review_now(self, messages_snapshot, review_memory=False, review_skills=False, focus=None, **kwargs):
        self.review_calls.append(("immediate", review_memory, review_skills))

    def _sync_external_memory_for_turn(self, *, original_user_message, final_response, interrupted, messages=None):
        if self._memory_manager:
            self._memory_manager.sync_all(original_user_message, final_response)

    def commit_memory_session(self, messages=None):
        if self._memory_manager:
            self._memory_manager.on_session_end(messages)

    def shutdown_memory_provider(self, messages=None):
        if self._memory_manager:
            self._memory_manager.on_session_end(messages)
            self._memory_manager.shutdown_all()


class FakeServer:
    def __init__(self, workspace, agent):
        self._LONG_HANDLERS = frozenset({"session.resume"})
        self.methods = {}
        self.sessions = {"runtime-session": {"agent": agent, "cwd": str(workspace), "session_key": "stored-session", "running": False}}
        self.scopes = []

    def _sess(self, params, rid):
        session = self.sessions.get(params.get("session_id"))
        return (session, None) if session else (None, self._err(rid, 4001, "session not found"))

    @contextmanager
    def _session_home_scope(self, session):
        self.scopes.append(session)
        yield

    def register_method(self, name, fn):
        self.methods[name] = fn

    def _wire_session_agent(self, sid, key, agent):
        if sid in self.sessions:
            self.sessions[sid]["agent"] = agent
        return True

    @staticmethod
    def _ok(rid, result):
        return {"jsonrpc": "2.0", "id": rid, "result": result}

    @staticmethod
    def _err(rid, code, msg):
        return {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": msg}}


def fake_skills(source):
    module = ModuleType("fake_skill_commands")
    # A normal FunctionType is important: the shim clones only this builder's
    # globals, and must never temporarily change the shared module config.
    exec('''
_load_skills_config = lambda: {"template_vars": True, "inline_shell": True}
def _build_skill_message(loaded_skill, skill_dir, activation_note, user_instruction="", runtime_note="", session_id=None):
    cfg = _load_skills_config()
    if cfg.get("inline_shell"):
        raise AssertionError("inline shell preprocessing must be disabled")
    content = loaded_skill["content"].replace("${HERMES_SKILL_DIR}", str(skill_dir))
    return activation_note + "\\n" + content + "\\n[Skill directory: " + str(skill_dir) + "]\\n" + user_instruction + "\\n" + runtime_note
''', module.__dict__)
    module.get_skill_commands = lambda: {"/example-skill": {"name": "Example Skill", "skill_dir": str(source)}}

    def load(skill_identifier, task_id=None):
        if str(source) != skill_identifier:
            return None
        return ({"name": "Example Skill", "content": (source / "SKILL.md").read_text(encoding="utf-8")}, source, "Example Skill")

    module._load_skill_payload = load
    return module


def fake_tool_modules():
    calls = []

    def execute(function_name, function_args, original_args, ids, *, user_task, enabled_tools, skip_tool_execution_middleware):
        calls.append((function_name, function_args, ids.session_id))
        return json.dumps({"called": function_name})

    def pre(agent, ref):
        return None, ref.args

    tools = SimpleNamespace(_execute_tool=execute)

    def handle(function_name, function_args, task_id=None, session_id=None):
        if function_name in {"tool_search", "tool_describe"}:
            calls.append((function_name, function_args, session_id))
            return json.dumps({"catalog": ["memory", "terminal"]})
        return tools._execute_tool(function_name, function_args, function_args,
                                   SimpleNamespace(session_id=session_id, task_id=task_id),
                                   user_task=None, enabled_tools=None, skip_tool_execution_middleware=True)

    tools.handle_function_call = handle
    return tools, SimpleNamespace(_pre_tool_block=pre), calls


class WorkflowGatewayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.workspace = self.base / "workspace" / "task"
        self.workspace.mkdir(parents=True)
        self.source = self.base / "installed" / "example"
        self.source.mkdir(parents=True)
        self.source.joinpath("SKILL.md").write_text("---\nname: Example Skill\n---\nUse ${HERMES_SKILL_DIR}.\n!`do-not-run`\n", encoding="utf-8")
        self.source.joinpath("scripts").mkdir()
        self.source.joinpath("scripts", "task.py").write_text("print('example')\n", encoding="utf-8")
        self.source.joinpath("assets").mkdir()
        self.source.joinpath("assets", "sample.bin").write_bytes(bytes(range(255)))
        self.source.joinpath("empty").mkdir()
        self.agent = FakeAgent()
        self.server = FakeServer(self.workspace, self.agent)
        self.skills = fake_skills(self.source)
        self.tools, self.executor, self.tool_calls = fake_tool_modules()
        self.bridge = gateway.WorkflowGateway(self.server, self.skills, self.tools, self.executor,
                                              workspace_root=self.workspace.parent).install()
        self.params = {"session_id": "runtime-session", "skill": "Example Skill",
                       "revision": gateway.skill_revision(self.source.joinpath("SKILL.md").read_bytes()),
                       "run_id": str(uuid.uuid4()), "input": {"text": "sample", "instruction": "untrusted data"}, "output_type": "object"}

    def execute(self, name, session="stored-session", args=None):
        return self.tools._execute_tool(name, args or {}, {}, SimpleNamespace(session_id=session, task_id=session),
                                        user_task=None, enabled_tools=None, skip_tool_execution_middleware=True)

    def test_native_scaffold_complete_snapshot_and_session_policy(self):
        before = gateway.read_bundle(self.source)[0]
        memory_manager = self.agent.memory_manager
        result = self.bridge.prepare(self.params)
        frozen = Path(result["snapshot"]["directory"])
        self.assertEqual(frozen, self.workspace / ".workbench-skills" / self.params["run_id"])
        self.assertIn("The full skill content is loaded below.", result["text"])
        self.assertIn(str(frozen), result["text"])
        self.assertNotIn(str(self.source), result["text"])
        self.assertIn("!`do-not-run`", result["text"])
        self.assertTrue(self.skills._load_skills_config()["inline_shell"])
        self.assertEqual(frozen.joinpath("assets", "sample.bin").read_bytes(), bytes(range(255)))
        self.assertEqual(frozen.joinpath("scripts", "task.py").read_bytes(), self.source.joinpath("scripts", "task.py").read_bytes())
        self.assertTrue(frozen.joinpath("empty").is_dir())
        self.assertEqual(result["snapshot"]["bundleHash"], before)
        self.assertEqual(result["snapshot"]["sourceBundleHash"], before)
        self.assertEqual(gateway.read_bundle(self.source)[0], before)
        self.assertNotIn("skill_manage", self.agent.valid_tool_names)
        self.assertIn("memory", self.agent.valid_tool_names)
        self.assertIn("terminal", self.agent.valid_tool_names)
        self.assertIn("write_file", self.agent.valid_tool_names)
        self.assertEqual(self.agent._skill_nudge_interval, 0)
        self.assertIs(self.agent.memory_manager, memory_manager)
        self.assertFalse(self.agent.skip_background_review)
        self.assertEqual(result["policy"], {"skillMutationBlocked": True, "memoryAllowed": True, "freeze": "bundle-copy"})
        self.assertEqual(set(self.server.methods), {"workbench.skill.prepare", "workbench.skill.input", "workbench.skill.finish", "workbench.learning.prepare",
                                                   "workbench.learning.memory.capture", "workbench.learning.memory.release", "workbench.learning.memory.restore"})
        self.assertIn("workbench.skill.prepare", self.server._LONG_HANDLERS)
        self.assertTrue(self.server.scopes)

    def test_late_dispatch_denies_even_if_deferred_schema_refresh_readds_skill_manage(self):
        self.bridge.prepare(self.params)
        self.agent.valid_tool_names.add("skill_manage")  # simulate late schema/MCP refresh
        self.assertIn("error", json.loads(self.execute("skill_manage")))
        self.assertIn("error", json.loads(self.execute("skill_manage", session="runtime-session")))
        self.assertEqual(self.tool_calls, [])
        self.assertEqual(json.loads(self.execute("terminal"))["called"], "terminal")
        self.assertEqual(json.loads(self.execute("memory"))["called"], "memory")
        self.assertEqual(json.loads(self.execute("skill_manage", session="ordinary-session"))["called"], "skill_manage")
        block, _ = self.executor._pre_tool_block(self.agent, SimpleNamespace(name="skill_manage", args={"action": "patch"}))
        self.assertIn("execution mode", block)
        self.assertEqual(self.executor._pre_tool_block(SimpleNamespace(session_id="other"), SimpleNamespace(name="skill_manage", args={})), (None, {}))

    def test_policy_and_resource_mapping_survive_native_session_id_rotation(self):
        self.bridge.prepare(self.params)
        # A late/deferred dispatch can carry a new physical session id together
        # with the old task identity before the agent pre-hook has run.
        early = self.tools._execute_tool("skill_manage", {}, {},
                                        SimpleNamespace(session_id="unseen-rotation", task_id="stored-session"),
                                        user_task=None, enabled_tools=None, skip_tool_execution_middleware=True)
        self.assertIn("error", json.loads(early))
        self.agent.session_id = "rotated-stored-session"
        self.executor._pre_tool_block(self.agent, SimpleNamespace(name="skill_view", args={}))
        self.assertIn("error", json.loads(self.execute("skill_manage", session="rotated-stored-session")))
        response = json.loads(self.execute("skill_view", session="rotated-stored-session",
                                           args={"name": "Example Skill", "file_path": "scripts/task.py"}))
        self.assertTrue(response["success"])
        self.assertEqual(response["content"], "print('example')\n")

    def test_skill_review_is_suppressed_but_memory_review_keeps_original_implementation(self):
        self.bridge.prepare(self.params)
        self.agent._spawn_background_review([], review_memory=False, review_skills=True)
        self.agent._spawn_background_review([], review_memory=True, review_skills=True)
        self.agent._spawn_background_review_now([], review_memory=True, review_skills=True)
        self.assertEqual(self.agent.review_calls, [("queued", True, False), ("immediate", True, False)])

    def test_skill_resource_reads_are_rebased_to_snapshot_and_escape_is_rejected(self):
        result = self.bridge.prepare(self.params)
        self.source.joinpath("scripts", "task.py").write_text("changed source\n", encoding="utf-8")
        response = json.loads(self.execute("skill_view", args={"name": "Example Skill", "file_path": "scripts/task.py"}))
        self.assertTrue(response["success"])
        self.assertEqual(response["content"], "print('example')\n")
        self.assertEqual(response["skill_dir"], result["snapshot"]["directory"])
        for bad in ("../auth.json", "/private/data", "..\\auth.json"):
            response = json.loads(self.execute("skill_view", args={"name": "Example Skill", "file_path": bad}))
            self.assertFalse(response["success"])
        self.assertEqual(self.tool_calls, [])

    def test_finish_audits_source_resources_and_snapshot_without_restoring_either(self):
        result = self.bridge.prepare(self.params)
        finish = {key: self.params[key] for key in ("session_id", "run_id")}
        self.assertEqual(self.bridge.finish(finish), {"unchanged": True, "snapshotIntact": True})
        self.source.joinpath("scripts", "task.py").write_text("changed source\n", encoding="utf-8")
        self.assertEqual(self.bridge.finish(finish), {"unchanged": False, "snapshotIntact": True})
        snapshot = Path(result["snapshot"]["directory"])
        snapshot.joinpath("assets", "sample.bin").write_bytes(b"changed snapshot")
        self.assertEqual(self.bridge.finish(finish), {"unchanged": False, "snapshotIntact": False})
        self.assertEqual(self.source.joinpath("scripts", "task.py").read_text(encoding="utf-8"), "changed source\n")
        self.assertIn("error", json.loads(self.execute("skill_manage")))

    def test_revision_mismatch_unknown_name_and_bad_json_fail_before_any_snapshot(self):
        for update in ({"revision": "sha256:" + "0" * 64}, {"skill": "other"}, {"run_id": "../escape"},
                       {"input": float("nan")}, {"output_type": "javascript"}, {"unexpected": "value"}):
            with self.subTest(update=update):
                response = self.bridge.prepare_rpc(7, self.params | update)
                self.assertEqual(response["error"]["code"], 4091)
        self.assertFalse(self.workspace.joinpath(".workbench-skills").exists())
        self.assertIn("skill_manage", self.agent.valid_tool_names)

    def test_workspace_and_snapshot_symlinks_fail_closed_without_writing_target(self):
        outside = self.base / "outside"
        outside.mkdir()
        self.server.sessions["runtime-session"]["cwd"] = str(outside)
        with self.assertRaisesRegex(gateway.WorkflowPolicyError, "outside"):
            self.bridge.prepare(self.params)
        self.server.sessions["runtime-session"]["cwd"] = str(self.workspace)
        self.workspace.joinpath(".workbench-skills").symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(gateway.WorkflowPolicyError, "real directory"):
            self.bridge.prepare(self.params)
        self.assertEqual(list(outside.iterdir()), [])
        self.bridge.workspace_root = None
        with self.assertRaisesRegex(gateway.WorkflowPolicyError, "WORKBENCH_GATEWAY_WORKSPACE_ROOT"):
            self.bridge.prepare(self.params)

    def test_symlink_credential_and_bundle_limits_are_rejected_without_loading_native_skill(self):
        self.source.joinpath("references").symlink_to(self.base, target_is_directory=True)
        with self.assertRaisesRegex(gateway.WorkflowPolicyError, "symlink"):
            self.bridge.prepare(self.params)
        self.source.joinpath("references").unlink()
        self.source.joinpath("auth.json").write_text("never-read", encoding="utf-8")
        with self.assertRaisesRegex(gateway.WorkflowPolicyError, "credential"):
            self.bridge.prepare(self.params)
        self.source.joinpath("auth.json").unlink()
        with patch.object(gateway, "MAX_BUNDLE_BYTES", 10):
            with self.assertRaisesRegex(gateway.WorkflowPolicyError, "size limit"):
                self.bridge.prepare(self.params)
        self.assertFalse(self.workspace.joinpath(".workbench-skills").exists())

    def test_prepare_idempotency_rejects_run_reuse_and_busy_sessions(self):
        result = self.bridge.prepare(self.params)
        self.assertEqual(self.bridge.prepare(dict(self.params)), result)
        with self.assertRaisesRegex(gateway.WorkflowPolicyError, "different workflow"):
            self.bridge.prepare(self.params | {"input": "changed"})
        with self.assertRaisesRegex(gateway.WorkflowPolicyError, "unfinished"):
            self.bridge.prepare(self.params | {"run_id": str(uuid.uuid4())})
        self.server.sessions["runtime-session"]["running"] = True
        with self.assertRaisesRegex(gateway.WorkflowPolicyError, "still running"):
            self.bridge.prepare(self.params)
        self.server.sessions["runtime-session"]["running"] = False
        finish = {"session_id": "runtime-session", "run_id": self.params["run_id"]}
        self.assertEqual(self.bridge.finish_rpc(5, finish)["result"], {"unchanged": True, "snapshotIntact": True})
        self.assertIn("error", self.bridge.finish_rpc(5, finish | {"session_id": "other"}))

    def test_finish_settles_message_complete_before_running_flag_clears(self):
        self.bridge.prepare(self.params)
        session = self.server.sessions["runtime-session"]
        session["running"] = True
        timer = threading.Timer(0.03, lambda: session.update(running=False))
        timer.start()
        self.addCleanup(timer.join)
        result = self.bridge.finish({"session_id": "runtime-session", "run_id": self.params["run_id"]})
        self.assertEqual(result, {"unchanged": True, "snapshotIntact": True})

    def test_native_interface_compatibility_fails_before_registration(self):
        self.tools._execute_tool = lambda name: None
        with self.assertRaisesRegex(gateway.WorkflowPolicyError, "Unsupported Hermes signature"):
            gateway.WorkflowGateway(self.server, self.skills, self.tools, self.executor, workspace_root=self.workspace).install()

    def test_revision_matches_universal_newlines_but_bundle_hash_keeps_raw_bytes(self):
        lf = b"name: sample\nbody\n"
        crlf = b"name: sample\r\nbody\r\n"
        self.assertEqual(gateway.skill_revision(lf), gateway.skill_revision(crlf))
        before = gateway.read_bundle(self.source)[0]
        self.source.joinpath("SKILL.md").write_bytes(crlf)
        self.assertNotEqual(gateway.read_bundle(self.source)[0], before)

    def input_params(self, value, *, run_id=None, session_id="runtime-session"):
        return {"session_id": session_id, "run_id": run_id or self.params["run_id"],
                "input": value, "output_type": self.params["output_type"]}

    @staticmethod
    def bound_json(message):
        return json.loads(message.split("\nWorkflow input (JSON):\n", 1)[1].split("\nWorkbench execution mode.", 1)[0])

    def test_same_skill_nodes_have_separate_snapshots_and_bind_only_their_own_input(self):
        other_agent = FakeAgent()
        other_agent.session_id = "stored-other"
        self.server.sessions["runtime-other"] = {
            "agent": other_agent, "cwd": str(self.workspace), "session_key": "stored-other", "running": False,
        }
        first_params = self.params | {"input": {"firstInitial": True}}
        second_params = self.params | {"session_id": "runtime-other", "run_id": str(uuid.uuid4()), "input": None}
        with patch.object(self.skills, "_load_skill_payload", wraps=self.skills._load_skill_payload) as load:
            first = self.bridge.prepare(first_params)
            second = self.bridge.prepare(second_params)
            self.assertEqual(load.call_count, 2)
        self.assertNotEqual(first["snapshot"]["directory"], second["snapshot"]["directory"])
        self.assertEqual(first["snapshot"]["bundleHash"], second["snapshot"]["bundleHash"])
        first_value = {"onlyFirst": "previous output", "false": False, "zero": 0, "null": None}
        second_value = {"onlySecond": [False, 0, None]}
        with patch.object(self.skills, "get_skill_commands", side_effect=AssertionError("must not rediscover live skills")), \
             patch.object(self.skills, "_load_skill_payload", side_effect=AssertionError("must not reload live skill")):
            first_message = self.bridge.bind_input(self.input_params(first_value))["text"]
            second_message = self.bridge.bind_input(self.input_params(second_value, run_id=second_params["run_id"],
                                                                          session_id="runtime-other"))["text"]
        self.assertEqual(self.bound_json(first_message), first_value)
        self.assertEqual(self.bound_json(second_message), second_value)
        self.assertNotIn("onlySecond", first_message)
        self.assertNotIn("onlyFirst", second_message)
        self.assertNotIn("firstInitial", first_message)
        self.assertIn(first["snapshot"]["directory"], first_message)
        self.assertNotIn(second["snapshot"]["directory"], first_message)
        self.assertEqual(self.bridge.finish({"session_id": "runtime-session", "run_id": self.params["run_id"]}),
                         {"unchanged": True, "snapshotIntact": True})
        self.assertEqual(self.bridge.finish({"session_id": "runtime-other", "run_id": second_params["run_id"]}),
                         {"unchanged": True, "snapshotIntact": True})

    def test_bind_preserves_typed_false_zero_null_and_object_without_repreparing(self):
        self.bridge.prepare(self.params | {"input": None})
        for value in (False, 0, None, {"typed": [False, 0, None]}, "literal input"):
            with self.subTest(value=value):
                response = self.server.methods["workbench.skill.input"](19, self.input_params(value))
                self.assertEqual(response["id"], 19)
                self.assertEqual(self.bound_json(response["result"]["text"]), value)
        self.assertIn("workbench.skill.input", self.server._LONG_HANDLERS)

    def test_bind_rejects_changed_source_or_snapshot_before_building_message(self):
        prepared = self.bridge.prepare(self.params)
        resource = self.source / "scripts" / "task.py"
        original = resource.read_bytes()
        resource.write_bytes(b"new source resource")
        with patch.object(self.bridge, "_native_message", side_effect=AssertionError("must audit before building")):
            with self.assertRaisesRegex(gateway.WorkflowPolicyError, "bundle changed"):
                self.bridge.bind_input(self.input_params({"value": 1}))
        resource.write_bytes(original)
        Path(prepared["snapshot"]["directory"]).joinpath("scripts", "task.py").write_bytes(b"new snapshot resource")
        with self.assertRaisesRegex(gateway.WorkflowPolicyError, "bundle changed"):
            self.bridge.bind_input(self.input_params({"value": 2}))

    def test_bind_requires_the_prepared_session_idle_unfinished_and_original_output_type(self):
        self.bridge.prepare(self.params | {"input": None})
        for patch_ in ({"session_id": "other-session"}, {"run_id": str(uuid.uuid4())},
                       {"output_type": "text"}, {"extra": True}):
            with self.subTest(patch=patch_):
                response = self.bridge.input_rpc(20, self.input_params(None) | patch_)
                self.assertEqual(response["error"]["code"], 4093)
        self.server.sessions["runtime-session"]["running"] = True
        with self.assertRaisesRegex(gateway.WorkflowPolicyError, "still running"):
            self.bridge.bind_input(self.input_params(None))
        self.server.sessions["runtime-session"]["running"] = False
        self.bridge.finish({"session_id": "runtime-session", "run_id": self.params["run_id"]})
        with self.assertRaisesRegex(gateway.WorkflowPolicyError, "already finished"):
            self.bridge.bind_input(self.input_params(None))

    def test_input_binding_limits_json_utf8_bytes_to_64kb_before_native_build(self):
        self.bridge.prepare(self.params)
        accepted = "x" * (64 * 1024 - 2)
        self.assertEqual(self.bound_json(self.bridge.bind_input(self.input_params(accepted))["text"]), accepted)
        for value in (accepted + "x", "界" * 21845, float("nan"), {"bad": object()}):
            with self.subTest(type=type(value)):
                response = self.bridge.input_rpc(21, self.input_params(value))
                self.assertEqual(response["error"]["code"], 4093)
        self.assertEqual(self.bridge.prepare_rpc(22, self.params | {"run_id": str(uuid.uuid4()), "input": "界" * 21845})["error"]["code"], 4091)

    def test_prepared_but_never_executed_node_can_finish_and_remain_unbindable(self):
        self.bridge.prepare(self.params | {"input": None})
        result = self.bridge.finish({"session_id": "runtime-session", "run_id": self.params["run_id"]})
        self.assertEqual(result, {"unchanged": True, "snapshotIntact": True})
        self.assertEqual(self.bridge.input_rpc(23, self.input_params("not executed"))["error"]["code"], 4093)

    def candidate_params(self, content=None):
        content = content or "---\nname: Example Skill\n---\nUse the improved candidate instructions.\n"
        return self.params | {"revision": gateway._sha256(content.encode("utf-8")),
                              "candidate_content": content, "source_revision": self.params["revision"]}

    def test_candidate_changes_only_frozen_markdown_and_uses_original_resources(self):
        original = self.source.joinpath("SKILL.md").read_bytes()
        original_hash = gateway.read_bundle(self.source)[0]
        params = self.candidate_params()
        prepared = self.bridge.prepare(params)
        frozen = Path(prepared["snapshot"]["directory"])
        self.assertEqual(prepared["skill"]["name"], "Example Skill")
        self.assertEqual(prepared["skill"]["revision"], params["revision"])
        self.assertEqual(prepared["skill"]["sourceRevision"], self.params["revision"])
        self.assertEqual(self.source.joinpath("SKILL.md").read_bytes(), original)
        self.assertEqual(frozen.joinpath("SKILL.md").read_text(encoding="utf-8"), params["candidate_content"])
        self.assertEqual(frozen.joinpath("scripts", "task.py").read_bytes(), self.source.joinpath("scripts", "task.py").read_bytes())
        self.assertEqual(frozen.joinpath("assets", "sample.bin").read_bytes(), bytes(range(255)))
        self.assertEqual(prepared["snapshot"]["sourceBundleHash"], original_hash)
        self.assertNotEqual(prepared["snapshot"]["bundleHash"], original_hash)
        self.assertIn("improved candidate instructions", prepared["text"])
        self.assertNotIn("!`do-not-run`", prepared["text"])
        bound = self.bridge.bind_input(self.input_params({"value": False}))["text"]
        self.assertIn("improved candidate instructions", bound)
        self.assertEqual(self.bound_json(bound), {"value": False})
        view = json.loads(self.execute("skill_view", args={"name": "Example Skill"}))
        self.assertEqual(view["content"], params["candidate_content"])
        self.assertEqual(self.bridge.finish({"session_id": "runtime-session", "run_id": self.params["run_id"]}),
                         {"unchanged": True, "snapshotIntact": True})

    def test_candidate_frontmatter_identity_revision_and_source_are_strictly_checked_before_copy(self):
        for content in ("---\nname: Changed Skill\n---\nnew body", "new body without original frontmatter",
                        "---\nname: Example Skill\nmetadata:\n  hermes:\n    config: []\n---\nnew body"):
            with self.subTest(content=content):
                with self.assertRaisesRegex(gateway.WorkflowPolicyError, "frontmatter"):
                    self.bridge.prepare(self.candidate_params(content))
        params = self.candidate_params()
        for update in ({"revision": self.params["revision"]}, {"source_revision": "sha256:" + "0" * 64},
                       {"source_revision": "latest"}, {"candidate_content": ""}, {"candidate_content": None}):
            with self.subTest(update=update):
                self.assertEqual(self.bridge.prepare_rpc(29, params | update)["error"]["code"], 4091)
        for missing in ("candidate_content", "source_revision"):
            incomplete = dict(params)
            incomplete.pop(missing)
            self.assertEqual(self.bridge.prepare_rpc(29, incomplete)["error"]["code"], 4091)
        self.assertFalse(self.workspace.joinpath(".workbench-skills").exists())

    def test_candidate_without_source_frontmatter_cannot_add_new_metadata(self):
        source_content = "Original body without metadata.\n"
        self.source.joinpath("SKILL.md").write_text(source_content, encoding="utf-8")
        self.params["revision"] = gateway.skill_revision(source_content.encode("utf-8"))
        with self.assertRaisesRegex(gateway.WorkflowPolicyError, "frontmatter"):
            self.bridge.prepare(self.candidate_params())
        prepared = self.bridge.prepare(self.candidate_params("Improved body without metadata.\n"))
        self.assertIn("Improved body without metadata", prepared["text"])

    def test_candidate_body_spacing_is_allowed_but_metadata_whitespace_changes_are_rejected(self):
        content = "---\nname: Example Skill\n---\n\n\nAn improved body after blank lines.\n"
        prepared = self.bridge.prepare(self.candidate_params(content))
        self.assertIn("An improved body", prepared["text"])
        changed = "---\nname:  Example Skill\n---\nBody"
        changed_params = self.candidate_params(changed) | {"run_id": str(uuid.uuid4())}
        self.bridge.finish({"session_id": "runtime-session", "run_id": self.params["run_id"]})
        with self.assertRaisesRegex(gateway.WorkflowPolicyError, "frontmatter"):
            self.bridge.prepare(changed_params)

    def test_candidate_and_installed_package_integrity_are_audited_independently(self):
        prepared = self.bridge.prepare(self.candidate_params())
        finish = {"session_id": "runtime-session", "run_id": self.params["run_id"]}
        frozen = Path(prepared["snapshot"]["directory"])
        content = frozen.joinpath("SKILL.md").read_bytes()
        frozen.joinpath("SKILL.md").write_bytes(content + b"tampered")
        self.assertEqual(self.bridge.finish(finish), {"unchanged": True, "snapshotIntact": False})
        frozen.joinpath("SKILL.md").write_bytes(content)
        self.source.joinpath("scripts", "task.py").write_bytes(b"changed original resource")
        self.assertEqual(self.bridge.finish(finish), {"unchanged": False, "snapshotIntact": True})

    def test_learning_control_policy_reads_existing_memory_but_blocks_writes_reviews_and_all_tools(self):
        memory_store = self.agent._memory_store
        memory_manager = self.agent._memory_manager
        response = self.server.methods["workbench.learning.prepare"](30, {"session_id": "runtime-session"})
        self.assertEqual(response["result"], {"policy": {"toolsAllowed": False, "memoryAllowed": True,
                                                        "memoryWriteAllowed": False, "skillMutationBlocked": True}})
        self.assertEqual(self.agent.tools, [])
        self.assertEqual(self.agent.valid_tool_names, set())
        self.assertEqual(self.agent._skill_nudge_interval, 0)
        self.assertIsNone(self.agent._memory_manager)
        self.assertTrue(self.agent.skip_background_review)
        self.assertEqual(self.agent._memory_nudge_interval, 0)
        self.assertEqual(self.agent._memory_store.format_for_system_prompt("memory"), memory_store.blocks["memory"])
        self.assertEqual(self.agent._memory_store.format_for_system_prompt("user"), memory_store.blocks["user"])
        memory_store.blocks["memory"] = "unrelated later changes"
        self.agent._memory_store.load_from_disk()
        self.assertEqual(self.agent._memory_store.format_for_system_prompt("memory"), "preexisting synthetic memory")
        self.assertEqual(memory_store.loads, 0)
        with self.assertRaisesRegex(gateway.WorkflowPolicyError, "do not permit memory writes"):
            self.agent._memory_store.add("memory", "PRIVATE_VALIDATION_ANSWER")
        self.agent._spawn_background_review([], review_memory=True, review_skills=True)
        self.agent._spawn_background_review_now([], review_memory=True, review_skills=True)
        self.agent._sync_external_memory_for_turn(original_user_message="PRIVATE_VALIDATION_INPUT", final_response="PRIVATE_VALIDATION_ANSWER",
                                                  interrupted=False, messages=[{"role": "user", "content": "PRIVATE_VALIDATION_ANSWER"}])
        self.agent.commit_memory_session([{"content": "PRIVATE_VALIDATION_ANSWER"}])
        self.agent.shutdown_memory_provider([{"content": "PRIVATE_VALIDATION_ANSWER"}])
        self.assertEqual(self.agent.review_calls, [])
        self.assertEqual(memory_manager.calls, [("shutdown",)])
        self.assertEqual(memory_store.writes, [])
        for name in ("memory", "terminal", "skill_manage", "tool_search", "tool_describe", "tool_call"):
            with self.subTest(name=name):
                self.agent.valid_tool_names.add(name)  # a deferred refresh must not widen the grant
                self.assertEqual(json.loads(self.execute(name))["code"], "workbench_learning_tools_blocked")
                direct = self.tools.handle_function_call(name, {"tool_name": "terminal"},
                                                         task_id="stored-session", session_id="new-unseen-session")
                self.assertEqual(json.loads(direct)["code"], "workbench_learning_tools_blocked")
                block, _ = self.executor._pre_tool_block(self.agent, SimpleNamespace(name=name, args={}))
                self.assertIn("do not permit tool calls", block)
        self.assertEqual(self.tool_calls, [])
        ordinary = json.loads(self.tools.handle_function_call("terminal", {}, task_id="ordinary", session_id="ordinary"))
        self.assertEqual(ordinary["called"], "terminal")

    def test_normal_skill_sessions_keep_live_builtin_and_external_memory_and_memory_only_review(self):
        store, manager = self.agent._memory_store, self.agent._memory_manager
        self.bridge.prepare(self.params)
        self.assertIs(self.agent._memory_store, store)
        self.assertIs(self.agent._memory_manager, manager)
        self.assertFalse(self.agent.skip_background_review)
        self.assertEqual(self.agent._memory_nudge_interval, 10)
        self.agent._spawn_background_review([], review_memory=True, review_skills=True)
        self.agent._sync_external_memory_for_turn(original_user_message="ordinary input", final_response="ordinary output", interrupted=False)
        self.agent.commit_memory_session([{"content": "ordinary input"}])
        self.assertEqual(self.agent.review_calls, [("queued", True, False)])
        self.assertEqual(manager.calls, [("sync", "ordinary input", "ordinary output"), ("session_end", [{"content": "ordinary input"}])])

    def test_learning_memory_policy_survives_rebuild_and_agent_reuse_without_touching_ordinary_agents(self):
        self.bridge.learning_prepare({"session_id": "runtime-session"})
        rebuilt = FakeAgent()
        old_manager = rebuilt._memory_manager
        rebuilt._user_turn_count = 2  # a native rebuilt agent may restore its history
        self.assertTrue(self.server._wire_session_agent("runtime-rebuilt", "stored-session", rebuilt))
        self.assertIsNone(rebuilt._memory_manager)
        self.assertTrue(rebuilt.skip_background_review)
        self.assertEqual(rebuilt.valid_tool_names, set())
        rebuilt._spawn_background_review([], review_memory=True, review_skills=True)
        self.assertEqual(rebuilt.review_calls, [])
        self.assertEqual(old_manager.calls, [("shutdown",)])
        self.assertEqual(json.loads(self.execute("memory", session="runtime-rebuilt"))["code"], "workbench_learning_tools_blocked")
        self.assertTrue(self.server._wire_session_agent("reuse-runtime", "reuse-key", rebuilt))
        self.assertEqual(json.loads(self.execute("terminal", session="reuse-runtime"))["code"], "workbench_learning_tools_blocked")
        ordinary = FakeAgent()
        ordinary_manager, ordinary_store = ordinary._memory_manager, ordinary._memory_store
        self.assertTrue(self.server._wire_session_agent("ordinary-runtime", "ordinary-key", ordinary))
        self.assertIs(ordinary._memory_manager, ordinary_manager)
        self.assertIs(ordinary._memory_store, ordinary_store)
        self.assertFalse(ordinary.skip_background_review)
        self.assertIn("memory", ordinary.valid_tool_names)

    def test_learning_memory_policy_fails_closed_on_unknown_interfaces_or_nonfresh_session(self):
        for name in ("_sync_external_memory_for_turn", "commit_memory_session", "shutdown_memory_provider"):
            with self.subTest(name=name):
                original = getattr(self.agent, name)
                setattr(self.agent, name, lambda: None)
                self.assertEqual(self.bridge.learning_prepare_rpc(32, {"session_id": "runtime-session"})["error"]["code"], 4094)
                self.assertEqual(self.agent._memory_manager.calls, [])
                self.assertFalse(self.agent.skip_background_review)
                setattr(self.agent, name, original)
        self.server.sessions["runtime-session"]["history"] = [{"role": "user", "content": "old prompt"}]
        with self.assertRaisesRegex(gateway.WorkflowPolicyError, "fresh session"):
            self.bridge.learning_prepare({"session_id": "runtime-session"})
        self.assertEqual(self.agent._memory_manager.calls, [])
        self.server.sessions["runtime-session"]["history"] = []
        with patch.object(self.agent._memory_manager, "shutdown_all", side_effect=RuntimeError("provider failure")):
            with self.assertRaisesRegex(gateway.WorkflowPolicyError, "Cannot retire external"):
                self.bridge.learning_prepare({"session_id": "runtime-session"})
        self.assertFalse(self.agent.skip_background_review)
        self.assertIn("memory", self.agent.valid_tool_names)
        with patch.object(self.agent._memory_store, "format_for_system_prompt", new=lambda: "incompatible"):
            with self.assertRaisesRegex(gateway.WorkflowPolicyError, "Unsupported Hermes"):
                self.bridge.learning_prepare({"session_id": "runtime-session"})

    def test_learning_rebuild_with_incompatible_memory_seam_refuses_before_native_wiring(self):
        self.bridge.learning_prepare({"session_id": "runtime-session"})
        rebuilt = FakeAgent()
        rebuilt.commit_memory_session = None
        self.server.sessions["runtime-rebuilt"] = {"agent": None}
        with self.assertRaisesRegex(gateway.WorkflowPolicyError, "commit_memory_session"):
            self.server._wire_session_agent("runtime-rebuilt", "stored-session", rebuilt)
        self.assertIsNone(self.server.sessions["runtime-rebuilt"]["agent"])
        self.assertEqual(rebuilt._memory_manager.calls, [])

    def test_learning_no_tools_policy_survives_agent_identity_rotation(self):
        self.bridge.learning_prepare({"session_id": "runtime-session"})
        self.agent.session_id = "rotated-learning-session"
        self.executor._pre_tool_block(self.agent, SimpleNamespace(name="memory", args={}))
        self.assertEqual(json.loads(self.execute("memory", session="rotated-learning-session"))["code"], "workbench_learning_tools_blocked")
        self.assertEqual(json.loads(self.tools.handle_function_call("tool_search", {}, session_id="rotated-learning-session"))["code"],
                         "workbench_learning_tools_blocked")

    def test_learning_preparation_refuses_busy_unknown_or_execution_sessions_and_is_repeatable(self):
        self.server.sessions["runtime-session"]["running"] = True
        self.assertEqual(self.bridge.learning_prepare_rpc(31, {"session_id": "runtime-session"})["error"]["code"], 4094)
        self.server.sessions["runtime-session"]["running"] = False
        self.assertEqual(self.bridge.learning_prepare_rpc(31, {"session_id": "missing"})["error"]["code"], 4001)
        self.assertEqual(self.bridge.learning_prepare_rpc(31, {"session_id": "runtime-session", "extra": True})["error"]["code"], 4094)
        self.bridge.prepare(self.params)
        with self.assertRaisesRegex(gateway.WorkflowPolicyError, "Skill execution session"):
            self.bridge.learning_prepare({"session_id": "runtime-session"})
        self.bridge.finish({"session_id": "runtime-session", "run_id": self.params["run_id"]})
        other = FakeAgent()
        other.session_id = "learning-stored"
        self.server.sessions["learning"] = {"agent": other, "cwd": str(self.workspace), "session_key": "learning-stored", "running": False}
        first = self.bridge.learning_prepare({"session_id": "learning"})
        self.assertEqual(self.bridge.learning_prepare({"session_id": "learning"}), first)
        with self.assertRaisesRegex(gateway.WorkflowPolicyError, "learning control session"):
            self.bridge.prepare(self.params | {"session_id": "learning", "run_id": str(uuid.uuid4())})

    def new_session(self, sid, memory="synthetic new live memory"):
        agent = FakeAgent()
        agent.session_id = "stored-" + sid
        agent._memory_store.blocks["memory"] = memory
        self.server.sessions[sid] = {"agent": agent, "cwd": str(self.workspace), "session_key": agent.session_id,
                                     "history": [], "running": False}
        return agent

    def capture_scope(self, scope_id=None):
        scope_id = scope_id or str(uuid.uuid4())
        anchor = self.new_session("anchor", "fixed memory before learning")
        result = self.bridge.memory_capture({"session_id": "anchor", "memory_scope_id": scope_id})
        return scope_id, anchor, result

    def set_planning_skill(self, declaration="allowed-tools: []"):
        content = "---\nname: Example Skill\n" + declaration + "\n---\nPlan using only the supplied JSON.\n"
        self.source.joinpath("SKILL.md").write_text(content, encoding="utf-8")
        self.params["revision"] = gateway.skill_revision(content.encode("utf-8"))
        return content

    def test_declared_empty_tools_learning_skill_blocks_real_dispatch_bridges_and_late_refresh(self):
        self.set_planning_skill()
        scope_id, anchor, _ = self.capture_scope()
        params = self.params | {"memory_scope_id": scope_id}
        result = self.bridge.prepare(params)
        self.assertFalse(result["policy"]["toolsAllowed"])
        self.assertIs(self.agent._memory_store, anchor._memory_store)
        self.assertEqual(self.agent.tools, [])
        self.assertEqual(self.agent.valid_tool_names, set())
        self.assertEqual(result, self.bridge.prepare(params), "exact retries of admitted no-tool Skills are idempotent")
        for name in ("read_file", "write_file", "terminal", "python", "memory", "skill_manage", "tool_search", "tool_describe", "unlisted_plugin"):
            with self.subTest(name=name):
                self.agent.valid_tool_names.add(name)
                self.agent.tools.append({"function": {"name": name}})
                self.assertEqual(json.loads(self.execute(name))["code"], "workbench_learning_tools_blocked")
                self.assertEqual(json.loads(self.execute(name, session="runtime-session"))["code"], "workbench_learning_tools_blocked")
                for args in ({"name": name}, {"tool_name": name}, {"calls": [{"name": name, "arguments": {"path": "/golden/answer"}}]}):
                    self.assertEqual(json.loads(self.tools.handle_function_call("tool_call", args, task_id="stored-session"))["code"],
                                     "workbench_learning_tools_blocked")
                self.assertEqual(json.loads(self.tools.handle_function_call(name, {}, task_id="stored-session",
                                                                           session_id="unseen-physical-session"))["code"],
                                 "workbench_learning_tools_blocked")
                block, _ = self.executor._pre_tool_block(self.agent, SimpleNamespace(name=name, args={}))
                self.assertIn("do not permit tool calls", block)
        self.assertEqual(self.tool_calls, [], "no guarded call may reach the underlying executor or catalog")
        with self.assertRaisesRegex(gateway.WorkflowPolicyError, "different workflow invocation"):
            self.bridge.prepare(params | {"input": {"changed": True}})
        with self.assertRaisesRegex(gateway.WorkflowPolicyError, "learning control session"):
            self.bridge.prepare(params | {"run_id": str(uuid.uuid4())})
        control = self.new_session("actual-control")
        self.bridge.learning_prepare({"session_id": "actual-control", "memory_scope_id": scope_id})
        with self.assertRaisesRegex(gateway.WorkflowPolicyError, "learning control session"):
            self.bridge.prepare(params | {"session_id": "actual-control", "run_id": str(uuid.uuid4())})
        self.assertEqual(control.valid_tool_names, set())

    def test_no_tools_planning_policy_survives_rotation_rebuild_release_and_keeps_ordinary_memory(self):
        self.set_planning_skill()
        scope_id, anchor, _ = self.capture_scope()
        params = self.params | {"memory_scope_id": scope_id}
        self.bridge.prepare(params)
        self.agent.session_id = "rotated-planning-session"
        block, _ = self.executor._pre_tool_block(self.agent, SimpleNamespace(name="read_file", args={"path": "/golden/answer"}))
        self.assertIn("do not permit tool calls", block)
        self.assertEqual(json.loads(self.tools.handle_function_call("tool_search", {}, session_id="rotated-planning-session"))["code"],
                         "workbench_learning_tools_blocked")
        self.bridge.memory_release({"memory_scope_id": scope_id})
        rebuilt = FakeAgent()
        manager = rebuilt._memory_manager
        rebuilt._user_turn_count = 2
        self.server._wire_session_agent("rebuilt-planner", "rotated-planning-session", rebuilt)
        self.assertEqual(rebuilt.tools, [])
        self.assertEqual(rebuilt.valid_tool_names, set())
        self.assertIs(rebuilt._memory_store, anchor._memory_store)
        self.assertEqual(manager.calls, [("shutdown",)])
        rebuilt.valid_tool_names.add("terminal")
        self.assertEqual(json.loads(self.execute("terminal", session="rebuilt-planner"))["code"], "workbench_learning_tools_blocked")
        self.assertEqual(json.loads(self.tools.handle_function_call("tool_call", {"tool_name": "read_file"}, task_id="rotated-planning-session"))["code"],
                         "workbench_learning_tools_blocked")
        ordinary = self.new_session("ordinary-planner")
        store, ordinary_manager = ordinary._memory_store, ordinary._memory_manager
        result = self.bridge.prepare(self.params | {"session_id": "ordinary-planner", "run_id": str(uuid.uuid4())})
        self.assertNotIn("toolsAllowed", result["policy"], "declaration only adds the workbench restriction within learning scopes")
        self.assertIs(ordinary._memory_store, store)
        self.assertIs(ordinary._memory_manager, ordinary_manager)
        self.assertEqual(json.loads(self.execute("memory", session="stored-ordinary-planner"))["called"], "memory")
        self.assertEqual(json.loads(self.execute("terminal", session="stored-ordinary-planner"))["called"], "terminal")
        ordinary._spawn_background_review([], review_memory=True, review_skills=True)
        ordinary._sync_external_memory_for_turn(original_user_message="ordinary", final_response="result", interrupted=False)
        ordinary.commit_memory_session([{"content": "ordinary"}])
        self.assertEqual(ordinary.review_calls, [("queued", True, False)])
        self.assertEqual(ordinary_manager.calls, [("sync", "ordinary", "result"), ("session_end", [{"content": "ordinary"}])])

    def test_empty_tool_declaration_is_metadata_only_and_never_inferred_from_other_yaml_values(self):
        scope_id, _, _ = self.capture_scope()
        variants = [
            "---\nname: Example Skill\n---\nallowed-tools: []\n",
            "---\n---\nallowed-tools: []\n---\nPlan.\n",
            "---\nname: Example Skill\nallowed-tools: \"[]\"\n---\nPlan.\n",
            "---\nname: Example Skill\nallowed-tools: [terminal]\n---\nPlan.\n",
            "---\nname: Example Skill\nallowed-tools:\n  - terminal\n---\nPlan.\n",
            "---\nname: Example Skill\ndescription: |\n  allowed-tools: []\n---\nPlan.\n",
            "---\nname: Example Skill\nallowed-tools: []\nallowed-tools: [terminal]\n---\nPlan.\n",
        ]
        for index, content in enumerate(variants):
            with self.subTest(content=content):
                self.source.joinpath("SKILL.md").write_text(content, encoding="utf-8")
                sid = "not-empty-" + str(index)
                agent = self.new_session(sid)
                result = self.bridge.prepare(self.params | {"session_id": sid, "run_id": str(uuid.uuid4()),
                                                           "revision": gateway.skill_revision(content.encode("utf-8")),
                                                           "memory_scope_id": scope_id})
                self.assertNotIn("toolsAllowed", result["policy"])
                self.assertIn("terminal", agent.valid_tool_names)
                self.assertEqual(json.loads(self.execute("terminal", session="stored-" + sid))["called"], "terminal")
        # A normalized frontmatter with BOM, CRLF and whitespace is the same
        # supported bare single-line empty YAML list, not a body substring.
        content = "\ufeff---\r\nname: Example Skill\r\nallowed-tools : [ ] # pure planning\r\n---\r\nPlan.\r\n"
        self.source.joinpath("SKILL.md").write_bytes(content.encode("utf-8"))
        sid = "whitespace-planner"
        agent = self.new_session(sid)
        result = self.bridge.prepare(self.params | {"session_id": sid, "run_id": str(uuid.uuid4()),
                                                   "revision": gateway.skill_revision(content.encode("utf-8")), "memory_scope_id": scope_id})
        self.assertFalse(result["policy"]["toolsAllowed"])
        self.assertEqual(agent.valid_tool_names, set())
        self.assertEqual(json.loads(self.execute("read_file", session="stored-" + sid))["code"], "workbench_learning_tools_blocked")

    def test_planning_candidate_cannot_remove_or_expand_source_no_tools_frontmatter(self):
        original = self.set_planning_skill()
        scope_id, _, _ = self.capture_scope()
        for declaration in ("", "allowed-tools: [terminal]", "allowed-tools: []\nallowed-tools: [read_file]"):
            content = "---\nname: Example Skill\n" + declaration + "\n---\nImproved body.\n"
            with self.subTest(declaration=declaration):
                with self.assertRaisesRegex(gateway.WorkflowPolicyError, "frontmatter"):
                    self.bridge.prepare(self.candidate_params(content) | {"memory_scope_id": scope_id})
        candidate = original.replace("Plan using only the supplied JSON.", "Use the improved directory convention on supplied JSON.")
        params = self.candidate_params(candidate) | {"memory_scope_id": scope_id}
        prepared = self.bridge.prepare(params)
        self.assertFalse(prepared["policy"]["toolsAllowed"])
        self.assertEqual(self.bridge.prepare(params), prepared)
        self.assertEqual(json.loads(self.execute("read_file"))["code"], "workbench_learning_tools_blocked")
        self.source.joinpath("SKILL.md").write_text(original.replace("allowed-tools: []", "allowed-tools: [terminal]"), encoding="utf-8")
        with self.assertRaisesRegex(gateway.WorkflowPolicyError, "bundle changed"):
            self.bridge.prepare(params)

    def test_batch_capture_is_fresh_private_idempotent_and_never_overwrites_the_original_snapshot(self):
        scope_id, anchor, result = self.capture_scope()
        self.assertEqual(result, {"policy": {"toolsAllowed": False, "memoryAllowed": True, "memoryWriteAllowed": False,
                                             "externalMemoryAllowed": False, "memoryMode": "batch-snapshot",
                                             "memoryScopeId": scope_id, "skillMutationBlocked": True}})
        self.assertNotIn("fixed memory before learning", json.dumps(result))
        snapshot = anchor._memory_store
        self.assertEqual(snapshot.format_for_system_prompt("memory"), "fixed memory before learning")
        self.assertIsNone(anchor._cached_system_prompt)
        self.assertEqual(self.bridge.memory_capture({"session_id": "anchor", "memory_scope_id": scope_id}), result)
        self.assertIs(self.bridge.memory_scopes[scope_id]["snapshot"], snapshot)
        self.new_session("different-anchor")
        with self.assertRaisesRegex(gateway.WorkflowPolicyError, "another capture session"):
            self.bridge.memory_capture({"session_id": "different-anchor", "memory_scope_id": scope_id})
        self.server.sessions["different-anchor"]["history"] = [{"role": "user", "content": "old prompt"}]
        with self.assertRaisesRegex(gateway.WorkflowPolicyError, "fresh anchor"):
            self.bridge.memory_capture({"session_id": "different-anchor", "memory_scope_id": str(uuid.uuid4())})
        self.assertEqual(len(self.bridge.memory_scopes), 1)

    def test_batch_control_and_skill_use_one_snapshot_and_block_memory_tools_bridges_and_unmanaged_agents(self):
        scope_id, anchor, _ = self.capture_scope()
        control = self.new_session("control", "validation answer must not enter the scope")
        control._memory_enabled = False
        control_manager = control._memory_manager
        response = self.bridge.learning_prepare({"session_id": "control", "memory_scope_id": scope_id})
        self.assertEqual(response["policy"]["memoryScopeId"], scope_id)
        self.assertTrue(control._memory_enabled, "scope flags override a new agent's live configuration")
        self.assertIs(control._memory_store, anchor._memory_store)
        self.assertEqual(control.valid_tool_names, set())
        self.agent._memory_store.blocks["memory"] = "CHANGED LIVE MEMORY DURING LEARNING"
        self.agent.valid_tool_names.update({"provider_write", "provider_recall", "delegate_task", "cronjob_manage", "message_agent", "kanban_create"})
        self.agent.tools.extend({"function": {"name": name}} for name in ("provider_write", "provider_recall", "delegate_task", "kanban_create"))
        manager = self.agent._memory_manager
        prepared = self.bridge.prepare(self.params | {"memory_scope_id": scope_id})
        self.assertIs(self.agent._memory_store, anchor._memory_store)
        self.assertIsNone(self.agent._memory_manager)
        self.assertEqual(self.agent._memory_store.format_for_system_prompt("memory"), "fixed memory before learning")
        self.assertIsNone(self.agent._cached_system_prompt)
        self.assertIsNone(self.agent._cached_system_prompt_static)
        self.assertEqual(prepared["policy"]["memoryMode"], "batch-snapshot")
        self.assertEqual(prepared["policy"]["memoryScopeId"], scope_id)
        self.assertFalse(prepared["policy"]["externalMemoryAllowed"])
        self.assertFalse(prepared["policy"]["memoryWriteAllowed"])
        self.assertNotIn("toolsAllowed", prepared["policy"])
        self.assertIn("fixed read-only snapshot shared by this learning batch", prepared["text"])
        self.assertNotIn("Memory may be read or updated", prepared["text"])
        self.assertIn("terminal", self.agent.valid_tool_names)
        self.assertIn("write_file", self.agent.valid_tool_names)
        for name in ("memory", "provider_write", "provider_recall", "delegate_task", "cronjob_manage", "message_agent", "kanban_create", "kanban_unblock"):
            self.agent.valid_tool_names.add(name)  # a late schema refresh cannot widen dispatch
            with self.subTest(name=name):
                self.assertEqual(json.loads(self.execute(name))["code"], "workbench_learning_memory_blocked")
                block, _ = self.executor._pre_tool_block(self.agent, SimpleNamespace(name=name, args={}))
                self.assertIn("do not permit memory writes", block)
                for args in ({"name": name, "arguments": {}}, {"calls": [{"name": name, "arguments": {}}]}, {"tool_name": name}):
                    value = self.tools.handle_function_call("tool_call", args, task_id="stored-session")
                    self.assertEqual(json.loads(value)["code"], "workbench_learning_memory_blocked")
        self.assertEqual(json.loads(self.tools.handle_function_call("memory", {}, task_id="stored-session"))["code"],
                         "workbench_learning_memory_blocked", "the native code ToolBridge passes task_id without session_id")
        self.assertEqual(json.loads(self.execute("terminal"))["called"], "terminal")
        self.assertEqual(json.loads(self.execute("write_file"))["called"], "write_file")
        for agent in (self.agent, control):
            agent._spawn_background_review([], review_memory=True, review_skills=True)
            agent._sync_external_memory_for_turn(original_user_message="PRIVATE_VALIDATION_INPUT", final_response="PRIVATE_VALIDATION_ANSWER", interrupted=False)
            agent.commit_memory_session([{"content": "PRIVATE_VALIDATION_ANSWER"}])
            agent.shutdown_memory_provider([{"content": "PRIVATE_VALIDATION_ANSWER"}])
            self.assertEqual(agent.review_calls, [])
        self.assertEqual(manager.calls, [("shutdown",)])
        self.assertEqual(control_manager.calls, [("shutdown",)])
        control._cached_system_prompt = "cached fixed scope prompt"
        self.bridge.learning_prepare({"session_id": "control", "memory_scope_id": scope_id})
        self.assertEqual(control._cached_system_prompt, "cached fixed scope prompt", "repeat preparation keeps the established prefix")

    def test_batch_scope_release_tombstones_unknown_ids_and_preserves_bound_policies_during_running_and_rebuild(self):
        scope_id, anchor, _ = self.capture_scope()
        self.bridge.prepare(self.params | {"memory_scope_id": scope_id})
        snapshot = self.agent._memory_store
        self.server.sessions["runtime-session"]["running"] = True
        expected = {"released": True, "memoryScopeId": scope_id}
        self.assertEqual(self.bridge.memory_release({"memory_scope_id": scope_id}), expected)
        self.assertEqual(self.bridge.memory_release({"memory_scope_id": scope_id}), expected)
        self.assertIs(self.agent._memory_store, snapshot)
        self.assertEqual(json.loads(self.execute("memory"))["code"], "workbench_learning_memory_blocked")
        fresh = self.new_session("late-sample")
        self.assertEqual(self.bridge.prepare_rpc(40, self.params | {"session_id": "late-sample", "run_id": str(uuid.uuid4()),
                                                                 "memory_scope_id": scope_id})["error"]["code"], 4091)
        self.assertEqual(self.bridge.learning_prepare_rpc(41, {"session_id": "late-sample", "memory_scope_id": scope_id})["error"]["code"], 4094)
        self.assertFalse(fresh.skip_background_review)
        rebuilt = FakeAgent()
        rebuilt._user_turn_count = 3
        rebuilt._memory_store.blocks["memory"] = "new live memory after release"
        self.server._wire_session_agent("rebuilt-sample", "stored-session", rebuilt)
        self.assertIs(rebuilt._memory_store, snapshot)
        self.assertIn("terminal", rebuilt.valid_tool_names)
        self.assertNotIn("memory", rebuilt.valid_tool_names)
        self.assertIsNone(rebuilt._cached_system_prompt)
        self.assertEqual(json.loads(self.execute("memory", session="rebuilt-sample"))["code"], "workbench_learning_memory_blocked")
        released_early = str(uuid.uuid4())
        self.bridge.memory_release({"memory_scope_id": released_early})
        self.assertEqual(self.bridge.memory_capture_rpc(42, {"session_id": "late-sample", "memory_scope_id": released_early})["error"]["code"], 4095)
        self.assertEqual(self.bridge.memory_capture_rpc(42, {"session_id": "anchor", "memory_scope_id": scope_id})["error"]["code"], 4095)

    def test_batch_scope_rotation_propagates_and_does_not_change_ordinary_skill_memory(self):
        scope_id, anchor, _ = self.capture_scope()
        self.bridge.prepare(self.params | {"memory_scope_id": scope_id})
        self.agent.session_id = "rotated-batch-session"
        self.executor._pre_tool_block(self.agent, SimpleNamespace(name="terminal", args={}))
        self.assertEqual(json.loads(self.execute("memory", session="rotated-batch-session"))["code"], "workbench_learning_memory_blocked")
        rebuilt = FakeAgent()
        self.server._wire_session_agent("rotated-new-runtime", "rotated-batch-session", rebuilt)
        self.assertIs(rebuilt._memory_store, anchor._memory_store)
        ordinary = self.new_session("ordinary-skill")
        original_store, original_manager = ordinary._memory_store, ordinary._memory_manager
        ordinary_params = self.params | {"session_id": "ordinary-skill", "run_id": str(uuid.uuid4())}
        result = self.bridge.prepare(ordinary_params)
        self.assertEqual(result["policy"], {"skillMutationBlocked": True, "memoryAllowed": True, "freeze": "bundle-copy"})
        self.assertIs(ordinary._memory_store, original_store)
        self.assertIs(ordinary._memory_manager, original_manager)
        self.assertFalse(ordinary.skip_background_review)
        self.assertEqual(json.loads(self.execute("memory", session="stored-ordinary-skill"))["called"], "memory")

    def test_native_agent_rebuild_can_finish_while_an_rpc_holds_the_policy_lock_waiting_for_it(self):
        scope_id, anchor, _ = self.capture_scope()
        self.bridge.prepare(self.params | {"memory_scope_id": scope_id})
        rebuilt, done, failures = FakeAgent(), threading.Event(), []

        def wire():
            try:
                self.server._wire_session_agent("runtime-rebuilt", "stored-session", rebuilt)
            except BaseException as error:
                failures.append(error)
            finally:
                done.set()

        worker = threading.Thread(target=wire, daemon=True)
        with self.bridge.lock:  # _sess blocks on native agent_ready inside this RPC lock
            worker.start()
            finished_before_unlock = done.wait(timeout=1)
        worker.join(timeout=2)
        self.assertTrue(finished_before_unlock, "native wiring must not wait on the RPC lock held by _sess")
        self.assertEqual(failures, [])
        self.assertIs(rebuilt._memory_store, anchor._memory_store)

    def test_batch_unknown_scope_restart_switch_and_invalid_payloads_fail_before_live_memory_or_skill_loading(self):
        for bad in ({"session_id": "runtime-session", "memory_scope_id": "../not-uuid"},
                    {"session_id": "runtime-session", "memory_scope_id": str(uuid.uuid4()), "extra": True}):
            self.assertEqual(self.bridge.memory_capture_rpc(43, bad)["error"]["code"], 4095)
        self.server.sessions["runtime-session"]["running"] = True
        self.assertEqual(self.bridge.memory_capture_rpc(43, {"session_id": "runtime-session", "memory_scope_id": str(uuid.uuid4())})["error"]["code"], 4095)
        self.server.sessions["runtime-session"]["running"] = False
        unknown = str(uuid.uuid4())
        with patch.object(self.skills, "get_skill_commands", side_effect=AssertionError("unknown scope must fail before loading Skill")):
            self.assertEqual(self.bridge.prepare_rpc(44, self.params | {"memory_scope_id": unknown})["error"]["code"], 4091)
        self.assertFalse(self.agent.skip_background_review)
        self.assertFalse(self.workspace.joinpath(".workbench-skills").exists())
        scope_id, anchor, _ = self.capture_scope()
        self.bridge.prepare(self.params | {"memory_scope_id": scope_id})
        self.bridge.finish({"session_id": "runtime-session", "run_id": self.params["run_id"]})
        another = str(uuid.uuid4())
        self.new_session("second-anchor")
        self.bridge.memory_capture({"session_id": "second-anchor", "memory_scope_id": another})
        for update in ({"memory_scope_id": another}, {}):
            params = self.params | {"run_id": str(uuid.uuid4())} | update
            with self.assertRaisesRegex(gateway.WorkflowPolicyError, "cannot change or remove"):
                self.bridge.prepare(params)
        new_tools, new_executor, _ = fake_tool_modules()
        restarted = gateway.WorkflowGateway(FakeServer(self.workspace, FakeAgent()), self.skills, new_tools, new_executor,
                                            workspace_root=self.workspace.parent).install()
        self.assertEqual(restarted.learning_prepare_rpc(45, {"session_id": "runtime-session", "memory_scope_id": scope_id})["error"]["code"], 4094)
        self.assertEqual(self.bridge.memory_release_rpc(46, {"memory_scope_id": "invalid"})["error"]["code"], 4096)

    def test_persisted_scope_restores_original_prompt_blocks_without_reading_new_live_memory(self):
        anchor = self.new_session("anchor", "ORIGINAL_BEFORE_TRAINING")
        scope_id = str(uuid.uuid4())
        result = self.bridge.memory_capture({"session_id": "anchor", "memory_scope_id": scope_id, "persist": True})
        descriptor = result["snapshot"]
        self.assertNotIn("ORIGINAL_BEFORE_TRAINING", json.dumps(result))
        path = self.workspace.parent / ".workbench-learning-memory" / (scope_id + ".json")
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
        new_agent = FakeAgent(); new_agent._memory_store.blocks["memory"] = "PRIVATE_VALIDATION_MUST_NOT_ENTER"
        tools, executor, _ = fake_tool_modules()
        restarted = gateway.WorkflowGateway(FakeServer(self.workspace, new_agent), self.skills, tools, executor,
                                            workspace_root=self.workspace.parent).install()
        with patch.object(new_agent._memory_store, "format_for_system_prompt", side_effect=AssertionError("restore must not read live memory")):
            restored = restarted.memory_restore({"snapshot": descriptor})
            restarted.learning_prepare({"session_id": "runtime-session", "memory_scope_id": scope_id})
        self.assertEqual(restored["snapshot"], descriptor)
        self.assertEqual(new_agent._memory_store.format_for_system_prompt("memory"), "ORIGINAL_BEFORE_TRAINING")
        new_agent._memory_store.load_from_disk()
        self.assertEqual(new_agent._memory_store.format_for_system_prompt("memory"), "ORIGINAL_BEFORE_TRAINING")
        self.assertIsNone(new_agent._memory_manager)
        self.assertEqual(json.loads(tools.handle_function_call("memory", {}, session_id="stored-session"))["code"], "workbench_learning_tools_blocked")
        self.assertNotIn("PRIVATE_VALIDATION_MUST_NOT_ENTER", path.read_text())

    def test_missing_tampered_and_released_persisted_scopes_never_fall_back_to_live_memory(self):
        self.new_session("anchor", "fixed memory")
        scope_id = str(uuid.uuid4())
        descriptor = self.bridge.memory_capture({"session_id": "anchor", "memory_scope_id": scope_id, "persist": True})["snapshot"]
        path = self.workspace.parent / ".workbench-learning-memory" / (scope_id + ".json")
        original = path.read_bytes(); path.write_bytes(original + b" ")
        with self.assertRaises(gateway.WorkflowPolicyError): self.bridge.memory_restore({"snapshot": descriptor})
        path.unlink()
        with self.assertRaises(gateway.WorkflowPolicyError): self.bridge.memory_restore({"snapshot": descriptor})
        path.write_bytes(original)
        self.bridge.memory_release({"memory_scope_id": scope_id})
        self.assertNotIn("fixed memory", path.read_text())
        tools, executor, _ = fake_tool_modules()
        restarted = gateway.WorkflowGateway(FakeServer(self.workspace, FakeAgent()), self.skills, tools, executor,
                                            workspace_root=self.workspace.parent).install()
        with self.assertRaises(gateway.WorkflowPolicyError): restarted.memory_restore({"snapshot": descriptor})

    def test_recapture_cannot_replace_a_previous_gateway_snapshot_with_current_memory(self):
        self.new_session("anchor", "original memory")
        scope_id = str(uuid.uuid4())
        descriptor = self.bridge.memory_capture({"session_id": "anchor", "memory_scope_id": scope_id, "persist": True})["snapshot"]
        path = self.workspace.parent / ".workbench-learning-memory" / (scope_id + ".json")
        original = path.read_bytes()
        tools, executor, _ = fake_tool_modules()
        restarted = gateway.WorkflowGateway(FakeServer(self.workspace, FakeAgent()), self.skills, tools, executor,
                                            workspace_root=self.workspace.parent).install()
        with self.assertRaises((OSError, gateway.WorkflowPolicyError)):
            restarted.memory_capture({"session_id": "runtime-session", "memory_scope_id": scope_id, "persist": True})
        self.assertEqual(path.read_bytes(), original)
        self.assertEqual(restarted.memory_restore({"snapshot": descriptor})["snapshot"], descriptor)

    def test_scope_survives_real_gateway_process_exit_and_restart_with_different_live_memory(self):
        scope_id = str(uuid.uuid4())
        script = '''import importlib.util,json,sys
from pathlib import Path
p=json.load(sys.stdin)
s=importlib.util.spec_from_file_location("gateway_test_fixtures",p["fixtures"])
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
agent=m.FakeAgent();agent._memory_store.blocks["memory"]=p["live"]
tools,executor,_=m.fake_tool_modules()
b=m.gateway.WorkflowGateway(m.FakeServer(Path(p["workspace"]),agent),m.fake_skills(Path(p["source"])),tools,executor,workspace_root=Path(p["root"])).install()
if p["operation"]=="capture": r=b.memory_capture({"session_id":"runtime-session","memory_scope_id":p["id"],"persist":True})
else:
 r=b.memory_restore({"snapshot":p["snapshot"]})
 b.learning_prepare({"session_id":"runtime-session","memory_scope_id":p["id"]})
r["observed"]=agent._memory_store.format_for_system_prompt("memory")
print(json.dumps(r))
'''
        common = {"fixtures": str(Path(__file__).resolve()), "workspace": str(self.workspace), "source": str(self.source),
                  "root": str(self.workspace.parent), "id": scope_id}
        def invoke(value):
            result = subprocess.run([sys.executable, "-B", "-c", script], input=json.dumps(common | value),
                                    text=True, capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        captured = invoke({"operation": "capture", "live": "MEMORY_BEFORE_ALL_SAMPLES"})
        restored = invoke({"operation": "restore", "live": "LIVE_MEMORY_AFTER_PRIVATE_VALIDATION", "snapshot": captured["snapshot"]})
        self.assertEqual(restored["observed"], "MEMORY_BEFORE_ALL_SAMPLES")
        self.assertEqual(restored["snapshot"], captured["snapshot"])


if __name__ == "__main__":
    unittest.main()
