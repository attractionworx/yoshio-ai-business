import OpenAI from 'openai';

// APIキーはNodeサーバーだけで読み取ります。例外本文・キーを記録しません。
export class OpenAIProviderError extends Error {
  constructor(outcome, category = 'unknown') {
    super('OpenAI APIの処理を完了できませんでした。');
    this.outcome = outcome;
    this.category = category;
  }
}

const schema = {
  type: 'object', additionalProperties: false,
  required: ['summary', 'titles', 'readerNeeds', 'outline', 'body', 'cta', 'social'],
  properties: {
    summary: { type: 'string' }, titles: { type: 'array', items: { type: 'string' }, minItems: 5, maxItems: 5 },
    readerNeeds: { type: 'string' }, outline: { type: 'string' }, body: { type: 'string' }, cta: { type: 'string' }, social: { type: 'string' },
  },
};

export function createOpenAIProvider({ client, apiKey = process.env.OPENAI_API_KEY } = {}) {
  const ready = Boolean(client || apiKey);
  return {
    kind: 'openai', ready,
    async generate({ prompt, model, maxOutputTokens, signal }) {
      if (!ready) throw new OpenAIProviderError('not-billed', 'missing-key');
      const api = client || new OpenAI({ apiKey, maxRetries: 0, timeout: 120000 });
      try {
        const response = await api.responses.create({
          model, instructions: prompt, input: 'この企画情報をもとに、指定の7項目を作成してください。',
          text: { format: { type: 'json_schema', name: 'affiliate_content', strict: true, schema } },
          max_output_tokens: maxOutputTokens, store: false,
        }, { signal });
        if (response.status !== 'completed' || typeof response.output_text !== 'string') throw new OpenAIProviderError('unknown', 'incomplete');
        return { status: 'completed', text: response.output_text, usage: {
          inputTokens: response.usage?.input_tokens, outputTokens: response.usage?.output_tokens,
        } };
      } catch (error) {
        if (error instanceof OpenAIProviderError) throw error;
        const status = Number(error?.status);
        // Auth / malformed request / rate limit / server error may be rejected before billing.
        // Network loss and timeout are ambiguous, so retain the reservation.
        if (status === 401 || status === 403 || status === 400 || status === 429) throw new OpenAIProviderError('not-billed', 'request-rejected');
        throw new OpenAIProviderError('unknown', error?.name === 'APIConnectionTimeoutError' ? 'timeout' : 'connection');
      }
    },
  };
}
