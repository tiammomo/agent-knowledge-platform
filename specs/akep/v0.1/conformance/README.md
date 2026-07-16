# AKEP v0.1 conformance seed

This matrix defines the minimum test harness to build during Phase 0. It is a
reviewable seed, not an executable TCK and not grounds for a public conformance
claim.

## Core identity and parsing

| Case | Expected result |
| --- | --- |
| `CORE-001` Validate every example against its Draft 2020-12 schema | Accept |
| `CORE-002` JCS-canonicalize the golden Manifest and compute SHA-256 | Exact ID in `../examples/asset-manifest.revision-id.txt` |
| `CORE-003` JSON with a duplicate key, invalid Unicode, NaN/Infinity, or an unsafe numeric literal | Reject before hashing |
| `CORE-004` Claimed Revision ID differs from the Manifest hash | `AKEP_DIGEST_MISMATCH` |
| `CORE-005` Payload bytes, digest, media type, decoded size, or unique name do not match the descriptor | Reject |
| `CORE-006` `critical` names an absent or unsupported extension | `AKEP_CRITICAL_EXTENSION_UNSUPPORTED` |

## Contribution and lifecycle

| Case | Expected result |
| --- | --- |
| `CON-001` Retry an identical write with the same caller, operation, and idempotency key | Same receipt; one side effect |
| `CON-002` Reuse an idempotency key with a different body | `AKEP_IDEMPOTENCY_CONFLICT` |
| `CON-003` Create has parents, status change carries a Manifest, or revise has no base | Schema rejection |
| `CON-004` `baseRevisionIds` differs from `manifest.parents`, or a parent belongs to another Record | `AKEP_REVISION_CONFLICT` |
| `CON-005` Contributor or review-only token attempts to publish | `AKEP_POLICY_DENIED` |
| `CON-006` Publication action does not match stored Contribution kind or current ETag/policy epoch | Reject without partial state change |
| `CON-007` Publish token invokes revoke/erase, incident token invokes erase, or erase lacks Privacy/Legal approval | `AKEP_POLICY_DENIED` |
| `CON-008` Ingestion reaches candidate without Revision/Contribution IDs, or failed without a Problem reference | Schema rejection; every terminal status remains actionable |
| `CON-009` Curator submits verify with no Attestation reference | Schema rejection; Contribution does not enter verified |
| `STATE-001` Old publish/update is replayed after revoke or erase | Revision remains unavailable; event is audited |
| `STATE-002` Approval transaction fails between Channel update and Outbox creation | Neither is committed |
| `STATE-003` Resolve contains duplicate `(trustDomain,name)` Channel keys or duplicate `(trustDomain,revisionId,name)` Status keys | Client rejects the whole representation; it never chooses a winner |

## Retrieval, authorization, and evidence

| Case | Expected result |
| --- | --- |
| `AUTH-001` Candidate, another Space, or a forbidden visibility partition is semantically closest | Never enters ANN/ranking candidate set or result counts |
| `AUTH-002` Policy or Channel changes while a query/read receipt is live | Epoch increments; cache, snapshot, and receipt fail closed |
| `AUTH-003` Direct Revision/Blob read omits purpose/obligation support or uses a receipt for another subject/Space | Reject without revealing existence |
| `AUTH-004` Effective obligation is absent from the client's exact supported set or has an unknown pinned Profile | Deny before returning content |
| `AUTH-005` Direct read quality is insufficient/unsuitable, or a warning is omitted from headers/Exposure Receipt | Deny the former; preserve the latter with reasons and Attestation references |
| `AUTH-006` Query sends an explicit empty spaces array | Schema rejection; omission alone means all token-authorized Spaces |
| `AUTH-007` Predicate handle is missing, caller-supplied, expired, or its subject/tenant/Space/purpose/epoch/digest binding differs | Deny before ANN/LIMIT; never interpret it as SQL or arbitrary DSL |
| `CITE-001` Every Citation is resolved against the exact Revision, payload digest, and byte/page/JSON range | Reproduces the same authorized content |
| `CITE-002` Direct Manifest, full Blob, and ranged Blob reads mint an Exposure Receipt | Server-issued Citation uses respectively whole-resource or exact end-exclusive byte-range; client-minted IDs are rejected |
| `CITE-003` Query returns zero results | Query Exposure Receipt is valid with zero Citations; direct-read receipts still require at least one |
| `CTX-001` ContextPack budget truncates a UTF-8 passage | Returned text and text-offset Citation reproduce the same authorized bytes; warning is explicit and all budget counters stay within the request |
| `CTX-002` Client calls ContextPack when the extension is not advertised, or requests semantic/hybrid on the current lexical/exact implementation | Client does not assume support; server rejects an unsupported mode without fallback |
| `USE-001` Usage cites content absent from its Query/Read receipt | Reject |
| `USE-002` Feedback uses a forged, expired, cross-subject, or already-conflicting usage record | Reject or return the original idempotent receipt |
| `USE-003` Positive Feedback arrives in large volume | Evidence only; no direct rank, publish, or training mutation |
| `USE-004` One Usage mixes Exposure citations from more than its declared Space | Reject; caller must split cross-Space use into one Usage per Space |
| `EVAL-001` Generic Attestation POST attempts to create `benchmark-result` | Reject; only a completed EvaluationRun may mint it |
| `EVAL-002` EvaluationRun required threshold fails, or advisory threshold alone fails | Persist immutable evidence with respectively `fail` or `warning`; never rewrite metrics |
| `EVAL-003` Review/publication cites missing, expired, failed, cross-Revision, or client-fabricated evaluation evidence | Reject; publication additionally requires a matching completed EvaluationRun |

## Federation and resilience

| Case | Expected result |
| --- | --- |
| `FED-001` DSSE signature, issuer/audience, expiry, chain hash, or mandatory suite is invalid | Reject and do not ACK |
| `FED-001A` Outer event identity/type disagrees with inner Manifest, LifecycleEvent, or Attestation | Reject and do not ACK |
| `FED-002` Event is duplicated, reordered, or has a sequence gap | Deduplicate; pause ordinary updates and reconcile |
| `FED-003` An old snapshot or backup replays publish after remote revoke/erase | Safety overlay remains monotonic |
| `FED-004` ACK is early or its Peer/deliveryId/checkpoint/event set does not exactly match the delivery | Reject/defer ACK |
| `FED-005` Quiet changes stream or empty-Space Snapshot contains zero events with the canonical empty event-set digest | Accept and allow checkpoint-only ACK |
| `FED-006` Snapshot is ready without delivery artifacts, failed without a Problem reference, or expired | Reject invalid receipt; expired GET returns 410 Problem rather than a receipt status |
| `FED-007` Signed Checkpoint contains two positions with the same streamId | Reject the whole Checkpoint even when the objects differ |
| `RES-001` Object write succeeds but database commit fails, or projection update fails after commit | Orphan is reclaimed or projection retried; no published-without-body state |
| `RES-002` Restore from backup after revoke/erase | Tombstones and policy epoch prevent resurrection |
| `RES-003` Safety Log fails before Intent ACK, after database commit, or contains an unpaired Intent during restore | No DB change before ACK; committed barrier stays effective and success is withheld until Commit; restore treats unpaired Intent as deny |

The executable TCK should emit the implementation version, negotiated AKEP
version, policy fixture, test-vector digest, and pass/fail evidence for every
case. Security timing tests must state their statistical model and isolation
class; they must not claim to eliminate every possible side channel.
