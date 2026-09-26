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
const directory = path.join(root, 'data/browser-phase2');
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
  // フォーカスのある実ブラウザでクリップボードコピーを検証。
  await call('Browser.grantPermissions', { origin: base, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
  await call('Page.bringToFront');
  await evaluate('document.querySelector("[data-copy]").click()');
  await until(() => evaluate('document.getElementById("copy-message").textContent.includes("コピーしました")'));
  const copied = await call('Runtime.evaluate', { expression: 'navigator.clipboard.readText()', awaitPromise: true, returnByValue: true });
  assert.equal(copied.result.value, prompt);
  const raw = JSON.stringify(template);
  async function importResult() {
    await evaluate(`(() => { document.getElementById('result').value = ${JSON.stringify(raw)}; document.querySelector('form').requestSubmit(); })()`);
    await until(() => evaluate('Boolean(document.querySelector("[data-editor]"))'));
    return evaluate('location.pathname');
  }
  const draftPath = await importResult();
  assert.equal(await evaluate('document.getElementById("draft-status").textContent'), '未確認');
  const file = path.join(dataDirectory, 'drafts', draftPath.split('/').at(-1) + '.json');
  const original = JSON.parse(await readFile(file, 'utf8')).original;
  async function editBody(value) {
    await evaluate(`(() => { const field = document.getElementById('body'); field.value = ${JSON.stringify(value)}; field.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    assert.equal(await evaluate('document.querySelector("[data-review]").disabled'), true);
    await evaluate('document.querySelector("button[value=save]").click()');
    await until(() => evaluate('document.getElementById("draft-status")?.textContent === "編集中"'));
  }
  await editBody('人間が編集した文章\n2行目');
  await evaluate('document.querySelector("[data-review]").click()');
  await until(() => evaluate('document.getElementById("draft-status")?.textContent === "確認済み"'));
  await editBody('確認後に再編集した文章');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).original, original);
  await call('Page.navigate', { url: base + planPath });
  await until(() => evaluate('Boolean(document.getElementById("result"))'));
  const secondPath = await importResult();
  assert.notEqual(secondPath, draftPath);
  await call('Page.navigate', { url: base + planPath });
  await until(() => evaluate(`Boolean(document.querySelector('a[href="${draftPath}"]')) && Boolean(document.querySelector('a[href="${secondPath}"]'))`));
  await evaluate(`document.querySelector('a[href="${draftPath}"]').click()`);
  await until(() => evaluate('Boolean(document.querySelector("[data-editor]"))'));
  assert.equal(await evaluate('document.getElementById("body").value'), '確認後に再編集した文章');
  assert.equal(await evaluate('document.getElementById("draft-status").textContent'), '編集中');
  assert.ok(!responses.some(r => r.status >= 400));
  // 今回の長文回答を実際のクリップボードから貼り付けて検証します。
  const fixtureRaw = await readFile(path.join(root, 'test/fixtures/codex-note-response.json'), 'utf8');
  const fixture = JSON.parse(fixtureRaw);
  const wrappedFixture = await readFile(path.join(root, 'test/fixtures/codex-pasted-wrapped.txt'), 'utf8');
  const actualPlanId = planPath.split('/').at(-1);
  const normalInput = fixtureRaw.replace(fixture.planId, actualPlanId);
  const wrappedInput = '以下が生成した回答です。\n```json\n' + wrappedFixture.replace(fixture.planId, actualPlanId) + '\n```\n以上です。';
  const draftFiles = async () => (await readdir(path.join(dataDirectory, 'drafts'))).filter(n => n.endsWith('.json'));
  async function pasteAndSubmit(input) {
    await call('Page.navigate', { url: base + planPath });
    await until(() => evaluate('Boolean(document.getElementById("result"))'));
    const written = await call('Runtime.evaluate', { expression: `navigator.clipboard.writeText(${JSON.stringify(input)})`, awaitPromise: true });
    assert.ok(!written.exceptionDetails);
    await evaluate('document.getElementById("result").focus()');
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'v', code: 'KeyV', modifiers: 4, windowsVirtualKeyCode: 86, commands: ['Paste'] });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', modifiers: 4, windowsVirtualKeyCode: 86 });
    await until(() => evaluate(`document.getElementById('result').value === ${JSON.stringify(input)}`));
    await evaluate('document.querySelector("form button[type=submit]").click()');
    await until(() => evaluate('location.pathname !== ' + JSON.stringify(planPath) + ' && document.readyState === "complete"'));
  }
  await pasteAndSubmit(normalInput);
  await until(() => evaluate('Boolean(document.querySelector("[data-editor]"))'));
  assert.equal(await evaluate('document.getElementById("body").value'), fixture.content.body);
  assert.equal((await draftFiles()).length, 3);
  await pasteAndSubmit(wrappedInput);
  await until(() => evaluate('Boolean(document.querySelector("button[name=confirmWrap]"))'));
  assert.ok((await evaluate('document.body.innerText')).includes('102か所'));
  assert.equal((await draftFiles()).length, 3, 'プレビューでは保存しない');
  await evaluate('document.querySelector("button[name=confirmWrap]").click()');
  await until(() => evaluate('Boolean(document.querySelector("[data-editor]"))'));
  for (const [key, value] of Object.entries(fixture.content)) {
    assert.equal(await evaluate(`document.getElementById(${JSON.stringify(key)}).value`), Array.isArray(value) ? value.join('\n') : value);
  }
  const correctedPath = await evaluate('location.pathname');
  const correctedFile = path.join(dataDirectory, 'drafts', correctedPath.split('/').at(-1) + '.json');
  const corrected = JSON.parse(await readFile(correctedFile, 'utf8'));
  assert.deepEqual(corrected.original, fixture.content);
  assert.equal(corrected.originalRaw.replace(/\r\n/g, '\n'), wrappedInput);
  assert.equal(corrected.importNormalization.count, 102);
  assert.equal((await draftFiles()).length, 4);
  for (const invalid of [normalInput.slice(0, -10), normalInput + normalInput, wrappedInput.replace('"generatedAt": null,', '"generatedAt": null,,')]) {
    await pasteAndSubmit(invalid);
    await until(() => evaluate('Boolean(document.querySelector(".error"))'));
    assert.equal((await draftFiles()).length, 4, '不正な入力を保存しない');
    assert.equal(await evaluate('document.getElementById("result").value'), invalid);
  }
  assert.ok(!responses.some(r => r.status >= 500));
  const evidence = { result: '既存の全フローと、架空の長文JSON・102か所の折り返し・説明文とコードブロック付き回答のクリップボード貼り付け、確認前未保存、7項目一致、不正入力拒否を確認', planPath, draftPath, secondPath, dataDirectory };
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  if (socket) socket.close();
  chrome.kill('SIGTERM');
  await new Promise(resolve => server.close(resolve));
}
