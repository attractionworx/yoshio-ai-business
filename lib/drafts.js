import { validateAffiliateContext } from './ai/affiliate-context.js';
import { mkdir, readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { preparePublication } from './publish.js';
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
  async function list(planId) {
    let names;
    try { names = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const drafts = await Promise.all(names.filter(n => /^[a-f0-9-]{36}\.json$/.test(n)).map(n => get(n.slice(0, -5))));
    const matching = drafts.filter(d => d.planId === planId);
    // Phase 2データは読み取り時だけ採番し、既存ファイルを移行・変更しません。
    const legacy = matching.filter(d => !d.versionNumber).sort((a, b) => a.importedAt.localeCompare(b.importedAt) || a.id.localeCompare(b.id));
    const numbers = new Map(legacy.map((d, i) => [d.id, i + 1]));
    return matching.map(d => ({ ...d, versionNumber: d.versionNumber || numbers.get(d.id) })).sort((a, b) => b.versionNumber - a.versionNumber);
  }
  return {
    get, list,
    async create(plan, parsed, raw, prompt, improvement = null, generation = null, affiliateContext = null) {
      if (affiliateContext) {
        if (generation?.provider !== 'openai') throw invalid('案件の生成根拠が不正です。');
        affiliateContext = validateAffiliateContext(affiliateContext);
      }
      const key = `plan:${plan.id}`;
      const previous = pending.get(key) || Promise.resolve();
      const operation = previous.catch(() => {}).then(async () => {
        const history = await list(plan.id);
        if (generation) {
          if (!['fake', 'openai'].includes(generation.provider) || generation.simulation !== (generation.provider === 'fake') || !/^[a-f0-9-]{36}$/.test(generation.executionId) || improvement) throw invalid('直接生成の保存情報が不正です。');
          const existing = history.find(d => d.generation?.executionId === generation.executionId);
          if (existing) return existing;
        }
        if (improvement) {
          const parent = await get(improvement.parentDraftId);
          if (parent.planId !== plan.id || improvement.planSnapshot.id !== plan.id || improvement.settings.mode !== 'rewrite') throw invalid('この改善依頼は取り込めません。');
        }
        const now = new Date().toISOString();
        return save({ schemaVersion: 2, versionNumber: (history[0]?.versionNumber || 0) + 1,
          parentDraftId: improvement?.parentDraftId || null,
          improvement: improvement ? structuredClone(improvement) : null, id: randomUUID(), planId: plan.id, inputSnapshot: plan,
          generatedAt: parsed.generatedAt, importedAt: now, updatedAt: now,
          generationMethod: generation ? (generation.provider === 'fake' ? 'ai-direct-fake' : 'ai-direct-openai') : 'codex-manual',
          ...(generation ? { generation: structuredClone(generation) } : {}),
          ...(affiliateContext ? { affiliateContext } : {}),
          promptVersion: generation?.promptVersion || improvement?.promptVersion || PROMPT_VERSION, prompt,
          importNormalization: parsed.normalization || null, originalRaw: raw, original: parsed.content, edited: structuredClone(parsed.content),
          status: '未確認', reviewedAt: null, revision: 1 });
      });
      pending.set(key, operation);
      try { return await operation; } finally { if (pending.get(key) === operation) pending.delete(key); }
    },
    async update(id, revision, content, action) {
      // 同じ下書きへの同時保存を直列化し、古いタブからの上書きを拒否します。
      const previous = pending.get(id) || Promise.resolve();
      const operation = previous.catch(() => {}).then(async () => {
        const draft = await get(id);
        if (draft.revision !== revision) throw invalid('別の画面で更新されています。入力内容をコピーしてから最新の下書きを開き直してください。', 409);
        if (action === 'publish') {
          draft.publication = preparePublication(draft, content);
          draft.updatedAt = new Date().toISOString();
          draft.revision += 1;
          return save(draft);
        }
        const changed = JSON.stringify(draft.edited) !== JSON.stringify(content);
        draft.edited = content;
        if (action === 'review' && !changed) { draft.status = '確認済み'; draft.reviewedAt = new Date().toISOString(); }
        else if (changed) { delete draft.publication; draft.status = '編集中'; draft.reviewedAt = null; }
        draft.updatedAt = new Date().toISOString();
        draft.revision += 1;
        return save(draft);
      });
      pending.set(id, operation);
      try { return await operation; } finally { if (pending.get(id) === operation) pending.delete(id); }
    },
  };
}
