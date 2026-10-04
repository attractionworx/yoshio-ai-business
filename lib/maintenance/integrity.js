import { inspectAI } from './ai-integrity.js';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { validateOffer } from '../offers/validation.js';
import { createOfferImportStore } from '../offer-import/store.js';
import { createCommitStore, commitStates } from '../offer-import/commit-store.js';
import { offerBusiness } from '../offer-import/projection.js';
import { capture, memoryFileSystem, snapshotHash } from './snapshot.js';

// Read-only validation reuses Step 1/2/4 validators through an in-memory filesystem.
export async function inspectSnapshot(snapshot) {
  const started = performance.now();
  const issues = [...snapshot.notes]; const offers = new Map(); const imports = new Map();
  let offerRevisions = 0; let importRevisions = 0; let commitEvents = 0;
  let auditStates = [];
  const add = (status, code, message, file = null, recovery = 'human_required') => issues.push({ status, code, message, file, recovery });
  const memory = memoryFileSystem(snapshot);
  const importStore = createOfferImportStore('/snapshot', { fileSystem: memory });
  for (const [file, bytes] of Object.entries(snapshot.files)) {
    if (file.startsWith('offers/')) {
      try {
        const record = JSON.parse(bytes.toString('utf8')); const id = file.slice(7, -5);
        if (!record || Object.keys(record).sort().join() !== 'revisions,schemaVersion' || record.schemaVersion !== 1 || !Array.isArray(record.revisions) || !record.revisions.length) throw new Error();
        const revisions = record.revisions.map(validateOffer);
        if (revisions.some((o, i) => o.id !== id || o.revision !== i + 1 || o.createdAt !== revisions[0].createdAt
          || (i > 0 && Date.parse(o.updatedAt) < Date.parse(revisions[i - 1].updatedAt)))) throw new Error();
        offers.set(id, revisions); offerRevisions += revisions.length;
      } catch { add('error', 'offer_history_invalid', '案件のschema・revision・出典参照・履歴を検証できません。', file); }
    } else if (file.startsWith('offer-imports/')) {
      try { const id = file.slice(14, -5); const revisions = await importStore.history(id); imports.set(id, revisions); importRevisions += revisions.length; }
      catch { add('error', 'import_history_invalid', '取り込みのschema・revision・出典参照・レビュー履歴を検証できません。', file); }
    }
  }
  for (const revisions of imports.values()) {
    const first = revisions[0];
    if (first.targetOffer && !offers.get(first.targetOffer.id)?.[first.targetOffer.revision - 1]) add('error', 'target_offer_missing', '取り込みが参照する案件revisionがありません。', `offer-imports/${first.id}.json`);
  }
  if (snapshot.files['offer-import-commits/ledger.json'] && !snapshot.files['offer-import-commits/initialized']) add('error', 'audit_marker_missing', '監査の初期化記録がありません。');
  if (snapshot.files['offer-import-commits/initialized'] && snapshot.files['offer-import-commits/initialized'].toString('utf8') !== '1\n') add('error', 'audit_marker_invalid', '監査の初期化記録が不正です。');
  try {
    const ledger = await createCommitStore('/snapshot', { fileSystem: memory }).read(); commitEvents = ledger.events.length;
    auditStates = commitStates(ledger);
    for (const state of auditStates) {
      const intent = state.intent; const p = intent.plan;
      const imported = imports.get(p.importId)?.[p.importRevision - 1];
      const history = offers.get(p.offerId); const previous = history?.[p.offerRevision - 1]; const next = history?.[p.nextRevision - 1];
      if (!isDeepStrictEqual(imported, intent.importSnapshot)) add('error', 'commit_import_mismatch', '監査が参照する取り込みrevisionが存在しないか一致しません。');
      if (!isDeepStrictEqual(previous, intent.offerSnapshot)) add('error', 'commit_offer_mismatch', '監査が参照する反映前の案件revisionが存在しないか一致しません。');
      const nextMatches = next && isDeepStrictEqual(offerBusiness(next), p.input);
      if (state.state === 'committed' && !nextMatches) add('error', 'commit_result_mismatch', '反映結果と正式案件revisionが一致しません。');
      if (state.state === 'not_applied' && nextMatches && Date.parse(next.updatedAt) <= Date.parse(state.result.at))
        add('human_review_required', 'not_applied_ambiguous', '未反映のresultと同内容の案件revisionがあります。保存時点を確定できないため人間確認が必要です。');
      if (state.state === 'recovery_required') {
        const known = imported && previous && isDeepStrictEqual(imported, intent.importSnapshot) && isDeepStrictEqual(previous, intent.offerSnapshot)
          && (nextMatches || isDeepStrictEqual(history?.at(-1), intent.offerSnapshot));
        add('human_review_required', 'unresolved_intent', known
          ? 'intentに対応するresultがありません。既存の監査復旧画面で人間による確認が必要です。'
          : 'intentの保存結果を判定できません。停止して履歴を人間が確認してください。', null, known ? 'recoverable' : 'human_required');
      }
    }
  } catch { add('error', 'audit_invalid', 'commit監査履歴を検証できません。'); }
  // A completely removed audit/import folder must not make generated provenance look normal.
  // Manually imitated reserved IDs are ambiguous too; no provenance is invented for them.
  const checkedSources = new Set();
  for (const [offerId, revisions] of offers) for (const offer of revisions) for (const source of offer.sources) {
    const match = source.id.match(/^imp-([a-f0-9-]{36})-d([1-9]\d*)$/);
    if (!match || checkedSources.has(`${offerId}/${source.id}`)) continue;
    checkedSources.add(`${offerId}/${source.id}`);
    const imported = imports.get(match[1])?.[0];
    const intent = auditStates.find(s => s.intent.plan.offerId === offerId && s.intent.plan.importId === match[1]
      && s.intent.plan.sources.some(entry => entry.id === source.id));
    if (!imported?.documents[Number(match[2]) - 1] || !intent)
      add('human_review_required', 'generated_provenance_missing', '取り込み由来の出典IDに対応する資料またはcommit監査がありません。人間確認が必要です。', `offers/${offerId}.json`);
  }
  const ai = inspectAI(snapshot, offers, imports); issues.push(...ai.issues);
  const status = issues.some(i => i.status === 'error') ? 'error' : issues.some(i => i.status === 'human_review_required') ? 'human_review_required' : issues.length ? 'warning' : 'normal';
  return { schemaVersion: 1, status, recovery: status === 'normal' ? 'normal' : issues.every(i => i.recovery === 'recoverable') ? 'recoverable' : 'human_required',
    stopped: status !== 'normal', issues, aiCoverage: ai.aiCoverage, commonBudgetActive: ai.commonBudgetActive, snapshotHash: snapshotHash(snapshot),
    metrics: { files: Object.keys(snapshot.files).length, bytes: Object.values(snapshot.files).reduce((n, b) => n + b.length, 0),
      ...ai.metrics, offers: offers.size, offerRevisions, imports: imports.size, importRevisions, commitEvents, inspectionMs: Math.round((performance.now() - started) * 100) / 100 } };
}

export async function integrityCheck(root, options = {}) {
  const started = performance.now();
  try {
    const report = await inspectSnapshot(await capture(root, options));
    report.metrics.inspectionMs = Math.round((performance.now() - started) * 100) / 100;
    return report;
  }
  catch (e) { return { schemaVersion: 1, status: 'human_review_required', recovery: 'human_required', stopped: true,
    issues: [{ status: 'human_review_required', code: e.status === 409 ? 'snapshot_busy' : 'snapshot_unreadable', message: 'データ取得が不完全です。処理を停止しました。更新処理・ロック・ファイルを人間が確認してください。' }],
    snapshotHash: null, metrics: { inspectionMs: Math.round(performance.now() - started) } }; }
}
