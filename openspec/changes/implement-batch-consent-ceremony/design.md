## Status

Reference-experimental. This change specifies the Option B batch consent ceremony selected by the `design-fast-broad-agent-consent` Recommended Decision Packet. It is a normative target for a *later* implementation lane. It does not modify the PAR contract, consent storage, consent UI issuance, or grant issuance, and authoring it is not authorization to implement. Until an implementation lane is opened against this spec, the reference's current one-entry behavior (`authorization_details.maxItems = 1`, source-bounded child grants) remains the live safety baseline.

The owner-default decisions encoded here (soft cap 8 / warn 6, approve-all gate conditions, manifest-declared sensitivity, package/parent-package grouping, no mixed-access packages) are the RI-owner defaults carried from the Recommended Decision Packet's O1–O8 recommendations. They are encoded so the spec is concrete and verifiable; each remains overrideable by the owner before implementation. Where a default is a tuning choice rather than an invariant, the requirement names it as a reference-contract policy constant so a later owner can change the value without a spec retraction.

## Problem

A capable owner-authorized agent often needs access to several sources — email, finance, Slack, GitHub, local coding history, calendar — before it is useful. One ceremony per source is safe but is poor setup UX, and the realistic workaround (owner-token sharing, or maximal one-at-a-time approvals) is worse. The current consent UI also gives the owner no cumulative picture of breadth across a sequence of approvals.

The decided shape (Option B) keeps every issued grant source-bounded and individually revocable while letting one ceremony stage and approve many of them. The novel piece — the only thing none of the surveyed production systems (Plaid Multi-Item Link, Slack optional scopes, Google granular/incremental consent, GitHub App installation) ship — is **cumulative cross-source risk legibility**: an aggregated picture of breadth across the bundle being approved.

## Construction Boundary (load-bearing)

This change is easy to over-promote into a new enforcement primitive. It is not one.

- **PDPP Core grants remain source-bounded and individually enforced/revocable.** Each approved source issues one independent grant. No cross-source grant object is created. RS per-grant enforcement, grant object shape, and revocation semantics are unchanged.
- **`package_id` and `parent_package_id` are grouping/audit aids, not grant authority.** Token routing and record authorization remain governed by active child grants, consistent with the already-merged "Grant packages SHALL NOT be PDPP grants" requirement.
- **Collection Profile is unaffected.** Batch consent is an authorization/disclosure-ceremony concern, not a connector-runtime concern.
- **The soft cap is a reference-contract policy constant, not a protocol limit.** `authorization_details.maxItems = 1` in the reference contract is a PDPP policy choice, not an RFC 9396 requirement and not Core. Relaxing it to a soft cap is a reference-contract edit. Each entry still carries exactly one source binding.
- **AS-side widening stays forbidden.** The AS SHALL NOT enrich or widen any staged `authorization_details` entry beyond what the owner reviewed; AS-side narrowing of an over-broad request is allowed. (Already decided in `design-fast-broad-agent-consent` D2.)

## Encoded owner-default decisions

These are the O1–O8 recommendations from the Recommended Decision Packet, encoded as this change's defaults. They are RI-owner defaults and remain overrideable before implementation.

| # | Decision | Encoded default | Where it lives in this change |
| --- | --- | --- | --- |
| O1 | First fast-setup primitive | Option B only (C is a later change; D off-track) | Whole change scope; non-goals |
| O3 | Soft cap / warning threshold | Soft cap 8, warn at 6, no hard cap (reference-contract policy constants) | "Staged request soft cap" requirement |
| O4 | Approve-all gate | Hidden whenever (continuous + all streams), (no time bound + sensitive source), or N≥3 sensitive sources; default presentation requires per-source confirmation | "Approve-all suppression" requirement |
| O5 | Sensitivity classification ownership | Manifest-declared `sensitivity: "standard" \| "sensitive"`; no hardcoded source list; central registry deferred | "Manifest-declared sensitivity" requirement |
| O6 | Package audit + revoke-package | `package_id` groups child grants in timeline + dashboard; per-grant revocation primary; revoke-package dispatches one revoke per child and surfaces partial failure | "Package-level audit grouping" + "Revoke-package convenience" requirements |
| O7 | Incremental add-source linkage | New ceremony issues a new package linked via `parent_package_id`; dashboard renders a cumulative per-client view | "Incremental add-source linkage" requirement |
| — | Mixed-access packages | Deferred: one `access_mode` per package this tranche | Non-goals; Residual Risks |

Decisions already closed upstream and not re-litigated here: D1 (grants stay source-bounded), D2 (AS-side widening forbidden), D3 (cross-source grant objects off-roadmap), D5 (source-bounded normativity lives in `agent-consent-bundling`), D6 (reference-experimental labeling required).

## Why this shape, not a maximal one

- **Simple.** Reuses the source-bounded grant object unchanged; adds two nullable grouping ids and one manifest field. No cross-source grant, no new token authority, no AS-side enrichment.
- **Lossless.** The owner sees *more* of what the agent will hold than today — a cumulative-risk header across the batch — not less. High-risk dimensions (continuous, all-streams, no time bound, no field projection, sensitive sources) are surfaced rather than hidden behind one button.
- **Verifiable.** Each constraint maps to a spec scenario (per-entry partial approval, independent issued grants, no-widen, approve-all gating, package-vs-grant revocation, parent linkage). The reference's existing one-entry behavior remains the baseline until an implementation lane lands this spec.
- **Polished.** Matches the production shape of Plaid Multi-Item Link, Slack optional scopes, Google granular/incremental consent, and GitHub App installation, and adds cumulative cross-source risk legibility.

## Boundary map

| Layer | What this change does (and does not) put here |
| --- | --- |
| **PDPP Core** (`spec-*.md`) | **No change.** "An issued grant binds one source boundary" is already normative-by-implication and is restated in the capability spec. Promoting it into `spec-core.md` is a separate optional owner call (D5). Batch *ceremony* semantics are explicitly not Core. |
| **Collection Profile** (`spec-collection-profile.md`) | **No change.** Batch consent is an authorization/disclosure concern, not a connector-runtime concern. |
| **Reference implementation** (`agent-consent-bundling` capability spec) | **All net-new behavior, behind a reference-experimental label.** Multi-entry staged-request acceptance (relaxing the reference-policy `authorization_details.maxItems = 1` to a soft cap), the grouped review ceremony, the cumulative-risk header, the approve-all gate, the soft cap/warning, manifest `sensitivity`, and `package_id`/`parent_package_id` grouping + dashboard/timeline surfaces. The already-merged hosted MCP package model is the precedent these reuse. |

## Alternatives considered

- **Option C (owner-authored permission sets) first.** Deferred to its own later OpenSpec change after B lands. Authoring permission-set storage, edit UI, and versioning before the first useful grant is more surface than the friction requires. Apple/Android and AWS IAM Identity Center evidence makes C the safer *repeat* path, not the first one.
- **Option D (agent roles).** Off-track. Prior-art review found no surveyed system shipping agent-role policy as a first-class consent primitive; it risks becoming account-level authorization rather than consent.
- **Consent-level predicate filters (date/resource/category).** Deferred to a separate change after the query-layer filter grammar settles.
- **Mixed-access-mode packages.** Deferred. One package applies one `access_mode` to all child grants this tranche. A future per-source progressive-disclosure tranche can lift this; it is not proven necessary yet.
- **Hard cap on staged entries.** Rejected. Slack and Plaid document no cap. A soft cap with a warning preserves legitimate broad setup as an intentional, visible owner decision rather than a blocked one.

## Acceptance checks

- `pnpm exec openspec validate implement-batch-consent-ceremony --strict` passes.
- `pnpm exec openspec validate --all --strict` passes.
- The spec delta distinguishes current one-entry behavior from the proposed batch ceremony, and every requirement is reversible (a grouping/presentation/policy aid that can be tightened or removed without a spec retraction).
- No runtime, contract, consent-UI, consent-storage, PAR, or grant-issuance code is changed in this lane.

## Residual risks

- **Spec-vs-implementation gap.** This change is normative-only. A future reader could treat it as implemented. Mitigated by the reference-experimental Status line and the `tasks.md` "no runtime code in this lane" gate; `design-fast-broad-agent-consent` §3 owner checkboxes for the implementation lane remain the authoritative "not yet built" signal.
- **No per-source access-mode mixing.** One package applies one `access_mode` to all child grants. A surgical mixed-access ceremony needs a separate progressive-disclosure tranche. Named as a non-goal.
- **Soft-cap value and the sensitive-source classification are tuning choices, not invariants.** The defaults (8 / 6, manifest-declared sensitivity) are RI-owner defaults; a later owner may change the cap value or move sensitivity into a central registry without a spec retraction.
