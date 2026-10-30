"""Compile workflow function bodies without rewriting their literal contents.

This module only parses and compiles. Importing it never executes a workflow,
imports a workflow dependency, or starts the worker's request loop.
"""

import ast
import json
import sys
import warnings

MAX_CODE_CHARACTERS = 100000
MAX_REQUEST_BYTES = 600000
MAX_SCRIPT_VARIABLES = 8
LIMITS = {"maxCodeCharacters": MAX_CODE_CHARACTERS, "maxRequestBytes": MAX_REQUEST_BYTES,
          "maxPythonScriptVariables": MAX_SCRIPT_VARIABLES, "maxNestedScriptCharacters": MAX_CODE_CHARACTERS}


def _parse_body(source, filename):
    if not isinstance(source, str) or not source.strip() or len(source) > MAX_CODE_CHARACTERS:
        raise ValueError("代码函数体无效。")
    try:
        return ast.parse(source, filename=filename, mode="exec")
    except IndentationError as original:
        # Previously accepted uniformly indented function bodies remain valid.
        # Add an enclosing statement rather than dedenting source text, which
        # would change whitespace inside triple-quoted strings again.
        if original.msg != "unexpected indent":
            raise
        try:
            enclosed = ast.parse("if True:\n" + source, filename=filename, mode="exec")
        except SyntaxError:
            raise original
        ast.increment_lineno(enclosed, -1)
        return ast.Module(body=enclosed.body[0].body, type_ignores=[])


def _wrap_body(parsed):
    if not parsed.body:
        raise SyntaxError("代码函数体至少需要一条语句。")
    function = ast.parse("def main(input, context=None):\n    pass\n").body[0]
    function.body = parsed.body
    function.end_lineno = parsed.body[-1].end_lineno
    function.end_col_offset = parsed.body[-1].end_col_offset
    return ast.fix_missing_locations(ast.Module(body=[function], type_ignores=parsed.type_ignores))


def workflow_body_tree(source, filename="<workflow-code>"):
    return _wrap_body(_parse_body(source, filename))


def compile_workflow_body(source, filename="<workflow-code>"):
    return compile(workflow_body_tree(source, filename), filename, "exec")


def _error(error):
    return {"type": type(error).__name__, "message": str(getattr(error, "msg", error))[:240],
            "line": getattr(error, "lineno", None), "column": getattr(error, "offset", None)}


def _script_variables(value):
    if value is None:
        return []
    if (not isinstance(value, list) or len(value) > MAX_SCRIPT_VARIABLES
            or any(not isinstance(name, str) or not name.isascii() or not name.isidentifier()
                   or len(name) > 80 or name.startswith("__") for name in value)
            or len(set(value)) != len(value)):
        raise ValueError("嵌套脚本变量名必须为最多 8 个不同的 ASCII 标识符。")
    return value


def _literal_script(value):
    if isinstance(value, ast.Constant) and isinstance(value.value, str):
        return value.value, "literal"
    if (isinstance(value, ast.Call) and isinstance(value.func, ast.Attribute) and value.func.attr == "replace"
            and len(value.args) == 2 and not value.keywords):
        nested = _literal_script(value.func.value)
        if nested:
            return nested[0], "literal-template"
    return None


def _check_scripts(function, variables):
    results = []
    for name in variables:
        writes = [node for node in ast.walk(function) if isinstance(node, ast.Name)
                  and node.id == name and isinstance(node.ctx, (ast.Store, ast.Del))]
        assignments = [node for node in function.body if isinstance(node, (ast.Assign, ast.AnnAssign))
                       and any(isinstance(target, ast.Name) and target.id == name
                               for target in (node.targets if isinstance(node, ast.Assign) else [node.target]))]
        literal = _literal_script(assignments[0].value) if len(writes) == 1 and len(assignments) == 1 else None
        result = {"variable": name, "status": "unavailable", "kind": None, "substitutionsEvaluated": False}
        if literal is None:
            result["reason"] = "只检查单次直接赋值的字符串字面量或 replace 模板；动态内容及多次赋值不可静态确认。"
        else:
            source, kind = literal
            result["kind"] = kind
            if len(source) > MAX_CODE_CHARACTERS:
                result["reason"] = "嵌套脚本超过静态检查字符限制。"
            else:
                try:
                    compile(source, "<declared-python-script>", "exec")
                    result["status"] = "valid"
                except (SyntaxError, ValueError, TypeError, RecursionError, MemoryError) as error:
                    result["status"] = "invalid"
                    result["error"] = _error(error)
        results.append(result)
    return results


def check_workflow_body(source, python_script_variables=None):
    result = {"version": 1, "language": "python", "analysisOnly": True, "executed": False,
              "status": "invalid", "body": {"valid": False}, "wrapper": None, "nestedScripts": [], "limits": LIMITS,
              "limitations": ["仅检查语法与函数体包装，不导入依赖，不执行代码，不保证业务、环境或产物正确。",
                              "默认不检查多行文本是否为 Python；嵌套脚本仅检查显式指定的静态字符串。"]}
    try:
        variables = _script_variables(python_script_variables)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            parsed = _parse_body(source, "<workflow-code>")
            original_strings = [node.value for node in ast.walk(parsed) if isinstance(node, ast.Constant) and isinstance(node.value, str)]
            wrapped = _wrap_body(parsed)
            compile(wrapped, "<workflow-code>", "exec")
            nested = _check_scripts(wrapped.body[0], variables)
        wrapped_strings = [node.value for node in ast.walk(wrapped) if isinstance(node, ast.Constant) and isinstance(node.value, str)]
        result["body"] = {"valid": True}
        result["wrapper"] = {"kind": "ast-function", "stringConstantsPreserved": original_strings == wrapped_strings,
                             "sourceStringConstants": len(original_strings), "wrappedStringConstants": len(wrapped_strings)}
        result["nestedScripts"] = nested
        result["status"] = "invalid" if any(item["status"] == "invalid" for item in nested) else "valid"
        if any(item["kind"] == "literal-template" for item in nested):
            result["limitations"].append("模板仅检查替换前字面量语法，不执行 replace 参数，不能确认动态替换后的实际脚本。")
    except (SyntaxError, ValueError, TypeError, RecursionError, MemoryError) as error:
        result["body"]["error"] = _error(error)
    return result


def main():
    try:
        data = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
        if len(data) > MAX_REQUEST_BYTES:
            raise ValueError("静态检查请求过大。")
        request = json.loads(data)
        if not isinstance(request, dict) or set(request) - {"code", "pythonScriptVariables"}:
            raise ValueError("静态检查参数无效。")
        result = check_workflow_body(request.get("code"), request.get("pythonScriptVariables"))
    except (ValueError, TypeError, RecursionError) as error:
        result = {"version": 1, "language": "python", "analysisOnly": True, "executed": False,
                  "status": "unavailable", "error": _error(error), "limits": LIMITS}
    print(json.dumps(result, ensure_ascii=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
