"""One source-bound Pinout capability, reused by learning and four-file runs."""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]
PRIVATE = ROOT / '.local/pinout-contexts'
OUTPUTS = ROOT / 'workspaces/pinout'
PYTHON = Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3'
CONTRACT = ROOT / 'hdk/learning/pinout/reference-contract.json'
STAGES = ('prepare', 'render', 'verify')


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_json(path, value):
    from hdk.four_files_pipeline import _write
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    _write(path, value)


def _run(operation):
    ident = os.environ.get('WORKBENCH_RUN_ID', '')
    if str(uuid.UUID(ident)) != ident or os.environ.get('WORKBENCH_NODE_ID') != 'pinout-' + operation:
        raise ValueError('Pinout 操作必须来自对应工作流节点。')
    with sqlite3.connect('file:' + str(ROOT / '.local/workbench.sqlite') + '?mode=ro', uri=True) as db:
        row = db.execute('SELECT value FROM workflow_runs WHERE id=?', (ident,)).fetchone()
    run = json.loads(row[0]) if row else {}
    if run.get('currentNodeId') != 'pinout-' + operation or run.get('workflowId') != os.environ.get('WORKBENCH_WORKFLOW_ID') or run.get('learningId', '') != os.environ.get('WORKBENCH_LEARNING_ID', ''):
        raise ValueError('Pinout 上下文与不可变运行快照不一致。')
    return run


def validate_input(value):
    from hdk.four_files_pipeline import validate_input as validate_four_input
    fields = {'sourcePath', 'productCode', 'hardwareVersion', 'releaseDate', 'images', 'pinoutPhotoProfilePath',
              'nativeReportPath', 'nativeReportSha256', 'viewSides'}
    if not isinstance(value, dict) or set(value) != fields:
        raise ValueError('Pinout 输入须提供源工程、两面照片、校准、已核验原生报告及 viewSides。')
    request = validate_four_input({key: value[key] for key in fields - {'nativeReportPath', 'nativeReportSha256', 'viewSides'}})
    sides = value['viewSides']
    if not isinstance(sides, list) or not sides or len(sides) > 2 or any(not isinstance(side, str) or side not in ('front', 'back') for side in sides) or len(set(sides)) != len(sides):
        raise ValueError('viewSides 需要不重复的 front/back。')
    report = Path(value['nativeReportPath']).expanduser().resolve()
    if not report.is_file() or not re.fullmatch(r'[a-f0-9]{64}', str(value['nativeReportSha256'])) or sha(report) != value['nativeReportSha256']:
        raise ValueError('原生编号报告哈希不一致。')
    # Admit only a completed, immutable four-file run and its exact private receipt.
    if not report.is_relative_to(ROOT / 'workspaces/four-files'):
        raise ValueError('原生报告必须来自已完成的四文件工作流。')
    run_id = report.relative_to(ROOT / 'workspaces/four-files').parts[0]
    if str(uuid.UUID(run_id)) != run_id:
        raise ValueError('原生证据没有真实运行标识。')
    with sqlite3.connect('file:' + str(ROOT / '.local/workbench.sqlite') + '?mode=ro', uri=True) as db:
        row = db.execute('SELECT value FROM workflow_runs WHERE id=?', (run_id,)).fetchone()
    native_run = json.loads(row[0]) if row else {}
    context = json.loads((ROOT / '.local/four-files-contexts' / (run_id + '.json')).read_text())
    native = json.loads(report.read_text())
    if (native_run.get('status') != 'complete' or native_run.get('workflowId') != 'workflow-epro2-four-files'
            or context.get('stage') != 'verify' or context.get('result', {}).get('status') != 'complete'
            or str(report) != context.get('native', {}).get('reportPath') or native != context['native']
            or native.get('status') != 'complete' or native.get('source', {}).get('sha256') != sha(request['sourcePath'])
            or not native.get('pinoutEvidence', {}).get('componentPads')):
        raise ValueError('Pinout 原生证据未与已完成的当前工程运行绑定。')
    return dict(request, nativeReportPath=str(report), nativeReportSha256=value['nativeReportSha256'], viewSides=sides)


def prepare_plan_input(views, request):
    from hdk.pinout_facts import display_options
    facts = json.loads(Path(views[0]['factsPath']).read_text())
    sides = request.get('viewSides', ['front', 'back'])
    return {'task': 'plan-pinout-display', 'productCode': request['productCode'], 'hardwareVersion': request['hardwareVersion'],
            'displayOptions': display_options(facts),
            'views': [{'side': view['side'], 'width': view['image']['width'], 'height': view['image']['height'],
                       'originalPhotoSha256': view['photoOriginal']['sha256']} for view in views if view['side'] in sides],
            'outputSchema': {'format': 'workbench-pinout-display-plan', 'version': 1,
                'styleFields': ['preset', 'background', 'guides', 'fontSize', 'labelGapPx', 'palette'],
                'aliasFields': ['connector', 'pad', 'net', 'label'], 'allowedLabelsOnly': True},
            'immutability': 'Geometry, source nets, physical pad numbers, photos and calibration are fixed; choose display options only.'}


def checked_skill_plan(run, skill_id, value, expected_input):
    step = run.get('nodes', {}).get(skill_id, {})
    if step.get('status') != 'complete' or step.get('input') != expected_input or step.get('output') != value:
        raise ValueError('排版计划不是本次已完成 Skill 的真实输出。')
    node = next((node for node in run['document']['nodes'] if node['id'] == skill_id and node['type'] == 'skill'), None)
    if not node:
        raise ValueError('当前流程缺少 Pinout Skill。')
    return {'ref': node['config']['skillRef'], 'version': node['config']['version']}


def render_photo_plan(request, views, native_path, output, plan):
    """Tool boundary shared by standalone learning and four-file execution."""
    from hdk.pinout_facts import validate_display_plan, prepare_photo_pinouts
    from hdk.four_files_pipeline import _process, NODE
    facts = json.loads(Path(views[0]['factsPath']).read_text())
    normalized = validate_display_plan(plan, facts)
    output = Path(output)
    prepared = prepare_photo_pinouts({'sourcePath': request['sourcePath'], 'images': request['images'],
        'photoProfilePath': request['pinoutPhotoProfilePath'], 'nativeMetaPath': str(native_path),
        'outputDir': str(output / '.planned-pinout'), 'productCode': request['productCode'],
        'hardwareVersion': 'V' + request['hardwareVersion'].removeprefix('V'), 'displayPlan': normalized})
    rendered = []
    for view in prepared['views']:
        if view['side'] not in request.get('viewSides', ['front', 'back']):
            continue
        basename = request['productCode'] + '_Pinout' + ('_Back' if view['side'] == 'back' else '') + '_V' + request['hardwareVersion'].removeprefix('V')
        converted = _process([NODE, ROOT / 'scripts/openpinmap-convert.mjs', '--project', view['projectPath'],
                              '--output-dir', output, '--basename', basename], timeout=300)
        rendered.append(dict(converted, side=view['side'], factsPath=view['factsPath']))
    return {'displayPlan': normalized, 'prepared': prepared, 'views': rendered}


def _load(run, previous):
    path = PRIVATE / (run['id'] + '.json')
    state = json.loads(path.read_text())
    if state.get('runId') != run['id'] or state.get('workflowId') != run['workflowId'] or state.get('stage') != previous:
        raise ValueError('Pinout 状态或阶段不属于本次运行。')
    if any(sha(item['path']) != item['sha256'] for item in state['sources']):
        raise ValueError('源工程、照片、校准或原生证据在运行中变化。')
    return state, path


def execute_stage(operation, value):
    if operation not in STAGES:
        raise ValueError('未知 Pinout 操作。')
    run = _run(operation)
    path = PRIVATE / (run['id'] + '.json')
    if operation == 'prepare':
        if value != run['input'] or path.exists():
            raise ValueError('Pinout 输入不匹配运行快照或已有准备回执。')
        request = validate_input(value)
        output = OUTPUTS / run['id'] / (request['productCode'] + '_Pinout')
        output.mkdir(parents=True, exist_ok=False)
        from hdk.pinout_facts import prepare_photo_pinouts
        prepared = prepare_photo_pinouts({'sourcePath': request['sourcePath'], 'images': request['images'],
            'photoProfilePath': request['pinoutPhotoProfilePath'], 'nativeMetaPath': request['nativeReportPath'],
            'outputDir': str(output / '.source-facts'), 'productCode': request['productCode'], 'hardwareVersion': request['hardwareVersion']})
        sources = [request['sourcePath'], request['pinoutPhotoProfilePath'], request['nativeReportPath'], *[image['path'] for image in request['images']]]
        archives = output / 'sources'; archives.mkdir()
        for image in request['images']:
            shutil.copyfile(image['path'], archives / (image['side'] + Path(image['path']).suffix.lower()))
        shutil.copyfile(request['pinoutPhotoProfilePath'], archives / 'photo-calibration.json')
        state = {'runId': run['id'], 'workflowId': run['workflowId'], 'learningId': run.get('learningId', ''),
            'request': request, 'sources': [{'path': source, 'sha256': sha(source)} for source in sources],
            'outputPath': str(output), 'prepared': prepared, 'stage': 'prepare', 'errors': {}}
        state['skillInput'] = prepare_plan_input(prepared['views'], request)
        write_json(path, state)
        return state['skillInput']
    state, path = _load(run, 'prepare' if operation == 'render' else 'render')
    if operation == 'render':
        state['skill'] = checked_skill_plan(run, 'pinout-plan-skill', value, state['skillInput'])
        state['plan'] = value
        try:
            state['rendered'] = render_photo_plan(state['request'], state['prepared']['views'], state['request']['nativeReportPath'], state['outputPath'], value)
        except ValueError as error:
            # Invalid model choices are useful learning feedback; factual or
            # infrastructure failures must not be disguised as learning errors.
            text = str(error)
            recoverable = any(word in text for word in ('Display ', 'display ', 'aliases', 'alias ', 'Readable Pinout labels', 'label gap', 'label transforms'))
            if not state['learningId'] or not recoverable:
                raise
            state['errors']['plan'] = text
        state['stage'] = 'render'
        state['renderReceipt'] = {'runId': run['id'], 'stage': 'render', 'outputPath': state['outputPath']}
        write_json(path, state)
        return state['renderReceipt']
    if value != state['renderReceipt']:
        raise ValueError('Pinout 验收输入不是本次渲染回执。')
    from hdk.pinout_learning import evaluate_pinout_views, CHECK_IDS
    if state.get('errors'):
        summary = {'passed': False, 'checks': {key: False for key in CHECK_IDS}}
        comparison = {'qualitySummary': summary, 'plan': state['plan'], 'diagnostics': state['errors'],
                      'limitations': ['No compliant export was produced; improve the Skill plan using the actual tool diagnostic.']}
        evaluation = {'passed': False, 'qualitySummary': summary, 'learningComparison': comparison, 'diagnostics': state['errors']}
    else:
        evaluation = evaluate_pinout_views(state['rendered']['views'], reference_contract=CONTRACT if CONTRACT.is_file() else None)
        evaluation['learningComparison']['plan'] = state['plan']
    output = Path(state['outputPath'])
    report = dict(evaluation, runId=run['id'], learningId=state['learningId'], skill=state['skill'], visualReview='required',
                  views=state.get('rendered', {}).get('views', []),
                  artifacts=[{'path': str(p.relative_to(output)), 'sha256': sha(p), 'bytes': p.stat().st_size}
                             for p in sorted(output.rglob('*')) if p.is_file()])
    report_path = output / 'Pinout验收.json'; write_json(report_path, report)
    state['stage'] = 'verify'; state['reportPath'] = str(report_path); write_json(path, state)
    if not report['passed'] and not state['learningId']:
        raise ValueError('Pinout 未达到参考标注要求，请先完成对应 Skill 学习。')
    return {'runId': run['id'], 'outputPath': str(output), 'reportPath': str(report_path),
            'qualitySummary': report['qualitySummary'], 'views': report['views'], 'skill': state['skill'],
            'learningComparison': report['learningComparison']}


def run_stage(operation, value):
    result = subprocess.run([str(PYTHON), '-I', str(Path(__file__).resolve())],
        input=json.dumps({'operation': operation, 'input': value}, ensure_ascii=False).encode(), cwd=ROOT,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=900, check=False)
    if result.stderr: print(result.stderr.decode(errors='replace')[-16000:], file=sys.stderr)
    if len(result.stdout) > 65536:
        raise ValueError('Pinout 回执超过节点限制。')
    reply = json.loads(result.stdout)
    if result.returncode or reply.get('ok') is not True:
        raise ValueError(reply.get('error', 'Pinout 未完成。'))
    return reply['result']


if __name__ == '__main__':
    sys.path.insert(0, str(ROOT))
    try:
        request = json.load(sys.stdin)
        print(json.dumps({'ok': True, 'result': execute_stage(request['operation'], request['input'])}, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False)); sys.exit(1)
