import OpenAI from 'openai';
import { extractionProfile, assertExtractionProfile, profileConfiguration } from './extraction-profile.js';
import { buildExtractionPayload, fixedJSON, estimateExtractionInput } from './extraction-payload.js';
import { digest, safetyError } from './safety-storage.js';

// No environment lookup. Credentials are supplied only by the server at explicit runtime startup.
export function createOpenAIExtractionProvider({ client, apiKey } = {}) {
  const ready = Boolean(client || apiKey);
  return Object.freeze({ kind: 'openai', ready, profileDigest: digest(extractionProfile),
    async extract({ input, configuration, payload, signal }) {
      assertExtractionProfile();
      const expected = profileConfiguration();
      if (digest(configuration) !== digest({ ...expected, hash: digest(expected) })) throw safetyError('configuration_conflict', 409);
      const request = buildExtractionPayload(input, extractionProfile);
      if (fixedJSON(request) !== fixedJSON(payload) || estimateExtractionInput(request, extractionProfile).inputTokens > extractionProfile.maxInputTokens) throw safetyError('payload_conflict', 409);
      if (!ready) throw safetyError('provider_unavailable', 409);
      const api = client || new OpenAI({ apiKey, maxRetries: 0, timeout: extractionProfile.timeoutMs });
      let response;
      try {
        response = await api.responses.create(request, { signal, maxRetries: 0, timeout: extractionProfile.timeoutMs });
      } catch { throw safetyError('request_result_unknown'); }
      if (response?.service_tier !== undefined && response.service_tier !== 'default') return { extraction: null, usage: null };
      const usage = { inputTokens: response?.usage?.input_tokens, outputTokens: response?.usage?.output_tokens };
      // Preserve known usage even for incomplete/refused/invalid JSON. The service books before validation.
      let extraction = null;
      if (response?.status === 'completed' && typeof response.output_text === 'string'
          && (response.service_tier === undefined || response.service_tier === 'default')) {
        try { extraction = JSON.parse(response.output_text); } catch { /* no raw text retained or logged */ }
      }
      return { extraction, usage };
    },
  });
}
