import { isDeepStrictEqual } from 'node:util';
import { validateGenerationLedger } from '../ai/generation-store.js';
import { generationAccounting, generationAccountingHash, aggregateBudget, validateActivation } from '../ai/budget-coordinator.js';
import { documentMetadata, requestDigest, materialFingerprint } from '../offer-import/execution-contract.js';
import { validateExecutionLedgerAny as validateExecutionLedger } from '../offer-import/execution-v5-contract.js';
import { validateArtifact } from '../offer-import/extraction-artifacts.js';
import { auditResolvedResultAny as auditResolvedResult } from '../offer-import/processing-registry.js';
import { validateExtraction } from '../offer-import/validation.js';
import { initialImportHash } from '../offer-import/extraction-service.js';
import { createOfferImport } from '../offer-import/contract.js';
import { digest, rejectSecrets } from '../ai/safety-storage.js';
import { validateRealApprovalPair } from '../ai/real-budget-approval.js';
import { auditExtractionInput } from '../ai/extraction-profile-registry.js';

// Pure snapshot inspection; never reads live stores or writes recovery decisions.
export function inspectAI(snapshot, offers, imports) {
  const issues = []; const add = (status, code, message, executionId = null) => issues.push({ status, code, message, recovery: 'human_required', ...(executionId ? { executionId } : {}) });
  const files = snapshot.files; const decode = name => JSON.parse(files[name].toString('utf8'));
  const metrics = { generationRuns: 0, extractionExecutions: 0, executionRevisions: 0, artifacts: 0, reanalysisExecutions: 0, upgradeExecutions: 0 };
  const complete = snapshot.directories.some(d => d.path === 'ai-budget');
  if (!complete) return { issues, metrics: {}, aiCoverage: 'legacy_only', commonBudgetActive: false }; // Uninspected AI stores are not reported as empty.
  let generation = { schemaVersion: 1, runs: [] }; let execution = { schemaVersion: 1, executions: [] }; let activation = null;
  for (const [dir, validate, assign] of [
    ['generations', v => generationAccounting(validateGenerationLedger(v)), v => { generation = v; metrics.generationRuns = v.runs.length; }],
    ['extraction-executions', validateExecutionLedger, v => { execution = v; metrics.extractionExecutions = v.executions.length; metrics.upgradeExecutions = v.executions.filter(e => Boolean(e.revisions[0].upgrade)).length; metrics.reanalysisExecutions = v.executions.filter(e => e.revisions[0].schemaVersion === 2).length; metrics.executionRevisions = v.executions.reduce((n, e) => n + e.revisions.length, 0); }],
  ]) {
    try {
      const exists = snapshot.directories.find(d => d.path === dir)?.present;
      if (files['ai-budget/activation.json'] && !exists) throw new Error();
      if (exists && (!files[`${dir}/ledger.json`] || files[`${dir}/initialized`]?.toString() !== '1\n')) throw new Error();
      if (files[`${dir}/ledger.json`]) { const v = decode(`${dir}/ledger.json`); rejectSecrets(v); assign(validate(v)); }
    } catch { add('error', 'ai_ledger_invalid', 'AI台帳・費用・revision履歴を検証できません。実行を停止してください。'); }
  }
  try {
    if (files['ai-budget/initialized']?.toString() !== '1\n') throw new Error();
    activation = validateActivation(decode('ai-budget/activation.json'));
    const original = activation.initialGeneration.map(r => {
      const current = generation.runs.find(x => x.id === r.id);
      if (!current || generationAccountingHash(current) !== r.hash) throw new Error();
      return current;
    });
    const initial = aggregateBudget({ schemaVersion: 1, runs: original }, { schemaVersion: 1, executions: [] }, new Date(activation.activatedAt));
    // All pre-activation extraction states are rejected by activation; the initial extraction budget is empty.
    if (!isDeepStrictEqual(initial, activation.initialBudget)) throw new Error();
  } catch { add('human_review_required', 'activation_invalid_or_missing', '共通予算の有効化記録・既存費用を確認できません。新しい外部AI実行は停止します。'); activation = null; }
  let realApproval = null;
  let realBudgetApprovalStatus = 'absent';
  try {
    const approval = files['ai-budget/real-approval.json'] ? decode('ai-budget/real-approval.json') : null;
    const anchor = files['ai-budget/real-approval-anchor.json'] ? decode('ai-budget/real-approval-anchor.json') : null;
    realApproval = validateRealApprovalPair(approval, anchor, activation);
    if (realApproval) realBudgetApprovalStatus = 'valid';
  } catch {
    realBudgetApprovalStatus = 'invalid';
    add('error', 'real_approval_invalid', '限定real承認記録とanchor・元activationの関連を確認できません。共通AI実行を停止します。');
  }
  const artifacts = new Map();
  for (const [file, bytes] of Object.entries(files).filter(([name]) => name.startsWith('extraction-artifacts/'))) {
    try {
      const a = validateArtifact(JSON.parse(bytes.toString()));
      if (file !== `extraction-artifacts/${a.id}.json`) throw new Error();
      artifacts.set(a.id, a); metrics.artifacts++;
    } catch { add('error', 'artifact_invalid', '固定資料または検証済み候補artifactのhash・形式を確認できません。'); }
  }
  const referenced = new Set();
  for (const entry of execution.executions) {
    const r = entry.revisions.at(-1);
    try {
      const get = (ref, type) => {
        const a = artifacts.get(ref.id);
        if (!a || a.executionId !== r.id || a.type !== type || a.contentHash !== ref.hash || a.byteSize !== ref.bytes) throw new Error();
        referenced.add(a.id); return a;
      };
      const input = get(r.inputArtifact, 'input');
      if (!isDeepStrictEqual(input.content.targetOffer, r.targetOffer) || !offers.get(r.targetOffer.id)?.[r.targetOffer.revision - 1]) throw new Error();
      const documents = input.content.documents;
      const meta = documentMetadata(documents);
      if (!isDeepStrictEqual(meta, r.documents) || r.requestHash !== requestDigest(input.contentHash, r.configuration, r.provider, r.model)) throw new Error();
      const fingerprint = materialFingerprint(r.targetOffer, documents);
      if (fingerprint !== r.fingerprint) throw new Error();
      auditExtractionInput(r, input.content);
      if (r.validatedArtifact) {
        const a = get(r.validatedArtifact, 'validated_extraction');
        if (a.content.inputHash !== input.contentHash) throw new Error();
        validateExtraction(a.content.extraction, documents);
        if (r.schemaVersion >= 4) auditResolvedResult(r,input.content,a);
        else if (digest({ extraction: a.content.extraction, usage: r.budget.usage }) !== r.responseHash) throw new Error();
      }
      if (r.plannedImport) {
        if (!r.validatedArtifact) throw new Error();
        const extraction = artifacts.get(r.validatedArtifact.id).content.extraction;
        const expected = createOfferImport({ id: r.plannedImport.id, createdAt: r.createdAt, ...input.content, extraction });
        if (initialImportHash(expected) !== r.plannedImport.contentHash) throw new Error();
        const first = imports.get(r.plannedImport.id)?.[0];
        if (first && initialImportHash(first) !== r.plannedImport.contentHash) throw new Error();
        if (r.state === 'succeeded' && (!first || digest(first) !== r.savedImport.hash)) throw new Error();
      }
      if (['approved', 'sending', 'response_received', 'validated', 'import_saving', 'import_save_failed', 'unknown', 'recovery_required'].includes(r.state))
        add('human_review_required', 'execution_unresolved', '未完了・結果不明・ローカル保存未確定の抽出があります。自動再送・自動修復は行いません。', r.id);
    } catch { add('error', 'execution_reference_invalid', '抽出execution→artifact→案件→取り込み初期revisionの対応を検証できません。'); }
  }
  for (const a of artifacts.values()) if (!referenced.has(a.id)) add('human_review_required', 'orphan_artifact', '実行記録から参照されないartifactがあります。削除・推測による復旧は行いません。');
  if (generation.runs.some(r => ['running', 'unknown', 'validated'].includes(r.state))) add('human_review_required', 'generation_unresolved', '記事生成の未完了・結果不明記録があります。新しいAI実行は停止します。');
  return { issues, metrics, aiCoverage: 'complete', commonBudgetActive: Boolean(activation) && realBudgetApprovalStatus !== 'invalid',
    realBudgetApprovalStatus, extractionLedgerVersion: execution.schemaVersion, effectiveRealStopMilliYen: realBudgetApprovalStatus === 'invalid' ? null : realApproval?.realStopMilliYen ?? activation?.policy.realStopMilliYen ?? null };
}
