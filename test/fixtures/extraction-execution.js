import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { newOfferInput } from '../../lib/offers/form.js';
import { createOfferStore } from '../../lib/offers/store.js';
import { createOfferImportStore } from '../../lib/offer-import/store.js';
import { createExecutionStore } from '../../lib/offer-import/execution-store.js';
import { createExtractionService } from '../../lib/offer-import/extraction-service.js';
import { createBudgetCoordinator } from '../../lib/ai/budget-coordinator.js';
import { createGenerationService } from '../../lib/ai/generation-service.js';
import { createDraftStore } from '../../lib/drafts.js';
import { createGenerationStore } from '../../lib/ai/generation-store.js';
import { regulationFixture, importTime } from './regulation-import.js';
import { fixtureBudgetPolicy } from './ai-budget.js';

export async function executionFixture(t, { activate = true, policy = fixtureBudgetPolicy, now = () => new Date(importTime), ...overrides } = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'fictional-extraction-'));
  t?.after(() => fs.rm(root, { recursive: true, force: true }));
  const offers = createOfferStore(root, { now }); const offer = await offers.create({ ...newOfferInput(), name: '架空の折り紙講座', asp: { code: 'fictional-asp', programId: null } });
  const imports = createOfferImportStore(root, { now }); const store = createExecutionStore(root, { now });
  const coordinator = createBudgetCoordinator(root, { now, executionStore: store });
  if (activate) await coordinator.activate(policy, { confirm: true, expectedRevision: 0 });
  const calls = [];
  const provider = { kind: 'fake', async extract(args) { calls.push(args); return { extraction: regulationFixture().extraction, usage: { inputTokens: 100, outputTokens: 200 } }; } };
  const options = { dataDirectory: root, now, provider, store, importStore: imports, offerStore: offers, coordinator, ...overrides };
  const service = createExtractionService(options);
  const value = { targetOffer: { id: offer.id, revision: 1 }, documents: regulationFixture().documents };
  const ready = async (s = service, input = value) => { const r = await s.prepare(input); return s.approve(r.id, r.revision, { confirm: true, requestHash: r.requestHash }); };
  const run = async (s = service) => { const r = await ready(s); return s.execute(r.id, r.revision); };
  const plan = { id: randomUUID(), createdAt: now().toISOString(), theme: '架空の紙工作', audience: '', medium: 'note', purpose: '', notes: '' };
  const generation = createGenerationService({ dataDirectory: root, now, draftStore: createDraftStore(root), store: createGenerationStore(root), coordinator });
  return { root, now, offers, offer, imports, store, coordinator, options, service, provider, calls, value, ready, run, plan, generation };
}
