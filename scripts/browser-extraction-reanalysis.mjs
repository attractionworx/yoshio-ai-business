import { blockedConnections } from '../test/helpers/network-guard.js';
import { tmpdir } from 'node:os';
// インストール済みChromeで実際にフォームを操作する確認用スクリプト。
// Chromeの専用プロフィールと架空データはOSの一時フォルダに保存します。
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rename } from 'node:fs/promises';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createApp } from '../server.js';
import { storeBytes } from '../test/fixtures/maintenance.js';
import { reanalysisFixture } from '../test/fixtures/extraction-reanalysis.js';
import { createMaintenanceService } from '../lib/maintenance/backup.js';
const fixture = await reanalysisFixture(undefined,{oneLine:true});
const parent = structuredClone((await fixture.store.read()).executions[0]);
const dataDirectory = fixture.root;
let before = await storeBytes(dataDirectory);
const directory = await mkdtemp(path.join(tmpdir(), 'yoshio-browser-reanalysis-'));
const server = createApp({ dataDirectory, generationOptions: { now: fixture.now }, maintenanceOptions: { now: fixture.now }, extractionOptions: { provider: fixture.provider } });
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
const navigationRequests = [];
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
    if (message.method === 'Network.requestWillBeSent') navigationRequests.push(message.params);
  });
  await call('Network.enable');
  await call('Page.enable');
  await call('Network.setBlockedURLs', { urls: ['https://*', 'http://*.openai.com/*'] });
  await call('Fetch.enable', { patterns: [{ urlPattern: '*' }] });

  async function navigate(url, text) {
    await call('Page.navigate', { url: base + url });
    await until(() => evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`));
  }
  async function screenshots(name) {
    for (const width of [375, 1280]) {
      await call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
      assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), `${name} width ${width}`);
      const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      await writeFile(path.join(directory, `${name}-${width}.png`), Buffer.from(shot.data, 'base64'));
    }
  }
  async function fill(rows) {
    await evaluate(`(${JSON.stringify(rows)}).forEach((row,i)=>Object.entries(row).forEach(([key,value])=>{document.querySelector('[name="documents.'+i+'.'+key+'"]').value=value;}))`);
  }
  await navigate('/offer-extractions/' + fixture.source.id, 'failed_after_request');
  assert.equal(await evaluate('Boolean(document.querySelector("a[href$=\\\"/reanalysis\\\"]"))'),true);
  await screenshots('failed-source');
  await evaluate('document.querySelector("a[href$=\\\"/reanalysis\\\"]").click()');
  await until(() => evaluate('document.body.innerText.includes("意図的再解析の準備確認")'));
  assert.equal(await evaluate('document.querySelector("input[name=confirm]").checked'),false);
  assert.equal(fixture.attempts.length,1);
  await screenshots('preparation-approval');
  await evaluate('document.querySelector("input[name=confirm]").click(); document.querySelector("form button").click()');
  await until(() => evaluate('document.body.innerText.includes("execution v2")'));
  const childId = (await fixture.store.read()).executions[1].revisions[0].id;
  assert.equal(await evaluate('location.pathname'), '/offer-extractions/' + childId);
  assert.equal(await evaluate('document.querySelector("input[name=confirm]").checked'),false);
  assert.equal(fixture.attempts.length,1);
  for (const text of ['operation ID','configuration hash','immutable input artifact','新しい送信・新たな費用予約','fake provider','共通simulation budget']) {
    assert.equal(await evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`),true,text);
  }
  await screenshots('new-send-approval');
  await evaluate('document.querySelector("input[name=confirm]").click(); document.querySelector("form button").click(); document.querySelector("form button").click()');
  await until(() => evaluate('document.body.innerText.includes("succeeded")'));
  assert.equal(fixture.attempts.length,2);
  assert.equal(await evaluate('document.body.innerText.includes("pending / unverified")'),true);
  await screenshots('reanalysis-succeeded');
  await evaluate('document.querySelector("a[href^=\\\"/offer-imports/\\\"]").click()');
  await until(() => evaluate('document.body.innerText.includes("候補レビュー")'));
  assert.equal(await evaluate('document.body.innerText.includes("未確認")'),true);
  await screenshots('pending-review');
  await navigate('/offer-extractions/' + fixture.source.id, '追加作成不可');
  assert.equal(await evaluate('Boolean(document.querySelector("a[href$=\\\"/reanalysis\\\"]"))'),false);
  assert.deepEqual((await fixture.store.read()).executions[0],parent);
  await navigate('/offer-extractions/new?offerId=' + fixture.offer.id, '資料から登録候補を作る');
  const rows=fixture.value.documents.map(d=>({label:d.label,kind:d.kind,versionLabel:d.versionLabel||'',text:d.text}));
  await fill(rows); await evaluate('document.querySelector("[data-extraction-form] button:not([type])").click()');
  await until(() => evaluate('document.body.innerText.includes("duplicate_request")'));
  assert.equal(await evaluate('document.body.innerText.includes("外部送信していません") && document.body.innerText.includes("API料金は発生していません")'),true);
  assert.equal(fixture.attempts.length,2); await screenshots('duplicate-request');
  before=await storeBytes(dataDirectory);
  await navigate('/maintenance/integrity','検査結果：正常');
  assert.equal(await evaluate('document.body.innerText.includes("execution v2")'),true);
  await screenshots('v2-maintenance');
  assert.deepEqual(await storeBytes(dataDirectory),before);
  const maintenance=createMaintenanceService(dataDirectory,{now:fixture.now}); const backup=await maintenance.create();
  assert.equal(backup.manifest.contracts.extractionExecution,2);
  assert.equal((await maintenance.dryRun(backup.manifest.id)).status,'normal');
  assert.deepEqual(externalRequests, []); assert.deepEqual(interceptionErrors, []); assert.equal(blockedConnections.length, 0);
  console.log('意図的再解析 Chrome確認成功：準備承認→新規送信承認（未チェック）、fake provider、二重クリックで1送信、元execution不変、pending/unverifiedレビュー、duplicate_request、v2 maintenance、375/1280px。外向き通信0件、実API0件。');
  console.log(`隔離fixture・Chrome確認画像: ${directory}`);
} finally {
  if (socket) socket.close();
  chrome.kill('SIGTERM');
  await new Promise(resolve => server.close(resolve));
}
