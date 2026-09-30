import { contentFields, validateContent, invalid } from './content.js';
import { contextHash, validateAffiliateContext } from './ai/affiliate-context.js';
import { verifyAffiliateEvidence } from './affiliate-evidence.js';

export const AFFILIATE_VALIDATION_VERSION = 'affiliate-local-v1';
export const findingSeverities = Object.freeze(['block', 'warning', 'info']);
// hashは変更検出用。署名・真正性・事実の正しさを保証しない。
export const contentHash = content => contextHash(validateContent(content));
export function affiliateContextHash(context) {
  const c = validateAffiliateContext(context);
  return contextHash({ schemaVersion: c.schemaVersion, offerId: c.offerId,
    offerRevision: c.offerRevision, conversionId: c.conversionId, snapshot: c.snapshot });
}
const normalize = text => text.normalize('NFKC').toLowerCase();
const compact = text => normalize(text).replace(/[\s\u200B-\u200D\uFEFF]/gu, '');
const numberPattern = /\d[\d,]*(?:\.\d+)?\s*(?:億|万|千)?\s*(?:円|%|日|週間|週|か月|ヶ月|カ月|月|年|時間|分|人|名)/gu;
function numericText(text) {
  return normalize(text).replace(numberPattern, token => {
    const m = /^(\d[\d,]*(?:\.\d+)?)\s*(億|万|千)?\s*(.*)$/u.exec(token);
    const value = Number(m[1].replaceAll(',', '')) * ({ 億: 1e8, 万: 1e4, 千: 1e3 }[m[2]] || 1);
    return `${value}${m[3]}`;
  }).trim();
}
const clauses = text => text.split(/[。！？\n]/u).map(s => s.trim()).filter(Boolean);

/** Pure/local. checkedAtを呼出側が与えるので同一入力の結果は決定論的。
 * contextありでは必ず固定offerを照合する。検査通過・infoは真偽の承認ではない。
 * humanConfirmation/公開可否/本文修正は扱わない。
 */
export function validateAffiliateContent({ content, affiliateContext = null, fixedOffer = null, checkedAt }) {
  const safeContent = validateContent(content);
  if (typeof checkedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(checkedAt)
      || !Number.isFinite(Date.parse(checkedAt))) throw invalid('検査日時が不正です。');
  const findings = [];
  const add = (code, severity, field, titleIndex, evidenceRefs = [], location) => {
    const base = { code, severity, field, ...(titleIndex === undefined ? {} : { titleIndex }),
      ...(location ? { location } : {}), evidenceRefs, messageKey: `affiliate.${code}` };
    findings.push({ id: contextHash(base), ...base });
  };
  const result = { schemaVersion: 1, validationVersion: AFFILIATE_VALIDATION_VERSION,
    contentHash: contentHash(safeContent), affiliateContextHash: affiliateContext ? affiliateContextHash(affiliateContext) : null,
    checkedAt, findings };
  if (!affiliateContext) return result; // 案件なしは既存フローへ影響させない。
  let snapshot;
  try { snapshot = verifyAffiliateEvidence(affiliateContext, fixedOffer); }
  catch { add('evidence-mismatch', 'block', 'context'); return result; }

  // 根拠参照は固定snapshot上の位置のみ。source ID/URL/内部管理値を保存しない。
  const publicEvidence = ['facts', 'targetAudience', 'sellingPoints', 'eligibility', 'approvalConditions', 'rejectionConditions']
    .flatMap(key => snapshot[key].map((text, index) => ({ text, ref: `${key}:${index}` })));
  for (const [field] of contentFields) {
    const texts = field === 'titles' ? safeContent[field] : [safeContent[field]];
    texts.forEach((raw, index) => {
      const titleIndex = field === 'titles' ? index : undefined;
      snapshot.prohibitedExpressions.forEach((expression, i) => {
        if (raw.includes(expression) || normalize(raw).includes(normalize(expression))) {
          add('prohibited-expression', 'block', field, titleIndex, [`prohibitedExpressions:${i}`]);
        } else if (compact(raw).includes(compact(expression))) {
          add('prohibition-evasion-candidate', 'warning', field, titleIndex, [`prohibitedExpressions:${i}`]);
        }
      });
      let offset = 0;
      for (const clause of clauses(raw)) {
        const start = raw.indexOf(clause, offset); offset = start + clause.length;
        const location = { start, end: offset }; // 原文UTF-16位置。正規化位置は流用しない。
        const numbers = [...normalize(clause).matchAll(numberPattern)];
        if (numbers.length) {
          const matches = publicEvidence.filter(e => clauses(e.text).some(c => numericText(c) === numericText(clause)));
          if (matches.length) add('numeric-text-match', 'info', field, titleIndex, matches.map(e => e.ref), location);
          else {
            const limited = publicEvidence.some(e => /最大|最低|最長|最短|以上|以下|まで|約/u.test(e.text)
              && [...normalize(e.text).matchAll(numberPattern)].some(n => numbers.some(m => numericText(n[0]) === numericText(m[0]))));
            add(limited ? 'numeric-qualification-review' : 'unregistered-numeric-candidate', 'warning', field, titleIndex, [], location);
          }
        } else if (/(?:実績|達成|成功率|効果|改善|保証|対象|限定|条件|無料|有料)/u.test(clause)) {
          const matches = publicEvidence.filter(e => clauses(e.text).some(c => normalize(c) === normalize(clause)));
          add(matches.length ? 'claim-text-match' : 'claim-review', matches.length ? 'info' : 'warning', field, titleIndex, matches.map(e => e.ref), location);
        }
      }
    });
  }
  for (const placement of snapshot.disclosure.placements) {
    const field = placement === 'bodyStart' ? 'body' : placement;
    const raw = normalize(safeContent[field]).trimStart();
    const required = normalize(snapshot.disclosure.text);
    const present = placement === 'bodyStart' ? raw.startsWith(required) : raw.includes(required);
    if (!present) add('disclosure-missing-or-misplaced', 'block', field, undefined, ['disclosure']);
  }
  add(normalize(safeContent.cta).trim() === normalize(snapshot.cta).trim() ? 'cta-text-match' : 'cta-review',
    normalize(safeContent.cta).trim() === normalize(snapshot.cta).trim() ? 'info' : 'warning', 'cta', undefined, ['cta']);
  add('human-fact-review-required', 'warning', 'all');
  return result;
}
