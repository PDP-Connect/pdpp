# Owner Review Synthesis: Fast Broad Agent Consent

Status: proposed — input for owner review, not accepted protocol
Author: fast-broad-consent-synthesis lane
Created: 2026-04-29
Related: `openspec/changes/design-fast-broad-agent-consent/{proposal.md,design.md,tasks.md}`,
`openspec/changes/design-fast-broad-agent-consent/design-notes/2026-04-27-prior-art-review.md`,
`openspec/changes/add-agent-scoped-pdpp-access/design-notes/2026-04-27-fast-broad-agent-consent.md`

## Purpose

Synthesize the owner feedback that "the inability to grant lots of permission
fast is itself a serious UX problem" into a normatively careful answer. This
note does not finalize anything. It separates what PDPP's protocol layer
SHOULD say from what the reference implementation MAY safely experiment with,
and names the owner decisions still required.

It complements rather than replaces the prior-art review. Where the prior-art
review consolidates external precedent, this note answers the five focused
questions the owner posed and proposes the minimum viable design that avoids
both an owner-token shortcut and a "scary approve everything" anti-pattern.

## Q1. Is "one source per issued grant" normative PDPP, reference policy, or just current implementation?

**Answer (proposed): one source per *issued grant* is normative; one source
per *consent ceremony* is reference policy that should change.**

Three distinct rules are tangled in the current state, and the survey clears
them up:

| Rule | Layer | Today | Proposed |
| --- | --- | --- | --- |
| One issued grant binds to one source boundary | Protocol | Normative-by-implication via `connector_id`/`provider_id` shape in `spec-core.md` §Grant fields | **Make explicitly normative.** Every surveyed system (Plaid Items, GitHub fine-grained PATs, Google scopes, AWS permission sets at the credential level) treats per-source independent credentials as the consensus shape. |
| One `authorization_details[]` entry per staged request | Reference | `authorization_details.maxItems = 1` enforced in the reference contract | **Reference policy only.** RFC 9396 explicitly permits multi-entry. The constraint should be relaxed in a follow-up implementation change, not in this design track. |
| One source per consent ceremony | Reference (de facto) | Emergent consequence of `maxItems = 1` | **Should change.** RAR multi-entry, Google selective grant, Slack optional scopes, Plaid Multi-Item, and GitHub Apps all run multi-entry ceremonies with partial approval. |

The distinction matters because it lets the protocol stay strict
(per-source enforcement, per-source revocation, per-source audit) while the
ceremony becomes faster (one owner-facing review, N independent grants
issued).

## Q2. Can one consent ceremony safely produce multiple source-bounded grants?

**Answer (proposed): yes, with five constraints. This is Option B from
`design.md`.**

Required constraints, each grounded in prior art:

1. **Per-entry partial approval.** The owner SHALL be able to approve, deny,
   or toggle individual sources before approval. (RAR §2.2 explicitly allows
   this; Slack optional scopes ship it; Google selective grant ships it.)
2. **Independent issued grants.** Approval SHALL produce one grant per
   approved source, each independently revocable. (Plaid Multi-Item Link
   produces one Item per institution; PDPP keeps that property.)
3. **No AS-side enrichment beyond owner review.** The AS SHALL NOT widen any
   `authorization_details` entry beyond what the owner saw and approved,
   even though RFC 9396 permits AS-side enrichment in the abstract. The
   inverse — AS-side narrowing of an over-broad request — is allowed and
   in some cases REQUIRED by the constraint rules below.
4. **Cumulative risk legibility.** The ceremony SHALL render aggregated risk
   across the bundle (sensitive source count, continuous-access count,
   no-time-bound count, no-field-projection count, total stream count).
   This is the genuinely novel piece — none of the surveyed systems do it.
5. **No default approve-all for high-risk shapes.** A single "approve all"
   affordance SHALL NOT be shown when the staged request includes any of
   (continuous + all streams), (no time bound + sensitive source), or N≥3
   sensitive sources in the same batch. (Apple/Android anti-bundling
   guidance; Slack v2 reasoning for breaking up umbrella scopes.)

If those five constraints hold, a multi-entry ceremony is safer than the
current single-entry ceremony, not less safe — because (a) the owner sees
*more* of what the agent will end up holding, and (b) the alternative path
of least resistance (owner token) is strictly worse.

## Q3. How should owner UX support fast broad approval while preserving per-source review, partial approval, audit, and revocation?

**Answer (proposed): grouped review, per-source toggles, package id for
audit, per-grant primary revocation with a package-level convenience
affordance.**

Concrete UX shape (proposed; reference-experimental until promoted):

- **Staged request.** A client may push a PAR payload containing N
  source-bounded `authorization_details[]` entries (still typed
  `https://pdpp.org/data-access`). Each entry continues to carry exactly one
  `connector_id` or `provider_id`. There is no cross-source entry shape.
- **Grouped review.** The consent UI renders a single review session with
  one card per source, plus an aggregated risk header. Each card shows the
  source, requested streams, fields/projection, time range, access mode,
  and per-card risk classification. The aggregated header shows the
  cumulative picture (e.g. "5 sources · 2 sensitive · 3 continuous · 1
  unbounded time range · 12 streams total").
- **Per-source controls.** Toggle on/off, edit time range down (never up),
  reduce stream/field set (never expand), and "skip for now" (defer
  without denial).
- **Approval action.** "Approve selected (N of M sources)." Approval issues
  one independent grant per approved source. A single package id is
  recorded for the ceremony.
- **Approve-all.** Allowed only when the bundle is below the high-risk
  threshold defined in Q2.5; otherwise hidden. When shown, it requires one
  confirmation step that re-asserts the per-source list.
- **Audit & timeline.** The grant timeline groups grants by package id but
  each grant remains individually queryable and revocable. A "revoke
  package" affordance is offered as a convenience and is never the only
  way to revoke. Revoking the package revokes its still-active grants;
  grants already revoked individually stay revoked.
- **Incremental upgrade.** When the same client returns later asking for
  one more source, that produces a new ceremony and a new package linked
  to the prior package via `parent_package_id`. The dashboard renders a
  per-agent cumulative view across all packages owned by that client
  identity. (Google `include_granted_scopes` is the precedent for "do not
  re-prompt previously granted scopes"; PDPP's per-grant model gets this
  property for free as long as the dashboard surfaces the cumulative
  picture.)
- **Reference-experimental labeling.** Until a follow-up OpenSpec change
  promotes batch consent to normative PDPP, the UI must display a
  reference-experimental badge on the grouped review screen and in
  generated docs. This is required by the existing
  `agent-consent-bundling` capability spec.

This shape preserves every existing safety property: source-bounded
enforcement, per-grant audit, per-grant revocation, no AS widening, and no
maximal-by-default presentation.

## Q4. Should grants support consent-level filters (date / resource / category predicates) in addition to stream/field/time bounds? If yes, what are the risks and what must remain proposed/experimental?

**Answer (proposed): no new filter grammar in this design track. Predicate
filtering is an attractive future capability, but it is out of scope for
the broad-consent synthesis and it would introduce risks that the current
proposal does not need to take on.**

What PDPP grants already constrain (and therefore what filters are NOT
needed for the broad-consent problem):

- `connector_id` / `provider_id` — source binding
- `streams[].name` and `streams[].fields` / `view` — record shape
  projection
- `streams[].time_range` — temporal bounds
- `access_mode` (`single_use` | `continuous`) — usage shape
- `streams[].necessity` — required vs optional

These dimensions already give the owner enough granularity to express
"only my last 90 days of email metadata, not body, single use." The fast-
broad-consent problem is about *speed across many sources*, not *missing
filter expressiveness within one source*.

If a future OpenSpec change introduces consent-level predicates (e.g.
`where merchant.country = "DE"`, `where label = "work"`, `where
amount < $X`), it MUST be designed in its own track with the following
risks named:

- **Capability drift.** Today the AS can validate a grant against a
  manifest at issuance time. Predicates push validation toward query time
  in the RS, where the AS no longer sees what the agent actually sees.
- **Side-channel leakage.** Predicates over filtered fields that the
  agent did not project can leak information through "did this match"
  signals. Apple's "Selected Photos" pattern works because the user picks
  the subset; a client-authored predicate is a *different* trust model.
- **Manifest contract surface.** Connectors would need to declare which
  predicates they support, with what semantics, against what fields.
  `polish-assistant-query-api-discovery` is already shaping
  `query.range_filters` and `query.aggregations` for the *query* layer;
  reusing that grammar at the *consent* layer is plausible but not yet
  designed.
- **Owner comprehension.** A consent screen that shows "and only when
  amount < $500 and merchant != Amazon" is hard to summarize, hard to
  audit, and easy to make incomprehensibly broad-looking-narrow.
- **Revocation semantics.** A predicate-grant might be "narrowed" by
  amending the predicate. PDPP has so far avoided amending issued grants
  (revoke + re-issue is the discipline). Predicates would tempt mutation.

Recommendation: leave consent-level predicates explicitly non-goal in this
change. Capture them as a separate proposal in a future OpenSpec change
once `polish-assistant-query-api-discovery` lands and the query-layer
filter grammar is settled. Reference predicates from there into the
manifest, not into `authorization_details`, until the trust model is
worked out.

## Q5. What is the minimum viable design that avoids owner-token shortcuts without creating a scary "approve everything" anti-pattern?

**Answer (proposed): the minimum viable design is Option B with the five
constraints from Q2, the UX shape from Q3, and the explicit decision to
defer Options C (permission sets) and D (agent roles) and Q4 (predicates)
to follow-up changes.** Do not bundle them into the first implementation.

### MVP scope

1. **Protocol.** Make "issued grants are source-bounded" explicitly
   normative in `spec-core.md` (or in the `agent-consent-bundling`
   capability spec, which is the right place if `spec-core.md` does not
   want a normative change yet). Make "AS MUST NOT widen
   `authorization_details` beyond owner review" explicitly normative.
   Leave staged-request multi-entry as reference-policy until owner
   review accepts the implementation change.
2. **Reference contract.** Allow up to a soft cap of N
   `authorization_details[]` entries per staged request (recommended cap:
   8, with a warning at 6, no hard cap). The cap is a UX guard, not a
   protocol limit.
3. **Reference UI.** Implement the grouped review screen with per-source
   toggles, aggregated risk header, and the approve-all gating from
   Q2.5. Label the screen reference-experimental.
4. **Audit.** Add `package_id` and optional `parent_package_id` to grant
   records. Surface package grouping in the dashboard and timeline; keep
   revocation per-grant.
5. **CLI / skill guidance.** Update `pdpp-data-access` to describe the
   batch ceremony as the recommended fast-setup path *only after* the
   reference UI ships behind the experimental label. Until then, do not
   recommend batched setup in skill text.

### Explicit non-MVP

- Owner-authored permission sets (Option C) — separate OpenSpec change
  after MVP lands.
- Agent roles (Option D) — out of scope for this track.
- Consent-level predicates (Q4) — separate OpenSpec change.
- Cross-source grants (one grant spanning multiple `connector_id`s) —
  not on the roadmap. The constraint that issued grants are
  source-bounded should remain.
- AS-side enrichment of `authorization_details` — explicitly forbidden.
- Default approve-all for high-risk bundles — explicitly forbidden.

### Why this is "minimum viable"

- It eliminates the "5–12 ceremonies to set up a useful agent" friction
  that drives owner-token shortcuts.
- It does not introduce any new authorization shape that the owner
  cannot read off the screen.
- It does not let the client author broad packages without scrutiny —
  the AS classifies risk and gates approve-all.
- It does not change RS enforcement, grant shape, or revocation
  semantics. Every added concept (`package_id`, `parent_package_id`)
  is a grouping aid, not an enforcement primitive.
- It is fully reversible. If the owner-experimental rollout shows the
  approve-all gate is too soft, tighten it. If the cumulative-risk
  header is unreadable, redesign it. None of those changes require a
  spec retraction.

## Cross-Reference With Existing Owner Decisions

The prior-art review listed eight owner decisions. This synthesis
proposes default answers for each, plus three new ones the synthesis
surfaced. Owner sign-off needed on every line.

| # | Decision | Proposed default | Rationale |
| --- | --- | --- | --- |
| 1 | Both Option B and Option C on roadmap, or only B? | **Both, B first, C as next OpenSpec change** | Apple/Android + AWS evidence; B alone normalizes client-authored bundles long-term. |
| 2 | Hard cap on `authorization_details[]` entries? | **Soft cap 8, warning at 6, no hard cap** | Slack/Plaid have no documented cap; a soft cap is enough to flag abuse. |
| 3 | Approve-all threshold | **Never when (continuous + all streams), (no time bound + sensitive source), or N≥3 sensitive sources** | Slack v2 + Apple/Android anti-bundling. |
| 4 | Sensitivity classification list | **Email, finance, location, health, private chat, raw filesystem/code history** | Lives in connector manifest field, not hardcoded; manifest field is `sensitivity: "standard" | "sensitive"`. |
| 5 | Package id semantics | **(a) timeline grouped, (b) dashboard grouped, (c) revoke-package as convenience only** | Per-grant revocation stays primary. |
| 6 | Incremental upgrade shape | **New ceremony, new package, `parent_package_id` link, dashboard shows cumulative per-client view** | Google `include_granted_scopes` precedent. |
| 7 | Permission-set storage (Option C) | **Owner-local with optional manifest-declared templates** | Out of MVP; deferred decision. |
| 8 | Reference-experimental labeling | **Required in UI, docs, OpenAPI metadata, and `pdpp-data-access` skill** | Already required by `agent-consent-bundling` spec. |
| 9 (new) | AS-side enrichment | **Forbidden. AS may narrow only.** | RFC 9396 allows enrichment but PDPP's owner-comprehension model requires what-you-see-is-what-is-issued. |
| 10 (new) | Cross-source grants | **Not on roadmap.** | Every surveyed system keeps per-source independent credentials. |
| 11 (new) | Consent-level predicates | **Out of scope. Separate OpenSpec change after query-layer filter grammar settles.** | Risks (capability drift, side-channel leakage, comprehension) not yet worked out. |

## Open Questions Still Requiring Owner Input

These are the questions the synthesis cannot answer without the owner:

1. **Where does normative "issued grants are source-bounded" live?** Promote
   into `spec-core.md` directly, or keep it inside the
   `agent-consent-bundling` capability spec for now? Owner judgment call:
   how stable is the rule.
2. **Soft cap value.** Is 8 the right number, or do we set it lower (5 –
   covers the common high-trust setup of email/finance/Slack/GitHub/
   calendar) or higher (12 – covers large connector libraries)?
3. **Sensitivity classification ownership.** Does the connector author
   declare `sensitivity` in the manifest, does PDPP maintain a registry,
   or both? Manifest-declared is faster to ship; central registry is
   harder to game.
4. **Approve-all visibility under low-risk bundles.** When the bundle is
   below the high-risk threshold, is approve-all *shown* by default or
   *hidden* and reachable via a "more" affordance? The synthesis leans
   *shown but secondary to per-source toggles*; the owner may prefer
   *hidden by default*.
5. **First implementation gating.** Is the MVP allowed to ship behind the
   reference-experimental label without a separate proposal, or must the
   batch consent UI proposal be its own OpenSpec change? The existing
   spec implies the latter; confirming.
6. **Skill guidance timing.** Is `pdpp-data-access` updated as part of the
   MVP shipping, or only after a follow-up OpenSpec change promotes
   batch consent out of reference-experimental? The synthesis leans
   *only after promotion*.

## What This Note Does Not Decide

- Wire format for the staged batch (single PAR with multi-entry
  `authorization_details[]` is the obvious shape but is not finalized
  here).
- Storage schema for `package_id` / `parent_package_id`.
- Exact UI components, copy, or color/severity treatment for the
  cumulative risk header.
- Whether the dashboard's per-agent cumulative view is a new page or a
  filter on the existing grants list.
- Telemetry. Any owner-side telemetry on consent flows is out of scope
  here and must be proposed separately under PDPP's privacy-first
  posture.
- Consent-level predicate grammar (Q4 — explicitly deferred).

## Confidence

- High confidence on Q1, Q2, Q3, Q5: directly grounded in the prior-art
  review and consistent with every surveyed system that ships multi-entry
  consent ceremonies. The synthesis does not invent new protocol shape.
- Medium confidence on Q4: the recommendation to defer is conservative
  but the risk list is necessarily speculative until the query-layer
  filter grammar settles.
- Lower confidence on the sensitivity classification list and the soft
  cap value. These need owner input rather than evidence.

## Distinctness From Earlier Notes

This note is the *synthesis* layer. The prior-art review
(`2026-04-27-prior-art-review.md`) is evidence; the design intake note
(`add-agent-scoped-pdpp-access/design-notes/2026-04-27-fast-broad-agent-consent.md`)
is the original problem framing; `design.md` is the candidate-model
analysis with a current leaning. This note answers the five focused
owner questions, separates protocol from reference policy, and proposes
default answers for the eleven decisions still on the table. It does
not modify durable specs and does not authorize implementation.
