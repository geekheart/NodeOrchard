#!/usr/bin/env python3
"""Export SCH PDF and assembly STEP from an immutable epro2 copy.

This adapter has its own request/receipt contract. It deliberately does not
change the existing HDK release gate, output naming, or exporter capabilities.
"""
import argparse
import datetime as dt
import importlib.util
import io
import json
import math
from pathlib import Path
import re
import shutil
import sys
import uuid
import zipfile

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('four_files_core_exporter', ROOT / 'exporter/export_hdk.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
Blocked = core.Blocked
SCRIPT = ROOT / 'exporter/native_four_files.js'
MAX_NATIVE_BYTES = 300_000_000


class Native(core.Native):
    """Keep the proven owned-session lifecycle with a narrower export script."""
    def invoke(self, args):
        return core.Native.invoke(self, args, script=SCRIPT)


def validate_request(request):
    required = {'sourcePath', 'outputParent', 'productCode', 'hardwareVersion', 'releaseDate'}
    if not isinstance(request, dict) or set(request) != required:
        raise Blocked('原生四文件导出请求必须包含 sourcePath/outputParent/productCode/hardwareVersion/releaseDate')
    product, version, date = (request[k] for k in ('productCode', 'hardwareVersion', 'releaseDate'))
    if not isinstance(product, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,79}', product):
        raise Blocked('productCode 格式无效')
    if not isinstance(version, str) or not re.fullmatch(r'V?\d{1,3}\.\d{1,3}', version):
        raise Blocked('hardwareVersion 需要如 1.0 或 V1.0')
    version = 'V' + version.removeprefix('V')
    try:
        if not isinstance(date, str) or dt.date.fromisoformat(date).isoformat() != date:
            raise ValueError()
    except (ValueError, TypeError):
        raise Blocked('releaseDate 必须为 YYYY-MM-DD') from None
    if not all(isinstance(request[k], str) and request[k] for k in ('sourcePath', 'outputParent')):
        raise Blocked('sourcePath/outputParent 必须是路径字符串')
    source, parent = (Path(request[k]).expanduser().resolve() for k in ('sourcePath', 'outputParent'))
    if not source.is_file() or source.suffix.lower() != '.epro2':
        raise Blocked('sourcePath 必须是存在的 epro2')
    if not parent.is_dir():
        raise Blocked('outputParent 必须是已存在目录')
    return source, parent, product, version


def validate_step(data):
    """Independent Part 21 structure checks, followed later by CAD-kernel QA.

    A nonempty/renamed file is insufficient. These checks establish a complete
    exchange file with actual solid geometry; they do not certify model coverage
    or replace the converter's CAD-kernel import and visual inspection.
    """
    if not data or len(data) > MAX_NATIVE_BYTES:
        raise Blocked('STEP 为空或超过大小限额')
    try:
        text = data.decode('utf-8-sig')
    except UnicodeDecodeError:
        raise Blocked('STEP 不是可读的 Part 21 交换文件') from None
    if not text.lstrip().startswith('ISO-10303-21;') or not text.rstrip().endswith('END-ISO-10303-21;'):
        raise Blocked('STEP Part 21 起止标记不完整')
    # Ignore quoted names when checking references; #123 can be a product name.
    syntax = re.sub(r"'(?:[^']|'')*'", "''", text)
    if len(re.findall(r'\bHEADER\s*;', syntax)) != 1 or len(re.findall(r'\bDATA\s*;', syntax)) != 1 or len(re.findall(r'\bENDSEC\s*;', syntax)) != 2:
        raise Blocked('STEP 必须包含唯一完整 HEADER/DATA 段')
    schema = re.search(r'FILE_SCHEMA\s*\(\s*\(\s*\'([^\']+)\'', text)
    if not schema:
        raise Blocked('STEP 缺少 FILE_SCHEMA')
    ids = re.findall(r'(?m)^\s*#(\d+)\s*=', syntax)
    if not ids or len(ids) != len(set(ids)):
        raise Blocked('STEP 缺少实体或存在重复实体编号')
    missing = set(re.findall(r'#(\d+)', syntax)) - set(ids)
    metadata_warnings = []
    for entity_id in sorted(missing):
        owners = []
        for reference in re.finditer(r'#' + re.escape(entity_id) + r'\b', syntax):
            start = syntax.rfind(';', 0, reference.start()) + 1
            statement = syntax[start:syntax.find(';', reference.start())]
            owner = re.match(r'\s*#\d+\s*=\s*([A-Z_][A-Z0-9_]*)\s*\(', statement)
            owners.append(owner.group(1) if owner else 'unknown')
        # Native 4.1.78 can omit an APPLICATION_CONTEXT in imported switch
        # model metadata while retaining its complete B-rep. Keep native bytes
        # unchanged, expose the defect, and require the next CAD-kernel import.
        # Missing geometry/assembly references remain a hard failure.
        if not owners or any(owner not in ('DESIGN_CONTEXT', 'MECHANICAL_CONTEXT') for owner in owners):
            raise Blocked('STEP 含悬空几何或装配实体引用')
        metadata_warnings.append({'missingEntityId': entity_id, 'referencedBy': sorted(set(owners)),
            'reason': 'native export omitted a non-geometric application context; original bytes retained'})
    solids = len(re.findall(r'\b(?:MANIFOLD_SOLID_BREP|BREP_WITH_VOIDS|FACETED_BREP)\s*\(', syntax))
    if not solids:
        raise Blocked('STEP 没有实体几何')
    return {'format': 'ISO-10303-21', 'schema': schema.group(1), 'entityCount': len(ids),
        'solidCount': solids, 'assemblyOccurrenceCount': len(re.findall(r'\bNEXT_ASSEMBLY_USAGE_OCCURRENCE\s*\(', syntax)),
        'structuralChecksPassed': True, 'cadKernelReview': 'required', 'visualReview': 'required',
        'allReferencesComplete': not missing, 'geometryReferencesComplete': True, 'nativeMetadataWarnings': metadata_warnings,
        'autoGenerateModels': False, 'modelCoverage': 'native STEP-compatible component models only; not certified'}


def _write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')


def _read_native_file(value, expected):
    meta = value.get('file') if isinstance(value, dict) else None
    if not isinstance(meta, dict) or meta.get('path') != str(expected):
        raise Blocked('原生文件回执路径不属于本次导出')
    size = meta.get('bytes')
    if isinstance(size, bool) or not isinstance(size, int) or not 0 < size <= MAX_NATIVE_BYTES:
        raise Blocked('原生文件回执字节数无效')
    if expected.is_symlink() or not expected.is_file() or expected.stat().st_size != size:
        raise Blocked('原生文件不存在或磁盘字节数与回执不一致')
    return expected.read_bytes(), meta


def pdf_font_audit(data):
    """Check every selected text font, including fonts inside Form XObjects."""
    from pypdf import PdfReader
    from pypdf.generic import ContentStream
    reader = PdfReader(io.BytesIO(data))
    issues, checked, visited = [], 0, set()
    def inspect(contents, resources, location):
        nonlocal checked
        if hasattr(resources, 'get_object'):
            resources = resources.get_object()
        fonts = resources.get('/Font', {})
        if hasattr(fonts, 'get_object'):
            fonts = fonts.get_object()
        for operands, operation in ContentStream(contents, reader).operations:
            if operation != b'Tf':
                continue
            checked += 1
            name = str(operands[0])
            font = fonts.get(name)
            if font is None or name.lower() in ('/undefined', '/null'):
                issues.append({'location': location, 'font': name, 'reason': 'undefined text font resource'})
            else:
                font = font.get_object()
                if not hasattr(font, 'get') or str(font.get('/BaseFont', '')).lower() in ('/undefined', '/null'):
                    issues.append({'location': location, 'font': name, 'reason': 'undefined base font'})
        objects = resources.get('/XObject', {})
        if hasattr(objects, 'get_object'):
            objects = objects.get_object()
        for name, reference in objects.items():
            obj = reference.get_object()
            if obj.get('/Subtype') != '/Form' or id(obj) in visited:
                continue
            visited.add(id(obj))
            inspect(obj, obj.get('/Resources', resources), location + '/' + str(name))
    for index, page in enumerate(reader.pages):
        if page.get_contents() is not None:
            inspect(page.get_contents(), page['/Resources'], 'page-' + str(index + 1))
    return {'passed': not issues, 'checkedFontSelections': checked, 'missingFontSelectionCount': len(issues),
        'issues': issues[:100], 'pageCount': len(reader.pages)}


def _single_png(data):
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        return data, None
    if not data.startswith(b'PK'):
        raise Blocked('原生原理图位图不是 PNG 或 PNG 压缩包')
    core.audit_zip(data)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        names = [name for name in archive.namelist() if not name.endswith('/') and not core.is_os_metadata_path(name)]
        if len(names) != 1 or not names[0].lower().endswith('.png'):
            raise Blocked('单个原理图图页导出未返回唯一 PNG')
        return archive.read(names[0]), names[0]


def export_pdf_with_fallback(native, vector_data, *, pages, bound_args, evidence):
    """Keep good native vector PDFs; replace font-damaged ones with native pixels.

    No source text is inferred, restored or redrawn. Each original source page
    is independently bound before native PNG export. PyPDF embeds the exact
    image pixels losslessly at the original vector PDF's physical paper size.
    """
    from pypdf import PdfReader, PdfWriter
    from pypdf.generic import NameObject, DictionaryObject, NumberObject, DecodedStreamObject
    from PIL import Image
    initial_checks = core.validate_file('schematicPdf', vector_data)
    audit = pdf_font_audit(vector_data)
    if initial_checks['pageCount'] != len(pages):
        raise Blocked('原理图 PDF 图页数与输入工程不一致')
    if audit['passed']:
        return vector_data, {**initial_checks, 'fontAudit': audit}, None
    vector_path = evidence / 'schematic-vector-original.pdf'
    with vector_path.open('xb') as file:
        file.write(vector_data)
    original = PdfReader(io.BytesIO(vector_data))
    pngs = []
    for index, (page, document) in enumerate(zip(original.pages, pages)):
        width, height = float(page.mediabox.width), float(page.mediabox.height)
        if width <= 0 or height <= 0 or tuple(float(v) for v in page.mediabox.lower_left) != (0.0, 0.0):
            raise Blocked('原生原理图纸张范围无效')
        native_path = evidence / f'schematic-page-{index+1}-{document["uuid"]}.native'
        size = {'width': width/72*25.4*4, 'height': height/72*25.4*4, 'unit': 'mm'}
        value = native.invoke({'action': 'export', 'kind': 'schematicPng', 'fileName': f'schematic-page-{index+1}',
            'outputPath': str(native_path), 'documentUuid': document['uuid'], 'documentType': 'SCH_PAGE', 'pngSize': size, **bound_args})
        native_data, _ = _read_native_file(value, native_path)
        png, member = _single_png(native_data)
        png_path = evidence / f'schematic-page-{index+1}-{document["uuid"]}.png'
        with png_path.open('xb') as file:
            file.write(png)
        with Image.open(png_path) as image:
            if image.format != 'PNG':
                raise Blocked('原生原理图导出不是有效 PNG')
            image.verify()
        with Image.open(png_path) as image:
            rgb = image.convert('RGB')
            uses_alpha = 'A' in image.getbands() and image.getchannel('A').getextrema() != (255,255)
            if min(rgb.size) < 1000 or not any(low != high for low, high in rgb.getextrema()):
                raise Blocked('原生原理图 PNG 分辨率不足或没有实际图像内容')
            dpi = min(rgb.width/(width/72), rgb.height/(height/72))
            if dpi < 150:
                raise Blocked('原生原理图 PNG 的实际纸张分辨率不足 150 dpi')
            pngs.append({'documentUuid': document['uuid'], 'path': str(png_path), 'sha256': core.digest(png),
                'nativePath': str(native_path), 'nativeSha256': core.digest(native_data), 'archiveMember': member,
                'width': rgb.width, 'height': rgb.height, 'rgbPixelSha256': core.digest(rgb.tobytes()),
                'alphaPixelSha256': core.digest(image.getchannel('A').tobytes()) if uses_alpha else None,
                'paperWidthPt': width, 'paperHeightPt': height, 'effectiveDpi': dpi, 'exportOptions': value.get('exportOptions', {})})
    out = io.BytesIO()
    writer = PdfWriter()
    writer.add_metadata({'/Title': 'Source schematic - native PNG compatibility export'})
    for image in pngs:
        width, height = image['paperWidthPt'], image['paperHeightPt']
        page = writer.add_blank_page(width=width, height=height)
        with Image.open(image['path']) as opened:
            pixels = opened.convert('RGB')
            raster = DecodedStreamObject()
            raster.set_data(pixels.tobytes())
            raster.update({NameObject('/Type'): NameObject('/XObject'), NameObject('/Subtype'): NameObject('/Image'),
                NameObject('/Width'): NumberObject(pixels.width), NameObject('/Height'): NumberObject(pixels.height),
                NameObject('/ColorSpace'): NameObject('/DeviceRGB'), NameObject('/BitsPerComponent'): NumberObject(8)})
            raster = raster.flate_encode()
            if 'A' in opened.getbands() and opened.getchannel('A').getextrema() != (255,255):
                alpha = DecodedStreamObject()
                alpha.set_data(opened.getchannel('A').tobytes())
                alpha.update({NameObject('/Type'): NameObject('/XObject'), NameObject('/Subtype'): NameObject('/Image'),
                    NameObject('/Width'): NumberObject(pixels.width), NameObject('/Height'): NumberObject(pixels.height),
                    NameObject('/ColorSpace'): NameObject('/DeviceGray'), NameObject('/BitsPerComponent'): NumberObject(8)})
                raster[NameObject('/SMask')] = writer._add_object(alpha.flate_encode())
        page[NameObject('/Resources')] = DictionaryObject({NameObject('/XObject'): DictionaryObject({NameObject('/SourcePage'): writer._add_object(raster)})})
        scale = min(width/image['width'], height/image['height'])
        draw_width, draw_height = image['width']*scale, image['height']*scale
        contents = DecodedStreamObject()
        contents.set_data(f'q\n{draw_width:.12f} 0 0 {draw_height:.12f} {(width-draw_width)/2:.12f} {(height-draw_height)/2:.12f} cm\n/SourcePage Do\nQ\n'.encode('ascii'))
        page[NameObject('/Contents')] = writer._add_object(contents.flate_encode())
    writer.write(out)
    data = out.getvalue()
    checks = core.validate_file('schematicPdf', data)
    final_audit = pdf_font_audit(data)
    if not final_audit['passed'] or checks['pageCount'] != len(pngs):
        raise Blocked('兼容原理图 PDF 最终字体或图页复读失败')
    result_reader = PdfReader(io.BytesIO(data))
    for page, image in zip(result_reader.pages, pngs):
        if abs(float(page.mediabox.width)-image['paperWidthPt']) > 0.01 or abs(float(page.mediabox.height)-image['paperHeightPt']) > 0.01:
            raise Blocked('兼容 PDF 改变了源纸张尺寸')
        images = [obj.get_object() for obj in page['/Resources'].get('/XObject', {}).values() if obj.get_object().get('/Subtype') == '/Image']
        if len(images) != 1 or images[0].get('/Width') != image['width'] or images[0].get('/Height') != image['height'] or core.digest(images[0].get_data()) != image['rgbPixelSha256']:
            raise Blocked('兼容 PDF 中的原生图像像素没有无损保留')
        if image['alphaPixelSha256']:
            mask = images[0].get('/SMask')
            if mask is None or core.digest(mask.get_object().get_data()) != image['alphaPixelSha256']:
                raise Blocked('兼容 PDF 没有无损保留原生 PNG 透明度')
    transformation = {'operation': 'nativeRasterFallback', 'reason': 'Native vector PDF selects undefined text fonts and loses non-ASCII character encoding.',
        'originalVectorPath': str(vector_path), 'originalVectorSha256': core.digest(vector_data), 'originalFontAudit': audit,
        'pages': pngs, 'imagePixelsUnchanged': True, 'paperSizesUnchanged': True, 'textReconstruction': False,
        'outputSha256': core.digest(data), 'visualCheckStatus': 'required',
        'note': 'Raster PDF contains the actual source-page PNG pixels; text is not selectable. No invented text or source geometry edits.'}
    return data, {**checks, 'fontAudit': final_audit, 'visualCheckStatus': 'required'}, transformation


def _pinout_evidence(raw, source_sha, pcb_uuid, image_path):
    """Calibrate actual native canvas pixels against independently drawn pads.

    Public indicator markers are temporary view overlays, not PCB primitives.
    Their measured pixel centres establish the transform; a fourth pad is held
    out to check it. The clean image must be exactly restored after removal.
    """
    from PIL import Image, ImageChops
    data, _ = _read_native_file({'file': raw.get('image')}, image_path)
    with Image.open(image_path) as opened:
        if opened.format != 'PNG':
            raise Blocked('原生 PCB 底图不是 PNG')
        base = opened.convert('RGB')
    final_path = Path(str(image_path) + '.after.png')
    _read_native_file({'file': raw.get('finalImage')}, final_path)
    with Image.open(final_path) as opened:
        final = opened.convert('RGB')
    if final.size != base.size or ImageChops.difference(base, final).getbbox() is not None:
        raise Blocked('临时标记移除后 PCB 底图未恢复，不能建立稳定的 Pinout 映射')
    controls = []
    calibration = raw.get('calibration', [])
    if len(calibration) < 4 or raw.get('markerFrame') != 'data':
        raise Blocked('需要至少四个原生 PCB 数据坐标的独立像素校准点')
    for index, record in enumerate(calibration):
        path = Path(str(image_path) + f'.control-{index}.png')
        _read_native_file({'file': record.get('image')}, path)
        with Image.open(path) as opened:
            marked = opened.convert('RGB')
        if marked.size != base.size:
            raise Blocked('校准截图尺寸发生变化')
        difference = ImageChops.difference(base, marked)
        box = difference.getbbox()
        if not box or not 2 <= box[2] - box[0] <= 32 or not 2 <= box[3] - box[1] <= 32:
            raise Blocked('未检测到独立、局部的原生焊盘校准标记')
        point = record.get('point', {})
        if not all(isinstance(point.get(k), (int, float)) and not isinstance(point[k], bool) and math.isfinite(point[k]) for k in ('x', 'y')):
            raise Blocked('原生校准焊盘坐标无效')
        controls.append({'world': [point['x'], point['y']], 'pixel': [(box[0]+box[2]-1)/2, (box[1]+box[3]-1)/2],
            'designator': point.get('designator'), 'padNumber': point.get('number'), 'net': point.get('net'),
            'primitiveId': point.get('primitiveId'), 'markerImagePath': str(path)})
    (x1, y1), (x2, y2), (x3, y3) = [c['world'] for c in controls[:3]]
    determinant = (x2-x1)*(y3-y1)-(x3-x1)*(y2-y1)
    if abs(determinant) < 1e-6:
        raise Blocked('原生校准点共线')
    def solve(axis):
        z1, z2, z3 = [c['pixel'][axis] for c in controls[:3]]
        px = ((z2-z1)*(y3-y1)-(z3-z1)*(y2-y1))/determinant
        py = ((x2-x1)*(z3-z1)-(x3-x1)*(z2-z1))/determinant
        return px, py, z1-px*x1-py*y1
    a, c, e = solve(0)
    b, d, f = solve(1)
    errors = [math.hypot(a*control['world'][0]+c*control['world'][1]+e-control['pixel'][0],
        b*control['world'][0]+d*control['world'][1]+f-control['pixel'][1]) for control in controls]
    if a <= 0 or d >= 0 or abs(b) > 1e-6 or abs(c) > 1e-6 or max(errors) > 1.5:
        raise Blocked('原生顶视图的仿射方向或独立校准误差不符合要求')
    grouped = {}
    for pad in raw.get('pads', []):
        key = (pad.get('componentId'), pad.get('designator'))
        group = grouped.setdefault(key, {'componentId': key[0], 'designator': key[1], 'pads': []})
        group['pads'].append({k: pad.get(k) for k in ('parentComponentId', 'primitiveId', 'number', 'net', 'layer', 'x', 'y')})
    return {'status': 'ready', 'sourceSha256': source_sha, 'pcbUuid': pcb_uuid, 'view': 'top',
        'coordinateFrame': 'pcb-data-mil', 'projection': 'native PCB editor orthographic top view',
        'image': {'path': str(image_path), 'sha256': core.digest(data), 'bytes': len(data), 'width': base.width, 'height': base.height},
        'worldToPixel': [a, b, c, d, e, f], 'controlPoints': controls, 'componentPads': list(grouped.values()),
        'calibration': {'passed': True, 'method': 'native public temporary indicator-marker pixel differencing',
            'fitControlCount': 3, 'independentCheckCount': len(controls)-3, 'maxErrorPx': max(errors),
            'cleanImageRestored': True}, 'rawEvidencePath': str(image_path.parent / 'pinout-native-raw.json')}


def export_native(request, execute=False, executable=core.CLI):
    source, parent, product, version = validate_request(request)
    origin = core.source_info(source)
    names = {'schematicPdf': f'{product}_SCH_{version}.pdf', 'step': f'{product}_3D_{version}.step'}
    report = {'schemaVersion': 1, 'status': 'preflight', 'source': origin,
        'request': {k: request[k] for k in ('productCode', 'hardwareVersion', 'releaseDate', 'outputParent')},
        'outputPath': None, 'evidencePath': None, 'names': names, 'artifacts': [], 'checks': {}, 'warnings': [], 'errors': []}
    if not execute:
        return report
    output = parent / f'{product}_四文件_{version}_{uuid.uuid4().hex}'
    output.mkdir(mode=0o700)
    evidence = output / '.native-evidence'
    evidence.mkdir(mode=0o700)
    report.update(outputPath=str(output), evidencePath=str(evidence), reportPath=str(evidence / 'export-report.json'))
    copy = evidence / 'input.epro2'
    shutil.copyfile(source, copy)
    if core.digest(copy.read_bytes()) != origin['sha256']:
        raise Blocked('隔离副本哈希与原始输入不一致')
    native = Native(executable, evidence)
    before = {}
    targets = [('PCB', origin['pcb']['uuid'])] + [('SCH_PAGE', p['uuid']) for p in origin['pages']]
    try:
        report['session'] = native.open(copy)
        project_uuid = report['session']['importedProject']['uuid']
        bound_args = {'expectedProjectUuid': project_uuid}
        inspection = native.invoke({'action': 'inspect', 'expectedPcbUuid': origin['pcb']['uuid'], **bound_args})
        report['nativeProject'] = inspection
        if inspection.get('project', {}).get('uuid') != project_uuid:
            raise Blocked('当前工程不是本次隔离导入副本')
        if {p.get('uuid') for p in inspection.get('pcbs', [])} != {origin['pcb']['uuid']} or {p['uuid'] for p in origin['pages']} != {p.get('uuid') for p in inspection.get('pages', [])}:
            raise Blocked('导入副本的 PCB/原理图文档 UUID 与输入归档不一致')
        if not inspection.get('pcbNativeReady'):
            report['warnings'].append('本机 ready 接口返回 false；以匹配的 DOCHEAD、实际源码与导出文件作为可观测判据。')
        for dtype, uid in targets:
            value = native.invoke({'action': 'source', 'documentUuid': uid, 'documentType': dtype, **bound_args})
            text = value.pop('source')
            before[uid] = text
            (evidence / f'{dtype}-{uid}-before.source').write_text(text, encoding='utf-8')
        # Export large geometry first; each file has its own failure receipt.
        for kind in ('step', 'schematicPdf'):
            dtype, target = ('PCB', origin['pcb']) if kind == 'step' else ('SCH_PAGE', origin['pages'][0])
            native_path = evidence / (kind + '.native')
            try:
                value = native.invoke({'action': 'export', 'kind': kind, 'fileName': Path(names[kind]).stem,
                    'outputPath': str(native_path), 'documentUuid': target['uuid'], 'documentType': dtype, **bound_args})
                data, meta = _read_native_file(value, native_path)
                native_sha = core.digest(data)
                if kind == 'schematicPdf':
                    data, transformation = core.unpack_native_pdf(data)
                    native_pdf_transformation = transformation
                    data, checks, transformation = export_pdf_with_fallback(native, data,
                        pages=inspection['pages'], bound_args=bound_args, evidence=evidence)
                    if native_pdf_transformation:
                        checks['nativePdfUnpacking'] = native_pdf_transformation
                    if transformation:
                        checks['transformation'] = transformation
                        report['warnings'].append('原生矢量 SCH 存在缺失字体；已改用同一源图页的原生 PNG 无损封装 PDF，保留原矢量证据。')
                else:
                    checks = validate_step(data)
                destination = output / names[kind]
                with destination.open('xb') as f:
                    f.write(data)
                if core.digest(destination.read_bytes()) != core.digest(data):
                    raise Blocked('写入后的产物哈希不一致')
                checks['passed'] = True
                report['artifacts'].append({'kind': kind, 'path': str(destination), 'relativePath': names[kind],
                    'bytes': len(data), 'sha256': core.digest(data), 'nativeSha256': native_sha,
                    'nativeFileName': meta.get('name'), 'nativePath': str(native_path), 'checks': checks,
                    'exportOptions': value.get('exportOptions', {})})
            except Exception as error:
                report['errors'].append({'kind': kind, 'message': str(error)})
                if native.uncertain:
                    break
        if not native.uncertain:
            try:
                image_path = evidence / 'pcb-top.png'
                raw_image = native.invoke({'action': 'image', 'outputPath': str(image_path),
                    'documentUuid': origin['pcb']['uuid'], **bound_args})
                _write_json(evidence / 'pinout-native-raw.json', raw_image)
                report['pinoutEvidence'] = _pinout_evidence(raw_image, origin['sha256'], origin['pcb']['uuid'], image_path)
                meta_path = evidence / 'pinout-native-metadata.json'
                _write_json(meta_path, report['pinoutEvidence'])
                report['pinoutEvidence']['metadataPath'] = str(meta_path)
            except Exception as error:
                report['pinoutEvidence'] = {'status': 'blocked', 'reason': str(error)}
                report['warnings'].append('Pinout 原生底图校准未完成：' + str(error))
        if not native.uncertain:
            for dtype, uid in targets:
                value = native.invoke({'action': 'source', 'documentUuid': uid, 'documentType': dtype, **bound_args})
                after = value.pop('source')
                (evidence / f'{dtype}-{uid}-after.source').write_text(after, encoding='utf-8')
                unchanged = core.stable_source(before[uid]) == core.stable_source(after)
                report['checks'].setdefault('documentSource', []).append({'uuid': uid, 'docType': dtype,
                    'beforeSha256': core.digest(before[uid].encode()), 'afterSha256': core.digest(after.encode()), 'recordsUnchanged': unchanged})
                if not unchanged:
                    report['errors'].append({'kind': 'sourceIntegrity', 'message': f'导出前后有效文档记录变化：{uid}'})
    except Exception as error:
        report['nativeStage'] = getattr(native, 'stage', 'unknown')
        report['errors'].append({'kind': 'native', 'stage': getattr(native, 'stage', 'unknown'), 'message': str(error)})
    finally:
        if native.session and not report.get('session'):
            report['session'] = {'sessionId': native.session, 'status': 'failed-before-inspection'}
        report['checks']['originalSourceUnchanged'] = source.is_file() and core.digest(source.read_bytes()) == origin['sha256']
        report['checks']['inputCopyUnchanged'] = copy.is_file() and core.digest(copy.read_bytes()) == origin['sha256']
        try:
            report['sessionClose'] = native.close()
        except Exception as error:
            report['warnings'].append('关闭本次专用会话失败：' + str(error))
        if native.uncertain:
            report['warnings'].append('原生操作超时，可能仍在后台；本次专用会话保留，禁止盲目重试。')
        integrity = report['checks']['originalSourceUnchanged'] and report['checks']['inputCopyUnchanged']
        documents = report['checks'].get('documentSource', [])
        integrity = integrity and len(documents) == len(targets) and all(d['recordsUnchanged'] for d in documents)
        report['status'] = 'complete' if integrity and not report['errors'] and {a['kind'] for a in report['artifacts']} == set(names) else 'blocked'
        _write_json(Path(report['reportPath']), report)
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--request', required=True)
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    try:
        result = export_native(json.loads(Path(args.request).read_text(encoding='utf-8')), execute=args.execute)
    except Exception as error:
        result = {'schemaVersion': 1, 'status': 'blocked', 'error': str(error)}
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result['status'] in ('preflight', 'complete') else 2


if __name__ == '__main__':
    sys.exit(main())
