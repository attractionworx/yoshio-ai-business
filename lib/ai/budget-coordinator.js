import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { readRealApproval, validateRealApproval, realApprovalFile, realApprovalAnchor } from './real-budget-approval.js';
import { withStoreLocks, snapshotHash } from '../maintenance/snapshot.js';
import { createGenerationStore } from './generation-store.js';
import { createExecutionStore } from '../offer-import/execution-store.js';
import { exact, digest, natural, timestamp, durableWrite, directoryLock, readJson, regular, safetyError, rejectSecrets } from './safety-storage.js';

// Decimal conversion is performed with integers, including legacy JSON decimal/exponent values.
export function milliYen(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw safetyError('budget_unclassifiable');
  const [mantissa, exponent = '0'] = String(value).toLowerCase().split('e');
  const [whole, fraction = ''] = mantissa.split('.'); const digits = BigInt(whole + fraction);
  const scale = Number(exponent) - fraction.length + 3;
  const result = scale >= 0 ? digits * 10n ** BigInt(scale) : (digits + 10n ** BigInt(-scale) - 1n) / 10n ** BigInt(-scale);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw safetyError('budget_overflow');
  return Number(result);
}
export function costMilliYen(usage, config) {
  natural(usage.inputTokens); natural(usage.outputTokens);
  const n = BigInt(usage.inputTokens) * BigInt(config.inputMilliYenPerMillion) + BigInt(usage.outputTokens) * BigInt(config.outputMilliYenPerMillion);
  const result = (n + 999999n) / 1000000n;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw safetyError('budget_overflow');
  return Number(result);
}
export function validatePolicy(p) {
  exact(p, ['schemaVersion', 'version', 'realStopMilliYen', 'simulationStopMilliYen']);
  if (p.schemaVersion !== 1 || typeof p.version !== 'string' || !/^[a-z0-9-]{1,60}$/.test(p.version)) throw safetyError();
  for (const k of ['realStopMilliYen', 'simulationStopMilliYen']) { if (p[k] !== null) { natural(p[k]); if (!p[k]) throw safetyError(); } }
  return structuredClone(p);
}
export function generationAccounting(ledger) {
  rejectSecrets(ledger);
  if (ledger.schemaVersion !== 1 || !Array.isArray(ledger.runs)) throw safetyError();
  for (const r of ledger.runs) {
    if (!r || !['running', 'unknown', 'validated', 'failed', 'save-failed', 'succeeded'].includes(r.state)
        || !['fake', 'openai'].includes(r.provider) || r.simulation !== (r.provider === 'fake') || typeof r.attempted !== 'boolean'
        || !/^\d{4}-\d{2}$/.test(r.month) || !r.createdAt || new Date(r.createdAt).toISOString().slice(0, 7) !== r.month) throw safetyError('budget_unclassifiable');
    milliYen(r.estimatedYen); milliYen(r.reservedYen);
    if (r.usage === null && r.estimatedYen !== 0) throw safetyError('budget_unclassifiable');
    if (r.usage !== null && (!r.usage || !Number.isSafeInteger(r.usage.inputTokens) || !Number.isSafeInteger(r.usage.outputTokens) || r.usage.inputTokens < 0 || r.usage.outputTokens < 0)) throw safetyError('budget_unclassifiable');
    if (r.usage && (r.usage.inputTokens || r.usage.outputTokens) && r.estimatedYen <= 0) throw safetyError('budget_unclassifiable');
    if (['succeeded', 'save-failed', 'validated'].includes(r.state) && (!r.usage || r.reservedYen !== 0)) throw safetyError('budget_unclassifiable');
    if (r.state === 'failed' && r.reservedYen !== 0) throw safetyError('budget_unclassifiable');
    if (['running', 'unknown'].includes(r.state) && r.reservedYen <= 0) throw safetyError('budget_unclassifiable');
  }
  return ledger;
}
export const generationAccountingHash = r => digest(Object.fromEntries(['id', 'provider', 'simulation', 'month', 'usage', 'estimatedYen', 'reservedYen', 'attempted'].map(k => [k, r[k]])));
export function aggregateBudget(generation, extraction, at) {
  generationAccounting(generation);
  const month = at.toISOString().slice(0, 7);
  const totals = { month, real: { bookedMilliYen: 0, reservedMilliYen: 0 }, simulation: { bookedMilliYen: 0, reservedMilliYen: 0 } };
  const add = (group, booked, reserved, m) => {
    if (m === month) totals[group].bookedMilliYen += booked;
    totals[group].reservedMilliYen += reserved;
    natural(totals[group].bookedMilliYen); natural(totals[group].reservedMilliYen);
  };
  for (const r of generation.runs) add(r.simulation ? 'simulation' : 'real', milliYen(r.estimatedYen), milliYen(r.reservedYen), r.month);
  for (const e of extraction.executions) { const r = e.revisions.at(-1); add(r.provider === 'fake' ? 'simulation' : 'real', r.budget.bookedMilliYen, r.budget.reservedMilliYen, r.budget.month); }
  return totals;
}
export function validateActivation(a) {
  exact(a, ['schemaVersion', 'revision', 'activatedAt', 'approval', 'policy', 'policyHash', 'initialBudget', 'generationHash', 'extractionHash', 'initialGeneration']);
  if (a.schemaVersion !== 1 || a.revision !== 1 || a.approval !== 'human_explicit') throw safetyError();
  timestamp(a.activatedAt); validatePolicy(a.policy);
  if (a.policyHash !== digest(a.policy) || !/^[a-f0-9]{64}$/.test(a.generationHash) || !/^[a-f0-9]{64}$/.test(a.extractionHash)) throw safetyError();
  exact(a.initialBudget, ['month', 'real', 'simulation']); if (a.initialBudget.month !== a.activatedAt.slice(0, 7)) throw safetyError();
  for (const g of ['real', 'simulation']) { exact(a.initialBudget[g], ['bookedMilliYen', 'reservedMilliYen']); natural(a.initialBudget[g].bookedMilliYen); natural(a.initialBudget[g].reservedMilliYen); }
  if (!Array.isArray(a.initialGeneration) || new Set(a.initialGeneration.map(r => r.id)).size !== a.initialGeneration.length) throw safetyError();
  for (const r of a.initialGeneration) { exact(r, ['id', 'hash']); if (!/^[a-f0-9-]{36}$/.test(r.id) || !/^[a-f0-9]{64}$/.test(r.hash)) throw safetyError(); }
  return structuredClone(a);
}
export function assertActivationBaseline(a, generation) {
  const original = a.initialGeneration.map(r => {
    const current = generation.runs.find(x => x.id === r.id);
    if (!current || generationAccountingHash(current) !== r.hash) throw safetyError('activation_baseline_mismatch');
    return current;
  });
  if (digest(aggregateBudget({ schemaVersion: 1, runs: original }, { schemaVersion: 1, executions: [] }, new Date(a.activatedAt))) !== digest(a.initialBudget)) throw safetyError('activation_baseline_mismatch');
}
const blockingExtraction = ['approved', 'sending', 'response_received', 'validated', 'import_saving', 'unknown', 'recovery_required'];
export function assertNoInProgress(g, e, exclude = null) {
  if (g.runs.some(r => r.id !== exclude && ['running', 'unknown', 'validated'].includes(r.state))
      || e.executions.some(entry => entry.revisions.at(-1).id !== exclude && blockingExtraction.includes(entry.revisions.at(-1).state))) {
    throw Object.assign(safetyError('ai_in_progress', 409), { message: '生成中または結果不明の実行があります。新しいAI実行を停止しています。' });
  }
}
export function checkCommonBudget(totals, policy, simulation, reservation) {
  natural(reservation); const group = simulation ? 'simulation' : 'real'; const cap = policy[`${group}StopMilliYen`];
  if (cap === null) throw safetyError('budget_policy_unavailable', 409);
  const total = BigInt(totals[group].bookedMilliYen) + BigInt(totals[group].reservedMilliYen) + BigInt(reservation);
  if (total > BigInt(cap)) throw Object.assign(safetyError('common_budget_exceeded', 409), { message: '共通AI予算の安全停止額を超えるため実行できません。' });
}
export function createBudgetCoordinator(root, { fileSystem = fs, now = () => new Date(), generationStore = createGenerationStore(root), executionStore = createExecutionStore(root, { fileSystem, now }) } = {}) {
  const dir = path.join(root, 'ai-budget'); const file = path.join(dir, 'activation.json');
  const locked = directoryLock(root, 'ai-budget', fileSystem);
  const approvalKey = randomBytes(32);
  const sign = body => createHmac('sha256', approvalKey).update(body).digest('hex');
  async function taskStoresPresent(ownedTaskLocks = false) {
    try { for (const name of ['generations', 'extraction-executions']) {
        await regular(fileSystem, path.join(root, name), true);
        await regular(fileSystem, path.join(root, name, 'ledger.json'));
        if (await fileSystem.readFile(path.join(root, name, 'initialized'), 'utf8') !== '1\n') throw safetyError();
        if ((await fileSystem.readdir(path.join(root, name))).some(n => !['ledger.json', 'initialized', ...(ownedTaskLocks ? ['.lock'] : [])].includes(n))) throw safetyError();
      }
    } catch { throw Object.assign(safetyError('task_store_missing'), { message: 'AI実行記録を安全に読み取れません。実行を停止しています。記録を削除せず確認してください。' }); }
  }
  async function activation() {
    try {
      await regular(fileSystem, dir, true);
      try { await fileSystem.lstat(path.join(dir, '.write-intent')); throw safetyError('persistence_uncertain'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const a = validateActivation(await readJson(fileSystem, file));
      if (await fileSystem.readFile(path.join(dir, 'initialized'), 'utf8') !== '1\n') throw safetyError();
      if ((await fileSystem.readdir(dir)).some(n => !['.lock', 'activation.json', 'initialized', realApprovalFile, realApprovalAnchor].includes(n))) throw safetyError();
      return a;
    } catch { throw safetyError('activation_required', 409); }
  }
  return {
    activation,
    async state() {
      return this.transaction(common => {
        assertNoInProgress(common.generation, common.extraction);
        return { activation: common.activation, realApproval: common.realApproval, effectivePolicy: common.effectivePolicy, totals: common.totals };
      });
    },
    async previewRealApproval(realStopMilliYen) {
      natural(realStopMilliYen); if (!realStopMilliYen) throw safetyError('invalid_real_stop', 400);
      return withStoreLocks(root, async snapshot => {
        const a = await activation(); await taskStoresPresent(true);
        if (a.policy.realStopMilliYen !== null || await readRealApproval(fileSystem, dir, a)) throw safetyError('real_already_enabled', 409);
        const g = await generationStore.read(); const e = await executionStore.read();
        generationAccounting(g); assertActivationBaseline(a, g); assertNoInProgress(g, e);
        if (g.runs.some(r => r.state === 'save-failed')) throw safetyError('generation_save_unresolved', 409);
        const { inspectSnapshot } = await import('../maintenance/integrity.js');
        if ((await inspectSnapshot(snapshot)).stopped) throw safetyError('real_approval_integrity', 409);
        const totals = aggregateBudget(g, e, now());
        const effectivePolicy = { ...a.policy, version: 'limited-real-v1', realStopMilliYen };
        checkCommonBudget(totals, effectivePolicy, false, 0);
        const body = Buffer.from(JSON.stringify({ expectedRevision: 0, activationHash: digest(a), snapshotHash: snapshotHash(snapshot),
          realStopMilliYen, expiresAt: now().getTime() + 15 * 60 * 1000 })).toString('base64url');
        return { token: `${body}.${sign(body)}`, activation: a, effectivePolicy, totals, realStopMilliYen, expectedRevision: 0 };
      }, fileSystem);
    },
    async enableReal(token, options = {}) {
      exact(options, ['confirm']); if (options.confirm !== true || typeof token !== 'string' || token.length > 2000) throw safetyError('real_approval_confirmation', 400);
      const [body, signature, extra] = token.split('.');
      if (!body || extra !== undefined || !/^[a-f0-9]{64}$/.test(signature || '') || !timingSafeEqual(Buffer.from(sign(body), 'hex'), Buffer.from(signature, 'hex'))) throw safetyError('real_approval_token', 409);
      let selection; try { selection = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { throw safetyError('real_approval_token', 409); }
      exact(selection, ['expectedRevision', 'activationHash', 'snapshotHash', 'realStopMilliYen', 'expiresAt']);
      if (selection.expectedRevision !== 0 || selection.expiresAt <= now().getTime()) throw safetyError('real_approval_expired', 409);
      return withStoreLocks(root, async snapshot => {
        const a = await activation(); await taskStoresPresent(true);
        if (a.policy.realStopMilliYen !== null || await readRealApproval(fileSystem, dir, a)) throw safetyError('real_already_enabled', 409);
        if (selection.activationHash !== digest(a) || selection.snapshotHash !== snapshotHash(snapshot)) throw safetyError('real_approval_conflict', 409);
        const g = await generationStore.read(); const e = await executionStore.read();
        generationAccounting(g); assertActivationBaseline(a, g); assertNoInProgress(g, e);
        if (g.runs.some(r => r.state === 'save-failed')) throw safetyError('generation_save_unresolved', 409);
        const { inspectSnapshot } = await import('../maintenance/integrity.js');
        if ((await inspectSnapshot(snapshot)).stopped) throw safetyError('real_approval_integrity', 409);
        const effectivePolicy = { ...a.policy, version: 'limited-real-v1', realStopMilliYen: selection.realStopMilliYen };
        checkCommonBudget(aggregateBudget(g, e, now()), effectivePolicy, false, 0);
        if (selection.expiresAt <= now().getTime()) throw safetyError('real_approval_expired', 409);
        const record = { schemaVersion: 1, revision: 1, expectedRevision: 0, activationHash: digest(a), activationRevision: a.revision,
          originalPolicyVersion: a.policy.version, originalPolicyHash: a.policyHash, realStopMilliYen: selection.realStopMilliYen,
          approvedAt: now().toISOString(), approval: 'human_explicit', effectivePolicy, effectivePolicyHash: digest(effectivePolicy), snapshotHash: selection.snapshotHash };
        record.recordHash = digest(record); validateRealApproval(record, a);
        // The immutable anchor is written first. Partial saves or loss of either file stop all new AI work.
        await durableWrite(fileSystem, path.join(dir, realApprovalAnchor), { schemaVersion: 1, revision: 1, activationHash: record.activationHash, recordHash: record.recordHash }, true);
        await durableWrite(fileSystem, path.join(dir, realApprovalFile), record, true);
        return readRealApproval(fileSystem, dir, a);
      }, fileSystem);
    },
    async activate(policy, options = {}) {
      exact(options, ['confirm', 'expectedRevision']); const { confirm, expectedRevision } = options;
      if (confirm !== true || expectedRevision !== 0) throw safetyError('activation_confirmation', 400);
      validatePolicy(policy);
      return locked(async () => {
        if ((await fileSystem.readdir(dir)).some(n => n !== '.lock')) throw safetyError('activation_exists_or_incomplete', 409);
        const missing = new Set();
        for (const name of ['generations', 'extraction-executions']) {
          try {
            await regular(fileSystem, path.join(root, name), true);
          } catch (e) { if (e.code === 'ENOENT') { missing.add(name); continue; } throw e; }
          await regular(fileSystem, path.join(root, name, 'ledger.json'));
          if (await fileSystem.readFile(path.join(root, name, 'initialized'), 'utf8') !== '1\n') throw safetyError('task_store_incomplete');
        }
        const g = await generationStore.read(); const e = await executionStore.read();
        generationAccounting(g); assertNoInProgress(g, e);
        if (e.executions.some(entry => entry.revisions.at(-1).attempt !== 'not_started' || entry.revisions.at(-1).budget.bookedMilliYen || entry.revisions.at(-1).budget.reservedMilliYen)) throw safetyError('extraction_before_activation');
        const initialBudget = aggregateBudget(g, e, now());
        for (const group of ['real', 'simulation']) if (initialBudget[group].bookedMilliYen || initialBudget[group].reservedMilliYen)
          checkCommonBudget(initialBudget, policy, group === 'simulation', 0);
        const a = validateActivation({ schemaVersion: 1, revision: 1, activatedAt: now().toISOString(), approval: 'human_explicit',
          policy: structuredClone(policy), policyHash: digest(policy), initialBudget, generationHash: digest(g), extractionHash: digest(e),
          initialGeneration: g.runs.map(r => ({ id: r.id, hash: generationAccountingHash(r) })) });
        // A marker without activation is deliberately unrecoverable by another activation attempt.
        await fileSystem.writeFile(path.join(dir, 'initialized'), '1\n', { flag: 'wx', mode: 0o600 });
        // Explicit activation establishes both empty-store anchors. Losing either store is not zero usage.
        if (missing.has('generations')) await generationStore.transaction(() => null);
        if (missing.has('extraction-executions')) await executionStore.initialize();
        await durableWrite(fileSystem, file, a, true); return a;
      });
    },
    async transaction(callback) {
      return locked(async () => {
        const a = await activation(); await taskStoresPresent(); const g = await generationStore.read(); const e = await executionStore.read();
        generationAccounting(g);
        assertActivationBaseline(a, g);
        const realApproval = await readRealApproval(fileSystem, dir, a);
        const effectivePolicy = realApproval ? realApproval.effectivePolicy : a.policy;
        const totals = aggregateBudget(g, e, now());
        return callback({ activation: a, realApproval, effectivePolicy, generation: g, extraction: e, totals,
          check(reservation, simulation, exclude = null) { assertNoInProgress(g, e, exclude); checkCommonBudget(totals, effectivePolicy, simulation, reservation); } });
      });
    },
  };
}
