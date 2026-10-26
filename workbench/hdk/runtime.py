"""Fixed HDK workflow operations shared by execution and learning runs.

Model output is a naming/export plan. Original paths and the immutable run
context are retained privately, and learning exports use separate directories.
"""
from pathlib import Path
import hashlib
import importlib.util
import json
import os
import re
import subprocess
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / '.local' / 'hdk-contexts'
SOURCE_ROOT = Path(os.environ.get('WORKBENCH_HDK_SOURCE_ROOT', Path.home() / 'Documents/文档整理')).expanduser().resolve()
OUTPUT_ROOT = SOURCE_ROOT / '生成结果'
# Use the bundled document runtime for its pinned Pillow/PDF dependencies.
# Isolated mode intentionally ignores the Hermes worker's PYTHONPATH/user site.
SYSTEM_PYTHON = str(Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3')
EXPORTER_SCRIPT = ROOT / 'hdk/exporter/export_hdk.py'
MAX_STDOUT = 8 * 1024 * 1024
EXTERNAL_KINDS = {'processXlsx', 'datasheets', 'testInstructions'}

# Only fixed Python code is executed. Paths arrive as JSON, never shell text.
PDF_PROBE = r'''
import json, sys
from pypdf import PdfReader
result = {}
for kind, path in json.load(sys.stdin).items():
    reader = PdfReader(path)
    def titles(items):
        out = []
        for item in items:
            if isinstance(item, list): out.extend(titles(item))
            elif item.get('/Title'): out.append(str(item.get('/Title')))
        return out
    result[kind] = {'pageCount': len(reader.pages), 'roles': titles(reader.outline)}
print(json.dumps(result, ensure_ascii=False))
'''


def exporter():
    """Load dependency-free source/preflight helpers, not PDF export code."""
    spec = importlib.util.spec_from_file_location('hdk_native_exporter', EXPORTER_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def context():
    run_id = os.environ.get('WORKBENCH_RUN_ID', '')
    try:
        if str(uuid.UUID(run_id)) != run_id: raise ValueError()
    except (ValueError, AttributeError):
        raise ValueError('缺少执行器提供的运行上下文。') from None
    learning_id = os.environ.get('WORKBENCH_LEARNING_ID', '')
    if learning_id and not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,127}', learning_id):
        raise ValueError('学习运行上下文无效。')
    DATA.mkdir(parents=True, exist_ok=True, mode=0o700)
    return run_id, DATA / (run_id + '.json')


def _private_json(path, value):
    with path.open('x', encoding='utf-8') as f:
        os.chmod(path, 0o600)
        json.dump(value, f, ensure_ascii=False, indent=2)


def _load_context():
    run_id, receipt = context()
    request = json.loads(receipt.read_text(encoding='utf-8'))
    if request.get('runId') != run_id or request.get('learningId', '') != os.environ.get('WORKBENCH_LEARNING_ID', ''):
        raise ValueError('私有回执与当前执行/学习运行不一致。')
    return run_id, request


def _system_json(arguments, *, input_value=None, timeout=1800):
    """Bound process time and memory even if the native CLI logs unexpectedly."""
    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
        try:
            result = subprocess.run([SYSTEM_PYTHON, '-I', *arguments],
                input=None if input_value is None else json.dumps(input_value, ensure_ascii=False).encode(),
                stdout=stdout, stderr=stderr, check=False, timeout=timeout,
                cwd=str(ROOT))
        except subprocess.TimeoutExpired as error:
            raise RuntimeError(f'原生资料操作超过 {timeout} 秒，已停止本次尝试；请检查保留的原生会话证据。') from error
        size = stdout.seek(0, 2)
        if size > MAX_STDOUT:
            raise RuntimeError('原生资料操作输出超过安全限额；证据文件保留，不自动重试。')
        stdout.seek(0)
        try:
            value = json.loads(stdout.read())
        except (ValueError, UnicodeDecodeError) as error:
            end = stderr.seek(0, 2); stderr.seek(max(0, end - 4096))
            raise RuntimeError('原生资料操作没有返回有效 JSON：' + stderr.read().decode('utf-8', errors='replace')) from error
    # Exit 2 means a blocked/incomplete package, rather than a crashed process.
    if result.returncode not in (0, 2) or not isinstance(value, dict):
        raise RuntimeError(f'原生资料操作异常退出（{result.returncode}）。')
    if value.get('error'):
        raise RuntimeError('原生资料基础设施失败：' + str(value['error']))
    return value


def preflight(value):
    run_id, receipt = context()
    if not isinstance(value, dict):
        raise ValueError('请输入 JSON 工程路径及发布参数。')
    source = Path(value.get('sourcePath', '')).expanduser().resolve()
    learning_id = os.environ.get('WORKBENCH_LEARNING_ID', '')
    paired_learning_source = bool(learning_id) and source.is_relative_to(SOURCE_ROOT) and not source.is_relative_to(OUTPUT_ROOT)
    if (source.parent != SOURCE_ROOT and not paired_learning_source) or source.suffix.lower() != '.epro2' or not source.is_file():
        raise ValueError('执行输入必须为“文档整理”目录中的原始 epro2；学习可读取该目录内案例自带的配对工程，不能把生成结果反用作源。')
    native = exporter()
    origin = native.source_info(source)
    product, version, date = [value.get(k) for k in ('productCode', 'hardwareVersion', 'releaseDate')]
    if not isinstance(version, str) or not re.fullmatch(r'\d{1,3}\.\d{1,3}', version):
        raise ValueError('hardwareVersion 必须为不带V前缀的主次版本，如1.0。')
    parent = (OUTPUT_ROOT / '学习' / learning_id / run_id) if learning_id else (OUTPUT_ROOT / '执行' / run_id)
    parent.mkdir(parents=True, exist_ok=False)
    request = {'runId': run_id, 'learningId': learning_id, 'sourcePath': str(source),
               'sourceSha256': origin['sha256'], 'outputParent': str(parent),
               'productCode': product, 'hardwareVersion': version, 'releaseDate': date}
    # The oracle admits parameters only. It is never supplied to the Skill or
    # substituted for its actual plan during later execution and validation.
    oracle = {'packageName': f'{product}_HDK_V{version}',
              'paths': native.expected_paths(product, version, date),
              'supplementalDirectories': ['重要器件手册', '生产资料/07_测试说明'],
              'checks': {'stencilFromCurrentGerber': True, 'checkDocumentReferences': True,
                         'excludeOsMetadata': True, 'exportFromInputOnly': True}}
    native.validate_request(dict(request, plan=oracle))
    _private_json(receipt, request)
    return {'productCode': product, 'hardwareVersion': version, 'releaseDate': date,
            'sourceProject': {'fileName': source.name,
                'documentSummary': f"已独立检查源工程 ZIP/CRC，含1个PCB和{len(origin['pages'])}张原理图。实际制造数据必须从此输入重新导出；不沿用案例硬件参数或附件。"}}


def execute_plan(plan):
    run_id, request = _load_context()
    source = Path(request['sourcePath'])
    if hashlib.sha256(source.read_bytes()).hexdigest() != request['sourceSha256']:
        raise ValueError('规划期间输入工程发生变化，停止导出。')
    native = exporter()
    if (DATA / (run_id + '.native-request.json')).exists():
        raise ValueError('本次运行已提交原生导出；请创建新运行，禁止覆盖或重复提交。')
    expected_output = Path(request['outputParent']) / f"{request['productCode']}_HDK_V{request['hardwareVersion']}"
    if expected_output.exists():
        raise ValueError('本次运行的输出目录已经存在；请创建新运行，禁止覆盖。')
    try:
        if not isinstance(plan, dict) or set(plan) != {'packageName', 'paths', 'supplementalDirectories', 'checks'}:
            raise ValueError('Skill 导出计划不符合固定数据契约。')
        native.validate_request(dict(request, plan=plan))
    except (ValueError, native.Blocked) as error:
        if not request['learningId']:
            raise
        # A bad candidate is learnable feedback. It never reaches native I/O.
        failure = {'runId': run_id, 'nativeStatus': 'invalidPlan', 'artifactCount': 0,
                   'validationErrors': ['invalidPlan'], 'validationDetails': [str(error)],
                   'candidatePlan': plan, 'reportPath': None, 'outputPath': None}
        _private_json(DATA / (run_id + '.invalid-plan.json'), failure)
        return failure
    request_path = DATA / (run_id + '.native-request.json')
    _private_json(request_path, dict(request, plan=plan))
    report = _system_json([str(EXPORTER_SCRIPT), '--request', str(request_path), '--execute'])
    if not report.get('reportPath'):
        raise RuntimeError('没有生成可供独立验证的导出报告：' + str(report.get('status')))
    report_path = Path(report['reportPath']).resolve()
    if not report_path.is_relative_to(Path(request['outputParent']).resolve()):
        raise ValueError('原生报告不属于本次独立输出目录。')
    return {'runId': run_id, 'reportPath': str(report_path), 'outputPath': report['outputPath'],
            'nativeStatus': report['status'], 'artifactCount': len(report['artifacts']),
            'missing': report['missing'], 'warnings': report.get('warnings', [])}


def _failed_summary(plan, diagnostic):
    return {'schemaVersion': 1, 'packageName': None, 'directories': [], 'paths': {},
            'tableHeaders': {}, 'pdfs': {},
            'sourceConsistency': dict.fromkeys(['inputUnchanged', 'documentRecordsUnchanged',
                'bomMatchesSource', 'pickPlaceMatchesSource', 'stencilMatchesGerber', 'osMetadataExcluded'], False),
            'externalPending': [], 'notApplicable': [], 'validationErrors': ['invalidPlan'],
            'candidatePlan': plan, 'diagnostic': diagnostic}


def quality_summary(checked, request, report_path):
    """Stable grading projection of real disk evidence, never a Skill assertion."""
    output = Path(checked['outputPath']).resolve()
    parent = Path(request['outputParent']).resolve()
    if not output.is_relative_to(parent) or not output.is_dir():
        raise ValueError('真实产物目录不属于本次运行。')
    report = json.loads(report_path.read_text(encoding='utf-8'))
    native = exporter()
    delivery_artifacts = [a for a in checked['artifacts'] if not native.is_os_metadata_path(a['path'])]
    artifacts = {a['kind']: a for a in delivery_artifacts}
    paths, headers, pdf_paths, validation_errors = {}, {}, {}, []
    for kind, artifact in artifacts.items():
        path = output / artifact['path']
        if path.is_symlink() or not path.resolve().is_relative_to(output) or not path.is_file():
            validation_errors.append(f'{kind}:missingOrUnsafeFile'); continue
        if hashlib.sha256(path.read_bytes()).hexdigest() != artifact['sha256']:
            validation_errors.append(f'{kind}:changedAfterVerification'); continue
        paths[kind] = path.relative_to(output).as_posix()
        if kind in ('bom', 'pickPlace'):
            # Re-read the actual worksheet; do not project a manifest label.
            rows = exporter().xlsx_rows(path.read_bytes())
            first = rows[0] if rows else {}
            def column_number(column):
                number = 0
                for letter in column: number = number * 26 + ord(letter) - 64
                return number
            headers[kind] = [first[column] for column in sorted(first, key=column_number)]
        if kind in ('schematicPdf', 'silkscreenPdf'): pdf_paths[kind] = str(path)
    pdfs = _system_json(['-c', PDF_PROBE], input_value=pdf_paths, timeout=60) if pdf_paths else {}
    entries = list(output.rglob('*'))
    scanned_metadata = {p.relative_to(output).as_posix() for p in entries if native.is_os_metadata_path(p.relative_to(output))}
    excluded_metadata = sorted(scanned_metadata
        | {a['path'] for a in checked['artifacts'] if native.is_os_metadata_path(a['path'])}
        | {p for p in checked.get('excludedMetadata', []) if native.is_os_metadata_path(p)})
    directories = sorted(p.relative_to(output).as_posix() for p in entries if p.is_dir() and not p.is_symlink()
        and not native.is_os_metadata_path(p.relative_to(output)))
    # Finder may create metadata after native verification. Admission concerns
    # the delivery list, with each ignored path recorded, not directory hygiene.
    metadata_excluded = scanned_metadata.issubset(excluded_metadata) and all(
        not native.is_os_metadata_path(a['path']) for a in delivery_artifacts)
    error_free = not checked['errors'] and not validation_errors and checked['coreStatus'] == 'complete'
    unchanged = hashlib.sha256(Path(request['sourcePath']).read_bytes()).hexdigest() == request['sourceSha256']
    snapshots_present = bool(report.get('checks', {}).get('documentSource'))
    paste_kinds = {'topPaste', 'bottomPaste'}
    not_applicable = sorted({a['kind'] for a in checked.get('notApplicable', [])})
    return {'schemaVersion': 1, 'packageName': output.name, 'directories': directories,
        'paths': dict(sorted(paths.items())), 'tableHeaders': headers, 'pdfs': pdfs,
        'sourceConsistency': {'inputUnchanged': unchanged,
            'documentRecordsUnchanged': error_free and snapshots_present,
            'bomMatchesSource': error_free and 'bom' in paths,
            'pickPlaceMatchesSource': error_free and 'pickPlace' in paths,
            'stencilMatchesGerber': error_free and paste_kinds.issubset(set(paths) | set(not_applicable)),
            'osMetadataExcluded': metadata_excluded},
        # Only external content requirements belong here; manual PDF visual
        # review remains explicitly present in the full pending result.
        'externalPending': sorted({p['kind'] for p in checked.get('pending', []) if p['kind'] in EXTERNAL_KINDS}),
        'notApplicable': not_applicable,
        'excludedMetadata': excluded_metadata,
        'validationErrors': sorted(set(validation_errors + (['artifactVerificationFailed'] if checked['errors'] else [])))}


def verify(value):
    run_id, request = _load_context()
    if not isinstance(value, dict) or value.get('runId') != run_id:
        raise ValueError('导出回执与当前运行不一致。')
    if value.get('nativeStatus') == 'invalidPlan':
        if not request['learningId']:
            raise ValueError('执行模式不能跳过无效导出计划。')
        # Read private evidence instead of accepting a model-forged failure.
        failure = json.loads((DATA / (run_id + '.invalid-plan.json')).read_text(encoding='utf-8'))
        return {'packageStatus': '计划校验失败', 'coreExportStatus': 'blocked',
                'outputPath': None, 'files': [], 'pending': [],
                'candidatePlan': failure['candidatePlan'], 'validationDetails': failure['validationDetails'],
                'qualitySummary': _failed_summary(failure['candidatePlan'], '\n'.join(failure['validationDetails']))}
    candidate = Path(value['reportPath'])
    report_path = candidate.resolve()
    parent = Path(request['outputParent']).resolve()
    if not report_path.is_relative_to(parent) or candidate.is_symlink():
        raise ValueError('导出报告不属于本次独立输出目录。')
    checked = _system_json([str(EXPORTER_SCRIPT), '--verify', str(report_path)], timeout=180)
    destination = parent / '验收报告.json'
    summary = quality_summary(checked, request, report_path)
    is_metadata = exporter().is_os_metadata_path
    checked['artifacts'] = [a for a in checked['artifacts'] if not is_metadata(a['path'])]
    checked['qualitySummary'] = summary
    checked['excludedMetadata'] = summary['excludedMetadata']
    destination.write_text(json.dumps(checked, ensure_ascii=False, indent=2), encoding='utf-8')
    artifacts = [{key: a[key] for key in ('kind', 'path', 'bytes', 'sha256') if key in a} for a in checked['artifacts']]
    failures = checked['errors'] + summary['validationErrors']
    if failures and not request['learningId']:
        raise ValueError('真实文件验收未通过；已保留所有证据：' + str(destination) + '\n' + '\n'.join(failures)[:2500])
    return {'packageStatus': ('真实文件验收失败' if failures else '待补充资料及视觉复核' if checked['pending'] else '完整'),
            'coreExportStatus': 'blocked' if failures else checked['coreStatus'], 'outputPath': checked['outputPath'],
            'reportPath': str(destination), 'nativeReportPath': str(report_path),
            'files': artifacts, 'pending': checked['pending'], 'sourceSha256': request['sourceSha256'],
            'excludedMetadata': summary['excludedMetadata'],
            'validationErrors': failures, 'qualitySummary': summary}
