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

## Residual Risks

- **No per-source access-mode mixing.** The access-mode narrowing tranche applies one `access_mode` to every child grant in a package. A future owner who wants `single_use` for one source and `continuous` for another must run two separate ceremonies. That asymmetry is consistent with the streams-narrowing tranche treating one source per row, but it limits how surgical a single ceremony can be. Mixed-access packages are deferred until the per-source progressive-disclosure work in §3 of `tasks.md` is decided.
