import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validateOfferId } from '../offers/validation.js';
import { createOfferImport, reviewCandidate } from './contract.js';
import { validateOfferImport } from './validation.js';

const error = (status) => Object.assign(new Error({
  400: '取り込み保存の入力が不正です。',
  404: '取り込み記録が見つかりません。',
  409: '取り込み記録の競合を検出しました。最新版を確認してください。',
  503: '取り込み記録を安全に読み書きできません。記録を変更せず確認してください。',
}[status]), { status });
function exact(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).sort().join() !== [...keys].sort().join()) throw error(400);
}

// Only create/review; no arbitrary draft replacement, offer writes, API calls or deletion.
export function createOfferImportStore(dataDirectory, { now = () => new Date(), fileSystem = fs } = {}) {
  const directory = path.join(dataDirectory, 'offer-imports');
  const filename = id => {
    try { validateOfferId(id); } catch { throw error(400); }
    return path.join(directory, `${id}.json`);
  };
  let pending = Promise.resolve();

  function validateHistory(record, id) {
    exact(record, ['schemaVersion', 'revisions']);
    if (record.schemaVersion !== 1 || !Array.isArray(record.revisions) || !record.revisions.length) throw error(503);
    const revisions = record.revisions.map(validateOfferImport);
    const first = revisions[0];
    const initial = createOfferImport({ id, createdAt: first.createdAt, targetOffer: first.targetOffer,
      documents: first.documents, extraction: { schemaVersion: 1, candidates: first.candidates.map(c => c.original) } });
    if (!isDeepStrictEqual(first, initial)) throw error(503);
    for (let i = 1; i < revisions.length; i++) {
      const previous = revisions[i - 1];
      const next = revisions[i];
      if (next.id !== id || next.revision !== i + 1 || next.createdAt !== first.createdAt
          || !isDeepStrictEqual(next.targetOffer, first.targetOffer)
          || !isDeepStrictEqual(next.documents, first.documents)
          || !isDeepStrictEqual(next.candidates.map(c => ({ id: c.id, original: c.original })),
            first.candidates.map(c => ({ id: c.id, original: c.original })))) throw error(503);
      const changed = next.candidates.filter((c, index) => !isDeepStrictEqual(c.review, previous.candidates[index].review));
      if (changed.length > 1 || !next.candidates.length) throw error(503);
      // Identical review operations are allowed; revision still records the explicit operation.
      const candidate = changed[0] || next.candidates[0];
      const r = candidate.review;
      const replay = reviewCandidate(previous, candidate.id, previous.revision, {
        decision: r.decision, edited: r.edited, sourceChecked: r.verification === 'source_checked',
        reason: r.reason, at: next.updatedAt,
      });
      if (!isDeepStrictEqual(replay, next)) throw error(503);
    }
    return revisions;
  }

  async function history(id) {
    const file = filename(id);
    try {
      if (!(await fileSystem.lstat(directory)).isDirectory()) throw error(503);
      const stat = await fileSystem.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw error(503);
      return validateHistory(JSON.parse(await fileSystem.readFile(file, 'utf8')), id);
    } catch (e) {
      if (e.code === 'ENOENT') throw error(404);
      throw error(503);
    }
  }

  async function save(revisions) {
    const temp = path.join(directory, `${randomUUID()}.tmp`);
    try {
      await fileSystem.writeFile(temp, JSON.stringify({ schemaVersion: 1, revisions }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      await fileSystem.rename(temp, filename(revisions[0].id));
    } catch { throw error(503); }
    finally {
      try { await fileSystem.unlink(temp); } catch (e) { if (e.code !== 'ENOENT') throw error(503); }
    }
  }

  function transaction(change) {
    const operation = pending.catch(() => {}).then(async () => {
      try {
        await fileSystem.mkdir(directory, { recursive: true, mode: 0o700 });
        if (!(await fileSystem.lstat(directory)).isDirectory()) throw error(503);
      } catch { throw error(503); }
      const lock = path.join(directory, '.lock');
      try { await fileSystem.mkdir(lock, { mode: 0o700 }); }
      catch (e) { throw error(e.code === 'EEXIST' ? 409 : 503); }
      try { return await change(); }
      finally { try { await fileSystem.rmdir(lock); } catch { throw error(503); } }
    });
    pending = operation;
    return operation;
  }

  return {
    history,
    async get(id) { return (await history(id)).at(-1); },
    async list() {
      let names;
      try {
        if (!(await fileSystem.lstat(directory)).isDirectory()) throw error(503);
        names = await fileSystem.readdir(directory);
      }
      catch (e) { if (e.code === 'ENOENT') return []; throw error(503); }
      try {
        const records = await Promise.all(names.filter(n => n.endsWith('.json')).sort().map(n => history(n.slice(0, -5))));
        return records.map(revisions => revisions.at(-1));
      } catch { throw error(503); }
    },
    async create(input, options = {}) {
      exact(input, ['targetOffer', 'documents', 'extraction']);
      if (!options || Object.getPrototypeOf(options) !== Object.prototype
          || Object.keys(options).some(k => k !== 'id')) throw error(400);
      const id = options.id ?? randomUUID();
      filename(id); // Validate before any filesystem mutation.
      let draft;
      try { draft = createOfferImport({ ...input, id, createdAt: now().toISOString() }); }
      catch { throw error(400); }
      return transaction(async () => {
        try { await history(id); }
        catch (e) {
          if (e.status !== 404) throw e;
          await save([draft]);
          return structuredClone(draft);
        }
        throw error(409);
      });
    },
    async review(id, candidateId, expectedRevision, action) {
      filename(id);
      exact(action, ['decision', 'edited', 'sourceChecked', 'reason']);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw error(400);
      let detached;
      try { detached = structuredClone(action); } catch { throw error(400); }
      return transaction(async () => {
        const revisions = await history(id);
        const previous = revisions.at(-1);
        if (previous.revision !== expectedRevision) throw error(409);
        let next;
        try { next = reviewCandidate(previous, candidateId, expectedRevision, { ...detached, at: now().toISOString() }); }
        catch { throw error(400); }
        await save([...revisions, next]);
        return structuredClone(next);
      });
    },
  };
}
