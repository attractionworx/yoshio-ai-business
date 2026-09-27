import { factRule } from '../fact-policy.js';
export const generationPromptVersion = 'direct-fake-v1';
export function buildGenerationPrompt() {
  return `日本語の7項目（summary、titles、readerNeeds、outline、body、cta、social）をJSONで作成してください。タイトルは5候補です。\n${factRule}\nこれは架空の紙工作の検証です。対象の実企画・ID・ファイルは参照せず、固定の架空資料「色紙で森を想像する」を使用してください。`;
}
