import { blockedConnections } from '../test/helpers/network-guard.js';
import { tmpdir } from 'node:os';
// インストール済みChromeで実際にフォームを操作する確認用スクリプト。
// Chromeの専用プロフィールと架空データはOSの一時フォルダに保存します。
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
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
  const scenarios = [];
  for (const name of ['active', 'paused', 'ended', 'revision', 'conversion', 'expired', 'missing', 'plain']) {
    const c = await scenario();
    const offerFile = path.join(dataDirectory, 'offers', `${c.offer.id}.json`);
    if (['paused', 'ended'].includes(name)) await createOfferStore(dataDirectory).update(c.offer.id, 1, { ...c.input, status: name });
    if (name === 'revision') await createOfferStore(dataDirectory).update(c.offer.id, 1, c.input);
    // テスト専用のローカル固定データ。同revisionでconversion/expiryの分岐を独立確認。
    if (['conversion', 'expired'].includes(name)) {
      const record = JSON.parse(await readFile(offerFile, 'utf8'));
      const offer = record.revisions[0];
      if (name === 'conversion') {
        offer.conversions[0].status = 'paused';
      } else offer.validUntil = new Date(Date.now() - 1000).toISOString();
      await writeFile(offerFile, JSON.stringify(record));
    }
    if (name === 'missing') await unlink(offerFile);
    if (name === 'plain') { delete c.draft.affiliateContext; delete c.draft.affiliateValidation; await writeFile(c.file, JSON.stringify(c.draft)); }
    scenarios.push({ name, ...c });
  }
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
  const reasons = { paused: '案件停止中', ended: '案件終了', revision: '案件revision変更', conversion: '成果地点が現在利用不可', expired: '有効期限切れ', missing: '案件が見つかりません' };
  for (const c of scenarios) {
    for (const width of [375, 1280]) {
      await call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
      await navigate(`/drafts/${c.draft.id}/publish`);
      if (c.name !== 'plain') {
        await required(); await warnings();
        assert.ok(await evaluate('Boolean(document.querySelector("[data-current-offer-check]"))'));
      } else assert.equal(await evaluate('Boolean(document.querySelector("[data-current-offer-check]"))'), false);
      await basic(); await submit();
      const pass = ['active', 'plain'].includes(c.name);
      assert.equal(await evaluate('document.getElementById("publish-status").textContent'), pass ? '公開準備OK' : '要修正');
      if (c.name !== 'plain') {
        const text = await evaluate('document.querySelector("[data-current-offer-check]").textContent');
        assert.match(text, pass ? /pass/ : /blocked/);
        if (!pass) assert.ok(text.includes(reasons[c.name]), `${c.name}: ${text}`);
      }
      assert.equal(await evaluate('[...document.querySelectorAll("[data-publication-copy]")].every(b => b.disabled)'), !pass);
      assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), `${c.name}幅${width}`);
      const saved = JSON.parse(await readFile(c.file, 'utf8'));
      assert.deepEqual(saved.affiliateContext, c.draft.affiliateContext);
      if (c.name === 'active') {
        const shot = await call('Page.captureScreenshot', { format: 'png' });
        await writeFile(path.join(directory, `current-offer-${width}.png`), Buffer.from(shot.data, 'base64'));
      }
    }
  }
  assert.equal(apiCalls.length, 0); assert.deepEqual(externalRequests, []); assert.deepEqual(interceptionErrors, []); assert.equal(blockedConnections.length, 0);
  console.log('Step 5.4 browser passed: active/pass, paused, ended, revision mismatch, conversion unavailable, expired, missing, plain. 375/1280px. API/ASP/outward requests: 0.');
  console.log(`ブラウザ画像: ${directory}/current-offer-375.png, ${directory}/current-offer-1280.png`);
} finally {
  if (socket) socket.close();
  chrome.kill('SIGTERM');
  await new Promise(resolve => server.close(resolve));
}
