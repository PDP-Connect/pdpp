# Proposal: Define Source Declarations and Resolved Grants

PDPP needs a neutral source declaration and a resolved grant that does not
depend on a later declaration lookup. The current contract leaves source
instances and per-stream connection scope ambiguous, and permits serving code
to reinterpret old authorization with current declaration metadata.

This change defines one Core `SourceDeclaration` for `connector` and
`provider_native` sources. It retains `source.kind` as a provenance and
authority class, while `source.id` is the authorization identity. It places
optional opaque `instance_ids` on each requested stream and a required unique
non-empty `instance_ids` set on each approved stream. The declaration and
request source objects have no instance IDs. Omission resolves only to one
eligible instance for that stream; explicit plurality is required for fan-in.

It defines complete JSON shapes for declarations, requests, and resolved
grants, including frozen stream fields, time constraints, and canonical
resources. The AS uses one immutable declaration snapshot through validation,
display, narrowing, issuance, and evidence. The RS enforces only resolved
authorization facts. Current serving metadata may narrow or reject a request
for routing and capability reasons, but client grant-scoped metadata is always
projected from the grant and never replaced by current declaration metadata.

The implementation is a five-PR program. The Source Contract PR owns the
neutral Core contract. The Source RI PR implements it in the reference
server. PR89 owns the OAuth/RAR carrier and separated-RS seam. Separate
Discovery Contract and Discovery RI PRs define and implement discovery and
publisher trust. Each PR has an explicit merge gate.

## Scope

- Define the Core `SourceDeclaration` contract and opaque extension seam.
- Preserve the common consent, record, selection, and query capabilities now
  declared by Core for both connector and provider-native sources.
- Define request and resolved-grant JSON shapes and matching rules.
- Make per-stream source-instance handles explicit and prevent implicit fan-in.
- Define snapshot retention, mutation barriers, evidence, and RS enforcement.
- Make the pre-v0.1 authorization-state break explicit: old pending consent,
  grants, and packages require fresh consent and are never adapted at read time.
- Define Core-only and combined implementation checks.

Out of scope are digests, portable credentials, security floors, discovery,
retrieval, trust, caches, quarantine, and broad cosmetic `Manifest` renames.
Collection owns acquisition and execution mechanics, POST ingest, state
endpoints, grant-scoped collection state, concurrent collection, and
conformance tiers. Its task here is limited to relocating those requirements
to `spec-collection-profile.md` and preserving compatibility with the neutral
contract.
