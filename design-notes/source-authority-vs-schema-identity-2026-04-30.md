# Source Authority Vs Schema Identity

Status: captured
Owner: protocol owner
Created: 2026-04-30
Updated: 2026-04-30
Related: `design-notes/source-instances-and-multi-account-configurations-2026-04-24.md`, `openspec/changes/archive/2026-04-30-unify-source-binding-vocabulary/`, `openspec/specs/reference-implementation-architecture/spec.md`, `openspec/specs/reference-native-provider-boundary/spec.md`, `apps/web/content/docs/spec-core.md`, `apps/web/content/docs/spec-collection-profile.md`

## Question

Does PDPP Core need an explicit source/authority identifier in selection requests, grants, discovery artifacts, and resource-server enforcement, or should PDPP Core identify requested data only by schema/stream references and leave source binding to deployment-specific or Collection Profile machinery?

If an explicit source/authority identifier belongs in Core, what is its canonical shape?

Examples:

- `source: { kind: "connector", id: "https://registry.pdpp.org/connectors/spotify" }`
- `connector_id: "https://registry.pdpp.org/connectors/spotify"`
- an opaque authority/resource URI
- a schema-qualified stream identifier with no separate source field

## Context

The reference implementation currently uses a discriminated `source` object as the public authority binding for connector and native-provider realizations:

- `kind = "connector"` names a connector/polyfill realization.
- `kind = "provider_native"` names a native-provider realization.
- `id` carries the kind-keyed stable identifier.

This was introduced to remove parallel public `connector_id` and `provider_id` fields and keep authorization checks, routing, provenance, revocation, and storage/index scoping tied to one explicit authority binding.

That decision is now implemented in the reference implementation and in reference OpenSpec capabilities. However, it has protocol implications because Core-facing examples and Collection Profile language still use connector-centric vocabulary in places. In particular, `apps/web/content/docs/spec-core.md` now contains a `source` example while nearby parameter tables and examples still refer to `connector_id`.

## Stakes

This decision affects:

- whether source/authority identity is part of PDPP Core or reference-only behavior
- whether schema names describe only record shape or also imply authority/routing
- how grants bind to authorization scope
- how resource servers enforce revocation and avoid cross-source stream collisions
- how native-provider and connector-backed implementations expose equivalent data
- how Collection Profile START messages map requested data to concrete collection runs
- how multi-account and configured source-instance support should be modeled
- what clients can rely on across independent PDPP implementations

A weak answer risks either over-specifying reference implementation details as PDPP Core or under-specifying grant authority so independent implementations cannot interoperate safely.

## Current Leaning

Treat this as undecided protocol design, not as settled Core normativity.

The reference implementation may continue to use a structured `source` object internally and in its reference contract because it needs one authority binding for mixed connector/native-provider support. That does not by itself prove the same shape belongs in PDPP Core.

The likely protocol invariant is stronger than schema identity but weaker than the current reference-specific shape: a grant needs an unambiguous authority/source binding that is distinct from record schema. The protocol still needs to decide whether that binding is:

- a Core field with a canonical structured shape
- a Core opaque URI/reference
- a Collection Profile concern only
- a reference implementation detail outside the normative Core surface

## Promotion Trigger

Promote this into an OpenSpec change or root PDPP spec update before treating any of these as normative Core behavior:

- replacing `connector_id` with `source` in PDPP Core selection requests or grants
- publishing `source.kind` values as Core-defined protocol vocabulary
- requiring independent resource servers to expose source objects in discovery or data APIs
- changing Collection Profile START, manifest, or connector-runtime contracts to depend on the `source` object
- using source identity as a cross-implementation interoperability key rather than a reference implementation authority binding

## Decision Log

- 2026-04-30: Captured after the reference source-binding refactor raised an unresolved protocol question: whether naming the source provides value beyond schema selection, and whether the reference `source` object should be promoted into PDPP Core or kept reference-only.
- 2026-04-30: Current implementation state is provisional from a protocol-governance perspective. The reference implementation has a committed `source` object, but Core and Collection Profile semantics are not accepted as final by this note.
