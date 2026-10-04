import { createBudgetCoordinator } from '../../lib/ai/budget-coordinator.js';
// Temporary fixture policy only. The real bucket is for mocked legacy OpenAI records, never real billing.
export const fixtureBudgetPolicy = Object.freeze({ schemaVersion: 1, version: 'fictional-fixture-v1', realStopMilliYen: 900000, simulationStopMilliYen: 900000 });
export async function activateFixtureBudget(root, options = {}) {
  return createBudgetCoordinator(root, options).activate(fixtureBudgetPolicy, { confirm: true, expectedRevision: 0 });
}
