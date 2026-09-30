import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createDraftStore } from '../../lib/drafts.js';
import { createOfferStore } from '../../lib/offers/store.js';
import { resolveAffiliateContext } from '../../lib/ai/affiliate-context.js';
import { offerInput } from './plan-offer.js';

export async function affiliateDraftFixture(t, changes = {}, dataDirectory = null) {
  const directory = dataDirectory || await mkdtemp(path.join(tmpdir(), 'affiliate-publish-'));
  if (t) t.after(() => rm(directory, { recursive: true, force: true }));
  const offers = createOfferStore(directory);
  const input = offerInput(); input.prohibitedExpressions[0].text = '絶対成功';
  input.facts[0].text = '料金は100円です。';
  input.facts[2].text = '非公開情報専用目印';
  input.conversions[0].reward.evidence.text = '報酬管理専用目印';
  input.sources[0].publicUrl = 'https://reference.example.test/never-copy';
  input.asp.programId = 'management-only';
  const offer = await offers.create(input);
  const plan = { id: randomUUID(), createdAt: new Date().toISOString(), theme: '架空の公開確認用企画', medium: 'note', audience: '', purpose: '', notes: '',
    offerBinding: { offerId: offer.id, offerRevision: 1, conversionId: 'consultation', selectionReason: '', snapshot: { offerName: offer.name, conversionName: offer.conversions[0].name } } };
  const { affiliateContext } = await resolveAffiliateContext(plan.offerBinding, offers, new Date());
  const content = { summary: '概要', titles: ['一', '二', '三', '四', '五'], readerNeeds: '悩み', outline: '構成', body: `${input.disclosure.text}\n料金は100円です。`, cta: input.conversions[0].ctaLabel.text, social: input.disclosure.text, ...changes };
  const drafts = createDraftStore(directory);
  const saved = await drafts.create(plan, { content, generatedAt: null }, JSON.stringify(content), 'mock prompt', null,
    { provider: 'openai', executionId: randomUUID(), simulation: false }, affiliateContext);
  const draft = await drafts.update(saved.id, saved.revision, saved.edited, 'review');
  return { directory, offer, offers, input, plan, content, drafts, draft, file: path.join(directory, 'drafts', `${draft.id}.json`) };
}
