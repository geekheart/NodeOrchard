"""Measure real OpenPinMap exports for evaluator-side Skill learning.

The known-result picture provides presentation features only. Electrical answers
come from the current epro2 fact preparation. No metric accepts a manifest's
``passed`` field as evidence; PNG pixels, SVG geometry and saved label text are
read again. A passing machine report still needs a human image review.
"""
from pathlib import Path
import argparse
import base64
from collections import Counter
import hashlib
import io
import json
import math
import os
import re
import statistics
import xml.etree.ElementTree as ET

from PIL import Image


DEFAULT_REFERENCE = Path(os.environ.get('WORKBENCH_HDK_PINOUT_REFERENCE',
    Path(os.environ.get('WORKBENCH_HDK_SOURCE_ROOT', Path.home() / 'Documents/文档整理')).expanduser()
    / 'WT9932S31-TINY_Pinout_V1.0.png')).expanduser()
NS = '{http://www.w3.org/2000/svg}'


def _sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _median(values, default=0):
    return statistics.median(values) if values else default


def _components(mask):
    """Connected opaque components using row runs, with no optional cv library."""
    width, height = mask.size
    data = mask.tobytes()
    parents, rows = [], []

    def find(value):
        while parents[value] != value:
            parents[value] = parents[parents[value]]
            value = parents[value]
        return value

    previous = []
    for y in range(height):
        current = []
        for match in re.finditer(b'\xff+', data[y*width:(y+1)*width]):
            left, right = match.span()
            ident = len(parents)
            parents.append(ident)
            rows.append((left, y, right, y+1, right-left))
            for start, end, parent in previous:
                if end >= left and start <= right:
                    parents[find(ident)] = find(parent)
            current.append((left, right, ident))
        previous = current
    grouped = {}
    for ident, (left, top, right, bottom, area) in enumerate(rows):
        key = find(ident)
        item = grouped.setdefault(key, {'bbox': [left, top, right, bottom], 'area': 0})
        box = item['bbox']
        box[:] = [min(box[0], left), min(box[1], top), max(box[2], right), max(box[3], bottom)]
        item['area'] += area
    return sorted(grouped.values(), key=lambda value: value['area'], reverse=True)


def png_features(path):
    with Image.open(path) as original:
        if original.format != 'PNG' or original.width*original.height > 32_000_000:
            raise ValueError('Pinout must be a bounded PNG image')
        image = original.convert('RGBA')
    histogram = image.getchannel('A').histogram()
    width, height = image.size
    components = _components(image.getchannel('A').point(lambda value: 255 if value >= 32 else 0))
    photo = components[0] if components else {'bbox': [0, 0, 0, 0], 'area': 0}
    label_boxes = [item['bbox'] for item in components[1:]
                   if item['area'] >= 100 and item['bbox'][2]-item['bbox'][0] >= (item['bbox'][3]-item['bbox'][1])*1.4]
    palette = Counter(pixel for pixel in image.get_flattened_data() if pixel[3] >= 240)
    colors = [{'hex': '#%02x%02x%02x' % color[:3], 'pixels': count}
              for color, count in palette.most_common(12)]
    return {'path': str(Path(path).resolve()), 'sha256': _sha(path), 'width': width, 'height': height,
            'aspectRatio': width/height, 'transparentFraction': sum(histogram[:16])/(width*height),
            'largestOpaqueComponent': photo, 'detachedCapsuleCount': len(label_boxes),
            'medianCapsuleWidthPx': _median([box[2]-box[0] for box in label_boxes]),
            'medianCapsuleHeightPx': _median([box[3]-box[1] for box in label_boxes]),
            'dominantOpaqueColors': colors}


def build_reference_contract(reference_png=None):
    """Extract only visual features; no S31 GPIO, pad, or board-name answer."""
    reference = png_features(reference_png or DEFAULT_REFERENCE)
    box = reference['largestOpaqueComponent']['bbox']
    board_width = box[2]-box[0]
    return {'schemaVersion': 1, 'format': 'workbench-pinout-reference-contract',
            'reference': reference,
            'measuredStyle': {'portrait': reference['height'] > reference['width'],
                              'transparentFraction': reference['transparentFraction'],
                              'photoWidthFraction': board_width/reference['width'],
                              'capsuleToPhotoWidthRatio': reference['medianCapsuleWidthPx']/max(1, board_width),
                              'palette': {'gpio': '#3498db', 'ground': '#2ecc71', 'power': '#ff0000'}},
            'requirements': {
                'portrait': True, 'transparentBackground': True,
                'minimumTransparentFraction': .15, 'maximumUpsampleFactor': 1.10,
                'maximumMainLabelCharacters': 12, 'minimumFontToPitchRatio': .48,
                'maximumCapsuleToPhotoWidthRatio': .40, 'maximumPhotoEdgeGapPx': 12,
                'maximumRowErrorPx': 2, 'maximumGuidePadErrorPx': 2,
                'sourceTracePreserved': True, 'distinguishMultipleChips': True,
                'preserveKnownControlAndUartRoles': True,
                'requireElectricalFactsFromCurrentEpro2': True},
            'interpretation': [
                'Match the compact visual method, not the reference board pin count, nets, orientation or GPIO answers.',
                'The supplied reference has no guide lines. Compact labels may omit guides; if guides exist, their actual endpoints must reach the calibrated physical pad centers.',
                'Main labels are concise user-facing names. Source connector/pad/net remain auditable separately and may not be changed by an optimizer.',
                'Preserve source-proven BOOT, EN, RX0 and TX0 roles in the concise main labels, including their chip namespace; do not abbreviate them into an undifferentiated GPIO.',
                'A small source photograph cannot become higher resolution by enlarging it. Keep native pixel scale, rather than trading away legibility for a larger bitmap.',
                'Unknown rail names stay traceable and explicitly unresolved; do not infer a voltage from appearance.'
            ]}


def build_learning_expected(contract_path=None, reference_png=None):
    contract = json.loads(Path(contract_path).read_text()) if contract_path else build_reference_contract(reference_png)
    return {'kind': 'pinout-visual-reference',
            'qualitySummary': {'passed': True, 'checks': {key: True for key in CHECK_IDS}},
            'referencePresentation': {'sha256': contract['reference']['sha256'],
                                      'measuredStyle': contract['measuredStyle'],
                                      'requirements': contract['requirements']},
            'reviewInstructions': contract['interpretation'] + [
                'Use measured actual PNG/SVG diagnostics and actual labelInventory to improve only the selected presentation Skill.',
                'Do not award a pass to a self-reported boolean, a matching hash alone, missing pictures, missing pad geometry or guessed electrical aliases.',
                'A validation image is evaluation-only; it cannot be injected into the optimizer or execution memory.'
            ]}


CHECK_IDS = ('actual-export-readable', 'transparent-portrait', 'source-photo-preserved',
             'native-photo-resolution', 'source-pin-trace', 'visible-labels-match-project',
             'concise-main-labels', 'multi-chip-disambiguation', 'reference-palette',
             'compact-readable-capsules', 'pad-row-or-guide-alignment', 'no-label-overlap-or-crop',
             'two-view-electrical-consistency')


def _matrix_multiply(a, b):
    return [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1],
            a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3],
            a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]]


def _transform(text):
    result = [1, 0, 0, 1, 0, 0]
    for name, args in re.findall(r'([A-Za-z]+)\s*\(([^)]*)\)', text or ''):
        values = [float(number) for number in re.findall(r'[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?', args)]
        if name == 'matrix' and len(values) == 6:
            matrix = values
        elif name == 'translate' and len(values) in (1, 2):
            matrix = [1, 0, 0, 1, values[0], values[1] if len(values) == 2 else 0]
        elif name == 'scale' and len(values) in (1, 2):
            matrix = [values[0], 0, 0, values[-1], 0, 0]
        elif name == 'rotate' and len(values) in (1, 3):
            angle = math.radians(values[0]); c, s = math.cos(angle), math.sin(angle)
            matrix = [c, s, -s, c, 0, 0]
            if len(values) == 3:
                x, y = values[1:]
                matrix[4], matrix[5] = x-c*x+s*y, y-s*x-c*y
        else:
            raise ValueError('Unsupported SVG transform: ' + name)
        result = _matrix_multiply(result, matrix)
    return result


def _point(matrix, point):
    return [matrix[0]*point[0]+matrix[2]*point[1]+matrix[4],
            matrix[1]*point[0]+matrix[3]*point[1]+matrix[5]]


def _number(element, name, default=0):
    return float(element.get(name, default))


def _svg_inventory(path):
    if Path(path).stat().st_size > 50_000_000:
        raise ValueError('SVG exceeds the image-evaluator budget')
    root = ET.parse(path).getroot()
    result = {'texts': [], 'rects': [], 'guides': [], 'images': []}

    def walk(element, matrix, font_size=0):
        matrix = _matrix_multiply(matrix, _transform(element.get('transform', '')))
        font_size = _number(element, 'font-size', font_size)
        kind = element.tag.removeprefix(NS)
        if kind == 'text':
            result['texts'].append({'text': ''.join(element.itertext()), 'point': _point(matrix, [_number(element, 'x'), _number(element, 'y')]),
                                    'fontSize': font_size*math.hypot(matrix[0], matrix[1]), 'fill': element.get('fill')})
        elif kind == 'rect' and '%' not in element.get('width', ''):
            x, y, w, h = (_number(element, key) for key in ('x', 'y', 'width', 'height'))
            points = [_point(matrix, point) for point in ((x, y), (x+w, y), (x, y+h), (x+w, y+h))]
            result['rects'].append({'bbox': [min(p[0] for p in points), min(p[1] for p in points), max(p[0] for p in points), max(p[1] for p in points)],
                                    'fill': element.get('fill', '').lower()})
        elif kind == 'path' and element.get('stroke'):
            numbers = [float(value) for value in re.findall(r'[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?', element.get('d', ''))]
            if not re.fullmatch(r'[MLml\d\s.,eE+\-]+', element.get('d', '')) or len(numbers) != 4:
                raise ValueError('Evaluator requires actual straight OpenPinMap guide geometry')
            result['guides'].append({'points': [_point(matrix, numbers[:2]), _point(matrix, numbers[2:])], 'stroke': element.get('stroke', '').lower()})
        elif kind == 'image':
            x, y, w, h = (_number(element, key) for key in ('x', 'y', 'width', 'height'))
            corners = [_point(matrix, [x, y]), _point(matrix, [x+w, y+h])]
            result['images'].append({'bbox': [corners[0][0], corners[0][1], corners[1][0], corners[1][1]],
                                     'href': element.get('href', element.get('{http://www.w3.org/1999/xlink}href', ''))})
        for child in element:
            walk(child, matrix, font_size)
    walk(root, [1, 0, 0, 1, 0, 0])
    return result


def _distance(a, b):
    return math.hypot(a[0]-b[0], a[1]-b[1])


def _pixel_photo_comparison(png_path, original, embedded, crop, box):
    """Recheck source/embedded pixels and real raster photo samples."""
    with Image.open(original) as source:
        expected = source.crop(crop).convert('RGBA')
    derived = Image.open(io.BytesIO(embedded)).convert('RGBA')
    if expected.size != derived.size or expected.tobytes() != derived.tobytes():
        return {'embeddedPixelsMatchOriginal': False, 'sampleCount': 0, 'meanAbsoluteRgbError': None, 'samplePassFraction': 0}
    with Image.open(png_path) as actual:
        actual = actual.convert('RGBA')
    errors = []
    for row in range(1, 25):
        for column in range(1, 13):
            sx, sy = min(derived.width-1, int(column*derived.width/13)), min(derived.height-1, int(row*derived.height/25))
            pixel = derived.getpixel((sx, sy))
            if pixel[3] < 250:
                continue
            x = min(actual.width-1, max(0, round(box[0]+(sx+.5)*(box[2]-box[0])/derived.width-.5)))
            y = min(actual.height-1, max(0, round(box[1]+(sy+.5)*(box[3]-box[1])/derived.height-.5)))
            output = actual.getpixel((x, y))
            errors.append(sum(abs(output[index]-pixel[index]) for index in range(3))/3)
    return {'embeddedPixelsMatchOriginal': True, 'sampleCount': len(errors),
            'meanAbsoluteRgbError': sum(errors)/len(errors) if errors else None,
            'samplePassFraction': sum(value <= 30 for value in errors)/len(errors) if errors else 0}


def evaluate_pinout_views(views, *, reference_contract=None):
    """Return diagnostics for actual PNG + SVG + saved-project + source facts.

    Each view: ``{side,pngPath,svgPath,projectPath,factsPath}``. ``factsPath`` must
    be the independently prepared current-epro2 facts, never model-generated.
    """
    contract = reference_contract or build_reference_contract()
    if isinstance(contract, (str, Path)):
        contract = json.loads(Path(contract).read_text())
    requirements = contract['requirements']
    checks = {key: [] for key in CHECK_IDS}
    metrics, inventory, electrical_maps = [], [], []

    def fail(key, side, message):
        checks[key].append(f'{side}: {message}')

    if not views or len(views) > 2 or any(view.get('side') not in ('front', 'back') for view in views) or len({view.get('side') for view in views}) != len(views):
        fail('two-view-electrical-consistency', 'all', 'Require one selected view or independently calibrated front and back views.')
    for view in views:
        side = view.get('side', '?')
        try:
            project = json.loads(Path(view['projectPath']).read_text())
            facts = json.loads(Path(view['factsPath']).read_text())
            png = png_features(view['pngPath'])
            svg = _svg_inventory(view['svgPath'])
            state = project['state']
            if not svg['texts'] or len(svg['images']) != 1:
                raise ValueError('Real SVG has missing labels or must contain exactly one photograph')
            photo = facts['photograph']; source_path = photo['original']['path']
            if photo.get('side') != side:
                fail('source-pin-trace', side, 'Selected view side differs from the independently calibrated source photograph.')
            if facts['source']['sha256'] != _sha(facts['source']['path']):
                fail('source-pin-trace', side, 'Current epro2 bytes differ from the independent source facts.')
            if photo['original']['sha256'] != _sha(source_path):
                fail('source-photo-preserved', side, 'Original photograph bytes changed.')
            embedded = base64.b64decode(svg['images'][0]['href'].split(',', 1)[1], validate=True)
            if svg['images'][0]['href'] != state['imageData']:
                fail('source-photo-preserved', side, 'Actual SVG embeds a different picture from the saved project.')
            export_scale = float(state.get('exportSettings', {}).get('scale', 1))
            if png['width'] != round(state['width']*export_scale) or png['height'] != round(state['height']*export_scale):
                fail('actual-export-readable', side, 'Real PNG dimensions differ from the saved project canvas and export scale.')
            image_box = [value*export_scale for value in svg['images'][0]['bbox']]
            photo_pixels = _pixel_photo_comparison(view['pngPath'], source_path, embedded, photo['cropBox'], image_box)
            if not photo_pixels['embeddedPixelsMatchOriginal'] or photo_pixels['sampleCount'] < 20 or photo_pixels['samplePassFraction'] < .90:
                fail('source-photo-preserved', side, 'Embedded source crop or actual rendered raster photo samples do not match the original photograph.')
            if png['height'] <= png['width'] or png['transparentFraction'] < requirements['minimumTransparentFraction']:
                fail('transparent-portrait', side, f"Measured {png['width']}×{png['height']}, transparent fraction {png['transparentFraction']:.3f}; require a portrait transparent PNG.")
            with Image.open(io.BytesIO(embedded)) as derived:
                upsample = max((image_box[2]-image_box[0])/derived.width, (image_box[3]-image_box[1])/derived.height)
            if upsample > requirements['maximumUpsampleFactor']:
                fail('native-photo-resolution', side, f'Actual photograph is upsampled {upsample:.3f}×; more pixels do not add photographic detail.')
            groups = state['groups']
            project_pins = [(group, pin) for group in groups for pin in group['pins']]
            actual_texts = [value['text'] for value in svg['texts']]
            expected_texts = [pin['name'] for group, pin in project_pins]
            if actual_texts != expected_texts:
                fail('visible-labels-match-project', side, 'Actual SVG main label text/order differs from the saved project pin inventory.')
            source_lookup = {(connector['designator'], str(pin['pad'])): pin for connector in facts['connectors'] for pin in connector['pins']}
            projected, row_errors, edge_gaps, label_ratios, font_ratios, boxes = [], [], [], [], [], []
            text_lookup = svg['texts']
            with Image.open(view['pngPath']) as raster:
                raster = raster.convert('RGBA')
            if len(svg['rects']) != len(project_pins):
                fail('visible-labels-match-project', side, 'Actual SVG capsule count differs from source pin count.')
            seen = set()
            for index, (group, pin) in enumerate(project_pins):
                key = (group.get('connector'), str(pin.get('_pin', '')))
                source = source_lookup.get(key)
                trace = {'side': side, 'connector': key[0], 'pad': key[1], 'sourceNet': source.get('net') if source else None,
                         'displayLabel': pin.get('name'), 'color': pin.get('color'), 'traceNet': pin.get('_net')}
                inventory.append(trace)
                if source is None or key in seen or pin.get('_net') != source.get('net'):
                    fail('source-pin-trace', side, f'{key} is missing, duplicated or its retained net differs from current epro2.')
                    continue
                seen.add(key)
                if len(pin['name']) > requirements['maximumMainLabelCharacters'] or re.search(r'\b[A-Z]+\d+\.\d+\s*[·:]', pin['name']):
                    fail('concise-main-labels', side, f"{key}: actual main label {pin['name']!r} is a long engineering trace rather than a compact user label.")
                net = source['net']
                if re.search(r'C61', net, re.I) and re.search(r'(?:IO\d|U\d|EN|BOOT)', net, re.I) and not re.search(r'C61', pin['name'], re.I):
                    fail('multi-chip-disambiguation', side, f'{key}: C61 signal lacks a C61 identifier in the visible main label.')
                chip_nets_present = any(re.search(r'C61', item['net'], re.I) for item in source_lookup.values())
                if chip_nets_present and re.fullmatch(r'IO\d+(?:_.*)?', net, re.I) and not re.search(r'P4|MAIN|主', pin['name'], re.I):
                    fail('multi-chip-disambiguation', side, f'{key}: primary-chip signal needs an explicit main-chip identity when C61 GPIOs share the photo.')
                for source_pattern, role in ((r'(?:^|_)BOOT(?:_|$)', 'BOOT'), (r'(?:^|_)EN(?:_|$)', 'EN'),
                                             (r'(?:^|_)U0RXD(?:_|$)', 'RX'), (r'(?:^|_)U0TXD(?:_|$)', 'TX')):
                    if re.search(source_pattern, net, re.I) and role not in pin['name'].upper():
                        fail('multi-chip-disambiguation', side, f'{key}: source-proven {role} role disappears from the visible main label {pin["name"]!r}.')
                color = pin.get('color', '').lower()
                role = 'ground' if re.fullmatch(r'(?:GND|GROUND|VSS)', net, re.I) else 'power' if re.fullmatch(r'(?:\+?\d+(?:\.\d+)?V\d*|V\d+|VCC|VIN|VBUS|BAT|VOUT|LDO_VO\d+)', net, re.I) else 'gpio'
                if color != contract['measuredStyle']['palette'][role]:
                    fail('reference-palette', side, f'{key}: actual {role} capsule color {color} differs from reference palette.')
                point = source['imagePixel']
                pad = [(state['imageX']+point[0]*state['imageScale']/100)*export_scale,
                       (state['imageY']+point[1]*state['imageScale']/100)*export_scale]
                projected.append(pad)
                if index >= len(svg['rects']) or index >= len(text_lookup):
                    continue
                rect = svg['rects'][index]
                box = [value*export_scale for value in rect['bbox']]; boxes.append(box)
                trace['actualLabelBox'] = box; trace['actualPadPixel'] = pad
                if rect['fill'] != color:
                    fail('visible-labels-match-project', side, f'{key}: actual SVG capsule color differs from the saved project.')
                rgb = tuple(int(color[offset:offset+2], 16) for offset in (1, 3, 5))
                fill_samples = []
                for fx, fy in ((.15, .25), (.25, .20), (.5, .15), (.75, .20), (.85, .25), (.15, .75), (.5, .85), (.85, .75)):
                    px = round(box[0]+(box[2]-box[0])*fx)
                    py = round(box[1]+(box[3]-box[1])*fy)
                    if 0 <= px < raster.width and 0 <= py < raster.height:
                        pixel = raster.getpixel((px, py))
                        fill_samples.append(pixel[3] >= 240 and max(abs(pixel[channel]-rgb[channel]) for channel in range(3)) <= 8)
                if sum(fill_samples) < 3:
                    fail('visible-labels-match-project', side, f'{key}: actual PNG does not contain its SVG capsule color at measured label positions.')
                center = [(box[0]+box[2])/2, (box[1]+box[3])/2]
                row_error = abs(center[1]-pad[1]) if group.get('layout') == 'vertical' else abs(center[0]-pad[0])
                row_errors.append(row_error)
                trace['rowErrorPx'] = row_error
                if group.get('layout') == 'vertical':
                    gap = image_box[0]-box[2] if center[0] < (image_box[0]+image_box[2])/2 else box[0]-image_box[2]
                    correct_side = box[2] <= image_box[0]+.5 if pad[0] < (image_box[0]+image_box[2])/2 else box[0] >= image_box[2]-.5
                else:
                    gap = image_box[1]-box[3] if center[1] < (image_box[1]+image_box[3])/2 else box[1]-image_box[3]
                    correct_side = box[3] <= image_box[1]+.5 if pad[1] < (image_box[1]+image_box[3])/2 else box[1] >= image_box[3]-.5
                if not correct_side:
                    fail('pad-row-or-guide-alignment', side, f'{key}: actual capsule is on the opposite side from its calibrated physical pad column.')
                edge_gaps.append(gap)
                if gap < -.5:
                    fail('no-label-overlap-or-crop', side, f'{key}: label intrudes into the photograph.')
                if gap > requirements['maximumPhotoEdgeGapPx']*export_scale and not state.get('guides'):
                    fail('pad-row-or-guide-alignment', side, f'{key}: no-guide capsule floats {gap:.1f}px away from the photo edge.')
                label_ratios.append((box[2]-box[0])/max(1, image_box[2]-image_box[0]))
                font_ratios.append(text_lookup[index]['fontSize']/max(1, group['gap']*group.get('scale', 1)))
                if min(box) < 0 or box[2] > png['width']+.5 or box[3] > png['height']+.5:
                    fail('no-label-overlap-or-crop', side, f'{key}: actual SVG capsule exceeds the final PNG bounds.')
            if seen != set(source_lookup):
                fail('source-pin-trace', side, 'Actual label trace does not cover the exact current-source connector/pad inventory.')
            if max(row_errors, default=999) > requirements['maximumRowErrorPx']*export_scale:
                fail('pad-row-or-guide-alignment', side, f'Maximum actual capsule-to-calibrated-pad row error is {max(row_errors, default=999):.2f}px.')
            guide_errors = []
            if state.get('guides'):
                if len(svg['guides']) != len(project_pins):
                    fail('pad-row-or-guide-alignment', side, 'Actual SVG lacks one physical-pad guide per pin.')
                for guide, pad in zip(svg['guides'], projected):
                    guide_errors.append(min(_distance([value*export_scale for value in point], pad) for point in guide['points']))
                if max(guide_errors, default=999) > requirements['maximumGuidePadErrorPx']*export_scale:
                    fail('pad-row-or-guide-alignment', side, f'Actual guide endpoint misses its calibrated pad by up to {max(guide_errors, default=999):.2f}px; image-edge endpoint is not pad alignment.')
            elif svg['guides']:
                fail('pad-row-or-guide-alignment', side, 'Actual SVG contains unexplained guide lines despite guides being disabled.')
            if max(label_ratios, default=999) > requirements['maximumCapsuleToPhotoWidthRatio'] or min(font_ratios, default=0) < requirements['minimumFontToPitchRatio']:
                fail('compact-readable-capsules', side, f'Actual capsule/photo width ratio max {max(label_ratios, default=999):.3f}, font/row-pitch min {min(font_ratios, default=0):.3f}.')
            for index, box in enumerate(boxes):
                for other in boxes[index+1:]:
                    if min(box[2], other[2])-max(box[0], other[0]) > .5 and min(box[3], other[3])-max(box[1], other[1]) > .5:
                        fail('no-label-overlap-or-crop', side, 'Two actual SVG capsule rectangles overlap.')
                        break
            electrical_maps.append(sorted((ref, pad, pin['net']) for (ref, pad), pin in source_lookup.items()))
            metrics.append({'side': side, 'png': {key: value for key, value in png.items() if key not in ('dominantOpaqueColors',)},
                            'photo': photo_pixels, 'upsampleFactor': upsample,
                            'actualSvgCapsules': len(svg['rects']), 'actualSvgLabels': len(svg['texts']),
                            'guidesEnabled': bool(state.get('guides')), 'guideMaxPadErrorPx': max(guide_errors, default=0),
                            'rowMaxErrorPx': max(row_errors, default=999), 'photoEdgeGapMaxPx': max(edge_gaps, default=999),
                            'capsuleToPhotoWidthRatioMax': max(label_ratios, default=999), 'fontToPitchRatioMin': min(font_ratios, default=0),
                            'files': {key: {'path': str(Path(view[key]).resolve()), 'sha256': _sha(view[key])}
                                      for key in ('pngPath', 'svgPath', 'projectPath', 'factsPath')}})
        except (KeyError, IndexError, TypeError, ValueError, OverflowError, OSError, ET.ParseError) as error:
            fail('actual-export-readable', side, str(error))
    if len(electrical_maps) != len(views) or len(electrical_maps) == 2 and electrical_maps[0] != electrical_maps[1]:
        fail('two-view-electrical-consistency', 'all', 'Front/back exported labels are not bound to the exact same current-source electrical inventory.')
    summary = {'passed': not any(checks.values()), 'checks': {key: not issues for key, issues in checks.items()}}
    diagnostics = [{'check': key, 'message': message} for key, issues in checks.items() for message in issues]
    # Deduplicate repeated row issues without discarding the raw inventory.
    diagnostics = list({(item['check'], item['message']): item for item in diagnostics}.values())
    result = {'schemaVersion': 1, 'passed': summary['passed'], 'qualitySummary': summary,
              'checks': [{'id': key, 'passed': not issues, 'issues': issues} for key, issues in checks.items()],
              'metrics': metrics, 'labelInventory': inventory, 'diagnostics': diagnostics,
              'limitations': ['Machine metrics do not prove subjective visual quality or silicon identity. Review both final PNG images before publishing.',
                              'The reference supplies presentation only; electrical pin names remain bound to current-source epro2 facts.']}
    # Full raw per-pin geometry and every issue remain in the report on disk.
    # The model comparison port has a 64 KiB budget and needs concise evidence.
    result['learningComparison'] = {
        'qualitySummary': summary,
        'metrics': [{key: value for key, value in metric.items() if key != 'files'} for metric in metrics],
        'labelInventory': [{key: item[key] for key in ('side', 'connector', 'pad', 'sourceNet', 'displayLabel', 'color', 'traceNet')} for item in inventory],
        'diagnostics': [{'check': key, 'affectedCount': len(issues), 'examples': issues[:3]} for key, issues in checks.items() if issues],
        'limitations': result['limitations']}
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=('reference', 'expected', 'evaluate'))
    parser.add_argument('--reference')
    parser.add_argument('--contract')
    parser.add_argument('--views')
    args = parser.parse_args()
    if args.operation == 'reference':
        result = build_reference_contract(args.reference)
    elif args.operation == 'expected':
        result = build_learning_expected(args.contract, args.reference)
    else:
        result = evaluate_pinout_views(json.loads(Path(args.views).read_text()), reference_contract=args.contract)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
