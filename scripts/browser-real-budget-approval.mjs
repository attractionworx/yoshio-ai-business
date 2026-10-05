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
import { storeBytes } from '../test/fixtures/maintenance.js';
import { executionFixture } from '../test/fixtures/extraction-execution.js';
import { createExtractionService } from '../lib/offer-import/extraction-service.js';
import { createMaintenanceService } from '../lib/maintenance/backup.js';

const fixture = await executionFixture(undefined, { activate: false });
const dataDirectory = fixture.root;
let before = await storeBytes(dataDirectory);
const directory = await mkdtemp(path.join(tmpdir(), 'yoshio-browser-step61a-'));
const server = createApp({ dataDirectory, generationOptions: { now: fixture.now }, maintenanceOptions: { now: fixture.now } });
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
  await call('Page.navigate', { url: base + '/maintenance/ai-budget' });
  await until(() => evaluate('document.body.innerText.includes("共通予算：未有効化")'));
  for (const width of [375, 1280]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), `budget width ${width}`);
    const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    await writeFile(path.join(directory, `budget-${width}.png`), Buffer.from(shot.data, 'base64'));
  }
  assert.equal(await evaluate('document.querySelector("input[name=confirm]").checked'), false);
  await evaluate('document.querySelector("input[name=simulationYen]").value = "900"; document.querySelector("input[name=confirm]").click(); document.querySelector("form button").click()');
  await until(() => evaluate('document.body.innerText.includes("明示有効化済み")'));
  assert.equal((await fixture.coordinator.activation()).policy.realStopMilliYen, null);
  await call('Page.navigate', { url: base + '/maintenance/ai-budget' });
  await until(() => evaluate('Boolean(document.querySelector("input[name=realYen]"))'));
  const originalActivation = JSON.stringify(await fixture.coordinator.activation());
  assert.equal(await evaluate('document.querySelector("input[name=realYen]").value'), '');
  await evaluate('document.querySelector("input[name=realYen]").value = "100.123"; document.querySelector("form[action=\\\"/maintenance/ai-budget/real-preview\\\"] button").click()');
  await until(() => evaluate('document.body.innerText.includes("共通real枠の最終確認")'));
  assert.equal(await evaluate('document.body.innerText.includes("100123 milliYen") && document.body.innerText.includes("記事生成と案件抽出の両方") && document.body.innerText.includes("API残高そのものとは別")'), true);
  assert.equal(await evaluate('document.querySelector("input[name=confirm]").checked'), false);
  for (const width of [375, 1280]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), `real preview width ${width}`);
    const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    await writeFile(path.join(directory, `real-preview-${width}.png`), Buffer.from(shot.data, 'base64'));
  }
  await evaluate('document.querySelector("input[name=confirm]").click(); document.querySelector("form button").click()');
  await until(() => evaluate('document.body.innerText.includes("限定real承認済み")'));
  assert.equal(await evaluate('Boolean(document.querySelector("form[action=\\\"/maintenance/ai-budget/real-preview\\\"]"))'), false);
  assert.equal((await fixture.coordinator.state()).effectivePolicy.realStopMilliYen, 100123);
  assert.equal(JSON.stringify(await fixture.coordinator.activation()), originalActivation);
  await call('Page.navigate', { url: base + '/maintenance/ai-budget' });
  await until(() => evaluate('document.body.innerText.includes("限定real承認済み")'));
  assert.equal(await evaluate('document.body.innerText.includes("再変更できません")'), true);
  await fixture.run(); // Fake-only harness. There is no document-intake or external-send UI.
  assert.equal(fixture.calls.length, 1);
  before = await storeBytes(dataDirectory);
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
  const verified = await maintenance.dryRun(backup.id); assert.equal(verified.realBudgetApprovalStatus, 'valid');
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
  const interrupted = createExtractionService({ ...fixture.options, fault: async p => { if (p === 'after_sending') throw new Error('fictional crash'); } });
  const changed = structuredClone(fixture.value); changed.documents[0].label = '別版の架空資料';
  const ready = await fixture.ready(interrupted, changed);
  await assert.rejects(interrupted.execute(ready.id, ready.revision));
  const state = await interrupted.status(ready.id);
  await interrupted.recover(ready.id, state.record.revision, { confirm: true, operation: 'mark_interrupted' });
  await call('Page.navigate', { url: base + '/maintenance/ai-budget' });
  await until(() => evaluate('document.body.innerText.includes("unknown") && document.body.innerText.includes("人間確認必須")'));
  assert.equal(fixture.calls.length, 1);
  const unresolved = await storeBytes(dataDirectory);
  await call('Page.navigate', { url: base + '/maintenance/integrity' });
  await until(() => evaluate('document.body.innerText.includes("人間確認必須") && Boolean(document.querySelector("[role=alert]"))'));
  assert.equal(await evaluate('document.body.innerText.includes("自動再送")'), true);
  assert.equal(await evaluate('Boolean(document.querySelector("form"))'), false);
  assert.deepEqual(await storeBytes(dataDirectory), unresolved);
  for (const width of [375, 1280]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), `stopped width ${width}`);
    const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    await writeFile(path.join(directory, `stopped-${width}.png`), Buffer.from(shot.data, 'base64'));
  }
  const payload = path.join(dataDirectory, 'maintenance-backups', backup.id, 'payload', 'extraction-executions', 'ledger.json');
  await writeFile(payload, 'fictional corrupted backup');
  await call('Page.navigate', { url: base + '/maintenance' });
  await until(() => evaluate('Boolean(document.querySelector("input[name=backupId]"))'));
  await evaluate('document.querySelector("form[action=\\\"/maintenance/dry-run\\\"] button").click()');
  await until(() => evaluate('document.body.innerText.includes("検証失敗") && Boolean(document.querySelector("[role=alert]"))'));
  assert.deepEqual(await storeBytes(dataDirectory), unresolved);
  assert.deepEqual(externalRequests, []); assert.deepEqual(interceptionErrors, []); assert.equal(blockedConnections.length, 0);
  console.log('Step 6-1A Chrome確認成功：金額入力・milliYen最終確認・未チェック承認・一度だけ保存・元activation保持・変更フォーム消失・v2承認backup/integrity/dry-run・unknown停止・改変backup停止・375/1280px。外向き通信0件。');
  console.log(`隔離fixture・Chrome確認画像: ${directory}`);
} finally {
  if (socket) socket.close();
  chrome.kill('SIGTERM');
  await new Promise(resolve => server.close(resolve));
}
