"""Edit the user's actual S31 DrawIO source without rebuilding its layout.

Template cells, pages, geometry, decorations and vertex styles are retained.
Only current-source labels and functional edge bindings are adapted, with a
per-cell audit. Actual raster/vector export still uses the desktop DrawIO CLI.
"""
from pathlib import Path
import base64
from copy import deepcopy
import hashlib
import html
import json
import math
import os
import plistlib
import re
import subprocess
import tempfile
from urllib.parse import unquote
import xml.etree.ElementTree as ET
import zlib

from hdk import guide_drawio as legacy

RENDERER_VERSION = 2
EDGE_ROUTING_VERSION = 2
FORMAT = 'source-bound-drawio-template-diagram'
MAX_XML_BYTES = 8 * 1024 * 1024


def _language(value):
    # None is the exact historical, English-labelled template adapter. Keeping
    # that distinction lets old saved manifests verify without rewriting them.
    if value not in (None, 'zh', 'en'):
        raise ValueError('DrawIO 图语言必须明确为 zh 或 en。')
    return value


def _designators(value):
    if type(value) is not bool:
        raise ValueError('DrawIO 位号显示策略必须是明确布尔值。')
    return value


def _assert_no_visible_designators(root):
    for cell in root.iter('mxCell'):
        if cell.get('vertex') == '1' and re.search(r'\bJ\d+\b', _plain(cell.get('value')), re.I):
            raise ValueError('隐藏位号策略的 DrawIO 图仍含可见 Jx 标签。')


def _read_template(path):
    path = Path(path).resolve(strict=True)
    raw = path.read_bytes()
    if not raw or len(raw) > MAX_XML_BYTES or b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper():
        raise ValueError('DrawIO 模板为空、过大或含不允许的外部实体。')
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as error:
        raise ValueError('DrawIO 模板不是合法 XML。') from error
    if root.tag != 'mxfile' or not 1 <= len(root.findall('diagram')) <= 32:
        raise ValueError('DrawIO 模板必须是含真实页面的 mxfile XML。')
    pages = []
    for page in root.findall('diagram'):
        model = page.find('mxGraphModel')
        if model is None:
            try:
                decoder = zlib.decompressobj(-15)
                decoded = decoder.decompress(base64.b64decode((page.text or '').strip(), validate=True), MAX_XML_BYTES)
                if decoder.unconsumed_tail or not decoder.eof:
                    raise ValueError('compressed page too large')
                text = unquote(decoded.decode())
                if '<!DOCTYPE' in text.upper() or '<!ENTITY' in text.upper():
                    raise ValueError('entities are not allowed')
                model = ET.fromstring(text)
            except Exception as error:
                raise ValueError('DrawIO 压缩页面无法读取。') from error
            page.text = None; page.append(model)
        cells = list(model.iter('mxCell'))
        if (model.tag != 'mxGraphModel' or model.find('root') is None or not cells
                or any(not cell.get('id') for cell in cells)
                or len({cell.get('id') for cell in cells}) != len(cells)):
            raise ValueError('DrawIO 页面缺少合法图模型或唯一单元格。')
        pages.append({'id': page.get('id'), 'name': page.get('name'), 'cellCount': len(cells),
                      'vertexCount': sum(cell.get('vertex') == '1' for cell in cells),
                      'edgeCount': sum(cell.get('edge') == '1' for cell in cells)})
    return root, {'path': str(path), 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw), 'pages': pages}


def inspect_template(path):
    """Source preflight only; no content assumptions, CLI, model or exports."""
    return _read_template(path)[1]


def _plain(value):
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]*>', ' ', value or ''))).strip()


def _role(cell):
    text = _plain(cell.get('value')).lower()
    if re.search(r'esp32[-_]?s31', text): return 'module'
    return {'reset and boot button': 'controls', 'rgb-led': 'rgb', 'full speed usb': 'usb-0',
            'high speed usb': 'usb-1', '2x9 dvp header': 'top-0', 'dvp camera': 'top-1',
            '2x21 pin header': 'header', 'tf card': 'sd'}.get(text)


def _group_label(group, language=None, show_designators=True):
    kind, members = group['kind'], group['members']
    refs = ', '.join(str(item['ref']) for item in members)
    if kind == 'header':
        counts = [len(item['pins']) for item in members]
        count = f'{len(counts)}×{counts[0]}' if len(set(counts)) == 1 else '+'.join(map(str, counts))
        lines = [count + (' 针' if language == 'zh' else ' Pin'), '扩展排针' if language == 'zh' else 'Header']
    elif kind == 'controls':
        functions = [name for name, key in ([('复位', 'reset'), ('BOOT', 'boot')] if language == 'zh' else [('Reset', 'reset'), ('Boot', 'boot')]) if any(item['kind'] == key for item in members)]
        lines = [('/' if language == 'zh' else ' / ').join(functions), '按键' if language == 'zh' else 'Button']
    else:
        names = {'mipi-dsi': ['MIPI DSI', 'Display'], 'mipi-csi': ['MIPI CSI', 'Camera'],
                 'dvp': ['DVP', 'Camera / Header'], 'rgb': ['RGB LED'], 'sd': ['TF Card'],
                 'usb': ['USB Type-C']}
        if language == 'zh':
            names = {'mipi-dsi': ['MIPI DSI', '显示接口'], 'mipi-csi': ['MIPI CSI', '摄像头接口'],
                     'dvp': ['DVP', '摄像头 / 排针'], 'rgb': ['RGB LED'], 'sd': ['TF 卡座'],
                     'usb': ['USB Type-C']}
        if kind not in names: raise ValueError('当前接口没有已核验的模板标签映射：' + str(kind))
        lines = names[kind]
    if show_designators: lines = lines + [refs]
    return '<br>'.join(html.escape(line) for line in lines)


def _module_label(value, facts):
    board = facts.get('board', {}); targets = board.get('targets') or []
    primary = board.get('primaryTarget') or (targets[0] if targets else '')
    if primary not in targets or any(not re.fullmatch(r'esp32[a-z0-9]+', str(target), re.I) for target in targets):
        raise ValueError('当前事实缺少明确的主控与配套芯片来源。')
    name = lambda target: re.sub('^esp32', 'ESP32-', str(target), flags=re.I).upper()
    text = re.sub(r'ESP32[-_]?S31', html.escape(name(primary)), value, flags=re.I)
    companion = ' + '.join(name(target) for target in targets if target != primary)
    # The template clock/ISA claim is replaced rather than copied to another chip.
    text, changed = re.subn(r'320MHz(?:&nbsp;|\s)*RISC-V', html.escape(companion), text, flags=re.I)
    if changed != 1: raise ValueError('模板主控说明与已核验的源文本结构不一致。')
    return text


def _box(cell, cells):
    geometry = cell.find('mxGeometry'); fields = geometry.attrib if geometry is not None else {}
    x, y = float(fields.get('x', 0)), float(fields.get('y', 0)); parent = cell.get('parent'); seen = set()
    while parent in cells and parent not in seen:
        seen.add(parent); ancestor = cells[parent]; geo = ancestor.find('mxGeometry')
        if geo is not None: x += float(geo.get('x', 0)); y += float(geo.get('y', 0))
        parent = ancestor.get('parent')
    return x, y, x + float(fields.get('width', 0)), y + float(fields.get('height', 0))


def _endpoint(edge, name, cells, recognized):
    existing = edge.get(name)
    if existing:
        if existing not in recognized: raise ValueError('模板连线端点没有已核验的功能映射。')
        return existing
    point = edge.find(f"mxGeometry/mxPoint[@as='{name}Point']")
    if point is None: raise ValueError('模板连线缺少可核验端点。')
    x, y = float(point.get('x')), float(point.get('y')); ranked = []
    for identifier in recognized:
        left, top, right, bottom = _box(cells[identifier], cells)
        ranked.append((math.hypot(max(left - x, 0, x - right), max(top - y, 0, y - bottom)), identifier))
    ranked.sort()
    if not ranked or ranked[0][0] > 12 or len(ranked) > 1 and ranked[0][0] == ranked[1][0]:
        raise ValueError('模板自由连线不能唯一绑定实际功能块。')
    return ranked[0][1]


def _style(style, replacements):
    found, parts = set(), []
    for part in style.split(';'):
        if not part: continue
        key = part.split('=', 1)[0]
        parts.append(key + '=' + replacements[key] if key in replacements else part); found.add(key)
    parts.extend(key + '=' + value for key, value in replacements.items() if key not in found)
    return ';'.join(parts) + ';'


def _cell_record(cell):
    geometry = cell.find('mxGeometry')
    return {'value': _plain(cell.get('value')), 'styleSha256': hashlib.sha256(cell.get('style', '').encode()).hexdigest(),
            'source': cell.get('source'), 'target': cell.get('target'), 'parent': cell.get('parent'),
            'geometrySha256': hashlib.sha256(ET.tostring(geometry) if geometry is not None else b'').hexdigest()}


def _feedback(value):
    if not isinstance(value, str) or len(value) > 8000:
        raise ValueError('DrawIO 布局反馈必须是最多 8000 字的原文字串。')
    return value


def _number(value):
    if not math.isfinite(value): raise ValueError('DrawIO 连线坐标必须为有限数值。')
    return format(value, '.12g')


def _segment_hits_box(start, end, box):
    left, top, right, bottom = box
    if abs(start[0] - end[0]) < 1e-7:
        return left < start[0] < right and max(min(start[1], end[1]), top) < min(max(start[1], end[1]), bottom)
    if abs(start[1] - end[1]) < 1e-7:
        return top < start[1] < bottom and max(min(start[0], end[0]), left) < min(max(start[0], end[0]), right)
    raise ValueError('DrawIO 布局含未对齐的斜线。')


def _route_edge(edge, module, peripheral, cells, recognized):
    """Bind the existing endpoints to facing borders; never infer new edges.

    A shared projected coordinate gives a straight connection whenever possible.
    Otherwise two bends stay in the empty gap between the existing boxes. Old
    free endpoints/waypoints and out-of-border fractional anchors are discarded.
    """
    ml, mt, mr, mb = _box(cells[module], cells)
    pl, pt, pr, pb = _box(cells[peripheral], cells)
    if min(mr - ml, mb - mt, pr - pl, pb - pt) <= 0:
        raise ValueError('DrawIO 功能块缺少可用的真实模板尺寸。')
    cx, cy = (pl + pr) / 2, (pt + pb) / 2
    clamp = lambda value, low, high: max(low, min(value, high))
    if pr < ml:
        side = 'left'; module_point = (ml, clamp(cy, mt + 12, mb - 12)); peripheral_point = (pr, cy)
        middle = (pr + ml) / 2
        bends = [(middle, cy), (middle, module_point[1])] if cy != module_point[1] else []
    elif pl > mr:
        side = 'right'; module_point = (mr, clamp(cy, mt + 12, mb - 12)); peripheral_point = (pl, cy)
        middle = (pl + mr) / 2
        bends = [(middle, cy), (middle, module_point[1])] if cy != module_point[1] else []
    elif pb < mt:
        side = 'top'; module_point = (clamp(cx, ml + 12, mr - 12), mt); peripheral_point = (cx, pb)
        middle = (pb + mt) / 2
        bends = [(cx, middle), (module_point[0], middle)] if cx != module_point[0] else []
    elif pt > mb:
        side = 'bottom'; module_point = (clamp(cx, ml + 12, mr - 12), mb); peripheral_point = (cx, pt)
        middle = (pt + mb) / 2
        bends = [(cx, middle), (module_point[0], middle)] if cx != module_point[0] else []
    else:
        raise ValueError('DrawIO 原模板功能块重叠，不能安全修整连接。')
    points = [peripheral_point, *bends, module_point]
    for other in recognized:
        if other in (module, peripheral): continue
        for first, second in zip(points, points[1:]):
            if _segment_hits_box(first, second, _box(cells[other], cells)):
                raise ValueError('DrawIO 连线会穿过其它功能块，请调整模板布局后重试。')
    if edge.get('source') == module: points.reverse()
    def anchor(identifier, point):
        left, top, right, bottom = _box(cells[identifier], cells)
        return ((point[0] - left) / (right - left), (point[1] - top) / (bottom - top))
    source_anchor = anchor(edge.get('source'), points[0]); target_anchor = anchor(edge.get('target'), points[-1])
    replacements = {'edgeStyle': 'orthogonalEdgeStyle', 'noEdgeStyle': '1', 'orthogonalLoop': '0', 'jettySize': '0',
                    'rounded': '0', 'curved': '0', 'exitX': _number(source_anchor[0]), 'exitY': _number(source_anchor[1]),
                    'entryX': _number(target_anchor[0]), 'entryY': _number(target_anchor[1]),
                    'exitDx': '0', 'exitDy': '0', 'entryDx': '0', 'entryDy': '0',
                    'exitPerimeter': '0', 'entryPerimeter': '0', 'sourcePerimeterSpacing': '0', 'targetPerimeterSpacing': '0'}
    edge.set('style', _style(edge.get('style', ''), replacements))
    previous = edge.find('mxGeometry'); geometry = ET.Element('mxGeometry', {'relative': '1', 'as': 'geometry'})
    # A possible edge-label offset is independent of its routing and is retained.
    if previous is not None:
        offset = previous.find("mxPoint[@as='offset']")
        if offset is not None: geometry.append(deepcopy(offset))
        edge.remove(previous)
    if len(points) > 2:
        waypoints = ET.SubElement(geometry, 'Array', {'as': 'points'})
        for x, y in points[1:-1]: ET.SubElement(waypoints, 'mxPoint', {'x': _number(x), 'y': _number(y)})
    edge.append(geometry)
    return {'id': edge.get('id'), 'source': edge.get('source'), 'target': edge.get('target'), 'side': side,
            'sourceAnchor': list(source_anchor), 'targetAnchor': list(target_anchor),
            'points': [list(point) for point in points], 'segments': 'axis-aligned', 'bendCount': len(points) - 2}


def build_drawio_from_template(facts, template_path, *, review_feedback='', language=None, show_designators=True, _routing_version=EDGE_ROUTING_VERSION):
    language = _language(language)
    show_designators = _designators(show_designators)
    review_feedback = _feedback(review_feedback)
    if _routing_version not in (1, EDGE_ROUTING_VERSION) or _routing_version == 1 and review_feedback:
        raise ValueError('DrawIO 历史路由版本不能附加本次布局反馈。')
    root, template = _read_template(template_path)
    source = facts.get('source', {})
    if not source.get('path') or legacy._sha(source['path']) != source.get('sha256'):
        raise ValueError('当前 DrawIO 事实未绑定原始工程实际 SHA。')
    page = root.findall('diagram')[0]; model = page.find('mxGraphModel'); cell_root = model.find('root')
    cells = {cell.get('id'): cell for cell in model.iter('mxCell')}
    original = {identifier: _cell_record(cell) for identifier, cell in cells.items()}
    roles = {identifier: _role(cell) for identifier, cell in cells.items() if _role(cell)}
    role_ids = {role: identifier for identifier, role in roles.items()}
    expected_roles = {'module', 'controls', 'rgb', 'usb-0', 'usb-1', 'top-0', 'top-1', 'header', 'sd'}
    if set(role_ids) != expected_roles or len(roles) != len(expected_roles):
        raise ValueError('所选真实模板没有唯一完整的 S31 功能槽，请明确提供对应源文件。')
    groups = legacy.diagram_groups(facts); assignment = {}; used = set()
    for role in ['controls', 'rgb', 'header', 'sd']:
        selected = [index for index, group in enumerate(groups) if group['kind'] == role]
        if len(selected) > 1: raise ValueError('当前接口超过模板功能槽容量：' + role)
        if selected: assignment[role] = groups[selected[0]]; used.add(selected[0])
    for prefix, kinds in [('usb', ['usb']), ('top', ['mipi-dsi', 'mipi-csi', 'dvp'])]:
        selected = sorted([index for index, group in enumerate(groups) if group['kind'] in kinds], key=lambda i: (kinds.index(groups[i]['kind']), groups[i]['refs']))
        if len(selected) > 2: raise ValueError('当前接口超过模板功能槽容量：' + prefix)
        for slot, index in enumerate(selected): assignment[f'{prefix}-{slot}'] = groups[index]; used.add(index)
    if len(used) != len(groups): raise ValueError('当前事实含模板尚无明确映射的接口，不能照抄旧图或遗漏。')
    cell_evidence = {}; removed = set(); routes = []
    for role, identifier in role_ids.items():
        if role == 'module': cells[identifier].set('value', _module_label(cells[identifier].get('value', ''), facts)); continue
        group = assignment.get(role)
        if group is None: removed.add(identifier); continue
        cells[identifier].set('value', _group_label(group, language, show_designators)); cell_evidence[identifier] = group
    module = role_ids['module']
    for cell in list(model.iter('mxCell')):
        if cell.get('edge') != '1': continue
        first = _endpoint(cell, 'source', cells, roles); second = _endpoint(cell, 'target', cells, roles)
        if module not in (first, second) or first == second: raise ValueError('模板连线不是可核验的主控与外设功能关系。')
        peripheral = second if first == module else first
        if peripheral in removed: removed.add(cell.get('id')); continue
        group = cell_evidence[peripheral]; cell.set('source', first); cell.set('target', second)
        cell.set('style', _style(cell.get('style', ''), {'startArrow': 'none', 'endArrow': 'none', 'startFill': '0', 'endFill': '0', 'dashed': '0' if group['moduleNets'] else '1'}))
        if _routing_version == EDGE_ROUTING_VERSION:
            routes.append(_route_edge(cell, module, peripheral, cells, set(roles) - removed))
        cell_evidence[cell.get('id')] = group
    for identifier in removed:
        if cells[identifier] not in list(cell_root): raise ValueError('模板功能槽层级与当前适配范围不一致。')
        cell_root.remove(cells[identifier])
    audit_cells = []
    for identifier, before in original.items():
        after = None if identifier in removed else _cell_record(cells[identifier]); evidence = cell_evidence.get(identifier)
        audit_cells.append({'id': identifier, 'role': roles.get(identifier), 'action': 'removed-unmapped-template-slot' if after is None else 'preserved' if before == after else 'source-adapted', 'before': before, 'after': after,
                            'sourceRefs': evidence['refs'] if evidence else [facts['board'].get('moduleRef')] if identifier == module else [], 'sourceNets': evidence['moduleNets'] if evidence else []})
    if not show_designators: _assert_no_visible_designators(root)
    ET.indent(root, space='  '); xml = ET.tostring(root, encoding='unicode') + '\n'
    audit = {'schemaVersion': 2, 'template': template, 'sourceSha256': source['sha256'], 'sourceFactsSha256': legacy.source_digest(facts),
             'pageId': page.get('id'), 'pageName': page.get('name'), 'cells': audit_cells,
             'claimScope': 'Functional groups from current source only; arrows removed, dashed when explicit module-net evidence is absent. Clock, USB speed and fitted accessories are not inherited.',
             'groupCount': len(groups), 'showDesignators': show_designators}
    if _routing_version == EDGE_ROUTING_VERSION:
        audit.update(edgeRoutingVersion=EDGE_ROUTING_VERSION, edgeRouting=routes, reviewFeedback=review_feedback,
                     feedbackScope='edge-layout-only; no relationship changes or executable instructions')
    if language is not None:
        audit.update(language=language, labelPolicy='current-source-functional-names-and-component-references')
    if not show_designators:
        audit['labelPolicy'] = 'current-source-functional-names; component-references-retained-in-audit-only'
    return xml, audit


def _json_write(path, value):
    with Path(path).open('x', encoding='utf-8') as stream: json.dump(value, stream, ensure_ascii=False, indent=2); stream.write('\n')


def render_source_diagram(facts, path, *, template_path, review_feedback='', language=None, show_designators=True):
    """Use the installed DrawIO CLI; no hand-built SVG or raster substitute."""
    target = Path(path).resolve()
    if target.suffix not in ('.drawio', '.svg', '.png'): raise ValueError('DrawIO 目标需要 .drawio、.svg 或 .png。')
    language = _language(language)
    show_designators = _designators(show_designators)
    xml, audit = build_drawio_from_template(facts, template_path, review_feedback=review_feedback, language=language, show_designators=show_designators)
    executable = Path(os.environ.get('WORKBENCH_DRAWIO', str(legacy.DRAWIO))).resolve()
    if not executable.is_file(): raise ValueError('实际 DrawIO 桌面 CLI 不可用。')
    target.parent.mkdir(parents=True, exist_ok=True)
    paths = {kind: target.with_suffix('.' + kind) for kind in ['drawio', 'svg', 'png']}
    audit_path = target.with_suffix('.drawio-template-audit.json'); manifest_path = target.with_suffix('.drawio-manifest.json')
    if any(file.exists() for file in [*paths.values(), audit_path, manifest_path]): raise FileExistsError('本版本 DrawIO 产物已存在，不能覆盖。')
    with paths['drawio'].open('x', encoding='utf-8') as stream: stream.write(xml)
    _json_write(audit_path, audit); exports = []
    for kind in ['svg', 'png']:
        with tempfile.TemporaryDirectory(prefix='.drawio-template-export-', dir=target.parent) as profile:
            command = [str(executable), '--user-data-dir=' + profile, '--disable-update', '--export', '--format', kind,
                       '--output', str(paths[kind]), '--border', '0', '--scale', '3', '--embed-diagram']
            if kind == 'svg': command += ['--svg-theme', 'light', '--embed-svg-fonts', 'false']
            command.append(str(paths['drawio'])); reply = subprocess.run(command, capture_output=True, text=True, timeout=90, check=False)
            if reply.returncode or not paths[kind].is_file(): raise ValueError('DrawIO 模板实际导出失败：' + (reply.stderr or reply.stdout)[-1200:])
            exports.append({'format': kind, 'method': 'DrawIO desktop CLI --export', 'stdout': reply.stdout[-500:]})
    if inspect_template(template_path)['sha256'] != audit['template']['sha256']: raise ValueError('DrawIO 模板在导出期间发生变化。')
    info = executable.parent.parent / 'Info.plist'; version = 'unknown'
    if info.is_file():
        with info.open('rb') as stream: version = str(plistlib.load(stream).get('CFBundleShortVersionString', 'unknown'))
    manifest = {'format': FORMAT, 'rendererVersion': RENDERER_VERSION, 'edgeRoutingVersion': EDGE_ROUTING_VERSION, 'showDesignators': show_designators, 'template': audit['template'],
                'sourceSha256': facts['source']['sha256'], 'sourceFactsSha256': legacy.source_digest(facts),
                'tool': {'name': 'draw.io', 'path': str(executable), 'version': version}, 'exports': exports,
                'pngDimensions': legacy._png_dimensions(paths['png']), 'groupCount': audit['groupCount'],
                'audit': {'path': str(audit_path), 'sha256': legacy._sha(audit_path)},
                'artifacts': {kind: {'path': str(file), 'sha256': legacy._sha(file)} for kind, file in paths.items()}}
    if language is not None: manifest['language'] = language
    _json_write(manifest_path, manifest)
    verify_source_diagram(manifest_path, facts, template_path=template_path, review_feedback=review_feedback, language=language, show_designators=show_designators)
    return {'path': str(target), 'sha256': legacy._sha(target), 'method': 'DrawIO desktop CLI --export',
            'interfaceCount': len(legacy._interfaces(facts)), 'manifestPath': str(manifest_path), 'auditPath': str(audit_path),
            'showDesignators': show_designators,
            **({'language': language} if language is not None else {}),
            **{kind + 'Path': str(file) for kind, file in paths.items()}}


def render_bilingual_source_diagrams(facts, path, *, template_path, review_feedback='', show_designators=True):
    """Two independently audited DrawIO exports from the same current facts.

    ``block.png`` is a basename request; its siblings become ``block.zh.*`` and
    ``block.en.*``. Neither language is derived from a previously rendered PNG.
    """
    target = Path(path).resolve()
    show_designators = _designators(show_designators)
    if target.suffix not in ('.drawio', '.svg', '.png'):
        raise ValueError('DrawIO 目标需要 .drawio、.svg 或 .png。')
    targets = {language: target.with_name(target.stem + '.' + language + target.suffix) for language in ('zh', 'en')}
    for item in targets.values():
        if any(item.with_suffix(suffix).exists() for suffix in
               ('.drawio', '.svg', '.png', '.drawio-template-audit.json', '.drawio-manifest.json')):
            raise FileExistsError('本版本双语 DrawIO 产物已存在，不能覆盖。')
    return {language: render_source_diagram(facts, item, template_path=template_path,
            review_feedback=review_feedback, language=language, show_designators=show_designators) for language, item in targets.items()}


def verify_source_diagram(manifest_path, facts, *, template_path, review_feedback='', language=None, show_designators=True):
    path = Path(manifest_path).resolve(); manifest = json.loads(path.read_text())
    language = _language(language)
    show_designators = _designators(show_designators)
    recorded_designators = _designators(manifest.get('showDesignators', True))
    if recorded_designators != show_designators:
        raise ValueError('DrawIO 位号显示策略与指定指南策略不一致。')
    recorded_language = _language(manifest.get('language'))
    if language is not None and recorded_language != language:
        raise ValueError('DrawIO 图语言与指定指南语言不一致。')
    xml, audit = build_drawio_from_template(facts, template_path, review_feedback=review_feedback,
                                          language=recorded_language,
                                          show_designators=recorded_designators,
                                          _routing_version=manifest.get('edgeRoutingVersion', 1))
    # Old immutable manifests predate the explicit display-policy field. Their
    # only supported policy showed refs, and their saved audit must stay exact.
    if 'showDesignators' not in manifest: audit.pop('showDesignators')
    if (manifest.get('format') != FORMAT or manifest.get('rendererVersion') != RENDERER_VERSION
            or manifest.get('template') != audit['template'] or manifest.get('sourceSha256') != facts['source']['sha256']
            or manifest.get('sourceFactsSha256') != legacy.source_digest(facts)):
        raise ValueError('DrawIO 模板或当前工程事实来源不一致。')
    if manifest.get('tool', {}).get('name') != 'draw.io' or [item.get('format') for item in manifest.get('exports', [])] != ['svg', 'png']:
        raise ValueError('缺少实际 DrawIO 桌面导出证据。')
    artifacts = manifest.get('artifacts', {})
    if set(artifacts) != {'drawio', 'svg', 'png'}: raise ValueError('DrawIO 源图或实际导出产物缺失。')
    for kind, item in [*artifacts.items(), ('json', manifest.get('audit', {}))]:
        file = Path(item.get('path', '')).resolve()
        if file.parent != path.parent or file.suffix != '.' + kind or not file.is_file() or legacy._sha(file) != item.get('sha256'):
            raise ValueError('DrawIO 产物或模板单元格审计的路径/SHA 不一致。')
    if json.loads(Path(manifest['audit']['path']).read_text()) != audit: raise ValueError('DrawIO 模板逐单元格审计内容不一致。')
    if Path(artifacts['drawio']['path']).read_text() != xml: raise ValueError('DrawIO 当前可编辑图不符来源模板与硬件事实。')
    if legacy._png_dimensions(artifacts['png']['path']) != manifest.get('pngDimensions') or legacy._png_embedded_xml(artifacts['png']['path']) != xml:
        raise ValueError('DrawIO PNG 不符本次实际源图。')
    svg = ET.parse(artifacts['svg']['path']).getroot()
    if svg.tag.rsplit('}', 1)[-1] != 'svg' or not svg.get('content') or legacy._cells(svg.get('content')) != legacy._cells(xml):
        raise ValueError('DrawIO SVG 不符本次实际源图。')
    return {'passed': True, 'templateSha256': audit['template']['sha256'], 'sourceFactsSha256': legacy.source_digest(facts),
            'showDesignators': recorded_designators,
            **({'language': recorded_language} if recorded_language is not None else {}),
            'interfaceCount': len(legacy._interfaces(facts)), 'groupCount': audit['groupCount'], 'artifacts': artifacts,
            'auditSha256': legacy._sha(manifest['audit']['path']), 'manifestSha256': legacy._sha(path)}
