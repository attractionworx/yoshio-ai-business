import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../server.js';
import { reflectionV2Fixture, reflectionV2Form, targetChoice } from './fixtures/reflection-v2.js';
import { createMappingDraftStore, mappingDraftBinding } from '../lib/offer-import/reflection-mapping-draft.js';
import { reflectionV2ChoiceGuidance } from '../lib/offer-import/reflection-v2-guidance.js';
import { validateReflectionV2Choice } from '../lib/offer-import/reflection-v2-policy.js';
const blank = id => ({ candidateId: id, mode: '', conversionIds: [], commonConfirmed: false, reason: '' });
const store = c => createMappingDraftStore({ dataDirectory: c.directory, importStore: c.imports, offerStore: c.offers, now: c.now });
const draftFile = c => path.join(c.directory, 'reflection-mapping-drafts', `${c.draft.id}--${c.offer.id}.json`);
async function http(t, c) {
  const server = createApp({ dataDirectory: c.directory }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`, route = `/offer-imports/${c.draft.id}/reflection-v2`;
  return { base, route, post: f => fetch(base + route, { method: 'POST', body: f, headers: { Origin: base }, redirect: 'manual' }) };
}
function form(c, choices, revision, save = true) {
  const f = reflectionV2Form(c, { ...c.options, choices }); const b = mappingDraftBinding(c.draft, c.offer);
  f.set('draftRevision', String(revision)); f.set('importHash', b.importHash); f.set('offerHash', b.offerHash);
  if (save) f.set('draftAction', 'save'); return f;
}
for (const id of ['candidate-4', 'candidate-5']) test(`guidance: ${id} single condition has no common requirement and persists/restores unchanged`, async t => {
  const c = await reflectionV2Fixture(t); const h = await http(t, c); const choices = structuredClone(c.options.choices);
  const index = Number(id.split('-')[1]) - 1; const original = structuredClone(choices[index]);
  assert.equal(reflectionV2ChoiceGuidance(original).status, 'complete'); assert.match(reflectionV2ChoiceGuidance(original).message, /単一地点では共通確認は不要/);
  assert.equal((await h.post(form(c, choices, 0))).status, 303);
  const restored = await store(c).get(c.draft.id, c.offer.id); assert.deepEqual(restored.choices[index], original);
  const html = await (await fetch(h.base + h.route)).text(); const section = html.split(`id="mapping-${id}"`)[1].split('</fieldset>')[0];
  assert.match(section, /単一地点では共通確認は不要/); assert.ok(!/name="candidate-[45]\.common"[^>]* checked/.test(section));
  const invalid = { ...original, commonConfirmed: true };
  for (const partial of [false, true]) assert.throws(() => validateReflectionV2Choice(invalid, c.draft.candidates[index], c.draft, c.offer, partial), e => e.v2Diagnostic?.field === 'common');
  assert.equal(reflectionV2ChoiceGuidance(invalid).status, 'invalid'); assert.equal(invalid.commonConfirmed, true);
  assert.equal((await h.post(form(c, choices, 1, false))).status, 200); assert.deepEqual((await c.audit.read()).events, []);
});
for (const id of ['candidate-3', 'candidate-7']) test(`guidance: ${id} 2-to-1 keeps common check and stops draft/preview until human clears it`, async t => {
  const c = await reflectionV2Fixture(t); const h = await http(t, c); const choices = structuredClone(c.options.choices); const index = Number(id.split('-')[1]) - 1;
  assert.equal(reflectionV2ChoiceGuidance(choices[index]).status, 'complete');
  assert.equal((await h.post(form(c, choices, 0))).status, 303);
  const before = await fs.readFile(draftFile(c)); choices[index].conversionIds = ['seminar'];
  assert.equal(choices[index].commonConfirmed, true); assert.equal(reflectionV2ChoiceGuidance(choices[index]).status, 'invalid');
  for (const save of [true, false]) {
    const response = await h.post(form(c, choices, 1, save)); assert.equal(response.status, 400); const html = await response.text();
    assert.ok(html.includes(id)); assert.ok(html.includes('V2_MAPPING_TARGET_INVALID')); assert.ok(html.includes('チェックを人間が解除するまで停止'));
    assert.deepEqual(await fs.readFile(draftFile(c)), before); assert.equal(choices[index].commonConfirmed, true);
  }
  choices[index].commonConfirmed = false; assert.equal((await h.post(form(c, choices, 1))).status, 303);
  assert.deepEqual((await store(c).get(c.draft.id, c.offer.id)).choices[index], choices[index]);
  assert.equal((await h.post(form(c, choices, 2, false))).status, 200); assert.equal((await h.post(form(c, choices, 1))).status, 409);
  assert.equal((await c.offers.get(c.offer.id)).revision, 1); assert.deepEqual(await c.imports.get(c.draft.id), c.draft); assert.deepEqual((await c.audit.read()).events, []);
});
test('guidance: location chosen but empty mode survives draft and is incomplete per candidate and progress (19/7)', async t => {
  const c = await reflectionV2Fixture(t, { size: 26, blockedDisclosure: true }); const h = await http(t, c); const choices = structuredClone(c.options.choices);
  choices[3] = { ...blank('candidate-4'), conversionIds: ['seminar'] }; for (let i = 20; i < 26; i++) choices[i] = blank(`candidate-${i + 1}`);
  assert.equal((await h.post(form(c, choices, 0))).status, 303);
  const html = await (await fetch(h.base + h.route)).text(); assert.ok(html.includes('入力済み 19件')); assert.ok(html.includes('未入力・未完了 7件')); assert.ok(html.includes('未入力・未完了の理由（7件）'));
  assert.ok(html.includes('反映判断（mode）未選択：地点1件は選択済みですが、未完了です'));
  for (const id of ['candidate-4', 'candidate-21', 'candidate-22', 'candidate-23', 'candidate-24', 'candidate-25', 'candidate-26']) assert.ok(html.includes(`href="#mapping-${id}"`));
  assert.deepEqual((await store(c).get(c.draft.id, c.offer.id)).choices[3], choices[3]);
  const response = await h.post(form(c, choices, 1, false)); assert.equal(response.status, 400); const failure = await response.text(); assert.ok(failure.includes('candidate-4')); assert.ok(failure.includes('modeは自動補完しません'));
  assert.equal((await store(c).get(c.draft.id, c.offer.id)).revision, 1); assert.equal(choices[3].mode, '');
});
test('guidance: missing common for 2 locations is incomplete; checked single and none remain inconsistent without normalization', () => {
  for (const choice of [{ ...targetChoice('candidate-3', 'seminar', 'membership'), commonConfirmed: false }, { ...blank('candidate-4'), conversionIds: ['seminar'] }]) assert.equal(reflectionV2ChoiceGuidance(choice).status, 'incomplete');
  for (const choice of [{ ...targetChoice('candidate-4', 'seminar'), commonConfirmed: true }, { ...blank('candidate-4'), conversionIds: ['seminar'], commonConfirmed: true }, { ...blank('candidate-8'), mode: 'none', reason: '重複', commonConfirmed: true }]) {
    const before = structuredClone(choice); assert.equal(reflectionV2ChoiceGuidance(choice).status, 'invalid'); assert.deepEqual(choice, before);
  }
});
