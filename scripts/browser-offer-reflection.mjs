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
import { createOfferStore } from '../lib/offers/store.js';
import { newOfferInput } from '../lib/offers/form.js';

const directory = await mkdtemp(path.join(tmpdir(), 'yoshio-browser-phase4-'));
await mkdir(directory, { recursive: true });
const dataDirectory = await mkdtemp(path.join(directory, 'run-'));
const store = createOfferImportStore(dataDirectory);
const offers = createOfferStore(dataDirectory);
const offer = await offers.create({ ...newOfferInput(), name: '架空の正式反映先', asp: { code: 'fictional', programId: null } });
let draft = await store.create({ targetOffer: { id: offer.id, revision: offer.revision }, ...regulationFixture() });
for (const index of [2, 3, 4]) draft = await store.review(draft.id, `candidate-${index}`, draft.revision, { decision: 'accepted', edited: null, sourceChecked: true, reason: '' });
const route = `/offer-imports/${draft.id}`;
const server = createApp({ dataDirectory, offerImportOptions: { store } });
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
const responses = [];
const externalRequests = [];
const interceptionErrors = [];
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
      void call(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId: message.params.requestId, ...(allowed ? {} : { errorReason: 'BlockedByClient' }) })
        .catch(error => {
          // Navigation may cancel an already paused request. Only that cancellation is benign.
          if (error.message !== 'Invalid InterceptionId.') interceptionErrors.push(error.message);
        });
    }
    if (message.method === 'Network.requestWillBeSentExtraInfo') requests.push(message.params);
    if (message.method === 'Network.requestWillBeSent' && /^https?:/.test(message.params.request.url) && new URL(message.params.request.url).origin !== base) externalRequests.push(message.params.request.url);
    if (message.method === 'Network.responseReceived') responses.push(message.params.response);
  });
  await call('Network.enable');
  await call('Page.enable');
  await call('Network.setBlockedURLs', { urls: ['https://*', 'http://*.openai.com/*'] });
  await call('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await call('Page.navigate', { url: base + route });
  await until(() => evaluate('Boolean(document.querySelector("a[href$=reflection]"))'));
  await evaluate('document.querySelector("a[href$=reflection]").click()');
  await until(() => evaluate('document.body.innerText.includes("正式案件への反映プレビュー")'));
  assert.equal((await offers.get(offer.id)).revision, 1);
  for (const width of [375, 1280]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), `width ${width}`);
  }
  assert.equal(await evaluate('document.querySelector("form[action$=commit] input[name=confirm]").checked'), false);
  await evaluate('document.querySelector("form[action$=commit] input[name=confirm]").click(); document.querySelector("form[action$=commit] button").click()');
  await until(() => evaluate('document.body.innerText.includes("committed")'));
  assert.equal((await offers.get(offer.id)).revision, 2);
  // Additional checked candidate creates a new preview; external edit makes its approval stale.
  draft = await store.get(draft.id);
  await store.review(draft.id, 'candidate-6', draft.revision, { decision: 'accepted', edited: null, sourceChecked: true, reason: '' });
  await call('Page.navigate', { url: base + route + '/reflection' });
  await until(() => evaluate('Boolean(document.querySelector("form[action$=commit]"))'));
  const current = await offers.get(offer.id);
  const { id: ignoredId, schemaVersion, revision, createdAt, updatedAt, ...business } = current;
  await offers.update(offer.id, current.revision, business);
  await evaluate('document.querySelector("form[action$=commit] input[name=confirm]").click(); document.querySelector("form[action$=commit] button").click()');
  await until(() => evaluate('document.body.innerText.includes("レビューを停止しました")'));
  assert.equal(await evaluate('Boolean(document.querySelector("form"))'), false);
  assert.equal((await offers.get(offer.id)).revision, 3);
  assert.deepEqual((await readdir(dataDirectory)).sort(), ['offer-import-commits', 'offer-imports', 'offers']);
  assert.deepEqual(externalRequests, []); assert.deepEqual(interceptionErrors, []); assert.equal(blockedConnections.length, 0);
  console.log('Step 4ブラウザ確認成功：反映導線・プレビュー無保存・明示承認・監査履歴・古い版停止・375/1280px。外向き通信0件。');
} finally {
  if (socket) socket.close();
  chrome.kill('SIGTERM');
  await new Promise(resolve => server.close(resolve));
}
