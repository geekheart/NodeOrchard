"""Portable bilingual board guides assembled from source facts and Skill prose.

Electrical tables, identifiers and commands are never invented by this renderer.
Known-result guides are intentionally not inputs to this module.
"""
from pathlib import Path
from html import escape as xml_escape
from urllib.parse import quote, urlsplit
import hashlib
import json
import re


class GuideRenderBlocked(ValueError):
    pass


def _text(value):
    return str(value if value is not None else '').replace('\r', '').strip()


def _cell(value):
    return xml_escape(_text(value), quote=False).replace('|', '&#124;').replace('\n', '<br>')


def _table(headings, rows):
    return '\n'.join(['| ' + ' | '.join(_cell(v) for v in headings) + ' |',
                      '| ' + ' | '.join('---' for _ in headings) + ' |'] +
                     ['| ' + ' | '.join(_cell(v) for v in row) + ' |' for row in rows])


def _prose(value):
    value = _text(value)
    if not value:
        raise GuideRenderBlocked('Required bilingual narrative paragraph is empty')
    if re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f]|(?:^|\n)\s*(?:#{1,6}\s|\||!\[|```)|!?\[[^\]]*\]\([^)]*\)|<\s*/?\s*(?:script|iframe|img|a)\b', value, re.I):
        raise GuideRenderBlocked('Narrative must contain plain explanatory paragraphs, not headings, links, tables or executable markup')
    return value


def _narrative(value):
    if not isinstance(value, dict):
        raise GuideRenderBlocked('Narrative must be a JSON object')
    result = {}
    for name in ('overview', 'hardware', 'power', 'preparation', 'development', 'notice'):
        field = value.get(name)
        if not isinstance(field, dict):
            raise GuideRenderBlocked('Missing bilingual narrative field: ' + name)
        result[name] = {language: _prose(field.get(language)) for language in ('zh', 'en')}
    features = value.get('features')
    if not isinstance(features, list) or not 1 <= len(features) <= 12:
        raise GuideRenderBlocked('Narrative requires a bounded feature list')
    result['features'] = [{language: _prose(feature.get(language)) for language in ('zh', 'en')} for feature in features]
    issues = value.get('troubleshooting')
    if not isinstance(issues, list) or not 1 <= len(issues) <= 12:
        raise GuideRenderBlocked('Narrative requires bounded troubleshooting entries')
    result['troubleshooting'] = [{key: _prose(issue.get(key)) for key in ('symptomZh', 'symptomEn', 'actionZh', 'actionEn')} for issue in issues]
    return result


def _local_asset(value, root):
    if not isinstance(value, str) or not value:
        return None
    parsed = urlsplit(value)
    if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment or Path(value).is_absolute() or '\\' in value:
        raise GuideRenderBlocked('Guide assets must be portable local paths')
    path = (root / value).resolve()
    if not path.is_relative_to(root) or not path.is_file() or not path.stat().st_size:
        raise GuideRenderBlocked('Guide asset missing or outside bundle: ' + value)
    return path.relative_to(root).as_posix()


def _asset(assets, key, label, language):
    if value := assets.get(key):
        return f'![{label}]({quote(value, safe="/")})'
    return ('本次资料未提供可发布的对应图片。' if language == 'zh' else
            'A publishable image for this item is not included in the supplied material.')


def _voltage(net, language):
    # A rail name is connectivity evidence, not a device absolute maximum rating.
    if net == 'GND':
        return '0 V（GND）' if language == 'zh' else '0 V (GND)'
    if re.fullmatch(r'\+?\d+(?:\.\d+)?V', net) or net in ('3V3', '+3V3'):
        return f'{net} 电源网络' if language == 'zh' else f'{net} power net'
    return '未给出额定值；查阅原理图' if language == 'zh' else 'Rating unspecified; see schematic'


def _pin_rows(interface, language):
    rows = []
    for pin in interface.get('pins', []):
        number, net = _text(pin.get('number')), _text(pin.get('net'))
        module_pins = pin.get('modulePins', [])
        mapping = '; '.join(f'{_text(p.get("number"))}: {_text(p.get("name"))}' for p in module_pins)
        name = _text(pin.get('name'))
        notes = ('模组引脚 ' if language == 'zh' else 'Module pin ') + mapping if mapping else ('按当前工程连接；空网络表示未连接' if language == 'zh' else 'Current source connection; an empty net means unconnected')
        rows.append([number, net, name, _voltage(net, language), notes])
    return rows


def _commands(facts):
    development = facts.get('development', {})
    raw = development.get('commands', development.get('verifiedCommands', facts.get('verifiedCommands', [])))
    if isinstance(raw, str):
        raw = [{'shell': raw}]
    result = []
    for item in raw or []:
        if isinstance(item, str):
            item = {'shell': item}
        shell = _text(item.get('shell', item.get('command', item.get('commands'))))
        if not shell or '\x00' in shell or '```' in shell:
            raise GuideRenderBlocked('Verified command must be a literal fenced-safe shell block')
        result.append(dict(item, shell=shell))
    return result


def _source_documents(facts):
    documents = list(facts.get('primaryDocuments', facts.get('documentation', [])) or [])
    vendor = facts.get('development', {}).get('vendor', {})
    if vendor.get('repository') and not any(d.get('url') == vendor['repository'] for d in documents if isinstance(d, dict)):
        documents.append({'titleZh': '已核对的厂商软件仓库', 'titleEn': 'Verified vendor software repository', 'url': vendor['repository']})
    result = []
    for item in documents:
        if not isinstance(item, dict):
            continue
        url = _text(item.get('url'))
        if url and (urlsplit(url).scheme not in ('https', 'http') or any(c in url for c in '\n\r<>')):
            raise GuideRenderBlocked('Primary document URL must be an explicit HTTP(S) source')
        if url or item.get('bundlePath'):
            result.append({**item, 'url': url})
    return result


def _contacts(facts, language):
    items = facts.get('contacts', [])
    lines = []
    for item in items:
        if not isinstance(item, dict):
            continue
        label = _text(item.get('labelZh' if language == 'zh' else 'labelEn', item.get('label', '')))
        value = _text(item.get('value'))
        url = _text(item.get('url'))
        if url:
            if urlsplit(url).scheme not in ('https', 'http', 'mailto') or any(c in url for c in '\n\r<>'):
                raise GuideRenderBlocked('Contact URL is invalid')
            lines.append(f'- [{_cell(label or value or url)}]({quote(url, safe=":/?=&@+%#")})')
        elif label or value:
            lines.append(f'- {_cell(label)}：{_cell(value)}')
    return '\n'.join(lines) if lines else ('本次输入资料没有提供经过核实的联系方式，因此不填写电话号码、邮箱或二维码。技术支持请查阅上节列出的原始官方资料。' if language == 'zh' else 'No verified contact details were supplied for this edition. No telephone number, email address or support QR code is invented here; consult the original official sources listed above for support.')


def _render_language(facts, narrative, assets, language, evidence_name):
    zh = language == 'zh'
    tr = lambda a, b: a if zh else b
    product = facts['productCode']
    board, dimensions, development = (facts.get(key, {}) for key in ('board', 'dimensions', 'development'))
    interfaces = facts.get('interfaces', [])
    if isinstance(interfaces, dict):
        interfaces = [dict(value, ref=ref) for ref, value in interfaces.items()]
    components = [c for c in facts.get('components', []) if c.get('kind') != 'other']
    title = lambda item: _text(item.get('titleZh' if zh else 'titleEn', item.get('part', '')))
    lines = [f'# {product} ' + tr('使用指南', 'User Guide'),
             f'[{tr("English", "简体中文")}]({quote(product + ("_User_Guide_en.md" if zh else "_User_Guide.md"))})',
             tr('## 免责声明', '## Disclaimer'),
             narrative['notice'][language],
             tr('本文根据当前工程、照片与已核对的软件资料编写。连接关系以当前工程为准；标注照片用于识别器件和接口，不代替电气规格。未提供的信息保持未确认状态。编译完成不代表经过实板测试。',
                'This guide is based on the current engineering project, supplied photographs and verified software material. The current project defines the connections. Annotated photographs identify components and connectors; they do not replace electrical specifications. Unprovided information remains unconfirmed. A successful build does not establish physical board operation.'),
             tr('## 版本记录', '## Revision History'),
             _table([tr('版本', 'Version'), tr('日期', 'Date'), tr('范围', 'Scope')],
                    [[facts.get('hardwareVersion', ''), facts.get('releaseDate', ''), tr('依据本次资料生成的中英文版本', 'Bilingual edition generated from the supplied sources')]]),
             '# 1. ' + tr('开发板简介', 'Board Overview'),
             '## 1.1 ' + tr('开发板介绍', 'Development Board Introduction'), narrative['overview'][language],
             _table([tr('项目', 'Item'), tr('当前资料', 'Current source value')], [
                 [tr('产品', 'Product'), product], [tr('主控模组位号', 'Processor module reference'), board.get('moduleRef', '')],
                 [tr('模组型号', 'Module part'), board.get('modulePart', '')],
                 [tr('主要开发目标', 'Primary development target'), board.get('primaryTarget', '')],
                 [tr('工程记录的芯片目标', 'Chip targets recorded by source'), ', '.join(board.get('targets', []))]]),
             '## 1.2 ' + tr('产品特点', 'Product Features'),
             '\n'.join('- ' + item[language] for item in narrative['features']),
             '## 1.3 ' + tr('开发板图片', 'Board Photographs'),
             _asset(assets, 'front', product + tr(' 正面原图', ' front source photograph'), language),
             _asset(assets, 'back', product + tr(' 背面原图', ' back source photograph'), language),
             '\n\n'.join(tr('照片来源注记（保留原文）：', 'Source photograph note (original wording retained): ') + _cell(image.get('noteZh' if zh else 'noteEn', image.get('note', '')))
                           for image in facts.get('images', []) if image.get('noteZh' if zh else 'noteEn', image.get('note'))),
             '# 2. ' + tr('硬件参考', 'Hardware Reference'),
             '## 2.1 ' + tr('功能框图', 'Functional Block Diagram'),
             _asset(assets, 'block', product + tr(' 源连接功能框图', ' source connection block diagram'), language),
             tr('框图只概括当前工程中可追溯的器件和接口。连接器并不表示对应显示屏、摄像头或其他附件已经随板装配；具体信号方向和复用关系请结合后面的引脚表及原理图。',
                'The diagram summarizes traceable components and interfaces in the current source. A connector does not establish that the corresponding display, camera or other accessory is fitted or included. Use the pin tables and schematic for signal direction and multiplexing details.'),
             ('[' + tr('可编辑 DrawIO 源图', 'Editable DrawIO source') + '](' + quote(assets['block_drawio'], safe='/') + ')') if assets.get('block_drawio') else '',
             ('[' + tr('SVG 矢量图', 'SVG vector export') + '](' + quote(assets['block_svg'], safe='/') + ')') if assets.get('block_svg') else '',
             '## 2.2 ' + tr('硬件外设', 'Hardware Peripherals'), narrative['hardware'][language],
             _table([tr('位号', 'Reference'), tr('外设/接口', 'Peripheral / interface'), tr('源器件型号', 'Source part'), tr('位置', 'Side')],
                    [[c.get('ref', ''), title(c), c.get('part', ''), tr('正面', 'Front') if c.get('side') == 'front' else tr('背面', 'Back')] for c in interfaces]),
             '## 2.3 ' + tr('组件介绍', 'Component Introduction'),
             _asset(assets, 'interface' if zh else 'interface_en', product + tr(' 正面接口标注', ' annotated front interfaces'), language),
             _asset(assets, 'interface_back' if zh else 'interface_back_en', product + tr(' 背面接口标注', ' annotated back interfaces'), language),
             _table([tr('位号', 'Reference'), tr('组件名称', 'Component name'), tr('源器件型号', 'Source part'), tr('说明', 'Description')],
                    [[c.get('ref', ''), title(c), c.get('part', ''), tr('按当前工程和实物照片核对', 'Identify against the current source and photographs')] for c in components]),
             '## 2.4 ' + tr('接口封装', 'Connector Footprints'),
             tr('下表保留源工程的连接器/器件型号，不根据照片猜测间距、额定电流或配套线材。采购和接线前还需核对原始封装及器件规格。',
                'The table preserves connector and component part identifiers from the source project. Pitch, current ratings and cable compatibility are not inferred from photographs. Check the native footprint and component specification before purchasing or connecting accessories.'),
             tr('数量是源工程的焊盘/引脚记录数，可能包含固定焊脚，不能当作排线信号触点数；触点数和排线规格以连接器型号的原始规格书为准。',
                'Counts below are source pad/pin records and may include mechanical mounting pads. They are not cable signal-contact counts; use the connector specification for contact count and cable selection.'),
             _table([tr('位号', 'Reference'), tr('接口', 'Interface'), tr('工程型号/封装标识', 'Source part / footprint identifier'), tr('源焊盘记录数（含固定脚）', 'Source pad records (including mounts)')],
                    [[c.get('ref', ''), title(c), c.get('part', ''), len(c.get('pins', []))] for c in interfaces]),
             '## 2.5 ' + tr('接口说明与引脚定义', 'Interface Description and Pin Definitions'),
             tr('引脚按源工程记录的物理编号顺序列出。网络名和模组引脚名保留原文；电源网络名称不是器件的绝对最大额定值，未核实的信号电压不能据此假定。空网络单元格表示源工程未连接。',
                'Pins are listed in the physical-number order recorded by the source. Net names and module pin identifiers remain unchanged. A power-net name is not an absolute maximum device rating; unspecified signal voltage must not be assumed from it. An empty net cell denotes an unconnected pin in the source.')]
    for interface in interfaces:
        lines += [f'### [{interface.get("ref", "")}] {title(interface)}',
                  _table(['Pin', 'Net', tr('引脚名称/功能标识', 'Pin name / function identifier'), tr('电压依据', 'Voltage evidence'), tr('连接说明', 'Connection notes')], _pin_rows(interface, language))]
    if assets.get('pinout'):
        lines += ['## 2.6 Pinout']
        if assets.get('pinout_back'):
            lines += [tr('正反面实拍图分别校准并标注。翻面后按图中引脚编号定位，不要根据屏幕左右推断针序。',
                         'Front and back photographs are calibrated and labelled separately. Identify pins by the printed numbers after turning the board over; do not infer pin order from screen left and right.'),
                      '### ' + tr('正面实拍 Pinout', 'Front Photograph Pinout'),
                      _asset(assets, 'pinout', product + tr(' 正面实拍 Pinout', ' front photograph Pinout'), language),
                      '### ' + tr('背面实拍 Pinout', 'Back Photograph Pinout'),
                      _asset(assets, 'pinout_back', product + tr(' 背面实拍 Pinout', ' back photograph Pinout'), language)]
        else:
            lines += [_asset(assets, 'pinout', product + ' Pinout', language)]
    lines += ['# 3. ' + tr('原理图', 'Schematic'),
              _asset(assets, 'schematic', product + tr(' 原理图', ' schematic'), language),
              tr('以上预览便于阅读定位，最终电气判断请结合随附的原始原理图文件和源工程。若图片没有覆盖全部页面，以源文件为完整依据。',
                 'The preview helps locate circuits. Base electrical decisions on the supplied original schematic and native project. If the preview does not include every page, the source document remains the complete reference.'),
              '# 4. ' + tr('结构支持', 'Mechanical Support'),
              '## 4.1 ' + tr('PCBA 尺寸图', 'PCBA Dimensions'),
              _asset(assets, 'dimensions', product + tr(' 结构尺寸参考', ' mechanical dimensions reference'), language)]
    if dimensions.get('lengthMm') is not None and dimensions.get('widthMm') is not None:
        lines += [_table([tr('项目', 'Item'), tr('数值', 'Value')], [
            [tr('PCB 轮廓长向范围', 'PCB outline long extent'), f'{dimensions["lengthMm"]} mm'],
            [tr('PCB 轮廓短向范围', 'PCB outline short extent'), f'{dimensions["widthMm"]} mm'],
            [tr('来源状态', 'Source status'), dimensions.get('status', '')],
            [tr('来源方法', 'Source method'), dimensions.get('method', '')]])]
    lines += [tr('这里的 PCB 轮廓数据与装配体/STEP 外包络是不同的尺寸范围。接口外伸、元件高度、装配间隙及公差须以对应原始机械图和三维文件核对；此文不补写未提供的生产公差。',
                 'PCB outline extents and the assembly/STEP bounding envelope describe different scopes. Verify protruding connectors, component height, assembly clearances and tolerances against the original mechanical drawing and 3D model. This guide does not supply unprovided manufacturing tolerances.'),
              '# 5. ' + tr('使用指引', 'Usage Instructions'),
              '## 5.1 ' + tr('准备工作', 'Preparation'), narrative['preparation'][language],
              '## 5.2 ' + tr('硬件接线', 'Hardware Connections and Wiring'), narrative['power'][language],
              tr('连接或更换外设前先断电，按当前接口位号与引脚编号核对方向及共地关系。对未核实的供电电压、引脚容限、线序或附件型号，先查原理图与器件规格再连接。',
                 'Disconnect power before attaching or changing accessories. Match the current reference designators, physical pin numbers, orientation and ground connections. Resolve unverified supply voltage, pin tolerance, cable order or accessory model against the schematic and component specifications before connection.'),
              '## 5.3 ' + tr('使用指南与开发步骤', 'Getting Started and Development')]
    commands = _commands(facts)
    constraints = development.get('defaultBuildConstraints')
    if constraints:
        lines += ['### ' + tr('首例固件的适用条件', 'Default Example Firmware Compatibility'),
                  '**' + tr('构建和烧录前确认：', 'Check before building or flashing:') + '**',
                  constraints.get('descriptionZh' if zh else 'descriptionEn', '')]
    lines.append(narrative['development'][language])
    setup = development.get('sdkSetup')
    if setup:
        lines += ['### 5.3.0 ' + tr('安装并激活匹配的 ESP-IDF', 'Install and Activate the Matching ESP-IDF'),
                  setup.get('descriptionZh' if zh else 'descriptionEn', ''),
                  _table([tr('项目', 'Item'), tr('要求', 'Requirement')], [[tr('Python', 'Python'), setup.get('minimumPython', '')], [tr('SDK 提交', 'SDK commit'), setup.get('commit', '')]])]
        for key, platform in setup.get('platforms', {}).items():
            lines += ['#### ' + platform.get('titleZh' if zh else 'titleEn', key),
                      platform.get('noteZh' if zh else 'noteEn', ''),
                      '```' + ('bat' if key == 'windowsCmd' else 'sh') + '\n' + platform['installShell'] + '\n```',
                      tr('每次新开终端需再次激活：', 'Reactivate in every new terminal:'),
                      '```' + ('bat' if key == 'windowsCmd' else 'sh') + '\n' + platform['activateShell'] + '\n```']
        lines.append(setup.get('handoffZh' if zh else 'handoffEn', ''))
    vendor = development.get('vendor', {})
    sdk = development.get('firmware', {}).get('idf', {})
    version_rows = []
    if vendor.get('repository'):
        version_rows.append([tr('BSP 仓库', 'BSP repository'), vendor['repository']])
    if vendor.get('commit'):
        version_rows.append([tr('BSP 固定提交', 'Pinned BSP commit'), vendor['commit']])
    if isinstance(sdk, dict):
        if sdk.get('version'):
            version_rows.append([tr('构建记录的 SDK 版本', 'SDK version in build record'), sdk['version']])
        if sdk.get('commit'):
            version_rows.append([tr('SDK 固定提交', 'Pinned SDK commit'), sdk['commit']])
    if version_rows:
        lines.append(_table([tr('开发资料', 'Development evidence'), tr('当前来源记录', 'Current source record')], version_rows))
    for index, command in enumerate(commands, 1):
        name = _text(command.get('titleZh' if zh else 'titleEn', command.get('title', '')))
        lines += [f'### 5.3.{index} ' + (name or tr('已核对的开发命令', 'Verified development commands')),
                  '```sh\n' + command['shell'] + '\n```']
        scope = command.get('scopeZh' if zh else 'scopeEn', command.get('scope', command.get('status', '')))
        if scope:
            lines.append(tr('来源范围：', 'Source scope: ') + _text(scope))
        source_name = Path(command.get('sourcePath', '')).name
        if source_name:
            if command.get('scope') == 'user-onboarding':
                lines.append(tr('上述命令会创建独立的 WT_BSP 目录；完成 SDK 激活后，在希望保存源码的目录开始执行，并在克隆后的 WT_BSP 根目录构建。将 PORT 替换为实际 FUSB 串口；Windows 原生 CMD 不支持前缀式环境变量赋值，请先执行 `set WT_BSP_BOARD=' + product + '`，再执行同一行的 idf.py 命令。这里没有执行烧录。',
                                'The commands create an independent WT_BSP directory. Start in your desired source location after activating ESP-IDF, then build from the cloned WT_BSP root. Replace PORT with the actual FUSB serial device. Native Windows CMD does not support prefix-style environment assignments: run `set WT_BSP_BOARD=' + product + '` first, then the idf.py command from the same line. No flashing was performed here.'))
            else:
                lines.append(tr('命令摘自配套资料 ', 'Command quoted from the accompanying source ') + '`' + source_name.replace('`', '') + '`' +
                             tr('。请在该源文件要求的工程/固件目录及 SDK 环境执行；此类重放/测试命令依赖原始完整交付包，不能在使用指南目录直接运行。烧录前需核对源说明中的接线、目标芯片和复位步骤；指南生成没有执行该命令。',
                                '. Run it in the project/firmware directory and SDK environment required by that source. These replay/test commands depend on the original complete delivery package and cannot run directly in the guide directory. Check the source wiring, target-chip and reset instructions before flashing; guide generation did not execute this command.'))
    behavior = development.get('expectedBlink')
    if behavior:
        lines += ['### 5.3.' + str(len(commands) + 1) + ' ' + tr('首次运行的核对方法', 'What to Check on First Run'),
                  behavior.get('descriptionZh' if zh else 'descriptionEn', ''),
                  development.get('monitorExit', {}).get('descriptionZh' if zh else 'descriptionEn', '')]
    if not commands:
        lines += [tr('本次输入尚未提供可直接复现的已核对命令块。请使用下节的原始开发资料；不要从其他板卡复制目标名、串口路径或烧录参数。',
                     'No verified, directly reproducible command block was supplied for this edition. Use the original development sources listed below; do not copy another board target, serial-device path or flashing parameters.')]
    firmware = development.get('firmware', {})
    if firmware:
        lines += ['### 5.3.' + str(len(commands) + (2 if behavior else 1)) + ' ' + tr('构建与实板验证范围', 'Build and Physical Validation Scope'),
                  _table([tr('项目', 'Item'), tr('来源记录', 'Source record')], [[key, firmware.get(key, '')] for key in ('status', 'target', 'physicalTestStatus', 'siliconRevisionFamily') if key in firmware]),
                  tr('上表直接保留输入资料的验证状态。`not-run` 表示尚未做实板验证，不能将构建或编译状态解释为外设、烧录或稳定性测试通过。',
                     'The table preserves the validation state recorded by the supplied material. `not-run` means physical testing has not been performed; a build or compile result is not evidence that peripherals, flashing or stability tests have passed.')]
    manual = development.get('manualDownload')
    if manual:
        lines += ['## 5.4 ' + tr('FUSB 手动下载模式', 'FUSB Manual Download Mode'),
                  manual.get('whenZh' if zh else 'whenEn', ''),
                  '\n'.join(str(index) + '. ' + step for index, step in enumerate(manual.get('stepsZh' if zh else 'stepsEn', []), 1)),
                  tr('步骤依据 ESP-IDF 固定版本文档，生成指南时未连接实板或执行烧录。',
                     'The sequence is based on the pinned ESP-IDF documentation. No physical board was connected or flashed during guide generation.')]
    lines += ['## 5.5 ' + tr('故障排查', 'Troubleshooting'),
              _table([tr('现象', 'Symptom'), tr('检查与处理', 'Check and action')], [[issue['symptomZh' if zh else 'symptomEn'], issue['actionZh' if zh else 'actionEn']] for issue in narrative['troubleshooting']]),
              '# 6. ' + tr('相关文档', 'Related Documentation')]
    for doc in _source_documents(facts):
        label = _text(doc.get('titleZh' if zh else 'titleEn', doc.get('title', doc.get('url', ''))))
        target = doc.get('bundlePath') or doc['url']
        lines.append(f'- [{_cell(label)}]({quote(target, safe=":/?=&@+%#")})')
    lines += [f'- [{tr("当前资料来源与哈希", "Current source evidence and hashes")}]({quote(evidence_name)})',
              tr('以下文件名来自本次输入。该列表说明证据范围；未随文打包的原始文件可以凭来源记录及 SHA-256 回到整理资料中核对。',
                 'The following filenames identify the supplied sources and their scope. For originals not included in this bundle, use the evidence record and SHA-256 to locate and verify the organized source material.'),
              _table([tr('来源角色', 'Source role'), tr('原始文件', 'Original file'), tr('SHA-256 前 12 位', 'SHA-256 prefix (12)')],
                     [[item.get('role', ''), Path(item.get('path', item.get('name', ''))).name, _text(item.get('sha256', ''))[:12]] for item in facts.get('sourceFiles', [])]),
              '# 7. ' + tr('联系我们', 'Contact Us'), _contacts(facts, language)]
    return '\n\n'.join(_text(line) for line in lines if _text(line)) + '\n'


def render_bundle(facts, narrative, output_dir, assets=None):
    """Write the two Markdown files and adjacent source evidence JSON.

    ``assets`` values are existing bundle-relative filenames; no input file is
    implicitly copied and no target guide is read. The caller owns preparation.
    """
    product = facts.get('productCode')
    if not isinstance(product, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{1,100}', product):
        raise GuideRenderBlocked('Product code must be a safe portable filename identifier')
    root = Path(output_dir).resolve()
    root.mkdir(parents=True, exist_ok=True)
    bound_assets = {key: _local_asset(value, root) for key, value in (assets or {}).items() if value}
    for document in facts.get('primaryDocuments', []):
        if isinstance(document, dict) and document.get('bundlePath'):
            _local_asset(document['bundlePath'], root)
    narrative = _narrative(narrative)
    evidence_name = 'source-evidence.json'
    evidence = {'schemaVersion': 1, 'productCode': product, 'hardwareVersion': facts.get('hardwareVersion'),
                'releaseDate': facts.get('releaseDate'), 'source': facts.get('source'), 'sourceFiles': facts.get('sourceFiles', []),
                'dimensions': facts.get('dimensions', {}), 'development': facts.get('development', {}),
                'images': facts.get('images', []), 'warnings': facts.get('warnings', []),
                'learningIsolation': facts.get('learningIsolation', {}), 'assets': bound_assets}
    evidence_path = root / evidence_name
    evidence_path.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    paths, counts = {}, {}
    for language, suffix in (('zh', ''), ('en', '_en')):
        path = root / f'{product}_User_Guide{suffix}.md'
        markdown = _render_language(facts, narrative, bound_assets, language, evidence_name)
        path.write_text(markdown, encoding='utf-8')
        paths[language + 'Path'] = str(path)
        counts[language] = len(markdown)
    return {**paths, 'outputPath': str(root), 'evidencePath': str(evidence_path), 'assets': bound_assets,
            'characters': counts, 'sourceSha256': facts.get('source', {}).get('sha256'),
            'renderedFiles': [{'path': value, 'sha256': hashlib.sha256(Path(value).read_bytes()).hexdigest()}
                              for value in [paths['zhPath'], paths['enPath'], str(evidence_path)]]}


deterministicrenderbundle = render_bundle


def render_source_diagram(facts, path):
    """Create editable DrawIO plus actual PNG/SVG exports in the S31 visual style."""
    from hdk.guide_drawio import render_source_diagram as render_drawio
    return render_drawio(facts, path)
