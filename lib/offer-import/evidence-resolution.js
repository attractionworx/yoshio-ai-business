import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { digest, bytesHash, exact, rejectSecrets, safetyError } from '../ai/safety-storage.js';
import { validateExtraction } from './validation.js';
const wireBytes = readFileSync(new URL('../../schemas/regulation-extraction-wire-v2.schema.json', import.meta.url));
const internalBytes = readFileSync(new URL('../../schemas/regulation-extraction.schema.json', import.meta.url));
export const evidenceWireSchema = JSON.parse(wireBytes);
const internalSchema = JSON.parse(internalBytes);
export function processingContract() {
  return { version: 'quote-resolution-v1', wireSchemaVersion: 2, wireSchemaHash: bytesHash(wireBytes),
    internalSchemaVersion: 1, internalSchemaHash: bytesHash(internalBytes),
    resolverVersion: 'block-exact-unique-utf16-v1', inverseVersion: 'strip-offsets-wire-v2-v1',
    algorithmHash: bytesHash(readFileSync(new URL('./evidence-resolution.js', import.meta.url))),
    validatorHash: bytesHash(readFileSync(new URL('./validation.js', import.meta.url))) };
}
export function assertProcessingContract(value) {
  if (!isDeepStrictEqual(value, processingContract())) throw safetyError('processing_contract_invalid');
}
const fail = code => { throw safetyError(code, 400); };
// Only the fixed extraction contracts, not a general JSON Schema implementation.
function check(value, rule, schema) {
  if (rule.$ref) return check(value, schema.$defs[rule.$ref.split('/').at(-1)], schema);
  if (rule.anyOf) { for (const branch of rule.anyOf) { try { check(value, branch, schema); return; } catch {} } fail('validation_wire_schema'); }
  if ('const' in rule && value !== rule.const || rule.enum && !rule.enum.includes(value)) fail('validation_wire_schema');
  if (rule.type === 'object') {
    try { exact(value, rule.required); } catch { fail('validation_wire_schema'); }
    for (const [key, child] of Object.entries(rule.properties)) check(value[key], child, schema);
  }
  if (rule.type === 'array') {
    if (!Array.isArray(value) || value.length < rule.minItems || value.length > rule.maxItems) fail('validation_wire_schema');
    for (const child of value) check(child, rule.items, schema);
  }
  if (rule.type === 'null' && value !== null || rule.type === 'integer' && (!Number.isSafeInteger(value) || value < rule.minimum)) fail('validation_wire_schema');
  if (rule.type === 'string' && (typeof value !== 'string' || value.trim().length < (rule.minLength || 0) || value.length > (rule.maxLength ?? Infinity)
    || rule.pattern && !new RegExp(rule.pattern).test(value))) fail('validation_wire_schema');
}
export function validateWireExtraction(wire) {
  rejectSecrets(wire); check(wire, evidenceWireSchema, evidenceWireSchema); return structuredClone(wire);
}
export function inverseEvidenceResolution(internal) {
  check(internal, internalSchema, internalSchema);
  const wire = structuredClone(internal); wire.schemaVersion = 2;
  for (const c of wire.candidates) for (const e of c.evidence) { delete e.start; delete e.end; }
  validateWireExtraction(wire); return wire;
}
export function resolveEvidence(wire, documents, contract = processingContract()) {
  assertProcessingContract(contract);
  validateExtraction({ schemaVersion: 1, candidates: [] }, documents);
  const result = validateWireExtraction(wire); result.schemaVersion = 1;
  for (const c of result.candidates) for (const e of c.evidence) {
    const doc = documents.find(d => d.id === e.documentId), block = doc?.blocks.find(b => b.id === e.blockId);
    if (!block) fail('validation_evidence_reference');
    const text = doc.text.slice(block.start, block.end);
    const first = text.indexOf(e.quote);
    if (first === -1) fail('validation_quote_not_found');
    // Advance one code unit, so overlapping occurrences are counted as ambiguity.
    if (text.indexOf(e.quote, first + 1) !== -1) fail('validation_quote_ambiguous');
    e.start = block.start + first; e.end = e.start + e.quote.length;
  }
  validateExtraction(result, documents);
  if (!isDeepStrictEqual(inverseEvidenceResolution(result), wire)) fail('validation_resolution_roundtrip');
  return result;
}
export function makeResultBinding(record, artifact) {
  const fields = { version: 'resolved-evidence-binding-v1', inputHash: record.inputArtifact.hash,
    responseHash: record.responseHash, validatedArtifactHash: artifact.hash, processingContractHash: digest(record.processingContract) };
  return { ...fields, bindingHash: digest(fields) };
}
export function auditResolvedResult(record, input, artifact) {
  assertProcessingContract(record.processingContract);
  if (digest(input) !== record.inputArtifact.hash || artifact.contentHash !== digest(artifact.content) || artifact.contentHash !== record.validatedArtifact.hash
      || artifact.executionId !== record.id || artifact.type !== 'validated_extraction' || artifact.byteSize !== record.validatedArtifact.bytes
      || Buffer.byteLength(JSON.stringify(artifact.content)) !== artifact.byteSize || artifact.content.inputHash !== record.inputArtifact.hash || !isDeepStrictEqual(record.resultBinding, makeResultBinding(record, record.validatedArtifact))) throw safetyError('result_binding_invalid');
  const internal = artifact.content.extraction, wire = inverseEvidenceResolution(internal);
  if (digest({ extraction: wire, usage: record.budget.usage }) !== record.responseHash
      || !isDeepStrictEqual(resolveEvidence(wire, input.documents, record.processingContract), internal)) throw safetyError('response_binding_mismatch');
  return internal;
}
