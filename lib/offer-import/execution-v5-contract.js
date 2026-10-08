import { isDeepStrictEqual } from 'node:util';
import { validateExecutionAny as validateV4, validateExecutionLedgerAny as ledgerV4, transitionExecutionAny as transitionV4, sendBindingHash as bindingV4 } from './execution-v4-contract.js';
import { parentLink } from './execution-v3-contract.js';
import { validateProfileSnapshot } from '../ai/extraction-profile-registry.js';
import { assertProcessingContract, makeResultBinding } from './evidence-resolution-v2.js';
import { digest, exact, safetyError, id, natural, validHash, timestamp } from '../ai/safety-storage.js';
function base(r) {
  if (r.schemaVersion !== 5) return structuredClone(r);
  const { processingContract, resultBinding, profileSnapshot, upgrade, ...b } = structuredClone(r);
  b.schemaVersion = 1;
  if (b.approval) delete b.approval.bindingHash;
  return b;
}
export function sendBindingHash(r) {
  if (r.schemaVersion !== 5) return bindingV4(r);
  return digest({ id:r.id,preparedRevision:1,requestHash:r.requestHash,targetOffer:r.targetOffer,inputArtifact:r.inputArtifact,
    configuration:r.configuration,profileSnapshotHash:digest(r.profileSnapshot),processingContractHash:digest(r.processingContract),
    estimate:r.estimate,lineageHash:r.upgrade?.lineageHash || null });
}
export function validateExecutionAny(r) {
  if (r.schemaVersion !== 5) return validateV4(r);
  exact(r,[...Object.keys(base(r)), 'profileSnapshot','processingContract','resultBinding', 'upgrade']);
  validateV4(base(r)); assertProcessingContract(r.processingContract);
  if (r.profileSnapshot.schemaVersion !== 3) throw safetyError('historical_profile_invalid');
  validateProfileSnapshot(r.profileSnapshot,r);
  if (!isDeepStrictEqual(r.profileSnapshot.profile.processingContract,r.processingContract)) throw safetyError('processing_contract_invalid');
  if (r.approval) { exact(r.approval,['at','hash','revision','bindingHash']); if(r.approval.bindingHash!==sendBindingHash(r))throw safetyError('approval_binding_invalid'); }
  if (r.upgrade !== null) {
    const link=r.upgrade;exact(link,['kind','sourceExecutionId','sourceRevision','sourceHash','sourceConfigurationHash','sourceRequestHash','destinationConfigurationHash','destinationRequestHash','reasonCode','operationId','preparationApproval','lineageHash']);
    id(link.sourceExecutionId); id(link.operationId); natural(link.sourceRevision);
    if (!link.sourceRevision || link.sourceExecutionId === r.id || link.kind !== 'configuration_upgrade_reextraction' || link.reasonCode !== 'configuration_change_validation_investigation') throw safetyError('upgrade_lineage_invalid');
    for (const k of ['sourceHash','sourceConfigurationHash','sourceRequestHash','destinationConfigurationHash','destinationRequestHash','lineageHash']) validHash(link[k]);
    exact(link.preparationApproval,['at','kind']); timestamp(link.preparationApproval.at);
    if (link.preparationApproval.kind !== 'human_explicit' || link.preparationApproval.at !== r.createdAt) throw safetyError('upgrade_lineage_invalid');
    const {lineageHash,...fields}=link;
    if (digest(fields)!==lineageHash || link.destinationConfigurationHash!==r.configuration.hash || link.destinationRequestHash!==r.requestHash || link.sourceConfigurationHash===link.destinationConfigurationHash) throw safetyError('upgrade_lineage_invalid');
  }
  if (r.resultBinding !== null) {
    if (!r.validatedArtifact || !r.responseHash || !isDeepStrictEqual(r.resultBinding,makeResultBinding(r,r.validatedArtifact))) throw safetyError('result_binding_invalid');
  } else if(r.validatedArtifact)throw safetyError('result_binding_invalid');
  return structuredClone(r);
}
export function transitionExecutionAny(previous,revision,state,patch,at) {
  if (previous.schemaVersion!==5) return transitionV4(previous,revision,state,patch,at);
  validateExecutionAny(previous);
  if(Object.keys(patch).some(k=>['schemaVersion','processingContract','profileSnapshot','upgrade'].includes(k)))throw safetyError('invalid_transition',409);
  if(Object.hasOwn(patch,'resultBinding') && (previous.resultBinding!==null || state!=='validated'))throw safetyError('invalid_transition',409);
  const {resultBinding,...clean}=structuredClone(patch);
  if(clean.approval)delete clean.approval.bindingHash;
  const next=transitionV4(base(previous),revision,state,clean,at);
  return validateExecutionAny({...next,schemaVersion:5,profileSnapshot:previous.profileSnapshot,processingContract:previous.processingContract,
    upgrade:previous.upgrade,resultBinding:Object.hasOwn(patch,'resultBinding')?resultBinding:previous.resultBinding,
    approval:patch.approval||previous.approval});
}
export function validateExecutionLedgerAny(ledger) {
  if(ledger.schemaVersion!==5)return ledgerV4(ledger);
  exact(ledger,['schemaVersion','executions']);if(!Array.isArray(ledger.executions))throw safetyError();
  const originals=new Map();
  for(const entry of ledger.executions) {
    exact(entry,['revisions']);if(!Array.isArray(entry.revisions)||!entry.revisions.length)throw safetyError();
    for(let i=0;i<entry.revisions.length;i++) {
      const r=validateExecutionAny(entry.revisions[i]);
      if(i){const p=entry.revisions[i-1];
        for(const k of ['schemaVersion','processingContract','profileSnapshot','upgrade'])if(!isDeepStrictEqual(r[k],entry.revisions[0][k]))throw safetyError();
        const fields=['approval','startedAt','endedAt','attempt','responseHash','validatedArtifact','plannedImport','savedImport','error','unknownReason','recoveryRequired','budget',...(r.schemaVersion===5?['resultBinding']:[])];
        const patch=Object.fromEntries(fields.filter(k=>!isDeepStrictEqual(p[k],r[k])).map(k=>[k,r[k]]));
        if(!isDeepStrictEqual(transitionExecutionAny(p,p.revision,r.state,patch,r.updatedAt),r))throw safetyError();
      }
    }
    const first=entry.revisions[0],link=parentLink(first);
    if(link){const source=originals.get(link.sourceExecutionId);if(!source||digest(source)!==link.sourceHash)throw safetyError('upgrade_lineage_invalid');}
    originals.set(first.id,entry.revisions.at(-1));
  }
  validateGraph(ledger);
  // Legacy records retain their actual validation path. Base histories validate v1 state/immutability.
  for(const entry of ledger.executions) validateLegacyEntry(entry);
  return structuredClone(ledger);
}
import {validateExecutionLedger as ledgerV1} from './execution-contract.js';
import {eligibleReanalysisSource} from './execution-v2-contract.js';
import {eligibleUpgradeSource} from './execution-v3-contract.js';
function validateLegacyEntry(entry){ledgerV1({schemaVersion:1,executions:[{revisions:entry.revisions.map(r=>{const {upgrade,profileSnapshot,reanalysis,processingContract,resultBinding,...b}=structuredClone(r);b.schemaVersion=1;if(b.approval)delete b.approval.bindingHash;return b;})}]});}
function validateGraph(ledger) {
  const seen=new Map(),operations=new Set(),sources=new Set();
  for(const entry of ledger.executions){const first=entry.revisions[0],link=parentLink(first);
    if(seen.has(first.id))throw safetyError('duplicate_request');
    if(!link){if([...seen.values()].some(s=>s.fingerprint===first.fingerprint||s.requestHash===first.requestHash))throw safetyError('duplicate_request');}
    else{
      const source=seen.get(link.sourceExecutionId);if(!source||sources.has(source.id)||operations.has(link.operationId)||digest(source)!==link.sourceHash||source.revision!==link.sourceRevision||first.createdAt<source.updatedAt||first.inputArtifact.id===source.inputArtifact.id||first.inputArtifact.hash!==source.inputArtifact.hash||first.fingerprint!==source.fingerprint||!isDeepStrictEqual(first.targetOffer,source.targetOffer)||!isDeepStrictEqual(first.documents,source.documents)||first.provider!==source.provider)throw safetyError('lineage_invalid');
      if(first.upgrade)eligibleUpgradeSource(source);else eligibleReanalysisSource(source);
      if(first.upgrade){
        if(link.kind!=='configuration_upgrade_reextraction'||link.reasonCode!=='configuration_change_validation_investigation'||link.sourceConfigurationHash!==source.configuration.hash||link.sourceRequestHash!==source.requestHash||link.destinationConfigurationHash!==first.configuration.hash||link.destinationRequestHash!==first.requestHash||link.preparationApproval?.kind!=='human_explicit'||link.preparationApproval.at!==first.createdAt)throw safetyError('upgrade_lineage_invalid');
        for(let p=source;p;p=parentLink(p)?seen.get(parentLink(p).sourceExecutionId):null)if(p.configuration.hash===first.configuration.hash)throw safetyError('upgrade_configuration_repeated');
      }else if(!isDeepStrictEqual(first.configuration,source.configuration)||!isDeepStrictEqual(first.estimate,source.estimate)||first.requestHash!==source.requestHash||first.model!==source.model)throw safetyError('lineage_invalid');
      operations.add(link.operationId);sources.add(source.id);
    }
    seen.set(first.id,entry.revisions.at(-1));
  }
}
