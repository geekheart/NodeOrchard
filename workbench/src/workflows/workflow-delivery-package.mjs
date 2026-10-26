import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const fail = message => Object.assign(new Error(message), { httpStatus: 409 });
const SHA = /^[a-f0-9]{64}$/;
const idOf = artifact => artifact.artifactId || artifact.id;
const inside = (root, path) => { const part = relative(root, path); return part && !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep); };
const memberPath = path => typeof path === 'string' && path && !path.includes('\\') && !path.includes('\0')
  && !isAbsolute(path) && !/^[A-Za-z]:/.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..');

/** Expand only a declared package backed by a current registered manifest. */
export async function expandDeliveryPackages(run, artifacts, readArtifact) {
  if (artifacts === null) return null;
  const selected = new Map(artifacts.map(item => [item.path, { ...item }]));
  for (const definition of run.document.nodes.filter(node => node.type === 'output')) {
    const state = run.nodes[definition.id], value = state?.output;
    if (state?.status !== 'complete' || !value || typeof value !== 'object' || !Object.hasOwn(value, 'packagePath')) continue;
    const root = value.packagePath;
    if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root || !inside(run.outputDirectory, root)) {
      throw fail('输出节点的 packagePath 必须位于本次运行的当前生产目录内，已停止发布。');
    }
    const declared = [...(Array.isArray(value.artifacts) ? value.artifacts : []), ...(Array.isArray(value.files) ? value.files : [])];
    const manifests = artifacts.filter(item => item.role === 'package-manifest' && dirname(item.path) === root
      && declared.some(row => row?.path === item.path || (row?.artifactId && row.artifactId === idOf(item))));
    if (manifests.length !== 1) throw fail('packagePath 缺少唯一、显式登记的 package-manifest 产物；请补齐包清单后重试保存副本。');
    const manifest = manifests[0], producer = run.nodes[manifest.nodeId];
    if (!producer || producer.status !== 'complete' || producer.attempt !== manifest.attempt
      || (root !== producer.outputDirectory && !inside(producer.outputDirectory, root))) {
      throw fail('交付包清单不属于生产节点当前已完成版本，已停止发布。');
    }
    const { record, data } = await readArtifact(idOf(manifest));
    if (['runId', 'nodeId', 'attempt', 'path', 'sha256', 'size'].some(key => record[key] !== manifest[key])) throw fail('交付包清单的登记版本发生变化，已停止发布。');
    let document;
    try { document = JSON.parse(data.toString('utf8')); } catch { throw fail('交付包清单不是有效 JSON，已停止发布。'); }
    if (document.schemaVersion !== 1 || !Array.isArray(document.files) || document.files.length > 50000) {
      throw fail('交付包清单版本或文件列表无效，最多允许 50000 个明确文件。');
    }
    const members = new Set();
    selected.set(manifest.path, { ...selected.get(manifest.path), packageRoot: root });
    for (const file of document.files) {
      const sha256 = file && Object.hasOwn(file, 'deliveredSha256') ? file.deliveredSha256 : file?.sha256;
      if (!memberPath(file?.path) || !SHA.test(sha256 || '') || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 512 * 1024 * 1024) {
        throw fail('交付包清单包含无效相对路径、SHA 或文件大小，已停止发布。');
      }
      if (members.has(file.path)) throw fail('交付包清单包含重复文件路径，已停止发布。');
      members.add(file.path);
      // Source provenance can refer to external originals. It is never a copy
      // location: only this producer's package root plus the relative member is.
      const path = join(root, ...file.path.split('/'));
      if (!inside(root, path) || !inside(producer.outputDirectory, path)) throw fail('交付包成员越过包目录，已停止发布。');
      const previous = selected.get(path);
      if (previous && (previous.sha256 !== sha256 || previous.size !== file.bytes)) throw fail('交付包成员与显式登记产物的 SHA 或大小不一致，已停止发布。');
      selected.set(path, { ...(previous || {}), runId: run.id, nodeId: manifest.nodeId, attempt: manifest.attempt,
        path, sha256, size: file.bytes, manifestArtifactId: idOf(manifest), manifestSha256: manifest.sha256, packageEntry: file.path });
      selected.get(path).packageRoot = root;
    }
    const closure = document.localLinkClosure;
    if (closure !== undefined) {
      if (!closure || !Array.isArray(closure.entrypoints) || !Array.isArray(closure.documents) || !Array.isArray(closure.links)) throw fail('交付包本地引用清单无效，已停止发布。');
      for (const path of [...closure.entrypoints, ...closure.documents]) {
        if (!memberPath(path) || !members.has(path)) throw fail('交付包缺少本地文档入口：' + String(path).slice(0, 200));
      }
      for (const link of closure.links) {
        if (!memberPath(link?.document) || !members.has(link.document) || !memberPath(link?.target) || !members.has(link.target)) {
          throw fail('交付包本地引用目标未包含在成员清单中，已停止发布。');
        }
      }
    }
  }
  return [...selected.values()].sort((a, b) => a.path.localeCompare(b.path));
}
