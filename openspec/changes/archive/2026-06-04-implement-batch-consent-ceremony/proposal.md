## Why

`design-fast-broad-agent-consent` evaluated how to make multi-source agent setup fast without normalizing a client-authored "all data" bundle or an owner-token shortcut. Its Recommended Decision Packet selected one coherent path: Option B — a batch consent ceremony that stages multiple source-bounded grant requests and issues independent source-bounded child grants in one owner ceremony. This change promotes that recommended path into a concrete, implementation-ready specification so a later implementation lane has a normative target.

The current reference accepts exactly one `authorization_details[]` entry per staged request. That keeps source boundaries crisp but forces a high-trust setup across email, finance, Slack, GitHub, and local agent history into many serial ceremonies. The path of least resistance becomes owner-token sharing or maximal one-at-a-time approvals with no cumulative-risk picture. Option B removes that friction by reusing the already-merged hosted MCP package model: one ceremony, N independent per-source credentials, partial approval, and the one property no surveyed system ships — cumulative cross-source risk legibility.

This change specifies behavior. It does not authorize implementation; runtime code, PAR handlers, consent storage, consent UI, and grant issuance remain frozen until a subsequent implementation lane is opened against this spec.

## What Changes

- Specify a reference-experimental batch consent ceremony that stages multiple independent source-bounded grant requests and issues one independent source-bounded child grant per approved source in a single owner ceremony.
- Relax the reference-contract `authorization_details.maxItems = 1` policy to an owner-chosen soft cap (default 8) with a warning threshold (default 6) and no hard cap. Each entry still carries exactly one source binding. This is a reference-contract policy constant, not a protocol limit and not a relaxation of source boundaries.
- Add normative requirements for: per-source review and per-source confirmation; a cumulative-risk header; an approve-all affordance suppressed under defined risk conditions; manifest-declared sensitivity classification (`sensitivity: "standard" | "sensitive"`); issuance of independent source-bounded child grants; package-level audit/timeline grouping via `package_id`; a revoke-package convenience that dispatches per-child revokes and surfaces partial failure; and incremental add-source via a new package linked by `parent_package_id`.
- Preserve the construction boundary: PDPP Core grants remain source-bounded and individually enforced/revocable; `package_id` and `parent_package_id` are grouping/audit aids, not a grant enforcement primitive; the Collection Profile is unaffected.
- Defer mixed-access-mode packages: one package applies one `access_mode` to all child grants in this tranche.

## Capabilities

### Modified

- `agent-consent-bundling`: Extend the reference hosted MCP / batch consent ceremony semantics to cover a staged multi-entry request, the soft cap and warning, per-source review/confirmation, the cumulative-risk header, the risk-gated approve-all affordance, manifest-declared sensitivity, `package_id` audit grouping, revoke-package partial-failure visibility, and `parent_package_id` incremental linkage.

### Added

- None. All net-new behavior extends the existing `agent-consent-bundling` capability spec behind a reference-experimental label.

## Impact

- Potential future reference areas (frozen until an implementation lane is opened against this spec): `/oauth/par`, the public reference contract `authorization_details.maxItems`, pending-consent storage, the hosted consent ceremony UI, grant-package storage, the grant timeline, and dashboard grant surfaces.
- No PDPP Core change. The Core-adjacent fact "an issued grant binds one source boundary" is already normative-by-implication and restated here. Promotion into `spec-core.md` remains a separate optional owner call.
- No Collection Profile change. Batch consent is an authorization/disclosure-ceremony concern, not a connector-runtime concern.
- Security impact: high. Every requirement preserves least privilege, per-source audit, per-grant revocation, and owner comprehension. The reference's current one-entry behavior remains the safety baseline until an implementation lane lands this spec.
