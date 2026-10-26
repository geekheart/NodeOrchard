"""Pinned, read-only SDK setup evidence for board user-guide facts.

No installer, compiler, firmware or terminal activation is executed here. Shell
blocks are documentation assembled from verified official scripts. The SDK and
BSP remain separate directories, and the first blink installs only its primary
processor target. Existing C61 programming and manual-download scope is copied
without alteration.
"""
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess


SDK_REPOSITORY = 'https://github.com/espressif/esp-idf.git'
SDK_COMMIT = 'fff9895c82d744c7237be8847347bdd1b07c6643'
BSP_REPOSITORY = 'https://github.com/Wireless-TAG-Maker/WT_BSP.git'
BSP_COMMIT = '916139150e8488b660942078da178b6e76a8f4a1'
EVIDENCE_CACHE = Path(__file__).resolve().parents[1] / '.local' / 'guide-sdk-evidence'
UNIX_SETUP = 'docs/en/get-started/linux-macos-setup-legacy.rst'
WINDOWS_SETUP = 'docs/en/get-started/windows-setup-update-legacy.rst'
WINDOWS_CURRENT = 'docs/en/get-started/windows-setup.rst'
PROJECT_GUIDE = 'docs/en/get-started/start-project.rst'
BLINK_SOURCE = 'examples/get-started/blink/main/main.c'
P4_BOARD_DEFAULTS = 'examples/get-started/blink/sdkconfig.wt9932p4c61_tiny'
P4_TARGET_DEFAULTS = 'examples/get-started/blink/sdkconfig.defaults.esp32p4'


class GuideSdkBlocked(ValueError):
    pass


def _git(repo, *arguments):
    result = subprocess.run(['git', '-C', str(repo), *arguments], capture_output=True, timeout=20,
                            env={**os.environ, 'GIT_TERMINAL_PROMPT': '0', 'GIT_NO_LAZY_FETCH': '1'})
    if result.returncode or len(result.stdout) > 2_000_000:
        raise GuideSdkBlocked('Pinned SDK/BSP source is unavailable; prepare the verified local checkout first')
    return result.stdout


def _repository(value, remote, commit):
    if not isinstance(value, dict) or set(value) != {'path', 'commit', 'remote'}:
        raise GuideSdkBlocked('SDK/BSP evidence must specify path, exact commit and official remote')
    if value['commit'] != commit or not isinstance(value['remote'], str) or value['remote'].removesuffix('.git') != remote.removesuffix('.git'):
        raise GuideSdkBlocked('SDK/BSP evidence differs from the reviewed official version')
    if not isinstance(value['path'], str) or not value['path'].strip():
        raise GuideSdkBlocked('SDK/BSP source path must be a nonempty string')
    repo = Path(value['path']).expanduser().resolve()
    if not repo.is_dir():
        raise GuideSdkBlocked('SDK/BSP checkout does not exist')
    head = _git(repo, 'rev-parse', 'HEAD').decode().strip()
    origin = _git(repo, 'remote', 'get-url', 'origin').decode().strip()
    if head != commit or origin.removesuffix('.git') != remote.removesuffix('.git'):
        raise GuideSdkBlocked('SDK/BSP checkout HEAD or remote changed')
    return repo


def _blob(repo, commit, relative, *, require_file=False):
    oid = _git(repo, 'rev-parse', commit + ':' + relative).decode().strip()
    if not re.fullmatch(r'[a-f0-9]{40}', oid):
        raise GuideSdkBlocked('Expected a SHA-1 Git blob for the pinned source')
    data = _git(repo, 'cat-file', 'blob', oid)
    if hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest() != oid:
        raise GuideSdkBlocked('Pinned SDK/BSP Git object contents failed verification')
    path = repo / relative
    if require_file and not path.is_file():
        raise GuideSdkBlocked('SDK documentation/script is absent from the local checkout')
    if path.is_file() and path.read_bytes() != data:
        raise GuideSdkBlocked('SDK/BSP working source differs from its pinned Git object')
    return data, {'relativePath': relative, 'sha256': hashlib.sha256(data).hexdigest(), 'gitBlob': oid}


def _require(text, expressions, label):
    if any(not re.search(expression, text, re.S) for expression in expressions):
        raise GuideSdkBlocked('Verified source no longer supports ' + label)


def _url(remote, commit, relative):
    return remote.removesuffix('.git') + '/blob/' + commit + '/' + relative


def _merge_source_files(existing, additions):
    result = copy.deepcopy(existing)
    by_path = {item['path']: item for item in result if isinstance(item, dict) and item.get('path')}
    for item in additions:
        if item['path'] in by_path:
            if by_path[item['path']].get('sha256') != item['sha256']:
                raise GuideSdkBlocked('Existing SDK evidence has a different source hash')
        else:
            result.append(item); by_path[item['path']] = item
    return result


def _cached_bsp_proof(data, proof):
    """Materialize an already Git-verified blob without changing the checkout."""
    path = EVIDENCE_CACHE / BSP_COMMIT / proof['relativePath']
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.open('xb') as destination:
            destination.write(data)
    except FileExistsError:
        pass
    if path.is_symlink() or not path.is_file() or path.read_bytes() != data:
        raise GuideSdkBlocked('Cached BSP evidence differs from its verified Git object')
    return {**proof, 'path': str(path), 'repository': BSP_REPOSITORY, 'commit': BSP_COMMIT,
            'url': _url(BSP_REPOSITORY, BSP_COMMIT, proof['relativePath'])}


def _config_values(data):
    values = {}
    for line in data.decode('utf-8').splitlines():
        match = re.fullmatch(r'(CONFIG_[A-Z0-9_]+)=(.*)', line.strip())
        disabled = re.fullmatch(r'# (CONFIG_[A-Z0-9_]+) is not set', line.strip())
        if match or disabled:
            key, value = (match.group(1), match.group(2)) if match else (disabled.group(1), 'n')
            if key in values:
                raise GuideSdkBlocked('Duplicate BSP configuration value requires review')
            values[key] = value
    return values


def _p4_build_constraints(bsp):
    expected = {
        P4_BOARD_DEFAULTS: {'CONFIG_WT_BSP_BOARD_WT9932P4C61_TINY': 'y',
                            'CONFIG_ESP32P4_SELECTS_REV_LESS_V3': 'n', 'CONFIG_ESP32P4_REV_MIN_301': 'y'},
        P4_TARGET_DEFAULTS: {'CONFIG_ESPTOOLPY_FLASHSIZE_16MB': 'y', 'CONFIG_ESPTOOLPY_FLASHSIZE': '"16MB"',
                             'CONFIG_SPIRAM': 'y', 'CONFIG_SPIRAM_MODE_HEX': 'y', 'CONFIG_SPIRAM_SPEED_200M': 'y'}}
    verified = []
    for relative, required in expected.items():
        data, proof = _blob(bsp, BSP_COMMIT, relative)
        values = _config_values(data)
        if any(values.get(key) != value for key, value in required.items()):
            raise GuideSdkBlocked('Pinned P4 first-blink revision or memory defaults require fresh review')
        verified.append((data, proof))
    proofs = [_cached_bsp_proof(data, proof) for data, proof in verified]
    return {'scope': 'pinned-bsp-first-blink-defaults', 'supportsCurrentHardware': 'unconfirmed',
        'minimumChipRevision': '3.1', 'flashSizeMB': 16,
        'psram': {'enabled': True, 'mode': 'HEX', 'speedMHz': 200},
        'descriptionZh': '首次 RGB 示例使用所固定 WT_BSP 提交的原始默认配置：ESP32-P4 最低芯片修订版为 3.1（CONFIG_ESP32P4_REV_MIN_301=y，未启用 REV_LESS_V3），Flash 为 16 MB，启用 HEX 模式、200 MHz PSRAM。这些是示例的构建前提，不是已确认的实板配置；当前工程和照片不能确认实际芯片修订版及完整存储型号。烧录前先核实实板与这些默认值相符，不符或未确认时暂停烧录并调整匹配配置。此前 HDK 测试固件采用独立的 legacy 配置，不能与此示例的默认构建产物混用。',
        'descriptionEn': 'The first RGB example uses the pinned WT_BSP defaults: ESP32-P4 minimum chip revision 3.1 (CONFIG_ESP32P4_REV_MIN_301=y; REV_LESS_V3 is disabled), 16 MB Flash, and enabled HEX-mode PSRAM at 200 MHz. These are example build requirements, not confirmed fitted-board specifications; the project and photos do not establish the actual silicon revision or full memory variant. Verify the physical board against these defaults before flashing; stop and select a matching configuration if they differ or remain unknown. The earlier HDK test firmware uses a separate legacy configuration and must not be interchanged with this default example build.',
        'sourceProofs': proofs}


def _sdk_setup(target, proofs):
    unix_root = '$HOME/esp/esp-idf-v6.1'
    windows_root = r'%USERPROFILE%\esp\esp-idf-v6.1'
    unix = '\n'.join(['mkdir -p "$HOME/esp"', 'cd "$HOME/esp"',
        'git clone ' + SDK_REPOSITORY + ' esp-idf-v6.1', 'cd "' + unix_root + '"',
        'git checkout ' + SDK_COMMIT, 'git submodule update --init --recursive',
        './install.sh ' + target, '. ./export.sh', 'cd "$HOME/esp"'])
    windows = '\n'.join([r'if not exist "%USERPROFILE%\esp" mkdir "%USERPROFILE%\esp"',
        r'cd /d "%USERPROFILE%\esp"', 'git clone ' + SDK_REPOSITORY + ' esp-idf-v6.1',
        'cd /d "' + windows_root + '"', 'git checkout ' + SDK_COMMIT,
        'git submodule update --init --recursive', 'call install.bat ' + target,
        'call export.bat', r'cd /d "%USERPROFILE%\esp"'])
    value = {'method': 'pinned-source-scripts', 'repository': SDK_REPOSITORY, 'commit': SDK_COMMIT, 'target': target,
        'prerequisitesZh': '先按下方官方平台文档准备 Git、Python 3.10 及以上版本和系统构建依赖。以下为固定源码提交的脚本安装方式；ESP-IDF v6.0 起官方默认推荐 EIM，已有匹配环境可直接激活。',
        'prerequisitesEn': 'Install Git, Python 3.10 or newer, and the host build prerequisites from the official platform links below. These scripts reproduce the pinned source commit; EIM is the default recommendation from ESP-IDF v6.0. An existing matching environment only needs activation.',
        'pathNoteZh': '示例安装目录及工程路径应为无空格的 ASCII 路径；若用户主目录不满足此条件，请一致替换为自己可写的 ASCII 目录。首次安装使用新目录，不覆盖已有 SDK。',
        'pathNoteEn': 'Use writable ASCII paths without spaces for the SDK and project. If your home path does not meet this condition, replace the example paths consistently. Use a new SDK directory for first installation.',
        'platforms': {
            'unix': {'shell': 'bash/zsh', 'installShell': unix,
                     'activateShell': '. "' + unix_root + '/export.sh"\ncd "$HOME/esp"',
                     'cwdZh': 'macOS / Linux：脚本安装及激活位于 ESP-IDF 根目录；最后切回其父目录。',
                     'cwdEn': 'macOS / Linux: install and activate in the ESP-IDF root, then return to its parent directory.'},
            'windowsCmd': {'shell': 'cmd.exe', 'installShell': windows,
                           'activateShell': 'cd /d "' + windows_root + '"\ncall export.bat\n' + r'cd /d "%USERPROFILE%\esp"',
                           'cwdZh': 'Windows：以下为 CMD 命令，不用于 PowerShell；install.bat / export.bat 在 ESP-IDF 根目录执行。',
                           'cwdEn': 'Windows: these commands use CMD, not PowerShell; run install.bat / export.bat in the ESP-IDF root.'}},
        'handoffZh': '每次新开终端先激活匹配的 SDK。保持同一终端，再按下节将 WT_BSP 克隆为 SDK 的同级目录；不要在 WT_BSP 目录运行 SDK 安装脚本。这里只安装首个 RGB 示例的主处理器工具，C61 单独开发另按配套说明配置。' if target == 'esp32p4' else '每次新开终端先激活匹配的 SDK。保持同一终端，再按下节将 WT_BSP 克隆为 SDK 的同级目录；不要在 WT_BSP 目录运行 SDK 安装脚本。S31 的 idf.py 命令仍使用 --preview。',
        'handoffEn': 'Activate the matching SDK in every new terminal. In that same terminal, clone WT_BSP beside the SDK as shown next; do not run SDK installation scripts in WT_BSP. Only the primary processor tools are installed for the first RGB example; separate C61 development follows its own instructions.' if target == 'esp32p4' else 'Activate the matching SDK in every new terminal. In that same terminal, clone WT_BSP beside the SDK as shown next; do not run SDK installation scripts in WT_BSP. Keep --preview on S31 idf.py commands.',
        'sourceProofs': {name: proof['gitBlob'] for name, proof in proofs.items()}, 'executed': False}
    value['minimumPython'] = '3.10'
    for language in ('Zh', 'En'):
        value['description' + language] = value.pop('prerequisites' + language) + '\n\n' + value.pop('pathNote' + language)
    for name, platform in value['platforms'].items():
        platform['titleZh'] = 'Windows CMD' if name == 'windowsCmd' else 'macOS / Linux 终端'
        platform['titleEn'] = 'Windows CMD' if name == 'windowsCmd' else 'macOS / Linux terminal'
        platform['noteZh'] = platform.pop('cwdZh')
        platform['noteEn'] = platform.pop('cwdEn')
    return value


def enrich_guide_development(facts, request):
    """Return a detached facts copy with checked setup/monitor/blink evidence."""
    if not isinstance(facts, dict) or not isinstance(request, dict) or not isinstance(facts.get('board'), dict):
        raise GuideSdkBlocked('SDK enrichment requires source facts and the original request')
    target = facts['board'].get('primaryTarget')
    if target not in ('esp32s31', 'esp32p4'):
        raise GuideSdkBlocked('First-blink SDK recipe has not been reviewed for this target')
    if not isinstance(facts.get('development', {}), dict) or not isinstance(facts.get('sourceFiles', []), list) or not isinstance(facts.get('primaryDocuments', []), list):
        raise GuideSdkBlocked('Guide development and source evidence have invalid shapes')
    if not isinstance(facts.get('features', {}).get('rgb'), dict):
        raise GuideSdkBlocked('First-blink behavior requires a source-confirmed board RGB LED')
    sdk = _repository(request.get('sdkRepository'), SDK_REPOSITORY, SDK_COMMIT)
    bsp = _repository(request.get('bspRepository'), BSP_REPOSITORY, BSP_COMMIT)
    paths = [UNIX_SETUP, WINDOWS_SETUP, WINDOWS_CURRENT, PROJECT_GUIDE, 'README.md',
             'install.sh', 'install.bat', 'export.sh', 'export.bat', 'tools/install_util.py', 'tools/tools.json']
    contents, proofs = {}, {}
    for relative in paths:
        data, proofs[relative] = _blob(sdk, SDK_COMMIT, relative, require_file=True)
        contents[relative] = data.decode('utf-8')
    _require(contents[UNIX_SETUP], [r'Python 3\.10', r'\./install\.sh \{IDF_TARGET_PATH_NAME\}', r'\. \$HOME/esp/esp-idf/export\.sh'], 'Unix SDK installation and activation')
    _require(contents[WINDOWS_SETUP], [r'install\.bat', r'export\.bat'], 'Windows CMD SDK installation and activation')
    _require(contents[WINDOWS_CURRENT], [r'default and recommended', r'EIM'], 'the Windows EIM recommendation')
    _require(contents['README.md'], [r'git submodule update --init --recursive', r'every shell environment'], 'fixed-source SDK setup')
    _require(contents[PROJECT_GUIDE], [r'To exit IDF monitor use the shortcut ``Ctrl\+\]``'], 'the IDF Monitor exit shortcut')
    _require(contents['install.sh'], [r'extract targets', r'install-python-env'], 'the Unix target-specific installer')
    _require(contents['install.bat'], [r'CMD\.EXE shell only', r'extract targets', r'install-python-env'], 'the CMD target-specific installer')
    _require(contents['tools/install_util.py'], [r'comma-separated', r'targets'], 'target installer arguments')
    tools = json.loads(contents['tools/tools.json'])
    if target not in {target for tool in tools.get('tools', []) for target in tool.get('supported_targets', [])}:
        raise GuideSdkBlocked('The SDK tools manifest does not support the selected primary target')
    blink_data, blink_proof = _blob(bsp, BSP_COMMIT, BLINK_SOURCE)
    blink = blink_data.decode('utf-8')
    _require(blink, [r'r\s*=\s*esp_random\(\)\s*%\s*255', r'g\s*=\s*esp_random\(\)\s*%\s*255',
                     r'b\s*=\s*esp_random\(\)\s*%\s*255', r'example_set_led_color\(r,\s*g,\s*b\)',
                     r'wt_bsp_rgb_set_pixel', r'wt_bsp_rgb_refresh', r'vTaskDelay\(1000\s*/\s*portTICK_PERIOD_MS\)'], 'the example RGB behavior')
    result = copy.deepcopy(facts)
    development = result.setdefault('development', {})
    development['sdkSetup'] = _sdk_setup(target, proofs)
    development['monitorExit'] = {'keys': 'Ctrl+]', 'descriptionZh': '在 IDF Monitor 中按 Ctrl+] 退出监视器。',
                                  'descriptionEn': 'Press Ctrl+] in IDF Monitor to exit the monitor.', 'sourceRole': 'idf-project-reference'}
    development['expectedBlink'] = {'periodMs': 1000,
        'descriptionZh': '该示例约每 1 秒为板载 RGB LED 随机更新一次颜色；不是固定亮灭序列。此为源码预期行为，本次未进行实板验证。',
        'descriptionEn': 'The example updates the onboard RGB LED to a random color about once per second; it is not a fixed on/off sequence. This is source-derived expected behavior, not a physical test result.',
        'physicalTestStatus': 'not-run', 'source': {**blink_proof, 'repository': BSP_REPOSITORY, 'commit': BSP_COMMIT,
                                                  'url': _url(BSP_REPOSITORY, BSP_COMMIT, BLINK_SOURCE)}}
    additions = []
    docs = [(UNIX_SETUP, 'idf-unix-setup-reference', 'ESP-IDF macOS / Linux 安装与激活', 'ESP-IDF macOS / Linux installation and activation'),
            (WINDOWS_SETUP, 'idf-windows-setup-reference', 'ESP-IDF Windows CMD 安装与激活', 'ESP-IDF Windows CMD installation and activation'),
            (PROJECT_GUIDE, 'idf-project-reference', 'ESP-IDF 构建、烧录与 Monitor', 'ESP-IDF build, flash and Monitor')]
    primary = copy.deepcopy(result.get('primaryDocuments', []))
    for relative, role, title_zh, title_en in docs:
        path = sdk / relative
        additions.append({'path': str(path), 'name': path.name, 'role': role, 'sha256': proofs[relative]['sha256'],
                          'sourceCommit': SDK_COMMIT, 'gitBlob': proofs[relative]['gitBlob']})
        url = _url(SDK_REPOSITORY, SDK_COMMIT, relative)
        if not any(item.get('url') == url for item in primary):
            primary.append({'titleZh': title_zh, 'titleEn': title_en, 'role': role, 'url': url})
    if target == 'esp32p4':
        constraints = _p4_build_constraints(bsp)
        development['defaultBuildConstraints'] = constraints
        titles = {
            P4_BOARD_DEFAULTS: ('WT_BSP P4 首例芯片修订版默认配置', 'WT_BSP first P4 example revision defaults'),
            P4_TARGET_DEFAULTS: ('WT_BSP P4 首例存储器默认配置', 'WT_BSP first P4 example memory defaults')}
        for proof in constraints['sourceProofs']:
            additions.append({'path': proof['path'], 'name': Path(proof['path']).name,
                              'role': 'bsp-first-blink-defaults', 'sha256': proof['sha256'],
                              'sourceCommit': BSP_COMMIT, 'gitBlob': proof['gitBlob'],
                              'relativePath': proof['relativePath']})
            if not any(item.get('url') == proof['url'] for item in primary):
                title_zh, title_en = titles[proof['relativePath']]
                primary.append({'titleZh': title_zh, 'titleEn': title_en,
                                'role': 'bsp-first-blink-defaults', 'url': proof['url']})
    result['sourceFiles'] = _merge_source_files(result.get('sourceFiles', []), additions)
    result['primaryDocuments'] = primary
    return result
