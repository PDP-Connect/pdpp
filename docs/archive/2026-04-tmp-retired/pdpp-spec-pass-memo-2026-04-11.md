# PDPP Spec Work Memo

Date: 2026-04-11
Repo: `<pdpp>`
Author: Codex

## Purpose

This memo records the spec-side work I completed after the user clarified that the priority was:

1. continue the PDPP thoughtwork already underway,
2. make spec changes first,
3. prioritize changes that cash out in observable e2e behavior,
4. avoid drifting into implementation cleanup or formal-adoption-only edits.

The through-line of the work was to reduce the "truth gap": make the draft more explicit about what PDPP actually enforces, what it only declares, and what an implementation must do to honestly claim conformance.

## High-level outcome

I made a multi-pass spec revision across the core and companion docs. The main effects were:

- the draft now distinguishes protocol-enforced constraints from structured policy declarations and client-attributed claims much more explicitly;
- `single_use`, `changes_since`, revocation/deletion, and state semantics are sharper and more implementation-visible;
- `freshness` is defined as response-side server-observed metadata instead of a fake grant-time guarantee;
- the Collection Profile no longer hand-waves the connector handoff: `START` now carries a normalized portable `scope`;
- the e2e examples were rewritten to current terminology and trust semantics so they stop teaching stale wire shapes.

## Files changed

Current spec diff in the working tree covers:

- `spec-core.md`
- `spec-architecture.md`
- `spec-collection-profile.md`
- `spec-change-tracking.md`
- `spec-data-query-api.md`
- `spec-deferred.md`
- `spec-auth-design.md`
- `spec-dti-alignment.md`
- `spec-e2e-examples.md`

Related steering-doc work also completed:

- `docs/personas/pdpp-reviewer-onboarding.md`

That onboarding file exists in the working tree but is not part of the current tracked diff set because `docs/personas/` is currently untracked in this worktree state.

## What I changed

### 1. Core semantic typing / honesty pass

Primary file: `spec-core.md`

This was the first major pass. The goal was to make the draft stop flattening very different kinds of consent-surface fields into one undifferentiated table.

Key changes:

- Added an explicit status discipline to request/grant-facing fields:
  - protocol-enforced constraints,
  - structured policy declarations,
  - attributed client claims / metadata.
- Made the consent surface normatively preserve those semantic distinctions rather than treating them as UI preference.
- Resolved the earlier contradiction where the draft both required differentiated rendering and also said consent UX was out of scope. The revised posture is:
  - visual design is out of scope,
  - semantic rendering obligations are in scope.
- Softened purpose and retention language so they match the real trust model:
  - purpose is for declaration / consent / audit / local policy, not generic downstream enforcement,
  - retention is a structured policy commitment, not a protocol-enforced deletion mechanism.

Why this mattered:

- It was the highest-leverage spec change identified in onboarding and the memos.
- It directly addressed the main critique: PDPP's promise surface was wider than its enforcement surface, but the draft was not visibly honest about that.

### 2. `single_use` semantics made explicit

Primary file: `spec-core.md`

I made `single_use` precise at the spec level:

- the grant is consumed at first client-token issuance,
- subsequent attempts to issue new client tokens for that grant must be rejected,
- already-issued tokens may still be used until expiry or revocation,
- `single_use` collection runs do not persist state.

Why this mattered:

- It closes a recurring ambiguity in the draft and in the older reference narrative.
- It creates a concrete implementation-visible obligation that can be tested directly.

### 3. Projection-safe `changes_since` tightened

Primary files:

- `spec-core.md`
- `spec-change-tracking.md`

I tightened the draft around the privacy property that makes PDPP's incremental sync distinctive:

- eligibility for `changes_since` must be computed on the grant-authorized projection,
- an implementation that selects records based on full-record changes and only projects afterward is explicitly non-conformant,
- tombstone and cursor-expiry semantics were kept aligned with that model.

Why this mattered:

- The reference implementation had a known projection-leak bug here.
- The spec needed stronger language if it was going to make this a real claim rather than an aspirational property.

### 4. State model reconciled

Primary files:

- `spec-core.md`
- `spec-collection-profile.md`

I reconciled the state story across the core and Collection Profile:

- `/v1/state/{connector_id}` now supports optional `grant_id` scoping for `continuous` grant-backed runs,
- the connector's global archival state remains the default when `grant_id` is absent,
- `single_use` runs are explicitly state-null and non-persistent.

Why this mattered:

- Core and Collection Profile were drifting.
- The draft needed one clear story for proactive archival collection vs grant-scoped recurring collection.

Note:

- I treated this as a bridge decision, not the center of gravity of the draft. It is pragmatic and useful, but not the main intellectual move.

### 5. Revocation vs deletion separated

Primary files:

- `spec-core.md`
- `spec-deferred.md`
- `spec-e2e-examples.md`

I made the draft more explicit that:

- revocation stops future disclosure,
- revocation is not deletion,
- data already disclosed is governed by retention commitments and external obligations,
- active erasure signaling remains future work.

Why this mattered:

- The repo thoughtwork had already identified this as an honesty problem.
- Users and implementers will otherwise overread revocation as erasure.

### 6. Freshness added as response metadata

Primary files:

- `spec-core.md`
- `spec-data-query-api.md`
- `spec-architecture.md`

This was the next substantive addition after the semantic-typing pass.

What changed:

- `freshness` is now defined as server-observed response metadata,
- it can appear on stream listings, stream metadata, and record-list responses,
- it reports things like `captured_at`, `status`, and optionally `last_attempted_at`,
- it is explicitly not a grant term and not a guarantee that the source has not changed since `captured_at`.

Why this mattered:

- It improves honesty without pretending the protocol can guarantee "fresh enough for the client's use case" in every environment.
- It fits the architecture much better than pushing freshness into consent semantics prematurely.

### 7. Deferred honesty sections added

Primary file: `spec-deferred.md`

I added short explicit deferred sections for:

- Active Erasure Signal
- Re-Interaction / Session Refresh
- Request-Side Freshness Requirements

I also cleaned stale deferred language that no longer matched the live draft.

Why this mattered:

- These are important real gaps.
- The draft is stronger when it names them honestly without faking a complete design.

### 8. Surrounding docs aligned with the new discipline

Primary files:

- `spec-auth-design.md`
- `spec-dti-alignment.md`

These were smaller but important consistency edits.

Examples:

- `spec-auth-design.md` now says the AS consent surface is out of scope at the wire level, while semantic distinctions in rendering remain normative.
- `spec-dti-alignment.md` now better distinguishes disclosure constraints from policy declarations.

Why this mattered:

- The core was starting to get more honest than the surrounding docs.
- That kind of inconsistency causes readers to overread enforceability again.

### 9. End-to-end examples rewritten

Primary file: `spec-e2e-examples.md`

I rewrote the examples file to current terms and current semantics.

The new file now reflects:

- `https://pdpp.org/data-access`
- `https://registry.pdpp.org/...`
- `access_mode` instead of stale naming
- differentiated consent rendering
- `single_use` consumption at first token issuance
- `changes_since` / `next_changes_since`
- response-side `freshness`
- revocation not equal to deletion
- grant-scoped state for `continuous` runs

It also explicitly labels itself illustrative and says the normative docs win when examples differ.

Why this mattered:

- The examples file had become a weak flank.
- Stale examples quietly override correct prose in implementers' minds.

### 10. Collection Profile `START` handoff closed

Primary files:

- `spec-collection-profile.md`
- `spec-architecture.md`
- `spec-e2e-examples.md`

This was the last major spec pass.

Problem:

- The draft said the runtime "derives the collection request from the grant" and "passes only what the connector needs to know," but the standardized `START` envelope did not actually define the collection target.
- That left a real under-specification at the connector boundary.

What I changed:

- Added a normalized portable `scope` object to `START`.
- `scope` carries:
  - explicit stream targets,
  - optional `resources`,
  - optional `time_range`,
  - optional `fields`.
- Clarified that `START` does not carry the raw grant or access token.
- Clarified that `scope` is not itself a grant and has no authorization force; it is the collection target for the run.
- Added connector obligations:
  - no emitting undeclared streams,
  - respect declared `resources` / `time_range`,
  - do not emit extra top-level fields when `fields` is present.
- Added runtime obligations:
  - send an explicit non-empty normalized `scope`,
  - do not pass wildcard stream names across the connector boundary.
- Clarified that issuance-time concepts like `necessity` and unresolved `view` names do not belong in `START.scope`.

Why this mattered:

- It closes the last obvious truth gap in the Collection Profile without inventing a whole new scheduler protocol.
- It keeps the raw grant out of the connector boundary while still making the handoff concrete and portable.

## Onboarding memo revision

File: `docs/personas/pdpp-reviewer-onboarding.md`

I also revised the onboarding memo in response to the advisor critique. The main changes were:

- removed the false binary between enforcement/declaration typing and attribution split;
- softened the "critique-only" posture so future agents are explicitly allowed to cross the bridge into concrete spec deltas once framing is stable;
- made it clearer that freshness, `data_class`, connector trust, erasure, and scraping/polyfill framing are still live even if not first.

Why this mattered:

- The memo was good continuity but too rigid as a steering document.
- Future agents should inherit the thoughtwork without being trapped in ontology arguments or permanent reviewer mode.

## What I deliberately did not do

- I did not make further `e2e/` changes in this spec-focused phase.
- I did not try to solve erasure, re-interaction, or request-side freshness fully.
- I did not add `data_class` yet.
- I did not broaden the work into formal adoption strategy or more positioning memos.
- I did not standardize more runtime execution hints beyond `START.scope`.

## Checks I ran

During the spec passes I repeatedly ran:

- repo greps for terminology drift and stale wording,
- targeted consistency reads across the touched spec docs,
- `git diff --check` on the edited files.

For the latest `START.scope` pass specifically, I:

- re-read all touched files end to end,
- grepped for the old under-specified `START` language,
- ran `git diff --check -- spec-collection-profile.md spec-architecture.md spec-e2e-examples.md`.

I did not run a docs/site build.

## Remaining live questions

The most important remaining questions after this work are:

1. Reference/tests conformance:
   - the draft now makes stronger claims;
   - the reference needs to earn them, especially around projection-safe `changes_since`, `single_use`, consent rendering distinctions, and state behavior.

2. `data_class`:
   - likely the next substantive addition after the current honesty/provability work settles;
   - should arrive as an explicitly typed policy/risk annotation, not as a fake enforcement primitive.

3. Collection Profile trust / provenance:
   - connector trust, provenance, and update posture should probably be elevated next in the profile and threat model.

4. Scope of `START`:
   - I believe v0.1 should stop at standardized `scope` and keep additional execution hints runtime-local unless the reference/test story proves more standardization is necessary.

## My assessment of the work

The best part of this work is that it moved PDPP from "better argued" toward "more true." The draft is now more explicit about what it can actually make happen, and its companion docs are less likely to silently reintroduce the original ambiguity.

The remaining risk is not primarily framing now. It is implementation lag: if the reference does not demonstrate the stronger conformance claims, the project will recreate the same truth gap in cleaner language.
