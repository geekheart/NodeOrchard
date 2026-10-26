"""Private full-HDK operator SOP over unchanged, source-bound build evidence.

The original SOP module remains unchanged. It still validates plans, resolved
files and flash contracts; this layer adds explicit fixture topology and moves
the complete source inventory out of the operator's first page.
"""
from pathlib import Path
import copy
import hashlib
import html
import importlib.util
import json
import os
import re
import shlex
import subprocess
import tempfile
from urllib.parse import unquote, urlsplit

from hdk import test_firmware as firmware
from hdk import companion_firmware as companion
from hdk import process_requirements as process

ROOT = Path(__file__).resolve().parents[1]
INDEX_MD = '构建文件与源码索引.md'
INDEX_JSON = '构建文件与源码索引.json'
ISOLATION = '烧录、复位、下载模式和断电前，先断开全部环回触点；不能带着闭合的环回线重新启动。'


def core_module():
    spec = importlib.util.spec_from_file_location('hdk_full_v2_sop_core', ROOT / 'hdk/test_sop.py')
    core = importlib.util.module_from_spec(spec); spec.loader.exec_module(core)
    return core


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')


def _arrays(text, prefix, count_name):
    def values(name):
        match = re.search(r'\b' + re.escape(name) + r'\[\]\s*=\s*\{([^}]*)\}', text)
        if not match or not re.fullmatch(r'\s*\d+(?:\s*,\s*\d+)*\s*', match[1]):
            raise ValueError('治具实际编译配置数组缺失：' + name)
        return [int(value.strip()) for value in match[1].split(',')]
    outs, ins = values(prefix + '_out'), values(prefix + '_in')
    count = re.search(r'^#define\s+' + re.escape(count_name) + r'\s+(\d+)\s*$', text, re.M)
    if not count or int(count[1]) != len(outs) or len(ins) != len(outs):
        raise ValueError('治具配置数量与实际编译数组不一致。')
    return [{'output': out, 'input': inp} for out, inp in zip(outs, ins)]


def _groups(connections):
    adjacency = {}
    for row in connections:
        a, b = row['output'], row['input']
        adjacency.setdefault(a, set()).add(b); adjacency.setdefault(b, set()).add(a)
    result, seen = [], set()
    for pin in sorted(adjacency):
        if pin in seen: continue
        pending, group = [pin], []
        while pending:
            current = pending.pop()
            if current in seen: continue
            seen.add(current); group.append(current); pending.extend(adjacency[current] - seen)
        result.append(sorted(group))
    return result


def fixture_contract(request, core=None):
    """Bind plans to actual manifests, generated arrays, source code and pins."""
    core = core or core_module()
    report, facts = request['firmware'], request['boardFacts']
    root = Path(request['packagePath']).resolve()
    tests = {item['id'] for _, _, item in core._test_entries(report.get('tests', []))}
    result = {'schemaVersion': 2, 'boardSourceSha256': facts['source']['sha256'],
              'physicalTestStatus': 'not-run', 'branches': [], 'sourceEvidence': []}
    if not tests.intersection({'gpio-loopback', 'companion-gpio-loopback'}): return result
    header = {(header['designator'] + '.' + str(pin['pad'])): pin
              for header in facts['peripherals']['headers'] for pin in header['pins']}

    def bind(current, target, design, pairs, config_name, prefix, count_name, source_asset):
        if current.get('boardSourceSha256') != facts['source']['sha256'] or current.get('fixtureDesign') != design:
            raise ValueError('治具设计与本次源板/实际固件清单不一致。')
        manifest = core._inside(current['manifestPath'], root)
        actual = json.loads(manifest.read_text())
        if any(actual.get(key) != current.get(key) for key in ('fixtureDesign', 'profile', 'boardSourceSha256')):
            raise ValueError('治具SOP输入不是本次真实固件清单。')
        artifacts = core._resolve_artifacts(current, root)
        known = {item['path']: item for item in artifacts}
        paths = [core._inside(Path(current['sourceDir']) / 'main' / name, root) for name in (config_name, 'main.c')]
        if any(str(path) not in known for path in paths): raise ValueError('治具编译配置/驱动源码没有真实构建哈希。')
        if _arrays(paths[0].read_text(), prefix, count_name) != pairs:
            raise ValueError('治具逐对拓扑与实际编译数组不同，不能只比较覆盖GPIO集合。')
        if paths[1].read_bytes() != source_asset.read_bytes():
            raise ValueError('治具驱动源码已变化，当前操作时序需要重新审查。')
        connections = copy.deepcopy(design['connections'])
        if [{'output': row['output'], 'input': row['input']} for row in connections] != pairs:
            raise ValueError('治具接线表与固件逐对拓扑不同。')
        for row in connections:
            for direction in ('output', 'input'):
                pin = header.get(row[direction + 'Pin'])
                if pin is None: raise ValueError('治具连接器针号不属于当前源板。')
                expected = ('C61_IO' if target == 'esp32c61' else 'IO') + str(row[direction])
                if pin.get('net') != expected or (target != 'esp32c61' and pin.get('gpio') != row[direction]):
                    raise ValueError('治具GPIO与当前连接器针号/网络不一致。')
                row[direction + 'Net'] = pin['net']
        for path in (manifest, *paths):
            result['sourceEvidence'].append({'path': path.relative_to(root).as_posix(), 'sha256': sha(path)})
        groups = _groups(connections)
        return {'target': target, 'status': design['status'], 'connections': connections, 'groups': groups,
                'pairCount': len(pairs), 'gpioCount': len({p for pair in pairs for p in pair.values()}),
                'electricalGroupCount': len(groups), 'readbackCount': len(pairs) * 4,
                'excludedGpios': design.get('excludedGpios', []), 'operatingRules': design['operatingRules']}

    if 'gpio-loopback' in tests:
        design = firmware.design_fixture(facts)
        pairs = report.get('profile', {}).get('fixturePairs')
        if pairs != design['fixturePairs']:
            raise ValueError('固件Skill配对与当前fixtureDesign不同，需要明确统一拓扑后才能出操作SOP。')
        p4 = bind(report, report['target'], design, pairs, 'hdk_board_config.h', 'hdk_fixture', 'HDK_FIXTURE_COUNT', firmware.ASSETS / 'main/main.c')
        p4['startupFixtureBeforeReady'] = True
        p4['drivePolicy'] = '每对依次双向；当前接收脚显式输入下拉，单个输出低/高各10ms读回，其余治具脚不主动输出；gpio_reset_pin不等同全脚输入。'
        result['branches'].append(p4)
        for variant in report.get('revisionVariants', []):
            path = core._inside(variant['manifestPath'], root); child = json.loads(path.read_text())
            bind(child, child['target'], design, pairs, 'hdk_board_config.h', 'hdk_fixture', 'HDK_FIXTURE_COUNT', firmware.ASSETS / 'main/main.c')
    if 'companion-gpio-loopback' in tests:
        path = core._inside(report['companion']['manifestPath'], root); child = json.loads(path.read_text())
        design = companion.fixture_design(facts)
        pairs = [{'output': row['output'], 'input': row['input']} for row in design['connections']]
        c61 = bind(child, 'esp32c61', design, pairs, 'companion_config.h', 'hdk_c61_fixture', 'HDK_C61_FIXTURE_COUNT', companion.ASSETS / 'main/main.c')
        c61['drivePolicy'] = '每方向开始四脚均为输入且floating；单个输出低/高各20ms读回，结束恢复四脚输入。应用hello不证明已执行该初始化。'
        result['branches'].append(c61)
    return result


def _endpoint(branch, gpio):
    for row in branch['connections']:
        for direction in ('output', 'input'):
            if row[direction] == gpio:
                return row[direction + 'Pin'], row[direction + 'Net']
    raise ValueError('治具电气组缺少可追溯端点。')


def diagram(product, contract):
    rows = [(branch, group) for branch in contract['branches'] for group in branch['groups']]
    if any(len(group) not in (2, 3) for _, group in rows):
        raise ValueError('当前治具图仅支持明确的两针/三针被动电气组。')
    height = max(430, 210 + ((len(rows) + 1) // 2) * 114 + 150)
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="{height}" viewBox="0 0 1600 {height}">',
        '<rect width="1600" height="100%" fill="#f8fafc"/>',
        '<style>text{font-family:Arial,"PingFang SC","Microsoft YaHei",sans-serif;fill:#172033}.small{font-size:16px}.pin{font-size:20px;font-weight:600}.net{font-size:17px}</style>',
        '<defs><marker id="arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#334155"/></marker></defs>',
        f'<text x="36" y="42" font-size="28">{html.escape(product)} · 真实治具连接图</text>',
        '<text x="36" y="78" class="small">逻辑接线图，不表示排针观察方向；端点必须按原理图的连接器位号和针号核对。</text>',
        '<text x="36" y="108" class="small">断电安装线束但触点断开 → 上电/烧录/复位保持隔离 → P4 READY + link PASS → 闭合信号触点 → 手动测试 → 断开再复位/断电</text>',
        '<text x="36" y="138" class="small">箭头表示测试方向逐次翻转，不是同时驱动；新治具未实板验证，不接电源针、外部输出或未列出的脚。</text>',
        f'<text x="36" y="168" class="small">本源 SHA-256：{contract["boardSourceSha256"][:24]}…；physicalTestStatus=not-run</text>']
    for index, (branch, group) in enumerate(rows):
        x, y = 36 + index % 2 * 784, 194 + index // 2 * 114
        color = '#7c3aed' if branch['target'] == 'esp32c61' else '#2563eb'
        out += [f'<rect x="{x}" y="{y}" width="748" height="100" rx="9" fill="white" stroke="{color}"/>',
                f'<text x="{x+12}" y="{y+22}" class="small">{html.escape(branch["target"])} · 电气组 {branch["groups"].index(group)+1}'+(' · 三针共线 / 两个测试对' if len(group) == 3 else ' · 双向逐次测试')+'</text>']
        for offset, gpio in enumerate(group):
            px = x + 14 + offset * (248 if len(group) == 3 else 470)
            pin, net = _endpoint(branch, gpio)
            shared = sum(gpio in (r['output'], r['input']) for r in branch['connections']) > 1
            width = 200 if len(group) == 3 else 218
            out += [f'<rect x="{px}" y="{y+31}" width="{width}" height="54" rx="6" fill="'+('#fff3cd' if shared else '#eff6ff')+'"/>',
                    f'<text x="{px+10}" y="{y+54}" class="pin">{html.escape(pin)} · GPIO{gpio}</text>',
                    f'<text x="{px+10}" y="{y+77}" class="net">{html.escape(net)}'+(' · 共享端点' if shared else '')+'</text>']
            if offset:
                previous = x + 14 + (offset - 1) * (248 if len(group) == 3 else 470) + width + 4
                out.append(f'<path d="M {previous} {y+58} H {px-5}" stroke="#334155" stroke-width="2" marker-start="url(#arrow)" marker-end="url(#arrow)"/>')
    fy = height - 100
    if not rows: out.append('<text x="36" y="230" font-size="22">本次清单未声明GPIO环回测试，不能推定治具接线。</text>')
    out += [f'<text x="36" y="{fy}" class="small">三针共线组共享同一个中间端点；不能把两个测试对当作两组独立回路。</text>',
            f'<text x="36" y="{fy+30}" class="small">C61没有字面READY日志；以P4手动link命令的同板 companion-link PASS 确认应用链路后，再进行其环回。</text>',
            f'<text x="36" y="{fy+60}" class="small">环回通过仅证明本次接线的双向电平读回，不证明所有GPIO独立、无额外短路或整板合格。</text>', '</svg>']
    return '\n'.join(out)


def render_png(svg, png):
    script = 'const sharp=require(process.argv[1]);sharp(process.argv[2]).png().toFile(process.argv[3]).catch(e=>{console.error(e.message);process.exit(1)});'
    subprocess.run([str(process.RUNTIME / 'node/bin/node'), '-e', script,
        str(process.RUNTIME / 'node/node_modules/sharp'), str(svg), str(png)], check=True, capture_output=True, timeout=60)
    from PIL import Image
    with Image.open(png) as image:
        image.load()
        if image.width != 1600 or image.height < 400: raise ValueError('真实接线图PNG尺寸不符合SVG画布。')


def _fixture_markdown(contract):
    lines = ['### 治具连接与操作顺序', '', ISOLATION, '',
        '1. 断电时安装并复核被动信号线束，所有环回触点/隔离开关保持断开；安装线束不等于闭合环回。',
        '2. 上电、烧录和复位时保持隔离，打开终端等待 `HDK usb-console READY`；存在C61时先手动执行 `link`，确认同板 `HDK companion-link PASS`。',
        '3. 仅在人工核对信号电压、针号、外部驱动隔离和治具闭合方式后，按下表闭合被动信号环回；本资料不宣称带电插拔已验证安全。条件无法确认时停止，不改成短接后上电。',
        '4. P4手动输入 `fixture`；C61手动输入 `c61-fixture`。正式判定采用READY后的这轮命令日志。',
        '5. 测试后先断开全部环回触点，再执行复位、`c61-reset`、`c61-download`、重新烧录或断电。', '',
        '**启动阶段会在READY之前自动执行外设和环回检测；隔离状态下的启动FAIL不是正式治具判定，不能为消除该FAIL而提前闭合治具。**', '',
        '不连接5V/3.3V供电针，不连接其它输出驱动；BOOT/EN/供电/协议与排除脚不能按相邻位置猜测加入环回。']
    for branch in contract['branches']:
        lines += ['', '#### ' + branch['target'] + ' 逐对接线', '',
            f'{branch["pairCount"]}个测试对 / {branch["gpioCount"]}个唯一GPIO / {branch["electricalGroupCount"]}个电气连通组；双向低、高共{branch["readbackCount"]}次读回。', '',
            branch['drivePolicy'], '', '| 测试对 | A端（首次输出） | B端（首次输入） | 反向 | 共享组 |', '| --- | --- | --- | --- | --- |']
        for index, row in enumerate(branch['connections'], 1):
            group = next(group for group in branch['groups'] if row['output'] in group)
            shared = '—'.join('GPIO' + str(g) for g in group) + ('；同一电气组，禁止当作独立回路' if len(group) > 2 else '')
            lines.append(f'| {index} | {row["outputPin"]} / {row["outputNet"]} / GPIO{row["output"]} | {row["inputPin"]} / {row["inputNet"]} / GPIO{row["input"]} | B输出→A输入，逐次执行 | {shared} |')
        lines += ['', '排除项：' + '；'.join('GPIO' + str(x['gpio']) + '（' + x['reason'] + '）' for x in branch['excludedGpios']), '',
                  '该治具状态：`' + branch['status'] + '`；首次须由用户核对接线和实板日志。环回不证明GPIO彼此独立或不存在其它短路。']
    return '\n'.join(lines)


def _operator_steps(item, contract):
    result = copy.deepcopy(item)
    if result['id'] == 'gpio-loopback':
        branch = next((b for b in contract['branches'] if b['target'] != 'esp32c61'), None)
        if branch:
            result['operatorSteps'] = [ISOLATION,
                '按“治具连接与操作顺序”断电安装线束但保持触点断开；上电/烧录/复位保持隔离。',
                '等待 HDK usb-console READY；有C61时先用link确认同板应用链路，再由人工确认后闭合本表信号触点。',
                f'手动输入 fixture，保留{branch["pairCount"]}对、{branch["gpioCount"]}个GPIO的{branch["readbackCount"]}次逐向低/高读回日志；共享组按表处理。',
                '结束先断开全部环回触点，再复位、下载、重新烧录或断电。']
    elif result['id'] == 'reset':
        result['operatorSteps'] = [ISOLATION] + result.get('operatorSteps', [])
    elif result['id'] == 'companion-link':
        result['operatorSteps'] = [ISOLATION,
            '保持环回触点断开；双方进入应用后，在P4终端手动执行link并保存同板 HDK companion-link PASS。',
            'C61没有字面READY日志，hello不等于GPIO已进入输入态；本项仅确认同板应用链路，不闭合治具或替代GPIO环回。']
    elif result['id'] == 'companion-gpio-loopback':
        result['operatorSteps'] = [ISOLATION,
            '双方进入应用后，在P4终端手动执行link并保存同板 HDK companion-link PASS；C61的hello不等于GPIO已进入输入态。',
            '按C61逐对接线表，由人工确认后仅闭合所列被动信号触点，再在P4终端输入c61-fixture。',
            '要求 HDK companion-gpio-loopback PASS pairs=2 gpios=4 checks=8；保留实际日志。结束先断开触点，再复位/下载/断电。']
    return result


def _index_text(core, artifacts, output):
    lines = ['# 完整构建文件与源码索引', '', '本附件保存完整库存。操作步骤见测试说明；源码不是额外烧录镜像。', '',
             '| 本次文件 | 用途 | 字节数 | SHA-256 |', '| --- | --- | ---: | --- |']
    lines += [f'| [{core._cell(a["relativePath"])}]({core._link(a["path"], output)}) | {core._cell(a.get("role", "构建产物"))} | {a["bytes"]} | `{a["sha256"]}` |' for a in artifacts]
    return '\n'.join(lines) + '\n'


def _references(core, text, document, root):
    result = []
    for value in re.findall(r'!?\[[^\]]*\]\(([^)]+)\)', text):
        url = urlsplit(value)
        if url.scheme or url.netloc: raise ValueError('SOP包含未经核验的外部引用。')
        path = core._inside(document.parent / unquote(url.path), root)
        result.append({'path': path.relative_to(root).as_posix(), 'sha256': sha(path)})
    return result


def verify(markdown_path, package_path):
    core = core_module(); root = Path(package_path).resolve(); document = core._inside(markdown_path, root)
    provenance = json.loads((document.parent / '测试依据.json').read_text())
    artifacts = core._resolve_artifacts(provenance['firmware'], root)
    contract = fixture_contract({'boardFacts': provenance['boardFacts'], 'firmware': provenance['firmware'], 'packagePath': str(root)}, core)
    text = document.read_text(); index = document.parent / INDEX_MD; inventory = document.parent / INDEX_JSON
    errors = []
    try:
        if index.read_text() != _index_text(core, artifacts, document.parent): raise ValueError('完整附件索引内容/哈希/链接与实际构建不同。')
        if json.loads(inventory.read_text()) != artifacts: raise ValueError('完整JSON库存与实际构建不同。')
        for path, label in ((index, '构建附件索引'), (inventory, '完整库存JSON')):
            if f'{label} SHA-256：`{sha(path)}`' not in text: raise ValueError('正文没有绑定当前完整库存附件SHA。')
        direct = _references(core, text, document, root)
        index_refs = _references(core, index.read_text(), index, root)
    except Exception as error:
        errors.append(str(error)); direct, index_refs = [], []
    # Original main-document checks still run. All omitted source references are
    # independently checked in the exact transitive inventory above.
    direct_paths = {item['path'] for item in direct}
    original = copy.deepcopy(provenance)
    original['resolvedArtifacts'] = [a for a in artifacts if a['relativePath'] in direct_paths]
    checked = core.verify(document, root, original)
    errors.extend(checked['errors'])
    expected_contract = provenance.get('fixtureContract')
    if contract != expected_contract: errors.append('SOP治具事实与本次真实构建不一致。')
    svg, png = document.parent / 'images/wiring.svg', document.parent / 'images/wiring.png'
    if svg.read_text() != diagram(provenance['productCode'], contract): errors.append('接线SVG不是当前治具连接图。')
    if sha(svg) != provenance['diagram']['svgSha256'] or sha(png) != provenance['diagram']['pngSha256']: errors.append('人审接线图SHA已变化。')
    with tempfile.TemporaryDirectory(prefix='hdk-sop-png-readback-', dir='/private/tmp') as temporary:
        reproduced = Path(temporary) / 'wiring.png'; render_png(svg, reproduced)
        if sha(reproduced) != sha(png): errors.append('接线PNG与当前真实SVG的标准渲染结果不一致。')
    if contract['branches'] and _fixture_markdown(contract) not in text: errors.append('治具逐对表或隔离操作顺序缺失/变化。')
    for _, _, item in core._test_entries(provenance['firmware'].get('tests', [])):
        expected = _operator_steps(item, contract)
        if expected != item and any(step not in text for step in expected['operatorSteps']): errors.append('测试步骤与当前治具时序冲突：' + item['id'])
    checks = checked['checks'] | {'completeTransitiveArtifactIndex': not errors,
        'fixtureTopologyMatchesCompiledConfig': contract == expected_contract,
        'operatorIsolationAndExpandedPairs': not errors, 'actualFixtureDiagram': not errors}
    return {'schemaVersion': 2, 'status': 'complete' if all(checks.values()) else 'failed', 'checks': checks,
        'references': direct + index_refs, 'errors': errors, 'physicalTestStatus': 'not-run'}


def render(request, output_dir, plan):
    core = core_module(); core.validate_plan(request, plan)
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,95}', str(request.get('productCode', ''))): raise ValueError('SOP产品代号无效。')
    root = Path(request['packagePath']).resolve(); output = Path(output_dir).resolve()
    if not output.is_relative_to(root): raise ValueError('SOP必须写入本次产物目录。')
    output.mkdir(parents=True, exist_ok=True); (output / 'images').mkdir(exist_ok=True)
    destinations = [output / plan['documentName'], output / INDEX_MD, output / INDEX_JSON,
                    output / 'images/wiring.svg', output / 'images/wiring.png', output / '测试依据.json', output / 'SOP验收.json']
    if any(path.exists() or path.is_symlink() for path in destinations): raise ValueError('SOP输出已存在，禁止覆盖。')
    facts, report = request['boardFacts'], request['firmware']
    if (not re.fullmatch(r'[a-f0-9]{64}', facts.get('source', {}).get('sha256', ''))
            or report.get('boardSourceSha256') != facts['source']['sha256']
            or report.get('target') not in facts['board']['targets']
            or report.get('status') != 'compiled'):
        raise ValueError('SOP必须绑定当前源板的真实成功构建。')
    artifacts = core._resolve_artifacts(report, root); flash = core._flash_rows(report, artifacts, root)
    if not artifacts or not flash: raise ValueError('SOP缺少真实构建文件与烧录布局。')
    p4 = core._p4_flash_contract(report, artifacts, root) if report['target'] == 'esp32p4' else None
    contract = fixture_contract(request, core)
    destinations[1].write_text(_index_text(core, artifacts, output)); _json(destinations[2], artifacts)
    destinations[3].write_text(diagram(request['productCode'], contract)); render_png(destinations[3], destinations[4])
    sections = {}
    material = ['## 资料准备', '', f'- 产品：`{request["productCode"]}`；硬件版本：`{request["hardwareVersion"]}`；发布日期：`{request["releaseDate"]}`。',
        f'- 源工程 SHA-256：`{facts["source"]["sha256"]}`。', '- **硬件实测未进行。编译成功不等于实板通过；治具为新设计，首次必须核对。**',
        '- 先阅读本次烧录分支选择与下方操作顺序，源码库存放在独立附件，不需要逐个烧录源码。', '',
        f'完整库存：[构建文件与源码索引]({INDEX_MD})；[机器可读JSON]({INDEX_JSON})。',
        f'构建附件索引 SHA-256：`{sha(destinations[1])}`', f'完整库存JSON SHA-256：`{sha(destinations[2])}`', '',
        '| 本次文件 | 用途 | 字节数 | SHA-256 |', '| --- | --- | ---: | --- |']
    for a in artifacts:
        if a.get('role') in ('applicationBin', 'mergedBin', 'buildReplayGuide', 'companionFlashGuide', 'revisionSelectionGuide'):
            material.append(f'| [{core._cell(a["relativePath"])}]({core._link(a["path"], output)}) | {core._cell(a["role"])} | {a["bytes"]} | `{a["sha256"]}` |')
    sections['preparation'] = '\n'.join(material)
    wiring = ['## 接线与供电', '', ISOLATION, '', '![当前实际治具连接图](images/wiring.png)', '', '[可编辑SVG接线图](images/wiring.svg)', '']
    wiring += [_fixture_markdown(contract)] if contract['branches'] else ['本次清单未声明GPIO环回，不能推测接线。']
    wiring += ['', '### 当前外设与接口事实', '', '| 当前事实字段 | 网名 / 引脚 / 已知条件 |', '| --- | --- |']
    wiring += [f'| {core._cell(k)} | {core._cell(v)} |' for k, v in core._connection_rows(facts.get('peripherals', {}), include_header_pins=False)]
    wiring += ['', '**供电电压、电流限制和接口角色仍须核对本次原理图；没有完整供电事实时不得套用其它板。**']
    sections['wiring'] = '\n'.join(wiring)
    if p4: flashing = core._p4_flashing(p4, output)
    else:
        flashing = ['## 烧录步骤', '', '仅按本次构建的真实flash参数执行；未确认下载接口时停止。', '',
            '| 地址 | 本构建文件 | SHA-256 |', '| --- | --- | --- |']
        flashing += [f'| `{row["offset"]}` | [{Path(row["path"]).name}]({core._link(row["path"], output)}) | `{row["sha256"]}` |' for row in flash]
        if not re.fullmatch(r'esp32[a-z0-9]+', report['target']): raise ValueError('SOP烧录目标无效。')
        arguments = ' '.join(row['offset'] + ' ' + shlex.quote(os.path.relpath(row['path'], output)) for row in flash)
        flashing += ['', '```sh', f'python -m esptool --chip {report["target"]} --port PORT --baud 115200 write-flash ' + arguments, '```']
    flashing.insert(2, ISOLATION); sections['flashing'] = '\n'.join(flashing)
    tests = ['## 测试步骤与判定', '', '启动阶段未接治具的环回FAIL不作正式判定；正式日志来自隔离启动、确认应用后手动触发的测试。', '']
    entries = core._test_entries([next(t for t in report['tests'] if t['id'] == test) for test in plan['testIds']])
    for index, level, original in entries:
        item = _operator_steps(original, contract)
        tests += [f'{"#"*level} {index}. {item.get("scope",item["id"])} (`{item["id"]}`)', '']
        equipment = core._equipment_names(item.get('hardwareRequired'))
        if equipment: tests += ['器材：' + '、'.join(equipment), '']
        tests += [f'{i}. {step}' for i, step in enumerate(item.get('operatorSteps', []), 1)]
        if item.get('command'): tests += ['', '实际串口命令：', '```text', item['command'], '```']
        tests += ['', '固件定义的日志 / 判据：', '```text', item.get('expectedLog', '未确认'), '```',
                  '通过条件：' + item.get('passCriteria', '以实际日志与人工检查为准，缺项记未测。'),
                  '实际结果：□通过　□失败　□未测；日志证据 / 异常：________________。', '']
    sections['tests'] = '\n'.join(tests)
    sections['troubleshooting'] = '\n'.join(['## 故障排查', '', ISOLATION,
        '- 启动FAIL：保持治具隔离直到READY，按步骤手动重测，不用提前闭合消除启动失败。',
        '- 未确认应用或同板link失败：保持隔离，核对芯片/固件/下载模式，不能先接环回继续。',
        '- 发热、短路或反复复位：停止并切断供电；按本次原理图检查，保留日志。',
        '- 共享组通过不证明各GPIO互相独立；需要额外短路/独立性检查时另定测试，不宣称已覆盖。'])
    pending = list(dict.fromkeys(report.get('warnings', []) + facts.get('warnings', []) + ['新治具未实板验证；带电闭合/隔离方式须人工确认。', '未连接或烧录实板，物理测试未运行。']))
    sections['record'] = '\n'.join(['## 测试记录', '', '| 测试 ID | 实测结果 | 日志/测量记录位置 | 异常与复测 |', '| --- | --- | --- | --- |']
        + [f'| {core._cell(item["id"])} | 未测 | 待填写 | 待填写 |' for _, _, item in entries]
        + ['', '操作员/板号/日期/实用固件SHA/治具版本：________________。', '', '待确认项：'] + ['- ' + p for p in pending])
    text = f'# {request["productCode"]} 测试说明\n\n' + '\n\n'.join(sections[k] for k in plan['sections'])
    text += '\n\n依据：[当前硬件、构建和引用来源](测试依据.json)。\n'
    destinations[0].write_text(text, encoding='utf-8')
    provenance = {'schemaVersion': 2, 'productCode': request['productCode'], 'sourceSha256': facts['source']['sha256'],
        'physicalTestStatus': 'not-run', 'boardFacts': facts, 'firmware': report, 'plan': plan,
        'resolvedArtifacts': artifacts, 'flashOffsets': flash, 'p4FlashContract': p4, 'pending': pending,
        'fixtureContract': contract, 'diagram': {'svgSha256': sha(destinations[3]), 'pngSha256': sha(destinations[4]), 'renderer': 'bundled sharp/libvips SVG renderer'},
        'adapter': {'sourceInventoryMovedTo': [INDEX_MD, INDEX_JSON], 'oldSopModuleUnchanged': True}}
    _json(destinations[5], provenance)
    checked = verify(destinations[0], root)
    checked.update(markdownPath=str(destinations[0]), pending=pending,
        artifacts=[{'path': p.relative_to(root).as_posix(), 'sha256': sha(p), 'bytes': p.stat().st_size} for p in destinations[:-1]])
    _json(destinations[6], checked); checked['reportPath'] = str(destinations[6])
    return checked


def semantics(text):
    text = re.sub(r'(?m)^(\| \[[^\n]+\]\([^\n]+\) \| [^\n|]* \| )\d+ \| `[0-9a-f]{64}` \|$', r'\1<bytes> | `<sha256>` |', text)
    return re.sub(r'(?m)^((?:构建附件索引|完整库存JSON) SHA-256：)`[0-9a-f]{64}`$', r'\1`<sha256>`', text)
