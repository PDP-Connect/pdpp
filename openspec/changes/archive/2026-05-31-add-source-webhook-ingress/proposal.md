# Proposal: Add Source Webhook Ingress

Status: proposed
Owner: reference implementation owner
Created: 2026-05-28
Related: `design-notes/source-webhooks-and-event-driven-collection-2026-05-15.md`, `openspec/specs/reference-implementation-architecture/spec.md` (lines 4349–4388), `reference-implementation/server/routes/source-webhooks.ts`, `reference-implementation/operations/ref-source-webhook-ingest/index.ts`

## Problem

`openspec/specs/reference-implementation-architecture/spec.md` already contains four requirements for source webhook ingress (lines 4349–4388), and a working implementation exists at `server/routes/source-webhooks.ts` + `operations/ref-source-webhook-ingest/index.ts`. However, the spec leaves the following under-specified:

1. **Envelope shape and header names.** The spec says "authenticate with a source-specific credential" but does not name the three headers (`PDPP-Webhook-Timestamp`, `PDPP-Webhook-Event-Id`, `PDPP-Webhook-Signature`) or the signed-material format (`sha256=HMAC-SHA256(secret, "${timestamp}.${body}")`).
2. **Timestamp format and replay tolerance.** The spec says "reject stale… signatures" but does not specify that the timestamp is Unix epoch seconds, or that the default tolerance window is ±5 minutes.
3. **Idempotency key composition.** The spec says "bound to the source id and event id" but does not specify the durable table (`source_webhook_events`) or the `(source_id, event_id)` uniqueness constraint.
4. **Error codes and HTTP status semantics.** The spec does not enumerate the error codes (`missing_event_id`, `missing_timestamp`, `missing_signature`, `unknown_source`, `stale_timestamp`, `invalid_signature`, `invalid_payload`) or their HTTP statuses (401 for auth/replay failures, 400 for payload errors, 404 for unknown source).
5. **Owner/session auth absence rationale.** The spec says "SHALL NOT accept source callbacks authenticated with owner bearer tokens, client grant tokens, or local collector device credentials" but does not explain *why* — specifically that the `/_ref/source-webhooks/:sourceId` route is intentionally outside the `_ref` owner-session gate because it is a machine-to-machine callback endpoint, not an operator surface.
6. **Payload action vocabulary.** The spec does not enumerate the two supported `action` values (`ingest_records`, `schedule_run`) or their required fields.

## Proposed Change

Extend the spec with a precise envelope/security-boundary section that documents the current implementation contract, so future implementers and reviewers can audit conformance without reading source code. No new behavior is introduced.

## Scope

- New spec delta in `openspec/changes/add-source-webhook-ingress/specs/reference-implementation-architecture/spec.md` containing the under-specified requirements.
- The four existing requirements in the canonical spec (lines 4349–4388) are preserved as-is; this change adds adjacent precision requirements and replaces them on archive.
- No runtime code changes. The implementation already conforms; this change catches the spec up to the code.

## Out of Scope

- Generic PDPP push delivery or event-driven grant semantics (deferred per `spec-deferred.md`).
- Source subscription lifecycle (subscribe/renew/expire) — see promotion triggers in `source-webhooks-and-event-driven-collection-2026-05-15.md`.
- Cross-source webhook standardization or a PDPP Push Delivery Profile.
- Binary mode, SSE pull, or catch-up replay for source webhooks.
