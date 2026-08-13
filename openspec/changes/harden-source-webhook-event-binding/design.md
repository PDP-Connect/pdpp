## Context

The reference source webhook endpoint is intentionally not a PDPP Core protocol surface. It is enabled only by operator-configured `PDPP_SOURCE_WEBHOOK_SECRETS` and uses PDPP-prefixed headers. The existing operation claimed idempotency by `(source_id, event_id)` after verifying an HMAC over only `timestamp.body`.

That left the signed payload and idempotency identity braided incorrectly: identity controlled replay state but was not authenticated by the signature.

## Decision

Sign `event_id.timestamp.body` for inbound source webhook callbacks.

This mirrors the event-id binding used by the outbound Standard Webhooks profile while keeping the inbound PDPP-prefixed header names and hex `sha256=` encoding. The changed contract is narrow because this ingress is reference-only and no external SDK sender was found beyond local tests and operator docs.

## Alternatives

- Keep `timestamp.body` and rely on `(source_id, event_id)` idempotency. Rejected because it lets a valid signed body choose a new replay identity.
- Add body-size or owner/connection scoping changes. Rejected as separate findings outside this slice.

## Acceptance Checks

- Operation test proves the old replay case fails with `invalid_signature`.
- Focused operation, pure validation, and route tests pass.
- Typecheck, focused Biome, OpenSpec strict validation, and stale signing-form grep pass.
