import { affiliateHumanChecks, validationFingerprint } from '../../lib/affiliate-publication.js';

export function publicationInput(draft, action = 'ready') {
  return { action, titleIndex: '0', experience: 'yes', numbers: 'yes', links: 'yes',
    ...(draft.affiliateContext ? { validationFingerprint: validationFingerprint(draft),
      ...Object.fromEntries(affiliateHumanChecks.map(([key]) => [key, 'yes'])),
      ...Object.fromEntries((draft.affiliateValidation?.findings || []).filter(f => f.severity === 'warning').map(f => [`warning.${f.id}`, 'yes'])) } : {}) };
}
