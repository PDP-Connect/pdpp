# Design: console grants safe review

## Scope

This change adds a console route for one live pending approval and binds consent approval to the immutable PR114 review artifact. It does not change PDPP Core, create a trust registry, fetch client logos, resolve connection labels, or add narrowing controls.

## Decision

`GET /_ref/approvals/:approval_id` remains an owner-session-only liveness/type check and owner-device detail projection. For consent approvals, the console does not trust that mutable reconstruction as approval authority. It calls `/consent/review` with the opaque `approval_id`, renders the exact returned `approval_review` artifact, and preserves the returned `request_uri` and `approval_review_revision`.

The console list is triage only. Both consent and owner-device approvals route to a stable detail page. Consent shows artifact version, subject, AI decision, client, purpose, source declaration, selection preset, resolved instance IDs, resources, fields, time constraints, access, retention, and expiry directly from the artifact. Owner-device review states that it authorizes owner control and has no data-grant scope preview.

The final confirmation is a second route state (`?confirm=1`), not a modal. Single-consent approval submits only the reviewed `request_uri` and `approval_review_revision`; it does not call `/consent/review` again and it does not submit mutable subject, AI, source, or narrowing facts. If approval fails, the console clears confirmation and returns to read-only review so the next attempt materializes a new immutable artifact. Batch consent is explicitly non-actionable in the console until the required `confirm_reviewed_decision` batch ceremony is implemented there.

## Alternatives

- Put full review data in the queue response: rejected because the queue becomes a large sensitive projection and has no clear per-request cache boundary.
- Keep row approval with an interstitial modal: rejected because it adds focus and client-state complexity while producing no stable review URL.
- Claim registered metadata proves a client is verified: rejected because the reference has no server-owned trust decision.

## Acceptance checks

- The detail endpoint is gated by the owner session and returns no result for terminal or expired approvals.
- The detail projection does not emit bearer-equivalent credentials or raw persisted payload.
- The console renders the exact `/consent/review` artifact and all authority-bearing artifact fields.
- No pending-list form can approve; only final confirmation has an approval submit for single consent and owner-device approvals.
- Single consent final approval submits only `request_uri` and `approval_review_revision`.
- Approval errors clear `?confirm=1`.
