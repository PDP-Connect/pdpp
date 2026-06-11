## Context

The reference read surface has two adjacent routes with different purposes:

- `GET /v1/streams/:stream` returns stream metadata.
- `GET /v1/streams/:stream/records` returns records.

A reported failure mixed those routes, but it also exposed a real parity gap. Owner bearer callers can discover `connection_id` from `/v1/streams`, and the public records query contract accepts `connection_id`, but `resolveOwnerReadScope` only reads `connector_id` for polyfill owner reads. MCP did not hit the bug because MCP uses grant-scoped client tokens and the client/grant path already resolves `connection_id`.

## Decision

The owner-bearer read scope resolver resolves `connection_id` before falling back to `connector_id`. The resolver SHALL:

- Parse canonical `connection_id` plus the deprecated `connector_instance_id` alias through the shared helper.
- Look up the referenced connector instance for the owner token subject.
- Require an active connection owned by that subject.
- Use the resolved row's `connector_id` and `connector_instance_id` as the storage binding.
- If `connector_id` is also supplied, verify it matches the resolved connection's connector.

This keeps REST, MCP, and storage fan-in semantics aligned without inventing a second connection identity system.

## Alternatives

- Require `connector_id` for owner REST forever: rejected because it leaves the advertised records contract misleading and forces owners to carry two identifiers after stream discovery.
- Treat `connection_id` as a raw `connector_instance_id` without resolving the row: rejected because the read scope still needs the connector id, ownership, and active-status check.
- Change `/v1/streams/:stream` to return records: rejected because that route is intentionally metadata-only.

## Acceptance Checks

- `openspec validate owner-connection-id-records-parity --strict`
- `node --test reference-implementation/test/trusted-owner-agent-rest-boundary.test.js`
- Owner bearer can call `/v1/streams/:stream/records?connection_id=<discovered id>&limit=1` without `connector_id`.
