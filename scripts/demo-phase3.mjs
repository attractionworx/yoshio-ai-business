// 手動確認専用。毎回OS一時フォルダを作り、既存data/には触れません。
import '../test/helpers/network-guard.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import { createFakeProvider } from '../lib/ai/fake-provider.js';

const scenario = process.argv[2] || 'success';
if (!['success', 'error', 'timeout', 'unknown', 'invalid-json', 'missing', 'violation'].includes(scenario)) throw new Error('対応するFakeシナリオを指定してください。');
const dataDirectory = await mkdtemp(path.join(tmpdir(), 'yoshio-phase3-demo-'));
const plan = { id: randomUUID(), createdAt: new Date().toISOString(), theme: '架空の紙工作を紹介する検証企画', audience: '架空の工作読者', medium: 'note', purpose: 'Fake生成の画面確認', notes: '実データを使わない手動確認用です。' };
await writeFile(path.join(dataDirectory, `${plan.id}.json`), JSON.stringify(plan, null, 2) + '\n', { mode: 0o600 });
const server = createApp({ dataDirectory, generationOptions: { provider: createFakeProvider({ scenario }), config: { timeoutMs: 2000 } } });
server.listen(3001, '127.0.0.1', () => {
  console.log('Fake AIの隔離デモ: http://127.0.0.1:3001');
  console.log(`架空データ保存先: ${dataDirectory}`);
  console.log(`シナリオ: ${scenario}。外部API通信・実料金は0。終了はControl+C。`);
});
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? 'ポート3001が使用中です。起動中のデモを終了してから再実行してください。' : 'デモを起動できませんでした。'); process.exitCode = 1; });
