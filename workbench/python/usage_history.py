"""Bounded metadata-only projection of Hermes' native read-only session store."""

from datetime import datetime, timezone
import math
import re
import sqlite3

MAX_SESSIONS = 50
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}\Z")
_COUNTERS = ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens", "api_call_count")


def validate_request(params):
    if (not isinstance(params, dict) or set(params) != {"stored_session_ids"}
            or not isinstance(params["stored_session_ids"], list)
            or not 1 <= len(params["stored_session_ids"]) <= MAX_SESSIONS
            or any(not isinstance(item, str) or not _ID.fullmatch(item) for item in params["stored_session_ids"])):
        raise ValueError("Usage history requires 1 to 50 stored session IDs, never a path or profile.")
    return list(dict.fromkeys(params["stored_session_ids"]))


def _rows(db, sql, params=()):
    if isinstance(db, sqlite3.Connection):
        cursor = db.execute(sql, params)
        names = [column[0] for column in cursor.description or ()]
        return [dict(zip(names, row)) for row in cursor.fetchall()]
    if getattr(db, "read_only", None) is not True or not callable(getattr(db, "_read_all", None)):
        raise ValueError("Usage history requires a native read-only store.")
    return [dict(row) for row in db._read_all(sql, params)]


def _columns(db, table):
    # Table names are fixed by this module, never request parameters.
    return {row["name"] for row in _rows(db, "PRAGMA table_info(" + table + ")")}


def _counter(value):
    return value if type(value) is int and 0 <= value <= 9007199254740991 else None


def _sum(*items):
    return sum(items) if all(item is not None for item in items) and sum(items) <= 9007199254740991 else None


def _usage(row):
    inp, out, read, write, reasoning, calls = (_counter(row.get(key)) for key in _COUNTERS)
    prompt = _sum(inp, read, write)
    return {"input": inp, "output": out, "prompt": prompt, "completion": out,
            "total": _sum(prompt, out), "calls": calls, "reasoning": reasoning,
            "cache_read": read, "cache_write": write}


def _recorded(usage):
    # Hermes increments calls even when a provider omits usage. Persisted zero
    # defaults cannot prove a measured zero-token request.
    return any(value is not None and value > 0 for key, value in usage.items() if key not in {"calls", "prompt", "completion", "total"})


def _timestamp(value):
    if type(value) not in {int, float} or not math.isfinite(value) or value < 0:
        return None
    try:
        return datetime.fromtimestamp(value, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    except (ValueError, OverflowError, OSError):
        return None


def _identity(value, limit=200):
    if (not isinstance(value, str) or not value or len(value) > limit or "://" in value
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_./:+-]*", value)):
        return ""
    return value


def read_usage_history(db, stored_session_ids):
    ids = validate_request({"stored_session_ids": stored_session_ids})
    session_columns, message_columns = _columns(db, "sessions"), _columns(db, "messages")
    if "id" not in session_columns or not {"session_id", "timestamp"}.issubset(message_columns):
        raise ValueError("Hermes usage store schema is incompatible.")
    route_columns = _columns(db, "session_model_usage")
    if route_columns and not {"session_id", "model", "task"}.issubset(route_columns):
        raise ValueError("Hermes model usage schema is incompatible.")
    field = lambda name, columns: name if name in columns else "NULL AS " + name
    names = (*_COUNTERS, "started_at", "ended_at", "parent_session_id", "end_reason")
    projection = ",".join(["id", *(field(name, session_columns) for name in names)])
    if "model_config" in session_columns:
        # Never load the model config blob. Only the numeric usage anchor is read.
        projection += ",CASE WHEN json_valid(model_config) THEN json_extract(model_config,'$._usage_anchor.prompt_tokens') END AS anchor_prompt_tokens"
    else:
        projection += ",NULL AS anchor_prompt_tokens"
    sessions = []
    for stored in ids:
        found = _rows(db, "SELECT " + projection + " FROM sessions WHERE id=?", (stored,))
        if not found:
            sessions.append({"storedSessionId": stored, "found": False, "source": "hermes.state-db"})
            continue
        row, = found
        counts = _rows(db, "SELECT MIN(timestamp) AS first_at,MAX(timestamp) AS last_at,COUNT(*) AS count FROM messages WHERE session_id=?", (stored,))[0]
        usage = _usage(row)
        anchor = _counter(row.get("anchor_prompt_tokens"))
        context = {"used": anchor, "max": None, "percent": None, "estimated": False, "historical": True,
                   "kind": "last-request-input", "capturedAt": None, "source": "hermes.persisted-usage-anchor"} if anchor and anchor > 0 else None
        model_usage = []
        if route_columns:
            fields = ("model", "billing_provider", "task", *_COUNTERS)
            rows = _rows(db, "SELECT " + ",".join(field(name, route_columns) for name in fields)
                         + " FROM session_model_usage WHERE session_id=? ORDER BY task,model LIMIT 201", (stored,))
            if len(rows) > 200:
                raise ValueError("Hermes model usage exceeds the bounded history limit.")
            for model in rows:
                model_usage.append({"model": _identity(model.get("model")), "provider": _identity(model.get("billing_provider"), 100),
                                    "task": _identity(model.get("task"), 100), "usage": _usage(model)})
        has_children = bool(_rows(db, "SELECT 1 AS present FROM sessions WHERE parent_session_id=? LIMIT 1", (stored,))) if "parent_session_id" in session_columns else None
        result = {"storedSessionId": stored, "found": True, "source": "hermes.state-db", "usage": usage,
                  "tokensRecorded": _recorded(usage), "startedAt": _timestamp(row.get("started_at")), "endedAt": _timestamp(row.get("ended_at")),
                  "firstMessageAt": _timestamp(counts["first_at"]), "lastMessageAt": _timestamp(counts["last_at"]),
                  "messageCount": counts["count"], "context": context, "modelUsage": model_usage,
                  "parentId": row.get("parent_session_id") if isinstance(row.get("parent_session_id"), str) and _ID.fullmatch(row["parent_session_id"]) else None,
                  "hasChildren": has_children, "compressed": row.get("end_reason") in {"compression", "orphaned_compression"} if "end_reason" in session_columns else None}
        if "role" in message_columns:
            summary_filter = " AND COALESCE(_compressed_summary,0)=0" if "_compressed_summary" in message_columns else ""
            user = _rows(db, "SELECT MIN(timestamp) AS first_at,MAX(timestamp) AS last_at,COUNT(*) AS count FROM messages WHERE session_id=? AND role='user'" + summary_filter, (stored,))[0]
            result.update(userMessageCount=user["count"], firstUserMessageAt=_timestamp(user["first_at"]), lastUserMessageAt=_timestamp(user["last_at"]))
        sessions.append(result)
    return {"schemaVersion": 1, "sessions": sessions}
