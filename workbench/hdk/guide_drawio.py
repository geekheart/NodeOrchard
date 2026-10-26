"""Editable, source-bound DrawIO functional diagrams for board user guides.

The S31 guide is a visual reference only: centred processor, rounded peripheral
blocks and black/white linework. Every identifier comes from the current facts.
"""
from pathlib import Path
import hashlib
import json
import os
import plistlib
import re
import struct
import subprocess
import tempfile
from urllib.parse import unquote
import xml.etree.ElementTree as ET
import zlib


DRAWIO = Path('/Applications/draw.io.app/Contents/MacOS/draw.io')
RENDERER_VERSION = 1


def _sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _interfaces(facts):
    value = facts.get('interfaces', [])
    if isinstance(value, dict):
        return [dict(item, ref=ref) for ref, item in value.items()]
    return value


def source_payload(facts):
    """Only source-backed diagram facts; bundle paths and prose cannot affect it."""
    board = facts.get('board', {})
    return {'productCode': facts.get('productCode', ''), 'sourceSha256': facts.get('source', {}).get('sha256'),
            'board': {key: board.get(key) for key in ('moduleRef', 'modulePart', 'primaryTarget', 'targets', 'targetEvidence')},
            'interfaces': [{key: item.get(key) for key in ('ref', 'kind', 'titleZh', 'titleEn', 'part', 'pins')}
                           for item in _interfaces(facts)]}


def source_digest(facts):
    return hashlib.sha256(json.dumps(source_payload(facts), ensure_ascii=False, sort_keys=True,
                                     separators=(',', ':')).encode()).hexdigest()


def _group_label(kind, members):
    refs = ', '.join(item.get('ref', '') for item in members)
    if kind == 'header':
        counts = [len(item.get('pins', [])) for item in members]
        count = f'{len(counts)} × {counts[0]}' if len(set(counts)) == 1 else ' + '.join(map(str, counts))
        return f'{count} Pin Header\n扩展排针\n{refs}'
    if kind == 'controls':
        kinds = {item.get('kind') for item in members}
        if kinds == {'reset'}:
            return f'RESET\n复位按键\n{refs}'
        if kinds == {'boot'}:
            return f'BOOT\n下载按键\n{refs}'
    names = {'mipi-dsi': ('MIPI DSI Display', '显示接口'), 'mipi-csi': ('MIPI CSI Camera', '摄像头接口'),
             'dvp': ('DVP Camera', '摄像头接口'), 'rgb': ('RGB LED', '可编程指示灯'),
             'controls': ('RESET / BOOT', '复位 / 下载按键'), 'sd': ('TF / microSD', '存储卡座'),
             'usb': ('USB Type-C', 'USB 接口')}
    if kind in names:
        en, zh = names[kind]
    else:
        en = members[0].get('titleEn') or members[0].get('part') or 'Interface'
        zh = members[0].get('titleZh') or '接口'
    return f'{en}\n{zh}\n{refs}'


def diagram_groups(facts):
    groups = []
    for item in _interfaces(facts):
        kind = item.get('kind', 'other')
        key = 'controls' if kind in ('reset', 'boot') else kind
        # Only matched headers and controls share blocks. Other connectors keep
        # individual references because identical protocol names need not share routing.
        existing = next((group for group in groups if group['kind'] == key), None) if key in ('header', 'controls') else None
        if existing:
            existing['members'].append(item)
        else:
            groups.append({'kind': key, 'members': [item]})
    for group in groups:
        group['refs'] = [item.get('ref', '') for item in group['members']]
        group['label'] = _group_label(group['kind'], group['members'])
        group['moduleNets'] = sorted({pin['net'] for item in group['members'] for pin in item.get('pins', [])
                                      if pin.get('modulePins') and pin.get('net')})
        group['connection'] = 'source-module-net' if group['moduleNets'] else 'functional-grouping-only'
    return groups


def _layout(groups):
    """Keep the S31 layout for the common functions, and expand for extras."""
    sides = {'top': [], 'left': [], 'right': [], 'bottom': []}
    for group in groups:
        kind = group['kind']
        side = ('top' if kind in ('mipi-dsi', 'mipi-csi', 'dvp') else
                'left' if kind in ('rgb', 'controls') else 'right' if kind == 'usb' else 'bottom')
        sides[side].append(group)
    top_rows = max(1, (len(sides['top']) + 2) // 3)
    bottom_rows = max(1, (len(sides['bottom']) + 2) // 3)
    side_rows = max(2, len(sides['left']), len(sides['right']))
    centre_y = 120 + top_rows * 150 + (side_rows * 145 - 230) / 2
    centre = {'x': 380, 'y': centre_y, 'width': 280, 'height': 230}
    for side, entries in sides.items():
        for index, group in enumerate(entries):
            if side in ('left', 'right'):
                x, y = (50 if side == 'left' else 790), 120 + top_rows * 150 + index * 145
            else:
                row, col = divmod(index, 3)
                count = min(3, len(entries) - row * 3)
                x = 520 - (count * 230 + (count - 1) * 35) / 2 + col * 265
                y = 120 + row * 150 if side == 'top' else 120 + top_rows * 150 + side_rows * 145 + 85 + row * 150
            group.update({'side': side, 'modulePort': round((index + 1) / (len(entries) + 1), 6),
                          'geometry': {'x': x, 'y': y, 'width': 230, 'height': 110}})
    height = 120 + top_rows * 150 + side_rows * 145 + 85 + bottom_rows * 150 + 90
    return centre, 1040, height


def build_drawio(facts):
    groups = diagram_groups(facts)
    centre, width, height = _layout(groups)
    product = str(facts.get('productCode', 'Board'))
    board = facts.get('board', {})
    mxfile = ET.Element('mxfile', {'host': 'Electron', 'agent': 'Workbench source-bound diagram',
                                 'type': 'device', 'version': '30.0.4'})
    diagram = ET.SubElement(mxfile, 'diagram', {'id': 'functional-blocks', 'name': 'Functional Block Diagram'})
    model = ET.SubElement(diagram, 'mxGraphModel', {'dx': str(width), 'dy': str(height), 'grid': '0',
                         'gridSize': '10', 'guides': '1', 'tooltips': '1', 'connect': '1', 'arrows': '1',
                         'fold': '1', 'page': '0', 'pageScale': '1', 'pageWidth': str(width),
                         'pageHeight': str(height), 'math': '0', 'shadow': '0', 'background': '#ffffff'})
    root = ET.SubElement(model, 'root')
    ET.SubElement(root, 'mxCell', {'id': '0'})
    ET.SubElement(root, 'mxCell', {'id': '1', 'parent': '0'})
    common = 'whiteSpace=wrap;html=0;fontFamily=Arial;fontColor=#111111;fillColor=#ffffff;strokeColor=#111111;'

    def vertex(identifier, value, geometry, extra=''):
        cell = ET.SubElement(root, 'mxCell', {'id': identifier, 'value': value, 'vertex': '1', 'parent': '1',
                           'style': common + extra})
        ET.SubElement(cell, 'mxGeometry', {**{key: str(value) for key, value in geometry.items()}, 'as': 'geometry'})
        return cell

    vertex('canvas', '', {'x': 0, 'y': 0, 'width': width, 'height': height}, 'strokeColor=none;')
    vertex('title', product, {'x': 50, 'y': 28, 'width': 940, 'height': 40},
           'text;strokeColor=none;fillColor=none;fontSize=29;fontStyle=1;align=center;')
    vertex('subtitle', 'Functional Block Diagram  /  功能框图', {'x': 50, 'y': 75, 'width': 940, 'height': 28},
           'text;strokeColor=none;fillColor=none;fontSize=18;align=center;')
    vertex('module', '', centre, 'rounded=1;arcSize=12;strokeWidth=3;')
    vertex('module-part', str(board.get('modulePart') or 'Processor module'),
           {'x': centre['x'] + 16, 'y': centre['y'] + 24, 'width': 248, 'height': 32},
           'text;strokeColor=none;fillColor=none;fontSize=22;fontStyle=1;align=center;')
    targets = board.get('targets') or ([board.get('primaryTarget')] if board.get('primaryTarget') else [])
    processor_names = [re.sub(r'^esp32', 'ESP32-', str(value), flags=re.I).upper() for value in targets]
    processor_text = '\n+\n'.join(processor_names) if len(processor_names) < 3 else '\n'.join(processor_names)
    vertex('processors', processor_text, {'x': centre['x'] + 16, 'y': centre['y'] + 70, 'width': 248, 'height': 100},
           'text;strokeColor=none;fillColor=none;fontSize=29;fontStyle=1;align=center;')
    vertex('module-caption', 'Processor module / 主控模组 · ' + str(board.get('moduleRef') or ''),
           {'x': centre['x'] + 12, 'y': centre['y'] + 184, 'width': 256, 'height': 24},
           'text;strokeColor=none;fillColor=none;fontSize=14;align=center;')
    vertex('pin-one', '', {'x': centre['x'] + 251, 'y': centre['y'] + 14, 'width': 12, 'height': 12},
           'ellipse;fillColor=#111111;strokeColor=#111111;')
    for index, group in enumerate(groups):
        identifier = f'function-{index + 1}'
        vertex(identifier, group['label'], group['geometry'],
               'rounded=1;arcSize=14;strokeWidth=2;fontSize=19;spacing=10;align=center;verticalAlign=middle;')
        port = str(group['modulePort'])
        ports = {'left': 'exitX=1;exitY=0.5;entryX=0;entryY=' + port + ';',
                 'right': 'exitX=0;exitY=0.5;entryX=1;entryY=' + port + ';',
                 'top': 'exitX=0.5;exitY=1;entryX=' + port + ';entryY=0;',
                 'bottom': 'exitX=0.5;exitY=0;entryX=' + port + ';entryY=1;'}
        style = ('edgeStyle=orthogonalEdgeStyle;rounded=0;html=0;strokeColor=#111111;strokeWidth=2;'
                 'startArrow=none;endArrow=none;' + ports[group['side']])
        if group['connection'] == 'functional-grouping-only':
            style += 'dashed=1;dashPattern=5 4;'
        edge = ET.SubElement(root, 'mxCell', {'id': f'connection-{index + 1}', 'edge': '1', 'parent': '1',
                                            'source': identifier, 'target': 'module', 'style': style,
                                            'value': ''})
        ET.SubElement(edge, 'mxGeometry', {'relative': '1', 'as': 'geometry'})
    vertex('legend', 'Solid: explicit module nets · Dashed: function grouping; see schematic for routing\n实线：源工程模组网络 · 虚线：功能分组，实际连线以原理图为准',
           {'x': 40, 'y': height - 65, 'width': 960, 'height': 44},
           'text;strokeColor=none;fillColor=none;fontSize=14;align=center;')
    ET.indent(mxfile, space='  ')
    return ET.tostring(mxfile, encoding='unicode') + '\n', groups


def _png_dimensions(path):
    data = Path(path).read_bytes()
    if len(data) < 24 or data[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError('DrawIO did not export a valid PNG')
    return list(struct.unpack('>II', data[16:24]))


def _png_embedded_xml(path):
    data = Path(path).read_bytes()
    _png_dimensions(path)
    offset, embedded, types = 8, None, []
    while offset < len(data):
        if offset + 12 > len(data):
            raise ValueError('DrawIO PNG has truncated chunks')
        size = struct.unpack('>I', data[offset:offset + 4])[0]
        kind = data[offset + 4:offset + 8]
        content = data[offset + 8:offset + 8 + size]
        end = offset + 12 + size
        if end > len(data) or zlib.crc32(kind + content) & 0xffffffff != struct.unpack('>I', data[end - 4:end])[0]:
            raise ValueError('DrawIO PNG chunk integrity check failed')
        types.append(kind)
        if kind == b'zTXt':
            key, compressed = content.split(b'\0', 1)
            if key == b'mxGraphModel' and compressed[:1] == b'\0':
                decompressor = zlib.decompressobj()
                xml = decompressor.decompress(compressed[1:], 8 * 1024 * 1024)
                if decompressor.unconsumed_tail or not decompressor.eof:
                    raise ValueError('DrawIO embedded graph is too large or corrupt')
                embedded = unquote(xml.decode('utf-8'))
        offset = end
        if kind == b'IEND':
            break
    if not embedded or b'IDAT' not in types or types[-1:] != [b'IEND'] or offset != len(data):
        raise ValueError('DrawIO PNG is missing its editable graph or raster content')
    return embedded


def _cells(xml):
    """DrawIO normalizes attribute order and zero geometry during SVG export."""
    result = {}
    for cell in ET.fromstring(xml).iter('mxCell'):
        geometry = cell.find('mxGeometry')
        fields = dict(geometry.attrib) if geometry is not None else None
        if fields is not None:
            for key in ('x', 'y', 'width', 'height'):
                if key in fields:
                    fields[key] = float(fields[key])
            for key in ('x', 'y'):
                if fields.get(key) == 0:
                    fields.pop(key)
        result[cell.get('id')] = {'attributes': dict(cell.attrib), 'geometry': fields}
    return result


def render_source_diagram(facts, path):
    """Export an editable .drawio with the installed DrawIO application itself."""
    target = Path(path).resolve()
    if target.suffix not in ('.svg', '.png', '.drawio'):
        raise ValueError('DrawIO diagram target must be .svg, .png or .drawio')
    target.parent.mkdir(parents=True, exist_ok=True)
    executable = Path(os.environ.get('WORKBENCH_DRAWIO', str(DRAWIO))).resolve()
    if not executable.is_file():
        raise ValueError('DrawIO desktop CLI is required for actual diagram export')
    paths = {key: target.with_suffix('.' + key) for key in ('drawio', 'svg', 'png')}
    xml, groups = build_drawio(facts)
    paths['drawio'].write_text(xml, encoding='utf-8')
    version = 'unknown'
    info = executable.parent.parent / 'Info.plist'
    if info.is_file():
        with info.open('rb') as stream:
            version = str(plistlib.load(stream).get('CFBundleShortVersionString', 'unknown'))
    exports = []
    for format_name in ('svg', 'png'):
        with tempfile.TemporaryDirectory(prefix='.drawio-export-', dir=target.parent) as profile:
            command = [str(executable), '--user-data-dir=' + profile, '--disable-update', '--export',
                       '--format', format_name, '--output', str(paths[format_name]), '--border', '0',
                       '--scale', '2', '--embed-diagram']
            if format_name == 'svg':
                command += ['--svg-theme', 'light', '--embed-svg-fonts', 'false']
            command.append(str(paths['drawio']))
            process = subprocess.run(command, capture_output=True, text=True, timeout=90, check=False)
            if process.returncode or not paths[format_name].is_file():
                raise ValueError(f'DrawIO {format_name} export failed: ' + (process.stderr or process.stdout)[-1200:])
            exports.append({'format': format_name, 'method': 'DrawIO desktop CLI --export',
                            'stdout': process.stdout.strip()[-500:]})
    dimensions = _png_dimensions(paths['png'])
    if min(dimensions) < 1000:
        raise ValueError('DrawIO PNG export is unexpectedly small')
    svg = ET.parse(paths['svg']).getroot()
    if svg.tag.rsplit('}', 1)[-1] != 'svg':
        raise ValueError('DrawIO SVG export is invalid')
    manifest_path = target.with_suffix('.drawio-manifest.json')
    manifest = {'schemaVersion': 1, 'rendererVersion': RENDERER_VERSION, 'format': 'source-bound-drawio-functional-diagram',
                'tool': {'name': 'draw.io', 'version': version, 'path': str(executable)},
                'sourceSha256': facts.get('source', {}).get('sha256'), 'sourceFactsSha256': source_digest(facts),
                'style': 'S31-TINY guide: centred module, rounded black/white function blocks',
                'claimScope': 'Functional groups only; no inferred protocol direction, frequency or fitted accessories',
                'interfaceCount': len(_interfaces(facts)), 'groups': [{key: value for key, value in group.items() if key != 'members'} for group in groups],
                'exports': exports, 'pngDimensions': dimensions,
                'artifacts': {key: {'path': str(value), 'sha256': _sha(value)} for key, value in paths.items()}}
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return {'path': str(target), 'sha256': _sha(target), 'method': 'DrawIO desktop CLI --export',
            'interfaceCount': len(_interfaces(facts)), 'manifestPath': str(manifest_path),
            **{key + 'Path': str(value) for key, value in paths.items()}}


def verify_source_diagram(manifest_path, facts):
    """Reread actual exports and rebuild source XML; receipt booleans are ignored."""
    path = Path(manifest_path).resolve()
    manifest = json.loads(path.read_text(encoding='utf-8'))
    if (manifest.get('format') != 'source-bound-drawio-functional-diagram' or
            manifest.get('rendererVersion') != RENDERER_VERSION or
            manifest.get('sourceFactsSha256') != source_digest(facts) or
            manifest.get('sourceSha256') != facts.get('source', {}).get('sha256')):
        raise ValueError('DrawIO source binding differs from the current engineering facts')
    if manifest.get('tool', {}).get('name') != 'draw.io' or [item.get('format') for item in manifest.get('exports', [])] != ['svg', 'png']:
        raise ValueError('DrawIO export evidence is incomplete')
    artifacts = manifest.get('artifacts', {})
    if set(artifacts) != {'drawio', 'svg', 'png'}:
        raise ValueError('DrawIO editable source or actual exports are missing')
    for format_name, artifact in artifacts.items():
        file = Path(artifact['path']).resolve()
        if file.parent != path.parent or file.suffix != '.' + format_name or not file.is_file() or _sha(file) != artifact.get('sha256'):
            raise ValueError('DrawIO exported artifact failed hash/path verification')
    xml, groups = build_drawio(facts)
    if Path(artifacts['drawio']['path']).read_text(encoding='utf-8') != xml:
        raise ValueError('DrawIO editable graph differs from the current source groups')
    expected_groups = [{key: value for key, value in group.items() if key != 'members'} for group in groups]
    if manifest.get('groups') != expected_groups:
        raise ValueError('DrawIO function-group evidence differs from the current source')
    if _png_dimensions(artifacts['png']['path']) != manifest.get('pngDimensions'):
        raise ValueError('DrawIO image dimensions differ from the export record')
    if _png_embedded_xml(artifacts['png']['path']) != xml:
        raise ValueError('DrawIO PNG embedded graph differs from the editable source')
    svg = ET.parse(artifacts['svg']['path']).getroot()
    if svg.tag.rsplit('}', 1)[-1] != 'svg':
        raise ValueError('DrawIO exported SVG is invalid')
    if not svg.get('content') or _cells(svg.get('content')) != _cells(xml):
        raise ValueError('DrawIO SVG embedded graph differs from the editable source')
    return {'passed': True, 'sourceFactsSha256': source_digest(facts), 'interfaceCount': len(_interfaces(facts)),
            'groupCount': len(groups), 'artifacts': artifacts, 'manifestSha256': _sha(path)}
