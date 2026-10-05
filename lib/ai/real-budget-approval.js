import { exact, digest, natural, timestamp, validHash, safetyError, regular, readJson } from './safety-storage.js';

export const realApprovalFile = 'real-approval.json';
export const realApprovalAnchor = 'real-approval-anchor.json';
const positive = n => { natural(n); if (!n) throw safetyError('invalid_real_stop', 400); };
export function validateRealApproval(r, activation) {
  exact(r, ['schemaVersion', 'revision', 'expectedRevision', 'activationHash', 'activationRevision', 'originalPolicyVersion', 'originalPolicyHash',
    'realStopMilliYen', 'approvedAt', 'approval', 'effectivePolicy', 'effectivePolicyHash', 'snapshotHash', 'recordHash']);
  if (r.schemaVersion !== 1 || r.revision !== 1 || r.expectedRevision !== 0 || r.activationRevision !== 1 || r.approval !== 'human_explicit') throw safetyError();
  positive(r.realStopMilliYen); timestamp(r.approvedAt);
  for (const k of ['activationHash', 'originalPolicyHash', 'effectivePolicyHash', 'snapshotHash', 'recordHash']) validHash(r[k]);
  const { recordHash, ...body } = r;
  if (digest(body) !== recordHash || !activation || activation.policy.realStopMilliYen !== null
      || r.activationHash !== digest(activation) || r.activationRevision !== activation.revision
      || r.originalPolicyVersion !== activation.policy.version || r.originalPolicyHash !== activation.policyHash
      || r.approvedAt < activation.activatedAt) throw safetyError('real_approval_binding');
  const expected = { ...activation.policy, version: 'limited-real-v1', realStopMilliYen: r.realStopMilliYen };
  if (digest(r.effectivePolicy) !== digest(expected) || r.effectivePolicyHash !== digest(expected)) throw safetyError('real_approval_policy');
  return structuredClone(r);
}
export function validateRealApprovalPair(record, anchor, activation) {
  if (!record && !anchor) return null;
  if (!record || !anchor) throw safetyError('real_approval_incomplete');
  exact(anchor, ['schemaVersion', 'revision', 'activationHash', 'recordHash']);
  const r = validateRealApproval(record, activation);
  if (anchor.schemaVersion !== 1 || anchor.revision !== 1 || anchor.activationHash !== r.activationHash || anchor.recordHash !== r.recordHash) throw safetyError('real_approval_anchor');
  return r;
}
export async function readRealApproval(fileSystem, directory, activation) {
  const optional = async name => {
    const file = `${directory}/${name}`;
    try { await regular(fileSystem, file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    return readJson(fileSystem, file);
  };
  return validateRealApprovalPair(await optional(realApprovalFile), await optional(realApprovalAnchor), activation);
}
