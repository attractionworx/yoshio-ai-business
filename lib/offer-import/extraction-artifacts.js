import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { exact, id, timestamp, digest, natural, validHash, readJson, durableWrite, regular, safetyError, directoryLock, rejectSecrets } from '../ai/safety-storage.js';
import { validateExtraction } from './validation.js';
import { createOfferImport } from './contract.js';
import { artifactReference } from './execution-contract.js';

export const artifactLimits = Object.freeze({ inputBytes: 256 * 1024, artifactBytes: 2 * 1024 * 1024 });
export function validateArtifact(a) {
  exact(a, ['schemaVersion', 'id', 'executionId', 'type', 'createdAt', 'contentHash', 'byteSize', 'content']);
  rejectSecrets(a.content);
  if (a.schemaVersion !== 1 || !['input', 'validated_extraction'].includes(a.type)) throw safetyError();
  id(a.id); id(a.executionId); timestamp(a.createdAt); validHash(a.contentHash); natural(a.byteSize);
  if (digest(a.content) !== a.contentHash || Buffer.byteLength(JSON.stringify(a.content)) !== a.byteSize || a.byteSize > artifactLimits.artifactBytes) throw safetyError();
  if (a.type === 'input') {
    exact(a.content, ['targetOffer', 'documents']);
    createOfferImport({ id: a.executionId, createdAt: a.createdAt, ...a.content, extraction: { schemaVersion: 1, candidates: [] } });
    if (!a.content.targetOffer || a.byteSize > artifactLimits.inputBytes) throw safetyError('input_limit', 400);
  } else {
    exact(a.content, ['inputHash', 'extraction']); validHash(a.content.inputHash);
    // Full candidate/evidence validation additionally requires the corresponding immutable input.
  }
  return structuredClone(a);
}
export function createArtifactStore(root, { fileSystem = fs, now = () => new Date() } = {}) {
  const dir = path.join(root, 'extraction-artifacts'); const locked = directoryLock(root, 'extraction-artifacts', fileSystem);
  const file = artifactId => path.join(dir, `${id(artifactId)}.json`);
  return {
    async read(ref, executionId, type) {
      try {
        artifactReference(ref);
        await regular(fileSystem, dir, true);
        const a = validateArtifact(await readJson(fileSystem, file(ref.id)));
        if (a.executionId !== executionId || a.type !== type || a.contentHash !== ref.hash || a.byteSize !== ref.bytes) throw safetyError();
        return a;
      } catch { throw safetyError('artifact_unreadable'); }
    },
    async create(executionId, type, content, documents = null) {
      if (type === 'validated_extraction') validateExtraction(content.extraction, documents);
      const a = validateArtifact({ schemaVersion: 1, id: randomUUID(), executionId, type, createdAt: now().toISOString(),
        content: structuredClone(content), contentHash: digest(content), byteSize: Buffer.byteLength(JSON.stringify(content)) });
      await locked(() => durableWrite(fileSystem, file(a.id), a, true));
      return { id: a.id, hash: a.contentHash, bytes: a.byteSize };
    },
  };
}
