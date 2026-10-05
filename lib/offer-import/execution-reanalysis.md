# Intentional reanalysis: execution v2

This contract extends the execution ledger only through explicit human preparation approval. The original `execution-contract.js` and `extraction-execution.schema.json` stay strict v1. No startup migration, retry, repair, restoration, policy update or data-directory switch is introduced.

## Entry and approvals

Normal prepare still rejects any matching target/document fingerprint or request hash, regardless of the previous outcome. Its fixed UI reason is `duplicate_request`, with a statement that this prepare did not send externally or incur API charges.

Only the detail page of an eligible source offers `/offer-extractions/:sourceId/reanalysis`. Eligibility requires `failed_after_request`, `response_received`, known usage, settled accounting, zero remaining reservation, no unknown/recovery flag, no validated artifact or planned/saved import, intact input/configuration/target revision, no child, valid activation/budget and a clean maintenance inspection. Other unresolved work, corruption, unclassified files, incomplete saves or conflicts stop the dedicated path.

The first unchecked confirmation approves preparation only. A short-lived signed token binds source ID/revision/hash, fixed reason `validation_failure_investigation`, operation ID, new execution ID, configuration hash and immutable input hash. Preparation copies the unchanged input into a new v1 artifact bound to the new execution. It does not reserve costs or invoke a provider.

The new execution's confirmation is a second unchecked approval of the full current payload, new cost reservation and shared budget. The signed sending token additionally binds lineage and the stored send-binding digest. Durable `sending` acknowledgement is required before the sole provider invocation. Preparation tokens cannot authorize sending.

## Persistence

`extraction-executions/ledger.json` uses envelope version 2 after the explicit dedicated prepare succeeds. Existing v1 revisions remain structurally identical; normal new executions remain v1 entries in the mixed envelope. New reanalysis records are version 2 with:

- `reanalysis.sourceExecutionId`, `sourceRevision`, `sourceHash` (canonical digest of the terminal source record)
- fixed `reasonCode`, server-generated `operationId`
- `preparationApproval.at` and `kind: human_explicit`
- `lineageHash` (canonical digest of all preceding lineage fields)
- `approval.bindingHash` on sending approval (ID, prepared revision, target, request hash, configuration, input artifact, estimate, lineage)

The v2 validator reuses every v1 record/history/transition rule through a strict projection, then validates immutable lineage, chronological parent references, source eligibility, unchanged configuration/estimate/materials, distinct artifact ownership, globally unique operations, one child per source, and sending binding. A failed eligible child may itself become a source; a succeeded child is not eligible. No parent record is altered.

The state machine remains `prepared → approved → sending → response_received → validated → import_saving → succeeded`, with the original failure/unknown/recovery branches. Only succeeded records link to ordinary review; pending/unverified and existing reflection/publication/active boundaries remain unchanged. Offer/import/extraction/artifact schemas stay v1.

## Duplicate clicks, conflicts and restart

All preparation and budget transitions use the existing common budget lock and durable execution-store lock/write protocol. Repeating the same approved preparation operation may return its existing prepared child; it never creates another artifact/execution or continues sending. A different operation for the same source stops. Concurrent lock conflicts stop.

Signed tokens expire after 15 minutes and become invalid across service restart. A durably saved prepared child remains readable and can receive a new explicit sending approval. Startup/read never resumes work. Orphan artifacts, write-intent markers, uncertain ledger writes, unresolved imports and other unknown/recovery states stop preparation or approval. A crash after durable sending cannot be retried; the existing reservation and unknown handling are retained.

## Shared budget and maintenance

Both versions are read by the same execution store used by generation and extraction budget accounting. Existing activation, effective real stop, baseline and fees/reservations are not changed or reset. Real execution requires the existing valid real bucket; fixture/fake execution uses simulation only.

Maintenance v2 keeps the same seven stores and adds no sidecar path. Integrity validates v2 lineage plus the existing artifact/import/offer/accounting relationships. New backup manifests declare the actual `contracts.extractionExecution` value. Dry-run compares that value with the backed-up ledger envelope; old v1-execution backups remain readable and report no reanalysis coverage. No real restore exists.

Diagnostic/UI reasons are fixed. Lineage records contain no free-text reason, source body, response body, raw exception or credentials. The existing full input display remains solely for human sending consent, not added diagnostics.

## Verification boundary

`test/fixtures/extraction-reanalysis.js` uses an isolated OS temporary directory and a fake provider, with no OpenAI client. The Chrome script uses only this fixture, blocks external browser requests and checks 375px/1280px layouts. Unit/HTTP tests run under the network guard. Live datasets, activation, real approval and API calls are not exercised by these checks. Real intentional reanalysis still requires a separate human instruction/review.
