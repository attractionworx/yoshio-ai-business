import { reanalysisFixture } from './extraction-reanalysis.js';
import { createExtractionService, fakeExtractionConfig, extractionPrompt } from '../../lib/offer-import/extraction-service.js';
import { bytesHash } from '../../lib/ai/safety-storage.js';

export const upgradeInstructions = extractionPrompt + '架空の設定変更テスト。分類の組合せを維持してください。';
export const upgradeConfig = Object.freeze({ ...fakeExtractionConfig, version: 'fictional-configuration-upgrade-v1',
  promptVersion: 'fictional-instructions-v2', promptHash: bytesHash(upgradeInstructions),
  maxInputTokens: 131072, inputMilliYenPerMillion: 2000, outputMilliYenPerMillion: 2000 });
// No SDK or OpenAI provider. Every store and activation belongs to an OS-temp fixture.
export async function upgradeFixture(t, options = {}) {
  const c = await reanalysisFixture(t, options);
  const upgradeCalls = [];
  const provider = { kind: 'fake', async extract(args) { upgradeCalls.push(structuredClone(args)); return c.provider.extract(args); } };
  const reopen = extra => createExtractionService({ ...c.options, provider, config: upgradeConfig,
    simulationInstructions: upgradeInstructions, ...extra });
  const service = reopen();
  const prepareChild = async (s = service, source = c.source) => {
    const preview = await s.upgradePreview(source.id);
    return s.prepareUpgrade(source.id, preview.token, { confirm: true });
  };
  return { ...c, provider, upgradeCalls, oldService: c.service, service, reopen, prepareChild };
}
