"""Source-bound execution stages for SCH/STEP/Pinout/CAD delivery.

Large binary data and editable projects stay on disk. Node ports carry receipts;
later stages use the private per-run context, never caller-supplied file outputs.
"""
import datetime as dt
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[1]
PRIVATE = ROOT / '.local/four-files-contexts'
OUTPUTS = ROOT / 'workspaces/four-files'
PYTHON = Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3'
NODE = Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node'
STAGES = ('preflight', 'native', 'cad', 'pin-facts', 'pinout', 'verify')
NODES = {stage: 'four-' + stage for stage in STAGES}
FIELDS = {'sourcePath', 'productCode', 'hardwareVersion', 'releaseDate', 'cadRotation', 'cadLayout', 'cadDetail', 'pinoutProfilePath', 'images', 'pinoutPhotoProfilePath'}
COMMITS = {'OpenPinMap': 'de6196839c6cf8126f4bf29b9792f73c17013b44', 'OpenStep2DWG': 'afd6a844e39ba0a205918dc866b60211f978b2b9'}


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _write(path, value):
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    with temporary.open('x', encoding='utf-8') as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream, ensure_ascii=False, indent=2)
    os.replace(temporary, path)


def _binding(operation):
    run_id = os.environ.get('WORKBENCH_RUN_ID', '')
    if str(uuid.UUID(run_id)) != run_id or os.environ.get('WORKBENCH_NODE_ID') != NODES[operation]:
        raise ValueError('四文件操作必须来自对应的工作流节点和真实运行。')
    workflow_id = os.environ.get('WORKBENCH_WORKFLOW_ID', '')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,127}', workflow_id):
        raise ValueError('缺少工作流执行上下文。')
    PRIVATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    return run_id, workflow_id, PRIVATE / (run_id + '.json')


def _process(command, *, timeout=1800):
    # No shell text, credentials, model calls or inherited browser profile.
    with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
        child = subprocess.Popen([str(arg) for arg in command], cwd=ROOT, stdout=output, stderr=errors)
        try:
            child.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            # Converter SIGTERM handlers abort their own Chromium context before
            # an eventual outer workflow process-group kill is needed.
            child.terminate()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill(); child.wait()
            raise ValueError('转换超过时限，已请求关闭本次转换进程。') from None
        end = errors.seek(0, 2); errors.seek(max(0, end - 24000))
        diagnostics = errors.read().decode('utf-8', errors='replace')
        if diagnostics:
            print(diagnostics, file=sys.stderr)
        if output.seek(0, 2) > 65536:
            raise ValueError('转换摘要超过节点限制，详细资料应写入文件。')
        output.seek(0)
        try:
            value = json.load(output)
        except (ValueError, UnicodeDecodeError):
            raise ValueError('转换未返回有效回执：' + diagnostics[-2000:]) from None
        if child.returncode or not isinstance(value, dict):
            raise ValueError('转换失败：' + str(value.get('error') if isinstance(value, dict) else diagnostics[-2000:]))
        return value


def validate_input(value):
    if not isinstance(value, dict) or set(value) - FIELDS or not {'sourcePath', 'productCode', 'hardwareVersion', 'releaseDate'} <= set(value):
        raise ValueError('输入需要 epro2、发布参数、正反面实拍图 images 和已核验的 pinoutPhotoProfilePath。')
    if not isinstance(value['sourcePath'], str) or not value['sourcePath']:
        raise ValueError('sourcePath 必须是原始 epro2 文件。')
    source = Path(value['sourcePath']).expanduser().resolve()
    if not source.is_file() or source.suffix.lower() != '.epro2':
        raise ValueError('sourcePath 必须是存在的 epro2 文件。')
    product, version, date = (value[key] for key in ('productCode', 'hardwareVersion', 'releaseDate'))
    if not isinstance(product, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,79}', product):
        raise ValueError('productCode 格式无效。')
    if not isinstance(version, str) or not re.fullmatch(r'V?\d{1,3}\.\d{1,3}', version):
        raise ValueError('hardwareVersion 需要如 1.0。')
    if not isinstance(date, str) or dt.date.fromisoformat(date).isoformat() != date:
        raise ValueError('releaseDate 必须是 YYYY-MM-DD。')
    if isinstance(value.get('cadRotation', 0), bool) or value.get('cadRotation', 0) not in (0, 90, 180, 270):
        raise ValueError('cadRotation 必须为 0/90/180/270。')
    if value.get('cadLayout', 'inspection') not in ('inspection', 'first-angle') or value.get('cadDetail', 'full') not in ('full', 'mechanical'):
        raise ValueError('CAD 排版或细节选项无效。')
    if value.get('pinoutProfilePath') is not None and (not isinstance(value['pinoutProfilePath'], str) or not Path(value['pinoutProfilePath']).is_file()):
        raise ValueError('pinoutProfilePath 必须是存在的已核验配置。')
    images = value.get('images')
    if not isinstance(images, list) or len(images) != 2 or any(not isinstance(image, dict) for image in images):
        raise ValueError('Pinout 必须提供正反面两张实拍图，不能使用 PCB 渲染图代替。')
    if {image.get('side') for image in images} != {'front', 'back'}:
        raise ValueError('images 必须分别指定 front 和 back。')
    from PIL import Image
    reviewed = []
    for image in images:
        if set(image) != {'side', 'path', 'sha256'} or not isinstance(image['path'], str) or not re.fullmatch(r'[0-9a-f]{64}', str(image['sha256'])):
            raise ValueError('每张实拍图需要 side、path 和准确 sha256。')
        image_path = Path(image['path']).expanduser().resolve()
        if not image_path.is_file() or image_path.stat().st_size > 50_000_000 or sha(image_path) != image['sha256']:
            raise ValueError('实拍图不存在、过大或 SHA 与核验记录不同。')
        with Image.open(image_path) as photo:
            if photo.format not in ('PNG', 'JPEG') or min(photo.size) < 32 or photo.width * photo.height > 32_000_000:
                raise ValueError('实拍图必须是有效 PNG/JPEG。')
            photo.verify()
        reviewed.append({**image, 'path': str(image_path)})
    profile = value.get('pinoutPhotoProfilePath')
    if not isinstance(profile, str) or not Path(profile).is_file() or Path(profile).stat().st_size > 2_000_000:
        raise ValueError('需要存在的正反面实拍图引脚校准配置。')
    return {**value, 'sourcePath': str(source), 'hardwareVersion': version.removeprefix('V'),
            'images': reviewed, 'pinoutPhotoProfilePath': str(Path(profile).resolve())}


def _receipt(state):
    return {key: state[key] for key in ('runId', 'workflowId', 'stage', 'sourceSha256', 'outputPath') if key in state} | {
        'files': [{key: artifact[key] for key in ('kind', 'path', 'bytes', 'sha256')} for artifact in state.get('files', [])]}


def _load(value, operation):
    run_id, workflow_id, path = _binding(operation)
    state = json.loads(path.read_text(encoding='utf-8'))
    skill_plan = operation == 'pinout' and 'skillInput' in state
    if state.get('runId') != run_id or state.get('workflowId') != workflow_id or not isinstance(value, dict) or (not skill_plan and value != _receipt(state)):
        raise ValueError('节点输入与本次私有运行回执不一致。')
    if skill_plan:
        from hdk.pinout_pipeline import checked_skill_plan
        with sqlite3.connect('file:' + str(ROOT / '.local/workbench.sqlite') + '?mode=ro', uri=True) as db:
            row = db.execute('SELECT value FROM workflow_runs WHERE id=?', (run_id,)).fetchone()
        run = json.loads(row[0]) if row else {}
        if run.get('currentNodeId') != 'four-pinout' or run.get('workflowId') != workflow_id or run.get('learningId', '') != os.environ.get('WORKBENCH_LEARNING_ID', ''):
            raise ValueError('Pinout Skill 不属于本次不可变四文件运行。')
        state['pinoutSkill'] = checked_skill_plan(run, 'four-pinout-skill', value, state['skillInput'])
    previous = STAGES[STAGES.index(operation) - 1]
    if state.get('stage') != previous or sha(state['request']['sourcePath']) != state['sourceSha256']:
        raise ValueError('执行阶段或原始 epro2 已变化，停止本次转换。')
    if any(sha(item['path']) != item['sha256'] for item in state.get('photoSources', [])):
        raise ValueError('实拍图或校准配置在运行中发生变化。')
    return state, path


def _inside(path, output):
    candidate = Path(path)
    if candidate.is_symlink() or not candidate.is_file() or not candidate.resolve().is_relative_to(Path(output).resolve()):
        raise ValueError('产物必须是本次独立输出目录内的真实文件。')
    return candidate


def _artifact(path, kind, output):
    file = _inside(path, output)
    if not file.stat().st_size:
        raise ValueError('产物为空。')
    return {'kind': kind, 'path': str(file), 'bytes': file.stat().st_size, 'sha256': sha(file)}


def pdf_font_check(reader):
    from pypdf.generic import ContentStream
    seen, missing = set(), set()
    def inspect(stream, resources):
        if stream is None:
            return
        resources = resources.get_object()
        fonts = resources.get('/Font', {})
        fonts = fonts.get_object() if hasattr(fonts, 'get_object') else fonts
        objects = resources.get('/XObject', {})
        objects = objects.get_object() if hasattr(objects, 'get_object') else objects
        for operands, operator in ContentStream(stream, reader).operations:
            if operator == b'Tf' and operands[0] not in fonts:
                missing.add(str(operands[0]))
            elif operator == b'Do' and operands[0] in objects:
                target = objects[operands[0]].get_object()
                if target.get('/Subtype') == '/Form' and id(target) not in seen:
                    seen.add(id(target)); inspect(target, target.get('/Resources', resources))
    for page in reader.pages:
        inspect(page.get_contents(), page.get('/Resources', {}))
    return {'passed': not missing, 'missingFonts': sorted(missing)}


def execute_stage(operation, value):
    if operation not in STAGES:
        raise ValueError('不支持的四文件操作。')
    if operation == 'preflight':
        run_id, workflow_id, path = _binding(operation)
        request = validate_input(value)
        if path.exists():
            raise ValueError('本次预检已有回执，不能覆盖或盲目重试。')
        from hdk.four_files_native import core
        source = core.source_info(Path(request['sourcePath']))
        for script in ('openstep2dwg-convert.mjs', 'openpinmap-convert.mjs'):
            dependency = _process([NODE, ROOT / 'scripts' / script, '--check'], timeout=120)
            if dependency.get('ready') is not True:
                raise ValueError('转换依赖未就绪：' + script)
        parent = OUTPUTS / run_id
        parent.mkdir(parents=True, exist_ok=False)
        state = {'runId': run_id, 'workflowId': workflow_id, 'stage': operation, 'sourceSha256': source['sha256'],
                 'request': request, 'outputParent': str(parent), 'files': [], 'startedAt': dt.datetime.now(dt.timezone.utc).isoformat()}
        state['photoSources'] = [*request['images'], {'path': request['pinoutPhotoProfilePath'], 'sha256': sha(request['pinoutPhotoProfilePath'])}]
    else:
        state, path = _load(value, operation)
        request = state['request']
        product, version = request['productCode'], 'V' + request['hardwareVersion']
        if operation == 'native':
            from hdk.four_files_native import export_native
            report = export_native({key: request[key] for key in ('sourcePath', 'productCode', 'hardwareVersion', 'releaseDate')} | {'outputParent': state['outputParent']}, execute=True)
            state['native'] = report; state['outputPath'] = report['outputPath']
            if not state['outputPath'] or not Path(state['outputPath']).resolve().is_relative_to(Path(state['outputParent']).resolve()):
                raise ValueError('原生输出目录不属于本次运行。')
            if report.get('status') != 'complete' or report['source']['sha256'] != state['sourceSha256']:
                state['error'] = report.get('errors'); _write(path, state)
                raise ValueError('SCH/STEP 原生导出或源完整性检查未通过：' + json.dumps(report.get('errors', []), ensure_ascii=False)[:2000])
            state['files'] = [_artifact(artifact['path'], artifact['kind'], state['outputPath']) for artifact in report['artifacts'] if artifact['kind'] in ('schematicPdf', 'step')]
        elif operation == 'cad':
            step = next(file for file in state['files'] if file['kind'] == 'step')
            if sha(step['path']) != step['sha256']:
                raise ValueError('本次 STEP 已变化。')
            state['cad'] = _process([NODE, ROOT / 'scripts/openstep2dwg-convert.mjs', '--input', step['path'], '--output-dir', state['outputPath'],
                '--basename', f'{product}_CAD_{version}', '--title', product, '--drawing-number', f'{product}_CAD', '--revision', version,
                '--date', request['releaseDate'], '--rotation', str(request.get('cadRotation', 0)), '--layout', request.get('cadLayout', 'inspection'),
                '--detail', request.get('cadDetail', 'full'), '--timeout-ms', '1200000'], timeout=1500)
            cad = next(file for file in state['cad']['artifacts'] if file['name'].endswith('.dwg'))
            state['files'].append(_artifact(cad['path'], 'cad', state['outputPath']))
        elif operation == 'pin-facts':
            from hdk.pinout_facts import prepare_pinout, prepare_photo_pinouts
            evidence = state['native'].get('pinoutEvidence') or {}
            image = evidence.get('image', {})
            board_image = image.get('path') or state['native'].get('boardImagePath')
            if request.get('images'):
                archive = Path(state['outputPath']) / 'sources/photos'
                archive.mkdir(parents=True)
                state['photoArchives'] = []
                for image in request['images']:
                    target = archive / (image['side'] + '-original' + Path(image['path']).suffix.lower())
                    shutil.copyfile(image['path'], target)
                    state['photoArchives'].append(dict(_artifact(target, 'photoOriginal', state['outputPath']), side=image['side']))
                target = archive / 'pinout-photo-calibration.json'
                shutil.copyfile(request['pinoutPhotoProfilePath'], target)
                state['photoArchives'].append(_artifact(target, 'photoCalibration', state['outputPath']))
                state['photoPinFacts'] = prepare_photo_pinouts({'sourcePath': request['sourcePath'], 'images': request['images'],
                    'photoProfilePath': request['pinoutPhotoProfilePath'], 'nativeMetaPath': state['native']['reportPath'],
                    'outputDir': str(Path(state['outputPath']) / '.pinout-preparation'), 'productCode': product, 'hardwareVersion': version})
                views = state['photoPinFacts'].get('views', [])
                front = next((view for view in views if view.get('side') == 'front'), None)
                if state['photoPinFacts'].get('validated') is not True or state['photoPinFacts'].get('status') != 'ready' or len(views) != 2 or {view.get('side') for view in views} != {'front', 'back'} or not front:
                    _write(path, state)
                    raise ValueError('正反面实拍图引脚校准尚未通过。')
                state['pinFacts'] = dict(front, validated=True, status='ready')
            else:
                # Immutable historical runs retain their original interpretation.
                state['pinFacts'] = prepare_pinout({'sourcePath': request['sourcePath'], 'boardImagePath': board_image,
                    'outputDir': str(Path(state['outputPath']) / '.pinout-preparation'), 'productCode': product, 'hardwareVersion': version,
                    'nativeMetaPath': state['native']['reportPath'], **({'profilePath': request['pinoutProfilePath']} if request.get('pinoutProfilePath') else {})})
            if state['pinFacts'].get('validated') is not True or state['pinFacts'].get('status') != 'ready':
                _write(path, state)
                raise ValueError('Pinout 引脚与底图映射尚未核验：' + str(state['pinFacts'].get('reason', '请查看引脚事实文件。')))
            if request.get('images'):
                from hdk.pinout_pipeline import prepare_plan_input
                state['skillInput'] = prepare_plan_input(state['photoPinFacts']['views'], request)
        elif operation == 'pinout':
            if 'skillInput' in state:
                from hdk.pinout_pipeline import render_photo_plan
                planned = render_photo_plan(request, state['photoPinFacts']['views'], state['native']['reportPath'], state['outputPath'], value)
                state['pinoutDisplayPlan'] = planned['displayPlan']
                state['photoPinFacts'] = planned['prepared']
                state['pinFacts'] = next(view for view in planned['prepared']['views'] if view['side'] == 'front')
                state['pinoutViews'] = planned['views']
            else:
                views = state.get('photoPinFacts', {}).get('views') or [dict(state['pinFacts'], side='front')]
                state['pinoutViews'] = []
                for view in views:
                    project = _inside(view['projectPath'], state['outputPath'])
                    side = view['side']
                    converted = _process([NODE, ROOT / 'scripts/openpinmap-convert.mjs', '--project', project,
                        '--output-dir', state['outputPath'], '--basename', f'{product}_Pinout' + ('_Back' if side == 'back' else '') + f'_{version}'], timeout=300)
                    state['pinoutViews'].append(dict(converted, side=side, factsPath=view['factsPath']))
            state['pinout'] = next(view for view in state['pinoutViews'] if view['side'] == 'front')
            state['supplementaryFiles'] = [_artifact(view['pngPath'], 'pinoutBack', state['outputPath']) for view in state['pinoutViews'] if view['side'] == 'back']
            state['files'].append(_artifact(state['pinout']['pngPath'], 'pinout', state['outputPath']))
        elif operation == 'verify':
            result = verify_files(state)
            _write(Path(state['outputPath']) / '四文件验收.json', result)
            state['result'] = result
        state['stage'] = operation
    _write(path, state)
    return state.get('result') if operation == 'verify' else state['skillInput'] if operation == 'pin-facts' and 'skillInput' in state else _receipt(state)


def verify_files(state):
    files = state['files']
    if len(files) != 4 or {file['kind'] for file in files} != {'schematicPdf', 'step', 'pinout', 'cad'}:
        raise ValueError('四项成果不完整。')
    for artifact in files:
        if _artifact(artifact['path'], artifact['kind'], state['outputPath']) != artifact:
            raise ValueError('产物在生成后被更改。')
    source_ok = sha(state['request']['sourcePath']) == state['sourceSha256']
    if any(sha(item['path']) != item['sha256'] for item in state.get('photoSources', [])):
        raise ValueError('最终验收发现实拍图或校准配置发生变化。')
    from hdk.four_files_native import validate_step
    from pypdf import PdfReader
    from PIL import Image
    by_kind = {file['kind']: file for file in files}
    reader = PdfReader(by_kind['schematicPdf']['path'])
    pages = len(reader.pages)
    fonts = pdf_font_check(reader)
    step = validate_step(Path(by_kind['step']['path']).read_bytes())
    with Image.open(by_kind['pinout']['path']) as image:
        image.verify()
    with Image.open(by_kind['pinout']['path']) as image:
        pixels = {'width': image.width, 'height': image.height}
        if image.format != 'PNG' or min(image.size) < 100:
            raise ValueError('Pinout 不是有效 PNG。')
    cad_manifest = json.loads(_inside(state['cad']['manifestPath'], state['outputPath']).read_text(encoding='utf-8'))
    pin_manifest = json.loads(_inside(state['pinout']['manifestPath'], state['outputPath']).read_text(encoding='utf-8'))
    pin_facts = json.loads(_inside(state['pinFacts']['factsPath'], state['outputPath']).read_text(encoding='utf-8'))
    project_path = _inside(state['pinFacts']['projectPath'], state['outputPath'])
    project = json.loads(project_path.read_text(encoding='utf-8'))
    project_hash = sha(project_path)
    facts_source = pin_facts.get('source', {})
    alignment = pin_facts.get('alignment', {})
    image_path = _inside(pin_facts['image']['path'], state['outputPath'])
    def manifest_matches(manifest, name, artifact):
        converter = manifest.get('converter', {})
        if converter.get('name') != name or converter.get('commit') != COMMITS[name]:
            return False
        matches = [entry for entry in manifest.get('artifacts', []) if entry.get('path') == artifact['path']]
        return len(matches) == 1 and matches[0].get('sha256') == artifact['sha256'] and matches[0].get('bytes') == artifact['bytes']
    source_alignment = project.get('workbenchAlignment', {})
    checks = {'originalEpro2Unchanged': source_ok, 'schPdfReadable': pages > 0, 'schFontsDefined': fonts['passed'], 'stepStructuralIntegrity': step['structuralChecksPassed'],
        'cadUsesThisStep': cad_manifest['source']['sha256'] == by_kind['step']['sha256'],
        'cadProvenance': manifest_matches(cad_manifest, 'OpenStep2DWG', by_kind['cad']),
        'cadRoundtrip': cad_manifest['verification']['roundtripEntityCountsMatched'] is True,
        'cadIndependentGeometry': cad_manifest['verification']['independentGeometryPassed'] is True,
        'cadFreshConversion': cad_manifest['verification'].get('freshConversion') is True
            and cad_manifest['verification'].get('sourceHashMatched') is True
            and cad_manifest['verification'].get('mismatchedEntities') == 0 and cad_manifest['verification'].get('auditErrors') == 0,
        'dwgHeader': Path(by_kind['cad']['path']).read_bytes()[:6] == b'AC1015',
        'pinoutProvenance': manifest_matches(pin_manifest, 'OpenPinMap', by_kind['pinout']),
        'pinoutUsesThisProject': pin_manifest['source']['sha256'] == project_hash,
        'pinoutSourceVerified': state['pinFacts']['validated'] is True and state['pinFacts'].get('status') == 'ready'
            and pin_facts.get('preparation', {}).get('validated') is True and pin_facts.get('preparation', {}).get('status') == 'ready'
            and facts_source.get('sha256') == state['sourceSha256'] and source_alignment.get('sourceSha256') == state['sourceSha256'],
        'pinoutImageBound': pin_facts['image']['sha256'] == sha(image_path) == source_alignment.get('imageSha256'),
        'pinoutFreshRender': pin_manifest['verification'].get('freshContext') is True and pin_manifest['verification'].get('defaultExampleUsed') is False
            and pin_manifest['verification'].get('boundProjectReadbackMatched') is True and pin_manifest['verification'].get('sourceHashMatched') is True,
        'pinoutAlignment': alignment.get('calibration', {}).get('passed') is True
            and pin_manifest.get('alignment', {}).get('labelCentersResolvedUsingRendererFontMetrics') is True
            and pin_manifest.get('alignment', {}).get('sourceSha256') == state['sourceSha256']
            and pin_manifest.get('alignment', {}).get('imageSha256') == sha(image_path),
        'pinoutPngReadable': True}
    photo_views = []
    presentation = None
    if state['request'].get('images'):
        photo_views = verify_photo_pinouts(state)
        checks.update(pinoutActualPhotographs=True, pinoutBothSidesVerified=True, pinoutOppositeViewsVerified=True,
                      pinoutRetainedPhotoPixels=True)
    if state.get('pinoutSkill'):
        from hdk.pinout_learning import evaluate_pinout_views
        from hdk.pinout_pipeline import CONTRACT
        presentation = evaluate_pinout_views(state['pinoutViews'], reference_contract=CONTRACT)
        _write(Path(state['outputPath']) / 'Pinout样式验收.json', presentation)
        checks['pinoutLearnedPresentation'] = presentation['passed']
    if not all(checks.values()) and (not os.environ.get('WORKBENCH_LEARNING_ID') or any(not passed for key, passed in checks.items() if key != 'pinoutLearnedPresentation')):
        raise ValueError('四文件验收失败：' + ','.join(key for key, passed in checks.items() if not passed))
    return {'status': 'complete', 'runId': state['runId'], 'sourcePath': state['request']['sourcePath'], 'sourceSha256': state['sourceSha256'],
        'outputPath': state['outputPath'], 'files': files, 'checks': checks, 'schPages': pages, 'stepSolids': step['solidCount'], 'pinoutImage': pixels,
        'pinCount': state['pinFacts'].get('pinCount'), 'reportPath': str(Path(state['outputPath']) / '四文件验收.json'),
        'editableProjects': [*[view['projectPath'] for view in (state.get('pinoutViews') or [state['pinout']])], *[file['path'] for file in state['cad']['artifacts'] if file['name'].endswith('.openstep2dwg.json')]],
        'artifacts': state.get('supplementaryFiles', []) + state.get('photoArchives', []),
        'pinoutViews': photo_views,
        **({'pinoutSkill': state['pinoutSkill'], 'pinoutPresentationReportPath': str(Path(state['outputPath']) / 'Pinout样式验收.json'),
            'pinoutLearningComparison': dict(presentation['learningComparison'], plan=state['pinoutDisplayPlan'])} if presentation else {}),
        'visualReview': 'required', 'stepMetadataWarnings': step.get('nativeMetadataWarnings', []),
        'schRendering': next(artifact.get('checks', {}) for artifact in state['native']['artifacts'] if artifact['kind'] == 'schematicPdf'),
        'pinoutBackground': ('用户提供的正反面实拍图，分别校准并只裁去透明边缘；电气网络与编号来自本次 epro2 和原生焊盘证据。'
                             if photo_views else '本次 epro2 的原生 PCB 顶视图，包含线路和丝印；不是产品照片。'),
        'limitations': cad_manifest.get('limitations', [])}


def verify_photo_pinouts(state):
    """Re-read each real conversion and source photograph, including crop pixels."""
    from PIL import Image
    import io
    output = state['outputPath']
    for artifact in state.get('supplementaryFiles', []):
        if _artifact(artifact['path'], artifact['kind'], output) != artifact:
            raise ValueError('背面 Pinout 附加产物发生变化。')
    views = state.get('pinoutViews', [])
    if len(views) != 2 or {view.get('side') for view in views} != {'front', 'back'}:
        raise ValueError('最终验收需要正反面两份实际 Pinout。')
    archived = state.get('photoArchives', [])
    for item in archived:
        if _artifact(item['path'], item['kind'], output)['sha256'] != item['sha256']:
            raise ValueError('实拍原图保留副本或校准副本发生变化。')
    profile_hash = sha(state['request']['pinoutPhotoProfilePath'])
    profile_copy = [item for item in archived if item['kind'] == 'photoCalibration']
    if len(profile_copy) != 1 or profile_copy[0]['sha256'] != profile_hash:
        raise ValueError('缺少本次照片校准配置的准确副本。')
    checked, maps, signs = [], [], []
    for view in views:
        side = view['side']
        source = next(image for image in state['request']['images'] if image['side'] == side)
        original_copy = [item for item in archived if item.get('side') == side]
        if len(original_copy) != 1 or original_copy[0]['sha256'] != source['sha256'] or sha(source['path']) != source['sha256']:
            raise ValueError('Pinout 未绑定本次实拍原图。')
        facts = json.loads(_inside(view['factsPath'], output).read_text())
        manifest = json.loads(_inside(view['manifestPath'], output).read_text())
        project_path = _inside(manifest['source']['path'], output)
        project = json.loads(project_path.read_text())
        alignment = project['workbenchAlignment']
        photograph = alignment.get('photograph', {})
        if photograph != facts.get('photograph') or photograph != manifest.get('alignment', {}).get('photograph'):
            raise ValueError('照片事实、项目和实际转换回执不一致。')
        if photograph.get('kind') != 'actual-photograph' or photograph.get('side') != side or photograph['original']['sha256'] != source['sha256']:
            raise ValueError('Pinout 底图不是所选面的实拍照片。')
        if photograph.get('transformation') != 'transparent-margin-crop-only' or photograph['profile']['sha256'] != profile_hash:
            raise ValueError('Pinout 照片变换或校准来源不一致。')
        if alignment['sourceSha256'] != state['sourceSha256'] or facts['source']['sha256'] != state['sourceSha256'] or not facts['alignment']['calibration']['passed']:
            raise ValueError('照片引脚未绑定当前工程或校准未通过。')
        image_path = _inside(facts['image']['path'], output)
        if sha(image_path) != facts['image']['sha256'] or sha(image_path) != alignment['imageSha256']:
            raise ValueError('Pinout 派生实拍图哈希不一致。')
        embedded = base64.b64decode(project['state']['imageData'].split(',', 1)[1], validate=True)
        if hashlib.sha256(embedded).hexdigest() != sha(image_path):
            raise ValueError('OpenPinMap 项目未嵌入这张实拍图。')
        with Image.open(source['path']) as original, Image.open(io.BytesIO(embedded)) as derived:
            expected_crop = list(original.getchannel('A').getbbox()) if 'A' in original.getbands() else [0, 0, original.width, original.height]
            if photograph['cropBox'] != expected_crop:
                raise ValueError('实拍图裁剪不是仅去透明边缘。')
            expected = original.crop(expected_crop).convert('RGBA')
            if expected.size != derived.size or expected.tobytes() != derived.convert('RGBA').tobytes():
                raise ValueError('Pinout 实拍图的板卡像素已发生变化。')
        converter = manifest.get('converter', {})
        verification = manifest.get('verification', {})
        if converter.get('name') != 'OpenPinMap' or converter.get('commit') != COMMITS['OpenPinMap'] or manifest['source']['sha256'] != sha(project_path) or not all(verification.get(key) is True for key in ('freshContext', 'boundProjectReadbackMatched', 'sourceHashMatched', 'svgEmbeddedImageMatched')) or verification.get('defaultExampleUsed') is not False:
            raise ValueError('实拍 Pinout 缺少本次真实转换回执。')
        for selected in (view['pngPath'], view['projectPath']):
            if len([artifact for artifact in manifest['artifacts'] if artifact['path'] == selected]) != 1:
                raise ValueError('Pinout 图片或可编辑项目未绑定实际导出清单。')
        if side == 'back' and len([artifact for artifact in state.get('supplementaryFiles', []) if artifact['path'] == view['pngPath'] and artifact['kind'] == 'pinoutBack']) != 1:
            raise ValueError('背面 Pinout 未绑定附加产物清单。')
        for artifact in manifest['artifacts']:
            actual = _artifact(artifact['path'], 'pinoutAsset', output)
            if actual['sha256'] != artifact['sha256'] or actual['bytes'] != artifact['bytes']:
                raise ValueError('实拍 Pinout 转换产物发生变化。')
        matrix = facts['alignment']['worldToPixel']
        signs.append(1 if matrix[0] * matrix[3] - matrix[1] * matrix[2] > 0 else -1)
        maps.append([(c['designator'], p['pad'], p['net']) for c in facts['connectors'] for p in c['pins']])
        checked.append({'side': side, 'pinCount': view['pinCount'], 'pngPath': view['pngPath'], 'projectPath': view['projectPath'],
                        'manifestPath': view['manifestPath'], 'factsPath': view['factsPath'], 'originalSha256': source['sha256'],
                        'derivedSha256': sha(image_path), 'cropBox': photograph['cropBox'], 'pixelsUnchanged': True,
                        'revisionCaveat': photograph.get('revisionCaveat', '')})
    if maps[0] != maps[1] or set(signs) != {-1, 1}:
        raise ValueError('正反面物理针序不一致或误用了同一镜像方向。')
    return checked


def run_stage(operation, value):
    """Existing workflow Python nodes use a fixed dependency runtime."""
    request = json.dumps({'operation': operation, 'input': value}, ensure_ascii=False).encode()
    result = subprocess.run([str(PYTHON), '-I', str(Path(__file__).resolve())], input=request, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, cwd=ROOT, timeout=1800, check=False)
    if result.stderr:
        print(result.stderr.decode('utf-8', errors='replace')[-24000:], file=sys.stderr)
    if len(result.stdout) > 65536:
        raise ValueError('四文件节点回执超过限制。')
    reply = json.loads(result.stdout)
    if result.returncode or reply.get('ok') is not True:
        raise ValueError(reply.get('error', '四文件操作未完成。'))
    return reply['result']


if __name__ == '__main__':
    sys.path.insert(0, str(ROOT))
    try:
        request = json.load(sys.stdin)
        result = execute_stage(request['operation'], request['input'])
        print(json.dumps({'ok': True, 'result': result}, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False))
        sys.exit(1)
