## Context

The local collector's durable outbox protects records from process crashes and transient server failures. That protection is undermined when a collector host points at a wrong or unreachable reference URL: the runner can lease and retry saved work before it proves the destination route is usable.

The observed failure mode was topology-specific, but the design problem is general: a local collector may be moved to another machine, VPN, reverse proxy, or deployment where the configured reference base URL no longer reaches the device-exporter routes.

## Design

Add a runner startup precondition before any durable outbox mutation:

1. Open the outbox so the precondition can report current queue counts.
2. Send the existing device heartbeat to the configured reference URL with `status: "starting"` and bounded diagnostics.
3. If the heartbeat fails, throw the existing typed local-device HTTP/timeout error and stop before lease recovery, outbox drain, or source scanning.
4. If it succeeds, continue with the existing startup sequence.

This deliberately uses the existing heartbeat contract rather than a new discovery endpoint. It proves the route that matters for a run: the base URL, the device-exporter path, the collector protocol header, device id, device token, and source binding are all accepted by the reference.

For `doctor`, add a non-mutating route check. When device id, token, and source instance id are configured, `doctor` performs a bounded `GET` of the device-scoped source-state route. That diagnoses bad base URLs, reverse-proxy 502s, protocol mismatches, and invalid device credentials without uploading data or changing collection state. When the required device config is absent, `doctor` reports the route check as `unknown` instead of guessing.

## Alternatives

- Use `/.well-known/oauth-protected-resource` as the route proof. Rejected: the local collector's configured console/proxy port does not necessarily serve that discovery route, while the device-exporter route is the actual run dependency.
- Add a new no-op device-exporter ping endpoint. Rejected for this tranche: the heartbeat and state-read routes already provide the needed proof without expanding the server API.
- Let transient dead-letter auto-recovery repair this later. Rejected: recovery is useful after a real destination failure, but a known-bad route should fail before touching saved local work.

## Acceptance Checks

- A run with a bad heartbeat route fails before `recoverExpiredLeases`, drain, or source scan mutates the outbox.
- The same failure leaves existing pending rows pending, not leased, retrying, or dead-lettered.
- A healthy run still sends route/start heartbeats with build-derived agent version and continues to drain/scans as before.
- `pdpp-local-collector doctor` reports `reference_route` as `ok`, `fail`, or `unknown` with redacted, bounded details.
- OpenSpec validation and targeted local-collector/polyfill tests pass.
