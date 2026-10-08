import { projectReflection, reflectionError, exactReflection } from './projection.js';
import { projectReflectionV2 } from './projection-v2.js';

export function reflectionVersion(options) {
  if (Object.hasOwn(options || {}, 'schemaVersion')) {
    if (options.schemaVersion !== 2) throw reflectionError(400);
    exactReflection(options, ['schemaVersion', 'offerId', 'choices']);
    return 2;
  }
  exactReflection(options, ['offerId', 'conversions']);
  return 1;
}
export function projectReflectionAny(draft, offer, options, prior = []) {
  return reflectionVersion(options) === 2 ? projectReflectionV2(draft, offer, options, prior) : projectReflection(draft, offer, options, prior);
}
export const canApproveReflection = plan => plan.schemaVersion === 2 ? plan.decisions.length > 0 : plan.mappings.length > 0;
