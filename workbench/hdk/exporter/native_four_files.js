// LCEDA Pro async invoke body, used only in a newly owned headless copy.
// Large STEP files are saved to the caller's private directory, not base64
// encoded into the CLI JSON response (which is limited to 8 MiB).
const a = __CLI__.args;
const environment = async () => ({
  isClient: await eda.sys_Environment.isClient(),
  isOnlineMode: await eda.sys_Environment.isOnlineMode(),
  isHalfOfflineMode: await eda.sys_Environment.isHalfOfflineMode(),
  isOfflineMode: await eda.sys_Environment.isOfflineMode(),
});
if (a.action === 'environment') return await environment();
const openBound = async (uuid, type) => {
  const project = await eda.dmt_Project.getCurrentProjectInfo();
  if (a.expectedProjectUuid && project?.uuid !== a.expectedProjectUuid) throw new Error('当前工程不是本次隔离副本');
  const tab = await eda.dmt_EditorControl.openDocument(uuid);
  if (!tab || !await eda.dmt_EditorControl.activateDocument(tab)) throw new Error('无法打开/激活目标文档');
  const ready = await eda.dmt_EditorControl.waitForDocumentReady(tab, 1000);
  const deadline = Date.now() + 60000;
  do {
    const source = await eda.sys_FileManager.getDocumentSource();
    if (source && source.length > 200) {
      const heads = source.split(/\r?\n/).filter(x => x.startsWith('{"type":"DOCHEAD"')).map(x => JSON.parse(x.split('||')[1].replace(/\|$/, '')));
      if (heads.length === 1 && heads[0].uuid === uuid && heads[0].docType === type) return {source, dochead: heads[0], nativeReady: ready, tabId: tab};
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  throw new Error('目标文档没有可观测的匹配 DOCHEAD 数据');
};
if (a.action === 'import') {
  const current = await environment();
  if (current.isClient !== true || !(current.isHalfOfflineMode === true || current.isOfflineMode === true)) {
    throw new Error('environment: 本地工程导入仅支持客户端半离线或全离线模式；请先切换模式并按客户端提示重启后再运行，未创建云工程。');
  }
  const file = await eda.sys_FileSystem.readFileFromFileSystem(a.filePath);
  if (!file?.size) throw new Error('无法读取隔离副本文件');
  const project = await eda.sys_FileManager.importProjectByProjectFile(file, 'JLCEDA Pro', undefined,
    {operation: 'Offline Client Local Path', folderPath: a.folderPath});
  if (!project?.uuid) throw new Error('隔离导入没有返回新本地工程 UUID');
  return project;
}
if (a.action === 'inspect') {
  let pcbs = [], pages = [];
  const deadline = Date.now() + 60000;
  do {
    pcbs = await eda.dmt_Pcb.getAllPcbsInfo() || [];
    pages = await eda.dmt_Schematic.getAllSchematicPagesInfo() || [];
    if (pcbs.length && pages.length) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  const target = pcbs.find(p => p.uuid === a.expectedPcbUuid);
  if (!target) throw new Error('隔离副本不含输入 PCB UUID');
  const bound = await openBound(target.uuid, 'PCB');
  return {project: await eda.dmt_Project.getCurrentProjectInfo(), pcbs, pages, pcbNativeReady: bound.nativeReady};
}
if (a.action === 'image') {
  let stage = 'open';
  try {
  const bound = await openBound(a.documentUuid, 'PCB');
  const tab = bound.tabId;
  stage = 'native pad inventory';
  const components = await eda.pcb_PrimitiveComponent.getAll();
  const pads = [];
  for (const component of components) {
    const componentId = component.getState_PrimitiveId();
    for (const pad of await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(componentId)) {
      const world = {x: pad.getState_X(), y: pad.getState_Y()};
      pads.push({componentId, designator: component.getState_Designator(), parentComponentId: pad.getState_ParentComponentPrimitiveId(),
        primitiveId:pad.getState_PrimitiveId(), number:pad.getState_PadNumber(), net:pad.getState_Net(), layer:pad.getState_Layer(),
        ...world, canvas: await eda.pcb_Document.convertDataOriginToCanvasOrigin(world.x, world.y)});
    }
  }
  const finite = pads.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!finite.length) throw new Error('源板没有实际焊盘坐标');
  const requestedBounds = {left:Math.min(...finite.map(p=>p.x))-100,right:Math.max(...finite.map(p=>p.x))+100,
    top:Math.min(...finite.map(p=>p.y))-100,bottom:Math.max(...finite.map(p=>p.y))+100};
  stage = 'zoomToRegion';
  if (!await eda.dmt_EditorControl.zoomToRegion(requestedBounds.left,requestedBounds.right,requestedBounds.top,requestedBounds.bottom,tab)) throw new Error('无法缩放到源板明确区域');
  await new Promise(resolve => setTimeout(resolve, 500));
  // 4.1.78 headless zoomTo() throws while reading minX. Do not infer a
  // viewport from a requested region: establish the affine transform from
  // separately captured public indicator markers at actual pad coordinates.
  const bounds = requestedBounds;
  const capture = async path => {
    const image = await eda.dmt_EditorControl.getCurrentRenderedAreaImage(tab);
    if (!image?.size || !await eda.sys_FileSystem.saveFileToFileSystem(path, image)) throw new Error('原生 PCB PNG 保存失败');
    return {path, bytes: image.size, type: image.type};
  };
  stage = 'capture';
  const image = await capture(a.outputPath);
  const inside = p => Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= Math.min(bounds.left, bounds.right)
    && p.x <= Math.max(bounds.left, bounds.right) && p.y >= Math.min(bounds.top, bounds.bottom) && p.y <= Math.max(bounds.top, bounds.bottom);
  const rawCount = pads.filter(inside).length, canvasCount = pads.filter(p => inside(p.canvas)).length;
  const markerFrame = rawCount >= canvasCount ? 'data' : 'canvas';
  const visible = pads.filter(p => inside(markerFrame === 'data' ? p : p.canvas));
  if (visible.length < 3) throw new Error('原生视口中没有足够焊盘控制点');
  const first = visible.reduce((best, p) => p.x + p.y < best.x + best.y ? p : best);
  const second = visible.reduce((best, p) => (p.x-first.x)**2+(p.y-first.y)**2 > (best.x-first.x)**2+(best.y-first.y)**2 ? p : best);
  const cross = p => Math.abs((second.x-first.x)*(p.y-first.y)-(second.y-first.y)*(p.x-first.x));
  const third = visible.reduce((best, p) => cross(p) > cross(best) ? p : best);
  if (cross(third) < 1) throw new Error('焊盘控制点共线');
  const fourth = visible.filter(p=>![first,second,third].includes(p)).reduce((best,p)=>
    Math.min(...[first,second,third].map(q=>(p.x-q.x)**2+(p.y-q.y)**2)) > Math.min(...[first,second,third].map(q=>(best.x-q.x)**2+(best.y-q.y)**2)) ? p : best, visible[0]);
  const calibration = [];
  stage = 'marker calibration';
  try {
    for (const [index, point] of [first, second, third, fourth].entries()) {
      const marker = markerFrame === 'data' ? point : point.canvas;
      if (!await eda.dmt_EditorControl.generateIndicatorMarkers([{type:'point', x:marker.x, y:marker.y}], {r:17,g:251,b:181,alpha:1}, 3, false, tab)) throw new Error('无法添加临时校准标记');
      await new Promise(resolve => setTimeout(resolve, 150));
      calibration.push({point, marker, image: await capture(a.outputPath + '.control-' + index + '.png')});
      if (!await eda.dmt_EditorControl.removeIndicatorMarkers(tab)) throw new Error('无法移除临时校准标记');
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  } finally {
    await eda.dmt_EditorControl.removeIndicatorMarkers(tab);
  }
  await new Promise(resolve => setTimeout(resolve, 300));
  const finalImage = await capture(a.outputPath + '.after.png');
  return {image, finalImage, requestedBounds, viewportBoundsAvailable:false, markerFrame, rawCount, canvasCount, pads, calibration,
    dataOriginOnCanvas: await eda.pcb_Document.convertDataOriginToCanvasOrigin(0,0), dochead:bound.dochead,
    view:'top', projection:'orthographic PCB editor canvas', coordinateUnit:'mil', sourceCoordinates:'PCB data origin'};
  } catch (error) { throw new Error(stage + ': ' + String(error?.message || error)); }
}
if (a.action === 'source' || a.action === 'export') {
  const bound = await openBound(a.documentUuid, a.documentType);
  if (a.action === 'source') return {...bound, project: await eda.dmt_Project.getCurrentProjectInfo()};
  let file;
  if (a.kind === 'schematicPng') {
    if (a.documentType !== 'SCH_PAGE') throw new Error('原理图 PNG 导出目标类型错误');
    if (!a.pngSize || !Number.isFinite(a.pngSize.width) || !Number.isFinite(a.pngSize.height) || a.pngSize.unit !== 'mm') throw new Error('缺少明确的高分辨率原理图渲染尺寸');
    file = await eda.sch_ManufactureData.getExportDocumentFile(a.fileName, 'PNG', {theme:'Default',size:a.pngSize}, 'Current Schematic Page');
  } else if (a.kind === 'schematicPdf') {
    if (a.documentType !== 'SCH_PAGE') throw new Error('原理图导出目标类型错误');
    file = await eda.sch_ManufactureData.getExportDocumentFile(a.fileName, 'PDF', {theme: 'Default'}, 'All Schematic', {outputMethod: 'Merged sheet'});
  } else if (a.kind === 'step') {
    if (a.documentType !== 'PCB') throw new Error('STEP 导出目标类型错误');
    // Missing models are reported; never synthesize substitute component boxes.
    file = await eda.pcb_ManufactureData.get3DFile(a.fileName, 'step', ['Component Model'], 'Outfit', false);
  } else throw new Error('未开放的导出类型');
  if (!file?.size) throw new Error('原生导出没有返回非空 File');
  if (typeof a.outputPath !== 'string' || !a.outputPath.startsWith('/')) throw new Error('缺少私有绝对输出路径');
  if (!await eda.sys_FileSystem.saveFileToFileSystem(a.outputPath, file)) throw new Error('保存原生文件失败');
  return {file: {path: a.outputPath, name: file.name || '', type: file.type || '', bytes: file.size}, dochead: bound.dochead,
    nativeReady: bound.nativeReady, exportOptions: a.kind === 'step'
      ? {api: 'pcb_ManufactureData.get3DFile', fileType: 'step', element: ['Component Model'], modelMode: 'Outfit', autoGenerateModels: false}
      : a.kind === 'schematicPng'
        ? {api:'sch_ManufactureData.getExportDocumentFile',fileType:'PNG',object:'Current Schematic Page',theme:'Default',size:a.pngSize}
        : {api: 'sch_ManufactureData.getExportDocumentFile', fileType: 'PDF', object: 'All Schematic', outputMethod: 'Merged sheet'}};
}
throw new Error('未开放的执行动作');
