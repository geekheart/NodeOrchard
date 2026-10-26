"""Trusted local Python function body runner; not an OS sandbox. Results use fd 3."""

import json
import math
import os
import sys
import textwrap

MAX_JSON_BYTES = 64 * 1024
MAX_REQUEST_BYTES = 600000
MAX_SAFE_INTEGER = 2**53 - 1


class OutputError(ValueError):
    def __init__(self, message, code="OUTPUT_INVALID"):
        super().__init__(message)
        self.code = code


def json_value(value, depth=0):
    if depth > 50:
        raise OutputError("结果嵌套过深。")
    if value is None or isinstance(value, (str, bool)):
        return
    if isinstance(value, int):
        if abs(value) > MAX_SAFE_INTEGER:
            raise OutputError("Python 整数超出 JavaScript 安全整数范围，请改为返回字符串，避免精度丢失。")
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise OutputError("代码必须返回有效 JSON 数据，不能返回 NaN 或 Infinity。")
        return
    if isinstance(value, list):
        for item in value:
            json_value(item, depth + 1)
        return
    if isinstance(value, dict) and all(isinstance(key, str) for key in value):
        for item in value.values():
            json_value(item, depth + 1)
        return
    raise OutputError("代码必须返回有效 JSON 数据，不能返回集合、元组或特殊对象。")


exit_code = 0
try:
    data = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if len(data) > MAX_REQUEST_BYTES:
        raise ValueError("代码请求过大。")
    request = json.loads(data)
    code = request.get("code")
    if not isinstance(code, str) or not code.strip() or len(code) > 100000:
        raise ValueError("代码函数体无效。")
    namespace = {"__name__": "__workflow__"}
    exec(compile("def main(input, context=None):\n" + textwrap.indent(code, "    ") + "\n", "<workflow-code>", "exec"), namespace)
    output = namespace["main"](request.get("input"), request.get("context", {}))
    json_value(output)
    encoded = json.dumps(output, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > MAX_JSON_BYTES:
        raise OutputError("代码输出不能超过 64KB JSON。", "OUTPUT_LIMIT")
    envelope = {"ok": True, "output": output}
except BaseException as error:
    envelope = {"ok": False, "error": {"code": getattr(error, "code", "CODE_FAILED"), "message": str(error)[:4000]}}
    exit_code = 1

try:
    sys.stdout.flush()
    sys.stderr.flush()
    with os.fdopen(3, "wb", closefd=True) as channel:
        channel.write((json.dumps(envelope, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n").encode("utf-8"))
        channel.flush()
finally:
    # A returned main() ends this operation even if user code started a thread
    # or installed an atexit hook. The parent reaps remaining child processes.
    os._exit(exit_code)
