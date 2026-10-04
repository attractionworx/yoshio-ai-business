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

const directory = await mkdtemp(path.join(tmpdir(), 'yoshio-browser-phase4-'));
await mkdir(directory, { recursive: true });
const dataDirectory = await mkdtemp(path.join(directory, 'run-'));
const store = createOfferImportStore(dataDirectory);
const draft = await store.create({ targetOffer: null, ...regulationFixture() });
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
    if (message.method === 'Network.requestWillBeSentExtraInfo') requests.push(message.params);
    if (message.method === 'Network.requestWillBeSent' && /^https?:/.test(message.params.request.url) && new URL(message.params.request.url).origin !== base) externalRequests.push(message.params.request.url);
    if (message.method === 'Network.responseReceived') responses.push(message.params.response);
  });
  await call('Network.enable');
  await call('Page.enable');
  await call('Network.setBlockedURLs', { urls: ['https://*', 'http://*.openai.com/*'] });
  await call('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await call('Page.navigate', { url: base + route });
  await until(() => evaluate('Boolean(document.querySelector("#candidate-2 form"))'));
  for (const width of [375, 1280]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), `width ${width}`);
  }
  await evaluate('document.querySelector("#candidate-2 button[value=accepted]").click()');
  await until(() => evaluate('Boolean(document.querySelector("#candidate-2 .import-verification"))'));
  assert.equal((await store.get(draft.id)).candidates[1].review.verification, 'unverified');
  assert.equal(await evaluate('document.querySelector("#candidate-2 input[name=confirm]").checked'), false);
  await evaluate(`(() => {
    const field = document.querySelector('#candidate-2 textarea[name=text]');
    field.value += ' 要確認。'; field.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  assert.equal(await evaluate('document.querySelector("#candidate-2 .import-verification button").disabled'), true);
  await evaluate('document.querySelector("#candidate-2 button[value=accepted]").click()');
  await until(() => evaluate('document.querySelector("#candidate-2 input[name=revision]").value === "3"'));
  await evaluate('document.querySelector("#candidate-2 input[name=confirm]").click(); document.querySelector("#candidate-2 .import-verification button").click()');
  await until(() => evaluate('document.querySelector("#candidate-2 input[name=revision]").value === "4"'));
  assert.equal((await store.get(draft.id)).candidates[1].review.verification, 'source_checked');
  // An independent store writes after the page loads; the browser must stop on conflict.
  await store.review(draft.id, 'candidate-3', 4, { decision: 'rejected', edited: null, sourceChecked: false, reason: '' });
  await evaluate('document.querySelector("#candidate-2 button[value=rejected]").click()');
  await until(() => evaluate('document.body.innerText.includes("レビューを停止しました")'));
  assert.equal(await evaluate('Boolean(document.querySelector("form"))'), false);
  assert.equal((await store.get(draft.id)).revision, 5);
  await call('Page.navigate', { url: base + route });
  await until(() => evaluate('Boolean(document.querySelector("#candidate-2 form"))'));
  // Native forms remain usable when script execution is disabled.
  await call('Emulation.setScriptExecutionDisabled', { value: true });
  await call('Page.navigate', { url: base + route });
  await until(() => evaluate('document.querySelector("#candidate-2 input[name=revision]").value === "5"'));
  await evaluate('document.querySelector("#candidate-2 button[value=pending]").click()');
  await until(() => evaluate('document.querySelector("#candidate-2 input[name=revision]").value === "6"'));
  assert.equal((await store.get(draft.id)).candidates[1].review.verification, 'unverified');
  await call('Page.navigate', { url: base + route + '/revisions/1' });
  await until(() => evaluate('document.body.innerText.includes("過去版の閲覧")'));
  assert.equal(await evaluate('Boolean(document.querySelector("form"))'), false);
  assert.deepEqual(await readdir(dataDirectory), ['offer-imports']);
  assert.deepEqual(externalRequests, []);
  assert.equal(blockedConnections.length, 0);
  console.log('Step 3ブラウザ確認成功：採用・修正・個別照合・確認解除・競合停止・履歴・JSなし・375/1280px。外部API通信0件。');
} finally {
  if (socket) socket.close();
  chrome.kill('SIGTERM');
  await new Promise(resolve => server.close(resolve));
}
