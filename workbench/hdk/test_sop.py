"""Render and verify a production-test SOP from current facts and build evidence.

The Skill supplies a small content plan; this module owns paths, hashes and
rendering. It never builds firmware, flashes hardware or asserts physical tests.
"""
from pathlib import Path
import hashlib
import html
import json
import os
import re
import shlex
import textwrap
from urllib.parse import quote, unquote, urlsplit

SECTIONS = ('preparation', 'wiring', 'flashing', 'tests', 'troubleshooting', 'record')
HEADINGS = ('资料准备', '接线与供电', '烧录步骤', '测试步骤与判定', '故障排查', '测试记录')
SUCCESS = {'complete', 'compiled', 'success', 'built', 'passed'}
PLAN_KEYS = {'documentName', 'sections', 'testIds', 'includeArtifactHashes',
             'includeUntestedNotice', 'referencePolicy'}


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _plain(value):
    if value is None: return '未确认'
    if isinstance(value, bool): return '是' if value else '否'
    if isinstance(value, (dict, list)): return json.dumps(value, ensure_ascii=False, sort_keys=True)
    return str(value)


def _cell(value):
    return _plain(value).replace('|', '\\|').replace('\r', '').replace('\n', '<br>')


def _equipment_names(value):
    """hardwareRequired booleans mark physical execution, not equipment names."""
    if isinstance(value, str): return [value.strip()] if value.strip() else []
    if isinstance(value, list):
        return [item.strip() for item in value if isinstance(item, str) and item.strip()]
    return []


def _inside(path, root):
    candidate = Path(path).resolve()
    if not candidate.is_relative_to(root) or not candidate.is_file():
        raise ValueError(f'SOP 引用文件必须为本次交付内的现存文件：{path}')
    # Resolve the original path as well: a symlink in any segment is not evidence.
    original = Path(path).absolute()
    for part in (original, *original.parents):
        if part == root.parent: break
        if part.is_symlink(): raise ValueError('SOP 引用不得经过符号链接。')
    return candidate


def default_plan(request):
    return {'documentName': str(request['productCode']) + '测试说明.md',
            'sections': list(SECTIONS),
            'testIds': [t['id'] for t in request['firmware'].get('tests', [])],
            'includeArtifactHashes': True, 'includeUntestedNotice': True,
            'referencePolicy': 'existing-and-hash-checked'}


def validate_plan(request, plan):
    if not isinstance(plan, dict) or set(plan) != PLAN_KEYS:
        raise ValueError('测试 SOP 计划字段不符合契约。')
    if plan['documentName'] != str(request['productCode']) + '测试说明.md':
        raise ValueError('测试说明文件名必须对应当前产品。')
    sections = plan['sections']
    if not isinstance(sections, list) or not all(isinstance(s, str) for s in sections) or len(sections) != len(SECTIONS) or set(sections) != set(SECTIONS):
        raise ValueError('SOP 必须完整包含六类内容，不能重复或增加未知章节。')
    test_ids = [t['id'] for t in request['firmware'].get('tests', [])]
    if len(test_ids) != len(set(test_ids)): raise ValueError('实际固件测试 ID 不能重复。')
    if not isinstance(plan['testIds'], list) or not all(isinstance(s, str) for s in plan['testIds']) or len(plan['testIds']) != len(test_ids) or set(plan['testIds']) != set(test_ids):
        raise ValueError('SOP 测试范围必须与真实固件接口清单一致。')
    if plan['includeArtifactHashes'] is not True or plan['includeUntestedNotice'] is not True:
        raise ValueError('SOP 必须展示固件哈希和未实测状态。')
    if plan['referencePolicy'] != 'existing-and-hash-checked':
        raise ValueError('SOP 仅允许引用本次交付中存在且哈希校验通过的文件。')
    return plan


def _flatten(value, prefix=''):
    """Keep supplied facts, including uncertainty; never infer connector pinouts."""
    result = []
    if isinstance(value, dict):
        for key, item in value.items():
            name = f'{prefix}.{key}' if prefix else str(key)
            result.extend(_flatten(item, name))
    elif isinstance(value, list) and value and all(isinstance(v, dict) for v in value):
        for index, item in enumerate(value): result.extend(_flatten(item, f'{prefix}[{index}]'))
    else:
        result.append((prefix, _plain(value)))
    return result


def _connection_rows(peripherals, include_header_pins=True):
    """Human-sized wiring index; the complete raw facts remain in provenance."""
    rows = []
    def gpio(value):
        if isinstance(value, int): return 'GPIO' + str(value)
        if isinstance(value, list): return ', '.join(gpio(v) for v in value)
        return _plain(value)
    for key, item in peripherals.items():
        if key == 'rgb' and isinstance(item, dict):
            rows.append((f'RGB · {item.get("designator", "")}', f'{item.get("part", "未确认料号")} / DIN: {gpio(item.get("gpio"))} / net={item.get("net", "未确认")} / pad={item.get("pad", "未确认")}'))
        elif key == 'buttons' and isinstance(item, list):
            for button in item:
                rows.append((f'按键 · {button.get("designator", "")}', f'{button.get("function", "未确认")} / {button.get("net", "未确认")} / {gpio(button["gpio"]) if button.get("gpio") is not None else "复位使能信号"} / activeLevel={button.get("activeLevel", "未确认")}'))
        elif key in ('sd', 'camera') and isinstance(item, dict):
            connector = item.get('designator') or item.get('connector') or ','.join(item.get('connectors', []))
            rows.append((f'{key.upper()} · {connector}', str(item.get('part') or item.get('interface') or '接口') + (f' / {item["width"]}-bit / slot={item["slot"]}' if key == 'sd' and 'width' in item and 'slot' in item else '')))
            for signal, pin in item.get('pins', {}).items(): rows.append((f'  {key}.{signal}', gpio(pin)))
            for signal in ('reset', 'powerDown', 'sensorConfirmed'):
                if signal in item: rows.append((f'  {key}.{signal}', _plain(item[signal])))
        elif key == 'usb' and isinstance(item, list):
            for port in item:
                connections = []
                for pin in port.get('pins', []):
                    if pin.get('net') and pin.get('name') not in ('EH', 'SBU1', 'SBU2', 'CC1', 'CC2'):
                        connections.append(f'{pin.get("pad")}/{pin.get("name")}={pin["net"]}')
                rows.append((f'USB · {port.get("designator", "")}', '; '.join(connections)))
        elif key == 'headers' and isinstance(item, list):
            for header in item:
                name = header.get('designator', '接口')
                if include_header_pins:
                    for pin in header.get('pins', []):
                        rows.append((f'{name} · pin {pin.get("pad", "?")}', str(pin.get('net', '未确认')) + (f' / {gpio(pin["gpio"])}' if pin.get('gpio') is not None else '')))
                else: rows.append((f'排针 · {name}', f'{len(header.get("pins", []))} 个引脚；完整网名/GPIO见正文逐脚表，不能按图片观察方向猜1脚。'))
        else: rows.extend(_flatten(item, key))
    return rows


def _diagram(product, peripherals):
    rows = _connection_rows(peripherals, include_header_pins=False)
    # A vector diagram is generated from current names/nets; it is not a photo
    # or a mechanical pin-orientation drawing. Full facts remain in the table.
    display = [(key, value) for key, value in rows if value not in ('[]', '{}')]
    blocks = [(textwrap.wrap(key, width=48) or [''], textwrap.wrap(value, width=78) or ['']) for key, value in display]
    height = max(220, 110 + sum(max(len(k), len(v)) * 19 + 15 for k, v in blocks))
    fragments = [f'<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="{height}" viewBox="0 0 1200 {height}">',
        '<rect width="1200" height="100%" fill="#f8fafc"/>',
        '<style>text{font-family:Arial,"PingFang SC","Microsoft YaHei",sans-serif;fill:#172033} .v{font-family:monospace;font-size:13px} .k{font-size:14px}</style>',
        f'<text x="28" y="33" font-size="21">{html.escape(product)} · 当前网表接线索引</text>',
        '<text x="28" y="60" font-size="13">自绘示意：不表示连接器观察方向、外设电压兼容性或实际测试通过。接线前核对原理图。</text>']
    if not blocks: blocks = [(['未提供接线'], ['请先补充当前板接口事实，禁止照抄其它板图。'])]
    y = 91
    for index, (keys, values) in enumerate(blocks):
        block_height = max(len(keys), len(values)) * 19 + 10
        fragments.append(f'<rect x="28" y="{y-17}" width="1136" height="{block_height}" rx="5" fill="{("#e8eff9" if index % 2 == 0 else "#ffffff")}"/>')
        for i, key in enumerate(keys): fragments.append(f'<text class="k" x="40" y="{y+2+i*19}">{html.escape(key)}</text>')
        for i, value in enumerate(values): fragments.append(f'<text class="v" x="490" y="{y+2+i*19}">{html.escape(value)}</text>')
        y += block_height + 5
    fragments.append('</svg>')
    return '\n'.join(fragments)


def _resolve_artifacts(firmware, root):
    result = []
    artifact_root = Path(firmware.get('artifactRoot') or root).resolve()
    if not artifact_root.is_relative_to(root): raise ValueError('固件产物根目录必须属于本次交付。')
    for entry in firmware.get('artifacts', []):
        supplied = entry.get('path')
        path = Path(supplied) if supplied else artifact_root / entry.get('relativePath', '')
        if not path.is_absolute(): path = artifact_root / path
        path = _inside(path, root)
        sha = digest(path)
        if not re.fullmatch(r'[0-9a-f]{64}', str(entry.get('sha256', ''))) or sha != entry['sha256']:
            raise ValueError(f'固件文件哈希不一致：{path.name}')
        if entry.get('bytes') is not None and entry['bytes'] != path.stat().st_size:
            raise ValueError(f'固件文件大小不一致：{path.name}')
        result.append(dict(entry, path=str(path), relativePath=path.relative_to(root).as_posix(), bytes=path.stat().st_size))
    return result


def _flash_rows(firmware, artifacts, root):
    known = {a['path']: a for a in artifacts}
    rows = []
    artifact_root = Path(firmware.get('artifactRoot') or root).resolve()
    for item in (firmware.get('flash') or {}).get('offsets', []):
        offset = item.get('offset')
        try: number = int(offset, 0) if isinstance(offset, str) else int(offset)
        except (ValueError, TypeError): raise ValueError('烧录地址必须来自真实构建的有效整数。') from None
        if number < 0 or number > 0xffffffff: raise ValueError('烧录地址越界。')
        path = Path(item.get('path') or item.get('relativePath', ''))
        if not path.is_absolute(): path = artifact_root / path
        path = _inside(path, root)
        artifact = known.get(str(path))
        if artifact is None or item.get('sha256') != artifact['sha256']:
            raise ValueError('烧录表文件必须已列入同一构建并通过哈希校验。')
        rows.append({'offset': hex(number), 'path': str(path), 'sha256': artifact['sha256']})
    if len({r['offset'] for r in rows}) != len(rows): raise ValueError('烧录地址不能重复。')
    return rows


def _link(path, document_dir):
    return quote(os.path.relpath(path, document_dir).replace(os.sep, '/'), safe='/._-')


def _test_entries(tests):
    """Preserve explicit capability subtests without changing Skill testIds."""
    entries, seen = [], set()
    for index, item in enumerate(tests, 1):
        if not isinstance(item, dict) or not isinstance(item.get('id'), str) or item['id'] in seen:
            raise ValueError('测试及子测试ID必须明确且不重复。')
        seen.add(item['id']); entries.append((str(index), 3, item))
        children = item.get('subtests', [])
        if not isinstance(children, list): raise ValueError('subtests必须为数组。')
        for subindex, child in enumerate(children, 1):
            if not isinstance(child, dict) or not isinstance(child.get('id'), str) or child['id'] in seen or child.get('subtests'):
                raise ValueError('子测试必须具有唯一ID，当前支持一层明确子覆盖。')
            seen.add(child['id']); entries.append((f'{index}.{subindex}', 4, child))
    return entries


def _p4_flash_contract(firmware, artifacts, root):
    """Resolve every silicon variant and companion before any flash text exists."""
    if firmware.get('hardwareSelectionRequired') is not True:
        raise ValueError('P4烧录必须先读取实物revision，不允许省略选择契约。')
    minimum = firmware.get('minimumFlashBytes')
    if isinstance(minimum, bool) or not isinstance(minimum, int) or minimum <= 0:
        raise ValueError('P4清单缺少明确最小Flash容量。')
    manifest = _inside(firmware.get('manifestPath', ''), root)
    known = {a['path']: a for a in artifacts}
    evidence = {str(manifest): digest(manifest)}
    def pinned(path, role=None):
        path = _inside(path, root); record = known.get(str(path))
        if record is None or (role and record.get('role') != role) or digest(path) != record['sha256']:
            raise ValueError('P4变体/C61引用没有本次聚合清单的真实哈希：' + path.name)
        evidence[str(path)] = record['sha256']; return path
    canonical = json.loads(manifest.read_text(encoding='utf-8'))
    for key in ('boardSourceSha256', 'flash', 'revisionVariants', 'companion', 'minimumFlashBytes'):
        if canonical.get(key) != firmware.get(key): raise ValueError('SOP输入与本次根固件清单不一致：' + key)
    def report_at(path, target):
        path = _inside(path, root)
        if path != manifest: pinned(path, 'childFirmwareManifest')
        report = json.loads(path.read_text(encoding='utf-8'))
        if report.get('status') not in SUCCESS or report.get('target') != target or report.get('boardSourceSha256') != firmware['boardSourceSha256']:
            raise ValueError('P4变体/C61缺少同板成功构建，不能生成可烧录步骤。')
        child_artifacts = _resolve_artifacts(report, root)
        for entry in child_artifacts:
            record = known.get(entry['path'])
            if record is None or record['sha256'] != entry['sha256']:
                raise ValueError('聚合清单遗漏变体/C61产物或哈希不一致。')
        rows = _flash_rows(report, child_artifacts, root)
        if not rows: raise ValueError('变体/C61没有真实烧录布局。')
        flash = report.get('flash') or {}
        args_path = pinned(flash.get('flashArgsPath', ''))
        args = json.loads(args_path.read_text(encoding='utf-8'))
        if args.get('extra_esptool_args', {}).get('chip') != target:
            raise ValueError('真实flasher_args芯片与当前烧录入口不一致。')
        settings = args.get('flash_settings', {})
        size = str(settings.get('flash_size', ''))
        match = re.fullmatch(r'(\d+)(KB|MB)', size)
        if not match: raise ValueError('实际Flash布局没有明确容量。')
        actual_minimum = int(match[1]) * (1024 if match[2] == 'KB' else 1024*1024)
        options = args.get('write_flash_args')
        if not isinstance(options, list) or len(options) % 2: raise ValueError('实际write_flash_args结构无效。')
        accepted = {'--flash-mode': 'flash_mode', '--flash-size': 'flash_size', '--flash-freq': 'flash_freq'}
        for option, value in zip(options[::2], options[1::2]):
            if option not in accepted or value != settings.get(accepted[option]):
                raise ValueError('真实Flash设置不一致，不能猜测烧录选项。')
        expected_files = {hex(int(offset,0)): (args_path.parent / name).resolve() for offset,name in args.get('flash_files',{}).items()}
        if {r['offset']: Path(r['path']) for r in rows} != expected_files:
            raise ValueError('flasher_args的布局与固件manifest不一致。')
        merged = pinned(flash.get('mergedPath', ''))
        return {'manifestPath':str(path), 'target':target, 'rows':rows, 'flashArgsPath':str(args_path),
            'options':options, 'minimumFlashBytes':actual_minimum, 'mergedPath':str(merged),
            'mergedOffset':flash.get('mergedOffset'), 'mergedSha256':digest(merged)}
    variants = firmware.get('revisionVariants')
    if not isinstance(variants, list) or len(variants) < 2:
        raise ValueError('P4必须提供完整的互斥硅片版本构建，不能只显示legacy。')
    selected, families, ranges, paths = [], set(), [], set()
    for variant in variants:
        family, low, high = variant.get('family'), variant.get('minRevision'), variant.get('maxRevision')
        if not isinstance(family,str) or not re.fullmatch(r'[A-Za-z0-9_-]+', family) or family in families:
            raise ValueError('P4硅片变体名称无效或重复。')
        if any(isinstance(v,bool) or not isinstance(v,int) for v in (low,high)) or not (0 <= low <= high <= 65535):
            raise ValueError('P4硅片范围必须为实际构建revision整数。')
        if any(low <= b and a <= high for a,b in ranges): raise ValueError('P4硅片范围重叠，无法安全选择。')
        item = report_at(variant.get('manifestPath',''), 'esp32p4')
        if item['manifestPath'] in paths or item['minimumFlashBytes'] != minimum:
            raise ValueError('P4变体重复引用同一构建或最小Flash与布局不符。')
        item.update(family=family,minRevision=low,maxRevision=high)
        selected.append(item); families.add(family); ranges.append((low,high)); paths.add(item['manifestPath'])
    companion = firmware.get('companion') or {}
    if companion.get('status') not in SUCCESS or companion.get('target') != 'esp32c61':
        raise ValueError('P4缺少独立C61成功构建。')
    c61 = report_at(companion.get('manifestPath',''), 'esp32c61')
    revision_guides = [a for a in artifacts if a.get('role') == 'revisionSelectionGuide']
    companion_guides = [a for a in artifacts if a.get('role') == 'companionFlashGuide']
    if len(revision_guides) != 1 or len(companion_guides) != 1:
        raise ValueError('缺少唯一的P4硅片选择指南或C61烧录说明。')
    selection_guide = pinned(revision_guides[0]['path'], 'revisionSelectionGuide')
    companion_guide = pinned(companion_guides[0]['path'], 'companionFlashGuide')
    return {'variants':selected,'companion':c61,'minimumFlashBytes':minimum,
        'selectionGuide':str(selection_guide),'companionGuide':str(companion_guide),
        'evidence':[{'path':Path(p).relative_to(root).as_posix(),'sha256':sha} for p,sha in sorted(evidence.items())]}


def _revision_label(value):
    return f'v{value//100}.{value%100}'


def _layout_text(item, output, port, *, c61=False):
    lines = ['| 目标地址 | 本构建文件 | SHA-256 |', '| --- | --- | --- |']
    arguments = []
    for row in item['rows']:
        relative = os.path.relpath(row['path'],output)
        lines.append(f'| `{row["offset"]}` | [{_cell(relative)}]({_link(row["path"],output)}) | `{row["sha256"]}` |')
        arguments += [row['offset'],shlex.quote(relative)]
    pre = ' --before no-reset --after no-reset' if c61 else ''
    lines += ['', '仅在此分支的芯片、revision及容量条件已经核对后执行：', '', '```sh',
        f'python -m esptool --chip {item["target"]} --port {port} --baud 115200{pre} write-flash '+shlex.join(item['options'])+' '+' '.join(arguments),
        '```', '', f'本分支构建清单：[manifest]({_link(item["manifestPath"],output)})；原生参数：[flasher_args]({_link(item["flashArgsPath"],output)})。',
        f'合并镜像仅供已选择此分支时使用：[{_cell(os.path.relpath(item["mergedPath"],output))}]({_link(item["mergedPath"],output)})，地址 `{item["mergedOffset"]}`，SHA-256 `{item["mergedSha256"]}`。']
    return lines


def _p4_flashing(contract, output):
    lines = ['## 烧录步骤', '', '### 先核实硅片revision与Flash，再选择P4固件', '',
        '**PCB硬件版本/目录V1.0不是芯片silicon revision。未读取实物信息前禁止选择或烧录任一P4镜像，不使用 `--force`。**', '',
        '先在P4下载接口识别实际串口，用本次SDK的esptool读取并保存下面两条结果：', '', '```sh',
        'python -m esptool --chip esp32p4 --port P4_PORT chip-id',
        'python -m esptool --chip esp32p4 --port P4_PORT flash-id', '```', '',
        f'Flash必须至少 `{contract["minimumFlashBytes"]}` 字节（{contract["minimumFlashBytes"]//(1024*1024)} MiB）。读取失败、容量不足、报告的revision不在下表任何范围内（含当前未支持的v2.x或未知版本）均停止；不能按板名猜测。', '',
        f'先阅读本次实际文件：[P4芯片版本与烧录选择]({_link(contract["selectionGuide"],output)})。', '',
        '| 硅片revision范围 | 仅可选择的本次构建 | 最小Flash |', '| --- | --- | --- |']
    for item in contract['variants']:
        lines.append(f'| `{_revision_label(item["minRevision"])}` 至 `{_revision_label(item["maxRevision"])}` | `{item["family"]}`：[精确构建清单]({_link(item["manifestPath"],output)}) | {item["minimumFlashBytes"]} 字节 |')
    lines += ['', '下面P4分支互斥，按实物结果只执行其中一个；C61是另一颗芯片，使用后面的独立入口。', '']
    for item in contract['variants']:
        lines += [f'### P4分支 `{item["family"]}`：仅限 {_revision_label(item["minRevision"])} 至 {_revision_label(item["maxRevision"])}', '',
            f'确认 `chip-id` 的真实revision在本范围内，且 `flash-id` 不小于 {item["minimumFlashBytes"]} 字节；否则跳过本分支。', '']
        lines += _layout_text(item,output,'P4_PORT') + ['']
    item = contract['companion']
    lines += ['### C61伴随芯片：独立烧录入口', '',
        f'先按[本次C61烧录说明]({_link(contract["companionGuide"],output)})核对排针、3.3V逻辑和共地。先装已选版本的P4主固件，再执行 `c61-download` 释放共享UART，连接外部适配器。`C61_UART_PORT`是适配器端口，不能填P4 USB端口。', '',
        '```sh', 'python -m esptool --chip esp32c61 --port C61_UART_PORT --before no-reset --after no-reset chip-id',
        'python -m esptool --chip esp32c61 --port C61_UART_PORT --before no-reset --after no-reset flash-id', '```', '',
        f'必须识别为 `esp32c61` 且Flash至少 {item["minimumFlashBytes"]} 字节。它的镜像不能写入P4，P4镜像也不能写入C61。', '']
    lines += _layout_text(item,output,'C61_UART_PORT',c61=True)
    lines += ['', '烧录后先断开外接适配器TX/RX，再在P4终端输入 `link` 复位C61进入应用；按说明依次验证 `wifi` 与 `c61-fixture`。新夹具的具体接线和排除项见C61烧录说明。', '']
    return lines


def render(request, output_dir, plan=None):
    """Write SOP files once, inside the current package, and independently verify.

    request: productCode/hardwareVersion/releaseDate/packagePath/boardFacts/firmware.
    A runtime must pass the actual Skill plan. default_plan exists for local tests
    and deterministic rendering previews; it is not a learning success oracle.
    """
    if not isinstance(request, dict): raise ValueError('SOP 输入必须为对象。')
    product = str(request.get('productCode', ''))
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,95}', product): raise ValueError('产品代号无效。')
    facts, firmware = request.get('boardFacts'), request.get('firmware')
    if not isinstance(facts, dict) or not isinstance(firmware, dict): raise ValueError('SOP 必须接收当前硬件与实际构建清单。')
    source_sha = facts.get('source', {}).get('sha256')
    if not re.fullmatch(r'[0-9a-f]{64}', str(source_sha or '')): raise ValueError('缺少当前源工程的有效哈希。')
    if firmware.get('boardSourceSha256') != source_sha:
        raise ValueError('固件构建必须明确绑定当前板源工程，不能使用另一板固件。')
    targets = facts.get('board', {}).get('targets', [])
    if targets and firmware.get('target') not in targets:
        raise ValueError('固件构建目标与当前板芯片不符。')
    root = Path(request.get('packagePath', '')).resolve()
    if not request.get('packagePath') or not root.is_dir(): raise ValueError('必须指定本次交付根目录。')
    output = Path(output_dir).absolute()
    if not output.resolve().is_relative_to(root): raise ValueError('测试说明必须写入本次交付目录。')
    for part in (output, *output.parents):
        if part == root.parent: break
        if part.is_symlink(): raise ValueError('测试说明目录不得经过符号链接。')
    if plan is None: plan = default_plan(request)
    validate_plan(request, plan)
    artifacts = _resolve_artifacts(firmware, root)
    flash_rows = _flash_rows(firmware, artifacts, root)
    compiled = firmware.get('status') in SUCCESS
    if compiled and (not artifacts or not flash_rows): raise ValueError('成功构建缺少可校验文件或实际烧录布局。')
    p4_contract = _p4_flash_contract(firmware, artifacts, root) if compiled and firmware.get('target') == 'esp32p4' else None
    top_tests = {item['id']: item for item in firmware.get('tests', [])}
    ordered_tests = [top_tests[test_id] for test_id in plan['testIds']]
    test_entries = _test_entries(ordered_tests)
    pending = []
    physical = firmware.get('physicalTestStatus', 'not-run')
    if physical != 'not-run':
        # Even a caller-supplied flag needs separately signed physical records.
        pending.append('输入声称已实测但未提供可核查实测记录；本文仍按未实测交付。')
    if not compiled: pending.append('固件尚未真实编译成功；禁止按本说明烧录。')
    if not firmware.get('tests'): pending.append('固件未定义测试接口，不能判定外设测试覆盖。')
    pending.extend(str(x) for x in facts.get('warnings', []))
    pending.extend(str(x) for x in firmware.get('warnings', []))
    sections = {}
    material = ['## 资料准备', '',
        f'- 产品：`{product}`；硬件版本：`{request.get("hardwareVersion", "未确认")}`；资料日期：`{request.get("releaseDate", "未确认")}`。',
        f'- 源工程 SHA-256：`{source_sha}`。',
        f'- 构建状态：`{firmware.get("status", "未确认")}`；目标：`{firmware.get("target", "未确认")}`。',
        f'- SDK：`{_plain(firmware.get("idf", {}))}`。',
        '- **硬件实测未进行。编译成功仅说明源码通过构建；下表必须由操作员在实物上完成。**', '',
        '| 本次文件 | 用途 | 字节数 | SHA-256 |', '| --- | --- | ---: | --- |']
    for a in artifacts: material.append(f'| [{_cell(Path(a["path"]).name)}]({_link(a["path"], output)}) | {_cell(a.get("role", "构建产物"))} | {a["bytes"]} | `{a["sha256"]}` |')
    material += ['', '准备与接口对应的 USB 数据线、串口终端和下列测试器材。不得使用仅供电线或其它板型号的治具。', '']
    requirements = []
    for _, _, t in test_entries:
        requirements.extend(_equipment_names(t.get('hardwareRequired')))
    material.extend('- ' + item for item in dict.fromkeys(requirements))
    sections['preparation'] = '\n'.join(material)

    wiring = ['## 接线与供电', '',
        '断电后接线，先核对连接器位号、1 脚方向、信号电压和共地；图中的网名不是可以任意短接的跳线指令。', '',
        '![本板当前网表的自绘接线索引](images/wiring.svg)', '',
        '| 当前事实字段 | 网名 / 引脚 / 已知条件 |', '| --- | --- |']
    for key, value in _connection_rows(facts.get('peripherals', {})): wiring.append(f'| {_cell(key)} | {_cell(value)} |')
    power = facts.get('power') or facts.get('board', {}).get('power')
    if power: wiring += ['', '供电事实：`' + _plain(power) + '`。']
    else:
        wiring += ['', '**供电电压、电流限制及端口角色应按当前原理图核对；输入事实未单独给出完整供电说明，不能套用案例。**']
        pending.append('未提供单独的供电规格事实；首次上电前须按原理图核对。')
    sections['wiring'] = '\n'.join(wiring)

    flashing = ['## 烧录步骤', '']
    if p4_contract:
        flashing = _p4_flashing(p4_contract, output)
    elif compiled:
        target = firmware.get('target', '')
        if not re.fullmatch(r'esp32[a-z0-9]*', target): raise ValueError('烧录目标不是已确认的 ESP 芯片目标。')
        flashing += ['1. 将数据线连接到当前硬件事实确认的下载接口；通过设备枚举确定串口，替换下面的 `PORT`。',
            '2. 按下方真实构建布局核对文件和地址。若不能自动进入下载模式，按本板 BOOT/RESET 网表和官方文档进入下载模式。',
            '3. 在本说明所在目录运行下面命令；先用保守的 115200 波特率。烧录后复位并打开构建指定的串口终端。', '',
            '| 地址 | 同一构建文件 | SHA-256 |', '| --- | --- | --- |']
        for row in flash_rows: flashing.append(f'| `{row["offset"]}` | [{_cell(Path(row["path"]).name)}]({_link(row["path"], output)}) | `{row["sha256"]}` |')
        arguments = []
        for row in flash_rows:
            arguments.extend([row['offset'], shlex.quote(os.path.relpath(row['path'], output))])
        flashing += ['', '```sh', f'python -m esptool --chip {target} --port PORT --baud 115200 write-flash ' + ' '.join(arguments), '```', '',
            '上面使用命令行工具的真实分离镜像布局；没有引用缺失的 Windows GUI 工具包。请在安装了与本次 SDK 匹配的 esptool 的环境执行。']
    else: flashing += ['**未生成可烧录的成功构建，暂停烧录。先完成固件构建并重新生成本说明。**']
    flash_args_path = (firmware.get('flash') or {}).get('flashArgsPath')
    if flash_args_path:
        path = Path(flash_args_path)
        if not path.is_absolute(): path = Path(firmware.get('artifactRoot') or root) / path
        path = _inside(path, root)
        flashing += ['', f'原始构建烧录参数：[文件]({_link(path, output)})。']
    sections['flashing'] = '\n'.join(flashing)

    tests = ['## 测试步骤与判定', '', '所有日志模式来自本次固件清单；未列出的串口命令不能据此说明执行。', '']
    for index, level, item in test_entries:
        test_id = item['id']
        tests += [f'{"#"*level} {index}. {_plain(item.get("scope", test_id))} (`{test_id}`)', '']
        hardware = item.get('hardwareRequired')
        equipment = _equipment_names(hardware)
        if equipment: tests += ['器材：' + '、'.join(equipment), '']
        elif hardware is True:
            tests += ['本项需要在实物上执行；具体器材按本项操作步骤和接线说明准备。', '']
        steps = item.get('operatorSteps', [])
        if not isinstance(steps, list): raise ValueError('operatorSteps 必须为真实操作步骤数组。')
        if not steps:
            pending.append(f'{test_id} 缺少固件作者确认的触发步骤。')
            tests += ['**触发步骤待固件接口确认；不能从 GPIO 初始化或日志名猜测完整操作。**', '']
        else:
            tests.extend(f'{i}. {_plain(step)}' for i, step in enumerate(steps, 1)); tests.append('')
        if item.get('command'):
            tests += ['实际串口命令：', '', '```text', str(item['command']), '```', '']
        tests += ['固件定义的日志 / 判据：', '', '```text', _plain(item.get('expectedLog')), '```', '']
        if item.get('passCriteria'): tests += ['通过条件：' + _plain(item['passCriteria']), '']
        if item.get('unsupported'):
            tests += ['**本项固件尚未实现，不能计为通过。**', '']; pending.append(f'{test_id} 尚未实现。')
        tests += ['实际结果：□通过　□失败　□未测；日志证据 / 异常：________________。', '']
    sections['tests'] = '\n'.join(tests)
    sections['troubleshooting'] = '\n'.join(['## 故障排查', '',
        '| 现象 | 检查方法 |', '| --- | --- |',
        '| 没有串口或无法烧录 | 确认数据线、当前下载接口、串口占用及供电；按本板实际 BOOT/RESET 定义重新进下载模式。 |',
        '| 烧录目标不符 | 核对实际芯片与构建 target，禁止强制绕过芯片检查。 |',
        '| 重复复位、掉电或器件异常发热 | 立即断电；检查电源、短路与连接器方向，记录现象后排查。 |',
        '| 预期日志未出现或外设失败 | 核对对应测试步骤、器材、引脚与固件覆盖范围；保存完整日志，不以其它测试成功替代。 |',
        '| 未实现的摄像头/无线/接口项 | 保留未测状态；不能仅凭供电或 GPIO 初始化标记外设合格。 |'])
    record = ['## 测试记录', '',
        '| 板号/序列号 | 操作员 | 测试日期 | 固件 SHA-256 | 供电/夹具/外设型号 |',
        '| --- | --- | --- | --- | --- |', '| 待填写 | 待填写 | 待填写 | 采用上表对应固件哈希 | 待填写 |', '',
        '| 测试 ID | 实测结果 | 日志/测量记录位置 | 异常与复测 |', '| --- | --- | --- | --- |']
    for _, _, item in test_entries: record.append(f'| {_cell(item["id"])} | 未测 | 待填写 | 待填写 |')
    record += ['', '签字：________　复核：________　最终判定：□合格　□不合格　□待补测', '',
        '本文件生成时未连接实物、未烧录、未进行硬件验收。待确认项：', '']
    record.extend('- ' + x for x in dict.fromkeys(pending))
    if not pending: record.append('- 实物测试及结果记录尚待操作员完成。')
    sections['record'] = '\n'.join(record)

    output.mkdir(parents=True, exist_ok=True)
    asset_dir = output / 'images'
    if asset_dir.is_symlink(): raise ValueError('接线图目录不得为符号链接。')
    asset_dir.mkdir(exist_ok=True)
    destinations = [output / plan['documentName'], asset_dir / 'wiring.svg',
                    output / '测试依据.json', output / 'SOP验收.json']
    if any(path.exists() or path.is_symlink() for path in destinations): raise ValueError('SOP 输出已存在，禁止覆盖本次或历史资料。')
    destinations[1].write_text(_diagram(product, facts.get('peripherals', {})), encoding='utf-8')
    provenance = {'schemaVersion': 1, 'productCode': product, 'sourceSha256': source_sha,
        'physicalTestStatus': 'not-run', 'boardFacts': facts, 'firmware': firmware,
        'plan': plan, 'resolvedArtifacts': artifacts, 'flashOffsets': flash_rows,
        'pending': list(dict.fromkeys(pending)), 'p4FlashContract':p4_contract}
    destinations[2].write_text(json.dumps(provenance, ensure_ascii=False, indent=2), encoding='utf-8')
    text = f'# {product} 测试说明\n\n' + '\n\n'.join(sections[k] for k in plan['sections'])
    text += '\n\n依据：[当前硬件、构建和引用来源](测试依据.json)。\n'
    destinations[0].write_text(text, encoding='utf-8')
    result = verify(destinations[0], root, provenance)
    result.update({'schemaVersion': 1, 'markdownPath': str(destinations[0]), 'physicalTestStatus': 'not-run',
        'pending': list(dict.fromkeys(pending)), 'artifacts': [
            {'path': p.relative_to(root).as_posix(), 'sha256': digest(p), 'bytes': p.stat().st_size}
            for p in destinations[:3]]})
    destinations[3].write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    result['reportPath'] = str(destinations[3])
    return result


def verify(markdown_path, package_path, provenance=None):
    """Reopen local links and build files; a model's boolean is never accepted."""
    root = Path(package_path).resolve(); document = _inside(markdown_path, root)
    text = document.read_text(encoding='utf-8')
    if provenance is None: provenance = json.loads((document.parent / '测试依据.json').read_text(encoding='utf-8'))
    references, errors = [], []
    for value in re.findall(r'!?\[[^\]]*\]\(([^)]+)\)', text):
        url = urlsplit(value)
        if url.scheme or url.netloc:
            errors.append('文档出现未经本地清单核对的外部引用：' + value); continue
        path = (document.parent / unquote(url.path))
        try: path = _inside(path, root)
        except ValueError as error: errors.append(str(error)); continue
        references.append({'path': path.relative_to(root).as_posix(), 'sha256': digest(path)})
    for artifact in provenance.get('resolvedArtifacts', []):
        try:
            path = _inside(root / artifact['relativePath'], root)
            if digest(path) != artifact['sha256']: errors.append('构建文件在文档生成后发生变化：' + artifact['relativePath'])
        except ValueError as error: errors.append(str(error))
    contract = provenance.get('p4FlashContract')
    if contract:
        for item in contract.get('evidence', []):
            try:
                path = _inside(root / item['path'], root)
                if digest(path) != item['sha256']: errors.append('硅片选择/伴随构建证据已变化：' + item['path'])
            except ValueError as error: errors.append(str(error))
    expected_refs = {(document.parent / 'images/wiring.svg').relative_to(root).as_posix(),
                     (document.parent / '测试依据.json').relative_to(root).as_posix()}
    expected_refs.update(a['relativePath'] for a in provenance.get('resolvedArtifacts', []))
    if contract: expected_refs.update(item['path'] for item in contract.get('evidence', []))
    actual_refs = {r['path'] for r in references}
    missing_refs = expected_refs - actual_refs
    errors.extend('文档没有引用必需附件：' + relative for relative in sorted(missing_refs))
    complete = all(k in provenance.get('plan', {}).get('sections', []) for k in SECTIONS)
    complete = complete and all(re.search(r'^## ' + re.escape(h) + r'\s*$', text, re.MULTILINE) for h in HEADINGS)
    main_tests = provenance.get('firmware', {}).get('tests', [])
    ids = {t['id'] for t in main_tests}
    all_test_ids = {item['id'] for _,_,item in _test_entries(main_tests)}
    ids_match = set(provenance.get('plan', {}).get('testIds', [])) == ids
    ids_match = ids_match and all(f'(`{test_id}`)' in text and f'| {_cell(test_id)} | 未测 |' in text for test_id in all_test_ids)
    checks = {'localReferencesExist': not errors, 'artifactHashesMatch': not errors,
              'requiredSectionsPresent': complete,
              'testIdsMatchManifest': ids_match,
              'physicalTestNotClaimed': provenance.get('physicalTestStatus') == 'not-run' and '硬件实测未进行' in text}
    if provenance.get('firmware', {}).get('target') == 'esp32p4' and provenance.get('firmware', {}).get('status') in SUCCESS:
        start = text.find('## 烧录步骤'); first_write = text.find('write-flash', start)
        chip = text.find('--chip esp32p4 --port P4_PORT chip-id', start)
        capacity = text.find('--chip esp32p4 --port P4_PORT flash-id', start)
        checks['siliconSelectionBeforeWrite'] = bool(contract and start >= 0 and chip >= 0 and capacity >= 0 and chip < first_write and capacity < first_write)
        checks['allVariantAndCompanionEntrypoints'] = bool(contract and all(f'### P4分支 `{v["family"]}`' in text for v in contract['variants']) and '### C61伴随芯片：独立烧录入口' in text)
    return {'status': 'complete' if all(checks.values()) else 'failed',
            'checks': checks, 'references': references, 'errors': errors}


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(); parser.add_argument('--request', required=True)
    parser.add_argument('--output-dir', required=True); parser.add_argument('--plan')
    args = parser.parse_args()
    request = json.loads(Path(args.request).read_text(encoding='utf-8'))
    plan = json.loads(Path(args.plan).read_text(encoding='utf-8')) if args.plan else None
    print(json.dumps(render(request, args.output_dir, plan), ensure_ascii=False))
