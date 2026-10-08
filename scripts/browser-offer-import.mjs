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
const fixture = regulationFixture();
fixture.extraction.candidates.push(...Array.from({ length: 17 }, () => structuredClone(fixture.extraction.candidates[1])));
const draft = await store.create({ targetOffer: null, ...fixture });
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
  const waitCandidate = (id, revision) => until(() => evaluate(`document.querySelector('.import-candidate')?.id === '${id}' && document.querySelector('.import-candidate input[name=revision]')?.value === '${revision}'`));
  const openCandidate = async (id, revision) => {
    await call('Page.navigate', { url: base + route + `?candidate=${id}&view=all#${id}` });
    await waitCandidate(id, revision);
  };
  const review = decision => evaluate(`document.querySelector('[data-candidate-review] button[value=${decision}]').click()`);
  const verify = () => evaluate('document.querySelector("input[name=confirm]").click(); document.querySelector(".import-verification button").click()');
  await call('Page.navigate', { url: base + route });
  await waitCandidate('candidate-1', 1);
  assert.equal(await evaluate('document.querySelectorAll(".import-candidate").length'), 1);
  assert.equal(await evaluate('document.querySelector("[data-review-count=total]").textContent'), '26');
  assert.equal(await evaluate('document.querySelector("[data-review-count=actionable]").textContent'), '26');
  await until(() => evaluate('document.activeElement.matches("[data-review-focus]")'));
  // GET selection through a real keyboard-activated link writes nothing.
  const initialSnapshot = await readFile(path.join(dataDirectory, 'offer-imports', draft.id + '.json'), 'utf8');
  await evaluate(`document.querySelector('.import-candidate-nav a[href*="candidate=candidate-2&"]').focus()`);
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  assert.ok(await evaluate('document.activeElement.matches(":focus-visible")'));
  await evaluate(`document.querySelector('.import-candidate-nav a[href*="candidate=candidate-2&"]').focus()`);
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await waitCandidate('candidate-2', 1);
  assert.equal(await readFile(path.join(dataDirectory, 'offer-imports', draft.id + '.json'), 'utf8'), initialSnapshot);
  for (const width of [375, 1280]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), `width ${width}`);
  }
  await review('accepted'); await waitCandidate('candidate-2', 2);
  await until(() => evaluate('document.activeElement.id === "candidate-2-verification"'));
  assert.equal((await store.get(draft.id)).candidates[1].review.verification, 'unverified');
  assert.equal(await evaluate('document.querySelector("input[name=confirm]").checked'), false);
  await evaluate(`(() => {
    const field = document.querySelector('textarea[name=text]');
    field.value += ' 要確認。'; field.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  assert.equal(await evaluate('document.querySelector(".import-verification button").disabled'), true);
  await review('accepted'); await waitCandidate('candidate-2', 3);
  await verify(); await waitCandidate('candidate-3', 4);
  assert.equal((await store.get(draft.id)).candidates[1].review.verification, 'source_checked');
  assert.equal(await evaluate('document.querySelector("[data-review-count=completed]").textContent'), '1');
  assert.equal(await evaluate('document.body.innerText.includes("操作はまだ実行していません。")'), false);
  // Explicit complete selection overrides actionable; expansion has no writes.
  await openCandidate('candidate-2', 4);
  assert.equal(await evaluate('Boolean(document.querySelector(".import-verification"))'), false);
  const checkedSnapshot = await readFile(path.join(dataDirectory, 'offer-imports', draft.id + '.json'), 'utf8');
  await evaluate('document.querySelector(".import-candidate details").open = true');
  assert.equal(await readFile(path.join(dataDirectory, 'offer-imports', draft.id + '.json'), 'utf8'), checkedSnapshot);
  // Independent candidate update invalidates this tab's whole-import revision.
  await store.review(draft.id, 'candidate-9', 4, { decision: 'rejected', edited: null, sourceChecked: false, reason: '' });
  await review('accepted');
  await until(() => evaluate('document.body.innerText.includes("レビューを停止しました")'));
  assert.equal(await evaluate('Boolean(document.querySelector("form"))'), false);
  assert.equal((await store.get(draft.id)).revision, 5);
  // Native GET links and separate POST operations remain sufficient without scripts.
  await call('Emulation.setScriptExecutionDisabled', { value: true });
  await openCandidate('candidate-2', 5);
  await review('accepted'); await waitCandidate('candidate-2', 6);
  assert.equal((await store.get(draft.id)).candidates[1].review.verification, 'unverified');
  assert.equal(await evaluate('document.querySelector("input[name=confirm]").checked'), false);
  await verify(); await waitCandidate('candidate-3', 7);
  await review('pending'); await waitCandidate('candidate-4', 8);
  assert.equal((await store.get(draft.id)).candidates[2].review.decision, 'pending');
  await review('rejected'); await waitCandidate('candidate-5', 9);
  assert.equal(await evaluate('document.querySelector("[data-review-count=completed]").textContent'), '3');
  await call('Page.navigate', { url: base + route + '/revisions/1?candidate=candidate-2' });
  await until(() => evaluate('document.body.innerText.includes("過去版の閲覧") && document.querySelector(".import-candidate")?.id === "candidate-2"'));
  assert.equal(await evaluate('Boolean(document.querySelector("form"))'), false);
  // Maximum candidate count, long body and 20 distinct document citations.
  const many = regulationFixture();
  const payload = structuredClone(many.extraction.candidates[1]);
  many.documents = Array.from({ length: 20 }, (_, i) => ({ ...structuredClone(many.documents[0]), id: `document-${i + 1}` }));
  payload.text = '長い架空候補本文。'.repeat(400);
  payload.evidence = many.documents.map(d => ({ ...structuredClone(payload.evidence[0]), documentId: d.id }));
  many.extraction.candidates = Array.from({ length: 200 }, () => structuredClone(payload));
  const large = await store.create({ targetOffer: null, ...many });
  const largeBefore = await readFile(path.join(dataDirectory, 'offer-imports', large.id + '.json'), 'utf8');
  await call('Page.navigate', { url: base + `/offer-imports/${large.id}?candidate=candidate-200&view=all#candidate-200` });
  await waitCandidate('candidate-200', 1);
  assert.equal(await evaluate('document.querySelector("[data-review-count=total]").textContent'), '200');
  assert.equal(await evaluate('document.querySelectorAll(".import-candidate").length'), 1);
  assert.equal(await evaluate('document.querySelectorAll(".import-candidate blockquote").length'), 20);
  assert.equal(await evaluate('document.querySelectorAll(".import-candidate-nav li").length'), 200);
  for (const width of [375, 1280]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), `200 candidates width ${width}`);
  }
  assert.equal(await readFile(path.join(dataDirectory, 'offer-imports', large.id + '.json'), 'utf8'), largeBefore);
  assert.deepEqual(await readdir(dataDirectory), ['offer-imports']);
  assert.deepEqual(externalRequests, []);
  assert.equal(blockedConnections.length, 0);
  console.log('レビューUX Step 2ブラウザ確認成功：26/200候補・詳細1件・20引用/長文・GET選択・保存後遷移・進捗・照合済み再表示は無変更・確認解除・全体revision競合・履歴・JSなし採用/照合/保留/却下・keyboard/focus-visible・375/1280px。外部通信/試行0件。');
} finally {
  if (socket) socket.close();
  chrome.kill('SIGTERM');
  await new Promise(resolve => server.close(resolve));
}
