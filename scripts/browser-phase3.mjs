import { blockedConnections } from '../test/helpers/network-guard.js';
import { createFakeProvider } from '../lib/ai/fake-provider.js';
import { tmpdir } from 'node:os';
// インストール済みChromeで実際にフォームを操作する確認用スクリプト。
// Chromeの専用プロフィールと架空データはOSの一時フォルダに保存します。
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createApp } from '../server.js';

const directory = await mkdtemp(path.join(tmpdir(), 'yoshio-browser-phase3-'));
await mkdir(directory, { recursive: true });
const dataDirectory = await mkdtemp(path.join(directory, 'run-'));
let scenario = 'success';
const server = createApp({ dataDirectory, generationOptions: { provider: { kind: 'fake', generate: input => createFakeProvider({ scenario }).generate(input) }, config: { timeoutMs: 200 } } });
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const base = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(path.join(directory, 'profile-'));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--disable-component-update', '--disable-breakpad', 'about:blank',
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
    if (message.method === 'Network.requestWillBeSentExtraInfo') requests.push(message.params);
    if (message.method === 'Network.requestWillBeSent' && /^https?:/.test(message.params.request.url) && new URL(message.params.request.url).origin !== base) externalRequests.push(message.params.request.url);
    if (message.method === 'Network.responseReceived') responses.push(message.params.response);
  });
  await call('Network.enable');
  await call('Page.enable');
  await call('Network.setBlockedURLs', { urls: ['https://*', 'http://*.openai.com/*'] });
  await call('Page.navigate', { url: base });
  await until(() => evaluate('Boolean(document.getElementById("theme"))'));
  await evaluate(`(() => { document.getElementById('theme').value = 'Fake生成の隔離ブラウザ用架空企画'; document.querySelector('form button').click(); })()`);
  await until(() => evaluate('Boolean(document.querySelector("[data-direct-generation]"))'));
  const planPath = await evaluate('location.pathname');
  assert.equal(await evaluate('Boolean(document.getElementById("prompt"))'), true);
  await evaluate('document.querySelector("[data-direct-generation]").click()');
  await until(() => evaluate('Boolean(document.querySelector("[data-generate]"))'));
  assert.ok(!(await readdir(dataDirectory)).includes('generations'));
  assert.match(await evaluate('document.body.innerText'), /外部送信・課金なし/);
  assert.match(await evaluate('document.body.innerText'), /最大予約額（模擬）：¥10/);
  for (const width of [320, 375]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 812, deviceScaleFactor: 1, mobile: true });
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    await evaluate('document.querySelector("[data-generate]").scrollIntoView()');
    assert.equal(await evaluate(`(() => { const r = document.querySelector('[data-generate] button').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })()`), true);
    const screenshot = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(directory, `confirm-${width}.png`), Buffer.from(screenshot.data, 'base64'));
  }
  await evaluate('document.querySelector("[data-generate] button").click()');
  await until(() => evaluate('Boolean(document.querySelector("[data-generated-draft]"))'));
  const resultPath = await evaluate('location.pathname');
  assert.equal(await evaluate('document.getElementById("generation-state").textContent'), '成功');
  assert.match(await evaluate('document.body.innerText'), /模擬API実行 1回/);
  assert.match(await evaluate('document.body.innerText'), /下書き保存 1件/);
  assert.match(await evaluate('document.body.innerText'), /今回の模擬概算：¥3/);
  await evaluate('document.querySelector("[data-generated-draft]").click()');
  await until(() => evaluate('Boolean(document.querySelector("[data-editor]"))'));
  const draftPath = await evaluate('location.pathname');
  assert.equal(await evaluate('document.getElementById("draft-status").textContent'), '未確認');
  assert.match(await evaluate('document.body.innerText'), /直接AI生成（Fake/);
  const stored = JSON.parse(await readFile(path.join(dataDirectory, 'drafts', draftPath.split('/').at(-1) + '.json'), 'utf8'));
  assert.equal(stored.reviewedAt, null);
  assert.equal(stored.publication, undefined);
  assert.equal(stored.generation.executionId, resultPath.split('/').at(-1));
  // Phase 2.2へ接続しコピーまで確認。
  await evaluate('document.querySelector("[data-review]").click()');
  await until(() => evaluate('document.getElementById("draft-status")?.textContent === "確認済み"'));
  await evaluate('document.querySelector("[data-publish-link] a").click()');
  await until(() => evaluate('Boolean(document.querySelector("[data-publish]"))'));
  await evaluate(`(() => { document.getElementById('titleIndex').value = '0'; document.querySelectorAll('[type=checkbox]').forEach(c => c.click()); document.querySelector('[value=ready]').click(); })()`);
  await until(() => evaluate('document.getElementById("publish-status")?.textContent === "公開準備OK"'));
  await call('Browser.grantPermissions', { origin: base, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
  await call('Page.bringToFront');
  await evaluate('document.querySelector("[data-publication-copy]").click()');
  await until(() => evaluate('document.getElementById("publish-title-message").textContent.includes("コピーしました")'));
  // 不正応答→失敗表示、ドラフトを増やさない。
  scenario = 'invalid-json';
  await call('Page.navigate', { url: base + planPath + '/generate' });
  await until(() => evaluate('Boolean(document.querySelector("[data-generate]"))'));
  await evaluate('document.querySelector("[data-generate] button").click()');
  await until(() => evaluate('document.getElementById("generation-state")?.textContent === "失敗"'));
  assert.equal((await readdir(path.join(dataDirectory, 'drafts'))).filter(n => n.endsWith('.json')).length, 1);
  // タイムアウト→予約を保持。新たな生成を止める。
  scenario = 'timeout';
  await call('Page.navigate', { url: base + planPath + '/generate' });
  await until(() => evaluate('Boolean(document.querySelector("[data-generate]"))'));
  await evaluate('document.querySelector("[data-generate] button").click()');
  await until(() => evaluate('document.getElementById("generation-state")?.textContent === "結果不明"'));
  assert.match(await evaluate('document.body.innerText'), /保持予約：¥10/);
  for (const width of [320, 375]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 812, deviceScaleFactor: 1, mobile: true });
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    await evaluate('scrollTo(0, 0)');
    const screenshot = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(directory, `result-${width}.png`), Buffer.from(screenshot.data, 'base64'));
  }
  await call('Page.navigate', { url: base + planPath + '/generate' });
  await until(() => evaluate('Boolean(document.querySelector("[data-generate]"))'));
  await evaluate('document.querySelector("[data-generate] button").click()');
  await until(() => evaluate('Boolean(document.querySelector("[role=alert]"))'));
  assert.match(await evaluate('document.body.innerText'), /生成中または結果不明/);
  assert.equal((await readdir(path.join(dataDirectory, 'drafts'))).filter(n => n.endsWith('.json')).length, 1);
  assert.equal(blockedConnections.length, 0);
  assert.deepEqual(externalRequests, []);
  const evidence = { result: '生成前確認・未確認保存・模擬usage・公開準備とコピー・不正応答・タイムアウト予約保持・新規実行停止・320/375pxを確認', externalRequests: 0, realApiCalls: 0, actualCostYen: 0, directory, dataDirectory };
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  if (socket) socket.close();
  chrome.kill('SIGTERM');
  await new Promise(resolve => server.close(resolve));
}
