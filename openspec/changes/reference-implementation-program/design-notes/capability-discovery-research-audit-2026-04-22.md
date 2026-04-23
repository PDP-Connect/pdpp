# Capability discovery research audit — 2026-04-22

**Status:** owner audit of existing research coverage
**Author:** Codex (owner agent)

## Purpose

Audit what relevant capability-discovery research is already captured on disk versus what still needs deliberate work before PDPP chooses a longer-haul discovery model.

This note follows the framing note:

- `openspec/changes/reference-implementation-program/design-notes/capability-discovery-framing-2026-04-22.md`

It does **not** decide the discovery model yet. It only answers:

- what is already documented well enough to rely on
- what is only partially documented
- what still needs targeted research before the decision reaches the desired standard

## Summary

The repo already contains enough research to justify the **overall direction**:

- capability discovery should be explicit rather than inferred
- PDPP should prefer a layered design over one flat global query contract
- Stripe/Plaid are the right quality bar for contract publication and ergonomics
- Open Banking / FDX / FAPI and SMART on FHIR / FHIR are the stronger comparators for normative ecosystem-scale semantics
- RFC 9728 and RFC 8414 already give PDPP a strong precedent for reusing adjacent discovery surfaces rather than inventing bespoke well-known documents casually

But the repo does **not** yet contain enough capability-discovery-specific analysis to choose confidently among:

- stream-only discovery
- layered server + stream discovery
- a broader capability document

So the state is:

- **directional legwork:** strong
- **final capability-discovery decision support:** incomplete

## Already documented strongly

### 1. PDPP design-principle lens

The current research and Core spec already document the principles that should constrain capability discovery:

- manifests define consent surface
- grants define actual consent
- authorization, disclosure, and collection are distinct concerns
- request-time narrowing must not become shadow grant semantics
- human reviewability and data minimization matter

Primary sources already on disk:

- `spec-core.md`
- `docs/concept-inventory.md`
- `record-query-contract-research-2026-04-21.md`

Assessment:

- strong enough to use as a stable evaluation lens now

### 2. Comparator weighting

The repo already captures the right split among comparators:

- **Open Banking / FDX / FAPI** for consented cross-provider access and ecosystem governance
- **SMART on FHIR / FHIR** for typed search and explicit capability declaration
- **Stripe / Plaid** for contract quality, generated artifacts, bounded power, and developer trust
- **SCIM** as a secondary protocol/discovery reference
- **OData** mainly as a cautionary reference

Primary source already on disk:

- `record-query-contract-research-2026-04-21.md`

Assessment:

- strong enough to use as the comparator map for the next pass

### 3. Layered-contract direction

The repo already records the key layout implication:

- keep a small global core
- declare higher-risk power explicitly
- maintain a truthful machine-readable reference contract

Primary sources already on disk:

- `record-query-contract-proposed-direction-2026-04-21.md`
- `record-query-contract-research-2026-04-21.md`
- `reference-implementation-execution-plan-2026-04-21.md`

Assessment:

- strong enough to preserve as the current default direction unless a stronger capability-discovery alternative displaces it

### 4. Existing PDPP precedent for metadata reuse over bespoke discovery

The repo already contains a very relevant precedent from the provider-connect/auth side:

- prefer RFC 9728 protected-resource metadata plus RFC 8414 authorization-server metadata
- only introduce a PDPP-specific well-known document if those adjacent standards prove insufficient

Primary sources already on disk:

- `docs/archive/2026-04-inbox-retired/pdpp-provider-connect-profile-draft.md`
- `docs/archive/2026-04-inbox-retired/pdpp-provider-connect-profile-outline.md`
- `docs/archive/2026-04-inbox-retired/reference-implementation-owner-decisions-2026-04-16.md`

Assessment:

- strong enough to matter as design precedent
- especially relevant to the `composable` and `elegant` rubric criteria

This does **not** decide the record-query capability model by itself, but it is a serious prior decision pattern inside PDPP:

- reuse existing adjacent discovery surfaces first
- only add a bespoke layer when a concrete gap remains

### 5. Stripe/Plaid/JSON:API/FHIR/OData lessons for query power

The current research note already captures the main lessons we need from these comparators:

- explicit, bounded expansion
- typed search behavior
- strict failure for unsupported shapes
- truthful machine-readable contracts
- caution against broad generic query grammars

Primary source already on disk:

- `record-query-contract-research-2026-04-21.md`

Assessment:

- strong enough for the general direction
- not yet specific enough for the final capability-discovery-structure decision

## Partially documented, but not yet sufficient

### 1. FHIR capability structure

What is already captured:

- `CapabilityStatement` is relevant
- `SearchParameter` is relevant
- FHIR teaches explicit capability declaration and typed search semantics

What is still missing:

- a sharper read of **which parts** of the FHIR pattern are actually useful here:
  - resource-level declarations
  - operation/search declarations
  - global vs per-resource capability split
  - whether PDPP needs anything analogous to standalone `SearchParameter` resources

Assessment:

- partial
- needs a focused extraction from primary FHIR sources before choosing between candidate discovery models

### 2. SCIM discovery lessons

What is already captured:

- `ServiceProviderConfig` is relevant
- SCIM shows schema extensibility plus discovery endpoints

What is still missing:

- whether SCIM's actual split among:
  - `ServiceProviderConfig`
  - `Schemas`
  - `ResourceTypes`
  offers a useful pattern for PDPP capability discovery or mostly serves as a cautionary reference

Assessment:

- partial
- needs a short, deliberate read rather than broad additional research

### 3. Open Banking / FDX capability-discovery details

What is already captured:

- governance/security scale and relevance
- strong evidence that cross-provider consented data ecosystems can work

What is still missing:

- a more capability-discovery-specific read:
  - where these ecosystems publish supported behavior
  - how much is global profile versus endpoint/resource-specific
  - whether their discovery approach teaches anything beyond auth/security metadata

Assessment:

- partial
- current note is strong on ecosystem relevance, weaker on actual capability-document shape

### 4. OAuth metadata-family lessons for extension strategy

What is already captured:

- RFC 8414 and RFC 9728 support explicit metadata publication
- PDPP already reuses them for provider-connect discovery

What is still missing:

- a sharper extraction of the extension lesson:
  - when is extending an existing metadata document better than creating a sibling document?
  - what makes an extension feel elegant versus overloaded?

Assessment:

- partial
- this is a narrow design-analysis gap, not a broad research gap

## Still missing and should be done deliberately

### 1. Explicit candidate-model comparison

The repo does **not** yet contain a side-by-side comparison of:

- stream-only discovery
- layered server + stream discovery
- broader capability document

against:

- the frozen rubric
- concrete scenarios

This is the most important missing artifact.

### 2. Scenario-based evaluation

The repo does **not** yet contain the scenario walk-through promised by the framing note, such as:

- stream with exact filters only
- stream with one declared range-filter field
- stream with one expandable relation
- stream with no extra query power
- client/agent generating valid requests ahead of trial-and-error
- future implementation that supports more than the current reference

This is required to test `stream-safe`, `incremental`, and `machine-readable`.

### 3. Mapping from candidate models to actual PDPP layers

The repo still lacks a crisp mapping table showing how each candidate model would interact with:

- manifest metadata
- stream metadata
- protected-resource metadata
- authorization-server metadata
- OpenAPI/reference-contract artifacts
- reference-only `/_ref` surfaces

This is required to test `composable` and `elegant`.

## Audit conclusion

The project has already done enough legwork to avoid starting from zero.

What we **do not** need:

- another broad “what can modern APIs teach us?” detour
- another general prior-art pass on Stripe/Plaid quality
- more generic discussion of why explicit capability discovery is good

What we **do** still need before choosing the model:

1. a focused primary-source extraction on:
   - FHIR capability structure
   - SCIM discovery structure
   - Open Banking / FDX capability-publication shape
   - OAuth metadata extension strategy
2. a candidate-model comparison against the frozen rubric
3. a scenario-based evaluation

So the correct next posture is:

- **not** “start researching from scratch”
- **not** “decide now based only on intuition”
- **yes** “run a focused, capability-discovery-specific comparison pass using the research base already captured”
