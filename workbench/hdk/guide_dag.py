"""Independent, immutable bilingual-guide capabilities for the v2 DAG.

The old linear controller and its release gate are deliberately not used. Tools
own facts, geometry and exports; the two Skills own bounded labels and prose.
Actual annotations and language-specific diagrams must be reviewed before the
author Skill can run, with separate review ports or a historical combined gate.
"""
import copy
import datetime as dt
import base64
import hashlib
import io
import math
import json
import os
from pathlib import Path
import re
import shutil
import xml.etree.ElementTree as ET

from hdk import guide_facts, guide_sdk, guide_reference, guide_render, guide_drawio
from hdk import guide_pipeline as legacy

OPERATIONS = (
    'hdk.guide.prepare', 'hdk.guide.import-four', 'hdk.guide.facts',
    'hdk.guide.drawio', 'hdk.guide.annotate-front-zh',
    'hdk.guide.annotate-front-en', 'hdk.guide.annotate-back-zh',
    'hdk.guide.annotate-back-en', 'hdk.guide.author-input',
    'hdk.guide.assemble', 'hdk.guide.verify',
)
DERIVED_ROLES = {'schematic-preview', 'mechanical-preview', 'pinout', 'pinout-back',
                 'schematic-pdf', 'mechanical-cad', 'step'}
IMAGE_PORTS = {'frontZh': ('front', 'zh'), 'frontEn': ('front', 'en'),
               'backZh': ('back', 'zh'), 'backEn': ('back', 'en')}
SDK_PATHS = (guide_sdk.UNIX_SETUP, guide_sdk.WINDOWS_SETUP,
             guide_sdk.WINDOWS_CURRENT, guide_sdk.PROJECT_GUIDE,
             'README.md', 'install.sh', 'install.bat', 'export.sh', 'export.bat',
             'tools/install_util.py', 'tools/tools.json',
             'docs/en/get-started/establish-serial-connection.rst')


def _file(path, api, maximum=100_000_000):
    if not isinstance(path, str) or not path.strip():
        raise ValueError('请提前准备有效的指南输入文件。')
    raw = Path(path).expanduser()
    if raw.is_symlink():
        raise ValueError('指南输入不能是符号链接。')
    file = raw.resolve()
    if not file.is_file() or not 0 < file.stat().st_size <= maximum:
        raise ValueError('指南输入文件缺失、为空或超过大小预算：' + file.name)
    return {'path': str(file), 'sha256': api.sha(file)}


def _sources(*groups):
    result = {}
    for group in groups:
        for item in group:
            if item['path'] in result and result[item['path']]['sha256'] != item['sha256']:
                raise ValueError('指南依赖了不同版本的同一路径。')
            result[item['path']] = item
    return list(result.values())


def _annotation_presentation(value=None):
    if value is None:
        return {'labelMode': 'source-detail'}
    if (not isinstance(value, dict) or set(value) != {'labelMode'}
            or value['labelMode'] not in ('source-detail', 'english-name-only', 'english-name-with-ref', 'localized-name-with-refs')):
        raise ValueError('指南标注显示策略无效。')
    return copy.deepcopy(value)


def _diagram_presentation(value=None):
    if value is None: return {'languages': ['en']}
    if (not isinstance(value, dict) or 'languages' not in value or not set(value).issubset({'languages', 'showDesignators'})
            or value['languages'] not in (['en'], ['zh', 'en'])
            or 'showDesignators' in value and not isinstance(value['showDesignators'], bool)):
        raise ValueError('指南框图语言必须明确为 en 或 zh/en。')
    return copy.deepcopy(value)


def _load(value, run, operation, api):
    data = api.load(value, run, operation)
    for name, expected_remote, expected_commit in (
        ('sdkRepository', guide_sdk.SDK_REPOSITORY, guide_sdk.SDK_COMMIT),
        ('bspRepository', guide_sdk.BSP_REPOSITORY, guide_sdk.BSP_COMMIT),
    ):
        if data.get('request', {}).get(name):
            guide_sdk._repository(data['request'][name], expected_remote, expected_commit)
    imported = data.get('importedReceipt') or data.get('fourReceipt')
    if imported:
        current = api.foreign_receipt(imported['receiptPath'], 'hdk.four.verify', data['sourceSha256'])
        if current['importedReceipt'] != imported:
            raise ValueError('指南依赖的四文件版本已经变化。')
        _four_photo_binding(current, data['request'], api)
    return data


def _repository_sources(request, product, api):
    """Hash only consumed pinned blobs, never recursively snapshot an SDK tree."""
    sdk = guide_sdk._repository(request['sdkRepository'], guide_sdk.SDK_REPOSITORY, guide_sdk.SDK_COMMIT)
    bsp = guide_sdk._repository(request['bspRepository'], guide_sdk.BSP_REPOSITORY, guide_sdk.BSP_COMMIT)
    result, blobs = [], []
    specifications = [(sdk, guide_sdk.SDK_COMMIT, name, True) for name in SDK_PATHS]
    specifications += [(bsp, guide_sdk.BSP_COMMIT, name, False) for name in (
        guide_sdk.BLINK_SOURCE, 'components/wt_bsp/boards/' + product + '/Kconfig.projbuild',
        'components/wt_bsp/tools/wt_bsp_project.cmake', 'examples/get-started/blink/CMakeLists.txt')]
    if product == 'WT9932P4C61-TINY':
        specifications += [(bsp, guide_sdk.BSP_COMMIT, name, False) for name in (
            guide_sdk.P4_BOARD_DEFAULTS, guide_sdk.P4_TARGET_DEFAULTS)]
    for repo, commit, relative, required in specifications:
        _, proof = guide_sdk._blob(repo, commit, relative, require_file=required)
        blobs.append({**proof, 'repositoryPath': str(repo), 'commit': commit})
        if (repo / relative).is_file():
            result.append(_file(str(repo / relative), api))
    return result, blobs


def prepare(value, api):
    required = {'sourcePath', 'frontImage', 'backImage', 'guideProfilePath',
                'fourFilesDirectory', 'productCode', 'hardwareVersion', 'releaseDate'}
    if not isinstance(value, dict) or set(value) != required:
        raise ValueError('指南输入需要工程、正反照片、指南区域配置、四文件目录、产品、版本和日期。')
    product, version, date = (value[k] for k in ('productCode', 'hardwareVersion', 'releaseDate'))
    if not isinstance(product, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{1,79}', product):
        raise ValueError('指南产品编号无效。')
    if not isinstance(version, str) or not re.fullmatch(r'\d{1,4}(?:\.\d{1,4}){1,2}', version):
        raise ValueError('指南硬件版本需要如 1.0。')
    if not isinstance(date, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', date) or dt.date.fromisoformat(date).isoformat() != date:
        raise ValueError('指南日期需要有效的 YYYY-MM-DD。')
    source = _file(value['sourcePath'], api)
    if Path(source['path']).suffix.lower() != '.epro2':
        raise ValueError('指南源工程必须是 epro2。')
    native, _, _, pcb = guide_facts.pinout_facts._source(source['path'])
    profile_file = _file(value['guideProfilePath'], api, 2_000_000)
    profile = api.read(profile_file['path'])
    if (not isinstance(profile, dict) or profile.get('format') != 'workbench-guide-profile'
            or profile.get('version') != 1 or profile.get('sourceSha256') != source['sha256']
            or profile.get('pcbUuid') != pcb['head']['uuid']):
        raise ValueError('请准备与当前工程绑定的指南照片区域配置。')
    presentation = _annotation_presentation(profile.get('annotationPresentation'))
    diagram_presentation = _diagram_presentation(profile.get('diagramPresentation'))
    if not isinstance(profile.get('images'), list) or len(profile['images']) != 2 or {i.get('side') for i in profile['images']} != {'front', 'back'}:
        raise ValueError('指南配置需要各一份正面和背面区域。')
    refs = {item.get('Designator') for item in guide_facts.pinout_facts._attrs(pcb).values() if item.get('Designator')}
    photos, sources = [], [source, profile_file]
    for side in ('front', 'back'):
        image = copy.deepcopy(next(i for i in profile['images'] if i['side'] == side))
        original = _file(value[side + 'Image'], api, 50_000_000)
        image['path'] = original['path']
        photo = guide_facts._photo(image, side, refs)
        # Dimensions are part of the human calibration, not freshly invented.
        if image.get('width') != photo['width'] or image.get('height') != photo['height']:
            raise ValueError('指南区域配置的原图尺寸已改变。')
        photos.append(photo); sources.append(original)
    ids = [r['id'] for image in photos for r in image['regions']]
    if len(ids) != len(set(ids)):
        raise ValueError('指南正反面区域 ID 不得重复。')
    documents = profile.get('technicalDocuments', [])
    if not isinstance(documents, list) or len(documents) > 40:
        raise ValueError('指南技术资料需要最多 40 个明确文件。')
    contract = api.read(guide_reference.DEFAULT_CONTRACT)
    answers = contract['references'] + contract.get('knownResultArtifacts', [])
    forbidden_paths = {str(Path(item['path']).resolve()) for item in answers}
    forbidden_hashes = {item['sha256'] for item in answers}
    copy_roles = {'test-sop', 'test-instructions', 'flash-instructions', 'build-replay',
                  'bsp-board-notes', 'module-datasheet', 'primary-chip-datasheet', 'companion-chip-datasheet'}
    seen_roles = set()
    for document in documents:
        if not isinstance(document, dict) or document.get('role') in DERIVED_ROLES:
            raise ValueError('工程衍生资料应由四文件节点导入，不能在指南配置中绕过。')
        file = _file(document.get('path'), api)
        if file['path'] in forbidden_paths or file['sha256'] in forbidden_hashes:
            raise ValueError('学习目标只供评估器使用，不能作为执行技术资料。')
        role = document.get('role')
        if role in copy_roles and role in seen_roles:
            raise ValueError('指南技术资料存在同角色多个文件，请提前明确选择：' + role)
        seen_roles.add(role)
        sources.append(file)
    guide_facts._documents(documents, source['sha256'])
    template = profile.get('drawioTemplate')
    if not isinstance(template, dict) or set(template) != {'path', 'sha256'}:
        raise ValueError('请在指南配置中明确选择原始 DrawIO 源文件及 SHA。')
    template_file = _file(template['path'], api, 2_000_000)
    if template_file['sha256'] != template['sha256'] or Path(template_file['path']).suffix.lower() not in ('.drawio', '.xml'):
        raise ValueError('所选 DrawIO 原始模板的格式或 SHA 已改变。')
    from hdk import guide_drawio_template_v2 as template_adapter
    template_adapter.inspect_template(template_file['path'])
    sources.append(template_file)
    request = {'sourcePath': str(native), 'productCode': product, 'hardwareVersion': version,
               'releaseDate': date, 'images': photos, 'technicalDocuments': documents,
               'bspRepository': profile.get('bspRepository'), 'sdkRepository': profile.get('sdkRepository')}
    repository_files, blobs = _repository_sources(request, product, api)
    selected = Path(value['fourFilesDirectory']).expanduser().resolve()
    if not selected.is_dir() or not (selected / 'receipt.json').is_file():
        raise ValueError('请先准备已执行完成且人工审核通过的 v2 四文件验收目录。')
    # Reject incomplete/stale imports before any Skill or image rendering starts.
    imported = api.foreign_receipt(selected / 'receipt.json', 'hdk.four.verify', source['sha256'])
    _four_photo_binding(imported, request, api)
    implementations = [Path(__file__), *[Path(m.__file__) for m in (
        guide_facts, guide_facts.pinout_facts, guide_facts.test_firmware,
        guide_sdk, guide_reference, guide_render, guide_drawio, legacy, template_adapter)],
        legacy.ROOT / 'scripts/openinterfacemark-convert.mjs',
        legacy.ROOT / 'scripts/render-user-guide-preview.mjs']
    return {'request': request, 'sourceSha256': source['sha256'], 'pcbUuid': pcb['head']['uuid'],
            'profilePath': profile_file['path'], 'fourFilesDirectory': str(selected),
            'drawioTemplate': template_file, 'annotationPresentation': presentation,
            'diagramPresentation': diagram_presentation,
            'fourReceipt': imported['importedReceipt'], 'repositoryBlobs': blobs,
            'sourceFiles': _sources(sources, repository_files, [_file(str(p), api) for p in implementations])}


def _four_photo_binding(imported, request, api):
    origin = api.row('workflow_runs', imported['runId'])
    if (imported.get('status') != 'complete' or not imported.get('checks')
            or not all(v is True for v in imported['checks'].values())):
        raise ValueError('导入四文件必须是工程与图片检查全部通过的普通执行成果。')
    definitions = [n for n in origin['document']['nodes'] if n.get('config', {}).get('toolName') == 'hdk.four.prepare']
    if len(definitions) != 1:
        raise ValueError('四文件来源必须有唯一真实输入准备节点。')
    parent = origin['nodes'].get(definitions[0]['id'], {}).get('output', {})
    original = api.foreign_receipt(parent.get('receiptPath'), 'hdk.four.prepare', imported['sourceSha256'])
    expected = {i['side']: i['sha256'] for i in request['images']}
    actual = {i['side']: i['sha256'] for i in original['request']['images']}
    if expected != actual or original['request']['productCode'] != request['productCode']:
        raise ValueError('指南原图或产品与已审核四文件输入不同，请重新准备匹配资料。')
    human_id = imported.get('humanReview', {}).get('nodeId')
    human = origin['nodes'].get(human_id, {})
    approved = imported.get('humanReview', {}).get('artifactHashes', [])
    if human.get('review', {}).get('artifactHashes') != approved:
        raise ValueError('四文件图像审核记录与当前人工决定不一致。')
    candidates = [i for i in imported.get('proofFiles', []) if Path(i['path']).suffix.lower() == '.png' and '_Pinout_' in Path(i['path']).name]
    digests = {i['sha256'] for i in candidates}
    files = [{'path': a['path'], 'sha256': a['sha256']} for a in human.get('artifacts', [])
             if a.get('sha256') in digests and a['path'].lower().endswith('.png')]
    if len(files) != 2 or len(digests) != 2:
        raise ValueError('四文件人工审核没有绑定本次正反面实际 Pinout。')
    api.reviewed_artifacts(origin, {'nodeId': imported['importedReceipt']['nodeId']}, human.get('output'), files)
    current = api.row('workflow_runs', imported['runId'])
    selected = current.get('nodes', {}).get(imported['importedReceipt']['nodeId'], {}).get('output', {})
    if (current.get('status') != 'complete' or selected.get('receiptSha256') != imported['importedReceipt']['receiptSha256']
            or current.get('nodes', {}).get(human_id, {}).get('review') != human.get('review')):
        raise ValueError('四文件成果或人工审批正在更新，请重新选择完成版本。')
    return original


def _one(items, predicate, label):
    values = {str(Path(i['path']).resolve()): i for i in items if predicate(Path(i['path']))}
    if len(values) != 1:
        raise ValueError('四文件导入缺失或歧义：' + label)
    return next(iter(values.values()))


def _import_four(prepared, out, api):
    path = Path(prepared['fourFilesDirectory']) / 'receipt.json'
    if api.sha(path) != prepared['fourReceipt']['receiptSha256']:
        raise ValueError('所选择四文件回执已变化。')
    data = api.foreign_receipt(path, 'hdk.four.verify', prepared['sourceSha256'])
    original = _four_photo_binding(data, prepared['request'], api)
    candidates = [i for i in data.get('proofFiles', []) if Path(i['path']).parent == path.parent]
    names = {'schematic-pdf': lambda p: p.suffix.lower() == '.pdf' and '_SCH_' in p.name,
             'step': lambda p: p.suffix.lower() in ('.step', '.stp'),
             'mechanical-cad': lambda p: p.suffix.lower() == '.dwg',
             'mechanical-preview': lambda p: p.suffix.lower() == '.png' and '_CAD_' in p.name,
             'pinout': lambda p: p.suffix.lower() == '.png' and '_Pinout_' in p.name and '_Back_' not in p.name,
             'pinout-back': lambda p: p.suffix.lower() == '.png' and '_Pinout_Back_' in p.name}
    documents = [{**_one(candidates, predicate, role), 'role': role} for role, predicate in names.items()]
    pdf = next(d for d in documents if d['role'] == 'schematic-pdf')
    import pypdfium2 as pdfium
    from importlib.metadata import version
    rendered = out / 'schematic-preview.png'
    with pdfium.PdfDocument(pdf['path']) as document:
        if len(document) < 1:
            raise ValueError('已导入原理图 PDF 没有图页。')
        page = document[0]
        try:
            bitmap = page.render(scale=2)
            try: bitmap.to_pil().save(rendered)
            finally: bitmap.close()
        finally: page.close()
    preview = {'path': str(rendered), 'sha256': api.sha(rendered), 'role': 'schematic-preview'}
    conversion = {'source': pdf, 'method': 'pypdfium2 actual PDF page rasterization',
                  'version': version('pypdfium2'), 'page': 1, 'scale': 2, 'artifact': preview,
                  'scope': 'First schematic page preview; full original PDF is retained.'}
    conversion_path = out / 'schematic-preview.conversion.json'; api.write(conversion_path, conversion)
    documents.append(preview)
    report = out / 'guide-engineering-import.json'
    api.write(report, {'status': 'complete', 'sourceSha256': prepared['sourceSha256'],
                       'importedReceipt': data['importedReceipt'], 'files': documents,
                       'humanReview': data['humanReview'], 'checks': data['checks'],
                       'previewConversionPath': str(conversion_path)})
    for document in documents: document['bindingReportPath'] = str(report)
    proof = _sources(data.get('proofFiles', []), original.get('sourceFiles', []),
                     [{'path': str(path), 'sha256': api.sha(path)},
                      {'path': original['importedReceipt']['receiptPath'], 'sha256': original['importedReceipt']['receiptSha256']},
                      {'path': str(conversion_path), 'sha256': api.sha(conversion_path)}])
    return {**prepared, 'engineeringDocuments': documents, 'importedReceipt': data['importedReceipt'],
            'proofFiles': proof, 'reportPath': str(report)}


def _skill(run, context, plan, expected_input):
    edges = [e for e in run['document']['edges'] if e['targetNode'] == context['nodeId'] and e['targetPort'] == 'plan']
    definition = next((n for n in run['document']['nodes'] if len(edges) == 1 and n['id'] == edges[0]['sourceNode']), {})
    record = run['nodes'].get(definition.get('id'), {})
    if (definition.get('type') != 'skill' or record.get('status') != 'complete'
            or record.get('input') != expected_input or record.get('output') != plan):
        raise ValueError('指南计划必须来自本次输入事实对应的真实 Skill 节点。')
    config = definition['config']
    if not config.get('skillRef') or not config.get('version'):
        raise ValueError('指南 Skill 需要固定版本。')
    return {'nodeId': definition['id'], 'ref': config['skillRef'], 'version': config['version']}


def _facts(prepared, engineering, out, api):
    if prepared['sourceSha256'] != engineering['sourceSha256'] or prepared['request'] != engineering['request']:
        raise ValueError('指南分支没有使用相同的输入快照。')
    request = copy.deepcopy(prepared['request'])
    request['technicalDocuments'] += engineering['engineeringDocuments']
    facts = guide_facts.prepare_guide_facts(request)
    previous_cache = guide_sdk.EVIDENCE_CACHE
    try:
        guide_sdk.EVIDENCE_CACHE = out / 'sdk-evidence'
        facts = guide_sdk.enrich_guide_development(facts, request)
    finally:
        guide_sdk.EVIDENCE_CACHE = previous_cache
    if facts['source']['sha256'] != prepared['sourceSha256']:
        raise ValueError('指南事实源工程在准备后发生变化。')
    commands = facts.get('development', {}).get('verifiedCommands', [])
    if not commands: raise ValueError('指南缺少当前 BSP 已核对的开发命令。')
    facts['requiredCommands'] = [item['shell'] for item in commands]
    facts['forbiddenClaims'] = ['未生成图片标注', '未完成图片标注', 'no image annotations']
    facts['annotationPresentation'] = _annotation_presentation(prepared.get('annotationPresentation'))
    facts['diagramPresentation'] = _diagram_presentation(prepared.get('diagramPresentation'))
    bindings = _annotation_source_bindings(facts)
    for image in facts['images']:
        for region in image['regions']:
            region['titleZh'] = bindings[region['id']]['titleZh']
            region['titleEn'] = bindings[region['id']]['titleEn']
    path = out / 'board-facts.json'; api.write(path, facts)
    annotation_input = {'productCode': facts['productCode'], 'displayImageWidth': 1400,
                        'planContract': _annotation_plan_contract(facts['annotationPresentation']),
                        'images': [{k: i[k] for k in ('side', 'width', 'height', 'note')} | {
                            'regions': [bindings[r['id']] for r in i['regions']]}
                            for i in facts['images']]}
    return {**engineering, 'facts': facts, 'factsPath': str(path), 'annotationInput': annotation_input,
            'sourceFiles': _sources(prepared['sourceFiles'], facts['sourceFiles'])}


def _annotation_plan_contract(presentation=None):
    """Send the complete renderer input bounds to the planning Skill.

    These are requested sizes at the 900px source-photo baseline, rather than
    final canvas pixel sizes. The existing validator remains authoritative.
    """
    presentation = _annotation_presentation(presentation)
    localized = presentation['labelMode'] == 'localized-name-with-refs'
    english_only = presentation['labelMode'] in ('english-name-only', 'english-name-with-ref')
    with_ref = presentation['labelMode'] == 'english-name-with-ref'
    style = {'color': '#ef4444', 'dashed': True, 'stroke': 3, 'fontSize': 18,
             'radius': 5, 'orientation': 'horizontal', 'connectors': 'straight'}
    return {
        'requiredKeys': ['regions', 'style'], 'additionalKeys': False,
        'presentation': {**presentation, 'displayLanguage': 'en' if english_only else 'branch-language',
                         'visibleFields': ['source references', 'localized function name'] if localized else (['source references', 'English function name'] if with_ref else ['English function name']) if english_only else ['source references', 'localized function name', 'source part'],
                         'sourceEvidence': 'Both internal titleZh/titleEn fields and all source refs, parts and pins remain bound evidence; display policy never edits hardware facts.'},
        'style': style,
        'styleConstraints': {
            'requiredKeys': list(style), 'additionalKeys': False,
            'color': {'type': 'string', 'pattern': '^#[a-fA-F0-9]{6}$', 'default': style['color']},
            'dashed': {'type': 'boolean', 'default': style['dashed']},
            'stroke': {'type': 'number', 'minimum': 1, 'maximum': 8, 'default': style['stroke']},
            'fontSize': {'type': 'number', 'minimum': 12, 'maximum': 22, 'default': style['fontSize']},
            'radius': {'type': 'number', 'minimum': 0, 'maximum': 20, 'default': style['radius']},
            'orientation': {'type': 'string', 'enum': ['horizontal'], 'default': 'horizontal'},
            'connectors': {'type': 'string', 'enum': ['straight'], 'default': 'straight'},
            'units': 'Requested sizes use a 900px source-photo baseline. The tool scales them for the original photo; do not enlarge them for high-resolution input.',
        },
        'regions': {
            'type': 'array', 'requiredKeys': ['id', 'titleZh', 'titleEn'], 'additionalKeys': False,
            'coverage': 'Include every id from images[].regions exactly once, across both faces. Do not add, omit or duplicate an id.',
            'titleZh': {'type': 'string', 'minLength': 1, 'maxLength': 90, 'choices': 'Copy exactly one nameChoicesZh value from the matching source-derived region.'},
            'titleEn': {'type': 'string', 'minLength': 1, 'maxLength': 40 if english_only else 90, 'choices': 'Copy exactly one nameChoicesEn value from the matching source-derived region.'},
        },
        'titles': ('Choose exact source-derived nameChoices for both language fields. Chinese-guide images display the exact schematic reference plus titleZh; English-guide images display that same reference plus titleEn. The tool adds the actual reference. Do not repeat references or append source part/model text to either title. All refs, parts, nets and photo geometry remain source evidence.' if localized else ('Choose exact source-derived nameChoices for both internal language fields. Every output image, including the Chinese-guide branches, displays the exact native schematic reference plus titleEn as its English function name. The tool adds the source reference; do not repeat it in titleEn or add models or Chinese text. Internal titleZh, parts and nets remain source evidence.' if with_ref else 'Choose exact source-derived nameChoices for both internal language fields. Every output image, including the Chinese-guide branches, displays only titleEn as its English function name. Do not add models, reference designators or Chinese text. Internal titleZh, refs, parts and nets remain read-only source evidence.') if english_only else 'Choose an exact source-derived nameChoice for each language; refs, parts and nets are read-only. Do not invent names or translate a different choice. The tool appends the actual part.'),
        'layout': 'Use orientation=horizontal and connectors=straight. The tool rotates the actual source photo losslessly and places straight collinear connector labels; do not return coordinates or alter source refs, parts, nets or photo geometry.',
    }


def _annotation_source_bindings(facts):
    """Profile locates regions; native SCH/PCB supply identities and pin facts."""
    source, raw, docs, pcb = guide_facts.pinout_facts._source(facts['source']['path'])
    if hashlib.sha256(raw).hexdigest() != facts['source']['sha256'] or pcb['head']['uuid'] != facts['source']['pcbUuid']:
        raise ValueError('标注事实与当前原工程不一致。')
    native = guide_facts.test_firmware.inspect_board(source)
    components = {c['designator']: c for c in native['board']['components']}
    schematic = {a['Designator'] for d in docs.values() if d['head'].get('docType') == 'SCH_PAGE'
                 for a in guide_facts.pinout_facts._attrs(d).values() if a.get('Designator')}
    recorded = {c['ref']: c for c in facts['components']}
    result = {}
    for image in facts['images']:
        for region in image['regions']:
            values = []
            for ref in region['refs']:
                component = components.get(ref); saved = recorded.get(ref)
                if (not component or ref not in schematic or not saved
                        or saved.get('sourceComponentId') != component['componentUuid']
                        or saved.get('part') != component['part']):
                    raise ValueError('标注区域没有绑定当前原理图与PCB的真实元件：' + ref)
                zh, en, kind = guide_facts._title(component, native['board']['moduleRef'], native['peripherals'])
                pins = [{'number': str(p['pad']), 'name': p['name'], 'net': p['net']} for p in component['pins']]
                actual_pins = [{k: p[k] for k in ('number', 'name', 'net')} for p in saved.get('pins', [])]
                if pins != actual_pins:
                    raise ValueError('标注元件针脚网络与当前原工程不一致：' + ref)
                values.append({'ref': ref, 'part': component['part'], 'nameZh': zh, 'nameEn': en,
                               'kind': kind, 'sourceComponentId': component['componentUuid'], 'pins': pins})
            zh = ' / '.join(c['nameZh'] for c in values); en = ' / '.join(c['nameEn'] for c in values)
            aliases_zh, aliases_en = [zh], [en]
            if len(values) == 1 and values[0]['kind'] == 'reset': aliases_zh.append('RESET 按键'); aliases_en.append('RESET button')
            if len(values) == 1 and values[0]['kind'] == 'module' and len(native['board'].get('targets', [])) == 2:
                aliases_zh.append('双芯片模组'); aliases_en.append('Dual-chip module')
            result[region['id']] = {'id': region['id'], 'refs': list(region['refs']),
                'titleZh': zh, 'titleEn': en, 'nameChoicesZh': aliases_zh, 'nameChoicesEn': aliases_en,
                'sourceComponents': values}
    return result


def _validate_annotation_v2(plan, facts, bindings=None):
    if not isinstance(plan, dict) or not isinstance(plan.get('style'), dict):
        raise ValueError('标注计划需要 regions/style。')
    normalized = copy.deepcopy(plan)
    orientation = normalized['style'].pop('orientation', 'horizontal')
    connectors = normalized['style'].pop('connectors', 'straight')
    if orientation != 'horizontal' or connectors != 'straight':
        raise ValueError('指南标注仅支持 orientation=horizontal、connectors=straight。')
    selected, style = legacy._validate_annotation(normalized, facts)
    bindings = bindings if bindings is not None else _annotation_source_bindings(facts)
    for ident, label in selected.items():
        binding = bindings[ident]
        for language, suffix in (('zh', 'Zh'), ('en', 'En')):
            if label['title' + suffix] not in binding['nameChoices' + suffix]:
                raise ValueError('标注名称必须选择当前原理图支持的名称：' + ident + '/' + language)
        presentation = _annotation_presentation(facts.get('annotationPresentation'))
        for language in ('zh', 'en') if presentation['labelMode'] == 'localized-name-with-refs' else ('en',):
            _annotation_display(binding, label, language, presentation)
    return selected, style, bindings


def _annotation_display(binding, label, language, presentation):
    if presentation['labelMode'] != 'source-detail':
        localized = presentation['labelMode'] == 'localized-name-with-refs'
        suffix = 'Zh' if localized and language == 'zh' else 'En'
        title = label['title' + suffix]
        parts = [c['part'] for c in binding['sourceComponents'] if c.get('part')]
        if (not isinstance(title, str) or not 1 <= len(title) <= (90 if localized else 40)
                or title not in binding['nameChoices' + suffix] or suffix == 'En' and re.search(r'[\u3400-\u9fff\uf900-\ufaff]', title)
                or any(part.casefold() in title.casefold() for part in parts)
                or any(re.search(r'(?<![A-Za-z0-9])' + re.escape(ref) + r'(?![A-Za-z0-9])', title, re.I) for ref in binding['refs'])):
            raise ValueError('标注名称须来自对应语言的功能名候选，不能在名称中追加型号或位号。')
        # OIM's pinned two-line renderer permits an empty second line. Source
        # references live in sourceBindings, independent of these display slots.
        return ('/'.join(binding['refs']), title) if localized or presentation['labelMode'] == 'english-name-with-ref' else (title, '')
    part = ' / '.join(dict.fromkeys(c['part'] for c in binding['sourceComponents'] if c.get('part')))
    title = label['titleZh' if language == 'zh' else 'titleEn']
    if part and part not in title: title += ' · ' + part
    return '/'.join(binding['refs']), title


def _label_metrics(entries, font_size):
    script = """
import {pathToFileURL} from 'node:url';
const r=JSON.parse(process.argv[1]),{chromium}=await import(pathToFileURL(r.playwright).href),{fontFamilyCSS}=await import(pathToFileURL(r.core).href);
let browser,cancelled=false;const cancel=()=>{cancelled=true;void browser?.close().catch(()=>{});};process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
try {browser=await chromium.launch({channel:'chrome',headless:true,timeout:30000,handleSIGINT:false,handleSIGTERM:false});if(cancelled)throw Error('Font measurement cancelled');const context=await browser.newContext({serviceWorkers:'block'});await context.route('**/*',route=>route.abort());const page=await context.newPage();await page.setContent('<canvas></canvas>');
const result=await page.evaluate(async r=>{await document.fonts.ready;const ctx=document.querySelector('canvas').getContext('2d');ctx.font=`600 ${r.fontSize}px ${r.family}`;return r.entries.map(e=>{const m=[e.code,e.title].map(t=>ctx.measureText(t));return {width:Math.ceil(Math.max(...m.map(v=>Math.max(v.width,v.actualBoundingBoxLeft+v.actualBoundingBoxRight)))),ascent:Math.ceil(Math.max(...m.map(v=>v.actualBoundingBoxAscent))),descent:Math.ceil(Math.max(...m.map(v=>v.actualBoundingBoxDescent)))};});},{...r,family:fontFamilyCSS('sans')});if(cancelled)throw Error('Font measurement cancelled');process.stdout.write(JSON.stringify({metrics:result}));}finally{await browser?.close();if(cancelled)process.exitCode=1;}
"""
    reply = legacy._process([legacy.NODE, '--input-type=module', '--eval', script, json.dumps({
        'entries': [{'code': e['code'], 'title': e['title']} for e in entries], 'fontSize': font_size,
        'playwright': str(legacy.ROOT / '.local/converters/OpenStep2DWG/node_modules/playwright-core/index.mjs'),
        'core': str(legacy.ROOT / '.local/converters/OpenInterfaceMark/src/core.js')}, ensure_ascii=False)], timeout=60)
    metrics = reply.get('metrics', [])
    if (len(metrics) != len(entries) or any(not isinstance(m, dict) or any(
            isinstance(m.get(k), bool) or not isinstance(m.get(k), (int, float)) or not math.isfinite(m[k]) or m[k] < 0
            for k in ('width', 'ascent', 'descent')) or m['width'] <= 0 or m['ascent'] <= 0 for m in metrics)):
        raise ValueError('实际字体测量没有返回有效标注边界。')
    return metrics


def _overlap(a, b, gap=0):
    return a['x'] < b['x'] + b['w'] + gap and b['x'] < a['x'] + a['w'] + gap and a['y'] < b['y'] + b['h'] + gap and b['y'] < a['y'] + a['h'] + gap


def _line_box(line, box, gap=0):
    a, b = line
    if abs(a[0] - b[0]) < 1e-8:
        return box['x'] - gap < a[0] < box['x'] + box['w'] + gap and max(min(a[1], b[1]), box['y'] - gap) < min(max(a[1], b[1]), box['y'] + box['h'] + gap) - 1e-8
    return box['y'] - gap < a[1] < box['y'] + box['h'] + gap and max(min(a[0], b[0]), box['x'] - gap) < min(max(a[0], b[0]), box['x'] + box['w'] + gap) - 1e-8


def _place_straight_labels(entries, width, height, font_size):
    """Bounded search: source-edge anchors, straight exits, measured clear text."""
    choices = {}
    for entry in entries:
        rect, metric = entry['rect'], entry['metric']; candidates = []
        for side in ('top', 'bottom', 'left', 'right'):
            for offset in (.5, .1, .9, .25, .75, 0, 1):
                for gap in (45, 90, 150, 230, 340):
                    gap *= max(1, font_size / 22)
                    if side in ('left', 'right'):
                        ax, ay = (rect['x'] if side == 'left' else rect['x'] + rect['w']), rect['y'] + rect['h'] * offset
                        lx, ly = (-gap if side == 'left' else width + gap), ay
                        box = {'x': lx - metric['width'] if side == 'left' else lx, 'y': ly - metric['ascent'],
                               'w': metric['width'], 'h': metric['ascent'] + font_size * 1.3 + metric['descent']}
                        end = (lx + font_size * .35 if side == 'left' else lx - font_size * .35, ly)
                    else:
                        ax, ay = rect['x'] + rect['w'] * offset, (rect['y'] if side == 'top' else rect['y'] + rect['h'])
                        lx = ax
                        ly = -gap - font_size * 1.3 - metric['descent'] if side == 'top' else height + gap + metric['ascent']
                        box = {'x': lx - metric['width'] / 2, 'y': ly - metric['ascent'], 'w': metric['width'],
                               'h': metric['ascent'] + font_size * 1.3 + metric['descent']}
                        end = (lx, ly + (font_size * 1.4 if side == 'top' else -font_size * .65))
                    line = ((ax, ay), end)
                    if any(other['id'] != entry['id'] and _line_box(line, other['rect'], max(2, font_size * .2)) for other in entries): continue
                    candidates.append({'side': side, 'offset': offset, 'labelX': lx, 'labelY': ly,
                                       'box': box, 'line': line, 'distance': math.dist((ax, ay), end)})
        choices[entry['id']] = sorted(candidates, key=lambda c: c['distance'])
    assigned = {}; steps = 0
    def valid(candidate):
        return all(not _overlap(candidate['box'], old['box'], max(12, font_size * .5))
                   and not _line_box(candidate['line'], old['box'], max(5, font_size * .35))
                   and not _line_box(old['line'], candidate['box'], max(5, font_size * .35)) for old in assigned.values())
    def search():
        nonlocal steps
        steps += 1
        if steps > 20000: return False
        if len(assigned) == len(entries): return True
        options = [(ident, [c for c in values if valid(c)]) for ident, values in choices.items() if ident not in assigned]
        ident, candidates = min(options, key=lambda item: len(item[1]))
        for candidate in candidates:
            assigned[ident] = candidate
            if search(): return True
            del assigned[ident]
        return False
    if not search(): raise ValueError('当前文字尺寸无法在实拍区域之间布置互不遮挡的笔直引线，请缩短受控标签或调整字号。')
    return assigned


def _horizontal_annotation_project(image, selected, style, bindings, language, name, metrics=None, *, presentation=None):
    presentation = _annotation_presentation(presentation)
    from PIL import Image
    with Image.open(image['path']) as source:
        photo = source.convert('RGBA')
    rotation = 90 if photo.width < photo.height else 0
    if rotation: photo = photo.transpose(Image.Transpose.ROTATE_270)
    # Preserve large original photo pixels while keeping the requested display
    # style readable. The bounded Skill sizes use a 900px source-photo baseline.
    style_scale = max(1, max(image['width'], image['height']) / 900)
    effective_style = {**style, 'fontSize': round(style['fontSize'] * style_scale),
                       'stroke': style['stroke'] * style_scale, 'radius': style['radius'] * style_scale}
    if effective_style['fontSize'] > 400 or effective_style['stroke'] > 100 or effective_style['radius'] > 1000:
        raise ValueError('原照像素和标注尺寸超出OIM限制，请准备尺寸合理的已审核原照。')
    entries = []
    for raw in image['regions']:
        rect = {k: raw[k] for k in ('x', 'y', 'w', 'h')}
        if rotation: rect = {'x': image['height'] - rect['y'] - rect['h'], 'y': rect['x'], 'w': rect['h'], 'h': rect['w']}
        binding = bindings[raw['id']]
        code, title = _annotation_display(binding, selected[raw['id']], language, presentation)
        entries.append({'id': raw['id'], 'rect': rect, 'code': code, 'title': title})
    measured = metrics if metrics is not None else _label_metrics(entries, effective_style['fontSize'])
    if len(measured) != len(entries): raise ValueError('标注字体测量数量不一致。')
    for entry, metric in zip(entries, measured): entry['metric'] = metric
    layout = _place_straight_labels(entries, photo.width, photo.height, effective_style['fontSize'])
    boxes = [c['box'] for c in layout.values()]
    left = math.ceil(32 - min(0, *(b['x'] for b in boxes))); top = math.ceil(32 - min(0, *(b['y'] for b in boxes)))
    width = math.ceil(left + max(photo.width, *(b['x'] + b['w'] for b in boxes)) + 32)
    height = math.ceil(top + max(photo.height, *(b['y'] + b['h'] for b in boxes)) + 32)
    if width <= height:
        padding = math.ceil((height * 1.25 - width) / 2); left += padding; width += padding * 2
    if width > 16000 or height > 16000 or width * height > 32_000_000: raise ValueError('横向标注图超出实际导出预算。')
    canvas = Image.new('RGBA', (width, height), (255, 255, 255, 0)); canvas.paste(photo, (left, top))
    stream = io.BytesIO(); canvas.save(stream, format='PNG')
    regions = []
    for entry in entries:
        rect, candidate = entry['rect'], layout[entry['id']]
        regions.append({'id': entry['id'], 'kind': 'rect', 'code': entry['code'], 'title': entry['title'],
            **{k: rect[k] + (left if k == 'x' else top if k == 'y' else 0) for k in ('x', 'y', 'w', 'h')},
            'labelX': candidate['labelX'] + left, 'labelY': candidate['labelY'] + top,
            'anchorSide': candidate['side'], 'anchorOffset': candidate['offset'],
            'color': effective_style['color'], 'dashed': effective_style['dashed'], 'stroke': effective_style['stroke'],
            'fontSize': effective_style['fontSize'], 'radius': effective_style['radius'], 'fontFamily': 'sans', 'textColor': '#111827'})
    project = {'format': 'open-interface-mark', 'version': 1, 'name': name,
        'image': {'name': image['name'], 'width': width, 'height': height,
                  'src': 'data:image/png;base64,' + base64.b64encode(stream.getvalue()).decode(), 'scale': 1, 'rotation': 0},
        'regions': regions, 'exportSettings': {'background': 'white', 'scale': 1}}
    proof = {'version': 2, 'orientation': 'horizontal', 'connectors': 'straight', 'side': image['side'], 'language': language,
             'sourcePhotoSha256': image['sha256'], 'rotationClockwiseDegrees': rotation,
             'requestedStyle': style, 'effectiveStyle': effective_style, 'styleScale': style_scale,
             'photoBounds': {'x': left, 'y': top, 'width': photo.width, 'height': photo.height},
             'sourceToCanvas': {'a': 0 if rotation else 1, 'b': 1 if rotation else 0, 'c': -1 if rotation else 0,
                                'd': 0 if rotation else 1, 'e': left + (image['height'] if rotation else 0), 'f': top},
             'sourceBindings': [bindings[e['id']] for e in entries]}
    if presentation['labelMode'] != 'source-detail':
        proof.update(annotationPresentation=presentation, displayLanguage=language if presentation['labelMode'] == 'localized-name-with-refs' else 'en')
    return project, proof


def _annotation(plan, facts, side, language, out, api, learning):
    bindings = _annotation_source_bindings(facts)
    try: selected, style, bindings = _validate_annotation_v2(plan, facts, bindings)
    except ValueError as error:
        if learning: raise api.InvalidLearningPlan(str(error)) from error
        raise
    image = next(i for i in facts['images'] if i['side'] == side)
    basename = 'interface' + ('_back' if side == 'back' else '') + ('_en' if language == 'en' else '')
    project, layout = _horizontal_annotation_project(image, selected, style, bindings, language, basename,
        presentation=_annotation_presentation(facts.get('annotationPresentation')))
    bound = out / (basename + '.bound.oim.json'); api.write(bound, project)
    result = legacy._process([legacy.NODE, legacy.ROOT / 'scripts/openinterfacemark-convert.mjs',
                              '--project', bound, '--output-dir', out, '--basename', basename], timeout=180)
    # Validate actual project, converter manifests, image pixels and text readback.
    if not _verify_annotation(result, out, api) or not _verify_annotation_layout(result, layout, facts):
        raise ValueError('OpenInterfaceMark 实际导出证据未通过。')
    return result, layout


def _verify_annotation_layout(entry, layout, facts):
    """Reread the original pixels, transformed rectangles and actual SVG routes."""
    from PIL import Image
    try:
        if layout.get('version') != 2 or layout.get('orientation') != 'horizontal' or layout.get('connectors') != 'straight': return False
        presentation = _annotation_presentation(facts.get('annotationPresentation'))
        if _annotation_presentation(layout.get('annotationPresentation')) != presentation: return False
        if layout.get('language') not in ('zh', 'en'): return False
        expected_language = layout['language'] if presentation['labelMode'] == 'localized-name-with-refs' else 'en'
        if presentation['labelMode'] != 'source-detail' and layout.get('displayLanguage') != expected_language: return False
        image = next(i for i in facts['images'] if i['side'] == layout['side'])
        if layout['sourcePhotoSha256'] != image['sha256'] or hashlib.sha256(Path(image['path']).read_bytes()).hexdigest() != image['sha256']: return False
        bindings = _annotation_source_bindings(facts)
        if layout['sourceBindings'] != [bindings[r['id']] for r in image['regions']]: return False
        project = json.loads(Path(entry['projectPath']).read_text())
        if project['image'].get('rotation') != 0 or project['image'].get('scale') != 1: return False
        rotation = 90 if image['width'] < image['height'] else 0
        if layout['rotationClockwiseDegrees'] != rotation: return False
        bounds = layout['photoBounds']; left, top = bounds['x'], bounds['y']
        if any(isinstance(bounds[k], bool) or not isinstance(bounds[k], int) for k in ('x', 'y', 'width', 'height')) or left < 0 or top < 0: return False
        expected_transform = {'a': 0 if rotation else 1, 'b': 1 if rotation else 0, 'c': -1 if rotation else 0,
                              'd': 0 if rotation else 1, 'e': left + (image['height'] if rotation else 0), 'f': top}
        if layout['sourceToCanvas'] != expected_transform: return False
        style = layout['requestedStyle']; scale = max(1, max(image['width'], image['height']) / 900)
        effective = {**style, 'fontSize': round(style['fontSize'] * scale), 'stroke': style['stroke'] * scale, 'radius': style['radius'] * scale}
        if layout['styleScale'] != scale or layout['effectiveStyle'] != effective: return False
        with Image.open(image['path']) as original: photo = original.convert('RGBA')
        if rotation: photo = photo.transpose(Image.Transpose.ROTATE_270)
        if photo.size != (bounds['width'], bounds['height']): return False
        raw = base64.b64decode(project['image']['src'].split(',')[1], validate=True)
        with Image.open(io.BytesIO(raw)) as embedded: canvas = embedded.convert('RGBA')
        if canvas.width <= canvas.height or canvas.size != (project['image']['width'], project['image']['height']): return False
        if left + photo.width > canvas.width or top + photo.height > canvas.height: return False
        expected = Image.new('RGBA', canvas.size, (255, 255, 255, 0)); expected.paste(photo, (left, top))
        if canvas.tobytes() != expected.tobytes(): return False
        if {r['id'] for r in project['regions']} != {r['id'] for r in image['regions']}: return False
        for region in project['regions']:
            source = next(r for r in image['regions'] if r['id'] == region['id']); binding = bindings[region['id']]
            rectangle = {k: source[k] for k in ('x', 'y', 'w', 'h')}
            if rotation: rectangle = {'x': image['height'] - source['y'] - source['h'], 'y': source['x'], 'w': source['h'], 'h': source['w']}
            rectangle['x'] += left; rectangle['y'] += top
            if any(abs(region[k] - rectangle[k]) > 1e-7 for k in rectangle): return False
            if any(region[k] != effective[k] for k in ('fontSize', 'stroke', 'radius', 'color', 'dashed')): return False
            suffix = 'Zh' if layout['language'] == 'zh' else 'En'
            if presentation['labelMode'] in ('english-name-only', 'english-name-with-ref'): suffix = 'En'
            allowed = [_annotation_display(binding, {'title' + suffix: name}, layout['language'], presentation)
                       for name in binding['nameChoices' + suffix]]
            if (region['code'], region['title']) not in allowed: return False
        svg = ET.parse(entry['svgPath']).getroot()
        if float(svg.get('width')) <= float(svg.get('height')): return False
        routes = [el for el in svg.iter() if el.tag.rsplit('}', 1)[-1] == 'polyline']
        if len(routes) != len(project['regions']): return False
        texts = [el for el in svg.iter() if el.tag.rsplit('}', 1)[-1] == 'text']
        if len(texts) != len(project['regions']): return False
        for route, region, text in zip(routes, project['regions'], texts):
            spans = [el.text or '' for el in text.iter() if el.tag.rsplit('}', 1)[-1] == 'tspan']
            if spans != [region['code'], region['title']]: return False
            points = [[float(n) for n in p.split(',')] for p in route.get('points', '').split()]
            if len(points) != 4 or any(len(p) != 2 or not all(math.isfinite(n) for n in p) for p in points): return False
            a, b = points[0], points[-1]; dx, dy = b[0] - a[0], b[1] - a[1]; length = dx * dx + dy * dy
            side, offset = region['anchorSide'], region['anchorOffset']
            anchor = (region['x'] if side == 'left' else region['x'] + region['w'], region['y'] + region['h'] * offset) if side in ('left', 'right') else (region['x'] + region['w'] * offset, region['y'] if side == 'top' else region['y'] + region['h'])
            end = (region['labelX'] + (region['fontSize'] * .35 if side == 'left' else -region['fontSize'] * .35), region['labelY']) if side in ('left', 'right') else (region['labelX'], region['labelY'] + (region['fontSize'] * 1.4 if side == 'top' else -region['fontSize'] * .65))
            if any(abs(actual - wanted) > 1e-6 for actual, wanted in zip(a + b, list(anchor) + list(end))): return False
            if abs(float(text.get('x')) - region['labelX']) > 1e-6 or abs(float(text.get('y')) - region['labelY']) > 1e-6: return False
            if length < 1 or (abs(dx) > 1e-7 and abs(dy) > 1e-7): return False
            projections = []
            for p in points:
                if abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) > 1e-6: return False
                projections.append(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length)
            if projections != sorted(projections) or min(projections) < -1e-8 or max(projections) > 1 + 1e-8: return False
        with Image.open(entry['pngPath']) as png:
            if png.width <= png.height: return False
        return True
    except (OSError, ValueError, TypeError, KeyError, StopIteration, ET.ParseError):
        return False


def _verify_annotation(entry, output, api):
    """One real export, with the legacy checks but no invented four-item list."""
    output = Path(output).resolve()
    try:
        manifest_path = Path(entry['manifestPath']).resolve()
        if not manifest_path.is_relative_to(output): return False
        recorded = api.read(manifest_path)
        if recorded != {k: v for k, v in entry.items() if k not in ('pngPath', 'svgPath', 'projectPath', 'manifestPath')}:
            return False
        if recorded['converter']['commit'] != 'f8f92636b2eb87ac956997e77c9239cf483913fc': return False
        source = recorded['source']; bound_path = Path(source['path']).resolve()
        if not bound_path.is_relative_to(output) or api.sha(bound_path) != source['sha256']: return False
        bound = api.read(bound_path)
        if bound.get('format') != 'open-interface-mark' or bound.get('version') != 1 or not bound.get('regions'):
            return False
        if hashlib.sha256(base64.b64decode(bound['image']['src'].split(',')[1], validate=True)).hexdigest() != source['embeddedImage']['sha256']:
            return False
        for artifact in recorded['artifacts']:
            file = Path(artifact['path']).resolve()
            if not file.is_relative_to(output) or api.sha(file) != artifact['sha256']: return False
        if len(recorded['artifacts']) != 3 or {Path(a['path']).suffix for a in recorded['artifacts']} != {'.png', '.svg', '.json'}:
            return False
        # The manifest must identify the actual files consumed by later nodes.
        if any(not any(Path(a['path']).resolve() == Path(entry[key]).resolve() for a in recorded['artifacts']) for key in ('pngPath', 'svgPath', 'projectPath')):
            return False
        if api.read(entry['projectPath']) != bound:
            return False
        from PIL import Image
        with Image.open(entry['pngPath']) as png:
            png.verify()
        with Image.open(entry['pngPath']) as png:
            if png.size != (recorded['png']['width'], recorded['png']['height']): return False
        with Image.open(io.BytesIO(base64.b64decode(bound['image']['src'].split(',')[1], validate=True))) as image:
            if image.size != (bound['image']['width'], bound['image']['height']): return False
            image.verify()
        svg = ET.parse(entry['svgPath']).getroot()
        if svg.tag.rsplit('}', 1)[-1] != 'svg': return False
        texts = [el for el in svg.iter() if el.tag.rsplit('}', 1)[-1] == 'text']
        images = [el for el in svg.iter() if el.tag.rsplit('}', 1)[-1] == 'image']
        if len(texts) != len(bound['regions']) or len(images) != 1:
            return False
        if images[0].get('href', images[0].get('{http://www.w3.org/1999/xlink}href')) != bound['image']['src']:
            return False
        if recorded['regions'] != [{k: r[k] for k in ('id', 'code', 'title', 'x', 'y', 'w', 'h')} for r in bound['regions']]:
            return False
        for text, region in zip(texts, bound['regions']):
            spans = [el.text or '' for el in text.iter() if el.tag.rsplit('}', 1)[-1] == 'tspan']
            if spans != [region['code'], region['title']]: return False
        verification = recorded['verification']
        if verification.get('defaultExampleExported') is not False or verification.get('pageErrors'):
            return False
        return all(verification.get(k) is True for k in (
            'freshContext', 'boundProjectReadbackMatched', 'imageDecodedDimensionsMatched',
            'sourceHashMatched', 'pngDimensionsMatched', 'svgLabelCountMatched',
            'svgEmbeddedImageMatched', 'allRequestsLocalGet'))
    except (KeyError, OSError, ValueError, TypeError, ET.ParseError):
        return False


def _illustrations(value, run, context, facts, api, diagram_value=None):
    separate = diagram_value is not None
    if not isinstance(value, dict) or set(value) != (set(IMAGE_PORTS) if separate else set(IMAGE_PORTS) | {'diagram'}):
        raise ValueError('指南审核需四张接口标注；框图须来自独立 diagram 审核或旧版合并审核。')
    illustrations, files = {}, []
    for port, (side, language) in IMAGE_PORTS.items():
        operation = 'hdk.guide.annotate-' + side + '-' + language
        data = _load(value[port], run, operation, api)
        if data['facts'] != facts:
            raise ValueError('指南标注图与当前事实不一致。')
        if data.get('annotationLayout', {}).get('side') != side or data.get('annotationLayout', {}).get('language') != language:
            raise ValueError('指南接口标注没有绑定对应的正反面和文档语言。')
        if not _verify_annotation(data['annotation'], Path(data['annotation']['manifestPath']).parent, api):
            raise ValueError('指南标注实际导出证据已变化。')
        if not _verify_annotation_layout(data['annotation'], data.get('annotationLayout', {}), facts):
            raise ValueError('指南标注横向、直线或源元件映射未通过。')
        illustrations[port] = data
        files.append({'path': data['annotation']['pngPath'], 'sha256': api.sha(data['annotation']['pngPath'])})
    annotation_files = list(files)
    diagram = _load(diagram_value if separate else value['diagram'], run, 'hdk.guide.drawio', api)
    if diagram['facts'] != facts:
        raise ValueError('指南框图与当前事实不一致。')
    _verify_diagram(diagram, facts)
    illustrations['diagram'] = diagram
    diagram_files = [{'path': image['pngPath'], 'sha256': api.sha(image['pngPath'])} for image in _diagram_images(diagram).values()]
    files.extend(diagram_files)
    if len({i['path'] for i in files}) != 4 + len(diagram_files):
        raise ValueError('指南审核图片必须逐张绑定不同文件。')
    if separate:
        review = {'mode': 'separate',
                  'annotations': api.reviewed_artifacts(run, context, value, annotation_files, port='images'),
                  'diagram': api.reviewed_artifacts(run, context, diagram_value, diagram_files, port='diagram')}
    else:
        review = api.reviewed_artifacts(run, context, value, files, port='images')
    return illustrations, files, review


def _rendered_annotation_labels(illustrations):
    labels = []
    for port, data in illustrations.items():
        if port == 'diagram': continue
        layout = data['annotationLayout']
        bindings = {item['id']: item for item in layout['sourceBindings']}
        english_only = _annotation_presentation(layout.get('annotationPresentation'))['labelMode'] == 'english-name-only'
        for region in data['annotation']['regions']:
            label = {'ref': '/'.join(bindings[region['id']]['refs']), 'title': region['code'] if english_only else region['title']}
            if _annotation_presentation(layout.get('annotationPresentation'))['labelMode'] == 'localized-name-with-refs':
                label.update(language=layout['language'], side=layout['side'])
            labels.append(label)
    return labels


def _verify_diagram(data, facts):
    presentation = _diagram_presentation(facts.get('diagramPresentation')); expected = presentation['languages']
    if data.get('diagrams'):
        if expected != ['zh', 'en'] or set(data['diagrams']) != {'zh', 'en'}:
            raise ValueError('指南框图语言与当前冻结配置不一致。')
        template = data['drawioTemplate']
        if hashlib.sha256(Path(template['path']).read_bytes()).hexdigest() != template['sha256']:
            raise ValueError('已选 DrawIO 原始源文件在运行中发生变化。')
        from hdk.guide_drawio_template_v2 import verify_source_diagram
        results = {language: verify_source_diagram(image['manifestPath'], facts, template_path=template['path'],
            review_feedback=data.get('drawioReviewFeedback', ''), language=language, show_designators=presentation.get('showDesignators', True))
            for language, image in data['diagrams'].items()}
        if data.get('diagram') != data['diagrams']['en']:
            raise ValueError('指南框图兼容引用不符英文源图。')
        return {'passed': all(item['passed'] for item in results.values()), 'languages': ['zh', 'en'], 'diagrams': results}
    if expected == ['zh', 'en']:
        raise ValueError('本次指南必须提供中文和英文两份真实 DrawIO 框图。')
    if data.get('drawioTemplate'):
        template = data['drawioTemplate']
        if hashlib.sha256(Path(template['path']).read_bytes()).hexdigest() != template['sha256']:
            raise ValueError('已选 DrawIO 原始源文件在运行中发生变化。')
        from hdk.guide_drawio_template_v2 import verify_source_diagram
        return verify_source_diagram(data['diagram']['manifestPath'], facts, template_path=template['path'],
                                     review_feedback=data.get('drawioReviewFeedback', ''), show_designators=presentation.get('showDesignators', True))
    # Historical node receipts remain inspectable. All new prepare inputs now
    # require a selected template; their original implementation SHA is frozen.
    return guide_drawio.verify_source_diagram(data['diagram']['manifestPath'], facts)


def _diagram_images(data):
    return data['diagrams'] if data.get('diagrams') else {'en': data['diagram']}


def _render_guide_bundle(facts, plan, out, assets):
    """Keep the shared renderer unchanged; bind each document's diagram assets."""
    rendered = guide_render.render_bundle(facts, plan, out, assets)
    if _diagram_presentation(facts.get('diagramPresentation'))['languages'] == ['zh', 'en']:
        narrative = guide_render._narrative(plan)
        for language in ('zh', 'en'):
            localized = {**assets, **{base: assets[base + '_' + language] for base in ('block', 'block_svg', 'block_drawio')}}
            markdown = guide_render._render_language(facts, narrative, localized, language, Path(rendered['evidencePath']).name)
            Path(rendered[language + 'Path']).write_text(markdown, encoding='utf-8')
            rendered['characters'][language] = len(markdown)
        rendered['renderedFiles'] = [{'path': path, 'sha256': hashlib.sha256(Path(path).read_bytes()).hexdigest()}
                                     for path in (rendered['zhPath'], rendered['enPath'], rendered['evidencePath'])]
    return rendered


def _verify_document_diagrams(bundle):
    if _diagram_presentation(bundle['facts'].get('diagramPresentation'))['languages'] != ['zh', 'en']: return True
    assets = bundle['rendered']['assets']
    try:
        for language in ('zh', 'en'):
            markdown = Path(bundle['rendered'][language + 'Path']).read_text()
            for base in ('block', 'block_svg', 'block_drawio'):
                selected = assets[base + '_' + language]
                other = assets[base + '_' + ('en' if language == 'zh' else 'zh')]
                if selected == other or '](' + selected + ')' not in markdown or '](' + other + ')' in markdown: return False
        return True
    except (OSError, KeyError, TypeError): return False


def _verify_document_annotations(bundle):
    if _annotation_presentation(bundle['facts'].get('annotationPresentation'))['labelMode'] != 'localized-name-with-refs': return True
    try:
        assets = bundle['rendered']['assets']
        for language in ('zh', 'en'):
            markdown = Path(bundle['rendered'][language + 'Path']).read_text()
            for base in ('interface', 'interface_back'):
                selected = assets[base + ('_en' if language == 'en' else '')]
                other = assets[base + ('_en' if language == 'zh' else '')]
                if selected == other or '](' + selected + ')' not in markdown or '](' + other + ')' in markdown: return False
        return True
    except (OSError, KeyError, TypeError): return False


def _copy(source, target, digest, api):
    source, target = Path(source), Path(target)
    if api.sha(source) != digest or target.exists():
        raise ValueError('指南打包源哈希变化或目标重名。')
    shutil.copyfile(source, target)
    if api.sha(target) != digest or api.sha(source) != digest:
        raise ValueError('指南打包副本哈希校验失败。')


def _assemble(author, plan, out, api, learning):
    try:
        legacy._validate_narrative(plan)
        guide_render._narrative(plan)
    except ValueError as error:
        if learning: raise api.InvalidLearningPlan(str(error)) from error
        raise
    facts = copy.deepcopy(author['facts'])
    assets = {}; (out / 'img').mkdir(); (out / 'sources').mkdir()
    for image in facts['images']:
        target = out / 'img' / (image['side'] + '.png')
        _copy(image['path'], target, image['sha256'], api)
        assets[image['side']] = 'img/' + target.name
    for port, data in author['illustrations'].items():
        if port == 'diagram':
            for language, paths in _diagram_images(data).items():
                for kind, base in (('png', 'block'), ('svg', 'block_svg'), ('drawio', 'block_drawio')):
                    source = Path(paths[kind + 'Path']); target = out / 'img' / source.name
                    _copy(source, target, api.sha(source), api)
                    assets[base + '_' + language] = 'img/' + target.name
                    if language == 'en': assets[base] = 'img/' + target.name
        else:
            for kind in ('png', 'svg', 'project'):
                source = Path(data['annotation'][kind + 'Path']); target = out / 'img' / source.name
                _copy(source, target, api.sha(source), api)
                if kind == 'png': assets[source.stem] = 'img/' + target.name
    # This helper copies only allowlisted technical sources and binds links;
    # all engineer-derived illustrations were already imported and SHA checked.
    state = {'facts': facts, 'outputPath': str(out), 'assets': assets}
    legacy._supporting_assets(state)
    api.write(out / 'sources/board-facts.json', facts)
    rendered = _render_guide_bundle(facts, plan, out, assets)
    if not _verify_document_diagrams({'facts': facts, 'rendered': rendered}) or not _verify_document_annotations({'facts': facts, 'rendered': rendered}):
        raise ValueError('中英文文档没有分别引用对应语言的实际框图或接口标注。')
    for language, key in (('zh', 'zhPath'), ('en', 'enPath')):
        legacy._process([legacy.NODE, legacy.ROOT / 'scripts/render-user-guide-preview.mjs',
                         rendered[key], out / ('preview.' + language + '.html')], timeout=30)
    return {**author, 'facts': facts, 'narrative': plan, 'rendered': rendered,
            'outputPath': str(out), 'factsPath': str(out / 'sources/board-facts.json')}


def guide(operation, value, context, api):
    if operation not in OPERATIONS:
        raise ValueError('未知使用指南能力。')
    run, root, out = api.bound(operation, value, context)
    os.environ['HDK_NODE_ID'] = context['nodeId']
    learning = bool(run.get('learningId'))
    if operation == 'hdk.guide.prepare':
        data = prepare(value, api)
        return api.receipt(operation, data, run, out)
    if operation == 'hdk.guide.import-four':
        prepared = _load(value['prepared'], run, 'hdk.guide.prepare', api)
        data = _import_four(prepared, out, api)
        return api.receipt(operation, data, run, out, api.assets([{'path': data['reportPath']}, {'path': str(out / 'schematic-preview.png')}]))
    if operation == 'hdk.guide.facts':
        prepared = _load(value['prepared'], run, 'hdk.guide.prepare', api)
        engineering = _load(value['engineering'], run, 'hdk.guide.import-four', api)
        data = _facts(prepared, engineering, out, api)
        return api.receipt(operation, data, run, out, api.assets([{'path': data['factsPath']}]), {'annotationInput': data['annotationInput']})
    if operation == 'hdk.guide.drawio':
        data = _load(value['facts'], run, 'hdk.guide.facts', api)
        from hdk.guide_drawio_template_v2 import render_source_diagram, render_bilingual_source_diagrams
        template = data['drawioTemplate']
        if api.sha(template['path']) != template['sha256']: raise ValueError('DrawIO 原始源文件已变化。')
        feedback = context.get('reviewFeedback', '')
        if not isinstance(feedback, str) or len(feedback) > 8000:
            raise ValueError('DrawIO 审核反馈需要不超过8000字的原文。')
        presentation = _diagram_presentation(data['facts'].get('diagramPresentation')); bilingual = presentation['languages'] == ['zh', 'en']
        if bilingual:
            diagrams = render_bilingual_source_diagrams(data['facts'], out / 'block.svg', template_path=template['path'], review_feedback=feedback, show_designators=presentation.get('showDesignators', True))
        else:
            diagrams = {'en': render_source_diagram(data['facts'], out / 'block.svg', template_path=template['path'], review_feedback=feedback, show_designators=presentation.get('showDesignators', True))}
        audits = {language: {'path': diagram['auditPath'], 'sha256': api.sha(diagram['auditPath'])} for language, diagram in diagrams.items()}
        current = {**data, 'diagram': diagrams['en'], 'drawioReviewFeedback': feedback,
                   'drawioLayoutAudit': audits['en'], 'proofFiles': _sources(data.get('proofFiles', []), list(audits.values()))}
        if bilingual: current.update(diagrams=diagrams, drawioLayoutAudits=audits)
        _verify_diagram(current, data['facts'])
        files = [{'path': diagram[k + 'Path']} for diagram in diagrams.values() for k in ('drawio', 'png', 'svg')]
        return api.receipt(operation, current, run, out, api.assets(files))
    if operation.startswith('hdk.guide.annotate-'):
        data = _load(value['facts'], run, 'hdk.guide.facts', api)
        skill = _skill(run, context, value['plan'], data['annotationInput'])
        side, language = operation.removeprefix('hdk.guide.annotate-').split('-')
        result, layout = _annotation(value['plan'], data['facts'], side, language, out, api, learning)
        layout_path = out / 'annotation-layout.json'; api.write(layout_path, layout)
        return api.receipt(operation, {**data, 'annotation': result, 'annotationLayout': layout,
                           'annotationPlan': value['plan'], 'annotationSkill': skill},
                           run, out, api.assets(result['artifacts'] + [{'path': str(layout_path)}]))
    if operation == 'hdk.guide.author-input':
        data = _load(value['facts'], run, 'hdk.guide.facts', api)
        illustrations, files, review = _illustrations(value['images'], run, context, data['facts'], api, diagram_value=value.get('diagram'))
        if len({json.dumps(d['annotationSkill'], sort_keys=True) for p, d in illustrations.items() if p != 'diagram'}) != 1 or len({json.dumps(d['annotationPlan'], sort_keys=True) for p, d in illustrations.items() if p != 'diagram'}) != 1:
            raise ValueError('指南正反面与中英图没有使用相同的 Skill 版本和计划。')
        compact = guide_facts.compact_skill_facts(data['facts']); compact.pop('learningIsolation', None)
        skill_input = {'facts': compact, 'annotation': {'status': 'complete', 'exportedImageCount': 4,
                       'renderedLabels': _rendered_annotation_labels(illustrations)},
                       'editorialContract': guide_reference.execution_editorial_contract()}
        if len(json.dumps(skill_input, ensure_ascii=False, separators=(',', ':')).encode()) > 60_000:
            raise ValueError('指南作者输入超过 60KB，请缩小明确技术资料集。')
        proofs = _sources(data.get('proofFiles', []), *[i.get('proofFiles', []) for i in illustrations.values()])
        result = {**data, 'illustrations': illustrations, 'reviewedImages': value['images'], 'reviewFiles': files,
                  'humanReview': review, 'authorInputNodeId': context['nodeId'], 'skillInput': skill_input, 'proofFiles': proofs}
        if value.get('diagram') is not None: result['reviewedDiagram'] = value['diagram']
        return api.receipt(operation, result, run, out, extra={'skillInput': skill_input})
    if operation == 'hdk.guide.assemble':
        author = _load(value['author'], run, 'hdk.guide.author-input', api)
        _illustrations(author['reviewedImages'], run, {**context, 'nodeId': author['authorInputNodeId']}, author['facts'], api,
                       diagram_value=author.get('reviewedDiagram'))
        skill = _skill(run, context, value['plan'], author['skillInput'])
        data = _assemble(author, value['plan'], out, api, learning)
        data['authorSkill'] = skill
        files = api.assets([{'path': str(p)} for p in sorted(out.rglob('*')) if p.is_file()])
        return api.receipt(operation, data, run, out, files)
    bundle = _load(value['bundle'], run, 'hdk.guide.assemble', api)
    # Assembly only adds portable bundle paths; diagram source payload is stable.
    illustrations, _, review = _illustrations(bundle['reviewedImages'], run,
        {**context, 'nodeId': bundle['authorInputNodeId']}, bundle['illustrations']['diagram']['facts'], api,
        diagram_value=bundle.get('reviewedDiagram'))
    evaluation = guide_reference.evaluate_guide_bundle(bundle['outputPath'], facts_path=bundle['factsPath'], product_code=bundle['facts']['productCode'])
    checks = {i['id']: i['passed'] for i in evaluation['checks']}
    checks['annotation-exports'] = all(_verify_annotation(i['annotation'], Path(i['annotation']['manifestPath']).parent, api)
        and _verify_annotation_layout(i['annotation'], i.get('annotationLayout', {}), bundle['illustrations']['diagram']['facts'])
        for p, i in illustrations.items() if p != 'diagram')
    checks['drawio-block-diagram'] = _verify_diagram(illustrations['diagram'], bundle['facts'])['passed']
    checks['drawio-document-languages'] = _verify_document_diagrams(bundle)
    checks['annotation-document-languages'] = _verify_document_annotations(bundle)
    checks['source-unchanged'] = all(api.sha(i['path']) == i['sha256'] for i in bundle['sourceFiles'])
    quality = {'schemaVersion': 1, 'checks': checks}
    if not all(checks.values()): quality['diagnostics'] = {'issues': evaluation['issues']}
    result = {'status': 'learning-candidate' if learning else 'complete', 'qualified': all(checks.values()),
              'sourceSha256': bundle['sourceSha256'], 'productCode': bundle['facts']['productCode'],
              'outputPath': bundle['outputPath'], 'zhPath': bundle['rendered']['zhPath'], 'enPath': bundle['rendered']['enPath'],
              'qualitySummary': quality, 'evaluation': evaluation, 'humanReview': review,
              'annotationSkill': illustrations['frontZh']['annotationSkill'], 'authorSkill': bundle['authorSkill'],
              'migrationQualification': 'current-run checks only; no legacy release gate inherited',
              'physicalTestStatus': 'not-run', 'sourceFiles': bundle['sourceFiles'], 'proofFiles': bundle['proofFiles']}
    # Source/render integrity remains hard in learning, prose/structure is scored.
    hard = ('bilingual-files', 'local-assets-zh', 'local-assets-en',
            'getting-started-commands-zh', 'getting-started-commands-en',
            'source-pin-tables-zh', 'source-pin-tables-en', 'bilingual-pin-consistency',
            'annotation-exports', 'annotation-document-languages', 'drawio-block-diagram', 'drawio-document-languages', 'source-unchanged')
    if any(checks[k] is not True for k in hard) or (not learning and not all(checks.values())):
        raise ValueError('使用指南验收未通过：' + json.dumps(quality, ensure_ascii=False))
    report = out / ('学习候选检查.json' if learning else '使用指南验收.json')
    result['reportPath'] = str(report); api.write(report, result)
    comparison = {'qualitySummary': quality, 'narrative': bundle['narrative'],
                  'annotation': {**illustrations['frontZh']['annotationPlan'], 'exportedImageCount': 4,
                                 'renderedLabels': _rendered_annotation_labels(illustrations)},
                  'editorialInventory': evaluation['files'],
                  'factsSummary': {'productCode': bundle['facts']['productCode'], 'board': bundle['facts']['board'],
                                   'photoNotes': [i['note'] for i in bundle['facts']['images']], 'physicalTestStatus': 'not-run'}}
    extra = {'status': result['status'], 'qualitySummary': quality, 'outputPath': result['outputPath'],
             'zhPath': result['zhPath'], 'enPath': result['enPath'], 'reportPath': str(report)}
    if learning: extra['learningComparison'] = comparison
    files = [{'path': str(report)}] + [{'path': str(p)} for p in sorted(Path(bundle['outputPath']).rglob('*')) if p.is_file()]
    return api.receipt(operation, result, run, out, api.assets(files), extra)
