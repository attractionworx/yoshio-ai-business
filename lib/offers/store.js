import { mkdir, readFile, readdir, writeFile, rename, unlink, rmdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { invalid } from '../content.js';
import { validateOffer, validateOfferId } from './validation.js';

const metadata = ['id', 'schemaVersion', 'revision', 'createdAt', 'updatedAt'];

export function createOfferStore(dataDirectory, { now = () => new Date() } = {}) {
  const directory = path.join(dataDirectory, 'offers');
  const file = id => path.join(directory, `${validateOfferId(id)}.json`);
  let pending = Promise.resolve();

  async function history(id) {
    const filename = file(id);
    let raw;
    try { raw = await readFile(filename, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') throw invalid('案件が見つかりません。', 404); throw error; }
    try {
      const record = JSON.parse(raw);
      if (!record || Object.keys(record).sort().join() !== 'revisions,schemaVersion' || record.schemaVersion !== 1 || !Array.isArray(record.revisions) || !record.revisions.length) throw new Error();
      const revisions = record.revisions.map(validateOffer);
      if (revisions.some((offer, index) => offer.id !== id || offer.revision !== index + 1
          || offer.createdAt !== revisions[0].createdAt
          || (index > 0 && Date.parse(offer.updatedAt) < Date.parse(revisions[index - 1].updatedAt)))) throw new Error();
      return revisions;
    } catch { throw invalid('案件履歴を安全に読み取れません。ファイルを変更せず確認してください。', 503); }
  }

  async function save(revisions) {
    const temporary = path.join(directory, `${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify({ schemaVersion: 1, revisions }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      await rename(temporary, file(revisions[0].id));
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }

  function transaction(change) {
    const operation = pending.catch(() => {}).then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const lock = path.join(directory, '.lock');
      try { await mkdir(lock, { mode: 0o700 }); }
      catch (error) { if (error.code === 'EEXIST') throw invalid('別の処理が案件を更新中です。時間を置いて再試行してください。', 409); throw error; }
      try { return await change(); } finally { await rmdir(lock); }
    });
    pending = operation;
    return operation;
  }

  function make(input, system) {
    if (!input || Object.getPrototypeOf(input) !== Object.prototype || metadata.some(key => Object.hasOwn(input, key))) throw invalid('案件の管理項目は指定できません。');
    return validateOffer({ ...input, ...system });
  }

  return {
    history,
    async get(id) { return (await history(id)).at(-1); },
    async list() {
      let names;
      try { names = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      const records = await Promise.all(names.filter(name => name.endsWith('.json')).sort().map(name => history(name.slice(0, -5))));
      return records.map(revisions => revisions.at(-1));
    },
    async create(input, { id = randomUUID() } = {}) {
      validateOfferId(id);
      const timestamp = now().toISOString();
      const offer = make(input, { schemaVersion: 1, id, revision: 1, createdAt: timestamp, updatedAt: timestamp });
      return transaction(async () => {
        try { await history(id); } catch (error) { if (error.status !== 404) throw error;
          await save([offer]); return structuredClone(offer); }
        throw invalid('案件IDが重複しています。', 409);
      });
    },
    async update(id, expectedRevision, input) {
      validateOfferId(id);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw invalid('revisionが不正です。');
      // 更新内容も書き込み前に検証。全項目置換で、曖昧な部分更新をしない。
      return transaction(async () => {
        const revisions = await history(id);
        const previous = revisions.at(-1);
        if (previous.revision !== expectedRevision) throw invalid('案件が別の処理で更新されています。', 409);
        const timestamp = now().toISOString();
        if (Date.parse(timestamp) < Date.parse(previous.updatedAt)) throw invalid('更新日時が過去になっています。');
        const offer = make(input, { schemaVersion: 1, id, revision: previous.revision + 1, createdAt: previous.createdAt, updatedAt: timestamp });
        await save([...revisions, offer]);
        return structuredClone(offer);
      });
    },
  };
}
