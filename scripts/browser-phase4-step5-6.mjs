import { blockedConnections } from '../test/helpers/network-guard.js';
import { tmpdir } from 'node:os';
// インストール済みChromeで実際にフォームを操作する確認用スクリプト。
// Chromeの専用プロフィールと架空データはOSの一時フォルダに保存します。
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createApp } from '../server.js';
import { randomUUID } from 'node:crypto';
import { createImprovementStore } from '../lib/improvements.js';
import { affiliateDraftFixture } from '../test/fixtures/affiliate-draft.js';
import { publicationInput } from '../test/fixtures/affiliate-publication.js';

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
  async function navigate(route, selector) {
    const previous = pageLoads;
    await call('Page.navigate', { url: base + route });
    await until(() => pageLoads > previous);
    await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`));
  }
  async function submit(selector, values = {}) {
    const previous = pageLoads;
    await evaluate(`(() => {
      const form = document.querySelector(${JSON.stringify(selector)});
      for (const [key, value] of Object.entries(${JSON.stringify(values)})) form.elements.namedItem(key).value = value;
      form.requestSubmit();
    })()`);
    await until(() => pageLoads > previous);
  }
  async function fit(width) {
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), `overflow at ${width}`);
  }
  for (const width of [375, 1280]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
    for (const scenario of ['ready', 'block', 'plain']) {
      const c = await affiliateDraftFixture(null, scenario === 'block' ? { summary: '絶対成功' } : {}, dataDirectory);
      if (scenario === 'plain') {
        c.plan = { ...c.plan, id: randomUUID(), theme: '案件なし改善' }; delete c.plan.offerBinding;
        c.draft = await c.drafts.create(c.plan, { content: c.content, generatedAt: null }, 'local raw', 'local prompt');
        c.file = path.join(dataDirectory, 'drafts', `${c.draft.id}.json`);
      }
      if (scenario === 'ready') c.draft = await c.drafts.update(c.draft.id, c.draft.revision, publicationInput(c.draft), 'publish');
      await writeFile(path.join(dataDirectory, `${c.plan.id}.json`), JSON.stringify(c.plan));
      const parentBefore = await readFile(c.file, 'utf8');
      await navigate(`/drafts/${c.draft.id}`, '[data-improve]');
      if (scenario === 'block') assert.ok((await evaluate('document.querySelector("[data-validation-counts]").textContent')).includes('block：1'));
      await submit('[data-improve]');
      await until(() => evaluate('Boolean(document.querySelector("#prompt"))'));
      const requestId = (await evaluate('location.pathname')).split('/').at(-1);
      const requestFile = path.join(dataDirectory, 'improvements', `${requestId}.json`);
      const request = JSON.parse(await readFile(requestFile, 'utf8'));
      const requestBefore = await readFile(requestFile, 'utf8');
      assert.equal(request.schemaVersion, scenario === 'plain' ? 1 : 2);
      if (scenario !== 'plain') assert.ok(await evaluate('Boolean(document.querySelector("[data-improvement-work]"))'));
      await evaluate(`window.copies = []; Object.defineProperty(navigator, 'clipboard', { configurable: true,
        value: { writeText: async text => { window.copies.push(text); } } }); document.querySelector('[data-copy]').click();`);
      await until(() => evaluate('window.copies.length === 1'));
      assert.equal(await evaluate('window.copies[0]'), request.prompt);
      await fit(width);
      if (scenario === 'block') {
        const shot = await call('Page.captureScreenshot', { format: 'png' });
        await writeFile(path.join(directory, `improvement-work-${width}.png`), Buffer.from(shot.data, 'base64'));
      }
      // 親が待機中に編集されても、依頼の本文と固定contextを維持する。
      if (scenario !== 'ready') await c.drafts.update(c.draft.id, c.draft.revision, { ...c.draft.edited, summary: '依頼後の親編集' }, 'save');
      const editedParent = await readFile(c.file, 'utf8');
      await navigate(`/improvements/${request.id}`, '#prompt');
      assert.equal(await evaluate('document.querySelector("#prompt").value'), request.prompt);
      assert.equal(await readFile(requestFile, 'utf8'), requestBefore);
      const raw = JSON.stringify({ planId: c.plan.id, promptVersion: request.promptVersion, requestId: request.id,
        parentDraftId: c.draft.id, generatedAt: null, content: { ...c.content, summary: '改善した概要' } });
      await submit('form', { result: raw });
      await until(() => evaluate('Boolean(document.querySelector("[data-editor]"))'));
      const childId = (await evaluate('location.pathname')).split('/').at(-1);
      const child = await c.drafts.get(childId);
      assert.equal(child.parentDraftId, c.draft.id); assert.equal(child.status, '未確認'); assert.equal(child.publication, undefined);
      assert.equal(await evaluate('document.querySelector("#draft-status").textContent'), '未確認');
      assert.ok((await evaluate('document.querySelector("[data-publish-link]").textContent')).includes('先に下書きを確認済み'));
      if (scenario !== 'plain') {
        assert.deepEqual(child.affiliateContext, request.affiliateContext);
        assert.notEqual(child.affiliateValidationRunId, c.draft.affiliateValidationRunId);
        assert.equal(await evaluate('document.querySelector("[data-affiliate-validation]").dataset.validationState'), 'current');
        assert.ok((await evaluate('document.querySelector("[data-validation-counts]").textContent')).includes('block：0'));
        const response = await evaluate(`fetch('/drafts/${child.id}/copy', { method: 'POST', body: new URLSearchParams({ revision: '1', field: 'body' }) }).then(async r => ({ status: r.status, body: await r.json() }))`);
        assert.equal(response.status, 409); assert.equal(response.body.result, 'blocked'); assert.equal(Object.hasOwn(response.body, 'text'), false);
      } else assert.equal(child.affiliateValidation, undefined);
      assert.equal(await readFile(c.file, 'utf8'), editedParent);
      if (scenario === 'ready') { assert.equal(parentBefore, editedParent); assert.equal(JSON.parse(editedParent).publication.status, '公開準備OK'); }
      else assert.notEqual(parentBefore, editedParent);
      await fit(width);
      if (scenario === 'ready') {
        const shot = await call('Page.captureScreenshot', { format: 'png' });
        await writeFile(path.join(directory, `improvement-child-${width}.png`), Buffer.from(shot.data, 'base64'));
      }
    }
    for (const scenario of ['legacy', 'tampered']) {
      const c = await affiliateDraftFixture(null, {}, dataDirectory);
      const request = await createImprovementStore(dataDirectory).create(c.plan, c.draft, { mode: 'rewrite', options: [], instructions: '' });
      if (scenario === 'legacy') {
        request.schemaVersion = 1; request.promptVersion = 'codex-improvement-v1';
        for (const key of ['purpose', 'affiliateContext', 'sourceContentHash', 'affiliateContextHash', 'offerId', 'offerRevision', 'conversionId', 'requestHash']) delete request[key];
      } else request.prompt += '改ざん';
      await writeFile(path.join(dataDirectory, 'improvements', `${request.id}.json`), JSON.stringify(request));
      await navigate(`/improvements/${request.id}`, 'main h1');
      assert.ok((await evaluate('document.body.textContent')).includes('新しい改善依頼'));
      assert.equal(await evaluate('Boolean(document.querySelector("#prompt, [data-copy], #result"))'), false);
      await fit(width);
    }
  }
  assert.deepEqual(externalRequests, []); assert.deepEqual(interceptionErrors, []); assert.equal(blockedConnections.length, 0);
  console.log('Step 5.6 browser passed: ready/block/plain creation, work prompt copy, parent edits, child import, new validation, no permission inheritance, final gate refusal, legacy/tampering rejection at 375/1280px. Outward requests: 0.');
  console.log(`Browser screenshots: ${directory}/improvement-work-{375,1280}.png, ${directory}/improvement-child-{375,1280}.png`);

} finally {
  if (socket) socket.close();
  chrome.kill('SIGTERM');
  await new Promise(resolve => server.close(resolve));
}
