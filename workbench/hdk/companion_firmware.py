"""Build the C61 side of a current-source-bound P4+C61 factory test.

The P4 main capability imports install_bridge() and compile_package(). No
hardware is flashed. The protocol tests link and radio scan, not Wi-Fi throughput.
"""
from pathlib import Path
import argparse
import collections
import hashlib
import importlib.util
import json
import os
import re
import shlex
import shutil
import struct
import subprocess
import tempfile
import time
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'skills/hdk-test-firmware/assets/companion'
SDK_COMMIT = 'fff9895c82d744c7237be8847347bdd1b07c6643'
PROTOCOL = {'version': 1, 'transport': 'UART JSON-lines', 'baud': 115200,
    'dataBits': 8, 'parity': 'none', 'stopBits': 1, 'terminator': 'newline',
    'commands': ['hello', 'scan', 'fixture'], 'requestIdRequired': True,
    'linkChecks': ['requestId', 'protocol', 'target=esp32c61', 'boardSha256'],
    'wifiChecks': ['real-scan-completes', 'at-least-one-ap', 'count-equals-records'],
    'fixtureChecks': ['two-current-header-pairs', 'both-directions', 'low-and-high', 'no-strapping-pins']}


def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _fw():
    spec = importlib.util.spec_from_file_location('hdk_main_firmware', ROOT / 'hdk/test_firmware.py')
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def _json(path, data): Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')


def binding(facts):
    """Use actual native module pins, then check supported P4/C61 wiring."""
    board = facts.get('board', {})
    if board.get('modulePart') != 'WT01P461-S1' or set(board.get('targets', [])) != {'esp32p4', 'esp32c61'}:
        raise ValueError('C61能力只接受当前事实明确的WT01P461-S1双芯片工程。')
    module = next((c for c in board.get('components', []) if c.get('designator') == board.get('moduleRef')), None)
    if not module: raise ValueError('当前工程缺少精确模组引脚事实。')
    by_name = {p.get('name'): p.get('net') for p in module['pins']}
    net_gpio = {}
    for pin in module['pins']:
        match = re.fullmatch(r'IO(\d+)(?:_[A-Za-z0-9]+)?', pin.get('name') or '')
        if match: net_gpio[pin.get('net')] = int(match.group(1))
    expected = {'C61_U0RXD': 54, 'C61_U0TXD': 53, 'C61_EN': 52, 'C61_IO9': 2}
    actual = {name: net_gpio.get(by_name.get(name)) for name in expected}
    if actual != expected: raise ValueError('当前P4-C61原生连接与已实现桥接口不同；不能照抄另一版本。')
    return {'p4': {'tx': actual['C61_U0RXD'], 'rx': actual['C61_U0TXD'],
            'reset': actual['C61_EN'], 'boot': actual['C61_IO9']},
        'c61': {'tx': 11, 'rx': 10, 'boot': 9, 'reset': 'EN'},
        'evidence': {'sourceSha256': facts['source']['sha256'],
            'nativeModuleRef': board['moduleRef'], 'nativeSignals': actual,
            'chipUartSource': 'https://documentation.espressif.com/esp32-c61_datasheet_en.html#io-mux-functions',
            'chipUartTable': 'ESP32-C61 datasheet v1.1 Table 2-3: GPIO10 U0RXD, GPIO11 U0TXD'}}


def _current(facts):
    current = _fw().inspect_board(facts['source']['path'])
    if current['source']['sha256'] != facts['source']['sha256']:
        raise ValueError('C61规划期间源工程发生变化。')
    binding(current)
    return current


def fixture_design(facts):
    """Safe ordinary C61 header pins only, excluding all documented strapping."""
    binding(facts)
    board = facts['board']
    module = next(c for c in board['components'] if c['designator'] == board['moduleRef'])
    net_pin = {}
    for pin in module['pins']:
        match = re.fullmatch(r'C61_IO(\d+)', pin.get('name') or '')
        if match: net_pin[pin['net']] = int(match.group(1))
        if pin.get('name') == 'C61_U0RXD': net_pin[pin['net']] = 10
        if pin.get('name') == 'C61_U0TXD': net_pin[pin['net']] = 11
    locations = collections.defaultdict(list)
    for header in facts['peripherals']['headers']:
        for pin in header['pins']:
            if pin['net'] in net_pin: locations[net_pin[pin['net']]].append(header['designator']+'.'+pin['pad'])
    # C61 datasheet v1.1 Table 3-1: MTMS=GPIO3, MTDI=GPIO4,
    # GPIO7 selects JTAG, GPIO8/9 select boot/ROM behavior.
    excluded = {3:'SDIO clock-edge strapping (MTMS)',4:'SDIO clock-edge strapping (MTDI)',
        7:'JTAG source strapping',8:'boot/ROM-message strapping',9:'boot strap used by P4 control',
        10:'UART0 RX protocol',11:'UART0 TX protocol'}
    ordinary = sorted(set(locations)-set(excluded))
    if ordinary != [0,1,5,6]:
        raise ValueError('C61普通排针集合与已验证的两对夹具不同，不能遗漏或猜测新增引脚。')
    connections = [{'output':0,'input':1,'outputPin':locations[0][0],'inputPin':locations[1][0]},
                   {'output':5,'input':6,'outputPin':locations[5][0],'inputPin':locations[6][0]}]
    return {'schemaVersion':1,'status':'new-design-not-physically-validated',
        'boardSourceSha256':facts['source']['sha256'],'target':'esp32c61',
        'connections':connections,'coveredGpios':ordinary,
        'excludedGpios':[{'gpio':pin,'pins':locations.get(pin,[]),'reason':reason} for pin,reason in sorted(excluded.items())],
        'strappingSource':'ESP32-C61 datasheet v1.1 page28 Table3-1 and page19 Table2-3',
        'operatingRules':['断电/烧录/任何复位时断开环回线；P4与C61均进入应用后再接两对3.3V信号环回。',
            '仅短接J3两组信号针，不接5V/3.3V电源针，不连接外部JTAG或其它输出驱动。',
            '每次只驱动一个GPIO，另一端输入；每对双向低/高共8次读回，测试后四脚恢复输入。',
            '这仅覆盖本源引出的四个普通C61 GPIO；strapping与协议占用脚明确排除，不宣称全芯片或复制旧案例夹具。']}


def _config(facts):
    b = binding(facts); fixture = fixture_design(facts)
    return '\n'.join(['#pragma once',
        f'#define HDK_C61_BOARD_SOURCE_SHA256 "{facts["source"]["sha256"]}"',
        f'#define HDK_C61_UART_TX {b["c61"]["tx"]}', f'#define HDK_C61_UART_RX {b["c61"]["rx"]}',
        f'#define HDK_P4_C61_TX {b["p4"]["tx"]}', f'#define HDK_P4_C61_RX {b["p4"]["rx"]}',
        f'#define HDK_P4_C61_RESET {b["p4"]["reset"]}', f'#define HDK_P4_C61_BOOT {b["p4"]["boot"]}',
        f'#define HDK_C61_FIXTURE_COUNT {len(fixture["connections"])}',
        'static const int hdk_c61_fixture_out[] = {'+','.join(str(c['output']) for c in fixture['connections'])+'};',
        'static const int hdk_c61_fixture_in[] = {'+','.join(str(c['input']) for c in fixture['connections'])+'};', ''])


def install_bridge(facts, main_dir):
    """Install P4 bridge sources and pinned cJSON component into a fresh source.

    Parent main CMake requires esp_driver_uart, esp_timer, hdk_cjson and includes
    bridge.c. Returns installed absolute paths for the parent's source manifest.
    """
    facts = _current(facts); main = Path(main_dir).resolve()
    if main.name != 'main' or not main.is_dir(): raise ValueError('请指定已生成源码的main目录。')
    component = main.parent / 'components/hdk_cjson'
    targets = [main / 'bridge.c', main / 'bridge.h', main / 'companion_config.h']
    if any(p.exists() for p in targets) or component.exists(): raise ValueError('P4桥源码已经存在，禁止覆盖。')
    for name in ('bridge.c', 'bridge.h'): shutil.copyfile(ASSETS / name, main / name)
    targets[2].write_text(_config(facts), encoding='utf-8')
    component.parent.mkdir(exist_ok=True); shutil.copytree(ASSETS / 'components/hdk_cjson', component)
    shutil.copyfile(ASSETS / 'third-party.json', component / 'UPSTREAM.json')
    return [str(p) for p in targets + sorted(component.rglob('*')) if p.is_file()]


def generate(facts, package_path):
    facts = _current(facts); package = Path(package_path).resolve()
    if not package.is_dir(): raise ValueError('当前交付根目录必须已存在。')
    area = package / '生产资料/07_测试说明/测试固件/C61'
    if area.exists(): raise ValueError('本次C61目录已经存在，禁止覆盖。')
    source = area / 'source'; source.mkdir(parents=True)
    shutil.copyfile(ASSETS / 'CMakeLists.txt', source / 'CMakeLists.txt')
    shutil.copytree(ASSETS / 'main', source / 'main')
    shutil.copytree(ASSETS / 'components', source / 'components')
    shutil.copyfile(ASSETS / 'third-party.json', source / 'third-party.json')
    (source / 'main/companion_config.h').write_text(_config(facts), encoding='utf-8')
    (source / 'sdkconfig.defaults').write_text('\n'.join([
        'CONFIG_IDF_TARGET="esp32c61"', 'CONFIG_ESPTOOLPY_FLASHSIZE_2MB=y',
        'CONFIG_PARTITION_TABLE_SINGLE_APP=y', 'CONFIG_COMPILER_OPTIMIZATION_SIZE=y',
        'CONFIG_ESP_CONSOLE_UART_DEFAULT=y', 'CONFIG_ESP_CONSOLE_UART_NUM=0',
        'CONFIG_ESP_CONSOLE_UART_BAUDRATE=115200', 'CONFIG_LOG_DEFAULT_LEVEL_WARN=y',
        'CONFIG_ESP_WIFI_NVS_ENABLED=n', 'CONFIG_ESP_WIFI_ENABLE_WPA3_SAE=n', '']), encoding='utf-8')
    _json(source / 'board-facts.json', facts); _json(source / 'protocol.json', PROTOCOL)
    _json(source / 'fixture-design.json', fixture_design(facts))
    helper = _fw()
    result = {'schemaVersion': 1, 'status': 'generated', 'target': 'esp32c61',
        'physicalTestStatus': 'not-run', 'packagePath': str(package), 'artifactRoot': str(area),
        'sourceDir': str(source), 'boardFacts': facts, 'binding': binding(facts), 'protocol': PROTOCOL,
        'boardSourceSha256': facts['source']['sha256'], 'fixtureDesign':fixture_design(facts), 'manifestPath': str(area / 'generation-manifest.json'),
        'sourceFiles': [helper.artifact(p, area, 'source') for p in sorted(source.rglob('*')) if p.is_file() and not helper.is_os_metadata(p)]}
    _json(result['manifestPath'], result)
    return result


def tests_manifest():
    return [{'id': 'companion-link', 'scope': 'P4-C61 UART双向通信与同板固件身份',
        'expectedLog': 'HDK companion-link PASS target=esp32c61 board_sha_checked',
        'command': 'link', 'operatorSteps': ['先烧录本次C61固件与P4主测试固件；断开外接烧录适配器TX/RX。',
            '在P4 USB Serial/JTAG串口115200 8N1输入 link 并回车。'],
        'hardwareRequired': ['本板P4与C61均运行当前交付固件'],
        'passCriteria': '真实UART往返，requestId、协议版本、C61目标及同板SHA均匹配；超时/不匹配均失败。', 'unsupported': False},
        {'id': 'wifi', 'scope': 'ESP32-C61真实2.4GHz Wi-Fi扫描',
        'expectedLog': 'HDK wifi AP {...} followed by HDK wifi PASS ap_count=N', 'command': 'wifi',
        'operatorSteps': ['开启已知2.4GHz测试AP，不需要在固件中填写任何账号密码。',
            '在P4 USB串口输入 wifi 并回车，保存AP的SSID、RSSI、信道及最终count。'],
        'hardwareRequired': ['可识别的2.4GHz测试AP', '正确连接天线的当前板'],
        'passCriteria': 'C61真实扫描成功，至少一条AP记录且count等于收到的记录数；操作员确认已知测试AP在列表内。无AP/timeout/error均失败；不是Wi-Fi吞吐量或联网通过证明。',
        'unsupported': False},
        {'id':'companion-gpio-loopback','scope':'C61当前四个普通排针GPIO双向高低环回（排除strapping/协议脚）',
        'expectedLog':'HDK companion-gpio-loopback PASS pairs=2 gpios=4 checks=8',
        'command':'c61-fixture','operatorSteps':['烧录/复位时断开环回线；P4与C61应用READY后再接入新设计夹具。',
            '按C61烧录说明的当前源接线表连接GPIO0↔1、GPIO5↔6，两对不可与供电针相接。',
            '输入 c61-fixture 并保存每次读回日志，测试后先拆环回线再复位或断电。'],
        'hardwareRequired':['两根3.3V信号环回跳线或新制被动夹具','已核对1脚方向的本次板'],
        'passCriteria':'GPIO0/1和5/6逐对双向低/高8次读回全部匹配，只有配置相同且errors=0才通过；不覆盖strap3/4/7/8/9、UART10/11或芯片其它未引出GPIO。',
        'unsupported':False}]


def write_flashing_guide(report):
    """Keep C61 instructions separate from the P4 image/offset table."""
    area = Path(report['artifactRoot']); facts = report['boardFacts']
    headers = facts['peripherals']['headers']; pin_by_net = collections.defaultdict(list)
    for header in headers:
        for pin in header['pins']: pin_by_net[pin['net']].append(header['designator']+'.'+pin['pad'])
    rx = ', '.join(pin_by_net['C61_U0RXD']); tx = ', '.join(pin_by_net['C61_U0TXD'])
    gnd = ', '.join(pin_by_net['GND'])
    if not rx or not tx or not gnd: raise ValueError('C61外部烧录接口缺少当前排针事实。')
    lines = ['# ESP32-C61 测试固件烧录与恢复', '',
        '**未连接或烧录任何实物；以下操作由用户在核对实板后执行。**', '',
        f'源工程 SHA-256：`{report["boardSourceSha256"]}`。固件目标必须是 `esp32c61`，不能选择 `esp32c6` 或把 P4 镜像写入 C61。', '',
        '本包采用 UART 测试 companion，协议为 hello/scan；不能与 ESP-Hosted master/slave 固件混用。', '',
        '## 准备与接线', '',
        '准备3.3V逻辑电平USB-UART适配器。开发板仍由USB供电；**不接适配器VCC，不向开发板3.3V输出针反向供电，不使用5V逻辑电平。**', '',
        '| 适配器 | 本次工程排针 | 说明 |', '| --- | --- | --- |',
        f'| TX（3.3V） | `{rx}` | 接 C61 UART0 RX（SoC GPIO10） |',
        f'| RX | `{tx}` | 接 C61 UART0 TX（SoC GPIO11） |',
        f'| GND | `{gnd}` 中一个 | 与开发板共地 |', '',
        '## 烧录顺序', '',
        '1. 先按主测试说明烧录P4主测试固件，保持适配器TX/RX未连接。',
        '2. 在P4 USB Serial/JTAG终端输入 `c61-download`，确认出现 `HDK companion DOWNLOAD external_uart_ready`。这会拉低C61 BOOT、脉冲C61 EN并释放P4共享UART引脚，避免两个输出对打。',
        '3. 连接上表TX/RX/GND。找到适配器的串口（它与P4 USB串口不同）。',
        '4. 在本文件目录执行下方命令；`--before no-reset`保留刚设置的下载模式，`--after no-reset`避免适配器无EN接线却宣称自动复位。', '',
        '| C61地址 | 文件 | SHA-256 |', '| --- | --- | --- |']
    arguments = []
    for item in report['flash']['offsets']:
        relative = os.path.relpath(item['path'], area)
        lines.append(f'| `{item["offset"]}` | [{Path(relative).name}]({quote(relative,safe="/._-")}) | `{item["sha256"]}` |')
        arguments += [item['offset'], shlex.quote(relative)]
    lines += ['', '```sh', 'python -m esptool --chip esp32c61 --port C61_UART_PORT --baud 115200 --before no-reset --after no-reset write-flash '+' '.join(arguments), '```', '',
        '5. 烧录完成后先断开适配器TX/RX，保留板USB供电。在P4终端输入 `link`；P4重新初始化共享UART并复位C61到应用模式。',
        '6. `link`应收到同板SHA匹配的C61回执。再打开已知2.4GHz测试AP并输入 `wifi`；应输出AP列表和非零count。保存日志并人工确认已知AP出现。', '',
        '## 失败处理', '',
        '- 串口找不到：区分P4 USB串口和外接USB-UART串口，确认驱动和数据线。',
        '- 无法sync：断开适配器数据线，重新执行c61-download后再接线；检查TX/RX交叉和共地，不强行跳过芯片检查。',
        '- link超时或board_sha不匹配：核对P4与C61来自同一次交付，不使用原厂另一个协议或历史固件。',
        '- Wi-Fi count为0或失败：检查天线、已知2.4GHz AP、电源和完整日志。空扫描不会判为通过。', '',
        '## 范围与复核', '',
        '无线测试验证扫描能力、AP记录与P4-C61串口链路；没有宣称联网、吞吐量、RF灵敏度、认证或硬件实测通过。',
        '原厂p4_flash预编译桥的README存在UART方向描述歧义，本包不将其当作当前源已核验的桥固件；以上方法采用本次工程确认的排针与P4释放共享引脚。', '']
    design = fixture_design(facts)
    lines += ['## C61普通排针环回夹具', '',
        '**这是新设计、未实物验证的被动夹具。烧录/上电/复位时断开环回；两芯片应用READY后再接。**', '',
        '| 接线A | 接线B | 实际GPIO |', '| --- | --- | --- |']
    for edge in design['connections']:
        lines.append(f'| `{edge["outputPin"]}` | `{edge["inputPin"]}` | C61 GPIO{edge["output"]} ↔ GPIO{edge["input"]} |')
    lines += ['', '接好后在P4终端输入 `c61-fixture`；每对双向低/高，共8次读回必须全部匹配。每步输出驱动脚、读入脚、期望和实际电平；结束后四脚恢复输入。', '',
        '| 排除GPIO | 原因 |', '| --- | --- |']
    for exclusion in design['excludedGpios']: lines.append(f'| C61 GPIO{exclusion["gpio"]} | {exclusion["reason"]} |')
    lines += ['', '仅覆盖当前板引出的C61 GPIO0/1/5/6四个普通信号脚。不宣称所有芯片GPIO或strapping脚均已测试；不复刻未知旧案例夹具。不得连接电源针、外部JTAG或其它输出驱动。', '']
    path = area / 'C61烧录说明.md'
    if path.exists(): raise ValueError('C61烧录说明已存在，禁止覆盖。')
    path.write_text('\n'.join(lines), encoding='utf-8')
    return path


def compile(generation, toolchain_profile=None):
    helper = _fw(); facts = _current(generation['boardFacts'])
    area = Path(generation['artifactRoot']).resolve(); source = Path(generation['sourceDir']).resolve()
    package = Path(generation['packagePath']).resolve()
    if not source.is_relative_to(area) or not area.is_relative_to(package): raise ValueError('C61构建目录越界。')
    source_files = helper._business_sources(generation['sourceFiles'])
    for item in source_files:
        if sha(item['path']) != item['sha256']: raise ValueError('C61生成源码发生变化，请重新生成。')
    tool = helper.default_toolchain() | (toolchain_profile or {}); idf = Path(tool['idfPath'])
    commit = subprocess.check_output(['git', '-C', str(idf), 'rev-parse', 'HEAD'], text=True).strip()
    if commit != SDK_COMMIT: raise ValueError('C61构建必须使用已核验的固定ESP-IDF v6.1。')
    destination = area / 'build'; log = area / 'build.log'
    if destination.exists() or log.exists(): raise ValueError('C61本次构建记录已存在，禁止覆盖。')
    scratch = Path(tempfile.mkdtemp(prefix='hdk-c61-', dir='/private/tmp'))
    scratch_source = scratch / 'source'; shutil.copytree(source, scratch_source); build = scratch / 'build'
    env = dict(os.environ, IDF_PATH=str(idf), IDF_TARGET='esp32c61', IDF_PYTHON_ENV_PATH=tool['pythonEnv'],
        IDF_TOOLS_PATH=tool['idfToolsPath'], IDF_COMPONENT_MANAGER='0', IDF_SKIP_CHECK_SUBMODULES='1', PYTHONDONTWRITEBYTECODE='1')
    env['PATH'] = os.pathsep.join([tool['compilerBin'], tool['cmakeBin'], tool['ninjaBin'], str(Path(tool['python']).parent), env.get('PATH', '')])
    command = [tool['python'], str(idf / 'tools/idf.py'), '--preview', '-B', str(build), '-C', str(scratch_source), '-DIDF_TARGET=esp32c61', 'build']
    started = time.time(); code = helper._run(command, env, scratch_source, log)
    if build.exists(): helper._copy_build_artifacts(build, destination, 'hdk_c61_companion')
    result = {'schemaVersion': 1, 'status': 'compiled' if code == 0 else 'failed', 'target': 'esp32c61',
        'physicalTestStatus': 'not-run', 'boardSourceSha256': facts['source']['sha256'], 'boardFacts': facts,
        'sourceSha256': hashlib.sha256(''.join(i['sha256'] for i in source_files).encode()).hexdigest(),
        'idf': {'path': str(idf), 'version': 'v6.1', 'commit': commit}, 'packagePath': str(package),
        'artifactRoot': str(area), 'sourceDir': str(source), 'manifestPath': str(area / 'firmware-manifest.json'),
        'binding': binding(facts), 'protocol': PROTOCOL, 'console': {'interface': 'C61 UART0 via P4 UART1', **{k: PROTOCOL[k] for k in ['baud','dataBits','parity','stopBits']}},
        'fixtureDesign':fixture_design(facts),
        'buildCommand': command, 'scratchBuildPath': str(build), 'exitCode': code,
        'durationSeconds': round(time.time()-started, 2), 'toolchain': tool,
        'artifacts': source_files + [helper.artifact(log, area, 'buildLog')],
        'tests': tests_manifest(), 'flash': None,
        'warnings': ['未刷写任何硬件；芯片LINK/无线结果等待用户实板验证。',
            '该UART companion只测真实LINK及Wi-Fi扫描，不是ESP-Hosted slave，不能与ESP-Hosted master混用。']}
    if code == 0:
        shutil.copyfile(scratch_source / 'sdkconfig', source / 'sdkconfig')
        result['artifacts'].append(helper.artifact(source / 'sdkconfig', area, 'sdkconfig'))
        flash_file = destination / 'flasher_args.json'; layout = json.loads(flash_file.read_text())
        replay = list(layout['write_flash_args'])
        for offset, relative in layout['flash_files'].items(): replay += [offset, relative]
        (destination / 'flash_args').write_text(shlex.join(replay)+'\n', encoding='utf-8')
        offsets = []
        for offset, relative in layout['flash_files'].items():
            file = destination / relative
            offsets.append({'offset': offset, 'path': str(file), 'relativePath': file.relative_to(area).as_posix(), 'sha256': sha(file)})
        files = [('hdk_c61_companion.elf','elf'),('hdk_c61_companion.map','map'),('hdk_c61_companion.bin','applicationBin'),
            ('flasher_args.json','flashArgs'),('flash_args','flashArgsText'),('bootloader/bootloader.bin','bootloaderBin'),('partition_table/partition-table.bin','partitionBin')]
        for relative, role in files: result['artifacts'].append(helper.artifact(destination / relative, area, role))
        merged = area / 'esp32c61-companion-merged.bin'
        merge = [tool['python'], '-m', 'esptool', '--chip', 'esp32c61', 'merge-bin', '-o', str(merged)]
        for offset, relative in layout['flash_files'].items(): merge += [offset, str(destination / relative)]
        merge_code = helper._run(merge, env, source, log, timeout=120)
        if merge_code: result['status'] = 'failed'; result['warnings'].append('C61合并镜像未成功生成。')
        else:
            result['artifacts'].append(helper.artifact(merged, area, 'mergedBin'))
            result['flash'] = {'offsets': offsets, 'flashArgsPath': str(flash_file), 'mergedPath': str(merged), 'mergedOffset': '0x0',
                'commandTemplate': 'python -m esptool --chip esp32c61 --port C61_UART_PORT --before no-reset --after no-reset write-flash 0x0 '+shlex.quote(merged.name)}
            guide = write_flashing_guide(result)
            result['artifacts'].append(helper.artifact(guide, area, 'companionFlashGuide'))
        # Merge step appends to the log, refresh its exact bytes.
        result['artifacts'] = [helper.artifact(i['path'], area, i['role']) for i in result['artifacts']]
        shutil.rmtree(scratch)
    _json(result['manifestPath'], result)
    return result


def compile_package(facts, package_path, toolchain_profile=None):
    return compile(generate(facts, package_path), toolchain_profile)


def validate_build(value):
    report_path = Path(value if isinstance(value, (str, Path)) else value['manifestPath']).resolve()
    report = json.loads(report_path.read_text()); root = Path(report['artifactRoot']).resolve()
    if not report_path.is_relative_to(root): raise ValueError('C61清单不属于本次构建目录。')
    helper = _fw(); errors = []; checks = {}; roles = collections.defaultdict(list)
    for entry in report.get('artifacts', []):
        path = Path(entry['path'])
        if path.is_symlink() or not path.resolve().is_relative_to(root):
            errors.append('C61产物缺失/变化/越界：'+entry['role']); continue
        if path.resolve().relative_to(root).as_posix() != entry['relativePath']:
            errors.append('C61相对路径不符。'); continue
        if helper.is_os_metadata(entry['relativePath']): continue
        if not path.is_file() or sha(path) != entry['sha256'] or path.stat().st_size != entry['bytes']:
            errors.append('C61产物缺失/变化/越界：'+entry['role']); continue
        roles[entry['role']].append((path,path.read_bytes()))
    checks['artifactHashes'] = not errors
    required_roles = {'source','buildLog','elf','map','applicationBin','flashArgs','flashArgsText',
        'bootloaderBin','partitionBin','mergedBin','companionFlashGuide'}
    checks['requiredArtifactsPresent'] = required_roles.issubset(roles)
    try:
        elf = roles['elf'][0][1]; app = roles['applicationBin'][0][1]; boot = roles['bootloaderBin'][0][1]
        checks['elfRiscV32'] = elf[:4] == b'\x7fELF' and elf[4:6] == b'\x01\x01' and struct.unpack_from('<H',elf,18)[0] == 243
        images = [helper._esp_image(image) for image in (app,boot)]
        checks['chipIdEsp32c61'] = all(image['chipId'] == 20 for image in images)
        checks['applicationMatchesElf'] = images[0]['appElfSha256'] == hashlib.sha256(elf).hexdigest()
        checks['boardHashEmbedded'] = report['boardSourceSha256'].encode() in app
        flash = json.loads(roles['flashArgs'][0][1]); build = roles['flashArgs'][0][0].parent
        merged = roles['mergedBin'][0][1]; delivered = {str(p):sha(p) for items in roles.values() for p,data in items}
        correct = flash['extra_esptool_args']['chip'] == 'esp32c61'
        for offset, relative in flash['flash_files'].items():
            path = (build / relative).resolve(); data = path.read_bytes(); start = int(offset,0)
            item = next((i for i in report['flash']['offsets'] if i['offset'] == offset), None)
            correct = correct and str(path) in delivered and merged[start:start+len(data)] == data
            correct = correct and bool(item and item['sha256'] == sha(path) and Path(item['path']).resolve() == path)
        checks['flashLayoutMatchesMerged'] = bool(correct)
        partition = roles['partitionBin'][0][1]; factory = None
        for pos in range(0,len(partition)-31,32):
            magic, kind, subtype, offset, size = struct.unpack_from('<HBBII',partition,pos)
            if magic != 0x50aa: break
            if kind == 0 and subtype == 0: factory = (offset,size)
        checks['partitionFitsApplication'] = bool(factory and int(flash['app']['offset'],0) == factory[0] and len(app) <= factory[1])
        checks['replayFlashArgs'] = report['scratchBuildPath'] not in roles['flashArgsText'][0][1].decode()
    except Exception as error: errors.append('C61构建证据读取失败：'+str(error))
    try:
        current = _current(report['boardFacts'])
        checks['sourceBoardUnchanged'] = current['source']['sha256'] == report['boardSourceSha256']
        checks['actualWiringBound'] = binding(current) == report['binding']
        checks['ordinaryHeaderCoverage'] = fixture_design(current) == report.get('fixtureDesign')
        header = (Path(report['sourceDir'])/'main/companion_config.h').read_text()
        checks['fixtureConfigMatchesSource'] = header == _config(current)
    except Exception as error: errors.append(str(error))
    checks['physicalPassNotClaimed'] = report.get('physicalTestStatus') == 'not-run'
    checks['buildExitCode'] = report.get('exitCode') == 0 and report.get('status') == 'compiled'
    checks['fixedSdkCommit'] = report.get('idf',{}).get('commit') == SDK_COMMIT
    for check, passed in checks.items():
        if not passed: errors.append('C61检查未通过：'+check)
    return {'schemaVersion':1, 'status':'complete' if not errors else 'blocked',
        'manifestPath':str(report_path), 'target':'esp32c61', 'physicalTestStatus':'not-run',
        'boardSourceSha256':report.get('boardSourceSha256'),
        'checks':checks,'errors':errors,'artifacts':[item for item in report.get('artifacts',[]) if not helper.is_os_metadata(item['path'])]}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('action',choices=['generate','compile','verify'])
    parser.add_argument('--facts'); parser.add_argument('--package'); parser.add_argument('--generation'); parser.add_argument('--output')
    args = parser.parse_args()
    if args.action == 'generate': result = generate(json.loads(Path(args.facts).read_text()),args.package)
    elif args.action == 'compile': result = compile(json.loads(Path(args.generation).read_text()))
    else: result = validate_build(args.generation)
    if args.output: _json(args.output,result)
    print(json.dumps(result,ensure_ascii=False))
