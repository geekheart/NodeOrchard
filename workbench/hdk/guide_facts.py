"""Source-bound facts for bilingual board user guides.

This module never reads a target guide, infers nets from a photograph, or treats
test accessories as fitted hardware. Reviewed photo regions are explicit input
data bound to image SHA-256; source component designators must exist in epro2.
"""
from pathlib import Path
import argparse
import copy
import datetime as dt
import hashlib
import json
import math
import re
import struct
import subprocess
import sys

try:
    from . import pinout_facts, test_firmware
except ImportError:
    import pinout_facts
    import test_firmware


class GuideFactsBlocked(ValueError):
    pass


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _read(path, maximum=50_000_000):
    if not isinstance(path, (str, Path)) or not str(path).strip():
        raise GuideFactsBlocked('Guide source path must be a nonempty filesystem path')
    file = Path(path).expanduser().resolve()
    if not file.is_file() or file.stat().st_size > maximum:
        raise GuideFactsBlocked(f'Missing or oversized guide source: {file}')
    data = file.read_bytes()
    return file, data, {'path': str(file), 'name': file.name, 'sha256': _sha(data), 'bytes': len(data)}


def _photo(value, side, component_refs):
    if isinstance(value, str):
        value = {'path': value}
    if not isinstance(value, dict) or not isinstance(value.get('regions'), list):
        raise GuideFactsBlocked('Photo input must contain a list of reviewed regions')
    file, data, info = _read(value.get('path'))
    if data[:8] != b'\x89PNG\r\n\x1a\n' or len(data) < 33:
        raise GuideFactsBlocked('Guide photo must be a real PNG')
    width, height = struct.unpack('>II', data[16:24])
    if width < 1 or height < 1 or width * height > 32_000_000:
        raise GuideFactsBlocked('Guide photo dimensions exceed budget')
    expected = value.get('sha256') or value.get('expectedSha256')
    if not value.get('regions') or len(value['regions']) > 64 or value.get('reviewStatus') != 'visually-reviewed':
        raise GuideFactsBlocked('Each source photo needs reviewed component regions before guide annotation')
    if value.get('regions') and expected != info['sha256']:
        raise GuideFactsBlocked('Reviewed photo regions require the exact image SHA-256')
    regions = []
    ids = set()
    for item in value.get('regions', []):
        if not isinstance(item, dict):
            raise GuideFactsBlocked('Photo region must be an object')
        region = dict(item)
        if not isinstance(region.get('id'), str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,79}', region['id']) or region['id'] in ids:
            raise GuideFactsBlocked('Photo region IDs must be unique')
        ids.add(region['id'])
        refs = region.get('refs', [region['ref']] if region.get('ref') else [])
        if not isinstance(refs, list) or not refs or len(set(str(ref) for ref in refs)) != len(refs) or any(not isinstance(ref, str) or ref not in component_refs for ref in refs):
            raise GuideFactsBlocked('Photo regions must cite existing source component refs')
        coordinate_space = region.pop('coordinateSpace', 'pixels')
        if coordinate_space not in ('normalized', 'pixels'):
            raise GuideFactsBlocked('Unsupported photo region coordinate space')
        scale = (width, height) if coordinate_space == 'normalized' else (1, 1)
        for key in ('x', 'y', 'w', 'h'):
            n = region.get(key)
            if isinstance(n, bool) or not isinstance(n, (int, float)) or not math.isfinite(n):
                raise GuideFactsBlocked('Photo region coordinates must be finite')
            region[key] = round(n * scale[0 if key in ('x', 'w') else 1], 3)
        if region['w'] <= 0 or region['h'] <= 0 or region['x'] < 0 or region['y'] < 0 or region['x'] + region['w'] > width or region['y'] + region['h'] > height:
            raise GuideFactsBlocked('Photo region lies outside the source image')
        region.update(refs=refs, reviewBasis='human visual inspection plus current native component/pad-net evidence')
        regions.append(region)
    return dict(info, side=side, width=width, height=height, regions=regions,
                note=value.get('note', ''), noteZh=value.get('noteZh', value.get('note', '')), noteEn=value.get('noteEn', value.get('note', '')),
                reviewStatus=value.get('reviewStatus', 'unreviewed'))


def _outline(pcb):
    paths = [(h.get('id'), b.get('path')) for h, b in pcb['records'] if h.get('type') == 'POLY' and b.get('layerId') == 11]
    if not paths:
        return {'status': 'unknown', 'note': 'No native outline primitives; do not invent dimensions'}
    if len(paths) == 1 and isinstance(paths[0][1], list) and paths[0][1][0] == 'R':
        p = paths[0][1]
        if len(p) != 7 or p[5] != 0 or p[3] <= 0 or p[4] <= 0:
            return {'status': 'unknown', 'note': 'Unsupported rotated rectangle outline'}
        width, height = p[3] * 0.0254, p[4] * 0.0254
        return {'status': 'source-derived', 'lengthMm': round(max(width, height), 3), 'widthMm': round(min(width, height), 3),
                'method': 'unrotated native rounded-rectangle dimensions', 'primitiveIds': [paths[0][0]],
                'scope': 'PCB outline only; not assembly or STEP bounding box'}
    points = []
    for _, p in paths:
        if not isinstance(p, list) or len(p) < 5 or not all(isinstance(v, (int, float)) for v in p[:2]):
            return {'status': 'unknown', 'note': 'Unsupported native outline path'}
        points.append(p[:2])
        i = 2
        while i < len(p):
            token = p[i]
            size = 3 if token == 'L' else 4 if token == 'ARC' else 0
            if not size or i + size > len(p):
                return {'status': 'unknown', 'note': 'Unsupported native outline command'}
            # An arbitrary arc may have extrema away from its endpoints. We
            # conservatively report endpoint extent rather than calling it a
            # certified mechanical dimension.
            points.append(p[i + size - 2:i + size])
            i += size
    extent = [(max(p[a] for p in points) - min(p[a] for p in points)) * 0.0254 for a in (0, 1)]
    return {'status': 'source-endpoint-envelope', 'lengthMm': round(max(extent), 3), 'widthMm': round(min(extent), 3),
            'method': 'native outline endpoint envelope, not a mechanical tolerance drawing',
            'primitiveCount': len(paths), 'scope': 'PCB outline only; verify production dimensions against native CAD'}


def _title(component, module_ref, peripherals):
    ref, part = component['designator'], component['part'] or ''
    nets = {p['net'] for p in component['pins']}
    if ref == module_ref: return ('主控模组', 'Processor module', 'module')
    if 'TYPE-C' in part.upper(): return ('USB Type-C 接口', 'USB Type-C port', 'usb')
    if any(n.startswith('DSI_DATA') for n in nets): return ('MIPI DSI 显示接口', 'MIPI DSI display connector', 'mipi-dsi')
    if any(n.startswith('CSI_DATA') for n in nets): return ('MIPI CSI 摄像头接口', 'MIPI CSI camera connector', 'mipi-csi')
    if 'DVP_PCLK' in nets: return ('DVP 摄像头接口', 'DVP camera connector', 'dvp')
    if any(p['name'] == 'DAT0' for p in component['pins']): return ('TF / microSD 卡座', 'TF / microSD card slot', 'sd')
    if re.search('2812', part, re.I): return ('可编程 RGB LED', 'Addressable RGB LED', 'rgb')
    button = next((b for b in peripherals['buttons'] if b['designator'] == ref), None)
    if button:
        return ('复位按键', 'Reset button', 'reset') if button['function'] == 'reset' else ('BOOT 按键', 'BOOT button', 'boot')
    if ref in {h['designator'] for h in peripherals['headers']} or re.search('HDGCPH|X6511|HC-PZ254', part):
        return ('扩展排针', 'Expansion header', 'header')
    if any(p['name'] in ('VIN', 'VOUT') for p in component['pins']): return ('电源稳压器', 'Voltage regulator', 'power')
    if ref.startswith('LED'): return ('指示灯', 'Indicator LED', 'indicator')
    return (part, part, 'other')


def _documents(values, source_sha):
    documents, development = [], {'physicalTestStatus': 'not-run', 'claims': []}
    for value in values:
        if isinstance(value, str): value = {'path': value, 'role': 'technical-source'}
        if not isinstance(value, dict):
            raise GuideFactsBlocked('Technical document must be a path or object')
        file, data, info = _read(value.get('path'), 100_000_000)
        role = value.get('role', 'technical-source')
        if not isinstance(role, str):
            raise GuideFactsBlocked('Technical document role must be a string')
        if role in ('target-guide', 'expected-guide', 'learning-target') or re.search(r'User[_ -]?Guide|使用指南', file.name, re.I):
            raise GuideFactsBlocked('Known-result guides belong only to the learning evaluator')
        derived_roles = {'schematic-preview', 'mechanical-preview', 'pinout', 'pinout-back', 'schematic-pdf', 'mechanical-cad', 'step'}
        allowed_roles = derived_roles | {'technical-source', 'module-datasheet', 'primary-chip-datasheet', 'companion-chip-datasheet', 'schematic', 'test-instructions', 'test-sop', 'firmware-manifest', 'build-replay', 'flash-instructions', 'vendor-provenance', 'bsp-board-notes'}
        if role not in allowed_roles:
            raise GuideFactsBlocked('Unsupported technical source role')
        if value.get('sha256') and value['sha256'] != info['sha256']:
            raise GuideFactsBlocked('Technical document SHA-256 differs from reviewed input')
        if role in derived_roles and not value.get('bindingReportPath'):
            raise GuideFactsBlocked('Derived engineering assets require a source-bound report')
        if value.get('conversionReportPath') and not value.get('bindingReportPath'):
            raise GuideFactsBlocked('Conversion evidence requires its source-bound report')
        info['role'] = role
        if value.get('bindingReportPath'):
            report_file, report_data, _ = _read(value['bindingReportPath'])
            report = json.loads(report_data)
            if not isinstance(report, dict) or report.get('status') not in ('complete', 'verified', 'ready'):
                raise GuideFactsBlocked('Imported artifact binding report has not completed successfully')
            if report.get('sourceSha256', report.get('source', {}).get('sha256')) != source_sha:
                raise GuideFactsBlocked('Imported artifact report belongs to another native board source')
            candidates = list(report.get('files', [])) + list(report.get('artifacts', []))
            candidates += report.get('schRendering', {}).get('transformation', {}).get('pages', [])
            if value.get('conversionReportPath'):
                conversion_file, conversion_data, _ = _read(value['conversionReportPath'])
                conversion = json.loads(conversion_data)
                if conversion.get('source', {}).get('sha256') not in {item.get('sha256') for item in candidates}:
                    raise GuideFactsBlocked('Conversion input is not bound to this report')
                candidates += conversion.get('artifacts', [])
                info['conversionReportPath'] = str(conversion_file)
                info['conversionReportSha256'] = _sha(conversion_data)
            def matches(item):
                path = Path(item.get('path', ''))
                if not path.is_absolute(): path = Path(report.get('outputPath', report_file.parent)) / path
                return path.resolve() == file and item.get('sha256') == info['sha256']
            if not any(matches(item) for item in candidates):
                raise GuideFactsBlocked('Imported artifact hash/path is absent from its source-bound report')
            info['binding'] = {'sourceSha256': source_sha, 'reportPath': str(report_file), 'reportSha256': _sha(report_data), 'artifactHashVerified': True}
        if value.get('pages'):
            pages = value['pages']
            if file.suffix.lower() != '.pdf' or not isinstance(pages, list) or len(pages) > 6 or any(isinstance(p, bool) or not isinstance(p, int) or p < 1 for p in pages):
                raise GuideFactsBlocked('Technical PDF excerpts need at most six explicit 1-based page numbers')
            from pypdf import PdfReader
            reader = PdfReader(file)
            if any(p > len(reader.pages) for p in pages):
                raise GuideFactsBlocked('Requested technical PDF page is absent')
            info['excerpts'] = [{'page': p, 'text': (reader.pages[p - 1].extract_text() or '')[:2200]} for p in pages]
        documents.append(info)
        if role == 'firmware-manifest':
            manifest = json.loads(data)
            if manifest.get('boardSourceSha256') != source_sha:
                raise GuideFactsBlocked('Firmware manifest does not match this native board source')
            development['firmware'] = {key: manifest.get(key) for key in ('status', 'physicalTestStatus', 'target', 'idf', 'siliconRevisionFamily')}
            development['firmware']['sourceFile'] = str(file)
            development['firmware']['sha256'] = info['sha256']
        elif role in ('build-replay', 'flash-instructions', 'bsp-board-notes'):
            text = data.decode('utf-8')
            development.setdefault('instructionSources', []).append({'role': role, 'path': str(file), 'sha256': info['sha256'], 'text': text[:9000]})
            for index, shell in enumerate(re.findall(r'```(?:sh|shell|bash)\s*\n(.*?)```', text, re.S)[:2]):
                development.setdefault('verifiedCommands', []).append({'titleZh': '已核对的构建命令' if role != 'flash-instructions' else 'C61 外接串口烧录命令（按配套说明接线）',
                    'titleEn': 'Verified build commands' if role != 'flash-instructions' else 'C61 external-UART flash command (follow wiring instructions)',
                    'shell': shell.strip(), 'scope': role, 'status': 'source-verified; not executed by guide generation',
                    'sourcePath': str(file), 'sourceSha256': info['sha256']})
        elif role == 'vendor-provenance':
            manifest = json.loads(data)
            development['vendor'] = {key: manifest.get(key) for key in ('repository', 'commit', 'board', 'files') if key in manifest}
    return documents, development


def _onboarding(value, product, target):
    if value is None: return None
    if not isinstance(value, dict) or set(value) != {'path', 'commit', 'remote'} or not isinstance(value.get('commit'), str) or not re.fullmatch(r'[a-f0-9]{40}', value['commit']):
        raise GuideFactsBlocked('BSP evidence requires a path, exact commit and repository remote')
    if not isinstance(value.get('remote'), str) or not re.fullmatch(r'https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\.git)?', value['remote']):
        raise GuideFactsBlocked('BSP repository remote must be an explicit public HTTPS GitHub URL')
    if not isinstance(value.get('path'), str) or not value['path'].strip():
        raise GuideFactsBlocked('BSP repository path must be a nonempty string')
    repo = Path(value['path']).resolve()
    def git(*args):
        result = subprocess.run(['git', '-C', str(repo), *args], capture_output=True, text=True, timeout=15)
        if result.returncode: raise GuideFactsBlocked('Pinned BSP evidence unavailable: ' + result.stderr[:300])
        return result.stdout.strip()
    commit = git('rev-parse', 'HEAD')
    if commit != value.get('commit'):
        raise GuideFactsBlocked('BSP commit differs from the reviewed source')
    remote = git('remote', 'get-url', 'origin')
    if remote.rstrip('/').removesuffix('.git') != value['remote'].rstrip('/').removesuffix('.git'):
        raise GuideFactsBlocked('BSP remote differs from reviewed repository')
    board = git('show', commit + ':components/wt_bsp/boards/' + product + '/Kconfig.projbuild')
    common = git('show', commit + ':components/wt_bsp/tools/wt_bsp_project.cmake')
    example = git('show', commit + ':examples/get-started/blink/CMakeLists.txt')
    if target not in board.lower() or 'WT_BSP_BOARD' not in common or 'wt_bsp_project.cmake' not in example:
        raise GuideFactsBlocked('BSP board target, selection environment, or example entry point not verified')
    preview = ' --preview' if target == 'esp32s31' else ''
    shell = '\n'.join([
        'git clone --recursive ' + value['remote'] + ' WT_BSP',
        'cd WT_BSP', 'git checkout ' + commit,
        'git submodule update --init --recursive',
        '# Load the matching ESP-IDF environment before continuing.',
        'WT_BSP_BOARD=' + product + ' idf.py' + preview + ' -C examples/get-started/blink build',
        '# After checking chip revision, board identity and the FUSB serial port:',
        'WT_BSP_BOARD=' + product + ' idf.py' + preview + ' -C examples/get-started/blink -p PORT flash monitor'])
    return {'repository': value['remote'], 'commit': commit,
            'minimumIdf': 'v6.1; esp32s31 preview' if target == 'esp32s31' else 'v6.0 according to vendor; this delivery compiled with v6.1',
            'target': target, 'siliconRevisionMustBeChecked': True,
            'commands': [{'titleZh': '从 BSP 获取、选板到首个 RGB 示例', 'titleEn': 'Get BSP, select the board, and run the first RGB example',
                          'shell': shell, 'scope': 'user-onboarding', 'status': 'Git tree and selection code verified; flash/monitor not run',
                          'sourcePath': str(repo), 'sourceCommit': commit}],
            'evidence': {'boardKconfigSha256': _sha(board.encode()), 'projectSelectionSha256': _sha(common.encode()), 'blinkCmakeSha256': _sha(example.encode())},
            'cautionZh': ('PORT 需替换为 FUSB 对应实际串口；上电前核对板卡与芯片版本，旧版与新版 P4 固件不得混用。示例只演示 RGB，不需要额外相机或屏幕。'
                          if target == 'esp32p4' else 'PORT 需替换为 FUSB 对应实际串口；使用 esp32s31 目标及 ESP-IDF v6.1 的 --preview 选项，烧录与当前板型匹配的固件。示例只演示 RGB，不需要额外相机或屏幕。'),
            'cautionEn': ('Replace PORT with the actual FUSB serial device. Check the board and silicon revision before flashing; do not mix legacy and newer P4 images. The RGB example requires no camera or display.'
                          if target == 'esp32p4' else 'Replace PORT with the actual FUSB serial device. Select esp32s31 and use --preview with ESP-IDF v6.1; flash firmware matching the current board. The RGB example requires no camera or display.')}


def _manual_download(value, images, interfaces, peripherals, target):
    """The SDK's physical BOOT/RESET sequence; never a C61 UART procedure."""
    if value is None: return None
    if not isinstance(value, dict) or set(value) != {'path', 'commit', 'remote'} or not re.fullmatch(r'[a-f0-9]{40}', str(value.get('commit', ''))) or value.get('remote') != 'https://github.com/espressif/esp-idf.git':
        raise GuideFactsBlocked('Manual download evidence requires an exact official ESP-IDF repository snapshot')
    if not isinstance(value.get('path'), str) or not value['path'].strip():
        raise GuideFactsBlocked('ESP-IDF source path must be a nonempty string')
    repo = Path(value['path']).resolve()
    def git(*args):
        result = subprocess.run(['git', '-C', str(repo), *args], capture_output=True, text=True, timeout=15)
        if result.returncode: raise GuideFactsBlocked('ESP-IDF source evidence is unavailable')
        return result.stdout.strip()
    if git('rev-parse', 'HEAD') != value['commit'] or git('remote', 'get-url', 'origin') != value['remote']:
        raise GuideFactsBlocked('ESP-IDF snapshot differs from reviewed download-mode documentation')
    relative = 'docs/en/get-started/establish-serial-connection.rst'
    file, data, info = _read(repo / relative)
    if git('rev-parse', value['commit'] + ':' + relative) != git('hash-object', str(file)):
        raise GuideFactsBlocked('ESP-IDF download-mode document differs from its pinned source')
    excerpt = 'press and hold the ``BOOT`` button and then press the ``RESET`` button once. After that release the ``BOOT`` button.'
    if excerpt not in data.decode('utf-8'):
        raise GuideFactsBlocked('Official BOOT/RESET sequence is absent from the supplied SDK source')
    buttons = {b['function']: b['designator'] for b in peripherals['buttons']}
    ports = {region['refs'][0] for image in images for region in image['regions'] if region.get('titleZh', '').startswith('FUSB') and len(region['refs']) == 1}
    usb = {item['ref'] for item in interfaces if item['kind'] == 'usb'}
    if not {'boot', 'reset'} <= set(buttons) or len(ports) != 1 or not ports <= usb:
        raise GuideFactsBlocked('Manual download steps need verified BOOT, RESET and FUSB references')
    port = next(iter(ports))
    url = 'https://github.com/espressif/esp-idf/blob/' + value['commit'] + '/' + relative
    info.update(role='idf-download-reference', sourceCommit=value['commit'])
    manual = {'scope': {'processor': target, 'usbFunction': 'USB Serial/JTAG', 'portLabel': 'FUSB', 'connectorRef': port,
                        'bootRef': buttons['boot'], 'resetRef': buttons['reset'], 'appliesToCompanionUart': False},
              'whenZh': '首次通过主处理器的 FUSB 烧录，或自动下载/串口连接失败时，按以下步骤进入下载模式；这不是 C61 外接 UART 的接线或烧录流程。' if target == 'esp32p4' else '首次通过 FUSB 烧录或自动下载/串口连接失败时，可按以下步骤让主处理器进入下载模式。',
              'whenEn': 'Use this sequence for first-time main-processor FUSB flashing, or when automatic download/serial connection fails. It is not the C61 external-UART programming procedure.' if target == 'esp32p4' else 'Use this sequence for first-time FUSB flashing, or when automatic download/serial connection fails, to enter the main processor download mode.',
              'stepsZh': ['使用可传输数据的 USB 线连接 FUSB（' + port + '）。', '按住 BOOT（' + buttons['boot'] + '）不放。', '保持按住 BOOT，按一下并松开 RESET（' + buttons['reset'] + '）。', '随后松开 BOOT。', '重新确认 FUSB 的实际串口名，将命令中的 PORT 替换为该串口，再按当前板型的已核对命令烧录。'],
              'stepsEn': ['Connect a data-capable USB cable to FUSB (' + port + ').', 'Press and hold BOOT (' + buttons['boot'] + ').', 'While holding BOOT, press and release RESET (' + buttons['reset'] + ') once.', 'Then release BOOT.', 'Identify the actual FUSB serial device again, replace PORT with that device, and use the verified flash command for the selected board.'],
              'sourcePath': str(file), 'sourceSha256': info['sha256'], 'sourceCommit': value['commit'], 'sourceUrl': url,
              'sourceExcerpt': excerpt, 'physicalTestStatus': 'not-run'}
    primary = {'titleZh': 'Espressif 官方下载模式与串口连接说明（固定 SDK 源码）', 'titleEn': 'Espressif download mode and serial connection (pinned SDK source)', 'url': url, 'role': info['role']}
    return manual, info, primary


def prepare_guide_facts(request):
    """Return fact-only guide input. File paths are explicit and read-only."""
    if not isinstance(request, dict):
        raise GuideFactsBlocked('Guide request must be an object')
    allowed = {'sourcePath', 'productCode', 'hardwareVersion', 'releaseDate', 'images', 'photos', 'technicalDocuments', 'bspRepository', 'sdkRepository'}
    if not {'sourcePath', 'productCode'} <= set(request) or set(request) - allowed:
        raise GuideFactsBlocked('Guide request has missing or unknown fields')
    if not isinstance(request['productCode'], str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{1,79}', request['productCode']):
        raise GuideFactsBlocked('Product code must be a safe 2–80 character identifier')
    if not isinstance(request['sourcePath'], str) or not request['sourcePath'].strip():
        raise GuideFactsBlocked('Native source path must be a nonempty string')
    version = request.get('hardwareVersion', '1.0')
    if not isinstance(version, str) or not re.fullmatch(r'\d{1,4}(?:\.\d{1,4}){1,2}', version):
        raise GuideFactsBlocked('Hardware version must be a dotted numeric version')
    release = request.get('releaseDate', dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).date().isoformat())
    try:
        if not isinstance(release, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', release) or dt.date.fromisoformat(release).isoformat() != release:
            raise ValueError()
    except ValueError:
        raise GuideFactsBlocked('Release date must be a real ISO calendar date') from None
    if not isinstance(request.get('technicalDocuments', []), list) or len(request.get('technicalDocuments', [])) > 40:
        raise GuideFactsBlocked('Technical documents must be a bounded list')
    if 'images' in request and 'photos' in request:
        raise GuideFactsBlocked('Choose images or photos, not both')
    if 'images' in request and (not isinstance(request['images'], list) or any(not isinstance(item, dict) or item.get('side') not in ('front', 'back') for item in request['images'])):
        raise GuideFactsBlocked('Images must be front/back objects')
    if 'photos' in request and (not isinstance(request['photos'], dict) or set(request['photos']) != {'front', 'back'}):
        raise GuideFactsBlocked('Photos must explicitly contain front and back')
    if 'photos' in request and any(not isinstance(value, (str, dict)) for value in request['photos'].values()):
        raise GuideFactsBlocked('Photo values must be source objects')
    source, data, docs, pcb = pinout_facts._source(request['sourcePath'])
    board = test_firmware.inspect_board(source)
    attrs = pinout_facts._attrs(pcb)
    placements = {h['id']: b for h, b in pcb['records'] if h.get('type') == 'COMPONENT'}
    source_sha = _sha(data)
    components, interfaces = [], []
    module = next(c for c in board['board']['components'] if c['designator'] == board['board']['moduleRef'])
    modules_by_net = {}
    for p in module['pins']:
        if p['net']:
            modules_by_net.setdefault(p['net'], []).append({'number': str(p['pad']), 'name': p['name']})
    for c in sorted(board['board']['components'], key=lambda c: c['designator']):
        zh, en, kind = _title(c, module['designator'], board['peripherals'])
        placement = placements.get(c['componentUuid'], {})
        item = {'ref': c['designator'], 'part': c['part'], 'titleZh': zh, 'titleEn': en, 'kind': kind,
                'sourceComponentId': c['componentUuid'], 'side': 'front' if placement.get('layerId') == 1 else 'back',
                'placementMil': {k: placement.get(k) for k in ('x', 'y', 'angle')}}
        if kind != 'other':
            item['pins'] = [{'number': str(p['pad']), 'name': p['name'], 'net': p['net'],
                             **({'modulePins': modules_by_net[p['net']]} if p['net'] in modules_by_net and p['net'] not in ('GND', '3.3V', '5V') else {})}
                            for p in c['pins']]
            if kind not in ('module', 'power', 'indicator'):
                interfaces.append(copy.deepcopy(item))
        components.append(item)
    photos = request.get('images')
    if photos is None:
        photos = [dict(value if isinstance(value, dict) else {'path': value}, side=side) for side, value in request.get('photos', {}).items()]
    images = [_photo(value, value['side'], {c['ref'] for c in components}) for value in photos]
    if {p['side'] for p in images} != {'front', 'back'} or len(images) != 2:
        raise GuideFactsBlocked('One front and one back source photo are required')
    region_ids = [r['id'] for image in images for r in image['regions']]
    if len(region_ids) != len(set(region_ids)):
        raise GuideFactsBlocked('Photo region IDs must be unique across both sides')
    documents, development = _documents(request.get('technicalDocuments', []), source_sha)
    onboarding = _onboarding(request.get('bspRepository'), request['productCode'], board['board']['primaryTarget'])
    if onboarding:
        development['onboarding'] = onboarding
        development['verifiedCommands'] = onboarding['commands'] + development.get('verifiedCommands', [])
        development.setdefault('vendor', {'repository': onboarding['repository'], 'commit': onboarding['commit']})
    download = _manual_download(request.get('sdkRepository'), images, interfaces, board['peripherals'], board['board']['primaryTarget'])
    if download:
        development['manualDownload'] = download[0]
        documents.append(download[1])
    peripherals = copy.deepcopy(board['peripherals'])
    for key in ('camera', 'display'):
        if peripherals.get(key):
            for field in ('recommendedTestSensor', 'recommendedTestPanel'):
                peripherals[key].pop(field, None)
    peripherals.pop('usb', None)
    peripherals.pop('headers', None)
    source_info = {'path': str(source), 'sha256': source_sha, 'bytes': len(data), 'pcbUuid': pcb['head']['uuid'],
                   'schematicPages': [d['head']['uuid'] for d in docs.values() if d['head'].get('docType') == 'SCH_PAGE']}
    warnings = ['No physical hardware test has been performed. Compiled firmware is not proof of a working board.',
                'Camera sensors and display panels are external accessories; connector presence does not identify a fitted sensor or panel.',
                'GPIO numbers are source module-pin names. Do not reuse another board guide pin map, chip memory capacity, or flash command.']
    warnings.extend(image['note'] for image in images if image['note'])
    return {'schemaVersion': 1, 'format': 'workbench-guide-facts', 'productCode': request['productCode'],
            'hardwareVersion': version, 'releaseDate': release,
            'source': source_info,
            'board': {k: v for k, v in board['board'].items() if k != 'components'},
            'dimensions': _outline(pcb), 'images': images, 'interfaces': interfaces, 'components': components,
            'features': peripherals, 'development': development,
            'sharedSignals': [{'net': net, 'modulePins': pins} for net, pins in modules_by_net.items() if len(pins) > 1 and net not in ('GND', '3.3V', '5V')],
            'primaryDocuments': [{'titleZh': item['name'], 'titleEn': item['name'], 'path': item['path'], 'role': item['role']} for item in documents] + ([download[2]] if download else []),
            'sourceFiles': [dict(source_info, role='native-engineering-source')] + documents + [dict({k: v for k, v in image.items() if k in ('path', 'name', 'sha256', 'bytes')}, role='source-photo-' + image['side']) for image in images],
            'warnings': warnings, 'learningIsolation': {'knownResultRead': False, 'memoryRequired': False}}


extract_guide_facts = prepare_guide_facts


def compact_skill_facts(facts):
    """Keep actual connection tables and reviewed regions, omit passive BOM noise."""
    value = copy.deepcopy(facts)
    value['components'] = [{k: v for k, v in c.items() if k not in ('sourceComponentId', 'placementMil', 'pins')}
                           for c in value['components'] if c['kind'] in ('module', 'power', 'indicator')]
    value['sourceFiles'] = [{k: item[k] for k in ('name', 'role', 'sha256', 'excerpts') if k in item} for item in value['sourceFiles']]
    value['primaryDocuments'] = [{k: item[k] for k in ('titleZh', 'titleEn', 'role') if k in item} for item in value['primaryDocuments']]
    for interface in value['interfaces']:
        interface.pop('sourceComponentId', None)
        interface.pop('placementMil', None)
    for image in value['images']:
        for region in image['regions']:
            region.pop('reviewBasis', None)
    for instruction in value['development'].get('instructionSources', []):
        instruction['text'] = instruction['text'][:6000]
        if instruction['role'] == 'bsp-board-notes':
            instruction['text'] = 'Exact shell commands are listed in development.verifiedCommands; read the cited source for sensor compatibility details.'
    if len(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()) > 52_000:
        raise GuideFactsBlocked('Compact guide facts exceed 52 KB; choose a smaller explicit technical source set')
    return value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--request', required=True)
    parser.add_argument('--output')
    parser.add_argument('--compact', action='store_true')
    args = parser.parse_args()
    value = prepare_guide_facts(json.loads(Path(args.request).read_text(encoding='utf-8')))
    if args.compact: value = compact_skill_facts(value)
    text = json.dumps(value, ensure_ascii=False, indent=2) + '\n'
    if args.output:
        Path(args.output).write_text(text, encoding='utf-8')
    else:
        sys.stdout.write(text)


if __name__ == '__main__':
    main()
