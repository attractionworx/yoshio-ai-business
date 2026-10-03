import { createImprovementStore, validateImprovementWork, hasAffiliateProvenance, parseImprovementResult } from './improvements.js';
import { contextHash } from './ai/affiliate-context.js';
import { checkCurrentOffer } from './current-offer-check.js';
import { validateAffiliateContext } from './ai/affiliate-context.js';
import { createOfferStore } from './offers/store.js';
import { createAffiliateValidationLifecycle } from './affiliate-validation-lifecycle.js';
import { contentHash } from './affiliate-validation.js';
import { mkdir, readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { preparePublication, publicationData } from './publish.js';
import { invalid, PROMPT_VERSION, validateContent } from './content.js';
import { checkFinalExport, copyFields, finalExportReasons } from './final-export-check.js';

export function createDraftStore(dataDirectory, validationOptions = {}) {
  const directory = path.join(dataDirectory, 'drafts');
  const offerStore = validationOptions.offerStore || createOfferStore(dataDirectory);
  const refreshValidation = createAffiliateValidationLifecycle({ ...validationOptions, offerStore });
  const pending = new Map();
  const improvementStore = createImprovementStore(dataDirectory);
  const improvementToken = Symbol('saved-affiliate-improvement');
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
  async function createDraft(plan, parsed, raw, prompt, improvement = null, generation = null, affiliateContext = null, authorization = null) {
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
        if (hasAffiliateProvenance(parent) || improvement.schemaVersion === 2 || improvement.affiliateContext) {
          if (authorization !== improvementToken) throw invalid('案件付き改稿は保存済み改善依頼から取り込んでください。', 409);
          const saved = await improvementStore.get(improvement.id);
          improvement = validateImprovementWork(saved, parent);
          if (contextHash(plan) !== contextHash(improvement.planSnapshot) || prompt !== improvement.prompt) throw invalid('改善依頼の固定情報が一致しません。', 409);
          affiliateContext = validateAffiliateContext(improvement.affiliateContext);
        }
      }
      const now = new Date().toISOString();
      const content = affiliateContext ? validateContent(parsed.content) : parsed.content;
      const draft = { schemaVersion: 2, versionNumber: (history[0]?.versionNumber || 0) + 1,
        parentDraftId: improvement?.parentDraftId || null,
        improvement: improvement ? structuredClone(improvement) : null, id: randomUUID(), planId: plan.id, inputSnapshot: plan,
        generatedAt: parsed.generatedAt, importedAt: now, updatedAt: now,
        generationMethod: generation ? (generation.provider === 'fake' ? 'ai-direct-fake' : 'ai-direct-openai') : 'codex-manual',
        ...(generation ? { generation: structuredClone(generation) } : {}),
        ...(affiliateContext ? { affiliateContext } : {}),
        promptVersion: generation?.promptVersion || improvement?.promptVersion || PROMPT_VERSION, prompt,
        importNormalization: parsed.normalization || null, originalRaw: raw, original: content, edited: structuredClone(content),
        status: '未確認', reviewedAt: null, revision: 1 };
      await refreshValidation(draft);
      return save(draft);
    });
    pending.set(key, operation);
    try { return await operation; } finally { if (pending.get(key) === operation) pending.delete(key); }
  }
  const store = {
    get, list,
    async copy(id, input) {
      // 編集・再検査・公開準備と同じ直列化。要求内で再読込し、許可した本文だけ返す。
      const previous = pending.get(id) || Promise.resolve();
      const operation = previous.catch(() => {}).then(async () => {
        const blocked = reasonCode => ({ result: 'blocked', reasonCode, message: finalExportReasons[reasonCode] });
        const entries = input instanceof URLSearchParams ? [...input.entries()] : Object.entries(input || {});
        if (entries.length !== 2 || new Set(entries.map(([key]) => key)).size !== 2
            || entries.some(([key, value]) => !['revision', 'field'].includes(key) || typeof value !== 'string')) return blocked('invalid-request');
        const values = Object.fromEntries(entries);
        if (!copyFields.includes(values.field) || !/^[1-9]\d*$/.test(values.revision)) return blocked('invalid-request');
        const draft = await get(id);
        if (draft.revision !== Number(values.revision)) return blocked('draft-changed');
        const check = await checkFinalExport(draft, offerStore);
        if (check.result !== 'pass') {
          // 失敗は記事findingに混ぜない。本文・根拠・検査・人間確認を保持する。
          if (draft.publication?.status === '公開準備OK') {
            draft.publication.status = '要修正';
            draft.publication.readyAt = null;
            draft.publication.missing = [finalExportReasons[check.reasonCode]];
            draft.updatedAt = new Date().toISOString();
            draft.revision += 1;
            await save(draft);
          }
          return blocked(check.reasonCode);
        }
        if (!draft.affiliateContext && draft.publication?.status !== '公開準備OK') return blocked('publication-not-ready');
        return { ...check, message: finalExportReasons[check.reasonCode], text: publicationData(draft, draft.publication.titleIndex)[values.field] };
      });
      pending.set(id, operation);
      try { return await operation; } finally { if (pending.get(id) === operation) pending.delete(id); }
    },
    async createImproved(requestId, raw) {
      const request = await improvementStore.get(requestId);
      const parent = await get(request.parentDraftId);
      const checked = validateImprovementWork(request, parent);
      if (checked.settings.mode !== 'rewrite') throw invalid('分析結果はドラフトとして取り込めません。');
      const parsed = parseImprovementResult(checked, raw);
      return createDraft(checked.planSnapshot, parsed, raw, checked.prompt, checked, null, null, improvementToken);
    },
    async create(plan, parsed, raw, prompt, improvement = null, generation = null, affiliateContext = null) {
      return createDraft(plan, parsed, raw, prompt, improvement, generation, affiliateContext);
    },
    async update(id, revision, content, action) {
      // 同じ下書きへの同時保存を直列化し、古いタブからの上書きを拒否します。
      const previous = pending.get(id) || Promise.resolve();
      const operation = previous.catch(() => {}).then(async () => {
        const draft = await get(id);
        if (draft.revision !== revision) throw invalid('別の画面で更新されています。入力内容をコピーしてから最新の下書きを開き直してください。', 409);
        if (action === 'publish') {
          const currentOfferCheck = await checkCurrentOffer(draft, offerStore);
          draft.publication = preparePublication(draft, content, currentOfferCheck);
          draft.updatedAt = new Date().toISOString();
          draft.revision += 1;
          return save(draft);
        }
        if (action === 'revalidate') {
          if (!draft.affiliateContext) throw invalid('この下書きには案件根拠がありません。');
          await refreshValidation(draft, { force: true });
          draft.updatedAt = new Date().toISOString();
          draft.revision += 1;
          return save(draft);
        }
        if (draft.affiliateContext) content = validateContent(content); // 追加キーを本文・根拠・検査結果へ昇格させない。
        const changed = draft.affiliateContext ? contentHash(draft.edited) !== contentHash(content)
          : JSON.stringify(draft.edited) !== JSON.stringify(content);
        draft.edited = content;
        if (action === 'review' && !changed) { draft.status = '確認済み'; draft.reviewedAt = new Date().toISOString(); }
        else if (changed) { delete draft.publication; draft.status = '編集中'; draft.reviewedAt = null; }
        await refreshValidation(draft);
        draft.updatedAt = new Date().toISOString();
        draft.revision += 1;
        return save(draft);
      });
      pending.set(id, operation);
      try { return await operation; } finally { if (pending.get(id) === operation) pending.delete(id); }
    },
  };
  return store;
}
