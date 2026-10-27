"""Historical metadata tests use only isolated SQLite fixtures and stdlib."""

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


usage_history = load("workbench_usage_history", "usage_history.py")
gateway = load("usage_history_gateway", "workflow_gateway.py")


class UsageHistoryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "state.db"
        db = sqlite3.connect(self.path)
        db.executescript("""
            CREATE TABLE sessions(id TEXT PRIMARY KEY,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,api_call_count,
              started_at,ended_at,parent_session_id,end_reason,model_config,system_prompt);
            CREATE TABLE messages(session_id TEXT,timestamp,role TEXT,content TEXT,_compressed_summary INTEGER DEFAULT 0);
            CREATE TABLE session_model_usage(session_id TEXT,model TEXT,billing_provider TEXT,task TEXT,
              input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,api_call_count,billing_base_url TEXT);
        """)
        config = json.dumps({"api_key": "PRIVATE_CONFIG_SENTINEL", "_usage_anchor": {"prompt_tokens": 900,
                            "completion_tokens": 40, "base_prefix_fp": "PRIVATE_FINGERPRINT_SENTINEL"}})
        db.execute("INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                   ("owned-session", 100, 40, 800, 0, 10, 2, 1793062800, 1793062803, None, None, config, "PRIVATE_PROMPT_SENTINEL"))
        db.execute("INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                   ("zero-session", 0, 0, 0, 0, 0, 0, 1793062800, None, None, None, "{}", ""))
        db.executemany("INSERT INTO messages(session_id,timestamp,role,content) VALUES(?,?,?,?)",
                       [("owned-session", 1793062801, "user", "PRIVATE_USER_SENTINEL"),
                        ("owned-session", 1793062803, "assistant", "PRIVATE_ASSISTANT_SENTINEL")])
        db.executemany("INSERT INTO session_model_usage VALUES(?,?,?,?,?,?,?,?,?,?,?)", [
            ("owned-session", "fixture/model", "fixture", "", 100, 40, 800, 0, 10, 2, "https://PRIVATE_ENDPOINT_SENTINEL"),
            ("owned-session", "fixture/vision", "fixture", "vision", 30, 8, 0, 0, 0, 1, "https://PRIVATE_ENDPOINT_SENTINEL")])
        db.commit(); db.close()

    def readonly(self):
        db = sqlite3.connect(self.path.as_uri() + "?mode=ro", uri=True)
        self.addCleanup(db.close)
        return db

    def test_canonical_counts_and_auxiliary_usage_are_projected_without_double_counting(self):
        value = usage_history.read_usage_history(self.readonly(), ["owned-session"])["sessions"][0]
        self.assertTrue(value["found"]); self.assertTrue(value["tokensRecorded"])
        self.assertEqual(value["usage"], {"input": 100, "output": 40, "prompt": 900, "completion": 40,
                                         "total": 940, "calls": 2, "reasoning": 10, "cache_read": 800, "cache_write": 0})
        self.assertEqual(value["modelUsage"][0]["usage"]["total"], 940)
        self.assertEqual(value["modelUsage"][1]["task"], "vision")
        self.assertEqual(value["modelUsage"][1]["usage"]["total"], 38)
        self.assertNotIn("PRIVATE_", json.dumps(value)); self.assertNotIn("https://", json.dumps(value))

    def test_context_is_last_request_input_with_unknown_window_and_unknown_measurement_time(self):
        value = usage_history.read_usage_history(self.readonly(), ["owned-session"])["sessions"][0]
        self.assertEqual(value["context"], {"used": 900, "max": None, "percent": None, "estimated": False,
                         "historical": True, "kind": "last-request-input", "capturedAt": None,
                         "source": "hermes.persisted-usage-anchor"})
        self.assertEqual(value["firstMessageAt"], "2026-10-27T01:00:01.000Z")
        self.assertEqual(value["lastMessageAt"], "2026-10-27T01:00:03.000Z")
        self.assertEqual(value["userMessageCount"], 1)

    def test_no_usage_is_not_fabricated_as_a_measured_zero_and_missing_ids_remain_explicit(self):
        value = usage_history.read_usage_history(self.readonly(), ["zero-session", "missing-session", "zero-session"])
        self.assertEqual(value["schemaVersion"], 1); self.assertEqual(len(value["sessions"]), 2)
        zero, missing = value["sessions"]
        self.assertFalse(zero["tokensRecorded"]); self.assertIsNone(zero["context"])
        self.assertIsNone(zero["firstMessageAt"]); self.assertFalse(missing["found"])

    def test_invalid_or_out_of_range_counters_and_timestamps_remain_unknown(self):
        db = sqlite3.connect(self.path)
        db.execute("UPDATE sessions SET input_tokens=-1,output_tokens=1.5,started_at='not-time',ended_at=-1,api_call_count=9007199254740992 WHERE id='zero-session'")
        db.commit(); db.close()
        value = usage_history.read_usage_history(self.readonly(), ["zero-session"])["sessions"][0]
        self.assertIsNone(value["usage"]["input"]); self.assertIsNone(value["usage"]["output"])
        self.assertIsNone(value["usage"]["total"]); self.assertIsNone(value["usage"]["calls"])
        self.assertIsNone(value["startedAt"]); self.assertIsNone(value["endedAt"])

    def test_api_call_count_alone_does_not_prove_provider_token_usage_was_reported(self):
        db = sqlite3.connect(self.path)
        db.execute("UPDATE sessions SET api_call_count=3 WHERE id='zero-session'")
        db.commit(); db.close()
        value = usage_history.read_usage_history(self.readonly(), ["zero-session"])["sessions"][0]
        self.assertEqual(value["usage"]["calls"], 3)
        self.assertEqual(value["usage"]["total"], 0)
        self.assertFalse(value["tokensRecorded"])

    def test_request_shape_is_bounded_and_has_no_file_profile_or_live_runtime_escape(self):
        for params in ({}, {"stored_session_ids": []}, {"stored_session_ids": ["owned-session"] * 51},
                       {"stored_session_ids": ["../state.db"]}, {"stored_session_ids": ["/state.db"]},
                       {"stored_session_ids": ["owned-session"], "profile": "other"},
                       {"stored_session_ids": "owned-session"}, {"stored_session_ids": [None]}):
            with self.subTest(params=params), self.assertRaises(ValueError): usage_history.validate_request(params)
        self.assertEqual(usage_history.validate_request({"stored_session_ids": ["owned-session"] * 2}), ["owned-session"])

    def test_reading_is_repeatable_without_writes_or_content_projection(self):
        db = self.readonly(); statements = []; db.set_trace_callback(statements.append)
        before = db.total_changes; first = usage_history.read_usage_history(db, ["owned-session"])
        self.assertEqual(usage_history.read_usage_history(db, ["owned-session"]), first)
        self.assertEqual(db.total_changes, before)
        self.assertTrue(all(sql.startswith(("SELECT ", "PRAGMA ")) for sql in statements))
        self.assertFalse(any("SELECT content" in sql or "SELECT model_config" in sql or "system_prompt" in sql for sql in statements))
        with self.assertRaises(sqlite3.OperationalError): db.execute("UPDATE sessions SET api_call_count=0")

    def test_old_optional_columns_remain_unknown_but_missing_base_schema_fails_closed(self):
        minimal = sqlite3.connect(":memory:"); self.addCleanup(minimal.close)
        minimal.executescript("CREATE TABLE sessions(id TEXT);CREATE TABLE messages(session_id TEXT,timestamp);INSERT INTO sessions VALUES('old-session');")
        value = usage_history.read_usage_history(minimal, ["old-session"])["sessions"][0]
        self.assertIsNone(value["usage"]["total"]); self.assertFalse(value["tokensRecorded"])
        self.assertIsNone(value["hasChildren"]); self.assertIsNone(value["compressed"])
        self.assertEqual(value["modelUsage"], [])
        missing = sqlite3.connect(":memory:"); self.addCleanup(missing.close)
        with self.assertRaises(ValueError): usage_history.read_usage_history(missing, ["old-session"])

    def test_lineage_flags_and_invalid_anchors_cannot_be_confused_with_independent_runs(self):
        db = sqlite3.connect(self.path)
        db.execute("UPDATE sessions SET end_reason='compression' WHERE id='owned-session'")
        db.execute("UPDATE sessions SET parent_session_id='owned-session',model_config=? WHERE id='zero-session'", ('{"_usage_anchor":{"prompt_tokens":"unsafe"}}',))
        db.commit(); db.close()
        parent, child = usage_history.read_usage_history(self.readonly(), ["owned-session", "zero-session"])["sessions"]
        self.assertTrue(parent["compressed"]); self.assertTrue(parent["hasChildren"])
        self.assertEqual(child["parentId"], "owned-session"); self.assertIsNone(child["context"])

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

    def test_rpc_uses_the_fixed_native_readonly_store_and_closes_it_without_agent_or_account_calls(self):
        module, calls = self.native_module(); bridge = self.bridge()
        with patch.dict(sys.modules, {"hermes_state": module, "usage_history": usage_history}):
            result = bridge.usage_history_rpc(20, {"stored_session_ids": ["owned-session"]})
        self.assertTrue(result["result"]["sessions"][0]["found"])
        self.assertEqual(calls, [("open", self.path, True), ("close",)])

    def test_rpc_read_errors_close_the_handle_and_never_return_a_path_or_credentials(self):
        module, calls = self.native_module(fail=True); bridge = self.bridge()
        with patch.dict(sys.modules, {"hermes_state": module, "usage_history": usage_history}):
            result = bridge.usage_history_rpc(21, {"stored_session_ids": ["owned-session"]})
        self.assertEqual(result["error"]["code"], 4101); self.assertNotIn("PRIVATE_", json.dumps(result))
        self.assertEqual(calls[-1], ("close",))


if __name__ == "__main__":
    unittest.main()
