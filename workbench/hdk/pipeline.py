"""One HDK execution graph: bounded Skill plans, real tools and disk checks.

Learning uses the exact same graph with per-run output isolation. Known answers
are held by the learning controller, never loaded here or handed to a Skill.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
from contextlib import closing

ROOT = Path(__file__).resolve().parents[1]
PRIVATE = ROOT / '.local/hdk-full-contexts'
GATE = ROOT / 'hdk/learning/full/release-gate.json'
CONTRACT = ROOT / 'hdk/learning/full/acceptance-contract.json'
REFERENCE_INVENTORY = ROOT / 'hdk/learning/full/reference-inventory.json'
TEMPLATE = Path(os.environ.get('WORKBENCH_HDK_PROCESS_TEMPLATE',
    Path(os.environ.get('WORKBENCH_HDK_SOURCE_ROOT', Path.home() / 'Documents/文档整理')).expanduser()
    / 'WT9932S31-TINY_HDK_V1.0/生产资料/06_工艺要求/WT9932S31-TINY-1V0-20261021.xlsx')).expanduser()
OWNERS = {'nativeExport': 'hdk-plan-skill', 'processTemplate': 'hdk-process-skill',
          'firmwareBuild': 'hdk-firmware-skill', 'firmwareCoverage': 'hdk-firmware-skill',
          'testSop': 'hdk-sop-skill'}
REQUIRED_IMPLEMENTATIONS = {
    'hdk/pipeline.py', 'hdk/runtime.py', 'hdk/capability_runner.py',
    'hdk/exporter/export_hdk.py', 'hdk/exporter/native_export.js',
    'hdk/process_requirements.py', 'hdk/test_firmware.py', 'hdk/test_sop.py', 'hdk/datasheets.py',
    'hdk/resources/catalog.json',
}
SKILL_NODE_IDS = {'hdk-plan-skill', 'hdk-process-skill', 'hdk-firmware-skill', 'hdk-sop-skill'}

def _base():
    spec = importlib.util.spec_from_file_location('hdk_pipeline_base', ROOT / 'hdk/runtime.py')
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value

def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def definition(document):
    # Mode, selection, names and viewport do not change the executable methods.
    value = {'id': document['id'], 'nodes': [{'id': n['id'], 'type': n['type'], 'config': n['config']} for n in document['nodes']],
             'edges': [{k: e[k] for k in ('sourceNode', 'sourcePort', 'targetNode', 'targetPort')} for e in document['edges']]}
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

def _run_record():
    run_id, _ = _base().context()
    with closing(sqlite3.connect('file:' + str(ROOT / '.local/workbench.sqlite') + '?mode=ro', uri=True)) as db:
        row = db.execute('SELECT value FROM workflow_runs WHERE id=?', (run_id,)).fetchone()
    if not row: raise ValueError('缺少服务端不可变运行快照。')
    return json.loads(row[0])

def _admit_node(expected):
    run = _run_record()
    if os.environ.get('WORKBENCH_NODE_ID') != expected or run.get('currentNodeId') != expected or (
        os.environ.get('WORKBENCH_WORKFLOW_ID') != run.get('workflowId')):
        raise ValueError('能力操作与服务端当前节点/工作流不一致。')

def _case_unchanged():
    contract = json.loads(CONTRACT.read_text(encoding='utf-8'))
    if sha(REFERENCE_INVENTORY) != contract.get('referenceInventorySha256'): return False
    inventory = json.loads(REFERENCE_INVENTORY.read_text(encoding='utf-8'))
    root = Path(inventory['caseRoot'])
    actual = {p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file()
        and not any(x in {'.DS_Store', '__MACOSX'} or x.startswith('._') for x in p.relative_to(root).parts)}
    if actual != {f['path'] for f in inventory['files']}: return False
    return all((root / f['path']).is_file() and not (root / f['path']).is_symlink()
        and sha(root / f['path']) == f['sha256'] for f in inventory['files'])

def _proof_files_unchanged(proof):
    if not proof: raise ValueError('缺少真实案例产物证明。')
    for case in proof:
        report_path = Path(case['reportPath'])
        if sha(report_path) != case.get('reportSha256'): raise ValueError('案例验收报告已变化。')
        report = json.loads(report_path.read_text(encoding='utf-8'))
        if not report.get('qualified') or not report.get('checks') or not all(report['checks'].values()):
            raise ValueError('案例证明未通过完整验收。')
        package = Path(case['packagePath']).resolve()
        files = report.get('artifacts', [])
        if not files: raise ValueError('案例证明没有真实产物。')
        for artifact in files:
            path = _inside_package(package / artifact['path'], package)
            if sha(path) != artifact.get('sha256'): raise ValueError('已通过学习的案例产物发生变化。')

def check_release_gate():
    run = _run_record()
    learning_id = os.environ.get('WORKBENCH_LEARNING_ID', '')
    if run.get('id') != os.environ.get('WORKBENCH_RUN_ID') or run.get('learningId', '') != learning_id:
        raise ValueError('学习/执行上下文与服务端运行快照不一致。')
    if learning_id:
        contract = json.loads(CONTRACT.read_text(encoding='utf-8'))
        source = Path(run.get('input', {}).get('sourcePath', '')).resolve()
        if not source.is_file() or sha(source) != contract['pairedSourceSha256']:
            raise ValueError('放行前仅可使用已批准的配对案例学习，不能提前运行 P4C61 任务。')
        return
    if not GATE.is_file(): raise ValueError('完整流水线尚未通过案例学习验收，暂不执行新任务。')
    gate = json.loads(GATE.read_text(encoding='utf-8'))
    if gate.get('status') != 'qualified' or gate.get('documentFingerprint') != definition(run['document']):
        raise ValueError('当前流水线或 Skill 版本不符合已验收快照，请先完成案例学习。')
    if gate.get('contractSha256') != sha(CONTRACT): raise ValueError('学习验收标准已变化，请重新验证。')
    if not _case_unchanged(): raise ValueError('原案例或其基线发生变化，不能继续使用旧学习结论。')
    _proof_files_unchanged(gate.get('caseProof'))
    if sha(gate['visualReviewPath']) != gate.get('visualReviewSha256'):
        raise ValueError('已完成的渲染检查记录发生变化。')
    with closing(sqlite3.connect('file:' + str(ROOT / '.local/workbench.sqlite') + '?mode=ro', uri=True)) as db:
        row = db.execute('SELECT value FROM workflow_learning WHERE id=?', (gate.get('learningId', ''),)).fetchone()
    learned = json.loads(row[0]) if row else {}
    if learned.get('status') != 'complete' or learned.get('bestScore') != 100:
        raise ValueError('放行记录没有对应的完整达标学习批次。')
    if not learned.get('bestDocument') or definition(learned['bestDocument']) != gate['documentFingerprint']:
        raise ValueError('学习批次最佳版本与放行版本不一致。')
    if not REQUIRED_IMPLEMENTATIONS.issubset(gate.get('implementationHashes', {})):
        raise ValueError('缺少已验收的固定实现清单。')
    for relative, expected in gate.get('implementationHashes', {}).items():
        if sha(ROOT / relative) != expected: raise ValueError('已验收的实现文件发生变化，请先重新回放案例。')
    if gate.get('templateSha256') != sha(TEMPLATE): raise ValueError('工艺模板发生变化，请先重新验证。')
    if gate.get('profileSchemaSha256') != sha(ROOT / 'skills/hdk-test-firmware/references/profile.schema.json'):
        raise ValueError('固件配置契约发生变化，请先重新验证。')

def _path():
    run_id, _ = _base().context()
    return PRIVATE / (run_id + '.json')

def _write(state):
    PRIVATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = _path()
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.chmod(0o600)
    temporary.replace(path)

def _load():
    state = json.loads(_path().read_text(encoding='utf-8'))
    run_id, _ = _base().context()
    if state['runId'] != run_id or state['learningId'] != os.environ.get('WORKBENCH_LEARNING_ID', ''):
        raise ValueError('能力上下文不属于本次运行。')
    if sha(state['request']['sourcePath']) != state['request']['sourceSha256']:
        raise ValueError('运行期间原始工程发生变化。')
    return state

def invoke(module, method, *args, timeout=1800, **kwargs):
    value = _base()._system_json([str(ROOT / 'hdk/capability_runner.py')],
        input_value={'module': module, 'method': method, 'args': args, 'kwargs': kwargs}, timeout=timeout)
    if not value.get('ok'):
        error = ValueError if value.get('errorType') in {'ValueError', 'ValidationError'} else RuntimeError
        raise error(f"{module}.{method}: {value.get('message', value.get('errorType'))}")
    return value['result']

def preflight(value):
    _admit_node('hdk-preflight')
    check_release_gate()
    if value != _run_record().get('input'):
        raise ValueError('预检输入与服务端运行快照不一致。')
    base = _base()
    plan_input = base.preflight(value)
    run_id, receipt = base.context()
    request = json.loads(receipt.read_text(encoding='utf-8'))
    board = invoke('test_firmware', 'inspect_board', request['sourcePath'], timeout=60)
    package = Path(request['outputParent']) / f"{request['productCode']}_HDK_V{request['hardwareVersion']}"
    state = {'runId': run_id, 'learningId': request['learningId'], 'request': request,
             'testRequirements': value.get('testRequirements', {}),
             'packagePath': str(package), 'boardFacts': board, 'plans': {}, 'results': {}, 'errors': {}}
    if _path().exists(): raise ValueError('本次完整流水线上下文已存在，禁止重复提交。')
    _write(state)
    return plan_input

def export_files(plan):
    _admit_node('hdk-native-export')
    state = _load()
    state['plans']['export'] = plan
    result = _base().execute_plan(plan)
    state['results']['native'] = result
    _write(state)
    return {'runId': state['runId'], 'stage': 'nativeExport', 'status': result['nativeStatus'],
            'artifactCount': result['artifactCount'], 'packagePath': state['packagePath']}

def _process_params(state):
    request = state['request']
    return {k: request[k] for k in ('sourcePath', 'productCode', 'hardwareVersion', 'releaseDate')} | {
        'packagePath': state['packagePath'], 'templatePath': str(TEMPLATE)}

def prepare_process(_value):
    _admit_node('hdk-process-input')
    state = _load()
    prepared = invoke('process_requirements', 'prepare_process_request', _process_params(state), timeout=120)
    # Interface identity comes from the same schematic inspection used by the
    # firmware stage. Signal names such as IO39 need not contain the word SDIO.
    peripherals = state['boardFacts'].get('peripherals', {})
    interfaces = {key: peripherals[key] for key in ('sd', 'camera', 'display', 'usb') if peripherals.get(key)}
    if interfaces.get('sd'):
        pins = set(interfaces['sd']['pins'].values())
        interfaces['sd'] = {**interfaces['sd'], 'signalNets': sorted(net for net, gpio in
            state['boardFacts'].get('netGpioMap', {}).items() if gpio in pins)}
    usb_signals = {pin['net'] for port in interfaces.get('usb', []) for pin in port.get('pins', [])
        if pin.get('net') and pin.get('name', '').lower().startswith(('dp', 'dn'))}
    interfaces['usbSignalPathComponents'] = [{key: component[key] for key in ('designator', 'part', 'pins')}
        for component in state['boardFacts'].get('board', {}).get('components', [])
        if component.get('designator', '').startswith(('R', 'L')) and
        any(pin.get('net') in usb_signals for pin in component.get('pins', []))]
    prepared['facts']['interfaces'] = interfaces
    state['results']['processInput'] = prepared
    _write(state)
    return prepared

def _attempt(state, key, plan, function):
    state['plans'][key] = plan
    try:
        result = function()
        state['results'][key] = result
    except ValueError as error:
        if not state['learningId']: raise
        state['errors'][key] = str(error)
        result = {'status': 'invalidPlan', 'diagnostic': str(error)}
        state['results'][key] = result
    _write(state)
    return {'runId': state['runId'], 'stage': key, 'status': result.get('status', 'generated'),
            'diagnostic': result.get('diagnostic', ''), 'packagePath': state['packagePath']}

def fill_process(plan):
    _admit_node('hdk-process-render')
    state = _load()
    return _attempt(state, 'process', plan, lambda: invoke('process_requirements',
        'generate_process_requirements', _process_params(state) | {'profile': plan, 'render': True}))

def prepare_firmware(_value):
    _admit_node('hdk-firmware-input')
    state = _load()
    schema = json.loads((ROOT / 'skills/hdk-test-firmware/references/profile.schema.json').read_text())
    fixture = invoke('test_firmware', 'design_fixture', state['boardFacts'], timeout=60)
    return {'productCode': state['request']['productCode'], 'boardFacts': _skill_board(state),
            'testRequirements': state['testRequirements'], 'profileSchema': schema,
            'fixtureDesign': fixture}

def _skill_board(state):
    facts = state['boardFacts']
    return {**facts, 'source': {k: v for k, v in facts['source'].items() if k != 'path'},
            'board': {k: v for k, v in facts['board'].items() if k != 'components'}}

def build_firmware(plan):
    _admit_node('hdk-firmware-build')
    state = _load()
    def build():
        generated = invoke('test_firmware', 'generate', state['boardFacts'], plan, state['packagePath'])
        state['results']['firmwareSource'] = generated
        return invoke('test_firmware', 'compile', generated, timeout=2700)
    return _attempt(state, 'firmware', plan, build)

def _sop_request(state):
    return {k: state['request'][k] for k in ('productCode', 'hardwareVersion', 'releaseDate')} | {
        'packagePath': state['packagePath'], 'boardFacts': state['boardFacts'],
        'firmware': state['results'].get('firmware', {'status': 'failed', 'tests': [], 'artifacts': []})}

def prepare_sop(_value):
    _admit_node('hdk-sop-input')
    state = _load()
    request = _sop_request(state)
    # Only bounded facts/interfaces go to the Skill. Source/binaries remain in
    # their isolated directory, and no expected answer is added here.
    return {'productCode': request['productCode'], 'hardwareVersion': request['hardwareVersion'],
            'releaseDate': request['releaseDate'], 'boardFacts': _skill_board(state),
            'firmware': {k: request['firmware'].get(k) for k in ('status', 'target', 'physicalTestStatus', 'tests', 'warnings')}}

def write_sop(plan):
    _admit_node('hdk-sop-render')
    state = _load()
    return _attempt(state, 'sop', plan, lambda: invoke('test_sop', 'render', _sop_request(state),
        str(Path(state['packagePath']) / '生产资料/07_测试说明'), plan))

def _all_artifacts(package):
    result = []
    for path in sorted(package.rglob('*')):
        relative = path.relative_to(package)
        if _os_metadata(relative): continue
        if path.is_symlink(): raise ValueError('交付目录中存在符号链接。')
        if path.is_file():
            result.append({'path': relative.as_posix(), 'bytes': path.stat().st_size, 'sha256': sha(path)})
    return result

def _os_metadata(relative):
    return any(part in {'.DS_Store', '__MACOSX'} or part.startswith('._') for part in Path(relative).parts)

def _inside_package(path, package):
    original = Path(path).absolute()
    candidate = original.resolve()
    if not candidate.is_relative_to(package.resolve()) or not candidate.is_file():
        raise ValueError('验收文件不属于本次交付目录：' + str(path))
    for part in (original, *original.parents):
        if part == package.parent: break
        if part.is_symlink(): raise ValueError('验收文件不得经过符号链接。')
    return candidate

def finalize(_value, *, audit=False):
    if not audit: _admit_node('hdk-file-verify')
    state = _load()
    request = state['request']
    package = Path(state['packagePath'])
    checks = {row['id']: False for row in json.loads(CONTRACT.read_text())['criteria']}
    evidence = {'runId': state['runId'], 'packagePath': str(package), 'checks': checks,
                'errors': dict(state['errors']), 'physicalTestStatus': 'not-run', 'sourceSha256': request['sourceSha256']}
    native = state['results'].get('native', {})
    if native.get('reportPath'):
        readback = _base().verify(native)
        evidence['native'] = readback
        checks['nativeExport'] = readback['coreExportStatus'] == 'complete' and not readback.get('validationErrors')
        checks['releaseNaming'] = checks['nativeExport'] and all(readback['qualitySummary']['sourceConsistency'].values())
    params = _process_params(state)
    process = state['results'].get('process', {})
    if process.get('workbookPath'):
        _inside_package(process['workbookPath'], package)
        validation = invoke('process_requirements', 'validate_process_requirements', params | {
            'workbookPath': process['workbookPath'], 'profile': state['plans']['process']}, timeout=180)
        evidence['process'] = validation
        # Adapted to the independent validator's documented return contract.
        checks['processTemplate'] = validation.get('passed') is True or validation.get('valid') is True or (
            validation.get('status') in {'complete', 'passed'} and bool(validation.get('checks')) and all(validation['checks'].values()))
    firmware = state['results'].get('firmware', {})
    if firmware.get('status') == 'compiled':
        actual = [artifact for artifact in firmware.get('artifacts', [])
            if not _os_metadata(artifact.get('relativePath', artifact['path']))]
        all_files = bool(actual) and all(sha(_inside_package(a['path'], package)) == a['sha256'] for a in actual)
        validation = invoke('test_firmware', 'validate_build', firmware, timeout=120)
        roles = {a.get('role') for a in actual}
        evidence['firmware'] = {'status': firmware['status'], 'target': firmware.get('target'),
            'tests': firmware.get('tests', []), 'roles': sorted(x for x in roles if x), 'hashesChecked': all_files,
            'validation': validation}
        checks['firmwareBuild'] = all_files and validation.get('status') == 'complete' and not validation.get('errors') and (
            {'elf', 'applicationBin', 'buildLog', 'flashArgs', 'mergedBin'}.issubset(roles))
        tests = firmware.get('tests', [])
        coverage = validation.get('checks', {}).get('boardFeatureCoverage', False)
        if isinstance(coverage, dict): coverage = coverage.get('passed') is True
        checks['firmwareCoverage'] = coverage is True and bool(tests) and not any(t.get('unsupported') for t in tests) and (
            {t['id'] for t in tests} == set(state['plans'].get('firmware', {}).get('tests', [])))
    sop = state['results'].get('sop', {})
    if sop.get('markdownPath'):
        _inside_package(sop['markdownPath'], package)
        validation = invoke('test_sop', 'verify', sop['markdownPath'], str(package), timeout=120)
        evidence['sop'] = validation
        checks['testSop'] = validation.get('status') == 'complete' and bool(validation.get('checks')) and (
            all(validation['checks'].values()) and not validation.get('errors'))
    if package.is_dir():
        manuals = state['results'].get('datasheets') or invoke('datasheets', 'collect', state['boardFacts'], str(package),
            product_code=request['productCode'], timeout=300)
        state['results']['datasheets'] = manuals
        if manuals.get('indexPath'):
            verified = invoke('datasheets', 'verify', manuals['indexPath'], str(package), timeout=120)
            evidence['datasheets'] = verified
            checks['datasheets'] = verified.get('status') == 'complete' and bool(verified.get('checks')) and (
                all(verified['checks'].values()) and not verified.get('errors') and not manuals.get('pending'))
    checks['evidence'] = sha(request['sourcePath']) == request['sourceSha256'] and checks['nativeExport'] and _case_unchanged()
    evidence['artifacts'] = _all_artifacts(package) if package.is_dir() else []
    evidence['excludedMetadata'] = sorted(path.relative_to(package).as_posix() for path in package.rglob('*')
        if path.is_file() and _os_metadata(path.relative_to(package))) if package.is_dir() else []
    evidence['qualified'] = all(checks.values())
    destination = Path(request['outputParent']) / '完整流水线验收.json'
    destination.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding='utf-8')
    state['results']['final'] = {'reportPath': str(destination), 'qualified': evidence['qualified']}
    _write(state)
    summary = {'schemaVersion': 1, 'packageName': package.name, 'checks': checks, 'physicalTestStatus': 'not-run'}
    if not evidence['qualified']:
        summary['diagnostics'] = {'errors': evidence['errors'], 'failedChecks': [key for key, ok in checks.items() if not ok],
                                  'plans': state['plans']}
    return {'packageStatus': '自动验收通过，待用户评分' if evidence['qualified'] else '未通过完整自动验收',
            'packagePath': str(package), 'reportPath': str(destination), 'artifactCount': len(evidence['artifacts']),
            'physicalTestStatus': 'not-run', 'qualified': evidence['qualified'], 'qualitySummary': summary}

def qualify_learning(learning_id, document, visual_review_path):
    """Publish a gate only from a completed complete-pipeline learning batch.

    Called by the controller after reviewing rendered files, never by a Skill.
    Revalidates physical files for every case of the selected round.
    """
    with closing(sqlite3.connect('file:' + str(ROOT / '.local/workbench.sqlite') + '?mode=ro', uri=True)) as db:
        row = db.execute('SELECT value FROM workflow_learning WHERE id=?', (learning_id,)).fetchone()
        job = json.loads(row[0]) if row else {}
        if job.get('status') != 'complete' or job.get('bestScore') != 100 or not job.get('bestDocument'):
            raise ValueError('完整学习尚未达标，不能发布执行门槛。')
        if definition(document) != definition(job['bestDocument']):
            raise ValueError('只允许发布实际验证过的最佳工作流和 Skill 版本。')
        if {n['id'] for n in document['nodes'] if n['type'] == 'skill'} != SKILL_NODE_IDS:
            raise ValueError('学习没有覆盖四项独立工程交付 Skill。')
        policy = job.get('memoryPolicy', {})
        if policy.get('mode') != 'batch-snapshot' or policy.get('memoryWriteAllowed') is not False or policy.get('externalMemoryAllowed') is not False:
            raise ValueError('学习记忆隔离尚未确认。')
        best = next((r for r in job.get('rounds', []) if r['index'] == job.get('bestRound')), None)
        if not best or best['status'] != 'complete' or not best.get('cases'):
            raise ValueError('缺少完整已评估轮次。')
        proof = []
        old = {k: os.environ.get(k) for k in ('WORKBENCH_RUN_ID', 'WORKBENCH_LEARNING_ID')}
        try:
            for case in best['cases']:
                run_row = db.execute('SELECT value FROM workflow_runs WHERE id=?', (case.get('runId'),)).fetchone()
                run = json.loads(run_row[0]) if run_row else {}
                if case.get('score') != 100 or run.get('status') != 'complete' or run.get('learningId') != learning_id:
                    raise ValueError('有样例没有对应真实完成且达标的业务运行。')
                if definition(run['document']) != definition(document): raise ValueError('样例实际运行版本不一致。')
                os.environ['WORKBENCH_RUN_ID'] = run['id']; os.environ['WORKBENCH_LEARNING_ID'] = learning_id
                state = _load()
                contract = json.loads(CONTRACT.read_text(encoding='utf-8'))
                if state['request']['sourceSha256'] != contract['pairedSourceSha256']:
                    raise ValueError('达标样例不属于批准的配对训练源。')
                fresh = finalize({}, audit=True)
                if not fresh['qualified']: raise ValueError('样例产物重新验收不通过：' + fresh['reportPath'])
                proof.append({'runId': run['id'], 'role': case.get('role'), 'reportPath': fresh['reportPath'],
                              'reportSha256': sha(fresh['reportPath']), 'packagePath': fresh['packagePath']})
        finally:
            for key, value in old.items():
                if value is None: os.environ.pop(key, None)
                else: os.environ[key] = value
    review = json.loads(Path(visual_review_path).read_text(encoding='utf-8'))
    if review.get('status') != 'passed' or review.get('learningId') != learning_id:
        raise ValueError('缺少该学习批次实际渲染检查记录。')
    covered = {(r['runId'], a['kind']): a for r in review.get('runs', []) for a in r.get('artifacts', [])}
    for case in proof:
        report = json.loads(Path(case['reportPath']).read_text(encoding='utf-8'))
        files = {a['path']: a for a in report['artifacts']}
        state = json.loads((PRIVATE / (case['runId'] + '.json')).read_text(encoding='utf-8'))
        expected_paths = dict(state['plans'].get('export', {}).get('paths', {}))
        process_path = state['results'].get('process', {}).get('workbookPath')
        if process_path:
            expected_paths['processXlsx'] = _inside_package(process_path, Path(case['packagePath'])).relative_to(
                Path(case['packagePath']).resolve()).as_posix()
        for kind in ('schematicPdf', 'silkscreenPdf', 'processXlsx'):
            inspected = covered.get((case['runId'], kind))
            if not inspected or inspected.get('status') != 'passed' or inspected.get('path') not in files or (
                not expected_paths.get(kind) or inspected.get('path') != expected_paths[kind]):
                raise ValueError('案例缺少实际图纸或工艺表的渲染检查：' + kind)
            if files[inspected['path']]['sha256'] != inspected.get('sha256'):
                raise ValueError('实际检查的图纸或工艺表不是当前产物。')
    implementations = set(REQUIRED_IMPLEMENTATIONS)
    implementations.update(str(p.relative_to(ROOT)) for p in (ROOT / 'skills/hdk-test-firmware/assets').rglob('*') if p.is_file())
    if (ROOT / 'hdk/companion_firmware.py').is_file(): implementations.add('hdk/companion_firmware.py')
    gate = {'schemaVersion': 1, 'status': 'qualified', 'learningId': learning_id, 'bestRound': job['bestRound'],
        'contractSha256': sha(CONTRACT), 'documentFingerprint': definition(document), 'caseProof': proof,
        'templateSha256': sha(TEMPLATE),
        'profileSchemaSha256': sha(ROOT / 'skills/hdk-test-firmware/references/profile.schema.json'),
        'visualReviewPath': str(Path(visual_review_path).resolve()), 'visualReviewSha256': sha(visual_review_path),
        'implementationHashes': {path: sha(ROOT / path) for path in sorted(implementations)},
        'physicalTestStatus': 'not-run', 'scope': 'paired-case artifact correctness and real builds; unseen P4 output awaits user rating'}
    GATE.write_text(json.dumps(gate, ensure_ascii=False, indent=2), encoding='utf-8')
    return gate
