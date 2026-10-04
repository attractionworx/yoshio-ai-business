// Isolated fictional Step 3 review demo; no real data/.env/API access.
import '../test/helpers/network-guard.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import { createOfferImportStore } from '../lib/offer-import/store.js';
import { regulationFixture } from '../test/fixtures/regulation-import.js';

const dataDirectory = await mkdtemp(path.join(tmpdir(), 'yoshio-import-demo-'));
const store = createOfferImportStore(dataDirectory);
await store.create({ targetOffer: null, ...regulationFixture() });
const server = createApp({ dataDirectory, offerImportOptions: { store } });
server.listen(3002, '127.0.0.1', () => {
  console.log('架空候補レビュー: http://127.0.0.1:3002/offer-imports');
  console.log(`一時データ保存先: ${dataDirectory}`);
  console.log('実API・実案件・.envは使用しません。終了はControl+C。');
});
server.on('error', () => { console.error('デモを起動できませんでした。ポート3002を確認してください。'); process.exitCode = 1; });
