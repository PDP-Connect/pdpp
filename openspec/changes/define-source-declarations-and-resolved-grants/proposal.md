# Proposal: Define Source Declarations and Resolved Grants

PDPP needs a neutral source declaration and a resolved grant that does not
depend on a later declaration lookup. The current contract leaves source
instances and per-stream connection scope ambiguous, and permits serving code
to reinterpret old authorization with current declaration metadata.

This change defines one Core `SourceDeclaration` for `connector` and
`provider_native` sources. It retains `source.kind` as a provenance and
authority class, while `source.id` is the authorization identity. It places
opaque instance handles on each request and grant stream. Requests may omit
them; every approved stream has an explicit unique non-empty set.

It defines complete JSON shapes for declarations, requests, and resolved
grants, including frozen stream fields, time constraints, and canonical
resources. The AS uses one immutable declaration snapshot through validation,
display, narrowing, issuance, and evidence. The RS enforces only resolved
authorization facts. Current serving metadata may narrow or reject a request
for routing and capability reasons, but never widens or reinterprets a grant.

## Scope

- Define the Core `SourceDeclaration` contract and opaque extension seam.
- Define request and resolved-grant JSON shapes and matching rules.
- Make per-stream instance handles explicit and prevent implicit fan-in.
- Define snapshot retention, mutation barriers, evidence, and RS enforcement.
- Specify persisted-data migration for pending consent, grants, packages, and
  legacy per-stream `connection_id` mappings.
- Define Core-only and combined implementation checks.

Out of scope are digests, portable credentials, security floors, discovery,
retrieval, trust, caches, quarantine, and broad cosmetic `Manifest` renames.
Collection owns execution semantics. Its task here is limited to reference
relocation and compatibility with the neutral contract.
