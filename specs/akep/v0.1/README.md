# AKEP v0.1 machine-readable draft

This directory is the machine-readable companion to the human specification in
[`docs/protocols/akep-v0.1.md`](../../../docs/protocols/akep-v0.1.md).

## Contents

- [OpenAPI 3.1 binding](openapi.yaml) — discovery, Reader, Contributor, Curator, Publisher, and Federation operations.
- Identity and knowledge schemas: [common types](schemas/common.schema.json), [Asset Manifest](schemas/asset-manifest.schema.json), [Profile document](schemas/profile-document.schema.json), [Record resolution](schemas/record-resource.schema.json), [Revision resource](schemas/revision-resource.schema.json).
- Query schemas: [request](schemas/query.schema.json), [result](schemas/query-result.schema.json), and the optional ContextPack extension [request](schemas/context-pack-request.schema.json) / [response](schemas/context-pack.schema.json).
- Contribution schemas: [Ingestion](schemas/ingestion.schema.json), [Ingestion receipt](schemas/ingestion-receipt.schema.json), [Contribution](schemas/contribution.schema.json), [Contribution receipt](schemas/contribution-receipt.schema.json), [Evidence amendment](schemas/contribution-amendment.schema.json), [Withdrawal](schemas/contribution-withdrawal.schema.json), [Review decision](schemas/decision.schema.json), [Publication/safety decision](schemas/publication-decision.schema.json).
- Governance and evidence schemas: [Phase 1 access policy](schemas/mvp-access-policy.schema.json), [Authorization plan](schemas/authorization-plan.schema.json), [Policy binding](schemas/policy-binding.schema.json), [Attestation](schemas/attestation.schema.json), EvaluationRun [request](schemas/evaluation-run-request.schema.json) / [resource](schemas/evaluation-run.schema.json), [Lifecycle event](schemas/lifecycle-event.schema.json), [Exposure receipt](schemas/exposure-receipt.schema.json), [Usage](schemas/usage.schema.json), [Usage receipt](schemas/usage-receipt.schema.json), [Feedback](schemas/feedback.schema.json), [Feedback evidence receipt](schemas/feedback-receipt.schema.json).
- Phase 1 knowledge profiles: [source document](profiles/mvp-source-document-v1.json) and [procedure](profiles/mvp-procedure-v1.json).
- Discovery and Federation schemas: [Capability](schemas/capability.schema.json), [Checkpoint payload](schemas/checkpoint.schema.json), [Signed checkpoint](schemas/signed-checkpoint.schema.json), [Federation event](schemas/federation-event.schema.json), [DSSE event envelope](schemas/dsse-event-envelope.schema.json), [Snapshot request](schemas/snapshot-request.schema.json), [Snapshot receipt](schemas/snapshot-receipt.schema.json), [Snapshot stream header](schemas/snapshot-stream-header.schema.json), [Change page](schemas/change-page.schema.json), [Delivery ACK](schemas/delivery-ack.schema.json).
- [Problem Details](schemas/problem.schema.json) and the [seed conformance matrix](conformance/README.md).
- Validated examples: [Manifest](examples/asset-manifest.json), [Capability](examples/capability.json), [Query](examples/query.json), [Query result](examples/query-result.json), [Exposure receipt](examples/exposure-receipt.json), [Contribution](examples/contribution.json), [Usage](examples/usage.json), and [Feedback](examples/feedback.json).

Schema `$id` values are intentionally relative. Resolve them against the URI or
directory from which the schema set was loaded, so offline validation never
depends on the proposed `agentknowledge.dev` namespace. A future public release
must ship a resolver catalog or immutable bundled schema in addition to any
deployed registry.

ContextPack and the MCP Adapter are optional capabilities, not new Core operations.
An implementation advertises them as `{uri, required:false}` entries in
`supportedExtensions`; the ContextPack wire shape is pinned by the schema links
above, while MCP remains a transport adapter over the same AKEP resources.

Profile document digests use SHA-256 over RFC 8785 JCS UTF-8 bytes, not the
pretty-printed source-file bytes. The Phase 1 procedure Profile digest is
`sha256:aae83aa5cd8d97cba553b453544d89e97609c6d91a57109b3ed5ee4897e648b4`.

## Canonical revision test vector

Canonicalize `examples/asset-manifest.json` with RFC 8785 JCS, hash the UTF-8
bytes with SHA-256, and prefix the lowercase hex digest with
`urn:akep:sha256:`. The result must equal the single line in
`examples/asset-manifest.revision-id.txt`:

```text
urn:akep:sha256:645b377464b2d9886f2567066e7d932156b2435df8fcc8d0790e5720129e430d
```

The manifest deliberately excludes mutable channel state, attestations,
signatures, and download locations. They are represented by separate resources,
so their lifecycle changes do not change the knowledge revision identity.

## Draft caveat

AKEP v0.1 is experimental. The `agentknowledge.dev` identifiers are proposed
namespace placeholders and are not yet a deployed registry. Do not publish a
public conformance claim before the namespace, license, media types, executable
negative test vectors, and governance process are finalized.
