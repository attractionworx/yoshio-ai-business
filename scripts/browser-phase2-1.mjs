// インストール済みChromeで実際にフォームを操作する確認用スクリプト。
// Chromeの専用プロフィールと検証記録は、Git対象外のdata/に保存します。
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, 'data/browser-phase2-1');
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
], { stdio: ['ignore', 'ignore', 'pipe'] });

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
  await until(() => evaluate('Boolean(document.querySelector("form"))'));
  await evaluate(`(() => {
    document.getElementById('theme').value = 'ブラウザPhase 2検証';
    document.getElementById('audience').value = '初心者';
    document.querySelector('button[type="submit"]').click();
  })()`);
  await until(() => evaluate('Boolean(document.getElementById("prompt"))'));
  const planPath = await evaluate('location.pathname');
  const prompt = await evaluate('document.getElementById("prompt").value');
  const template = JSON.parse(prompt.slice(prompt.lastIndexOf('\n{') + 1));
  assert.equal(template.planId, planPath.split('/').at(-1));
  await evaluate(`(() => { document.getElementById('result').value = ${JSON.stringify(JSON.stringify(template))}; document.querySelector('form').requestSubmit(); })()`);
  await until(() => evaluate('Boolean(document.querySelector("[data-editor]"))'));
  const parentPath = await evaluate('location.pathname');
  await evaluate('document.querySelector("[data-review]").click()');
  await until(() => evaluate('document.getElementById("draft-status")?.textContent === "確認済み"'));
  const parentFile = path.join(dataDirectory, 'drafts', parentPath.split('/').at(-1) + '.json');
  const parentBefore = await readFile(parentFile, 'utf8');
  assert.equal(await evaluate('document.querySelector("[data-improve] details").open'), false);
  assert.deepEqual(await evaluate('Array.from(document.querySelectorAll("[name=options]:checked"), x => x.value)'), ['readability', 'beginners', 'examples']);
  await evaluate('document.querySelector("[data-improve] button").click()');
  await until(() => evaluate('Boolean(document.getElementById("prompt"))'));
  const improvementPath = await evaluate('location.pathname');
  const improvementPrompt = await evaluate('document.getElementById("prompt").value');
  assert.ok(improvementPrompt.includes('実体験・収益・経歴・成功実績'));
  await call('Browser.grantPermissions', { origin: base, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
  await call('Page.bringToFront');
  await evaluate('document.querySelector("[data-copy]").click()');
  await until(() => evaluate('document.getElementById("copy-message").textContent.includes("コピーしました")'));
  const copied = await call('Runtime.evaluate', { expression: 'navigator.clipboard.readText()', awaitPromise: true, returnByValue: true });
  assert.equal(copied.result.value, improvementPrompt);
  const payload = JSON.parse(improvementPrompt.slice(improvementPrompt.lastIndexOf('\n{') + 1));
  payload.content.body = '改善した本文。仮の例として説明します。';
  await evaluate(`(() => { document.getElementById('result').value = ${JSON.stringify(JSON.stringify(payload))}; document.querySelector('form').requestSubmit(); })()`);
  await until(() => evaluate('Boolean(document.querySelector("[data-editor]"))'));
  const secondPath = await evaluate('location.pathname');
  assert.notEqual(secondPath, parentPath);
  assert.equal(await evaluate('document.getElementById("draft-status").textContent'), '未確認');
  assert.match(await evaluate('document.getElementById("version-history").innerText'), /v2.*最新バージョン/s);
  assert.equal(await readFile(parentFile, 'utf8'), parentBefore);
  // スマホ幅で詳細設定・通常操作・履歴リンクが画面からはみ出さない。
  for (const width of [320, 375]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 812, deviceScaleFactor: 1, mobile: true });
    await evaluate('document.querySelector("[data-improve] details").open = true');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    assert.equal(await evaluate(`Array.from(document.querySelectorAll('[data-improve] input, [data-improve] textarea, [data-improve] button, #version-history a')).every(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })`), true);
  }
  await evaluate('document.querySelector("[data-improve] details").scrollIntoView()');
  const screenshot = await call('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(directory, 'mobile.png'), Buffer.from(screenshot.data, 'base64'));
  await evaluate(`document.querySelector('#version-history a[href="${parentPath}"]').click()`);
  await until(() => evaluate('document.getElementById("draft-status")?.textContent === "確認済み"'));
  assert.equal(await evaluate('document.getElementById("body").value'), template.content.body);
  // 詳細設定から分析。取り込みフォームは出さない。
  await evaluate(`(() => { document.querySelector('[data-improve] details').open = true; document.querySelector('[name=mode][value=analysis]').click(); document.querySelector('[name=options][value=seo]').click(); document.getElementById('instructions').value = '重要な記事なので先に問題を分析'; document.querySelector('[data-improve] button').click(); })()`);
  await until(() => evaluate('Boolean(document.getElementById("prompt"))'));
  const analysisPrompt = await evaluate('document.getElementById("prompt").value');
  assert.ok(analysisPrompt.includes('【分析モード】')); assert.ok(analysisPrompt.includes('SEOを意識する'));
  assert.equal(await evaluate('Boolean(document.getElementById("result"))'), false);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  await call('Page.navigate', { url: base + secondPath });
  await until(() => evaluate('Boolean(document.querySelector("[data-editor]"))'));
  await evaluate('document.getElementById("body").dispatchEvent(new Event("input", { bubbles: true }))');
  assert.equal(await evaluate('document.querySelector("[data-improve] button").disabled'), true);
  assert.ok(!responses.some(r => r.status >= 400));
  assert.equal(await readFile(parentFile, 'utf8'), parentBefore);
  const evidence = { result: '通常依頼・コピー・新規改稿・確認済み親の保持・過去版・詳細設定・分析・未保存編集の誘導・320/375px幅の基本操作を確認', parentPath, secondPath, improvementPath, dataDirectory };
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  if (socket) socket.close();
  chrome.kill('SIGTERM');
  await new Promise(resolve => server.close(resolve));
}
