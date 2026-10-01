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
import { publicationInput } from '../test/fixtures/affiliate-publication.js';

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
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
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
  async function navigate(id) {
    const previous = pageLoads;
    await call('Page.navigate', { url: `${base}/drafts/${id}/publish` });
    await until(() => pageLoads > previous);
    await until(() => evaluate('Boolean(document.querySelector("[data-publish]"))'));
    await evaluate(`window.copies = []; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copies.push(text); } } });`);
  }
  const codes = { paused: 'offer-paused', ended: 'offer-ended', revision: 'revision-mismatch', conversion: 'conversion-unavailable', expired: 'offer-expired', missing: 'offer-missing', stale: 'validation-stale', human: 'human-confirmation-required' };
  const messages = { paused: '案件停止中', ended: '案件終了', revision: '案件revision変更', conversion: '成果地点が現在利用不可', expired: '有効期限切れ', missing: '案件が見つかりません', stale: '再検査が必要', human: '人間確認が必要' };
  for (const width of [375, 1280]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
    for (const name of ['active', 'paused', 'ended', 'revision', 'conversion', 'expired', 'missing', 'stale', 'human', 'plain']) {
      const c = await affiliateDraftFixture(null, {}, dataDirectory);
      if (name === 'plain') { delete c.draft.affiliateContext; delete c.draft.affiliateValidation; await writeFile(c.file, JSON.stringify(c.draft)); }
      c.draft = await c.drafts.update(c.draft.id, c.draft.revision, publicationInput(c.draft), 'publish');
      const before = structuredClone(c.draft);
      await navigate(c.draft.id);
      assert.equal(await evaluate('document.getElementById("publish-status").textContent'), '公開準備OK');
      assert.equal(await evaluate('document.querySelector("[data-publication-copy=publish-body]").disabled'), false);
      if (name !== 'plain') assert.equal(await evaluate('document.getElementById("publish-body").value'), '');
      // 画面を開いた後でstoreを変える。GET時のpassで許可しない。
      const offerFile = path.join(dataDirectory, 'offers', `${c.offer.id}.json`);
      if (['paused', 'ended'].includes(name)) await c.offers.update(c.offer.id, 1, { ...c.input, status: name });
      if (name === 'revision') await c.offers.update(c.offer.id, 1, c.input);
      if (['conversion', 'expired'].includes(name)) {
        const record = JSON.parse(await readFile(offerFile, 'utf8'));
        if (name === 'conversion') record.revisions[0].conversions[0].status = 'paused';
        else record.revisions[0].validUntil = new Date(Date.now() - 1000).toISOString();
        await writeFile(offerFile, JSON.stringify(record));
      }
      if (name === 'missing') await unlink(offerFile);
      if (name === 'stale') { c.draft.edited.summary += '変更'; await writeFile(c.file, JSON.stringify(c.draft)); }
      if (name === 'human') {
        c.draft.publication.affiliate.humanConfirmation.requiredChecks.affiliateFacts = false;
        c.draft.publication.affiliate.humanConfirmation.confirmedAt = null;
        await writeFile(c.file, JSON.stringify(c.draft));
      }
      const responseCount = responses.length;
      await evaluate('document.querySelector("[data-publication-copy=publish-body]").click()');
      const pass = ['active', 'plain'].includes(name);
      await until(() => evaluate(pass ? 'window.copies.length === 1' : 'Boolean(document.getElementById("publish-body-message").dataset.reasonCode)'));
      const message = await evaluate('document.getElementById("publish-body-message").textContent');
      if (pass) {
        assert.equal(await evaluate('window.copies[0]'), c.draft.edited.body);
        if (name === 'active') assert.match(message, /最終再確認に成功/);
      } else {
        assert.equal(await evaluate('window.copies.length'), 0);
        assert.equal(await evaluate('document.getElementById("publish-body").value'), '');
        assert.equal(await evaluate('document.getElementById("publish-body-message").dataset.reasonCode'), codes[name]);
        assert.ok(message.includes(messages[name]), `${name}: ${message}`);
        assert.equal(await evaluate('[...document.querySelectorAll("[data-publication-copy]")].every(b => b.disabled)'), true);
      }
      if (name !== 'plain') {
        await until(() => responses.slice(responseCount).some(r => r.url.endsWith('/copy')));
        assert.equal(responses.slice(responseCount).find(r => r.url.endsWith('/copy')).status, pass ? 200 : 409);
      } else assert.equal(responses.slice(responseCount).some(r => r.url.endsWith('/copy')), false);
      assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), `${name} width ${width}`);
      const saved = JSON.parse(await readFile(c.file, 'utf8'));
      assert.deepEqual(saved.affiliateContext, before.affiliateContext);
      assert.deepEqual(saved.affiliateValidation, before.affiliateValidation);
      if (name === 'active') {
        const shot = await call('Page.captureScreenshot', { format: 'png' });
        await writeFile(path.join(directory, `final-copy-${width}.png`), Buffer.from(shot.data, 'base64'));
        // 一度成功したブラウザでも、次の要求では新たに再確認し拒否する。
        await c.offers.update(c.offer.id, 1, { ...c.input, status: 'paused' });
        await evaluate('document.querySelector("[data-publication-copy=publish-body]").click()');
        await until(() => evaluate('document.getElementById("publish-body-message").dataset.reasonCode === "offer-paused"'));
        assert.equal(await evaluate('window.copies.length'), 1);
        assert.equal(await evaluate('document.getElementById("publish-body").value'), '');
      }
    }
  }
  // Clipboard拒否時も、gate成功後の本文だけ手動コピー用に選択する。
  const fallback = await affiliateDraftFixture(null, {}, dataDirectory);
  fallback.draft = await fallback.drafts.update(fallback.draft.id, fallback.draft.revision, publicationInput(fallback.draft), 'publish');
  await navigate(fallback.draft.id);
  await evaluate('navigator.clipboard.writeText = async () => { throw new Error("local clipboard rejection"); }; document.querySelector("[data-publication-copy=publish-body]").click()');
  await until(() => evaluate('document.getElementById("publish-body-message").textContent.includes("Command+C")'));
  assert.equal(await evaluate('document.getElementById("publish-body").value'), fallback.draft.edited.body);
  assert.equal(await evaluate('document.activeElement.id'), 'publish-body');
  assert.equal(apiCalls.length, 0); assert.deepEqual(externalRequests, []); assert.deepEqual(interceptionErrors, []); assert.equal(blockedConnections.length, 0);
  console.log('Step 5.5 browser passed: 10 scenarios x 375/1280px, repeat-pass refusal, clipboard fallback. API/ASP/outward requests: 0.');
  console.log(`Browser screenshots: ${directory}/final-copy-375.png, ${directory}/final-copy-1280.png`);
} finally {
  if (socket) socket.close();
  chrome.kill('SIGTERM');
  await new Promise(resolve => server.close(resolve));
}
