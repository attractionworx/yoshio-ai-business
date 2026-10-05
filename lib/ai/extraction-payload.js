// Pure deterministic builder. Every outbound request field is displayed and estimated from this object.
export function fixedJSON(value) {
  const sort = v => Array.isArray(v) ? v.map(sort) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])])) : v;
  return JSON.stringify(sort(value));
}
export function buildExtractionPayload(input, profile) {
  return JSON.parse(fixedJSON({ model: profile.model, instructions: profile.instructions, input: fixedJSON(input),
    text: { format: { type: 'json_schema', name: 'regulation_extraction_v1', strict: true, schema: profile.outputSchema } },
    max_output_tokens: profile.maxOutputTokens, store: false, service_tier: 'default', tools: [] }));
}
export function estimateExtractionInput(payload, profile) {
  const requestBytes = Buffer.byteLength(fixedJSON(payload), 'utf8');
  return { requestBytes, inputTokens: profile.estimator.byteMultiplier * requestBytes + profile.estimator.overheadTokens };
}
