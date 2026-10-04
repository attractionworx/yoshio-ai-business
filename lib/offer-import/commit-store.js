import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validateOfferId } from '../offers/validation.js';
import { projectReflection, reflectionHash, exactReflection, reflectionError } from './projection.js';

function stamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw reflectionError(503);
}
export function commitStates(ledger) {
  const states = new Map();
  for (const event of ledger.events) {
    if (event.type === 'intent') states.set(event.id, { intent: event, state: 'recovery_required', result: null });
    else if (event.type === 'result') Object.assign(states.get(event.commitId), { state: event.outcome, result: event });
  }
  return [...states.values()];
}
export const committedPlans = ledger => commitStates(ledger).filter(s => s.state === 'committed').map(s => s.intent.plan);

// Independent append-only audit envelope. Step 1/2 schemas and histories remain unchanged.
export function createCommitStore(dataDirectory, { fileSystem = fs } = {}) {
  const directory = path.join(dataDirectory, 'offer-import-commits');
  const file = path.join(directory, 'ledger.json');
  let pending = Promise.resolve();
  function validate(value) {
    exactReflection(value, ['schemaVersion', 'events']);
    if (value.schemaVersion !== 1 || !Array.isArray(value.events)) throw reflectionError(503);
    const seen = new Map(); const prior = [];
    for (const e of value.events) {
      if (e.type === 'intent') {
        exactReflection(e, ['type', 'id', 'at', 'previewHash', 'plan', 'importSnapshot', 'offerSnapshot', 'options']);
        validateOfferId(e.id); stamp(e.at);
        if (seen.has(e.id) || [...seen.values()].some(s => !s.result)) throw reflectionError(503);
        const plan = projectReflection(e.importSnapshot, e.offerSnapshot, e.options, prior);
        if (!plan.mappings.length || !isDeepStrictEqual(e.plan, plan) || e.previewHash !== reflectionHash(plan)) throw reflectionError(503);
        seen.set(e.id, { intent: e, result: false, recovery: false });
      } else if (e.type === 'recovery_required') {
        exactReflection(e, ['type', 'commitId', 'at']); stamp(e.at);
        const state = seen.get(e.commitId);
        if (!state || state.result || state.recovery || Date.parse(e.at) < Date.parse(state.intent.at)) throw reflectionError(503);
        state.recovery = true;
      } else if (e.type === 'result') {
        exactReflection(e, ['type', 'commitId', 'at', 'outcome', 'offerRevision', 'mode']); stamp(e.at);
        const state = seen.get(e.commitId);
        if (!state || state.result || !['committed', 'not_applied'].includes(e.outcome) || !['save', 'recovery'].includes(e.mode)
          || Date.parse(e.at) < Date.parse(state.intent.at)
          || e.offerRevision !== (e.outcome === 'committed' ? state.intent.plan.nextRevision : state.intent.plan.offerRevision)
          || (e.outcome === 'not_applied' && e.mode !== 'recovery')) throw reflectionError(503);
        state.result = true;
        if (e.outcome === 'committed') prior.push(state.intent.plan);
      } else throw reflectionError(503);
    }
    return structuredClone(value);
  }
  async function read() {
    try {
      if (!(await fileSystem.lstat(directory)).isDirectory() || !(await fileSystem.lstat(file)).isFile()) throw reflectionError(503);
      return validate(JSON.parse(await fileSystem.readFile(file, 'utf8')));
    } catch (e) {
      if (e.code === 'ENOENT') {
        try { await fileSystem.lstat(path.join(directory, 'initialized')); }
        catch (marker) { if (marker.code === 'ENOENT') return { schemaVersion: 1, events: [] }; }
      }
      throw reflectionError(503);
    }
  }
  async function save(ledger) {
    validate(ledger);
    const temp = path.join(directory, `${randomUUID()}.tmp`);
    try {
      await fileSystem.writeFile(temp, JSON.stringify(ledger, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      try {
        if (!(await fileSystem.lstat(path.join(directory, 'initialized'))).isFile()) throw reflectionError(503);
      } catch (e) { if (e.code !== 'ENOENT') throw reflectionError(503); }
      await fileSystem.writeFile(path.join(directory, 'initialized'), '1\n', { mode: 0o600 });
      await fileSystem.rename(temp, file);
    } catch { throw reflectionError(503); }
    finally { try { await fileSystem.unlink(temp); } catch (e) { if (e.code !== 'ENOENT') throw reflectionError(503); } }
  }
  function transaction(change) {
    const operation = pending.catch(() => {}).then(async () => {
      const lock = path.join(directory, '.lock');
      try {
        await fileSystem.mkdir(directory, { recursive: true, mode: 0o700 });
        if (!(await fileSystem.lstat(directory)).isDirectory()) throw reflectionError(503);
      } catch { throw reflectionError(503); }
      try { await fileSystem.mkdir(lock, { mode: 0o700 }); } catch (e) { throw reflectionError(e.code === 'EEXIST' ? 409 : 503); }
      try {
        const ledger = await read();
        return await change(ledger, async event => {
          const next = { schemaVersion: 1, events: [...ledger.events, event] };
          await save(next); ledger.events = next.events;
        });
      } finally { try { await fileSystem.rmdir(lock); } catch { throw reflectionError(503); } }
    });
    pending = operation; return operation;
  }
  return { read, transaction };
}
