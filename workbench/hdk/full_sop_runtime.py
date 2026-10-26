"""Versioned SOP-only correction of the C61 application/fixture instructions.

The compiled aggregate is copied by the existing capability before this adapter
touches its attempt-owned copy. No source, executable, wiring or flash layout is
changed. Authentication, receipt loading, rendering and build validation remain
the original implementation's responsibilities.
"""
from pathlib import Path
import copy
import hashlib
import importlib.util
import json

OPERATION = 'hdk.full.sop'
OLD_STEP = '烧录/复位时断开环回线；P4与C61应用READY后再接入新设计夹具。'
NEW_STEP = ('烧录/上电/复位期间保持环回隔离；等待P4 `HDK usb-console READY`，'
    '再以同板 `HDK companion-link PASS` 确认C61应用链路，由人工确认后仅闭合所列被动信号触点。'
    'C61没有字面READY日志，hello不代表GPIO已进入输入态；结束先断开触点再复位/下载/断电。')
OLD_PARAGRAPH = '**这是新设计、未实物验证的被动夹具。烧录/上电/复位时断开环回；两芯片应用READY后再接。**'
NEW_PARAGRAPH = ('**这是新设计、未实物验证的被动夹具。烧录/上电/复位全过程保持环回隔离；'
    '等待P4 `HDK usb-console READY`，再用P4终端的 `link` 命令取得同板 '
    '`HDK companion-link PASS`，由人工确认后仅闭合本表被动信号触点。'
    'C61没有字面READY日志，hello不等于其GPIO已进入输入态。'
    '结束先断开环回触点，再复位、进入下载模式或断电。**')
BINARY_ROLES = {'elf', 'applicationBin', 'bootloaderBin', 'partitionBin', 'mergedBin', 'flashArgs', 'flashArgsText'}


def sha(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''): value.update(block)
    return value.hexdigest()


def private_core():
    path = Path(__file__).with_name('full_dag.py')
    spec = importlib.util.spec_from_file_location('hdk_full_sop_runtime_private', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _owned(path, package):
    path, package = Path(path), Path(package)
    if (not path.is_absolute() or not path.is_relative_to(package)
            or path.resolve(strict=True) != path or path.is_symlink() or not path.is_file()):
        raise ValueError('SOP文档修正只允许本次真实、非软链产物。')
    return path


def _snapshot(core, package):
    return {item['path']: {'sha256': item['sha256'], 'bytes': item['bytes']} for item in core.inventory(package)}


def _steps(tests, expected):
    """Replace exact existing operator instructions, never arbitrary JSON text."""
    changed, present = [], []
    def visit(value, location='tests'):
        if isinstance(value, dict):
            for key, child in value.items():
                if key == 'operatorSteps':
                    if not isinstance(child, list) or any(not isinstance(step, str) for step in child):
                        raise ValueError('操作步骤格式无效，不能进行受控修正。')
                    for index, step in enumerate(child):
                        where = location + '.operatorSteps[' + str(index) + ']'
                        if step == OLD_STEP:
                            child[index] = NEW_STEP; changed.append(where); present.append(where)
                        elif step == NEW_STEP: present.append(where)
                        elif 'P4与C61应用READY' in step or '两芯片应用READY' in step:
                            raise ValueError('发现未经确认的C61 READY措辞，禁止宽泛替换。')
                else: visit(child, location + '.' + str(key))
        elif isinstance(value, list):
            for index, child in enumerate(value): visit(child, location + '[' + str(index) + ']')
    visit(tests)
    if len(present) != expected:
        raise ValueError('C61 READY步骤数量与当前已核验固件契约不一致。')
    encoded = json.dumps(tests, ensure_ascii=False)
    if OLD_STEP in encoded or 'P4与C61应用READY' in encoded or '两芯片应用READY' in encoded:
        raise ValueError('当前测试清单仍有未修正的双芯片READY要求。')
    return changed


def normalize_aggregate(report, package, copies, core):
    """Correct four files in a newly copied aggregate and revalidate all builds."""
    package = Path(package)
    if not package.is_absolute() or package.resolve(strict=True) != package or package.is_symlink():
        raise ValueError('SOP修正需要规范的本次独立产物目录。')
    before = _snapshot(core, package)
    if report.get('target') != 'esp32p4':
        return report, core._validate_build(report), copies, {
            'schemaVersion': 1, 'applicable': False, 'reason': '当前构建不含P4/C61配套说明。',
            'physicalTestStatus': 'not-run', 'changes': [], 'protectedFiles': len(before)}, before
    if report.get('physicalTestStatus') != 'not-run':
        raise ValueError('文档修正不能继承硬件实测通过声明。')
    master_path = _owned(report['manifestPath'], package)
    area = _owned(master_path, package).parent
    if report.get('artifactRoot') != str(area) or core.read(master_path) != report:
        raise ValueError('当前聚合清单与真实本次文件不一致。')
    variants = report.get('revisionVariants') or []
    modern = [item for item in variants if item.get('family') == 'v3']
    if len(modern) != 1: raise ValueError('需要唯一的当前P4 v3构建。')
    paths = {'c61': _owned(report['companion']['manifestPath'], package),
        'v3': _owned(modern[0]['manifestPath'], package), 'legacy': master_path}
    if paths['c61'] != area / 'C61/firmware-manifest.json' or paths['v3'] != area / 'variants/p4-v3/firmware-manifest.json':
        raise ValueError('当前三构建不符合独立复制后的固定目录契约。')
    guide = _owned(area / 'C61/C61烧录说明.md', package)
    text = guide.read_bytes().decode('utf-8')
    if text.count(OLD_PARAGRAPH) == 1 and NEW_PARAGRAPH not in text:
        updated = text.replace(OLD_PARAGRAPH, NEW_PARAGRAPH)
    elif OLD_PARAGRAPH not in text and text.count(NEW_PARAGRAPH) == 1:
        updated = text
    else: raise ValueError('C61烧录说明没有唯一可核对的原始或已规范段落。')
    if '两芯片应用READY' in updated or 'P4与C61应用READY' in updated:
        raise ValueError('C61烧录说明仍有未核对的READY要求。')
    reports = {name: core.read(path) for name, path in paths.items()}
    original_reports = copy.deepcopy(reports)
    edits = {}
    for name, current in reports.items():
        if (current.get('physicalTestStatus') != 'not-run' or current.get('status') != 'compiled'
                or current.get('boardSourceSha256') != report.get('boardSourceSha256')
                or current.get('target') != ('esp32c61' if name == 'c61' else 'esp32p4')):
            raise ValueError('修正对象不是同源、未实板验证的当前三构建。')
        edits[name] = _steps(current.get('tests'), 1 if name == 'c61' else 2)
    allowed = {str(guide), *(str(path) for path in paths.values())}
    guide.write_bytes(updated.encode('utf-8'))
    validations = {}
    # Children first: the master binds their actual updated file hashes.
    for name in ('c61', 'v3', 'legacy'):
        current = core._refresh_report(reports[name])
        core.replace_json(paths[name], current)
        validations[name] = core._validate_build(current, single=name != 'legacy')
    after = _snapshot(core, package)
    if set(before) != set(after): raise ValueError('文档修正增删了已编译产物文件。')
    changed = {path for path in before if before[path] != after[path]}
    if changed - allowed: raise ValueError('文档修正改变了源代码、二进制或其它受保护文件。')
    protected = {path: item for path, item in after.items() if path not in allowed}
    for name, current in reports.items():
        restored = copy.deepcopy(current)
        restored['tests'] = copy.deepcopy(original_reports[name]['tests'])
        restored['artifacts'] = copy.deepcopy(original_reports[name]['artifacts'])
        if restored != original_reports[name]:
            raise ValueError('固件清单修正改变了tests和库存哈希以外的工程/烧录事实。')
        if len(current['artifacts']) != len(original_reports[name]['artifacts']):
            raise ValueError('文档修正增删了固件清单产物条目。')
        for old, new in zip(original_reports[name]['artifacts'], current['artifacts']):
            if old.get('path') != new.get('path'):
                raise ValueError('文档修正改变了清单产物路径。')
            restored_entry = dict(new, sha256=old['sha256'], bytes=old['bytes'])
            if restored_entry != old or (old['path'] not in allowed and new != old):
                raise ValueError('文档修正改变了清单拓扑或受保护产物SHA。')
    for item in copies:
        path = item['path']
        if path in changed:
            item['documentationCorrected'] = True
            item['documentationCorrection'] = {'beforeSha256': before[path]['sha256'], 'afterSha256': after[path]['sha256']}
            item['deliveredSha256'] = after[path]['sha256']
        if sha(item['source']) != item['sha256']:
            raise ValueError('文档修正期间原始compiled来源发生变化。')
    binary = {}
    for current in reports.values():
        for item in current['artifacts']:
            if item.get('role') in BINARY_ROLES:
                path = item['path']
                if path not in protected or before[path] != after[path]:
                    raise ValueError('文档修正改变了真实固件、ELF或flash参数。')
                binary[path] = {'path': Path(path).relative_to(package).as_posix(), **after[path]}
    copied = {item['path']: item for item in copies}
    changes = [{'path': Path(path).relative_to(package).as_posix(), 'beforeSha256': before[path]['sha256'],
        'afterSha256': after[path]['sha256'], 'beforeBytes': before[path]['bytes'], 'afterBytes': after[path]['bytes'],
        'documentationCorrected': True, 'metadataRelocated': copied.get(path, {}).get('metadataRelocated', False),
        'classification': 'documentation-correction' if path == str(guide) else 'current-manifest-documentation-and-artifact-hashes'}
        for path in sorted(changed)]
    evidence = {'schemaVersion': 1, 'applicable': True, 'operation': 'c61-application-readiness-instructions-v1',
        'physicalTestStatus': 'not-run', 'changes': changes, 'operatorStepFields': edits,
        'checks': {'allOtherFilesByteIdentical': True, 'compiledSourceAndBinaryPreserved': True,
            'flashOffsetsAndWiringUnchanged': True, 'allThreeBuildsRevalidated': True},
        'protectedFiles': len(protected), 'compiledImageEvidence': list(binary.values()),
        'validations': {name: {'status': value['status'], 'checks': value['checks'], 'errors': value.get('errors', [])}
            for name, value in validations.items()},
        'scope': 'Only the current operator document and tests.operatorSteps in three active manifests are corrected. '
                 'Historical generation evidence and actual build commands remain untouched. No model/build/flash is invoked.'}
    # Rendering may add SOP/index/preview files, but it must not change any of
    # the already normalized aggregate, including its four corrected documents.
    return reports['legacy'], validations['legacy'], copies, evidence, after


class _ReceiptAPI:
    def __init__(self, original, core, state, implementation):
        self.original, self.core, self.state, self.implementation = original, core, state, implementation

    def __getattr__(self, name): return getattr(self.original, name)

    def receipt(self, operation, data, run, out, artifacts=(), extra=None):
        if operation != OPERATION or 'normalization' not in self.state:
            raise ValueError('SOP规范化缺少真实独立复制与验收边界。')
        for path, item in self.state['protected'].items():
            if sha(_owned(path, self.state['package'])) != item['sha256']:
                raise ValueError('SOP生成期间受保护的compiled文件发生变化。')
        for item in self.state['copies']:
            if sha(item['source']) != item['sha256']:
                raise ValueError('SOP生成期间原始compiled来源发生变化。')
        if sha(self.implementation['path']) != self.implementation['sha256']:
            raise ValueError('SOP运行适配实现发生变化。')
        checked = self.core._validate_build(data['build'])
        evidence = self.state['normalization'] | {'implementation': self.implementation,
            'sourceAggregateReceipt': self.state['sourceReceipt'],
            'checksAtReceipt': {'compiledFilesStillUnchanged': True, 'originalCompiledSourceStillUnchanged': True,
                'implementationUnchanged': True, 'buildStatus': checked['status']}}
        path = Path(out) / 'C61附录文档规范化.json'
        self.core.write(path, evidence)
        files = [{'path': str(path), 'kind': 'documentation-normalization-proof'}]
        data = copy.deepcopy(data)
        if evidence['applicable']:
            guide = Path(data['build']['artifactRoot']) / 'C61/C61烧录说明.md'
            markdown = _owned(data['rendered']['markdownPath'], self.state['package'])
            href = self.core.sop._link(str(guide), markdown.parent)
            if '](' + href + ')' not in markdown.read_text(encoding='utf-8'):
                raise ValueError('正式SOP没有提供修正后C61烧录说明的实际可点击链接。')
            file = self.core.file_ref(guide, 'companion-flash-guide')
            data['reviewFiles'] = list(data['reviewFiles']) + [file]
            files.append({'path': str(guide), 'kind': 'companion-flash-guide'})
        data['documentationNormalization'] = evidence | {'reportPath': str(path)}
        data['proofFiles'] = list(data.get('proofFiles', [])) + [self.implementation,
            {'path': str(path), 'sha256': sha(path)}]
        additions = self.original.assets(files)
        return self.original.receipt(operation, data, run, out, list(artifacts) + additions,
            extra=dict(extra or {}, physicalTestStatus='not-run', documentationNormalization={
                'applicable': evidence['applicable'], 'reportPath': str(path),
                'changedFiles': len(evidence['changes']), 'compiledFilesUnchanged': True,
                'implementationSha256': self.implementation['sha256']}))


def full(operation, value, context, api):
    if operation != OPERATION: raise ValueError('独立SOP运行适配器仅支持hdk.full.sop。')
    implementation = {'path': str(Path(__file__).resolve()), 'sha256': sha(__file__)}
    core, state = private_core(), {}
    original = core.relocate_aggregate
    def relocated(report, package):
        expected = Path(context['outputDirectory']) / 'package'
        if Path(package) != expected: raise ValueError('SOP修正不能写入本次能力目录之外。')
        result, _, copies = original(report, package)
        result, checked, copies, normalization, protected = normalize_aggregate(result, package, copies, core)
        source = value.get('firmware', {}) if isinstance(value, dict) else {}
        state.update(normalization=normalization, protected=protected, package=Path(package), copies=copies,
            sourceReceipt={key: source[key] for key in ('kind', 'runId', 'nodeId', 'operation', 'receiptPath', 'receiptSha256', 'attempt', 'attemptId') if key in source})
        return result, checked, copies
    core.relocate_aggregate = relocated
    return core.full(operation, value, context, _ReceiptAPI(api, core, state, implementation))
