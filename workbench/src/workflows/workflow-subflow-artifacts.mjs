import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { selectDeliveryArtifacts } from './workflow-delivery.mjs';

const fail = message => Object.assign(new Error(message), { httpStatus: 409 });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const idOf = artifact => artifact.artifactId || artifact.id;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const binding = artifacts => JSON.stringify(artifacts.map(item => [idOf(item), item.runId, item.nodeId, item.attempt, item.path,
  item.sha256, item.size, item.manifestArtifactId, item.manifestSha256, item.packageEntry]));
async function exists(path) { try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }

function mappedValue(value, paths, artifacts) {
  if (typeof value === 'string') return paths.get(value) || artifacts.get(value)?.artifactId || value;
  if (Array.isArray(value)) return value.map(item => mappedValue(item, paths, artifacts));
  if (!value || typeof value !== 'object') return value;
  const result = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, mappedValue(child, paths, artifacts)]));
  const mapped = artifacts.get(value.artifactId || value.id) || (typeof value.path === 'string' && artifacts.get(value.path));
  if (mapped) {
    // Rewrite only an exact registered file reference. Receipt/run provenance and
    // unrelated strings remain untouched, and copied files retain original bytes.
    for (const key of ['id', 'artifactId', 'runId', 'nodeId', 'attempt', 'path', 'sha256', 'size', 'mimeType', 'previewUrl', 'downloadUrl']) {
      if (Object.hasOwn(value, key)) result[key] = mapped[key];
    }
  }
  return result;
}

/** Copy a completed child's explicitly exposed files into this parent attempt. */
export async function stageSubflowArtifacts(files, { parent, nodeId, child, isCurrent = () => true, saveProgress = () => {} }) {
  const record = parent.nodes[nodeId], attempt = record?.attempt, attemptId = record?.attemptId;
  const assertCurrent = () => {
    if (!isCurrent() || parent.nodes[nodeId] !== record || record.attempt !== attempt || record.attemptId !== attemptId
      || child.parentRunId !== parent.id || child.status !== 'complete'
      || record.subflowProgress?.childRunId !== child.id || !record.subflowProgress?.childRunIds?.includes(child.id)) {
      throw fail('子流程归集与父节点当前运行版本不一致，已停止复制。');
    }
  };
  assertCurrent();
  if (!UUID.test(child.id || '') || !UUID.test(parent.id || '') || typeof attemptId !== 'string' || !attemptId
    || !Number.isSafeInteger(attempt) || attempt < 1 || files.run(parent.id).outputDirectory !== parent.outputDirectory
    || files.run(child.id).outputDirectory !== child.outputDirectory
    || record.outputDirectory !== join(parent.outputDirectory, nodeId, '版本-' + attempt)
    || await files.nodeDirectory({ runId: parent.id, nodeId, attempt }) !== record.outputDirectory) {
    throw fail('子流程归集目录不属于父节点当前版本，已停止复制。');
  }
  const direct = selectDeliveryArtifacts(child, id => files.getArtifact(id));
  const selected = await files.deliveryArtifacts(child.id);
  if (!selected) throw fail('子流程缺少可核验的当前输出，不能归集到父运行。');
  const originalBinding = binding(direct || []), expandedBinding = binding(selected);
  const assertChildCurrent = () => {
    assertCurrent();
    const current = files.app.workflows.get(child.id);
    if (current.parentRunId !== parent.id || current.status !== 'complete'
      || binding(selectDeliveryArtifacts(current, id => files.getArtifact(id)) || []) !== originalBinding) {
      throw fail('子流程当前输出在归集期间发生变化，已停止复制。');
    }
  };
  assertChildCurrent();
  const root = record.outputDirectory;
  if (await realpath(root) !== root) throw fail('子流程归集目录位置已变化，已停止复制。');
  const paths = new Map(), mapping = new Map(), artifacts = [], sources = [];
  const packageReservations = new Map();
  for (const source of selected.filter(item => item.packageRoot)) {
    if (packageReservations.has(source.packageRoot)) continue;
    const manifest = selected.find(item => item.role === 'package-manifest' && dirname(item.path) === source.packageRoot);
    if (!manifest) throw fail('子流程交付包缺少当前清单，已停止复制。');
    const targetRoot = join(root, 'children', child.id, relative(child.outputDirectory, source.packageRoot));
    const expected = { path: targetRoot, sourceRoot: source.packageRoot, sourceRunId: child.id,
      sourceManifestArtifactId: idOf(manifest), sourceManifestSha256: manifest.sha256,
      parentAttempt: attempt, parentAttemptId: attemptId };
    const previous = (record.stagedChildPackages || []).filter(item => item.path === targetRoot);
    if (previous.length > 1 || (previous.length && Object.keys(expected).some(key => previous[0][key] !== expected[key]))) {
      throw fail('子流程交付包目录已绑定其它来源或版本，未覆盖已有文件。');
    }
    let reservation = previous[0];
    if (!reservation) {
      if (await exists(targetRoot)) throw fail('子流程交付包目标已存在且未经登记，未覆盖已有目录。');
      reservation = { ...expected, status: 'reserved' };
      (record.stagedChildPackages ||= []).push(reservation); saveProgress();
    }
    packageReservations.set(source.packageRoot, reservation); paths.set(source.packageRoot, targetRoot);
  }
  for (const source of selected) {
    assertChildCurrent();
    const { data } = await files.readDeliveryArtifact(source);
    const target = join(root, 'children', child.id, relative(child.outputDirectory, source.path));
    await mkdir(dirname(target), { recursive: true });
    if (await realpath(dirname(target)) !== dirname(target)) throw fail('子流程归集目录存在符号链接，已停止复制。');
    assertChildCurrent();
    const expected = { path: target, sha256: source.sha256, bytes: source.size,
      sourceArtifactId: idOf(source), sourceRunId: source.runId, sourceNodeId: source.nodeId,
      sourceAttempt: source.attempt, sourcePath: source.path, parentAttempt: attempt, parentAttemptId: attemptId };
    const manifestMember = !idOf(source) && source.manifestArtifactId;
    const existing = manifestMember ? [] : (record.stagedChildArtifacts || []).filter(item => item.path === target);
    if (existing.length > 1 || (existing.length && Object.keys(expected).some(key => existing[0][key] !== expected[key]))) {
      throw fail('子流程归集路径已绑定其它来源或版本，未覆盖已有文件。');
    }
    let reservation = manifestMember ? { ...expected, status: 'reserved' } : existing[0];
    if (reservation && !['reserved', 'complete'].includes(reservation.status)) throw fail('子流程归集的保存状态无效，未覆盖已有文件。');
    if (!reservation) {
      if (await exists(target)) throw fail('子流程归集目标已有未经登记的文件，未覆盖；请核验后重跑父节点。');
      reservation = { ...expected, status: 'reserved' };
      (record.stagedChildArtifacts ||= []).push(reservation);
      saveProgress(); // Persist the exact source binding before the first copy.
    }
    const existingFile = await exists(target);
    if (existingFile) {
      if (!existingFile.isFile() || existingFile.isSymbolicLink() || await realpath(target) !== target) throw fail('子流程归集目标存在符号链接或非常规文件，未覆盖。');
    } else {
      if (reservation.status === 'complete') throw fail('已登记的子流程归集文件缺失，请核验后重跑父节点。');
      await copyFile(source.path, target, constants.COPYFILE_EXCL);
    }
    const copied = await readFile(target);
    await files.readDeliveryArtifact(source); // Detect a source changed during copy.
    if (copied.length !== source.size || data.length !== source.size || hash(copied) !== source.sha256) {
      throw fail('子流程归集前后 SHA 不一致，未传给下游。');
    }
    assertChildCurrent();
    paths.set(source.path, target);
    if (manifestMember) continue; // The current registered package manifest is its authority.
    let artifact;
    if (reservation.status === 'complete') {
      artifact = files.getArtifact(reservation.artifactId);
      const recorded = (record.childArtifacts || []).find(item => idOf(item) === reservation.artifactId);
      if (!recorded || ['runId', 'nodeId', 'attempt', 'path', 'sha256', 'size'].some(key => recorded[key] !== artifact[key])
        || artifact.runId !== parent.id || artifact.nodeId !== nodeId || artifact.attempt !== attempt || artifact.path !== target) {
        throw fail('已登记的子流程归集版本不一致，未覆盖已有文件。');
      }
      await files.readArtifact(reservation.artifactId);
    } else {
      artifact = await files.registerArtifact({ runId: parent.id, nodeId, attempt, path: target,
        label: source.label, role: source.role, kind: source.kind });
    }
    if (artifact.runId !== parent.id || artifact.nodeId !== nodeId || artifact.attempt !== attempt || artifact.path !== target
      || artifact.sha256 !== source.sha256 || artifact.size !== source.size || await realpath(target) !== target) {
      throw fail('子流程归集文件在登记时发生变化，未传给下游。');
    }
    assertChildCurrent();
    if (!(record.childArtifacts || []).some(item => idOf(item) === idOf(artifact))) (record.childArtifacts ||= []).push(artifact);
    Object.assign(reservation, { artifactId: idOf(artifact), status: 'complete' }); saveProgress();
    artifacts.push(artifact); paths.set(source.path, artifact.path);
    mapping.set(idOf(source), artifact); mapping.set(source.path, artifact);
    sources.push({ ...reservation });
  }
  assertChildCurrent();
  if (binding(await files.deliveryArtifacts(child.id)) !== expandedBinding) throw fail('子流程交付包清单在归集期间发生变化，未传给下游。');
  for (const reservation of packageReservations.values()) reservation.status = 'complete';
  if (packageReservations.size) saveProgress();
  return { output: mappedValue(child.output, paths, mapping), artifacts, sources };
}
