import { executionFixture } from './extraction-execution.js';
import { createOpenAIExtractionProvider } from '../../lib/ai/openai-extraction-provider.js';
import { createExtractionService } from '../../lib/offer-import/extraction-service.js';
import { makeDocuments } from '../../lib/offer-import/extraction-pages.js';

// SDK stub only. Existing fixture activation is isolated in an OS temp directory, never data/.
export const fictionalRows = () => [
  { label: '架空ASP案件詳細', kind: 'asp_material', versionLabel: '架空v1', text: '架空の紙工作教材を毎月提供します。' },
  { label: '架空広告主レギュレーション', kind: 'advertiser_material', versionLabel: '架空v2', text: '必ず上達するという成果保証表現は禁止です。' },
];
export function stubExtraction(input) {
  return { schemaVersion: 1, candidates: input.documents.map((d,i) => ({ target: i === 0 ? 'facts' : 'prohibitedExpressions', conversionKey: null,
    category: i === 0 ? 'feature' : 'prohibition', text: d.text, usage: i === 0 ? 'publishable' : 'constraint_only', purpose: i === 0 ? 'fact' : 'restriction',
    evidence: [{ documentId: d.id, blockId: d.blocks[0].id, start: 0, end: d.text.length, quote: d.text }] })) };
}
export async function openaiExtractionFixture(t, { respond, serviceOptions = {}, ...options } = {}) {
  const c = await executionFixture(t, options); const sdkCalls = [];
  const client = { responses: { async create(request, sdkOptions) {
    const sending = (await c.store.read()).executions.map(e => e.revisions.at(-1)).filter(r => r.state === 'sending');
    if (sending.length !== 1 || sending[0].provider !== 'openai') throw new Error('stub-before-durable-sending');
    sdkCalls.push({ request: structuredClone(request), options: sdkOptions });
    const input = JSON.parse(request.input);
    const response = await (respond ? respond(request, sdkOptions, input) : { status: 'completed', service_tier: 'default', output_text: JSON.stringify(stubExtraction(input)), usage: { input_tokens: 1000, output_tokens: 2000 } });
    // The SDK stub represents the current wire contract; fake legacy fixtures retain v1.
    try {
      const wire = JSON.parse(response.output_text);
      if (wire.schemaVersion === 1 && Array.isArray(wire.candidates)) {
        wire.schemaVersion = 2;
        for (const c of wire.candidates) for (const e of c.evidence || []) { delete e.start; delete e.end; }
        response.output_text = JSON.stringify(wire);
      }
    } catch { /* retain intentionally malformed fictional response */ }
    return response;
  } } };
  const provider = createOpenAIExtractionProvider({ client });
  const service = createExtractionService({ ...c.options, provider, ...serviceOptions });
  const value = { targetOffer: { id: c.offer.id, revision: c.offer.revision }, documents: makeDocuments(fictionalRows()) };
  const prepare = () => service.prepare(value);
  const run = async () => { const r = await prepare(); const v = await service.preview(r.id); return service.approveAndExecute(r.id, v.token, { confirm: true }); };
  return { ...c, provider, client, service, value, sdkCalls, prepare, run };
}
