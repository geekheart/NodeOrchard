"""Source-bound HDK DAG capabilities. Each attempt writes one immutable receipt.

No global stage cursor or shared context mutation; parents are explicit ports.
The workflow is built by the user in the editor, never synthesized here.
"""
from pathlib import Path
import sys, json, os, hashlib, sqlite3, uuid, shutil, datetime
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from hdk.four_files_pipeline import validate_input, _process, _artifact, NODE, verify_files
PYTHON=Path.home()/'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3'
DATABASE=ROOT/'.local/workbench.sqlite'
class InvalidLearningPlan(ValueError):
    code='LEARNING_INVALID_PLAN'
def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def write(path,data):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    with path.open('x') as stream:json.dump(data,stream,ensure_ascii=False,indent=2)
def read(path):return json.loads(Path(path).read_text())
def row(table,ident):
    with sqlite3.connect('file:'+str(DATABASE)+'?mode=ro',uri=True) as db:
        value=db.execute('SELECT value FROM '+table+' WHERE id=?',(ident,)).fetchone()
    if not value:raise ValueError('缺少本次不可变运行记录。')
    return json.loads(value[0])
def bound(operation,value,context):
    run=row('workflow_runs',context['runId']);node=run['nodes'].get(context['nodeId'],{})
    definition=next(n for n in run['document']['nodes'] if n['id']==context['nodeId'])
    if (run['document']['schemaVersion']!=2 or run['workflowId']!=context.get('workflowId') or definition['config'].get('toolName')!=operation
            or node.get('status')!='running' or node.get('input')!=value or node.get('attemptId')!=context.get('attemptId') or node.get('attempt')!=context.get('attempt')):
        raise ValueError('能力不属于本次运行节点或输入快照。')
    files=row('workflow_file_runs',run['id']);root=Path(files['outputDirectory']).resolve()
    out=Path(context['outputDirectory']).resolve()
    expected=root/context['nodeId']/('版本-'+str(context['attempt']))
    if (not out.is_relative_to(root) or not out.is_dir() or context.get('runOutputDirectory')!=str(root)
            or out!=expected.resolve() or node.get('outputDirectory')!=str(out)):
        raise ValueError('能力产物目录不属于本次运行节点及尝试。')
    return run,root,out
RECEIPT_REF_FIELDS=frozenset(['kind','runId','nodeId','operation','receiptPath','receiptSha256','attempt','attemptId'])
def _resolve_receipt_ref(reference,run):
    """Resolve only a current registered-tool output, never caller-supplied data.

    The compact value is transport identity. The original producer output and
    immutable receipt file remain authoritative, including every source/proof.
    """
    strings=['runId','nodeId','operation','receiptPath','receiptSha256','attemptId']
    if (set(reference)!=RECEIPT_REF_FIELDS or reference.get('kind')!='hdk-node-receipt-ref'
            or any(not isinstance(reference.get(key),str) or not reference[key] for key in strings)
            or type(reference.get('attempt')) is not int or reference['attempt']<1
            or len(reference['receiptSha256'])!=64 or any(c not in '0123456789abcdef' for c in reference['receiptSha256'])
            or reference['runId']!=run['id']):
        raise ValueError('精简上游回执字段无效或不属于当前运行。')
    current=row('workflow_runs',run['id'])
    matches=[node for node in current.get('document',{}).get('nodes',[]) if node.get('id')==reference['nodeId']]
    definition=matches[0] if len(matches)==1 else {}
    config=definition.get('config',{})
    source=current.get('nodes',{}).get(reference['nodeId'],{})
    full=source.get('output')
    identity=['runId','nodeId','operation','receiptPath','receiptSha256']
    if (current.get('id')!=run['id'] or definition.get('type')!='tool'
            or not isinstance(config,dict) or config.get('executionMode')!='tool' or config.get('toolName')!=reference['operation']
            or source.get('status')!='complete' or source.get('attempt')!=reference['attempt']
            or source.get('attemptId')!=reference['attemptId']
            or not isinstance(full,dict) or full.get('kind')!='hdk-node-receipt'
            or any(full.get(key)!=reference[key] for key in identity)):
        raise ValueError('精简上游回执不是本次已完成内置能力的当前版本。')
    identifier=reference['nodeId']
    if identifier in ('.','..') or Path(identifier).name!=identifier:
        raise ValueError('精简上游回执节点标识无效。')
    root=Path(row('workflow_file_runs',run['id'])['outputDirectory']).resolve(strict=True)
    expected=root/identifier/('版本-'+str(reference['attempt']))
    path=Path(reference['receiptPath'])
    if (not path.is_absolute() or source.get('outputDirectory')!=str(expected)
            or reference['receiptPath']!=str(expected/'receipt.json')
            or not expected.is_dir() or expected.resolve(strict=True)!=expected
            or path.is_symlink() or not path.is_file() or path.resolve(strict=True)!=path
            or not path.is_relative_to(root)):
        raise ValueError('精简上游回执位置不属于来源节点当前版本目录。')
    return full
def load(receipt,run,operation=None):
    if isinstance(receipt,dict) and receipt.get('kind')=='hdk-node-receipt-ref':
        full=_resolve_receipt_ref(receipt,run)
        data=load(full,run,operation or receipt['operation'])
        if data.get('runId')!=run['id'] or _resolve_receipt_ref(receipt,run)!=full:
            raise ValueError('精简上游回执在读取期间已失效。')
        return data
    if not isinstance(receipt,dict) or receipt.get('kind')!='hdk-node-receipt' or receipt.get('runId')!=run['id']:
        raise ValueError('需要当前运行的真实上游回执。')
    root=Path(row('workflow_file_runs',run['id'])['outputDirectory']).resolve();path=Path(receipt['receiptPath']).resolve()
    if not path.is_relative_to(root) or sha(path)!=receipt['receiptSha256']:raise ValueError('上游回执位置或内容已变化。')
    current=row('workflow_runs',run['id']);source=current['nodes'].get(receipt['nodeId'],{})
    if source.get('status')!='complete' or source.get('output')!=receipt:raise ValueError('上游能力尚未完成或回执已过期。')
    data=read(path)
    if operation and data['operation']!=operation:raise ValueError('上游能力类型不符合当前端口。')
    for file in data.get('sourceFiles',[])+data.get('proofFiles',[]):
        if sha(file['path'])!=file['sha256']:raise ValueError('本次源资料或上游产物发生变化，请重新准备运行。')
    return data
def receipt(operation,data,run,out,artifacts=(),extra=None):
    path=out/'receipt.json';data={**data,'operation':operation,'runId':run['id']}
    if operation.startswith('hdk.four.pin') or operation=='hdk.four.verify':
        rules=Path(__file__).with_name('pinout_display_v2.py')
        evaluation_rules=Path(__file__).with_name('pinout_evaluation_v2.py')
        current_policy=Path(__file__).with_name('pinout_policy.py')
        data['displayContract']={'version':2,'aliasRule':'LDO_(VO<n>) may display as VO<n>; electrical net identity is unchanged',
            'namespacePolicy':'source-bound-primary-secondary-function-aliases','namespacePolicyVersion':3,
            'implementationPath':str(rules),'implementationSha256':sha(rules),
            'evaluationImplementationPath':str(evaluation_rules),'evaluationImplementationSha256':sha(evaluation_rules),
            'namespaceImplementationPath':str(current_policy),'namespaceImplementationSha256':sha(current_policy)}
    proofs={item['path']:item for item in data.get('proofFiles',[])}
    for item in artifacts:
        file=Path(item['path'])
        if item.get('sha256') and sha(file)!=item['sha256']:raise ValueError('产物与能力原始回执的SHA不一致。')
        proofs[str(file)]={'path':str(file),'sha256':sha(file)}
    def manifests(value):
        if isinstance(value,list):
            for child in value:manifests(child)
        elif isinstance(value,dict):
            for key,child in value.items():
                if key in ['reportPath','manifestPath','factsPath','projectPath'] and isinstance(child,str) and Path(child).is_file():
                    digest=sha(child)
                    if child in proofs and proofs[child]['sha256']!=digest:raise ValueError('上游证据在能力执行中发生变化。')
                    proofs[child]={'path':child,'sha256':digest}
                elif key!='proofFiles':manifests(child)
    manifests(data);data['proofFiles']=list(proofs.values());write(path,data)
    result={'kind':'hdk-node-receipt','runId':run['id'],'nodeId':os.environ['HDK_NODE_ID'],'operation':operation,
        'receiptPath':str(path),'receiptSha256':sha(path),'artifacts':list(artifacts)}
    if extra:result.update(extra)
    return result
def assets(items):
    result=[]
    for item in items:
        path=Path(item['path']);digest=sha(path)
        if item.get('sha256') and item['sha256']!=digest:raise ValueError('产物与转换器原始SHA回执不一致。')
        result.append({'path':str(path),'sha256':digest,'bytes':path.stat().st_size,'label':item.get('name',path.name),'role':item.get('kind','')})
    return result
def foreign_receipt(path,expected_operation,source_sha=None):
    """Import an explicitly selected, completed run; an old pass alone is insufficient."""
    path=Path(path).resolve(strict=True)
    header=read(path)
    if not isinstance(header,dict) or header.get('operation')!=expected_operation:
        raise ValueError('所选资料不是需要的能力回执。')
    parent=row('workflow_runs',header.get('runId',''))
    if parent.get('status')!='complete' or parent.get('learningId'):
        raise ValueError('仅可导入已完成的普通执行成果。')
    selected=[]
    for ident,node in parent.get('nodes',{}).items():
        token=node.get('output')
        if (isinstance(token,dict) and token.get('kind')=='hdk-node-receipt'
                and token.get('nodeId')==ident and token.get('operation')==expected_operation
                and str(Path(token.get('receiptPath','')).resolve())==str(path)):
            selected.append((ident,node,token))
    if len(selected)!=1:raise ValueError('导入回执未绑定唯一已完成的来源节点。')
    ident,node,token=selected[0]
    files=row('workflow_file_runs',parent['id'])
    root=Path(files['outputDirectory']).resolve(strict=True)
    expected=root/ident/('版本-'+str(node.get('attempt')))
    if (node.get('status')!='complete' or node.get('outputDirectory')!=str(expected)
            or path!=expected/'receipt.json' or not path.is_relative_to(root)):
        raise ValueError('导入回执不属于来源节点当前版本目录。')
    data=load(token,parent,expected_operation)
    if source_sha is not None and data.get('sourceSha256')!=source_sha:
        raise ValueError('导入成果与当前原始工程不一致。')
    # A partial rerun can supersede this version while the files are read.
    current=row('workflow_runs',parent['id'])
    if current.get('status')!='complete' or current.get('nodes',{}).get(ident,{}).get('output')!=token:
        raise ValueError('来源成果正在更新，请重新选择已完成版本。')
    return {**data,'importedReceipt':{'runId':parent['id'],'nodeId':ident,'attempt':node['attempt'],
        'receiptPath':str(path),'receiptSha256':sha(path)}}
def reviewed_artifacts(run,context,value,files,port='images'):
    """Require the current human decision to cover each actual consumed file."""
    if (not isinstance(files,list) or not 1<=len(files)<=64
            or len({str(Path(f['path']).resolve()) for f in files})!=len(files)):
        raise ValueError('人工审核需明确列出1–64个不同的实际产物。')
    edges=[e for e in run['document']['edges'] if e['targetNode']==context['nodeId'] and e['targetPort']==port]
    if len(edges)!=1:raise ValueError('此端口需要显式人工审核输出。')
    definition=next(n for n in run['document']['nodes'] if n['id']==edges[0]['sourceNode'])
    human=run['nodes'].get(definition['id'],{});review=human.get('review') or {}
    if (definition['type']!='human' or human.get('status')!='complete' or human.get('output')!=value
            or review.get('decision')!='approved'):
        raise ValueError('当前产物尚未通过本次人工审核。')
    approved={(a['id'],a['sha256']) for a in review.get('artifactHashes',[])}
    for file in files:
        if sha(file['path'])!=file['sha256']:raise ValueError('人工审核后的产物已发生变化。')
        selected=[a for a in human.get('artifacts',[]) if a['path']==file['path'] and a['sha256']==file['sha256']]
        if not selected or not any((a['id'],a['sha256']) in approved for a in selected):
            raise ValueError('人工批准内容不包含当前消费的实际产物。')
    return {'nodeId':definition['id'],'reviewedAt':review['reviewedAt'],'artifactHashes':review['artifactHashes']}
def reviewed_images(run,context,images,files):
    if len(files)!=2 or len({file['path'] for file in files})!=2 or any(not file['path'].lower().endswith('.png') for file in files):
        raise ValueError('人工审核必须覆盖当前正反面两张不同的PNG图片。')
    edge=[e for e in run['document']['edges'] if e['targetNode']==context['nodeId'] and e['targetPort']=='images']
    if len(edge)!=1:raise ValueError('四文件验收需要显式人工审核输出。')
    definition=next(n for n in run['document']['nodes'] if n['id']==edge[0]['sourceNode'])
    human=run['nodes'].get(definition['id'],{});review=human.get('review') or {}
    if definition['type']!='human' or human.get('status')!='complete' or human.get('output')!=images or review.get('decision')!='approved':
        raise ValueError('正反面图片尚未通过本次人工审核。')
    approved={(a['id'],a['sha256']) for a in review.get('artifactHashes',[])}
    for file in files:
        selected=[a for a in human.get('artifacts',[]) if a['path']==file['path'] and a['sha256']==file['sha256']]
        if not selected or not any((a['id'],a['sha256']) in approved for a in selected):raise ValueError('人工批准内容不包含本次正反面实际图片。')
    return {'nodeId':definition['id'],'reviewedAt':review['reviewedAt'],'artifactHashes':review['artifactHashes']}
def prepare(value):
    data=dict(value)
    if 'images' not in data:
        data['images']=[{'side':side,'path':data.pop(side+'Image'),'sha256':sha(value[side+'Image'])} for side in ['front','back']]
    request=validate_input(data)
    from hdk.four_files_native import core
    source=core.source_info(Path(request['sourcePath']))
    # Reject a mismatching photo profile before model or native conversion.
    profile=read(request['pinoutPhotoProfilePath'])
    if (profile.get('format')!='workbench-pinout-photo-calibration' or profile.get('version')!=1
            or profile.get('sourceSha256')!=source['sha256'] or profile.get('pcbUuid')!=source['pcb']['uuid']):
        raise ValueError('请准备与当前epro2匹配的已审核照片校准。')
    views=profile.get('views',[])
    if (len(views)!=2 or {v.get('side') for v in views}!={'front','back'}
            or {v.get('expectedDeterminantSign') for v in views}!={-1,1}):
        raise ValueError('照片校准必须包含已审核且翻面方向相反的正反两面。')
    from PIL import Image
    for view in views:
        image=next(i for i in request['images'] if i['side']==view['side'])
        with Image.open(image['path']) as photo:width,height=photo.size
        if (view.get('reviewStatus')!='visually-reviewed' or view.get('orientationReviewed') is not True
                or view.get('image')!={'sha256':image['sha256'],'width':width,'height':height}):
            raise ValueError('请准备对应实拍图且方向已审核的照片校准。')
    # Full calibration still uses native numbered-pad evidence in pin-facts.
    return {'request':request,'sourceSha256':source['sha256'],'sourceFiles':[{'path':p,'sha256':sha(p)} for p in [request['sourcePath'],request['pinoutPhotoProfilePath'],*[i['path'] for i in request['images']]]]}
def render_dag_photo_plan(request,views,native_path,output,plan):
    """Keep the historical converter intact; classify one bounded layout error."""
    from hdk.pinout_facts import validate_display_plan,prepare_photo_pinouts
    normalized=validate_display_plan(plan,read(views[0]['factsPath']))
    prepared=prepare_photo_pinouts({'sourcePath':request['sourcePath'],'images':request['images'],
        'photoProfilePath':request['pinoutPhotoProfilePath'],'nativeMetaPath':str(native_path),
        'outputDir':str(output/'.planned-pinout'),'productCode':request['productCode'],
        'hardwareVersion':'V'+request['hardwareVersion'].removeprefix('V'),'displayPlan':normalized})
    rendered=[]
    for view in prepared['views']:
        if view['side'] not in request['viewSides']:continue
        basename=request['productCode']+'_Pinout'+('_Back' if view['side']=='back' else '')+'_V'+request['hardwareVersion'].removeprefix('V')
        reply=_process([NODE,ROOT/'scripts/openpinmap-dag-convert.mjs','--project',view['projectPath'],
            '--output-dir',output,'--basename',basename],timeout=300)
        if reply.get('ok') is not True:
            error=reply.get('error','Pinout转换未完成。')
            if reply.get('code')=='PINOUT_LAYOUT_INVALID':raise InvalidLearningPlan(error)
            raise ValueError(error)
        rendered.append(dict(reply['output'],side=view['side'],factsPath=view['factsPath']))
    return {'displayPlan':normalized,'prepared':prepared,'views':rendered}
def four(operation,value,context):
    run,root,out=bound(operation,value,context);os.environ['HDK_NODE_ID']=context['nodeId']
    if operation=='hdk.four.prepare':return receipt(operation,prepare(value),run,out)
    if operation=='hdk.four.native':
        data=load(value,run,'hdk.four.prepare');request=data['request']
        from hdk.four_files_native import export_native
        native=export_native({k:request[k] for k in ['sourcePath','productCode','hardwareVersion','releaseDate']}|{'outputParent':str(out)},execute=True)
        if native.get('status')!='complete' or native['source']['sha256']!=data['sourceSha256']:raise ValueError('原生导出未通过：'+str(native.get('errors')))
        files=[x for x in native['artifacts'] if x['kind'] in ['schematicPdf','step']]
        return receipt(operation,{**data,'native':native,'files':files},run,out,assets(files))
    if operation in ['hdk.four.cad','hdk.four.pin-facts']:
        data=load(value,run,'hdk.four.native');request=data['request'];native=data['native']
        if operation.endswith('.cad'):
            step=next(x for x in data['files'] if x['kind']=='step')
            if sha(step['path'])!=step['sha256']:raise ValueError('原生STEP已变化。')
            cad=_process([NODE,ROOT/'scripts/openstep2dwg-convert.mjs','--input',step['path'],'--output-dir',out,'--basename',request['productCode']+'_CAD_V'+request['hardwareVersion'],
                '--title',request['productCode'],'--drawing-number',request['productCode']+'_CAD','--revision','V'+request['hardwareVersion'],'--date',request['releaseDate'],
                '--rotation',str(request.get('cadRotation',0)),'--layout',request.get('cadLayout','inspection'),'--detail',request.get('cadDetail','full'),'--timeout-ms','1200000'],timeout=1500)
            return receipt(operation,{**data,'cad':cad},run,out,assets(cad['artifacts']))
        from hdk.pinout_facts import prepare_photo_pinouts
        from hdk.pinout_pipeline import prepare_plan_input
        prepared=prepare_photo_pinouts({'sourcePath':request['sourcePath'],'images':request['images'],'photoProfilePath':request['pinoutPhotoProfilePath'],
            'nativeMetaPath':native['reportPath'],'outputDir':str(out/'facts'),'productCode':request['productCode'],'hardwareVersion':request['hardwareVersion']})
        if prepared.get('status')!='ready' or not prepared.get('validated'):raise ValueError('照片校准未通过。')
        archive=out/'sources';archive.mkdir();photo_archives=[]
        for image in request['images']:
            target=archive/(image['side']+'-original'+Path(image['path']).suffix.lower())
            shutil.copyfile(image['path'],target)
            photo_archives.append(dict(_artifact(target,'photoOriginal',root),side=image['side']))
        target=archive/'pinout-photo-calibration.json';shutil.copyfile(request['pinoutPhotoProfilePath'],target)
        photo_archives.append(_artifact(target,'photoCalibration',root))
        skill_input=prepare_plan_input(prepared['views'],request)
        return receipt(operation,{**data,'prepared':prepared,'photoArchives':photo_archives,'skillInput':skill_input},run,out,assets(photo_archives),extra={'skillInput':skill_input})
    if operation in ['hdk.four.pinout-front','hdk.four.pinout-back']:
        data=load(value['facts'],run,'hdk.four.pin-facts');plan=value['plan'];side=operation.rsplit('-',1)[1]
        edges=[e for e in run['document']['edges'] if e['targetNode']==context['nodeId'] and e['targetPort']=='plan']
        source=next(n for n in run['document']['nodes'] if n['id']==edges[0]['sourceNode']) if len(edges)==1 else {}
        record=run['nodes'].get(source.get('id'),{})
        if source.get('type')!='skill' or record.get('output')!=plan or record.get('input')!=data['skillInput']:raise ValueError('图片计划必须来自本次真实Skill及针脚事实。')
        # Only the bounded AI display choices are recoverable learning errors.
        # Source, calibration, converter and filesystem failures remain hard.
        from hdk.pinout_facts import validate_display_plan, PinoutBlocked
        facts=read(data['prepared']['views'][0]['factsPath'])
        try:validate_display_plan(plan,facts)
        except PinoutBlocked as error:raise InvalidLearningPlan(str(error)) from error
        rendered=render_dag_photo_plan(dict(data['request'],viewSides=[side]),data['prepared']['views'],data['native']['reportPath'],out,plan)
        view=rendered['views'][0]
        from hdk.pinout_policy import evaluate_pinout_views
        from hdk.pinout_pipeline import CONTRACT
        evaluation=evaluate_pinout_views([view],reference_contract=CONTRACT)
        write(out/'图片检查.json',evaluation)
        # A real candidate is still shown for human review when style metrics fail.
        # Electrical provenance and renderer validation remain hard failures.
        result={**data,'rendered':rendered,'evaluation':evaluation,'skill':{'ref':source['config']['skillRef'],'version':source['config']['version']}}
        return receipt(operation,result,run,out,assets(view['artifacts']),{'qualitySummary':evaluation['qualitySummary'],'learningComparison':evaluation['learningComparison']})
    if operation=='hdk.four.verify':
        native_data=load(value['native'],run,'hdk.four.native');cad_data=load(value['cad'],run,'hdk.four.cad')
        images=value.get('images',value)
        front=load(images['front'],run,'hdk.four.pinout-front');back=load(images['back'],run,'hdk.four.pinout-back')
        # Both reviewed branches retain the same source and selected Skill plan.
        if len({x['sourceSha256'] for x in [native_data,cad_data,front,back]})!=1 or front['skill']!=back['skill'] or front['rendered']['displayPlan']!=back['rendered']['displayPlan']:
            raise ValueError('四文件分支来源或Skill计划不一致。')
        from hdk.pinout_policy import evaluate_pinout_views
        from hdk.pinout_pipeline import CONTRACT
        views=front['rendered']['views']+back['rendered']['views'];evaluation=evaluate_pinout_views(views,reference_contract=CONTRACT)
        learning=bool(context.get('learningId'))
        if not evaluation['passed'] and not learning:
            failures=[row['id'] for row in evaluation['checks'] if not row['passed']]
            raise ValueError('Pinout图片检查未通过，不能完成交付：'+','.join(failures))
        image_files=assets([a for v in views for a in v['artifacts'] if a['path']==v['pngPath']])
        review_evidence=reviewed_images(run,context,images,image_files)
        front_view=front['rendered']['views'][0]
        facts_view=next(v for v in front['rendered']['prepared']['views'] if v['side']=='front')
        dwg=next(a for a in cad_data['cad']['artifacts'] if a['path'].endswith('.dwg'))
        engineering_files=[_artifact(a['path'],a['kind'],root) for a in native_data['files']]
        engineering_files.extend([_artifact(front_view['pngPath'],'pinout',root),_artifact(dwg['path'],'cad',root)])
        # Reuse the established source/geometry/font/photo-pixel/renderer checks
        # with this run's immutable branch artifacts, never inherit an old pass.
        engineering=verify_files({'runId':run['id'],'outputPath':str(root),'sourceSha256':native_data['sourceSha256'],
            'request':native_data['request'],'files':engineering_files,'native':native_data['native'],'cad':cad_data['cad'],
            'pinout':front_view,'pinFacts':dict(facts_view,status='ready',validated=True),'pinoutViews':views,
            'photoArchives':front['photoArchives'],'photoSources':native_data['sourceFiles'],
            'supplementaryFiles':[_artifact(back['rendered']['views'][0]['pngPath'],'pinoutBack',root)]})
        files=assets(native_data['files']+cad_data['cad']['artifacts']+[a for v in views for a in v['artifacts']])
        for file in ([] if learning else files):
            target=out/Path(file['path']).name
            if target.exists() and sha(target)!=file['sha256']:raise ValueError('最终交付文件重名。')
            if not target.exists():shutil.copyfile(file['path'],target)
            if sha(target)!=file['sha256'] or sha(file['path'])!=file['sha256']:raise ValueError('交付副本与本次已核验的源产物不一致。')
        result={'status':'learning-candidate' if learning else 'complete','runId':run['id'],'sourceSha256':native_data['sourceSha256'],'outputPath':str(out),'skill':front['skill'],
            'qualitySummary':evaluation['qualitySummary'],'checks':{**engineering['checks'],'branchesSameSource':True,'sourceUnchanged':sha(native_data['request']['sourcePath'])==native_data['sourceSha256'],
                'cadFreshConversion':cad_data['cad']['verification']['freshConversion'],'cadIndependentGeometry':cad_data['cad']['verification']['independentGeometryPassed'],
                'pinoutActualImagesPassed':evaluation['passed'],'humanApprovedCurrentImages':True},'physicalTestStatus':'not-run',
            'humanReview':review_evidence,'namespacePolicy':evaluation['namespacePolicy'],
            'legacyNamespacePassed':evaluation['legacyReference']['qualitySummary']['checks']['multi-chip-disambiguation'],
            'stepMetadataWarnings':engineering['stepMetadataWarnings'],'schRendering':engineering['schRendering'],
            'limitations':engineering['limitations'],'pinoutViews':engineering['pinoutViews']}
        hard_checks={k:v for k,v in result['checks'].items() if k!='pinoutActualImagesPassed' or not learning}
        if not all(hard_checks.values()):raise ValueError('四文件验收失败：'+','.join(k for k,v in hard_checks.items() if not v))
        write(out/('学习候选检查.json' if learning else '四文件验收.json'),result)
        return receipt(operation,result,run,out,assets([{'path':str(p)} for p in sorted(out.iterdir()) if p.is_file()]),
            extra={'status':result['status'],'qualitySummary':evaluation['qualitySummary'],'learningComparison':evaluation['learningComparison']})
    raise ValueError('未知四文件能力。')
def main():
    global DATABASE
    request=json.load(sys.stdin);operation=request['operation'];context=request['context']
    if context.get('databasePath'):DATABASE=Path(context['databasePath']).resolve(strict=True)
    from hdk.pinout_display_v2 import display_v2_scope
    with display_v2_scope():
        if operation.startswith('hdk.four.'):output=four(operation,request['input'],context)
        elif operation=='hdk.guide.package':
            from hdk.guide_package import package
            output=package(request['input'],context,sys.modules[__name__])
        elif operation.startswith('hdk.guide.'):
            from hdk.guide_dag import guide
            output=guide(operation,request['input'],context,sys.modules[__name__])
        elif operation=='hdk.full.sop':
            from hdk.full_sop_runtime import full
            output=full(operation,request['input'],context,sys.modules[__name__])
        elif operation in ('hdk.full.assemble','hdk.full.verify-delivery','hdk.full.archive-delivery'):
            from hdk.full_delivery import full
            output=full(operation,request['input'],context,sys.modules[__name__])
        elif operation.startswith('hdk.full.'):
            from hdk.full_dag import full
            output=full(operation,request['input'],context,sys.modules[__name__])
        elif operation.startswith('hdk.pinout.'):
            from hdk.pinout_dag import pinout
            output=pinout(operation,request['input'],context,sys.modules[__name__])
        else:raise ValueError('未知板卡能力。')
    sys.stdout.write(json.dumps({'ok':True,'output':output},ensure_ascii=False))
if __name__=='__main__':
    try:main()
    except Exception as error:
        print(json.dumps({'ok':False,'error':str(error),'code':getattr(error,'code',None)},ensure_ascii=False));sys.exit(1)
