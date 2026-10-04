import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, rmdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { validateOfferId } from '../offers/validation.js';
import { createCommitStore, commitStates, committedPlans } from './commit-store.js';
import { projectReflection, reflectionHash, offerBusiness, reflectionError, exactReflection } from './projection.js';

export function createReflectionService({ dataDirectory, importStore, offerStore, auditStore = createCommitStore(dataDirectory), now = () => new Date() }) {
  const secret = randomBytes(32);
  const sign = payload => createHmac('sha256', secret).update(payload).digest('hex');
  function token(value) {
    const payload = Buffer.from(JSON.stringify({ ...value, expires: now().getTime() + 15 * 60_000 })).toString('base64url');
    if (payload.length > 20000) throw reflectionError(400);
    return `${payload}.${sign(payload)}`;
  }
  function verify(raw, kind) {
    try {
      const [payload, signature, extra] = String(raw).split('.');
      if (extra || !payload || payload.length > 20000 || !/^[a-f0-9]{64}$/.test(signature || '') || !timingSafeEqual(Buffer.from(signature), Buffer.from(sign(payload)))) throw reflectionError(400);
      const value = JSON.parse(Buffer.from(payload, 'base64url').toString());
      if (value.kind !== kind || !Number.isSafeInteger(value.expires) || value.expires < now().getTime()) throw reflectionError(409);
      return value;
    } catch { throw reflectionError(409); }
  }
  async function withImportLock(id, operation) {
    validateOfferId(id);
    const directory = path.join(dataDirectory, 'offer-imports');
    const lock = path.join(directory, '.lock');
    try { if (!(await lstat(directory)).isDirectory()) throw reflectionError(503); }
    catch { throw reflectionError(503); }
    try { await mkdir(lock, { mode: 0o700 }); } catch (e) { throw reflectionError(e.code === 'EEXIST' ? 409 : 503); }
    try { return await operation(); }
    finally { try { await rmdir(lock); } catch { throw reflectionError(503); } }
  }
  function unresolved(ledger) { return commitStates(ledger).some(s => s.state === 'recovery_required'); }
  async function preview(importId, options) {
    exactReflection(options, ['offerId', 'conversions']);
    const ledger = await auditStore.read();
    if (unresolved(ledger)) throw reflectionError(409);
    const draft = await importStore.get(importId);
    const offer = await offerStore.get(options.offerId);
    const plan = projectReflection(draft, offer, options, committedPlans(ledger));
    return { plan, token: plan.mappings.length ? token({ kind: 'commit', id: randomUUID(), importId, options,
      importRevision: draft.revision, offerRevision: offer.revision, previewHash: reflectionHash(plan) }) : '' };
  }
  async function commit(raw, approval) {
    exactReflection(approval, ['approve']); if (approval.approve !== true) throw reflectionError(400);
    const checked = verify(raw, 'commit');
    return auditStore.transaction(async (ledger, append) => {
      if (unresolved(ledger) || ledger.events.some(e => e.type === 'intent' && e.id === checked.id)) throw reflectionError(409);
      return withImportLock(checked.importId, async () => {
        const draft = await importStore.get(checked.importId);
        const offer = await offerStore.get(checked.options.offerId);
        if (draft.revision !== checked.importRevision || offer.revision !== checked.offerRevision) throw reflectionError(409);
        const plan = projectReflection(draft, offer, checked.options, committedPlans(ledger));
        if (!plan.mappings.length || checked.previewHash !== reflectionHash(plan) || checked.expires < now().getTime()) throw reflectionError(409);
        const intent = { type: 'intent', id: checked.id, at: now().toISOString(), previewHash: checked.previewHash,
          plan, importSnapshot: draft, offerSnapshot: offer, options: checked.options };
        await append(intent); // Durable provenance before any offer write.
        let resultAttempted = false;
        try {
          const saved = await offerStore.update(offer.id, offer.revision, plan.input);
          if (saved.revision !== plan.nextRevision || !isDeepStrictEqual(offerBusiness(saved), plan.input)) throw reflectionError(503);
          resultAttempted = true;
          await append({ type: 'result', commitId: intent.id, at: now().toISOString(), outcome: 'committed', offerRevision: saved.revision, mode: 'save' });
          return { commitId: intent.id, offerId: saved.id, offerRevision: saved.revision };
        } catch {
          // If this marker cannot save, the durable unresolved intent itself requires recovery.
          // A failed result write may already have renamed the ledger. Never overwrite that
          // possibly committed result with a marker assembled from stale in-memory events.
          if (!resultAttempted) {
            try { await append({ type: 'recovery_required', commitId: intent.id, at: now().toISOString() }); } catch { /* stop */ }
          }
          throw reflectionError(503);
        }
      });
    });
  }
  async function inspect(intent) {
    const history = await offerStore.history(intent.plan.offerId);
    const target = history.find(o => o.revision === intent.plan.nextRevision);
    if (target && isDeepStrictEqual(offerBusiness(target), intent.plan.input)) return 'committed';
    const latest = history.at(-1);
    if (latest.revision === intent.offerSnapshot.revision && isDeepStrictEqual(latest, intent.offerSnapshot)) return 'not_applied';
    return null;
  }
  async function records(importId) {
    validateOfferId(importId);
    const ledger = await auditStore.read();
    const all = commitStates(ledger);
    const states = all.filter(s => s.intent.plan.importId === importId);
    const pending = states.find(s => s.state === 'recovery_required');
    let recovery = null;
    if (pending) {
      let outcome = null;
      try { outcome = await inspect(pending.intent); } catch { /* safely blocked */ }
      recovery = { outcome, token: outcome ? token({ kind: 'recover', id: pending.intent.id, importId,
        intentHash: reflectionHash(pending.intent), outcome }) : '' };
    }
    return { states, recovery, blockedBy: all.filter(s => s.state === 'recovery_required' && s.intent.plan.importId !== importId).map(s => s.intent.plan.importId) };
  }
  async function recover(raw, approval) {
    exactReflection(approval, ['approve']); if (approval.approve !== true) throw reflectionError(400);
    const checked = verify(raw, 'recover');
    return auditStore.transaction(async (ledger, append) => {
      const state = commitStates(ledger).find(s => s.intent.id === checked.id && s.intent.plan.importId === checked.importId);
      if (!state || state.state !== 'recovery_required' || reflectionHash(state.intent) !== checked.intentHash) throw reflectionError(409);
      return withImportLock(checked.importId, async () => {
        const outcome = await inspect(state.intent);
        if (!outcome || outcome !== checked.outcome) throw reflectionError(409);
        await append({ type: 'result', commitId: state.intent.id, at: now().toISOString(), outcome,
          offerRevision: outcome === 'committed' ? state.intent.plan.nextRevision : state.intent.plan.offerRevision, mode: 'recovery' });
        return outcome; // Never write/retry/rollback the offer during recovery.
      });
    });
  }
  return { preview, commit, records, recover };
}
