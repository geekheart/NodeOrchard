"""V2 source-bound namespaces over the unchanged real-image evaluator.

Only multi-chip-disambiguation is replaced. Every raster, SVG, electrical
trace, photograph, palette and geometry check still comes from the legacy
evaluator, whose full unmodified report is retained as legacyReference.
"""
from copy import deepcopy
import re

from hdk import pinout_learning as legacy

CHECK_ID = 'multi-chip-disambiguation'
NAMESPACE_POLICY = {
    'id': 'source-bound-primary-io-secondary-prefix', 'version': 2,
    'primary': 'Unprefixed source IO<n> is the primary namespace; its exact IO number must remain visible.',
    'secondary': 'C61 source signals keep C61; C61_IO<n> also keeps that exact IO number.',
    'power': 'Exact LDO_VO<n> may display VO<n>; the suffix asserts neither voltage nor GPIO identity.',
    'roles': 'Source-proven BOOT, EN, U0RXD and U0TXD remain visible as BOOT, EN, RX0/U0RXD and TX0/U0TXD.',
    'trace': 'Every evaluated row retains sourceNet == traceNet; this policy never changes electrical facts.',
}


def _token(pattern, text):
    return re.search(r'(?<![A-Za-z0-9])(?:' + pattern + r')(?![A-Za-z0-9])', text, re.I) is not None


def namespace_issues(inventory, sides):
    """Inspect actual exported label inventory; never accept a manifest pass."""
    issues, seen, represented = [], set(), set()
    if not isinstance(inventory, list) or not inventory:
        return ['all: No actual exported label inventory is available for the V2 namespace policy.']
    for row in inventory:
        if not isinstance(row, dict):
            issues.append('all: Actual exported label inventory contains a malformed row.'); continue
        side, connector, pad = row.get('side'), row.get('connector'), row.get('pad')
        key = (side, connector, pad)
        location = f'{side}: {connector}.{pad}'
        if side not in sides or not connector or not pad or key in seen:
            issues.append(location + ': exported source identity is missing, duplicated or outside the selected views.')
        seen.add(key); represented.add(side)
        source, trace, label = row.get('sourceNet'), row.get('traceNet'), row.get('displayLabel')
        if not isinstance(source, str) or not source or trace != source or not isinstance(label, str) or not label.strip():
            issues.append(location + ': visible label or its retained source-net trace is missing or mismatched.'); continue
        primary = re.fullmatch(r'IO(\d+)(?:_.*)?', source, re.I)
        secondary = re.match(r'^C61(?:_|$)', source, re.I)
        secondary_io = re.fullmatch(r'C61_IO(\d+)(?:_.*)?', source, re.I)
        actual_ios = re.findall(r'(?<![A-Za-z0-9])IO(\d+)(?![A-Za-z0-9])', label, re.I)
        if primary:
            if actual_ios != [primary.group(1)]:
                issues.append(location + f': primary label {label!r} must retain the exact source IO{primary.group(1)} number.')
            if _token('C61', label):
                issues.append(location + ': primary IO label incorrectly claims the C61 namespace.')
        if secondary:
            if not _token('C61', label):
                issues.append(location + f': secondary label {label!r} must retain its source C61 namespace.')
            if secondary_io and actual_ios != [secondary_io.group(1)]:
                issues.append(location + f': C61 label {label!r} must retain the exact source IO{secondary_io.group(1)} number.')
        rail = re.fullmatch(r'LDO_(VO\d+)', source)
        if rail and label not in {source, rail.group(1)}:
            issues.append(location + f': source rail {source} may retain its raw name or {rail.group(1)}, not an inferred voltage or GPIO.')
        for source_pattern, display_pattern, role in (
            (r'(?:^|_)BOOT(?:_|$)', 'BOOT', 'BOOT'),
            (r'(?:^|_)EN(?:_|$)', 'EN', 'EN'),
            (r'(?:^|_)U0RXD(?:_|$)', 'RX0|U0RXD', 'RX0'),
            (r'(?:^|_)U0TXD(?:_|$)', 'TX0|U0TXD', 'TX0'),
        ):
            if re.search(source_pattern, source, re.I) and not _token(display_pattern, label):
                issues.append(location + f': source-proven {role} role disappears or changes in the visible main label {label!r}.')
    for side in sides - represented:
        issues.append(str(side) + ': selected view has no actual namespace inventory.')
    return list(dict.fromkeys(issues))


def evaluate_pinout_views(views, *, reference_contract=None):
    """Read real artifacts through the old evaluator, then apply V2 namespaces."""
    reference = legacy.evaluate_pinout_views(views, reference_contract=reference_contract)
    result = deepcopy(reference)
    issues = namespace_issues(reference.get('labelInventory'), {view.get('side') for view in views})
    checks = dict(reference['qualitySummary']['checks'])
    checks[CHECK_ID] = not issues
    summary = {'passed': all(checks.values()), 'checks': checks}
    result.update(passed=summary['passed'], qualitySummary=summary, namespacePolicy=deepcopy(NAMESPACE_POLICY),
                  legacyReference=deepcopy(reference))
    result['checks'] = [dict(row, passed=not issues, issues=list(issues)) if row['id'] == CHECK_ID else row
                        for row in result['checks']]
    result['diagnostics'] = [row for row in result['diagnostics'] if row['check'] != CHECK_ID]
    result['diagnostics'].extend({'check': CHECK_ID, 'message': issue} for issue in issues)
    comparison = result['learningComparison']
    comparison['qualitySummary'] = deepcopy(summary)
    comparison['namespacePolicy'] = deepcopy(NAMESPACE_POLICY)
    old_namespace = next(row for row in reference['checks'] if row['id'] == CHECK_ID)
    comparison['legacyReference'] = {'passed': reference['passed'], 'namespacePassed': old_namespace['passed'],
                                   'namespaceIssueCount': len(old_namespace['issues']), 'namespaceExamples': old_namespace['issues'][:3]}
    comparison['diagnostics'] = [row for row in comparison['diagnostics'] if row['check'] != CHECK_ID]
    if issues:
        comparison['diagnostics'].append({'check': CHECK_ID, 'affectedCount': len(issues), 'examples': issues[:3]})
    return result
