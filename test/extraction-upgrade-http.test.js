import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server.js';
import { upgradeFixture, upgradeConfig, upgradeInstructions } from './fixtures/extraction-upgrade.js';
import { snapshotHash, capture } from '../lib/maintenance/snapshot.js';

async function fixture(t) {
  const c = await upgradeFixture(t);
  const app = createApp({ dataDirectory: c.root, generationOptions: { now: c.now },
    extractionOptions: { provider: c.provider, config: upgradeConfig, simulationInstructions: upgradeInstructions, now: c.now } });
  await new Promise((resolve, reject) => { app.once('error', reject); app.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}`;
  const source = `/offer-extractions/${c.source.id}`;
  const post = (url, form, headers = { Origin: base }) => fetch(base + url, { method: 'POST', body: form, headers, redirect: 'manual' });
  const preparation = async () => {
    const response = await fetch(base + source + '/configuration-upgrade'); const html = await response.text();
    assert.equal(response.status, 200);
    return { response, html, token: html.match(/name="token" value="([^"]+)"/)[1] };
  };
  return { ...c, sourceRecord: c.source, app, base, source, post, preparation };
}

test('upgrade HTTP: archival source opens, dedicated two approvals, new instructions, pending review and CSP', async t => {
  const c = await fixture(t); const before = snapshotHash(await capture(c.root));
  const old = await fetch(c.base + c.source); assert.equal(old.status, 200);
  const oldHtml = await old.text(); assert.match(oldHtml, /現在設定で再抽出する準備/); assert.match(oldHtml, /記録当時の固定設定/);
  assert.ok(!oldHtml.includes('name="token"')); assert.ok(!oldHtml.includes('href="' + c.source + '/reanalysis"'));
  const p = await c.preparation(); assert.equal(snapshotHash(await capture(c.root)), before);
  assert.equal(p.response.headers.get('cache-control'), 'no-store'); assert.match(p.response.headers.get('content-security-policy'), /form-action 'self'/);
  assert.match(p.html, /configuration_upgrade_reextraction/); assert.match(p.html, /旧profile/); assert.match(p.html, /新profile/);
  assert.ok(p.html.includes(upgradeInstructions)); assert.ok(!p.html.includes(' checked')); assert.equal(c.attempts.length, 1);
  const form = new URLSearchParams({ token: p.token, confirm: 'yes' });
  const prepared = await c.post(c.source + '/configuration-upgrade/prepare', form); assert.equal(prepared.status, 303);
  const location = prepared.headers.get('location'); assert.notEqual(location, c.source);
  const repeated = await c.post(c.source + '/configuration-upgrade/prepare', form); assert.equal(repeated.headers.get('location'), location);
  const childHtml = await (await fetch(c.base + location)).text(); assert.match(childHtml, /execution v3/); assert.match(childHtml, /設定変更再抽出による新しい送信・新たな費用予約/);
  assert.ok(childHtml.includes(upgradeInstructions)); assert.ok(!childHtml.includes(' checked')); assert.equal(c.attempts.length, 1);
  const token = childHtml.match(/name="token" value="([^"]+)"/)[1];
  const sent = await c.post(location + '/approve', new URLSearchParams({ token, confirm: 'yes' })); assert.equal(sent.status, 303);
  assert.equal(c.attempts.length, 2); assert.equal(c.upgradeCalls[0].prompt, upgradeInstructions);
  assert.equal((await c.post(location + '/approve', new URLSearchParams({ token, confirm: 'yes' }))).status, 409);
  const result = await (await fetch(c.base + location)).text(); assert.match(result, /pending \/ unverified/);
  assert.deepEqual(await c.store.get(c.sourceRecord.id), c.sourceRecord);
});

for (const defect of ['origin','missing_origin','cross_site','unchecked','duplicate_confirm','reason_injection','operation_injection','destination_injection','snapshot_injection','raw_field','token','host']) {
  test(`upgrade HTTP: ${defect} refused without child or raw echo`, async t => {
    const c = await fixture(t); const p = await c.preparation(); const before = snapshotHash(await capture(c.root));
    const form = new URLSearchParams({ token: p.token, confirm: 'yes' }); const headers = { Origin: c.base };
    if (defect === 'origin') headers.Origin = 'https://outside.test';
    if (defect === 'missing_origin') delete headers.Origin;
    if (defect === 'cross_site') headers['Sec-Fetch-Site'] = 'cross-site';
    if (defect === 'unchecked') form.delete('confirm');
    if (defect === 'duplicate_confirm') form.append('confirm', 'yes');
    if (defect === 'reason_injection') form.set('reasonCode', 'FICTIONAL_PRIVATE_VALUE');
    if (defect === 'operation_injection') form.set('operationId', c.sourceRecord.id);
    if (defect === 'destination_injection') form.set('destinationConfigurationHash', '0'.repeat(64));
    if (defect === 'snapshot_injection') form.set('profileSnapshot', 'FICTIONAL_PRIVATE_VALUE');
    if (defect === 'raw_field') form.set('response', 'FICTIONAL_PRIVATE_VALUE');
    if (defect === 'token') form.set('token', p.token + 'x');
    let response;
    if (defect === 'host') response = await new Promise((resolve, reject) => {
      const req = http.request(c.base + c.source + '/configuration-upgrade/prepare', { method: 'POST',
        headers: { ...headers, Host: 'outside.test', 'Content-Type': 'application/x-www-form-urlencoded' } }, res => {
        res.resume(); res.on('end', () => resolve({ status: res.statusCode, text: async () => '' }));
      }); req.on('error', reject); req.end(form.toString());
    });
    else response = await c.post(c.source + '/configuration-upgrade/prepare', form, headers);
    assert.ok([400,403,409].includes(response.status)); assert.ok(!(await response.text()).includes('FICTIONAL_PRIVATE_VALUE'));
    assert.equal(snapshotHash(await capture(c.root)), before); assert.equal((await c.store.read()).executions.length, 1); assert.equal(c.attempts.length, 1);
  });
}

test('upgrade HTTP: normal duplicate remains refused after configuration change without preparation artifacts', async t => {
  const c = await fixture(t); const before = snapshotHash(await capture(c.root));
  const form = new URLSearchParams({ offerId: c.offer.id, offerRevision: '1' });
  c.value.documents.forEach((d,i) => Object.entries({ label: d.label, kind: d.kind, versionLabel: d.versionLabel || '', text: d.text })
    .forEach(([k,v]) => form.set(`documents.${i}.${k}`, v)));
  const response = await c.post('/offer-extractions/prepare', form); assert.equal(response.status, 409);
  const html = await response.text(); assert.match(html, /duplicate_request/); assert.match(html, /API料金は発生していません/);
  assert.equal(snapshotHash(await capture(c.root)), before); assert.equal(c.attempts.length, 1);
});
