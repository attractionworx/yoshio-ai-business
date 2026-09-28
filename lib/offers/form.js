import { readFileSync } from 'node:fs';
import { invalid } from '../content.js';
import { fromJapanInput } from './ui-guidance.js';

// 型の定義はStep 1のスキーマだけを使用。ここではフォームの文字列を型へ変換する。
export const offerSchema = JSON.parse(readFileSync(new URL('../../schemas/offer.schema.json', import.meta.url), 'utf8'));
export const businessProperties = Object.fromEntries(Object.entries(offerSchema.properties).filter(([key]) => !['id', 'schemaVersion', 'revision', 'createdAt', 'updatedAt'].includes(key)));
export const resolveRule = rule => rule.$ref ? offerSchema.$defs[rule.$ref.split('/').at(-1)] : rule;
const badForm = () => { throw invalid('入力形式を確認してください。未知の項目・重複項目・不足した項目は保存できません。'); };

export function emptyValue(original) {
  const rule = resolveRule(original);
  if (rule.oneOf) return null;
  if (rule.type === 'object') return Object.fromEntries(Object.entries(rule.properties).map(([key, child]) => [key, key === 'verification' ? 'unverified' : emptyValue(child)]));
  if (rule.type === 'array') return [];
  if ('const' in rule) return rule.const;
  if (rule.enum) return rule.enum[0];
  return '';
}

export function newOfferInput() {
  return { ...Object.fromEntries(Object.entries(businessProperties).map(([key, rule]) => [key, emptyValue(rule)])),
    disclosure: { required: true, text: '広告：この記事にはアフィリエイトリンクが含まれます。', placements: ['bodyStart'] } };
}

export function parseOfferForm(form, editing = false) {
  const tree = Object.create(null);
  for (const [name, value] of form) {
    const parts = name.split('.');
    if (parts.length > 14 || parts.some(part => !/^(?:[A-Za-z][A-Za-z0-9]*|__array|__present|\d{1,6})$/.test(part))) badForm();
    let node = tree;
    for (const part of parts.slice(0, -1)) {
      if (Object.hasOwn(node, part) && typeof node[part] !== 'object') badForm();
      node = node[part] ??= Object.create(null);
    }
    const key = parts.at(-1);
    if (Object.hasOwn(node, key)) badForm();
    node[key] = value;
  }
  if (Object.keys(tree).some(key => !['offer', 'id', 'timeZone', ...(editing ? ['revision'] : [])].includes(key)) || typeof tree.id !== 'string') badForm();
  if (tree.timeZone !== undefined && tree.timeZone !== 'Asia/Tokyo') badForm();
  function decode(original, node) {
    const rule = resolveRule(original);
    if (rule.oneOf) {
      const child = resolveRule(rule.oneOf.find(item => item.type !== 'null'));
      if (child.type === 'object') {
        if (!node || !['null', 'value'].includes(node.__present)) badForm();
        const { __present, ...rest } = node;
        const decoded = decode(child, rest); // null選択でも未知項目は拒否。
        return __present === 'null' ? null : decoded;
      }
      if (node === '') return null;
      return decode(child, node);
    }
    if (rule.type === 'object') {
      if (!node || typeof node !== 'object' || Object.keys(node).some(key => !Object.hasOwn(rule.properties, key))) badForm();
      return Object.fromEntries(Object.entries(rule.properties).map(([key, child]) => [key, decode(child, node[key])]));
    }
    if (rule.type === 'array') {
      if (!node || typeof node !== 'object' || node.__array !== '1') badForm();
      const keys = Object.keys(node).filter(key => key !== '__array');
      if (keys.length > rule.maxItems || keys.some(key => !/^(0|[1-9]\d{0,5})$/.test(key))) badForm();
      return keys.sort((a, b) => Number(a) - Number(b)).map(key => decode(rule.items, node[key]));
    }
    if (typeof node !== 'string') badForm();
    if (rule.format === 'date-time' && tree.timeZone === 'Asia/Tokyo') return fromJapanInput(node);
    if (typeof rule.const === 'boolean') { if (!['true', 'false'].includes(node)) badForm(); return node === 'true'; }
    if (rule.type === 'number' || rule.type === 'integer') {
      if (node === '') return null; // 未入力はStep 1で拒否。未使用の任意オブジェクト内だけ許容。
      if (!/^-?\d+(?:\.\d+)?$/.test(node)) badForm();
      return Number(node);
    }
    return node;
  }
  if (editing && !/^[1-9]\d*$/.test(tree.revision || '')) badForm();
  return { id: tree.id, revision: editing ? Number(tree.revision) : undefined,
    input: decode({ type: 'object', properties: businessProperties }, tree.offer) };
}
