// Dedicated Step 4 demo: fictional temporary data, no .env, actual materials or API.
import '../test/helpers/network-guard.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import { createOfferStore } from '../lib/offers/store.js';
import { newOfferInput } from '../lib/offers/form.js';
import { createOfferImportStore } from '../lib/offer-import/store.js';
import { regulationFixture } from '../test/fixtures/regulation-import.js';

const dataDirectory = await mkdtemp(path.join(tmpdir(), 'yoshio-reflection-demo-'));
const offers = createOfferStore(dataDirectory);
const offer = await offers.create({ ...newOfferInput(), name: '架空の正式反映先', asp: { code: 'fictional', programId: null } });
const store = createOfferImportStore(dataDirectory);
const fixture = regulationFixture(); fixture.extraction.candidates[1].usage = 'publishable';
let draft = await store.create({ targetOffer: { id: offer.id, revision: offer.revision }, ...fixture });
for (const index of [2, 3, 4]) draft = await store.review(draft.id, `candidate-${index}`, draft.revision,
  { decision: 'accepted', edited: null, sourceChecked: true, reason: '架空fixtureの照合' });
const server = createApp({ dataDirectory, offerImportOptions: { store } });
server.listen(3003, '127.0.0.1', () => {
  console.log(`架空反映デモ: http://127.0.0.1:3003/offer-imports/${draft.id}`);
  console.log(`一時保存先: ${dataDirectory}。実案件・.env・実APIは使用しません。終了はControl+C。`);
});
server.on('error', () => { console.error('デモを起動できませんでした。ポート3003を確認してください。'); process.exitCode = 1; });
