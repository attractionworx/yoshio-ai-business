import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../server.js';
import { createExtractionService } from '../lib/offer-import/extraction-service.js';
import { createReflectionService } from '../lib/offer-import/reflection-service.js';
import { budgetPage } from '../lib/ai/budget-pages.js';
import { createMaintenanceService } from '../lib/maintenance/backup.js';
import { executionFixture } from './fixtures/extraction-execution.js';
import { maintenanceFixture } from './fixtures/maintenance.js';
import { createBudgetCoordinator } from '../lib/ai/budget-coordinator.js';
import { fixtureBudgetPolicy } from './fixtures/ai-budget.js';
const e = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
async function httpFixture(t, options = {}) {
  const c = await executionFixture(t, options); const app = createApp({ dataDirectory: c.root, generationOptions: { now: c.now }, maintenanceOptions: { now: c.now } });
  await new Promise((resolve, reject) => { app.once('error', reject); app.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(r => app.close(r))); const base = `http://127.0.0.1:${app.address().port}`;
  const post = (url, values, headers = {}) => fetch(base + url, { method: 'POST', body: new URLSearchParams(values), headers: { Origin: base, ...headers } });
  return { ...c, base, post };
}
const values = { confirm: 'yes', revision: '0', realYen: '', simulationYen: '900' };
test('6-0A HTTP: management GET never activates; explicit POST fixes version/hash and no real policy price', async t => {
  const c = await httpFixture(t, { activate: false });
  const response = await fetch(c.base + '/maintenance/ai-budget'); assert.equal(response.status, 200); const text = await response.text(); assert.match(text, /未有効化/);
  assert.match(response.headers.get('content-security-policy'), /form-action 'self'/);
  await assert.rejects(fs.lstat(path.join(c.root, 'ai-budget')), { code: 'ENOENT' });
  const activated = await c.post('/maintenance/ai-budget/activate', values); assert.equal(activated.status, 200); assert.match(await activated.text(), /明示有効化済み/);
  const a = await c.coordinator.activation(); assert.equal(a.policy.realStopMilliYen, null); assert.equal(a.schemaVersion, 1); assert.equal(a.initialBudget.simulation.bookedMilliYen, 0);
  assert.equal((await c.post('/maintenance/ai-budget/activate', values)).status, 409);
});
for (const kind of ['origin', 'missing_origin', 'cross_site', 'unknown', 'duplicate', 'revision', 'unchecked', 'xss', 'host']) test(`6-0A HTTP: activation ${kind} refused, no record or secret echo`, async t => {
  const c = await httpFixture(t, { activate: false }); const data = new URLSearchParams(values); const headers = { Origin: c.base };
  if (kind === 'origin') headers.Origin = 'https://example.test'; if (kind === 'missing_origin') delete headers.Origin;
  if (kind === 'cross_site') headers['Sec-Fetch-Site'] = 'cross-site'; if (kind === 'host') headers.Host = 'outside.example.test';
  if (kind === 'unknown') data.set('token', 'fictional_forbidden'); if (kind === 'duplicate') data.append('confirm', 'yes');
  if (kind === 'revision') data.set('revision', '1'); if (kind === 'unchecked') data.delete('confirm');
  if (kind === 'xss') data.set('simulationYen', '<svg onload="window.pwned=true">');
  const response = kind !== 'host' ? await fetch(c.base + '/maintenance/ai-budget/activate', { method: 'POST', headers, body: data }) : await new Promise((resolve, reject) => {
    const req = http.request(c.base + '/maintenance/ai-budget/activate', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' } }, res => {
      let body = ''; res.on('data', b => body += b); res.on('end', () => resolve({ status: res.statusCode, text: async () => body }));
    }); req.on('error', reject); req.end(data.toString());
  });
  assert.ok([400, 403].includes(response.status)); const text = await response.text(); assert.ok(!text.includes('window.pwned')); assert.ok(!text.includes('fictional_forbidden'));
  await assert.rejects(fs.lstat(path.join(c.root, 'ai-budget/activation.json')), { code: 'ENOENT' });
});
test('6-0A HTTP: unresolved import cannot review, verify, or create reflection preview; explicit result unlocks', async t => {
  const c = await httpFixture(t); const s = createExtractionService({ ...c.options, fault: async p => { if (p === 'before_result') throw new Error('disk'); } }); const r = await c.run(s);
  const id = r.plannedImport.id;
  assert.equal((await fetch(c.base + `/offer-imports/${id}`)).status, 409);
  assert.equal((await fetch(c.base + `/offer-imports/${id}/reflection?offerId=${c.offer.id}`)).status, 409);
  assert.equal((await c.post(`/offer-imports/${id}/candidates/candidate-2/verify`, { revision: '1', confirm: 'yes' })).status, 409);
  const reflection = createReflectionService({ dataDirectory: c.root, importStore: c.imports, offerStore: c.offers });
  await assert.rejects(reflection.preview(id, { offerId: c.offer.id, conversions: [] }), { status: 409 });
  await c.service.recover(r.id, r.revision, { confirm: true, operation: 'finalize_result' });
  assert.equal((await fetch(c.base + `/offer-imports/${id}`)).status, 200);
});
test('6-0A: budget state view escapes untrusted state text and has no intake/send form', () => {
  const text = budgetPage(e, null, [{ id: '<svg onload=bad>', state: '<img src=x onerror=bad>', revision: 1 }]);
  assert.ok(text.includes('&lt;svg')); assert.ok(!text.includes('<img')); assert.ok(!text.includes('textarea')); assert.ok(!text.includes('/extract'));
});
test('6-0A: maintenance fixes global lock order including artifacts without changing Step 4 order', async t => {
  const c = await maintenanceFixture(t); await createBudgetCoordinator(c.root, { now: c.now }).activate(fixtureBudgetPolicy, { confirm: true, expectedRevision: 0 });
  await fs.mkdir(path.join(c.root, 'extraction-artifacts')); const locks = [];
  const fileSystem = { ...fs, async mkdir(file, options) { if (file.endsWith('/.lock') && !file.includes('/maintenance-backups/')) locks.push(path.basename(path.dirname(file))); return fs.mkdir(file, options); } };
  const backup = await createMaintenanceService(c.root, { fileSystem, now: c.now }).create();
  assert.equal(backup.manifest.schemaVersion, 2);
  assert.deepEqual(locks, ['ai-budget', 'generations', 'extraction-executions', 'extraction-artifacts', 'offer-import-commits', 'offer-imports', 'offers']);
});
