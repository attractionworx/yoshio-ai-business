import { assertProcessingContractAny as assertProcessingContract, executionVersionForProcessing } from '../offer-import/processing-registry.js';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { extractionProfile, profileConfiguration, deepFreeze } from './extraction-profile.js';
import { buildExtractionPayload, estimateExtractionInput } from './extraction-payload.js';
import { digest, bytesHash, exact, rejectSecrets, safetyError } from './safety-storage.js';

// Exact, verified release snapshots. Never infer a profile from a hash, execute snapshot code,
// read credentials, or register profiles from live records. Hashes are change detection, not signatures.
const releases = [
  ['original-v1', 'ab7d7f17833f3852d744cdc8510cd1f71ec3b2a6b7776c6e66bcd4134d3577c8'],
  ['candidate-contract-v1', '04921ad84e91f89884d267da60b28681c8ed40a66464c46ae48b5e447ccd3591'],
  ['quote-contract-v1', '2566d6ab4bf7e40c8bde719c2a01b8ca8d67e0981b8b77c830d5b09e88efa5d9'],
  ['local-quote-v2', 'ba821e7ed4e0267a47b50ea3d5b068adce686f9d2ad0149b92d92cf24f7f1f49'],
  ['local-quote-fixed-mapping-v2', '36109bd6e756c54e7046e4a1dcd123f2ecc302bb70a3ed71f9bfa5197907ee92'],
  ['target-variants-v3', '25cd89f262b5c3983a6938bd0a41b93f7b9cddf9857f8aadde0b9ef9825b20dc'],
  ['unique-quote-selection-v3', '95e693612ab03ec41f6d3f761ad7f7389761482156433d13bd49dab44a86b36d'],
];
export const historicalExtractionProfiles = deepFreeze(releases.map(([name, hash]) => {
  const profile = JSON.parse(readFileSync(new URL(`./extraction-profiles/${name}.json`, import.meta.url), 'utf8'));
  rejectSecrets(profile);
  if (digest(profile) !== hash) throw safetyError('historical_profile_invalid');
  return profile;
}));
const knownProfiles = () => [...historicalExtractionProfiles, extractionProfile];
function fullConfiguration(profile) { const c = profileConfiguration(profile); return { ...c, hash: digest(c) }; }
export function validateProfileSnapshot(snapshot, record) {
  exact(snapshot, ['schemaVersion', 'profile']);
  if (![1, 2, 3].includes(snapshot.schemaVersion)) throw safetyError('historical_profile_invalid');
  if (record.schemaVersion !== undefined && snapshot.schemaVersion >= 2 && record.schemaVersion !== (snapshot.schemaVersion === 2 ? 4 : 5)) throw safetyError('historical_profile_invalid');
  rejectSecrets(snapshot);
  const p = snapshot.profile;
  if (snapshot.schemaVersion >= 2) {
    assertProcessingContract(p.processingContract);
    if (snapshot.schemaVersion !== (executionVersionForProcessing(p.processingContract) === 4 ? 2 : 3)) throw safetyError('historical_profile_invalid');
  }
  else if (p.processingContract) throw safetyError('historical_profile_invalid');
  if (record.provider === 'fake') {
    exact(p, ['provider', 'model', 'configuration', 'instructions', 'estimatorVersion', ...(snapshot.schemaVersion >= 2 ? ['processingContract'] : [])]);
    if (p.provider !== 'fake' || p.model !== 'fake-extraction-v1' || p.model !== record.model
        || typeof p.instructions !== 'string' || !p.instructions.length || p.instructions.length > 100000 || bytesHash(p.instructions) !== record.configuration.promptHash
        || !isDeepStrictEqual(p.configuration, record.configuration) || p.estimatorVersion !== 'simulation-input-utf8-v1') throw safetyError('historical_profile_invalid');
  } else {
    const trusted = knownProfiles().find(v => digest(v) === digest(p));
    if (!trusted || p.provider !== 'openai' || p.model !== record.model || !isDeepStrictEqual(fullConfiguration(p), record.configuration)) throw safetyError('historical_profile_unknown');
  }
  return structuredClone(snapshot);
}
export function extractionProfileSnapshot(configuration, provider, model, instructions, processing = null) {
  const contract = processing || (provider === 'openai' ? extractionProfile.processingContract : null);
  const snapshot = { schemaVersion: contract ? (executionVersionForProcessing(contract) === 4 ? 2 : 3) : 1, profile: provider === 'openai' ? structuredClone(extractionProfile)
    : { provider, model, configuration: structuredClone(configuration), instructions, estimatorVersion: 'simulation-input-utf8-v1', ...(processing ? { processingContract: structuredClone(processing) } : {}) } };
  validateProfileSnapshot(snapshot, { configuration, provider, model });
  return snapshot;
}
export function resolveAuditProfile(record) {
  if (record.profileSnapshot) return validateProfileSnapshot(record.profileSnapshot, record).profile;
  if (record.provider === 'fake') return null; // Legacy simulation has no real outbound request/profile.
  const profile = knownProfiles().find(p => p.model === record.model && isDeepStrictEqual(fullConfiguration(p), record.configuration));
  if (!profile) throw safetyError('historical_profile_unknown');
  if (profile.processingContract && record.schemaVersion !== undefined && record.schemaVersion !== executionVersionForProcessing(profile.processingContract)) throw safetyError('historical_profile_invalid');
  return profile;
}
export function auditExtractionInput(record, input) {
  const profile = resolveAuditProfile(record);
  let payload = null; let inputTokens;
  if (record.provider === 'openai') {
    // Version and pinned source digest select this pure builder, never code supplied by a snapshot.
    const compatible = historicalExtractionProfiles[0];
    if (profile.builderVersion !== 'canonical-request-v1' || profile.builderHash !== compatible.builderHash
        || bytesHash(readFileSync(new URL('./extraction-payload.js', import.meta.url))) !== profile.builderHash
        || profile.estimator.version !== 'request-utf8-x2-plus8192-v1'
        || profile.estimator.byteMultiplier !== 2 || profile.estimator.overheadTokens !== 8192) throw safetyError('historical_builder_unknown');
    payload = buildExtractionPayload(input, profile);
    inputTokens = estimateExtractionInput(payload, profile).inputTokens;
  } else {
    inputTokens = Buffer.byteLength(JSON.stringify(input));
    if (profile) payload = { input, prompt: profile.instructions, configuration: record.configuration };
  }
  if (inputTokens !== record.estimate.inputTokens || inputTokens > record.configuration.maxInputTokens) throw safetyError('estimate_binding_mismatch');
  return { profile, payload, inputTokens };
}
