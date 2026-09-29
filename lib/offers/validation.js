import { readFileSync } from 'node:fs';
import { invalid } from '../content.js';

const schema = JSON.parse(readFileSync(new URL('../../schemas/offer.schema.json', import.meta.url), 'utf8'));
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail = () => { throw invalid('案件情報が不正です。項目・出典・日時・秘密情報の混入を確認してください。'); };

export function validateOfferId(id) {
  if (typeof id !== 'string' || !uuid.test(id)) fail();
  return id;
}

function validDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, y, m, d, h, min, sec, zone] = match;
  const days = new Date(Date.UTC(Number(y), Number(m), 0)).getUTCDate();
  return Number(m) >= 1 && Number(m) <= 12 && Number(d) >= 1 && Number(d) <= days
    && Number(h) <= 23 && Number(min) <= 59 && Number(sec) <= 59
    && (zone === 'Z' || (Number(zone.slice(1, 3)) <= 23 && Number(zone.slice(4)) <= 59));
}

// 値をエラーへ含めない。未知の秘密形式までは判別できないため、必要な案件記述だけを入力する。
export function safeText(value) {
  const normalized = value.normalize('NFKC');
  if (/(?:sk-[a-z0-9_-]{8,}|AKIA[A-Z0-9]{16}|gh[pousr]_[a-z0-9]{20,}|eyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+|-----BEGIN [^-]*PRIVATE KEY-----|\bBearer\s+\S+|\b(?:api[_ -]?key|password|passwd|cookie|set-cookie|authorization|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|session(?:id|_id)?)['"]?\s*[=:：]\s*\S+|(?:APIキー|パスワード|クッキー|認証情報)['"]?\s*[=:：]\s*\S+)/iu.test(normalized)) fail();
  // 自由記述中のURLも検査し、認証情報付きURLの迂回保存を防ぐ。
  for (const match of normalized.matchAll(/https?:\/\/[^\s<>"）]+/giu)) safeUrl(match[0]);
}

function safeUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail();
  const sensitive = /(?:token|password|passwd|secret|cookie|session|authorization|api[_-]?key|credential)/i;
  for (const key of url.searchParams.keys()) if (sensitive.test(key)) fail();
  let fragment;
  try { fragment = decodeURIComponent(url.hash); } catch { fail(); }
  if (sensitive.test(fragment)) fail();
}

// このスキーマで使用する語彙だけを実装。汎用JSON Schemaエンジンではない。
function check(value, rule) {
  if (rule.$ref) return check(value, schema.$defs[rule.$ref.split('/').at(-1)]);
  if (rule.oneOf) {
    let successes = 0;
    for (const choice of rule.oneOf) { try { check(value, choice); successes++; } catch { /* 次の型 */ } }
    if (successes !== 1) fail();
    return;
  }
  if ('const' in rule && value !== rule.const) fail();
  if (rule.enum && !rule.enum.includes(value)) fail();
  if (rule.type === 'null' && value !== null) fail();
  if (rule.type === 'object') {
    if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail();
    if (Object.keys(value).some(key => !Object.hasOwn(rule.properties, key)) || rule.required.some(key => !Object.hasOwn(value, key))) fail();
    for (const [key, item] of Object.entries(value)) check(item, rule.properties[key]);
  }
  if (rule.type === 'array') {
    if (!Array.isArray(value) || value.length < (rule.minItems || 0) || value.length > rule.maxItems) fail();
    if (rule.uniqueItems && new Set(value).size !== value.length) fail();
    for (const item of value) check(item, rule.items);
  }
  if (rule.type === 'string') {
    if (typeof value !== 'string' || value.trim().length < (rule.minLength || 0) || value.length > (rule.maxLength || Infinity)) fail();
    safeText(value);
    if (rule.pattern && !new RegExp(rule.pattern).test(value)) fail();
    if (rule.format === 'uuid') validateOfferId(value);
    if (rule.format === 'date-time' && !validDate(value)) fail();
    if (rule.format === 'uri') safeUrl(value);
  }
  if (['number', 'integer'].includes(rule.type)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < rule.minimum || (rule.type === 'integer' && !Number.isSafeInteger(value))) fail();
  }
}

const topStatements = offer => ['facts', 'targetAudience', 'sellingPoints', 'prohibitedExpressions'].flatMap(key => offer[key]);
const conversionStatements = c => [...c.eligibility, ...c.approvalConditions, ...c.rejectionConditions, ...(c.ctaLabel ? [c.ctaLabel] : []), ...(c.reward ? [c.reward.evidence] : [])];
const checked = statement => statement.verification === 'source_checked';

export function validateOffer(value) {
  check(value, schema);
  const sources = new Map(value.sources.map(source => [source.id, source]));
  const statements = [...topStatements(value), ...value.conversions.flatMap(conversionStatements)];
  // IDの名前空間は出典・statement・成果地点それぞれ。statementは案件全体で一意。
  for (const items of [value.sources, statements, value.conversions]) if (new Set(items.map(item => item.id)).size !== items.length) fail();
  for (const statement of statements) {
    if (statement.sourceIds.some(id => !sources.has(id))) fail();
    if (checked(statement) && (!statement.sourceIds.length || statement.sourceIds.some(id => !sources.get(id).checkedAt))) fail();
  }
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) fail();
  if (value.validFrom && value.validUntil && Date.parse(value.validFrom) >= Date.parse(value.validUntil)) fail();
  for (const c of value.conversions) {
    if (c.reward && ((c.reward.kind === 'percentage' && (c.reward.value > 100 || c.reward.currency !== null)) || (c.reward.kind === 'fixed' && !c.reward.currency))) fail();
    if (c.reward && c.reward.evidence.usage !== 'internal_only') fail();
    if (c.status === 'active') {
      for (const list of [c.eligibility, c.approvalConditions, c.rejectionConditions]) {
        if (!list.length || list.some(s => !checked(s) || s.usage === 'internal_only')) fail();
      }
      if (!c.affiliateUrl || !c.ctaLabel || !checked(c.ctaLabel) || c.ctaLabel.usage !== 'publishable') fail();
    }
  }
  if (value.status === 'active') {
    if (!value.conversions.some(c => c.status === 'active')) fail();
    if (!value.prohibitedExpressions.length || value.prohibitedExpressions.some(s => !checked(s) || s.usage === 'internal_only')) fail();
  }
  return structuredClone(value);
}

// データ層の利用資格判定のみ。プロンプト生成・AIへの接続は行わない。
export function getUsableStatements(value, conversionId, now = new Date()) {
  const offer = validateOffer(value);
  const time = now.getTime();
  if (!Number.isFinite(time)) fail();
  const c = offer.conversions.find(item => item.id === conversionId);
  if (offer.status !== 'active' || c?.status !== 'active'
      || (offer.validFrom && time < Date.parse(offer.validFrom))
      || (offer.validUntil && time >= Date.parse(offer.validUntil))
      || (offer.reviewDueAt && time >= Date.parse(offer.reviewDueAt))) return { publishable: [], constraints: [] };
  const eligible = [...topStatements(offer), ...conversionStatements(c)].filter(checked);
  return { publishable: eligible.filter(s => s.usage === 'publishable'), constraints: eligible.filter(s => s.usage === 'constraint_only') };
}
