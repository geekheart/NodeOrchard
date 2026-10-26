"""Prepare OpenPinMap from native electrical facts and calibrated real imagery.

The image is never used to infer nets. Ambiguous bottom-side pin ordering or an
uncalibrated image is blocked rather than rendered as a plausible Pinout.
The legacy native-PCB image API remains available for historical runs; the
photograph API independently calibrates supplied front/back photos. Original
engineering files and photographs remain read-only.
"""
from pathlib import Path, PurePosixPath
import argparse
import base64
import hashlib
import json
import math
import os
import re
import struct
import sys
import zipfile


class PinoutBlocked(ValueError):
    pass


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _point(value):
    return isinstance(value, (list, tuple)) and len(value) == 2 and all(_finite(item) for item in value)


def _distance(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _write_new(path, value):
    with Path(path).open('x', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write('\n')


def _attrs(doc):
    values = {}
    for head, body in doc.get('records', []):
        if head.get('type') == 'ATTR' and isinstance(body, dict):
            values.setdefault(body.get('parentId'), {})[body.get('key')] = body.get('value')
    return values


def _source(source_path):
    source = Path(source_path).expanduser().resolve()
    if not source.is_file() or source.suffix.lower() != '.epro2':
        raise PinoutBlocked('sourcePath must be an existing native epro2 file')
    data = source.read_bytes()
    if len(data) > 300_000_000:
        raise PinoutBlocked('epro2 exceeds the 300 MB input budget')
    with zipfile.ZipFile(source) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)) or any(PurePosixPath(name).is_absolute() or '..' in PurePosixPath(name).parts or '\\' in name for name in names):
            raise PinoutBlocked('Unsafe or duplicate epro2 ZIP members')
        if sum(item.file_size for item in archive.infolist()) > 400_000_000 or archive.testzip():
            raise PinoutBlocked('epro2 ZIP budget or CRC check failed')
        projects = [name for name in names if name.endswith('.epru')]
        if len(projects) != 1:
            raise PinoutBlocked('Exactly one native epru project is required')
        text = archive.read(projects[0]).decode('utf-8-sig')
    docs, current = {}, None
    for line in text.splitlines():
        if '||' not in line:
            continue
        left, right = line.split('||', 1)
        try:
            payload = right[:-1] if right.endswith('|') else right
            head, body = json.loads(left), json.loads(payload) if payload else None
        except (ValueError, TypeError):
            raise PinoutBlocked('Malformed native epru record')
        if body is None:
            continue
        if head.get('type') == 'DOCHEAD':
            current = body.get('uuid')
            if not current or current in docs:
                raise PinoutBlocked('Missing or duplicate native document UUID')
            docs[current] = {'head': body, 'records': []}
        if current:
            docs[current]['records'].append((head, body))
    pcbs = [doc for doc in docs.values() if doc['head'].get('docType') == 'PCB']
    if len(pcbs) != 1:
        raise PinoutBlocked('Exactly one PCB is required for Pinout')
    return source, data, docs, pcbs[0]


def _line_geometry(pads):
    """Only explicit through-hole, regular single-row footprints are auto-picked."""
    if len(pads) < 2 or len({str(pad.get('num')) for pad in pads}) != len(pads):
        return None
    if not all(pad.get('plated') is True and (pad.get('hole') or {}).get('width', 0) > 0 and all(_finite(pad.get(key)) for key in ('centerX', 'centerY')) for pad in pads):
        return None
    points = [[pad['centerX'], pad['centerY']] for pad in pads]
    extent = [max(point[axis] for point in points) - min(point[axis] for point in points) for axis in (0, 1)]
    major = 0 if extent[0] > extent[1] else 1
    if extent[major] <= 0 or extent[1-major] > 0.01:
        return None
    ordered = sorted(points, key=lambda point: point[major])
    gaps = [ordered[index+1][major] - ordered[index][major] for index in range(len(ordered)-1)]
    if min(gaps) <= 0 or max(gaps)-min(gaps) > 0.01:
        return None
    return {'localAxis': 'x' if major == 0 else 'y', 'pitchMil': sum(gaps)/len(gaps)}


def extract_pinout_facts(source_path, connector_designators=None):
    source, data, docs, pcb = _source(source_path)
    attrs = _attrs(pcb)
    placements = {head.get('id'): body for head, body in pcb['records'] if head.get('type') == 'COMPONENT'}
    nets = {}
    for head, body in pcb['records']:
        if head.get('type') != 'PAD_NET':
            continue
        ident = json.loads(head['id'])
        key = (ident[1], str(ident[2]))
        if key in nets and nets[key] != body.get('padNet', ''):
            raise PinoutBlocked('Conflicting PAD_NET assignments in source')
        nets[key] = body.get('padNet', '')
    connectors = []
    for uid, attr in attrs.items():
        designator = attr.get('Designator')
        if not designator or uid not in placements:
            continue
        footprint = docs.get(attr.get('Footprint'), {})
        pads = [body for head, body in footprint.get('records', []) if head.get('type') == 'PAD']
        geometry = _line_geometry(pads)
        explicit = connector_designators is not None and designator in connector_designators
        if connector_designators is not None and not explicit:
            continue
        if connector_designators is None and (not geometry or not re.fullmatch(r'(?:H|J|P|CN|CON)\d+', designator, re.I)):
            continue
        if not geometry:
            raise PinoutBlocked(f'{designator} is not an unambiguous regular single-row through-hole connector')
        placement = placements[uid]
        if not all(_finite(placement.get(key)) for key in ('x', 'y', 'angle')):
            raise PinoutBlocked(f'{designator} has invalid native placement')
        pins = []
        for pad in pads:
            number = str(pad['num'])
            net = nets.get((uid, number))
            if not isinstance(net, str) or not net:
                raise PinoutBlocked(f'{designator}.{number} lacks an explicit source PAD_NET; no pin name will be invented')
            pins.append({'pad': number, 'net': net, 'name': net, 'localMil': [pad['centerX'], pad['centerY']], 'footprintPadId': next(head.get('id') for head, body in footprint['records'] if body is pad)})
        connectors.append({'designator': designator, 'componentId': uid, 'footprintUuid': attr.get('Footprint'), 'placement': {key: placement.get(key) for key in ('x', 'y', 'angle', 'layerId')}, 'geometry': geometry, 'pins': pins})
    if connector_designators is not None and set(connector_designators) != {connector['designator'] for connector in connectors}:
        raise PinoutBlocked('Requested connectors do not exactly match source connector facts')
    return {'format': 'workbench-pinout-facts', 'version': 1, 'source': {'path': str(source), 'bytes': len(data), 'sha256': _sha(data)}, 'pcbUuid': pcb['head']['uuid'], 'coordinateFrame': 'pcb-data-mil', 'connectors': sorted(connectors, key=lambda connector: connector['designator']), 'pinCount': sum(len(connector['pins']) for connector in connectors)}


def _png_info(data):
    if len(data) < 33 or data[:8] != b'\x89PNG\r\n\x1a\n' or data[12:16] != b'IHDR':
        raise PinoutBlocked('boardImagePath must be the calibrated native PNG')
    width, height = struct.unpack('>II', data[16:24])
    if width < 1 or height < 1 or width*height > 32_000_000:
        raise PinoutBlocked('Native PNG dimensions exceed the Pinout budget')
    return {'width': width, 'height': height, 'bytes': len(data), 'sha256': _sha(data)}


def _project(matrix, point):
    a, b, c, d, e, f = matrix
    return [a*point[0]+c*point[1]+e, b*point[0]+d*point[1]+f]


def _native_mapping(connector, native):
    pads = native.get('pads', [])
    if len(pads) != len(connector['pins']) or any(pad.get('parentComponentId', connector['componentId']) != connector['componentId'] or not all(_finite(pad.get(key)) for key in ('x', 'y')) for pad in pads):
        raise PinoutBlocked(f"{connector['designator']} native absolute pad ownership/count is invalid")
    numbered = {}
    for pad in pads:
        number = pad.get('number', pad.get('padNumber', pad.get('num')))
        if number is not None:
            number = str(number)
            if number in numbered:
                raise PinoutBlocked('Duplicate native absolute pad number')
            numbered[number] = [pad['x'], pad['y']]
            expected = next((pin['net'] for pin in connector['pins'] if pin['pad'] == number), None)
            if 'net' in pad and pad['net'] != expected:
                raise PinoutBlocked(f"{connector['designator']}.{number} native net differs from source PAD_NET")
    placement = connector['placement']
    candidates = []
    mirrors = ['none'] if placement['layerId'] == 1 else ['none', 'x', 'y']
    for mirror in mirrors:
        for direction in [1, -1]:
            angle = math.radians(placement['angle']*direction)
            positions = {}
            for pin in connector['pins']:
                x, y = pin['localMil']
                if mirror == 'x': x = -x
                if mirror == 'y': y = -y
                positions[pin['pad']] = [placement['x'] + x*math.cos(angle)-y*math.sin(angle), placement['y'] + x*math.sin(angle)+y*math.cos(angle)]
            if numbered:
                matched = set(numbered) == set(positions) and all(_distance(positions[number], numbered[number]) <= 0.02 for number in positions)
            else:
                available = list(range(len(pads)))
                matched = True
                for point in positions.values():
                    near = [index for index in available if _distance(point, [pads[index]['x'], pads[index]['y']]) <= 0.02]
                    if len(near) != 1: matched = False; break
                    available.remove(near[0])
            if matched and not any(all(_distance(candidate['positions'][number], point) <= 0.02 for number, point in positions.items()) for candidate in candidates):
                candidates.append({'mirror': mirror, 'rotationSign': direction, 'positions': positions})
    if len(candidates) != 1:
        raise PinoutBlocked(f"{connector['designator']} has {len(candidates)} possible native pad-number mappings; native numbered pads or an explicitly verified profile is required")
    return candidates[0]


def validate_alignment(facts, image, evidence):
    if evidence.get('sourceSha256') != facts['source']['sha256'] or evidence.get('pcbUuid') != facts['pcbUuid']:
        raise PinoutBlocked('Pinout projection is not bound to this exact epro2/PCB')
    if evidence.get('view') != 'top' or evidence.get('coordinateFrame') not in ('pcb-data-mil', 'pcb data origin'):
        raise PinoutBlocked('An explicit top-view PCB data-coordinate projection is required')
    if any(evidence.get('image', {}).get(key) != image[key] for key in ('sha256', 'width', 'height')):
        raise PinoutBlocked('Native projection image hash/dimensions do not match boardImagePath')
    matrix = evidence.get('worldToPixel')
    if not isinstance(matrix, list) or len(matrix) != 6 or not all(_finite(item) for item in matrix) or abs(matrix[0]*matrix[3]-matrix[1]*matrix[2]) < 1e-12:
        raise PinoutBlocked('worldToPixel must be a finite, invertible affine projection')
    calibration = evidence.get('calibration', {})
    error = calibration.get('maxErrorPx')
    if calibration.get('passed') is not True or not _finite(error) or error > 1.5:
        raise PinoutBlocked('Native image calibration must pass with maximum error <= 1.5 px')
    controls = evidence.get('controlPoints', [])
    if len(controls) < 3 or any(not _point(control.get('world', control.get('worldMil'))) or not _point(control.get('pixel')) for control in controls):
        raise PinoutBlocked('At least three explicit native image control points are required')
    points = [control.get('world', control.get('worldMil')) for control in controls]
    if not any(abs((points[j][0]-points[0][0])*(points[k][1]-points[0][1])-(points[k][0]-points[0][0])*(points[j][1]-points[0][1])) > 0.01 for j in range(1, len(points)) for k in range(j+1, len(points))):
        raise PinoutBlocked('Native projection control points are collinear')
    if any(_distance(_project(matrix, control.get('world', control.get('worldMil'))), control['pixel']) > 1.5 for control in controls):
        raise PinoutBlocked('Native image control points disagree with worldToPixel')
    native_components = evidence.get('componentPads', [])
    if not facts['connectors']:
        raise PinoutBlocked('No unambiguous external single-row through-hole connectors found')
    for connector in facts['connectors']:
        matching = [native for native in native_components if native.get('componentId') == connector['componentId'] and native.get('designator') == connector['designator']]
        if len(matching) != 1:
            raise PinoutBlocked(f"{connector['designator']} lacks exact native absolute pad evidence")
        mapping = _native_mapping(connector, matching[0])
        connector['nativeTransform'] = {key: mapping[key] for key in ('mirror', 'rotationSign')}
        for pin in connector['pins']:
            pin['worldMil'] = mapping['positions'][pin['pad']]
            pin['imagePixel'] = _project(matrix, pin['worldMil'])
            if not (-1.5 <= pin['imagePixel'][0] <= image['width']+1.5 and -1.5 <= pin['imagePixel'][1] <= image['height']+1.5):
                raise PinoutBlocked('A source connector pad falls outside the calibrated native image')
    return {'method': 'native-source-pad-net-and-calibrated-top-image', 'worldToPixel': matrix, 'calibration': calibration, 'controlPoints': controls, 'electricalSource': 'epro2 PCB PAD_NET', 'pinNumberMapping': 'native absolute pad geometry verified against source footprint'}


def _color(net):
    if re.fullmatch(r'(?:GND|GROUND|VSS)', net, re.I): return '#2ecc71'
    if re.fullmatch(r'(?:\+?\d+(?:\.\d+)?V\d*|V\d+|VCC|VIN|VBUS|BAT|VOUT|LDO_VO\d+)', net, re.I): return '#e74c3c'
    return '#3498db'


def _label_candidates(net):
    """Display abbreviations may remove redundant source spelling, never add facts."""
    labels = [net]
    if re.fullmatch(r'IO\d+(?:_[A-Za-z0-9]+)*', net):
        labels.append(re.match(r'IO\d+', net).group())
        labels.append('MAIN '+re.match(r'IO\d+', net).group())
        if '_U0RXD' in net: labels.extend(['RX0', re.match(r'IO\d+', net).group()+' RX0'])
        if '_U0TXD' in net: labels.extend(['TX0', re.match(r'IO\d+', net).group()+' TX0'])
        if '_U0RXD' in net: labels.append('MAIN RX0')
        if '_U0TXD' in net: labels.append('MAIN TX0')
        if '_BOOT' in net: labels.extend(['BOOT', re.match(r'IO\d+', net).group()+' BOOT', 'MAIN BOOT'])
    if re.fullmatch(r'C\d+_IO\d+', net):
        labels.append(net.replace('_', ' '))
    if re.fullmatch(r'C\d+_U0(?:RXD|TXD)', net):
        labels.append(net.split('_')[0]+(' RX0' if net.endswith('RXD') else ' TX0'))
    if re.fullmatch(r'C\d+_EN', net): labels.append(net.replace('_', ' '))
    if re.fullmatch(r'LDO_VO\d+', net): labels.extend(['LDO'+net.split('VO')[1], 'LDO'+net.split('VO')[1]+'?'])
    return list(dict.fromkeys(labels))


def display_options(facts):
    """Bound choices for a Skill; there is deliberately no editable geometry."""
    return {'format': 'workbench-pinout-display-options', 'version': 1,
        'sourceSha256': facts['source']['sha256'], 'pinCount': facts['pinCount'],
        'style': {'presets': ['engineering', 'reference-compact'], 'backgrounds': ['white', 'transparent'],
            'guides': [True, False], 'fontSizeRange': [12, 18], 'recommendedPhotoFontSize': 12,
            'labelGapPxRange': [0, 8], 'paletteKeys': ['gpio', 'power', 'ground'],
            'compactImageScale': 100},
        'namespaceNote': 'Unprefixed IO is the main processor namespace; explicit C61 or other source prefixes must remain visible. LDO net spelling does not establish voltage. A question mark in an allowed LDO display alias means voltage unverified, not an asserted voltage value.',
        'pins': [{'connector': connector['designator'], 'pad': pin['pad'], 'net': pin['net'],
            'allowedLabels': list(dict.fromkeys(_label_candidates(pin['net'])+[f"{connector['designator']}.{pin['pad']} · {pin['net']}"]))} for connector in facts['connectors'] for pin in connector['pins']]}


def validate_display_plan(plan, facts):
    """Reject unsupported options, missing pins, invented nets and guessed aliases."""
    if not isinstance(plan, dict) or set(plan) != {'format', 'version', 'style', 'displayAliases'} or plan.get('format') != 'workbench-pinout-display-plan' or plan.get('version') != 1:
        raise PinoutBlocked('Display plan must use the bounded workbench-pinout-display-plan version 1 schema')
    style = plan.get('style')
    if not isinstance(style, dict) or set(style) != {'preset', 'background', 'guides', 'fontSize', 'labelGapPx', 'palette'}:
        raise PinoutBlocked('Display style has missing or unsupported fields')
    if style['preset'] not in ('engineering', 'reference-compact') or style['background'] not in ('white', 'transparent') or type(style['guides']) is not bool:
        raise PinoutBlocked('Display style preset/background/guides is invalid')
    if type(style['fontSize']) is not int or not 12 <= style['fontSize'] <= 18 or not _finite(style['labelGapPx']) or not 0 <= style['labelGapPx'] <= 8:
        raise PinoutBlocked('Display font size or label gap exceeds the bounded choices')
    palette = style['palette']
    if not isinstance(palette, dict) or set(palette) != {'gpio', 'power', 'ground'} or any(not isinstance(color, str) or not re.fullmatch(r'#[0-9a-fA-F]{6}', color) for color in palette.values()):
        raise PinoutBlocked('Display palette must contain explicit six-digit GPIO, power and ground colors')
    choices = {(item['connector'], item['pad']): item for item in display_options(facts)['pins']}
    aliases = plan.get('displayAliases')
    if not isinstance(aliases, list) or len(aliases) != len(choices):
        raise PinoutBlocked('Display aliases must cover every source pin exactly once')
    seen, normalized = set(), []
    for alias in aliases:
        if not isinstance(alias, dict) or set(alias) != {'connector', 'pad', 'net', 'label'}:
            raise PinoutBlocked('Display alias contains missing or unsupported fields')
        key = (alias['connector'], alias['pad'])
        if key in seen or key not in choices or alias['net'] != choices[key]['net'] or alias['label'] not in choices[key]['allowedLabels']:
            raise PinoutBlocked('Display alias changes source identity/net or uses an unverified label')
        seen.add(key)
        normalized.append(dict(alias))
    return {'format': plan['format'], 'version': 1, 'style': {**style, 'palette': dict(palette)}, 'displayAliases': normalized}


def _build_project(facts, image_data, image, product_code, photo=False, display_plan=None):
    plan = validate_display_plan(display_plan, facts) if display_plan is not None else None
    style = plan['style'] if plan else None
    alias_lookup = {(item['connector'], item['pad']): item['label'] for item in plan['displayAliases']} if plan else {}
    compact = bool(style and style['preset'] == 'reference-compact')
    connectors = facts['connectors']
    min_pitch = float('inf')
    for connector in connectors:
        pixels = [pin['imagePixel'] for pin in connector['pins']]
        extents = [max(point[axis] for point in pixels)-min(point[axis] for point in pixels) for axis in (0, 1)]
        axis = 0 if extents[0] > extents[1] else 1
        if extents[1-axis] > (8 if photo else 1.5):
            raise PinoutBlocked('Native image connector projection is not horizontal/vertical; a calibrated quarter-turn image is required')
        connector['pins'].sort(key=lambda pin: pin['imagePixel'][axis])
        gaps = [connector['pins'][index+1]['imagePixel'][axis]-connector['pins'][index]['imagePixel'][axis] for index in range(len(pixels)-1)]
        if min(gaps) <= 0 or max(gaps)-min(gaps) > 1.5:
            raise PinoutBlocked('Projected connector pins are not regularly spaced')
        connector['layout'] = 'horizontal' if axis == 0 else 'vertical'
        connector['imagePitchPx'] = sum(gaps)/len(gaps)
        min_pitch = min(min_pitch, connector['imagePitchPx'])
    scale = 1 if compact else max(1, 30/min_pitch)
    font_size = style['fontSize'] if style else max(12, min(36, math.floor(min_pitch*scale/1.7)))
    def label(connector, pin):
        if plan: return alias_lookup[(connector['designator'], pin['pad'])]
        return f"{connector['designator']}.{pin['pad']} · {pin['name']}" if photo else pin['name']
    max_name = max(len(label(connector, pin)) for connector in connectors for pin in connector['pins'])
    label_width = math.ceil(max_name*font_size*0.85+font_size*2)
    margin = label_width+(style['labelGapPx']+12 if compact else 40)
    margin_y = (20 if compact else 40) if photo and all(connector['layout'] == 'vertical' for connector in connectors) else margin
    width, height = math.ceil(image['width']*scale+margin*2), math.ceil(image['height']*scale+margin_y*2)
    if width > 8000 or height > 8000 or width*height > 32_000_000 or scale > 5:
        raise PinoutBlocked('Calibrated image cannot fit readable, non-overlapping labels in the OpenPinMap canvas budget')
    groups, anchors = [], []
    for connector in connectors:
        first = connector['pins'][0]['imagePixel']
        axis = 0 if connector['layout'] == 'horizontal' else 1
        center = sum(pin['imagePixel'][1-axis] for pin in connector['pins'])/len(connector['pins'])
        side = ('top' if center < image['height']/2 else 'bottom') if axis == 0 else ('left' if center < image['width']/2 else 'right')
        anchor = [margin+first[0]*scale, margin_y+first[1]*scale]
        start = [anchor[0]-label_width/2, margin_y-40-font_size*1.6] if side == 'top' else [anchor[0]-label_width/2, margin_y+image['height']*scale+40] if side == 'bottom' else [margin-label_width-30, anchor[1]-font_size*0.8] if side == 'left' else [margin+image['width']*scale+30, anchor[1]-font_size*0.8]
        palette = style['palette'] if style else {'gpio': '#3498db', 'power': '#e74c3c', 'ground': '#2ecc71'}
        def color(net):
            category = 'ground' if _color(net) == '#2ecc71' else 'power' if _color(net) == '#e74c3c' else 'gpio'
            return palette[category]
        groups.append({'connector': connector['designator'], 'layout': connector['layout'], 'textDirection': 'horizontal', 'labelRotation': 90 if axis == 0 else 0, 'rotation': 0, 'mirrorX': False, 'mirrorY': False, 'scale': 1, 'start': start, 'gap': connector['imagePitchPx']*scale, 'pins': [{'name': label(connector, pin), 'color': color(pin['net']), '_pin': pin['pad'], '_net': pin['net'], '_worldMil': pin['worldMil'], '_imagePixel': pin['imagePixel']} for pin in connector['pins']]})
        anchors.append({'connector': connector['designator'], 'side': side, 'firstPadPixel': anchor, 'firstPadImagePixel': first, 'padImagePixels': [pin['imagePixel'] for pin in connector['pins']]})
    if compact and width >= height:
        height = width+40
    result = {'format': 'openpinmap', 'version': 2, 'state': {'name': product_code, 'width': width, 'height': height, 'paper': {'format': 'custom', 'orientation': 'portrait', 'dpi': 300}, 'exportSettings': {'format': 'png', 'scale': 1, 'quality': 90, 'optimizeSvg': False, 'smoothing': True}, 'background': style['background'] if style else 'white', 'fontSize': font_size, 'fontFamily': 'Arial', 'radius': 100, 'guides': style['guides'] if style else True, 'imageX': margin, 'imageY': margin_y, 'imageScale': scale*100, 'imageRotation': 0, 'imageName': product_code+'_PCB_top.png', 'imageData': 'data:image/png;base64,'+base64.b64encode(image_data).decode('ascii'), 'palette': palette, 'groups': groups}, 'workbenchAlignment': {'version': 1, 'anchors': anchors, 'image': {'width': image['width'], 'height': image['height']}, 'sourceSha256': facts['source']['sha256'], 'pcbUuid': facts['pcbUuid'], 'imageSha256': image['sha256']}}
    if plan:
        result['workbenchAlignment']['displayPlan'] = plan
        result['workbenchAlignment']['aliasMapping'] = plan['displayAliases']
        facts['displayPlan'] = plan
    return result


def prepare_pinout(sourcePath=None, boardImagePath=None, outputDir=None, productCode=None, hardwareVersion='V1.0', nativeMetaPath=None, profilePath=None, connectorDesignators=None, **unused):
    if isinstance(sourcePath, dict):
        return prepare_pinout(**sourcePath)
    if not isinstance(productCode, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,100}', productCode):
        raise PinoutBlocked('productCode must be a safe explicit product identifier')
    if not isinstance(hardwareVersion, str) or not re.fullmatch(r'V?[0-9]+(?:\.[0-9]+){0,3}', hardwareVersion):
        raise PinoutBlocked('hardwareVersion must be an explicit version such as V1.0')
    output = Path(outputDir).expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    name = f'{productCode}_Pinout_{hardwareVersion}'
    facts_path, project_path = output/(name+'.facts.json'), output/(name+'.openpinmap.json')
    if facts_path.exists() or project_path.exists():
        raise PinoutBlocked('Refusing to overwrite an existing Pinout preparation')
    facts = extract_pinout_facts(sourcePath, connectorDesignators)
    result = {'status': 'blocked', 'validated': False, 'projectPath': None, 'factsPath': str(facts_path), 'pinCount': facts['pinCount']}
    try:
        if not boardImagePath or not nativeMetaPath and not profilePath:
            raise PinoutBlocked('A native top-view PNG and calibrated nativeMetaPath (or explicit verified profilePath) are required')
        image_path = Path(boardImagePath).expanduser().resolve()
        image_data = image_path.read_bytes()
        image = _png_info(image_data)
        payload = json.loads(Path(profilePath or nativeMetaPath).expanduser().read_text(encoding='utf-8'))
        evidence = payload.get('pinoutEvidence', payload)
        if profilePath and evidence.get('alignmentVerified') is not True:
            raise PinoutBlocked('Explicit Pinout profile must declare alignmentVerified=true')
        if not evidence.get('componentPads') and payload.get('componentPads'):
            evidence = {**evidence, 'componentPads': payload['componentPads']}
        facts['image'] = {**image, 'path': str(image_path)}
        facts['alignment'] = validate_alignment(facts, image, evidence)
        project = _build_project(facts, image_data, image, productCode)
        # Detect edits to either source after the read/calibration boundary.
        if _sha(Path(sourcePath).expanduser().resolve().read_bytes()) != facts['source']['sha256'] or _sha(image_path.read_bytes()) != image['sha256']:
            raise PinoutBlocked('Input source or calibrated image changed during preparation')
        _write_new(project_path, project)
        result.update(status='ready', validated=True, projectPath=str(project_path))
    except (PinoutBlocked, OSError, ValueError, KeyError, TypeError) as error:
        result['reason'] = str(error)
    facts['preparation'] = result.copy()
    try:
        _write_new(facts_path, facts)
    except Exception:
        if result['projectPath']:
            project_path.unlink(missing_ok=True)
        raise
    return result


def _solve_three(matrix, vector):
    rows = [list(row) + [value] for row, value in zip(matrix, vector)]
    for column in range(3):
        pivot = max(range(column, 3), key=lambda index: abs(rows[index][column]))
        rows[column], rows[pivot] = rows[pivot], rows[column]
        if abs(rows[column][column]) < 1e-9:
            raise PinoutBlocked('Photograph calibration controls are collinear')
        divisor = rows[column][column]
        rows[column] = [value/divisor for value in rows[column]]
        for index in range(3):
            if index != column:
                factor = rows[index][column]
                rows[index] = [value-factor*base for value, base in zip(rows[index], rows[column])]
    return [row[3] for row in rows]


def _fit_photo_affine(controls):
    # Center/scale the native mil coordinates before least squares so boards
    # far from the CAD origin have the same numerical tolerance.
    origin = [sum(control['worldMil'][axis] for control in controls)/len(controls) for axis in (0, 1)]
    size = max(_distance(control['worldMil'], origin) for control in controls)
    if size <= 0:
        raise PinoutBlocked('Photograph calibration has no spatial extent')
    vectors = [[(control['worldMil'][0]-origin[0])/size, (control['worldMil'][1]-origin[1])/size, 1] for control in controls]
    normal = [[sum(row[a]*row[b] for row in vectors) for b in range(3)] for a in range(3)]
    axes = [_solve_three(normal, [sum(row[axis]*control['pixel'][dim] for row, control in zip(vectors, controls)) for axis in range(3)]) for dim in (0, 1)]
    a, c = axes[0][0]/size, axes[0][1]/size
    b, d = axes[1][0]/size, axes[1][1]/size
    return [a, b, c, d, axes[0][2]-a*origin[0]-c*origin[1], axes[1][2]-b*origin[0]-d*origin[1]]


def validate_photo_alignment(facts, image, view, native_evidence):
    """Bind manually reviewed photo controls to exact source-numbered pads.

    Only geometry is learned from a photograph. Electrical names and pad
    numbers always come from this run's epro2 and native absolute-pad evidence.
    """
    if view.get('side') not in ('front', 'back') or view.get('reviewStatus') != 'visually-reviewed' or view.get('orientationReviewed') is not True:
        raise PinoutBlocked('Each photograph needs an explicit reviewed side and orientation')
    if any(view.get('image', {}).get(key) != image[key] for key in ('sha256', 'width', 'height')):
        raise PinoutBlocked('Photograph hash/dimensions differ from its reviewed calibration')
    if native_evidence.get('sourceSha256') != facts['source']['sha256'] or native_evidence.get('pcbUuid') != facts['pcbUuid']:
        raise PinoutBlocked('Photograph native pad evidence is not bound to this epro2/PCB')
    for connector in facts['connectors']:
        matching = [item for item in native_evidence.get('componentPads', []) if item.get('componentId') == connector['componentId'] and item.get('designator') == connector['designator']]
        if len(matching) != 1:
            raise PinoutBlocked(f"{connector['designator']} lacks exact native absolute pad evidence")
        mapping = _native_mapping(connector, matching[0])
        connector['nativeTransform'] = {key: mapping[key] for key in ('mirror', 'rotationSign')}
        for pin in connector['pins']:
            pin['worldMil'] = mapping['positions'][pin['pad']]
    lookup = {(connector['designator'], pin['pad']): pin for connector in facts['connectors'] for pin in connector['pins']}
    controls, identities = [], set()
    for item in view.get('controlPoints', []):
        key = (item.get('connector'), str(item.get('pad')))
        pin = lookup.get(key)
        if key in identities or pin is None or item.get('net') != pin['net'] or not _point(item.get('pixel')) or item.get('use') not in ('fit', 'check'):
            raise PinoutBlocked('Photograph controls must uniquely identify exact source pad/net and fit/check roles')
        if not (0 <= item['pixel'][0] < image['width'] and 0 <= item['pixel'][1] < image['height']):
            raise PinoutBlocked('Photograph control lies outside the original image')
        identities.add(key)
        controls.append({**item, 'pad': key[1], 'worldMil': pin['worldMil']})
    fit = [control for control in controls if control['use'] == 'fit']
    checks = [control for control in controls if control['use'] == 'check']
    if len(fit) < 4 or len(checks) < 2 or {control['connector'] for control in checks} != {connector['designator'] for connector in facts['connectors']}:
        raise PinoutBlocked('Photograph calibration requires >=4 fit controls and independent checks on every connector')
    matrix = _fit_photo_affine(fit)
    determinant = matrix[0]*matrix[3]-matrix[1]*matrix[2]
    expected_sign = view.get('expectedDeterminantSign')
    if expected_sign not in (-1, 1) or determinant*expected_sign <= 1e-9:
        raise PinoutBlocked('Photograph side/orientation determinant differs from the reviewed profile')
    errors = [_distance(_project(matrix, control['worldMil']), control['pixel']) for control in controls]
    if max(errors) > 1.5:
        raise PinoutBlocked('Photograph calibration differs from measured fit/check controls by more than 1.5 px')
    for pin in lookup.values():
        pin['originalPhotoPixel'] = _project(matrix, pin['worldMil'])
        if not (0 <= pin['originalPhotoPixel'][0] < image['width'] and 0 <= pin['originalPhotoPixel'][1] < image['height']):
            raise PinoutBlocked('A projected source pad lies outside the original photograph')
    return {'method': 'source-pad-net-with-independently-reviewed-photo-controls', 'view': view['side'], 'worldToPixel': matrix,
        'calibration': {'passed': True, 'maxErrorPx': max(errors), 'fitControlCount': len(fit), 'independentCheckCount': len(checks), 'photoOrientationReviewed': True},
        'controlPoints': [{**control, 'errorPx': error} for control, error in zip(controls, errors)],
        'electricalSource': 'epro2 PCB PAD_NET', 'pinNumberMapping': 'native absolute pad geometry verified against source footprint',
        'photoRevisionCaveat': view.get('revisionCaveat', '')}


def prepare_photo_pinouts(sourcePath=None, images=None, photoProfilePath=None, nativeMetaPath=None, outputDir=None,
                          productCode=None, hardwareVersion='V1.0', connectorDesignators=None, displayPlan=None, **unused):
    if isinstance(sourcePath, dict):
        return prepare_photo_pinouts(**sourcePath)
    from PIL import Image
    if not isinstance(productCode, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,100}', productCode):
        raise PinoutBlocked('productCode must be a safe explicit product identifier')
    if not isinstance(hardwareVersion, str) or not re.fullmatch(r'V?[0-9]+(?:\.[0-9]+){0,3}', hardwareVersion):
        raise PinoutBlocked('hardwareVersion must be an explicit version such as V1.0')
    if not isinstance(images, list) or len(images) != 2 or {item.get('side') for item in images} != {'front', 'back'}:
        raise PinoutBlocked('Both actual front and back photographs are required')
    source_facts = extract_pinout_facts(sourcePath, connectorDesignators)
    if displayPlan is not None:
        displayPlan = validate_display_plan(displayPlan, source_facts)
    profile_path = Path(photoProfilePath).expanduser().resolve()
    profile_bytes = profile_path.read_bytes()
    profile = json.loads(profile_bytes)
    if profile.get('format') != 'workbench-pinout-photo-calibration' or profile.get('version') != 1 or profile.get('sourceSha256') != source_facts['source']['sha256'] or profile.get('pcbUuid') != source_facts['pcbUuid']:
        raise PinoutBlocked('Reviewed photograph profile is not bound to this exact epro2/PCB')
    views = profile.get('views', [])
    if len(views) != 2 or {item.get('side') for item in views} != {'front', 'back'} or {item.get('expectedDeterminantSign') for item in views} != {-1, 1}:
        raise PinoutBlocked('Photo profile must contain independently calibrated opposite front/back views')
    native_payload = json.loads(Path(nativeMetaPath).expanduser().read_text(encoding='utf-8'))
    native = native_payload.get('pinoutEvidence', native_payload)
    if not native.get('componentPads') and native_payload.get('componentPads'):
        native = {**native, 'componentPads': native_payload['componentPads']}
    output = Path(outputDir).expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    results = []
    for side in ('front', 'back'):
        import copy
        facts = copy.deepcopy(source_facts)
        item = next(item for item in images if item['side'] == side)
        view = next(view for view in views if view['side'] == side)
        original = Path(item['path']).expanduser().resolve()
        data = original.read_bytes()
        if not re.fullmatch(r'[a-f0-9]{64}', str(item.get('sha256', ''))) or _sha(data) != item['sha256']:
            raise PinoutBlocked('Photograph input SHA256 does not match the exact supplied original')
        with Image.open(original) as photo:
            if photo.format not in ('PNG', 'JPEG') or photo.width*photo.height > 32_000_000:
                raise PinoutBlocked('Photographs must be bounded PNG or JPEG images')
            info = {'path': str(original), 'sha256': _sha(data), 'bytes': len(data), 'width': photo.width, 'height': photo.height}
            alignment = validate_photo_alignment(facts, info, view, native)
            # Remove only fully transparent margins; no geometric warping,
            # recoloring, retouching or invented PCB imagery is permitted.
            crop = list(photo.getchannel('A').getbbox()) if 'A' in photo.getbands() else [0, 0, photo.width, photo.height]
            if crop != view.get('cropBox'):
                raise PinoutBlocked('Transparent-margin crop differs from the visually reviewed profile')
            derived = photo.crop(crop).convert('RGBA')
            image_name = f'{productCode}_Pinout_{hardwareVersion}_{side}.photo.png'
            derived_path = output/image_name
            if derived_path.exists():
                raise PinoutBlocked('Refusing to overwrite existing photograph preparation')
            derived.save(derived_path, format='PNG')
        derived_bytes = derived_path.read_bytes()
        image = {**_png_info(derived_bytes), 'path': str(derived_path)}
        for connector in facts['connectors']:
            for pin in connector['pins']:
                pin['imagePixel'] = [pin['originalPhotoPixel'][0]-crop[0], pin['originalPhotoPixel'][1]-crop[1]]
                if not (0 <= pin['imagePixel'][0] < image['width'] and 0 <= pin['imagePixel'][1] < image['height']):
                    raise PinoutBlocked('A source pin lies outside the unchanged cropped photograph')
        alignment['originalWorldToPixel'] = alignment['worldToPixel'][:]
        alignment['worldToPixel'][4] -= crop[0]
        alignment['worldToPixel'][5] -= crop[1]
        alignment['cropBox'] = crop
        photo_binding = {'side': side, 'kind': 'actual-photograph', 'original': info, 'cropBox': crop,
            'transformation': 'transparent-margin-crop-only', 'derived': image,
            'profile': {'path': str(profile_path), 'sha256': _sha(profile_bytes)},
            'pixelsUnchanged': True, 'revisionCaveat': view.get('revisionCaveat', '')}
        facts.update(image=image, alignment=alignment, photoOriginal=info, photograph=photo_binding)
        project = _build_project(facts, derived_bytes, image, productCode+'_'+side, photo=True, display_plan=displayPlan)
        project['state']['imageName'] = image_name
        project['workbenchAlignment']['photograph'] = photo_binding
        facts_path = output/f'{productCode}_Pinout_{hardwareVersion}_{side}.facts.json'
        project_path = output/f'{productCode}_Pinout_{hardwareVersion}_{side}.openpinmap.json'
        result = {'side': side, 'status': 'ready', 'validated': True, 'pinCount': facts['pinCount'], 'projectPath': str(project_path),
            'factsPath': str(facts_path), 'image': image, 'alignment': alignment, 'photoOriginal': info, 'photograph': photo_binding}
        facts['preparation'] = {key: result[key] for key in ('side', 'status', 'validated', 'pinCount', 'projectPath', 'factsPath')}
        _write_new(project_path, project)
        _write_new(facts_path, facts)
        if _sha(original.read_bytes()) != info['sha256'] or _sha(profile_path.read_bytes()) != _sha(profile_bytes):
            raise PinoutBlocked('Original photograph/profile changed during preparation')
        results.append(result)
    if _sha(Path(sourcePath).expanduser().resolve().read_bytes()) != source_facts['source']['sha256']:
        raise PinoutBlocked('Electrical source changed during photograph preparation')
    return {'status': 'ready', 'validated': True, 'views': results, 'pinCount': source_facts['pinCount'],
        'source': source_facts['source'], 'photoProfile': {'path': str(profile_path), 'sha256': _sha(profile_bytes)}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--request')
    args = parser.parse_args()
    request = json.loads(Path(args.request).read_text(encoding='utf-8')) if args.request else json.load(sys.stdin)
    try:
        print(json.dumps(prepare_pinout(request), ensure_ascii=False, allow_nan=False))
    except Exception as error:
        print(json.dumps({'status': 'blocked', 'validated': False, 'reason': str(error)}, ensure_ascii=False))
        sys.exit(1)


if __name__ == '__main__':
    main()
