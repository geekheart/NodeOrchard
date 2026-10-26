"""Independent HDK v2 abilities with explicit receipts and attempt-owned files.

The old pipeline/gates remain untouched.  Skills still return bounded plans;
these abilities perform real native export, authoring, builds and reread checks.
No function flashes hardware or promotes a historical release gate.
"""
from pathlib import Path
import copy
import datetime as dt
import hashlib
import importlib.util
import io
import json
import os
import re
import shutil
import subprocess
import tempfile
import zipfile

from hdk import process_requirements as process
from hdk import test_firmware as firmware
from hdk import companion_firmware as companion
from hdk import test_sop as sop
from hdk import full_sop_v2 as sop_v2
from hdk import datasheets
from hdk import four_files_native as sch_native

ROOT = Path(__file__).resolve().parents[1]
PREFIX = 'hdk.full.'
CRITERIA = ('nativeExport', 'releaseNaming', 'processTemplate', 'firmwareBuild',
            'firmwareCoverage', 'testSop', 'datasheets', 'evidence')
MAX_FILES = 50000
MAX_BYTES = 2 * 1024 * 1024 * 1024


def native_module():
    spec = importlib.util.spec_from_file_location('hdk_full_dag_native', ROOT / 'hdk/exporter/export_hdk.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def export_full_native(request):
    """Keep all raw manufacturing bytes; adapt SCH unpacking in this module only.

    The original manufacturing module is loaded privately. Its original native
    PDF/ZIP remains schematicPdf.native. Only the delivery conversion changes,
    and the existing same-session PNG capability supplies actual source pixels.
    """
    core = native_module()
    base_native, original_unpack = core.Native, core.unpack_native_pdf
    instances = []

    class FullNative(base_native):
        def __init__(self, executable, evidence):
            super().__init__(executable, evidence)
            self.project_uuid, self.pages, self.pending_sch = None, [], False
            self.schematic = None
            instances.append(self)

        def open(self, path):
            result = super().open(path)
            self.project_uuid = result['importedProject']['uuid']
            return result

        def invoke(self, args):
            if args.get('action') == 'export' and args.get('kind') == 'schematicPng':
                if not self.project_uuid:
                    raise ValueError('原生SCH PNG缺少本次独占工程绑定。')
                return sch_native.Native.invoke(self, args | {'expectedProjectUuid': self.project_uuid})
            result = super().invoke(args)
            if args.get('action') == 'inspect':
                if result.get('project', {}).get('uuid') != self.project_uuid:
                    raise ValueError('制造导出工程并非本次独占导入副本。')
                self.pages = result['pages']
            if args.get('action') == 'source' and result.get('project', {}).get('uuid') != self.project_uuid:
                raise ValueError('导出前后源快照属于另一工程。')
            if args.get('action') == 'export' and args.get('kind') == 'schematicPdf':
                self.pending_sch = True
            return result

    def unpack(data):
        vector, unpacking = original_unpack(data)
        active = next((instance for instance in instances if instance.pending_sch), None)
        if active is None:
            return vector, unpacking
        active.pending_sch = False
        rendered, checks, transformation = sch_native.export_pdf_with_fallback(active, vector,
            pages=active.pages, bound_args={'expectedProjectUuid': active.project_uuid}, evidence=active.evidence)
        active.schematic = {'originalNativeSha256': core.digest(data), 'originalVectorSha256': core.digest(vector),
            'outputSha256': core.digest(rendered), 'fontAudit': checks['fontAudit'], 'nativePdfUnpacking': unpacking,
            'mode': 'nativeRasterFallback' if transformation else 'original-vector-preserved'}
        if transformation:
            # Old verification already pins this key to schematicPdf.native.
            # The v2 verifier reconstructs the conversion from archived PNGs.
            transformation = transformation | {'nativeArchiveSha256': core.digest(data), 'nativePdfUnpacking': unpacking}
            active.schematic['transformation'] = transformation
            return rendered, transformation
        return rendered, unpacking

    core.Native, core.unpack_native_pdf = FullNative, unpack
    report = core.export(request, execute=True)
    report['fullNativeAdapter'] = {'schemaVersion': 1, 'rawNativePreserved': True,
        'sameOwnedSessionForPng': True, 'sourceTextReconstruction': False,
        'schematic': next((instance.schematic for instance in instances if instance.schematic), None)}
    if report['fullNativeAdapter']['schematic'] and report['fullNativeAdapter']['schematic']['mode'] == 'nativeRasterFallback':
        report['warnings'].append('原生SCH矢量字体损坏；从同一独占工程图页原生导出PNG并无损封装兼容PDF。保留原件和前后SHA，兼容PDF文字不可选择。')
    replace_json(report['reportPath'], report)
    return report


def replay_schematic(data, transformation, pages):
    """Reconstruct actual archived PNG pixels in scratch; never rerun EDA."""
    core = native_module()
    if core.digest(data) != transformation.get('nativeArchiveSha256'):
        raise ValueError('原生SCH PDF/ZIP原件SHA与转换记录不一致。')
    vector, unpacking = core.unpack_native_pdf(data)
    if core.digest(vector) != transformation.get('originalVectorSha256') or unpacking != transformation.get('nativePdfUnpacking'):
        raise ValueError('原始SCH矢量内容或ZIP解包来源不一致。')
    original = Path(transformation['originalVectorPath'])
    if sha(original) != transformation['originalVectorSha256'] or original.read_bytes() != vector:
        raise ValueError('保留的原始矢量PDF已变化。')
    records = transformation.get('pages', [])
    if len(records) != len(pages) or {p['documentUuid'] for p in records} != {p['uuid'] for p in pages}:
        raise ValueError('兼容PDF没有覆盖准确的原生源图页。')
    if len({p['documentUuid'] for p in records}) != len(records):
        raise ValueError('兼容PDF重复使用了原生图页。')
    by_id = {p['documentUuid']: p for p in records}

    class ReplayNative:
        def invoke(self, args):
            if args.get('action') != 'export' or args.get('kind') != 'schematicPng' or args.get('documentType') != 'SCH_PAGE':
                raise ValueError('重读验收只允许保存的原生SCH PNG。')
            record = by_id[args['documentUuid']]
            native_path = Path(record['nativePath'])
            if sha(native_path) != record['nativeSha256'] or sha(record['path']) != record['sha256']:
                raise ValueError('原生PNG原件或解包图像已变化。')
            if record.get('exportOptions', {}).get('size') != args['pngSize']:
                raise ValueError('原生PNG纸张尺寸或导出选项不一致。')
            destination = Path(args['outputPath'])
            shutil.copyfile(native_path, destination)
            return {'file': {'path': str(destination), 'bytes': destination.stat().st_size},
                'exportOptions': record['exportOptions']}

    with tempfile.TemporaryDirectory(prefix='hdk-sch-readback-', dir='/private/tmp') as scratch:
        result, checks, reproduced = sch_native.export_pdf_with_fallback(ReplayNative(), vector,
            pages=[{'uuid': p['documentUuid']} for p in records], bound_args={}, evidence=Path(scratch))
    if reproduced is None or reproduced['originalFontAudit'] != transformation['originalFontAudit']:
        raise ValueError('原始字体问题与本次保存的转换证据不一致。')
    keys = ('documentUuid', 'sha256', 'nativeSha256', 'archiveMember', 'width', 'height', 'rgbPixelSha256',
            'alphaPixelSha256', 'paperWidthPt', 'paperHeightPt', 'effectiveDpi', 'exportOptions')
    if [{k: p.get(k) for k in keys} for p in reproduced['pages']] != [{k: p.get(k) for k in keys} for p in records]:
        raise ValueError('复读PNG像素、透明度或纸张大小不一致。')
    if core.digest(result) != transformation['outputSha256'] or not checks['fontAudit']['passed']:
        raise ValueError('从原生PNG重建的PDF与本次交付SHA不一致。')
    return result, transformation


def verify_full_native(report_path):
    core = native_module()
    report = read(report_path)
    schematic = next((a for a in report['artifacts'] if a['kind'] == 'schematicPdf'), None)
    transformation = schematic.get('checks', {}).get('transformation') if schematic else None
    if transformation and transformation.get('operation') == 'nativeRasterFallback':
        core.unpack_native_pdf = lambda raw: replay_schematic(raw, transformation, report['source']['pages'])
    checked = core.verify_report(report_path)
    fonts = {}
    for artifact in checked['artifacts']:
        if artifact['kind'] not in ('schematicPdf', 'silkscreenPdf'):
            continue
        path = Path(checked['outputPath']) / artifact['path']
        fonts[artifact['kind']] = sch_native.pdf_font_audit(path.read_bytes())
        if not fonts[artifact['kind']]['passed']:
            checked['errors'].append(artifact['kind'] + ': 实际PDF字体审计未通过。')
    if checked['errors']:
        checked['coreStatus'] = 'blocked'
    checked['fontAudits'] = fonts
    checked['schRendering'] = {'transformation': transformation,
        'fontAudit': fonts.get('schematicPdf'), 'rawNativePreserved': True,
        'independentPngReconstruction': bool(transformation and transformation.get('operation') == 'nativeRasterFallback')}
    return checked


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)


def replace_json(path, value):
    """Rewrite only newly copied metadata owned by the current attempt."""
    path = Path(path)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')


def file_ref(path, role=''):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise ValueError('需要真实、非符号链接的文件：' + str(path))
    path = path.resolve()
    return {'path': str(path), 'sha256': sha(path), 'bytes': path.stat().st_size, 'kind': role}


def publish_file(source, destination, role=''):
    """Expose a byte-identical copy outside private .hdk evidence directories."""
    before = file_ref(source)
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() or destination.is_symlink():
        raise ValueError('公开产物已存在，禁止覆盖。')
    shutil.copyfile(source, destination)
    if sha(source) != before['sha256'] or sha(destination) != before['sha256']:
        raise ValueError('公开预览与内部实际产物SHA不一致。')
    return file_ref(destination, role)


def inventory(root):
    root = Path(root).resolve()
    files, total = [], 0
    for path in sorted(root.rglob('*')):
        if path.is_symlink():
            raise ValueError('本次产物树不得包含符号链接：' + str(path))
        if not path.is_file() or firmware.is_os_metadata(path.relative_to(root)):
            continue
        total += path.stat().st_size
        if len(files) >= MAX_FILES or total > MAX_BYTES:
            raise ValueError('本次文件库存超过HDK能力限额。')
        files.append(file_ref(path))
    return files


def copy_tree(source, destination, exclude=()):
    """Copy exact current bytes, reject collisions, verify both sides again."""
    source, destination = Path(source).resolve(), Path(destination).resolve()
    if destination.is_relative_to(source) or source.is_relative_to(destination):
        raise ValueError('产物复制必须使用互相独立的目录。')
    records = inventory(source)
    destination.mkdir(parents=True, exist_ok=True)
    copied = []
    for item in records:
        original = Path(item['path'])
        relative = original.relative_to(source)
        if any(relative == Path(name) or Path(name) in relative.parents for name in exclude):
            continue
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists() or target.is_symlink():
            raise ValueError('交付目标已存在，禁止覆盖：' + str(target))
        shutil.copyfile(original, target)
        if sha(original) != item['sha256'] or sha(target) != item['sha256']:
            raise ValueError('复制前后实际文件SHA不一致。')
        copied.append({'source': str(original), 'path': str(target), 'sha256': item['sha256'],
            'deliveredSha256': item['sha256'], 'metadataRelocated': False})
    return copied


def _one(value, name):
    # A sole named input port is an object, whereas the default in port unwraps.
    return value[name] if isinstance(value, dict) and set(value) == {name} else value


def _plan_error(api, run, message):
    error = api.InvalidLearningPlan if run.get('learningId') else ValueError
    raise error(message)


def _facts(api, value, run):
    return api.load(value, run, PREFIX + 'prepare')


def _same(facts, *parents):
    expected = facts['sourceSha256']
    if any(parent.get('sourceSha256') != expected for parent in parents):
        raise ValueError('能力分支来自不同源工程，不能组装。')


def _common(facts):
    return {'request': facts['request'], 'sourceSha256': facts['sourceSha256'],
            'sourceFiles': facts['sourceFiles']}


def _skill_board(facts):
    board = facts['boardFacts']
    return {**board, 'source': {k: v for k, v in board['source'].items() if k != 'path'},
            'board': {k: v for k, v in board['board'].items() if k != 'components'}}


def resource_preflight(target):
    """Read-only readiness checks; do not install SDKs or warm compiler caches."""
    tool = firmware.default_toolchain()
    paths = [Path(tool['idfPath']) / 'tools/idf.py', Path(tool['python']),
             Path(native_module().CLI), process.RUNTIME / 'node/bin/node',
             process.RUNTIME / 'node/node_modules/@oai/artifact-tool',
             process.RUNTIME / 'bin/override/soffice', process.RUNTIME / 'bin/override/pdftoppm']
    for path in paths:
        if not path.exists():
            raise ValueError('请先准备本地导出/工艺/编译资源：' + str(path))
    commit = subprocess.check_output(['git', '-C', tool['idfPath'], 'rev-parse', 'HEAD'], text=True).strip()
    if commit != firmware.SDK_COMMIT:
        raise ValueError('本次固定ESP-IDF提交尚未准备好。')
    result = {'sdkCommit': commit, 'physicalTestStatus': 'not-run'}
    if target == 'esp32p4':
        vendor = ROOT / '.local/hdk-firmware-training/WT_BSP'
        commit = subprocess.check_output(['git', '-C', str(vendor), 'rev-parse', 'HEAD'], text=True).strip()
        if commit != '916139150e8488b660942078da178b6e76a8f4a1':
            raise ValueError('当前P4C61固定BSP尚未准备好。')
        result['bspCommit'] = commit
    return result


def implementation_files():
    """Freeze this run's methods/assets, without reading historical gate proofs."""
    paths = [Path(__file__).resolve(), ROOT / 'hdk/full_sop_v2.py', ROOT / 'hdk/exporter/export_hdk.py', ROOT / 'hdk/exporter/native_export.js',
        ROOT / 'hdk/process_requirements.py', ROOT / 'hdk/test_firmware.py', ROOT / 'hdk/companion_firmware.py',
        ROOT / 'hdk/test_sop.py', ROOT / 'hdk/datasheets.py', ROOT / 'hdk/resources/catalog.json',
        ROOT / 'hdk/four_files_native.py', ROOT / 'hdk/exporter/native_four_files.js',
        ROOT / 'skills/hdk-test-firmware/references/profile.schema.json']
    paths += [path for path in (ROOT / 'skills/hdk-test-firmware/assets').rglob('*')
        if path.is_file() and not firmware.is_os_metadata(path)]
    return [file_ref(path, 'fixed-capability-implementation') for path in sorted(set(paths))]


def prepare(value):
    if not isinstance(value, dict):
        raise ValueError('请按输入清单选择工程、发布配置和产品参数。')
    allowed = {'sourcePath', 'productCode', 'hardwareVersion', 'releaseDate', 'profilePath', 'templatePath'}
    if set(value) - allowed:
        raise ValueError('完整HDK输入包含未知字段；已知答案只能交给学习评估器。')
    product, version, date = (value.get(k) for k in ('productCode', 'hardwareVersion', 'releaseDate'))
    if not isinstance(product, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,79}', product):
        raise ValueError('请准备有效产品代号。')
    if not isinstance(version, str) or not re.fullmatch(r'\d{1,3}\.\d{1,3}', version):
        raise ValueError('硬件版本应为不含V前缀的数字版本，如1.0。')
    if not isinstance(date, str) or dt.date.fromisoformat(date).isoformat() != date:
        raise ValueError('发布日期应为真实YYYY-MM-DD日期。')
    source = file_ref(value.get('sourcePath', ''))
    if Path(source['path']).suffix.lower() != '.epro2':
        raise ValueError('输入需要原始epro2工程。')
    profile_file = file_ref(value.get('profilePath', ''), 'execution-profile')
    if profile_file['bytes'] > 65536:
        raise ValueError('发布测试配置超过64KiB。')
    profile = read(profile_file['path'])
    if not isinstance(profile, dict) or profile.get('schemaVersion') != 1 or set(profile) - {
            'schemaVersion', 'template', 'testRequirements', 'processProfile', 'notes'}:
        raise ValueError('发布配置必须为有界模板、测试要求和制造偏好；不得加入案例答案。')
    template_spec = profile.get('template') or {}
    template = file_ref(value.get('templatePath') or template_spec.get('path', ''), 'manufacturing-template')
    if template_spec.get('sha256') != template['sha256']:
        raise ValueError('工艺模板与显式确认的SHA不一致，请重新准备发布配置。')
    if Path(template['path']).suffix.lower() != '.xlsx':
        raise ValueError('工艺模板必须为原生XLSX。')
    requirements = profile.get('testRequirements') or {}
    if not isinstance(requirements, dict) or set(requirements) - {'cameraSensor', 'displayPanel', 'accessoryBasis',
            'fixturePolicy', 'requireAllBoardFeatures', 'physicalTestStatus'}:
        raise ValueError('测试要求包含未知字段，不能把已知答案或历史产物带入执行。')
    if requirements.get('physicalTestStatus', 'not-run') != 'not-run':
        raise ValueError('测试要求不能把构建声明为硬件实测通过。')
    if len(json.dumps(requirements, ensure_ascii=False).encode()) > 8000:
        raise ValueError('测试要求超过8KiB。')
    preferences = profile.get('processProfile') or {'schemaVersion': 1}
    process._profile(preferences)
    origin = native_module().source_info(Path(source['path']))
    board = firmware.inspect_board(source['path'])
    if origin['sha256'] != source['sha256'] or board['source']['sha256'] != source['sha256']:
        raise ValueError('预检工程来源不一致。')
    request = {'sourcePath': source['path'], 'productCode': product, 'hardwareVersion': version,
               'releaseDate': date, 'templatePath': template['path'], 'profilePath': profile_file['path']}
    # Check real geometry/template controls before any Skill call, without output.
    process.prepare_process_request(request | {'profile': preferences})
    template_zip, sheets = process._xlsx_read(Path(template['path']).read_bytes())
    controls, _ = process._template_controls(template_zip, sheets)
    if len(sheets) != 2 or len(controls) != 45:
        raise ValueError('需要已确认的两张表、45原生控件工艺模板。')
    resources = resource_preflight(board['board']['primaryTarget'])
    return {'request': request, 'sourceSha256': source['sha256'], 'sourceFiles': [source, profile_file, template],
            'boardFacts': board, 'nativeSource': origin, 'testRequirements': requirements,
            'processProfile': preferences, 'resources': resources, 'proofFiles': implementation_files(),
            'releaseQualification': {'legacyGateInherited': False, 'status': 'current-v2-artifacts-require-independent-acceptance'}}


def process_input(facts):
    result = process.prepare_process_request(facts['request'] | {'profile': facts['processProfile']})
    peripherals = facts['boardFacts'].get('peripherals', {})
    interfaces = {k: copy.deepcopy(peripherals[k]) for k in ('sd', 'camera', 'display', 'usb') if peripherals.get(k)}
    if interfaces.get('sd'):
        pins = set(interfaces['sd']['pins'].values())
        interfaces['sd']['signalNets'] = sorted(net for net, gpio in facts['boardFacts'].get('netGpioMap', {}).items() if gpio in pins)
    signals = {pin['net'] for port in interfaces.get('usb', []) for pin in port.get('pins', [])
               if pin.get('net') and pin.get('name', '').lower().startswith(('dp', 'dn'))}
    interfaces['usbSignalPathComponents'] = [{k: c[k] for k in ('designator', 'part', 'pins')}
        for c in facts['boardFacts']['board'].get('components', [])
        if c.get('designator', '').startswith(('R', 'L')) and any(p.get('net') in signals for p in c.get('pins', []))]
    result['facts']['interfaces'] = interfaces
    # Absolute template location is tool-owned; the Skill receives its contract.
    result.pop('templatePath', None)
    return result


def _attachment_selection(workbook_bytes, template_bytes):
    """Read the actual template's one-based option, never assume its index."""
    template, template_sheets = process._xlsx_read(template_bytes)
    template_controls, _ = process._template_controls(template, template_sheets)
    workbook, sheets = process._xlsx_read(workbook_bytes)
    controls, vml_member = process._template_controls(workbook, sheets)
    if '1028' not in controls or '1028' not in template_controls:
        raise ValueError('完整HDK工艺表缺少原生附图数量控件1028。')
    control, original = controls['1028'], template_controls['1028']
    if control['choices'] != original['choices'] or control['prop'].attrib.get('objectType') != 'Drop':
        raise ValueError('附图数量控件的真实候选或类型与冻结模板不一致。')
    images = [name for name in workbook.namelist() if name.startswith('xl/media/') and not name.endswith('/')]
    # This adapter is only for the existing single embedded impedance drawing.
    # Additional attachments need an explicit contract, not a guessed count.
    if len(images) != 1:
        raise ValueError('完整HDK工艺表应包含唯一的当前源阻抗附图。')
    label = '1张'
    matches = [index for index, value in enumerate(original['choices'], 1)
               if process._normalized(value) == process._normalized(label)]
    if len(matches) != 1:
        raise ValueError('冻结工艺模板缺少唯一的“1张”附图候选。')
    return workbook, control, vml_member, matches[0], label


def adapt_full_process_workbook(workbook_bytes, template_bytes):
    """Change only this attempt's attachment ctrlProp and its matching VML."""
    workbook, control, vml_member, selected, label = _attachment_selection(workbook_bytes, template_bytes)
    names = workbook.namelist()
    if len(names) != len(set(names)):
        raise ValueError('工艺XLSX包含重复归档成员。')
    member = control['member']
    replacements = {
        member: process._attr(workbook.read(member).decode(), 'sel', selected).encode(),
        vml_member: process._set_vml_state(workbook.read(vml_member).decode(), '1028', {'sel': selected}).encode(),
    }
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w') as archive:
        for info in workbook.infolist():
            archive.writestr(copy.copy(info), replacements.get(info.filename, workbook.read(info.filename)))
    updated = output.getvalue()
    reread, actual, _, index, _ = _attachment_selection(updated, template_bytes)
    if int(actual['prop'].attrib.get('sel', 0)) != index or int(actual['state'].get('Sel', 0)) != index:
        raise ValueError('附图数量ctrlProps与VML没有同步到真实模板选项。')
    changed = [name for name in names if workbook.read(name) != reread.read(name)]
    if set(changed) - set(replacements):
        raise ValueError('附图适配改变了控件之外的工作簿内容。')
    return updated, {'schemaVersion': 1, 'operation': 'current-impedance-attachment-count',
        'controlId': '1028', 'selectionIndex': selected, 'selectionLabel': label, 'attachmentCount': 1,
        'templateSha256': hashlib.sha256(template_bytes).hexdigest(),
        'beforeSha256': hashlib.sha256(workbook_bytes).hexdigest(),
        'afterSha256': hashlib.sha256(updated).hexdigest(), 'changedMembers': changed}


def _process_unresolved(items=()):
    unresolved = copy.deepcopy(list(items or ()))
    if not any(item.get('field') == 'fabricatorStackupAndCoupon' for item in unresolved):
        unresolved.append({'field': 'fabricatorStackupAndCoupon', 'severity': 'manufacturing-confirmation',
            'detail': 'Targets and nominal stack are specified. Fabricator must confirm its realized stack/coupon; '
                      'this is not a missing HDK file or an impedance measurement.'})
    return unresolved


def validate_full_process(params, unresolved=()):
    """Keep the old engineering checks and add the v2 attachment invariant."""
    checked = process.validate_process_requirements(params)
    workbook = Path(params['workbookPath']).read_bytes()
    template = Path(params.get('templatePath') or process.DEFAULT_TEMPLATE).read_bytes()
    _, control, _, selected, label = _attachment_selection(workbook, template)
    actual = {'ctrlProps': int(control['prop'].attrib.get('sel', 0)),
              'vml': int(control['state'].get('Sel', 0))}
    check = {'name': 'current-attachment-count', 'passed': all(value == selected for value in actual.values()),
             'actual': actual, 'expected': {'selectionIndex': selected, 'selectionLabel': label, 'attachmentCount': 1}}
    checked['checks'].append(check)
    checked['passed'] = bool(checked['passed'] and check['passed'])
    checked['unresolved'] = _process_unresolved(unresolved)
    return checked


def generate_full_process(params):
    """Adapt only newly generated v2 files, then render the corrected workbook."""
    result = process.generate_process_requirements(params | {'render': False})
    package = Path(params['packagePath']).resolve()
    workbook, fields_path = Path(result['workbookPath']), Path(result['fieldsReportPath'])
    if any(path.is_symlink() or not path.resolve().is_relative_to(package) for path in (workbook, fields_path)):
        raise ValueError('完整HDK工艺适配仅允许本次独立产物目录。')
    before = workbook.read_bytes()
    updated, adapter = adapt_full_process_workbook(before, Path(params.get('templatePath') or process.DEFAULT_TEMPLATE).read_bytes())
    original_path = fields_path.parent / 'full-v2-adapter-before.xlsx'
    with original_path.open('xb') as stream:
        stream.write(before)
    workbook.write_bytes(updated)
    adapter['originalWorkbookPath'] = str(original_path)
    checked = validate_full_process(params | {'workbookPath': str(workbook)}, result.get('unresolved', []))
    if not checked['passed']:
        raise ValueError('完整HDK工艺附图适配后未通过独立重读。')
    rendered = process._render(workbook, fields_path.parent) if params.get('render', True) else {
        'status': 'skipped', 'limitation': 'Native visual rendering was not requested; no visual-readability claim.'}
    fields = read(fields_path)
    fields['controlEdits']['1028'] = {'sel': adapter['selectionIndex']}
    fields['fields'].append({'field': 'attachmentCount', 'value': 1,
        'source': 'one actual embedded current-source impedance picture; frozen native template option', 'classification': 'source'})
    fields.update(nativeValidation=checked, render=rendered, unresolved=checked['unresolved'], fullV2Adapter=adapter)
    replace_json(fields_path, fields)
    replace_json(fields_path.parent / 'validation.json', checked)
    result.update(validation=checked, render=rendered, unresolved=checked['unresolved'], fullV2Adapter=adapter)
    result['artifacts'] = [dict(item, sha256=sha(workbook)) if Path(item['path']) == workbook else item
                           for item in result['artifacts']]
    return result


def pdf_previews(paths, directory):
    from pypdf import PdfReader
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    previews = []
    executable = process.RUNTIME / 'bin/override/pdftoppm'
    for role, source in paths:
        count = len(PdfReader(source).pages)
        if not 1 <= count <= 40 or len(previews) + count > 60:
            raise ValueError('图纸预览页数超过人工检查限额。')
        for page in range(1, count + 1):
            prefix = directory / (role + '-' + str(page))
            subprocess.run([str(executable), '-f', str(page), '-singlefile', '-scale-to', '1800',
                            '-png', str(source), str(prefix)], check=True, capture_output=True, timeout=120)
            previews.append(file_ref(prefix.with_suffix('.png'), role + '-preview'))
    return previews


def source_archive(source, destination):
    archive_tree(source, destination, 'source')
    return file_ref(destination, 'firmware-source-archive')


def archive_tree(source, destination, prefix):
    """Verify the actual compressed members, not only the input file hashes."""
    source = Path(source).resolve()
    files = inventory(source)
    with zipfile.ZipFile(destination, 'x', compression=zipfile.ZIP_DEFLATED) as archive:
        for item in files:
            path = Path(item['path'])
            archive.write(path, prefix + '/' + path.relative_to(source).as_posix())
            if sha(path) != item['sha256']:
                raise ValueError('源码在归档过程中发生变化。')
    with zipfile.ZipFile(destination) as archive:
        names = {prefix + '/' + Path(item['path']).relative_to(source).as_posix(): item for item in files}
        if len(archive.namelist()) != len(names) or set(archive.namelist()) != set(names):
            raise ValueError('最终ZIP成员与真实文件库存不一致。')
        for name, item in names.items():
            if hashlib.sha256(archive.read(name)).hexdigest() != item['sha256'] or sha(item['path']) != item['sha256']:
                raise ValueError('最终ZIP成员SHA与本次真实产物不一致。')
    if Path(destination).stat().st_size > 512 * 1024 * 1024:
        raise ValueError('单个公开归档超过512MiB，请将交付拆分。')


def compact_build_files(report, directory):
    roles = {'elf', 'applicationBin', 'mergedBin', 'buildLog', 'flashArgs', 'buildReplayGuide', 'companionFlashGuide'}
    selected = [file_ref(a['path'], a['role']) for a in report['artifacts'] if a['role'] in roles]
    selected.append(file_ref(report['manifestPath'], 'firmware-manifest'))
    selected.append(source_archive(report['sourceDir'], Path(directory) / '可重建测试源码.zip'))
    return selected


def _validate_build(report, single=False):
    checked = companion.validate_build(report['manifestPath']) if report['target'] == 'esp32c61' else firmware.validate_build(report['manifestPath'], _nested=single)
    if report.get('status') != 'compiled' or checked.get('status') != 'complete' or checked.get('errors'):
        raise ValueError('真实固件构建或独立验收失败：' + json.dumps(checked.get('errors', []), ensure_ascii=False))
    if not all(checked.get('checks', {}).values()):
        raise ValueError('固件独立检查存在未通过项。')
    return checked


def _map_paths(value, old, new):
    old, new = str(old), str(new)
    if isinstance(value, str):
        return new + value[len(old):] if value == old or value.startswith(old + os.sep) else value
    if isinstance(value, list):
        return [_map_paths(item, old, new) for item in value]
    if isinstance(value, dict):
        return {key: _map_paths(item, old, new) for key, item in value.items()}
    return value


def _refresh_report(report):
    root = Path(report['artifactRoot'])
    report['artifacts'] = [dict(a, path=str(Path(a['path']).resolve()), relativePath=Path(a['path']).resolve().relative_to(root).as_posix(),
        bytes=Path(a['path']).stat().st_size, sha256=sha(a['path'])) for a in report['artifacts']]
    return report


def relocate_branch(report, destination, package, exclude=()):
    """Copy a whole branch, then relocate metadata without touching source/bin."""
    old, destination = Path(report['artifactRoot']).resolve(), Path(destination).resolve()
    copies = copy_tree(old, destination, exclude)
    rewritten = _map_paths(copy.deepcopy(report), old, destination)
    rewritten['packagePath'] = str(Path(package).resolve())
    # Build commands are historical evidence, not instructions that were run
    # at the relocated path. Keep their actual original arguments verbatim.
    if 'buildCommand' in report:
        rewritten['buildCommand'] = copy.deepcopy(report['buildCommand'])
    rewritten['relocationHistory'] = copy.deepcopy(report.get('relocationHistory', [])) + [{
        'sourceArtifactRoot': str(old), 'destinationArtifactRoot': str(destination),
        'sourceManifestSha256': sha(report['manifestPath']),
        'method': 'exact source/binary copies plus deterministic manifest/dependency-index path relocation'}]
    # These are generated manifests, not firmware source or vendor dependencies.
    for name in ('generation-manifest.json',):
        path = destination / name
        if path.is_file():
            data = _map_paths(read(path), old, destination)
            data['packagePath'] = str(Path(package).resolve())
            replace_json(path, data)
    index = Path(rewritten['sourceDir']) / 'dependency-source-index.json'
    if index.is_file():
        replace_json(index, _map_paths(read(index), old, destination))
    _refresh_report(rewritten)
    replace_json(rewritten['manifestPath'], rewritten)
    return rewritten, copies


def selection_guide(path):
    Path(path).write_text('# P4芯片版本与烧录选择\n\nPCB硬件版本不是硅片revision。烧录前执行真实 chip-id 和 flash-id，失败或未知范围必须停止，不使用 --force。\n\n'
        'v0.x/v1.x仅用legacy；v3.x仅用variants/p4-v3。两套镜像互斥，v2.x或未知版本未覆盖。P4至少4MiB Flash，所需PSRAM与测试附件仍须核对。\n\n'
        'C61是另一颗芯片，按本包C61/C61烧录说明.md使用独立外部UART入口，不混用P4镜像或ESP-Hosted固件。\n\n'
        '本次未连接实物、未烧录、未执行硬件测试。依据固定ESP-IDF与实际构建清单选择，不能按目录名猜测。\n', encoding='utf-8')


def aggregate_builds(facts, reports, package, legacy_exclusions=()):
    package = Path(package).resolve()
    package.mkdir(parents=True)
    area = package / '生产资料/07_测试说明/测试固件'
    legacy, copies = relocate_branch(reports['legacy'], area, package, legacy_exclusions)
    branches = [legacy]
    if legacy['target'] == 'esp32p4':
        modern, copied = relocate_branch(reports['modern'], area / 'variants/p4-v3', package)
        copies += copied
        c61, copied = relocate_branch(reports['c61'], area / 'C61', package)
        copies += copied
        branches += [modern, c61]
        legacy['revisionVariants'] = [{'family': 'legacy', 'manifestPath': legacy['manifestPath'], 'minRevision': 0, 'maxRevision': 199},
            {'family': 'v3', 'manifestPath': modern['manifestPath'], 'minRevision': 300, 'maxRevision': 399}]
        legacy['companion'] = {'manifestPath': c61['manifestPath'], 'target': 'esp32c61', 'status': c61['status']}
        legacy['minimumFlashBytes'] = 4 * 1024 * 1024
        legacy['hardwareSelectionRequired'] = True
        guide = area / 'P4芯片版本与烧录选择.md'
        selection_guide(guide)
        for child in (modern, c61):
            legacy['artifacts'] += [dict(a, relativePath=Path(a['path']).relative_to(area).as_posix()) for a in child['artifacts']]
            legacy['artifacts'].append(dict(file_ref(child['manifestPath']), role='childFirmwareManifest',
                relativePath=Path(child['manifestPath']).relative_to(area).as_posix()))
        legacy['artifacts'].append(dict(file_ref(guide), role='revisionSelectionGuide', relativePath=guide.relative_to(area).as_posix()))
    _refresh_report(legacy)
    replace_json(legacy['manifestPath'], legacy)
    checked = _validate_build(legacy)
    metadata = {str(Path(branch['manifestPath']).resolve()) for branch in branches}
    for branch in branches:
        metadata.update(str(Path(path).resolve()) for path in [Path(branch['artifactRoot']) / 'generation-manifest.json',
            Path(branch['sourceDir']) / 'dependency-source-index.json'])
    for item in copies:
        if sha(item['source']) != item['sha256']:
            raise ValueError('固件复制来源在聚合期间发生变化。')
        item['deliveredSha256'] = sha(item['path'])
        item['metadataRelocated'] = item['deliveredSha256'] != item['sha256']
        if item['metadataRelocated'] and str(Path(item['path']).resolve()) not in metadata:
            raise ValueError('固件复制修改了源代码或二进制，不能作为路径重定位处理。')
    return legacy, checked, copies


def relocate_aggregate(report, package):
    """Recreate the canonical topology in an attempt-owned delivery package."""
    if report['target'] != 'esp32p4':
        return aggregate_builds(None, {'legacy': report}, package)
    modern_path = next(v['manifestPath'] for v in report['revisionVariants'] if v['family'] == 'v3')
    modern, c61 = read(modern_path), read(report['companion']['manifestPath'])
    # Root P4 metadata already includes children; copy only its own files first.
    modern_area, c61_area = Path(modern['artifactRoot']).resolve(), Path(c61['artifactRoot']).resolve()
    legacy = copy.deepcopy(report)
    legacy['artifacts'] = [a for a in legacy['artifacts'] if not Path(a['path']).resolve().is_relative_to(modern_area)
        and not Path(a['path']).resolve().is_relative_to(c61_area) and a['role'] != 'revisionSelectionGuide']
    # Copy the root's own files and the two child trees separately. Upstream
    # directories remain untouched and copy receipts retain real source paths.
    return aggregate_builds(None, {'legacy': legacy, 'modern': modern, 'c61': c61}, package,
        legacy_exclusions=('variants', 'C61', 'P4芯片版本与烧录选择.md'))


def _sop_skill_input(facts, report):
    return {k: facts['request'][k] for k in ('productCode', 'hardwareVersion', 'releaseDate')} | {
        'boardFacts': _skill_board(facts), 'firmware': {k: report.get(k) for k in ('status', 'target', 'physicalTestStatus', 'tests', 'warnings')}}


def _sop_request(facts, report, package):
    return {k: facts['request'][k] for k in ('productCode', 'hardwareVersion', 'releaseDate')} | {
        'packagePath': str(package), 'boardFacts': facts['boardFacts'], 'firmware': report}


def _sop_semantics(text):
    # Only deterministic attachment hash/byte cells and explicit inventory
    # digest lines may change when the same files are relocated for delivery.
    return sop_v2.semantics(text)


def learning_comparison(facts, parents, quality, files, report_path, package):
    """A bounded view of this run's evidence; never load evaluator references."""
    board = facts['boardFacts']['board']
    peripherals = {}
    for name, value in sorted(facts['boardFacts'].get('peripherals', {}).items())[:20]:
        summary = {'present': bool(value)}
        if isinstance(value, list):
            summary['count'] = len(value)
            summary['designators'] = [str(item.get('designator', ''))[:100] for item in value[:24] if isinstance(item, dict)]
        elif isinstance(value, dict):
            for key in ('designator', 'interface', 'gpio'):
                if isinstance(value.get(key), (str, int)) and not isinstance(value.get(key), bool):
                    summary[key] = value[key][:200] if isinstance(value[key], str) else value[key]
            if isinstance(value.get('pins'), dict):
                summary['pinNames'] = sorted(str(key)[:80] for key in value['pins'])[:24]
        peripherals[str(name)[:80]] = summary
    extensions = {}
    for item in files:
        suffix = Path(item['path']).suffix.lower()[:60] or '(none)'
        extensions[suffix] = extensions.get(suffix, 0) + 1
    evidence = [{'kind': 'full-current-run-verification', 'reportPath': str(report_path), 'sha256': sha(report_path)},
        {'kind': 'delivered-firmware-manifest', 'manifestPath': str(Path(package) / '生产资料/07_测试说明/测试固件/firmware-manifest.json'),
         'sha256': sha(Path(package) / '生产资料/07_测试说明/测试固件/firmware-manifest.json')}]
    for kind, path in [('native', parents['native']['native'].get('reportPath')),
            ('process', parents['process']['result'].get('fieldsReportPath')),
            ('firmware-aggregation', parents['firmware'].get('aggregationPath')),
            ('reviewed-sop', parents['sop']['rendered'].get('reportPath'))]:
        if path:
            evidence.append({'kind': kind, 'reportPath': path, 'sha256': sha(path)})
    return {'schemaVersion': 2, 'qualitySummary': quality,
        'plans': {'export': parents['native']['plan'], 'process': parents['process']['plan'],
            'firmware': parents['firmware'].get('plan', parents['firmware']['build']['profile']), 'sop': parents['sop']['plan']},
        'factsSummary': {k: facts['request'][k] for k in ('productCode', 'hardwareVersion', 'releaseDate')} | {
            'sourceSha256': facts['sourceSha256'],
            'chips': {key: board[key] for key in ('primaryTarget', 'targets', 'modulePart', 'moduleRef') if key in board},
            'peripherals': peripherals, 'physicalTestStatus': 'not-run'},
        'artifactInventory': {'fileCount': len(files), 'totalBytes': sum(item['bytes'] for item in files),
            'byExtension': [{'extension': key, 'count': count} for key, count in sorted(extensions.items(), key=lambda pair: (-pair[1], pair[0]))[:24]],
            'samplePaths': [str(item['path'])[:300] for item in files[:24]],
            'completeInventoryReportPath': str(report_path)},
        'verificationEvidence': evidence, 'qualificationScope': 'current-run-engineering-artifacts',
        'releaseQualified': False, 'legacyGateInherited': False}


def _emit(api, operation, data, run, out, artifacts=(), extra=None):
    # The full per-file inventory stays on disk. The transport remains <64KiB.
    outer = api.receipt(operation, data, run, out, api.assets(list(artifacts)), extra=extra)
    if len(json.dumps(outer, ensure_ascii=False).encode()) > 60000:
        raise ValueError('HDK回执过大；完整库存必须保留在磁盘清单中。')
    return outer


def full(operation, value, context, api):
    if operation not in {PREFIX + key for key in ('prepare', 'export-plan-input', 'native', 'process-input', 'process',
            'firmware-input', 'build-legacy', 'build-v3', 'build-c61', 'firmware-aggregate', 'sop-input', 'sop', 'datasheets', 'verify')}:
        raise ValueError('未知完整HDK能力。')
    run, root, out = api.bound(operation, value, context)
    os.environ['HDK_NODE_ID'] = context['nodeId']
    action = operation.removeprefix(PREFIX)
    if action == 'prepare':
        return _emit(api, operation, prepare(_one(value, 'in')), run, out)
    if action in ('export-plan-input', 'process-input', 'firmware-input', 'build-c61', 'datasheets'):
        facts = _facts(api, _one(value, 'facts'), run)
    else:
        if not isinstance(value, dict) or 'facts' not in value:
            raise ValueError('能力需要显式facts端口。')
        facts = _facts(api, value['facts'], run)
    common = _common(facts)
    if action == 'export-plan-input':
        request, origin = facts['request'], facts['nativeSource']
        skill_input = {k: request[k] for k in ('productCode', 'hardwareVersion', 'releaseDate')} | {
            'sourceProject': {'fileName': Path(request['sourcePath']).name,
                'documentSummary': f"已独立核验当前归档ZIP/CRC、1个PCB和{len(origin['pages'])}张原理图；制造文件只能从本次工程重新导出。"}}
        return _emit(api, operation, common, run, out, extra={'skillInput': skill_input})
    if action == 'native':
        native = native_module()
        request = facts['request']
        plan = value.get('plan')
        expected = {'packageName': request['productCode'] + '_HDK_V' + request['hardwareVersion'],
            'paths': native.expected_paths(request['productCode'], request['hardwareVersion'], request['releaseDate']),
            'supplementalDirectories': ['重要器件手册', '生产资料/07_测试说明'],
            'checks': {'stencilFromCurrentGerber': True, 'checkDocumentReferences': True, 'excludeOsMetadata': True, 'exportFromInputOnly': True}}
        if not isinstance(plan, dict) or json.dumps(plan, sort_keys=True) != json.dumps(expected, sort_keys=True):
            _plan_error(api, run, '导出与命名Skill计划不符合当前产品/版本/日期及来源契约。')
        parent = out / 'native'
        parent.mkdir()
        result = export_full_native(request | {'outputParent': str(parent), 'plan': plan})
        if result.get('error'):
            stage = result.get('nativeStage', 'native')
            raise ValueError('制造文件原生导出失败 [' + str(stage) + ']：' + str(result['error']))
        checked = verify_full_native(result['reportPath'])
        if checked['coreStatus'] != 'complete' or checked['errors']:
            raise ValueError('制造文件原生导出未通过独立重读：' + json.dumps(checked['errors'], ensure_ascii=False))
        checked_path = out / '制造文件验收.json'
        write(checked_path, checked)
        package = Path(result['outputPath'])
        artifacts = [file_ref(package / a['path'], a['kind']) for a in checked['artifacts']]
        previews = pdf_previews([(a['kind'], package / a['path']) for a in checked['artifacts'] if a['kind'] in ('schematicPdf', 'silkscreenPdf')], out / 'previews')
        artifacts += previews + [publish_file(result['reportPath'], out / '原生导出报告.json', 'native-export-report'), file_ref(checked_path, 'native-verification')]
        data = common | {'plan': plan, 'native': result, 'verification': checked, 'packagePath': str(package), 'reviewFiles': previews,
            # Imported editable-project caches are not acceptance evidence and
            # may keep housekeeping files. Pin the actual exported bytes and
            # independently reread native source snapshots instead.
            'proofFiles': inventory(result['evidencePath']) + [file_ref(result['reportPath'])] + artifacts,
            'limitations': checked['pending']}
        return _emit(api, operation, data, run, out, artifacts)
    if action == 'process-input':
        return _emit(api, operation, common, run, out, extra={'skillInput': process_input(facts)})
    if action == 'process':
        plan = value.get('plan')
        try:
            if not isinstance(plan, dict) or type(plan.get('schemaVersion')) is not int or plan['schemaVersion'] != 1:
                raise ValueError('工艺Skill必须输出实际的schemaVersion 1制造profile。')
            process._profile(plan)
        except ValueError as error:
            _plan_error(api, run, str(error))
        package = out / 'package'
        package.mkdir()
        relative = native_module().expected_paths(facts['request']['productCode'], facts['request']['hardwareVersion'], facts['request']['releaseDate'])['processXlsx']
        params = facts['request'] | {'packagePath': str(package), 'profile': plan, 'render': True, 'outputRelativePath': relative}
        result = generate_full_process(params)
        checked = result['validation']
        if not checked.get('passed') or result.get('render', {}).get('status') != 'rendered' or not result['render'].get('images'):
            raise ValueError('正式工艺表或实际打印预览未准备好，不能等待人工审核。')
        images = [publish_file(path, out / 'previews' / Path(path).name, 'process-preview') for path in result['render']['images']]
        artifacts = [file_ref(result['workbookPath'], 'process-workbook'),
            publish_file(result['fieldsReportPath'], out / '工艺字段依据.json', 'process-evidence'),
            publish_file(result['render']['pdfPath'], out / 'previews/工艺打印预览.pdf', 'process-preview-pdf')] + images
        return _emit(api, operation, common | {'plan': plan, 'result': result, 'verification': checked, 'unresolved': checked['unresolved'],
            'packagePath': str(package), 'reviewFiles': [artifacts[0]] + images, 'proofFiles': inventory(package)}, run, out, artifacts)
    if action == 'firmware-input':
        schema = read(ROOT / 'skills/hdk-test-firmware/references/profile.schema.json')
        skill_input = {'productCode': facts['request']['productCode'], 'boardFacts': _skill_board(facts),
            'testRequirements': facts['testRequirements'], 'profileSchema': schema, 'fixtureDesign': firmware.design_fixture(facts['boardFacts'])}
        return _emit(api, operation, common, run, out, extra={'skillInput': skill_input})
    if action.startswith('build-'):
        target = facts['boardFacts']['board']['primaryTarget']
        applicable = action == 'build-legacy' or target == 'esp32p4'
        if not applicable:
            return _emit(api, operation, common | {'applicable': False, 'status': 'notApplicable', 'reason': '当前主芯片不是P4，不生成P4 v3或C61固件。'}, run, out)
        package = out / 'package'
        package.mkdir()
        if action == 'build-c61':
            report = companion.compile_package(facts['boardFacts'], str(package))
        else:
            plan = value.get('plan')
            try:
                plan = firmware.validate_profile(facts['boardFacts'], plan)
                for key in ('cameraSensor', 'displayPanel'):
                    if facts['testRequirements'].get(key) is not None and plan.get(key) != facts['testRequirements'][key]:
                        raise ValueError('测试计划不符合已明确提供的外接测试配件：' + key)
                if not firmware.coverage(facts['boardFacts'], plan)['complete']:
                    raise ValueError('测试计划没有覆盖当前板真实外设与普通排针治具。')
            except ValueError as error:
                _plan_error(api, run, str(error))
            generated = firmware.generate(facts['boardFacts'], plan, str(package),
                _revision_family=('legacy' if action == 'build-legacy' else 'v3') if target == 'esp32p4' else None)
            report = firmware._compile_one(generated)
        checked = _validate_build(report, single=True)
        artifacts = compact_build_files(report, out)
        return _emit(api, operation, common | {'applicable': True, 'build': report, 'verification': checked,
            **({'plan': copy.deepcopy(value['plan'])} if action != 'build-c61' else {}),
            'proofFiles': inventory(package)}, run, out, artifacts, extra={'status': 'compiled', 'target': report['target']})
    if action == 'firmware-aggregate':
        parents = {key: api.load(value[key], run, PREFIX + name) for key, name in
            [('legacy', 'build-legacy'), ('modern', 'build-v3'), ('c61', 'build-c61')]}
        _same(facts, *parents.values())
        target = facts['boardFacts']['board']['primaryTarget']
        if not parents['legacy'].get('applicable') or (target == 'esp32p4' and not all(p.get('applicable') for p in parents.values())):
            raise ValueError('当前板所需固件分支未完整生成。')
        if target != 'esp32p4' and any(parents[k].get('applicable') for k in ('modern', 'c61')):
            raise ValueError('非P4工程不能混入其它芯片构建。')
        reports = {key: parent['build'] for key, parent in parents.items() if parent.get('applicable')}
        for report in reports.values():
            if report.get('boardSourceSha256') != facts['sourceSha256']:
                raise ValueError('固件分支未绑定当前源工程。')
            _validate_build(report, single=True)
        report, checked, copies = aggregate_builds(facts, reports, out / 'package')
        index = out / '三构建聚合清单.json'
        write(index, {'sourceSha256': facts['sourceSha256'], 'copies': copies, 'verification': checked})
        artifacts = [file_ref(report['manifestPath'], 'aggregate-firmware-manifest'), file_ref(index, 'build-aggregation-proof')]
        return _emit(api, operation, common | {'build': report, 'verification': checked, 'packagePath': str(out / 'package'),
            'plan': parents['legacy'].get('plan', report['profile']),
            'aggregationPath': str(index), 'proofFiles': inventory(out / 'package')}, run, out, artifacts)
    if action in ('sop-input', 'sop'):
        parent = api.load(value['firmware'], run, PREFIX + 'firmware-aggregate')
        _same(facts, parent)
        _validate_build(parent['build'])
        if action == 'sop-input':
            return _emit(api, operation, common, run, out, extra={'skillInput': _sop_skill_input(facts, parent['build'])})
        plan = value.get('plan')
        try:
            sop.validate_plan(_sop_request(facts, parent['build'], root), plan)
        except ValueError as error:
            _plan_error(api, run, str(error))
        report, checked, copies = relocate_aggregate(parent['build'], out / 'package')
        package = out / 'package'
        rendered = sop_v2.render(_sop_request(facts, report, package), package / '生产资料/07_测试说明', plan)
        if rendered['status'] != 'complete':
            raise ValueError('测试说明引用或内容未通过独立检查。')
        markdown = Path(rendered['markdownPath'])
        image = markdown.parent / 'images/wiring.svg'
        artifacts = [file_ref(markdown, 'test-sop'), file_ref(image, 'wiring-diagram'),
            file_ref(markdown.parent / 'images/wiring.png', 'wiring-preview'),
            file_ref(markdown.parent / sop_v2.INDEX_MD, 'build-source-index'),
            file_ref(markdown.parent / sop_v2.INDEX_JSON, 'build-source-inventory'),
            file_ref(markdown.parent / '测试依据.json', 'sop-provenance'), file_ref(rendered['reportPath'], 'sop-verification')]
        return _emit(api, operation, common | {'plan': plan, 'build': report, 'rendered': rendered, 'packagePath': str(package),
            'reviewFiles': artifacts[:4], 'proofFiles': inventory(package), 'physicalTestStatus': 'not-run'}, run, out, artifacts)
    if action == 'datasheets':
        package = out / 'package'
        package.mkdir()
        result = datasheets.collect(facts['boardFacts'], str(package), product_code=facts['request']['productCode'], cache_path=out / 'resource-cache')
        checked = datasheets.verify(result['indexPath'], str(package))
        if checked['status'] != 'complete' or not all(checked['checks'].values()) or result['pending']:
            raise ValueError('当前板匹配的主要器件资料仍需准备：' + json.dumps(result['pending'], ensure_ascii=False))
        artifacts = [file_ref(result['indexPath'], 'datasheet-index'), file_ref(result['readmePath'], 'datasheet-readme')]
        return _emit(api, operation, common | {'result': result, 'verification': checked, 'packagePath': str(package),
            'proofFiles': inventory(package)}, run, out, artifacts)
    if action == 'verify':
        parents = {key: api.load(value[key], run, PREFIX + kind) for key, kind in
            [('native', 'native'), ('process', 'process'), ('firmware', 'firmware-aggregate'), ('sop', 'sop'), ('datasheets', 'datasheets')]}
        _same(facts, *parents.values())
        reviews = {key: api.reviewed_artifacts(run, context, value[key], parents[key]['reviewFiles'], port=key)
            for key in ('native', 'process', 'sop')}
        _validate_build(parents['firmware']['build'])
        _validate_build(parents['sop']['build'])
        source_sop = parents['sop']
        if source_sop['build']['boardSourceSha256'] != parents['firmware']['build']['boardSourceSha256']:
            raise ValueError('已审SOP与本次固件不属于同一源工程。')
        # The SOP contains a verified copy of this exact aggregate. Every binary
        # must still match; a same-board but different profile cannot substitute.
        expected = {(a['role'], Path(a['path']).relative_to(parents['firmware']['build']['artifactRoot']).as_posix()): a['sha256']
            for a in parents['firmware']['build']['artifacts'] if a['role'] in ('applicationBin', 'mergedBin', 'elf')}
        actual = {(a['role'], Path(a['path']).relative_to(source_sop['build']['artifactRoot']).as_posix()): a['sha256']
            for a in source_sop['build']['artifacts'] if a['role'] in ('applicationBin', 'mergedBin', 'elf')}
        if actual != expected:
            raise ValueError('已审SOP引用了另一份固件配置或构建。')
        package = out / (facts['request']['productCode'] + '_HDK_V' + facts['request']['hardwareVersion'])
        report, build_check, copies = relocate_aggregate(source_sop['build'], package)
        native = parents['native']
        native_check = verify_full_native(native['native']['reportPath'])
        if native_check['coreStatus'] != 'complete' or native_check['errors']:
            raise ValueError('制造资料在人工审核后未通过实际重读。')
        native_root = Path(native['packagePath'])
        for entry in native_check['artifacts']:
            source = native_root / entry['path']
            target = package / entry['path']
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists():
                raise ValueError('制造文件与交付分支发生重名。')
            shutil.copyfile(source, target)
            if sha(source) != entry['sha256'] or sha(target) != entry['sha256']:
                raise ValueError('制造文件最终副本SHA不一致。')
            copies.append({'source': str(source), 'path': str(target), 'sha256': entry['sha256'],
                'deliveredSha256': entry['sha256'], 'metadataRelocated': False})
        proc = parents['process']
        process_path = Path(proc['result']['workbookPath'])
        relative = process_path.relative_to(Path(proc['packagePath']))
        target = package / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(process_path, target)
        if sha(target) != sha(process_path):
            raise ValueError('已审工艺表复制SHA不一致。')
        copies.append({'source': str(process_path), 'path': str(target), 'sha256': sha(target),
            'deliveredSha256': sha(target), 'metadataRelocated': False})
        proc_check = validate_full_process(facts['request'] | {'workbookPath': str(target), 'profile': proc['plan']},
            proc.get('unresolved', proc['result'].get('unresolved', [])))
        if not proc_check['passed']:
            raise ValueError('最终工艺表未通过实际重读。')
        copies += copy_tree(Path(parents['datasheets']['packagePath']) / '重要器件手册', package / '重要器件手册')
        manual_check = datasheets.verify(package / '重要器件手册/资料来源索引.json', package)
        if manual_check['status'] != 'complete' or not all(manual_check['checks'].values()):
            raise ValueError('最终器件手册未通过独立重读。')
        final_sop = sop_v2.render(_sop_request(facts, report, package), package / '生产资料/07_测试说明', source_sop['plan'])
        if final_sop['status'] != 'complete':
            raise ValueError('最终测试说明的引用与固件不一致。')
        before, after = Path(source_sop['rendered']['markdownPath']), Path(final_sop['markdownPath'])
        if _sop_semantics(before.read_text()) != _sop_semantics(after.read_text()):
            raise ValueError('最终组装改变了已审测试说明正文，需要重新人工审核。')
        before_image, after_image = before.parent / 'images/wiring.svg', after.parent / 'images/wiring.svg'
        if sha(before_image) != sha(after_image):
            raise ValueError('最终接线图与人工批准的实际图不一致。')
        if sha(before.parent / 'images/wiring.png') != sha(after.parent / 'images/wiring.png'):
            raise ValueError('最终接线PNG与人工批准的实际预览不一致。')
        if _sop_semantics((before.parent / sop_v2.INDEX_MD).read_text()) != _sop_semantics((after.parent / sop_v2.INDEX_MD).read_text()):
            raise ValueError('最终源码/构建库存语义与人工批准的附件索引不一致。')
        for source in facts['sourceFiles']:
            if sha(source['path']) != source['sha256']:
                raise ValueError('最终组装期间原始工程、模板或发布配置发生变化。')
        checks = {key: True for key in CRITERIA}
        quality = {'schemaVersion': 2, 'packageName': package.name, 'checks': checks, 'physicalTestStatus': 'not-run'}
        files = [dict(item, path=Path(item['path']).relative_to(package).as_posix()) for item in inventory(package)]
        status = 'learning-candidate' if run.get('learningId') else 'complete'
        proof = {'schemaVersion': 2, 'status': status, 'qualified': True, 'sourceSha256': facts['sourceSha256'],
            'qualificationScope': 'current-run-engineering-artifacts', 'releaseQualified': False,
            **({'learningId': run['learningId']} if run.get('learningId') else {}),
            'checks': checks, 'physicalTestStatus': 'not-run', 'humanReview': reviews,
            'native': native_check, 'process': proc_check, 'firmware': build_check, 'sop': final_sop,
            'unresolved': [dict(item, branch='process') for item in proc_check['unresolved']],
            'datasheets': manual_check, 'artifacts': files, 'assemblyCopies': copies,
            'sopRelocation': {'sourceSha256': sha(before), 'deliveredSha256': sha(after), 'bodyAndWiringUnchanged': True,
                'transformation': 'deterministic attachment/index hash/byte updates after metadata path relocation; operator steps and SVG/PNG unchanged'},
            'releaseQualification': facts['releaseQualification'],
            'nativePendingResolution': [{'kind': item['kind'], 'resolvedBy': {
                'processXlsx': 'current-reviewed-process-branch', 'datasheets': 'current-datasheets-branch',
                'testInstructions': 'current-builds-and-reviewed-sop-branch', 'schematicPdf': 'current-native-human-review',
                'silkscreenPdf': 'current-native-human-review'}.get(item['kind'], 'see-current-branch-evidence')}
                for item in native_check.get('pending', [])],
            'limitations': ['编译成功不代表硬件实测通过；未连接或烧录任何实物。', '旧schema1学习门禁未继承为本次v2全图已学习的证明。']}
        report_path = out / '完整HDK验收.json'
        write(report_path, proof)
        archive = out / (package.name + '.zip')
        archive_tree(package, archive, package.name)
        comparison = learning_comparison(facts, parents, quality, files, report_path, package)
        return _emit(api, operation, common | {'packagePath': str(package), 'reportPath': str(report_path),
            'status': status, 'qualitySummary': quality, 'qualified': True, 'releaseQualified': False, 'unresolved': proof['unresolved'],
            'learningComparison': comparison, 'proofFiles': inventory(package)}, run, out,
            [file_ref(report_path, 'full-hdk-verification'), file_ref(archive, 'full-hdk-delivery')],
            extra={'status': status, 'qualitySummary': quality, 'packagePath': str(package), 'physicalTestStatus': 'not-run',
                'qualified': True, 'releaseQualified': False, 'unresolved': proof['unresolved'], 'learningComparison': comparison})
