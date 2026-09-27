import '../test/helpers/network-guard.js';
import { tmpdir } from 'node:os';
// インストール済みChromeで実際にフォームを操作する確認用スクリプト。
// Chromeの専用プロフィールと架空データはOSの一時フォルダに保存します。
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createApp } from '../server.js';

const directory = await mkdtemp(path.join(tmpdir(), 'yoshio-browser-phase2-2-'));
await mkdir(directory, { recursive: true });
const dataDirectory = await mkdtemp(path.join(directory, 'run-'));
const server = createApp({ dataDirectory });
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
    if (message.method === 'Network.responseReceived') responses.push(message.params.response);
  });
  await call('Network.enable');
  await call('Page.enable');
  await call('Page.navigate', { url: base });
  await until(() => evaluate('Boolean(document.getElementById("theme"))'));
  await evaluate(`(() => { document.getElementById('theme').value = '公開準備ブラウザ専用の架空企画'; document.querySelector('form button').click(); })()`);
  await until(() => evaluate('Boolean(document.getElementById("prompt"))'));
  const planPath = await evaluate('location.pathname');
  const prompt = await evaluate('document.getElementById("prompt").value');
  const template = JSON.parse(prompt.slice(prompt.lastIndexOf('\n{') + 1));
  template.content = { summary: '架空の工作記事', titles: ['紙の小箱', '小箱を折る', '紙選び', '折り方', '色を楽しむ'], readerNeeds: '工作する', outline: '準備と折り方', body: '架空の紙工作です。要確認 https://example.com', cta: '違う色でも試しましょう。', social: '架空の紙工作の紹介です。' };
  await evaluate(`(() => { document.getElementById('result').value = ${JSON.stringify(JSON.stringify(template))}; document.querySelector('form').requestSubmit(); })()`);
  await until(() => evaluate('Boolean(document.querySelector("[data-editor]"))'));
  const draftPath = await evaluate('location.pathname');
  assert.match(await evaluate('document.querySelector("[data-publish-link]").innerText'), /先に下書きを確認済み/);
  await evaluate('document.querySelector("[data-review]").click()');
  await until(() => evaluate('document.getElementById("draft-status")?.textContent === "確認済み"'));
  await evaluate('document.querySelector("[data-publish-link] a").click()');
  await until(() => evaluate('Boolean(document.querySelector("[data-publish]"))'));
  assert.equal(await evaluate('document.getElementById("titleIndex").value'), '');
  assert.equal(await evaluate('Array.from(document.querySelectorAll("[data-publication-copy]")).every(b => b.disabled)'), true);
  await evaluate(`(() => { document.getElementById('titleIndex').value = '1'; document.querySelector('[value=check]').click(); })()`);
  await until(() => evaluate('document.getElementById("preflight-result")?.textContent === "要確認"'));
  assert.match(await evaluate('document.body.innerText'), /仮URL/);
  await call('Page.navigate', { url: base + draftPath });
  await until(() => evaluate('Boolean(document.querySelector("[data-editor]"))'));
  await evaluate(`(() => { const b = document.getElementById('body'); b.value = '架空の紙工作の手順です。'; b.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  assert.equal(await evaluate('Boolean(document.querySelector("[data-publish-link] a"))'), false);
  await evaluate('document.querySelector("[value=save]").click()');
  await until(() => evaluate('document.getElementById("draft-status")?.textContent === "編集中"'));
  await evaluate('document.querySelector("[data-review]").click()');
  await until(() => evaluate('document.getElementById("draft-status")?.textContent === "確認済み"'));
  await evaluate('document.querySelector("[data-publish-link] a").click()');
  await until(() => evaluate('Boolean(document.querySelector("[data-publish]"))'));
  await evaluate(`(() => { document.getElementById('titleIndex').value = '1'; document.querySelector('[value=ready]').click(); })()`);
  await until(() => evaluate('Boolean(document.querySelector(".error"))'));
  assert.match(await evaluate('document.querySelector(".error").textContent'), /人間による最終確認/);
  await evaluate(`(() => { document.getElementById('titleIndex').value = '1'; document.querySelectorAll('[type=checkbox]').forEach(c => c.click()); document.querySelector('[value=check]').click(); })()`);
  await until(() => evaluate('document.getElementById("publish-status")?.textContent === "最終承認待ち"'));
  assert.equal(await evaluate('document.getElementById("titleIndex").value'), '1');
  assert.match(await evaluate('document.getElementById("preflight-result").textContent'), /問題なし/);
  await evaluate('document.querySelector("[value=ready]").click()');
  await until(() => evaluate('document.getElementById("publish-status")?.textContent === "公開準備OK"'));
  await call('Browser.grantPermissions', { origin: base, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
  await call('Page.bringToFront');
  for (const key of ['title', 'body', 'bodyWithCta', 'social']) {
    await evaluate(`document.querySelector('[data-publication-copy="publish-${key}"]').click()`);
    await until(() => evaluate(`document.getElementById('publish-${key}-message').textContent.includes('コピーしました')`));
    const copied = await call('Runtime.evaluate', { expression: 'navigator.clipboard.readText()', awaitPromise: true, returnByValue: true });
    assert.equal(copied.result.value, await evaluate(`document.getElementById('publish-${key}').value`));
  }
  assert.equal(await evaluate('document.getElementById("publish-title").value'), '小箱を折る');
  assert.equal(await evaluate('document.getElementById("publish-bodyWithCta").value'), '架空の紙工作の手順です。\n\n違う色でも試しましょう。');
  // 拒否されるクリップボードを再現し、失敗案内と手動選択を確認。
  await evaluate(`Object.defineProperty(navigator.clipboard, 'writeText', { value: async () => { throw new Error('test-denied'); }, configurable: true })`);
  await evaluate('document.querySelector("[data-publication-copy]").click()');
  await until(() => evaluate('document.getElementById("publish-title-message").textContent.includes("コピーに失敗")'));
  assert.equal(await evaluate('document.activeElement.id'), 'publish-title');
  for (const width of [320, 375]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 812, deviceScaleFactor: 1, mobile: true });
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    assert.equal(await evaluate(`Array.from(document.querySelectorAll('select, input[type=checkbox], button, textarea')).every(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })`), true);
    await evaluate('document.querySelector("[data-publish]").scrollIntoView()');
    const screenshot = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(directory, `mobile-${width}.png`), Buffer.from(screenshot.data, 'base64'));
  }
  await evaluate(`(() => { const s = document.getElementById('titleIndex'); s.value = '2'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  assert.equal(await evaluate('Array.from(document.querySelectorAll("[data-publication-copy]")).every(b => b.disabled)'), true);
  assert.match(await evaluate('document.getElementById("publish-status").textContent'), /未保存/);
  const errors = responses.filter(r => r.status >= 400);
  assert.equal(errors.length, 1); // 人間確認なしの承認要求のみ400。
  assert.equal(errors[0].status, 400);
  const evidence = { result: '未確認案内・仮記述検出・修正・人間確認不足の拒否・タイトル保存・承認・4種類コピー・コピー失敗・未保存変更のコピー停止・320/375pxを確認', directory, dataDirectory };
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  if (socket) socket.close();
  chrome.kill('SIGTERM');
  await new Promise(resolve => server.close(resolve));
}
