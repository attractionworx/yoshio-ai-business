import * as fs from 'node:fs/promises';
import path from 'node:path';
import { durableWrite, directoryLock, readJson, regular, safetyError, id } from '../ai/safety-storage.js';
import { validateExecutionLedger, transitionExecution } from './execution-contract.js';

export function createExecutionStore(root, { fileSystem = fs, now = () => new Date() } = {}) {
  const dir = path.join(root, 'extraction-executions'); const file = path.join(dir, 'ledger.json');
  const locked = directoryLock(root, 'extraction-executions', fileSystem);
  async function read() {
    try {
      await regular(fileSystem, dir, true);
      try { await fileSystem.lstat(path.join(dir, '.write-intent')); throw safetyError('persistence_uncertain'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const ledger = validateExecutionLedger(await readJson(fileSystem, file));
      if (await fileSystem.readFile(path.join(dir, 'initialized'), 'utf8') !== '1\n') throw safetyError();
      return ledger;
    } catch (e) {
      if (e.code === 'ENOENT') {
        try { await fileSystem.lstat(dir); } catch (d) { if (d.code === 'ENOENT') return { schemaVersion: 1, executions: [] }; }
      }
      throw safetyError('execution_unreadable');
    }
  }
  async function persist(ledger) {
    validateExecutionLedger(ledger);
    try { await regular(fileSystem, path.join(dir, 'initialized')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; await fileSystem.writeFile(path.join(dir, 'initialized'), '1\n', { flag: 'wx', mode: 0o600 }); }
    await durableWrite(fileSystem, file, ledger);
  }
  return {
    read,
    async initialize() {
      return locked(async () => {
        const names = (await fileSystem.readdir(dir)).filter(n => n !== '.lock');
        if (names.length) return read();
        const ledger = { schemaVersion: 1, executions: [] }; await persist(ledger); return ledger;
      });
    },
    async get(executionId) { id(executionId); const e = (await read()).executions.find(e => e.revisions[0].id === executionId); if (!e) throw safetyError('execution_missing', 404); return e.revisions.at(-1); },
    async create(record) {
      return locked(async () => {
        // An empty freshly acquired directory is allowed only for its first intentional write.
        let ledger;
        const names = (await fileSystem.readdir(dir)).filter(n => n !== '.lock');
        if (!names.length) ledger = { schemaVersion: 1, executions: [] }; else ledger = await read();
        if (ledger.executions.some(e => e.revisions[0].requestHash === record.requestHash || e.revisions[0].fingerprint === record.fingerprint)) throw safetyError('duplicate_request', 409);
        ledger.executions.push({ revisions: [record] }); await persist(ledger); return structuredClone(record);
      });
    },
    async transition(executionId, revision, state, patch) {
      return locked(async () => {
        const ledger = await read(); const entry = ledger.executions.find(e => e.revisions[0].id === id(executionId));
        if (!entry) throw safetyError('execution_missing', 404);
        const next = transitionExecution(entry.revisions.at(-1), revision, state, patch, now().toISOString());
        entry.revisions.push(next); await persist(ledger); return next;
      });
    },
  };
}
