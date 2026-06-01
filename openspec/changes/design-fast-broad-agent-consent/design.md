## Status

This is a high-stakes normative design track. It is not an accepted PDPP protocol change, does not modify the reference PAR contract, and does not authorize implementation of multi-source grants or approve-many consent UI.

## Problem

A capable owner-authorized agent often needs access to multiple sources before it can be useful: email, finances, Slack, GitHub, local coding history, calendar, and memories. Requiring a separate consent ceremony for every source is safe in isolation but poor as setup UX.

At the same time, "approve everything" is exactly the failure mode PDPP exists to avoid. A broad multi-source approval can become an owner token with nicer packaging unless source boundaries, scope explanation, revocation, and audit remain explicit.

The current reference behavior is a defensible safety rail:

- `authorization_details[]` is constrained to one entry.
- An issued client grant is source-bounded.
- A client cannot bundle all sources into one approval.

But it creates a real user problem:

- A legitimate high-trust setup can require many approval round trips.
- The path of least resistance becomes owner-token sharing or maximal continuous grants.
- The consent UI does not yet help the owner understand cumulative broadness across a sequence of approvals.

## Design Principles

- **Preserve source-bounded enforcement.** One issued grant should remain bound to one source boundary unless a future accepted spec very deliberately changes that rule.
- **Separate ceremony from grant object.** A fast owner-facing approval flow can issue many independent grants; it does not need one cross-source grant.
- **Make broadness legible.** Mixed-source, continuous, no-time-limit, all-stream, or no-field-limit access needs stronger presentation than a narrow one-shot task grant.
- **Keep denial and revocation granular.** The owner must be able to deny or revoke one source without invalidating unrelated approved access unless they choose package-level revocation.
- **Do not let clients author dark-pattern bundles.** Client-authored broad packages need constraints. Owner-authored permission sets may be safer for repeated high-trust use.
- **Treat this as proposed until accepted.** Any experimental reference implementation must be labeled reference-experimental and must not claim root PDPP normativity.

## Candidate Models

### Option A: Keep one source per ceremony

The current behavior becomes normative: clients request one source at a time, and owners approve one source at a time.

Pros:

- Strongest data-minimization default.
- Simple audit and revocation.
- Closest to the current reference.

Cons:

- Poor setup UX for useful agents.
- Encourages owner-token shortcuts.
- Makes legitimate broad access feel like a tedious workaround instead of an intentional owner decision.

### Option B: Batch consent ceremony issuing independent grants

The client submits a batch containing multiple source-bounded grant requests. The AS renders one owner-facing review session. Approval issues one independent grant per source.

Pros:

- Fast setup without cross-source grant objects.
- Keeps revocation and enforcement source-bounded.
- Maps naturally to OAuth RAR multiple `authorization_details[]` entries while preserving PDPP source boundaries.

Cons:

- Consent UI complexity increases sharply.
- "Approve all" can become a dark pattern.
- Pending-consent storage, timeline, audit, CLI, and dashboard need package-level concepts.

### Option C: Owner-authored permission sets

The owner defines reusable sets such as "personal assistant", "finance review", or "coding assistant". Clients request a named permission set or the owner applies one during consent.

Pros:

- The owner, not the requesting client, authors broad access.
- Repeated setup becomes fast without normalizing client-authored maximal requests.
- Permission sets can be reviewed, versioned, and retired.

Cons:

- More product surface before the first useful grant.
- Requires policy storage, edit UI, and package versioning semantics.
- Still needs per-source audit and revocation.

### Option D: Agent roles

The AS supports owner-defined roles that map an agent/client identity to allowed grant envelopes over time.

Pros:

- Strong fit for long-lived personal assistants.
- Can support incremental upgrades and policy drift explicitly.

Cons:

- Highest protocol complexity.
- Risks becoming account-level authorization policy rather than consent.
- Needs careful relationship to client registration, project-local caches, and revocation.

## Current Leaning

Prefer **Option B as the first implementation candidate**, constrained by source-bounded issued grants, and **Option C as the next OpenSpec change after B lands** rather than a parallel track. **Option D is out of scope for this design track** based on prior-art review (see `design-notes/2026-04-27-prior-art-review.md`): no surveyed system ships anything close to agent-role policy as a first-class consent primitive, so it should not block fast setup.

The likely shape:

1. A client may stage a batch consent request containing multiple source-bounded grant requests.
2. The AS renders a grouped consent ceremony.
3. The owner can approve, deny, or toggle individual sources/streams. An "approve all" affordance is gated by risk: it SHALL NOT appear when the staged request combines high-risk dimensions (continuous + all streams, no time bound + sensitive source, or several sensitive sources in one batch). Default presentation requires per-source confirmation.
4. Approval issues multiple independent grants, one per source.
5. The AS records a package/session id for audit and timeline grouping. A "revoke package" affordance is optional convenience and never replaces per-grant revocation.
6. RS enforcement remains unchanged: each token/grant is still source-scoped.
7. High-risk items require explicit confirmation: continuous access, all streams, no time bound, sensitive connectors, and no field projection.
8. The AS SHALL NOT enrich, widen, or otherwise modify the staged `authorization_details` beyond what the owner reviewed in this ceremony, even though RFC 9396 permits AS-side enrichment in the abstract.

Prior art validates this shape. RFC 9396 already supports multi-entry staged requests with partial approval. Plaid Multi-Item Link, Slack optional scopes, GitHub App installation, and Google granular consent all ship per-entry toggling against independent per-source credentials. The novel piece PDPP would invent — and must not underestimate — is **cumulative cross-source risk legibility**: none of the surveyed systems show an aggregated picture of risk across the bundle being approved.

This leaning is not final. It must survive owner review before implementation.

## Decision Matrix

This is the owner-consumable summary of every `tasks.md` §3 decision in one place. It separates what accepted artifacts and prior owner steering already make safe to close (Decided) from genuine owner choices (Owner-gated). For each owner-gated row, the exact question text the owner must answer is below the table. Status here mirrors the checkboxes in `tasks.md`; this table does not introduce new normative requirements (those live in `specs/agent-consent-bundling/spec.md`).

| # | Decision | Status | Recommendation | Where it is / would be captured |
| --- | --- | --- | --- | --- |
| D1 | Issued grants stay source-bounded in near-term designs | **Decided: yes** | n/a — already normative | `agent-consent-bundling/spec.md` (source-bounded child grants); owner steering |
| D2 | AS-side enrichment of `authorization_details` | **Decided: forbidden; AS may narrow only** | n/a | This change's delta ("SHALL NOT silently widen…"); merged `reference-implementation-architecture` no-widen reqs |
| D3 | Cross-source grant objects | **Decided: off near-term roadmap** | Keep off; permanence is a later owner call | Merged spec ("SHALL NOT issue a single cross-source PDPP grant") |
| D4 | Consent-level predicate filters (date/resource/category) | **Decided: deferred** | Reopen only as its own change after the query-layer filter grammar settles | Synthesis Q4 / decision #11 |
| D5 | Where "source-bounded" normativity lives | **Decided: `agent-consent-bundling` capability spec** | `spec-core.md` promotion remains an optional later owner call | Merged capability spec |
| D6 | Reference-experimental labeling of any first Option B | **Decided: required** | n/a | `agent-consent-bundling/spec.md` ("SHALL label it reference-experimental") |
| O1 | First fast-setup primitive: B / C / D / none | **Owner-gated** | **B first.** D-out is prior-art-backed and safe; B-vs-nothing is the live owner call | Would gate a follow-up Option B implementation change (§4) |
| O2 | Both B and C on roadmap, or only B | **Owner-gated** | **Both — B first, C as the next OpenSpec change, not a parallel track** | design.md "Current Leaning"; would be ratified into proposal scope |
| O3 | Soft cap / warning threshold on `authorization_details[]` entries | **Owner-gated** | **Soft cap 8, warning at 6, no hard cap.** Lower to 5 if the target is the common email/finance/Slack/GitHub/calendar setup | Reference-contract policy in the follow-up B change (not a protocol limit) |
| O4 | "Approve all" allowed for mixed-source, and disabling conditions | **Owner-gated** | **Hidden whenever (continuous + all streams), (no time bound + sensitive source), or N≥3 sensitive sources;** default presentation requires per-source confirmation | design.md "Current Leaning" step 3; would become a B-change spec scenario |
| O5 | Which sources are "sensitive" + where the list lives | **Owner-gated** | **Manifest-declared `sensitivity: "standard" \| "sensitive"`** to ship fast; central registry as a later hardening step. Do **not** hardcode a source list | Connector manifest field, defined in the follow-up B change |
| O6 | Package-level audit + revoke-package affordance | **Owner-gated (B-ceremony surface only)** | Hosted MCP package audit is already decided in merged spec; the **Option B batch-ceremony** package model stays open: package id grouped in timeline + dashboard, per-grant revocation primary, revoke-package as convenience only | Merged spec covers hosted MCP; B-ceremony semantics would be the follow-up change |
| O7 | Incremental "add a source later" linkage | **Owner-gated** | **New ceremony, new package linked via `parent_package_id`; dashboard renders a cumulative per-client view** (Google `include_granted_scopes` precedent) | Follow-up B change storage + dashboard delta |
| O8 | Option C permission-set storage + client-registration impact | **Owner-gated (deferred to Option C track)** | **Owner-local storage with optional manifest-declared templates;** decide only when Option C opens | Separate Option C design/implementation change |

### Exact owner questions

These are the questions to put to the owner verbatim. Each is phrased so it can be answered without re-reading the full design track.

- **O1 — First primitive.** "We can make multi-source agent setup fast in one of three ways: (B) the client submits several source requests and you approve them in one review screen; (C) you pre-author reusable permission sets the client asks for by name; (D) long-lived agent roles. Prior art rules out D as a first-class consent primitive. Do you want to start with B, start with C, or ship nothing further right now? (Recommended: B first.)"
- **O2 — Roadmap.** "Should C (owner-authored permission sets) stay on the roadmap as the change after B, or do you want only B with C dropped? (Recommended: keep both, B first.)"
- **O3 — Soft cap.** "When a client requests N sources in one batch, at what count should we warn the owner, and at what count should we flag it as unusual? We do not want a hard limit. (Recommended: warn at 6, soft cap at 8; pick 5 if you'd rather flag earlier.)"
- **O4 — Approve-all gate.** "Should a single 'approve all sources' button ever appear for a mixed-source request, and under which conditions must it be hidden so the owner must confirm each source? (Recommended: hide it whenever the batch combines continuous access with all-streams, pairs no-time-bound with a sensitive source, or includes 3+ sensitive sources.)"
- **O5 — Sensitivity ownership.** "Which sources count as 'sensitive' for risk warnings, and should that flag be declared by the connector author in its manifest, maintained in a central PDPP registry, or both? (Recommended: manifest-declared `sensitivity` field now, central registry later; do not hardcode a list.)"
- **O6 — Package audit (B ceremony).** "For the Option B batch ceremony, should the package id group grants in the timeline and dashboard, with per-grant revocation staying primary and a 'revoke package' button offered only as a convenience? (Recommended: yes to grouping, yes to per-grant-primary, revoke-package optional.)"
- **O7 — Incremental linkage.** "When an agent comes back later to add one more source, should that create a new package linked to the prior one (`parent_package_id`) with the dashboard showing the agent's cumulative access, or should each addition stand alone? (Recommended: linked package + cumulative dashboard view.)"
- **O8 — Permission-set storage (only when C opens).** "When we build Option C, should permission sets live in your local instance storage, be declarable as manifest templates, or both — and how should a client reference one during registration? (Recommended: owner-local with optional manifest templates; defer until C starts.)"

## Current-State Audit

Reference PAR behavior remains intentionally one-entry-only:

- `reference-implementation/server/auth.js` rejects any request whose `authorization_details.length !== 1`.
- The observed runtime failure shape for two entries is HTTP `400` with body `{ error: { type: "invalid_request_error", code: "invalid_request", message: "Exactly one authorization_details entry is supported in the current reference flow", request_id } }`; no `PDPP-Reference-Trace-Id` header is returned for this validation failure.
- `reference-implementation/test/pdpp.test.js` now pins that multi-entry rejection shape in the malformed request-envelope coverage.
- The public reference contract schema also advertises `authorization_details.maxItems = 1` (`packages/reference-contract/src/public/index.ts`).

Consent presentation for maximal single-source grants is legible but not enough for mixed-source batching:

- Wildcard streams render as an "All streams" warning and expand to manifest stream names when available (`reference-implementation/server/routes/as-consent-ui-helpers.ts`).
- Continuous access renders a warning; when no retention bound is present, the owner sees that the client may keep reading until revocation.
- Per-stream fields, views, time ranges, and optionality render in the stream list when provided.
- There is no risk scoring, sensitivity classification, package summary, or second confirmation for "continuous + all streams + no retention + no field projection"; that is acceptable for the one-source current flow but insufficient for Option B.

Dashboard grant surfaces are per-grant today:

- `/dashboard/grants` lists individual grant summaries with status, client id, source, event count, and a peekable timeline (`apps/web/src/app/dashboard/grants/page.tsx`).
- `/dashboard/grants/[grantId]` shows a single grant timeline (`apps/web/src/app/dashboard/grants/[grantId]/page.tsx`).
- `POST /grants/:grantId/revoke` remains per-grant and accepts owner or same-grant client auth (`reference-implementation/server/routes/as-grant-revoke.ts`).
- Package/session grouping could be added as display metadata without weakening revocation, but a "revoke package" affordance must dispatch one revoke per child grant and surface partial failures.

Agent guidance mostly resists broad shortcuts:

- `docs/agent-skills/pdpp-data-access/SKILL.md` tells agents to request the narrowest grant, avoid owner bearer tokens, avoid silent broadening, and stop on insufficient scope.
- `reference-implementation/cli/commands/agent.js` stages exactly one source object per request and defaults to `single_use`.
- One stale CLI help line advertised `pdpp agent request --connector-id`; this audit corrected it to `--source-kind <kind> --source-id <id>` in `reference-implementation/cli/index.js`.
- The skill's old "owner-token escape hatch" wording was too permissive for routine data access; this audit tightened it to treat owner/admin sign-in as outside the data-access skill rather than as a broad-read workaround.
- `docs/agent-skills/pdpp-data-access/references/grant-design.md` now says cross-source tasks require multiple requests/grants in the current reference; multi-entry batch consent remains a design track.

## Prior Art

Reviewed in detail in `design-notes/2026-04-27-prior-art-review.md`. Headline findings:

- **OAuth RAR (RFC 9396).** Multi-entry `authorization_details[]` with partial approval is already normative. The reference's `authorization_details.maxItems = 1` is a PDPP policy choice, not an RFC requirement. AS-side enrichment is permitted by RAR but PDPP should forbid it because owners must see exactly what they approve.
- **OAuth PAR (RFC 9126).** Short-lived (5–600 s), client-bound staged requests. PAR says nothing about consent UI or batch semantics; the pushed payload shape is a separate decision.
- **Google OAuth.** Granular consent (user can grant a subset) and incremental authorization (`include_granted_scopes`) are precedents for selective per-source approval and "add a source later without re-approving previous sources." Domain-wide delegation is the antipattern PDPP must not recreate.
- **GitHub fine-grained PATs and Apps.** Repository-level toggles, mandatory expiration, per-permission read/write granularity, and "cannot span multiple organizations" structurally enforce source boundaries. App installation is closer to all-or-nothing per app — PDPP must be more granular than that.
- **Slack OAuth v2 + optional scopes (March 2026).** Production validation of per-source toggle inside one consent screen, with workspace admins able to pre-approve which optional scopes are even offered (an Option C precedent). Slack also documents the failure mode PDPP fears: "avoid requesting excessive permissions that could cause installations to be rejected."
- **Plaid Multi-Item Link.** One Link session, multiple institutions, one independent Item per institution. Strongest production precedent for "one ceremony, N independent per-source credentials."
- **Apple HIG and Android.** Strongest cautionary signal. Both treat bundling as a smell and ship granular subsets ("Selected Photos", "Approximate Location") under user control rather than client control. The closest PDPP analog to Apple's system-defined permission groups is Option C (owner-authored permission sets), not client-authored bundles.
- **AWS IAM Identity Center permission sets.** Admin-authored, reusable, multi-target. Strong precedent for Option C: owners pre-define bundles instead of letting the requesting client author "all data" packages at consent time.

## Non-Goals

- Do not implement multi-source PAR in this change.
- Do not change issued grant enforcement from source-bounded to cross-source.
- Do not add reusable permission sets or agent roles in this change.
- Do not update the `pdpp-data-access` skill to recommend broad setup flows until a design is accepted.
- Do not treat the reference's current `authorization_details.maxItems = 1` as permanently normative without explicit owner/spec review.

## Acceptance Checks

- The OpenSpec change validates strictly.
- The design clearly distinguishes current behavior from proposed behavior.
- Tasks require prior-art review before implementation planning.
- Any future implementation task preserves source-bounded issued grants unless a later accepted change says otherwise.

## Accepted Behavior — Picker Retention

The hosted MCP picker emits no `retention` field on the `authorization_details[]` entries it constructs, and the issued child grants carry no `retention` object. `spec-core.md` defines `retention` as `{ max_duration: ISO 8601 duration, on_expiry: 'delete' | 'anonymize' }`; the generic hosted MCP ceremony has no Core-shaped per-source retention commitment to encode, so absence is the honest signal. The picker copy says plainly that this ceremony does not encode a machine-readable retention bound on the issued grants, and that retention of fetched results is governed by the MCP client's own policy and any external agreements the owner has with that client. The `grant.issued` spine event surfaces absence as an explicit `retention: null` so a dashboard or CLI reading the timeline can distinguish "no machine-readable bound" from "I forgot to read this field" without reaching for a non-Core shape.

Owner-narrowable retention remains future work. A future tranche that wants to add a retention preset control to the picker should (a) define a fixed list of Core-shaped `{ max_duration, on_expiry }` presets that the picker offers, then (b) wire those into the picker form and the spine event. Until that lands, the picker stays silent on retention rather than fabricating a non-Core shape.

## Accepted Behavior — Existing Hosted MCP Picker UX

The existing hosted MCP picker remains a reference-experimental ceremony that issues independent source-bounded child grants. It does not change `/oauth/par`, does not create cross-source grant objects, and does not approve multi-entry PDPP Core semantics.

Within that boundary, the owner-facing picker is source-first rather than stream-first. Source sections render collapsed by default. Stream checkboxes are unchecked and disabled until the owner selects the parent source. Selecting the parent source enables stream controls but does not auto-select every stream; the owner can choose individual streams or use the per-source/global bulk affordances. Clearing a source clears its streams and collapses that source. Form submissions that contain only orphan stream values are ignored server-side, and a submission with no selected source, or with a selected source that has no selected streams, re-renders the hosted HTML validation page instead of returning a raw JSON error page.

This repair is deliberately narrower than the full Option B design. It makes the current package picker usable and less misleading for external agents, but it does not add sensitivity classification, package risk scoring, permission sets, or approve-all behavior for mixed high-risk bundles.

## Residual Risks

- **No per-source access-mode mixing.** The access-mode narrowing tranche applies one `access_mode` to every child grant in a package. A future owner who wants `single_use` for one source and `continuous` for another must run two separate ceremonies. That asymmetry is consistent with the streams-narrowing tranche treating one source per row, but it limits how surgical a single ceremony can be. Mixed-access packages are deferred until the per-source progressive-disclosure work in §3 of `tasks.md` is decided.
