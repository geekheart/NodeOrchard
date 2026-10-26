// LCEDA Pro invoke async body. Only publicly documented read/export APIs are used.
const a = __CLI__.args;
const environment = async () => ({
  isClient: await eda.sys_Environment.isClient(),
  isOnlineMode: await eda.sys_Environment.isOnlineMode(),
  isHalfOfflineMode: await eda.sys_Environment.isHalfOfflineMode(),
  isOfflineMode: await eda.sys_Environment.isOfflineMode(),
});
if (a.action === 'environment') return await environment();
const encode = async (blob) => {
  if (!blob || !blob.size) throw new Error('原生导出没有返回非空 File');
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({name: blob.name || '', type: blob.type, bytes: blob.size, base64: String(reader.result).split(',')[1]});
    reader.onerror = () => reject(new Error('读取原生导出 File 失败'));
    reader.readAsDataURL(blob);
  });
};
const openBound = async (uuid, type) => {
  const tab = await eda.dmt_EditorControl.openDocument(uuid);
  if (!tab || !await eda.dmt_EditorControl.activateDocument(tab)) throw new Error('无法打开/激活目标文档');
  // 4.1.78 reports notLoaded for this local headless file even when its exact
  // source and all primitives are available. Ask the documented wait API,
  // then require observable DOCHEAD data; never equate false with empty data.
  const ready = await eda.dmt_EditorControl.waitForDocumentReady(tab, 1000);
  const deadline = Date.now() + 60000;
  do {
    const source = await eda.sys_FileManager.getDocumentSource();
    if (source && source.length > 200) {
      const heads = source.split(/\r?\n/).filter(x => x.startsWith('{"type":"DOCHEAD"')).map(x => JSON.parse(x.split('||')[1].replace(/\|$/, '')));
      if (heads.length === 1 && heads[0].uuid === uuid && heads[0].docType === type) return {source, dochead: heads[0], nativeReady: ready};
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
  // The session is newly owned and empty; import creates a new disk project.
  const file = await eda.sys_FileSystem.readFileFromFileSystem(a.filePath);
  if (!file?.size) throw new Error('无法读取隔离副本文件');
  const project = await eda.sys_FileManager.importProjectByProjectFile(file, 'JLCEDA Pro', undefined,
    {operation: 'Offline Client Local Path', folderPath: a.folderPath});
  if (!project?.uuid) throw new Error('隔离导入没有返回新本地工程 UUID');
  return project;
}
if (a.action === 'inspect') {
  // This build keeps ProjectReadyState at notLoaded on the start page even
  // after the project tree is loaded. Open the exact source PCB first.
  let pcbs = [], pages = [];
  const deadline = Date.now() + 60000;
  do {
    pcbs = await eda.dmt_Pcb.getAllPcbsInfo() || [];
    pages = await eda.dmt_Schematic.getAllSchematicPagesInfo() || [];
    if (pcbs.length && pages.length) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  const target = pcbs.find(p => p.uuid === a.expectedPcbUuid);
  if (!target) throw new Error('新本地工程不含输入 PCB UUID');
  const bound = await openBound(target.uuid, 'PCB');
  return {
    project: await eda.dmt_Project.getCurrentProjectInfo(),
    pcbs, pages,
    projectReadyState: await eda.dmt_Project.getReadyState(),
    pcbNativeReady: bound.nativeReady,
  };
}
if (a.action === 'source' || a.action === 'export') {
  const bound = await openBound(a.documentUuid, a.documentType);
  const source = bound.source;
  if (a.action === 'source') {
    const result = {...bound, project: await eda.dmt_Project.getCurrentProjectInfo()};
    if (a.documentType === 'PCB') {
      const components = await eda.pcb_PrimitiveComponent.getAll();
      result.components = components.map(c => ({id: c.getState_PrimitiveId(), designator: c.getState_Designator(), name: c.getState_Name(), layer: c.getState_Layer(), device: c.getState_Component(), otherProperty: c.getState_OtherProperty(), nameProperties: {'Manufacturer Part': c.getState_ManufacturerId(), 'Supplier Part': c.getState_SupplierId()}}));
      result.layers = await eda.pcb_Layer.getAllLayers();
      result.canvasOrigin = await eda.pcb_Document.getCanvasOrigin();
      result.dataOriginOnCanvas = await eda.pcb_Document.convertDataOriginToCanvasOrigin(0, 0);
      // Public getAllPinsByPrimitiveId() example documents these three getters.
      // Keep owner and actual PCB coordinates as independent DXF references.
      result.componentPads = [];
      for (const c of components) {
        const id = c.getState_PrimitiveId();
        const pads = await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(id);
        result.componentPads.push({componentId: id, designator: c.getState_Designator(), pads: pads.map(p => ({parentComponentId: p.getState_ParentComponentPrimitiveId(), x: p.getState_X(), y: p.getState_Y()}))});
      }
      result.copperLayers = await eda.pcb_Layer.getTheNumberOfCopperLayers();
    }
    return result;
  }
  let file;
  switch (a.kind) {
    case 'project': file = await eda.sys_FileManager.getProjectFile(a.fileName, undefined, 'epro2'); break;
    case 'schematicPdf': file = await eda.sch_ManufactureData.getExportDocumentFile(a.fileName, 'PDF', {theme: 'Default'}, 'All Schematic', {outputMethod: 'Merged sheet'}); break;
    // Keep native material grouping. This build's custom columns/group option
    // returns undefined; the fixed Python adapter restores the 5 extra case
    // columns from this same input archive and native component getters.
    case 'bom': file = await eda.sch_ManufactureData.getBomFile(a.fileName, 'xlsx'); break;
    case 'gerber': file = await eda.pcb_ManufactureData.getGerberFile(a.fileName); break;
    case 'pickPlace': file = await eda.pcb_ManufactureData.getPickAndPlaceFile(a.fileName, 'xlsx', 'mm'); break;
    case 'silkscreenPdf': file = await eda.pcb_ManufactureData.getPdfFile(a.fileName, 'paged', {displayAttributesAsMenu: true, showOutlineOnly: true}, {show: false}, [
      {checked: true, name: '顶面自动位号图'}, {checked: true, name: '底面自动位号图'},
      {checked: false, name: 'BOM'}, {checked: false, name: '装配图顶层'}, {checked: false, name: '装配图底层'}, {checked: false, name: '钻孔图'}]); break;
    // Optional layers/objects are deliberately omitted: the native defaults
    // retain switchable outline, component/pad, hole and silkscreen references
    // like the example HDK. A BoardOutline object filter excludes valid older
    // POLY outlines. Python verifies the outline layer separately from parts.
    case 'outlineDxf': file = await eda.pcb_ManufactureData.getDxfFile(a.fileName); break;
    default: throw new Error('未开放的导出类型');
  }
  return {file: await encode(file), dochead: bound.dochead, nativeReady: bound.nativeReady,
    ...(a.kind === 'outlineDxf' ? {exportOptions: {api: 'pcb_ManufactureData.getDxfFile(fileName)', layers: 'native defaults', objects: 'native defaults'}} : {})};
}
throw new Error('未开放的执行动作');
