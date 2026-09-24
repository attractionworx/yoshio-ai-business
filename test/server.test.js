import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../server.js';

test('企画の保存・再起動後の表示・入力検証・外部サイトからの保存拒否', async t => {
  // 検証データもプロジェクト内のGit対象外フォルダに保存します。
  const { mkdir } = await import('node:fs/promises');
  const testRoot = path.resolve('data/test-runs');
  await mkdir(testRoot, { recursive: true });
  const dataDirectory = await mkdtemp(path.join(testRoot, 'run-'));
  async function start() {
    const server = createApp({ dataDirectory });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    t.after(() => new Promise(resolve => server.close(resolve)));
    return { server, base: `http://127.0.0.1:${server.address().port}` };
  }
  const first = await start();
  const home = await fetch(first.base);
  assert.equal(home.status, 200);
  assert.equal(home.headers.get('referrer-policy'), 'same-origin');
  assert.match(await home.text(), /企画を作成/);
  assert.equal((await fetch(`${first.base}/style.css`)).status, 200);

  const theme = '<script>alert("test")</script> 副業入門';
  const values = { theme, audience: '初心者', medium: 'note', purpose: '経験を共有', notes: '1行目\n2行目' };
  const saved = await fetch(`${first.base}/plans`, {
    method: 'POST', headers: { Origin: first.base, 'Sec-Fetch-Site': 'same-origin' },
    body: new URLSearchParams(values), redirect: 'manual',
  });
  assert.equal(saved.status, 303);
  const location = saved.headers.get('location');
  assert.match(location, /^\/plans\/[a-f0-9-]{36}$/);
  const file = (await readdir(dataDirectory)).find(name => name.endsWith('.json'));
  const stored = JSON.parse(await readFile(path.join(dataDirectory, file), 'utf8'));
  for (const [key, value] of Object.entries(values)) assert.equal(stored[key], value);

  await new Promise(resolve => first.server.close(resolve));
  const second = await start();
  const detail = await fetch(second.base + location);
  assert.equal(detail.status, 200);
  const html = await detail.text();
  assert.match(html, /&lt;script&gt;/);
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('1行目\n2行目'));
  assert.ok((await (await fetch(second.base)).text()).includes(location));

  for (const invalid of [{ ...values, theme: ' ' }, { ...values, medium: '不正な媒体' }, { ...values, notes: 'あ'.repeat(5001) }]) {
    const response = await fetch(`${second.base}/plans`, { method: 'POST', body: new URLSearchParams(invalid) });
    assert.equal(response.status, 400);
  }
  for (const headers of [
    { Origin: 'https://example.com' },
    { Origin: 'null' },
    { 'Sec-Fetch-Site': 'cross-site' },
  ]) {
    const foreign = await fetch(`${second.base}/plans`, {
      method: 'POST', headers, body: new URLSearchParams(values),
    });
    assert.equal(foreign.status, 403);
  }
  assert.equal((await readdir(dataDirectory)).length, 1);
  assert.equal((await fetch(`${second.base}/plans/00000000-0000-0000-0000-000000000000`)).status, 404);
  assert.equal((await fetch(`${second.base}/.env`)).status, 404);
  assert.equal((await fetch(`${second.base}/data/${file}`)).status, 404);
});
