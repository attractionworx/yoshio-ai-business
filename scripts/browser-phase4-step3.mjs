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
import { createOfferStore } from '../lib/offers/store.js';
import { offerInput } from '../test/fixtures/plan-offer.js';

const directory = await mkdtemp(path.join(tmpdir(), 'yoshio-browser-phase4-'));
await mkdir(directory, { recursive: true });
const dataDirectory = await mkdtemp(path.join(directory, 'run-'));
const server = createApp({ dataDirectory });
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
  const store = createOfferStore(dataDirectory);
  const offer = await store.create({ ...offerInput(), name: 'ブラウザ専用の架空案件' });
  const second = await store.create({ ...offerInput(), name: '別の架空案件' });
  const paused = await store.create({ ...offerInput(), name: '新規選択できない架空案件', status: 'paused' });
  async function navigate(url, selector) {
    await call('Page.navigate', { url: base + url });
    await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`));
    if (selector === '[data-plan-form]') await until(() => evaluate("document.querySelector('[data-plan-offer]')?.dataset.ready === 'true'"));
  }
  async function select(name, value) {
    await evaluate(`(() => { const field = document.getElementsByName(${JSON.stringify(name)})[0]; field.value = ${JSON.stringify(value)}; field.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  }
  async function submit() {
    await evaluate('document.querySelector("[data-plan-form]").requestSubmit()');
    await until(() => evaluate('Boolean(document.querySelector(".detail [data-plan-binding]"))'));
  }
  await navigate('/', '[data-plan-form]');
  assert.equal(await evaluate(`Boolean(document.querySelector('option[value="${paused.id}"]'))`), false);
  await select('theme', 'ブラウザで案件を紐付け');
  await select('offerId', offer.id);
  assert.equal(await evaluate('document.getElementsByName("conversionId")[0].value'), '');
  assert.equal(await evaluate('document.getElementsByName("conversionId")[0].options.length'), 3);
  await select('conversionId', 'consultation');
  await select('selectionReason', '初心者向けの記事と相性が良いため');
  await submit();
  const planPath = await evaluate('location.pathname');
  const filename = path.join(dataDirectory, planPath.split('/').at(-1) + '.json');
  const readPlan = async () => JSON.parse(await readFile(filename, 'utf8'));
  const initial = (await readPlan()).offerBinding;
  assert.equal(initial.offerId, offer.id); assert.equal(initial.offerRevision, 1);
  assert.equal(initial.conversionId, 'consultation'); assert.equal(initial.selectionReason, '初心者向けの記事と相性が良いため');
  await store.update(offer.id, 1, { ...offerInput(), name: '更新後の案件名' });
  await navigate(planPath, '[data-plan-binding]');
  assert.match(await evaluate('document.body.innerText'), /現在の案件は revision 2/);
  assert.match(await evaluate('document.body.innerText'), /ブラウザ専用の架空案件/);
  await navigate(planPath + '/edit', '[data-plan-form]');
  await select('notes', '案件を変更せず通常編集');
  assert.equal(await evaluate('document.getElementsByName("offerRevision")[0].value'), '1');
  await submit(); assert.deepEqual((await readPlan()).offerBinding, initial);
  await store.update(offer.id, 2, { ...offerInput(), status: 'paused' });
  await navigate(planPath, '[data-plan-binding]');
  assert.match(await evaluate('document.body.innerText'), /現在この案件はpausedです/);
  await navigate(planPath + '/edit', '[data-plan-form]');
  await submit(); assert.deepEqual((await readPlan()).offerBinding, initial);
  await navigate(planPath + '/edit', '[data-plan-form]');
  await select('offerId', second.id);
  assert.equal(await evaluate('document.getElementsByName("conversionId")[0].value'), '');
  await select('conversionId', 'contract'); await submit();
  assert.equal((await readPlan()).offerBinding.offerId, second.id);
  assert.equal((await readPlan()).offerBinding.conversionId, 'contract');
  await store.update(second.id, 1, offerInput());
  await navigate(planPath + '/edit', '[data-plan-form]');
  await select('conversionId', 'consultation');
  assert.equal(await evaluate('document.getElementsByName("offerRevision")[0].value'), '2');
  await select('conversionId', 'contract');
  assert.equal(await evaluate('document.getElementsByName("offerRevision")[0].value'), '1');
  await select('conversionId', 'consultation'); await submit();
  assert.equal((await readPlan()).offerBinding.offerRevision, 2);
  for (const width of [375, 1280]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
    await navigate(planPath + '/edit', '[data-plan-form]');
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), `フォーム幅${width}`);
  }
  await select('offerId', '');
  await evaluate('document.querySelector("[data-plan-form]").requestSubmit()');
  await until(() => evaluate('Boolean(document.querySelector(".detail"))'));
  assert.equal((await readPlan()).offerBinding, undefined);
  assert.deepEqual(externalRequests, []); assert.equal(blockedConnections.length, 0);
  console.log('Phase 4 Step 3ブラウザ確認成功：案件・成果地点の明示選択、理由保存、旧revision保持、paused警告と保存、別案件・別成果地点変更、元の選択に戻した場合のrevision保持、解除、375/1280px。外部通信0件。');
} finally {
  if (socket) socket.close();
  chrome.kill('SIGTERM');
  await new Promise(resolve => server.close(resolve));
}
