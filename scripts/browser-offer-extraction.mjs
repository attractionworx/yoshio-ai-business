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
import { openaiExtractionFixture, fictionalRows, stubExtraction } from '../test/fixtures/openai-extraction.js';
import { createExtractionService } from '../lib/offer-import/extraction-service.js';
import { createMaintenanceService } from '../lib/maintenance/backup.js';

let mode = 'success';
const fixture = await openaiExtractionFixture(undefined, { activate: false, respond: (_request, _options, input) => {
  if (mode === 'unknown') throw new Error('fictional interrupted stub');
  return { status: 'completed', service_tier: 'default', output_text: JSON.stringify(stubExtraction(input)), usage: { input_tokens: 1000, output_tokens: 2000 } };
} });
const dataDirectory = fixture.root;
let before = await storeBytes(dataDirectory);
const directory = await mkdtemp(path.join(tmpdir(), 'yoshio-browser-step61-'));
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
  await navigate('/maintenance/ai-budget', '共通予算：未有効化');
  await evaluate('document.querySelector("input[name=simulationYen]").value="100"; document.querySelector("input[name=realYen]").value="100"; document.querySelector("input[name=confirm]").click(); document.querySelector("form button").click()');
  await until(() => evaluate('location.pathname === "/maintenance/ai-budget" && document.body.innerText.includes("effective real停止額：100円")'));
  assert.ok(navigationRequests.some(p=>p.redirectResponse?.status===303 && p.redirectResponse.url===base+'/maintenance/ai-budget/activate' && p.request.method==='GET' && p.request.url===base+'/maintenance/ai-budget'));
  assert.equal(await evaluate('document.body.innerText.includes("共通budgetを安全に確認できません")'),false);
  assert.equal(fixture.sdkCalls.length,0); await screenshots('initial-activation-effective-budget');
  await navigate('/offers/' + fixture.offer.id, '架空の折り紙講座');
  assert.equal(await evaluate('document.body.innerText.includes("資料から登録候補を作る")'), true);
  await navigate('/offer-extractions/new?offerId=' + fixture.offer.id, '資料から登録候補を作る');
  await until(() => evaluate('Boolean(document.querySelector("[data-extraction-form]"))'));
  await evaluate('document.querySelector("[data-add-document]").click()');
  assert.equal(await evaluate('document.querySelectorAll("[data-extraction-document]").length'), 3);
  await evaluate('document.querySelectorAll("[data-remove-document]")[2].click()');
  assert.equal(await evaluate('document.querySelectorAll("[data-extraction-document]").length'), 2);
  await fill(fictionalRows());
  await screenshots('intake');
  const baseline = JSON.stringify(await fixture.coordinator.activation());
  await evaluate('document.querySelector("[data-extraction-form] button:not([type])").click()');
  await until(() => evaluate('document.body.innerText.includes("資料抽出の送信前確認")'));
  assert.equal(fixture.sdkCalls.length, 0);
  assert.equal(await evaluate('document.querySelector("input[name=confirm]").checked'), false);
  for (const text of ['metadata', 'output schema', 'extraction instructions', 'gpt-6-luna', '1.824円', '固定為替', 'pricing version', 'configuration hash', 'immutable input artifact', '今回予約後の判定', 'API残高そのものではありません']) {
    assert.equal(await evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`), true, text);
  }
  await screenshots('confirmation');
  await evaluate('document.querySelector("input[name=confirm]").click(); document.querySelector("form button").click()');
  await until(() => evaluate('document.body.innerText.includes("succeeded")'));
  assert.equal(fixture.sdkCalls.length, 1);
  assert.equal(await evaluate('document.body.innerText.includes("pending / unverified") && document.body.innerText.includes("応答の実usage")'), true);
  assert.equal(await evaluate('Boolean(document.querySelector("input[name=confirm]"))'), false);
  assert.equal(JSON.stringify(await fixture.coordinator.activation()), baseline);
  await screenshots('succeeded');
  await evaluate('document.querySelector("a[href^=\\\"/offer-imports/\\\"]").click()');
  await until(() => evaluate('document.body.innerText.includes("候補レビュー")'));
  assert.equal(await evaluate('document.body.innerText.includes("未確認")'), true);
  before = await storeBytes(dataDirectory);
  await navigate('/maintenance/integrity', '検査結果：正常');
  assert.deepEqual(await storeBytes(dataDirectory), before);
  const maintenance = createMaintenanceService(dataDirectory, { now: fixture.now });
  const backup = await maintenance.create();
  assert.equal((await maintenance.dryRun(backup.manifest.id)).status, 'normal');
  await call('Emulation.setScriptExecutionDisabled', { value: true });
  await navigate('/offer-extractions/new?offerId=' + fixture.offer.id, '資料から登録候補を作る');
  assert.equal(await evaluate('document.querySelectorAll("textarea").length'), 2);
  await call('Emulation.setScriptExecutionDisabled', { value: false });
  await navigate('/offer-extractions/new?offerId=' + fixture.offer.id, '資料から登録候補を作る');
  // Only isolated fictional fixtures: no runtime budget/data mutation.
  await rename(path.join(dataDirectory,'ai-budget/activation.json'),path.join(directory,'fixture-activation-away.json'));
  await fill(fictionalRows());
  await evaluate('document.querySelector("[data-extraction-form] button:not([type])").click()');
  await until(() => evaluate('document.body.innerText.includes("budget_uninitialized")'));
  for (const text of ['共通budget未初期化','外部送信していません','API料金は発生していません','保存前に停止しました']) {
    assert.equal(await evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`),true,text);
  }
  assert.equal(fixture.sdkCalls.length,1); await screenshots('prepare-budget-uninitialized');
  await rename(path.join(directory,'fixture-activation-away.json'),path.join(dataDirectory,'ai-budget/activation.json'));
  await navigate('/offer-extractions/new?offerId=' + fixture.offer.id, '資料から登録候補を作る');
  const oversized = fictionalRows(); oversized[0].text = '架空'.repeat(15000);
  await fill(oversized); await evaluate('document.querySelector("[data-extraction-form] button:not([type])").click()');
  await until(() => evaluate('document.body.innerText.includes("見積上限超過")'));
  assert.equal(await evaluate('document.body.innerText.includes("API料金は発生していません")'),true);
  await screenshots('prepare-input-limit');
  await navigate('/offer-extractions/new?offerId=' + fixture.offer.id, '資料から登録候補を作る');
  const rows = fictionalRows(); rows[0].label += '別版';
  await fill(rows); mode = 'unknown';
  await evaluate('document.querySelector("[data-extraction-form] button:not([type])").click()');
  await until(() => evaluate('document.body.innerText.includes("資料抽出の送信前確認")'));
  await evaluate('document.querySelector("input[name=confirm]").click(); document.querySelector("form button").click()');
  await until(() => evaluate('document.body.innerText.includes("state unknown")'));
  assert.equal(fixture.sdkCalls.length, 2);
  assert.equal(await evaluate('Boolean(document.querySelector("input[name=confirm]")) || Boolean(document.querySelector("a[href^=\\\"/offer-imports/\\\"]"))'), false);
  assert.equal(await evaluate('document.body.innerText.includes("送信結果不明（send_unknown）") && document.body.innerText.includes("二重送信防止のため再送しない")'),true);
  await screenshots('unknown');
  await assert.rejects(fixture.generation.execute(fixture.plan, fixture.generation.confirmation(fixture.plan)), { code: 'ai_in_progress' });
  assert.deepEqual(externalRequests, []); assert.deepEqual(interceptionErrors, []); assert.equal(blockedConnections.length, 0);
  console.log('Step 6-1 Chrome確認成功：複数テキスト・資料追加削除・immutable送信前確認・未チェック承認・SDK stub成功・pending/unverifiedレビュー接続・実usage・共通予算・v2 maintenance・unknown両経路停止・JSなし2資料・375/1280px。外向き通信0件、実API0件。');
  console.log(`隔離fixture・Chrome確認画像: ${directory}`);
} finally {
  if (socket) socket.close();
  chrome.kill('SIGTERM');
  await new Promise(resolve => server.close(resolve));
}
