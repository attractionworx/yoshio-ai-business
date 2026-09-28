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
    if (message.method === 'Fetch.requestPaused') {
      const allowed = message.params.request.url.startsWith(base + '/');
      if (!allowed) externalRequests.push(message.params.request.url);
      void call(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId: message.params.requestId, ...(allowed ? {} : { errorReason: 'BlockedByClient' }) });
    }
    if (message.method === 'Network.requestWillBeSentExtraInfo') requests.push(message.params);
    if (message.method === 'Network.requestWillBeSent' && /^https?:/.test(message.params.request.url) && new URL(message.params.request.url).origin !== base) externalRequests.push(message.params.request.url);
    if (message.method === 'Network.responseReceived') responses.push(message.params.response);
  });
  await call('Network.enable');
  await call('Page.enable');
  await call('Network.setBlockedURLs', { urls: ['https://*', 'http://*.openai.com/*'] });
  await call('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await call('Page.navigate', { url: base + '/offers/new' });
  await until(() => evaluate('document.querySelector("[data-offer-form]")?.dataset.offerReady === "true"'));
  await evaluate(`(() => {
    window.setField = (name, value) => {
      const field = document.getElementsByName(name)[0];
      if (!field) throw new Error('入力欄がありません: ' + name);
      field.value = value; field.dispatchEvent(new Event('change', { bubbles: true }));
    };
    window.addItem = name => document.getElementsByName(name + '.__array')[0].closest('[data-array]').querySelector(':scope > [data-add-item]').click();
    setField('offer.name', 'ブラウザ検証用の架空案件');
    setField('offer.asp.code', 'demo-asp');
    addItem('offer.sources');
    setField('offer.sources.0.id', 'source-1');
    setField('offer.sources.0.label', '架空資料');
    addItem('offer.facts');
    setField('offer.facts.0.id', 'fact-1');
    setField('offer.facts.0.text', '未確認の架空情報');
    addItem('offer.facts.0.sourceIds');
    setField('offer.facts.0.sourceIds.0', 'source-1');
    addItem('offer.conversions');
    setField('offer.conversions.0.id', 'consultation');
    setField('offer.conversions.0.name', '架空の相談');
    setField('offer.conversions.0.reward.__present', 'value');
    setField('offer.conversions.0.reward.value', '100');
    setField('offer.conversions.0.reward.currency', 'JPY');
    setField('offer.conversions.0.reward.evidence.id', 'reward-1');
    setField('offer.conversions.0.reward.evidence.text', '未確認の架空報酬');
    setField('offer.conversions.0.reward.evidence.usage', 'internal_only');
    setField('offer.conversions.0.ctaLabel.__present', 'value');
    setField('offer.conversions.0.ctaLabel.id', 'cta-1');
    setField('offer.conversions.0.ctaLabel.text', '架空の案内');
    addItem('offer.conversions.0.approvalConditions');
    setField('offer.conversions.0.approvalConditions.0.id', 'condition-1');
    setField('offer.conversions.0.approvalConditions.0.text', '未確認の成果条件');
    addItem('offer.conversions.0.approvalConditions.0.sourceIds');
    setField('offer.conversions.0.approvalConditions.0.sourceIds.0', 'source-1');
    addItem('offer.conversions');
    setField('offer.conversions.1.id', 'contract');
    setField('offer.conversions.1.name', '架空の契約');
    addItem('offer.sellingPoints');
    document.getElementsByName('offer.sellingPoints.0.id')[0].closest('[data-array-item]').querySelector(':scope > [data-remove-item]').click();
  })()`);
  assert.equal(await evaluate('document.getElementsByName("offer.facts.0.verification")[0].value'), 'unverified');
  await evaluate('document.querySelector("[data-offer-form]").requestSubmit()');
  await until(() => evaluate(`Boolean(document.querySelector('a[href$="/edit"]'))`));
  const offerPath = await evaluate('location.pathname');
  const filename = path.join(dataDirectory, 'offers', offerPath.split('/').at(-1) + '.json');
  let record = JSON.parse(await readFile(filename, 'utf8'));
  assert.equal(record.revisions.length, 1);
  assert.equal(record.revisions[0].facts[0].verification, 'unverified');
  assert.equal(record.revisions[0].conversions.length, 2);
  assert.equal(record.revisions[0].conversions[0].reward.value, 100);
  assert.equal(record.revisions[0].conversions[0].reward.evidence.usage, 'internal_only');
  assert.equal(record.revisions[0].conversions[0].ctaLabel.verification, 'unverified');
  assert.deepEqual(record.revisions[0].conversions[0].approvalConditions[0].sourceIds, ['source-1']);
  assert.deepEqual(record.revisions[0].sellingPoints, []);
  await call('Page.navigate', { url: base + offerPath + '/edit' });
  await until(() => evaluate('document.querySelector("[data-offer-form]")?.dataset.offerReady === "true"'));
  await evaluate(`(() => {
    document.getElementsByName('offer.status')[0].value = 'paused';
    document.querySelector('[data-offer-form]').requestSubmit();
  })()`);
  await until(() => evaluate(`Boolean(document.querySelector('a[href$="/edit"]'))`));
  record = JSON.parse(await readFile(filename, 'utf8'));
  assert.equal(record.revisions.length, 2);
  assert.equal(record.revisions[0].status, 'draft');
  assert.equal(record.revisions[1].status, 'paused');
  assert.equal(record.revisions[1].facts[0].verification, 'unverified');
  for (const width of [375, 1280]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'));
  }
  await call('Page.navigate', { url: base + offerPath + '/revisions/1' });
  await until(() => evaluate('document.body.innerText.includes("過去revisionの閲覧")'));
  // Step 2.1：自動ID・出典選択・日時を、端末のタイムゾーンを変えて確認。
  await call('Emulation.setTimezoneOverride', { timezoneId: 'America/New_York' });
  await call('Page.navigate', { url: base + '/offers/new' });
  await until(() => evaluate('document.querySelector("[data-offer-form]")?.dataset.offerReady === "true"'));
  const automatic = await evaluate(`(() => {
    const set = (name, value) => { const field = document.getElementsByName(name)[0]; field.value = value; field.dispatchEvent(new Event('input', { bubbles: true })); };
    const add = name => document.getElementsByName(name + '.__array')[0].closest('[data-array]').querySelector(':scope > [data-add-item]').click();
    set('offer.name', 'UI改善ブラウザ確認'); set('offer.asp.code', 'test');
    set('offer.validFrom', '2026-09-28T09:00');
    add('offer.sources'); set('offer.sources.0.label', '架空の出典資料'); set('offer.sources.0.checkedAt', '2026-09-28T09:12:34.123');
    add('offer.facts'); set('offer.facts.0.text', '自動IDを持つ未確認情報'); add('offer.facts.0.sourceIds');
    const source = document.getElementsByName('offer.sources.0.id')[0].value;
    const fact = document.getElementsByName('offer.facts.0.id')[0].value;
    const reference = document.getElementsByName('offer.facts.0.sourceIds.0')[0];
    if (reference.tagName !== 'SELECT' || !reference.options[1].text.includes('架空の出典資料')) throw new Error('出典選択の表示が不正');
    reference.value = source;
    document.querySelectorAll('form details').forEach(section => { section.open = true; });
    return { source, fact };
  })()`);
  assert.match(automatic.source, /^source-[a-f0-9-]{36}$/);
  assert.match(automatic.fact, /^statement-[a-f0-9-]{36}$/);
  for (const width of [375, 1280]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), `フォーム幅${width}`);
  }
  await evaluate('document.querySelector("[data-offer-form]").requestSubmit()');
  await until(() => evaluate(`Boolean(document.querySelector('a[href$="/edit"]'))`));
  const improvedPath = await evaluate('location.pathname');
  const improvedFile = path.join(dataDirectory, 'offers', improvedPath.split('/').at(-1) + '.json');
  let improved = JSON.parse(await readFile(improvedFile, 'utf8'));
  assert.equal(improved.revisions[0].validFrom, '2026-09-28T09:00:00+09:00');
  assert.equal(improved.revisions[0].sources[0].checkedAt, '2026-09-28T09:12:34.123+09:00');
  assert.deepEqual(improved.revisions[0].facts[0].sourceIds, [automatic.source]);
  assert.equal(improved.revisions[0].facts[0].verification, 'unverified');
  await call('Page.navigate', { url: base + improvedPath + '/edit' });
  await until(() => evaluate('document.querySelector("[data-offer-form]")?.dataset.offerReady === "true"'));
  assert.equal(await evaluate('document.getElementsByName("offer.facts.0.id")[0].value'), automatic.fact);
  await evaluate(`document.getElementsByName('offer.sources.0.id')[0].closest('[data-array-item]').querySelector(':scope > [data-remove-item]').click()`);
  assert.equal(await evaluate('document.getElementsByName("offer.facts.0.sourceIds.0")[0].value'), automatic.source);
  assert.match(await evaluate('document.getElementsByName("offer.facts.0.sourceIds.0")[0].selectedOptions[0].text'), /参照先がありません/);
  await evaluate('document.querySelector("[data-offer-form]").requestSubmit()');
  await until(() => evaluate('Boolean(document.querySelector("[role=alert]"))'));
  assert.equal(JSON.parse(await readFile(improvedFile, 'utf8')).revisions.length, 1);
  await call('Page.navigate', { url: base + improvedPath + '/edit' });
  await until(() => evaluate('document.querySelector("[data-offer-form]")?.dataset.offerReady === "true"'));
  await evaluate(`document.getElementsByName('offer.status')[0].value = 'active'; document.querySelector('[data-offer-form]').requestSubmit()`);
  await until(() => evaluate('Boolean(document.querySelector("[role=alert]"))'));
  assert.match(await evaluate('document.body.innerText'), /禁止表現が未登録/);
  assert.equal(JSON.parse(await readFile(improvedFile, 'utf8')).revisions.length, 1);
  // JavaScript無効でも既存データを編集保存でき、ID・未確認状態・履歴を保持する。
  await call('Emulation.setScriptExecutionDisabled', { value: true });
  await call('Page.navigate', { url: base + improvedPath + '/edit' });
  await until(() => evaluate('Boolean(document.querySelector("[data-offer-form]"))'));
  assert.equal(await evaluate('document.querySelector("[data-offer-form]").dataset.offerReady'), undefined);
  assert.equal(await evaluate('document.getElementsByName("offer.validFrom")[0].value'), '2026-09-28T09:00');
  await evaluate(`(() => {
    document.getElementsByName('offer.name')[0].value = 'JSなしで編集';
    document.querySelector('[data-offer-form]').requestSubmit();
  })()`);
  await until(() => evaluate(`Boolean(document.querySelector('a[href$="/edit"]'))`));
  improved = JSON.parse(await readFile(improvedFile, 'utf8'));
  assert.equal(improved.revisions.length, 2);
  assert.equal(improved.revisions[1].sources[0].id, automatic.source);
  assert.equal(improved.revisions[1].facts[0].id, automatic.fact);
  assert.equal(improved.revisions[1].facts[0].verification, 'unverified');
  assert.equal(Date.parse(improved.revisions[1].validFrom), Date.parse(improved.revisions[0].validFrom));
  await call('Emulation.setScriptExecutionDisabled', { value: false });
  assert.deepEqual(externalRequests, []);
  assert.equal(blockedConnections.length, 0);
  console.log('Phase 4 Step 2/2.1ブラウザ確認成功：追加・削除・任意項目・自動ID・出典選択・参照削除拒否・日本時間変換（端末NY）・JSなし編集・active拒否・履歴・375/1280px。外部通信・実API呼出し0件。');
} finally {
  if (socket) socket.close();
  chrome.kill('SIGTERM');
  await new Promise(resolve => server.close(resolve));
}
