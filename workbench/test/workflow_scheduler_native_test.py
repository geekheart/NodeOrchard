"""Exercise installed Hermes cron functions with isolated files and no model."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from datetime import datetime, timezone, timedelta
from unittest.mock import patch
from uuid import uuid4
from zoneinfo import ZoneInfo

path = Path(__file__).parents[1] / "python" / "workflow_scheduler.py"
spec = importlib.util.spec_from_file_location("nodeorchard_workflow_scheduler", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class NativeSchedulerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="nodeorchard-native-cron-")
        self.root = Path(self.directory.name).resolve()
        self.environment = patch.dict(os.environ, {"HERMES_HOME": str(self.root), "HERMES_DISABLE_LAZY_INSTALLS": "1"})
        self.environment.start()
        self.events = []
        self.scheduler = module.NativeWorkflowScheduler(self.root, self.events.append)
        self.now = datetime(2026, 11, 1, 0, 0, tzinfo=timezone.utc)
        clock = lambda: self.now.astimezone(ZoneInfo(os.environ.get("HERMES_TIMEZONE", "UTC")))
        self.patches = [patch.object(self.scheduler.jobs, "_hermes_now", clock), patch.object(self.scheduler.executions, "_hermes_now", clock)]
        for item in self.patches:
            item.start()

    def tearDown(self):
        self.scheduler.close()
        for item in reversed(self.patches):
            item.stop()
        self.environment.stop()
        self.directory.cleanup()

    def once(self):
        return {"id": str(uuid4()), "name": "isolated native timer", "key": "a" * 64,
            "timing": {"kind": "once", "localDateTime": "2026-11-01T08:01", "timezone": "Asia/Shanghai"},
            "enabled": True, "nextRunAt": "2026-11-01T00:01:00+00:00"}

    def test_real_native_due_claim_and_execution_ledger_no_model(self):
        definition = self.once()
        result = self.scheduler.sync([definition])
        self.assertEqual(result["engine"], "hermes-native")
        self.assertEqual(self.scheduler.tick()["fired"], 0)
        self.now += timedelta(minutes=1)
        self.assertEqual(self.scheduler.tick()["fired"], 1)
        fire = self.events[0]["value"]
        self.assertEqual(self.scheduler.tick()["fired"], 0)
        self.scheduler.finish({"executionId": fire["executionId"], "status": "started", "runId": "isolated-run"})
        with self.scheduler.scope("Asia/Shanghai"):
            execution = self.scheduler.executions.get_execution(fire["executionId"])
            job = self.scheduler.jobs.get_job(fire["jobId"])
            self.assertEqual(execution["status"], "completed")
            self.assertEqual(execution["delivery_outcome"], "workflow-admitted")
            self.assertEqual(job["repeat"]["completed"], 1)
            self.assertEqual(job["state"], "completed")
        self.assertEqual(self.scheduler.tick()["fired"], 0)

    def test_daily_uses_native_cron_and_per_task_timezone(self):
        definition = self.once()
        definition.update(timing={"kind": "daily", "time": "09:00", "timezone": "Asia/Shanghai"}, nextRunAt="2026-11-01T01:00:00+00:00")
        self.scheduler.sync([definition])
        self.now += timedelta(hours=1)
        self.assertEqual(self.scheduler.tick()["fired"], 1)
        fire = self.events[0]["value"]
        self.assertEqual(datetime.fromisoformat(fire["nextRunAt"]), datetime(2026, 11, 2, 1, tzinfo=timezone.utc))
        with self.scheduler.scope("Asia/Shanghai"):
            self.assertEqual(self.scheduler.jobs.get_job(fire["jobId"])["schedule"], {"kind": "cron", "expr": "0 9 * * *", "display": "0 9 * * *"})
        self.scheduler.finish({"executionId": fire["executionId"], "status": "started"})

    def test_pause_removes_native_registration_and_does_not_fire(self):
        definition = self.once()
        self.scheduler.sync([definition]); definition["enabled"] = False; definition["key"] = "b" * 64
        self.scheduler.sync([definition]); self.now += timedelta(minutes=1)
        self.assertEqual(self.scheduler.tick()["fired"], 0)

    def test_native_daily_keeps_existing_dst_gap_and_first_fold_policy(self):
        definition = self.once()
        definition.update(timing={"kind": "daily", "time": "02:30", "timezone": "America/New_York"}, nextRunAt="2026-03-07T07:30:00+00:00")
        self.now = datetime(2026, 3, 7, 7, 29, tzinfo=timezone.utc)
        self.scheduler.sync([definition]); self.now += timedelta(minutes=1)
        self.scheduler.tick(); fire = self.events[-1]["value"]
        self.assertEqual(datetime.fromisoformat(fire["nextRunAt"]), datetime(2026, 3, 9, 6, 30, tzinfo=timezone.utc))
        self.scheduler.finish({"executionId": fire["executionId"], "status": "started"})
        with self.scheduler.scope("America/New_York"):
            self.assertEqual(datetime.fromisoformat(self.scheduler.jobs.get_job(fire["jobId"])["next_run_at"]), datetime(2026, 3, 9, 6, 30, tzinfo=timezone.utc))

    def test_unknown_ack_is_rejected_without_another_attempt(self):
        self.scheduler.sync([self.once()])
        with self.assertRaisesRegex(ValueError, "stale"):
            self.scheduler.finish({"executionId": "not-an-execution", "status": "started"})
        self.assertEqual(self.scheduler.tick()["fired"], 0)

    def test_invalid_config_does_not_install_or_execute(self):
        for timing in ({"kind": "interval", "minutes": 1, "timezone": "UTC"},
                       {"kind": "daily", "time": "09:00", "timezone": "Bad/Zone"},
                       {"kind": "once", "localDateTime": "2026-03-08T02:30", "timezone": "America/New_York"}):
            value = self.once(); value["timing"] = timing
            with self.assertRaises((ValueError, KeyError)):
                self.scheduler.sync([value])
        self.assertEqual(self.events, [])


if __name__ == "__main__":
    unittest.main()
