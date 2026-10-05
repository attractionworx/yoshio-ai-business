import { executionFixture } from './extraction-execution.js';
import { regulationFixture } from './regulation-import.js';
import { makeDocuments } from '../../lib/offer-import/extraction-pages.js';
import { createExtractionService } from '../../lib/offer-import/extraction-service.js';

// All writes stay in an isolated OS temp fixture. No SDK or API client is constructed.
export async function reanalysisFixture(t, { oneLine = false, ...options } = {}) {
  const c = await executionFixture(t, options);
  if (oneLine) c.value.documents = makeDocuments([{label:'架空ASP資料',kind:'asp_material',versionLabel:'架空v1',text:'架空の紙工作教材を提供します。'}, {label:'架空広告主規約',kind:'advertiser_material',versionLabel:'架空v1',text:'成果保証表現は禁止です。'}]);
  const output = oneLine ? {schemaVersion:1,candidates:c.value.documents.map((d,i)=>({target:i===0?'facts':'prohibitedExpressions',conversionKey:null,category:i===0?'feature':'prohibition',text:d.text,usage:i===0?'publishable':'constraint_only',purpose:i===0?'fact':'restriction',evidence:[{documentId:d.id,blockId:'block-1',start:0,end:d.text.length,quote:d.text}]}))} : regulationFixture().extraction; const attempts = [];
  const provider = { kind: 'fake', async extract(args) {
    attempts.push(structuredClone({ input: args.input, configuration: args.configuration }));
    const sending = (await c.store.read()).executions.map(e => e.revisions.at(-1)).filter(r => r.state === 'sending');
    if (sending.length !== 1) throw new Error('fictional durable sending missing');
    return { extraction: attempts.length === 1 ? {} : output,
      usage: { inputTokens: 100, outputTokens: 200 } };
  } };
  const service = createExtractionService({ ...c.options, provider });
  const source = await c.run(service);
  return { ...c, service, provider, attempts, source, reopen: extra => createExtractionService({ ...c.options, provider, ...extra }),
    prepareChild: async (s = service) => { const v = await s.reanalysisPreview(source.id); return s.prepareReanalysis(source.id,v.token,{confirm:true}); } };
}
