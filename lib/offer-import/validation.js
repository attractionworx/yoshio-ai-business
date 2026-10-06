import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { safeText, validateOfferId } from '../offers/validation.js';
import { validationReasonCode } from './validation-reasons.js';

const draftSchema = JSON.parse(readFileSync(new URL('../../schemas/offer-import.schema.json', import.meta.url), 'utf8'));
const extractionSchema = JSON.parse(readFileSync(new URL('../../schemas/regulation-extraction.schema.json', import.meta.url), 'utf8'));
const fail = (code = 'validation_failed') => { throw Object.assign(new Error('取り込み候補が不正です。形式・出典・確認状態を確認してください。'), { status: 400, code: validationReasonCode(code) }); };
export const hashDocumentText = text => createHash('sha256').update(text, 'utf8').digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
const hash = value => hashDocumentText(JSON.stringify(canonical(value)));

function validDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m || !Number.isFinite(Date.parse(value))) return false;
  const [, y, month, day, hour, minute, second, zone] = m;
  return +month >= 1 && +month <= 12 && +day >= 1 && +day <= new Date(Date.UTC(+y, +month, 0)).getUTCDate()
    && +hour <= 23 && +minute <= 59 && +second <= 59
    && (zone === 'Z' || (+zone.slice(1, 3) <= 23 && +zone.slice(4) <= 59));
}

// These two contracts only; unsupported schema keywords are not a general validator API.
function check(value, rule, schema) {
  if (rule.$ref) return check(value, schema.$defs[rule.$ref.split('/').at(-1)], schema);
  if (rule.anyOf) {
    for (const branch of rule.anyOf) { try { check(value, branch, schema); return; } catch { /* next */ } }
    fail();
  }
  if ('const' in rule && value !== rule.const) fail();
  if (rule.enum && !rule.enum.includes(value)) fail();
  if (rule.type === 'null' && value !== null) fail();
  if (rule.type === 'object') {
    if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail();
    if (Object.keys(value).some(k => !Object.hasOwn(rule.properties, k)) || rule.required.some(k => !Object.hasOwn(value, k))) fail();
    for (const [key, child] of Object.entries(rule.properties)) check(value[key], child, schema);
  }
  if (rule.type === 'array') {
    if (!Array.isArray(value) || value.length < rule.minItems || value.length > rule.maxItems) fail();
    for (const item of value) check(item, rule.items, schema);
  }
  if (rule.type === 'integer' && (!Number.isSafeInteger(value) || value < rule.minimum)) fail();
  if (rule.type === 'string') {
    if (typeof value !== 'string' || value.trim().length < (rule.minLength || 0) || value.length > (rule.maxLength ?? Infinity)) fail();
    try { safeText(value); } catch { fail('validation_secret'); }
    // Known management-page markers. Unknown secrets/full-page formats still require human exclusion.
    if (/<\s*(?:html|head|body|form|input|script)\b|<!doctype\s+html|(?:管理画面|ダッシュボード)[\s\S]{0,100}(?:ログアウト|ログイン中)/iu.test(value)) fail('validation_secret');
    if (rule.pattern && !new RegExp(rule.pattern).test(value)) fail();
    if (rule.format === 'uuid') validateOfferId(value);
    if (rule.format === 'date-time' && !validDate(value)) fail();
  }
}

function unique(items) { if (new Set(items.map(item => item.id)).size !== items.length) fail(); }
function documentsChecked(documents) {
  check(documents, draftSchema.properties.documents, draftSchema);
  unique(documents);
  for (const doc of documents) {
    if (hashDocumentText(doc.text) !== doc.textHash) fail();
    unique(doc.blocks);
    let end = 0;
    for (const block of doc.blocks) {
      if (block.start !== end || block.end <= block.start || block.end > doc.text.length) fail();
      end = block.end;
    }
    if (end !== doc.text.length) fail(); // No silently omitted input ranges.
  }
}
const conversionTargets = new Set(['conversion_name', 'eligibility', 'approvalConditions', 'rejectionConditions', 'ctaLabel', 'reward_evidence']);
// Observations only, after the existing reference/range/exact-match guards.
// Priority: another occurrence in the same block, UTF-16 length, same-length mismatch.
function quoteMismatchReason(doc, block, evidence) {
  let found = doc.text.indexOf(evidence.quote, block.start);
  if (found === evidence.start) found = doc.text.indexOf(evidence.quote, found + 1);
  if (found >= block.start && found + evidence.quote.length <= block.end) return 'validation_quote_found_elsewhere_in_block';
  return evidence.end - evidence.start !== evidence.quote.length
    ? 'validation_quote_length_mismatch' : 'validation_quote_same_length_mismatch';
}
function payloadChecked(payload, documents) {
  const expected = { targetAudience: 'audience', sellingPoints: 'selling_point', prohibitedExpressions: 'prohibition',
    eligibility: 'eligibility', approvalConditions: 'approval', rejectionConditions: 'rejection', reward_evidence: 'reward' };
  if (Boolean(payload.conversionKey) !== conversionTargets.has(payload.target)) fail('validation_candidate_conversion_key');
  if (expected[payload.target] && payload.category !== expected[payload.target]) fail('validation_candidate_target_category');
  if (payload.category === 'reward' && (payload.target !== 'reward_evidence' || payload.usage !== 'internal_only')) fail('validation_candidate_reward');
  if (['eligibility', 'approvalConditions', 'rejectionConditions'].includes(payload.target) && payload.purpose !== 'conversion_condition') fail('validation_candidate_conversion_purpose');
  if (payload.purpose === 'conversion_condition' && !['eligibility', 'approvalConditions', 'rejectionConditions'].includes(payload.target)) fail('validation_candidate_conversion_target');
  if (payload.target === 'prohibitedExpressions' && (!['restriction', 'marketing_goal'].includes(payload.purpose) || payload.usage !== 'constraint_only')) fail('validation_candidate_prohibited');
  if (payload.purpose === 'marketing_goal' && payload.target !== 'prohibitedExpressions') fail('validation_candidate_marketing_target');
  if (payload.purpose === 'restriction' && payload.target !== 'prohibitedExpressions') fail('validation_candidate_restriction_target');
  if (payload.purpose === 'unmapped' || payload.target === 'unmapped') {
    if (payload.purpose !== 'unmapped' || payload.target !== 'unmapped' || payload.usage !== 'internal_only') fail('validation_candidate_unmapped');
  }
  if (payload.category === 'prohibition' && payload.target !== 'prohibitedExpressions') fail('validation_candidate_prohibition_target');
  const seen = new Set();
  for (const evidence of payload.evidence) {
    const doc = documents.find(d => d.id === evidence.documentId);
    const block = doc?.blocks.find(b => b.id === evidence.blockId);
    if (!block) fail('validation_evidence_reference');
    if (evidence.start < block.start || evidence.end > block.end || evidence.end <= evidence.start) fail('validation_evidence_range');
    if (doc.text.slice(evidence.start, evidence.end) !== evidence.quote) fail(quoteMismatchReason(doc, block, evidence));
    const key = hash(evidence);
    if (seen.has(key)) fail('validation_evidence_duplicate');
    seen.add(key);
  }
}

// Change detection, not a signature or proof of truth/human identity.
export function reviewContentHash(payload, documents) {
  return hash({ payload, documents: [...new Set(payload.evidence.map(e => e.documentId))].sort()
    .map(id => {
      const doc = documents.find(d => d.id === id);
      return doc && { id: doc.id, format: doc.format, label: doc.label, kind: doc.kind,
        versionLabel: doc.versionLabel, textHash: doc.textHash, blocks: doc.blocks };
    }) });
}

export function validateExtraction(value, documents) {
  let stage = 'validation_input';
  try {
    documentsChecked(documents);
    stage = 'validation_schema';
    check(value, extractionSchema, extractionSchema);
    stage = 'validation_candidate';
    for (const payload of value.candidates) payloadChecked(payload, documents);
    return structuredClone(value);
  } catch (error) {
    const code = validationReasonCode(error.code);
    fail(code === 'validation_failed' ? stage : code);
  }
}

export function validateOfferImport(value) {
  try {
    check(value, draftSchema, draftSchema);
    documentsChecked(value.documents);
    unique(value.candidates);
    if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) fail();
    for (const candidate of value.candidates) {
      payloadChecked(candidate.original, value.documents);
      const review = candidate.review;
      const effective = review.edited || candidate.original;
      if (review.edited) payloadChecked(review.edited, value.documents);
      if (review.reviewedAt && (Date.parse(review.reviewedAt) < Date.parse(value.createdAt) || Date.parse(review.reviewedAt) > Date.parse(value.updatedAt))) fail();
      if (review.decision === 'pending') {
        if (review.reviewedAt !== null || review.confirmedHash !== null || review.checkedAt !== null || review.verification !== 'unverified') fail();
      } else if (!review.reviewedAt || review.confirmedHash !== reviewContentHash(effective, value.documents)) fail();
      if (review.verification === 'source_checked') {
        if (review.decision !== 'accepted' || !review.checkedAt || review.checkedAt !== review.reviewedAt) fail();
      } else if (review.checkedAt !== null) fail();
      if (review.decision === 'accepted' && effective.target === 'unmapped') fail();
    }
    return structuredClone(value);
  } catch { fail(); }
}
