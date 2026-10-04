import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { validateOfferId, safeText } from '../offers/validation.js';

export const safetyError = (code = 'unsafe_record', status = 503) => Object.assign(new Error('AI実行を停止しました。記録を変更せず、人間が状態を確認してください。'), { code, status });
export function exact(v, keys) {
  if (!v || Object.getPrototypeOf(v) !== Object.prototype || Object.keys(v).sort().join() !== [...keys].sort().join()) throw safetyError();
}
export const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
export const digest = v => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
export const bytesHash = v => createHash('sha256').update(v).digest('hex');
export const validHash = h => { if (typeof h !== 'string' || !/^[a-f0-9]{64}$/.test(h)) throw safetyError(); };
export const id = v => { try { return validateOfferId(v); } catch { throw safetyError('invalid_id', 400); } };
export const timestamp = v => { if (typeof v !== 'string' || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) throw safetyError(); };
export const natural = v => { if (!Number.isSafeInteger(v) || v < 0) throw safetyError(); };
export function rejectSecrets(value) {
  try {
    if (typeof value === 'string') {
      safeText(value);
      if (/\btoken['"]?\s*[=:：]\s*\S+/iu.test(value.normalize('NFKC'))) throw safetyError();
    } else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
      if (/^(?:api[_ -]?key|password|passwd|cookie|set-cookie|token|authorization|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|session(?:id|_id)?)$/i.test(key.normalize('NFKC'))) throw safetyError();
      rejectSecrets(child);
    }
  } catch { throw safetyError('secret_rejected', 400); }
}
export function privateText(v) { if (typeof v !== 'string' || v.length > 200 || !v.trim()) throw safetyError(); try { safeText(v); } catch { throw safetyError(); } }
export async function regular(fileSystem, file, directory = false) {
  const s = await fileSystem.lstat(file);
  if (s.isSymbolicLink() || !(directory ? s.isDirectory() : s.isFile())) throw safetyError();
  return s;
}
export async function readJson(fileSystem, file) {
  if ((await regular(fileSystem, file)).size > 64 * 1024 * 1024) throw safetyError();
  return JSON.parse(await fileSystem.readFile(file, 'utf8'));
}
// A successful return acknowledges file and directory fsync. Any uncertain save forbids sending.
export async function durableWrite(fileSystem, file, value, immutable = false) {
  rejectSecrets(value);
  const raw = JSON.stringify(value, null, 2) + '\n';
  if (Buffer.byteLength(raw) > 64 * 1024 * 1024) throw safetyError('storage_limit');
  const dir = path.dirname(file); await fileSystem.mkdir(dir, { recursive: true, mode: 0o700 }); await regular(fileSystem, dir, true);
  const temp = path.join(dir, `${randomUUID()}.tmp`); const intent = path.join(dir, '.write-intent'); let handle;
  const syncDir = async folder => { const d = await fileSystem.open(folder, 'r'); try { await d.sync(); } finally { await d.close(); } };
  try {
    // Never hide an uncertain replacement behind a successful read after restart.
    const marker = await fileSystem.open(intent, 'wx', 0o600);
    try { await marker.writeFile(JSON.stringify({ version: 1, file: path.basename(file), hash: digest(value) })); await marker.sync(); } finally { await marker.close(); }
    await syncDir(dir); await syncDir(path.dirname(dir));
    handle = await fileSystem.open(temp, 'wx', 0o600);
    await handle.writeFile(raw); await handle.sync(); await handle.close(); handle = null;
    if (immutable) { await fileSystem.link(temp, file); await fileSystem.unlink(temp); }
    else await fileSystem.rename(temp, file);
    await syncDir(dir);
    const saved = await readJson(fileSystem, file);
    if (digest(saved) !== digest(value)) throw safetyError();
    await fileSystem.unlink(intent); await syncDir(dir);
  } catch { throw safetyError('persistence_uncertain'); }
  finally { if (handle) await handle.close().catch(() => {}); /* preserve incomplete files for inspection */ }
}
export function directoryLock(root, name, fileSystem = fs) {
  let pending = Promise.resolve();
  return callback => {
    const task = pending.catch(() => {}).then(async () => {
      const dir = path.join(root, name); await fileSystem.mkdir(dir, { recursive: true, mode: 0o700 }); await regular(fileSystem, dir, true);
      const lock = path.join(dir, '.lock');
      try { await fileSystem.mkdir(lock, { mode: 0o700 }); } catch { throw safetyError('lock_busy', 409); }
      try { return await callback(); } finally { await fileSystem.rmdir(lock); }
    }); pending = task; return task;
  };
}
