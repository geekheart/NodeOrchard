"""Attempt-bound callbacks for workflow desktop and configured MCP tools.

Hermes keeps its tool loop. The host owns the live attempt, human permissions,
approved desktop targets, configured connections and individual write approvals.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path
import re
import threading
import uuid

from workflow_integrations import WorkflowIntegrations

_TEXT = {"type": "string", "maxLength": 160}
DESKTOP_SCHEMA = {
    "type": "object",
    "properties": {
        "action": {"type": "string", "enum": ["capture", "list_apps", "list_windows", "click", "double_click", "right_click", "scroll", "type", "key", "set_value"]},
        "app": copy.deepcopy(_TEXT), "mode": {"type": "string", "enum": ["som", "ax", "vision"]},
        "captureId": copy.deepcopy(_TEXT), "element": {"type": "integer", "minimum": 0},
        "coordinate": {"type": "array", "minItems": 2, "maxItems": 2, "items": {"type": "integer", "minimum": 0, "maximum": 32768}},
        "text": {"type": "string", "maxLength": 4000},
        "keys": copy.deepcopy(_TEXT),
        "direction": {"type": "string", "enum": ["up", "down", "left", "right"]}, "amount": {"type": "integer", "minimum": 1, "maximum": 20}, "value": {"type": "string", "maxLength": 1000},
    }, "required": ["action", "app"], "additionalProperties": False,
}


def is_local_tool(name):
    return isinstance(name, str) and (name == "computer_use" or name.startswith("mcp__"))


def local_tool_call(name, arguments):
    if is_local_tool(name):
        return True
    if name != "tool_call" or not isinstance(arguments, dict):
        return False
    rows = arguments.get("calls", [arguments])
    return isinstance(rows, list) and any(isinstance(row, dict) and is_local_tool(row.get("name", row.get("tool_name"))) for row in rows)


def connection_management(name, arguments):
    if name == "manage_connections":
        return True
    if name != "tool_call" or not isinstance(arguments, dict):
        return False
    rows = arguments.get("calls", [arguments])
    return isinstance(rows, list) and any(isinstance(row, dict) and row.get("name", row.get("tool_name")) == "manage_connections" for row in rows)


def replace_desktop_definitions(definitions):
    result = copy.deepcopy(definitions)
    for definition in result:
        function = definition.get("function", {}) if isinstance(definition, dict) else {}
        if function.get("name") == "computer_use":
            function["description"] = ("操作用户批准的本机应用。先capture获取captureId和窗口图像，再引用该captureId点击、输入或滚动。"
                "应用、系统权限和每次修改由宿主检查；不能操作未批准的窗口或更改权限。")
            function["parameters"] = copy.deepcopy(DESKTOP_SCHEMA)
    return result


class WorkflowLocalIntegrations(WorkflowIntegrations):
    def catalog(self):
        result = super().catalog()
        # A native driver's schema is not the schema exposed by the host broker.
        # Bind capability admission to the actual workflow-facing definition.
        result["revision"] = "sha256:" + hashlib.sha256(json.dumps({"native": result["revision"], "desktop": DESKTOP_SCHEMA},
            sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
        return result

    def definitions(self, required, names):
        return replace_desktop_definitions(super().definitions(required, names))


def _valid_uuid(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value
    except (ValueError, TypeError, AttributeError):
        return False


def _error(message, code="workbench_local_tool_blocked"):
    return json.dumps({"error": message, "code": code})


def _capture_result(result, run):
    if not isinstance(result, dict) or "_nodeorchard_images" not in result:
        return result
    from supervisor_gateway import _image_bytes, _image_content
    checked = _image_bytes(result["_nodeorchard_images"])
    workspace = Path(run["workspace"])
    if not workspace.is_absolute() or workspace.is_symlink() or workspace.resolve() != workspace or not workspace.is_dir():
        raise ValueError("Workflow capture workspace is unavailable.")
    count, total = run.get("local_capture_count", 0), run.get("local_capture_bytes", 0)
    if count + len(checked) > 16 or total + sum(len(data) for _, data in checked) > 64 * 1024 * 1024:
        raise ValueError("Workflow capture limit was reached.")
    directory = workspace
    for name in (".workbench-artifacts", run["run_id"], "local-captures"):
        directory /= name
        if directory.is_symlink():
            raise ValueError("Workflow capture directory cannot be a symbolic link.")
        directory.mkdir(mode=0o700, exist_ok=True)
        if not directory.is_dir() or directory.resolve() != directory:
            raise ValueError("Workflow capture directory changed.")
    extensions = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif"}
    files = []
    try:
        for mime, data in checked:
            target = directory / (uuid.uuid4().hex + extensions[mime])
            descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
            files.append(target)
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(data)
    except Exception:
        for path in files:
            path.unlink(missing_ok=True)
        raise
    run["local_capture_count"] = count + len(checked)
    run["local_capture_bytes"] = total + sum(len(data) for _, data in checked)
    public = {key: value for key, value in result.items() if key != "_nodeorchard_images"}
    public["images"] = [str(path) for path in files]
    public["readWith"] = "若模型仅收到文字摘要，请先用read_file或vision_analyze读取images中的当前尝试截图，再判断画面。"
    summary = json.dumps(public, ensure_ascii=False, allow_nan=False)
    return {"_multimodal": True, "content": [{"type": "text", "text": summary}, *_image_content(checked)], "text_summary": summary}


class WorkflowLocalTools:
    def __init__(self, requests):
        self.requests = requests
        self.lock = threading.RLock()

    def call(self, run, tool, arguments, call_id=None):
        if (not isinstance(run, dict) or run.get("finished") is not False or not _valid_uuid(run.get("run_id"))
                or not _valid_uuid(run.get("local_tool_token")) or not isinstance(run.get("sid"), str) or not run["sid"]):
            return _error("Local tools require the current host-admitted workflow attempt.")
        if not is_local_tool(tool) or not isinstance(arguments, dict):
            return _error("Only declared workflow desktop or MCP tools can use this callback.")
        try:
            if len(json.dumps(arguments, allow_nan=False).encode()) > 65536:
                return _error("Local tool arguments exceed the attempt limit.")
        except (TypeError, ValueError):
            return _error("Local tool arguments must be finite JSON.")
        payload = {"attempt_id": run["run_id"], "capability_token": run["local_tool_token"], "tool": tool, "arguments": arguments,
            "call_id": call_id if isinstance(call_id, str) and re.fullmatch(r"[^\x00-\x1f\x7f]{1,256}", call_id) else str(uuid.uuid4())}
        result = self.requests.send("workbench.local-tools.call", run["sid"], payload, timeout=None)
        if result is None or run.get("finished") is not False:
            return _error("The workflow attempt ended or its local tool request was cancelled; it was not replayed.", "workbench_local_tool_cancelled")
        try:
            with self.lock:
                if run.get("finished") is not False:
                    return _error("The workflow attempt already ended.", "workbench_local_tool_cancelled")
                if isinstance(result, dict) and "_nodeorchard_images" in result:
                    # These bytes arrived through the host's authenticated
                    # attempt callback, not through model arguments. MCP image
                    # content uses the same signature/size admission as desktop.
                    return _capture_result(result, run)
                return json.dumps(result, ensure_ascii=False, allow_nan=False)
        except (ValueError, TypeError, OSError):
            return _error("Local tool result or desktop image could not be admitted.", "workbench_local_image_rejected")


def install_local_tool_request_contract():
    from pydantic import ConfigDict
    from tui_gateway.contracts.base import Params, Result, JsonValue
    from tui_gateway.contracts import registry as contracts

    class LocalToolRequest(Params):
        session_id: str
        attempt_id: str
        capability_token: str
        tool: str
        arguments: JsonValue
        call_id: str

    class LocalToolResult(Result):
        model_config = ConfigDict(extra="allow")

    if "workbench.local-tools.call" not in contracts.SERVER_REQUESTS:
        contracts.server_request("workbench.local-tools.call", params=LocalToolRequest, result=LocalToolResult)
