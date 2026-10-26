"""Select pinned reference documents by current part/target, then copy and audit.

This is a fixed tool capability, separate from the SOP Skill. A source index
distinguishes chip, module, board and component documents and records gaps.
"""
from pathlib import Path
import hashlib
import json
import os
import re
import shutil
import tempfile
import urllib.request
from urllib.parse import quote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / 'hdk/resources/catalog.json'
CACHE = ROOT / '.local/hdk-resource-cache'
MAX_BYTES = 30 * 1024 * 1024
LOCAL_RESOURCE_FIELDS = {'sourcePath', 'downloadEvidencePath'}


def local_catalog_path():
    workspace = Path(os.environ.get('WORKBENCH_WORKSPACE_ROOT', ROOT.parent / 'workflow')).expanduser()
    return Path(os.environ.get('WORKBENCH_HDK_RESOURCE_OVERLAY',
        workspace / 'config/hdk-resources.local.json')).expanduser()


def load_catalog(catalog_path=CATALOG, *, overlay_path=None):
    """Keep official identities/hashes public and machine-specific file locations private.

    The implicit overlay applies only to the bundled catalog. Explicit/custom
    catalogs remain isolated unless their caller explicitly supplies an overlay.
    Local entries may supply file locations, never change a pinned hash, remote
    URL, electrical identity, resource matching rule or availability claim.
    """
    catalog_path = Path(catalog_path)
    catalog = json.loads(catalog_path.read_text(encoding='utf-8'))
    if overlay_path is None:
        if catalog_path.resolve() != CATALOG.resolve(): return catalog
        overlay_path = local_catalog_path()
    overlay_path = Path(overlay_path)
    if not overlay_path.exists(): return catalog
    overlay = json.loads(overlay_path.read_text(encoding='utf-8'))
    if (not isinstance(overlay, dict) or set(overlay) != {'schemaVersion', 'resources'}
            or overlay['schemaVersion'] != 1 or not isinstance(overlay['resources'], dict)):
        raise ValueError('本机资料覆盖必须为 schemaVersion=1 和 resources 对象。')
    entries = {entry['id']: entry for entry in catalog['resources']}
    for resource_id, fields in overlay['resources'].items():
        if resource_id not in entries:
            raise ValueError('本机资料覆盖引用了公开目录中不存在的资源。')
        if not isinstance(fields, dict) or not fields or set(fields) - LOCAL_RESOURCE_FIELDS:
            raise ValueError('本机资料覆盖只能指定 sourcePath / downloadEvidencePath。')
        for key, value in fields.items():
            if not isinstance(value, str) or not value or not Path(value).expanduser().is_absolute():
                raise ValueError('本机资料位置必须是绝对路径。')
            entries[resource_id][key] = str(Path(value).expanduser())
    return catalog


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _part(value):
    return str(value or '').strip().upper()


def _identities(facts, product):
    board = facts.get('board', {})
    components = board.get('components', [])
    if isinstance(components, dict): components = list(components.values())
    parts, suppliers = set(), set()
    for component in components:
        attrs = component.get('attributes', {})
        for key in ('part', 'libraryTitle', 'title', 'manufacturerPart'):
            if component.get(key): parts.add(_part(component[key]))
        if attrs.get('Manufacturer Part'): parts.add(_part(attrs['Manufacturer Part']))
        supplier = component.get('supplierPart') or attrs.get('Supplier Part')
        if supplier: suppliers.add(_part(supplier))
    module = _part(board.get('modulePart'))
    if module: parts.add(module)
    return {'parts': parts, 'supplierParts': suppliers,
            'moduleParts': {module} if module else set(),
            'targets': set(board.get('targets', [])),
            'products': {_part(product)} if product else set()}


def _matching(entry, identities):
    result = []
    for key, values in entry.get('match', {}).items():
        if key not in identities: raise ValueError('未知资料匹配字段：' + key)
        matches = identities[key].intersection(_part(x) if key != 'targets' else x for x in values)
        result.extend({'field': key, 'value': value} for value in sorted(matches))
    return result


def _valid_pdf(path, entry):
    path = Path(path)
    if path.is_symlink() or not path.is_file(): return False
    size = path.stat().st_size
    if not (32 < size <= MAX_BYTES): return False
    with path.open('rb') as f:
        if not f.read(8).startswith(b'%PDF-'): return False
    return digest(path) == entry.get('sha256')


def _get(entry, cache, allow_download):
    name = entry.get('fileName', '')
    if Path(name).name != name or not name.endswith('.pdf') or not re.fullmatch(r'[0-9a-f]{64}', str(entry.get('sha256', ''))):
        raise ValueError('资料尚无可校验的本地PDF版本：' + name)
    cached = cache / name
    if _valid_pdf(cached, entry): return cached
    original = entry.get('sourcePath')
    if original and _valid_pdf(Path(original), entry):
        cache.mkdir(parents=True, exist_ok=True)
        if cached.exists() and cached.is_symlink(): raise ValueError('缓存不得为符号链接。')
        shutil.copyfile(original, cached)
        return cached
    url = entry.get('url')
    parsed = urlsplit(url or '')
    if not allow_download or parsed.scheme != 'https' or not parsed.netloc:
        raise ValueError('资料缓存缺失且没有可下载的已核验版本：' + name)
    # URL and expected hash come from a locally maintained catalog, not model text.
    request = urllib.request.Request(url, headers={'User-Agent': 'HDK-reference-cache/1.0'})
    with urllib.request.urlopen(request, timeout=40) as response:
        if urlsplit(response.geturl()).scheme != 'https': raise ValueError('资料下载重定向到非HTTPS。')
        data = response.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES or not data.startswith(b'%PDF-') or hashlib.sha256(data).hexdigest() != entry['sha256']:
        raise ValueError('资料下载不是已核验PDF，可能为HTML或版本已经变化：' + name)
    cache.mkdir(parents=True, exist_ok=True)
    if cached.is_symlink(): raise ValueError('缓存不得为符号链接。')
    with tempfile.NamedTemporaryFile(dir=cache, suffix='.part', delete=False) as stream:
        temporary = Path(stream.name); stream.write(data)
    try: temporary.replace(cached)
    finally: temporary.unlink(missing_ok=True)
    return cached


def collect(board_facts, package_path, *, product_code=None, catalog_path=CATALOG,
            cache_path=CACHE, allow_download=True, overlay_path=None):
    """Copy selected immutable PDFs to package/重要器件手册 and write provenance.

    Returns status/documents/pending/paths/checks. It does not declare coverage
    for unlisted parts; missing module documents are explicitly reported.
    """
    root = Path(package_path).resolve()
    if not root.is_dir(): raise ValueError('本次交付目录必须已存在。')
    source_sha = board_facts.get('source', {}).get('sha256')
    if not re.fullmatch(r'[0-9a-f]{64}', str(source_sha or '')): raise ValueError('资料选择必须绑定当前工程哈希。')
    catalog = load_catalog(catalog_path, overlay_path=overlay_path)
    identities = _identities(board_facts, product_code)
    selected = [(entry, _matching(entry, identities)) for entry in catalog['resources']]
    selected = [(entry, match) for entry, match in selected if match]
    destination = root / '重要器件手册'
    if destination.is_symlink(): raise ValueError('重要器件手册目录不得为符号链接。')
    destination.mkdir(exist_ok=True)
    index_path, readme_path = destination / '资料来源索引.json', destination / '资料说明.md'
    if index_path.exists() or readme_path.exists() or index_path.is_symlink() or readme_path.is_symlink():
        raise ValueError('本次资料索引已存在；不得覆盖或重复组包。')
    documents, pending = [], []
    for entry, matched_by in selected:
        try: cached = _get(entry, Path(cache_path), allow_download)
        except (ValueError, OSError) as error:
            pending.append({'id': entry['id'], 'kind': entry['kind'], 'title': entry['title'],
                'reason': str(error), 'url': entry.get('url'), 'matchedBy': matched_by})
            continue
        output = destination / entry['fileName']
        if output.exists() or output.is_symlink(): raise ValueError('资料目标已存在：' + output.name)
        shutil.copyfile(cached, output)
        if not _valid_pdf(output, entry): raise ValueError('复制后的PDF验证失败：' + output.name)
        documents.append({k: entry.get(k) for k in ('id', 'kind', 'title', 'scope', 'notes',
            'authority', 'url', 'sourcePath', 'verifiedDate')} | {
            'path': output.relative_to(root).as_posix(), 'sha256': digest(output),
            'bytes': output.stat().st_size, 'matchedBy': matched_by})
    module = board_facts.get('board', {}).get('modulePart')
    if module and not any(d['kind'] == 'module-datasheet' for d in documents):
        if not any(p['kind'] == 'module-datasheet' for p in pending):
            pending.append({'id': 'missing-module', 'kind': 'module-datasheet', 'title': module,
                'reason': '尚未收集此精确模组规格书。芯片datasheet不能代替模组引脚和电源要求。'})
    index = {'schemaVersion': 1, 'sourceSha256': source_sha,
        'modulePart': module, 'productCode': product_code,
        'documents': documents, 'pending': pending,
        'referenceUrls': catalog.get('referenceUrls', []) if 'esp32p4' in identities['targets'] else [],
        'coverageNote': '按本次器件/供应商SKU/芯片target精确选择已核验资源；没有声称所有BOM器件均有手册。'}
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding='utf-8')
    lines = ['# 重要器件资料说明', '',
        f'当前源工程 SHA-256：`{source_sha}`。', '',
        '芯片、模组、开发板指南和器件图纸分别标注；开发板指南仅供参考，以当前源工程网表/原理图为准。',
        '使用案例中已提供的厂商文件时，先核对本次料号或供应商SKU，保留来源哈希，不复制不匹配的其它板资料。', '',
        '| 文件 | 类型与适用范围 | 匹配依据 |', '| --- | --- | --- |']
    for d in documents:
        local = quote(Path(d['path']).name, safe='._-')
        matches = ', '.join(x['field'] + '=' + x['value'] for x in d['matchedBy'])
        lines.append(f'| [{d["title"]}]({local}) | {d["kind"]}；{d["scope"]} | {matches} |')
    notes = [d for d in documents if d.get('notes')]
    if notes:
        lines += ['', '适用范围说明：', '']
        for d in notes: lines.append(f'- {d["title"]}：{d["notes"]}')
    if pending:
        lines += ['', '待补资料：', '']
        for p in pending: lines.append('- ' + p['title'] + '：' + p['reason'])
    if index['referenceUrls']:
        lines += ['', '原厂参考链接：', '']
        for r in index['referenceUrls']: lines.append(f'- [{r["title"]}]({r["url"]})')
    lines += ['', '[逐份文件哈希与来源索引](资料来源索引.json)。', '']
    readme_path.write_text('\n'.join(lines), encoding='utf-8')
    checked = verify(index_path, root)
    return {'status': 'partial' if pending else 'complete', 'sourceSha256': source_sha,
        'documents': documents, 'pending': pending, 'checks': checked['checks'],
        'indexPath': str(index_path), 'readmePath': str(readme_path), 'errors': checked['errors']}


def verify(index_path, package_path):
    """Reopen every copied file and compare its manifest hash and PDF header."""
    root = Path(package_path).resolve(); index_path = Path(index_path)
    if index_path.is_symlink() or not index_path.resolve().is_relative_to(root): raise ValueError('资料索引不属于本次交付。')
    index = json.loads(index_path.read_text(encoding='utf-8'))
    errors = []
    for entry in index['documents']:
        relative = Path(entry['path']); path = root / relative
        if relative.is_absolute() or not path.resolve().is_relative_to(root) or not _valid_pdf(path, entry):
            errors.append('资料不存在、被修改或路径不安全：' + str(relative))
    kinds = {d['kind'] for d in index['documents']}
    checks = {'filesExistAndHashMatch': not errors,
        'chipAndModuleSeparated': all(d['kind'] in ('chip-datasheet', 'module-datasheet', 'board-guide', 'component-datasheet', 'component-drawing', 'family-drawing') for d in index['documents']),
        'moduleDocumentPresent': not index.get('modulePart') or 'module-datasheet' in kinds}
    return {'status': 'failed' if errors else ('partial' if index.get('pending') else 'complete'),
            'checks': checks, 'errors': errors, 'pending': index.get('pending', [])}
