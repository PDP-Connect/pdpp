# Capability discovery options and recommendation — 2026-04-22

**Status:** owner recommendation / no normative spec edit yet
**Author:** Codex (owner agent)

## Purpose

Compare the candidate PDPP capability-discovery models against the frozen rubric and recommend the next shape to steer the protocol and reference work.

Inputs:

- `capability-discovery-framing-2026-04-22.md`
- `capability-discovery-research-audit-2026-04-22.md`
- `record-query-contract-research-2026-04-21.md`
- current `spec-core.md`
- targeted primary-source refresh on:
  - HL7 FHIR `CapabilityStatement`
  - RFC 7643 / RFC 7644 SCIM discovery structure
  - RFC 8414 / RFC 9728 metadata-extension structure

## Comparator takeaways that matter most

The targeted refresh sharpened four useful lessons:

1. **FHIR**
   - `CapabilityStatement` is a broader service-level discovery document.
   - It still carries resource-specific capability detail such as supported `searchParam`, `_include`, and operations.
   - Unlisted resource types or operations are not supported.
   - This is strong evidence for explicit capability publication, but it is also a reminder that broader capability documents become justified mainly when the ecosystem needs rich, shared, cross-resource discovery.

2. **SCIM**
   - SCIM uses a layered structure:
     - `ServiceProviderConfig` for global service features such as filter, sort, patch, bulk, and authentication schemes
     - `ResourceTypes` for per-resource endpoints and schemas
     - `Schemas` for the resource/data model itself
   - This is the closest direct precedent for a clean split between service-wide capability facts and per-resource capability facts.

3. **OAuth metadata family**
   - RFC 8414 and RFC 9728 are deliberately parallel metadata documents with registry-backed extension points.
   - They also support cross-linking:
     - `authorization_servers` on the protected resource side
     - `protected_resources` on the authorization-server side
   - This reinforces a pattern PDPP already uses: add a new metadata layer only when it serves a distinct role, and prefer extension/parallelism over overloaded bespoke discovery.

4. **Open Banking / FDX**
   - Still strongest as evidence for ecosystem-scale consented data access and governance.
   - Much weaker, in the current captured research, as a concrete model for the exact capability-discovery shape we need here.

## Candidate models

### A. Stream-only discovery

- Keep capability discovery primarily in per-stream metadata.
- The current `query` object grows only as needed.
- No separate server-level query capability layer.
- No broader capability document.

### B. Layered server + stream discovery

- Keep per-stream metadata authoritative for stream-specific query power.
- Add a small server-level capability layer only for truly cross-stream/global facts.
- Do not add a broader capability document unless later justified.

### C. Broader capability document

- Add a new first-class capability-discovery document analogous in spirit to FHIR `CapabilityStatement`.
- Stream metadata still exists, but the broader document becomes a core discovery layer.

## Scenario check

The following scenarios matter most for PDPP:

1. stream with exact filters only
2. stream with declared range filters on one field but not another
3. stream with one expandable relationship
4. stream with no special query power
5. client or agent trying to generate valid requests before trial-and-error
6. future implementation that supports more than today's reference
7. server-wide facts that may apply across streams, such as whether a capability family exists at all

### A. Stream-only discovery

Works well for scenarios 1–4 because all meaningful variance is already per-stream.

Weaknesses:

- scenario 5 gets awkward when a client wants a quick server-wide answer before inspecting every stream
- scenario 6 risks duplication if broader capabilities later need to be repeated across many streams
- scenario 7 has no clean home except ad hoc extensions or duplicated hints

### B. Layered server + stream discovery

Works well for scenarios 1–4 because per-stream metadata remains authoritative where it should.

Also handles scenarios 5–7 cleanly:

- server-level metadata can publish a small set of truly global facts
- stream metadata continues to answer “what can I do with this stream?”
- later growth remains possible without prematurely adding a heavyweight document

### C. Broader capability document

Can handle all scenarios in principle, but today it is weak on elegance and incrementalism:

- likely duplicates stream facts already available elsewhere
- adds one more document clients must discover and reconcile
- solves future ecosystem complexity before PDPP has actually reached that level of complexity

## Rubric comparison

### A. Stream-only discovery

- **Honest:** high
- **Elegant:** medium-high
- **Interoperable:** medium
- **Composable:** medium
- **Stream-safe:** high
- **Human-reviewable:** high
- **Machine-readable:** medium
- **Incremental:** high

Read:

- strongest on simplicity today
- weaker once truly global capability facts or richer client-generation needs emerge

### B. Layered server + stream discovery

- **Honest:** high
- **Elegant:** high, if the server-level layer stays small
- **Interoperable:** high
- **Composable:** high
- **Stream-safe:** high
- **Human-reviewable:** high
- **Machine-readable:** high
- **Incremental:** high

Read:

- best balance
- matches SCIM-style layering
- fits OAuth-metadata precedent
- preserves the current stream-first shape while leaving room for clean growth

### C. Broader capability document

- **Honest:** medium-high
- **Elegant:** low-medium
- **Interoperable:** high
- **Composable:** medium
- **Stream-safe:** high
- **Human-reviewable:** medium
- **Machine-readable:** high
- **Incremental:** low-medium

Read:

- defensible only if PDPP soon needs richer cross-resource capability publication than stream metadata plus a small server layer can express
- not justified yet

## Recommendation

Choose **B. Layered server + stream discovery** as the long-haul PDPP direction.

But apply it in a deliberately incremental way:

1. **Keep the current per-stream `query` object.**
   - It remains the authoritative place for stream-specific query power such as:
     - range-filter support
     - expansion support
     - relation-specific bounds

2. **Do not add a broad new capability document now.**
   - PDPP has not yet demonstrated a concrete need strong enough to justify a CapabilityStatement-like layer.

3. **Reserve a small server-level capability layer for truly global facts only.**
   - This layer should exist only when a fact is genuinely cross-stream and does not belong naturally in stream metadata.
   - It should not duplicate stream-specific query power.

## What “small server-level capability layer” means

The intended server-level layer should be narrow and should only answer questions like:

- is a capability family present at all on this server?
- are there server-wide defaults or limits that apply across streams?
- is there a global discovery relationship the client should know before traversing stream metadata?

It should **not** become:

- a second place to enumerate per-stream range-filter fields
- a second place to enumerate per-stream expandable relations
- a replacement for stream metadata

## Why this is the best fit for PDPP

### 1. It matches the problem shape

PDPP is a protocol over future heterogeneous streams. Much of the interesting capability variance is inherently stream-specific. So stream metadata must remain first-class.

### 2. It matches adjacent standards cleanly

- SCIM shows the value of:
  - small global service config
  - separate per-resource discovery
- OAuth metadata shows the value of:
  - explicit parallel metadata documents with registries
  - adding new discovery documents only when they serve a distinct role

### 3. It preserves elegance

This option best satisfies the Rich Hickey test:

- enough structure to model the real problem
- not so much structure that the protocol spends effort managing its own metadata machinery

### 4. It keeps the next spec move small

The current Core does not need another large rewrite immediately. The main near-term implication is a design constraint:

- future capability growth should be tested against layered server + stream discovery
- not against a reflex to create a larger capability document

## What would justify revisiting C later

PDPP should revisit a broader capability document only if one or more of these become true:

1. clients need a single place to discover cross-resource operations or capability families that cannot be expressed elegantly in stream metadata
2. stream metadata begins duplicating too much shared capability structure
3. independent implementations need richer conformance/discovery publication than stream metadata plus OpenAPI can provide
4. agent/client-generation workflows demonstrably suffer from the absence of a broader discovery document

Until then, adding C would be incidental complexity.

## Immediate implication for PDPP work

The owner recommendation is:

- keep the current stream-level `query` capability shape as the near-term truth
- do **not** add a new broader discovery document during the current reference-contract / Fastify work
- if a server-level capability layer becomes necessary, design it as a small companion layer rather than a replacement for stream metadata

## Success condition

This decision pass is complete when the project can say:

- the long-haul direction is layered server + stream discovery
- the current near-term implementation remains stream-first
- a broader capability document is intentionally deferred until it solves a concrete problem
