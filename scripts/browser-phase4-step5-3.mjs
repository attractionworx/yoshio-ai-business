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
import { affiliateDraftFixture } from '../test/fixtures/affiliate-draft.js';

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
let pageLoads = 0;
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
    if (message.method === 'Page.loadEventFired') pageLoads++;
    if (message.method === 'Fetch.requestPaused') {
      const allowed = message.params.request.url.startsWith(base + '/');
      if (!allowed) externalRequests.push(message.params.request.url);
      void call(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId: message.params.requestId, ...(allowed ? {} : { errorReason: 'BlockedByClient' }) })
        .catch(error => { if (!/Invalid InterceptionId/u.test(error.message)) interceptionErrors.push(error.message); });
    }
    if (message.method === 'Network.requestWillBeSentExtraInfo') requests.push(message.params);
    if (message.method === 'Network.requestWillBeSent' && /^https?:/.test(message.params.request.url) && new URL(message.params.request.url).origin !== base) externalRequests.push(message.params.request.url);
    if (message.method === 'Network.responseReceived') responses.push(message.params.response);
  });
  await call('Network.enable');
  await call('Page.enable');
  await call('Network.setBlockedURLs', { urls: ['https://*', 'http://*.openai.com/*'] });
  await call('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  async function scenario(changes = {}) {
    const c = await affiliateDraftFixture(null, changes, dataDirectory);
    await writeFile(path.join(dataDirectory, `${c.plan.id}.json`), JSON.stringify(c.plan));
    return c;
  }
  const normal = await scenario();
  const warning = await scenario({ summary: '料金999円です。' });
  const block = await scenario({ summary: '絶対成功' });
  const stale = await scenario(); stale.draft.affiliateValidation.validationVersion = 'old';
  await writeFile(stale.file, JSON.stringify(stale.draft));
  const legacy = await scenario(); delete legacy.draft.affiliateValidation;
  await writeFile(legacy.file, JSON.stringify(legacy.draft));
  const plain = await scenario(); delete plain.draft.affiliateContext; delete plain.draft.affiliateValidation; delete plain.draft.affiliateValidationRunId;
  await writeFile(plain.file, JSON.stringify(plain.draft));
  async function navigate(url) {
    const previous = pageLoads;
    await call('Page.navigate', { url: base + url });
    await until(() => pageLoads > previous);
    await until(() => evaluate('Boolean(document.querySelector("[data-publish]"))'));
  }
  async function submit() {
    const previous = pageLoads;
    await evaluate('document.querySelector("[data-publish]").requestSubmit(document.querySelector("button[value=ready]"))');
    await until(() => pageLoads > previous);
    await until(() => evaluate('Boolean(document.querySelector("[data-publish]"))'));
  }
  async function basic() {
    await evaluate('document.querySelector("[name=titleIndex]").value = "0"');
    for (const name of ['experience', 'numbers', 'links']) await evaluate(`document.querySelector('[name=${name}]').checked = true`);
  }
  async function required() {
    for (const name of ['affiliateFacts', 'affiliateProhibited', 'affiliateDisclosure', 'affiliateCta']) await evaluate(`document.querySelector('[name=${name}]').checked = true`);
  }
  async function warnings() {
    const names = await evaluate('[...document.querySelectorAll("[data-affiliate-warnings] input")].map(input => input.name)');
    for (const name of names) await evaluate(`document.getElementsByName(${JSON.stringify(name)})[0].checked = true`);
  }
  const route = c => `/drafts/${c.draft.id}/publish`;
  await navigate(route(normal)); await basic(); await submit();
  assert.match(await evaluate('document.body.innerText'), /必須.*4項目/);
  assert.equal(JSON.parse(await readFile(normal.file, 'utf8')).publication, undefined);
  await basic(); await required(); await submit();
  assert.match(await evaluate('document.body.innerText'), /warningを1件ずつ/);
  await basic(); await required(); await warnings(); await submit();
  assert.equal(await evaluate('document.getElementById("publish-status").textContent'), '公開準備OK');
  assert.ok(JSON.parse(await readFile(normal.file, 'utf8')).publication.affiliate.humanConfirmation.confirmedAt);
  for (const width of [375, 1280]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
    await evaluate('document.querySelector("[data-affiliate-publish]").scrollIntoView()');
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), `公開確認幅${width}`);
    const screenshot = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(directory, `human-confirmation-${width}.png`), Buffer.from(screenshot.data, 'base64'));
  }
  await navigate(route(warning)); await basic(); await required();
  const names = await evaluate('[...document.querySelectorAll("[data-affiliate-warnings] input")].map(input => input.name)');
  assert.ok(names.length >= 2);
  await evaluate(`document.getElementsByName(${JSON.stringify(names[0])})[0].checked = true`); await submit();
  assert.match(await evaluate('document.body.innerText'), /warningを1件ずつ/);
  await basic(); await required(); await warnings(); await submit();
  assert.equal(await evaluate('document.getElementById("publish-status").textContent'), '公開準備OK');
  await navigate(route(block)); assert.match(await evaluate('document.body.innerText'), /チェックでは解除できません/);
  await basic(); await required(); await warnings(); await submit();
  assert.match(await evaluate('document.body.innerText'), /block finding/);
  assert.equal(await evaluate('[...document.querySelectorAll("[data-publication-copy]")].every(b => b.disabled)'), true);
  await navigate(route(stale));
  assert.equal(await evaluate('document.querySelector("[data-affiliate-publish]").dataset.validationState'), 'stale');
  await basic(); await submit(); assert.match(await evaluate('document.body.innerText'), /再検査/);
  await navigate(route(legacy));
  assert.equal(await evaluate('document.querySelector("[data-affiliate-publish]").dataset.validationState'), 'unvalidated');
  assert.match(await evaluate('document.body.innerText'), /下書きで再検査/);
  await basic(); await submit(); assert.match(await evaluate('document.body.innerText'), /currentではありません/);
  assert.equal(JSON.parse(await readFile(legacy.file, 'utf8')).affiliateValidation, undefined);
  await navigate(route(plain)); assert.equal(await evaluate('Boolean(document.querySelector("[data-affiliate-publish]"))'), false);
  await basic(); await submit(); assert.equal(await evaluate('document.getElementById("publish-status").textContent'), '公開準備OK');
  for (const width of [375, 1280]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), `案件なし幅${width}`);
  }
  assert.equal(apiCalls.length, 0); assert.deepEqual(externalRequests, []); assert.deepEqual(interceptionErrors, []); assert.equal(blockedConnections.length, 0);
  console.log('Step 5.3ブラウザ検証成功：正常案件の人間確認前拒否→4確認→warning個別確認→公開準備OK、複数warning、block拒否、stale拒否、Step 4旧draft再検査誘導、案件なし互換。375/1280px。実API/ASP/外向き通信0件。');
  console.log(`ブラウザ画像: ${directory}/human-confirmation-375.png, ${directory}/human-confirmation-1280.png`);
} finally {
  if (socket) socket.close();
  chrome.kill('SIGTERM');
  await new Promise(resolve => server.close(resolve));
}
