import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { affiliateDraftFixture } from './fixtures/affiliate-draft.js';
import { publicationInput } from './fixtures/affiliate-publication.js';
import { preparePublication } from '../lib/publish.js';
import { publishPage } from '../lib/publish-page.js';
import { affiliateHumanChecks, validationFingerprint, savedAffiliateConfirmation, affiliatePublicationIsCurrent } from '../lib/affiliate-publication.js';
import { affiliateValidationState } from '../lib/affiliate-validation-lifecycle.js';
import { contextHash } from '../lib/ai/affiliate-context.js';
import { createApp } from '../server.js';

const ready = d => { d.publication = preparePublication(d, publicationInput(d)); return d; };
const noAffiliateChecks = d => ({ action: 'ready', titleIndex: '0', experience: 'yes', numbers: 'yes', links: 'yes', validationFingerprint: validationFingerprint(d) });
const e = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

test('Step 5.3: 正常案件でも人間確認前はready不可', async t => { const { draft } = await affiliateDraftFixture(t); assert.throws(() => preparePublication(draft, noAffiliateChecks(draft)), /必須.*4|warning/); });
for (const [key] of affiliateHumanChecks) test(`Step 5.3: 必須確認${key}を省略できない`, async t => { const { draft } = await affiliateDraftFixture(t); const input = publicationInput(draft); delete input[key]; assert.throws(() => preparePublication(draft, input), /4項目/); });
test('Step 5.3: 必須4確認・warning個別確認でready、infoは承認不要', async t => {
  const { draft } = await affiliateDraftFixture(t); const prep = preparePublication(draft, publicationInput(draft)); assert.equal(prep.status, '公開準備OK');
  assert.equal(prep.affiliate.validationFingerprint, validationFingerprint(draft)); assert.ok(prep.affiliate.humanConfirmation.confirmedAt);
  assert.ok(prep.affiliate.humanConfirmation.warningResolutions.every(r => r.reasonCode === 'human-reviewed'));
});
test('Step 5.3: 検出ゼロでも必須4確認', async t => {
  const { draft } = await affiliateDraftFixture(t); draft.affiliateValidation.findings = []; assert.equal(affiliateValidationState(draft).state, 'current');
  assert.throws(() => preparePublication(draft, noAffiliateChecks(draft)), /4項目/); assert.equal(preparePublication(draft, publicationInput(draft)).status, '公開準備OK');
});
test('Step 5.3: blockを全確認しても解除不可', async t => { const { draft } = await affiliateDraftFixture(t, { summary: '絶対成功' }); assert.throws(() => preparePublication(draft, publicationInput(draft)), /block/); });
test('Step 5.3: warningは1件でも未確認ならready不可', async t => {
  const { draft } = await affiliateDraftFixture(t, { summary: '料金999円です。', cta: '有料契約してください' }); const input = publicationInput(draft);
  for (const f of draft.affiliateValidation.findings.filter(f => f.severity === 'warning')) {
    const missingOne = { ...input }; delete missingOne[`warning.${f.id}`]; assert.throws(() => preparePublication(draft, missingOne), /1件ずつ/);
  }
});
test('Step 5.3: warning個別部分確認をcheck保存し再表示', async t => {
  const { draft } = await affiliateDraftFixture(t, { summary: '料金999円です。' }); const warnings = draft.affiliateValidation.findings.filter(f => f.severity === 'warning');
  const input = { ...noAffiliateChecks(draft), action: 'check', [`warning.${warnings[0].id}`]: 'yes' }; draft.publication = preparePublication(draft, input);
  assert.equal(draft.publication.status, '要修正'); assert.equal(savedAffiliateConfirmation(draft).warningResolutions.length, 1);
  assert.equal(savedAffiliateConfirmation(draft).confirmedAt, null); assert.match(publishPage(draft, e), new RegExp(`name="warning.${warnings[0].id}" value="yes" checked`));
});
for (const key of ['allWarnings', 'warning.all', 'humanConfirmation', 'affiliateValidation', 'affiliateContext', 'ignoreBlock']) test(`Step 5.3: 一括偽装・直接注入${key}拒否`, async t => { const { draft } = await affiliateDraftFixture(t); assert.throws(() => preparePublication(draft, { ...publicationInput(draft), [key]: 'yes' }), /未知|不正/); });
test('Step 5.3: 存在しないfinding ID拒否', async t => { const { draft } = await affiliateDraftFixture(t); assert.throws(() => preparePublication(draft, { ...publicationInput(draft), [`warning.${'a'.repeat(64)}`]: 'yes' }), /未知/); });
test('Step 5.3: infoをwarningとして承認する入力拒否', async t => { const { draft } = await affiliateDraftFixture(t); const f = draft.affiliateValidation.findings.find(f => f.severity === 'info'); assert.throws(() => preparePublication(draft, { ...publicationInput(draft), [`warning.${f.id}`]: 'yes' }), /未知/); });
test('Step 5.3: 重複値をObject.fromEntries前に拒否', async t => {
  const { draft } = await affiliateDraftFixture(t); for (const key of ['revision', 'validationFingerprint', 'affiliateFacts', ...draft.affiliateValidation.findings.filter(f => f.severity === 'warning').map(f => `warning.${f.id}`)]) {
    const form = new URLSearchParams({ ...publicationInput(draft), revision: String(draft.revision) }); form.append(key, form.get(key)); assert.throws(() => preparePublication(draft, form), /重複/);
  }
});
test('Step 5.3: checkbox値trueは確認として信用しない', async t => { const { draft } = await affiliateDraftFixture(t); assert.throws(() => preparePublication(draft, { ...publicationInput(draft), affiliateFacts: 'true' }), /個別/); });
test('Step 5.3: stale fingerprint拒否', async t => { const { draft } = await affiliateDraftFixture(t); assert.throws(() => preparePublication(draft, { ...publicationInput(draft), validationFingerprint: 'a'.repeat(64) }), { status: 409 }); });
for (const [name, mutate] of [
  ['contentHash', d => { d.edited.summary = '変更'; }],
  ['affiliateContextHash', d => { d.affiliateContext.offerRevision++; }],
  ['validationVersion', d => { d.affiliateValidation.validationVersion = 'old'; }],
  ['findings', d => { d.affiliateValidation.findings = d.affiliateValidation.findings.filter(f => f.code !== 'numeric-text-match'); }],
]) test(`Step 5.3: ${name}変更で以前の確認・publication無効`, async t => {
  const { draft } = await affiliateDraftFixture(t); ready(draft); const original = publicationInput(draft); mutate(draft);
  assert.equal(savedAffiliateConfirmation(draft), null); assert.equal(affiliatePublicationIsCurrent(draft), false);
  assert.throws(() => preparePublication(draft, original)); const html = publishPage(draft, e); assert.match(html, /id="publish-status">未チェック/); assert.ok(!html.includes('value="yes" checked'));
});
test('Step 5.3: 再validation同じ内容でもrunIdが変わり古い確認を拒否', async t => {
  const c = await affiliateDraftFixture(t); let d = await c.drafts.update(c.draft.id, c.draft.revision, publicationInput(c.draft), 'publish'); const original = publicationInput(d);
  const before = validationFingerprint(d); d = await c.drafts.update(d.id, d.revision, null, 'revalidate');
  assert.notEqual(validationFingerprint(d), before); assert.equal(d.publication, undefined); assert.equal(savedAffiliateConfirmation(d), null);
  assert.throws(() => preparePublication(d, original), { status: 409 }); assert.equal(draftContent(d), draftContent(c.draft));
});
const draftContent = d => JSON.stringify(d.edited);
for (const state of ['stale', 'invalid', 'failed', 'unvalidated']) test(`Step 5.3: ${state}はready不可`, async t => {
  const { draft } = await affiliateDraftFixture(t);
  if (state === 'stale') draft.edited.summary = '変更';
  if (state === 'invalid') draft.affiliateValidation.findings[0].messageKey = 'unknown';
  if (state === 'failed') { delete draft.affiliateValidation; draft.affiliateValidationFailure = { schemaVersion: 1, code: 'validation-unavailable', attemptedAt: new Date().toISOString(), contentHash: cHash(draft), affiliateContextHash: aHash(draft) }; }
  if (state === 'unvalidated') delete draft.affiliateValidation;
  assert.equal(affiliateValidationState(draft).state, state); assert.throws(() => preparePublication(draft, { action: 'ready', titleIndex: '0', experience: 'yes', numbers: 'yes', links: 'yes' }), /current|再検査/);
});
import { contentHash as cHashContent, affiliateContextHash as aHashContent } from '../lib/affiliate-validation.js';
const cHash = d => cHashContent(d.edited); const aHash = d => aHashContent(d.affiliateContext);
test('Step 5.3: 案件なしは既存公開準備を維持', async t => { const { draft } = await affiliateDraftFixture(t); delete draft.affiliateContext; const p = preparePublication(draft, publicationInput(draft)); assert.equal(p.status, '公開準備OK'); assert.equal(p.affiliate, undefined); assert.ok(!publishPage(draft, e).includes('data-affiliate-publish')); });
test('Step 5.3: 既存preflight・タイトル・draft確認・3確認を維持', async t => {
  const { draft } = await affiliateDraftFixture(t);
  for (const key of ['titleIndex', 'experience', 'numbers', 'links']) { const input = publicationInput(draft); delete input[key]; assert.throws(() => preparePublication(draft, input)); }
  assert.throws(() => preparePublication({ ...draft, status: '未確認' }, publicationInput(draft)), /確認済み/);
  const pending = await affiliateDraftFixture(t, { body: `${draft.affiliateContext.snapshot.disclosure.text}\n要確認` });
  assert.throws(() => preparePublication(pending.draft, publicationInput(pending.draft)), /検出された記述/);
});
test('Step 5.3: 編集保存でconfirmation/publication失効', async t => {
  const c = await affiliateDraftFixture(t); let d = await c.drafts.update(c.draft.id, c.draft.revision, publicationInput(c.draft), 'publish');
  d = await c.drafts.update(d.id, d.revision, { ...d.edited, summary: '新しい概要' }, 'save'); assert.equal(d.publication, undefined); assert.equal(savedAffiliateConfirmation(d), null); assert.equal(d.status, '編集中');
});
test('Step 5.3: publicationはサーバー生成fingerprintに束縛される', async t => {
  const c = await affiliateDraftFixture(t); const d = await c.drafts.update(c.draft.id, c.draft.revision, publicationInput(c.draft), 'publish');
  assert.equal(d.publication.affiliate.validationFingerprint, validationFingerprint(d)); assert.equal(savedAffiliateConfirmation(d).validationFingerprint, validationFingerprint(d)); assert.equal(affiliatePublicationIsCurrent(d), true);
});
test('Step 5.3: 過去Step 5.2の未束縛readyを信用しない', async t => {
  const { draft } = await affiliateDraftFixture(t); draft.publication = { status: '公開準備OK', titleIndex: 0, confirmations: { experience: true, numbers: true, links: true }, findings: [], missing: [] };
  assert.equal(affiliatePublicationIsCurrent(draft), false); assert.match(publishPage(draft, e), /id="publish-status">未チェック/);
});
test('Step 5.3: 人間確認の不正保存値を表示・再利用しない', async t => {
  const { draft } = await affiliateDraftFixture(t); ready(draft); draft.publication.affiliate.humanConfirmation.warningResolutions[0].reasonCode = 'SYNTHETIC_SECRET';
  assert.equal(savedAffiliateConfirmation(draft), null); assert.ok(!publishPage(draft, e).includes('SYNTHETIC_SECRET'));
});
test('Step 5.3: 現在paused/ended・期限・conversion状態は今回のgateで読まない', async t => {
  const c = await affiliateDraftFixture(t); await c.offers.update(c.offer.id, 1, { ...c.input, status: 'ended' }); const d = await c.drafts.update(c.draft.id, c.draft.revision, publicationInput(c.draft), 'publish'); assert.equal(d.publication.status, '公開準備OK');
});
async function httpFixture(t, changes) {
  const c = await affiliateDraftFixture(t, changes); await writeFile(path.join(c.directory, `${c.plan.id}.json`), JSON.stringify(c.plan));
  const server = createApp({ dataDirectory: c.directory }); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`; const route = `/drafts/${c.draft.id}/publish`;
  const post = values => fetch(base + route, { method: 'POST', headers: { Origin: base }, body: values instanceof URLSearchParams ? values : new URLSearchParams(values), redirect: 'manual' });
  return { ...c, base, route, post };
}
test('Step 5.3 HTTP: 4確認・個別warning・ready保存・GET無変更', async t => {
  const c = await httpFixture(t); const before = await readFile(c.file, 'utf8'); const html = await (await fetch(c.base + c.route)).text();
  assert.match(html, /data-affiliate-required/); assert.match(html, /data-affiliate-warnings/); assert.equal(await readFile(c.file, 'utf8'), before);
  assert.equal((await c.post({ ...noAffiliateChecks(c.draft), revision: c.draft.revision })).status, 400);
  assert.equal((await c.post({ ...publicationInput(c.draft), revision: c.draft.revision })).status, 303);
  assert.equal((await c.drafts.get(c.draft.id)).publication.status, '公開準備OK');
});
test('Step 5.3 HTTP: 重複・未知ID・偽造confirmation/validation・stale拒否で保存なし', async t => {
  const c = await httpFixture(t); const before = await readFile(c.file, 'utf8');
  const baseInput = { ...publicationInput(c.draft), revision: String(c.draft.revision) };
  const duplicated = new URLSearchParams(baseInput); duplicated.append('affiliateFacts', 'yes');
  for (const input of [duplicated, { ...baseInput, humanConfirmation: '{}' }, { ...baseInput, affiliateValidation: '{}' }, { ...baseInput, 'warning.unknown': 'yes' }, { ...baseInput, validationFingerprint: 'b'.repeat(64) }]) {
    const response = await c.post(input); assert.ok([400, 409].includes(response.status)); assert.equal(await readFile(c.file, 'utf8'), before);
  }
});
test('Step 5.3 HTTP: block説明・安全なwarning・内部情報非漏洩', async t => {
  const c = await httpFixture(t, { summary: '絶対成功', readerNeeds: 'password=SYNTHETIC_SECRET 999円です。' });
  const html = await (await fetch(c.base + c.route)).text(); assert.match(html, /チェックでは解除できません/); assert.match(html, /数値候補/);
  for (const value of ['SYNTHETIC_SECRET', c.offer.conversions[0].affiliateUrl, c.offer.sources[0].publicUrl, '非公開情報専用目印', '報酬管理専用目印', 'management-only', 'reward', 'internal_only', 'test-asp', 'source-1']) assert.ok(!html.includes(value));
  const check = await c.post({ ...publicationInput(c.draft, 'check'), revision: c.draft.revision }); assert.equal(check.status, 303);
  const prep = (await c.drafts.get(c.draft.id)).publication; assert.ok(!JSON.stringify(prep).includes('SYNTHETIC_SECRET'));
  for (const value of [c.offer.conversions[0].affiliateUrl, c.offer.sources[0].publicUrl, '非公開情報専用目印', '報酬管理専用目印', 'management-only']) assert.ok(!JSON.stringify(prep).includes(value));
});
test('Step 5.3 HTTP: 秘密入り不正入力をエラー・ログへ転載しない', async t => {
  const c = await httpFixture(t); const logs = []; const original = console.error; console.error = (...args) => logs.push(args.join(' ')); t.after(() => { console.error = original; });
  const response = await c.post({ ...publicationInput(c.draft), revision: c.draft.revision, humanConfirmation: 'password=SYNTHETIC_SECRET' });
  assert.equal(response.status, 400); assert.ok(!(await response.text()).includes('SYNTHETIC_SECRET')); assert.deepEqual(logs, []);
});
test('Step 5.3 HTTP: 旧draft再検査誘導・GETで修復しない', async t => {
  const c = await httpFixture(t); delete c.draft.affiliateValidation; await writeFile(c.file, JSON.stringify(c.draft)); const before = await readFile(c.file, 'utf8');
  const html = await (await fetch(c.base + c.route)).text(); assert.match(html, /未検査/); assert.match(html, /再検査/); assert.equal(await readFile(c.file, 'utf8'), before);
});
test('Step 5.3: 外向き通信なし', async t => { const guard = await import('./helpers/network-guard.js'); const before = guard.blockedConnections.length; const { draft } = await affiliateDraftFixture(t); ready(draft); publishPage(draft, e); assert.equal(guard.blockedConnections.length, before); });
