"""Evaluator-side structure checks for bilingual, source-bound user guides.

This module never returns reference Markdown to a workflow capability node.
``reference-contract.json`` contains editorial requirements and source hashes,
not board-specific answers. Electrical correctness is checked against *current*
execution facts, independently from the learning example's prose.
"""
from pathlib import Path
import argparse
import hashlib
import json
import re
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONTRACT = Path(__file__).with_name('learning') / 'user-guide' / 'reference-contract.json'


def execution_editorial_contract(contract_path=None):
    """Allowlisted generic guidance; deliberately omits target identities/paths."""
    value = json.loads(Path(contract_path or DEFAULT_CONTRACT).read_text())
    return {key: value[key] for key in ('schemaVersion', 'naming', 'sections', 'requiredImageRoles',
                                      'minimumNarrativeCharacters', 'requiredCommands', 'style')}


def _reference_excerpts(markdown, language):
    """Representative target prose, excluding tables, code/logs and metadata."""
    collected = {key: [] for key in ('overview', 'features', 'preparation', 'wiring', 'development', 'troubleshooting')}
    current = None
    for line in _outside_fences(markdown).splitlines():
        heading = re.match(r'^#{1,6}\s+(\d+(?:\.\d+)*)\.?\s+(.+)$', line)
        if heading:
            number = heading.group(1)
            current = next((key for prefix, key in [('1.1', 'overview'), ('1.2', 'features'), ('5.1', 'preparation'),
                                                    ('5.2', 'wiring'), ('5.3', 'development')]
                            if number == prefix or number.startswith(prefix + '.')), None)
            continue
        if re.match(r'^\s*(?:\||#|!\[|\\)', line) or not current:
            continue
        cleaned = line.rstrip()
        collected[current].append(cleaned)
        if current == 'development' and line.lstrip().startswith('>'):
            collected['troubleshooting'].append(cleaned)
    budget = 8000 if language == 'zh' else 12000
    result = {}
    for key, lines in collected.items():
        text = re.sub(r'\n{3,}', '\n\n', '\n'.join(lines)).strip()
        # Give all editorial roles a share; no single long chapter consumes the reference.
        cap = min(budget, 1800 if language == 'zh' else 2800)
        if text:
            result[key] = text[:cap].rstrip()
            budget -= len(result[key])
    return result


def build_learning_expected(*, contract_path=None, check_ids=None):
    """Build evaluator/optimizer-only target examples, strictly below 60 KiB.

    Unlike ``execution_editorial_contract``, this function deliberately reads
    known-result Markdown. Its return belongs only in the learning job's
    ``expected`` field, never in workflow input, current facts or Skill input.
    """
    contract = json.loads(Path(contract_path or DEFAULT_CONTRACT).read_text())
    if check_ids is None:
        check_ids = ['bilingual-files'] + [key + '-' + language for language in ('zh', 'en')
                     for key in ('section-coverage', 'narrative-coverage', 'local-assets', 'image-coverage',
                                 'product-identity', 'source-claims', 'getting-started-commands', 'source-pin-tables', 'portable-markdown')]
        check_ids += ['bilingual-pin-consistency', 'bilingual-source-links', 'annotation-exports', 'drawio-block-diagram', 'source-unchanged']
    examples = []
    for reference in contract['references']:
        path = Path(reference['path'])
        if not path.is_file() or path.stat().st_size > 1_000_000 or _sha(path) != reference['sha256']:
            raise ValueError('Known-result guide is missing, oversized or changed: ' + path.name)
        language = reference['language']
        examples.append({'language': language, 'referenceName': path.name, 'sha256': reference['sha256'],
                         'excerpts': _reference_excerpts(path.read_text(encoding='utf-8-sig'), language)})
    expected = {'schemaVersion': 1,
                'qualitySummary': {'schemaVersion': 1, 'checks': dict.fromkeys(check_ids, True)},
                'referenceExamples': examples,
                'semanticCriteria': [
                    'All deterministic qualitySummary checks must pass. An attractive narrative cannot compensate for a wrong pin, missing file or unverified export.',
                    'Compare the current guide narrative and editorial inventory with the reference organization, explanation depth and beginner usability. Do not require equal board-specific facts or verbatim prose.',
                    'Chinese and English must communicate the same actions, limitations and hardware relationships. Preserve current source identifiers, commands and factual values.',
                    'Distinguish fitted hardware from external accessories; place power, cable orientation and software prerequisites next to the relevant actions.',
                    'Give useful development and troubleshooting guidance grounded in the current evidence; do not invent test logs, compatibility, electrical ratings or successful physical tests.',
                    'Learn reusable editorial and annotation methods rather than reference board names, GPIO mappings, fixed menu numbers or broken PDF template links.'
                ],
                'isolation': 'Known-result excerpts are evaluator/optimizer-only. They must never be added to execution facts, ordinary author prompts, Hermes execution memory or validation optimizer context.',
                'validationScope': 'A held-out parameter change on this same board tests consistency; it does not establish independent-hardware generalization.'}
    # Defensive bound even if a future target changes language or grows.
    while len(json.dumps(expected, ensure_ascii=False, separators=(',', ':')).encode()) >= 60 * 1024:
        excerpts = [example['excerpts'] for example in examples]
        owner = max(excerpts, key=lambda value: max(map(len, value.values()), default=0))
        key = max(owner, key=lambda key: len(owner[key]))
        if len(owner[key]) < 200:
            raise ValueError('Reference learning target cannot fit the expected-value budget')
        owner[key] = owner[key][:-200].rstrip()
    return expected


def _sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _body(markdown):
    """Drop Pandoc/YAML metadata, including its embedded raw LaTeX fence."""
    lines = markdown.splitlines()
    if lines and lines[0].strip() == '---':
        for index in range(1, len(lines)):
            if lines[index].strip() in ('---', '...'):
                return '\n'.join(lines[index + 1:])
    return markdown


def _outside_fences(markdown):
    lines, fence = [], None
    for line in _body(markdown).splitlines():
        marker = re.match(r'^\s*(`{3,}|~{3,})', line)
        if marker:
            current = marker.group(1)[0]
            if fence == current:
                fence = None
            elif fence is None:
                fence = current
            lines.append('')
        else:
            lines.append(line if fence is None else '')
    return '\n'.join(lines)


def markdown_inventory(path):
    path = Path(path)
    text = path.read_text(encoding='utf-8-sig')
    prose = _outside_fences(text)
    images = [{'alt': alt, 'target': target} for alt, target in re.findall(r'!\[([^\]]*)\]\(([^)]+)\)', prose)]
    headings = [{'level': len(m.group(1)), 'title': m.group(2).strip()}
                for m in re.finditer(r'^(#{1,6})\s+(.+?)\s*#*$', prose, re.M)]
    tables = []
    table = []
    for line in prose.splitlines() + ['']:
        if line.strip().startswith('|'):
            table.append([cell.strip() for cell in line.strip().strip('|').split('|')])
        elif table:
            if len(table) > 1 and all(re.fullmatch(r':?-+:?', cell.replace(' ', '')) for cell in table[1]):
                tables.append({'header': table[0], 'rows': table[2:]})
            table = []
    return {'path': str(path), 'sha256': _sha(path), 'characters': len(text),
            'headings': headings, 'images': images, 'tables': tables}


def _canonical(value):
    value = re.sub(r'[`*\s]', '', str(value)).upper()
    return {'3V3': '3.3V', '+3V3': '3.3V', '+3.3V': '3.3V', '+5V': '5V', 'VCC3V3': '3.3V'}.get(value, value)


def _pin_tables(markdown):
    """Extract physical pin tables below ``### [REF]`` headings.

    USB contacts and connector shell/detect pads may use A1, B12, CD or SH1.
    Table structure distinguishes headers from data; digit-only pin filtering
    would silently discard real source contacts.
    """
    result, refs, in_table_body = {}, [], False
    for line in _outside_fences(markdown).splitlines():
        heading = re.match(r'^#{1,6}\s+(.+)$', line)
        if heading:
            refs = re.findall(r'\[([A-Za-z]+\d+)\]', heading.group(1))
            in_table_body = False
        if not line.lstrip().startswith('|'):
            in_table_body = False
            continue
        cells = [cell.strip() for cell in line.strip().strip('|').split('|')]
        if all(re.fullmatch(r':?-+:?', cell.replace(' ', '')) for cell in cells):
            in_table_body = True
            continue
        if in_table_body and refs and len(cells) >= 2 and _canonical(cells[0]):
            pair = (_canonical(cells[0]), _canonical(cells[1]))
            for ref in refs:
                result.setdefault(ref.upper(), []).append(pair)
    return result


def _local_assets(markdown, root):
    problems, assets = [], []
    # Includes Markdown images and links; annotations such as {width=60%} are outside URLs.
    for target in re.findall(r'!?\[[^\]]*\]\(([^)]+)\)', _outside_fences(markdown)):
        value = target.strip().split(' "', 1)[0].strip('<>')
        parsed = urlsplit(value)
        if parsed.scheme or parsed.netloc or not parsed.path:
            continue
        decoded = unquote(parsed.path)
        candidate = (root / decoded).resolve()
        if Path(decoded).is_absolute() or not candidate.is_relative_to(root):
            problems.append('Local asset leaves the guide bundle: ' + value)
        elif not candidate.is_file() or candidate.stat().st_size == 0:
            problems.append('Missing or empty local asset: ' + value)
        else:
            assets.append(str(candidate.relative_to(root)))
    return sorted(set(assets)), sorted(set(problems))


def _source_link_key(value):
    # Locale equivalents are expected in a bilingual guide. Other path/query
    # differences remain visible instead of silently collapsing distinct docs.
    value = re.sub(r'/(?:zh_CN|zh-CN|en)/', '/_locale_/', value)
    return re.sub(r'_(?:cn|en)\.pdf(?=$|[?#])', '_locale.pdf', value)


def _source_interfaces(facts):
    """The small public schema intentionally accepts no target-guide prose."""
    interfaces = facts.get('interfaces', [])
    if isinstance(interfaces, dict):
        interfaces = [dict(value, ref=ref) for ref, value in interfaces.items()]
    result = {}
    for interface in interfaces:
        ref = str(interface.get('ref', interface.get('designator', ''))).upper()
        pins = interface.get('pins', [])
        if ref and pins:
            result[ref] = [(_canonical(pin.get('number', pin.get('num', ''))),
                            _canonical(pin.get('net', pin.get('signal', '')))) for pin in pins]
    return result


def evaluate_guide_bundle(bundle_path, *, contract_path=None, facts_path=None, product_code=None):
    """Return deterministic editorial/data checks, never a self-awarded prose score.

    Optional facts JSON: ``{productCode, interfaces:[{ref,pins:[{number,net}]}],
    requiredTerms:[...], forbiddenClaims:[...], requiredCommands:[...]}``. All facts come from the current
    epro2/BSP/verified sources, not the training target. Reference fidelity still
    needs the learning evaluator and visual review; passing here cannot prove it.
    """
    root = Path(bundle_path).resolve()
    contract = json.loads(Path(contract_path or DEFAULT_CONTRACT).read_text())
    facts = json.loads(Path(facts_path).read_text()) if facts_path else {}
    product_code = product_code or facts.get('productCode')
    if product_code:
        paths = [root / f'{product_code}_User_Guide.md', root / f'{product_code}_User_Guide_en.md']
    else:
        zh = [path for path in root.glob('*_User_Guide.md') if path.is_file()]
        paths = [zh[0], zh[0].with_name(zh[0].stem + '_en.md')] if len(zh) == 1 else []
    checks = []

    def check(key, issues):
        checks.append({'id': key, 'passed': not issues, 'issues': issues})

    missing = [str(path.name) for path in paths if not path.is_file()]
    check('bilingual-files', missing if paths else ['Exactly one *_User_Guide.md / *_User_Guide_en.md pair is required.'])
    if missing or not paths:
        return {'schemaVersion': 1, 'passed': False, 'passRate': 0.0, 'checks': checks,
                'issues': [item for check in checks for item in check['issues']], 'files': []}
    texts = [path.read_text(encoding='utf-8-sig') for path in paths]
    inventories = [markdown_inventory(path) for path in paths]
    for language, text, inventory in zip(('zh', 'en'), texts, inventories):
        titles = '\n'.join(item['title'] for item in inventory['headings'])
        issues = []
        for section in contract['sections']:
            if not any(re.search(pattern, titles, re.I) for pattern in section['patterns'][language]):
                issues.append('Missing ' + section['id'] + ' section.')
        check('section-coverage-' + language, issues)
        narrative = '\n'.join(line for line in _outside_fences(text).splitlines()
                              if line.strip() and not re.match(r'^\s*(?:\||#|!\[|\\)', line))
        minimum = contract.get('minimumNarrativeCharacters', {}).get(language, 0)
        check('narrative-coverage-' + language,
              [] if len(narrative) >= minimum else [f'Explanatory prose is too sparse ({len(narrative)} < {minimum} characters); headings/tables alone are insufficient.'])
        assets, problems = _local_assets(text, root)
        check('local-assets-' + language, problems)
        image_targets = [item['target'] for item in inventory['images']]
        image_issues = []
        for role, patterns in contract['requiredImageRoles'].items():
            if not any(re.search(pattern, ' '.join(image_targets), re.I) for pattern in patterns):
                image_issues.append('Missing ' + role + ' image role.')
        check('image-coverage-' + language, image_issues)
        # Metadata may hold the product title, so identity checks include it.
        identity_issues = [] if not product_code or product_code in text[:6000] else ['Product identity is absent from the title/introduction.']
        check('product-identity-' + language, identity_issues)
        term_issues = ['Missing required source term: ' + term for term in facts.get('requiredTerms', []) if term not in text]
        term_issues += ['Forbidden unsupported claim: ' + term for term in facts.get('forbiddenClaims', []) if term in text]
        check('source-claims-' + language, term_issues)
        required_commands = facts.get('requiredCommands', contract.get('requiredCommands', []))
        if facts.get('boardSelectionCommand'):
            required_commands = list(required_commands) + [facts['boardSelectionCommand']]
        command_issues = ['Missing reproducible command: ' + command for command in required_commands
                          if command not in text]
        check('getting-started-commands-' + language, command_issues)
        expected, actual = _source_interfaces(facts), _pin_tables(text)
        pin_issues = []
        for ref, pins in expected.items():
            if actual.get(ref) != pins:
                pin_issues.append('Pin/net table differs from current source: ' + ref)
        check('source-pin-tables-' + language, pin_issues)
        # Pandoc PDF templates are optional; if retained, their referenced files must exist.
        template_issues = []
        for filename in re.findall(r'(?:page-background:\s*["\']([^"\']+)["\']|\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\})', text):
            target = next((item for item in filename if item), '')
            if target and not (root / target).is_file():
                template_issues.append('Missing optional PDF template resource: ' + target)
        check('portable-markdown-' + language, template_issues)
    check('bilingual-pin-consistency', [] if _pin_tables(texts[0]) == _pin_tables(texts[1]) else ['Chinese and English physical pin tables differ.'])
    # All source URLs and assets should remain usable in either language.
    source_links = [{_source_link_key(link) for link in re.findall(r'(?<!!)\[[^\]]*\]\((https?://[^)]+)\)', _outside_fences(text))} for text in texts]
    check('bilingual-source-links', [] if source_links[0] == source_links[1] else ['Chinese and English source URL sets differ; review equivalent localized links explicitly.'])
    passed = sum(item['passed'] for item in checks)
    return {'schemaVersion': 1, 'passed': passed == len(checks), 'passRate': round(passed / len(checks), 4),
            'checks': checks, 'issues': [issue for item in checks for issue in item['issues']],
            'files': [{'path': item['path'], 'sha256': item['sha256'], 'characters': item['characters']} for item in inventories],
            'scope': 'Deterministic structure, portability and source-bound pin checks; visual/prose learning evaluation is separate.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('bundle')
    parser.add_argument('--facts')
    parser.add_argument('--contract')
    parser.add_argument('--product-code')
    args = parser.parse_args()
    result = evaluate_guide_bundle(args.bundle, contract_path=args.contract, facts_path=args.facts, product_code=args.product_code)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(0 if result['passed'] else 1)
