"""Shared host-side MCP and bounded desktop execution, using Hermes runtimes.

The caller supplies only saved server/tool identities and a host-admitted scope.
No model input can install a process, change a connection, or grant permissions.
"""
from __future__ import annotations

import base64
import atexit
import contextlib
import dataclasses
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import stat
import threading
import time
from types import FunctionType, SimpleNamespace
from urllib.parse import urlsplit
import uuid

ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z")
PROTECTED_APPS = re.compile(r"(?:^|[._-])(?:terminal|iterm2?|ghostty|warp|vscode|code|codex|cursor|zed|textmate|sublime(?:text)?|emacs|vim|jetbrains|systempreferences|systemsettings|finder|safari|chrome|chromium|firefox|edge|brave|arc|orion|electron|automator|scripteditor)(?:$|[._-])", re.I)
UNSAFE_CONTROL = re.compile(r"(?:console|terminal|python|javascript|script|repl|command\s*(?:line|prompt)|code\s*editor|控制台|终端|脚本|命令行|代码编辑)", re.I)
UNSAFE_TEXT = re.compile(r"(?:\b(?:exec|eval|compile|__import__)\s*\(|\b(?:import\s+(?:os|sys|subprocess|pathlib)|from\s+(?:os|subprocess|pathlib)\s+import)\b|\b(?:curl|wget|sudo|osascript|open\s+-a)\b|(?:^|\n)\s*(?:rm|chmod|chown|bash|zsh|sh)\s)", re.I)
DESKTOP_MUTATIONS = frozenset({"click", "double_click", "right_click", "scroll", "type", "key", "set_value"})
DESKTOP_TOOLS = ["start_session", "end_session", "list_apps", "list_windows", "get_window_state", "click", "double_click", "scroll", "type_text", "press_key", "hotkey", "set_value"]


class LocalToolError(ValueError):
    def __init__(self, message, code="LOCAL_TOOL_UNAVAILABLE"):
        super().__init__(message)
        self.code = code


def _plain(value):
    return isinstance(value, dict) and all(isinstance(key, str) for key in value)


def _identifier(value):
    return isinstance(value, str) and ID.fullmatch(value) is not None


def _digest(value):
    return "sha256:" + hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def _safe_text(value, limit=1000):
    text = str(value or "")
    text = re.sub(r"(?i)\bBearer\s+\S+|\b(?:sk-|ghp_)[A-Za-z0-9_-]+|(?:api_key|access_token|refresh_token|password|secret)\s*[=:]\s*[^\s,;}]+", "[REDACTED]", text)
    return text[:limit]


def _image_result(capture):
    payload = dataclasses.asdict(capture) if dataclasses.is_dataclass(capture) else dict(capture)
    encoded = payload.pop("png_b64", None)
    payload.pop("png_bytes_len", None)
    payload["elements"] = payload.get("elements", [])[:200]
    if encoded:
        try:
            raw = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError) as error:
            raise LocalToolError("Desktop driver returned invalid image bytes.") from error
        if not 0 < len(raw) <= 8 * 1024 * 1024 or not (raw.startswith(b"\x89PNG\r\n\x1a\n") or raw.startswith(b"\xff\xd8\xff")):
            raise LocalToolError("Desktop driver returned an unsupported or oversized image.")
        mime = "image/png" if raw.startswith(b"\x89PNG") else "image/jpeg"
        payload["_nodeorchard_images"] = [{"mimeType": mime, "data": encoded}]
    return payload


def _stop_driver(backend):
    process = getattr(getattr(backend, '_embedded_daemon', None), '_process', None)
    try:
        backend.stop()
    finally:
        # Hermes' embedded daemon drains stderr on a reader thread; after its
        # process exits the embedding host also owns closing that pipe handle.
        if process is not None and getattr(process, 'stderr', None) is not None:
            with contextlib.suppress(Exception):
                process.stderr.close()


def _bound_function(function, **overrides):
    """Bind native helpers to this instance without mutating imported modules."""
    namespace = {**function.__globals__, **overrides}
    bound = FunctionType(function.__code__, namespace, function.__name__, function.__defaults__, function.__closure__)
    bound.__kwdefaults__ = function.__kwdefaults__
    return bound


def _private_native_backend(native, binary, manifest_path):
    policy = {'capability_manifest': str(manifest_path), 'permission_mode': 'bounded', 'no_overlay': True}
    # Only this constructor reads the private manifest. Other Hermes threads
    # retain their actual profile's configuration at every point in time.
    def daemon(_ignored_binary, permission_mode, capability_manifest=None):
        return native._EmbeddedCuaDaemon(binary, permission_mode, capability_manifest=capability_manifest)
    constructor = _bound_function(native.CuaDriverBackend.__init__, _computer_use_cfg=lambda: dict(policy), _EmbeddedCuaDaemon=daemon)
    # The native start method skips on-demand PM acquisition only for this
    # verified binary. Its environment view is local to the cloned function;
    # os.environ itself and the upstream module's namespace are untouched.
    private_os = SimpleNamespace(**{**vars(os), 'environ': {**os.environ, 'HERMES_CUA_DRIVER_CMD': binary}})
    start = _bound_function(native.CuaDriverBackend.start, os=private_os, sandbox_mcp_invocation=lambda: None,
                            cua_driver_runtime_contract_status=lambda: native.cua_driver_runtime_contract_status(binary),
                            _cua_no_overlay=lambda: True)
    scoped_type = type('WorkbenchBoundedCuaBackend', (native.CuaDriverBackend,), {'__init__': constructor, 'start': start})
    backend = scoped_type(permission_mode='bounded')
    backend.start()
    return backend


class LocalTools:
    def __init__(self, server=None, *, dependencies=None, now=time.monotonic, application_port=None):
        self.server = server
        self.dependencies = dependencies or {}
        self.now = now
        self.application_port = int(application_port or os.environ.get("WORKBENCH_APPLICATION_PORT", "4318"))
        self.lock = threading.RLock()
        self.backends = {}
        self.captures = {}
        self.closed = False
        atexit.register(self.close)

    def native(self, name):
        if name in self.dependencies:
            return self.dependencies[name]
        if name == "config":
            from hermes_cli.config import load_config_readonly
            return load_config_readonly
        if name == "discover":
            from tools.mcp_tool_discovery import discover_mcp_tools
            return discover_mcp_tools
        if name == "status":
            from tools.mcp_tool_discovery import get_mcp_status
            return get_mcp_status
        if name == "entries":
            from tools.registry import registry
            return registry.get_all_entries
        if name == "readonly":
            from tools.mcp_tool_schema import _convert_mcp_schema
            from tools.mcp_tool_discovery import _get_connected_server_for_call
            from tools.mcp_tool_common import mcp_field
            def readonly(server_name, entry):
                connected = _get_connected_server_for_call(server_name)
                for tool in getattr(connected, "_tools", []) if connected else []:
                    if _convert_mcp_schema(server_name, tool).get("name") == entry.name:
                        annotations = getattr(tool, 'annotations', None)
                        hint = annotations.get('readOnlyHint') if isinstance(annotations, dict) else mcp_field(annotations, 'read_only_hint', 'readOnlyHint') if annotations is not None else None
                        return hint is True
                return False
            return readonly
        if name == "desktop_status":
            from tools.computer_use.permissions import computer_use_status
            return computer_use_status
        if name == "backend":
            return self._native_backend
        raise LocalToolError("Native local-tool interface is unavailable.")

    def check_open(self):
        if self.closed:
            raise LocalToolError("Local tools are closed.", "LOCAL_TOOL_CANCELLED")

    def configured(self):
        value = self.native("config")()
        servers = value.get("mcp_servers", {}) if isinstance(value, dict) else {}
        return {name: config for name, config in servers.items() if _identifier(name) and isinstance(config, dict)} if isinstance(servers, dict) else {}

    def allowed_server(self, config, application_port=None):
        if config.get("enabled", True) is not True:
            return False, "disabled"
        if "url" not in config:
            return (True, "") if isinstance(config.get("command"), str) and config["command"].strip() else (False, "invalid_config")
        try:
            parsed = urlsplit(config["url"])
            if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
                return False, "invalid_endpoint"
            port = parsed.port or (443 if parsed.scheme == "https" else 80)
            host = parsed.hostname.lower().rstrip(".")
            if host in {"metadata.google.internal", "metadata", "instance-data", "169.254.169.254", "168.63.129.16"}:
                return False, "protected_endpoint"
            addresses = [row[4][0] for row in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)]
            for address in addresses:
                parsed_address = ipaddress.ip_address(address)
                parsed_address = parsed_address.ipv4_mapped if isinstance(parsed_address, ipaddress.IPv6Address) and parsed_address.ipv4_mapped else parsed_address
                if parsed_address.is_link_local or parsed_address.is_multicast or parsed_address.is_unspecified or str(parsed_address) == '168.63.129.16':
                    return False, 'protected_endpoint'
            if port == (application_port or self.application_port):
                # Workbench control is reached through its dispatcher, never an
                # MCP server pointing at the human HTTP management interface.
                if host in {"localhost", "127.0.0.1", "::1", "0.0.0.0"} or any(address.startswith("127.") or address in {"::1", "0.0.0.0"} for address in addresses):
                    return False, "protected_endpoint"
            return True, ""
        except (ValueError, TypeError, OSError):
            return False, "invalid_endpoint"

    def _tool_rows(self, name, entries):
        tools = []
        for entry in entries:
            if entry.toolset != "mcp-" + name or not _identifier(entry.name):
                continue
            schema = entry.schema.get("function", entry.schema)
            tool = {"name": entry.name, "description": _safe_text(schema.get("description", entry.description), 2000),
                    "inputSchema": schema.get("parameters", {}), "readOnly": self.native("readonly")(name, entry) is True}
            if len(json.dumps(tool)) <= 65536:
                tools.append(tool)
        return sorted(tools, key=lambda row: row['name'])[:256]

    def _revision(self, servers, entries=None):
        # Config (including its secret generation) and discovered schemas are
        # bound together; same endpoint + changed tool cannot reuse an approval.
        entries = self.native('entries')() if entries is None else entries
        return _digest({'config': servers, 'tools': {name: self._tool_rows(name, entries) for name in sorted(servers)}})

    def catalog(self, params=None):
        self.check_open()
        params = params or {}
        if not _plain(params) or set(params) - {"server", "refresh", "application_port"}:
            raise LocalToolError("Unexpected local-tool catalog parameters.", "LOCAL_TOOL_ARGUMENTS")
        configured = self.configured()
        selected = params.get("server")
        if selected is not None and (not _identifier(selected) or selected not in configured):
            raise LocalToolError("MCP server is not configured.", "LOCAL_TOOL_ARGUMENTS")
        wanted = [selected] if selected else list(configured) if params.get("refresh") is True else []
        allowed = [name for name in wanted if self.allowed_server(configured[name], params.get("application_port"))[0]]
        errors = set()
        for name in allowed:
            try:
                self.native("discover")([name])
            except Exception:
                errors.add(name)
        try:
            statuses = {row["name"]: row for row in self.native("status")(configured) if isinstance(row, dict) and isinstance(row.get("name"), str)}
        except Exception:
            statuses = {}
        entries = self.native("entries")()
        rows = []
        for name, config in sorted(configured.items()):
            if selected and selected != name:
                continue
            allowed, reason = self.allowed_server(config, params.get("application_port"))
            tools = self._tool_rows(name, entries) if allowed else []
            state = statuses.get(name, {}).get("status", "configured")
            rows.append({"id": name, "enabled": config.get("enabled", True) is True, "transport": "http" if "url" in config else "stdio",
                         "status": "blocked" if not allowed else "failed" if name in errors else state,
                         "reason": reason or ("Connection failed; inspect the native MCP logs." if name in errors else ""), "tools": tools[:256]})
        try:
            status = self.native("desktop_status")()
            desktop = {key: status.get(key) for key in ("platform", "installed", "version", "ready", "accessibility", "screen_recording", "screen_recording_capturable")}
            desktop["reason"] = "" if desktop.get("ready") is True else "Install the Hermes computer-use driver and manually grant system permissions."
        except Exception:
            desktop = {"ready": False, "reason": "Native desktop status is unavailable."}
        return {"revision": self._revision(configured, entries), "servers": rows, "desktop": desktop}

    def scope(self, value):
        if not _plain(value) or set(value) - {"session_id", "working_folder", "read_only", "allowed_apps"}:
            raise LocalToolError("Missing host-bound local-tool scope.", "LOCAL_TOOL_SCOPE")
        folder = value.get("working_folder")
        if not _identifier(value.get("session_id")) or not isinstance(folder, str) or not Path(folder).is_absolute() or Path(folder).resolve() != Path(folder):
            raise LocalToolError("Invalid host-bound local-tool identity.", "LOCAL_TOOL_SCOPE")
        if not isinstance(value.get("read_only"), bool):
            raise LocalToolError("Local-tool scope must declare read-only state.", "LOCAL_TOOL_SCOPE")
        return value

    def mcp(self, params):
        self.check_open()
        if not _plain(params) or set(params) - {"server", "tool", "arguments", "expected_revision", "scope", "operation_id", "application_port"}:
            raise LocalToolError("Unexpected MCP call parameters.", "LOCAL_TOOL_ARGUMENTS")
        scope = self.scope(params.get("scope"))
        if not _identifier(params.get("server")) or not _identifier(params.get("tool")) or not _plain(params.get("arguments")) or len(json.dumps(params["arguments"])) > 65536:
            raise LocalToolError("MCP tool identity or arguments are invalid.", "LOCAL_TOOL_ARGUMENTS")
        configured = self.configured()
        name = params["server"]
        if params.get("expected_revision") != self._revision(configured):
            raise LocalToolError("MCP configuration changed after admission.", "LOCAL_TOOL_CONFLICT")
        if name not in configured or not self.allowed_server(configured[name], params.get("application_port"))[0]:
            raise LocalToolError("MCP endpoint is unavailable or protected.", "LOCAL_TOOL_PERMISSION")
        self.native("discover")([name])
        entry = next((entry for entry in self.native("entries")() if entry.name == params["tool"] and entry.toolset == "mcp-" + name), None)
        if entry is None:
            raise LocalToolError("MCP tool is absent from the saved server.", "LOCAL_TOOL_UNAVAILABLE")
        if scope["read_only"] and self.native("readonly")(name, entry) is not True:
            raise LocalToolError("Read-only sessions cannot call write-capable MCP tools.", "LOCAL_TOOL_PERMISSION")
        if self._revision(self.configured()) != params["expected_revision"]:
            raise LocalToolError("MCP configuration changed during discovery.", "LOCAL_TOOL_CONFLICT")
        # Native handler owns transport, per-server filters, OAuth refresh,
        # read-only retry classification and uncertain-write no-replay behavior.
        result = entry.handler(params["arguments"], session_id=scope["session_id"], task_id=scope["session_id"])
        if hasattr(result, "__await__"):
            raise LocalToolError("Asynchronous native registry entry is unsupported.")
        if isinstance(result, str):
            if len(result.encode()) > 8 * 1024 * 1024:
                raise LocalToolError("MCP result exceeds the local-tool limit.")
            try:
                result = json.loads(result)
            except (TypeError, ValueError):
                result = {"text": result}
        return {"server": name, "tool": entry.name, "result": result}

    def _native_backend(self, manifest_path):
        from tools.computer_use import cua_backend
        from tools.computer_use.cua_backend_driver import resolve_cua_driver_cmd
        binary = resolve_cua_driver_cmd()
        if not binary:
            raise LocalToolError("Install the pinned driver with `hermes computer-use install`.")
        return _private_native_backend(cua_backend, binary, manifest_path)

    def backend(self, scope):
        apps = scope.get("allowed_apps")
        if not isinstance(apps, list) or not apps or len(apps) > 32 or any(not _identifier(app) or PROTECTED_APPS.search(app) for app in apps):
            raise LocalToolError("A human-approved desktop application allowlist is required.", "LOCAL_TOOL_PERMISSION")
        key = scope["session_id"]
        digest = _digest({"apps": sorted(apps), "folder": scope["working_folder"]})
        if key in self.backends:
            previous = self.backends[key]
            if previous[0] != digest:
                _stop_driver(previous[1])
                previous[2].unlink(missing_ok=True)
                del self.backends[key]
                raise LocalToolError("Desktop scope changed; capture a new target.", "LOCAL_TOOL_CONFLICT")
            return previous[1]
        # The manifest lives in Hermes private cache, never in the user workflow.
        root = Path(self.dependencies.get("cache_root", os.environ.get("HERMES_HOME", str(Path.home() / ".hermes")))) / "cache" / "nodeorchard-desktop"
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        if root.resolve() != root or root.is_symlink():
            raise LocalToolError("Desktop manifest cache is not a private directory.")
        path = root / (uuid.uuid4().hex + ".json")
        manifest = {"version": 3, "expires_after": "1h", "idle_timeout": "10m", "allow": {"tools": DESKTOP_TOOLS},
                    "resources": {"apps": [{"bundle_id": app, "launch": False, "windows": "all", "terminate": "deny"} for app in apps],
                                  "files": {"read": [{"dir": scope["working_folder"], "recursive": True}], "write": [{"dir": scope["working_folder"], "recursive": True}]}, "desktop": {"display": False}}}
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as handle:
            json.dump(manifest, handle)
        try:
            driver = self.native("backend")(path)
        except Exception:
            path.unlink(missing_ok=True)
            raise
        self.backends[key] = (digest, driver, path)
        return driver

    def desktop(self, params):
        self.check_open()
        if not _plain(params) or set(params) - {"action", "app", "mode", "captureId", "capture_id", "element", "coordinate", "text", "keys", "direction", "amount", "value", "operationId", "scope", "application_port"}:
            raise LocalToolError("Unexpected desktop parameters.", "LOCAL_TOOL_ARGUMENTS")
        scope = self.scope(params.get("scope"))
        action, app = params.get("action"), params.get("app")
        if action == "status":
            value = self.native("desktop_status")()
            return {key: value.get(key) for key in ("platform", "installed", "version", "ready", "accessibility", "screen_recording", "screen_recording_capturable")}
        if app not in scope.get("allowed_apps", []) or not _identifier(app) or PROTECTED_APPS.search(app):
            raise LocalToolError("Desktop app is outside the human-approved scope.", "LOCAL_TOOL_PERMISSION")
        if scope["read_only"] and action in DESKTOP_MUTATIONS:
            raise LocalToolError("Read-only sessions cannot control the desktop.", "LOCAL_TOOL_PERMISSION")
        if action not in DESKTOP_MUTATIONS | {"capture", "list_windows", "list_apps"}:
            raise LocalToolError("Desktop action is unsupported.", "LOCAL_TOOL_ARGUMENTS")
        with self.lock:
            backend = self.backend(scope)
            if action == "list_windows":
                # The manifest enforces the same allowlist in the driver.
                return {"windows": backend.list_windows()[:100]}
            if action == "list_apps":
                return {"apps": backend.list_apps()[:100]}
            if action == "capture":
                mode = params.get("mode", "som")
                if mode not in {"som", "ax", "vision"}:
                    raise LocalToolError("Desktop capture mode is invalid.", "LOCAL_TOOL_ARGUMENTS")
                capture = backend.capture(mode=mode, app=app)
                result = _image_result(capture)
                capture_id = str(uuid.uuid4())
                pid, window = getattr(backend, "_active_pid", None), getattr(backend, "_active_window_id", None)
                self.captures[scope["session_id"]] = {"id": capture_id, "app": app, "pid": pid, "window": window, "at": self.now(), "elements": result.get("elements", [])}
                return {"captureId": capture_id, "app": app, "pid": pid, "windowId": window, **result}
            previous = self.captures.get(scope["session_id"])
            if not previous or previous["id"] != params.get("capture_id", params.get("captureId")) or previous["app"] != app or self.now() - previous["at"] > 30:
                raise LocalToolError("Capture the approved window again before this action.", "LOCAL_TOOL_CAPTURE_STALE")
            if not previous["pid"] or not previous["window"]:
                raise LocalToolError("The driver cannot prove an exact application/window target.")
            # Each mutation revalidates the exact window and accessibility state
            # after human approval; no fallback to the frontmost application.
            current = backend.capture(mode="ax", app=app, pid=previous["pid"], window_id=previous["window"])
            elements = dataclasses.asdict(current).get("elements", []) if dataclasses.is_dataclass(current) else current.get("elements", [])
            if not elements or getattr(backend, "_active_pid", None) != previous["pid"] or getattr(backend, "_active_window_id", None) != previous["window"]:
                raise LocalToolError("Reliable accessibility state is required for desktop changes.")
            # Prevent generic input into scripting consoles and source editors.
            if UNSAFE_CONTROL.search(str(getattr(current, "window_title", ""))):
                raise LocalToolError("Scripting/editor windows cannot be driven.", "LOCAL_TOOL_PERMISSION")
            selected = next((row for row in elements if row.get("index") == params.get("element")), None)
            focused = [row for row in elements if (row.get("attributes") or {}).get("focused") is True or (row.get("attributes") or {}).get("AXFocused") is True]
            controls = ([selected] if selected else []) + focused
            if any(UNSAFE_CONTROL.search(" ".join(str(row.get(key, "")) for key in ("label", "role", "attributes"))) for row in controls):
                raise LocalToolError("Scripting/editor controls cannot receive input.", "LOCAL_TOOL_PERMISSION")
            if action in {"type", "key", "set_value"} and not focused:
                raise LocalToolError("The driver could not prove the focused control; input was refused.")
            if params.get("text") is not None and (not isinstance(params["text"], str) or len(params["text"]) > 4000 or UNSAFE_TEXT.search(params["text"])):
                raise LocalToolError("Desktop text is unsafe or exceeds its limit.", "LOCAL_TOOL_PERMISSION")
            if action == "key":
                keys = str(params.get("keys", "")).lower()
                if not re.fullmatch(r"(?:(?:cmd|ctrl|shift|option|alt)\+)*(?:[a-z0-9]|return|enter|escape|tab|space|backspace|delete|up|down|left|right|home|end)", keys) or keys in {"cmd+space", "ctrl+space", "cmd+shift+p", "cmd+option+i", "alt+p", "ctrl+alt+t"}:
                    raise LocalToolError("This desktop shortcut is not permitted.", "LOCAL_TOOL_PERMISSION")
            element = params.get("element")
            coordinate = params.get("coordinate")
            if coordinate is not None and (not isinstance(coordinate, list) or len(coordinate) != 2 or any(not isinstance(n, int) or isinstance(n, bool) or n < 0 or n > 32768 for n in coordinate)):
                raise LocalToolError("Desktop coordinates are invalid.", "LOCAL_TOOL_ARGUMENTS")
            pointer = {"element": element} if element is not None else {"x": coordinate[0], "y": coordinate[1]} if coordinate else {}
            if action in {"click", "double_click", "right_click"}:
                result = backend.click(**pointer, button="right" if action == "right_click" else "left", click_count=2 if action == "double_click" else 1, delivery_mode="background")
            elif action == "scroll":
                if params.get("direction") not in {"up", "down", "left", "right"}:
                    raise LocalToolError("Desktop scroll direction is invalid.", "LOCAL_TOOL_ARGUMENTS")
                result = backend.scroll(**pointer, direction=params["direction"], amount=max(1, min(20, int(params.get("amount", 3)))), delivery_mode="background")
            elif action == "type":
                result = backend.type_text(params.get("text", ""), delivery_mode="background")
            elif action == "key":
                result = backend.key(params["keys"], delivery_mode="background")
            else:
                value = params.get("value")
                if not isinstance(value, str) or len(value) > 1000 or UNSAFE_TEXT.search(value):
                    raise LocalToolError("Desktop value is invalid.", "LOCAL_TOOL_ARGUMENTS")
                result = backend.set_value(element=element, value=value)
            # Every input consumes its capture. The next action must observe the
            # resulting state and obtain fresh human approval.
            self.captures.pop(scope["session_id"], None)
            return dataclasses.asdict(result) if dataclasses.is_dataclass(result) else result

    def close(self):
        self.closed = True
        atexit.unregister(self.close)
        with self.lock:
            for _, backend, manifest in self.backends.values():
                with contextlib.suppress(Exception):
                    _stop_driver(backend)
                manifest.unlink(missing_ok=True)
            self.backends.clear()
            self.captures.clear()
        return {"closed": True}

    def install(self):
        if self.server is None:
            raise LocalToolError("A gateway server is required.")
        methods = {"workbench.local-tools.catalog": self.catalog, "workbench.local-tools.mcp": self.mcp, "workbench.local-tools.desktop": self.desktop, "workbench.local-tools.close": lambda params: self.close()}
        for method, handler in methods.items():
            def dispatch(rid, params, fn=handler):
                try:
                    return self.server._ok(rid, fn(params or {}))
                except Exception as error:
                    return self.server._err(rid, 4120, _safe_text(error))
            self.server.register_method(method, dispatch)
        if hasattr(self.server, "_LONG_HANDLERS"):
            self.server._LONG_HANDLERS = frozenset(self.server._LONG_HANDLERS) | set(methods)
        return self
