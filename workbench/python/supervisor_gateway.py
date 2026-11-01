"""Native Hermes sessions with application tools attached through their real dispatcher.

This entry point is launched only inside the host's verified supervisor sandbox.
It does not install or modify Hermes. Native memory, skills, compression and tool
execution remain Hermes-owned; application mutations still cross the Node broker.
"""
from __future__ import annotations

import copy
import base64
import binascii
from contextlib import nullcontext
from contextvars import ContextVar
import inspect
import json
import os
from pathlib import Path
import re
import threading
import uuid
import weakref


class SupervisorPolicyError(ValueError):
    pass


DEFAULT_DENIED_TOOLS = frozenset({"cronjob", "cronjob_manage", "manage_connections"})
PREFIX = "nodeorchard_"
MAX_TOOLS = 128
ROUTE_TOOL = "conversation.route"
ROUTE_NAME = "nodeorchard_conversation_route"
INTENTS = frozenset({"workflow", "diagnose", "discuss", "feedback", "skill", "run", "review"})
MAX_IMAGES = 4
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_TOTAL_IMAGE_BYTES = 16 * 1024 * 1024


def _text(value, limit, *, minimum=1):
    return (isinstance(value, str) and minimum <= len(value) <= limit
            and not any(ord(char) < 32 or ord(char) == 127 for char in value))


def native_tool_name(name):
    if not _text(name, 96) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_.-]*", name):
        raise SupervisorPolicyError("Application tool name is invalid.")
    native = PREFIX + re.sub(r"[^A-Za-z0-9_]", "_", name)
    if len(native) > 64:
        raise SupervisorPolicyError("Application tool name exceeds the native function name limit.")
    return native


def tool_definitions(tools):
    if not isinstance(tools, list) or len(tools) > MAX_TOOLS:
        raise SupervisorPolicyError("Application tool catalog is invalid.")
    names, definitions = {}, []
    for entry in tools:
        if (not isinstance(entry, dict) or set(entry) != {"name", "description", "inputSchema"}
                or not isinstance(entry.get("description"), str) or len(entry["description"]) > 16000
                or not isinstance(entry.get("inputSchema"), dict) or entry["inputSchema"].get("type") != "object"):
            raise SupervisorPolicyError("Application tool definition is invalid.")
        name = native_tool_name(entry["name"])
        if name in names:
            raise SupervisorPolicyError("Application tool names collide after native encoding.")
        names[name] = entry["name"]
        definitions.append({"type": "function", "function": {"name": name,
            "description": entry["description"], "parameters": copy.deepcopy(entry["inputSchema"])}})
    # Check size, finite numbers and JSON-serializability before changing a live agent.
    try:
        if len(json.dumps(definitions, allow_nan=False).encode("utf-8")) > 256 * 1024:
            raise SupervisorPolicyError("Application tool catalog exceeds its size limit.")
    except (TypeError, ValueError) as error:
        raise SupervisorPolicyError("Application tool catalog is not finite JSON.") from error
    return names, definitions


def _image_bytes(images):
    if not isinstance(images, list) or len(images) > MAX_IMAGES:
        raise SupervisorPolicyError("Native supervisor accepts at most four images.")
    checked, total = [], 0
    for image in images:
        if (not isinstance(image, dict) or set(image) != {"mimeType", "data"}
                or not isinstance(image.get("data"), str) or len(image["data"]) > 4 * ((MAX_IMAGE_BYTES + 2) // 3)):
            raise SupervisorPolicyError("Native image content is invalid or exceeds its size limit.")
        try:
            data = base64.b64decode(image["data"], validate=True)
        except (ValueError, binascii.Error) as error:
            raise SupervisorPolicyError("Native image content is not canonical base64.") from error
        mime = ("image/png" if data.startswith(b"\x89PNG\r\n\x1a\n") else
                "image/jpeg" if data.startswith(b"\xff\xd8\xff") else
                "image/webp" if data.startswith(b"RIFF") and data[8:12] == b"WEBP" else
                "image/gif" if data.startswith((b"GIF87a", b"GIF89a")) else None)
        total += len(data)
        if mime is None or image.get("mimeType") != mime or len(data) > MAX_IMAGE_BYTES or total > MAX_TOTAL_IMAGE_BYTES:
            raise SupervisorPolicyError("Native image signature, MIME or total byte limit is invalid.")
        checked.append((mime, data))
    return checked


def _image_content(checked):
    return [{"type": "image_url", "image_url": {"url": "data:" + mime + ";base64," + base64.b64encode(data).decode("ascii")}}
            for mime, data in checked]


def image_parts(images):
    return _image_content(_image_bytes(images))


def _capture_images(result, original_tool):
    """Move trusted capture bytes across the sandbox without leaking base64 text."""
    if not isinstance(result, dict) or "_nodeorchard_images" not in result:
        return result
    if original_tool != "browser.capture":
        raise SupervisorPolicyError("Private capture images are only admitted for browser.capture.")
    checked = _image_bytes(result["_nodeorchard_images"])
    home = os.environ.get("HERMES_HOME")
    if not isinstance(home, str) or not Path(home).is_absolute():
        raise SupervisorPolicyError("Native capture images require the private Hermes home.")
    directory = Path(home)
    if directory.is_symlink() or not directory.is_dir() or directory.resolve() != directory:
        raise SupervisorPolicyError("Native capture home must be a real private directory.")
    for component in ("cache", "nodeorchard-captures"):
        directory /= component
        directory.mkdir(mode=0o700, exist_ok=True)
        if directory.is_symlink() or not directory.is_dir() or directory.resolve() != directory:
            raise SupervisorPolicyError("Native capture cache cannot use symbolic links.")
    extensions = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif"}
    created = []
    try:
        for mime, data in checked:
            target = directory / (uuid.uuid4().hex + extensions[mime])
            descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
            created.append(target)
            with os.fdopen(descriptor, "wb") as image:
                image.write(data)
    except Exception:
        for target in created:
            target.unlink(missing_ok=True)
        raise
    public = {key: value for key, value in result.items() if key != "_nodeorchard_images"}
    public["images"] = [str(path) for path in created]
    public["readWith"] = "图像内容由 Hermes 按当前模型和提供商的支持情况传递。若仅收到文字摘要，先用 read_file 或 vision_analyze 读取 images 中的私有副本，再判断画面；文件路径和截图回执本身不证明图像内容。"
    summary = json.dumps(public, ensure_ascii=False, allow_nan=False)
    return {"_multimodal": True, "content": [{"type": "text", "text": summary}, *_image_content(checked)], "text_summary": summary}


class NativeSupervisorGateway:
    def __init__(self, server, registry, requests, *, model_tools=None, tool_executor=None, isolation_verified=None, trace_factory=None):
        self.server, self.registry, self.requests = server, registry, requests
        self.model_tools, self.tool_executor = model_tools, tool_executor
        self.trace_factory = trace_factory
        self.isolation_verified = (os.environ.get("WORKBENCH_SUPERVISOR_ISOLATED") == "1"
            if isolation_verified is None else isolation_verified is True)
        self.lock = threading.RLock()
        self.sessions = {}
        self.agents = weakref.WeakKeyDictionary()
        self.registered = set()
        self.call_context = ContextVar("nodeorchard_supervisor_tool_call", default={})
        self.denied_tools = set(DEFAULT_DENIED_TOOLS)
        self.installed = False

    def _binding(self, identities):
        return next((self.sessions[value] for value in identities if value and value in self.sessions), None)

    def _remember_agent(self, agent, binding):
        identity = getattr(agent, "session_id", None)
        if identity:
            binding["identities"].add(identity)
            self.sessions[identity] = binding
        self.agents[agent] = binding

    def _register(self, definition):
        name = definition["function"]["name"]
        if name in self.registered:
            return
        # A namespace collision with a third-party plugin is not an override grant.
        if self.registry.get_entry(name) is not None:
            raise SupervisorPolicyError("Native application tool namespace is already registered.")

        def handler(args, task_id=None, session_id=None, tool_call_id=None, **_context):
            context = self.call_context.get()
            return self.invoke(name, args, task_id=task_id, session_id=session_id,
                tool_call_id=tool_call_id or context.get("tool_call_id"))

        self.registry.register(name=name, toolset="nodeorchard", schema=copy.deepcopy(definition["function"]), handler=handler)
        self.registered.add(name)

    def _attach(self, agent, binding):
        self._remember_agent(agent, binding)
        # Re-prepare refreshes only application schemas. Native agent state, tool
        # loop, memory managers, history and compression engines are untouched.
        native = [row for row in getattr(agent, "tools", [])
                  if not row.get("function", {}).get("name", "").startswith(PREFIX)
                  and row.get("function", {}).get("name") not in self.denied_tools]
        agent.tools = native + copy.deepcopy(binding["definitions"])
        agent.valid_tool_names = {row["function"]["name"] for row in agent.tools}
        if getattr(agent, "enabled_toolsets", None) is not None:
            agent.enabled_toolsets = list(dict.fromkeys([*agent.enabled_toolsets, "nodeorchard"]))
        if not hasattr(agent, "_nodeorchard_native_base_prompt"):
            agent._nodeorchard_native_base_prompt = getattr(agent, "ephemeral_system_prompt", None) or ""
        agent.ephemeral_system_prompt = "\n\n".join(part for part in [
            agent._nodeorchard_native_base_prompt, binding["system_prompt"]] if part)
        agent._cached_system_prompt = None
        agent._cached_system_prompt_static = None
        if binding.get("tracer") is not None:
            try:
                binding["tracer"].attach_agent(agent)
            except Exception:
                binding["tracer"].unavailable("TRACE_HOOK_UNAVAILABLE")
        self._guard_turn(agent)

    def _guard_turn(self, agent):
        """Installed at native gateway wiring, before any host prepare exists.

        Agent construction and memory loading remain native. A resume, queued
        turn or background gateway callback cannot enter run_conversation until
        the current human turn has received fresh host admission.
        """
        if getattr(agent, "_nodeorchard_native_turn_guard", False):
            return
        original = agent.run_conversation
        signature = inspect.signature(original)

        def run(*args, **kwargs):
            with self.lock:
                current = self.agents.get(agent)
                if current is None or not current["prepared"] or current["active"]:
                    raise SupervisorPolicyError("Native supervisor turn requires fresh host preparation.")
                self._attach(agent, current)
                current["prepared"], current["active"] = False, True
                current["used_turns"].add(current["turn_id"])
                images, current["images"] = current["images"], []
            try:
                bound = signature.bind(*args, **kwargs)
                if images:
                    message = bound.arguments.get("user_message")
                    if not isinstance(message, (str, list)):
                        raise SupervisorPolicyError("Native user message cannot receive images.")
                    parts = [{"type": "text", "text": message}] if isinstance(message, str) else copy.deepcopy(message)
                    parts.extend(images)
                    bound.arguments["user_message"] = parts
                    if "persist_user_message" in signature.parameters:
                        bound.arguments["persist_user_message"] = parts
                tracer = current.get("tracer")
                with tracer.turn() if tracer is not None else nullcontext():
                    result = original(*bound.args, **bound.kwargs)
                if not current["route_admitted"]:
                    raise SupervisorPolicyError("Native supervisor did not classify this human message; no application operation was admitted.")
                return result
            finally:
                with self.lock:
                    current["active"] = False

        run.__signature__ = signature
        agent.run_conversation = run
        agent._nodeorchard_native_turn_guard = True

    def prepare(self, params, rid=None):
        allowed = {"session_id", "turn_id", "capability_token", "tools", "system_prompt", "isolation", "cwd", "denied_tools", "request_id", "images"}
        if (not isinstance(params, dict) or set(params) - allowed
                or not {"session_id", "turn_id", "capability_token", "tools", "system_prompt", "isolation"} <= set(params)
                or not _text(params.get("session_id"), 256) or not _text(params.get("turn_id"), 256)
                or not _text(params.get("capability_token"), 256, minimum=16)
                or not isinstance(params.get("system_prompt"), str) or len(params["system_prompt"]) > 64000):
            raise SupervisorPolicyError("Native supervisor preparation is invalid.")
        isolation = params["isolation"]
        if (not self.isolation_verified or not isinstance(isolation, dict) or set(isolation) != {"verified", "kind"}
                or isolation.get("verified") is not True or isolation.get("kind") != "seatbelt"):
            raise SupervisorPolicyError("Native supervisor requires a verified OS sandbox; no host fallback.")
        denied = params.get("denied_tools", [])
        if not isinstance(denied, list) or len(denied) > 128 or any(not _text(name, 128) for name in denied):
            raise SupervisorPolicyError("Native supervisor denied tools are invalid.")
        names, definitions = tool_definitions(params["tools"])
        images = image_parts(params.get("images", []))
        request_id = params.get("request_id")
        if "request_id" in params:
            try:
                if not isinstance(request_id, str) or str(uuid.UUID(request_id)) != request_id:
                    raise ValueError()
            except (TypeError, ValueError, AttributeError) as error:
                raise SupervisorPolicyError("Native request_id must be a canonical UUID.") from error
        if ROUTE_NAME not in names or names[ROUTE_NAME] != ROUTE_TOOL:
            raise SupervisorPolicyError("Native supervisor requires the host's AI intent routing tool.")
        session, error = self.server._sess({"session_id": params["session_id"]}, rid)
        if error:
            return error
        if session.get("running"):
            raise SupervisorPolicyError("Native supervisor session is still running.")
        agent = session.get("agent")
        if agent is None or not callable(getattr(agent, "run_conversation", None)):
            raise SupervisorPolicyError("Hermes native supervisor agent is unavailable.")
        if getattr(agent, "api_mode", "") == "codex_app_server":
            raise SupervisorPolicyError("This Hermes runtime cannot attach native application function tools.")
        if "cwd" in params:
            if (not isinstance(params["cwd"], str) or not Path(params["cwd"]).is_absolute()
                    or Path(params["cwd"]).resolve() != Path(session.get("cwd") or "").resolve()):
                raise SupervisorPolicyError("Native supervisor working directory differs from its session.")
        with self.lock:
            identities = {params["session_id"], session.get("session_key"), getattr(agent, "session_id", None)} - {None, ""}
            binding = self._binding(identities)
            if binding is not None and (binding["active"] or params["turn_id"] in binding["used_turns"]):
                raise SupervisorPolicyError("Native supervisor turn already submitted; it will not be replayed.")
            for definition in definitions:
                self._register(definition)
            self.denied_tools.update(denied)
            if binding is None:
                binding = {"identities": set(), "used_turns": set(), "active": False}
            binding.update({"sid": params["session_id"], "turn_id": params["turn_id"],
                "capability_token": params["capability_token"], "names": names, "definitions": definitions,
                "system_prompt": params["system_prompt"], "prepared": True, "route_admitted": False, "images": images})
            if self.trace_factory is not None:
                if "tracer" not in binding:
                    binding["tracer"] = self.trace_factory(lambda trace: self.server._emit(
                        "model.request.trace", binding["sid"], {"trace": trace}), request_id=request_id)
                else:
                    binding["tracer"].set_request_id(request_id)
            binding["identities"].update(identities)
            for identity in binding["identities"]:
                self.sessions[identity] = binding
            self._attach(agent, binding)
            return {"policy": {"nativeAgent": True, "toolsAllowed": True, "memoryAllowed": True,
                "applicationTools": "native-functions", "isolationVerified": True},
                "tools": [{"name": original, "nativeName": native} for native, original in names.items()],
                "nativeTools": sorted(agent.valid_tool_names - set(names)), "deniedTools": sorted(self.denied_tools),
                "attachedImages": len(images), "requestId": request_id}

    def invoke(self, native_name, arguments, *, task_id=None, session_id=None, tool_call_id=None):
        with self.lock:
            binding = self._binding((session_id, task_id))
            if binding is None or not binding["active"] or native_name not in binding["names"]:
                return json.dumps({"error": "Application tool is not authorized for this native session.", "code": "supervisor_scope_denied"})
            if not binding["route_admitted"] and native_name != ROUTE_NAME:
                return json.dumps({"error": "First classify this human message with nodeorchard_conversation_route.", "code": "supervisor_route_required"})
            # Identity fields come exclusively from the host-prepared binding,
            # never from model arguments or child-agent inherited environment.
            sid = binding["sid"]
            payload = {"turn_id": binding["turn_id"], "capability_token": binding["capability_token"],
                "tool": binding["names"][native_name], "arguments": arguments,
                "call_id": tool_call_id if _text(tool_call_id, 256) else str(uuid.uuid4())}
        result = self.requests.send("workbench.tool.call", sid, payload, timeout=None)
        if result is None:
            return json.dumps({"error": "Application tool request was cancelled or rejected; it was not replayed.", "code": "supervisor_tool_cancelled"})
        if native_name == ROUTE_NAME and isinstance(result, dict) and result.get("accepted") is True:
            intent = arguments.get("intent") if isinstance(arguments, dict) else None
            if intent in INTENTS and result.get("intent") == intent:
                with self.lock:
                    # A late callback cannot admit a different human turn.
                    if binding["active"] and binding["turn_id"] == payload["turn_id"]:
                        binding["route_admitted"] = True
        if isinstance(result, dict) and "_nodeorchard_images" in result:
            with self.lock:
                if not binding["active"] or binding["turn_id"] != payload["turn_id"]:
                    return json.dumps({"error": "Capture result belongs to an ended native turn.", "code": "supervisor_tool_cancelled"})
            # This is Hermes' native multimodal tool-result envelope. Its own
            # provider adapter chooses image parts or the safe text fallback.
            # Other application data remains JSON text, never an implicit image
            # envelope selected by a workflow/tool-result payload.
            return _capture_images(result, payload["tool"])
        return json.dumps(result, ensure_ascii=False, allow_nan=False)

    def _route_block(self, binding, name):
        return binding is not None and not binding.get("route_admitted") and name != ROUTE_NAME

    def _blocked(self, name, arguments):
        if name in self.denied_tools:
            return True
        if name == "tool_call" and isinstance(arguments, dict):
            rows = arguments.get("calls", [arguments])
            return isinstance(rows, list) and any(isinstance(row, dict) and self._blocked(
                row.get("name", row.get("tool_name")), row.get("arguments", {})) for row in rows)
        return False

    def install(self):
        if self.installed:
            return self
        self.server.register_method("workbench.supervisor.prepare", self.prepare_rpc)
        self.server._LONG_HANDLERS = frozenset(self.server._LONG_HANDLERS) | {"workbench.supervisor.prepare"}

        def no_auto_continue(_sid, _session, _session_key):
            # A crash marker is evidence of an interrupted operation, never a
            # new human instruction. Do not read, clear, or resubmit its prompt.
            return None

        self.server._maybe_schedule_auto_continue = no_auto_continue
        auto_module = getattr(self.server, "_session_auto_continue", None)
        if auto_module is not None:
            auto_module._maybe_schedule_auto_continue = no_auto_continue
        # Native split helpers are rebound onto server globals. Cover the
        # actual callable namespaces as well, so an import/alias cannot keep
        # the old scheduling path in a second globals dictionary.
        for name in ("_resume_cold", "_resume_eager", "_schedule_resume_hydration"):
            namespace = getattr(getattr(self.server, name, None), "__globals__", None)
            if isinstance(namespace, dict):
                namespace["_maybe_schedule_auto_continue"] = no_auto_continue
        wire = self.server._wire_session_agent

        def wire_agent(sid, key, agent):
            # Wire-time admission must precede the native callback wiring:
            # resume can build an agent before workbench.supervisor.prepare.
            self._guard_turn(agent)
            result = wire(sid, key, agent)
            with self.lock:
                binding = self._binding((sid, key, getattr(agent, "session_id", None)))
                if binding is not None:
                    self._attach(agent, binding)
            return result

        self.server._wire_session_agent = wire_agent
        if self.model_tools is not None:
            original = self.model_tools.handle_function_call
            signature = inspect.signature(original)

            def handle(*args, **kwargs):
                bound = signature.bind(*args, **kwargs)
                binding = self._binding((bound.arguments.get("session_id"), bound.arguments.get("task_id")))
                if self._route_block(binding, bound.arguments["function_name"]):
                    return json.dumps({"error": "First classify this human message with nodeorchard_conversation_route.", "code": "supervisor_route_required"})
                if self._blocked(bound.arguments["function_name"], bound.arguments.get("function_args")):
                    return json.dumps({"error": "This native tool requires an unsupported external lifecycle or configuration permission.", "code": "supervisor_tool_unavailable"})
                token = self.call_context.set({"tool_call_id": bound.arguments.get("tool_call_id")})
                try:
                    return original(*args, **kwargs)
                finally:
                    self.call_context.reset(token)

            self.model_tools.handle_function_call = handle
        if self.tool_executor is not None:
            original_pre = self.tool_executor._pre_tool_block

            def pre(agent, ref):
                with self.lock:
                    binding = self.agents.get(agent)
                    if binding is not None:
                        self._remember_agent(agent, binding)
                if self._route_block(binding, ref.name):
                    return "First classify this human message with nodeorchard_conversation_route.", ref.args
                if self._blocked(ref.name, ref.args):
                    return "This native tool is unavailable in the isolated supervisor runtime.", ref.args
                return original_pre(agent, ref)

            self.tool_executor._pre_tool_block = pre
        self.installed = True
        return self

    def prepare_rpc(self, rid, params):
        try:
            result = self.prepare(params, rid)
            return result if isinstance(result, dict) and "jsonrpc" in result else self.server._ok(rid, result)
        except SupervisorPolicyError as error:
            return self.server._err(rid, 4400, str(error))


def install_tool_request_contract():
    """Declare the extra request only in this child; upstream files stay untouched."""
    from pydantic import ConfigDict
    from tui_gateway.contracts.base import Params, Result, JsonValue
    from tui_gateway.contracts import registry as contracts

    class ToolRequest(Params):
        session_id: str
        turn_id: str
        capability_token: str
        tool: str
        arguments: JsonValue
        call_id: str

    class ToolResult(Result):
        model_config = ConfigDict(extra="allow")

    if "workbench.tool.call" not in contracts.SERVER_REQUESTS:
        contracts.server_request("workbench.tool.call", params=ToolRequest, result=ToolResult)


def main():
    # Match Hermes' supported entry bootstrap before loading its packages.
    import hermes_bootstrap
    hermes_bootstrap.harden_import_path()
    from tui_gateway import server, server_requests
    from tools.registry import registry
    from agent import tool_executor
    import model_tools
    from model_request_trace import ModelRequestTracer
    install_tool_request_contract()
    NativeSupervisorGateway(server, registry, server_requests, model_tools=model_tools, tool_executor=tool_executor,
        trace_factory=ModelRequestTracer).install()
    from tui_gateway import entry
    entry.main()


if __name__ == "__main__":
    main()
