// APIキー・環境変数は一切参照しません。実Provider・実モデルの登録口は未実装。
export const fakeConfig = Object.freeze({
  profile: 'economy', provider: 'fake', model: 'fake-paper-v1', pricingVersion: 'simulation-v1',
  monthlyBudgetYen: 1000, warningYen: 800, stopYen: 900, perRunYen: 20,
  reservationYen: 10, maxInputTokens: 4000, maxOutputTokens: 6000,
  inputYenPerMillion: 1000, outputYenPerMillion: 1000,
  timeoutMs: 5000, maxConcurrent: 1, retries: 0,
});
// サーバー側だけで選択するOpenAI設定。ブラウザ入力からは変更できません。
export const openaiConfig = Object.freeze({
  profile: 'economy', provider: 'openai', model: 'gpt-6-luna', pricingVersion: 'openai-gpt-6-luna-2026-09',
  monthlyBudgetYen: 1000, warningYen: 800, stopYen: 900, perRunYen: 20,
  reservationYen: 2, maxInputTokens: 20000, maxOutputTokens: 6000,
  // 概算用の仮置き単価（円/100万tokens）。価格・為替を確認して更新します。
  inputYenPerMillion: 20, outputYenPerMillion: 100,
  timeoutMs: 120000, maxConcurrent: 1, retries: 0,
});
export function resolveConfig(overrides = {}) {
  const provider = overrides.provider || 'fake';
  const base = provider === 'openai' ? openaiConfig : fakeConfig;
  const value = { ...base, ...overrides };
  if (value.profile !== 'economy' || !((value.provider === 'fake' && value.model === 'fake-paper-v1') || (value.provider === 'openai' && value.model === 'gpt-6-luna')) || value.maxConcurrent !== 1 || value.retries !== 0) throw new Error('利用できないAI設定です。');
  for (const key of ['monthlyBudgetYen', 'warningYen', 'stopYen', 'perRunYen', 'reservationYen', 'maxInputTokens', 'maxOutputTokens', 'inputYenPerMillion', 'outputYenPerMillion', 'timeoutMs']) {
    if (!Number.isFinite(value[key]) || value[key] <= 0) throw new Error('生成制限の設定が不正です。');
  }
  if (value.warningYen > value.stopYen || value.stopYen > value.monthlyBudgetYen) throw new Error('予算設定が不正です。');
  return Object.freeze(value);
}
