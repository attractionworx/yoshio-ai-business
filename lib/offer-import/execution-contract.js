import { isDeepStrictEqual } from 'node:util';
import { exact, digest, id, timestamp, validHash, natural, privateText, safetyError } from '../ai/safety-storage.js';

export const executionStates = Object.freeze(['prepared', 'approved', 'sending', 'response_received', 'validated', 'import_saving', 'import_save_failed', 'succeeded', 'failed_before_request', 'failed_after_request', 'unknown', 'recovery_required']);
export const documentMetadata = documents => documents.map(d => ({ id: d.id, label: d.label, kind: d.kind, versionLabel: d.versionLabel, bodyHash: d.textHash, bytes: Buffer.byteLength(d.text) }));
export const requestDigest = (inputHash, configuration, provider = 'fake', model = 'fake-extraction-v1') => digest({ inputHash, configuration, provider, model });
export const materialFingerprint = (targetOffer, documents) => digest({ targetOffer, documents: documents.map(d => ({ bodyHash: d.textHash, kind: d.kind, label: d.label, versionLabel: d.versionLabel })).sort((a, b) => digest(a).localeCompare(digest(b))) });
export const transitions = Object.freeze({
  prepared: ['approved', 'failed_before_request'], approved: ['sending', 'failed_before_request'],
  sending: ['response_received', 'unknown'], response_received: ['validated', 'failed_after_request', 'recovery_required'],
  validated: ['import_saving', 'recovery_required'], import_saving: ['succeeded', 'import_save_failed', 'recovery_required'],
  import_save_failed: ['import_saving', 'recovery_required'], recovery_required: ['succeeded', 'import_saving'],
  succeeded: [], failed_before_request: [], failed_after_request: [], unknown: [],
});
const immutable = ['schemaVersion', 'id', 'createdAt', 'targetOffer', 'documents', 'inputArtifact', 'requestHash', 'fingerprint', 'provider', 'model', 'configuration', 'estimate'];
const mutable = ['approval', 'startedAt', 'endedAt', 'attempt', 'responseHash', 'validatedArtifact', 'plannedImport', 'savedImport', 'error', 'unknownReason', 'recoveryRequired', 'budget'];
const keys = [...immutable, ...mutable, 'revision', 'updatedAt', 'state'];
const nullable = (value, check) => { if (value !== null) check(value); };
export function artifactReference(v) { exact(v, ['id', 'hash', 'bytes']); id(v.id); validHash(v.hash); natural(v.bytes); }
function budget(v) {
  exact(v, ['state', 'month', 'reservedMilliYen', 'bookedMilliYen', 'usage']);
  if (!['none', 'reserved', 'settled', 'unknown'].includes(v.state) || !/^\d{4}-\d{2}$/.test(v.month)) throw safetyError();
  natural(v.reservedMilliYen); natural(v.bookedMilliYen);
  nullable(v.usage, u => { exact(u, ['inputTokens', 'outputTokens']); natural(u.inputTokens); natural(u.outputTokens); });
  if (v.state === 'none' && (v.bookedMilliYen || v.usage !== null)) throw safetyError();
  if (['none', 'settled'].includes(v.state) && v.reservedMilliYen !== 0) throw safetyError();
}
export function validateExecution(v) {
  exact(v, keys); if (v.schemaVersion !== 1 || !executionStates.includes(v.state)) throw safetyError();
  id(v.id); natural(v.revision); if (v.revision < 1) throw safetyError(); timestamp(v.createdAt); timestamp(v.updatedAt);
  if (v.updatedAt < v.createdAt) throw safetyError();
  exact(v.targetOffer, ['id', 'revision']); id(v.targetOffer.id); natural(v.targetOffer.revision); if (!v.targetOffer.revision) throw safetyError();
  if (!Array.isArray(v.documents) || !v.documents.length || v.documents.length > 20 || new Set(v.documents.map(d => d.id)).size !== v.documents.length) throw safetyError();
  for (const d of v.documents) { exact(d, ['id', 'label', 'kind', 'versionLabel', 'bodyHash', 'bytes']); privateText(d.id); privateText(d.label); nullable(d.versionLabel, privateText); validHash(d.bodyHash); natural(d.bytes); if (!['asp_material', 'advertiser_material', 'user_provided'].includes(d.kind)) throw safetyError(); }
  artifactReference(v.inputArtifact); validHash(v.requestHash); validHash(v.fingerprint);
  // Provider identity is archival metadata; it never authorizes a connection without a registered service/profile.
  if (!['fake', 'openai'].includes(v.provider)) throw safetyError();
  privateText(v.model); if (v.provider === 'fake' && v.model !== 'fake-extraction-v1') throw safetyError();
  exact(v.configuration, ['version', 'hash', 'promptVersion', 'promptHash', 'schemaVersion', 'schemaHash', 'maxInputTokens', 'maxOutputTokens', 'inputMilliYenPerMillion', 'outputMilliYenPerMillion', 'timeoutMs']);
  privateText(v.configuration.version); privateText(v.configuration.promptVersion);
  for (const k of ['hash', 'promptHash', 'schemaHash']) validHash(v.configuration[k]);
  for (const k of ['schemaVersion', 'maxInputTokens', 'maxOutputTokens', 'inputMilliYenPerMillion', 'outputMilliYenPerMillion', 'timeoutMs']) natural(v.configuration[k]);
  if (v.configuration.schemaVersion !== 1 || !v.configuration.timeoutMs || !v.configuration.maxInputTokens || !v.configuration.maxOutputTokens) throw safetyError();
  const { hash: ignored, ...config } = v.configuration; if (v.configuration.hash !== digest(config)) throw safetyError();
  if (v.requestHash !== requestDigest(v.inputArtifact.hash, v.configuration, v.provider, v.model)
      || v.fingerprint !== materialFingerprint(v.targetOffer, v.documents.map(d => ({ ...d, textHash: d.bodyHash })))) throw safetyError();
  exact(v.estimate, ['inputBytes', 'inputTokens', 'estimatedMilliYen', 'maximumReservedMilliYen']); for (const n of Object.values(v.estimate)) natural(n);
  const charge = u => {
    const n = BigInt(u.inputTokens) * BigInt(v.configuration.inputMilliYenPerMillion) + BigInt(u.outputTokens) * BigInt(v.configuration.outputMilliYenPerMillion);
    const result = (n + 999999n) / 1000000n; if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw safetyError(); return Number(result);
  };
  if (v.estimate.maximumReservedMilliYen !== charge({ inputTokens: v.configuration.maxInputTokens, outputTokens: v.configuration.maxOutputTokens })
      || !v.estimate.maximumReservedMilliYen || v.estimate.inputBytes !== v.inputArtifact.bytes || v.estimate.inputTokens > v.configuration.maxInputTokens) throw safetyError();
  if (v.estimate.estimatedMilliYen !== charge({ inputTokens: v.estimate.inputTokens, outputTokens: v.configuration.maxOutputTokens })) throw safetyError();
  nullable(v.approval, a => { exact(a, ['at', 'hash', 'revision']); timestamp(a.at); validHash(a.hash); natural(a.revision); if (a.hash !== v.requestHash || a.revision !== 1 || a.at < v.createdAt || a.at > v.updatedAt) throw safetyError(); });
  for (const k of ['startedAt', 'endedAt']) nullable(v[k], timestamp);
  if (v.startedAt && (v.startedAt < (v.approval?.at || v.createdAt) || v.startedAt > v.updatedAt)) throw safetyError();
  if (v.endedAt && (v.endedAt < (v.startedAt || v.createdAt) || v.endedAt > v.updatedAt)) throw safetyError();
  if (!['not_started', 'may_have_started', 'response_received'].includes(v.attempt)) throw safetyError();
  nullable(v.responseHash, validHash); nullable(v.validatedArtifact, artifactReference);
  nullable(v.plannedImport, p => { exact(p, ['id', 'contentHash']); id(p.id); validHash(p.contentHash); });
  nullable(v.savedImport, p => { exact(p, ['id', 'revision', 'hash']); id(p.id); if (p.revision !== 1 || p.id !== v.plannedImport?.id) throw safetyError(); validHash(p.hash); });
  nullable(v.error, e => { exact(e, ['code', 'phase']); for (const s of Object.values(e)) if (typeof s !== 'string' || !/^[a-z_]{1,60}$/.test(s)) throw safetyError(); });
  nullable(v.unknownReason, r => { if (typeof r !== 'string' || !/^[a-z_]{1,60}$/.test(r)) throw safetyError(); });
  if (typeof v.recoveryRequired !== 'boolean') throw safetyError(); budget(v.budget);
  if (v.budget.reservedMilliYen > v.estimate.maximumReservedMilliYen) throw safetyError();
  if (v.budget.usage && (v.budget.usage.inputTokens > v.configuration.maxInputTokens || v.budget.usage.outputTokens > v.configuration.maxOutputTokens
      || v.budget.bookedMilliYen !== charge(v.budget.usage))) throw safetyError();
  if (['reserved', 'unknown'].includes(v.budget.state) && (v.budget.usage || v.budget.bookedMilliYen)) throw safetyError();
  if (v.budget.month !== (v.startedAt || v.approval?.at || v.createdAt).slice(0, 7)) throw safetyError();
  if (['prepared', 'approved', 'failed_before_request'].includes(v.state)) {
    if (v.attempt !== 'not_started' || v.startedAt || v.responseHash || v.validatedArtifact || v.plannedImport || v.savedImport) throw safetyError();
  } else if (v.attempt === 'not_started' || !v.startedAt || !v.approval) throw safetyError();
  if (v.state !== 'prepared' && v.state !== 'failed_before_request' && !v.approval) throw safetyError();
  if (v.state === 'prepared' && (v.approval || v.budget.state !== 'none')) throw safetyError();
  if (['approved', 'sending'].includes(v.state) && (v.budget.state !== 'reserved' || v.budget.reservedMilliYen !== v.estimate.maximumReservedMilliYen)) throw safetyError();
  if (['response_received', 'validated', 'import_saving', 'import_save_failed', 'succeeded', 'failed_after_request'].includes(v.state)
      && (v.attempt !== 'response_received' || !v.responseHash || v.budget.state !== 'settled' || !v.budget.usage)) throw safetyError();
  if (['validated', 'import_saving', 'import_save_failed', 'succeeded'].includes(v.state) && !v.validatedArtifact) throw safetyError();
  if (['import_saving', 'import_save_failed', 'succeeded'].includes(v.state) && !v.plannedImport) throw safetyError();
  if (v.state === 'succeeded' && (!v.savedImport || !v.endedAt || v.recoveryRequired)) throw safetyError();
  if (v.state !== 'succeeded' && v.savedImport) throw safetyError();
  if (v.state === 'unknown' && (!v.unknownReason || !v.recoveryRequired || v.budget.state !== 'unknown' || v.budget.reservedMilliYen !== v.estimate.maximumReservedMilliYen)) throw safetyError();
  if (v.state === 'recovery_required' && !v.recoveryRequired) throw safetyError();
  if (['failed_before_request', 'failed_after_request'].includes(v.state) && (!v.error || !v.endedAt || v.budget.reservedMilliYen)) throw safetyError();
  return structuredClone(v);
}
const patches = {
  approved: ['approval', 'budget'], sending: ['startedAt', 'attempt', 'budget'],
  response_received: ['responseHash', 'attempt', 'budget'], validated: ['validatedArtifact', 'plannedImport'],
  import_saving: ['plannedImport', 'recoveryRequired', 'error'], import_save_failed: ['error', 'recoveryRequired'],
  succeeded: ['savedImport', 'endedAt', 'recoveryRequired', 'error'],
  failed_before_request: ['error', 'endedAt', 'budget'], failed_after_request: ['error', 'endedAt'],
  unknown: ['error', 'unknownReason', 'recoveryRequired', 'budget', 'endedAt'], recovery_required: ['error', 'recoveryRequired'],
};
export function transitionExecution(previous, expectedRevision, state, patch, at) {
  validateExecution(previous);
  if (previous.revision !== expectedRevision) throw safetyError('revision_conflict', 409);
  if (!transitions[previous.state].includes(state) || !patch || Object.keys(patch).some(k => !patches[state].includes(k))) throw safetyError('invalid_transition', 409);
  timestamp(at); if (at < previous.updatedAt) throw safetyError();
  const next = validateExecution({ ...previous, ...structuredClone(patch), state, revision: previous.revision + 1, updatedAt: at });
  if (previous.plannedImport && !isDeepStrictEqual(previous.plannedImport, next.plannedImport)) throw safetyError();
  if (previous.approval && !isDeepStrictEqual(previous.approval, next.approval)) throw safetyError();
  if (previous.responseHash && previous.responseHash !== next.responseHash) throw safetyError();
  return next;
}
export function validateExecutionLedger(ledger) {
  exact(ledger, ['schemaVersion', 'executions']); if (ledger.schemaVersion !== 1 || !Array.isArray(ledger.executions)) throw safetyError();
  const ids = new Set(); const hashes = new Set(); const prints = new Set();
  for (const entry of ledger.executions) {
    exact(entry, ['revisions']); if (!Array.isArray(entry.revisions) || !entry.revisions.length) throw safetyError();
    const first = validateExecution(entry.revisions[0]);
    if (first.state !== 'prepared' || first.revision !== 1 || first.createdAt !== first.updatedAt || first.recoveryRequired || first.error || first.unknownReason || first.endedAt) throw safetyError();
    if (ids.has(first.id) || hashes.has(first.requestHash) || prints.has(first.fingerprint)) throw safetyError('duplicate_request');
    ids.add(first.id); hashes.add(first.requestHash); prints.add(first.fingerprint);
    for (let i = 1; i < entry.revisions.length; i++) {
      const prev = entry.revisions[i - 1]; const next = validateExecution(entry.revisions[i]);
      const patch = Object.fromEntries(mutable.filter(k => !isDeepStrictEqual(prev[k], next[k])).map(k => [k, next[k]]));
      if (!isDeepStrictEqual(transitionExecution(prev, prev.revision, next.state, patch, next.updatedAt), next)) throw safetyError();
    }
  }
  return structuredClone(ledger);
}
