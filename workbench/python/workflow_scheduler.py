"""Hermes-native due jobs and durable claims, dispatching typed workflow receipts.

This process has no model credentials or workflow documents. Hermes owns its cron
store/calculation/claim ledger; the host retains workflow admission and review.
"""
from __future__ import annotations

from contextlib import contextmanager, redirect_stdout
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import select
import sys
import time
from zoneinfo import ZoneInfo

PROTOCOL_OUT = sys.stdout
UUID = re.compile(r"^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$")
KEY = re.compile(r"^[a-f0-9]{64}$")


def emit(value):
    PROTOCOL_OUT.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    PROTOCOL_OUT.flush()


def write_json(path, value):
    temp = path.with_name(path.name + ".new")
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(temp, flags, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as target:
        json.dump(value, target, ensure_ascii=False)
        target.flush()
        os.fsync(target.fileno())
    os.replace(temp, path)


class NativeWorkflowScheduler:
    def __init__(self, root, notify=emit):
        self.root = Path(root).absolute()
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.root.is_symlink() or self.root.resolve() != self.root:
            raise ValueError("Scheduler directory must be a real private directory")
        self.notify = notify
        self.definitions = {}
        self.pending = {}
        self.pending_file = self.root / "admissions.json"
        if self.pending_file.exists():
            if self.pending_file.is_symlink() or self.pending_file.stat().st_size > 1024 * 1024:
                raise ValueError("Scheduler admission record is invalid")
            self.recovery = json.loads(self.pending_file.read_text())
        else:
            self.recovery = {}
        if not isinstance(self.recovery, dict):
            raise ValueError("Scheduler admission record is invalid")
        with redirect_stdout(sys.stderr):
            from cron import jobs, executions
        self.jobs, self.executions = jobs, executions

    @contextmanager
    def scope(self, zone):
        ZoneInfo(zone)
        home = self.root / "zones" / hashlib.sha256(zone.encode()).hexdigest()[:24]
        home.mkdir(mode=0o700, parents=True, exist_ok=True)
        if home.is_symlink() or home.resolve() != home:
            raise ValueError("Scheduler profile identity is invalid")
        config = home / "config.yaml"
        if config.is_symlink():
            raise ValueError("Scheduler config identity is invalid")
        if not config.exists():
            write_json(config, {"timezone": zone, "cron": {"catch_up_missed": False}})
        previous = {key: os.environ.get(key) for key in ("HERMES_HOME", "HERMES_TIMEZONE")}
        os.environ["HERMES_HOME"], os.environ["HERMES_TIMEZONE"] = str(home), zone
        try:
            with self.jobs.use_cron_store(home), redirect_stdout(sys.stderr):
                yield
        finally:
            for key, value in previous.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

    def definition(self, raw):
        if not isinstance(raw, dict) or set(raw) != {"id", "name", "key", "timing", "enabled", "nextRunAt"}:
            raise ValueError("Invalid workflow timer definition")
        if not UUID.fullmatch(raw["id"]) or not KEY.fullmatch(raw["key"]):
            raise ValueError("Invalid workflow timer identity")
        if not isinstance(raw["name"], str) or not 1 <= len(raw["name"]) <= 120 or type(raw["enabled"]) is not bool:
            raise ValueError("Invalid workflow timer label or lifecycle")
        timing = raw["timing"]
        if not isinstance(timing, dict) or timing.get("kind") not in ("once", "daily"):
            raise ValueError("Only existing once/daily workflow timers are supported")
        ZoneInfo(timing.get("timezone", ""))
        if timing["kind"] == "once":
            if set(timing) != {"kind", "localDateTime", "timezone"}:
                raise ValueError("Invalid one-shot timer")
            local = datetime.strptime(timing["localDateTime"], "%Y-%m-%dT%H:%M")
            aware = local.replace(tzinfo=ZoneInfo(timing["timezone"]), fold=0)
            if aware.astimezone(timezone.utc).astimezone(aware.tzinfo).replace(tzinfo=None) != local:
                raise ValueError("Nonexistent local timer instant")
            spec = aware.isoformat()
        else:
            if set(timing) != {"kind", "time", "timezone"} or not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", timing.get("time", "")):
                raise ValueError("Invalid daily timer")
            hour, minute = map(int, timing["time"].split(":"))
            spec = f"{minute} {hour} * * *"
        if raw["nextRunAt"] is not None:
            instant = datetime.fromisoformat(raw["nextRunAt"].replace("Z", "+00:00"))
            if instant.tzinfo is None:
                raise ValueError("Timer instant must have an offset")
        return dict(raw, spec=spec)

    def normalize_next(self, job, definition):
        """Keep the existing skip-gap/first-fold policy atop native cron math."""
        value = job.get("next_run_at")
        if definition["timing"]["kind"] != "daily" or not value:
            return job
        zone = ZoneInfo(definition["timing"]["timezone"])
        for _ in range(370):
            candidate = datetime.fromisoformat(value)
            wall = candidate.astimezone(zone)
            if wall.strftime("%H:%M") == definition["timing"]["time"] and not wall.fold:
                if value != job.get("next_run_at"):
                    return self.jobs.update_job(job["id"], {"next_run_at": value})
                return job
            value = self.jobs.compute_next_run(job["schedule"], wall.isoformat())
            if not value:
                raise ValueError("Native cron could not calculate the next local occurrence")
        raise ValueError("Native cron could not find a valid local occurrence")

    def sync(self, raws):
        if not isinstance(raws, list) or len(raws) > 100:
            raise ValueError("Too many workflow timers")
        definitions = [self.definition(raw) for raw in raws]
        if len({row["id"] for row in definitions}) != len(definitions):
            raise ValueError("Duplicate workflow timer")
        zones = {row["timing"]["timezone"] for row in definitions}
        zones.update(row["timing"]["timezone"] for row in self.definitions.values())
        zones.update(row["zone"] for row in self.recovery.values())
        for zone in zones:
            with self.scope(zone):
                self.executions.recover_interrupted_executions()
                for execution_id, old in list(self.recovery.items()):
                    if old["zone"] != zone:
                        continue
                    self.jobs.mark_job_run(old["jobId"], False,
                        "Workflow trigger interrupted before acknowledgement; not replayed.",
                        status="interrupted", expected_fire_owner=old["owner"])
                    self.recovery.pop(execution_id)
                existing = self.jobs.load_jobs()
                wanted = {row["id"]: row for row in definitions if row["timing"]["timezone"] == zone and row["enabled"]}
                for job in existing:
                    origin = job.get("origin") or {}
                    if origin.get("platform") != "nodeorchard-workflow":
                        raise ValueError("Unexpected job in dedicated scheduler store")
                    row = wanted.get(origin.get("chat_id"))
                    if row is None or origin.get("definition_key") != row["key"]:
                        self.jobs.remove_job(job["id"])
                existing = self.jobs.load_jobs()
                for row in wanted.values():
                    matching = next((job for job in existing if (job.get("origin") or {}).get("chat_id") == row["id"]), None)
                    if matching:
                        continue
                    job = self.jobs.create_job(prompt="Dispatch the bound NodeOrchard workflow snapshot.",
                        schedule=row["spec"], name=row["name"], deliver="local",
                        origin={"platform": "nodeorchard-workflow", "chat_id": row["id"], "definition_key": row["key"]})
                    # Frozen host timing pins the first occurrence during migration;
                    # subsequent times are calculated by Hermes cron itself.
                    if row["nextRunAt"]:
                        native_instant = datetime.fromisoformat(row["nextRunAt"].replace("Z", "+00:00")).astimezone(ZoneInfo(zone)).isoformat()
                        job = self.jobs.update_job(job["id"], {"next_run_at": native_instant})
                    self.normalize_next(job, row)
        self.definitions = {row["id"]: row for row in definitions}
        write_json(self.pending_file, self.pending)
        return {"engine": "hermes-native", "registered": sum(row["enabled"] for row in definitions)}

    def tick(self):
        zones = sorted({row["timing"]["timezone"] for row in self.definitions.values() if row["enabled"]})
        delivered = 0
        for zone in zones:
            with self.scope(zone):
                before = {job["id"]: job for job in self.jobs.load_jobs()}
                due = self.jobs.get_due_jobs()
                pending_jobs = {row["jobId"] for row in self.pending.values()}
                claimed_ids = set()
                for due_job in due:
                    if due_job["id"] in pending_jobs:
                        continue
                    job = self.jobs.claim_job_for_fire(due_job["id"], return_job=True)
                    if not job:
                        continue
                    origin = job.get("origin") or {}
                    definition = self.definitions.get(origin.get("chat_id"))
                    if not definition or definition["key"] != origin.get("definition_key"):
                        raise ValueError("Native workflow timer lost its definition")
                    job = self.normalize_next(job, definition)
                    instant = due_job.get("_scheduled_instant") or due_job["next_run_at"]
                    execution = self.executions.create_execution(job["id"], source="nodeorchard-workflow", scheduled_instant=instant)
                    if not self.executions.mark_execution_running(execution["id"]):
                        raise RuntimeError("Native timer admission was not confirmed")
                    record = {"scheduleId": definition["id"], "key": definition["key"], "jobId": job["id"],
                        "executionId": execution["id"], "scheduledAt": instant,
                        "nextRunAt": job.get("next_run_at") if job["schedule"]["kind"] != "once" else None,
                        "zone": zone, "owner": job["fire_claim"]["by"]}
                    self.pending[execution["id"]] = record
                    write_json(self.pending_file, self.pending)
                    self.notify({"event": "fire", "value": {key: value for key, value in record.items() if key not in ("zone", "owner")}})
                    claimed_ids.add(job["id"])
                    delivered += 1
                after = {job["id"]: job for job in self.jobs.load_jobs()}
                for job_id, job in before.items():
                    origin = job.get("origin") or {}
                    following = after.get(job_id)
                    if job_id not in claimed_ids and job_id not in pending_jobs and (not following or following.get("next_run_at") != job.get("next_run_at")):
                        self.notify({"event": "advance", "value": {"scheduleId": origin.get("chat_id"),
                            "key": origin.get("definition_key"), "scheduledAt": job.get("next_run_at"),
                            "nextRunAt": following.get("next_run_at") if following else None}})
                self.jobs.record_ticker_heartbeat(success=True)
        return {"fired": delivered}

    def finish(self, params):
        if not isinstance(params, dict) or set(params) - {"executionId", "status", "error", "runId"}:
            raise ValueError("Invalid native timer acknowledgement")
        record = self.pending.get(params.get("executionId"))
        if record is None:
            raise ValueError("Native timer acknowledgement is stale")
        status = params.get("status")
        if status not in ("started", "offline", "busy", "error", "waiting_review", "missed", "cancelled"):
            raise ValueError("Invalid native timer result")
        error = str(params.get("error") or "")[:1000]
        with self.scope(record["zone"]):
            success = status == "started"
            self.jobs.mark_job_run(record["jobId"], success, error or None,
                status="ok" if success else "workflow_" + status, expected_fire_owner=record["owner"])
            job = self.jobs.get_job(record["jobId"])
            definition = self.definitions.get(record["scheduleId"])
            if job and definition:
                self.normalize_next(job, definition)
            self.executions.finish_execution(record["executionId"], success=success,
                error=error or status, delivery_outcome="workflow-admitted" if success else "workflow-not-started")
        self.pending.pop(record["executionId"])
        write_json(self.pending_file, self.pending)
        return {"acknowledged": True, "executionId": record["executionId"],
            "nextRunAt": job.get("next_run_at") if job and job.get("enabled") else None}

    def close(self):
        # An unacknowledged fire is result-unknown and stays durable for recovery.
        write_json(self.pending_file, self.pending)


def main():
    import fcntl
    root = Path(sys.argv[1]).absolute()
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock = open(root / ".owner.lock", "a+")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    poll = max(0.01, min(float(sys.argv[2]) / 1000, 60))
    scheduler = NativeWorkflowScheduler(root)
    while True:
        readable, _, _ = select.select([sys.stdin], [], [], poll)
        if readable:
            line = sys.stdin.readline()
            if not line:
                scheduler.close()
                break
            frame = {}
            try:
                if len(line) > 128 * 1024:
                    raise ValueError("Native timer request too large")
                frame = json.loads(line)
                method, params = frame["method"], frame.get("params", {})
                if method == "status":
                    result = {"engine": "hermes-native", "status": "ready"}
                elif method == "sync":
                    result = scheduler.sync(params["schedules"])
                elif method == "tick":
                    result = scheduler.tick()
                elif method == "finish":
                    result = scheduler.finish(params)
                else:
                    raise ValueError("Unsupported native timer method")
                emit({"id": frame["id"], "result": result})
            except Exception as error:
                emit({"id": frame.get("id"), "error": str(error)[:1000]})
        else:
            try:
                scheduler.tick()
            except Exception:
                # Keep the native store intact and report unavailability without
                # emitting backend paths, prompts or credentials.
                emit({"event": "unavailable", "value": {"code": "HERMES_CRON_SCAN_FAILED"}})


if __name__ == "__main__":
    main()
