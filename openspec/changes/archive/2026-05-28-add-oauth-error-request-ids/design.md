## Context

The reference exposes two classes of public HTTP surfaces:

- OAuth authorization-server endpoints whose clients already expect `{ error, error_description }`.
- PDPP resource/query/control endpoints whose clients expect `{ error: { type, code, message, request_id } }`.

Changing OAuth endpoints to the nested PDPP envelope would make the implementation more uniform internally but less compatible with OAuth tooling. The higher-value fix is to keep OAuth's error shape and add the same traceability guarantees that PDPP errors already have.

## Decision

The reference will add `request_id` to OAuth error bodies and set the `Request-Id` header for OAuth errors. Routes that already have a trace context will reuse it. Routes without one will allocate a request id at error-write time.

## Out Of Scope

- Converting OAuth errors to nested PDPP envelopes.
- Adding request ids to every OAuth success response.
- Changing introspection's inactive-token success shape.

## Acceptance Checks

- DCR rejection includes `error`, `error_description`, `request_id`, and a matching `Request-Id` header.
- Device authorization rejection includes `request_id` without losing the RFC-shaped fields.
- Device token rejection includes `request_id` without losing the RFC-shaped fields.
- The OpenAPI/contract OAuth error schema includes `request_id`.
