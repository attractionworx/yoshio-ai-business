import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { extractionProfile } from '../lib/ai/extraction-profile.js';
import { buildExtractionPayload } from '../lib/ai/extraction-payload.js';
import { validateExtraction } from '../lib/offer-import/validation.js';
import { validationReasons } from '../lib/offer-import/validation-reasons.js';
import { makeDocuments, extractionPages } from '../lib/offer-import/extraction-pages.js';
import { executionFixture } from './fixtures/extraction-execution.js';
import { fictionalRows, stubExtraction } from './fixtures/openai-extraction.js';
import { createExtractionService } from '../lib/offer-import/extraction-service.js';

const documents = makeDocuments(fictionalRows());
const base = stubExtraction({ documents }).candidates[0];
const candidate = patch => ({ ...structuredClone(base), ...patch });
const validate = p => validateExtraction({ schemaVersion: 1, candidates: [p] }, documents);
const normal = [
  ['name', null, 'other', 'publishable', 'fact'],
  ['conversion_name', 'group', 'other', 'publishable', 'fact'],
  ['disclosure_text', null, 'other', 'publishable', 'fact'],
  ['facts', null, 'feature', 'publishable', 'fact'],
  ['targetAudience', null, 'audience', 'publishable', 'fact'],
  ['sellingPoints', null, 'selling_point', 'publishable', 'fact'],
  ['prohibitedExpressions', null, 'prohibition', 'constraint_only', 'restriction'],
  ['prohibitedExpressions', null, 'prohibition', 'constraint_only', 'marketing_goal'],
  ['eligibility', 'group', 'eligibility', 'publishable', 'conversion_condition'],
  ['approvalConditions', 'group', 'approval', 'constraint_only', 'conversion_condition'],
  ['rejectionConditions', 'group', 'rejection', 'constraint_only', 'conversion_condition'],
  ['ctaLabel', 'group', 'other', 'publishable', 'fact'],
  ['reward_evidence', 'group', 'reward', 'internal_only', 'fact'],
  ['unmapped', null, 'other', 'internal_only', 'unmapped'],
];
for (const [target, conversionKey, category, usage, purpose] of normal) {
  test(`candidate contract accepts ${target}/${purpose}`, () => {
    const p = candidate({ target, conversionKey, category, usage, purpose });
    assert.deepEqual(validate(p).candidates[0], p);
  });
}
const invalid = [
  ['conversion_key', { conversionKey: 'group' }],
  ['conversion_key', { target: 'ctaLabel', conversionKey: null }],
  ['target_category', { target: 'targetAudience', category: 'feature' }],
  ['reward', { category: 'reward' }],
  ['reward', { target: 'reward_evidence', conversionKey: 'group', category: 'reward', usage: 'publishable' }],
  ['conversion_purpose', { target: 'eligibility', conversionKey: 'group', category: 'eligibility', purpose: 'fact' }],
  ['conversion_target', { purpose: 'conversion_condition' }],
  ['prohibited', { target: 'prohibitedExpressions', category: 'prohibition', usage: 'publishable', purpose: 'restriction' }],
  ['prohibited', { target: 'prohibitedExpressions', category: 'prohibition', usage: 'constraint_only', purpose: 'fact' }],
  ['marketing_target', { purpose: 'marketing_goal' }],
  ['restriction_target', { purpose: 'restriction' }],
  ['unmapped', { target: 'unmapped', purpose: 'fact', usage: 'internal_only' }],
  ['unmapped', { purpose: 'unmapped', usage: 'internal_only' }],
  ['unmapped', { target: 'unmapped', purpose: 'unmapped', usage: 'publishable' }],
  ['prohibition_target', { category: 'prohibition' }],
];
for (const [i, [suffix, patch]] of invalid.entries()) {
  const code = `validation_candidate_${suffix}`;
  test(`candidate contract rejects combination ${i + 1} with ${code}`, () => {
    assert.throws(() => validate(candidate(patch)), e => e.code === code && !e.message.includes('group'));
  });
  test(`fake candidate diagnostic ${i + 1} persists only fixed reason`, async t => {
    const c = await executionFixture(t);
    c.value.documents = makeDocuments(fictionalRows());
    const marker = `FICTIONAL_UNSAVED_CANDIDATE_${i}`;
    let calls = 0;
    const service = createExtractionService({ ...c.options, provider: { kind: 'fake', async extract({ input }) {
      calls++;
      const extraction = stubExtraction(input);
      extraction.candidates = [{ ...extraction.candidates[0], ...patch, text: marker }];
      return { extraction, usage: { inputTokens: 100, outputTokens: 200 } };
    } } });
    const r = await c.run(service);
    assert.equal(calls, 1);
    assert.deepEqual(r.error, { code, phase: 'validation' });
    assert.equal(r.state, 'failed_after_request');
    assert.equal(r.budget.state, 'settled');
    assert.equal(r.budget.reservedMilliYen, 0);
    assert.equal(r.validatedArtifact, null);
    assert.equal(r.savedImport, null);
    assert.deepEqual(await c.imports.list(), []);
    assert.equal((await service.store.get(r.id)).error.code, code);
    const html = extractionPages(String).detail(await service.preview(r.id));
    assert.ok(html.includes(validationReasons[code]));
    assert.ok(!html.includes(marker));
    const scan = async directory => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await scan(file);
        else assert.ok(!(await fs.readFile(file, 'utf8')).includes(marker), `response leak in fixture store ${entry.name}`);
      }
    };
    await scan(c.root);
  });
}

test('outbound instructions cover every candidate combination condition without adding category restrictions', () => {
  const request = buildExtractionPayload({ documents, targetOffer: null }, extractionProfile);
  const text = request.instructions;
  for (const pair of ['targetAudience=audience', 'sellingPoints=selling_point', 'prohibitedExpressions=prohibition',
    'eligibility=eligibility', 'approvalConditions=approval', 'rejectionConditions=rejection', 'reward_evidence=reward']) assert.ok(text.includes(pair));
  for (const clause of [
    '他のtargetには追加のcategory固定条件はありません',
    'conversionKeyはconversion_name、eligibility、approvalConditions、rejectionConditions、ctaLabel、reward_evidenceで必須',
    'それ以外のtargetでは必ずnull',
    'category=rewardはtarget=reward_evidenceかつusage=internal_only',
    'targetがeligibility、approvalConditions、rejectionConditionsならpurpose=conversion_condition',
    'purpose=conversion_conditionはこの3つのtargetだけ',
    'target=prohibitedExpressionsはusage=constraint_onlyかつpurpose=restrictionまたはmarketing_goal',
    'purpose=restrictionまたはmarketing_goalはtarget=prohibitedExpressionsだけ',
    'targetまたはpurposeがunmappedならtarget=unmapped、purpose=unmapped、usage=internal_only',
    'category=prohibitionはtarget=prohibitedExpressionsだけ',
  ]) assert.ok(text.includes(clause), clause);
  assert.equal(request.text.format.strict, true);
});
