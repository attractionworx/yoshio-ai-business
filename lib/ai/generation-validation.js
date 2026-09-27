import { validateContent, contentFields } from '../content.js';
import { readImportJson } from '../import-json.js';
import { hasClearFactViolation } from '../fact-policy.js';

// UIやProviderに依存しない、保存前の共通検証。補正・自動修復は行わない。
export function validateGeneration(response) {
  if (response?.status !== 'completed' || typeof response.text !== 'string' || response.text.length > 400000
      || !response.text.trim().startsWith('{') || !response.text.trim().endsWith('}')) throw new Error('invalid-response');
  const parsed = readImportJson(response.text);
  if (parsed.normalization || Object.keys(parsed.value).some(key => !contentFields.some(([k]) => k === key))) throw new Error('invalid-response');
  const content = validateContent(parsed.value);
  if (hasClearFactViolation(content)) throw new Error('fact-policy');
  return content;
}
