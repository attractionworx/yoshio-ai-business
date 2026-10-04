import { hashDocumentText } from '../../lib/offer-import/validation.js';
import { createOfferImport } from '../../lib/offer-import/contract.js';

// Entirely fictional; never read data/, .env, or any advertiser's actual materials.
export const importTime = '2026-10-04T01:00:00.000Z';
export function regulationFixture() {
  const lines = [
    '正式表記は「架空の紙工作ラボ」です。',
    '月額1,000円（税込1,100円）です。',
    '必ず上達するという成果保証表現は禁止です。',
    '記事の最終ゴールは月額会員への入会です。体験会参加を最終ゴールにしないでください。',
    '成果条件は、初回の月額会員登録完了です。',
    '対象読者は紙工作を始めたい成人です。',
    '視認できないPR表記は禁止です。',
    '会員向けの紙工作教材を毎月提供します。',
    '報酬は架空の固定額300円です。',
  ];
  const text = lines.join('\n');
  let offset = 0;
  const blocks = lines.map((line, index) => {
    const start = offset;
    offset += line.length + (index < lines.length - 1 ? 1 : 0);
    return { id: `paragraph-${index + 1}`, start, end: offset };
  });
  const documents = [{ id: 'document-1', format: 'text', label: '架空ASPのテスト専用資料',
    kind: 'asp_material', versionLabel: '架空v1', text, textHash: hashDocumentText(text), blocks }];
  const targets = ['name', 'facts', 'prohibitedExpressions', 'prohibitedExpressions', 'approvalConditions',
    'targetAudience', 'prohibitedExpressions', 'sellingPoints', 'reward_evidence'];
  const categories = ['other', 'price', 'prohibition', 'prohibition', 'approval', 'audience', 'prohibition', 'selling_point', 'reward'];
  const candidates = lines.map((text, index) => ({ target: targets[index],
    conversionKey: [4, 8].includes(index) ? 'membership' : null, category: categories[index], text,
    usage: [2, 3, 6].includes(index) ? 'constraint_only' : 'internal_only',
    purpose: index === 3 ? 'marketing_goal' : index === 4 ? 'conversion_condition'
      : [2, 6].includes(index) ? 'restriction' : 'fact',
    evidence: [{ documentId: 'document-1', blockId: blocks[index].id, start: blocks[index].start,
      end: blocks[index].start + text.length, quote: text }],
  }));
  return { documents, extraction: { schemaVersion: 1, candidates } };
}
export function importFixture() {
  return createOfferImport({ id: '10000000-0000-4000-8000-000000000001', createdAt: importTime,
    ...regulationFixture() });
}
