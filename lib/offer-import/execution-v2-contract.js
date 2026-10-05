import { isDeepStrictEqual } from 'node:util';
import { validateExecution, validateExecutionLedger, transitionExecution } from './execution-contract.js';
import { exact, digest, id, natural, timestamp, validHash, safetyError } from '../ai/safety-storage.js';

export const reanalysisReason = 'validation_failure_investigation';
export function eligibleReanalysisSource(r) {
  if (r.state !== 'failed_after_request' || r.attempt !== 'response_received' || r.budget.state !== 'settled'
      || !r.budget.usage || r.budget.reservedMilliYen !== 0 || r.recoveryRequired || r.unknownReason
      || r.validatedArtifact || r.plannedImport || r.savedImport) throw safetyError('reanalysis_not_allowed', 409);
}
export function sendBindingHash(r) {
  return digest({ id: r.id, preparedRevision: 1, targetOffer: r.targetOffer, requestHash: r.requestHash,
    configuration: r.configuration, inputArtifact: r.inputArtifact, estimate: r.estimate, lineageHash: r.reanalysis?.lineageHash || null });
}
function v1(r) {
  const { reanalysis, ...base } = structuredClone(r); base.schemaVersion = 1;
  if (base.approval) { const { bindingHash, ...approval } = base.approval; base.approval = approval; }
  return base;
}
export function validateExecutionAny(r) {
  if (r.schemaVersion === 1) return validateExecution(r);
  if (r.schemaVersion !== 2) throw safetyError();
  validateExecution(v1(r));
  const a = r.reanalysis;
  exact(a, ['sourceExecutionId', 'sourceRevision', 'sourceHash', 'reasonCode', 'operationId', 'preparationApproval', 'lineageHash']);
  id(a.sourceExecutionId); id(a.operationId); natural(a.sourceRevision); if (!a.sourceRevision) throw safetyError();
  validHash(a.sourceHash); validHash(a.lineageHash);
  if (a.reasonCode !== reanalysisReason || a.sourceExecutionId === r.id) throw safetyError();
  exact(a.preparationApproval, ['at', 'kind']); timestamp(a.preparationApproval.at);
  if (a.preparationApproval.kind !== 'human_explicit' || a.preparationApproval.at !== r.createdAt) throw safetyError();
  const { lineageHash, ...body } = a;
  if (lineageHash !== digest(body)) throw safetyError('lineage_invalid');
  if (r.approval) {
    exact(r.approval, ['at', 'hash', 'revision', 'bindingHash']); validHash(r.approval.bindingHash);
    if (r.approval.bindingHash !== sendBindingHash(r)) throw safetyError('approval_binding_invalid');
  }
  return structuredClone(r);
}
export function transitionExecutionAny(previous, revision, state, patch, at) {
  if (previous.schemaVersion === 1) return transitionExecution(previous, revision, state, patch, at);
  validateExecutionAny(previous);
  const cleanPatch = structuredClone(patch);
  if (Object.keys(cleanPatch).some(k => ['reanalysis', 'schemaVersion'].includes(k))) throw safetyError('invalid_transition',409);
  if (cleanPatch.approval) { const { bindingHash, ...a } = cleanPatch.approval; cleanPatch.approval = a; }
  const next = transitionExecution(v1(previous), revision, state, cleanPatch, at);
  if (patch.approval) next.approval = structuredClone(patch.approval);
  else next.approval = structuredClone(previous.approval);
  return validateExecutionAny({ ...next, schemaVersion: 2, reanalysis: previous.reanalysis });
}
export function validateExecutionLedgerAny(ledger) {
  if (ledger.schemaVersion === 1) return validateExecutionLedger(ledger);
  exact(ledger, ['schemaVersion', 'executions']); if (ledger.schemaVersion !== 2 || !Array.isArray(ledger.executions)) throw safetyError();
  const ids = new Map(); const operations = new Set(); const children = new Set();
  const roots = [];
  for (const entry of ledger.executions) {
    exact(entry, ['revisions']); if (!Array.isArray(entry.revisions) || !entry.revisions.length) throw safetyError();
    const first = validateExecutionAny(entry.revisions[0]);
    // Reuse every v1 state/history invariant, independently; duplicates need the v2 lineage proof below.
    validateExecutionLedger({ schemaVersion: 1, executions: [{ revisions: entry.revisions.map(r => r.schemaVersion === 2 ? v1(r) : r) }] });
    for (let i = 1; i < entry.revisions.length; i++) {
      const prev = entry.revisions[i-1], next = validateExecutionAny(entry.revisions[i]);
      if (next.schemaVersion !== first.schemaVersion || !isDeepStrictEqual(next.reanalysis, first.reanalysis)) throw safetyError();
      const fields = ['approval','startedAt','endedAt','attempt','responseHash','validatedArtifact','plannedImport','savedImport','error','unknownReason','recoveryRequired','budget'];
      const patch = Object.fromEntries(fields.filter(k => !isDeepStrictEqual(prev[k],next[k])).map(k => [k,next[k]]));
      if (!isDeepStrictEqual(transitionExecutionAny(prev,prev.revision,next.state,patch,next.updatedAt),next)) throw safetyError();
    }
    const latest = entry.revisions.at(-1);
    if (ids.has(first.id)) throw safetyError('duplicate_request');
    if (first.schemaVersion === 1) {
      if (roots.some(r => r.requestHash === first.requestHash || r.fingerprint === first.fingerprint)) throw safetyError('duplicate_request');
      // A normal entry can never bypass duplicates against a previous reanalysis either.
      if ([...ids.values()].some(r => r.requestHash === first.requestHash || r.fingerprint === first.fingerprint)) throw safetyError('duplicate_request');
      roots.push(first);
    } else {
      const a = first.reanalysis, source = ids.get(a.sourceExecutionId);
      if (!source) throw safetyError('lineage_source_missing');
      eligibleReanalysisSource(source);
      if (source.revision !== a.sourceRevision || digest(source) !== a.sourceHash || first.createdAt < source.updatedAt
          || first.fingerprint !== source.fingerprint || first.inputArtifact.hash !== source.inputArtifact.hash
          || first.inputArtifact.id === source.inputArtifact.id || !isDeepStrictEqual(first.targetOffer,source.targetOffer)
          || !isDeepStrictEqual(first.configuration,source.configuration) || !isDeepStrictEqual(first.estimate,source.estimate)
          || first.requestHash !== source.requestHash || !isDeepStrictEqual(first.documents,source.documents) || first.provider !== source.provider || first.model !== source.model
          || operations.has(a.operationId) || children.has(a.sourceExecutionId)) throw safetyError('lineage_invalid');
      operations.add(a.operationId); children.add(a.sourceExecutionId);
    }
    ids.set(first.id, latest);
  }
  return structuredClone(ledger);
}
