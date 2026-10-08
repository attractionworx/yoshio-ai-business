import * as fs from 'node:fs/promises';
import path from 'node:path';
import { durableWrite, directoryLock, readJson, regular, safetyError, id } from '../ai/safety-storage.js';
import { validateExecutionLedgerAny as validateExecutionLedger, transitionExecutionAny as transitionExecution, validateExecutionAny } from './execution-v5-contract.js';

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
      if (![1,4,5].includes(record.schemaVersion) || record.schemaVersion >= 4 && record.upgrade) throw safetyError('reanalysis_dedicated_only', 409);
      return locked(async () => {
        // An empty freshly acquired directory is allowed only for its first intentional write.
        let ledger;
        const names = (await fileSystem.readdir(dir)).filter(n => n !== '.lock');
        if (!names.length) ledger = { schemaVersion: 1, executions: [] }; else ledger = await read();
        if (ledger.executions.some(e => e.revisions[0].requestHash === record.requestHash || e.revisions[0].fingerprint === record.fingerprint)) throw safetyError('duplicate_request', 409);
        ledger.executions.push({ revisions: [record] }); ledger.schemaVersion = Math.max(ledger.schemaVersion, record.schemaVersion); await persist(ledger); return structuredClone(record);
      });
    },
    async createReanalysis(record) {
      return locked(async () => {
        validateExecutionAny(record);
        if (record.schemaVersion !== 2 || record.state !== 'prepared') throw safetyError('reanalysis_dedicated_only',409);
        const ledger = await read();
        const same = ledger.executions.find(e => e.revisions[0].reanalysis?.operationId === record.reanalysis.operationId);
        if (same) {
          if (same.revisions[0].id !== record.id || same.revisions[0].reanalysis.lineageHash !== record.reanalysis.lineageHash) throw safetyError('reanalysis_conflict',409);
          return structuredClone(same.revisions.at(-1));
        }
        if (ledger.executions.some(e => e.revisions[0].reanalysis?.sourceExecutionId === record.reanalysis.sourceExecutionId)) throw safetyError('reanalysis_child_exists',409);
        // Only this explicit path changes the ledger envelope. All v1 revisions remain identical.
        const next = { schemaVersion: Math.max(2, ledger.schemaVersion), executions: [...ledger.executions, { revisions: [record] }] };
        await persist(next); return structuredClone(record);
      });
    },
    async createUpgrade(record) {
      return locked(async () => {
        validateExecutionAny(record);
        if (![3,4,5].includes(record.schemaVersion) || record.state !== 'prepared') throw safetyError('upgrade_dedicated_only', 409);
        const ledger = await read();
        const same = ledger.executions.find(e => e.revisions[0].upgrade?.operationId === record.upgrade.operationId);
        if (same) {
          if (same.revisions[0].id !== record.id || same.revisions[0].upgrade.lineageHash !== record.upgrade.lineageHash) throw safetyError('upgrade_conflict', 409);
          if (same.revisions.at(-1).state !== 'prepared') throw safetyError('upgrade_already_prepared', 409);
          return structuredClone(same.revisions.at(-1));
        }
        const next = { schemaVersion: Math.max(3, ledger.schemaVersion, record.schemaVersion), executions: [...ledger.executions, { revisions: [record] }] };
        await persist(next); return structuredClone(record);
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
