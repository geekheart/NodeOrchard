"""Standalone, current-run Pinout delivery over the shared DAG image branches.

This verifier consumes an explicit human-approved front/back bundle. It neither
imports an old pipeline pass nor claims SCH, STEP, CAD or physical-test success.
"""
from pathlib import Path
import os
import shutil
from hdk.pinout_policy import evaluate_pinout_views as _evaluate_pinout_views


# Learning may retain a genuine picture with presentation defects. Electrical
# identity, photograph provenance and actual exported geometry remain hard gates.
PRESENTATION_CHECKS = frozenset({
    'transparent-portrait', 'concise-main-labels', 'reference-palette',
    'compact-readable-capsules',
})


def _proofs(api, *groups):
    files = {}
    for group in groups:
        for item in group:
            path = str(Path(item['path']).resolve())
            digest = api.sha(path)
            if digest != item['sha256'] or path in files and files[path]['sha256'] != digest:
                raise ValueError('Pinout 来源或产物证据发生变化。')
            files[path] = {'path': path, 'sha256': digest}
    return list(files.values())


def pinout(operation, value, context, api):
    """Run hdk.pinout.verify through the same bound/load/receipt API as four.*."""
    if operation != 'hdk.pinout.verify':
        raise ValueError('未知独立 Pinout 能力。')
    run, root, out = api.bound(operation, value, context)
    os.environ['HDK_NODE_ID'] = context['nodeId']
    if context.get('learningId') != run.get('learningId'):
        raise ValueError('Pinout 学习上下文与本次运行不一致。')
    if not isinstance(value, dict) or set(value) != {'images'}:
        raise ValueError('Pinout 验收需要 images 端口的本次人工审核输出。')
    images = value['images']
    if not isinstance(images, dict) or set(images) != {'front', 'back'}:
        raise ValueError('人工审核输出必须明确包含 front 和 back 两面回执。')
    front = api.load(images['front'], run, 'hdk.four.pinout-front')
    back = api.load(images['back'], run, 'hdk.four.pinout-back')
    if (not front.get('sourceSha256') or front['sourceSha256'] != back.get('sourceSha256')
            or not front.get('skill') or front['skill'] != back.get('skill')
            or front.get('request') != back.get('request')
            or front['rendered']['displayPlan'] != back['rendered']['displayPlan']):
        raise ValueError('Pinout 正反面来源、发布资料或 Skill 排版计划不一致。')
    views = []
    for side, data in [('front', front), ('back', back)]:
        selected = data['rendered']['views']
        if len(selected) != 1 or selected[0].get('side') != side:
            raise ValueError('Pinout 正反面端口必须各绑定一张对应面的真实出图。')
        views.extend(selected)
    if api.sha(front['request']['sourcePath']) != front['sourceSha256']:
        raise ValueError('本次原始工程已变化。')
    # Re-read real photo pixels, calibration, native pin geometry, source maps,
    # converter manifests and all original export hashes. No CAD state is needed.
    from hdk.four_files_pipeline import verify_photo_pinouts, _artifact
    verified_views = verify_photo_pinouts({
        'outputPath': str(root), 'request': front['request'],
        'sourceSha256': front['sourceSha256'], 'pinoutViews': views,
        'photoArchives': front['photoArchives'],
        'supplementaryFiles': [_artifact(views[1]['pngPath'], 'pinoutBack', root)],
    })
    from hdk.pinout_pipeline import CONTRACT
    evaluation = _evaluate_pinout_views(views, reference_contract=CONTRACT)
    checks = evaluation['qualitySummary']['checks']
    hard_failures = [name for name, passed in checks.items() if not passed and name not in PRESENTATION_CHECKS]
    if hard_failures:
        raise ValueError('Pinout 来源或实际导出几何验收失败：' + ','.join(hard_failures))
    learning = bool(context.get('learningId'))
    if not evaluation['passed'] and not learning:
        raise ValueError('Pinout 实际图片样式检查未通过，不能完成执行交付。')
    image_files = api.assets([
        artifact for view in views for artifact in view['artifacts']
        if artifact['path'] == view['pngPath']
    ])
    if (len(image_files) != 2 or len({item['path'] for item in image_files}) != 2
            or any(Path(item['path']).suffix.lower() != '.png' for item in image_files)):
        raise ValueError('Pinout 人工审核必须覆盖当前正反面两张不同的 PNG。')
    human_review = api.reviewed_artifacts(run, context, images, image_files, port='images')
    source_files = _proofs(api, front.get('sourceFiles', []), back.get('sourceFiles', []))
    upstream_proofs = _proofs(api, front.get('proofFiles', []), back.get('proofFiles', []), [
        {'path': token['receiptPath'], 'sha256': token['receiptSha256']} for token in images.values()
    ])
    files, copied = [], {}
    for view in views:
        selected = [view['pngPath'], view['svgPath'], view['projectPath']]
        for path in selected:
            original = next((item for item in view['artifacts'] if item['path'] == path), None)
            if original is None:
                raise ValueError('Pinout PNG、SVG 或可编辑工程缺少本次实际导出记录。')
            artifact = api.assets([original])[0]
            target = out / Path(path).name
            if target in copied and copied[target] != path:
                raise ValueError('Pinout 两面的交付文件名冲突，请分别命名后重试。')
            copied[target] = path
            if target.exists() and api.sha(target) != artifact['sha256']:
                raise ValueError('Pinout 交付文件同名但内容不同。')
            if not target.exists():
                shutil.copyfile(path, target)
            if api.sha(target) != artifact['sha256'] or api.sha(path) != artifact['sha256']:
                raise ValueError('Pinout 交付副本与本次已审核来源不一致。')
            files.append({**artifact, 'path': str(target), 'sourcePath': path})
    result = {
        'status': 'learning-candidate' if learning else 'complete',
        'passed': evaluation['passed'], 'runId': run['id'],
        'sourceSha256': front['sourceSha256'], 'sourceFiles': source_files,
        'proofFiles': upstream_proofs, 'parents': images, 'outputPath': str(out),
        'skill': front['skill'], 'displayPlan': front['rendered']['displayPlan'],
        'displayContract': front.get('displayContract'), 'files': files,
        'pinoutViews': verified_views, 'humanReview': human_review,
        'qualitySummary': evaluation['qualitySummary'],
        'learningComparison': evaluation['learningComparison'],
        'namespacePolicy': evaluation['namespacePolicy'],
        'checks': {'branchesSameSource': True, 'sourceUnchanged': True,
                   'actualPhotoGeometryVerified': True, 'humanApprovedCurrentImages': True,
                   'pinoutActualImagesPassed': evaluation['passed']},
        'physicalTestStatus': 'not-run', 'limitations': evaluation.get('limitations', []),
    }
    api.write(out / 'Pinout图片检查.json', evaluation)
    api.write(out / ('Pinout学习候选检查.json' if learning else 'Pinout验收.json'), result)
    return api.receipt(operation, result, run, out,
        api.assets([{'path': str(path)} for path in sorted(out.iterdir()) if path.is_file()]),
        extra={'status': result['status'], 'qualitySummary': evaluation['qualitySummary'],
               'learningComparison': evaluation['learningComparison']})
