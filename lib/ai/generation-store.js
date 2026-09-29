import { validateAffiliateContext } from './affiliate-context.js';
import { mkdir, readFile, writeFile, rename, rmdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { invalid } from '../content.js';

// 一つの台帳を原子的に保存。ロックは別プロセスとの同時予約も拒否します。
export function createGenerationStore(dataDirectory) {
  const directory = path.join(dataDirectory, 'generations');
  const file = path.join(directory, 'ledger.json');
  const lock = path.join(directory, '.lock');
  let pending = Promise.resolve();
  async function read() {
    try {
      const value = JSON.parse(await readFile(file, 'utf8'));
      const states = ['running', 'unknown', 'failed', 'save-failed', 'succeeded', 'validated'];
      if (value.schemaVersion !== 1 || !Array.isArray(value.runs) || value.runs.some(r =>
        !/^[a-f0-9-]{36}$/.test(r.id) || !states.includes(r.state) || !/^\d{4}-\d{2}$/.test(r.month)
        || !r || !/^[a-f0-9-]{36}$/.test(r.planId) || !(['fake', 'openai'].includes(r.provider)) || r.model !== (r.provider === 'fake' ? 'fake-paper-v1' : 'gpt-6-luna') || r.simulation !== (r.provider === 'fake') || typeof r.attempted !== 'boolean'
        || (r.state === 'succeeded' && !/^[a-f0-9-]{36}$/.test(r.draftId))
        || (r.usage !== null && (!r.usage || !Number.isSafeInteger(r.usage.inputTokens) || r.usage.inputTokens < 0 || !Number.isSafeInteger(r.usage.outputTokens) || r.usage.outputTokens < 0))
        || !Number.isFinite(r.reservedYen) || r.reservedYen < 0 || !Number.isFinite(r.estimatedYen) || r.estimatedYen < 0)
        || new Set(value.runs.map(r => r.id)).size !== value.runs.length) throw new Error('invalid-ledger');
      for (const run of value.runs) {
        if (Object.hasOwn(run, 'affiliateContext')) {
          if (run.provider !== 'openai') throw new Error('invalid-affiliate-provider');
          validateAffiliateContext(run.affiliateContext);
        }
      }
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') {
        // 初期化マーカーがあるのに台帳がない場合は予算をリセットしない。
        try { await readFile(path.join(directory, 'initialized')); }
        catch (markerError) { if (markerError.code === 'ENOENT') return { schemaVersion: 1, runs: [] }; }
      }
      throw invalid('生成記録を安全に読み取れません。API生成を停止しています。記録を削除せず確認してください。', 503);
    }
  }
  async function transaction(change) {
    const operation = pending.catch(() => {}).then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      try { await mkdir(lock, { mode: 0o700 }); }
      catch { throw invalid('別の処理が生成記録を使用中です。記録を削除せず、しばらく待ってください。', 409); }
      try {
        const ledger = await read();
        const result = await change(ledger);
        const temp = path.join(directory, `${randomUUID()}.tmp`);
        await writeFile(temp, JSON.stringify(ledger, null, 2) + '\n', { mode: 0o600 });
        await writeFile(path.join(directory, 'initialized'), '1\n', { mode: 0o600 });
        await rename(temp, file);
        return structuredClone(result);
      } finally { await rmdir(lock); }
    });
    pending = operation;
    return operation;
  }
  return { read, transaction };
}
