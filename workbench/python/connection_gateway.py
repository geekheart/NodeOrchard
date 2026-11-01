"""Host-owned connection lifecycle using Hermes' real native connection tool.

The model may name catalog/configured targets, never commands, URLs or secrets.
Only the human response interface can answer the native approval/credential card.
"""
from __future__ import annotations

import hashlib
import json
import re
import threading

ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
SLUG = re.compile(r"^[a-z0-9][a-z0-9_-]{0,79}$")
ACTIONS = frozenset({"connect", "reconnect", "install", "enable", "authorize"})


class ConnectionPolicyError(ValueError):
    pass


def _object(value, keys):
    if not isinstance(value, dict) or set(value) - set(keys):
        raise ConnectionPolicyError("Connection parameters are invalid.")


def _id(value):
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise ConnectionPolicyError("Connection identity is invalid.")
    return value


def _targets(value):
    if not isinstance(value, list) or not 1 <= len(value) <= 10:
        raise ConnectionPolicyError("Choose 1-10 connection targets.")
    result, seen = [], set()
    for row in value:
        if isinstance(row, str):
            name, mcp = row, False
        else:
            _object(row, ("name", "mcp"))
            name, mcp = row.get("name"), row.get("mcp", False)
        if not isinstance(name, str) or not SLUG.fullmatch(name) or not isinstance(mcp, bool):
            raise ConnectionPolicyError("Connection target is invalid.")
        if (name, mcp) not in seen:
            result.append({"name": name, "mcp": mcp})
            seen.add((name, mcp))
    return result


def _public(value, *, browser=False):
    """Allowlist the native result. Auth links belong only to the human card."""
    if not isinstance(value, dict):
        raise ConnectionPolicyError("Hermes returned an invalid connection result.")
    result = {key: value[key] for key in ("op_id", "seq", "deadline_at", "timeout_seconds", "settled_at", "settled_by", "status", "settled") if key in value}
    result["targets"] = []
    for row in (value.get("targets") or [])[:10]:
        if not isinstance(row, dict):
            continue
        target = {key: row[key] for key in ("name", "kind", "action", "state") if key in row}
        # Error bodies can contain credentials. A fixed outcome is safer than
        # treating a remote exception's prose as connection metadata.
        if row.get("detail"):
            target["detail"] = "Hermes reports a connection issue; inspect the connection status."
        tools = row.get("tools")
        if isinstance(tools, list):
            target["tools"] = [name for name in tools[:256] if isinstance(name, str) and ID.fullmatch(name)]
        if row.get("discovery_error"):
            target["discovery_error"] = "Authorized; tool discovery did not complete."
        if browser:
            url = row.get("connect_url")
            if isinstance(url, str) and len(url) <= 8192 and re.match(r"^https?://[^\s]+$", url):
                target["connect_url"] = url
            fields = []
            for field in (row.get("required_env") or [])[:32]:
                if not isinstance(field, dict) or not re.fullmatch(r"[A-Z][A-Z0-9_]{0,127}", str(field.get("name", ""))):
                    continue
                fields.append({"name": field["name"], "prompt": str(field.get("prompt") or field["name"])[:300],
                               "required": field.get("required") is True, "secret": field.get("secret") is True,
                               "default": "" if field.get("secret") else str(field.get("default") or "")[:1000]})
            if fields:
                target["required_env"] = fields
        result["targets"].append(target)
    if value.get("error"):
        result["error"] = "Hermes could not complete this connection operation. Check its configuration and authorization."
    return result


class _HermesConnections:
    def revision(self):
        from hermes_constants import get_hermes_home
        home = get_hermes_home()
        digest = hashlib.sha256()
        for name in ("config.yaml", ".env"):
            path = home / name
            if path.is_symlink() or path.exists() and (not path.is_file() or path.stat().st_size > 4 * 1024 * 1024):
                raise ConnectionPolicyError("Hermes connection configuration is unavailable.")
            digest.update(name.encode())
            digest.update(path.read_bytes() if path.exists() else b"missing")
        return "sha256:" + digest.hexdigest()

    def inventory(self):
        from hermes_cli.mcp_catalog import list_catalog, installed_servers, server_enabled
        from tools.connectors.gateway.config import connectors_available
        configured = installed_servers()
        catalog = [{"name": row.name, "description": str(row.description or "")[:500], "installed": row.name in configured}
                   for row in list_catalog()[:200]]
        mcps = [{"name": name, "enabled": server_enabled(row), "transport": "http" if row.get("url") else "stdio"}
                for name, row in list(configured.items())[:200] if isinstance(row, dict) and SLUG.fullmatch(name)]
        available = connectors_available()
        hosted, hosted_error = [], False
        if available:
            try:
                from tools.connectors.managed import managed_client
                hosted = [{key: row.get(key) for key in ("connector", "enabled", "connected", "connection_status")}
                          for row in managed_client().list_connectors()[:200] if isinstance(row, dict)]
            except Exception:
                hosted_error = True
        return {"mcp": mcps, "catalog": catalog, "hosted": hosted, "hostedAvailable": available, "hostedStatusUnavailable": hosted_error}

    def manage(self, args, session_id, callback):
        from tools.connectors.tool import manage_connections
        from tools.connectors.gateway.config import connectors_available
        return manage_connections(args, session_id=session_id, connection_callback=callback, connectors_available=connectors_available)

    def operation(self, session_id, op_id):
        from tools.connectors import live
        return live.get(session_id, op_id)

    def answer(self, operation, body):
        from tools.connectors.run import apply_answer
        from tools.connectors.contract import SettleReason
        apply_answer(operation, json.dumps(body))
        operation.wake.set()
        if operation.all_resolved:
            operation.settle(SettleReason.all_resolved)

    def cancel(self, operation):
        from tools.connectors.run import apply_answer
        from tools.connectors.contract import SettleReason
        apply_answer(operation, json.dumps({"targets": [{"name": row.name, "status": "skipped"} for row in operation.targets]}))
        operation.settle(SettleReason.interrupt)


class HermesConnections:
    def __init__(self, runtime=None, emit=None):
        self.runtime = runtime or _HermesConnections()
        self.emit = emit or (lambda *_args: None)
        self.lock = threading.RLock()
        self.active = {}

    def inspect(self, params):
        _object(params, ())
        return {**self.runtime.inventory(), "revision": self.runtime.revision(), "native": True}

    def manage(self, params):
        _object(params, ("operation_id", "conversation_id", "turn_id", "expected_revision", "action", "connectors", "force"))
        identity = {key: _id(params.get(key)) for key in ("operation_id", "conversation_id", "turn_id")}
        action = params.get("action")
        targets = _targets(params.get("connectors"))
        if action not in ACTIONS or not isinstance(params.get("force", False), bool):
            raise ConnectionPolicyError("Connection action is invalid.")
        if action in {"install", "enable", "authorize"} and any(not row["mcp"] for row in targets):
            raise ConnectionPolicyError("Choose MCP targets for this action.")
        if action in {"connect", "reconnect"} and any(row["mcp"] for row in targets):
            raise ConnectionPolicyError("Choose hosted targets for this action.")
        if params.get("force") and action != "reconnect":
            raise ConnectionPolicyError("Force applies only to reconnect.")
        with self.lock:
            if params.get("expected_revision") != self.runtime.revision():
                raise ConnectionPolicyError("Hermes connection configuration changed; inspect again.")
            if self.active:
                raise ConnectionPolicyError("Another connection operation is active.")
            state = {**identity, "session_id": "nodeorchard-" + identity["operation_id"], "op_id": None, "revision": params["expected_revision"], "cancelled": False}
            self.active[identity["operation_id"]] = state

        def card(payload):
            with self.lock:
                state["op_id"] = _id(payload.get("op_id"))
                state["card"] = _public(payload, browser=True)
                if state["cancelled"]:
                    operation = self.runtime.operation(state["session_id"], state["op_id"])
                    if operation:
                        self.runtime.cancel(operation)
                    return
            self.emit("request", {**identity, "snapshot": state["card"]})

        try:
            args = {"action": action, "connectors": targets, "force": params.get("force", False)}
            raw = self.runtime.manage(args, state["session_id"], card)
            value = json.loads(raw) if isinstance(raw, str) else raw
            return {**_public(value), "revision": self.runtime.revision(), "native": True}
        except ConnectionPolicyError:
            raise
        except Exception:
            raise ConnectionPolicyError("Hermes connection operation was not confirmed; inspect before retrying.") from None
        finally:
            with self.lock:
                self.active.pop(identity["operation_id"], None)
            self.emit("complete", {**identity, "snapshot": {"settled": True}})

    def respond(self, params):
        _object(params, ("operation_id", "result"))
        with self.lock:
            state = self.active.get(_id(params.get("operation_id")))
            if not state or not state["op_id"] or state["cancelled"]:
                raise ConnectionPolicyError("This connection request is no longer active.")
            operation = self.runtime.operation(state["session_id"], state["op_id"])
            if not operation or operation.settled:
                raise ConnectionPolicyError("This connection request has settled.")
            body = params.get("result")
            _object(body, ("targets", "settled_by"))
            if body.get("settled_by") not in (None, "continue"):
                raise ConnectionPolicyError("Only continue or native row answers are accepted.")
            rows = body.get("targets", [])
            if not isinstance(rows, list) or len(rows) > 10:
                raise ConnectionPolicyError("Connection answer is invalid.")
            allowed = {row.get("name"): row for row in state["card"].get("targets", [])}
            for row in rows:
                _object(row, ("name", "status", "env"))
                target = allowed.get(row.get("name"))
                if not target or row.get("status") not in ("approved", "skipped"):
                    raise ConnectionPolicyError("Connection answer does not match this card.")
                fields = {field["name"]: field for field in target.get("required_env", [])}
                env = row.get("env", {})
                if not isinstance(env, dict) or set(env) - fields.keys() or any(not isinstance(v, str) or len(v) > 16384 or "\0" in v for v in env.values()):
                    raise ConnectionPolicyError("Only declared setup fields may be submitted.")
                if row["status"] == "approved" and any(field.get("required") and not env.get(name, "").strip() for name, field in fields.items()):
                    raise ConnectionPolicyError("Required setup values are missing.")
            if any(row.get("status") == "approved" for row in rows) and self.runtime.revision() != state["revision"]:
                raise ConnectionPolicyError("Hermes configuration changed; cancel this card and inspect again.")
            self.runtime.answer(operation, body)
            # Only the native backend may report connected; the UI cannot claim it.
            snapshot = _public(operation.snapshot(), browser=True)
            state["card"] = snapshot
            self.emit("update", {key: state[key] for key in ("operation_id", "conversation_id", "turn_id")} | {"snapshot": snapshot})
            return {"accepted": True, "settled": operation.settled}

    def cancel(self, params):
        _object(params, ("operation_id",))
        with self.lock:
            state = self.active.get(_id(params.get("operation_id")))
            if not state:
                return {"cancelled": False}
            state["cancelled"] = True
            operation = self.runtime.operation(state["session_id"], state["op_id"]) if state["op_id"] else None
            if operation:
                self.runtime.cancel(operation)
            return {"cancelled": True}


def install_connection_rpc(server, service=None):
    if service is None:
        # Declare custom metadata frames in this process only; no upstream edit.
        from pydantic import Field
        from tui_gateway.contracts.base import Payload
        from tui_gateway.contracts.registry import event

        class ConnectionFrame(Payload):
            operation_id: str
            conversation_id: str
            turn_id: str
            snapshot: dict = Field(default_factory=dict)

        for suffix in ("request", "update", "complete"):
            event("workbench.connections." + suffix, ConnectionFrame)
        service = HermesConnections(emit=lambda kind, value: server._emit("workbench.connections." + kind, "", value))

    for action, method in (("inspect", service.inspect), ("manage", service.manage), ("respond", service.respond), ("cancel", service.cancel)):
        def call(rid, params, handler=method):
            try:
                return server._ok(rid, handler(params))
            except ConnectionPolicyError as error:
                return server._err(rid, 4400, str(error))
            except Exception:
                return server._err(rid, 4401, "Hermes connection operation was not confirmed.")
        server.register_method("workbench.connections." + action, call)
    server._LONG_HANDLERS = frozenset(server._LONG_HANDLERS) | {"workbench.connections.manage", "workbench.connections.inspect", "workbench.connections.respond"}
    return service
