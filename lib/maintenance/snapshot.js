import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const directories = ['offer-import-commits', 'offer-imports', 'offers']; // Manifest v1 is immutable.
export const aiDirectories = ['ai-budget', 'generations', 'extraction-executions', 'extraction-artifacts'];
export const directoriesV2 = [...aiDirectories, ...directories]; // Global lock order; skip unneeded intermediate locks.
export const limits = { files: 10000, fileBytes: 64 * 1024 * 1024, totalBytes: 256 * 1024 * 1024 };
export const hash = data => createHash('sha256').update(data).digest('hex');
export const maintenanceError = (status = 503) => Object.assign(new Error(status === 409
  ? '更新中または状態の変化を検出しました。処理を停止しました。再読込してください。'
  : status === 400 ? '管理操作の入力が不正です。'
    : '安全に検証できません。処理を停止しました。元データを変更せず人間が確認してください。'), { status });
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
export const allowedPath = name => typeof name === 'string' && new RegExp(`^(?:offers|offer-imports)/${uuid}\\.json$|^offer-import-commits/(?:ledger\\.json|initialized)$`).test(name);
export const allowedPathV2 = name => allowedPath(name) || /^(?:ai-budget\/(?:activation\.json|initialized|real-approval\.json|real-approval-anchor\.json)|(?:generations|extraction-executions)\/(?:ledger\.json|initialized)|extraction-artifacts\/[a-f0-9-]{36}\.json)$/.test(name);
async function scope(root, fileSystem) {
  for (const dir of aiDirectories) { try { await fileSystem.lstat(path.join(root, dir)); return directoriesV2; } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  return directories;
}
export const snapshotHash = snapshot => hash(JSON.stringify({ directories: snapshot.directories,
  files: Object.entries(snapshot.files).sort(([a], [b]) => a.localeCompare(b)).map(([name, bytes]) => ({ path: name, size: bytes.length, sha256: hash(bytes) })) }));

export async function regular(fileSystem, filename, directory = false) {
  const stat = await fileSystem.lstat(filename);
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile())) throw maintenanceError();
  return stat;
}

// Only allowlisted stores are inspected. No environment files, arbitrary root files or temp contents.
async function collect(root, fileSystem, ownedLocks, selected) {
  const result = { directories: [], files: {}, notes: [] }; let total = 0;
  for (const dir of selected) {
    const folder = path.join(root, dir); let names;
    try { await regular(fileSystem, folder, true); names = (await fileSystem.readdir(folder)).sort(); }
    catch (e) { if (e.code === 'ENOENT') { result.directories.push({ path: dir, present: false }); continue; } throw e; }
    result.directories.push({ path: dir, present: true });
    for (const name of names) {
      if (name === '.lock') { if (!ownedLocks.has(dir)) throw maintenanceError(409); continue; }
      const relative = `${dir}/${name}`;
      if (!(selected === directoriesV2 ? allowedPathV2 : allowedPath)(relative)) {
        result.notes.push({ status: 'human_review_required', code: 'unrecognized_file', message: '未完了ファイルまたは未知のファイルがあります。内容は取得せず、人間確認が必要です。' }); continue;
      }
      const filename = path.join(folder, name);
      const stat = await regular(fileSystem, filename);
      if (stat.size > limits.fileBytes || total + stat.size > limits.totalBytes || Object.keys(result.files).length >= limits.files) throw maintenanceError();
      const bytes = await fileSystem.readFile(filename);
      if (bytes.length !== stat.size) throw maintenanceError(409);
      await regular(fileSystem, filename); // Reject a replaced link as well as initial links.
      total += bytes.length; result.files[relative] = bytes;
    }
  }
  return result;
}

// Double capture provides a read-only, conservative check. Cooperative writers/locks stop inspection.
export async function capture(root, { fileSystem = fs, ownedLocks = new Set() } = {}) {
  try {
    await regular(fileSystem, root, true).catch(e => { if (e.code !== 'ENOENT') throw e; });
    const first = await collect(root, fileSystem, ownedLocks, await scope(root, fileSystem));
    const second = await collect(root, fileSystem, ownedLocks, await scope(root, fileSystem));
    if (snapshotHash(first) !== snapshotHash(second) || JSON.stringify(first.notes) !== JSON.stringify(second.notes)) throw maintenanceError(409);
    return second;
  } catch (e) { throw maintenanceError(e.status === 409 ? 409 : 503); }
}

// Backup holds all existing store locks, using the same order as Step 4. Missing stores are not created.
export async function withStoreLocks(root, callback, fileSystem = fs) {
  const owned = new Set();
  try {
    await regular(fileSystem, root, true).catch(e => { if (e.code !== 'ENOENT') throw e; });
    for (const dir of await scope(root, fileSystem)) {
      const folder = path.join(root, dir);
      try { await regular(fileSystem, folder, true); }
      catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      try { await fileSystem.mkdir(path.join(folder, '.lock'), { mode: 0o700 }); }
      catch (e) { throw maintenanceError(e.code === 'EEXIST' ? 409 : 503); }
      owned.add(dir);
    }
    const snapshot = await capture(root, { fileSystem, ownedLocks: owned });
    // A writer created a previously missing directory while locks were acquired. Stop, never guess.
    if (snapshot.directories.some(d => d.present && !owned.has(d.path))) throw maintenanceError(409);
    return await callback(snapshot);
  } finally {
    for (const dir of [...owned].reverse()) {
      try { await fileSystem.rmdir(path.join(root, dir, '.lock')); }
      catch { throw maintenanceError(); }
    }
  }
}

export function memoryFileSystem(snapshot) {
  const name = filename => path.relative('/snapshot', filename).split(path.sep).join('/');
  const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
  return {
    async lstat(filename) {
      const p = name(filename); const directory = snapshot.directories.some(d => d.path === p && d.present);
      if (!directory && !Object.hasOwn(snapshot.files, p)) throw missing();
      return { isDirectory: () => directory, isFile: () => !directory, isSymbolicLink: () => false };
    },
    async readFile(filename, encoding) {
      const bytes = snapshot.files[name(filename)]; if (!bytes) throw missing();
      return encoding ? bytes.toString(encoding) : bytes;
    },
  };
}
