"""Read-only firmware profile constraint learning, without export or compilation.

Private cases pin actual upstream Skill inputs. The model sees those inputs;
only this fixed verifier resolves their original board paths and re-reads EDA.
"""
from pathlib import Path
from contextlib import closing
import hashlib
import importlib.util
import json
import os
import sqlite3

ROOT = Path(__file__).resolve().parents[1]
REGISTRY = ROOT / '.local/hdk-profile-learning/cases.json'
DATABASE = ROOT / '.local/workbench.sqlite'
WORKFLOW_ID = 'workflow-hdk-profile-constraints'


def _hash(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def _firmware():
    spec = importlib.util.spec_from_file_location('hdk_frozen_firmware_constraints', ROOT / 'hdk/test_firmware.py')
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def _record(run_id):
    with closing(sqlite3.connect('file:' + str(DATABASE) + '?mode=ro', uri=True)) as connection:
        row = connection.execute('SELECT value FROM workflow_runs WHERE id=?', (run_id,)).fetchone()
    if not row:
        raise RuntimeError('Missing immutable workflow run snapshot.')
    return json.loads(row[0])


def _case(expected_node, registry_sha256):
    if hashlib.sha256(REGISTRY.read_bytes()).hexdigest() != registry_sha256:
        raise RuntimeError('Read-only profile learning registry changed.')
    registry = json.loads(REGISTRY.read_text(encoding='utf-8'))
    record = _record(os.environ.get('WORKBENCH_RUN_ID', ''))
    if (os.environ.get('WORKBENCH_NODE_ID') != expected_node or record.get('currentNodeId') != expected_node
        or record.get('workflowId') != WORKFLOW_ID or os.environ.get('WORKBENCH_WORKFLOW_ID') != WORKFLOW_ID):
        raise RuntimeError('Profile verifier is not bound to its admitted workflow node.')
    raw = record.get('input')
    if not isinstance(raw, dict) or set(raw) != {'caseId'} or raw['caseId'] not in registry['cases']:
        raise RuntimeError('Only registered immutable case IDs are accepted.')
    case = registry['cases'][raw['caseId']]
    origin = _record(case['originRunId'])
    node = origin.get('nodes', {}).get(case['originNodeId'], {})
    if node.get('status') != 'complete' or _hash(node.get('output')) != case['skillInputSha256']:
        raise RuntimeError('Actual upstream firmware Skill input changed or is incomplete.')
    if _hash(case['skillInput']) != case['skillInputSha256']:
        raise RuntimeError('Registered case no longer matches actual upstream input.')
    return case


def bind_case(_input, registry_sha256):
    """Return the actual upstream payload, never a model-provided facts copy."""
    case = _case('profile-input-bind', registry_sha256)
    check_case(case)
    return case['skillInput']


def check_case(case):
    firmware = _firmware()
    facts = firmware.inspect_board(case['sourcePath'])
    given = case['skillInput']
    if facts['source']['sha256'] != case['sourceSha256'] or given['boardFacts']['source']['sha256'] != case['sourceSha256']:
        raise RuntimeError('Board source changed; optimization cannot repair source evidence.')
    public = {**facts, 'source': {k: v for k, v in facts['source'].items() if k != 'path'},
        'board': {k: v for k, v in facts['board'].items() if k != 'components'}}
    if public != given['boardFacts']:
        raise RuntimeError('Fresh native board facts differ from the original actual Skill input.')
    if firmware.design_fixture(facts) != given['fixtureDesign']:
        raise RuntimeError('Native fixture facts differ from the original actual Skill input.')
    schema = json.loads((ROOT / 'skills/hdk-test-firmware/references/profile.schema.json').read_text())
    if schema != given['profileSchema']:
        raise RuntimeError('Frozen profile schema differs from the actual upstream schema.')
    return firmware, facts


def evaluate_case(case, candidate):
    """Validate only constraints. This is not an HDK or hardware quality score."""
    firmware, facts = check_case(case)
    diagnostics = []
    actual_coverage = None
    try:
        profile = firmware.validate_profile(facts, candidate)
        actual_coverage = firmware.coverage(facts, profile)
        if not actual_coverage['complete']:
            diagnostics.append({'kind': 'boardCoverage', 'message': 'Required native board features or ordinary header GPIO are missing.',
                'missing': actual_coverage['missingTests']})
        requirements = case['skillInput']['testRequirements']
        for key in ('cameraSensor', 'displayPanel'):
            if requirements.get(key) is not None and profile.get(key) != requirements[key]:
                diagnostics.append({'kind': 'accessoryRequirement', 'field': key,
                    'message': 'Profile must honor the explicit supported test accessory requirement; connectors do not identify an installed accessory.'})
    except (ValueError, TypeError, KeyError) as error:
        diagnostics.append({'kind': 'fixedProfileValidation', 'message': str(error)})
    if not diagnostics:
        return {'valid': True}
    peripherals = facts['peripherals']
    return {'valid': False, 'candidateProfile': candidate, 'diagnostics': diagnostics,
        'nativeInterfaces': {'camera': (peripherals.get('camera') or {}).get('interface'),
            'display': (peripherals.get('display') or {}).get('interface'), 'target': facts['board']['primaryTarget']},
        **({'coverage': actual_coverage} if actual_coverage is not None else {})}


def verify_profile(candidate, registry_sha256):
    return evaluate_case(_case('profile-verify', registry_sha256), candidate)
