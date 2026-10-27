"""Bounded assistant-call metadata without materializing stored transcripts."""

from usage_history import _columns, _counter, _rows, _timestamp, read_usage_history, validate_request as validate_usage_request

MAX_SESSIONS = 12
_COMPLETE = frozenset({"stop", "end_turn", "stop_sequence", "eos", "eos_token", "tool_calls", "function_call"})
_PARTIAL = frozenset({"length", "max_tokens", "max_output_tokens", "token_limit", "interrupted", "cancelled", "canceled", "timeout", "error", "content_filter"})


def validate_request(params):
    if (not isinstance(params, dict) or set(params) != {"stored_session_ids"}
            or not isinstance(params["stored_session_ids"], list)
            or not 1 <= len(params["stored_session_ids"]) <= MAX_SESSIONS):
        raise ValueError("Assistant diagnostics requires 1 to 12 stored IDs, never a path, query or profile.")
    return validate_usage_request(params)


def _completion(reason, explicit_partial):
    reason = reason if isinstance(reason, str) and reason in _COMPLETE | _PARTIAL else None
    partial = bool(explicit_partial) if type(explicit_partial) is int and explicit_partial in {0, 1} else None
    if partial is True or reason in _PARTIAL:
        return reason, False, True
    if reason in _COMPLETE:
        return reason, True, False
    return reason, None, partial


def read_assistant_diagnostics(db, stored_session_ids):
    ids = validate_request({"stored_session_ids": stored_session_ids})
    message_columns = _columns(db, "messages")
    if not {"session_id", "timestamp", "role", "content"}.issubset(message_columns):
        raise ValueError("Hermes assistant diagnostic schema is incompatible.")
    usage_rows = read_usage_history(db, ids)["sessions"]
    sessions = []
    summary_filter = " AND COALESCE(_compressed_summary,0)=0" if "_compressed_summary" in message_columns else ""
    # All SQL expressions and table/column names are fixed. Only numeric lengths,
    # counts, timestamps and a whitelisted finish label leave the native store.
    count_sql = ("SELECT COALESCE(SUM(CASE WHEN role='user' THEN length(content) ELSE 0 END),0) AS prompt_characters,"
                 "COALESCE(SUM(CASE WHEN role='assistant' THEN length(content) ELSE 0 END),0) AS output_characters,"
                 "SUM(CASE WHEN role='user' THEN 1 ELSE 0 END) AS user_count,"
                 "SUM(CASE WHEN role='assistant' THEN 1 ELSE 0 END) AS assistant_count "
                 "FROM messages WHERE session_id=?" + summary_filter)
    finish = "finish_reason" if "finish_reason" in message_columns else "NULL AS finish_reason"
    partial = "CASE WHEN typeof(partial)='integer' AND partial IN(0,1) THEN partial END AS partial" if "partial" in message_columns else "NULL AS partial"
    order = "timestamp DESC," + ("id DESC" if "id" in message_columns else "rowid DESC")
    last_sql = "SELECT timestamp," + finish + "," + partial + " FROM messages WHERE session_id=? AND role='assistant'" + summary_filter + " ORDER BY " + order + " LIMIT 1"
    for usage in usage_rows:
        stored = usage["storedSessionId"]
        value = {"storedSessionId": stored, "found": usage["found"], "promptCharacters": None, "outputCharacters": None,
                 "userMessageCount": None, "assistantMessageCount": None, "lastAssistantAt": None,
                 "finishReason": None, "complete": None, "partial": None, "usage": usage.get("usage"),
                 "tokensRecorded": usage.get("tokensRecorded", False), "source": "hermes.state-db.metadata"}
        if usage["found"]:
            counts = _rows(db, count_sql, (stored,))[0]
            last = _rows(db, last_sql, (stored,))
            value.update(promptCharacters=_counter(counts["prompt_characters"]), outputCharacters=_counter(counts["output_characters"]),
                         userMessageCount=_counter(counts["user_count"] or 0), assistantMessageCount=_counter(counts["assistant_count"] or 0))
            if last:
                reason, complete, is_partial = _completion(last[0]["finish_reason"], last[0]["partial"])
                value.update(lastAssistantAt=_timestamp(last[0]["timestamp"]), finishReason=reason, complete=complete, partial=is_partial)
        sessions.append(value)
    return {"schemaVersion": 1, "sessions": sessions}
