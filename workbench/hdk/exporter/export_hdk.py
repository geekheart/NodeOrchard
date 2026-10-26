#!/usr/bin/env python3
"""Read-only native HDK exports in an exclusively owned LCEDA headless copy.

No layout, routes, copper, library, project name or manufacturing defaults are
changed. The original source and the example package are never written.
"""
import argparse
import base64
import binascii
import datetime as dt
import hashlib
import io
import json
import math
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import uuid
import xml.etree.ElementTree as ET
import zipfile

CLI = '/Applications/嘉立创EDA(专业版).app/Contents/MacOS/LCEDA-Pro'
SCRIPT = Path(__file__).with_name('native_export.js')
BOM_HEADERS = ['No.', 'Quantity', 'Comment', 'Designator', 'Footprint', 'Value', 'Manufacturer Part', 'Manufacturer', 'Supplier Part', 'Supplier', 'Name', 'Device', 'Symbol', 'Description', 'Features']
PNP_HEADERS = ['Designator', 'Device', 'Footprint', 'Mid X', 'Mid Y', 'Ref X', 'Ref Y', 'Pad X', 'Pad Y', 'Pins', 'Layer', 'Rotation', 'SMD', 'Comment', 'Name']
DIRECTORIES = ['原理图PDF', '板框及重要位置', '生产资料/01_电子BOM', '生产资料/02_GerberFile', '生产资料/03_钢网文件', '生产资料/04_坐标文件', '生产资料/05_丝印位图', '生产资料/06_工艺要求', '生产资料/07_测试说明', '生产资料/07_测试说明/images', '生产资料/07_测试说明/测试固件', '重要器件手册', '项目工程']
CORE = ['schematicPdf', 'bom', 'gerber', 'pickPlace', 'silkscreenPdf', 'outlineDxf', 'project']

class Blocked(Exception):
    pass

def digest(data):
    return hashlib.sha256(data).hexdigest()

def safe_member(name):
    p = PurePosixPath(name)
    if p.is_absolute() or '..' in p.parts or '\\' in name or '\x00' in name:
        raise Blocked('ZIP 包含不安全路径')
    return p

def is_os_metadata_path(path):
    """Exact macOS metadata names, including descendants of metadata folders.

    Other hidden files are ordinary delivery data. This classifies paths only;
    it never deletes or rewrites source/output files or archive members.
    """
    return any(part in {'.DS_Store', '__MACOSX'} or part.startswith('._') for part in PurePosixPath(str(path)).parts)

def excluded_metadata(output, artifacts=()):
    entries = {p.relative_to(output).as_posix() for p in output.rglob('*') if is_os_metadata_path(p.relative_to(output))}
    entries.update(a['path'] for a in artifacts if isinstance(a.get('path'), str) and is_os_metadata_path(a['path']))
    return sorted(entries)

def audit_zip(data):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise Blocked('ZIP 包含重复路径')
        if sum(i.file_size for i in archive.infolist()) > 300_000_000:
            raise Blocked('ZIP 解压大小超出限额')
        for n in names: safe_member(n)
        bad = archive.testzip()
        if bad: raise Blocked('ZIP CRC 校验失败: ' + bad)
        return [{'path': i.filename, 'bytes': i.file_size, 'crc32': f'{i.CRC:08x}', 'sha256': digest(archive.read(i)) if not i.is_dir() else None} for i in archive.infolist()]

def source_info(path):
    data = path.read_bytes()
    members = audit_zip(data)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = [n for n in archive.namelist() if n.endswith('.epru')]
        if len(entries) != 1 or 'project2.json' not in archive.namelist():
            raise Blocked('只接受单工程的原生 epro2 输入')
        project = json.loads(archive.read('project2.json'))
        docs = {}
        for line in archive.read(entries[0]).decode('utf-8-sig').splitlines():
            if '||' not in line: continue
            head, body = line.split('||', 1)
            if json.loads(head).get('type') == 'DOCHEAD':
                obj = json.loads(body[:-1] if body.endswith('|') else body)
                if obj.get('docType') in ('PCB', 'SCH_PAGE'):
                    docs[(obj['docType'], obj['uuid'])] = obj
        pcb = [d for (t, _), d in docs.items() if t == 'PCB']
        pages = [d for (t, _), d in docs.items() if t == 'SCH_PAGE']
        if len(pcb) != 1 or not pages: raise Blocked('第一版需要单 PCB 且至少一张原理图图页')
        return {'path': str(path), 'bytes': len(data), 'sha256': digest(data), 'projectTitle': project.get('title'), 'pcb': pcb[0], 'pages': pages, 'archive': members}

def expected_paths(product, version, date):
    compact = date.replace('-', '')
    token = version.removeprefix('V').replace('.', 'V')
    return {
        'project': f'项目工程/{product}_{date}.epro2',
        'schematicPdf': f'原理图PDF/{product}_{date}.pdf',
        'bom': f'生产资料/01_电子BOM/{product}_{token}_{date}.xlsx',
        'gerber': f'生产资料/02_GerberFile/{product}-{token}-{compact}-Gerber.zip',
        'topPaste': '生产资料/03_钢网文件/Gerber_TopPasteMaskLayer.GTP',
        'bottomPaste': '生产资料/03_钢网文件/Gerber_BottomPasteMaskLayer.GBP',
        'pickPlace': f'生产资料/04_坐标文件/{product}_{token}_{compact}.xlsx',
        'silkscreenPdf': f'生产资料/05_丝印位图/{product}-{token}_{compact}.pdf',
        'outlineDxf': f'板框及重要位置/{product}_DXF_{compact}.dxf',
        'processXlsx': f'生产资料/06_工艺要求/{product}-{token}-{compact}.xlsx',
    }

def validate_request(request):
    if not isinstance(request, dict): raise Blocked('request 必须为对象')
    product, version, date = (request.get(k) for k in ('productCode', 'hardwareVersion', 'releaseDate'))
    if not isinstance(product, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,79}', product): raise Blocked('productCode 格式无效')
    if not isinstance(version, str) or not re.fullmatch(r'V?\d{1,3}\.\d{1,3}', version): raise Blocked('hardwareVersion 需要如 V1.0')
    version = 'V' + version.removeprefix('V')
    try:
        if dt.date.fromisoformat(date).isoformat() != date: raise ValueError()
    except (ValueError, TypeError): raise Blocked('releaseDate 必须为 YYYY-MM-DD')
    source, parent = (Path(request.get(k, '')).expanduser().resolve() for k in ('sourcePath', 'outputParent'))
    if not source.is_file() or source.suffix.lower() != '.epro2': raise Blocked('sourcePath 必须是存在的 epro2')
    if not parent.is_dir(): raise Blocked('outputParent 必须是已存在目录')
    plan = request.get('plan')
    name = f'{product}_HDK_{version}'
    if not isinstance(plan, dict) or plan.get('packageName') != name or plan.get('paths') != expected_paths(product, version, date): raise Blocked('Skill plan 的目录或命名不符合已验证案例规则')
    checks = {'stencilFromCurrentGerber': True, 'checkDocumentReferences': True, 'excludeOsMetadata': True, 'exportFromInputOnly': True}
    if plan.get('checks') != checks: raise Blocked('Skill plan 未声明必需的来源与完整性检查')
    if plan.get('supplementalDirectories') != ['重要器件手册', '生产资料/07_测试说明']: raise Blocked('补充资料目录规则不符合案例')
    output = parent / name
    if output.exists(): raise Blocked('输出目录已存在；为避免覆盖案例或旧成果，请改用新的 outputParent')
    return source, parent, output, plan

def xlsx_rows(data):
    audit_zip(data)
    ns = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        shared = []
        if 'xl/sharedStrings.xml' in z.namelist():
            shared = [''.join(i.itertext()) for i in ET.fromstring(z.read('xl/sharedStrings.xml')).findall('s:si', ns)]
        sheets = sorted(n for n in z.namelist() if re.fullmatch(r'xl/worksheets/sheet\d+\.xml', n))
        if not sheets: raise Blocked('XLSX 没有工作表')
        rows = []
        for row in ET.fromstring(z.read(sheets[0])).findall('.//s:sheetData/s:row', ns):
            cells = {}
            for c in row.findall('s:c', ns):
                ref = re.match(r'[A-Z]+', c.get('r', '')).group()
                v = c.find('s:v', ns)
                value = '' if v is None else (v.text or '')
                if c.get('t') == 's': value = shared[int(value)]
                if c.get('t') == 'inlineStr': value = ''.join(c.find('s:is', ns).itertext())
                cells[ref] = value
            rows.append(cells)
        return rows

def validate_file(kind, data):
    if not data: raise Blocked(f'{kind} 原生文件为空')
    check = {}
    if kind in ('gerber', 'project', 'bom', 'pickPlace'):
        check['archive'] = audit_zip(data)
    if kind in ('schematicPdf', 'silkscreenPdf'):
        if not data.startswith(b'%PDF-') or b'%%EOF' not in data[-4096:]: raise Blocked(f'{kind} 不是完整 PDF')
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted or not reader.pages: raise Blocked(f'{kind} 没有可读取的PDF图页')
        check['pageCount'] = len(reader.pages)
        if kind == 'silkscreenPdf':
            titles = [item.get('/Title') for item in reader.outline if not isinstance(item, list)]
            if len(reader.pages) != 2 or titles != ['顶面自动位号图', '底面自动位号图']: raise Blocked('位号PDF必须是有顶/底角色书签的两页')
        check['visualReview'] = 'required'
    if kind in ('bom', 'pickPlace'):
        rows = xlsx_rows(data)
        expected = BOM_HEADERS if kind == 'bom' else PNP_HEADERS
        first = rows[0] if rows else {}
        headers = [first.get(chr(65 + i), '') for i in range(15)]
        if headers != expected or len(first) != 15: raise Blocked(f'{kind} 必须保留案例的完整 15 列，原生实际列为 {headers}')
        if len(rows) < 2: raise Blocked(f'{kind} 没有元件数据')
        filled = [r for r in rows[1:] if any(v for v in r.values())]
        check.update({'headers': headers, 'dataRows': len(filled)})
        if kind == 'bom':
            all_refs = []
            for row in filled:
                refs = [r.strip() for r in row.get('D', '').split(',') if r.strip()]
                try: quantity = int(row.get('B', ''))
                except ValueError: raise Blocked('BOM 数量不是整数')
                if not refs or len(refs) != quantity or len(refs) != len(set(refs)): raise Blocked('BOM 每组数量必须与无重复位号数相同')
                all_refs.extend(refs)
            if len(all_refs) != len(set(all_refs)): raise Blocked('BOM 位号跨组重复')
            check['designators'] = all_refs
        if kind == 'pickPlace':
            refs = [r.get('A', '') for r in rows[1:] if r.get('A')]
            if len(refs) != len(set(refs)): raise Blocked('坐标文件位号重复')
            check['designators'] = refs
            check['nonSmdRows'] = sum(r.get('M', '').lower() in ('no', 'false', '否') for r in rows[1:])
    if kind == 'outlineDxf':
        geometry = dxf_geometry(data)
        geometry.pop('_vertices')
        check.update(geometry)
    if kind == 'project':
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            if not any(n.endswith('.epru') for n in z.namelist()): raise Blocked('工程导出缺少原生 epru')
    return check

def dxf_entities(data):
    """Read only the DXF model entities; tables/blocks are not geometry proof."""
    lines = data.decode('utf-8-sig', errors='replace').splitlines()
    if len(lines) % 2: raise Blocked('原生 DXF 组码/值不成对')
    try: pairs = [(int(lines[i].strip()), lines[i + 1].strip()) for i in range(0, len(lines), 2)]
    except ValueError: raise Blocked('原生 DXF 组码无效')
    if not pairs or pairs[-1] != (0, 'EOF'): raise Blocked('原生 DXF 格式不完整')
    sections = [i for i, p in enumerate(pairs) if p == (0, 'SECTION') and i + 1 < len(pairs) and pairs[i + 1] == (2, 'ENTITIES')]
    if len(sections) != 1: raise Blocked('原生 DXF 没有唯一 ENTITIES 段')
    start = sections[0] + 2
    end = next((i for i in range(start, len(pairs)) if pairs[i] == (0, 'ENDSEC')), None)
    if end is None: raise Blocked('原生 DXF 实体段不完整')
    entities = []
    for code, value in pairs[start:end]:
        if code == 0: entities.append({'type': value, 'groups': []})
        elif not entities: raise Blocked('原生 DXF 实体头缺失')
        else: entities[-1]['groups'].append((code, value))
    if not entities: raise Blocked('原生 DXF 没有板框几何')
    return entities

def dxf_geometry(data):
    """Inspect the outline layer independently of native part/reference layers."""
    all_entities = dxf_entities(data)
    layer_counts = {}
    for entity in all_entities:
        layer = next((v for c, v in entity['groups'] if c == 8), '')
        layer_counts[layer] = layer_counts.get(layer, 0) + 1
    entities = [e for e in all_entities if re.sub('[^a-z]', '', next((v for c, v in e['groups'] if c == 8), '').lower()) == 'boardoutlinelayer']
    if not entities: raise Blocked('原生 DXF 没有板框层几何')
    vertices, closed, arcs = [], 0, 0
    for entity in entities:
        # This native exporter represents both the segmented and rounded-R
        # source outlines as lightweight polylines. Unknown encodings need a
        # real adapter/inspection instead of being accepted as nonempty text.
        if entity['type'] != 'LWPOLYLINE': raise Blocked('原生 DXF 板框实体类型尚未验证: ' + entity['type'])
        groups = entity['groups']
        try:
            xs, ys = ([float(v) for c, v in groups if c == code] for code in (10, 20))
            bulges = [float(v) for c, v in groups if c == 42]
            count = int(next(v for c, v in groups if c == 90))
            flags = int(next((v for c, v in groups if c == 70), '0'))
        except (ValueError, StopIteration): raise Blocked('原生 DXF 板框顶点字段无效')
        if count < 2 or len(xs) != count or len(ys) != count or not all(math.isfinite(v) for v in xs + ys + bulges): raise Blocked('原生 DXF 板框没有足够的有限坐标')
        points = list(zip(xs, ys))
        if len(set(points)) < 2: raise Blocked('原生 DXF 板框退化为单点')
        vertices.extend(points); closed += bool(flags & 1); arcs += sum(abs(v) > 1e-12 for v in bulges)
    bounds = [min(x for x, y in vertices), min(y for x, y in vertices), max(x for x, y in vertices), max(y for x, y in vertices)]
    if bounds[2] - bounds[0] <= 0 or bounds[3] - bounds[1] <= 0: raise Blocked('原生 DXF 板框没有二维尺寸')
    return {'entityCount': len(entities), 'entityTypes': {'LWPOLYLINE': len(entities)}, 'vertexCount': len(vertices), 'closedPolylineCount': closed, 'arcSegmentCount': arcs, 'vertexBoundsMm': bounds, 'totalEntityCount': len(all_entities), 'layerEntityCounts': layer_counts, '_vertices': vertices}

def pcb_canvas_origin(source):
    """Read the bound PCB's data-to-canvas translation without moving it."""
    origins = []
    for line in source.splitlines():
        if '||' not in line: continue
        a, b = line.split('||', 1); head = json.loads(a)
        if head.get('type') == 'CANVAS': origins.append(json.loads(b[:-1] if b.endswith('|') else b))
    if len(origins) > 1: raise Blocked('PCB 源存在多个画布原点，不能选择任意坐标系')
    # New PCB defaults to the data origin. Minimal legacy source fixtures can
    # omit CANVAS; real exports additionally bind the public origin API below.
    value = origins[0] if origins else {'originX': 0, 'originY': 0}
    if not all(isinstance(value.get(k), (int, float)) and not isinstance(value[k], bool) and math.isfinite(value[k]) for k in ('originX', 'originY')): raise Blocked('PCB 画布原点不是有限坐标')
    return {'x': value['originX'], 'y': value['originY']}

def check_dxf_source(data, source):
    """Tie native DXF geometry to this bound PCB, not just the file extension."""
    geometry = dxf_geometry(data)
    paths = []
    for line in source.splitlines():
        if '||' not in line: continue
        a, b = line.split('||', 1); head = json.loads(a); body = json.loads(b[:-1] if b.endswith('|') else b)
        if head.get('type') == 'POLY' and isinstance(body, dict) and body.get('layerId') == 11: paths.append(body.get('path'))
    if not paths or len(paths) != geometry['entityCount']: raise Blocked('DXF 板框实体数与本次 PCB 源板框不一致')
    # Installed native DXF uses the exact legacy mil conversion 1/39.37.
    # The 0.002 mm tolerance also admits the conventional 0.0254 conversion.
    scale, tolerance = 1 / 39.37, 0.002
    origin = pcb_canvas_origin(source)
    if len(paths) == 1 and isinstance(paths[0], list) and paths[0][0] == 'R':
        p = paths[0]
        if len(p) != 7 or p[5] != 0 or p[3] <= 0 or p[4] <= 0: raise Blocked('DXF 来源矩形板框参数尚未验证')
        expected = [(p[1] - origin['x']) * scale, (p[2] - p[4] - origin['y']) * scale,
                    (p[1] + p[3] - origin['x']) * scale, (p[2] - origin['y']) * scale]
        if geometry['closedPolylineCount'] != 1 or any(abs(a - b) > tolerance for a, b in zip(expected, geometry['vertexBoundsMm'])): raise Blocked('DXF 矩形板框尺寸与当前 PCB 源不一致')
        method = 'source-rounded-rectangle-bounds'
    else:
        expected, arcs = [], 0
        for p in paths:
            if not isinstance(p, list) or len(p) < 5 or not all(isinstance(v, (int, float)) for v in p[:2]): raise Blocked('DXF 来源板框路径类型尚未验证')
            points = [((p[0] - origin['x']) * scale, (p[1] - origin['y']) * scale)]
            i = 2
            while i < len(p):
                token = p[i]; size = 3 if token == 'L' else 4 if token == 'ARC' else 0
                if not size or i + size > len(p) or not all(isinstance(v, (int, float)) for v in p[i + 1:i + size]): raise Blocked('DXF 来源板框路径命令尚未验证')
                points.append(((p[i + size - 2] - origin['x']) * scale, (p[i + size - 1] - origin['y']) * scale))
                arcs += token == 'ARC'; i += size
            expected.extend(points)
        actual = list(geometry['_vertices'])
        if len(actual) != len(expected) or arcs != geometry['arcSegmentCount']: raise Blocked('DXF 板框顶点/圆弧数量与当前 PCB 源不一致')
        for x, y in expected:
            hit = next((i for i, (a, b) in enumerate(actual) if abs(a - x) <= tolerance and abs(b - y) <= tolerance), None)
            if hit is None: raise Blocked('DXF 板框顶点与当前 PCB 源坐标不一致')
            actual.pop(hit)
        method = 'source-segment-vertices-and-arc-count'
    return {'passed': True, 'method': method, 'sourceOutlinePrimitives': len(paths), 'toleranceMm': tolerance,
            'coordinateFrame': 'native-canvas-origin', 'canvasOriginMil': origin}

def check_dxf_references(data, source, native_document):
    """Check current connector/switch/mounting pad locations in native DXF.

    Hidden designators need not be rendered as labels. Their native pad
    positions must still be identifiable in physical copper/hole reference
    geometry. This never creates new drawing geometry or changes the PCB.
    """
    references = pcb_component_references(source)
    origin = pcb_canvas_origin(source)
    native_origin, zero = native_document.get('canvasOrigin', {}), native_document.get('dataOriginOnCanvas', {})
    if not all(isinstance(native_origin.get(k), (int, float)) and math.isfinite(native_origin[k]) for k in ('offsetX', 'offsetY')) or (
        abs(native_origin['offsetX'] - origin['x']) > 1e-6 or abs(native_origin['offsetY'] - origin['y']) > 1e-6): raise Blocked('DXF 原点与本次公开画布原点快照不一致')
    if not all(isinstance(zero.get(k), (int, float)) and math.isfinite(zero[k]) for k in ('x', 'y')) or (
        abs(zero['x'] + origin['x']) > 1e-6 or abs(zero['y'] + origin['y']) > 1e-6): raise Blocked('DXF 数据坐标转换与本次画布偏移不一致')
    selected = {ref: c for ref, c in references.items() if re.match(r'^(?:J|H|CN|CON|USB|SW|SCREW|P|S)\d', ref, re.I) or re.search(r'usb|type.?c|connector|header|hdmi|rj45|fpc|ffc|排针|排母|螺丝|按键|轻触', c.get('deviceName', ''), re.I)}
    entities = dxf_entities(data)
    layers = {re.sub(r'[^a-z0-9]', '', l.get('name', '').lower()) for l in native_document.get('layers', [])}
    used_layers = {next((v for c, v in e['groups'] if c == 8), '') for e in entities}
    if not layers or any(re.sub(r'[^a-z0-9]', '', l.lower()) not in layers for l in used_layers): raise Blocked('DXF 参考层不能与本次公开图层快照对应')
    reference_layers = sorted(l for l in used_layers if re.sub('[^a-z]', '', l.lower()) != 'boardoutlinelayer')
    if references and not reference_layers: raise Blocked('DXF 只有板框，缺少本板装配/连接器位置参考')
    # Native pad contours are closed lightweight polylines. Circular holes in
    # this build repeat their first endpoint with flag=0, so geometric closure
    # is accepted too. Compare with public component-pad getters separately.
    centres = []
    physical = {'toplayer', 'bottomlayer', 'multilayer', 'holelayer'}
    for entity in entities:
        groups = entity['groups']; layer = next((v for c, v in groups if c == 8), '')
        if entity['type'] != 'LWPOLYLINE' or re.sub('[^a-z]', '', layer.lower()) not in physical: continue
        try:
            closed = bool(int(next((v for c, v in groups if c == 70), '0')) & 1)
            xs, ys = ([float(v) for c, v in groups if c == code] for code in (10, 20))
        except ValueError: raise Blocked('DXF 连接器参考图元坐标无效')
        if len(xs) < 2 or len(xs) != len(ys) or not all(math.isfinite(v) for v in xs + ys): continue
        if not closed and not (len(xs) >= 3 and math.hypot(xs[0] - xs[-1], ys[0] - ys[-1]) <= 1e-6): continue
        centres.append(((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, layer))
    saved = {p.get('designator'): p for p in native_document.get('componentPads', [])}
    checked, tolerance = [], 0.005
    for ref, component in selected.items():
        saved_component = saved.get(ref)
        if not saved_component or saved_component.get('componentId') != component['id']: raise Blocked('DXF 缺少本次机械器件原生焊盘快照: ' + ref)
        pads = saved_component.get('pads')
        if not isinstance(pads, list) or not pads or not centres: raise Blocked('DXF 没有可验证的机械器件位置参考: ' + ref)
        matched_layers, distances = {}, []
        points = []
        for pad in pads:
            if pad.get('parentComponentId') != component['id'] or not all(isinstance(pad.get(k), (int, float)) and math.isfinite(pad[k]) for k in ('x', 'y')): raise Blocked('DXF 原生焊盘归属/坐标错误: ' + ref)
            x, y = (pad['x'] - origin['x']) / 39.37, (pad['y'] - origin['y']) / 39.37
            distance, layer = min((math.hypot(x - a, y - b), layer) for a, b, layer in centres)
            if distance > tolerance: raise Blocked('DXF 未包含当前机械器件焊盘位置: ' + ref)
            points.append([x, y]); distances.append(distance); matched_layers[layer] = matched_layers.get(layer, 0) + 1
        checked.append({'designator': ref, 'componentId': component['id'], 'deviceName': component.get('deviceName', ''), 'sourcePositionMil': [component.get('x'), component.get('y')], 'rotationDegrees': component.get('angle'), 'padCount': len(pads), 'matchedPadCount': len(distances), 'maxDeviationMm': max(distances), 'matchedLayers': matched_layers, 'padCentresMm': points})
    return {'passed': True, 'method': 'native-component-pad-centres-in-layered-dxf', 'referenceLayers': reference_layers, 'toleranceMm': tolerance, 'componentCount': len(checked), 'padCount': sum(c['padCount'] for c in checked), 'components': checked,
            'coordinateFrame': 'native-canvas-origin', 'canvasOriginMil': origin, 'publicDataOriginOnCanvasMil': zero}

def stable_source(text):
    records = []
    for line in text.splitlines():
        if '||' not in line: continue
        a, b = line.split('||', 1)
        head = json.loads(a)
        if head.get('type') == 'DOCHEAD': continue
        records.append([head.get('type'), head.get('id'), json.loads(b[:-1] if b.endswith('|') else b)])
    # Tab switching can reorder records without changing a single primitive.
    # Sort full records, retaining duplicates rather than losing them in a map.
    records.sort(key=lambda r: json.dumps(r, sort_keys=True, ensure_ascii=False, separators=(',', ':')))
    return digest(json.dumps(records, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode())

def pcb_component_references(text):
    components, attrs = {}, {}
    for line in text.splitlines():
        if '||' not in line: continue
        a, b = line.split('||', 1); head = json.loads(a); body = json.loads(b[:-1] if b.endswith('|') else b)
        if head.get('type') == 'COMPONENT': components[head['id']] = body
        if head.get('type') == 'ATTR' and isinstance(body, dict): attrs.setdefault(body.get('parentId'), {})[body.get('key')] = body.get('value')
    result = {}
    for uid, body in components.items():
        if not attrs.get(uid, {}).get('Designator'): continue
        name = body.get('attrs', {}).get('DeviceName', '{}')
        try: name = json.loads(name).get('name', '') if isinstance(name, str) else ''
        except (ValueError, AttributeError): name = ''
        ref = attrs[uid]['Designator']
        result[ref] = {'id': uid, 'designator': ref, 'device': attrs[uid].get('Device'), 'deviceName': name, **{k: body.get(k) for k in ('x', 'y', 'angle')}}
    return result

def check_bom_components(data, components):
    components = {c['designator']: c for c in components if c.get('designator')}
    refs_all = []
    for row in xlsx_rows(data)[1:]:
        refs = [r.strip() for r in row.get('D', '').split(',') if r.strip()]
        refs_all.extend(refs)
        if any(r not in components for r in refs): raise Blocked('BOM 存在本次 PCB 无法对应的位号')
        devices = set()
        for ref in refs:
            devices.add(component_device_uuid(components[ref].get('device')))
        if len(devices) > 1: raise Blocked('BOM 将不同器件库型号聚合成同一行，需要修正分组配置')
    if not components or set(refs_all) != set(components): raise Blocked('BOM 位号集合与本次 PCB 元件不一致')

def component_device_uuid(device):
    for _ in range(5):
        if isinstance(device, dict): device = device.get('uuid')
        else: break
    if not isinstance(device, str) or not device: raise Blocked('无法准确读取本次器件 UUID')
    return device

def resolved_name(name, attributes):
    if not isinstance(name, str): raise Blocked('原生 Name 不是字符串')
    field = re.fullmatch(r'=\{([^{}]+)\}', name)
    if field:
        value = attributes.get(field.group(1))
        if not isinstance(value, (str, int, float)): raise Blocked('Name 表达式缺少同来源属性 ' + field.group(1))
        return str(value)
    if name.startswith('='): raise Blocked('不支持的Name表达式，必须原生解析后再导出')
    return name

def unpack_native_pdf(data):
    if data.startswith(b'%PDF-'): return data, None
    if not data.startswith(b'PK'): return data, None
    members = audit_zip(data)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        pdfs = [i for i in members if i['path'].lower().endswith('.pdf')]
        if len(pdfs) != 1: raise Blocked('原理图 PDF ZIP 不含唯一 PDF，需明确多图页合并策略')
        return archive.read(pdfs[0]['path']), {'operation': 'extractNativePdf', 'nativeArchiveSha256': digest(data), 'member': pdfs[0]}

def select_assembly_pdf(data):
    from pypdf import PdfReader, PdfWriter
    reader = PdfReader(io.BytesIO(data))
    roles = ['顶面自动位号图', '底面自动位号图']
    destinations = {}
    def visit(items):
        for item in items:
            if isinstance(item, list): visit(item)
            else:
                title = item.get('/Title')
                if title in roles:
                    if title in destinations: raise Blocked('原生PDF位号图书签重复')
                    destinations[title] = reader.get_destination_page_number(item)
    visit(reader.outline)
    if set(destinations) != set(roles): raise Blocked('原生PDF缺少明确顶面/底面自动位号图书签，不能猜页码')
    writer = PdfWriter()
    for role in roles:
        index = destinations[role]
        if not isinstance(index, int) or index < 0 or index >= len(reader.pages): raise Blocked('原生PDF书签页码无效')
        writer.add_page(reader.pages[index])
        writer.add_outline_item(role, len(writer.pages) - 1)
    out = io.BytesIO(); writer.write(out)
    return out.getvalue(), {'operation': 'selectNativeAssemblyRoles', 'nativeFileSha256': digest(data), 'nativePageCount': len(reader.pages), 'selectedRoles': [{'role': role, 'nativePage': destinations[role] + 1} for role in roles], 'visualReview': 'required'}

def input_library_metadata(source):
    libraries = {}; active = None
    with zipfile.ZipFile(source) as z:
        entry = next(n for n in z.namelist() if n.endswith('.epru'))
        for line in z.read(entry).decode('utf-8-sig').splitlines():
            if '||' not in line: continue
            a, b = line.split('||', 1); head = json.loads(a); raw = b[:-1] if b.endswith('|') else b
            if head.get('type') == 'DOCHEAD':
                active = json.loads(raw)
            elif head.get('type') == 'META' and active and active.get('docType') in ('DEVICE', 'SYMBOL'):
                libraries[(active['docType'], active['uuid'])] = json.loads(raw) if raw else None
    return libraries

def normalize_bom(data, source, components):
    rows = xlsx_rows(data)
    headers = [rows[0].get(chr(65 + i), '') for i in range(len(rows[0]))]
    if headers == BOM_HEADERS: return data, None
    if headers != BOM_HEADERS[:10]: return data, None
    check_bom_components(data, components)
    components = {c['designator']: c for c in components if c.get('designator')}
    libraries = input_library_metadata(source)
    additions = [['Name', 'Device', 'Symbol', 'Description', 'Features']]
    provenance = []
    for row in rows[1:]:
        refs = [r.strip() for r in row.get('D', '').split(',') if r.strip()]
        if not refs:
            additions.append([''] * 5)
            continue
        comp = components[refs[0]]
        device_id = component_device_uuid(comp.get('device'))
        meta = libraries.get(('DEVICE', device_id))
        if not meta: raise Blocked('无法从同一输入工程定位 BOM 器件属性 ' + str(device_id))
        attributes = meta.get('attributes', {})
        symbol_id = attributes.get('Symbol', '').split('|')[0]
        symbol = libraries.get(('SYMBOL', symbol_id))
        if not symbol: raise Blocked('无法从同一输入工程定位 BOM 符号属性 ' + str(symbol_id))
        names = sorted({resolved_name(components[r].get('name', ''), {**attributes, **components[r].get('otherProperty', {}), 'Value': row.get('F', '')}) for r in refs})
        additions.append([','.join(names), meta.get('title', ''), symbol.get('title', ''), attributes.get('Description', meta.get('description', '')), attributes.get('Features', '')])
        provenance.append({'designators': refs, 'deviceUuid': device_id, 'symbolUuid': symbol_id})
    nsuri = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'; ns = {'s': nsuri}; ET.register_namespace('', nsuri)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        sheet = sorted(n for n in archive.namelist() if re.fullmatch(r'xl/worksheets/sheet\d+\.xml', n))[0]
        root = ET.fromstring(archive.read(sheet))
        for index, row in enumerate(root.findall('.//s:sheetData/s:row', ns)):
            for col, value in enumerate(additions[index], 10):
                cell = ET.SubElement(row, '{' + nsuri + '}c', {'r': chr(65 + col) + row.get('r'), 't': 'inlineStr'})
                ET.SubElement(ET.SubElement(cell, '{' + nsuri + '}is'), '{' + nsuri + '}t').text = str(value)
        dimension = root.find('s:dimension', ns)
        if dimension is not None: dimension.set('ref', 'A1:O' + str(len(rows)))
        cols = root.find('s:cols', ns)
        if cols is not None: ET.SubElement(cols, '{' + nsuri + '}col', {'min': '11', 'max': '15', 'width': '20', 'customWidth': '1'})
        out = io.BytesIO()
        with zipfile.ZipFile(out, 'w') as target:
            for item in archive.infolist(): target.writestr(item, ET.tostring(root, encoding='utf-8', xml_declaration=True) if item.filename == sheet else archive.read(item))
    return out.getvalue(), {'operation': 'restoreCaseBomColumns', 'nativeFileSha256': digest(data), 'sourceArchiveSha256': digest(Path(source).read_bytes()), 'reason': '原生10列BOM保留全部分组/位号/数量；额外5列取同一原生PCB Name与输入工程DEVICE/SYMBOL META', 'groups': provenance}

def normalize_pick_place(data, components, source=None):
    rows = xlsx_rows(data)
    headers = [rows[0].get(chr(65 + i), '') for i in range(15)]
    if headers == PNP_HEADERS and len(rows[0]) == 15: return data, None
    if headers not in (PNP_HEADERS, PNP_HEADERS[:-1] + ['Value']): return data, None
    component_map = {c['designator']: c for c in components if c.get('designator')}
    libraries = input_library_metadata(source) if source else {}
    names = {}
    for row in rows[1:]:
        ref = row.get('A')
        if ref not in component_map: raise Blocked('Name 列兼容转换需要每个位号的原生 getState_Name')
        comp = component_map[ref]
        metadata = libraries.get(('DEVICE', component_device_uuid(comp.get('device'))), {}) if source else {}
        names[ref] = resolved_name(comp.get('name'), {**metadata.get('attributes', {}), **(comp.get('otherProperty') or {}), **(comp.get('nameProperties') or {}), 'Value': row.get('O', '')})
    nsuri = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    ns = {'s': nsuri}; ET.register_namespace('', nsuri)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        sheet = sorted(n for n in archive.namelist() if re.fullmatch(r'xl/worksheets/sheet\d+\.xml', n))[0]
        root = ET.fromstring(archive.read(sheet))
        for index, row in enumerate(root.findall('.//s:sheetData/s:row', ns)):
            for cell in list(row):
                if re.match(r'[A-Z]+', cell.get('r', '')).group() not in [chr(65 + i) for i in range(15)]: row.remove(cell)
            target = next((c for c in row.findall('s:c', ns) if c.get('r') == 'O' + row.get('r')), None)
            if target is None: target = ET.SubElement(row, '{' + nsuri + '}c', {'r': 'O' + row.get('r')})
            for child in list(target): target.remove(child)
            target.set('t', 'inlineStr')
            ET.SubElement(ET.SubElement(target, '{' + nsuri + '}is'), '{' + nsuri + '}t').text = 'Name' if index == 0 else names[rows[index]['A']]
        dimension = root.find('s:dimension', ns)
        if dimension is not None: dimension.set('ref', 'A1:O' + str(len(rows)))
        cols = root.find('s:cols', ns)
        if cols is not None:
            for col in list(cols):
                if int(col.get('min')) > 15: cols.remove(col)
                elif int(col.get('max')) > 15: col.set('max', '15')
        out = io.BytesIO()
        with zipfile.ZipFile(out, 'w') as target:
            for item in archive.infolist(): target.writestr(item, ET.tostring(root, encoding='utf-8', xml_declaration=True) if item.filename == sheet else archive.read(item))
    return out.getvalue(), {'operation': 'restoreLegacyNameColumn', 'reason': '依本次PCB getState_Name恢复案例Name列；全部案例15列、坐标/旋转/SMD/所有行保留；新版额外字段保留于原生evidence', 'nativeFileSha256': digest(data), 'nativeExtraColumns': {k: v for k, v in rows[0].items() if k not in [chr(65 + i) for i in range(15)]}, 'rows': len(rows) - 1}

def bottom_paste_not_applicable(gerber_data, pnp_data, pcb_source):
    """Three independent native observations; never manufacture an empty GBP."""
    with zipfile.ZipFile(io.BytesIO(gerber_data)) as z:
        if any(n.upper().endswith('.GBP') for n in z.namelist()): return None
    rows = xlsx_rows(pnp_data)
    bottom = [r for r in rows[1:] if r.get('K', '').upper() in ('B', 'BOTTOM')]
    if any(r.get('M', '').lower() not in ('no', 'false', '否') for r in bottom): return None
    types = {'PAD', 'FILL', 'POLY', 'LINE', 'ARC', 'STRING', 'IMAGE', 'TEXT', 'REGION'}
    explicit = 0
    for line in pcb_source.splitlines():
        if '||' not in line: continue
        a, b = line.split('||', 1); head = json.loads(a); body = json.loads(b[:-1] if b.endswith('|') else b)
        if head.get('type') in types and isinstance(body, dict) and body.get('layerId') == 8: explicit += 1
    if explicit: return None
    return {'kind': 'bottomPaste', 'status': 'notApplicable', 'reason': '本次原生Gerber未输出底面锡膏；本次坐标底面仅非SMD器件；PCB有效源中没有底面锡膏层绘制对象，不制造伪空GBP', 'checks': {'nativeGerberHasBottomPaste': False, 'bottomNonSmdDesignators': [r['A'] for r in bottom], 'bottomSmdCount': 0, 'explicitBottomPastePrimitives': 0}}

class Native:
    def __init__(self, executable, evidence):
        self.executable, self.evidence, self.session = executable, evidence, None
        self.uncertain = False
        self.stage = 'not-started'

    def command(self, args, timeout=190):
        try:
            done = subprocess.run([self.executable, *args], capture_output=True, text=True, timeout=timeout, check=False)
        except subprocess.TimeoutExpired as error:
            self.uncertain = True
            raise Blocked(f'原生 CLI [{self.stage}] 超时，操作可能仍在后台；保留专用会话，不盲目重试') from error
        try: result = json.loads(done.stdout)
        except (ValueError, TypeError): raise Blocked(f'原生 CLI [{self.stage}] 未返回 JSON (exit {done.returncode}): {done.stderr[-500:]}')
        if done.returncode or result.get('ok') is not True: raise Blocked(f'原生 CLI [{self.stage}] 失败: ' + str(result.get('error', result))[:1000])
        return result.get('value')

    def invoke(self, args, script=SCRIPT):
        self.stage = args.get('action', 'invoke') + (':' + str(args['kind']) if args.get('kind') else '')
        timeout_ms = 5000 if self.stage == 'environment' else 180000
        return self.command(['invoke', '--session', self.session, '--ext-uuid', 'eda', '--code-file', str(script), '--args', json.dumps(args, ensure_ascii=False), '--timeout', str(timeout_ms)], timeout=7 if self.stage == 'environment' else 190)

    def open(self, path):
        self.stage = 'list-before-create'
        before = {s['sessionId'] for s in self.command(['session', 'list'], timeout=10)}
        # `open --path` accepts editable .eprj2/.eprj3, not epro2 archives.
        self.stage = 'create-import-session'
        result = self.command(['open', '--headless', 'true'], timeout=30)
        session = result.get('sessionId') if isinstance(result, dict) else result
        if not isinstance(session, str) or session in before: raise Blocked('原生 CLI [create-import-session] 没有创建可证明独占的新会话')
        self.session = session
        self.stage = 'validate-import-session'
        sessions = self.command(['session', 'list'], timeout=10)
        mine = next((s for s in sessions if s.get('sessionId') == session), None)
        if not mine or mine.get('headless') is not True or mine.get('origin') != 'cli': raise Blocked('原生 CLI [validate-import-session] 新会话隔离属性不符合要求')
        environment = self.invoke({'action': 'environment'})
        if (not isinstance(environment, dict) or environment.get('isClient') is not True
                or not (environment.get('isHalfOfflineMode') is True or environment.get('isOfflineMode') is True)):
            raise Blocked('原生 CLI [environment] 本地工程导入需要客户端半离线或全离线模式；请先在嘉立创 EDA 中切换为半离线或全离线，按客户端提示重启后再运行。当前导出未导入工程，也未创建云工程。')
        self.stage = 'prepare-import-directory'
        native_project = path.parent / 'native-project'
        native_project.mkdir()
        imported = self.invoke({'action': 'import', 'filePath': str(path), 'folderPath': str(native_project)})
        projects = list(native_project.glob('*.eprj2'))
        if len(projects) != 1: raise Blocked('原生 CLI [import] 本地导入没有生成唯一的 eprj2')
        # Import creates the local editable file. CLI `open --path` binds it
        # correctly, whereas openProject(uuid) does not load it in this build.
        self.close()
        self.session = None
        self.stage = 'list-before-bind'
        before = {s['sessionId'] for s in self.command(['session', 'list'], timeout=10)}
        self.stage = 'bind-project'
        result = self.command(['open', '--path', str(projects[0]), '--headless', 'true'])
        active = result.get('sessionId') if isinstance(result, dict) else result
        if not isinstance(active, str) or active in before: raise Blocked('原生 CLI [bind-project] 本地副本没有创建新的隔离编辑会话')
        self.session = active
        self.stage = 'validate-bound-session'
        active_info = next((s for s in self.command(['session', 'list']) if s.get('sessionId') == active), None)
        if not active_info or active_info.get('headless') is not True or active_info.get('origin') != 'cli': raise Blocked('原生 CLI [validate-bound-session] 本地副本会话属性不符合隔离要求')
        return {'sessionId': active, 'session': active_info, 'openResult': result, 'importedProject': imported, 'importSessionId': session, 'importEnvironment': environment}

    def close(self):
        if self.session and not self.uncertain:
            self.stage = 'close-session'
            return self.command(['session', 'close', '--session', self.session, '--destroy', 'true'])
        return None

def export(request, execute=False, executable=CLI):
    source, parent, output, plan = validate_request(request)
    origin = source_info(source)
    report = {'schemaVersion': 1, 'status': 'preflight', 'source': origin, 'request': {k: request[k] for k in ('productCode', 'hardwareVersion', 'releaseDate', 'outputParent')}, 'outputPath': str(output), 'plan': plan, 'artifacts': [], 'excludedMetadata': [], 'missing': [], 'warnings': [], 'checks': {}}
    report['missing'] = [
        {'kind': 'processXlsx', 'path': plan['paths']['processXlsx'], 'reason': '源板工艺参数、阻抗、板厚和制造要求需独立确认，禁止套用案例四层表'},
        {'kind': 'datasheets', 'path': '重要器件手册', 'reason': '仅可加入与源板精确料号对应并核对的手册，禁止盲拷案例附件'},
        {'kind': 'testInstructions', 'path': '生产资料/07_测试说明', 'reason': '输入工程未包含本板测试流程、固件和夹具验证，禁止套用案例固件'},
    ]
    if not execute: return report
    run = parent / ('.hdk-export-' + uuid.uuid4().hex)
    run.mkdir(mode=0o700)
    evidence = run / 'evidence'
    evidence.mkdir()
    source_copy = run / 'input.epro2'
    shutil.copyfile(source, source_copy)
    if digest(source_copy.read_bytes()) != origin['sha256']: raise Blocked('隔离副本哈希与原始输入不一致')
    output.mkdir()
    for d in DIRECTORIES: (output / d).mkdir(parents=True, exist_ok=True)
    report['evidencePath'] = str(evidence)
    native = Native(executable, evidence)
    before = {}
    try:
        report['session'] = native.open(source_copy)
        inspection = native.invoke({'action': 'inspect', 'expectedPcbUuid': origin['pcb']['uuid']})
        report['nativeProject'] = inspection
        if not inspection.get('pcbNativeReady'):
            report['warnings'].append('本机 alpha ready 接口返回 false；已独立核对准确 DOCHEAD、可读源码及本次原生元件数据才继续导出')
        runtime_pcbs = {p.get('uuid') for p in inspection['pcbs']}
        runtime_pages = {p.get('uuid') for p in inspection['pages']}
        if origin['pcb']['uuid'] not in runtime_pcbs or not {p['uuid'] for p in origin['pages']}.issubset(runtime_pages): raise Blocked('导入副本的文档 UUID 与输入归档不一致')
        targets = [('PCB', origin['pcb']['uuid'])] + [('SCH_PAGE', p['uuid']) for p in origin['pages']]
        for dtype, uid in targets:
            detail = native.invoke({'action': 'source', 'documentUuid': uid, 'documentType': dtype})
            (evidence / (dtype + '-' + uid + '-before.source')).write_text(detail.pop('source'), encoding='utf-8')
            before[uid] = detail
            report.setdefault('documents', []).append(detail)
        # Obtain manufacturing/data files before renderer-heavy PDFs so a PDF
        # failure still leaves independently verifiable native core exports.
        for kind in ['gerber', 'pickPlace', 'bom', 'outlineDxf', 'project', 'silkscreenPdf', 'schematicPdf']:
            target = origin['pages'][0] if kind in ('schematicPdf', 'bom') else origin['pcb']
            dtype = 'SCH_PAGE' if kind in ('schematicPdf', 'bom') else 'PCB'
            try:
                value = native.invoke({'action': 'export', 'kind': kind, 'fileName': Path(plan['paths'][kind]).stem, 'documentUuid': target['uuid'], 'documentType': dtype})
                blob = value['file']
                data = base64.b64decode(blob['base64'], validate=True)
                if len(data) != blob['bytes']: raise Blocked('原生 File 字节数不一致')
                (evidence / (kind + '.native')).write_bytes(data)
                transformation = None
                if kind == 'schematicPdf': data, transformation = unpack_native_pdf(data)
                if kind == 'silkscreenPdf': data, transformation = select_assembly_pdf(data)
                if kind == 'pickPlace': data, transformation = normalize_pick_place(data, before[origin['pcb']['uuid']]['components'], source)
                if kind == 'bom': data, transformation = normalize_bom(data, source, before[origin['pcb']['uuid']]['components'])
                check = validate_file(kind, data)
                if kind == 'outlineDxf':
                    pcb_source = (evidence / ('PCB-' + origin['pcb']['uuid'] + '-before.source')).read_text(encoding='utf-8')
                    check['sourceGeometry'] = check_dxf_source(data, pcb_source)
                    check['mechanicalReferences'] = check_dxf_references(data, pcb_source, before[origin['pcb']['uuid']])
                    check['nativeExportOptions'] = value.get('exportOptions')
                if transformation: check['transformation'] = transformation
                dest = output / plan['paths'][kind]
                with dest.open('xb') as f: f.write(data)
                check['passed'] = True
                artifact = {'kind': kind, 'path': plan['paths'][kind], 'bytes': len(data), 'sha256': digest(data), 'crc32': f'{binascii.crc32(data) & 0xffffffff:08x}', 'nativeFileName': blob.get('name'), 'checks': check}
                report['artifacts'].append(artifact)
                if kind == 'pickPlace':
                    pcb_detail = before[origin['pcb']['uuid']]
                    expected = {c['designator'] for c in pcb_detail['components'] if c['designator']}
                    got = set(check['designators'])
                    if got != expected: raise Blocked(f'坐标与本次原生 PCB 位号不一致：缺少 {sorted(expected - got)}，多出 {sorted(got - expected)}')
                if kind == 'bom':
                    check_bom_components(data, before[origin['pcb']['uuid']]['components'])
                if kind == 'gerber':
                    with zipfile.ZipFile(io.BytesIO(data)) as z:
                        for paste, suffix in [('topPaste', '.GTP'), ('bottomPaste', '.GBP')]:
                            names = [n for n in z.namelist() if n.upper().endswith(suffix)]
                            if not names and paste == 'bottomPaste':
                                continue  # decided after same-run coordinate/source checks
                            if len(names) != 1: raise Blocked('同次 Gerber 没有唯一钢网层 ' + suffix)
                            extracted = z.read(names[0])
                            if not extracted: raise Blocked('钢网层为空')
                            with (output / plan['paths'][paste]).open('xb') as f: f.write(extracted)
                            report['artifacts'].append({'kind': paste, 'path': plan['paths'][paste], 'bytes': len(extracted), 'sha256': digest(extracted), 'crc32': f'{binascii.crc32(extracted) & 0xffffffff:08x}', 'sourceGerberSha256': digest(data), 'sourceGerberMember': names[0], 'checks': {'passed': True, 'sameGerberMemberSha256': digest(extracted) == next(m['sha256'] for m in check['archive'] if m['path'] == names[0])}})
            except Exception as error:
                for artifact in report['artifacts']:
                    if artifact['kind'] == kind:
                        artifact['checks']['passed'] = False
                        artifact['checks']['error'] = str(error)
                report['missing'].append({'kind': kind, 'path': plan['paths'][kind], 'reason': str(error)})
                if native.uncertain: break
        gerber_file = evidence / 'gerber.native'; pnp_file = evidence / 'pickPlace.native'
        if gerber_file.is_file() and pnp_file.is_file() and not any(a['kind'] == 'bottomPaste' for a in report['artifacts']):
            source_before = evidence / ('PCB-' + origin['pcb']['uuid'] + '-before.source')
            absent = bottom_paste_not_applicable(gerber_file.read_bytes(), pnp_file.read_bytes(), source_before.read_text(encoding='utf-8'))
            if absent: report['notApplicable'] = [absent]
            else: report['missing'].append({'kind': 'bottomPaste', 'reason': '底面钢网缺失且没有足够源数据证明不适用'})
        if not native.uncertain:
            for dtype, uid in targets:
                after = native.invoke({'action': 'source', 'documentUuid': uid, 'documentType': dtype})
                after_text = after.pop('source')
                (evidence / (dtype + '-' + uid + '-after.source')).write_text(after_text, encoding='utf-8')
                before_text = (evidence / (dtype + '-' + uid + '-before.source')).read_text(encoding='utf-8')
                unchanged = stable_source(before_text) == stable_source(after_text)
                report['checks'].setdefault('documentSource', []).append({'uuid': uid, 'docType': dtype, 'beforeSha256': digest(before_text.encode()), 'afterSha256': digest(after_text.encode()), 'recordsUnchanged': unchanged})
                if not unchanged: report['missing'].append({'kind': 'sourceIntegrity', 'reason': '导出前后有效文档记录发生变化，需要人工核对 ' + uid})
        report['status'] = 'blocked' if report['missing'] else 'complete'
    except Exception as error:
        report['status'] = 'blocked'
        report['error'] = str(error)
        report['nativeStage'] = getattr(native, 'stage', 'unknown')
    finally:
        if native.session and not report.get('session'):
            report['session'] = {'sessionId': native.session, 'status': 'failed-before-inspection'}
        report['checks']['originalSourceUnchanged'] = digest(source.read_bytes()) == origin['sha256']
        report['checks']['inputCopyUnchanged'] = digest(source_copy.read_bytes()) == origin['sha256']
        if not report['checks']['originalSourceUnchanged']: report['status'] = 'blocked'
        try: report['sessionClose'] = native.close()
        except Exception as error: report['warnings'].append('关闭专用会话失败: ' + str(error))
        if native.uncertain: report['warnings'].append('超时未取消后台 RPC；专用会话已保留，请根据 sessionId 检查后处理')
        report['excludedMetadata'] = excluded_metadata(output, report['artifacts'])
        report['artifacts'] = [a for a in report['artifacts'] if not is_os_metadata_path(a['path'])]
        accepted = {a['kind'] for a in report['artifacts'] if a['checks'].get('passed')} | {a['kind'] for a in report.get('notApplicable', [])}
        report['coreStatus'] = 'complete' if set(CORE + ['topPaste', 'bottomPaste']).issubset(accepted) and not any(m['kind'] == 'sourceIntegrity' for m in report['missing']) else 'blocked'
        report['reportPath'] = str(run / 'export-report.json')
        Path(report['reportPath']).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    return report

def verify_report(path):
    """Re-open actual on-disk bytes; do not accept the exporter's success flags."""
    report = json.loads(Path(path).read_text(encoding='utf-8'))
    output = Path(report['outputPath']).resolve()
    request = report['request']
    version = 'V' + request['hardwareVersion'].removeprefix('V')
    paths = expected_paths(request['productCode'], version, request['releaseDate'])
    if report['plan']['paths'] != paths or output.name != request['productCode'] + '_HDK_' + version:
        raise Blocked('落盘验证：目录/命名与固定规则不一致')
    result = {'schemaVersion': 1, 'status': 'blocked', 'coreStatus': 'blocked', 'outputPath': str(output), 'artifacts': [], 'errors': [], 'pending': [],
              'excludedMetadata': excluded_metadata(output, report['artifacts'])}
    source = Path(report['source']['path'])
    if not source.is_file() or digest(source.read_bytes()) != report['source']['sha256']:
        result['errors'].append('原始输入与导出来源哈希不一致')
    # Metadata cannot replace a business file or win a duplicate-kind lookup.
    # Required core paths still undergo every source/hash/content check below.
    manifest = {a['kind']: a for a in report['artifacts'] if not is_os_metadata_path(a['path'])}
    gerber_data = None
    try:
        pcb_source = (Path(report['evidencePath']) / ('PCB-' + report['source']['pcb']['uuid'] + '-before.source')).read_text(encoding='utf-8')
        source_components = pcb_component_references(pcb_source)
    except Exception as error:
        source_components = {}
        result['errors'].append('无法独立读取本次 PCB 元件快照: ' + str(error))
    for kind in CORE:
        try:
            file = output / paths[kind]
            if file.is_symlink() or not file.resolve().is_relative_to(output): raise Blocked('禁止链接到输出目录之外')
            data = file.read_bytes()
            check = validate_file(kind, data)
            if kind == 'outlineDxf':
                check['sourceGeometry'] = check_dxf_source(data, pcb_source)
                pcb_document = next((d for d in report.get('documents', []) if d.get('dochead', {}).get('docType') == 'PCB'), {})
                check['mechanicalReferences'] = check_dxf_references(data, pcb_source, pcb_document)
                if digest((Path(report['evidencePath']) / 'outlineDxf.native').read_bytes()) != digest(data): raise Blocked('DXF 与同次原生导出证据不一致')
            if kind == 'bom': check_bom_components(data, source_components.values())
            if kind == 'pickPlace' and (not source_components or set(check['designators']) != set(source_components)): raise Blocked('坐标位号与本次源快照不一致')
            artifact = manifest.get(kind)
            if not artifact or artifact['path'] != paths[kind] or digest(data) != artifact['sha256'] or len(data) != artifact['bytes']: raise Blocked('落盘文件与本次原生导出来源清单不一致')
            if artifact.get('checks', {}).get('passed') is not True: raise Blocked('原生阶段此文件未通过业务校验')
            transformation = artifact.get('checks', {}).get('transformation')
            if transformation:
                native = (Path(report['evidencePath']) / (kind + '.native')).read_bytes()
                expected_native_sha = transformation.get('nativeFileSha256') or transformation.get('nativeArchiveSha256')
                if digest(native) != expected_native_sha: raise Blocked('原生原件证据哈希与转换来源不一致')
                components = next((d.get('components', []) for d in report.get('documents', []) if d.get('dochead', {}).get('docType') == 'PCB'), [])
                if kind == 'schematicPdf': reconstructed, _ = unpack_native_pdf(native)
                elif kind == 'silkscreenPdf': reconstructed, _ = select_assembly_pdf(native)
                elif kind == 'pickPlace': reconstructed, _ = normalize_pick_place(native, components, source)
                elif kind == 'bom': reconstructed, _ = normalize_bom(native, source, components)
                else: raise Blocked('未知原生转换')
                if digest(reconstructed) != digest(data): raise Blocked('落盘文件与按原件重新转换的真实结果不一致')
            if kind == 'gerber': gerber_data = data
            result['artifacts'].append({'kind': kind, 'path': paths[kind], 'bytes': len(data), 'sha256': digest(data), 'crc32': f'{binascii.crc32(data) & 0xffffffff:08x}', 'checks': {**check, 'passed': True}})
        except Exception as error:
            result['errors'].append(f'{kind}: {error}')
    for kind, suffix in [('topPaste', '.GTP'), ('bottomPaste', '.GBP')]:
        try:
            if not gerber_data: raise Blocked('同次 Gerber 尚未通过落盘验证')
            file = output / paths[kind]
            if kind == 'bottomPaste' and any(n.get('kind') == kind for n in report.get('notApplicable', [])):
                pcb = report['source']['pcb']['uuid']
                evidence = Path(report['evidencePath'])
                absent = bottom_paste_not_applicable(gerber_data, (evidence / 'pickPlace.native').read_bytes(), (evidence / ('PCB-' + pcb + '-before.source')).read_text(encoding='utf-8'))
                if not absent or file.exists(): raise Blocked('底钢网不适用声明与本次源/坐标/Gerber不一致')
                result.setdefault('notApplicable', []).append(absent)
                continue
            if file.is_symlink() or not file.resolve().is_relative_to(output): raise Blocked('禁止钢网符号链接')
            data = file.read_bytes()
            with zipfile.ZipFile(io.BytesIO(gerber_data)) as z:
                names = [n for n in z.namelist() if n.upper().endswith(suffix)]
                if len(names) != 1 or data != z.read(names[0]): raise Blocked('钢网与本次 Gerber 对应成员逐字节不一致')
            result['artifacts'].append({'kind': kind, 'path': paths[kind], 'bytes': len(data), 'sha256': digest(data), 'checks': {'passed': True, 'sameGerberMemberSha256': True}})
        except Exception as error: result['errors'].append(f'{kind}: {error}')
    for doc in report.get('checks', {}).get('documentSource', []):
        try:
            stem = doc['docType'] + '-' + doc['uuid']
            evidence = Path(report['evidencePath'])
            before = (evidence / (stem + '-before.source')).read_text(encoding='utf-8')
            after = (evidence / (stem + '-after.source')).read_text(encoding='utf-8')
            if digest(before.encode()) != doc['beforeSha256'] or digest(after.encode()) != doc['afterSha256'] or stable_source(before) != stable_source(after): raise Blocked('源码快照不匹配或有效记录变化')
        except Exception as error: result['errors'].append(f'文档完整性: {error}')
    if not report.get('checks', {}).get('documentSource'): result['errors'].append('缺少导出前后原生文档快照')
    if not result['errors']: result['coreStatus'] = 'complete'
    # A native export does not certify the contents of process/testing/manuals.
    result['pending'] = report.get('missing', [])
    result['pending'].extend({'kind': k, 'reason': '必须实际渲染并人工检查中文、标题栏、配色、顶底面可读性'} for k in ('schematicPdf', 'silkscreenPdf'))
    if result['coreStatus'] == 'complete' and not result['pending']: result['status'] = 'complete'
    return result

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument('--request')
    modes.add_argument('--verify', metavar='EXPORT_REPORT_JSON')
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    try:
        if args.verify:
            report = verify_report(args.verify)
        else:
            request = json.loads(Path(args.request).read_text(encoding='utf-8'))
            report = export(request, execute=args.execute)
    except Exception as error:
        report = {'schemaVersion': 1, 'status': 'blocked', 'error': str(error)}
    print(json.dumps(report, ensure_ascii=False))
    return 0 if report['status'] in ('preflight', 'complete') else 2

if __name__ == '__main__':
    sys.exit(main())
