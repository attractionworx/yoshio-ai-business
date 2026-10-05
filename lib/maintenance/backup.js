import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validateOfferId } from '../offers/validation.js';
import { directories, directoriesV2, limits, hash, snapshotHash, allowedPath, allowedPathV2, regular, withStoreLocks, maintenanceError } from './snapshot.js';
import { inspectSnapshot, integrityCheck } from './integrity.js';

const contracts = { offer: 1, import: 1, commit: 1 };
const contractsV2 = { ...contracts, generation: 1, extractionExecution: 1, extractionArtifact: 1, budgetActivation: 1, budgetPolicy: 1 };
const contractsV2Real = { ...contractsV2, realBudgetApproval: 1 };
const exact = (v, keys) => {
  if (!v || Object.getPrototypeOf(v) !== Object.prototype || Object.keys(v).sort().join() !== [...keys].sort().join()) throw maintenanceError();
};
function id(value) { try { return validateOfferId(value); } catch { throw maintenanceError(400); } }
function validateManifest(m, backupId) {
  exact(m, ['schemaVersion', 'kind', 'id', 'createdAt', 'contracts', 'directories', 'files', 'totalBytes', 'snapshotHash', 'integrityStatus']);
  const selected = m.schemaVersion === 2 ? directoriesV2 : directories;
  const expectedContracts = m.schemaVersion === 2 ? (Object.hasOwn(m.contracts || {}, 'realBudgetApproval') ? contractsV2Real : contractsV2) : contracts;
  if (![1, 2].includes(m.schemaVersion) || m.kind !== 'offer-operations-backup' || m.id !== backupId || !isDeepStrictEqual(m.contracts, expectedContracts)
    || typeof m.createdAt !== 'string' || !Number.isFinite(Date.parse(m.createdAt)) || new Date(m.createdAt).toISOString() !== m.createdAt
    || !['normal', 'warning', 'error', 'human_review_required'].includes(m.integrityStatus)
    || !/^[a-f0-9]{64}$/.test(m.snapshotHash) || !Number.isSafeInteger(m.totalBytes) || m.totalBytes < 0 || m.totalBytes > limits.totalBytes
    || !Array.isArray(m.directories) || m.directories.length !== selected.length || !Array.isArray(m.files) || m.files.length > limits.files) throw maintenanceError();
  for (const [i, d] of m.directories.entries()) {
    exact(d, ['path', 'present']); if (d.path !== selected[i] || typeof d.present !== 'boolean') throw maintenanceError();
  }
  const seen = new Set(); let bytes = 0;
  for (const f of m.files) {
    exact(f, ['path', 'size', 'sha256']);
    if (!(m.schemaVersion === 2 ? allowedPathV2 : allowedPath)(f.path) || seen.has(f.path) || !Number.isSafeInteger(f.size) || f.size < 0 || f.size > limits.fileBytes
      || !/^[a-f0-9]{64}$/.test(f.sha256) || !m.directories.find(d => d.path === f.path.split('/')[0])?.present) throw maintenanceError();
    seen.add(f.path); bytes += f.size;
  }
  if (!m.contracts.realBudgetApproval && m.files.some(f => /^ai-budget\/real-approval/.test(f.path))) throw maintenanceError();
  if (bytes !== m.totalBytes) throw maintenanceError();
  return m;
}

// Only immutable backups are written. There is deliberately no restoration method.
export function createMaintenanceService(root, { fileSystem = fs, now = () => new Date() } = {}) {
  const folder = path.join(root, 'maintenance-backups');
  async function readBackup(backupId) {
    id(backupId); const archive = path.join(folder, backupId);
    await regular(fileSystem, folder, true); await regular(fileSystem, archive, true);
    if ((await fileSystem.readdir(archive)).sort().join() !== 'manifest.json,manifest.sha256,payload') throw maintenanceError();
    const manifestFile = path.join(archive, 'manifest.json');
    if ((await regular(fileSystem, manifestFile)).size > 4 * 1024 * 1024) throw maintenanceError();
    if ((await regular(fileSystem, path.join(archive, 'manifest.sha256'))).size !== 65) throw maintenanceError();
    const raw = await fileSystem.readFile(manifestFile);
    if (await fileSystem.readFile(path.join(archive, 'manifest.sha256'), 'utf8') !== `${hash(raw)}\n`) throw maintenanceError();
    const manifest = validateManifest(JSON.parse(raw.toString('utf8')), backupId);
    const payload = path.join(archive, 'payload'); await regular(fileSystem, payload, true);
    const expectedDirs = manifest.directories.filter(d => d.present).map(d => d.path).sort();
    if (!isDeepStrictEqual((await fileSystem.readdir(payload)).sort(), expectedDirs)) throw maintenanceError();
    for (const d of expectedDirs) {
      const dir = path.join(payload, d); await regular(fileSystem, dir, true);
      const expectedFiles = manifest.files.filter(f => f.path.startsWith(d + '/')).map(f => f.path.slice(d.length + 1)).sort();
      if (!isDeepStrictEqual((await fileSystem.readdir(dir)).sort(), expectedFiles)) throw maintenanceError();
    }
    const snapshot = { directories: manifest.directories, files: {}, notes: [] };
    for (const f of manifest.files) {
      const filename = path.join(payload, f.path);
      if ((await regular(fileSystem, filename)).size !== f.size) throw maintenanceError();
      const bytes = await fileSystem.readFile(filename);
      if (bytes.length !== f.size || hash(bytes) !== f.sha256) throw maintenanceError();
      snapshot.files[f.path] = bytes;
    }
    if (snapshotHash(snapshot) !== manifest.snapshotHash) throw maintenanceError();
    const report = await inspectSnapshot(snapshot);
    if (report.status !== manifest.integrityStatus) throw maintenanceError();
    return { manifest, report };
  }
  async function create() {
    // Backup metadata is a separate namespace; no existing record is overwritten.
    await regular(fileSystem, root, true).catch(e => { if (e.code !== 'ENOENT') throw e; });
    await fileSystem.mkdir(folder, { recursive: true, mode: 0o700 }); await regular(fileSystem, folder, true);
    const lock = path.join(folder, '.lock');
    try { await fileSystem.mkdir(lock, { mode: 0o700 }); } catch (e) { throw maintenanceError(e.code === 'EEXIST' ? 409 : 503); }
    try {
      return await withStoreLocks(root, async snapshot => {
        // Unknown/temp files cannot silently be excluded from a complete backup.
        if (snapshot.notes.length) throw maintenanceError();
        const report = await inspectSnapshot(snapshot);
        // Never persist unvalidated/corrupt records (including detected secret-bearing data).
        // A valid unresolved intent can still be preserved, explicitly marked as requiring review.
        if (report.status === 'error') throw maintenanceError();
        const backupId = randomUUID(); const stage = path.join(folder, `.incomplete-${backupId}`);
        const destination = path.join(folder, backupId);
        await fileSystem.mkdir(stage, { mode: 0o700 });
        const payload = path.join(stage, 'payload'); await fileSystem.mkdir(payload, { mode: 0o700 });
        for (const d of snapshot.directories.filter(d => d.present)) await fileSystem.mkdir(path.join(payload, d.path), { mode: 0o700 });
        const files = [];
        for (const [name, bytes] of Object.entries(snapshot.files).sort(([a], [b]) => a.localeCompare(b))) {
          const filename = path.join(payload, name);
          await fileSystem.writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
          if (hash(await fileSystem.readFile(filename)) !== hash(bytes)) throw maintenanceError();
          files.push({ path: name, size: bytes.length, sha256: hash(bytes) });
        }
        const version = snapshot.directories.length === directoriesV2.length ? 2 : 1;
        const manifest = { schemaVersion: version, kind: 'offer-operations-backup', id: backupId, createdAt: now().toISOString(), contracts: version === 2 ? contractsV2Real : contracts,
          directories: snapshot.directories, files, totalBytes: report.metrics.bytes, snapshotHash: snapshotHash(snapshot), integrityStatus: report.status };
        validateManifest(manifest, backupId);
        const raw = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
        await fileSystem.writeFile(path.join(stage, 'manifest.json'), raw, { flag: 'wx', mode: 0o600 });
        await fileSystem.writeFile(path.join(stage, 'manifest.sha256'), `${hash(raw)}\n`, { flag: 'wx', mode: 0o600 });
        if (!isDeepStrictEqual(await fileSystem.readFile(path.join(stage, 'manifest.json')), raw)
          || await fileSystem.readFile(path.join(stage, 'manifest.sha256'), 'utf8') !== `${hash(raw)}\n`) throw maintenanceError();
        // Check directories absent at the capture point have not appeared while writing.
        for (const d of snapshot.directories.filter(d => !d.present)) {
          try { await fileSystem.lstat(path.join(root, d.path)); throw maintenanceError(409); }
          catch (e) { if (e.code !== 'ENOENT') throw e; }
        }
        try { await fileSystem.lstat(destination); throw maintenanceError(409); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        await fileSystem.rename(stage, destination);
        return { manifest, report };
      }, fileSystem);
    } catch (e) { throw maintenanceError(e.status === 409 ? 409 : 503); }
    finally { try { await fileSystem.rmdir(lock); } catch { throw maintenanceError(); } }
  }
  async function list() {
    let names;
    try { await regular(fileSystem, folder, true); names = await fileSystem.readdir(folder); }
    catch (e) { if (e.code === 'ENOENT') return { backups: [], incomplete: 0 }; throw maintenanceError(); }
    let incomplete = 0; const backups = [];
    for (const name of names.sort()) {
      if (name === '.lock') { incomplete++; continue; }
      try { id(name); } catch { incomplete++; continue; }
      // Listing is intentionally inexpensive. Validation occurs only on explicit dry-run.
      try { await regular(fileSystem, path.join(folder, name), true); backups.push({ id: name }); }
      catch { backups.push({ id: name, invalid: true }); }
    }
    return { backups, incomplete };
  }
  async function dryRun(backupId) {
    id(backupId);
    try {
      const { manifest, report } = await readBackup(backupId);
      const current = await integrityCheck(root, { fileSystem });
      const stale = current.snapshotHash !== null && current.snapshotHash !== manifest.snapshotHash;
      const warnings = [];
      if (current.snapshotHash === null) warnings.push({ status: 'warning', code: 'current_unreadable', message: '現在のデータを完全に取得できず、バックアップとの一致を判定できません。停止して確認してください。' });
      if (stale) warnings.push({ status: 'warning', code: 'different_current_data', message: 'バックアップと現在のデータが異なります。古いバックアップの可能性があります。復元は行いません。' });
      if (Date.parse(manifest.createdAt) > now().getTime()) warnings.push({ status: 'warning', code: 'future_backup', message: 'バックアップの日時が現在より未来です。時計・バックアップを確認してください。' });
      if (manifest.schemaVersion === 1) warnings.push({ status: 'info', code: 'legacy_ai_coverage', message: '旧範囲のバックアップとして検証しました。新しいAI実行・共通予算情報は含まず、予算有効化済みとは判断しません。' });
      if (!manifest.contracts.realBudgetApproval) warnings.push({ status: 'info', code: 'legacy_real_approval_coverage', message: 'この旧バックアップは限定real承認記録の保全対象を含みません。追加承認済みとは判断しません。' });
      return { schemaVersion: 1, backupId, backupValid: report.status !== 'error', restored: false, manifest,
        status: report.status === 'normal' && !current.stopped && !warnings.some(w => w.status === 'warning') ? 'normal' : report.status === 'normal' ? 'warning' : report.status,
        aiCoverage: manifest.schemaVersion === 2 ? 'complete' : 'legacy_only', commonBudgetActive: manifest.schemaVersion === 2 && Boolean(report.commonBudgetActive),
        realBudgetApprovalCoverage: manifest.contracts.realBudgetApproval === 1 ? 'covered' : 'not_covered',
        realBudgetApprovalStatus: manifest.contracts.realBudgetApproval === 1 ? report.realBudgetApprovalStatus : 'not_covered',
        stopped: report.stopped || current.stopped || warnings.some(w => w.status === 'warning'), report, current, warnings };
    } catch {
      return { schemaVersion: 1, backupId, backupValid: false, restored: false, status: 'error', stopped: true,
        warnings: [], report: { issues: [{ status: 'error', code: 'backup_invalid', message: 'manifest・hash・version・必要ファイル・履歴を検証できません。停止して人間が確認してください。' }] } };
    }
  }
  return { create, list, dryRun, integrity: () => integrityCheck(root, { fileSystem }) };
}
