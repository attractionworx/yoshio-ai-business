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
import { createOpenAIProvider } from '../lib/ai/openai-provider.js';
import { openaiConfig } from '../lib/ai/config.js';
import { fakeContent } from '../lib/ai/fake-provider.js';

const directory = await mkdtemp(path.join(tmpdir(), 'yoshio-browser-phase4-'));
await mkdir(directory, { recursive: true });
const dataDirectory = await mkdtemp(path.join(directory, 'run-'));
const apiCalls = [];
const provider = createOpenAIProvider({ client: { responses: { create: async args => {
  apiCalls.push(args);
  return { status: 'completed', output_text: JSON.stringify(fakeContent), usage: { input_tokens: 1000, output_tokens: 2000 } };
} } } });
const server = createApp({ dataDirectory, generationOptions: { provider, config: openaiConfig } });
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
  const input = offerInput(); input.name = 'Step 4ブラウザ用の架空案件';
  input.facts[0].text = '固定版の公開情報の目印';
  input.conversions[0].name = '架空のセミナー予約';
  const offer = await store.create(input);
  async function navigate(url, selector) {
    await call('Page.navigate', { url: base + url });
    await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`));
    if (selector === '[data-plan-form]') await until(() => evaluate("document.querySelector('[data-plan-offer]')?.dataset.ready === 'true'"));
  }
  async function select(name, value) {
    await evaluate(`(() => { const field = document.getElementsByName(${JSON.stringify(name)})[0]; field.value = ${JSON.stringify(value)}; field.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  }
  await navigate('/', '[data-plan-form]');
  await select('theme', 'Step 4ブラウザ専用の架空企画');
  await select('offerId', offer.id); await select('conversionId', 'consultation');
  await select('selectionReason', '人間が記録する理由の目印');
  await evaluate('document.querySelector("[data-plan-form]").requestSubmit()');
  await until(() => evaluate('Boolean(document.querySelector(".detail [data-plan-binding]"))'));
  const planPath = await evaluate('location.pathname');
  const filename = path.join(dataDirectory, planPath.split('/').at(-1) + '.json');
  const originalPlan = await readFile(filename, 'utf8');
  await navigate(planPath + '/generate', '[data-generate]');
  let body = await evaluate('document.body.innerText');
  for (const text of ['Step 4ブラウザ用の架空案件', '架空のセミナー予約', 'offer revision', '現在の案件status：active', '人間が記録する理由の目印']) assert.ok(body.includes(text), text);
  await evaluate('document.querySelector("[data-affiliate-context] details").open = true');
  assert.match(await evaluate('document.body.innerText'), /固定版の公開情報の目印/);
  assert.equal(apiCalls.length, 0);
  async function generate() {
    await evaluate('document.querySelector("[data-generate]").requestSubmit()');
    await until(() => evaluate('Boolean(document.querySelector("[data-generated-draft]"))'));
    const draftPath = await evaluate('document.querySelector("[data-generated-draft]").getAttribute("href")');
    await navigate(draftPath, '[data-affiliate-context]');
    return JSON.parse(await readFile(path.join(dataDirectory, 'drafts', draftPath.split('/').at(-1) + '.json'), 'utf8'));
  }
  const first = await generate();
  assert.equal(first.affiliateContext.offerId, offer.id); assert.equal(first.affiliateContext.offerRevision, 1);
  assert.equal(first.affiliateContext.conversionId, 'consultation');
  assert.match(await evaluate('document.body.innerText'), new RegExp(first.affiliateContext.contextHash));
  assert.equal(apiCalls.length, 1);
  assert.ok(apiCalls[0].instructions.includes('固定版の公開情報の目印'));
  assert.ok(!apiCalls[0].instructions.includes('人間が記録する理由の目印'));
  const updated = structuredClone(input); updated.name = '新revisionだけの名前'; updated.facts[0].text = '新revisionだけの情報';
  await store.update(offer.id, 1, updated);
  await navigate(planPath + '/generate', '[data-generate]');
  assert.match(await evaluate('document.body.innerText'), /現在の案件 revision 2/);
  const second = await generate(); assert.equal(second.affiliateContext.offerRevision, 1);
  assert.equal(second.affiliateContext.contextHash, first.affiliateContext.contextHash);
  assert.ok(!apiCalls[1].instructions.includes('新revisionだけ')); assert.equal(apiCalls.length, 2);
  await navigate(planPath + '/generate', '[data-generate]');
  await store.update(offer.id, 2, { ...updated, status: 'paused' });
  await evaluate('document.querySelector("[data-generate]").requestSubmit()');
  await until(() => evaluate('Boolean(document.querySelector("[role=alert]"))'));
  assert.match(await evaluate('document.body.innerText'), /paused/); assert.equal(apiCalls.length, 2);
  await navigate(planPath + '/generate', '[data-current-offer-status]');
  assert.match(await evaluate('document.body.innerText'), /現在この案件はpaused/);
  assert.equal(await evaluate('Boolean(document.querySelector("[data-generate]"))'), false);
  for (const width of [375, 1280]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
    await evaluate('document.querySelector("[data-affiliate-context] details").open = true');
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), `表示幅${width}`);
  }
  assert.equal(await readFile(filename, 'utf8'), originalPlan);
  assert.deepEqual(externalRequests, []); assert.equal(blockedConnections.length, 0);
  console.log('Phase 4 Step 4ブラウザ検証成功：架空案件の紐付け→確認情報表示→明示生成→draft根拠保存→案件改訂後も旧revision→古い確認でpaused拒否→生成フォーム停止。375/1280px。SDK mock呼出し2回・実API/ASPアクセス/外部通信0件。');
} finally {
  if (socket) socket.close();
  chrome.kill('SIGTERM');
  await new Promise(resolve => server.close(resolve));
}
