import { reflectionV2Fixture } from '../test/fixtures/reflection-v2.js';
import { blockedConnections } from '../test/helpers/network-guard.js';
import { tmpdir } from 'node:os';
// インストール済みChromeで実際にフォームを操作する確認用スクリプト。
// Chromeの専用プロフィールと架空データはOSの一時フォルダに保存します。
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createApp } from '../server.js';
import { createOfferImportStore } from '../lib/offer-import/store.js';
import { regulationFixture } from '../test/fixtures/regulation-import.js';

const fixture = await reflectionV2Fixture(null, { size: 26, blockedDisclosure: true });
const { directory, draft, offer, service, imports: store } = fixture;
const dataDirectory = directory;
const route = `/offer-imports/${draft.id}/reflection-v2`;
const server = createApp({ dataDirectory, offerImportOptions: { store, reflection: service } });
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const base = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(path.join(directory, 'profile-'));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--disable-sync', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost', '--disable-component-update', '--disable-breakpad', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: tmpdir() } });

let socket;
let nextId = 0;
const pending = new Map();
const requests = [];
const mappingPosts = [];
const responses = [];
const externalRequests = [];
function call(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function until(check) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('ブラウザ確認がタイムアウトしました。');
}
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chromeの起動待ちがタイムアウトしました。')), 15_000);
    chrome.on('error', reject);
    chrome.stderr.on('data', chunk => {
      if (chunk.toString().includes('DevTools listening')) { clearTimeout(timer); resolve(); }
    });
  });
  const [port] = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n');
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
  await once(socket, 'open');
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const handler = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) handler.reject(new Error(message.error.message));
      else handler.resolve(message.result);
    }
    if (message.method === 'Fetch.requestPaused') {
      const allowed = message.params.request.url.startsWith(base + '/');
      if (!allowed) externalRequests.push(message.params.request.url);
      void call(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId: message.params.requestId, ...(allowed ? {} : { errorReason: 'BlockedByClient' }) });
    }
    if (message.method === 'Network.requestWillBeSent' && message.params.request.method === 'POST') mappingPosts.push(message.params.request.url);
    if (message.method === 'Network.requestWillBeSentExtraInfo') requests.push(message.params);
    if (message.method === 'Network.requestWillBeSent' && /^https?:/.test(message.params.request.url) && new URL(message.params.request.url).origin !== base) externalRequests.push(message.params.request.url);
    if (message.method === 'Network.responseReceived') responses.push(message.params.response);
  });
  await call('Network.enable');
  await call('Page.enable');
  await call('Network.setBlockedURLs', { urls: ['https://*', 'http://*.openai.com/*'] });
  await call('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await call('Emulation.setScriptExecutionDisabled', { value: true });
  await call('Page.navigate', { url: base + route });
  await until(() => evaluate('Boolean(document.querySelector("[data-reflection-v2-form]"))'));
  assert.equal(await evaluate(`document.querySelectorAll('[name$=".mode"]').length`), 26);
  assert.equal(await evaluate('document.querySelectorAll("input:checked").length'), 0);
  assert.equal(await evaluate(`Array.from(document.querySelector('[name="candidate-20.mode"]').options).some(o => o.value === 'offer')`), false);
  assert.ok(await evaluate(`document.querySelector('#mapping-candidate-20').innerText.includes('現在のusage/classification')`));
  const beforeImport = await readFile(path.join(directory, 'offer-imports', draft.id + '.json'), 'utf8');
  const beforeOffer = await readFile(path.join(directory, 'offers', offer.id + '.json'), 'utf8');
  for (const width of [375, 1280]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'));
  }
  // Save just one explicit human choice; remaining 25 choices stay blank, without JS on the page.
  await evaluate(`document.querySelector('[name="candidate-1.mode"]').value = 'conversions'; document.querySelector('[name="candidate-1.target"][value="seminar"]').checked = true; document.querySelector('button[name="draftAction"]').click()`);
  await until(() => evaluate(`document.querySelector('[name="draftRevision"]')?.value === '1'`));
  assert.ok(await evaluate(`document.body.innerText.includes('入力済み 1件') && document.body.innerText.includes('未入力・未完了 25件')`));
  await call('Page.reload');
  await until(() => evaluate(`document.querySelector('[name="candidate-1.mode"]')?.value === 'conversions' && document.querySelector('[name="candidate-1.target"][value="seminar"]')?.checked`));
  assert.equal(await readFile(path.join(directory, 'offers', offer.id + '.json'), 'utf8'), beforeOffer);
  assert.equal(await readFile(path.join(directory, 'offer-imports', draft.id + '.json'), 'utf8'), beforeImport);
  // JS enhancement: a single location cannot accidentally acquire a common confirmation.
  await call('Emulation.setScriptExecutionDisabled', { value: false });
  await call('Page.navigate', { url: base + route });
  await until(() => evaluate(`document.querySelector('[name="candidate-4.common"]')?.disabled === true`));
  const savedDraftPath = path.join(directory, 'reflection-mapping-drafts', `${draft.id}--${offer.id}.json`);
  const beforeChoiceEdit = await readFile(savedDraftPath, 'utf8');
  const boundFields = await evaluate(`['draftRevision','importHash','offerHash','importRevision','offerRevision'].map(n => document.querySelector('[name="'+n+'"]').value)`);
  await evaluate(`(() => {
    const target = document.querySelector('[name="candidate-4.target"][value="seminar"]'); target.checked = true; target.dispatchEvent(new Event('change', {bubbles:true}));
  })()`);
  assert.equal(await evaluate(`document.querySelector('[name="candidate-4.mode"]').value`), '');
  assert.ok(await evaluate(`document.querySelector('#mapping-candidate-4 [data-mapping-status]').textContent.includes('地点1件は選択済みですが、未完了')`));
  assert.ok(await evaluate(`document.querySelector('[data-mapping-input-progress]').textContent.includes('入力完了 1件')`));
  await evaluate(`(() => { const mode = document.querySelector('[name="candidate-4.mode"]'); mode.value = 'conversions'; mode.dispatchEvent(new Event('change', {bubbles:true})); document.querySelector('[name="candidate-4.common"]').click(); })()`);
  assert.equal(await evaluate(`document.querySelector('[name="candidate-4.common"]').checked`), false);
  await evaluate(`(() => {
    const row = document.querySelector('#mapping-candidate-3'); document.querySelector('[name="candidate-3.mode"]').value='conversions';
    row.querySelectorAll('[data-mapping-target]').forEach(x => x.checked = true); row.dispatchEvent(new Event('change', {bubbles:true}));
    row.querySelector('[data-mapping-common]').click(); row.querySelector('[value="membership"]').checked=false; row.dispatchEvent(new Event('change', {bubbles:true}));
  })()`);
  assert.equal(await evaluate(`document.querySelector('[name="candidate-3.common"]').checked`), true);
  assert.equal(await evaluate(`document.querySelector('[name="candidate-3.common"]').disabled`), false);
  assert.equal(await evaluate(`document.querySelector('#mapping-candidate-3 [data-mapping-status]').dataset.status`), 'invalid');
  const countBeforeBlocked = mappingPosts.length;
  await evaluate(`document.querySelector('button[name="draftAction"]').click()`);
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(mappingPosts.length, countBeforeBlocked);
  assert.equal(await readFile(savedDraftPath, 'utf8'), beforeChoiceEdit);
  assert.deepEqual(await evaluate(`['draftRevision','importHash','offerHash','importRevision','offerRevision'].map(n => document.querySelector('[name="'+n+'"]').value)`), boundFields);
  await evaluate(`document.querySelector('[name="candidate-3.common"]').click(); document.querySelector('button[name="draftAction"]').click()`);
  await until(() => evaluate(`document.querySelector('[name="draftRevision"]')?.value === '2'`));
  assert.equal(await evaluate(`document.querySelector('[name="candidate-3.common"]').checked`), false);
  assert.equal(await evaluate(`document.querySelector('[name="candidate-4.mode"]').value`), 'conversions');
  const storedAfterHumanClear = JSON.parse(await readFile(savedDraftPath, 'utf8')).revisions.at(-1);
  assert.equal(storedAfterHumanClear.choices[2].commonConfirmed, false);
  assert.equal(storedAfterHumanClear.choices[2].conversionIds.length, 1);
  // Continue all native/server fallback checks with JS disabled again.
  await call('Emulation.setScriptExecutionDisabled', { value: true });
  await call('Page.navigate', { url: base + route });
  await until(() => evaluate(`document.querySelector('[name="draftRevision"]')?.value === '2'`));
  const fill = async options => {
    await evaluate(`(() => { const choices = ${JSON.stringify(options.choices)}; const form = document.querySelector('[data-reflection-v2-form]');
      for (const choice of choices) {
        form.elements.namedItem(choice.candidateId + '.mode').value = choice.mode;
        form.elements.namedItem(choice.candidateId + '.reason').value = choice.reason;
        for (const input of form.querySelectorAll('input')) {
          if (input.name === choice.candidateId + '.target') input.checked = choice.conversionIds.includes(input.value);
          if (input.name === choice.candidateId + '.common') input.checked = choice.commonConfirmed;
        }
      } form.querySelector('button').click(); })()`);
    await until(() => evaluate('Boolean(document.querySelector("input[name=token]"))'));
  };
  await fill(fixture.options);
  assert.equal(await evaluate('Boolean(document.querySelector("[data-reflection-v2-form]"))'), false);
  assert.equal(await readFile(path.join(directory, 'offers', offer.id + '.json'), 'utf8'), beforeOffer);
  assert.equal(await readFile(path.join(directory, 'offer-imports', draft.id + '.json'), 'utf8'), beforeImport);
  const oldToken = await evaluate('document.querySelector("input[name=token]").value');
  await evaluate(`document.querySelector('a[href*="reflection-v2?offerId="]').click()`);
  await until(() => evaluate('Boolean(document.querySelector("[data-reflection-v2-form]"))'));
  const stale = await fetch(base + `/offer-imports/${draft.id}/commit`, { method: 'POST', body: new URLSearchParams({ token: oldToken, confirm: 'yes' }), headers: { Origin: base }, redirect: 'manual' });
  assert.equal(stale.status, 409);
  await fill(fixture.options);
  for (const width of [375, 1280]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'));
  }
  await evaluate(`document.querySelector('input[name=confirm]').click(); document.querySelector('form[action$="/commit"] button').click()`);
  await until(() => evaluate('document.body.innerText.includes("反映記録・復旧確認")'));
  const saved = await fixture.offers.get(offer.id);
  assert.equal(saved.revision, 2); assert.equal(saved.status, 'draft');
  assert.equal(saved.conversions[0].eligibility.length, 1); assert.equal(saved.conversions[1].eligibility.length, 1);
  assert.equal(saved.conversions[0].rejectionConditions.length, 1); assert.equal(saved.conversions[1].rejectionConditions.length, 1);
  assert.notEqual(saved.conversions[0].eligibility[0].id, saved.conversions[1].eligibility[0].id);
  assert.equal(await readFile(path.join(directory, 'offer-imports', draft.id + '.json'), 'utf8'), beforeImport);
  await call('Page.navigate', { url: base + '/maintenance/integrity' });
  await until(() => evaluate('document.body.innerText.includes("対応判断の下書きが古いため再開できません")'));
  // Use the original server/store for a new large import so all browser requests remain in the allowed local origin.
  const f = regulationFixture();
  f.extraction.candidates = Array.from({ length: 200 }, () => structuredClone(f.extraction.candidates[1]));
  const largeDraft = await store.create({ targetOffer: { id: offer.id, revision: saved.revision }, ...f });
  await call('Page.navigate', { url: base + `/offer-imports/${largeDraft.id}/reflection-v2` });
  await until(() => evaluate(`document.querySelectorAll('[name$=".mode"]').length === 200`));
  for (const width of [375, 1280]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'));
  }
  await evaluate(`document.querySelector('[name="candidate-1.mode"]').value = 'none'; document.querySelector('[name="candidate-1.reason"]').value = '架空の後日検討'; document.querySelector('button[name="draftAction"]').click()`);
  await until(() => evaluate(`document.querySelector('[name="draftRevision"]')?.value === '1'`));
  assert.ok(await evaluate(`document.body.innerText.includes('入力済み 1件') && document.body.innerText.includes('未入力・未完了 199件')`));
  for (const width of [375, 1280]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'));
  }
  assert.deepEqual(externalRequests, []);
  assert.equal(blockedConnections.length, 0);
  console.log('reflection v2ブラウザ確認成功：JS有効のcommon不整合送信停止・mode未補完・JS無効・26/200候補・固有/共通対応・反映なし理由・承認失効・別承認POST・review不変・26/200途中下書き保存復元・maintenance下書きstale警告・375/1280px。外部通信/試行0件。');
} finally {
  if (socket) socket.close();
  chrome.kill('SIGTERM');
  await new Promise(resolve => server.close(resolve));
}
