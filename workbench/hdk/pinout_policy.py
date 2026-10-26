"""Current source-bound Pinout policy shared by rendering and both deliveries.

The V2/legacy evaluators remain unchanged. Their actual raster, SVG, source,
photo and geometry results stay authoritative and are retained in this report.
"""
from copy import deepcopy
import re

POLICY_ID = 'source-bound-primary-secondary-function-aliases'
POLICY_VERSION = 3


def evaluate_pinout_views(views, *, reference_contract=None):
    """Accept only exact source-proven UART0/BOOT aliases, with no MAIN prefix."""
    from hdk.pinout_evaluation_v2 import evaluate_pinout_views as evaluate_v2, namespace_issues, CHECK_ID
    reference = evaluate_v2(views, reference_contract=reference_contract)
    inventory = deepcopy(reference.get('labelInventory'))
    aliases, accepted, prefix_issues = {'U0RXD': 'RX0', 'U0TXD': 'TX0', 'BOOT': 'BOOT'}, [], []
    for row in inventory if isinstance(inventory, list) else []:
        if not isinstance(row, dict): continue
        label = row.get('displayLabel')
        if isinstance(label, str) and re.search(r'(?<![A-Za-z0-9])MAIN(?![A-Za-z0-9])', label, re.I):
            prefix_issues.append(f"{row.get('side')}: {row.get('connector')}.{row.get('pad')}: redundant MAIN prefix is not permitted in the default primary namespace.")
        match = re.fullmatch(r'IO(\d+)_(U0RXD|U0TXD|BOOT)', str(row.get('sourceNet', '')))
        if match and row.get('traceNet') == row.get('sourceNet') and label == aliases[match.group(2)]:
            accepted.append({key: row.get(key) for key in ('side', 'connector', 'pad', 'sourceNet', 'traceNet', 'displayLabel')})
            # Expand only the temporary namespace-check inventory. Actual export
            # labels, facts, pixels, SVG geometry and report inventory stay intact.
            row['displayLabel'] = 'IO' + match.group(1) + ' ' + label
    issues = namespace_issues(inventory, {view.get('side') for view in views}) + prefix_issues
    result = deepcopy(reference)
    summary = result['qualitySummary']; summary['checks'][CHECK_ID] = not issues
    summary['passed'] = all(summary['checks'].values()); result['passed'] = summary['passed']
    result['checks'] = [dict(row, passed=not issues, issues=list(issues)) if row['id'] == CHECK_ID else row for row in result['checks']]
    result['diagnostics'] = [row for row in result['diagnostics'] if row['check'] != CHECK_ID]
    result['diagnostics'].extend({'check': CHECK_ID, 'message': issue} for issue in issues)
    policy = dict(reference['namespacePolicy'], id=POLICY_ID, version=POLICY_VERSION,
        primary='Unprefixed source IO<n> is the primary namespace; only exact source-proven UART0/BOOT function aliases may omit its IO number. MAIN is not a visible label prefix.',
        functionAliases={
            'scope': 'source-bound-pinout-capabilities',
            'sourcePatterns': {'IO<n>_U0RXD': 'RX0', 'IO<n>_U0TXD': 'TX0', 'IO<n>_BOOT': 'BOOT'},
            'rule': 'Only exact source-derived function aliases may omit their IO number; ordinary IO numbers, C61 identity, source trace and source rail names remain mandatory.',
            'accepted': accepted,
        })
    result.update(namespacePolicy=policy, v2Reference=reference)
    comparison = result['learningComparison']; comparison['qualitySummary'] = deepcopy(summary)
    comparison['namespacePolicy'] = deepcopy(policy)
    comparison['v2NamespaceReference'] = next(deepcopy(row) for row in reference['checks'] if row['id'] == CHECK_ID)
    comparison['diagnostics'] = [row for row in comparison['diagnostics'] if row['check'] != CHECK_ID]
    if issues: comparison['diagnostics'].append({'check': CHECK_ID, 'affectedCount': len(issues), 'examples': issues[:3]})
    return result
