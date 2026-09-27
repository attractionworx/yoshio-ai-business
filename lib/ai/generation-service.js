import { createHmac, randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { invalid } from '../content.js';
import { validateGeneration, validationMessages } from './generation-validation.js';
import { createFakeProvider, FakeProviderError } from './fake-provider.js';
import { OpenAIProviderError } from './openai-provider.js';
import { resolveConfig } from './config.js';
import { buildGenerationPrompt, buildOpenAIPrompt, generationPromptVersion } from './generation-prompt.js';
import { createGenerationStore } from './generation-store.js';
import { summarizeUsage, checkBudget, readUsage, estimateYen, monthKey } from './usage-budget.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safePlan = plan => Object.fromEntries(['id', 'createdAt', 'theme', 'audience', 'medium', 'purpose', 'notes'].map(k => [k, plan[k]]));
const validId = id => /^[a-f0-9-]{36}$/.test(id);

export function createGenerationService({ dataDirectory, draftStore, provider = createFakeProvider(), config: settings = {}, now = () => new Date(), store = createGenerationStore(dataDirectory) }) {
  const config = resolveConfig(settings);
  if (!['fake', 'openai'].includes(provider.kind) || provider.kind !== config.provider) throw new Error('AI Provider設定が一致しません。');
  const secret = randomBytes(32); // APIキーではない、確認画面の改ざん防止用メモリ内秘密値。
  const sign = payload => createHmac('sha256', secret).update(payload).digest('hex');
  async function summary() { return summarizeUsage((await store.read()).runs, now(), config); }
  function confirmation(plan) {
    const payload = Buffer.from(JSON.stringify({ id: randomUUID(), planId: plan.id, planHash: hash(safePlan(plan)), configHash: hash(config), expires: now().getTime() + 15 * 60_000 })).toString('base64url');
    return `${payload}.${sign(payload)}`;
  }
  function verify(token, plan) {
    const [payload, signature, extra] = String(token || '').split('.');
    if (!payload || !/^[a-f0-9]{64}$/.test(signature || '') || extra || payload.length > 2000 || !timingSafeEqual(Buffer.from(signature), Buffer.from(sign(payload)))) throw invalid('生成前確認が無効です。企画から開き直してください。');
    let value;
    try { value = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { throw invalid('生成前確認が無効です。'); }
    if (!validId(value.id) || value.planId !== plan.id || value.planHash !== hash(safePlan(plan)) || value.configHash !== hash(config)) throw invalid('企画または設定が変わりました。生成前確認を開き直してください。', 409);
    return value;
  }
  async function get(id) {
    if (!validId(id)) throw invalid('生成記録が見つかりません。', 404);
    const run = (await store.read()).runs.find(r => r.id === id);
    if (!run) throw invalid('生成記録が見つかりません。', 404);
    return run;
  }
  async function update(id, change) { return store.transaction(ledger => { const run = ledger.runs.find(r => r.id === id); change(run); run.updatedAt = now().toISOString(); return run; }); }
  async function saveValidated(run) {
    try {
      const content = validateGeneration({ status: 'completed', text: run.raw });
      if (JSON.stringify(content) !== JSON.stringify(run.content)) throw new Error('staged-content-mismatch');
      const metadata = { provider: run.provider, model: run.model, profile: run.profile, executionId: run.id,
        promptVersion: generationPromptVersion, pricingVersion: run.pricingVersion, usage: run.usage, estimatedYen: run.estimatedYen, simulation: run.simulation };
      const draft = await draftStore.create(run.planSnapshot, { content: run.content, generatedAt: run.generatedAt }, run.raw, run.provider === 'openai' ? run.prompt : buildGenerationPrompt(), null, metadata);
      return await update(run.id, r => { r.state = 'succeeded'; r.draftId = draft.id; delete r.content; delete r.raw; delete r.planSnapshot; delete r.prompt; r.message = `${r.provider === 'fake' ? 'Fake AI' : 'OpenAI API'}の新規下書きを未確認で保存しました。`; });
    } catch {
      return update(run.id, r => { if (r.state === 'succeeded') return; r.state = 'save-failed'; r.message = '下書きの保存に失敗しました。生成は再実行しません。保存のみ再試行できます。'; });
    }
  }
  async function execute(plan, token) {
    const checked = verify(token, plan);
    const reserved = await store.transaction(ledger => {
      const existing = ledger.runs.find(r => r.id === checked.id);
      if (existing) return { existing: true, run: existing };
      if (now().getTime() > checked.expires) throw invalid('生成前確認の期限が切れました。開き直してください。');
      if (ledger.runs.some(r => ['running', 'unknown', 'validated'].includes(r.state))) throw invalid('生成中または結果不明の実行があります。新しい生成は停止しています。', 409);
      checkBudget(summarizeUsage(ledger.runs, now(), config), config);
      const run = { id: checked.id, planId: plan.id, planSnapshot: safePlan(plan), state: 'running', month: monthKey(now()), createdAt: now().toISOString(), updatedAt: now().toISOString(),
        provider: config.provider, model: config.model, profile: config.profile, pricingVersion: config.pricingVersion, simulation: config.provider === 'fake',
        reservedYen: config.reservationYen, estimatedYen: 0, usage: null, attempted: true, message: '生成中です。再起動などで中断した場合は結果不明として予約を保持します。' };
      ledger.runs.push(run);
      return { existing: false, run };
    });
    if (reserved.existing) return reserved.run;
    const run = reserved.run;
    let timer;
    const controller = new AbortController();
    let response;
    let timedOut = false;
    const prompt = config.provider === 'openai' ? buildOpenAIPrompt(plan) : buildGenerationPrompt();
    try {
      // Providerには識別子・保存状態・APIキーを渡さず、指示と企画内容だけを渡します。
      response = await Promise.race([
        Promise.resolve().then(() => provider.generate({ prompt, model: config.model, maxOutputTokens: config.maxOutputTokens, signal: controller.signal })),
        new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new FakeProviderError('unknown')); }, config.timeoutMs); }),
      ]);
    } catch (error) {
      const definite = (error instanceof FakeProviderError || error instanceof OpenAIProviderError) && error.outcome === 'not-billed';
      return await update(run.id, r => { r.state = definite ? 'failed' : 'unknown'; if (definite) r.reservedYen = 0; delete r.planSnapshot;
        r.message = definite ? (config.provider === 'fake' ? 'Fake Providerが失敗しました。下書きは作成していません。' : 'OpenAI APIが要求を受け付けませんでした。下書きは作成していません。APIキーや利用上限を確認してください。')
          : config.provider === 'openai' ? `${timedOut || error?.category === 'timeout' ? '生成が時間切れになりました。' : error?.category === 'connection' ? 'OpenAI APIへ接続できませんでした。' : '生成結果を確認できませんでした。'} 下書きは作成していません。料金が発生した可能性があるため予約を保持し、次の生成を停止しました。OpenAIの利用状況を確認してください。`
            : '結果を確認できませんでした。下書きは作成せず予約を保持し、新しい生成を停止しています。実行履歴と利用状況を確認してください。'; });
    } finally { clearTimeout(timer); }
    const usage = readUsage(response?.usage, config);
    if (!usage) return update(run.id, r => { r.state = 'unknown'; delete r.planSnapshot; r.message = '使用量が不明または上限外のため予約を保持します。下書きは作成していません。'; });
    let content;
    try {
      content = validateGeneration(response);
    } catch (error) {
      const validationCode = typeof error?.validationCode === 'string' ? error.validationCode : 'unknown-validation';
      return update(run.id, r => { r.state = 'failed'; r.usage = usage; r.estimatedYen = estimateYen(usage, config); r.reservedYen = 0; delete r.planSnapshot;
        r.validationCode = validationCode;
        const diagnostic = validationMessages[validationCode] || 'その他の検証';
        r.message = `生成結果の検証に失敗しました（${diagnostic}）。下書きは作成していません。${config.provider === 'fake' ? '模擬' : '概算'}使用量を記録しました。`; });
    }
    const validated = await update(run.id, r => { r.state = 'validated'; r.usage = usage; r.estimatedYen = estimateYen(usage, config); r.reservedYen = 0; r.content = content; r.raw = response.text; r.prompt = prompt; r.generatedAt = now().toISOString(); });
    return saveValidated(validated);
  }
  async function retrySave(id) {
    const run = await get(id);
    if (!['save-failed', 'validated'].includes(run.state)) return run;
    return saveValidated(run); // 外部生成は呼ばない。Draft store側もexecutionIdで冪等。
  }
  const actionToken = id => sign(`save:${id}`);
  function verifyAction(id, token) {
    if (!/^[a-f0-9]{64}$/.test(token || '') || !timingSafeEqual(Buffer.from(token), Buffer.from(actionToken(id)))) throw invalid('保存確認が無効です。画面を開き直してください。');
  }
  async function recent(planId) { return (await store.read()).runs.filter(r => r.planId === planId).slice(-10).reverse(); }
  return { config, confirmation, summary, execute, get, retrySave, actionToken, verifyAction, recent };
}
