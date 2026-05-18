# Local Device Exporter Runbook

Status: reference-experimental. This is an RI owner/operator surface, not a PDPP Core or Collection Profile protocol contract.

The local device exporter lets a user run a connector on a separate machine and push batches into a reference server without granting that machine an owner token. The server issues a short-lived enrollment code from the owner dashboard, exchanges it for a device-scoped ingest credential, and only accepts heartbeat or ingest on `/_ref/device-exporters/*`.

For the end-to-end operator path against the Docker reference deployment (Claude Code and Codex sources, with resumable state via `design-local-collector-state-sync`), see [`docs/operator/local-collector-runbook.md`](../../docs/operator/local-collector-runbook.md). It uses the canonical `pdpp collector` surface and is the supported operator path going forward.

## Run

1. Open `/dashboard/device-exporters`.
2. Create an enrollment code for a connector id and local binding name. The dashboard then renders the matching `pdpp collector enroll` and `pdpp collector run` commands pre-filled with the public reference base URL and the freshly minted code.
3. On the device that has the local data, run the canonical collector flow (preferred &mdash; this is the only path that exercises STATE load/replay/persist through the device-scoped state route):

```bash
pnpm exec pdpp collector enroll \
  --base-url http://127.0.0.1:7662 \
  --code <enrollment-code>
```

4. Use the returned `device_id`, `device_token`, and `source_instance_id` (the legacy device-binding selector used as `PDPP_CONNECTION_ID`) to run a connector pass. Responses may also include `connector_instance_id`, which is the server-side owner-facing connection id for diagnostics and instance-scoped storage:

```bash
PDPP_LOCAL_DEVICE_ID=<device_id> \
PDPP_LOCAL_DEVICE_TOKEN=<device_token> \
PDPP_CONNECTION_ID=<connection_id> \
  pnpm exec pdpp collector run --base-url http://127.0.0.1:7662 --connector claude_code
```

Swap `--connector claude_code` for `codex` (or any other in-runtime-profile connector) to run a different lane. Re-running is safe: prior STATE replays into the next `START` envelope and emitted STATE is only persisted after records are durably accepted.

### Legacy lane (no STATE sync)

The older single-purpose script under `packages/polyfill-connectors/bin/local-device-exporter.ts` is still present as a compatibility shim. It does not participate in STATE sync and is being retired by `introduce-local-collector-runner`. Prefer the `pdpp collector` flow above.

```bash
pnpm --dir packages/polyfill-connectors exec tsx bin/local-device-exporter.ts enroll \
  --base-url http://127.0.0.1:7662 \
  --code <enrollment-code>
pnpm --dir packages/polyfill-connectors exec tsx bin/local-device-exporter.ts run \
  --base-url http://127.0.0.1:7662 \
  --device-id <device-id> \
  --device-token <device-token> \
  --connection-id <connection-id>
```

Environment equivalents:

- `PDPP_REFERENCE_BASE_URL`: reference AS base URL.
- `PDPP_LOCAL_DEVICE_ID`: enrolled device id.
- `PDPP_LOCAL_DEVICE_TOKEN`: device-scoped ingest token.
- `PDPP_CONNECTION_ID`: device-binding selector returned by enrollment as `source_instance_id`.
- `PDPP_SOURCE_INSTANCE_ID`: compatibility alias for existing local device bindings.
- `PDPP_RUN_ID`: optional stable run id for streaming-companion target registration.
- `PDPP_COLLECTOR_QUEUE`: durable queue path for `pdpp collector`. Defaults to a connection-scoped file under `packages/polyfill-connectors/.pdpp-data/`.
- `PDPP_LOCAL_DEVICE_QUEUE`: durable queue path for the legacy lane. Defaults to a connection-scoped file under `packages/polyfill-connectors/.pdpp-data/`.

## Boundaries

- Device credentials are not owner or client grant tokens.
- Owner-token and client-token routes do not accept device credentials.
- Device ingest resolves the device-binding selector to an authorized `connector_instance_id` before writing records or state, so same stream/key records from different devices do not overwrite each other. Existing device routes and JSON still call the device-binding selector `source_instance_id`.
- Device-scoped local collector STATE read/write is available through the same device-exporter authority at `GET|PUT /_ref/device-exporters/:deviceId/source-instances/:sourceInstanceId/state`. The route uses the existing device bearer credential, stores state under the same internal storage connector id used by device ingest, and never collides with the owner-auth `/v1/state/:connectorId` route (which remains keyed by public connector id plus grant). See OpenSpec `design-local-collector-state-sync` for the load/replay/persist contract.
- The public/source-instance vocabulary remains an open protocol question owned outside the RI. See `design-notes/source-authority-vs-schema-identity-2026-04-30.md`.
