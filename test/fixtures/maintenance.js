import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createOfferStore } from '../../lib/offers/store.js';
import { newOfferInput } from '../../lib/offers/form.js';
import { createOfferImportStore } from '../../lib/offer-import/store.js';
import { createCommitStore } from '../../lib/offer-import/commit-store.js';
import { createReflectionService } from '../../lib/offer-import/reflection-service.js';
import { createMaintenanceService } from '../../lib/maintenance/backup.js';
import { regulationFixture, importTime } from './regulation-import.js';

export const checkedAction = { decision: 'accepted', edited: null, sourceChecked: true, reason: '' };
export async function maintenanceFixture(t, { committed = true, fileSystem, offerWrapper } = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'yoshio-maintenance-fixture-'));
  t?.after(() => fs.rm(root, { recursive: true, force: true }));
  const now = () => new Date(importTime);
  const offers = createOfferStore(root, { now });
  const offer = await offers.create({ ...newOfferInput(), name: '架空のバックアップ検証案件', asp: { code: 'fictional', programId: null } });
  const imports = createOfferImportStore(root, { now });
  let draft = await imports.create({ targetOffer: { id: offer.id, revision: 1 }, ...regulationFixture() });
  draft = await imports.review(draft.id, 'candidate-2', draft.revision, checkedAction);
  const audit = createCommitStore(root);
  const reflection = createReflectionService({ dataDirectory: root, importStore: imports, offerStore: offerWrapper ? offerWrapper(offers) : offers, auditStore: audit, now });
  const options = { offerId: offer.id, conversions: [] };
  if (committed) await reflection.commit((await reflection.preview(draft.id, options)).token, { approve: true });
  return { root, offers, imports, audit, reflection, offer, draft, options, now, maintenance: createMaintenanceService(root, { now, ...(fileSystem ? { fileSystem } : {}) }) };
}
export async function storeBytes(root) {
  const result = {};
  for (const dir of ['offers', 'offer-imports', 'offer-import-commits']) {
    let files; try { files = await fs.readdir(path.join(root, dir)); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    for (const f of files.sort()) {
      const stat = await fs.lstat(path.join(root, dir, f));
      result[`${dir}/${f}`] = stat.isFile() ? await fs.readFile(path.join(root, dir, f), 'utf8') : 'directory';
    }
  }
  return result;
}
