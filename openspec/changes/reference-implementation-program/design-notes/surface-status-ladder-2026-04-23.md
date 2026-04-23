# Surface Status Ladder — 2026-04-23

**Status:** owner decision rubric (project-scoped, non-normative)  
**Purpose:** give PDPP a repeatable way to decide whether a capability belongs in core, a companion profile, an optional extension, the reference implementation only, or purely inside an implementation.

This note is not a protocol decision by itself. It is a rubric for making those decisions with less drift and less accidental protocol gravity.

## Why this exists

PDPP now has enough real implementation surface that "just ship it in the reference" is no longer a neutral move.

Some capabilities:

- are clearly core and should be portable everywhere
- are clearly reference-only product conveniences
- are coherent optional bundles that look more like profiles than one-off features
- are valuable enough to be public and discoverable, but not yet mature enough for core
- are implementation details that clients should never see

Without an explicit ladder, useful reference behavior tends to become de facto truth by accident.

## The ladder

### 1. Implementation detail

Purely internal choice. Clients should not know or care.

Examples:

- storage engine
- tokenizer
- ranking implementation details
- embedding backend
- index layout

### 2. Reference-only surface

Real, documented, useful behavior in the forkable reference product, but with no interoperability claim beyond the reference itself.

Clients MAY use it when targeting the reference specifically. They MUST NOT assume other PDPP implementations expose it.

Examples:

- `/_ref/*`
- dashboard/operator UI
- composed browser mode
- placeholder owner password gate
- hosted owner-facing HTML shells

### 3. Optional extension

A public capability that implementations MAY expose and clients MAY rely on when it is explicitly advertised.

This is the right bucket for features that are:

- valuable
- portable enough to define honestly
- not yet mature enough to require everywhere

An extension should be:

- named
- discoverable
- capability-declared
- testable
- honest about what it does and does not guarantee

### 4. Companion profile

A coherent optional bundle of public behavior that is larger than one capability.

Profiles are the right tool when the thing being standardized is not "one feature" but a recognizable mode or workflow that multiple implementations could target as a whole.

Examples from existing PDPP thinking:

- Collection Profile
- a possible future provider-connect profile
- a possible future event-driven delivery profile

### 5. Core

Mandatory portable PDPP behavior. Serious clients should be able to assume it exists across conforming implementations.

Core should be reserved for features that are:

- necessary for interoperable clients
- stable enough to define truthfully
- valuable enough to justify universal implementation cost

## What each rung commits us to

| Status | Public? | Discoverable? | Normative? | Conformance-tested? | Client may rely across implementations? |
|---|---|---|---|---|---|
| Implementation detail | no | no | no | no | no |
| Reference-only | yes, reference-local | optional docs only | no | reference tests only | no |
| Optional extension | yes | yes | yes, but optional | yes, if advertised | yes, when advertised |
| Companion profile | yes | yes | yes, as a bundle | yes, at profile level | yes, when claiming the profile |
| Core | yes | implicit | yes | yes | yes |

## Decision questions

For any candidate capability, ask these in order.

### 1. Is this needed for interoperability, or only for product/operator quality?

- If only the reference product needs it, prefer `reference-only`.
- If third-party clients written once for many owners need to rely on it, it cannot remain merely reference-only.

### 2. Can we define it truthfully and portably?

- If semantics are stable and testable, it may be `core` or an `extension`.
- If semantics depend heavily on local taste, local data shape, or moving implementation choices, avoid `core`.

### 3. Is it one capability, or a whole workflow bundle?

- one capability -> likely `extension`
- coherent multi-surface workflow -> likely `profile`

### 4. Is ecosystem fragmentation acceptable here?

- If yes, `extension` may be fine.
- If serious clients become materially broken without universal support, the feature likely wants `core` or a mandatory profile for a given deployment mode.

### 5. Does it require capability discovery?

- If clients need to probe support, that points toward `extension` or `profile`.
- If clients should be able to assume it exists everywhere, that points toward `core`.

### 6. Does it force highly opinionated or fast-moving choices?

Examples:

- embedding model choice
- ranking policy
- tokenizer/language behavior
- storage/index versioning

High opinionation argues against `core`.

### 7. Is fallback acceptable if absent?

- If the fallback is still viable, though worse, `extension` may be appropriate.
- If the fallback is effectively "query SQLite directly" or "rebuild the whole thing out of band," the capability may be too important to leave undefined forever.

## Practical decision worksheet

Before deciding status, write down:

1. **Primary user**
   - owner
   - owner-run agent
   - third-party client
   - operator/developer

2. **Interop necessity**
   - can a serious client work well without this?

3. **Semantic stability**
   - can we define correct behavior without hand-waving?

4. **Opinionation level**
   - does this force local or vendor-specific choices?

5. **Fallback quality**
   - what happens when an implementation does not support it?

6. **Discovery need**
   - does a client need metadata to know whether it is supported?

7. **Likely category**
   - implementation detail / reference-only / extension / profile / core

## Default heuristics

### Prefer `reference-only` when:

- the capability is mostly for reference ergonomics
- it explains or inspects the reference implementation
- it is tightly coupled to the reference UI or local hosting story

### Prefer `extension` when:

- the capability is public and useful
- clients can benefit from it immediately
- it is not yet mature enough to require everywhere
- it can be declared honestly in metadata

### Prefer `profile` when:

- the capability is really a bundle
- the bundle has its own workflow and boundary
- multiple implementations could claim it coherently

### Prefer `core` when:

- serious clients written once for many owners materially depend on it
- the semantics are stable and portable
- the ecosystem cost of optionality would be worse than the cost of mandating it

### Keep it an `implementation detail` when:

- exposing it would not help clients
- exposing it would mostly freeze internal choices prematurely

## Worked examples from the current repository

### `_ref/*` trace and control-plane surfaces

Current best classification: `reference-only`

Why:

- they are explicitly for debugging, replay, operator inspection, and reference credibility
- the architecture spec already treats them as reference-designated, not core PDPP
- other implementations should not be forced to copy them

### Provider-connect

Current best classification: `companion profile`

Why:

- this is not one feature; it is a workflow bundle
- it includes metadata, request staging, registration/bootstrap, approval flows, and related client behavior
- the reference already describes it as a thin provider-connect profile rather than as ambient core

### Lexical retrieval over authorized records

Current best classification: `optional extension`, with a real possibility of later promotion

Why:

- it is public and clearly valuable
- it is much less opinionated than semantic retrieval
- capability discovery is likely appropriate
- serious clients may eventually make a strong case for core, but that has not been fully decided yet

### Semantic retrieval / embeddings

Current best classification: `extension` or `reference-first experiment`, not core

Why:

- model choice, versioning, language bias, storage/index implications, and export consequences are all still highly opinionated
- the repo's open-question notes explicitly show unresolved portability and versioning cost

### Composed browser mode, hosted HTML flows, placeholder owner password

Current best classification: `reference-only`

Why:

- these are important reference product behaviors
- they improve local usability
- they do not describe portable PDPP protocol behavior

### Storage engine, tokenizer, vector backend, ranking formula

Current best classification: `implementation detail`

Why:

- clients should care about the exposed capability and its declared semantics, not the hidden machinery

## Promotion and demotion

A capability can move up the ladder, but should only do so explicitly.

### Promotion examples

- `reference-only` -> `extension`
  - when a feature becomes public, discoverable, and intentionally reusable by non-reference clients

- `extension` -> `core`
  - when the ecosystem cost of optionality becomes worse than the implementation cost of requiring it

- `reference-only bundle` -> `profile`
  - when a cluster of related surfaces becomes a coherent portable mode

### Demotion examples

- `extension` -> `reference-only`
  - when the surface turns out to be too implementation-specific to define honestly

- `candidate core feature` -> `extension`
  - when research reveals excessive opinionation or poor portability

## Process rule

When a feature materially changes the public surface of PDPP or the reference, contributors should explicitly classify it on this ladder rather than leaving its status ambient.

The minimum useful question is:

> Is this core, a companion profile, an optional extension, reference-only, or just an implementation detail?

If the answer is not written down, the feature is likely to drift into accidental de facto standardization.

## Present owner read

Based on the current repository state and research:

- `core PDPP` should remain small and strict
- `companion profiles` are the right tool for coherent optional workflow bundles
- `extensions` are the right tool for public optional capabilities with real value but unsettled universality
- `reference-only` should remain a first-class category, not an embarrassment
- `implementation details` should stay hackable as long as public behavior is declared truthfully

That is the decision discipline this repository should use going forward.
