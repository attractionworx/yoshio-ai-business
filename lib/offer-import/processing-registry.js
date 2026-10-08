import * as v1 from './evidence-resolution.js';
import * as v2 from './evidence-resolution-v2.js';
import { safetyError } from '../ai/safety-storage.js';

// Only application-owned implementations. Never execute code from stored snapshots.
function implementation(contract) {
  const impl = contract?.version === 'quote-resolution-v1' ? v1
    : contract?.version === 'quote-resolution-v2' ? v2 : null;
  if (!impl) throw safetyError('processing_contract_invalid');
  impl.assertProcessingContract(contract); // All version and implementation/schema hashes must match.
  return impl;
}
export function assertProcessingContractAny(contract) { implementation(contract); }
export function executionVersionForProcessing(contract) { implementation(contract); return contract.version === 'quote-resolution-v1' ? 4 : 5; }
export function resolveEvidenceAny(wire, documents, contract) { return implementation(contract).resolveEvidence(wire, documents, contract); }
export function auditResolvedResultAny(record, input, artifact) {
  if (executionVersionForProcessing(record.processingContract) !== record.schemaVersion) throw safetyError('processing_contract_invalid');
  return implementation(record.processingContract).auditResolvedResult(record, input, artifact);
}
export const makeResultBinding = v1.makeResultBinding;
