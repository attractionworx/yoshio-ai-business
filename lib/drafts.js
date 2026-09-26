import { mkdir, readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { invalid, PROMPT_VERSION } from './content.js';

export function createDraftStore(dataDirectory) {
  const directory = path.join(dataDirectory, 'drafts');
  const pending = new Map();
  async function save(draft) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const destination = path.join(directory, `${draft.id}.json`);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(draft, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, destination);
    return draft;
  }
  async function get(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw invalid('下書きが見つかりません。', 404);
    try { return JSON.parse(await readFile(path.join(directory, `${id}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') throw invalid('下書きが見つかりません。', 404); throw error; }
  }
  return {
    get,
    async list(planId) {
      let names;
      try { names = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      const drafts = await Promise.all(names.filter(n => /^[a-f0-9-]{36}\.json$/.test(n)).map(n => get(n.slice(0, -5))));
      return drafts.filter(d => d.planId === planId).sort((a, b) => b.importedAt.localeCompare(a.importedAt));
    },
    async create(plan, parsed, raw, prompt) {
      const now = new Date().toISOString();
      return save({ schemaVersion: 1, id: randomUUID(), planId: plan.id, inputSnapshot: plan,
        generatedAt: parsed.generatedAt, importedAt: now, updatedAt: now,
        generationMethod: 'codex-manual', promptVersion: PROMPT_VERSION, prompt,
        importNormalization: parsed.normalization || null, originalRaw: raw, original: parsed.content, edited: structuredClone(parsed.content),
        status: '未確認', reviewedAt: null, revision: 1 });
    },
    async update(id, revision, content, action) {
      // 同じ下書きへの同時保存を直列化し、古いタブからの上書きを拒否します。
      const previous = pending.get(id) || Promise.resolve();
      const operation = previous.catch(() => {}).then(async () => {
        const draft = await get(id);
        if (draft.revision !== revision) throw invalid('別の画面で更新されています。入力内容をコピーしてから最新の下書きを開き直してください。', 409);
        const changed = JSON.stringify(draft.edited) !== JSON.stringify(content);
        draft.edited = content;
        if (action === 'review' && !changed) { draft.status = '確認済み'; draft.reviewedAt = new Date().toISOString(); }
        else if (changed) { draft.status = '編集中'; draft.reviewedAt = null; }
        draft.updatedAt = new Date().toISOString();
        draft.revision += 1;
        return save(draft);
      });
      pending.set(id, operation);
      try { return await operation; } finally { if (pending.get(id) === operation) pending.delete(id); }
    },
  };
}
