import { blockedConnections } from '../test/helpers/network-guard.js';
import { tmpdir } from 'node:os';
// インストール済みChromeで実際にフォームを操作する確認用スクリプト。
// Chromeの専用プロフィールと架空データはOSの一時フォルダに保存します。
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createApp } from '../server.js';
import { maintenanceFixture, storeBytes } from '../test/fixtures/maintenance.js';
import { createMaintenanceService } from '../lib/maintenance/backup.js';

const fixture = await maintenanceFixture();
const dataDirectory = fixture.root;
const before = await storeBytes(dataDirectory);
const directory = await mkdtemp(path.join(tmpdir(), 'yoshio-browser-phase5-'));
const server = createApp({ dataDirectory, maintenanceOptions: { now: fixture.now } });
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
        .catch(error => {
          // Navigation may cancel an already paused request. Only that cancellation is benign.
          if (error.message !== 'Invalid InterceptionId.') interceptionErrors.push(error.message);
        });
    }
    if (message.method === 'Network.requestWillBeSentExtraInfo') requests.push(message.params);
    if (message.method === 'Network.requestWillBeSent' && /^https?:/.test(message.params.request.url) && new URL(message.params.request.url).origin !== base) externalRequests.push(message.params.request.url);
    if (message.method === 'Network.responseReceived') responses.push(message.params.response);
  });
  await call('Network.enable');
  await call('Page.enable');
  await call('Network.setBlockedURLs', { urls: ['https://*', 'http://*.openai.com/*'] });
  await call('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await call('Page.navigate', { url: base + '/maintenance' });
  await until(() => evaluate('document.body.innerText.includes("データ保全管理") && Boolean(document.querySelector("form[action=\\\"/maintenance/backups\\\"]"))'));
  for (const width of [375, 1280]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), `admin width ${width}`);
    const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    await writeFile(path.join(directory, `admin-${width}.png`), Buffer.from(shot.data, 'base64'));
  }
  assert.equal(await evaluate('document.querySelector("input[name=confirm]").checked'), false);
  await call('Page.navigate', { url: base + '/maintenance/integrity' });
  await until(() => evaluate('document.body.innerText.includes("検査結果：正常")'));
  assert.deepEqual(await storeBytes(dataDirectory), before);
  await call('Page.navigate', { url: base + '/maintenance' });
  await until(() => evaluate('Boolean(document.querySelector("input[name=confirm]"))'));
  await evaluate('document.querySelector("input[name=confirm]").click(); document.querySelector("form[action=\\\"/maintenance/backups\\\"] button").click()');
  await until(() => evaluate('document.body.innerText.includes("バックアップ作成完了")'));
  const maintenance = createMaintenanceService(dataDirectory, { now: fixture.now });
  const backup = (await maintenance.list()).backups[0]; assert.ok(backup);
  await call('Page.navigate', { url: base + '/maintenance' });
  await until(() => evaluate('Boolean(document.querySelector("input[name=backupId]"))'));
  await evaluate('document.querySelector("form[action=\\\"/maintenance/dry-run\\\"] button").click()');
  await until(() => evaluate('document.body.innerText.includes("復元dry-run結果：正常")'));
  assert.equal(await evaluate('document.body.innerText.includes("現在のデータは変更しません")'), true);
  for (const width of [375, 1280]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), `dry-run width ${width}`);
    const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    await writeFile(path.join(directory, `dry-run-${width}.png`), Buffer.from(shot.data, 'base64'));
  }
  assert.deepEqual(await storeBytes(dataDirectory), before);
  const ledgerFile = path.join(dataDirectory, 'offer-import-commits', 'ledger.json');
  const ledger = JSON.parse(await readFile(ledgerFile, 'utf8')); ledger.events.pop();
  await writeFile(ledgerFile, JSON.stringify(ledger));
  const unresolved = await storeBytes(dataDirectory);
  await call('Page.navigate', { url: base + '/maintenance/integrity' });
  await until(() => evaluate('document.body.innerText.includes("人間確認必須") && Boolean(document.querySelector("[role=alert]"))'));
  assert.equal(await evaluate('document.body.innerText.includes("復旧可能性あり")'), true);
  assert.equal(await evaluate('Boolean(document.querySelector("form"))'), false);
  assert.deepEqual(await storeBytes(dataDirectory), unresolved);
  for (const width of [375, 1280]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), `stopped width ${width}`);
    const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    await writeFile(path.join(directory, `stopped-${width}.png`), Buffer.from(shot.data, 'base64'));
  }
  const payload = path.join(dataDirectory, 'maintenance-backups', backup.id, 'payload', 'offer-import-commits', 'ledger.json');
  await writeFile(payload, 'fictional corrupted backup');
  await call('Page.navigate', { url: base + '/maintenance' });
  await until(() => evaluate('Boolean(document.querySelector("input[name=backupId]"))'));
  await evaluate('document.querySelector("form[action=\\\"/maintenance/dry-run\\\"] button").click()');
  await until(() => evaluate('document.body.innerText.includes("検証失敗") && Boolean(document.querySelector("[role=alert]"))'));
  assert.deepEqual(await storeBytes(dataDirectory), unresolved);
  assert.deepEqual(externalRequests, []); assert.deepEqual(interceptionErrors, []); assert.equal(blockedConnections.length, 0);
  console.log('Step 5 Chrome確認成功：管理画面・integrity・明示バックアップ・復元dry-run・未解決intent停止・改変バックアップ停止・375/1280px・既存データ非変更。外向き通信0件。');
  console.log(`隔離fixture・Chrome確認画像: ${directory}`);
} finally {
  if (socket) socket.close();
  chrome.kill('SIGTERM');
  await new Promise(resolve => server.close(resolve));
}
