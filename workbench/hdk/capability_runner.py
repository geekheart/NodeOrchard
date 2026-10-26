"""JSON-only process boundary for the fixed HDK capability implementations."""
import contextlib
import importlib
import json
from pathlib import Path
import sys
import traceback

ALLOWED = {
    'process_requirements': {'prepare_process_request', 'generate_process_requirements', 'validate_process_requirements'},
    'test_firmware': {'inspect_board', 'design_fixture', 'generate', 'compile', 'validate_build'},
    'test_sop': {'default_plan', 'render', 'verify'},
    'datasheets': {'collect', 'verify'},
}

def main():
    request = json.load(sys.stdin)
    module, method = request['module'], request['method']
    if module not in ALLOWED or method not in ALLOWED[module]:
        raise ValueError('Unsupported fixed capability operation')
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    try:
        with contextlib.redirect_stdout(sys.stderr):
            function = getattr(importlib.import_module('hdk.' + module), method)
            result = function(*request.get('args', []), **request.get('kwargs', {}))
        return {'ok': True, 'result': result}
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        return {'ok': False, 'errorType': type(error).__name__, 'message': str(error)}

if __name__ == '__main__':
    print(json.dumps(main(), ensure_ascii=False))
