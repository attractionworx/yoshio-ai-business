import { currentOfferCheckPasses, currentOfferReasons } from './current-offer-check.js';
import { invalid } from './content.js';
import { readPublicationInput, prepareAffiliatePublication } from './affiliate-publication.js';

export const humanChecks = [
  ['experience', '本人の実体験・経歴・実績として書かれている内容を確認した'],
  ['numbers', '数値・収益・金額などの表現を確認した'],
  ['links', '外部リンクがある場合、そのリンク先を確認した（ない場合はリンクがないことを確認した）'],
];

// 公開対象の4項目のみ検査。外部リンクの取得や事実性の判定は行いません。
export function publicationData(draft, titleIndex) {
  const index = typeof titleIndex === 'string' && /^[0-4]$/.test(titleIndex) ? Number(titleIndex) : titleIndex;
  const title = Number.isInteger(index) && index >= 0 && index < draft.edited.titles.length ? draft.edited.titles[index] : '';
  const { body, cta, social } = draft.edited;
  return { title, body, cta, social, bodyWithCta: [body, cta].filter(Boolean).join('\n\n') };
}

const rules = [
  ['要確認の記述', /要確認/u],
  ['仮URL', /\b(?:[a-z0-9-]+\.)*(?:example\.(?:com|org|net)|localhost|[^\s/]+\.(?:invalid|test))(?=[:/?#\s）)\]。、]|$)|https?:\/\/(?:xxx+|仮URL|ここにURL)/iu],
  ['編集メモ・プレースホルダー', /\b(?:TODO|FIXME|TBD)\b|【(?:編集メモ|仮タイトル|ここに[^】]+|公開前に[^】]+)】|\{\{[^{}\n]+\}\}|\[(?:URL|リンク|タイトル|本文|CTA|ここに[^\]\n]+)\]/iu],
  ['未確定の案内先', /(?:URL|リンク(?:先)?|案内先|申込先|申し込み先|公開先)\s*[：:（(]?\s*(?:未定|未確定|後日|準備中|仮|差し替え|あとで)|(?:URL|リンク(?:先)?)を(?:後で|後日|あとで)(?:追加|挿入|記載|差し替え)/iu],
];

export function preflight(data) {
  const labels = { title: 'タイトル', body: '本文', cta: 'CTA', social: 'SNS告知文' };
  return Object.entries(labels).flatMap(([field, label]) => rules.filter(([, pattern]) => pattern.test(data[field])).map(([reason]) => ({ field, label, reason })));
}

export function preparePublication(draft, input, currentOfferCheck = null) {
  input = readPublicationInput(draft, input);
  if (draft.status !== '確認済み') throw invalid('公開準備をするには、先に下書きを確認済みにしてください。');
  if (!['check', 'ready'].includes(input.action)) throw invalid('公開前チェックまたは公開準備OKを選んでください。');
  const titleIndex = /^[0-4]$/.test(input.titleIndex ?? '') ? Number(input.titleIndex) : null;
  const data = publicationData(draft, titleIndex);
  const findings = preflight(data);
  const confirmations = Object.fromEntries(humanChecks.map(([key]) => [key, input[key] === 'yes']));
  const missing = [];
  if (!data.title) missing.push('公開するタイトルを選択してください。');
  if (findings.length) missing.push('検出された記述を下書きで修正し、再度確認済みにしてください。');
  if (!Object.values(confirmations).every(Boolean)) missing.push('人間による最終確認をすべて行ってください。');
  const checkedAt = new Date().toISOString();
  const affiliate = prepareAffiliatePublication(draft, input, checkedAt);
  if (affiliate) {
    affiliate.currentOfferCheck = currentOfferCheck;
    missing.push(...affiliate.missing);
    if (!currentOfferCheckPasses(draft, currentOfferCheck)) missing.push(currentOfferReasons[currentOfferCheck?.reasonCode] || '現在案件チェックが未実施です。');
  }
  if (input.action === 'ready' && missing.length && (!affiliate || currentOfferCheckPasses(draft, currentOfferCheck))) throw invalid(missing.join(' '));
  return { schemaVersion: 1, titleIndex, confirmations, findings, checkedAt,
    ...(affiliate ? { affiliate } : {}),
    status: missing.length ? '要修正' : input.action === 'ready' ? '公開準備OK' : '最終承認待ち',
    missing, readyAt: input.action === 'ready' && !missing.length ? new Date().toISOString() : null };
}
