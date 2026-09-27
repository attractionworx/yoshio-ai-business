import { validateContent, contentFields } from '../content.js';
import { readImportJson } from '../import-json.js';
import { hasClearFactViolation } from '../fact-policy.js';

function validationError(code) {
  const error = new Error(code);
  error.validationCode = code;
  return error;
}

// UIやProviderに依存しない、保存前の共通検証。補正・自動修復は行わない。
export function validateGeneration(response) {
  if (response?.status !== 'completed' || typeof response.text !== 'string' || response.text.length > 400000
      || !response.text.trim().startsWith('{') || !response.text.trim().endsWith('}')) throw validationError('response-format');
  let parsed;
  try { parsed = readImportJson(response.text); }
  catch { throw validationError('json-parse'); }
  if (parsed.normalization) throw validationError('json-normalization');
  if (Object.keys(parsed.value).some(key => !contentFields.some(([k]) => k === key))) throw validationError('unexpected-field');
  for (const [key] of contentFields) {
    if (!(key in parsed.value)) throw validationError(key === 'titles' ? 'titles-required' : 'required-field');
    if (key === 'titles' && !Array.isArray(parsed.value[key])) throw validationError('titles-type');
    if (key === 'titles' && parsed.value[key].length !== 5) throw validationError('titles-count');
  }
  let content;
  try { content = validateContent(parsed.value); }
  catch {
    const titles = parsed.value.titles;
    if (!Array.isArray(titles) || titles.some(value => typeof value !== 'string')) throw validationError('titles-type');
    throw validationError('field-value');
  }
  if (hasClearFactViolation(content)) throw validationError('fact-policy');
  return content;
}

export const validationMessages = Object.freeze({
  'response-format': '応答形式', 'json-parse': 'JSON解析', 'json-normalization': 'JSON形式',
  'unexpected-field': '未知のフィールド', 'titles-required': 'titles必須', 'required-field': '必須項目',
  'titles-count': 'titles件数（5件必須）', 'titles-type': 'titles型',
  'field-value': 'フィールドの型・空欄・文字数', 'fact-policy': '創作禁止ルール',
});
