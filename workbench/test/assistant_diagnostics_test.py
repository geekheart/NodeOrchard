"""Metadata diagnostics use a fixed read-only Hermes fixture, never a live agent."""

import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch


def load(name, relative):
    path = Path(__file__).resolve().parents[1] / "python" / relative
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


usage_history = load("workbench_assistant_usage", "usage_history.py")
with patch.dict(sys.modules, {"usage_history": usage_history}):
    diagnostics = load("workbench_assistant_diagnostics", "assistant_diagnostics.py")
gateway = load("assistant_diagnostics_gateway", "workflow_gateway.py")


class AssistantDiagnosticsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(); self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "state.db"
        db = sqlite3.connect(self.path)
        db.executescript("""
            CREATE TABLE sessions(id TEXT PRIMARY KEY,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,
              api_call_count,started_at,ended_at,parent_session_id,end_reason,model_config,system_prompt);
            CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,timestamp,role TEXT,content TEXT,finish_reason TEXT,
              partial,_compressed_summary INTEGER DEFAULT 0,reasoning TEXT,display_metadata TEXT);
        """)
        config = json.dumps({"api_key": "PRIVATE_CONFIGURATION", "_usage_anchor": {"prompt_tokens": 120}})
        db.execute("INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                   ("owned-session", 100, 30, 20, 0, 5, 1, 1793062800, 1793062803, None, None, config, "PRIVATE_SYSTEM_PROMPT"))
        db.execute("INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                   ("partial-session", 0, 0, 0, 0, 0, 1, 1793062800, None, None, None, "{}", "PRIVATE_SYSTEM_PROMPT"))
        db.executemany("INSERT INTO messages(session_id,timestamp,role,content,finish_reason,partial,reasoning,display_metadata) VALUES(?,?,?,?,?,?,?,?)", [
            ("owned-session", 1793062801, "user", "PRIVATE_PROMPT_ONE", None, None, "PRIVATE_REASONING", "PRIVATE_DISPLAY"),
            ("owned-session", 1793062802, "assistant", "PRIVATE_OLD_OUTPUT", "length", 1, "PRIVATE_REASONING", "PRIVATE_DISPLAY"),
            ("owned-session", 1793062802.5, "tool", "PRIVATE_TOOL_OUTPUT", None, None, "PRIVATE_REASONING", "PRIVATE_DISPLAY"),
            ("owned-session", 1793062803, "assistant", "PRIVATE_FINAL_OUTPUT", "stop", 0, "PRIVATE_REASONING", "PRIVATE_DISPLAY"),
            ("partial-session", 1793062802, "user", "PRIVATE_PROMPT_TWO", None, None, "PRIVATE_REASONING", "PRIVATE_DISPLAY"),
            ("partial-session", 1793062803, "assistant", "PRIVATE_PARTIAL_OUTPUT", None, None, "PRIVATE_REASONING", "PRIVATE_DISPLAY"),
        ])
        db.commit(); db.close()

    def readonly(self):
        db = sqlite3.connect(self.path.as_uri() + "?mode=ro", uri=True)
        self.addCleanup(db.close); return db

    def test_projection_counts_only_user_assistant_content_and_returns_canonical_usage(self):
        value = diagnostics.read_assistant_diagnostics(self.readonly(), ["owned-session"])["sessions"][0]
        self.assertEqual(value["storedSessionId"], "owned-session")
        self.assertEqual(value["promptCharacters"], len("PRIVATE_PROMPT_ONE"))
        self.assertEqual(value["outputCharacters"], len("PRIVATE_OLD_OUTPUT") + len("PRIVATE_FINAL_OUTPUT"))
        self.assertEqual(value["userMessageCount"], 1)
        self.assertEqual(value["assistantMessageCount"], 2)
        self.assertEqual(value["lastAssistantAt"], "2026-10-27T01:00:03.000Z")
        self.assertEqual(value["finishReason"], "stop")
        self.assertTrue(value["complete"]); self.assertFalse(value["partial"])
        self.assertEqual(value["usage"]["total"], 150)
        self.assertTrue(value["tokensRecorded"])
        self.assertNotIn("PRIVATE_", json.dumps(value))
        self.assertEqual(set(value), {"storedSessionId", "found", "promptCharacters", "outputCharacters", "userMessageCount", "assistantMessageCount",
                                     "lastAssistantAt", "finishReason", "complete", "partial", "usage", "tokensRecorded", "source"})

    def test_missing_finish_reason_remains_unknown_even_with_an_output_and_api_calls(self):
        value = diagnostics.read_assistant_diagnostics(self.readonly(), ["partial-session"])["sessions"][0]
        self.assertGreater(value["outputCharacters"], 0)
        self.assertIsNone(value["finishReason"]); self.assertIsNone(value["complete"]); self.assertIsNone(value["partial"])
        self.assertFalse(value["tokensRecorded"])
        self.assertEqual(value["usage"]["calls"], 1)

    def test_finish_labels_are_whitelisted_and_explicit_partial_is_not_claimed_complete(self):
        for reason, partial, expected_reason, complete, expected_partial in [
            ("length", None, "length", False, True), ("interrupted", None, "interrupted", False, True),
            ("end_turn", None, "end_turn", True, False), ("tool_calls", None, "tool_calls", True, False),
            ("stop", 1, "stop", False, True), ("PRIVATE_TOKEN_SENTINEL", None, None, None, None),
            (None, 0, None, None, False), (None, 1, None, False, True),
        ]:
            with self.subTest(reason=reason, partial=partial):
                db = sqlite3.connect(self.path)
                db.execute("UPDATE messages SET finish_reason=?,partial=? WHERE session_id='partial-session' AND role='assistant'", (reason, partial))
                db.commit(); db.close()
                value = diagnostics.read_assistant_diagnostics(self.readonly(), ["partial-session"])["sessions"][0]
                self.assertEqual((value["finishReason"], value["complete"], value["partial"]), (expected_reason, complete, expected_partial))
                self.assertNotIn("PRIVATE_", json.dumps(value))

    def test_request_requires_one_to_twelve_ids_without_profile_paths_queries_or_accessors(self):
        for params in ({}, {"stored_session_ids": []}, {"stored_session_ids": ["owned-session"] * 13},
                       {"stored_session_ids": ["owned-session"], "path": "/state.db"},
                       {"stored_session_ids": ["owned-session"], "query": "SELECT content FROM messages"},
                       {"stored_session_ids": ["owned-session"], "profile": "another"},
                       {"stored_session_ids": ["../state.db"]}, {"stored_session_ids": ["/state.db"]},
                       {"stored_session_ids": [None]}, {"stored_session_ids": "owned-session"}):
            with self.subTest(params=params), self.assertRaises(ValueError): diagnostics.validate_request(params)
        self.assertEqual(diagnostics.validate_request({"stored_session_ids": ["owned-session"] * 2}), ["owned-session"])

    def test_read_queries_never_materialize_transcripts_configuration_or_reasoning(self):
        db = self.readonly(); queries = []; db.set_trace_callback(queries.append)
        before = db.total_changes
        first = diagnostics.read_assistant_diagnostics(db, ["owned-session", "partial-session"])
        self.assertEqual(diagnostics.read_assistant_diagnostics(db, ["owned-session", "partial-session"]), first)
        self.assertEqual(db.total_changes, before)
        self.assertTrue(all(query.startswith(("SELECT ", "PRAGMA ")) for query in queries))
        self.assertTrue(any("length(content)" in query for query in queries))
        self.assertFalse(any("SELECT content" in query or "SELECT model_config" in query or "reasoning_content" in query
                             or "display_metadata" in query or "system_prompt" in query for query in queries))
        with self.assertRaises(sqlite3.OperationalError): db.execute("DELETE FROM sessions")

    def test_optional_old_columns_and_missing_sessions_remain_explicit(self):
        minimal = sqlite3.connect(":memory:"); self.addCleanup(minimal.close)
        minimal.executescript("CREATE TABLE sessions(id TEXT);CREATE TABLE messages(session_id TEXT,timestamp,role,content);INSERT INTO sessions VALUES('old-session');")
        value, missing = diagnostics.read_assistant_diagnostics(minimal, ["old-session", "missing-session"])["sessions"]
        self.assertEqual(value["promptCharacters"], 0); self.assertEqual(value["outputCharacters"], 0)
        self.assertIsNone(value["finishReason"]); self.assertIsNone(value["complete"]); self.assertIsNone(value["partial"])
        self.assertIsNone(value["lastAssistantAt"]); self.assertFalse(value["tokensRecorded"])
        self.assertFalse(missing["found"])
        broken = sqlite3.connect(":memory:"); self.addCleanup(broken.close)
        broken.executescript("CREATE TABLE sessions(id TEXT);CREATE TABLE messages(session_id TEXT,timestamp);")
        with self.assertRaises(ValueError): diagnostics.read_assistant_diagnostics(broken, ["old-session"])

    def native_module(self, fail=False):
        calls, path = [], self.path
        class Native:
            def __init__(self, db_path=None, read_only=False):
                calls.append(("open", db_path, read_only)); self.read_only = read_only
                self.connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True); self.connection.row_factory = sqlite3.Row
            def _read_all(self, sql, params=()):
                if fail: raise sqlite3.OperationalError("PRIVATE_PATH_SENTINEL")
                return self.connection.execute(sql, params).fetchall()
            def close(self): calls.append(("close",)); self.connection.close()
        module = ModuleType("hermes_state"); module.SessionDB = Native
        return module, calls

    def bridge(self):
        bridge = gateway.WorkflowGateway.__new__(gateway.WorkflowGateway)
        bridge.server = SimpleNamespace(_launch_state_db_path=lambda: self.path,
            _ok=lambda rid, value: {"id": rid, "result": value}, _err=lambda rid, code, message: {"id": rid, "error": {"code": code, "message": message}})
        return bridge

    def test_rpc_uses_only_fixed_native_readonly_store_and_closes_it(self):
        module, calls = self.native_module(); bridge = self.bridge()
        with patch.dict(sys.modules, {"hermes_state": module, "assistant_diagnostics": diagnostics}):
            value = bridge.assistant_diagnostics_rpc(30, {"stored_session_ids": ["owned-session"]})
        self.assertTrue(value["result"]["sessions"][0]["found"])
        self.assertEqual(calls, [("open", self.path, True), ("close",)])

    def test_rpc_errors_never_return_private_errors_and_always_close_handle(self):
        module, calls = self.native_module(fail=True); bridge = self.bridge()
        with patch.dict(sys.modules, {"hermes_state": module, "assistant_diagnostics": diagnostics}):
            value = bridge.assistant_diagnostics_rpc(31, {"stored_session_ids": ["owned-session"]})
        self.assertEqual(value["error"]["code"], 4102)
        self.assertNotIn("PRIVATE_", json.dumps(value)); self.assertEqual(calls[-1], ("close",))

    def test_rpc_invalid_request_is_refused_before_opening_store(self):
        module, calls = self.native_module(); bridge = self.bridge()
        with patch.dict(sys.modules, {"hermes_state": module, "assistant_diagnostics": diagnostics}):
            value = bridge.assistant_diagnostics_rpc(32, {"stored_session_ids": ["owned-session"], "path": "/other"})
        self.assertIn("error", value); self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
