import { isDeepStrictEqual } from 'node:util';
import { validateExecution, validateExecutionLedger, transitionExecution } from './execution-contract.js';
import { validateExecutionAny as validateV2, validateExecutionLedgerAny as ledgerV2, transitionExecutionAny as transitionV2,
  eligibleReanalysisSource, sendBindingHash as bindingV2 } from './execution-v2-contract.js';
import { validateProfileSnapshot } from '../ai/extraction-profile-registry.js';
import { exact, digest, id, natural, timestamp, validHash, safetyError } from '../ai/safety-storage.js';

export const upgradeKind = 'configuration_upgrade_reextraction';
export const upgradeReason = 'configuration_change_validation_investigation';
export const parentLink = r => r.upgrade || r.reanalysis || null;
export function eligibleUpgradeSource(r) {
  eligibleReanalysisSource(r);
  if (r.error?.phase !== 'validation') throw safetyError('upgrade_not_allowed', 409);
}
function baseV1(r) {
  const { upgrade, profileSnapshot, reanalysis, ...base } = structuredClone(r); base.schemaVersion = 1;
  if (base.approval) { const { bindingHash, ...a } = base.approval; base.approval = a; }
  return base;
}
export function sendBindingHash(r) {
  if (r.schemaVersion !== 3) return bindingV2(r);
  return digest({ kind: upgradeKind, id: r.id, preparedRevision: 1, targetOffer: r.targetOffer, requestHash: r.requestHash,
    configuration: r.configuration, profileSnapshotHash: digest(r.profileSnapshot), inputArtifact: r.inputArtifact,
    estimate: r.estimate, lineageHash: r.upgrade.lineageHash });
}
export function validateExecutionAny(r) {
  if (r.schemaVersion !== 3) return validateV2(r);
  exact(r, [...Object.keys(baseV1(r)), 'upgrade', 'profileSnapshot']);
  validateExecution(baseV1(r)); validateProfileSnapshot(r.profileSnapshot, r);
  const a = r.upgrade;
  exact(a, ['kind', 'sourceExecutionId', 'sourceRevision', 'sourceHash', 'sourceConfigurationHash', 'sourceRequestHash',
    'destinationConfigurationHash', 'destinationRequestHash', 'reasonCode', 'operationId', 'preparationApproval', 'lineageHash']);
  if (a.kind !== upgradeKind || a.reasonCode !== upgradeReason || a.sourceExecutionId === r.id) throw safetyError('upgrade_lineage_invalid');
  id(a.sourceExecutionId); id(a.operationId); natural(a.sourceRevision); if (!a.sourceRevision) throw safetyError();
  for (const k of ['sourceHash', 'sourceConfigurationHash', 'sourceRequestHash', 'destinationConfigurationHash', 'destinationRequestHash', 'lineageHash']) validHash(a[k]);
  if (a.sourceConfigurationHash === a.destinationConfigurationHash || a.destinationConfigurationHash !== r.configuration.hash
      || a.destinationRequestHash !== r.requestHash) throw safetyError('upgrade_lineage_invalid');
  exact(a.preparationApproval, ['at', 'kind']); timestamp(a.preparationApproval.at);
  if (a.preparationApproval.kind !== 'human_explicit' || a.preparationApproval.at !== r.createdAt) throw safetyError();
  const { lineageHash, ...fields } = a;
  if (digest(fields) !== lineageHash) throw safetyError('upgrade_lineage_invalid');
  if (r.approval) {
    exact(r.approval, ['at', 'hash', 'revision', 'bindingHash']);
    if (r.approval.bindingHash !== sendBindingHash(r)) throw safetyError('approval_binding_invalid');
  }
  return structuredClone(r);
}
export function transitionExecutionAny(previous, revision, state, patch, at) {
  if (previous.schemaVersion !== 3) return transitionV2(previous, revision, state, patch, at);
  validateExecutionAny(previous);
  if (Object.keys(patch).some(k => ['upgrade', 'profileSnapshot', 'schemaVersion'].includes(k))) throw safetyError('invalid_transition', 409);
  const clean = structuredClone(patch);
  if (clean.approval) { const { bindingHash, ...approval } = clean.approval; clean.approval = approval; }
  const next = transitionExecution(baseV1(previous), revision, state, clean, at);
  return validateExecutionAny({ ...next, schemaVersion: 3, upgrade: previous.upgrade, profileSnapshot: previous.profileSnapshot,
    approval: patch.approval || previous.approval });
}
export function validateExecutionLedgerAny(ledger) {
  if (ledger.schemaVersion !== 3) return ledgerV2(ledger);
  exact(ledger, ['schemaVersion', 'executions']); if (!Array.isArray(ledger.executions)) throw safetyError();
  const ids = new Map(), operations = new Set(), childSources = new Set(), pairs = new Set();
  for (const entry of ledger.executions) {
    exact(entry, ['revisions']); if (!Array.isArray(entry.revisions) || !entry.revisions.length) throw safetyError();
    const first = validateExecutionAny(entry.revisions[0]);
    validateExecutionLedger({ schemaVersion: 1, executions: [{ revisions: entry.revisions.map(baseV1) }] });
    for (let i = 1; i < entry.revisions.length; i++) {
      const prev = entry.revisions[i - 1], next = validateExecutionAny(entry.revisions[i]);
      if (next.schemaVersion !== first.schemaVersion || !isDeepStrictEqual(next.reanalysis, first.reanalysis) || !isDeepStrictEqual(next.upgrade, first.upgrade)
          || !isDeepStrictEqual(next.profileSnapshot, first.profileSnapshot)) throw safetyError();
      const fields = ['approval','startedAt','endedAt','attempt','responseHash','validatedArtifact','plannedImport','savedImport','error','unknownReason','recoveryRequired','budget'];
      const patch = Object.fromEntries(fields.filter(k => !isDeepStrictEqual(prev[k], next[k])).map(k => [k, next[k]]));
      if (!isDeepStrictEqual(transitionExecutionAny(prev, prev.revision, next.state, patch, next.updatedAt), next)) throw safetyError();
    }
    if (ids.has(first.id)) throw safetyError('duplicate_request');
    const link = parentLink(first);
    if (!link) {
      if ([...ids.values()].some(e => e.latest.requestHash === first.requestHash || e.latest.fingerprint === first.fingerprint)) throw safetyError('duplicate_request');
    } else {
      const source = ids.get(link.sourceExecutionId)?.latest;
      if (!source) throw safetyError('lineage_source_missing');
      if (operations.has(link.operationId) || childSources.has(link.sourceExecutionId)) throw safetyError('lineage_invalid');
      if (first.schemaVersion === 3) {
        eligibleUpgradeSource(source);
        const pair = `${source.id}:${first.configuration.hash}`;
        if (pairs.has(pair) || source.revision !== link.sourceRevision || digest(source) !== link.sourceHash
            || link.sourceConfigurationHash !== source.configuration.hash || link.sourceRequestHash !== source.requestHash
            || first.createdAt < source.updatedAt || first.inputArtifact.id === source.inputArtifact.id
            || first.inputArtifact.hash !== source.inputArtifact.hash || first.fingerprint !== source.fingerprint
            || !isDeepStrictEqual(first.targetOffer, source.targetOffer) || !isDeepStrictEqual(first.documents, source.documents)
            || first.provider !== source.provider) throw safetyError('upgrade_lineage_invalid');
        for (let p = source; p; p = parentLink(p) ? ids.get(parentLink(p).sourceExecutionId)?.latest : null) {
          if (p.configuration.hash === first.configuration.hash) throw safetyError('upgrade_configuration_repeated');
        }
        pairs.add(pair);
      } else {
        // v2 is unchanged: same configuration/estimate/request, even when its parent is v3.
        eligibleReanalysisSource(source);
        if (source.revision !== link.sourceRevision || digest(source) !== link.sourceHash || first.createdAt < source.updatedAt
            || first.fingerprint !== source.fingerprint || first.inputArtifact.hash !== source.inputArtifact.hash
            || first.inputArtifact.id === source.inputArtifact.id || !isDeepStrictEqual(first.targetOffer, source.targetOffer)
            || !isDeepStrictEqual(first.configuration, source.configuration) || !isDeepStrictEqual(first.estimate, source.estimate)
            || first.requestHash !== source.requestHash || !isDeepStrictEqual(first.documents, source.documents)
            || first.provider !== source.provider || first.model !== source.model) throw safetyError('lineage_invalid');
      }
      operations.add(link.operationId); childSources.add(link.sourceExecutionId);
    }
    ids.set(first.id, { entry, latest: entry.revisions.at(-1) });
  }
  return structuredClone(ledger);
}
