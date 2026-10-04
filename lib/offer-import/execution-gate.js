import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { createExecutionStore } from './execution-store.js';
import { digest, safetyError } from '../ai/safety-storage.js';

// Legacy imports have no execution association. New imports wait for a matched execution result.
export function createExecutionGate(root, store = createExecutionStore(root)) {
  return async (importId, firstRevision) => {
    try {
      try {
        await lstat(path.join(root, 'ai-budget', 'initialized'));
        await lstat(path.join(root, 'extraction-executions', 'initialized'));
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        try { await lstat(path.join(root, 'ai-budget', 'initialized')); throw safetyError(); }
        catch (missing) { if (missing.code !== 'ENOENT') throw missing; }
      }
      const ledger = await store.read();
      const related = ledger.executions.map(e => e.revisions.at(-1)).filter(r => r.plannedImport?.id === importId);
      const first = related.length && typeof firstRevision === 'function' ? await firstRevision() : firstRevision;
      if (related.length > 1 || related.some(r => r.state !== 'succeeded' || r.savedImport?.hash !== digest(first))) throw safetyError('execution_unresolved', 409);
    } catch (e) { throw safetyError(e.code === 'execution_unresolved' ? 'execution_unresolved' : 'execution_unreadable', e.code === 'execution_unresolved' ? 409 : 503); }
  };
}
