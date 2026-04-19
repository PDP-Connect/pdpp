# Reference Topology / Canonical System Memo

Status note: historical topology memo. The active canonical architecture now lives in `openspec/specs/reference-implementation-architecture/` and the active program tracker lives in `openspec/changes/reference-implementation-program/`.

**Date:** 2026-04-16  
**Status:** Recommendation for the PDPP reference implementation

## Bottom line

PDPP should be presented and built as **one protocol core with two realization paths**:

1. **Native provider path**: a cooperating HR platform that speaks PDPP directly.
2. **Personal-server polyfill path**: a user-side deployment that makes PDPP work against non-native sources.

Everything else hangs off those two paths:

- **Longview** is the canonical client that proves the consent/grant/enforcement story.
- **CLI** is the canonical operator path for owner self-export and inspection.
- **Optional connectors/runtime** are only needed for the polyfill path, and they are reference architecture, not protocol ontology.

The key design rule is simple: **the client should never need to know whether the source was native, browser-driven, or imported.** The client-facing contract is the same either way.

---

## Canonical system shape

The clearest topology is:

```text
Longview client      CLI
      |               |
      v               v
  PDPP protocol surfaces (selection request, grants, RS query, owner access)
      |               |
      +-------+-------+
              |
   +----------+---------------------------+
   |                                      |
   v                                      v
Native HR provider                Personal-server polyfill
(AS + RS, direct)                  (AS + RS + optional runtime)
                                           |
                                           v
                              Connectors / import / browser automation
                                           |
                                           v
                                 External data sources
```

This is not “one server with many tricks.” It is one protocol model with two deployment shapes:

- **Native HR provider** proves PDPP is a first-class platform capability.
- **Personal server** proves PDPP still works where platforms do not cooperate yet.

The reference should keep those two deployment shapes visibly distinct while making their client-facing behavior identical.

---

## Layer model

### 1. Protocol core

This is the stable PDPP surface another implementation would need to copy.

Owns:

- selection request semantics
- grant issuance and grant lifecycle
- consent surface definitions
- resource-server projection and revocation enforcement
- owner-authenticated RS access
- record model and stream semantics
- introspection-based token resolution

Must stay stable:

- Longview should see the same request/grant/enforcement model against both paths.
- CLI should use the same owner-authenticated RS surfaces against both paths.
- The source of the data must not leak into the protocol meaning.

### 2. Deployment layer

This is where the same protocol is realized in different ways.

#### Native HR provider

Working reference example: `Northstar HR`.

Role:

- AS + RS in one cooperating platform
- native PDPP support, no scraping story
- direct owner self-export
- direct client grants against first-party data

What it proves:

- PDPP is not dependent on a personal server
- PDPP can be implemented by a platform directly
- the reference protocol is not “just a polyfill wrapper”

#### Personal-server polyfill

Role:

- AS + RS + runtime co-located in a user-side deployment
- collects from non-native sources through connectors, browser automation, or import
- preserves the same grant and enforcement semantics as the native path

What it proves:

- PDPP works before platforms adopt it
- collection method is an implementation detail behind the consent boundary
- browser automation is a polyfill path, not the ontology

### 3. Client layer

#### Longview

Longview is the canonical client because it is the clearest end-user request story.

It should prove:

- the client sends a concrete selection request
- the user sees exactly what is being asked
- the server enforces the grant
- the same client works against both native and polyfilled realizations

Longview should remain protocol-shaped, not source-specific. If the topology changes, Longview should not.

#### CLI

The CLI is not an afterthought. It is the operator/reference path for:

- owner self-export
- listing streams
- querying records
- debugging grants, revocation, and introspection

The CLI should consume the same PDPP surfaces as Longview and should not require private database access.

### 4. Collection/runtime layer

This layer is optional and only exists because many sources are not native PDPP providers yet.

Owns:

- connector process lifecycle
- browser automation or API collection
- import handling
- state management for bounded runs
- retries, scheduling, secrets, browser lifecycle

Should be treated as:

- **replaceable implementation detail**
- **reference architecture**
- **not** part of the protocol ontology

The runtime is important, but it is subordinate to the protocol contract. It exists to feed the same RECORD/STATE model into the RS, not to redefine the protocol.

---

## Replaceable parts

These are the pieces a fork should be able to swap without changing the protocol story:

- **Native source implementation**: any cooperative HR or identity-adjacent platform can replace Northstar HR.
- **Fulfillment path**: native API, browser automation, and import can be swapped or added without changing client or grant semantics.
- **Connector runtime implementation**: child-process JSONL today, something else later if needed, as long as the Collection Profile contract holds.
- **Client application**: Longview is canonical for this reference, but the topology should not depend on it.
- **CLI shelling / UX**: the command names can change, but the owner-authenticated RS surfaces should not.

These are **not** replaceable if the fork still claims to be PDPP:

- grant semantics
- selection-request semantics
- field projection enforcement
- revocation behavior
- owner vs client distinction
- stream/field authorship split
- introspection-based enforcement

In short: a fork can swap the sources and the wrappers, but not the meaning of the grant.

---

## Forkability constraints

The reference should remain forkable by other implementers. That means:

1. **Keep the protocol and the deployment separate.**
   The same PDPP behavior should be reachable from both native and polyfill deployments without changing the client model.

2. **Keep the client ignorant of collection mechanics.**
   Longview should not know whether records were collected via API, browser automation, or import.

3. **Keep the CLI on standard surfaces.**
   If a tool needs private database access, it is no longer a clean reference client.

4. **Keep runtime concerns runtime-local.**
   Scheduling, retries, secrets, browser lifecycle, and connector update strategy should not become protocol surface unless there is a real interoperability need.

5. **Keep the reference honest about what is normative.**
   Core and Collection Profile define the protocol. The native HR deployment, personal-server deployment, and Longview specimen are reference choices.

6. **Keep one golden path.**
   The reference should be easy to read as one concrete story, not as a configurable platform kit.

The practical test is: if another team forked this repo, could they replace the native HR provider, swap in a different polyfill source, or rebuild the CLI without rewriting the protocol semantics? If yes, the topology is healthy.

---

## What “production-credible but pure reference” means

### Production-credible

The reference must feel like a real system:

- real persistence
- real HTTP and token flows
- real grant enforcement
- real CLI access
- real tests at the seams
- realistic seed data and manifests
- executable walkthroughs, not prose-only claims

### Pure reference

The reference must not become a speculative product platform:

- no hidden control plane that bypasses the protocol
- no product-only shortcuts that cannot be explained at the wire level
- no generalized SDK unless an interoperability need demands it
- no registry, marketplace, or multi-tenant SaaS layer unless it becomes protocol-relevant
- no forked PDPP-specific language where existing standards already solve the problem

The rule of thumb is:

- if it affects interoperability, it belongs in protocol or profile work
- if it only affects operation, it belongs in reference architecture
- if it only affects product convenience, it should stay out

---

## Clearest topology recommendation

The most legible reference topology is:

1. **Lead with the native provider as proof of the protocol itself.**
   It is the cleanest demonstration that PDPP is a platform capability, not just a user-side workaround.

2. **Keep the personal server as the polyfill path.**
   It proves adoption before platform cooperation and makes browser automation/import look like fulfillment choices, not the point of the protocol.

3. **Use Longview against both paths.**
   That is what makes the topology feel like one protocol instead of two separate products.

4. **Add the CLI as a first-class owner/debug client.**
   This makes the reference credible to implementers and reviewers, not just demo viewers.

5. **Keep connectors/runtime optional and clearly subordinate.**
   They matter only on the non-native path, and they should never become the conceptual center.

That gives the strongest overall shape:

- **protocol center**: consent, grants, enforcement
- **deployment center**: native provider and personal-server polyfill
- **client center**: Longview and CLI
- **collection center**: optional, replaceable runtime behind the polyfill path

If the reference needs one sentence, it is this:

**PDPP is a consent-and-enforcement protocol that can be implemented natively by a provider or realized through a personal-server polyfill, with Longview and the CLI proving the same contract on both paths.**
