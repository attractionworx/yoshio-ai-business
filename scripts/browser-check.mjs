// インストール済みChromeで実際にフォームを操作する確認用スクリプト。
// Chromeの専用プロフィールと検証記録は、Git対象外のdata/に保存します。
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, 'data/browser-check');
await mkdir(directory, { recursive: true });
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
  await call('Page.navigate', { url: 'http://127.0.0.1:3000/' });
  await until(() => evaluate('Boolean(document.querySelector("form"))'));
  const values = {
    theme: `【動作確認】ブラウザからの企画作成 ${new Date().toISOString()}`,
    audience: '副業・コンテンツ制作の初心者', medium: 'note',
    purpose: 'フォーム送信から保存・表示まで確認する', notes: 'ブラウザによる確認用の企画です。\n既存データは変更していません。',
  };
  await evaluate(`(() => {
    for (const [key, value] of Object.entries(${JSON.stringify(values)})) document.getElementById(key).value = value;
    document.querySelector('button[type="submit"]').click();
  })()`);
  await until(() => evaluate('location.pathname !== "/" && document.readyState === "complete"'));
  const displayed = await evaluate('({ path: location.pathname, text: document.body.innerText })');
  const submission = requests.find(request => Object.keys(request.headers).some(key => key.toLowerCase() === 'origin'));
  const origin = Object.entries(submission?.headers || {}).find(([key]) => key.toLowerCase() === 'origin')?.[1];
  const evidence = { origin, path: displayed.path, statuses: responses.map(response => ({ url: response.url, status: response.status })) };
  if (process.argv.includes('--expect-rejection')) {
    assert.equal(displayed.path, '/plans');
    assert.ok(displayed.text.includes('このアプリの入力画面から保存してください。'));
    assert.ok(responses.some(response => response.status === 403));
    evidence.result = 'ブラウザからの正常な送信が403で拒否される不具合を再現';
  } else {
    assert.match(displayed.path, /^\/plans\/[a-f0-9-]{36}$/);
    const id = displayed.path.split('/').at(-1);
    const saved = JSON.parse(await readFile(path.join(root, 'data', `${id}.json`), 'utf8'));
    for (const [key, value] of Object.entries(values)) {
      assert.equal(saved[key].replace(/\r\n/g, '\n'), value);
      assert.ok(displayed.text.replace(/\r\n/g, '\n').includes(value));
    }
    await call('Page.navigate', { url: 'http://127.0.0.1:3000/' });
    await until(() => evaluate(`Boolean(document.querySelector('a[href="${displayed.path}"]'))`));
    evidence.result = '実ブラウザのフォーム送信→JSON保存→企画表示→一覧掲載を確認';
  }
  await writeFile(path.join(directory, process.argv.includes('--expect-rejection') ? 'before.json' : 'after.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  if (socket) socket.close();
  chrome.kill('SIGTERM');
}
