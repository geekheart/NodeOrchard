"""Portable, hash-bound packaging of an already verified bilingual guide.

No prose or images are generated here. The two guide copies change only three
attachment hrefs. User-facing Markdown links form a checked closure; complete
rebuild sources are separately copied from the frozen dependency inventories.
"""
from pathlib import Path, PurePosixPath
from html.parser import HTMLParser
import copy
import hashlib
import json
import os
import re
import shutil
import subprocess
from urllib.parse import unquote, urlsplit, quote

from hdk import guide_reference

OPERATION = 'hdk.guide.package'
SOURCE_OPERATION = 'hdk.guide.verify'
MAX_FILES = 30000
MAX_BYTES = 1024 ** 3
ROLES = ('test-sop', 'build-replay', 'flash-instructions')
IMAGE_NAMES = ('interface.png', 'interface_en.png', 'interface_back.png', 'interface_back_en.png', 'block.zh.png', 'block.en.png')
REQUIRED_CHECKS = {'bilingual-files', 'bilingual-pin-consistency', 'bilingual-source-links', 'annotation-exports',
    'drawio-block-diagram', 'drawio-document-languages', 'annotation-document-languages', 'source-unchanged'} | {
    key + '-' + language for language in ('zh', 'en') for key in ('section-coverage', 'narrative-coverage',
    'local-assets', 'image-coverage', 'product-identity', 'source-claims', 'getting-started-commands',
    'source-pin-tables', 'portable-markdown')}


def digest(path):
    result = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''): result.update(block)
    return result.hexdigest()


def _sha(value):
    return isinstance(value, str) and re.fullmatch(r'[0-9a-f]{64}', value) is not None


def _file(value, root=None):
    if not isinstance(value, (str, Path)) or not str(value): raise ValueError('打包来源路径无效。')
    path = Path(value)
    try:
        if not path.is_absolute() or path.resolve(strict=True) != path or path.is_symlink() or not path.is_file():
            raise ValueError('打包来源不是规范路径的真实文件。')
        if root is not None and not path.is_relative_to(root): raise ValueError('打包来源路径越界。')
    except OSError as error:
        raise ValueError('打包来源缺失或无法读取：' + path.name) from error
    return path


def _read(path):
    if Path(path).stat().st_size > 32 * 1024 * 1024: raise ValueError('打包JSON证据超过32MiB预算。')
    with Path(path).open(encoding='utf-8') as stream: return json.load(stream)


def _relative(value):
    if not isinstance(value, str) or not value or '\\' in value: raise ValueError('打包相对路径无效。')
    path = PurePosixPath(value)
    if path.is_absolute() or '..' in path.parts or str(path) != value or value == '.':
        raise ValueError('打包相对路径越界或不规范。')
    return Path(value)


def _bound_row(item, base):
    if not isinstance(item, dict) or not _sha(item.get('sha256')): raise ValueError('打包库存缺少实际SHA。')
    path = _file(item.get('path'), base)
    relative = _relative(item.get('relativePath'))
    if base / relative != path: raise ValueError('库存原路径与相对路径不一致。')
    size = item.get('bytes')
    if type(size) is not int or size < 0 or size != path.stat().st_size: raise ValueError('库存字节数与实际文件不一致。')
    return path, item['sha256'], size


class _HTMLLinks(HTMLParser):
    def __init__(self): super().__init__(); self.urls = []
    def handle_starttag(self, tag, attrs):
        for key, value in attrs:
            if key.lower() in ('src', 'href') and value: self.urls.append(value)


def markdown_urls(text):
    """Use the same bundled CommonMark parser as the real guide preview.

    Reference-style links are resolved by marked. Fenced/code-span strings never
    become links. HTML anchors/images are included without executing HTML.
    """
    runtime = Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies/node'
    module = runtime / 'node_modules/marked/lib/marked.esm.js'
    script = """import fs from 'node:fs';import{pathToFileURL}from'node:url';
const{marked}=await import(pathToFileURL(process.argv[1]).href);
const p=JSON.parse(fs.readFileSync(0,'utf8')),urls=[],html=[];
marked.walkTokens(marked.lexer(p.text,{gfm:true}),t=>{if(t.type==='link'||t.type==='image')urls.push(t.href);if(t.type==='html')html.push(t.text);});
process.stdout.write(JSON.stringify({urls,html}));"""
    result = subprocess.run([str(runtime / 'bin/node'), '--input-type=module', '-e', script, str(module)],
        input=json.dumps({'text': text}), capture_output=True, text=True, timeout=30, check=False)
    if result.returncode or len(result.stdout.encode()) > 4 * 1024 * 1024: raise ValueError('Markdown引用无法完整解析。')
    parsed = json.loads(result.stdout); html_links = _HTMLLinks()
    for fragment in parsed['html']: html_links.feed(fragment)
    return list(dict.fromkeys(parsed['urls'] + html_links.urls))


def _local(url, parent, root):
    if not isinstance(url, str) or any(c in url for c in ('\x00', '\r', '\n', '\\')): raise ValueError('文档引用路径无效。')
    parts = urlsplit(url)
    if parts.scheme:
        if parts.scheme.lower() in ('https', 'http', 'mailto', 'data'): return None
        raise ValueError('文档包含不允许的引用协议。')
    if parts.netloc: return None  # Network URL; never downloaded by packaging.
    if not parts.path: return None
    decoded = unquote(parts.path)
    if Path(decoded).is_absolute() or '\\' in decoded: raise ValueError('文档包含绝对本地引用。')
    path = Path(os.path.normpath(str(parent / decoded)))
    if not path.is_relative_to(root): raise ValueError('文档本地引用超出交付目录。')
    return path


def rewrite_attachment_links(text, replacements):
    """Change only actual inline href tokens used by the frozen guide renderer."""
    actual = set(markdown_urls(text))
    if not set(replacements).issubset(actual): raise ValueError('指南缺少实际可点击的三个附件href。')
    counts = {old: 0 for old in replacements}
    pattern = re.compile(r'(\]\(\s*<?)([^\s)>]+)(>?)')
    # Preserve code byte-for-byte, including illustrative Markdown in fences.
    masked, fence = [], None
    for line in text.splitlines(keepends=True):
        marker = re.match(r'^ {0,3}(`{3,}|~{3,})', line)
        if fence is not None:
            masked.append(''.join('\n' if c == '\n' else ' ' for c in line))
            if marker and marker[1][0] == fence[0] and len(marker[1]) >= len(fence) and not line[marker.end():].strip(): fence = None
        elif marker:
            fence = marker[1]; masked.append(''.join('\n' if c == '\n' else ' ' for c in line))
        else: masked.append(line)
    visible = ''.join(masked)
    visible = re.sub(r'(`+)(?!`)([\s\S]*?)\1(?!`)', lambda m: ''.join('\n' if c == '\n' else ' ' for c in m[0]), visible)
    chunks, cursor, changed_spans, delivered_size = [], 0, [], 0
    for match in pattern.finditer(visible):
        value = match[2]
        if value not in replacements: continue
        prefix = text[cursor:match.start(2)]
        counts[value] += 1; chunks += [prefix, replacements[value]]
        start = delivered_size + len(prefix)
        changed_spans.append((start, start + len(replacements[value]), value))
        delivered_size = start + len(replacements[value]); cursor = match.end(2)
    chunks.append(text[cursor:]); updated = ''.join(chunks)
    if any(count != 1 for count in counts.values()): raise ValueError('两份指南必须各有唯一的三个附件href。')
    restored = updated
    for start, end, old in reversed(changed_spans): restored = restored[:start] + old + restored[end:]
    if restored != text: raise ValueError('打包改变了href以外的作者内容。')
    return updated, counts


class CopyPlan:
    def __init__(self, root): self.root = root; self.entries = {}; self.sources = {}; self.bytes = 0
    def add(self, source, target, sha256, size=None, origin='source'):
        source = _file(source); relative = _relative(target)
        if not _sha(sha256): raise ValueError('打包文件缺少绑定SHA。')
        actual_size = source.stat().st_size
        if size is not None and (type(size) is not int or size != actual_size): raise ValueError('打包文件字节数已变化。')
        if relative.as_posix() not in self.entries and (len(self.entries) + 1 > MAX_FILES or self.bytes + actual_size > MAX_BYTES):
            raise ValueError('打包超过30000文件或1GiB预算。')
        previous = self.sources.get(str(source))
        if previous and previous['sha256'] != sha256: raise ValueError('同一路径提供了互相冲突的来源SHA。')
        if not previous:
            if digest(source) != sha256: raise ValueError('打包来源SHA已变化：' + source.name)
            self.sources[str(source)] = {'path': str(source), 'sha256': sha256}
        existing = self.entries.get(relative.as_posix())
        if existing:
            if existing['source'] != str(source) or existing['sha256'] != sha256: raise ValueError('打包目标路径冲突。')
            return
        if len(self.entries) + 1 > MAX_FILES or self.bytes + actual_size > MAX_BYTES: raise ValueError('打包超过30000文件或1GiB预算。')
        self.entries[relative.as_posix()] = {'source': str(source), 'path': relative.as_posix(), 'sha256': sha256,
            'bytes': actual_size, 'origin': origin, 'content': None}
        self.bytes += actual_size
    def rewrite(self, relative, text):
        entry = self.entries[relative]; self.bytes += len(text.encode()) - entry['bytes']; entry['content'] = text
        entry['bytes'] = len(text.encode()); entry['deliveredSha256'] = hashlib.sha256(text.encode()).hexdigest()
        if self.bytes > MAX_BYTES: raise ValueError('打包超过1GiB预算。')
    def text(self, relative):
        entry = self.entries[relative]
        return entry['content'] if entry['content'] is not None else Path(entry['source']).read_text(encoding='utf-8-sig')
    def copy(self):
        if self.root.exists() or self.root.is_symlink(): raise ValueError('交付目录已存在，禁止覆盖。')
        self.root.mkdir()
        inventory = []
        for relative, entry in self.entries.items():
            source = _file(entry['source']); target = self.root / relative
            if digest(source) != entry['sha256']: raise ValueError('复制前来源SHA发生变化。')
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.parent.resolve(strict=True) != target.parent: raise ValueError('交付目录存在软链。')
            with target.open('xb') as output:
                if entry['content'] is not None: output.write(entry['content'].encode())
                else:
                    descriptor = os.open(source, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
                    with os.fdopen(descriptor, 'rb') as stream: shutil.copyfileobj(stream, output, 1024 * 1024)
            expected = entry.get('deliveredSha256', entry['sha256'])
            if digest(source) != entry['sha256'] or digest(target) != expected: raise ValueError('复制前后来源或交付SHA不一致。')
            inventory.append({key: value for key, value in entry.items() if key != 'content'} | {'deliveredSha256': expected})
        return inventory


def _source_selection(value, run, api):
    if isinstance(value, dict) and value.get('kind') in ('hdk-node-receipt', 'hdk-node-receipt-ref'):
        data = api.load(value, run, SOURCE_OPERATION)
        source = {'runId': value['runId'], 'nodeId': value['nodeId'], 'receiptPath': value['receiptPath'], 'receiptSha256': value['receiptSha256']}
    elif isinstance(value, dict) and set(value) == {'receiptPath'} and isinstance(value['receiptPath'], str):
        data = api.foreign_receipt(value['receiptPath'], SOURCE_OPERATION)
        source = data['importedReceipt']
    else: raise ValueError('请选择已完成指南的真实验收回执。')
    checks = data.get('qualitySummary', {}).get('checks', {})
    if (data.get('status') != 'complete' or data.get('qualified') is not True or not isinstance(checks, dict)
            or not REQUIRED_CHECKS.issubset(checks) or any(value is not True for value in checks.values())):
        raise ValueError('来源指南尚未通过全部原始验收。')
    if not _sha(data.get('sourceSha256')): raise ValueError('来源指南缺少当前工程SHA。')
    return data, source


def _materials(facts, plan):
    by_role = {}
    for role in (*ROLES, 'firmware-manifest'):
        matches = [item for item in facts.get('sourceFiles', []) if item.get('role') == role]
        if len(matches) != 1: raise ValueError('打包需要唯一源资料：' + role)
        item = matches[0]; path = _file(item['path'])
        if not _sha(item.get('sha256')) or digest(path) != item['sha256']: raise ValueError('源资料SHA变化。')
        by_role[role] = item
    sop = Path(by_role['test-sop']['path']); root = sop.parent
    master_path = _file(by_role['firmware-manifest']['path'], root); master = _read(master_path)
    if (master.get('status') != 'compiled' or master.get('boardSourceSha256') != facts['source']['sha256']
            or Path(master.get('artifactRoot', '')) != master_path.parent): raise ValueError('测试固件清单未绑定当前工程与目录。')
    package_root = Path(master.get('packagePath', ''))
    if not package_root.is_absolute() or not root.is_relative_to(package_root): raise ValueError('SOP原目录不属于固件交付根。')
    allowed = {}
    def allow(path, value, size=None):
        path = _file(path, root)
        if not _sha(value): raise ValueError('资料闭包缺少SHA。')
        previous = allowed.get(str(path))
        if previous and previous['sha256'] != value: raise ValueError('资料闭包SHA冲突。')
        allowed[str(path)] = {'sha256': value, 'bytes': size}
    for item in by_role.values(): allow(item['path'], item['sha256'], item.get('bytes'))
    rows = master.get('artifacts')
    if not isinstance(rows, list) or not rows: raise ValueError('主固件清单没有真实库存。')
    dependencies = []
    for item in rows:
        path, value, size = _bound_row(item, master_path.parent); allow(path, value, size)
        if item.get('role') == 'dependencySourceIndex': dependencies.append(path)
    if not dependencies: raise ValueError('可重建测试资料缺少依赖源码索引。')
    dependency_count = 0
    for index in dict.fromkeys(dependencies):
        binding = allowed[str(index)]
        if digest(index) != binding['sha256']: raise ValueError('依赖源码索引SHA变化。')
        content = _read(index); files = content.get('files')
        if not isinstance(files, list): raise ValueError('依赖源码索引格式无效。')
        lock = _file(index.parent / 'dependencies.lock', root)
        if not _sha(content.get('lockSha256')) or digest(lock) != content['lockSha256']: raise ValueError('依赖lock与索引不一致。')
        for item in files:
            path, value, size = _bound_row(item, index.parent); allow(path, value, size); dependency_count += 1
    # The old guide froze SOP + master, but not this report. Freeze it now and
    # cross-bind its SOP artifact and master reference to those prior anchors.
    report_path = _file(root / 'SOP验收.json', root); report = _read(report_path)
    if report.get('status') != 'complete' or report.get('errors') or not report.get('checks') or any(v is not True for v in report['checks'].values()):
        raise ValueError('源SOP报告没有通过检查。')
    claims = {}
    for item in report.get('references', []) + report.get('artifacts', []):
        path = package_root / _relative(item['path']); path = _file(path, root)
        if path in claims and claims[path] != item['sha256']: raise ValueError('SOP证据哈希冲突。')
        claims[path] = item['sha256']
    if claims.get(sop) != by_role['test-sop']['sha256'] or claims.get(master_path) != by_role['firmware-manifest']['sha256']:
        raise ValueError('新增SOP报告不能与已冻结SOP及master相互绑定。')
    for path, value in claims.items(): allow(path, value)
    allow(report_path, digest(report_path), report_path.stat().st_size)
    canonical = Path('sources/test-materials')
    # Every manifest/index entry is needed for rebuild even without an MD link.
    required = {str(_file(item['path'], master_path.parent)) for item in rows}
    for index in dict.fromkeys(dependencies): required.update(item['path'] for item in _read(index)['files'])
    required.update(item['path'] for item in by_role.values()); required.add(str(report_path))
    for source in sorted(required):
        item = allowed[source]; plan.add(source, (canonical / Path(source).relative_to(root)).as_posix(), item['sha256'], item['bytes'], 'test-material-inventory')
    return root, allowed, by_role, {'masterPath': str(master_path), 'masterSha256': by_role['firmware-manifest']['sha256'],
        'sourceDeliveryRoot': str(package_root),
        'newlyFrozenSopReport': {'path': str(report_path), 'sha256': digest(report_path), 'scope': 'new packaging evidence; not an earlier guide approval'},
        'masterEntries': len(rows), 'dependencyIndexes': len(set(dependencies)), 'dependencyEntries': dependency_count}


def _closure(plan, entries, source_root, allowed):
    pending, visited, links, limitations = list(entries), set(), [], []
    while pending:
        relative = pending.pop(0)
        if relative in visited: continue
        visited.add(relative)
        for url in markdown_urls(plan.text(relative)):
            target = _local(url, (plan.root / relative).parent, plan.root)
            if target is None: continue
            name = target.relative_to(plan.root).as_posix()
            if name not in plan.entries:
                materials = plan.root / 'sources/test-materials'
                if not target.is_relative_to(materials): raise ValueError('文档引用缺少绑定产物：' + name)
                source = source_root / target.relative_to(materials)
                item = allowed.get(str(source))
                if item is None:
                    entry = plan.entries[relative]
                    vendor = re.search(r'(?:^|/)source/components/wt_bsp/(?:README\.md|boards/WT9932S31-TINY/README\.md)$', entry['source'])
                    original_target = _local(url, Path(entry['source']).parent, source_root)
                    if vendor and original_target is not None and not original_target.exists() and not original_target.is_symlink():
                        limitations.append({'document': relative, 'sourceDocument': entry['source'], 'sourceDocumentSha256': entry['sha256'],
                            'sourceUrl': url, 'originalTarget': str(original_target), 'originalTargetMissing': True, 'packageTarget': name,
                            'scope': 'pre-existing frozen vendor source README link; not an operational guide entrypoint'})
                        continue
                    raise ValueError('文档引用没有可信SHA清单：' + name)
                plan.add(source, name, item['sha256'], item['bytes'], 'user-facing-link-closure')
            links.append({'document': relative, 'url': url, 'target': name})
            if target.suffix.lower() == '.md': pending.append(name)
    return {'entrypoints': list(entries), 'documents': sorted(visited), 'links': links, 'sourceDocumentationLimitations': limitations,
        'scope': 'Operational documents have zero missing links. Reachable frozen vendor source README limitations are listed separately; unlinked vendor README files are source inventory, not document entrypoints.'}


def _previews(destination, names):
    script = Path(__file__).resolve().parents[1] / 'scripts/render-user-guide-preview.mjs'
    before = digest(script)
    node = Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node'
    result = []
    for language, name in zip(('zh', 'en'), names):
        target = destination / ('preview.' + language + '.html')
        if target.exists() or target.is_symlink(): raise ValueError('预览输出已存在。')
        reply = subprocess.run([str(node), str(script), str(destination / name), str(target)], capture_output=True, text=True, timeout=30, check=False)
        if reply.returncode or not target.is_file() or digest(script) != before: raise ValueError('重新生成指南预览失败或脚本发生变化。')
        links = _HTMLLinks(); links.feed(target.read_text())
        for url in links.urls:
            local = _local(url, destination, destination)
            if local is not None: _file(local, destination)
        result.append({'source': str(script), 'sourceSha256': before, 'path': target.relative_to(destination).as_posix(),
            'sha256': digest(target), 'deliveredSha256': digest(target), 'bytes': target.stat().st_size,
            'origin': 'derived-preview-from-packaged-markdown'})
    return result, {'path': str(script), 'sha256': before}


def package(value, context, api):
    run, _, out = api.bound(OPERATION, value, context); out = Path(out)
    if run.get('learningId'): raise ValueError('打包只能用于普通执行，不继承学习候选资格。')
    implementation_path = _file(Path(__file__).resolve())
    implementation = {'path': str(implementation_path), 'sha256': digest(implementation_path)}
    os.environ['HDK_NODE_ID'] = context['nodeId']
    verified, source_receipt = _source_selection(value, run, api)
    # Keep an immutable selection while large dependency trees are copied. The
    # same receipt file may remain on disk after its producer is superseded.
    verified, source_receipt = copy.deepcopy(verified), copy.deepcopy(source_receipt)
    original = Path(verified.get('outputPath', ''))
    if not original.is_absolute() or original.resolve(strict=True) != original or not original.is_dir(): raise ValueError('来源指南目录无效。')
    proof = {item['path']: item for item in verified.get('proofFiles', []) if isinstance(item, dict) and isinstance(item.get('path'), str)}
    facts_path = _file(original / 'sources/board-facts.json', original)
    if str(facts_path) not in proof or digest(facts_path) != proof[str(facts_path)]['sha256']: raise ValueError('指南事实不属于已验收的产物清单。')
    facts = _read(facts_path); product = facts.get('productCode'); version = str(facts.get('hardwareVersion', '')).removeprefix('V')
    if (not isinstance(product, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,95}', product)
            or verified.get('productCode') != product or facts.get('source', {}).get('sha256') != verified['sourceSha256']
            or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,31}', version)):
        raise ValueError('打包产品、版本或源工程身份不一致。')
    destination = out / (product + '_使用指南_V' + version); plan = CopyPlan(destination)
    replaced = {'sources/' + role + '.md' for role in ROLES} | {'preview.zh.html', 'preview.en.html'}
    for path, item in proof.items():
        candidate = Path(path)
        if candidate.is_relative_to(original):
            relative = candidate.relative_to(original).as_posix()
            if relative not in replaced: plan.add(candidate, relative, item['sha256'], origin='verified-guide-bundle')
    entrypoints = [product + '_User_Guide.md', product + '_User_Guide_en.md']
    for name in entrypoints:
        if name not in plan.entries: raise ValueError('原验收清单缺少中英文Markdown。')
    if any(name in plan.entries for name in ('README.md', 'package-manifest.json')): raise ValueError('原包占用了打包元数据保留路径。')
    source_root, allowed, roles, evidence = _materials(facts, plan)
    replacements = {'sources/' + role + '.md': quote((Path('sources/test-materials') / Path(roles[role]['path']).relative_to(source_root)).as_posix(), safe='/._-') for role in ROLES}
    edits = []
    for name in entrypoints:
        before = plan.text(name); after, counts = rewrite_attachment_links(before, replacements); plan.rewrite(name, after)
        edits.append({'path': name, 'originalSha256': plan.entries[name]['sha256'], 'deliveredSha256': plan.entries[name]['deliveredSha256'],
            'onlyAttachmentHrefsChanged': True, 'replacements': [{'from': old, 'to': new, 'count': counts[old]} for old, new in replacements.items()]})
    package_facts = copy.deepcopy(facts); metadata_changes = []
    for role in ROLES:
        documents = [item for item in package_facts.get('primaryDocuments', []) if item.get('role') == role]
        if (len(documents) != 1 or documents[0].get('path') != roles[role]['path']
                or documents[0].get('bundlePath') != 'sources/' + role + '.md'):
            raise ValueError('指南附件机器元数据未绑定唯一原始来源。')
        old = documents[0]['bundlePath']; documents[0]['bundlePath'] = unquote(replacements[old])
        metadata_changes.append({'role': role, 'from': old, 'to': documents[0]['bundlePath']})
    fact_relative = 'sources/board-facts.json'
    plan.rewrite(fact_relative, json.dumps(package_facts, ensure_ascii=False, indent=2))
    facts_edit = {'path': fact_relative, 'originalSha256': plan.entries[fact_relative]['sha256'],
        'deliveredSha256': plan.entries[fact_relative]['deliveredSha256'], 'onlyThreeBundlePathsChanged': True, 'fields': metadata_changes}
    closure = _closure(plan, entrypoints, source_root, allowed)
    inventory = plan.copy()
    for link in closure['links']: _file(destination / link['target'], destination)
    previews, preview_source = _previews(destination, entrypoints); inventory.extend(previews)
    evaluation = guide_reference.evaluate_guide_bundle(destination, facts_path=destination / 'sources/board-facts.json', product_code=product)
    if evaluation.get('passed') is not True: raise ValueError('新包未通过原指南检查：' + json.dumps(evaluation.get('issues', []), ensure_ascii=False))
    image_evidence = []
    approved = {item['sha256'] for review in verified.get('humanReview', {}).values() if isinstance(review, dict) for item in review.get('artifactHashes', [])}
    # Historical combined review has a different shape; both variants bind the
    # same immutable six image bytes and remain verifiable.
    approved.update(item['sha256'] for item in verified.get('humanReview', {}).get('artifactHashes', []))
    for name in IMAGE_NAMES:
        relative = 'img/' + name; entry = plan.entries.get(relative)
        if not entry or entry['sha256'] not in approved or digest(destination / relative) != entry['sha256']:
            raise ValueError('新包没有保留本次人工批准的六图原始SHA。')
        image_evidence.append({'path': relative, 'sha256': entry['sha256']})
    current_checks = {item['id']: item['passed'] for item in evaluation['checks']}
    inherited_checks = {name: verified['qualitySummary']['checks'][name] for name in REQUIRED_CHECKS - set(current_checks)}
    current_checks.update(inherited_checks)
    for item in plan.sources.values():
        if digest(_file(item['path'])) != item['sha256']: raise ValueError('打包期间原始来源发生变化。')
    manifest = destination / 'package-manifest.json'
    report_path = out / '可携交付验收.json'
    notice = destination / 'README.md'
    source_run = re.search(r'/执行/([0-9a-f-]{36})/', evidence['sourceDeliveryRoot'])
    source_label = '原HDK运行' + source_run[1] if source_run else evidence['sourceDeliveryRoot']
    notice_text = ('# 使用指南可携交付包\n\n'
        '中英文正文与六张已审核图片沿用本次已完成指南。仅三个技术附件链接调整到原始相对目录；图片与作者内容未重新生成。\n\n'
        '测试资料沿用本次指南明确指定并以SHA冻结的来源：' + source_label + '。其他完整HDK工作流的新工艺/SOP仍需各自独立人工审核，未在本包静默替换或继承审批。'
        '固件编译记录与physicalTestStatus=not-run均保留；本打包步骤不执行模型、编译、烧录或实板测试，也不更正原附件的操作内容。\n\n'
        '本板操作文档的可点击本地引用已闭包检查。少数已冻结第三方源码README原有缺失链接单独记录在package-manifest.json的localLinkClosure.sourceDocumentationLimitations，未伪称所有第三方文档无断链。\n')
    with notice.open('x', encoding='utf-8') as stream: stream.write(notice_text)
    inventory.append({'source': 'packaging provenance notice', 'path': 'README.md', 'sha256': digest(notice),
        'deliveredSha256': digest(notice), 'bytes': notice.stat().st_size, 'origin': 'packaging-scope-notice'})
    api.write(manifest, {'schemaVersion': 1, 'sourceGuideReceipt': source_receipt, 'sourceSha256': verified['sourceSha256'],
        'files': inventory, 'authorContent': edits, 'factsMetadataRelocation': facts_edit, 'replacedFlatAttachments': sorted(replaced),
        'testMaterials': evidence, 'localLinkClosure': closure})
    report = {'schemaVersion': 1, 'status': 'complete', 'qualified': True, 'productCode': product,
        'sourceSha256': verified['sourceSha256'], 'outputPath': str(destination), 'sourceGuideReceipt': source_receipt,
        'originalQualitySummary': verified['qualitySummary'], 'qualitySummary': {'schemaVersion': 1, 'checks': current_checks},
        'inheritedSourceImageChecks': {'checks': inherited_checks, 'basis': 'Original qualified source receipt, only three href edits, exact approved image copies; no image regeneration.'},
        'packagingChecks': {'allSourceAndCopyHashes': True, 'boundedInventoriesOnly': True, 'recursiveUserFacingLinks': True,
            'zeroNewBrokenLinks': True, 'onlyThreeAttachmentHrefsChanged': True, 'approvedSixImagesUnchanged': True,
            'freshHtmlPreviews': True},
        'sourceInventory': {'files': len(inventory), 'bytes': sum(item['bytes'] for item in inventory)},
        'documentClosure': {'documents': len(closure['documents']), 'links': len(closure['links']), 'scope': closure['scope'],
            'sourceDocumentationLimitations': closure['sourceDocumentationLimitations']},
        'imageEvidence': image_evidence, 'authorContent': edits, 'factsMetadataRelocation': facts_edit, 'testMaterials': evidence,
        'manifestPath': str(manifest), 'manifestSha256': digest(manifest), 'physicalTestStatus': verified.get('physicalTestStatus', 'not-run'),
        'scope': 'Packaging integrity only; original authors, image approvals, source firmware and hardware validation status are preserved. No model/build/flash is invoked.'}
    api.write(report_path, report)
    metadata = [manifest, report_path]
    if len(inventory) + len(metadata) > MAX_FILES or sum(item['bytes'] for item in inventory) + sum(path.stat().st_size for path in metadata) > MAX_BYTES:
        raise ValueError('交付清单及报告超过30000文件或1GiB预算。')
    source_files = {}
    for item in verified.get('sourceFiles', []) + list(plan.sources.values()) + [preview_source, implementation]:
        previous = source_files.get(item['path'])
        if previous and previous['sha256'] != item['sha256']: raise ValueError('来源清单存在同路径不同SHA。')
        source_files[item['path']] = previous or item
    source_files = list(source_files.values())
    target_proofs = [{'path': str(destination / item['path']), 'sha256': item['deliveredSha256']} for item in inventory]
    files = [{'path': str(destination / name), 'kind': 'guide-' + language} for language, name in zip(('zh', 'en'), entrypoints)]
    files += [{'path': str(manifest), 'kind': 'package-manifest'}, {'path': str(report_path), 'kind': 'package-verification'}]
    files += [{'path': str(destination / item['path']), 'kind': 'approved-image'} for item in image_evidence]
    data = report | {'sourceFiles': source_files, 'proofFiles': target_proofs, 'reportPath': str(report_path),
        'zhPath': str(destination / entrypoints[0]), 'enPath': str(destination / entrypoints[1])}
    current_verified, current_source_receipt = _source_selection(value, run, api)
    if current_source_receipt != source_receipt or current_verified != verified:
        raise ValueError('打包期间来源指南版本或验收资格发生变化。')
    if digest(implementation_path) != implementation['sha256']:
        raise ValueError('打包期间实现代码发生变化。')
    return api.receipt(OPERATION, data, run, out, api.assets(files), extra={'status': 'complete', 'qualified': True,
        'packagePath': str(destination), 'reportPath': str(report_path), 'sourceGuideReceipt': source_receipt,
        'fileCount': len(inventory), 'localLinkCount': len(closure['links']), 'physicalTestStatus': report['physicalTestStatus']})
