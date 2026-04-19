# PDPP Status Map -- Decision Memo

Date: 2026-04-08

---

## Bottom line

PDPP has two normative documents (spec-core.md and spec-collection-profile.md), one likely-superseded companion (spec-data-query-api.md), and everything else is informational, reference, or experimental. The highest-value immediate action is adding explicit status labels to every spec-*.md file so that readers, agents, and future authors never have to guess which documents carry normative weight. The second-highest-value action is resolving the spec-data-query-api.md duplication before it causes a real interop disagreement.

---

## 10 highest-value classifications

These are the ones that matter most for reducing confusion:

| # | Artifact | Classification | Why it matters |
|---|----------|---------------|----------------|
| 1 | `spec-core.md` | **Normative core spec** | The single source of truth for the protocol. All conformance definitions, all MUST requirements. No ambiguity. |
| 2 | `spec-collection-profile.md` | **Normative companion** | The only other normative document. Tier 2 conformance (ingest, state, freshness) derives from here, not Core. |
| 3 | `spec-data-query-api.md` | **Likely superseded** | Written before Core Section 8 was expanded. Now duplicates Core with minor inconsistencies. Must be resolved. |
| 4 | Three semantic classes (Section 5) | **Shared semantics, housed in Core** | The attribution split and consent-surface rendering obligations are the protocol's most distinctive normative property. They govern all future profiles. |
| 5 | RECORD envelope (Section 4) | **Shared semantics, housed in Core** | The universal data shape used by both Core disclosure and Collection Profile ingest. Any new profile inherits it. |
| 6 | `mock-server.ts` | **Reference architecture, not normative** | Encodes spec requirements and claims real enforcement. Useful as a secondary conformance check, but the spec text wins when they disagree. |
| 7 | PDPP components (consent-card, grant-inspector, etc.) | **Reference architecture** | They demonstrate normative consent surface requirements (attribution, three layers). The what is reference; the how (React, CSS) is implementation detail. |
| 8 | `spec-architecture.md` | **Informational, not normative** | Has no MUST/SHOULD/MAY. Contains a now-incorrect table claiming the RS API is not normatively defined. Needs a correction note. |
| 9 | `spec-deferred.md` | **Experimental parking lot** | Stable as a catalog of future concerns. The subset template design direction constrains future versions but is not itself normative. |
| 10 | `spec-change-tracking.md` | **Design rationale for normative content** | The decision (grant-relative sync, not canonical changelogs) is settled and encoded in Core. This document explains why. Authority is Core, not this file. |

---

## 5 biggest ambiguities to watch

### 1. spec-data-query-api.md is a latent spec conflict

Core Section 8 and spec-data-query-api.md define the same endpoints with minor differences (`prev_cursor`, `expandable` vs `relationships`, simpler error codes). If an implementer reads one and not the other, they may build a non-conformant RS. This is the highest-priority cleanup.

**Action:** Deprecate spec-data-query-api.md with a pointer to Core Section 8, or reconcile and explicitly mark which is authoritative.

### 2. The VitePress sidebar implies wrong normative weight

spec-architecture.md is grouped under "Collection Profile" but covers the whole system. spec-auth-design.md is grouped under "Core Protocol" but is a design rationale document. spec-change-tracking.md is under "Design Notes" but contains normative substance (restated from Core). The sidebar is the reader's first classifier.

**Action:** Add status badges to sidebar entries, or regroup to match actual normative weight.

### 3. The mock server's relationship to the planned conformance test suite

The mock server enforces spec requirements. The spec says a conformance test suite is planned (Section 9). When the test suite is built, should it be derived from the mock server's behavior, from the spec text directly, or from both? The mock server may have encoded interpretations of the spec that are subtly wrong.

**Action:** When building the test suite, derive tests from spec text (Sections 8-9), then validate against mock server behavior. Treat disagreements as potential spec bugs, not mock server bugs.

### 4. demo_archived/CONSTITUTION.md: active philosophy, archived artifact

The reviewer onboarding memo says CONSTITUTION.md "still contains authoritative design philosophy for the reference." The build target is archived (demo_archived/). The design principles, surface temperature rules, and trust model rendering rules are active decisions that govern the apps/web/ implementation.

**Action:** Either migrate the active philosophy content to a living document in docs/ or apps/web/, or add a clear pointer from the archived location to the current implementation.

### 5. Where normative consent-surface requirements end and reference design begins

The spec requires preserving semantic distinctions between protocol-enforced terms, structured policy, manifest descriptions, and client claims (conformance item 7). But it explicitly does not standardize consent screen layout, visual design, or copywriting. The PDPP components implement both the normative requirements (attribution, three layers) and opinionated design choices (copper/blue temperature, card layouts, monogram for unverified clients). The boundary between "you must do this" and "we chose to do it this way" is not marked in the component code.

**Action:** Consider adding inline comments or a companion document that maps each component behavior to its source: normative requirement (cite spec section) vs. reference design choice (cite CONSTITUTION.md or experience-architecture.md). This helps future implementers know which behaviors they must replicate and which they may vary.
