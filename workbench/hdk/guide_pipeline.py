"""Execution-first bilingual guide workflow; reference answers stay evaluator-side."""
import base64
import copy
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
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[1]
PRIVATE = ROOT / '.local/user-guide-contexts'
OUTPUTS = ROOT / 'workspaces/user-guides'
GATE = ROOT / 'hdk/learning/user-guide/release-gate.json'
CONTRACT = ROOT / 'hdk/learning/user-guide/reference-contract.json'
NODE = Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node'
PYTHON = Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3'
OPERATIONS = ('prepare', 'annotate', 'write', 'verify')

def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temporary.chmod(0o600)
    temporary.replace(path)

def fingerprint(document):
    value = {k: document[k] for k in ('id', 'edges')}
    value['nodes'] = [{k: n[k] for k in ('id', 'type', 'config')} for n in document['nodes']]
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

def _run(operation):
    run_id = os.environ.get('WORKBENCH_RUN_ID', '')
    if str(uuid.UUID(run_id)) != run_id or os.environ.get('WORKBENCH_NODE_ID') != 'guide-' + operation:
        raise ValueError('使用指南操作必须由对应工作流节点运行。')
    with sqlite3.connect('file:' + str(ROOT / '.local/workbench.sqlite') + '?mode=ro', uri=True) as db:
        row = db.execute('SELECT value FROM workflow_runs WHERE id=?', (run_id,)).fetchone()
    run = json.loads(row[0]) if row else {}
    if run.get('currentNodeId') != 'guide-' + operation or run.get('workflowId') != os.environ.get('WORKBENCH_WORKFLOW_ID'):
        raise ValueError('节点上下文与不可变运行快照不一致。')
    if run.get('learningId', '') != os.environ.get('WORKBENCH_LEARNING_ID', ''):
        raise ValueError('学习记忆上下文不一致。')
    return run

def _process(command, timeout=600):
    with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
        child = subprocess.Popen([str(x) for x in command], cwd=ROOT, stdout=output, stderr=errors)
        try:
            child.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            child.terminate()
            try: child.wait(timeout=10)
            except subprocess.TimeoutExpired: child.kill(); child.wait()
            raise ValueError('指南工具运行超时。') from None
        end = errors.seek(0, 2); errors.seek(max(0, end - 16000))
        diagnostic = errors.read().decode('utf-8', errors='replace')
        if diagnostic: print(diagnostic, file=sys.stderr)
        if child.returncode: raise ValueError('指南工具失败：' + diagnostic[-2500:])
        if output.seek(0, 2) > 65536: raise ValueError('工具回执过大。')
        output.seek(0)
        return json.load(output)

def _load(run):
    state = json.loads((PRIVATE / (run['id'] + '.json')).read_text())
    if state['runId'] != run['id'] or state['workflowId'] != run['workflowId']:
        raise ValueError('指南状态不属于本次运行。')
    for file in state['sources']:
        if sha(file['path']) != file['sha256']: raise ValueError('源资料在运行中发生变化。')
    return state

def _save(state):
    write_json(PRIVATE / (state['runId'] + '.json'), state)

def _gate(run):
    if run.get('learningId'):
        request = run['input']
        contract = json.loads(CONTRACT.read_text())
        paired = contract.get('pairedTrainingSource', {})
        if paired and sha(request['sourcePath']) != paired.get('sha256'):
            raise ValueError('学习只能使用已配对的 S31 案例工程。')
        return
    if not GATE.is_file(): raise ValueError('请先完成 S31 目标指南对比学习，再执行新板卡指南。')
    gate = json.loads(GATE.read_text())
    if gate.get('status') != 'qualified' or gate.get('documentFingerprint') != fingerprint(run['document']) or gate.get('contractSha256') != sha(CONTRACT):
        raise ValueError('指南流水线或 Skill 已变化，需要重新验证案例。')
    for item in gate.get('caseProof', []):
        if sha(item['path']) != item['sha256']: raise ValueError('案例验收证明发生变化。')
        if item.get('kind') == 'artifact-report':
            report_path = Path(item['path']).resolve()
            report = json.loads(report_path.read_text())
            for artifact in report['artifacts']:
                path = (report_path.parent / artifact['path']).resolve()
                if not path.is_relative_to(report_path.parent) or sha(path) != artifact['sha256']:
                    raise ValueError('已通过学习的指南产物发生变化。')
    for path, digest in gate.get('implementationHashes', {}).items():
        if sha(ROOT / path) != digest: raise ValueError('指南实现已变化，请重新核验案例。')
    with sqlite3.connect('file:' + str(ROOT / '.local/workbench.sqlite') + '?mode=ro', uri=True) as db:
        row = db.execute('SELECT value FROM workflow_learning WHERE id=?', (gate.get('learningId'),)).fetchone()
    job = json.loads(row[0]) if row else {}
    if job.get('status') != 'complete' or job.get('bestScore', 0) < 95 or fingerprint(job['bestDocument']) != gate['documentFingerprint']:
        raise ValueError('放行记录缺少已完成的达标学习批次。')
    contract = json.loads(CONTRACT.read_text())
    if any(sha(item['path']) != item['sha256'] for item in contract['references'] + contract.get('knownResultArtifacts', [])):
        raise ValueError('S31目标文档发生变化，请重新对比学习。')

def _prepare(value, run):
    if value != run['input']: raise ValueError('指南输入与运行快照不一致。')
    _gate(run)
    reference = json.loads(CONTRACT.read_text())
    answers = reference['references'] + reference.get('knownResultArtifacts', [])
    forbidden_paths = {str(Path(item['path']).resolve()) for item in answers}
    forbidden_hashes = {item['sha256'] for item in answers}
    for item in value.get('technicalDocuments', []):
        path = Path(item if isinstance(item, str) else item['path']).resolve()
        if str(path) in forbidden_paths or sha(path) in forbidden_hashes:
            raise ValueError('已知答案只能供评估器使用，不能作为执行侧技术资料。')
    from hdk.guide_facts import prepare_guide_facts
    facts = prepare_guide_facts(value)
    from hdk.guide_sdk import enrich_guide_development
    facts = enrich_guide_development(facts, value)
    commands = facts.get('development', {}).get('verifiedCommands', [])
    if not commands: raise ValueError('需要经当前 BSP 核验的开发与烧录命令。')
    facts['requiredCommands'] = [item['shell'] for item in commands]
    facts['forbiddenClaims'] = ['未生成图片标注', '未完成图片标注', 'no image annotations']
    output = OUTPUTS / run['id'] / (facts['productCode'] + '_使用指南')
    output.mkdir(parents=True, exist_ok=False)
    (output / 'img').mkdir(); (output / 'sources').mkdir()
    write_json(output / 'sources/board-facts.json', facts)
    state = {'runId': run['id'], 'workflowId': run['workflowId'], 'learningId': run.get('learningId', ''),
             'request': value, 'facts': facts, 'outputPath': str(output), 'sources': facts['sourceFiles'],
             'plans': {}, 'errors': {}, 'assets': {}, 'stage': 'prepare'}
    # Image candidates are visual observations bound to hashes; the model chooses
    # wording and style only, never pixel geometry or electrical net identity.
    model_images = [{k: image[k] for k in ('side', 'width', 'height', 'note')} | {
        'regions': [{k: r[k] for k in ('id', 'refs', 'titleZh', 'titleEn') if k in r} for r in image['regions']]}
        for image in facts['images']]
    result = {'runId': run['id'], 'productCode': facts['productCode'], 'displayImageWidth': 900, 'images': model_images}
    state['nextInput'] = result; _save(state)
    return result

def _annotation_project(image, selected, style, language, name):
    # OpenInterfaceMark labelX/Y is a baseline anchor, not a text-box corner.
    # Its alignment is chosen by leader slope. Keep horizontal dominance and
    # place vertical bends in the white margin, using the actual export font.
    from PIL import Image
    import io
    import math
    entries = []
    for raw in image['regions']:
        label = selected[raw['id']]
        entries.append({'raw': raw, 'code': '/'.join(raw['refs']),
                        'title': label['titleZh' if language == 'zh' else 'titleEn']})
    metric_script = """
import {pathToFileURL} from 'node:url';
const request=JSON.parse(process.argv[1]);
const {chromium}=await import(pathToFileURL(request.playwright).href);
const {fontFamilyCSS}=await import(pathToFileURL(request.core).href);
let browser,cancelled=false;
const cancel=()=>{cancelled=true;void browser?.close().catch(()=>{});};
process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
try {
  browser=await chromium.launch({channel:'chrome',headless:true,timeout:30000,handleSIGINT:false,handleSIGTERM:false});
  if(cancelled)throw Error('Font measurement cancelled');
  const context=await browser.newContext({serviceWorkers:'block'});
  await context.route('**/*',route=>route.abort());
  const page=await context.newPage();
  await page.setContent('<!doctype html><canvas></canvas>');
  const labels=await page.evaluate(async({items,fontSize,fontFamily})=>{
    await document.fonts.ready;
    const ctx=document.querySelector('canvas').getContext('2d');
    ctx.font=`600 ${fontSize}px ${fontFamily}`;
    return items.map(item=>{
      const metrics=[item.code,item.title].map(text=>ctx.measureText(text));
      return {width:Math.ceil(Math.max(...metrics.map(m=>Math.max(m.width,m.actualBoundingBoxLeft+m.actualBoundingBoxRight)))),
        height:Math.ceil(Math.max(...metrics.map(m=>m.actualBoundingBoxAscent))+fontSize*1.3+Math.max(...metrics.map(m=>m.actualBoundingBoxDescent)))};
    });
  },{items:request.items,fontSize:request.fontSize,fontFamily:fontFamilyCSS('sans')});
  if(cancelled)throw Error('Font measurement cancelled');
  process.stdout.write(JSON.stringify({labels}));
} finally { await browser?.close();if(cancelled)process.exitCode=1; }
"""
    measured = _process([NODE, '--input-type=module', '--eval', metric_script, json.dumps({
        'playwright': str(ROOT / '.local/converters/OpenStep2DWG/node_modules/playwright-core/index.mjs'),
        'core': str(ROOT / '.local/converters/OpenInterfaceMark/src/core.js'),
        'items': [{'code': e['code'], 'title': e['title']} for e in entries],
        'fontSize': style['fontSize']}, ensure_ascii=False)], timeout=60)
    metrics = measured.get('labels', [])
    if len(metrics) != len(entries) or any(not isinstance(m, dict) or any(isinstance(m.get(k), bool) or not isinstance(m.get(k), (int, float)) or not math.isfinite(m[k]) or m[k] <= 0 for k in ('width', 'height')) for m in metrics):
        raise ValueError('标注字体测量没有返回有效的实际文字边界。')
    for entry, metric in zip(entries, metrics):
        entry['metric'] = metric
    with Image.open(image['path']) as original:
        original = original.convert('RGBA')
        ratio = min(1, 720 / original.width, 950 / original.height)
        size = (round(original.width * ratio), round(original.height * ratio))
        photo = original.resize(size, Image.Resampling.LANCZOS)
        columns = {side: sorted([e for e in entries if (e['raw']['x'] + e['raw']['w']/2 < image['width']/2) == (side == 'left')],
                                key=lambda e: (e['raw']['y'] + e['raw']['h']/2, e['raw']['x'], e['raw']['id']))
                   for side in ('left', 'right')}
        row_gap = math.ceil(max((m['height'] for m in metrics), default=style['fontSize']*2.4) + 18)
        height = max(size[1] + 120, max((len(c) for c in columns.values()), default=0) * row_gap + 120)
        top = (height - size[1]) // 2
        font_size = style['fontSize']
        # Prefer a border point whose short horizontal exit does not cross
        # another marked component. Dense regions may still require review.
        clearance = (style['stroke']*1.5 + 4) / ratio
        for side, column in columns.items():
            for entry in column:
                raw = entry['raw']
                ax = raw['x'] if side == 'left' else raw['x'] + raw['w']
                low, high = (0, ax) if side == 'left' else (ax, image['width'])
                entry['anchorOffset'] = .5
                for offset in (.5, .25, .75, .1, .9, .05, .95, 0, 1):
                    ay = raw['y'] + raw['h']*offset
                    blocked = any(other['raw']['id'] != raw['id'] and
                                  other['raw']['x'] < high and other['raw']['x'] + other['raw']['w'] > low and
                                  other['raw']['y'] - clearance < ay < other['raw']['y'] + other['raw']['h'] + clearance
                                  for other in entries)
                    if not blocked:
                        entry['anchorOffset'] = offset
                        break
            column.sort(key=lambda e: (e['raw']['y'] + e['raw']['h']*e['anchorOffset'], e['raw']['x'], e['raw']['id']))
        for side, column in columns.items():
            minimum, maximum = 25 + font_size, height - 25 - font_size*1.4
            previous = minimum - row_gap
            for entry in column:
                raw = entry['raw']
                ideal = top + (raw['y'] + raw['h']*entry['anchorOffset']) * ratio - font_size*.2
                entry['labelY'] = max(minimum, ideal, previous + row_gap)
                previous = entry['labelY']
            following = maximum + row_gap
            for entry in reversed(column):
                entry['labelY'] = min(entry['labelY'], following - row_gap, maximum)
                following = entry['labelY']
        max_displacement = max((abs(e['labelY'] - (top + (e['raw']['y'] + e['raw']['h']*e['anchorOffset'])*ratio)) for e in entries), default=0)
        gutter = math.ceil(max_displacement + font_size*1.4 + 48)
        margin = math.ceil(max((m['width'] for m in metrics), default=0)*1.04) + gutter + 32
        canvas = Image.new('RGBA', (size[0] + margin*2, height), 'white')
        if canvas.width > 16000 or canvas.height > 16000 or canvas.width*canvas.height > 64000000:
            raise ValueError('标注数量或文字过长，超出可读图片布局预算。')
        canvas.alpha_composite(photo, (margin, round(top)))
        stream = io.BytesIO(); canvas.save(stream, format='PNG')
        data_url = 'data:image/png;base64,' + base64.b64encode(stream.getvalue()).decode()
    regions = []
    for side, column in columns.items():
        left = side == 'left'
        for entry in column:
            raw = entry['raw']
            x, y, w, h = [raw[k] * ratio for k in ('x', 'y', 'w', 'h')]
            regions.append({'id': raw['id'], 'kind': raw.get('kind', 'rect'), 'code': entry['code'],
                'title': entry['title'], 'color': style['color'], 'dashed': style['dashed'],
                'x': x + margin, 'y': y + top, 'w': w, 'h': h,
                'labelX': margin - gutter if left else margin + size[0] + gutter,
                'labelY': entry['labelY'], 'anchorSide': side, 'anchorOffset': entry['anchorOffset'],
                'bendX': margin - 20 if left else margin + size[0] + 20,
                'bendY': top + y + h*entry['anchorOffset'],
                'stroke': style['stroke'], 'fontSize': font_size, 'radius': style['radius'],
                'fontFamily': 'sans', 'textColor': '#111827'})
    return {'format': 'open-interface-mark', 'version': 1, 'name': name,
        'image': {'name': image['name'], 'width': canvas.width, 'height': canvas.height, 'src': data_url, 'scale': 1, 'rotation': 0},
        'regions': regions, 'exportSettings': {'background': 'white', 'scale': 1}}

def _validate_annotation(plan, facts):
    expected = {r['id'] for image in facts['images'] for r in image['regions']}
    if not isinstance(plan, dict) or set(plan) != {'regions', 'style'}: raise ValueError('标注计划需要 regions/style。')
    regions = plan['regions']
    if not isinstance(regions, list) or any(not isinstance(r, dict) or not isinstance(r.get('id'), str) for r in regions) or {r.get('id') for r in regions} != expected or len(regions) != len(expected):
        raise ValueError('标注计划须覆盖所有已核验的正反面区域，不能新增区域。')
    for r in regions:
        if set(r) != {'id', 'titleZh', 'titleEn'} or any(not isinstance(r[k], str) or not 1 <= len(r[k]) <= 90 for k in ('titleZh', 'titleEn')):
            raise ValueError('标注需要简短完整的中英文名称。')
    style = plan['style']
    if not isinstance(style, dict) or set(style) != {'color', 'dashed', 'stroke', 'fontSize', 'radius'} or not re.fullmatch(r'#[a-fA-F0-9]{6}', str(style['color'])) or not isinstance(style['dashed'], bool):
        raise ValueError('标注样式无效。')
    for key, low, high in (('stroke', 1, 8), ('fontSize', 12, 22), ('radius', 0, 20)):
        if isinstance(style[key], bool) or not isinstance(style[key], (int, float)) or not low <= style[key] <= high:
            raise ValueError('标注样式 ' + key + ' 超出可读布局范围。')
    return {r['id']: r for r in regions}, style

def _annotate(plan, state):
    from hdk.guide_facts import compact_skill_facts
    output = Path(state['outputPath'])
    state['plans']['annotation'] = plan
    try:
        selected, style = _validate_annotation(plan, state['facts'])
        manifests = []
        for image in state['facts']['images']:
            side = image['side']
            shutil.copyfile(image['path'], output / 'img' / (side + '.png'))
            state['assets'][side] = 'img/' + side + '.png'
            for language in ('zh', 'en'):
                basename = 'interface' + ('_back' if side == 'back' else '') + ('_en' if language == 'en' else '')
                project = _annotation_project(image, selected, style, language, basename)
                bound = output / 'sources' / (basename + '.bound.oim.json')
                write_json(bound, project)
                result = _process([NODE, ROOT / 'scripts/openinterfacemark-convert.mjs', '--project', bound,
                                   '--output-dir', output / 'img', '--basename', basename], timeout=180)
                manifests.append(result)
                state['assets'][basename] = 'img/' + basename + '.png'
        state['annotationManifests'] = manifests
    except ValueError as error:
        if not state['learningId']: raise
        state['errors']['annotation'] = str(error)
    state['stage'] = 'annotate'
    model_facts = compact_skill_facts(state['facts'])
    model_facts.pop('learningIsolation', None)
    result = {'runId': state['runId'], 'facts': model_facts,
              'annotation': {'status': 'complete' if not state['errors'].get('annotation') else 'invalidPlan',
                             'exportedImageCount': len(state.get('annotationManifests', [])),
                             'renderedLabels': [{'ref': item['code'], 'title': item['title']} for manifest in state.get('annotationManifests', []) for item in manifest['regions']],
                             'diagnostic': state['errors'].get('annotation', '')}}
    state['nextInput'] = result; _save(state)
    return result

def _write_guide(plan, state):
    state['plans']['narrative'] = plan
    output = Path(state['outputPath'])
    try:
        from hdk.guide_render import render_bundle, render_source_diagram
        _validate_narrative(plan)
        _supporting_assets(state)
        state['blockDiagram'] = render_source_diagram(state['facts'], output / 'img/block.svg')
        state['assets'].update(block='img/block.png', block_drawio='img/block.drawio', block_svg='img/block.svg')
        result = render_bundle(state['facts'], plan, output, state['assets'])
        for language, key in (('zh', 'zhPath'), ('en', 'enPath')):
            _process([NODE, ROOT / 'scripts/render-user-guide-preview.mjs', result[key], output / ('preview.' + language + '.html')], timeout=30)
        state['rendered'] = result
    except ValueError as error:
        if not state['learningId']: raise
        state['errors']['narrative'] = str(error)
    state['stage'] = 'write'
    result = {'runId': state['runId'], 'stage': 'write', 'outputPath': state['outputPath']}
    state['nextInput'] = result; _save(state)
    return result

def _supporting_assets(state):
    """Copy only explicit engineering evidence; large source trees never propagate."""
    from PIL import Image
    output = Path(state['outputPath'])
    for document in state['facts']['sourceFiles']:
        role = document.get('role', '')
        file = Path(document['path'])
        if role in ('schematic-preview', 'mechanical-preview', 'pinout', 'pinout-back'):
            key = {'schematic-preview': 'schematic', 'mechanical-preview': 'dimensions', 'pinout': 'pinout', 'pinout-back': 'pinout_back'}[role]
            target = output / 'img' / (key + file.suffix.lower())
            shutil.copyfile(file, target); state['assets'][key] = 'img/' + target.name
        elif role in ('schematic-pdf', 'mechanical-cad', 'step', 'test-sop', 'test-instructions', 'flash-instructions', 'build-replay', 'bsp-board-notes', 'module-datasheet', 'primary-chip-datasheet', 'companion-chip-datasheet'):
            name = re.sub(r'[^A-Za-z0-9_.-]', '_', role) + file.suffix.lower()
            shutil.copyfile(file, output / 'sources' / name)
            for item in state['facts'].get('primaryDocuments', []):
                if item.get('path') == str(file): item['bundlePath'] = 'sources/' + name
    # If no original dimensions preview was supplied, draw a clearly labelled
    # source-outline diagram (not a projection of the photo or STEP envelope).
    if 'dimensions' not in state['assets']:
        dims = state['facts']['dimensions']
        if dims.get('lengthMm') and dims.get('widthMm'):
            import html
            text = f"PCB outline: {dims['lengthMm']} x {dims['widthMm']} mm"
            svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="400" viewBox="0 0 1000 400"><rect width="1000" height="400" fill="white"/><rect x="160" y="100" width="680" height="220" rx="18" fill="#eef2ff" stroke="#64748b" stroke-width="3"/><text x="500" y="60" text-anchor="middle" font-family="Arial" font-size="26">' + html.escape(text) + '</text><text x="500" y="370" text-anchor="middle" font-family="Arial" font-size="18">Source-derived outline schematic; not a tolerance drawing</text></svg>'
            (output / 'img/dimensions.svg').write_text(svg)
            state['assets']['dimensions'] = 'img/dimensions.svg'

def _validate_narrative(plan):
    keys = {'overview', 'features', 'hardware', 'power', 'preparation', 'development', 'troubleshooting', 'notice'}
    if not isinstance(plan, dict) or set(plan) != keys: raise ValueError('指南说明需要完整的中英文内容字段。')
    def bilingual(value):
        return isinstance(value, dict) and set(value) == {'zh', 'en'} and all(isinstance(value[k], str) and 20 <= len(value[k]) <= 12000 for k in ('zh', 'en'))
    for key in keys - {'features', 'troubleshooting'}:
        if not bilingual(plan[key]): raise ValueError('指南字段 ' + key + ' 缺少完整中英文说明。')
    if not isinstance(plan['features'], list) or not 4 <= len(plan['features']) <= 8 or not all(bilingual(item) for item in plan['features']):
        raise ValueError('指南需要4–8项中英文产品特点。')
    if not isinstance(plan['troubleshooting'], list) or not 3 <= len(plan['troubleshooting']) <= 6:
        raise ValueError('指南需要3–6项故障排查。')
    for item in plan['troubleshooting']:
        if not isinstance(item, dict) or set(item) != {'symptomZh', 'symptomEn', 'actionZh', 'actionEn'} or not all(isinstance(value, str) and value.strip() for value in item.values()):
            raise ValueError('故障排查需要完整的中英文现象和处理方法。')

def _verify(value, state):
    if value != state['nextInput']: raise ValueError('验收输入与当前运行回执不一致。')
    from hdk.guide_reference import evaluate_guide_bundle
    output = Path(state['outputPath'])
    evaluation = evaluate_guide_bundle(output, facts_path=output / 'sources/board-facts.json', product_code=state['facts']['productCode'])
    checks = {item['id']: item['passed'] for item in evaluation['checks']}
    checks['annotation-exports'] = _verify_annotations(state)
    from hdk.guide_drawio import verify_source_diagram
    checks['drawio-block-diagram'] = bool(state.get('blockDiagram')) and verify_source_diagram(state['blockDiagram']['manifestPath'], state['facts']).get('passed') is True
    checks['source-unchanged'] = all(sha(item['path']) == item['sha256'] for item in state['sources'])
    quality = {'schemaVersion': 1, 'checks': checks}
    if not all(checks.values()) or state['errors']:
        quality['diagnostics'] = {'errors': state['errors'], 'issues': evaluation['issues']}
    proof = {'schemaVersion': 1, 'runId': state['runId'], 'learningId': state['learningId'],
             'qualified': all(checks.values()) and not state['errors'], 'qualitySummary': quality,
             'source': state['facts']['source'], 'evaluation': evaluation,
             'annotationManifests': [item['manifestPath'] for item in state.get('annotationManifests', [])],
             'blockDiagramManifest': state.get('blockDiagram', {}).get('manifestPath'),
             'visualReview': 'required', 'physicalTestStatus': 'not-run',
             'artifacts': [{'path': str(p.relative_to(output)), 'sha256': sha(p), 'bytes': p.stat().st_size}
                           for p in sorted(output.rglob('*')) if p.is_file()]}
    report = output / '使用指南验收.json'
    write_json(report, proof)
    state['stage'] = 'verify'; state['proofPath'] = str(report); _save(state)
    if not proof['qualified'] and not state['learningId']:
        raise ValueError('使用指南验收未通过：' + json.dumps(quality.get('diagnostics', {}), ensure_ascii=False))
    result = {'runId': state['runId'], 'productCode': state['facts']['productCode'], 'outputPath': str(output),
            'zhPath': str(output / (state['facts']['productCode'] + '_User_Guide.md')),
            'enPath': str(output / (state['facts']['productCode'] + '_User_Guide_en.md')),
            'reportPath': str(report), 'qualitySummary': quality, 'physicalTestStatus': 'not-run'}
    if state['learningId']:
        result['learningComparison'] = {'qualitySummary': quality, 'narrative': state['plans'].get('narrative'),
            'annotation': {**state['plans'].get('annotation', {}),
                           'exportedImageCount': len(state.get('annotationManifests', [])),
                           'renderedLabels': [{'ref': item['code'], 'title': item['title']}
                                              for manifest in state.get('annotationManifests', []) for item in manifest.get('regions', [])]},
            'editorialInventory': evaluation.get('files'),
            'factsSummary': {'productCode': state['facts']['productCode'], 'board': state['facts']['board'],
                             'photoNotes': [image['note'] for image in state['facts']['images']],
                             'physicalTestStatus': 'not-run'}}
    return result

def qualify_learning(learning_id, document, visual_review_path):
    """Release only the model-compared, structurally verified and viewed snapshot."""
    with sqlite3.connect('file:' + str(ROOT / '.local/workbench.sqlite') + '?mode=ro', uri=True) as db:
        row = db.execute('SELECT value FROM workflow_learning WHERE id=?', (learning_id,)).fetchone()
        job = json.loads(row[0]) if row else {}
        if job.get('status') != 'complete' or job.get('bestScore', 0) < 95 or fingerprint(job['bestDocument']) != fingerprint(document):
            raise ValueError('需要已达标的完整案例学习及相同工作流版本。')
        contract = json.loads(CONTRACT.read_text())
        reference_hashes = {item['sha256'] for item in contract['references']}
        config = job['config']
        if config.get('comparison') != 'model' or not config.get('trainingCases') or not config.get('validationCases'):
            raise ValueError('放行需要实际参考原文模型对比和参数验证。')
        for case in config['trainingCases'] + config['validationCases']:
            if {item.get('sha256') for item in case['expected'].get('referenceExamples', [])} != reference_hashes:
                raise ValueError('学习对照材料不是当前已核验的 S31 目标文档。')
        round_ = next(r for r in job['rounds'] if r['index'] == job['bestRound'])
        proof = []
        for case in round_['cases']:
            if case.get('status') != 'complete' or case.get('score', 0) < 95:
                raise ValueError('每个案例的参考对比均须达到目标。')
            run_row = db.execute('SELECT value FROM workflow_runs WHERE id=?', (case['runId'],)).fetchone()
            run = json.loads(run_row[0])
            report = Path(run['output']['reportPath'])
            evidence = json.loads(report.read_text())
            if run['status'] != 'complete' or not evidence['qualified'] or not all(evidence['qualitySummary']['checks'].values()):
                raise ValueError('学习样例没有通过完整的真实产物验收。')
            output = report.parent
            for artifact in evidence['artifacts']:
                path = (output / artifact['path']).resolve()
                if not path.is_relative_to(output.resolve()) or sha(path) != artifact['sha256']:
                    raise ValueError('案例产物哈希不一致。')
            proof.append({'path': str(report), 'sha256': sha(report), 'kind': 'artifact-report'})
        review = Path(visual_review_path).resolve()
        reviewed = json.loads(review.read_text())
        if reviewed.get('status') != 'reviewed' or not set(c['runId'] for c in round_['cases']) <= set(reviewed.get('runIds', [])):
            raise ValueError('缺少当前最佳轮次样例的图片与指南实际检查。')
        proof.append({'path': str(review), 'sha256': sha(review)})
    files = ['hdk/guide_pipeline.py', 'hdk/guide_facts.py', 'hdk/guide_render.py', 'hdk/guide_drawio.py', 'hdk/guide_reference.py',
             'hdk/guide_sdk.py', 'hdk/pinout_facts.py', 'hdk/test_firmware.py', 'scripts/openinterfacemark-convert.mjs', 'scripts/render-user-guide-preview.mjs']
    gate = {'schemaVersion': 1, 'status': 'qualified', 'learningId': learning_id, 'bestRound': job['bestRound'],
            'documentFingerprint': fingerprint(document), 'contractSha256': sha(CONTRACT), 'caseProof': proof,
            'implementationHashes': {path: sha(ROOT / path) for path in files},
            'scope': 'One paired S31 reference board plus release-parameter consistency, not independent hardware generalization',
            'qualifiedAt': dt.datetime.now(dt.timezone.utc).isoformat()}
    write_json(GATE, gate)
    return gate

def execute_stage(operation, value):
    if operation not in OPERATIONS: raise ValueError('未知使用指南操作。')
    run = _run(operation)
    if operation == 'prepare': return _prepare(value, run)
    state = _load(run)
    previous = {'annotate': 'prepare', 'write': 'annotate', 'verify': 'write'}[operation]
    if state.get('stage') != previous: raise ValueError('节点执行顺序与指南状态不一致。')
    if operation == 'annotate': return _annotate(value, state)
    if operation == 'write': return _write_guide(value, state)
    return _verify(value, state)

def _verify_annotations(state):
    manifests = state.get('annotationManifests', [])
    if len(manifests) != 4: return False
    output = Path(state['outputPath']).resolve()
    try:
        for entry in manifests:
            manifest_path = Path(entry['manifestPath']).resolve()
            if not manifest_path.is_relative_to(output): return False
            recorded = json.loads(manifest_path.read_text())
            if recorded != {key: value for key, value in entry.items() if key not in ('pngPath', 'svgPath', 'projectPath', 'manifestPath')}: return False
            if recorded['converter']['commit'] != 'f8f92636b2eb87ac956997e77c9239cf483913fc': return False
            source = recorded['source']
            if not Path(source['path']).resolve().is_relative_to(output) or sha(source['path']) != source['sha256']: return False
            bound = json.loads(Path(source['path']).read_text())
            if hashlib.sha256(base64.b64decode(bound['image']['src'].split(',')[1])).hexdigest() != source['embeddedImage']['sha256']: return False
            for artifact in recorded['artifacts']:
                path = Path(artifact['path']).resolve()
                if not path.is_relative_to(output) or sha(path) != artifact['sha256']: return False
            verification = recorded['verification']
            if verification.get('defaultExampleExported') is not False or verification.get('pageErrors') or any(
                verification.get(key) is not True for key in ('freshContext', 'boundProjectReadbackMatched', 'imageDecodedDimensionsMatched', 'sourceHashMatched', 'pngDimensionsMatched', 'svgLabelCountMatched', 'svgEmbeddedImageMatched', 'allRequestsLocalGet')): return False
    except (KeyError, ValueError, OSError, TypeError): return False
    return True

def run_stage(operation, value):
    # Workflow's minimal Python worker may lack Pillow. Use the bundled runtime
    # through a fixed capability entrypoint; no source text becomes a shell call.
    if Path(sys.executable).resolve() != PYTHON.resolve():
        with tempfile.TemporaryDirectory(prefix='guide-stage-', dir=ROOT / '.local') as tmp:
            request = Path(tmp) / 'request.json'
            write_json(request, {'operation': operation, 'input': value})
            return _process([PYTHON, '-I', ROOT / 'hdk/guide_pipeline.py', request], timeout=900)
    return execute_stage(operation, value)

if __name__ == '__main__':
    sys.path.insert(0, str(ROOT))
    request = json.loads(Path(sys.argv[1]).read_text())
    print(json.dumps(execute_stage(request['operation'], request['input']), ensure_ascii=False))
