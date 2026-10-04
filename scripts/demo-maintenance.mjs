// Dedicated Step 5 demo: temporary fictional data; importing server.js does not load .env.
import '../test/helpers/network-guard.js';
import { createApp } from '../server.js';
import { maintenanceFixture } from '../test/fixtures/maintenance.js';
const fixture = await maintenanceFixture();
const server = createApp({ dataDirectory: fixture.root, maintenanceOptions: { now: fixture.now } });
server.listen(3004, '127.0.0.1', () => {
  console.log('架空データ保全デモ: http://127.0.0.1:3004/maintenance');
  console.log(`一時保存先: ${fixture.root}。実案件・.env・実APIは使用しません。終了はControl+C。`);
});
server.on('error', () => { console.error('デモを起動できませんでした。ポート3004を確認してください。'); process.exitCode = 1; });
