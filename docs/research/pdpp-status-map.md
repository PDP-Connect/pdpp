# PDPP Status Map

Date: 2026-04-08

---

## Executive summary

PDPP contains roughly 30 distinct artifacts spanning spec documents, design notes, research docs, a reference implementation (in-memory mock server + React components), a Node.js e2e implementation, shared brand infrastructure, and planning documents. Most artifacts have a clear home in the classification scheme below, but several straddle boundaries in ways that matter for future authors and agents. The biggest source of confusion is not misclassification but the absence of explicit labels: the VitePress sidebar groups spec-architecture.md with the Collection Profile and groups spec-change-tracking.md under "Design Notes," but the actual normative weight of those documents is determined by their content, not their sidebar placement. This map resolves that.

---

## Status bucket definitions

1. **Normative core spec** -- Defines MUST/SHOULD/MAY requirements that all conformant implementations follow. The wire format, grant schema, RS enforcement rules, conformance definitions. If you violate it, you are not PDPP-conformant.

2. **Normative companion/profile** -- Defines requirements for a specific mode of operation that is optional relative to Core but normative for implementations claiming support. The Collection Profile is the primary example: you do not need it for a Core RS, but if you claim Collection Profile support you MUST implement it.

3. **Shared semantics** -- Concepts, message formats, or field definitions intended to be reused across multiple profiles or specs. The RECORD envelope, stream semantics (append_only/mutable_state), the three semantic classes, the purpose code registry. These are defined in Core but are load-bearing for companion specs too.

4. **Reference architecture** -- Implementation that demonstrates the spec but is not itself normative. The reference page, mock server, PDPP components, design system, e2e implementation. A conformant implementation may ignore all of this and still be conformant.

5. **Implementation detail** -- Code, config, or tooling that supports the project but has no spec significance. Build config, CSS tokens, VitePress config, package scaffolding, React component internals.

6. **Experimental / not yet committed** -- Research, proposals, planning docs, and deferred concerns that have not been committed to the spec or reference. May influence future versions but carry no current authority.

---

## Classification table

### Spec documents (repo root)

| Artifact | Current Status | Why | Stability |
|----------|---------------|-----|-----------|
| `spec-core.md` (Sections 1-12, Appendices A-B) | **Normative core spec** | Defines all MUST/SHOULD/MAY requirements: grant schema (Section 6), selection request format (Section 5), RS interface (Section 8), conformance (Section 9), record model (Section 4), manifest format (Section 7), security considerations (Section 10), scope boundaries (Section 11), TypeScript types (Section 12, illustrative). Contains the complete protocol. | Stable -- v0.1.0 Draft, actively maintained |
| `spec-collection-profile.md` | **Normative companion/profile** | Defines the connector run protocol (START/RECORD/STATE/INTERACTION/DONE), manifest extensions, runtime binding matching, scope fields, and conformance for connectors and runtimes. Required only for Collection Profile claimants. | Stable -- v0.1.0 Draft |
| `spec-data-query-api.md` | **Ambiguous: normative or superseded** | Defines the same RS HTTP endpoints that spec-core.md Section 8 now defines. Originally a separate companion spec. Since Section 8 of Core was expanded to include all the same endpoints (list streams, list records, get blob, ingest, sync state, errors, versioning), this file is now substantially duplicative. Some details differ (e.g., `prev_cursor` mentioned here but not in Core; `expandable` metadata field vs `relationships`; no `changes_since` in the original query API). See Key Ambiguities below. | **In-motion** -- likely needs deprecation or reconciliation |
| `spec-architecture.md` | **Informational / reference architecture** | An illustrated overview of system components and flows. Contains no MUST/SHOULD/MAY language. Describes Flows A-D, versioning patterns, freshness strategy, and a "what the spec defines vs what it doesn't" table. The VitePress sidebar places it under "Collection Profile" but its content covers the whole system. | Stable -- informational |
| `spec-auth-design.md` | **Informational / design rationale** | Records the design decision for bearer tokens at both boundaries. No normative requirements -- references what spec-core.md mandates and explains why. Maps existing Vana stack to PDPP boundaries. Industry patterns section. | Stable -- rationale document |
| `spec-change-tracking.md` | **Shared semantics (design rationale + normative content)** | Documents the decision to use grant-relative incremental sync instead of canonical changelog streams. The "How it works" section restates normative requirements from Core (projection-aware deltas, tombstones, cursor expiry). The "Why not canonical streams" section is design rationale. The substance is normative but the authority lives in spec-core.md Section 4 and Section 8. | Stable -- the design decision is settled |
| `spec-deferred.md` | **Experimental / not yet committed** | Explicitly catalogs concerns out of scope for v0.1. Contains future design directions (subset templates, active erasure, re-interaction, freshness requirements, source lifecycle actions, event-driven triggers, canonical view naming, AS interface, point-in-time reconstruction). Some items (predicate-based grant scoping) include recommended design directions that constrain future versions. | Stable as a parking lot; contents are unstable |
| `spec-dti-alignment.md` | **Experimental / not yet committed** | Research on DTI's receptiveness and strategic framing for engagement. No spec-level content. Pure positioning and engagement strategy. | Stable -- historical research |
| `spec-e2e-examples.md` | **Informational / reference architecture** | Three end-to-end examples marked "Illustrative" at the top. Explicitly states normative documents win when examples differ. Covers single_use with consent rendering, continuous with grant-scoped state, and retention/revocation. | Stable -- illustrative |
| `spec-connector-ecosystem.md` | **Experimental / not yet committed** | Browser abstraction decision (Model A vs B), catalog of third-party tools that could become connectors, runtime requirements landscape. No normative content. Research and ecosystem planning. | Stable -- historical research |

### Shared semantic concepts (defined in Core but cross-cutting)

| Concept | Where Defined | Status | Why | Stability |
|---------|--------------|--------|-----|-----------|
| RECORD envelope (stream, key, data, emitted_at, op) | spec-core.md Section 4 | **Shared semantics** | Used by both Core RS (query responses) and Collection Profile (connector output). The canonical data shape. | Stable |
| Stream semantics (append_only, mutable_state) | spec-core.md Section 4 | **Shared semantics** | Determines version history requirements (Core) and incremental sync behavior (Collection Profile). | Stable |
| Three semantic classes (protocol-enforced, structured policy, attributed claims) | spec-core.md Section 5 | **Shared semantics** | Governs consent surface rendering obligations. Cross-cuts AS conformance, reference components, and future profiles. | Stable |
| Purpose code registry (Appendix A) | spec-core.md Appendix A | **Shared semantics** | URI-based purpose codes used by selection requests and grants. Extensible by any implementation. `ai_training` carries a unique protocol-level consent rule. | Stable |
| Tombstone format | spec-core.md Section 4 | **Shared semantics** | Same envelope (object: "record", deleted: true) used in RS responses and potentially in Collection Profile delete directives. | Stable |
| consent_time_field | spec-core.md Section 7 | **Shared semantics** | Used by AS (grant validation), RS (time_range enforcement), and manifest authors. Absence is the normative signal that time-range is unsupported. | Stable |

### Documentation (docs/)

| Artifact | Current Status | Why | Stability |
|----------|---------------|-----|-----------|
| `docs/personas/pdpp-reviewer-onboarding.md` | **Experimental / not yet committed** | Onboarding memo for a reviewer persona. Contains the most comprehensive repo layout section. Records already-decided design choices and the state of the review conversation. Operational document, not spec content. | In-motion -- updated as review progresses |
| `docs/personas/standards-editor-reviewer.md` | **Experimental / not yet committed** | Full persona specification for a standards reviewer. Persona definition, not protocol content. | Stable |
| `docs/concept-inventory.md` | **Experimental / not yet committed** | 85 concepts tagged by flow position and audience. Enumerates what the reference should convey. Planning artifact for the reference page, not normative. | Stable |
| `docs/experience-architecture.md` | **Experimental / not yet committed** | Detailed design document for the reference page structure (Illustrated Protocol paradigm, 11 sections, global state architecture, Gemini review feedback). Describes how the reference should work, not what the protocol requires. | In-motion -- actively being implemented |
| `docs/full-vision.md` | **Experimental / not yet committed** | Honest statement of the full ambition, what has been built, and what gaps remain. Planning and self-assessment document. | In-motion |
| `docs/critique-action-plan.md` | **Experimental / not yet committed** | Action items from design critique. Implementation planning. | In-motion |
| `docs/demo-v2-implementation-plan.md` | **Experimental / not yet committed** | Implementation plan for the reference page rebuild. | In-motion |
| `docs/reference-audit.md` | **Experimental / not yet committed** | Audit of the reference page against criteria. | In-motion |
| `docs/reference-design-research.md` | **Experimental / not yet committed** | Research on Martini Glass, C4, Illustrated TLS presentation patterns. | Stable -- historical research |
| `docs/research/attribution-split-prior-art.md` | **Experimental / not yet committed** | Prior art research on whether PDPP's trust-model rendering obligation is novel (P3P, TCF, Apple labels, HAIP). Found no existing protocol that mandates attribution rendering normatively. | Stable -- completed research |
| `docs/research/collection-prior-art-deep-dive.md` | **Experimental / not yet committed** | Deep dive on collection prior art (Airbyte, Singer, etc.). | Stable -- completed research |
| `docs/inbox/pdpp_memo.txt` | **Experimental / not yet committed** | Gemini 3.1 Pro review memo. External critique. | Stable -- historical |
| `docs/inbox/pdpp_memo_chatgpt.txt` | **Experimental / not yet committed** | ChatGPT 5.4 review memo. External critique. Identified the promise-surface/enforcement-surface distinction as the highest-leverage editorial fix. | Stable -- historical |
| `docs/inbox/collection-profile-prior-art-memo.md` | **Experimental / not yet committed** | Collection profile prior art research. | Stable -- historical |
| `docs/inbox/design-sidebar-slvp-plan.md` | **Experimental / not yet committed** | Design sidebar planning. | In-motion |

### Reference implementation (apps/web/)

| Artifact | Current Status | Why | Stability |
|----------|---------------|-----|-----------|
| `apps/web/src/lib/mock-server.ts` | **Reference architecture** | In-memory PDPP server that enforces field projection, computes incremental deltas, refuses revoked grants, and supports self-export. The header explicitly states "This is NOT a toy mock -- it enforces the same constraints as a real RS." It encodes spec requirements but is not normative. | In-motion |
| `apps/web/src/lib/use-protocol.ts` | **Reference architecture** | React hook that drives the reference page from the mock server. Manages the protocol state machine (idle/granted/revoked). Swappable for real HTTP calls. | In-motion |
| `apps/web/src/components/pdpp/consent-card.tsx` | **Reference architecture** | Implements the consent surface rendering obligations from Section 5 (attribution split, three content layers, display metadata authorship). Went through multi-model SLVP review. Quality bar is locked. | Stable |
| `apps/web/src/components/pdpp/grant-inspector.tsx` | **Reference architecture** | Visualizes grant objects from Section 6. Shows streams, fields, time ranges, access mode, retention, status. | Stable |
| `apps/web/src/components/pdpp/stream-inventory.tsx` | **Reference architecture** | Displays stream metadata (record counts, semantics, sync status). | Stable |
| `apps/web/src/components/pdpp/connector-card.tsx` | **Reference architecture** | Renders connector manifest data (streams, capabilities, profiles). | Stable |
| `apps/web/src/components/pdpp/spec-citation.tsx` | **Reference architecture** | Links reference page sections back to spec sections on the VitePress site. | Stable |
| `apps/web/src/components/ReferenceApp.tsx` | **Reference architecture** | 11-section Illustrated Protocol page. Contains section content, protocol flow stepper, field projection animation, incremental sync animation. Drives global state through sections 4-8. | In-motion |
| `apps/web/src/app/page.tsx` | **Implementation detail** | Next.js page wrapper. Just renders ReferenceApp with a Hero. | Stable |
| `apps/web/src/components/Hero.tsx` | **Implementation detail** | Hero component for the landing page. Visual shell, no protocol semantics. | Stable |
| `apps/web/src/components/SiteHeader.tsx` | **Implementation detail** | Navigation header. | Stable |
| `apps/web/src/lib/seed-data.ts` | **Implementation detail** | Seed data for the mock server. | Stable |
| `apps/web/src/lib/spec-refs.ts` | **Implementation detail** | Spec section reference mapping for citations. | Stable |
| `apps/web/src/lib/types.ts` | **Implementation detail** | TypeScript type definitions for the reference app. | Stable |
| `apps/web/src/app/design/` | **Reference architecture** | Design system workbench page. Same components as reference, with specimen switchers for all spec axes. | In-motion |
| `apps/web/src/app/docs/` | **Implementation detail** | Fumadocs integration for spec rendering. | Stable |

### E2E reference implementation (e2e/)

| Artifact | Current Status | Why | Stability |
|----------|---------------|-----|-----------|
| `e2e/server/index.js` | **Reference architecture** | Express server implementing the RS interface (query endpoints, ingest, state management). The "real" reference implementation the owner wants implementers to read. | In-motion |
| `e2e/server/records.js` | **Reference architecture** | Query logic including `changes_since` with projection-aware deltas. Contains the confirmed-then-fixed projection-leak bug path. The privacy property reviewers should verify. | In-motion |
| `e2e/server/auth.js` | **Reference architecture** | Authentication logic for owner/client token distinction. | In-motion |
| `e2e/server/db.js` | **Reference architecture** | SQLite database layer for record storage and version history. | In-motion |
| `e2e/runtime/index.js` | **Reference architecture** | Connector runtime implementing START/RECORD/STATE/DONE protocol. | In-motion |
| `e2e/client/demo.js` | **Reference architecture** | Client demonstrating the full protocol flow (request, consent, query, sync). | In-motion |
| `e2e/manifests/github.json`, `spotify.json`, `reddit.json` | **Reference architecture** | Example connector manifests conforming to Section 7. | Stable |
| `e2e/connectors/github/`, `spotify/`, `reddit/` | **Reference architecture** | Working connector implementations using the Collection Profile protocol. | In-motion |
| `e2e/test/pdpp.test.js` | **Reference architecture** | E2E tests covering projection, incremental sync, revocation, tombstones. | In-motion |

### Shared packages (packages/)

| Artifact | Current Status | Why | Stability |
|----------|---------------|-----|-----------|
| `packages/pdpp-brand/base.css` | **Implementation detail** | Design tokens: colors, spacing, typography. Includes the temperature system (human=copper, protocol=blue). | Stable -- locked per design decisions |
| `packages/pdpp-brand/app.css` | **Implementation detail** | Application-specific CSS for the reference app. | Stable |
| `packages/pdpp-brand/docs.css` | **Implementation detail** | CSS for VitePress spec site. | Stable |
| `packages/pdpp-brand/chrome.js` | **Implementation detail** | Navigation configuration for the VitePress site (siteNav export). | Stable |

### Build and config

| Artifact | Current Status | Why | Stability |
|----------|---------------|-----|-----------|
| `.vitepress/config.ts` | **Implementation detail** | VitePress configuration. The sidebar structure here is the source of some classification confusion (see Key Ambiguities). | Stable |
| `.claude/working-state.md` | **Experimental / not yet committed** | Current steering constraints and evaluation lens. Refreshed by hook. | In-motion -- ephemeral |
| `demo_archived/CONSTITUTION.md` | **Experimental / not yet committed** | Five design principles, surface temperature rules, trust model rendering rules for the reference. Still contains authoritative design philosophy per the reviewer onboarding memo, but the build target is archived. | Ambiguous -- philosophy is active, artifact is archived |

---

## Key ambiguities and boundary tensions

### 1. spec-data-query-api.md: separate spec or superseded by Core?

**Tension:** This file was written as a companion spec (Date: 2026-03-28, before Core Section 8 was expanded). Core Section 8 now covers the same endpoints with more detail (changes_since, tombstones, freshness metadata, error codes, collection profile endpoints). The two documents have minor inconsistencies: the query API mentions `prev_cursor` and `expandable` metadata; Core uses `relationships` and does not mention `prev_cursor`. The query API's ingest and sync state sections are simpler than Core's.

**Classification:** Currently informational / partially superseded. If it were still normative, the inconsistencies with Core would be spec bugs.

**Recommendation:** Either deprecate spec-data-query-api.md with a pointer to Core Section 8, or reconcile the differences and mark it as a normative companion that extends Core's RS interface. Do not leave both claiming authority over the same endpoints.

### 2. spec-architecture.md: normative or informational?

**Tension:** The VitePress sidebar places it under "Collection Profile," but its content covers the whole system (Flows A-D, versioning, freshness). It contains no MUST/SHOULD/MAY language. The "What the spec defines vs what it doesn't" table says "Personal server API: No (reference only)" -- which contradicts Core Section 8, which does normatively define the RS API.

**Classification:** Informational. Written before Core was expanded. The table at line 121 is now partly wrong (Core does define the personal server query API normatively).

**Recommendation:** Add a note at the top that this is an informational overview, not normative. Update the table to reflect that Core Section 8 now normatively defines the RS query interface.

### 3. Where do the semantic classes live -- Core or shared semantics?

**Tension:** The three semantic classes (protocol-enforced, structured policy, attributed claims) are defined in spec-core.md Section 5 and are explicitly normative (conformance item 7 requires AS implementations to preserve these distinctions). But they are architecturally cross-cutting: they govern how any future profile's consent surface should work, not just Core.

**Classification:** Defined in Core, but function as shared semantics. This is correct for v0.1 since Core is the only normative document that defines consent surface requirements. If additional profiles are created (e.g., a health data profile with specialized consent requirements), the semantic classes would need to be referenced from or promoted to a shared semantics layer.

**Recommendation:** No action needed for v0.1. Note that the semantic classes are architecturally shared even though they are editorially housed in Core.

### 4. Does the mock server encode testable spec requirements?

**Tension:** `mock-server.ts` explicitly claims "it enforces the same constraints as a real RS." It implements field projection, grant status checking, stream membership validation, incremental sync, and self-export. These behaviors directly correspond to Core RS conformance items 1-12. But the mock server is not referenced by the spec and has no normative status.

**Classification:** Reference architecture. It encodes spec requirements but is not the authority for those requirements. The authority is Core Section 8 and Section 9.

**Recommendation:** The mock server should be treated as a secondary conformance oracle -- useful for testing understanding, but the spec text is authoritative when they disagree. Future work: the planned conformance test suite (Section 9) should be derived from the spec text, not from the mock server.

### 5. Are the PDPP components (ConsentCard, etc.) reference architecture or implementation detail?

**Tension:** The components implement spec-level requirements (consent surface attribution, three content layers, display metadata authorship). The ConsentCard went through multi-model SLVP review. But they are React components for a specific UI framework, not a portable reference.

**Classification:** Reference architecture. They demonstrate normative consent surface requirements (Section 5, conformance item 7) in a way that other implementations can study. The design decisions they embody (attribution rendering, unverified logo suppression, commitment disclaimer) are normatively required. The React/CSS specifics are implementation detail.

**Recommendation:** No change needed. The components correctly straddle the line: the what they render is reference architecture; the how they render it (React, Tailwind, CSS custom properties) is implementation detail.

### 6. Design tokens and the temperature system

**Tension:** `packages/pdpp-brand/base.css` defines the human/protocol temperature system (copper for human surfaces, blue for protocol surfaces). This system is referenced by `demo_archived/CONSTITUTION.md` and by the experience architecture as load-bearing design decisions. But the spec says nothing about visual design -- consent surface semantic rendering is normative, visual rendering is not.

**Classification:** Implementation detail. The temperature system is a design decision for this reference implementation. A conformant AS could use entirely different colors and still satisfy the semantic rendering requirements.

**Recommendation:** No change. The temperature system is an opinionated design choice, not a spec concern.

### 7. VitePress sidebar grouping vs actual document status

**Tension:** The sidebar groups spec-architecture.md under "Collection Profile" (it covers the whole system), spec-change-tracking.md under "Design Notes" (it contains normative substance), and spec-auth-design.md under "Core Protocol" (it is a design rationale document, not normative). The sidebar is the primary navigation for readers of the spec site, so these groupings create wrong impressions about normative weight.

**Recommendation:** Realign sidebar labels with actual document status. Possible structure: "Core Protocol" (spec-core.md only), "Companion Profiles" (spec-collection-profile.md), "Design Rationale" (spec-architecture.md, spec-auth-design.md, spec-change-tracking.md, spec-data-query-api.md), "Examples" (spec-e2e-examples.md), "Future" (spec-deferred.md). Or add a status badge to each entry.

---

## Recommended immediate labeling cleanups

1. **Add a status line to every spec-*.md file.** Each file should have a machine-readable status after the title: `Status: Normative`, `Status: Informational`, `Status: Superseded by spec-core.md Section 8`, `Status: Deferred`, etc. Currently only spec-core.md and spec-collection-profile.md have "Status: Draft."

2. **Resolve spec-data-query-api.md.** Either deprecate it (add a note at the top pointing to Core Section 8) or reconcile it with Core. The current state where both define the same endpoints with minor differences is a spec-quality issue.

3. **Update spec-architecture.md line 121-125.** The "What the spec defines" table says the personal server API is "reference only." Core Section 8 now normatively defines it. The table is wrong.

4. **Realign VitePress sidebar grouping.** See recommendation in ambiguity 7 above.

5. **Label demo_archived/CONSTITUTION.md.** Its design philosophy is still active (per the reviewer onboarding memo) but the build target is archived. Add a note directing readers to the current implementation in `apps/web/`.

---

## Bottom-line guidance for future agents and authors

- **When implementing:** Core Section 8 (RS interface) and Section 9 (conformance) are the authorities. The mock server and e2e implementation demonstrate these requirements but do not define them.

- **When writing spec text:** Only spec-core.md and spec-collection-profile.md carry normative weight. Everything else is informational, research, or planning. Do not cite spec-architecture.md or spec-change-tracking.md as normative sources.

- **When building components:** The PDPP components in `apps/web/src/components/pdpp/` demonstrate normative consent surface requirements. The three content layers (protocol facts, manifest descriptions, client claims) and the attribution rendering are required by the spec. The specific UI patterns (cards, copper/blue temperature) are opinionated reference choices.

- **When classifying new artifacts:** Ask two questions. (1) Does it define a MUST/SHOULD/MAY requirement? If yes, it is normative and belongs in spec-core.md or a companion profile. (2) Does it demonstrate a normative requirement? If yes, it is reference architecture. Everything else is implementation detail or experimental.

- **The shared semantics bucket matters most for extensibility.** The RECORD envelope, stream semantics, semantic classes, and purpose registry are the cross-cutting concepts that any future profile will need. They live in Core today but should be recognized as shared infrastructure.
