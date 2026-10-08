import { isDeepStrictEqual } from 'node:util';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateOfferId } from '../offers/validation.js';
import { reflectionError, reflectionHash, exactReflection } from './projection.js';
import { validateReflectionV2Choice } from './reflection-v2-policy.js';
import { regular } from '../maintenance/snapshot.js';

export const mappingDraftDirectory = 'reflection-mapping-drafts';
export const mappingDraftPolicyVersion = 1;
export const mappingDraftBinding = (draft, offer) => ({ importRevision: draft.revision, offerRevision: offer.revision,
  importHash: reflectionHash(draft), offerHash: reflectionHash(offer), policyVersion: mappingDraftPolicyVersion });
export function mappingDraftMatches(record, draft, offer) {
  return record.importId === draft.id && record.offerId === offer.id && isDeepStrictEqual(record.binding, mappingDraftBinding(draft, offer));
}
export function validateMappingDraftHistory(value, importId, offerId, imports, offers) {
  exactReflection(value, ['schemaVersion', 'revisions']);
  if (value.schemaVersion !== 1 || !Array.isArray(value.revisions) || !value.revisions.length || value.revisions.length > 1000) throw reflectionError(503);
  for (const [i, r] of value.revisions.entries()) {
    exactReflection(r, ['schemaVersion', 'revision', 'importId', 'offerId', 'binding', 'savedAt', 'choices']);
    exactReflection(r.binding, ['importRevision', 'offerRevision', 'importHash', 'offerHash', 'policyVersion']);
    const draft = imports[r.binding.importRevision - 1], offer = offers[r.binding.offerRevision - 1];
    if (r.schemaVersion !== 1 || r.revision !== i + 1 || r.importId !== importId || r.offerId !== offerId
      || !draft || !offer || !mappingDraftMatches(r, draft, offer) || !Number.isFinite(Date.parse(r.savedAt))
      || new Date(r.savedAt).toISOString() !== r.savedAt || (i && Date.parse(r.savedAt) < Date.parse(value.revisions[i - 1].savedAt))
      || !Array.isArray(r.choices) || r.choices.length !== draft.candidates.length || r.choices.reduce((n, c) => n + (Array.isArray(c?.conversionIds) ? c.conversionIds.length : 1001), 0) > 1000) throw reflectionError(503);
    for (const [index, choice] of r.choices.entries()) {
      if (choice.candidateId !== draft.candidates[index].id) throw reflectionError(503);
      validateReflectionV2Choice(choice, draft.candidates[index], draft, offer, true);
    }
  }
  return structuredClone(value.revisions);
}
export function mappingDraftProgress(record, draft, offer) {
  const complete = record.choices.filter((c, i) => validateReflectionV2Choice(c, draft.candidates[i], draft, offer, true)).length;
  return { complete, incomplete: draft.candidates.length - complete };
}
export function createMappingDraftStore({ dataDirectory, importStore, offerStore, now = () => new Date(), fileSystem = fs }) {
  const directory = path.join(dataDirectory, mappingDraftDirectory);
  const filename = (importId, offerId) => path.join(directory, `${validateOfferId(importId)}--${validateOfferId(offerId)}.json`);
  async function history(importId, offerId) {
    const file = filename(importId, offerId);
    try {
      await regular(fileSystem, directory, true);
      const stat = await regular(fileSystem, file); if (stat.size > 16 * 1024 * 1024) throw reflectionError(503);
      const value = JSON.parse(await fileSystem.readFile(file, 'utf8'));
      return validateMappingDraftHistory(value, importId, offerId, await importStore.history(importId), await offerStore.history(offerId));
    } catch (e) { if (e.code === 'ENOENT') return []; throw reflectionError(503); }
  }
  async function get(importId, offerId) { return (await history(importId, offerId)).at(-1) || null; }
  async function save(importId, offerId, expectedRevision, binding, choices) {
    filename(importId, offerId); // Validate IDs before touching the filesystem.
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw reflectionError(400);
    const owned = [];
    try {
      await regular(fileSystem, dataDirectory, true);
      await fileSystem.mkdir(directory, { recursive: true, mode: 0o700 }); await regular(fileSystem, directory, true);
      // Same relative global order as backup and reflection; never remove somebody else's lock.
      for (const dir of [mappingDraftDirectory, 'offer-import-commits', 'offer-imports', 'offers']) {
        try { await regular(fileSystem, path.join(dataDirectory, dir), true); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
        try { await fileSystem.mkdir(path.join(dataDirectory, dir, '.lock'), { mode: 0o700 }); }
        catch (e) { throw reflectionError(e.code === 'EEXIST' ? 409 : 503); }
        owned.push(dir);
      }
      const prior = await history(importId, offerId);
      if ((prior.at(-1)?.revision || 0) !== expectedRevision) throw reflectionError(409);
      const draft = await importStore.get(importId), offer = await offerStore.get(offerId);
      const record = { schemaVersion: 1, revision: expectedRevision + 1, importId, offerId, binding: structuredClone(binding), savedAt: now().toISOString(), choices: structuredClone(choices) };
      if (!mappingDraftMatches(record, draft, offer) || (prior.length && !mappingDraftMatches(prior.at(-1), draft, offer))) throw reflectionError(409);
      if (draft.targetOffer && draft.targetOffer.id !== offer.id) throw reflectionError(400);
      if (!Array.isArray(choices) || choices.length !== draft.candidates.length || choices.reduce((n, c) => n + (Array.isArray(c?.conversionIds) ? c.conversionIds.length : 1001), 0) > 1000) throw reflectionError(400);
      for (const [i, choice] of choices.entries()) {
        if (choice.candidateId !== draft.candidates[i].id) throw reflectionError(400);
        validateReflectionV2Choice(choice, draft.candidates[i], draft, offer, true);
      }
      const value = { schemaVersion: 1, revisions: [...prior, record] };
      validateMappingDraftHistory(value, importId, offerId, await importStore.history(importId), await offerStore.history(offerId));
      const bytes = JSON.stringify(value, null, 2) + '\n'; if (Buffer.byteLength(bytes) > 16 * 1024 * 1024) throw reflectionError(413);
      const temp = path.join(directory, `${randomUUID()}.tmp`);
      try {
        await fileSystem.writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
        await fileSystem.rename(temp, filename(importId, offerId));
      } catch { throw reflectionError(503); }
      finally { try { await fileSystem.unlink(temp); } catch (e) { if (e.code !== 'ENOENT') throw reflectionError(503); } }
      return record;
    } catch (e) { throw e.status ? e : reflectionError(503); }
    finally { for (const dir of owned.reverse()) { try { await fileSystem.rmdir(path.join(dataDirectory, dir, '.lock')); } catch { throw reflectionError(503); } } }
  }
  return { get, history, save };
}
