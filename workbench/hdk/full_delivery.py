"""Separate immutable HDK assembly, reread verification, and ZIP creation.

The assembly directory is never changed by the later phases.  Verification
publishes a small companion kit; ZIP creation places that kit at 校验/ inside
the archive.  Historical compiler metadata is evidence, not a replay claim.
"""
from pathlib import Path, PurePosixPath
import copy
import hashlib
import json
import os
import re
import shlex
import shutil
import stat
import zipfile
from urllib.parse import unquote, urlsplit

from hdk import full_dag as core
from hdk import guide_package as markdown

PREFIX = 'hdk.full.'
OPERATIONS = {PREFIX + name for name in ('assemble', 'verify-delivery', 'archive-delivery')}
PARENTS = {'facts': 'prepare', 'native': 'native', 'process': 'process',
           'firmware': 'firmware-aggregate', 'sop': 'sop', 'datasheets': 'datasheets'}
KIT = '校验'
KIT_FILES = ('relative-inventory.json', 'verify_delivery.py', 'verification.json')
SCOPE = ('Current native manufacturing, process, test firmware/SOP and datasheets only; '
         'STEP/CAD/Pinout/guides are separate flows. No hardware test or release qualification is claimed.')


def digest(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b''): value.update(part)
    return value.hexdigest()


def _relative(value):
    if not isinstance(value, str) or not value or any(c in value for c in ('\\', ':', '\x00', '\r', '\n')):
        raise ValueError('交付相对路径无效。')
    path = PurePosixPath(value)
    if path.is_absolute() or '..' in path.parts or str(path) != value or value == '.':
        raise ValueError('交付相对路径越界或不规范。')
    return Path(value)


def _root(value):
    path = Path(value)
    if not path.is_absolute() or not path.is_dir() or path.is_symlink() or path.resolve(strict=True) != path:
        raise ValueError('HDK目录必须是本次真实的规范目录。')
    return path


def _file(value, root=None):
    path = Path(value)
    if (not path.is_absolute() or not path.is_file() or path.is_symlink()
            or path.resolve(strict=True) != path or root is not None and not path.is_relative_to(root)):
        raise ValueError('交付文件缺失、含软链或超出本次目录。')
    return path


def _write(path, value): core.write(Path(path), value)
def _read(path): return core.read(_file(path))
def _one(value): return value['in'] if isinstance(value, dict) and set(value) == {'in'} else value


def relative_inventory(package):
    package = _root(package)
    return [{'path': Path(item['path']).relative_to(package).as_posix(), 'bytes': item['bytes'],
             'sha256': item['sha256']} for item in core.inventory(package)]


def check_inventory(package, rows):
    if not isinstance(rows, list) or not rows or len(rows) > core.MAX_FILES:
        raise ValueError('交付库存缺失或超限。')
    expected, total = {}, 0
    for item in rows:
        if not isinstance(item, dict) or set(item) != {'path', 'bytes', 'sha256'}:
            raise ValueError('相对交付库存字段无效。')
        name = _relative(item['path']).as_posix()
        if name in expected or type(item['bytes']) is not int or item['bytes'] < 0 or not re.fullmatch(r'[0-9a-f]{64}', str(item['sha256'])):
            raise ValueError('交付库存含重复路径或无效SHA/大小。')
        expected[name] = item; total += item['bytes']
    if total > core.MAX_BYTES: raise ValueError('交付库存超过2GiB。')
    actual = relative_inventory(package)
    if {x['path']: x for x in actual} != expected:
        raise ValueError('实际HDK目录与已冻结相对库存不一致。')
    return actual


def _implementation():
    return [{'path': str(Path(path).resolve()), 'sha256': digest(path)}
            for path in (Path(__file__), Path(markdown.__file__))]


def _current(api, run):
    current = api.row('workflow_runs', run['id'])
    if not isinstance(current, dict) or current.get('id') != run['id']:
        raise ValueError('无法重新核对当前工作流审批。')
    return current


def _parents(tokens, run, context, api):
    if not isinstance(tokens, dict) or set(tokens) != set(PARENTS):
        raise ValueError('HDK组装需要六个明确的当前输入端口。')
    data = {key: api.load(tokens[key], run, PREFIX + operation) for key, operation in PARENTS.items()}
    facts = data.pop('facts'); core._same(facts, *data.values())
    reviews = {key: api.reviewed_artifacts(run, context, tokens[key], data[key]['reviewFiles'], port=key)
               for key in ('native', 'process', 'sop')}
    return facts, data, reviews


def _bins(report):
    root = _root(report['artifactRoot'])
    return {(a['role'], _file(a['path'], root).relative_to(root).as_posix()): a['sha256']
            for a in report['artifacts'] if a['role'] in ('source', 'applicationBin', 'mergedBin', 'elf')}


def _preserve_sop(source, final, package):
    before = _file(source['rendered']['markdownPath'], _root(source['packagePath']))
    after = _file(final['markdownPath'], package)
    for a, b in [(before, after), (before.parent / core.sop_v2.INDEX_MD, after.parent / core.sop_v2.INDEX_MD)]:
        if core._sop_semantics(a.read_text()) != core._sop_semantics(b.read_text()):
            raise ValueError('最终组装改变了已批准SOP或索引语义，需要重新人工审核。')
    for name in ('wiring.svg', 'wiring.png'):
        if digest(before.parent / 'images' / name) != digest(after.parent / 'images' / name):
            raise ValueError('最终接线图与已批准的实际图不同。')
    # A corrected C61 guide can be an additional explicit review file.  Only
    # the main/index metadata are permitted to undergo semantic relocation.
    source_root = _root(source['packagePath'])
    semantics = {before, before.parent / core.sop_v2.INDEX_MD}
    for item in source['reviewFiles']:
        path = _file(item['path'])
        if path.is_relative_to(source_root) and path not in semantics:
            target = _file(package / path.relative_to(source_root), package)
            if digest(path) != item['sha256'] or digest(target) != item['sha256']:
                raise ValueError('已批准的SOP附件在组装时发生变化。')
    return {'sourceSha256': digest(before), 'deliveredSha256': digest(after),
            'bodyWiringAndApprovedAttachmentsUnchanged': True,
            'transformation': 'Only deterministic metadata hash/byte updates after path relocation; no operator instruction changes.'}


def _assemble_files(facts, parents, package):
    core._validate_build(parents['firmware']['build']); core._validate_build(parents['sop']['build'])
    if _bins(parents['firmware']['build']) != _bins(parents['sop']['build']):
        raise ValueError('已批准SOP引用另一份源代码或固件。')
    report, build_check, copies = core.relocate_aggregate(parents['sop']['build'], package)
    native = parents['native']; native_root = _root(native['packagePath'])
    native_check = core.verify_full_native(native['native']['reportPath'])
    if native_check['coreStatus'] != 'complete' or native_check.get('errors'):
        raise ValueError('当前制造资料未通过独立重读。')
    for item in native_check['artifacts']:
        relative = _relative(item['path']); source = _file(native_root / relative, native_root)
        target = package / relative; target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists() or target.is_symlink(): raise ValueError('制造文件与交付分支重名。')
        with target.open('xb') as stream, source.open('rb') as incoming: shutil.copyfileobj(incoming, stream)
        if digest(source) != item['sha256'] or digest(target) != item['sha256']:
            raise ValueError('制造文件最终副本SHA不一致。')
        copies.append({'source': str(source), 'path': str(target), 'sha256': item['sha256'],
                       'deliveredSha256': item['sha256'], 'metadataRelocated': False})
    proc = parents['process']; proc_root = _root(proc['packagePath'])
    source = _file(proc['result']['workbookPath'], proc_root); target = package / source.relative_to(proc_root)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open('xb') as stream, source.open('rb') as incoming: shutil.copyfileobj(incoming, stream)
    if digest(source) != digest(target): raise ValueError('已批准工艺表副本SHA不一致。')
    copies.append({'source': str(source), 'path': str(target), 'sha256': digest(source),
                   'deliveredSha256': digest(target), 'metadataRelocated': False})
    proc_check = core.validate_full_process(facts['request'] | {'workbookPath': str(target), 'profile': proc['plan']},
                    proc.get('unresolved', proc['result'].get('unresolved', [])))
    if proc_check.get('passed') is not True: raise ValueError('组装的工艺表未通过重读。')
    copies += core.copy_tree(_root(parents['datasheets']['packagePath']) / '重要器件手册', package / '重要器件手册')
    manual_check = core.datasheets.verify(package / '重要器件手册/资料来源索引.json', package)
    if manual_check.get('status') != 'complete' or not all(manual_check.get('checks', {}).values()):
        raise ValueError('组装的器件手册未通过重读。')
    final = core.sop_v2.render(core._sop_request(facts, report, package), package / '生产资料/07_测试说明', parents['sop']['plan'])
    if final.get('status') != 'complete': raise ValueError('组装的SOP未通过重读。')
    preservation = _preserve_sop(parents['sop'], final, package)
    if _bins(report) != _bins(parents['sop']['build']): raise ValueError('组装修改了源代码或二进制。')
    return {'build': report, 'native': native_check, 'process': proc_check, 'datasheets': manual_check,
            'sop': final, 'assemblyCopies': copies, 'sopRelocation': preservation,
            'processRelativePath': target.relative_to(package).as_posix()}


def _local(url, parent, root):
    if not isinstance(url, str) or any(c in url for c in ('\x00', '\r', '\n', '\\')): raise ValueError('文档引用无效。')
    u = urlsplit(url)
    if u.scheme:
        if u.scheme.lower() in ('http', 'https', 'mailto', 'data'): return None
        raise ValueError('文档引用协议不允许。')
    if u.netloc or not u.path: return None
    decoded = unquote(u.path)
    if Path(decoded).is_absolute() or any(c in decoded for c in ('\x00', '\r', '\n', '\\')):
        raise ValueError('文档引用绝对路径或无效编码。')
    target = Path(os.path.normpath(str(parent / decoded)))
    if not target.is_relative_to(root): raise ValueError('文档引用越过交付根目录。')
    return target


def _temporary_replay_copy(block, document, package):
    """Recognize only the emitted three-line replay recipe; never run shell.

    Its -C operand names a future temporary copy, rather than a package file.
    Freeze the actual package source inventory which that exact cp would copy.
    Other variables, assignments, shell operators or copy recipes are rejected
    by the ordinary operand check instead of being guessed or expanded.
    """
    lines = [line.strip() for line in block.replace('\\\n', ' ').splitlines() if line.strip()]
    if len(lines) != 3 or lines[0] != 'replay_dir=$(mktemp -d /tmp/hdk-replay-XXXXXX)': return None
    try:
        copy_words, build_words = [shlex.split(line, comments=True) for line in lines[1:]]
    except ValueError: return None
    # Only the target flag varies; no shell operators or extra commands.
    expected = ['python', '$IDF_PATH/tools/idf.py', '--preview', '-B', '$replay_dir/build', '-C', '$replay_dir/source']
    if (copy_words != ['cp', '-R', 'source', '$replay_dir/source'] or len(build_words) != 9
            or build_words[:7] != expected or not re.fullmatch(r'-DIDF_TARGET=esp32[a-z0-9]+', build_words[7])
            or build_words[8] != 'build'): return None
    source = _root(_local('source', document.parent, package))
    rows = relative_inventory(source)
    if not rows: raise ValueError('操作命令的临时重放源码目录为空。')
    inventory_sha = hashlib.sha256(json.dumps(rows, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return {'document': document.relative_to(package).as_posix(), 'operand': '$replay_dir/source',
            'source': source.relative_to(package).as_posix(), 'temporaryTemplate': '/tmp/hdk-replay-XXXXXX',
            'sourceInventorySha256': inventory_sha, 'sourceFileCount': len(rows),
            'inventoryBasis': 'Sorted source-relative paths, byte sizes and SHA-256; files also belong to the frozen package inventory.',
            'executed': False}


def document_closure(package, assembly, source_sop):
    package = _root(package)
    main = _file(assembly['sop']['markdownPath'], package)
    starts = [main, main.parent / core.sop_v2.INDEX_MD, package / '重要器件手册/资料说明.md']
    pending = [p for p in starts if p.is_file()]; seen, links, limitations, commands, archived_examples, replay_copies = set(), [], [], [], [], []
    frozen = {item['path']: item['sha256'] for item in source_sop.get('proofFiles', [])}
    copies = {item['path']: item for item in assembly['assemblyCopies']}
    source_root = _root(source_sop['packagePath'])
    while pending:
        path = pending.pop(0)
        if path in seen: continue
        _file(path, package); seen.add(path); text = path.read_text(encoding='utf-8-sig')
        for url in markdown.markdown_urls(text):
            target = _local(url, path.parent, package)
            if target is None: continue
            if not target.is_file():
                copy_item = copies.get(str(path)); source = Path(copy_item['source']) if copy_item else None
                legacy = source and re.search(r'(?:^|/)source/components/wt_bsp/(?:README\.md|boards/WT9932S31-TINY/README\.md)$', str(source))
                original = _local(url, source.parent, source_root) if source else None
                if (not legacy or original is None or original.exists() or original.is_symlink()
                        or frozen.get(str(source)) != digest(source) or digest(source) != digest(path)):
                    raise ValueError('操作文档断链或缺少原有来源限制证据：' + str(target.relative_to(package)))
                limitations.append({'document': path.relative_to(package).as_posix(), 'url': url,
                    'target': target.relative_to(package).as_posix(), 'sourceDocument': str(source),
                    'sourceDocumentSha256': digest(source), 'originalTarget': str(original), 'originalTargetMissing': True})
                continue
            _file(target, package)
            links.append({'document': path.relative_to(package).as_posix(), 'url': url, 'target': target.relative_to(package).as_posix()})
            if target.suffix.lower() in ('.md', '.markdown'): pending.append(target)
        # Vendored README examples assume their original whole-repository CWD,
        # not this README's directory. They are preserved source documentation,
        # never promoted to selected operator replay instructions. Their actual
        # Markdown links above are still checked and limited explicitly.
        document = path.relative_to(package).as_posix()
        if '/source/' in '/' + document or '/managed_components/' in '/' + document:
            if re.search(r'```(?:sh|bash|shell)\s*\n', text):
                archived_examples.append({'document': document, 'executed': False,
                    'scope': 'Vendored source repository examples; not selected operational/replay entrypoints.'})
            continue
        # Inspect, never execute, selected operator/replay shell file operands.
        # Historical JSON buildCommand arrays remain outside this replay check.
        for block in re.findall(r'```(?:sh|bash|shell)\s*\n(.*?)```', text, re.S):
            replay = _temporary_replay_copy(block, path, package)
            if replay: replay_copies.append(replay)
            for line in block.replace('\\\n', ' ').splitlines():
                if not line.strip() or line.lstrip().startswith('#'): continue
                try: words = shlex.split(line, comments=True)
                except ValueError as error: raise ValueError('操作命令无法完整解析。') from error
                operands = [w for w in words if w.lower().endswith(('.bin', '.elf'))]
                for i, word in enumerate(words[:-1]):
                    if word == '-C': operands.append(words[i + 1])
                for operand in operands:
                    temporary = replay is not None and operand == replay['operand']
                    if not temporary and any(token in operand for token in ('$', '`')):
                        raise ValueError('操作命令包含未绑定动态文件引用：' + document + '：' + operand)
                    target = package / replay['source'] if temporary else _local(operand, path.parent, package)
                    if target is None or not target.exists() or target.is_symlink(): raise ValueError('操作命令引用缺失或非相对文件：' + document + '：' + operand)
                    if target.is_dir(): _root(target)
                    else: _file(target, package)
                    commands.append({'document': path.relative_to(package).as_posix(), 'operand': operand,
                                     'target': target.relative_to(package).as_posix(), 'executed': False,
                                     **({'resolvedThrough': 'controlled-temporary-copy', 'sourceInventorySha256': replay['sourceInventorySha256']} if temporary else {})})
    return {'entrypoints': [p.relative_to(package).as_posix() for p in starts if p.is_file()],
            'documents': sorted(p.relative_to(package).as_posix() for p in seen), 'links': links,
            'sourceDocumentationLimitations': limitations, 'relativeCommandOperands': commands,
            'archivedSourceCommandExamples': archived_examples,
            'temporaryReplayCopies': replay_copies,
            'scope': 'Operational documents have no missing local files. Frozen vendor README limitations are enumerated; no build/flash command was executed.'}


def _portable_script(manifest_sha, report_sha):
    # This verifier intentionally depends only on Python's standard library.
    return '''#!/usr/bin/env python3
"""Verify copied/extracted HDK files. Does not compile, flash, or test hardware."""
from pathlib import Path, PurePosixPath
import hashlib,json,sys
def sha(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for b in iter(lambda:f.read(1048576),b''):h.update(b)
 return h.hexdigest()
def verify(root):
 root=Path(root).absolute()
 if not root.is_dir() or root.is_symlink() or root.resolve()!=root:raise ValueError('Invalid directory or symlink')
 manifest=Path(__file__).with_name('relative-inventory.json')
 if sha(manifest)!=''' + repr(manifest_sha) + ''':raise ValueError('Inventory manifest SHA changed')
 report=Path(__file__).with_name('verification.json')
 if not report.is_file() or report.is_symlink() or sha(report)!=''' + repr(report_sha) + ''':raise ValueError('Verification report SHA changed')
 data=json.loads(manifest.read_text(encoding='utf-8')); expected={}
 for row in data['files']:
  name=row['path'];p=PurePosixPath(name)
  if not isinstance(name,str) or p.is_absolute() or '..' in p.parts or str(p)!=name or name=='.' or any(x in name for x in ('\\\\',':','\\x00')) or name in expected:raise ValueError('Unsafe/duplicate path')
  q=root/Path(name)
  if q.is_symlink() or q.resolve()!=q or not q.is_file() or q.stat().st_size!=row['bytes'] or sha(q)!=row['sha256']:raise ValueError('Changed/missing file: '+name)
  expected[name]=row
 allowed={'校验/relative-inventory.json','校验/verify_delivery.py','校验/verification.json'}
 actual=set()
 for q in root.rglob('*'):
  if q.is_symlink():raise ValueError('Symlink: '+str(q))
  if not q.is_file():continue
  rel=q.relative_to(root)
  if q.name in ('.DS_Store','Thumbs.db','desktop.ini') or q.name.startswith('._') or '__MACOSX' in rel.parts:continue
  actual.add(rel.as_posix())
 if actual-allowed!=set(expected):raise ValueError('Unexpected or missing files')
 return {'status':'complete','files':len(expected),'physicalTestStatus':'not-run','scope':'File inventory integrity only; historical absolute build metadata was not replayed.'}
if __name__=='__main__':
 try:
  root=Path(sys.argv[1]) if len(sys.argv)>1 else Path(__file__).resolve().parent.parent
  print(json.dumps(verify(root),ensure_ascii=False))
 except Exception as error:
  print(json.dumps({'status':'failed','error':str(error)},ensure_ascii=False));sys.exit(1)
'''


def _assembly_input(value, run, api):
    token = _one(value); data = api.load(token, run, PREFIX + 'assemble')
    if (data.get('status') != 'assembled' or data.get('qualified') is not False
            or data.get('assemblyNodeId') != token.get('nodeId')):
        raise ValueError('需要当前真正组装完成、尚未认证的HDK回执。')
    return token, data


def _recheck_sources(data, run, api):
    facts, parents, reviews = _parents(data['sourceTokens'], run, {'nodeId': data['assemblyNodeId']}, api)
    if reviews != data['humanReview']: raise ValueError('原组装审批已变化，必须重新组装。')
    return facts, parents, reviews


def _verify_engineering(data, facts, parents):
    package = _root(data['packagePath']); assembled = data['assembly']
    build = core._validate_build(assembled['build'])
    if _bins(assembled['build']) != _bins(parents['firmware']['build']): raise ValueError('交付固件与当前父构建不同。')
    native = core.verify_full_native(parents['native']['native']['reportPath'])
    if native.get('coreStatus') != 'complete' or native.get('errors'): raise ValueError('制造资料独立验收失败。')
    for item in native['artifacts']:
        if digest(_file(package / _relative(item['path']), package)) != item['sha256']: raise ValueError('交付制造文件SHA变化。')
    proc = core.validate_full_process(facts['request'] | {'workbookPath': str(package / _relative(assembled['processRelativePath'])),
                'profile': parents['process']['plan']}, parents['process'].get('unresolved', []))
    if proc.get('passed') is not True: raise ValueError('交付工艺要求独立验收失败。')
    manuals = core.datasheets.verify(package / '重要器件手册/资料来源索引.json', package)
    if manuals.get('status') != 'complete' or not manuals.get('checks') or not all(manuals['checks'].values()): raise ValueError('交付手册独立验收失败。')
    sop = core.sop_v2.verify(assembled['sop']['markdownPath'], package)
    if sop.get('status') != 'complete' or sop.get('errors'): raise ValueError('交付SOP独立验收失败。')
    preservation = _preserve_sop(parents['sop'], assembled['sop'], package)
    return {'native': native, 'process': proc, 'firmware': build, 'datasheets': manuals, 'sop': sop,
            'sopRelocation': preservation}


def _emit(api, operation, data, run, out, files, extra):
    data['sourceFiles'] = list({x['path']: x for x in data.get('sourceFiles', []) + _implementation()}.values())
    return core._emit(api, operation, data, run, out, files, extra)


def _validate_archive(path, entries, prefix):
    _relative(prefix)
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist(); names = [x.filename for x in infos]
        expected = {prefix + '/' + key: item for key, item in entries.items()}
        if len(names) != len(set(names)) or set(names) != set(expected): raise ValueError('ZIP成员重复、缺失或包含额外文件。')
        for info in infos:
            _relative(info.filename)
            mode = info.external_attr >> 16
            if info.is_dir() or not stat.S_ISREG(mode) or info.flag_bits & 1: raise ValueError('ZIP含非普通文件、软链或加密成员。')
            item = expected[info.filename]
            if info.file_size != item['bytes']: raise ValueError('ZIP成员大小不同。')
            value = hashlib.sha256()
            with archive.open(info) as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b''): value.update(block)
            if value.hexdigest() != item['sha256']: raise ValueError('ZIP成员SHA不同。')
    return {'members': len(entries), 'memberHashes': True, 'uniqueSafeRegularMembers': True}


def delivery(operation, value, context, api):
    if operation not in OPERATIONS: raise ValueError('未知HDK交付阶段。')
    run, _, out = api.bound(operation, value, context); out = Path(out)
    os.environ['HDK_NODE_ID'] = context['nodeId']
    implementation = _implementation()
    if operation == PREFIX + 'assemble':
        tokens = copy.deepcopy(value); facts, parents, reviews = _parents(tokens, run, context, api)
        product, version = facts['request']['productCode'], facts['request']['hardwareVersion']
        if any(not isinstance(x, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,95}', x) for x in (product, version)):
            raise ValueError('HDK产品或版本不能作为安全目录名。')
        package = out / (product + '_HDK_V' + version)
        if package.exists() or package.is_symlink(): raise ValueError('组装目录已存在，禁止覆盖。')
        assembled = _assemble_files(facts, parents, package); rows = relative_inventory(package)
        if any(Path(x['path']).parts[0] == KIT for x in rows): raise ValueError('原始产物占用校验套件保留目录。')
        manifest = out / '组装清单.json'
        _write(manifest, {'schemaVersion': 1, 'status': 'assembled', 'qualified': False, 'packageName': package.name,
            'sourceSha256': facts['sourceSha256'], 'files': rows, 'scope': SCOPE})
        current = _current(api, run); _, _, fresh = _parents(tokens, current, context, api)
        if fresh != reviews: raise ValueError('组装期间人工审批发生变化。')
        if implementation != _implementation(): raise ValueError('组装期间交付实现发生变化。')
        api.bound(operation, value, context)  # Current consumer attempt/input must still be running.
        data = core._common(facts) | {'status': 'assembled', 'qualified': False, 'releaseQualified': False,
            'assemblyNodeId': context['nodeId'], 'sourceTokens': tokens, 'humanReview': reviews,
            'packagePath': str(package), 'assemblyManifestPath': str(manifest), 'assemblyManifestSha256': digest(manifest),
            'assembly': assembled, 'proofFiles': core.inventory(package), 'physicalTestStatus': 'not-run', 'scope': SCOPE}
        return _emit(api, operation, data, run, out, [core.file_ref(manifest, 'assembly-inventory')],
            {'status': 'assembled', 'qualified': False, 'releaseQualified': False, 'packagePath': str(package),
             'fileCount': len(rows), 'physicalTestStatus': 'not-run', 'scope': SCOPE})
    if operation == PREFIX + 'verify-delivery':
        token, data = _assembly_input(value, run, api)
        facts, parents, reviews = _recheck_sources(data, _current(api, run), api)
        manifest = _read(data['assemblyManifestPath'])
        if digest(data['assemblyManifestPath']) != data['assemblyManifestSha256']: raise ValueError('组装清单已变化。')
        package = _root(data['packagePath']); rows = check_inventory(package, manifest['files'])
        engineering = _verify_engineering(data, facts, parents)
        closure = document_closure(package, data['assembly'], parents['sop'])
        kit = out / KIT; kit.mkdir()
        inventory = kit / KIT_FILES[0]
        _write(inventory, {'schemaVersion': 1, 'format': 'workbench-full-hdk-relative-inventory',
            'packageName': package.name, 'sourceSha256': facts['sourceSha256'], 'files': rows,
            'sourceDocumentationLimitations': closure['sourceDocumentationLimitations'], 'scope': SCOPE,
            'historicalBuildMetadata': {'absolutePathsRetainedAsEvidence': True, 'replayPerformed': False},
            'usage': 'python3 校验/verify_delivery.py [moved-HDK-directory]; without argument uses the extracted ZIP root.'})
        report_path = kit / KIT_FILES[2]
        quality = {'schemaVersion': 3, 'checks': {key: True for key in core.CRITERIA}, 'physicalTestStatus': 'not-run'}
        report = {'schemaVersion': 1, 'status': 'verified', 'qualified': True, 'releaseQualified': False,
            'packagePath': str(package), 'verificationKitPath': str(kit), 'scope': SCOPE,
            'engineering': engineering, 'humanReview': reviews, 'qualitySummary': quality,
            'documentClosure': closure, 'relativeInventorySha256': digest(inventory),
            'fileCount': len(rows), 'physicalTestStatus': 'not-run',
            'historicalBuildMetadata': {'absolutePathsRetainedAsEvidence': True, 'replayPerformed': False}}
        _write(report_path, report)
        script = kit / KIT_FILES[1]
        with script.open('x', encoding='utf-8') as stream:
            stream.write(_portable_script(digest(inventory), digest(report_path)))
        files = [dict(item, path=item['path']) for item in rows]
        comparison = core.learning_comparison(facts, parents, quality, files, report_path, package)
        # Recheck after the expensive reads, including live approval identities.
        check_inventory(package, rows); _recheck_sources(data, _current(api, run), api)
        if api.load(token, _current(api, run), PREFIX + 'assemble') != data or implementation != _implementation():
            raise ValueError('验收期间组装版本或实现发生变化。')
        api.bound(operation, value, context)
        kit_refs = [core.file_ref(kit / name, 'verification-kit') for name in KIT_FILES]
        result = core._common(facts) | report | {'assemblyToken': token, 'sourceTokens': data['sourceTokens'],
            'assemblyNodeId': data['assemblyNodeId'], 'reportPath': str(report_path),
            'relativeInventoryPath': str(inventory), 'verificationKitFiles': kit_refs,
            'proofFiles': core.inventory(package) + kit_refs, 'learningComparison': comparison}
        return _emit(api, operation, result, run, out, kit_refs,
            {'status': 'verified', 'qualified': True, 'releaseQualified': False, 'packagePath': str(package),
             'verificationKitPath': str(kit), 'fileCount': len(rows), 'localLinkCount': len(closure['links']),
             'sourceDocumentationLimitations': len(closure['sourceDocumentationLimitations']),
             'physicalTestStatus': 'not-run', 'learningComparison': comparison, 'scope': SCOPE})
    token = _one(value); verified = api.load(token, run, PREFIX + 'verify-delivery')
    if verified.get('status') != 'verified' or verified.get('qualified') is not True:
        raise ValueError('ZIP归档只接受当前真正验收通过的HDK。')
    assembly = api.load(verified['assemblyToken'], run, PREFIX + 'assemble')
    _recheck_sources(assembly, _current(api, run), api)
    if run.get('learningId'):
        api.bound(operation, value, context)
        return _emit(api, operation, core._common(verified) | {'status': 'skipped', 'qualified': False,
            'reason': 'Learning uses verified files/comparison and skips the large ZIP.', 'physicalTestStatus': 'not-run'},
            run, out, [], {'status': 'skipped', 'qualified': False, 'releaseQualified': False, 'physicalTestStatus': 'not-run'})
    package = _root(verified['packagePath']); inventory = _read(verified['relativeInventoryPath'])
    rows = check_inventory(package, inventory['files'])
    entries = {x['path']: {'path': str(package / x['path']), 'sha256': x['sha256'], 'bytes': x['bytes']} for x in rows}
    kit = _root(verified['verificationKitPath'])
    if {Path(x['path']).name for x in verified['verificationKitFiles']} != set(KIT_FILES): raise ValueError('校验套件不完整。')
    for item in verified['verificationKitFiles']:
        path = _file(item['path'], kit)
        if digest(path) != item['sha256']: raise ValueError('归档前校验套件SHA变化。')
        name = KIT + '/' + path.name
        if name in entries: raise ValueError('交付占用校验套件保留路径。')
        entries[name] = {'path': str(path), 'sha256': item['sha256'], 'bytes': path.stat().st_size}
    archive = out / (package.name + '.zip')
    with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_DEFLATED) as zipped:
        for name, item in entries.items():
            path = _file(item['path']); zipped.write(path, package.name + '/' + name)
            if digest(path) != item['sha256']: raise ValueError('归档期间文件已变化。')
    checked = _validate_archive(archive, entries, package.name)
    if archive.stat().st_size > 512 * 1024 * 1024: raise ValueError('公开ZIP超过512MiB预算。')
    check_inventory(package, rows); _recheck_sources(assembly, _current(api, run), api)
    if api.load(token, _current(api, run), PREFIX + 'verify-delivery') != verified or implementation != _implementation():
        raise ValueError('归档期间验收资格或实现发生变化。')
    api.bound(operation, value, context)
    report = out / '归档验收.json'
    _write(report, {'status': 'complete', 'archiveSha256': digest(archive), 'checks': checked,
        'sourceVerifiedReceipt': token, 'scope': SCOPE, 'physicalTestStatus': 'not-run', 'releaseQualified': False})
    return _emit(api, operation, core._common(verified) | {'status': 'complete', 'qualified': True,
        'releaseQualified': False, 'sourceVerifiedReceipt': token, 'archivePath': str(archive),
        'reportPath': str(report), 'checks': checked, 'physicalTestStatus': 'not-run', 'scope': SCOPE}, run, out,
        [core.file_ref(archive, 'full-hdk-delivery'), core.file_ref(report, 'archive-verification')],
        {'status': 'complete', 'qualified': True, 'releaseQualified': False, 'archivePath': str(archive),
         'physicalTestStatus': 'not-run', 'scope': SCOPE})


full = delivery
