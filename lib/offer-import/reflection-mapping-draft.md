# Reflection v2 mapping draft (schema 1)

An explicit POST with draftAction=save saves only human mapping choices to
reflection-mapping-drafts/<import UUID>--<offer UUID>.json. GET/reload restores
that pair's latest draft, without writing. No review, source-check, offer,
reflection intent/result, permission or confirmation is created or changed.
No JS, browser storage or automatic saving is required. Preview never saves a draft.

The envelope is {schemaVersion:1,revisions:[...]}. Each append-only revision has
schemaVersion, its independent revision, importId, offerId, binding, savedAt and
choices. The binding contains the import/offer revisions, SHA256 hashes of both
complete validated snapshots, and policyVersion=1. Choices keep candidateId,
mode (including the explicit empty undecided value), conversionIds, reason and
commonConfirmed. No extracted text, quote, secret or approval token is duplicated.
Reasons pass the existing secret guard. Each candidate has a record in saved order;
blanks are never changed to none, and an incomplete explicit choice remains incomplete.
The shared v2 choice validator validates drafts and formal projection. Draft-only
partial validation permits missing reason, missing target or common confirmation;
known forbidden policy/target combinations are rejected. Full projection still
requires every choice complete and checks prior reflection, collisions, final offer
validation and snapshot/revision conflicts before approval.

All historical bindings and choices are verified against exact existing import and
offer history. Current revision or snapshot hash differences stop resume, resave and
preview with 409. Policy version changes are fail-closed. No automatic migration,
refresh, repair, merge, reset or stale-draft deletion is provided. A stale draft is
preserved for human inspection; starting a new generation after stale is future work.
Saving a current draft invalidates previous v2 confirmations. UI previews bind the
draft revision and full latest-draft hash in their signed token; an independently saved newer draft stops commit.
Restart retains choices on disk but invalidates all approvals through existing HMAC
secret behavior. Unsaved browser edits remain unsaved and are not persisted on error.

The rendered hidden draft revision is checked, never refreshed just before submit.
Save acquires exclusive mkdir locks in relative global order: drafts, existing
commit store, imports, offers (backup also locks AI stores before commit). Existing
locks fail 409; they are never removed. Snapshot validation happens under these locks.
A unique wx/0600 temporary file is atomically renamed to the draft history file.
Rename failure returns 503; no retry or rollback. If acknowledgement was lost after
rename, a human reload observes the actual stored revision. Atomic rename is not an
fsync/power-loss durability guarantee. No directories/files are created at startup or GET.
Max 200 candidates, 1000 selected destinations, 1000 draft history entries, 16 MiB file,
and the existing 512000-byte submitted form cap apply.

Maintenance double-captures and locks the new store, checks syntax, references,
hashes and shared policy for every historical draft. Stale drafts produce a warning,
corrupt drafts an error; unknown/temp/symlink files retain fail-closed behavior.
Draft-containing backups use manifest v6 + reflectionMappingDraft:1; an explicit
legacy scope has drafts + existing 3 stores, while AI scope has drafts + existing
AI/v2 stores and their unchanged contract versions. This never activates AI/budget.
Manifest versions 1–5, old projection, commit ledger and recovery remain unchanged.
Backups preserve full draft histories; dry-run never restores data. Entire independent
file/directory deletion cannot be detected by an absent-store reader without an
external inventory/backup; draft loss never grants approval or enables reflection.
