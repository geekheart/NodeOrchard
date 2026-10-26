"""Read native board facts, render test firmware, and run a pinned ESP-IDF build.

No flashing or hardware-pass claims. The Skill selects a small test profile;
this module re-reads the original archive before generating actual pin macros.
"""
from pathlib import Path
import argparse
import collections
import hashlib
import json
import os
import re
import shutil
import struct
import shlex
import subprocess
import time
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'skills/hdk-test-firmware/assets'
SDK_ROOT = ROOT / '.local/sdk/esp-idf-v6.1'
SDK_COMMIT = 'fff9895c82d744c7237be8847347bdd1b07c6643'
TEST_IDS = ['chip-info','rgb','boot-button','reset','sd-card','usb-console','camera-sccb','gpio-loopback','mipi-dsi','mipi-csi','companion-link','wifi']


def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def is_os_metadata(path):
    parts=Path(path).parts
    return bool(parts) and (parts[-1]=='.DS_Store' or parts[-1].startswith('._') or '__MACOSX' in parts[:-1])


def _business_sources(entries):
    return [entry for entry in entries if not is_os_metadata(entry['path'])]


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')


def _records(path):
    with zipfile.ZipFile(path) as z:
        if z.testzip(): raise ValueError('工程ZIP CRC不完整')
        if any(Path(n).is_absolute() or '..' in Path(n).parts for n in z.namelist()): raise ValueError('工程ZIP包含不安全路径')
        names=[n for n in z.namelist() if n.endswith('.epru')]
        if len(names)!=1: raise ValueError('固件事实解析需要一个原生工程')
        text=z.read(names[0]).decode('utf-8-sig')
    docs={};current=None
    for line in text.splitlines():
        if '||' not in line: continue
        a,b=line.split('||',1)
        try: head=json.loads(a);body=json.loads(b[:-1] if b.endswith('|') else b)
        except ValueError: continue
        if head.get('type')=='DOCHEAD':
            current=body.get('uuid');docs[current]={'head':body,'records':[]}
        if current: docs[current]['records'].append((head,body))
    return docs


def _attrs(doc):
    result=collections.defaultdict(dict)
    for h,b in doc.get('records',[]):
        if h['type']=='ATTR' and isinstance(b,dict):result[b.get('parentId')][b.get('key')]=b.get('value')
    return result


def _meta(doc):return next((b for h,b in doc.get('records',[]) if h['type']=='META'),{})


def inspect_board(source_path):
    source=Path(source_path).expanduser().resolve()
    if source.suffix.lower()!='.epro2' or not source.is_file():raise ValueError('需要真实epro2输入')
    docs=_records(source);pcbs=[d for d in docs.values() if d['head']['docType']=='PCB']
    if len(pcbs)!=1:raise ValueError('请明确单PCB固件目标')
    pcb=pcbs[0];sch={}
    for doc in docs.values():
        if doc['head']['docType']=='SCH_PAGE':
            for attr in _attrs(doc).values():
                if attr.get('Designator'):sch[attr['Designator']]=attr
    components=[]
    nets=collections.defaultdict(list)
    for h,b in pcb['records']:
        if h['type']=='PAD_NET':
            ident=json.loads(h['id']);nets[ident[1]].append((ident[2],b.get('padNet','')))
    for uid,instance in _attrs(pcb).items():
        if not instance.get('Designator'):continue
        ref=instance['Designator'];device=_meta(docs.get(instance.get('Device'),{}))
        # Instance values override library defaults, including Symbol and MPN.
        effective=device.get('attributes',{}) | sch.get(ref,{}) | instance
        symbol=_attrs(docs.get(effective.get('Symbol'),{}))
        pins={a.get('Pin Number'):a.get('Pin Name') for a in symbol.values()}
        padmap=[]
        for pad,net in nets[uid]:
            value={'pad':pad,'name':pins.get(pad),'net':net}
            if value not in padmap:padmap.append(value)
        components.append({'designator':ref,'componentUuid':uid,'deviceUuid':instance.get('Device'),
            'libraryTitle':device.get('title'),'part':effective.get('Manufacturer Part') or device.get('title'),
            'supplierPart':effective.get('Supplier Part'),'symbolUuid':effective.get('Symbol'),'pins':padmap})
    modules=[c for c in components if re.search(r'WT01P461|WT0132S31|ESP32.S31',c['libraryTitle'] or '',re.I)]
    if len(modules)!=1:raise ValueError('无法唯一确定受支持的主控模组，禁止按文件名猜芯片')
    module=modules[0];title=module['libraryTitle'];p4='WT01P461' in title
    target='esp32p4' if p4 else 'esp32s31';targets=[target]+(['esp32c61'] if p4 else [])
    net_gpio={};companion={}
    for p in module['pins']:
        name=p['name'] or ''
        m=re.match(r'^IO(\d+)(?:_|$)',name)
        if m:net_gpio[p['net']]=int(m.group(1))
        m=re.match(r'^C61_IO(\d+)$',name)
        if m:companion[p['net']]=int(m.group(1))
        if target=='esp32s31':
            if name in ['SD_D0','SD_D1','SD_D2','SD_D3','SD_CLK','SD_CMD']:net_gpio[p['net']]=['SD_D0','SD_D1','SD_D2','SD_D3','SD_CLK','SD_CMD'].index(name)+20
            if name in ('TX0','RX0'):net_gpio[p['net']]=58 if name=='TX0' else 59
    def gpio(net):return net_gpio.get(net)
    rgb=None;buttons=[];sd=None;camera=None;usb=[];headers=[]
    for c in components:
        name=c['part'] or '';pins=c['pins']
        if re.search(r'2812',name,re.I):
            din=next((p for p in pins if p['name'] in ('DI','DIN')),None)
            if din:rgb={'designator':c['designator'],'part':name,'gpio':gpio(din['net']),'net':din['net'],'pad':din['pad'],'order':'GRB'}
        if 'TS3425' in name:
            signal=next((p['net'] for p in pins if p['net'] and p['net']!='GND'),None)
            buttons.append({'designator':c['designator'],'net':signal,'gpio':gpio(signal),'function':'reset' if signal and 'EN' in signal else 'boot','activeLevel':0})
        if any(p['name']=='DAT0' for p in pins):
            names={'DAT0':'d0','DAT1':'d1','DAT2':'d2','CD/DAT3':'d3','CMD':'cmd','CLX':'clk','CLK':'clk'}
            mapping={names[p['name']]:gpio(p['net']) for p in pins if p['name'] in names}
            sd={'designator':c['designator'],'part':name,'width':4,'slot':0,'pins':mapping}
        if any(p['net']=='DVP_PCLK' for p in pins) and any(p['net']=='CAM_I2C_SDA' for p in pins):
            camera={'interface':'dvp','connectors':[],'pins':{'sda':gpio('CAM_I2C_SDA'),'scl':gpio('CAM_I2C_SCL'),'xclk':gpio('IO55'),'pclk':gpio('DVP_PCLK'),'vsync':gpio('DVP_VSYNC'),'href':gpio('DVP_HREF'),'data':[gpio('DVP_Y'+str(i)) for i in range(2,10)]},
                'reset':{'control':'passive-pullup','net':'CAM_RESET','voltage':2.8},'powerDown':{'control':'passive-pulldown','net':'CAM_PWDN'},'sensorConfirmed':None}
        if 'TYPE-C' in name.upper():usb.append({'designator':c['designator'],'pins':pins})
        if any(p['net'].startswith('CSI_DATA') for p in pins) and c!=module:camera={'interface':'mipi-csi','connector':c['designator'],'sensorConfirmed':None,'recommendedTestSensor':{'model':'sc2336','basis':'原厂WT_BSP CSI示例明确推荐测试配件，不代表已接入实物','source':'https://github.com/Wireless-TAG-Maker/WT_BSP/tree/916139150e8488b660942078da178b6e76a8f4a1/examples/camera/csi'},'pins':{'sda':gpio('IO7'),'scl':gpio('IO8'),'enable':gpio('IO0'),'auxControl':gpio('IO1')}}
        if ('排针' in name or 'HDGCPH' in name or 'X6511' in name or 'PZ254' in name):headers.append({'designator':c['designator'],'pins':[{'pad':p['pad'],'net':p['net'],'gpio':gpio(p['net'])} for p in pins]})
    if camera and camera['interface']=='dvp':
        camera['connectors']=[c['designator'] for c in components if c!=module and any(p['net']=='DVP_PCLK' for p in c['pins'])]
    return {'schemaVersion':1,'source':{'path':str(source),'sha256':sha(source),'pcbUuid':pcb['head']['uuid']},
        'board':{'moduleRef':module['designator'],'modulePart':title,'targets':targets,'primaryTarget':target,'componentCount':len(components),
            'targetEvidence':'原生WT01P461-S1模组Symbol/PAD_NET；原厂模组规格书V1.0确认ESP32-P4+ESP32-C61，芯片硅片版本仍未知' if p4 else '原生S31模组库关联与引脚命名',
            'components':components},
        'peripherals':{'rgb':rgb,'buttons':buttons,'sd':sd,'camera':camera,'usb':usb,'headers':headers,
            'display':next(({'interface':'mipi-dsi','connector':c['designator'],'panelConfirmed':None,'recommendedTestPanel':{'profile':'st7102-480x640','basis':'原厂固定BSP明确测试profile；不是从FPC推出实物型号','source':'https://github.com/Wireless-TAG-Maker/WT_BSP/blob/916139150e8488b660942078da178b6e76a8f4a1/components/wt_bsp/boards/WT9932P4C61-TINY/board.c'},'pins':c['pins']} for c in components if c!=module and any(p['net'].startswith('DSI_DATA') for p in c['pins'])),None)},
        'netGpioMap':dict(sorted(net_gpio.items())),'companionNetGpioMap':dict(sorted(companion.items())),
        'warnings':['未连接实板；物理测试未运行']+(['模组家族资料为P4 Flash16MB、C61 Flash4MB和PSRAM16/32MB；本次原生工程未明确硅片修订号及完整采购后缀，必须读chip-id/flash-id选择legacy/v3互斥镜像，P4使用保守4MiB布局'] if p4 else ['源模组库未明确Flash/PSRAM容量；测试工程使用保守2MB分区并关闭PSRAM'])}


def validate_profile(facts, profile):
    keys={'schemaVersion','target','tests','cameraSensor','fixturePairs'}
    if not isinstance(profile,dict) or not keys.issubset(profile) or not set(profile).issubset(keys|{'displayPanel'}) or profile['schemaVersion']!=1:raise ValueError('测试固件配置不符合profile契约')
    if profile['target']!=facts['board']['primaryTarget']:raise ValueError('测试固件target必须匹配真实主芯片；不能替换为已有工具链目标')
    tests=profile['tests']
    if not isinstance(tests,list) or not tests or len(tests)!=len(set(tests)) or any(t not in TEST_IDS for t in tests):raise ValueError('测试ID无效或重复')
    p=facts['peripherals']
    required={'rgb':p['rgb'],'boot-button':next((b for b in p['buttons'] if b['function']=='boot'),None),'sd-card':p['sd'],'camera-sccb':p['camera']}
    for test,feature in required.items():
        if test in tests and not feature:raise ValueError(f'{test}没有对应真实外设，不能继承案例配置')
    if 'rgb' in tests and not isinstance(p['rgb'].get('gpio'),int):raise ValueError('RGB缺少真实GPIO证据')
    if 'boot-button' in tests and not isinstance(required['boot-button'].get('gpio'),int):raise ValueError('BOOT缺少真实GPIO证据')
    if 'sd-card' in tests and (set(p['sd']['pins']) != {'d0','d1','d2','d3','clk','cmd'} or any(not isinstance(v,int) for v in p['sd']['pins'].values())):raise ValueError('SD卡需要完整的六路GPIO证据')
    if profile['cameraSensor'] not in (None,'gc2145','sc2336'):raise ValueError('测试传感器必须为明确支持的GC2145或SC2336')
    if 'camera-sccb' in tests and (not p['camera'] or p['camera']['interface']!='dvp' or profile['cameraSensor']!='gc2145'):raise ValueError('摄像头识别需要DVP连接事实和明确GC2145测试目标')
    if 'mipi-csi' in tests and (not p['camera'] or p['camera']['interface']!='mipi-csi' or profile['cameraSensor']!='sc2336'):raise ValueError('MIPI CSI需要真实接口及明确SC2336配件profile')
    if 'mipi-dsi' in tests and (not p.get('display') or profile.get('displayPanel')!='st7102-480x640'):raise ValueError('MIPI DSI需要真实接口及明确ST7102 480x640配件profile')
    if any(t in tests for t in ['companion-link','wifi']) and 'esp32c61' not in facts['board']['targets']:raise ValueError('本板没有已核验C61伴随芯片')
    pairs=profile['fixturePairs']
    if not isinstance(pairs,list) or len(pairs)>32:raise ValueError('fixturePairs无效')
    header_gpios={pin['gpio'] for h in p['headers'] for pin in h['pins'] if pin['gpio'] is not None}
    reserved={p['rgb']['gpio']} if p['rgb'] else set()
    reserved|={b['gpio'] for b in p['buttons'] if b['gpio'] is not None}
    if p['sd']:reserved|=set(p['sd']['pins'].values())
    if p['camera']:
        reserved|={v for v in p['camera']['pins'].values() if isinstance(v,int)}
        if p['camera']['interface']=='dvp':reserved|=set(p['camera']['pins']['data'])
    reserved|=({33,34,36,37,60,61} if profile['target']=='esp32s31' else {2,24,25,34,35,36,37,38,52,53,54})
    seen=set()
    for pair in pairs:
        if not isinstance(pair,dict) or set(pair)!={'output','input'}:raise ValueError('治具对必须包含output/input')
        edge=tuple(sorted(pair.values()))
        if pair['output']==pair['input'] or edge in seen:raise ValueError('治具GPIO对重复或短接自身')
        seen.add(edge)
        for pin in pair.values():
            if isinstance(pin,bool) or not isinstance(pin,int) or pin not in header_gpios or pin in reserved:raise ValueError('治具GPIO未引出、占用或strapping；请提供已确认接线')
    return dict(profile,tests=[t for t in TEST_IDS if t in tests])



def design_fixture(facts):
    """Propose a new passive harness from this board, never an old fixture claim."""
    p=facts['peripherals'];locations=collections.defaultdict(list)
    for header in p['headers']:
        for pin in header['pins']:
            if pin['gpio'] is not None:locations[pin['gpio']].append(header['designator']+'.'+pin['pad'])
    reserved={p['rgb']['gpio']} if p['rgb'] else set()
    reserved|={b['gpio'] for b in p['buttons'] if b['gpio'] is not None}
    if p['sd']:reserved|=set(p['sd']['pins'].values())
    if p['camera']:
        reserved|={v for v in p['camera']['pins'].values() if isinstance(v,int)}
        if p['camera']['interface']=='dvp':reserved|=set(p['camera']['pins']['data'])
    reserved|=({33,34,36,37,60,61} if facts['board']['primaryTarget']=='esp32s31' else {2,24,25,34,35,36,37,38,52,53,54})
    usable=sorted(set(locations)-reserved);pairs=[]
    start=0
    if len(usable)%2 and len(usable)>=3:
        pairs.extend([{'output':usable[0],'input':usable[1]},{'output':usable[1],'input':usable[2]}]);start=3
    for i in range(start,len(usable)-1,2):pairs.append({'output':usable[i],'input':usable[i+1]})
    covered=sorted({v for pair in pairs for v in pair.values()})
    return {'schemaVersion':1,'status':'new-design-not-physically-validated','boardSourceSha256':facts['source']['sha256'],
        'fixturePairs':pairs,'connections':[dict(pair,outputPin=locations[pair['output']][0],inputPin=locations[pair['input']][0]) for pair in pairs],
        'coveredGpios':covered,'excludedGpios':[{'gpio':g,'pins':locations[g],'reason':'occupied peripheral or strapping; use its dedicated test or leave unverified'} for g in sorted(set(locations)-set(covered))],
        'operatingRules':['按新接线表制作被动3.3V信号环回，绝不接5V/3.3V供电针；三针共线组采用接线排。','烧录时断开环回连接；进入应用READY后接入治具并输入fixture。','每对逐次反向驱动高/低，其余治具针先恢复输入，不同时驱动短接的多个输出。','该设计没有复刻案例未知治具板及其协议；首次必须由用户核对接线与实板结果。']}



def coverage(facts, profile):
    p=facts['peripherals'];required=['chip-info','reset','usb-console']
    if p['rgb']:required.append('rgb')
    if any(b['function']=='boot' for b in p['buttons']):required.append('boot-button')
    if p['sd']:required.append('sd-card')
    if p['camera']:required.append('camera-sccb' if p['camera']['interface']=='dvp' else 'mipi-csi')
    if p.get('display'):required.append('mipi-dsi')
    if len(facts['board']['targets'])>1:required.extend(['companion-link','wifi'])
    design=design_fixture(facts)
    if design['coveredGpios']:required.append('gpio-loopback')
    provided=set(profile['tests']);missing=sorted(set(required)-provided)
    desired=set(design['coveredGpios']);configured={pin for pair in profile['fixturePairs'] for pin in pair.values()}
    if 'gpio-loopback' in required and not desired.issubset(configured):missing.append('gpio-loopback:ordinary-header-coverage')
    return {'requiredTests':sorted(required),'implementedTests':sorted(provided),
        'missingTests':missing,'complete':not missing,
        'gpioCoverage':{'requiredOrdinaryHeaderGpios':sorted(desired),'configuredGpios':sorted(configured),
            'excluded':design['excludedGpios']},
        'physicalTestStatus':'not-run','scopeCaveat':('CSI三帧采集不含画质验收，DSI色条需人工目视；' if facts['board']['primaryTarget']=='esp32p4' else '摄像头身份识别不含成像质量；')+'普通排针环回不复刻未知工厂治具，不覆盖未明确的全部芯片内部信号。'}


def artifact(path, root, role):
    p=Path(path).resolve();return {'role':role,'path':str(p),'relativePath':p.relative_to(root).as_posix(),'bytes':p.stat().st_size,'sha256':sha(p)}


def generate(board_facts, profile, package_path, *, _revision_family=None):
    current=inspect_board(board_facts['source']['path'])
    if current['source']['sha256']!=board_facts['source']['sha256']:raise ValueError('原始工程已变化，拒绝使用旧固件引脚')
    profile=validate_profile(current,profile)
    package=Path(package_path).expanduser().resolve()
    if not package.is_dir():raise ValueError('packagePath必须是本次独立交付目录')
    area=package/'生产资料/07_测试说明/测试固件'
    if _revision_family:area=area/'variants'/('p4-'+_revision_family)
    area.mkdir(parents=True,exist_ok=True)
    source_dir=area/'source'
    if source_dir.exists():raise ValueError('本次固件源码已存在，禁止覆盖；请创建新工作流运行')
    source_dir.mkdir()
    shutil.copyfile(ASSETS/'CMakeLists.txt',source_dir/'CMakeLists.txt')
    shutil.copytree(ASSETS/'main',source_dir/'main')
    p=current['peripherals'];rgb=p['rgb'] or {};boot=next((b for b in p['buttons'] if b['function']=='boot'),{});sd=p['sd'] or {};camera=p['camera'] if p['camera'] and p['camera']['interface']=='dvp' else {}
    macros={'HDK_RGB_PIN':rgb.get('gpio',-1),'HDK_BOOT_PIN':boot.get('gpio',-1),'HDK_SD_SLOT':sd.get('slot',1),'HDK_CAMERA_SDA':camera.get('pins',{}).get('sda',-1),'HDK_CAMERA_SCL':camera.get('pins',{}).get('scl',-1),'HDK_CAMERA_XCLK':camera.get('pins',{}).get('xclk',-1)}
    macros|={'HDK_SD_'+key.upper():sd.get('pins',{}).get(key,-1) for key in ['d0','d1','d2','d3','clk','cmd']}
    macros|={'HDK_TEST_'+t.replace('-','_').upper():int(t in profile['tests']) for t in TEST_IDS}
    content='#pragma once\n'+''.join(f'#define {k} {int(v) if v is not None else -1}\n' for k,v in macros.items())
    pairs=profile['fixturePairs'];content+=f'#define HDK_FIXTURE_COUNT {len(pairs)}\n'
    content+='static const int hdk_fixture_out[] = {'+(','.join(str(p['output']) for p in pairs) or '-1')+'};\n'
    content+='static const int hdk_fixture_in[] = {'+(','.join(str(p['input']) for p in pairs) or '-1')+'};\n'
    content+='#define HDK_BOARD_SOURCE_SHA256 '+json.dumps(current['source']['sha256'])+'\n'
    content+='#define HDK_CONFIG_SHA256 '+json.dumps(hashlib.sha256(content.encode()).hexdigest())+'\n'
    (source_dir/'main/hdk_board_config.h').write_text(content)
    config=['CONFIG_IDF_TARGET="'+profile['target']+'"','CONFIG_ESPTOOLPY_FLASHSIZE_2MB=y','CONFIG_PARTITION_TABLE_SINGLE_APP=y','CONFIG_COMPILER_OPTIMIZATION_SIZE=y','CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y','CONFIG_FATFS_LFN_HEAP=y','CONFIG_FATFS_MAX_LFN=64','CONFIG_LOG_DEFAULT_LEVEL_INFO=y']
    if profile['target']=='esp32p4':
        config=[line for line in config if not line.startswith('CONFIG_ESPTOOLPY_FLASHSIZE_2MB') and not line.startswith('CONFIG_PARTITION_TABLE_SINGLE_APP')]
        config+=prepare_p4_backend(current,profile,source_dir,_revision_family or 'legacy')
    (source_dir/'sdkconfig.defaults').write_text('\n'.join(config)+'\n')
    write_json(source_dir/'board-facts.json',current);write_json(source_dir/'test-profile.json',profile)
    manifest={'schemaVersion':1,'status':'generated','physicalTestStatus':'not-run','sourceDir':str(source_dir),'artifactRoot':str(area),'packagePath':str(package),
        'manifestPath':str(area/'generation-manifest.json'),'boardSourceSha256':current['source']['sha256'],'boardFacts':current,'profile':profile,
        'sourceFiles':[artifact(f,area,'source') for f in sorted(source_dir.rglob('*')) if f.is_file() and not is_os_metadata(f)],
        'siliconRevisionFamily':(_revision_family or 'legacy') if profile['target']=='esp32p4' else None}
    write_json(manifest['manifestPath'],manifest);return manifest



def prepare_p4_backend(facts, profile, source, revision_family='legacy'):
    vendor=ROOT/'.local/hdk-firmware-training/WT_BSP'
    commit=subprocess.check_output(['git','-C',str(vendor),'rev-parse','HEAD'],text=True).strip()
    if commit!='916139150e8488b660942078da178b6e76a8f4a1':raise ValueError('原厂BSP版本变化，请重新验证P4驱动')
    component=source/'components/wt_bsp'
    shutil.copytree(vendor/'components/wt_bsp',component)
    shutil.copyfile(vendor/'LICENSE',component/'LICENSE')
    if (ASSETS/'p4/dependencies.lock').is_file():shutil.copyfile(ASSETS/'p4/dependencies.lock',source/'dependencies.lock')
    for file in (ASSETS/'p4').glob('*'):
        if file.suffix in ('.c','.h'):shutil.copyfile(file,source/'main'/file.name)
    import importlib.util
    spec=importlib.util.spec_from_file_location('hdk_companion_firmware',ROOT/'hdk/companion_firmware.py')
    companion=importlib.util.module_from_spec(spec);spec.loader.exec_module(companion)
    companion.install_bridge(facts,source/'main')
    # esp_video 2.3 registry metadata still refers to this removed option.
    # Define its false/default meaning locally, without changing vendor code.
    (source/'main/Kconfig.projbuild').write_text('config ESP_VIDEO_USE_CUSTOMIZED_ESP_H264_VERSION\n    bool "Use a custom esp_h264 dependency (registry compatibility option)"\n    default n\nconfig WT_BSP_BOARD_SELECTED_BY_TOOL\n    bool\n    default y\nconfig WT_BSP_SELECTED_BOARD_WT9932P4C61_TINY\n    bool\n    default y\n')
    (source/'main/idf_component.yml').write_text('dependencies:\n  espressif/esp_video:\n    version: "2.3.0"\n    require: public\n')
    cmake=source/'main/CMakeLists.txt'
    cmake.write_text('idf_component_register(SRCS "main.c" "hdk_mipi.c" "bridge.c" INCLUDE_DIRS "." REQUIRES esp_driver_gpio esp_driver_rmt esp_driver_ledc esp_driver_i2c fatfs sdmmc esp_system esp_hw_support spi_flash vfs wt_bsp esp_driver_uart esp_timer esp_mm esp_lcd esp_video hdk_cjson)\n')
    board=component/'boards/WT9932P4C61-TINY/board.c';body=board.read_text()
    # The source has no dedicated LCD reset/backlight nets on J1. Use DCS
    # software reset; do not toggle unrelated external header GPIO26/27.
    body=re.sub(r'(#define BOARD_DSI_BACKLIGHT_GPIO_NUM) +26',r'\1 -1',body)
    body=re.sub(r'(#define BOARD_DSI_RESET_GPIO_NUM) +27',r'\1 -1',body)
    board.write_text(body)
    write_json(source/'vendor-provenance.json',{'repository':'https://github.com/Wireless-TAG-Maker/WT_BSP','commit':commit,
        'adaptations':['DSI reset/backlight=-1 because no matching dedicated GPIO routes on current 15pin J1','SDMMC uses source board 3.3V, no VO4 LDO; base fixed test owns SD/RGB/button','SC2336 SCCB SDA7 SCL8 and accessory enable GPIO0 are the explicit vendor recommended profile'],
        'accessories':{'camera':'SC2336 MIPI CSI, recommended by vendor CSI example','display':'ST7102 480x640 RGB888 2lane, recommended by vendor P4C61 BSP'},
        'siliconRevisionFamily':revision_family,'revisionSource':'https://documentation.espressif.com/esp32-p4-chip-revision-v3.x_user_guide_en.pdf',
        'revisionSelection':'read chip-id and flash-id before selecting mutually incompatible legacy/v3 images','physicalTestStatus':'not-run'})
    # Do not infer the fitted flash capacity from the module family. A 4MiB
    # layout is conservative; the operator must verify flash-id >=4MiB.
    (source/'partitions.csv').write_text('nvs,data,nvs,0x9000,0x6000\nphy_init,data,phy,0xf000,0x1000\nfactory,app,factory,0x10000,0x3f0000\n')
    config=['CONFIG_WT_BSP_BOARD_WT9932P4C61_TINY=y','CONFIG_WT_BSP_ENABLE_DSI=y','CONFIG_WT_BSP_ENABLE_CSI=y',
        'CONFIG_WT_BSP_ENABLE_RGB=n','CONFIG_WT_BSP_ENABLE_BUTTON=n','CONFIG_WT_BSP_ENABLE_SDMMC=n','CONFIG_WT_BSP_ENABLE_TOUCH=n',
        'CONFIG_WT_BSP_ENABLE_USB_DEVICE_CDC=n','CONFIG_WT_BSP_ENABLE_USB_DEVICE_UVC=n',
        'CONFIG_SPIRAM=y','CONFIG_SPIRAM_SPEED_200M=y',
        'CONFIG_PARTITION_TABLE_CUSTOM=y','CONFIG_PARTITION_TABLE_CUSTOM_FILENAME="partitions.csv"','CONFIG_ESPTOOLPY_FLASHSIZE_4MB=y','CONFIG_ESP_MAIN_TASK_STACK_SIZE=32768',
        'CONFIG_CAMERA_SC2336=y','CONFIG_CAMERA_SC2336_AUTO_DETECT_MIPI_INTERFACE_SENSOR=y',
        'CONFIG_CAMERA_SC2336_MIPI_RAW8_1024X600_30FPS=y','CONFIG_CAMERA_SC2336_MIPI_DEFAULT_FMT_RAW8_1024X600_30FPS=y',
        'CONFIG_CAMERA_SC2336_DEFAULT_IPA_JSON_CONFIGURATION_FILE=y','CONFIG_CAMERA_XCLK_USE_ESP_CLOCK_ROUTER=y']
    config+=['CONFIG_ESP32P4_SELECTS_REV_LESS_V3=y','CONFIG_ESP32P4_REV_MIN_0=y'] if revision_family=='legacy' else ['CONFIG_ESP32P4_SELECTS_REV_LESS_V3=n','CONFIG_ESP32P4_REV_MIN_300=y']
    return config


def default_toolchain():
    espressif_home = Path(os.environ.get('WORKBENCH_HDK_ESPRESSIF_HOME', Path.home() / '.espressif')).expanduser()
    return {'idfPath':str(SDK_ROOT),'python':str(ROOT/'.local/sdk/python-env/bin/python'),
        'pythonEnv':str(ROOT/'.local/sdk/python-env'),'idfToolsPath':str(ROOT/'.local/sdk/tools'),
        'compilerBin':str(Path(os.environ.get('WORKBENCH_HDK_COMPILER_BIN', espressif_home/'tools/riscv32-esp-elf/esp-15.2.0_20251204/riscv32-esp-elf/bin')).expanduser()),
        'cmakeBin':str(Path(os.environ.get('WORKBENCH_HDK_CMAKE_BIN', espressif_home/'tools/cmake/3.30.2/CMake.app/Contents/bin')).expanduser()),
        'ninjaBin':str(Path(os.environ.get('WORKBENCH_HDK_NINJA_BIN', espressif_home/'tools/ninja/1.12.1')).expanduser())}


def _run(command, env, cwd, log, timeout=1200):
    with Path(log).open('ab') as out:
        out.write(('\nCOMMAND '+json.dumps(command)+'\n').encode());out.flush()
        result=subprocess.run(command,cwd=str(cwd),env=env,stdout=out,stderr=subprocess.STDOUT,timeout=timeout,check=False)
    return result.returncode


def _copy_build_artifacts(build, destination, project_name):
    """Retain replayable evidence, excluding rebuildable compiler caches."""
    build=Path(build);destination=Path(destination);destination.mkdir(parents=True)
    relatives=[project_name+'.elf',project_name+'.map',project_name+'.bin',
        'flasher_args.json','flash_args','sdkconfig','config/sdkconfig.h',
        'bootloader/bootloader.bin','partition_table/partition-table.bin']
    for relative in relatives:
        source=build/relative
        if source.is_file():
            target=destination/relative;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,target)


def _retain_generated_sources(staged, source, source_files):
    """Publish build-generated dependencies/config without replacing authored files."""
    for entry in source_files:
        original=Path(entry['path']).resolve()
        copied=staged/original.relative_to(source)
        if sha(original)!=entry['sha256'] or sha(copied)!=entry['sha256']:
            raise ValueError('构建期间固定源码发生变化；拒绝发布构建产物')
    for name in ('managed_components','dependencies.lock','sdkconfig','sdkconfig.old'):
        generated=staged/name;destination=source/name
        if generated.is_dir():shutil.copytree(generated,destination,dirs_exist_ok=True)
        elif generated.is_file():shutil.copyfile(generated,destination)


def tests_manifest(facts, profile):
    p=facts['peripherals'];result=[]
    specs={
      'chip-info':('芯片、Flash容量与复位原因','HDK chip-info PASS',['上电，打开USB Serial/JTAG串口。'],'开机记录真实chip model、flash size、reset reason。'),
      'rgb':('RGB逐色输出和目视检查','HDK rgb EMITTED',['输入 rgb 并回车，观察红、绿、蓝和熄灭。'],'日志EMITTED仅证明已发波形；操作员确认实际三色正确。'),
      'boot-button':('BOOT按键消抖与RGB开关','HDK boot-button PRESSED',['正常启动后按下并释放BOOT，重复三次。'],'每次按下/释放各一条日志且RGB亮灭切换。'),
      'reset':('EN复位','HDK reset OBSERVED',['记录一次启动序号，按RESET。'],'设备重启并重新打印真实reset reason；不能仅由代码判定机械按键通过。'),
      'sd-card':('SD卡四位挂载、独占临时文件读写校验清理','HDK sd-card PASS',['断电插入已备份的FAT格式MicroSD测试卡；上电后输入 sd。'],'实际四位挂载且写入/回读逐字节一致，只删除本次新建临时文件。'),
      'usb-console':('USB Serial/JTAG日志与命令收发','HDK usb-console READY',['将数据线接Serial/JTAG口，选择实际端口115200波特，输入 help。'],'主机实际枚举、可见READY且可收到help响应；OTG口应用枚举另行测试。'),
      'camera-sccb':('GC2145时钟与SCCB芯片身份','HDK camera-sccb PASS',['断电连接已确认GC2145摄像头，核对FPC方向和电源后上电，输入 camera。'],'SCCB地址0x3c读取寄存器0xf0/0xf1=0x2145；不等同DVP采集或画质通过。'),
      'mipi-dsi':('ST7102 MIPI DSI 480x640 RGB888八色条绘制','HDK mipi-dsi EMITTED',['断电连接明确ST7102 480x640测试屏，上电后输入display。'],'DSI控制器真实绘制帧缓冲且操作员确认八色条和几何尺寸；日志EMITTED不代替目视。'),
      'mipi-csi':('SC2336 MIPI CSI实际抓取至少三帧并记录尺寸/字节/CRC','HDK mipi-csi PASS',['断电连接明确SC2336测试摄像头，上电后输入capture。'],'5秒内实际收到至少三帧有效数据；不等于画质、对焦、颜色全部合格。'),
      'companion-link':('P4至ESP32-C61独立固件UART双向协议','HDK companion-link PASS',['按双芯片烧录步骤装入本次C61固件，启动P4后输入link。'],'P4核对C61 target/protocol/requestId/同板SHA回执，拒绝旧固件或错误芯片。'),
      'wifi':('ESP32-C61真实WiFi扫描并经P4链路返回AP记录','HDK wifi PASS',['确认C61固件与link已通过，输入wifi，确保现场有可检测AP。'],'AP记录非空且完成回执计数一致；零AP为失败，未配置连接认证/吞吐测试不宣称通过。'),
      'gpio-loopback':('已确认治具对双向电平环回','HDK gpio-loopback PASS',['断电按profile.fixturePairs接治具后上电，输入 fixture。'],'每一已确认对低/高电平匹配；空配置为SKIP，不能视为全GPIO通过。')}
    commands={'rgb':'rgb','sd-card':'sd','camera-sccb':'camera','gpio-loopback':'fixture','usb-console':'help','mipi-dsi':'display','mipi-csi':'capture','companion-link':'link','wifi':'wifi'}
    for test in profile['tests']:
        scope,expected,steps,criteria=specs[test];unsupported=test=='gpio-loopback' and not profile['fixturePairs']
        result.append({'id':test,'scope':scope,'expectedLog':'HDK gpio-loopback SKIP configuration_required' if unsupported else expected,
            'hardwareRequired':True,'operatorSteps':steps,'command':commands.get(test),'passCriteria':criteria,'unsupported':unsupported})
        if test=='companion-link':
            subtest=next(item for item in _companion().tests_manifest() if item['id']=='companion-gpio-loopback')
            result[-1]['subtests']=[subtest]
            result[-1]['scope']+='，并明确覆盖C61普通排针GPIO0/1/5/6两对安全环回'
            result[-1]['operatorSteps']=steps+subtest['operatorSteps']+['环回命令c61-fixture必须出现 '+subtest['expectedLog']+'；链路通过不能替代环回通过。']
            result[-1]['passCriteria']=criteria+' 同时完成子覆盖：'+subtest['passCriteria']
    return result


def _compile_one(generation, toolchain_profile=None):
    source=Path(generation['sourceDir']).resolve();area=Path(generation['artifactRoot']).resolve();package=Path(generation['packagePath']).resolve()
    if not source.is_relative_to(package) or not area.is_relative_to(package):raise ValueError('固件构建路径必须属于本次交付目录')
    source_files=_business_sources(generation['sourceFiles'])
    for f in source_files:
        if sha(f['path'])!=f['sha256']:raise ValueError('生成的源码已变化；请重新生成可审计配置')
    facts=generation['boardFacts'];profile=validate_profile(facts,generation['profile']);target=profile['target']
    tool=default_toolchain() | (toolchain_profile or {});idf=Path(tool['idfPath']).resolve()
    head=subprocess.check_output(['git','-C',str(idf),'rev-parse','HEAD'],text=True).strip()
    if head!=SDK_COMMIT:raise ValueError('测试固件构建必须使用已经验证的固定ESP-IDF v6.1提交')
    env=dict(os.environ,IDF_PATH=str(idf),IDF_TARGET=target,ESP_IDF_VERSION='6.1.0' if head==SDK_COMMIT else '5.5.4',IDF_PYTHON_ENV_PATH=tool['pythonEnv'],IDF_TOOLS_PATH=tool['idfToolsPath'],IDF_COMPONENT_MANAGER='1' if target=='esp32p4' else '0',IDF_COMPONENT_CACHE_PATH=str(ROOT/'.local/sdk/component-cache'),IDF_SKIP_CHECK_SUBMODULES='1',PYTHONDONTWRITEBYTECODE='1')
    env['PATH']=os.pathsep.join([tool['compilerBin'],tool['cmakeBin'],tool['ninjaBin'],str(Path(tool['python']).parent),env.get('PATH','')])
    destination_build=area/'build';log=area/'build.log'
    if destination_build.exists():raise ValueError('本次构建目录已存在，禁止覆盖；请使用新的工作流运行')
    # IDF specs processing needs ASCII build paths. esp_ipa also splits its
    # input filenames on whitespace internally, even with correct CLI quoting.
    # Stage both source and build in an ASCII, space-free private scratch path.
    scratch=Path(tempfile.mkdtemp(prefix='hdk-fw-',dir='/private/tmp'));build=scratch/'build';staged=scratch/'source'
    shutil.copytree(source,staged)
    command=[tool['python'],str(idf/'tools/idf.py'),'--preview','-B',str(build),'-C',str(staged),'-DIDF_TARGET='+target,'build']
    started=time.time();code=_run(command,env,staged,log)
    _retain_generated_sources(staged,source,source_files)
    if build.exists():_copy_build_artifacts(build,destination_build,'hdk_factory')
    build=destination_build
    report={'schemaVersion':1,'status':'compiled' if code==0 else 'failed','physicalTestStatus':'not-run','target':target,
        'idf':{'path':str(idf),'version':'v6.1' if head==SDK_COMMIT else 'local','commit':head},'boardSourceSha256':facts['source']['sha256'],
        'sourceSha256':hashlib.sha256(''.join(f['sha256'] for f in source_files).encode()).hexdigest(),'artifactRoot':str(area),
        'packagePath':str(package),'sourceDir':str(source),'boardFacts':facts,'profile':profile,'durationSeconds':round(time.time()-started,2),'exitCode':code,
        'artifacts':[artifact(log,area,'buildLog')]+source_files,'flash':None,'tests':tests_manifest(facts,profile),
        'warnings':facts['warnings']+(['SC2336通过真实CSI帧回调检测采集；ST7102输出色条需目视，均不等同完整画质验收'] if target=='esp32p4' else ['摄像头当前仅SCCB身份识别，不是DVP采集质量测试'])+['未刷写任何实板；所有硬件结果等待用户验证'],
        'manifestPath':str(area/'firmware-manifest.json'),'buildCommand':command,'scratchBuildPath':str(scratch/'build'),'scratchSourcePath':str(staged),'toolchain':tool,
        'console':{'interface':'USB Serial/JTAG','baud':115200,'dataBits':8,'parity':'none','stopBits':1,'commandTerminator':'newline'},
        'fixtureDesign':design_fixture(facts),'coverage':coverage(facts,profile),'siliconRevisionFamily':generation.get('siliconRevisionFamily')}
    if code==0:
        replay=area/'构建重放.md'
        replay.write_text('# 构建重放\n\n构建只生成文件，不连接或刷写硬件。ESP-IDF v6.1固定提交 `'+SDK_COMMIT+'`，RISC-V GCC `esp-15.2.0_20251204`。源码、sdkconfig、依赖lock和managed_components随包交付。先按Espressif官方说明配置同版本SDK环境，再在当前目录执行：\n\n```sh\nreplay_dir=$(mktemp -d /tmp/hdk-replay-XXXXXX)\ncp -R source "$replay_dir/source"\npython "$IDF_PATH/tools/idf.py" --preview -B "$replay_dir/build" -C "$replay_dir/source" -DIDF_TARGET='+target+' build\n```\n\n每次重放使用新的ASCII且不含空格的临时源码与构建目录，避免SDK specs和摄像头IPA配置生成器对路径的兼容性问题。交付目录可以包含中文和空格；保留临时目录以检查编译输出。实际本次命令、SDK提交和工具链路径见firmware-manifest.json。P4不同硅片版本需要分别从各自source目录重建，不能交换sdkconfig。Serial/JTAG终端115200 8N1；编译成功不等于实板通过。\n',encoding='utf-8')
        report['artifacts'].append(artifact(replay,area,'buildReplayGuide'))
        managed=source/'managed_components'
        if managed.is_dir():
            index=source/'dependency-source-index.json'
            write_json(index,{'files':[artifact(file,source,'dependencySource') for file in sorted(managed.rglob('*')) if file.is_file() and not is_os_metadata(file)],
                'registry':'https://components.espressif.com/','lockSha256':sha(source/'dependencies.lock')})
            report['artifacts'].append(artifact(index,area,'dependencySourceIndex'))
        for extra,role in [('dependencies.lock','dependencyLock'),('sdkconfig','sdkconfig')]:
            if (source/extra).is_file():report['artifacts'].append(artifact(source/extra,area,role))
        flash_file=build/'flasher_args.json';flash_json=json.loads(flash_file.read_text());offsets=[]
        original_flash_args=build/'flash_args'
        if original_flash_args.exists():
            (build/'flash_args.native').write_bytes(original_flash_args.read_bytes())
        replay_args=list(flash_json['write_flash_args'])
        for offset,file in flash_json['flash_files'].items():replay_args.extend([offset,file])
        original_flash_args.write_text(shlex.join(replay_args)+'\n')
        for offset,relative in flash_json['flash_files'].items():
            file=build/relative
            offsets.append({'offset':offset,'path':str(file.resolve()),'relativePath':file.resolve().relative_to(area).as_posix(),'sha256':sha(file)})
        for file,role in [(build/'hdk_factory.elf','elf'),(build/'hdk_factory.map','map'),(build/'hdk_factory.bin','applicationBin'),(flash_file,'flashArgs'),(build/'flash_args','flashArgsText'),(build/'bootloader/bootloader.bin','bootloaderBin'),(build/'partition_table/partition-table.bin','partitionBin'),(build/'flash_args.native','nativeFlashArgs')]:
            if file.is_file():report['artifacts'].append(artifact(file,area,role))
        merged=area/(target+'-factory-merged.bin')
        merge=[tool['python'],'-m','esptool','--chip',target,'merge-bin','-o',str(merged)]
        for offset,file in flash_json['flash_files'].items():merge.extend([offset,str(build/file)])
        merge_code=_run(merge,env,source,log,timeout=120)
        if merge_code:report['status']='failed';report['warnings'].append('合并固件失败，不能按完整交付烧录')
        else:
            report['artifacts'].append(artifact(merged,area,'mergedBin'))
            report['flash']={'offsets':offsets,'flashArgsPath':str(flash_file),'mergedPath':str(merged),'mergedOffset':'0x0',
                'commandTemplate':f'{tool["python"]} -m esptool --chip {target} --port <PORT> --baud 460800 write-flash 0x0 "{merged.name}"',
                'consolePort':'USB Serial/JTAG','consoleBaud':115200}
        # log grows while creating merged image; retain final exact bytes.
        report['artifacts']=[artifact(a['path'],area,a['role']) for a in report['artifacts']]
    write_json(report['manifestPath'],report)
    if code==0:shutil.rmtree(scratch)
    return report


def _companion():
    import importlib.util
    spec=importlib.util.spec_from_file_location('hdk_companion_firmware',ROOT/'hdk/companion_firmware.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


def compile(generation, toolchain_profile=None):
    """Build all silicon variants and the actual C61 companion for a P4 board."""
    report=_compile_one(generation,toolchain_profile)
    if report['target']=='esp32p4' and report['status']=='compiled':
        other=generate(report['boardFacts'],report['profile'],report['packagePath'],_revision_family='v3')
        modern=_compile_one(other,toolchain_profile)
        companion=_companion().compile_package(report['boardFacts'],report['packagePath'])
        report['revisionVariants']=[{'family':'legacy','manifestPath':report['manifestPath'],'minRevision':0,'maxRevision':199},
            {'family':'v3','manifestPath':modern['manifestPath'],'minRevision':300,'maxRevision':399}]
        report['companion']= {'manifestPath':companion['manifestPath'],'target':'esp32c61','status':companion['status']}
        report['minimumFlashBytes']=4*1024*1024
        report['hardwareSelectionRequired']=True
        guide=Path(report['artifactRoot'])/'P4芯片版本与烧录选择.md'
        guide.write_text('# P4 芯片版本与烧录选择\n\n原生工程没有提供硅片修订号或实际Flash容量，PCB V1.0不能代替芯片版本。烧录前必须读取硬件信息，不使用 --force。\n\n```sh\npython -m esptool --chip esp32p4 --port <PORT> chip-id\npython -m esptool --chip esp32p4 --port <PORT> flash-id\n```\n\nFlash必须至少4MiB，且模组具有厂家规定的PSRAM。v0.x/v1.x使用当前目录esp32p4-factory-merged.bin；v3.x使用variants/p4-v3/esp32p4-factory-merged.bin。两套固件互不兼容，芯片v2.x/未知版本停止选择并核验。读取失败或容量不足时禁止烧录；没有实板结果时不声称已适配确认。两套均使用真实源GPIO和SC2336/ST7102明确测试配件配置，配件型号仍须核对。\n\n来源：Espressif《ESP32-P4 Chip Revision v3.x》；固定ESP-IDF v6.1 Kconfig ESP32P4_SELECTS_REV_LESS_V3。\n',encoding='utf-8')
        report['artifacts'].append(artifact(guide,Path(report['artifactRoot']),'revisionSelectionGuide'))
        if modern['status']!='compiled' or companion['status']!='compiled':report['status']='failed'
        for child in [modern,companion]:
            report['artifacts'] += [artifact(a['path'],Path(report['artifactRoot']),a['role']) for a in child['artifacts']]
            report['artifacts'].append(artifact(child['manifestPath'],Path(report['artifactRoot']),'childFirmwareManifest'))
        write_json(report['manifestPath'],report)
    return report




def _esp_image(data):
    if len(data)<24 or data[0]!=0xe9 or data[1]>16:raise ValueError('ESP镜像header或segment数无效')
    pos=24;checksum=0xef;segments=[]
    for _ in range(data[1]):
        address,size=struct.unpack_from('<II',data,pos);pos+=8
        segment=data[pos:pos+size]
        if len(segment)!=size:raise ValueError('ESP镜像segment被截断')
        for byte in segment:checksum^=byte
        segments.append(segment);pos+=size
    checksum_at=((pos+16)//16)*16-1
    if checksum_at>=len(data) or data[checksum_at]!=checksum:raise ValueError('ESP镜像XOR checksum无效')
    if data[23]:
        digest=hashlib.sha256(data[:checksum_at+1]).digest()
        if data[checksum_at+1:checksum_at+33]!=digest:raise ValueError('ESP镜像内置SHA256无效')
    app=next((s for s in segments if s[:4]==struct.pack('<I',0xabcd5432)),None)
    return {'chipId':struct.unpack_from('<H',data,12)[0],
        'minRevision':struct.unpack_from('<H',data,15)[0],'maxRevision':struct.unpack_from('<H',data,17)[0],
        'appElfSha256':app[144:176].hex() if app else None,
        'idfVersion':app[112:144].split(b'\0',1)[0].decode(errors='replace') if app else None}


def _dependency_sources_match(source,index):
    source=Path(source).resolve()
    entries=[item for item in index['files'] if not is_os_metadata(item['relativePath'])]
    actual={p.relative_to(source).as_posix() for p in (source/'managed_components').rglob('*') if p.is_file() and not is_os_metadata(p)}
    if actual!={item['relativePath'] for item in entries} or sha(source/'dependencies.lock')!=index['lockSha256']:return False
    for item in entries:
        file=(source/item['relativePath'])
        if file.is_symlink() or not file.resolve().is_relative_to(source) or sha(file)!=item['sha256']:return False
    return True


def validate_build(value, *, _nested=False):
    """Re-open delivered files and cross-check ELF, ESP images and flash layout."""
    report_path=Path(value if isinstance(value,(str,Path)) else value['manifestPath']).resolve()
    report=json.loads(report_path.read_text(encoding='utf-8'));root=Path(report['artifactRoot']).resolve()
    errors=[];checks={};by_role=collections.defaultdict(list)
    if not report_path.is_relative_to(root):raise ValueError('固件清单不属于产物根目录')
    for a in report.get('artifacts',[]):
        try:
            path=Path(a['path']);resolved=path.resolve()
            if path.is_symlink() or not resolved.is_relative_to(root):raise ValueError('产物路径越出本次包')
            relative=resolved.relative_to(root).as_posix()
            if relative!=a['relativePath']:raise ValueError('产物相对路径不一致')
            if is_os_metadata(relative):continue
            data=resolved.read_bytes()
            if len(data)!=a['bytes'] or hashlib.sha256(data).hexdigest()!=a['sha256']:raise ValueError('产物bytes/hash与清单不一致')
            by_role[a['role']].append((resolved,data,a))
        except Exception as error:errors.append(a.get('role','unknown')+': '+str(error))
    checks['artifactHashes']=not errors
    for role in ['source','buildLog','elf','map','applicationBin','flashArgs','flashArgsText','bootloaderBin','partitionBin','mergedBin']:
        if not by_role[role]:errors.append('缺少实际构建产物: '+role)
    target=report.get('target');expected_chip={'esp32s31':32,'esp32p4':18,'esp32c61':20}.get(target)
    try:
        elf=by_role['elf'][0][1]
        checks['elfRiscV32']=elf[:4]==b'\x7fELF' and elf[4]==1 and elf[5]==1 and struct.unpack_from('<H',elf,16)[0]==2 and struct.unpack_from('<H',elf,18)[0]==243
        if not checks['elfRiscV32']:errors.append('ELF不是32位小端RISC-V可执行文件')
        images={role:by_role[role][0][1] for role in ['applicationBin','bootloaderBin']}
        image_info={role:_esp_image(data) for role,data in images.items()}
        checks['imageChipId']=expected_chip is not None and all(image['chipId']==expected_chip for image in image_info.values())
        checks['imageChecksums']=True
        if target=='esp32p4':
            family=report.get('siliconRevisionFamily');expected_range=(0,199) if family=='legacy' else (300,399) if family=='v3' else None
            checks['imageSiliconRevisionRange']=expected_range is not None and all((image['minRevision'],image['maxRevision'])==expected_range for image in image_info.values())
            if not checks['imageSiliconRevisionRange']:errors.append('真实boot/app镜像硅片修订范围与构建档位不一致')
        checks['applicationMatchesElf']=image_info['applicationBin']['appElfSha256']==hashlib.sha256(elf).hexdigest()
        if not checks['applicationMatchesElf']:errors.append('BIN内嵌ELF SHA与实际ELF不一致')
        if not checks['imageChipId']:errors.append('真实BIN芯片ID与目标不符')
        flash=json.loads(by_role['flashArgs'][0][1]);build=by_role['flashArgs'][0][0].parent
        if flash['extra_esptool_args']['chip']!=target:errors.append('实际flash_args芯片目标不符')
        merged=by_role['mergedBin'][0][1];delivered={str(a[0]):a[2]['sha256'] for values in by_role.values() for a in values}
        offset_ok=True
        for offset,relative in flash['flash_files'].items():
            file=(build/relative).resolve()
            if not file.is_relative_to(root) or str(file) not in delivered:offset_ok=False;continue
            data=file.read_bytes();start=int(offset,0)
            offset_ok &= merged[start:start+len(data)]==data
            recorded=next((i for i in report['flash']['offsets'] if i['offset']==offset),None)
            offset_ok &= bool(recorded and recorded['sha256']==sha(file) and Path(recorded['path']).resolve()==file)
        partition=by_role['partitionBin'][0][1];app_entry=None
        for pos in range(0,len(partition)-31,32):
            magic,kind,subtype,offset,size=struct.unpack_from('<HBBII',partition,pos)
            if magic!=0x50aa:break
            if kind==0 and subtype==0:app_entry=(offset,size)
        checks['partitionFitsApplication']=bool(app_entry and int(flash['app']['offset'],0)==app_entry[0] and len(images['applicationBin'])<=app_entry[1])
        if not checks['partitionFitsApplication']:errors.append('实际分区表不能容纳本次应用或offset不一致')
        checks['flashLayoutAndMergedBytes']=offset_ok
        if not offset_ok:errors.append('合并固件与实际分区/boot/app字节或offset不一致')
        text=by_role['flashArgsText'][0][1].decode()
        checks['replayFlashArgs']=str(report.get('scratchBuildPath','<none>')) not in text and all(relative in text for relative in flash['flash_files'].values())
        if not checks['replayFlashArgs']:errors.append('flash_args残留不可重放临时路径')
    except Exception as error:errors.append('读取ELF/BIN/flash布局失败: '+str(error))
    try:
        facts=inspect_board(report['boardFacts']['source']['path'])
        checks['sourceBoardUnchanged']=facts['source']['sha256']==report['boardSourceSha256'] and facts['board']['primaryTarget']==target
        if not checks['sourceBoardUnchanged']:errors.append('当前源板与构建来源不一致')
        profile=validate_profile(facts,report['profile']);header_path=Path(report['sourceDir'])/'main/hdk_board_config.h'
        if target=='esp32s31' and not header_path.exists():header_path=Path(report['sourceDir'])/'main/board_config.h'
        header=header_path.read_text()
        checks['boardHashEmbedded']=report['boardSourceSha256'] in header and report['boardSourceSha256'].encode() in by_role['applicationBin'][0][1]
        if not checks['boardHashEmbedded']:errors.append('固件未嵌入本次源板哈希')
        before,digest=header.rsplit('#define HDK_CONFIG_SHA256 ',1);config_digest=json.loads(digest.strip())
        checks['configurationEmbedded']=hashlib.sha256(before.encode()).hexdigest()==config_digest and config_digest.encode() in by_role['applicationBin'][0][1]
        if not checks['configurationEmbedded']:errors.append('固件内嵌配置摘要与交付源码不一致')
        sdkconfig=(Path(report['sourceDir'])/'sdkconfig').read_text()
        checks['usbConsoleConfigured']='CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y' in sdkconfig and '\nCONFIG_ESP_CONSOLE_NONE=y' not in sdkconfig
        if not checks['usbConsoleConfigured']:errors.append('USB Serial/JTAG控制台未在实际sdkconfig启用')
        if target=='esp32p4':
            checks['exactVendorBoardConfigured']='CONFIG_WT_BSP_BOARD_WT9932P4C61_TINY=y' in sdkconfig and '\nCONFIG_WT_BSP_BOARD_WT9932P4_TINY=y' not in sdkconfig
            if not checks['exactVendorBoardConfigured']:errors.append('实际BSP选板并非本次P4C61板')
        checks['fixtureConfigured']=('gpio-loopback' not in profile['tests']) or bool(profile['fixturePairs'])
        actual_coverage=coverage(facts,profile)
        checks['boardFeatureCoverage']=actual_coverage['complete']
        if not checks['boardFeatureCoverage']:errors.append('实际板功能测试代码尚未覆盖: '+','.join(actual_coverage['missingTests']))
        checks['physicalPassNotClaimed']=report.get('physicalTestStatus')=='not-run'
        if not checks['physicalPassNotClaimed']:errors.append('构建清单把未实测硬件冒充通过')
    except Exception as error:errors.append('读取源工程/测试配置失败: '+str(error))
    if target=='esp32p4':
        try:
            index_path=next(item[0] for item in by_role['dependencySourceIndex'] if item[0].parent==Path(report['sourceDir']))
            index=json.loads(index_path.read_text());source=Path(report['sourceDir']).resolve()
            checks['dependencySourcesPinned']=_dependency_sources_match(source,index)
            if not checks['dependencySourcesPinned']:errors.append('注册依赖源码或固定lock已变化')
        except Exception as error:errors.append('依赖源码索引无效: '+str(error))
        if not _nested:
            try:
                variants=report['revisionVariants'];modern=next(v for v in variants if v['family']=='v3')
                child=validate_build(modern['manifestPath'],_nested=True)
                checks['bothP4RevisionFamiliesBuilt']=report.get('siliconRevisionFamily')=='legacy' and child['status']=='complete'
                companion=_companion().validate_build(report['companion']['manifestPath'])
                checks['c61CompanionBuilt']=companion['status']=='complete' and companion['boardSourceSha256']==report['boardSourceSha256']
                if not checks['bothP4RevisionFamiliesBuilt']:errors.append('P4两套互斥silicon镜像尚未分别独立验收')
                if not checks['c61CompanionBuilt']:errors.append('C61配套源码/固件未独立验收或来源不一致')
            except Exception as error:errors.append('P4/C61整套镜像验收失败: '+str(error))
    checks['buildExitCode']=report.get('exitCode')==0
    if not checks['buildExitCode']:errors.append('构建退出码非0')
    checks['fixedSdkCommit']=report.get('idf',{}).get('commit')==SDK_COMMIT
    if not checks['fixedSdkCommit']:errors.append('构建未使用固定SDK提交')
    return {'schemaVersion':1,'status':'complete' if not errors else 'blocked','target':target,
        'boardSourceSha256':report.get('boardSourceSha256'),'physicalTestStatus':'not-run',
        'manifestPath':str(report_path),'checks':checks,'errors':errors,
        'artifacts':[a for a in report.get('artifacts',[]) if a['role']!='source' and not is_os_metadata(a['path'])]}


def main():
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=['inspect','generate','compile','verify']);parser.add_argument('--source');parser.add_argument('--profile');parser.add_argument('--package');parser.add_argument('--generation');parser.add_argument('--output');args=parser.parse_args()
    if args.action=='inspect':result=inspect_board(args.source)
    elif args.action=='generate':result=generate(inspect_board(args.source),json.loads(Path(args.profile).read_text()),args.package)
    elif args.action=='compile':result=compile(json.loads(Path(args.generation).read_text()))
    else:result=validate_build(args.generation)
    if args.output:write_json(args.output,result)
    print(json.dumps(result,ensure_ascii=False))
    return 0 if result.get('status')!='failed' else 2

if __name__=='__main__':raise SystemExit(main())
