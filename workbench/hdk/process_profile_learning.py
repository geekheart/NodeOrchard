"""Read-only process-profile constraint learning, never an HDK quality score.

The registry pins real upstream inputs and their source records. The new input
variant adds only the source-derived interfaces now exposed by prepare_process;
fixed validation rereads that same EPRO2 and never generates a workbook/export.
"""
from contextlib import closing
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3

ROOT = Path(__file__).resolve().parents[1]
REGISTRY = ROOT / '.local/hdk-process-profile-learning/cases.json'
DATABASE = ROOT / '.local/workbench.sqlite'
WORKFLOW_ID = 'workflow-hdk-process-profile-constraints'


def _hash(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def _module(name):
    spec = importlib.util.spec_from_file_location('hdk_process_constraints_'+name, ROOT / 'hdk' / (name+'.py'))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def _record(run_id):
    with closing(sqlite3.connect('file:'+str(DATABASE)+'?mode=ro', uri=True)) as connection:
        row = connection.execute('SELECT value FROM workflow_runs WHERE id=?', (run_id,)).fetchone()
    if not row: raise RuntimeError('Missing immutable upstream workflow record.')
    return json.loads(row[0])


def interface_facts(board_facts):
    """Same current-source public interface facts as pipeline.prepare_process."""
    peripherals = board_facts.get('peripherals', {})
    interfaces = {key:copy.deepcopy(peripherals[key]) for key in ('sd','camera','display','usb') if peripherals.get(key)}
    if interfaces.get('sd'):
        pins = set(interfaces['sd']['pins'].values())
        interfaces['sd']['signalNets'] = sorted(net for net,gpio in board_facts.get('netGpioMap',{}).items() if gpio in pins)
    usb_signals = {pin['net'] for port in interfaces.get('usb',[]) for pin in port.get('pins',[])
        if pin.get('net') and pin.get('name','').lower().startswith(('dp','dn'))}
    interfaces['usbSignalPathComponents'] = [{key:copy.deepcopy(component[key]) for key in ('designator','part','pins')}
        for component in board_facts.get('board',{}).get('components',[])
        if component.get('designator','').startswith(('R','L')) and
        any(pin.get('net') in usb_signals for pin in component.get('pins',[]))]
    return interfaces


def fresh_input(case):
    """Reproduce the read-only upstream payload and verify its historical origin."""
    origin = _record(case['originRunId'])
    node = origin.get('nodes',{}).get(case['originNodeId'],{})
    if node.get('status') != 'complete' or _hash(node.get('output')) != case['originInputSha256']:
        raise RuntimeError('The actual upstream process input changed or is incomplete.')
    params = case['params']
    if any(params[k] != origin['input'][k] for k in ('sourcePath','productCode','hardwareVersion','releaseDate')):
        raise RuntimeError('Registered parameters differ from the real upstream request.')
    process, firmware = _module('process_requirements'), _module('test_firmware')
    current = process.prepare_process_request(params)
    original = copy.deepcopy(node['output'])
    original['facts'].pop('interfaces',None)
    if current != original:
        raise RuntimeError('Fresh source/schema/profile facts differ from the original prepare_process input.')
    if current['facts']['sourceSha256'] != case['sourceSha256']:
        raise RuntimeError('The registered board source changed.')
    board = firmware.inspect_board(params['sourcePath'])
    if board['source']['sha256'] != case['sourceSha256']:
        raise RuntimeError('Native interface facts refer to another source.')
    if case['inputVariant'] == 'with-source-interfaces':
        current['facts']['interfaces'] = interface_facts(board)
    elif case['inputVariant'] != 'original':
        raise RuntimeError('Unknown fixed upstream input variant.')
    return process, current, board


def _case(expected_node, registry_sha256):
    raw = REGISTRY.read_bytes()
    if hashlib.sha256(raw).hexdigest() != registry_sha256:
        raise RuntimeError('Read-only process constraint registry changed.')
    registry = json.loads(raw)
    for relative, expected in registry['implementationHashes'].items():
        if hashlib.sha256((ROOT/relative).read_bytes()).hexdigest() != expected:
            raise RuntimeError('Read-only process verifier implementation changed during learning.')
    record = _record(os.environ.get('WORKBENCH_RUN_ID',''))
    if (record.get('id') != os.environ.get('WORKBENCH_RUN_ID') or
        record.get('learningId') != os.environ.get('WORKBENCH_LEARNING_ID') or not record.get('learningId') or
        record.get('workflowId') != WORKFLOW_ID or os.environ.get('WORKBENCH_WORKFLOW_ID') != WORKFLOW_ID or
        record.get('currentNodeId') != expected_node or os.environ.get('WORKBENCH_NODE_ID') != expected_node):
        raise RuntimeError('Process constraint verifier is not bound to its learning workflow node.')
    value = record.get('input')
    if not isinstance(value,dict) or set(value) != {'caseId'} or value['caseId'] not in registry['cases']:
        raise RuntimeError('Only admitted immutable case IDs are accepted.')
    case = registry['cases'][value['caseId']]
    if _hash(case['skillInput']) != case['skillInputSha256']:
        raise RuntimeError('Registered upstream payload changed.')
    return case


def bind_case(_input, registry_sha256):
    case = _case('process-profile-input-bind',registry_sha256)
    _, current, _ = fresh_input(case)
    if current != case['skillInput']:
        raise RuntimeError('Registered input is not the current read-only upstream payload.')
    return current


def source_requirements(facts, board, interfaces):
    """Protocol targets from real interfaces and source differential pair nets.

    A USB connector's net name can change across a common-mode/series component.
    Include only additional source-declared differential pair members found on
    those source-linked R/L components; do not sweep their power/ground pins in.
    """
    signal_nets = set(facts['signalNets'])
    pairs = [set(nets) for nets in facts['nativeDifferentialPairs'].values() if len(set(nets))==2]
    usb_seeds = {pin['net'] for port in interfaces.get('usb',[]) for pin in port['pins']
        if pin.get('net') and pin.get('name','').lower().startswith(('dp','dn'))}
    path_nets = {pin['net'] for c in interfaces.get('usbSignalPathComponents',[]) for pin in c['pins'] if pin.get('net')}
    usb_aliases = set().union(*(pair for pair in pairs if pair <= path_nets)) if pairs else set()
    usb_nets = (usb_seeds | usb_aliases) & signal_nets
    requirements = []
    def target(family,nets,kind,ohms,evidence):
        if nets: requirements.append({'family':family,'nets':sorted(nets),'kind':kind,
            'targetOhms':ohms,'tolerancePercent':10,'evidence':evidence})
    target('USB',usb_nets,'differential',90,'actual USB Dp/Dn pins plus differential pairs across source-linked R/L signal-path components')
    mipi_nets = set()
    components = {c['designator']:c for c in board['board']['components']}
    pair_members = set().union(*pairs) if pairs else set()
    for key in ('camera','display'):
        interface = interfaces.get(key,{})
        if str(interface.get('interface','')).startswith('mipi-'):
            connector = components.get(interface.get('connector'),{})
            mipi_nets.update(pin['net'] for pin in connector.get('pins',[])
                if pin.get('net') in pair_members and pin.get('net') in signal_nets)
    target('MIPI',mipi_nets,'differential',100,'source-confirmed MIPI CSI/DSI connectors and source differential pair members')
    sd_nets = set(interfaces.get('sd',{}).get('signalNets',[])) & signal_nets
    target('SDIO',sd_nets,'single-ended',50,'source SD socket bus pins and native net-to-GPIO map, regardless of net spelling')
    return requirements


def profile_diagnostics(process, facts, records, profile, requirements):
    effective = process._effective_targets(records,profile)
    diagnostics = []
    for required in requirements:
        nets = set(required['nets']); covered = set(); conflicts = []
        for target in effective:
            matched = nets.intersection(target['nets'])
            if not matched: continue
            if all(target[k] == required[k] for k in ('kind','targetOhms','tolerancePercent')):
                covered.update(matched)
            else:
                conflicts.append({'target':target['name'],'nets':sorted(matched),
                    'kind':target['kind'],'targetOhms':target['targetOhms'],'tolerancePercent':target['tolerancePercent']})
        if nets-covered:
            diagnostics.append({'kind':'missingProtocolCoverage','family':required['family'],
                'missingNets':sorted(nets-covered),'requiredKind':required['kind'],
                'requiredOhms':required['targetOhms'],'requiredTolerancePercent':required['tolerancePercent'],
                'sourceEvidence':required['evidence']})
        if conflicts:
            diagnostics.append({'kind':'conflictingProtocolTargets','family':required['family'],'conflicts':conflicts})
    return diagnostics


def evaluate_case(case, candidate):
    """Only profile legality/coverage; never create XLSX, exports, or HDK scores."""
    process, current, board = fresh_input(case)
    if current != case['skillInput']:
        raise RuntimeError('Current upstream payload differs from its admitted snapshot.')
    facts, records, _ = process._source_data(Path(case['params']['sourcePath']))
    diagnostics = []
    try:
        if not isinstance(candidate,dict) or candidate.get('schemaVersion') != 1:
            raise ValueError('Return a process profile object with schemaVersion=1.')
        profile = process._profile(candidate)
        z,sheets = process._xlsx_read(Path(current['templatePath']).read_bytes())
        controls,_ = process._template_controls(z,sheets)
        process._edit_plan(facts,profile,current['productCode'],current['hardwareVersion'],
            current['releaseDate'],controls,process._effective_targets(records,profile))
        if case['requiredPolicy'] == 'source-interface-guidelines':
            requirements = source_requirements(facts,board,interface_facts(board))
        elif case['requiredPolicy'] == 'successful-origin-profile':
            origin = _record(case['originRunId'])
            old = origin['nodes'][case['originProfileNodeId']]
            if old['status'] != 'complete' or _hash(old['output']) != case['originProfileSha256']:
                raise RuntimeError('Successful reference profile changed.')
            requirements = [{'family':t['name'],'nets':t['nets'],'kind':t['kind'],
                'targetOhms':t['targetOhms'],'tolerancePercent':t['tolerancePercent'],
                'evidence':'same required targets as the actual successful reference profile; no new held-out standard'}
                for t in process._effective_targets(records,process._profile(old['output']))]
        else:
            raise RuntimeError('Unknown fixed constraint policy.')
        diagnostics.extend(profile_diagnostics(process,facts,records,profile,requirements))
    except (ValueError,TypeError,KeyError) as error:
        diagnostics.append({'kind':'fixedProfileValidation','message':str(error)})
    if not diagnostics: return {'valid':True}
    return {'valid':False,'candidateProfile':candidate,'diagnostics':diagnostics,
        'scope':'Read-only protocol-profile constraints, not HDK or physical hardware quality.'}


def verify_profile(candidate, registry_sha256):
    return evaluate_case(_case('process-profile-verify',registry_sha256),candidate)
