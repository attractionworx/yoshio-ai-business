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
  const store = createOfferStore(dataDirectory);
  const input = offerInput(); input.name = 'Step 5.2ブラウザ用架空案件';
  const offer = await store.create(input);
  async function navigate(url, selector) {
    await call('Page.navigate', { url: base + url });
    await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`));
    if (selector === '[data-plan-form]') await until(() => evaluate("document.querySelector('[data-plan-offer]')?.dataset.ready === 'true'"));
  }
  async function fill(name, value, event = 'change') {
    await evaluate(`(() => { const field = document.getElementsByName(${JSON.stringify(name)})[0]; field.value = ${JSON.stringify(value)}; field.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true })); })()`);
  }
  await navigate('/', '[data-plan-form]');
  await fill('theme', 'Step 5.2ブラウザ専用架空企画');
  await fill('offerId', offer.id); await fill('conversionId', 'consultation');
  await evaluate('document.querySelector("[data-plan-form]").requestSubmit()');
  await until(() => evaluate('Boolean(document.querySelector(".detail [data-plan-binding]"))'));
  const planPath = await evaluate('location.pathname');
  await navigate(planPath + '/generate', '[data-generate]');
  await evaluate('document.querySelector("[data-generate]").requestSubmit()');
  await until(() => evaluate('Boolean(document.querySelector("[data-generated-draft]"))'));
  const draftPath = await evaluate('document.querySelector("[data-generated-draft]").getAttribute("href")');
  await navigate(draftPath, '[data-affiliate-validation]');
  const draftFile = path.join(dataDirectory, 'drafts', draftPath.split('/').at(-1) + '.json');
  const initial = JSON.parse(await readFile(draftFile, 'utf8'));
  assert.equal(await evaluate('document.querySelector("[data-affiliate-validation]").dataset.validationState'), 'current');
  for (const text of ['検査済み', 'block：', 'warning：', 'info：', 'validationVersion', 'checkedAt', '記事の正しさや公開可否を保証しません']) assert.ok((await evaluate('document.body.innerText')).includes(text), text);
  for (const width of [375, 1280]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), `案件draft幅${width}`);
    await fill('summary', `ブラウザで編集した概要${width}`, 'input');
    assert.equal(await evaluate('document.querySelector("[data-affiliate-validation]").dataset.validationState'), 'unsaved');
    assert.equal(await evaluate('document.querySelector("[data-revalidate] button").disabled'), true);
    const revision = await evaluate('document.querySelector("[data-editor] input[name=revision]").value');
    await evaluate('document.querySelector("[data-editor]").requestSubmit(document.querySelector("[data-editor] button[value=save]"))');
    await until(() => evaluate(`document.querySelector('[data-editor] input[name=revision]')?.value !== ${JSON.stringify(revision)} && document.querySelector('[data-affiliate-validation]')?.dataset.validationState === 'current'`));
    assert.equal(await evaluate('document.querySelector("#draft-status").textContent'), '編集中');
    const edited = JSON.parse(await readFile(draftFile, 'utf8'));
    assert.notEqual(edited.affiliateValidation.contentHash, initial.affiliateValidation.contentHash);
    assert.deepEqual(edited.affiliateContext, initial.affiliateContext);
    assert.equal(apiCalls.length, 1);
    const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(path.join(directory, `validation-${width}.png`), Buffer.from(screenshot.data, 'base64'));
  }
  // 旧draftのGETは永続データを変えず、明示POSTで初めて検査する。
  const legacy = JSON.parse(await readFile(draftFile, 'utf8')); delete legacy.affiliateValidation;
  await writeFile(draftFile, JSON.stringify(legacy)); const legacyRaw = await readFile(draftFile, 'utf8');
  await navigate(draftPath, '[data-affiliate-validation]');
  assert.equal(await evaluate('document.querySelector("[data-affiliate-validation]").dataset.validationState'), 'unvalidated');
  assert.equal(await readFile(draftFile, 'utf8'), legacyRaw);
  await evaluate('document.querySelector("[data-revalidate]").requestSubmit()');
  await until(() => evaluate('document.querySelector("[data-affiliate-validation]")?.dataset.validationState === "current"'));
  assert.equal(apiCalls.length, 1);
  // 案件なしdraftを同じmockで生成し、従来UI・保存形式を確認する。
  await navigate('/', '[data-plan-form]'); await fill('theme', '案件なしブラウザ用架空企画');
  await evaluate('document.querySelector("[data-plan-form]").requestSubmit()');
  await until(() => evaluate('Boolean(document.querySelector("[data-direct-generation]"))'));
  const plainPlan = await evaluate('location.pathname');
  await navigate(plainPlan + '/generate', '[data-generate]');
  await evaluate('document.querySelector("[data-generate]").requestSubmit()');
  await until(() => evaluate('Boolean(document.querySelector("[data-generated-draft]"))'));
  const plainPath = await evaluate('document.querySelector("[data-generated-draft]").getAttribute("href")');
  await navigate(plainPath, '[data-editor]');
  assert.equal(await evaluate('Boolean(document.querySelector("[data-affiliate-validation]"))'), false);
  const plainDraft = JSON.parse(await readFile(path.join(dataDirectory, 'drafts', plainPath.split('/').at(-1) + '.json'), 'utf8'));
  assert.equal(plainDraft.affiliateValidation, undefined);
  for (const width of [375, 1280]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), `案件なし幅${width}`);
  }
  assert.equal(apiCalls.length, 2); assert.deepEqual(externalRequests, []); assert.deepEqual(interceptionErrors, []); assert.equal(blockedConnections.length, 0);
  console.log('Step 5.2ブラウザ検証成功：検査状態・件数・版・日時、375/1280px、未保存編集表示→保存再検査、旧draft未検査→明示再検査、案件なしdraft。SDK mock2回・実API/ASP/外部通信0件。');
  console.log(`ブラウザ画像: ${directory}/validation-375.png, ${directory}/validation-1280.png`);
} finally {
  if (socket) socket.close();
  chrome.kill('SIGTERM');
  await new Promise(resolve => server.close(resolve));
}
