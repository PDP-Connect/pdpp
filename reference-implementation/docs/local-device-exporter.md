# Local Device Exporter Runbook

Status: reference-experimental. This is an RI owner/operator surface, not a PDPP Core or Collection Profile protocol contract.

The local device exporter lets a user run a connector on a separate machine and push batches into a reference server without granting that machine an owner token. The server issues a short-lived enrollment code from the owner dashboard, exchanges it for a device-scoped ingest credential, and only accepts heartbeat or ingest on `/_ref/device-exporters/*`.

## Run

1. Open `/dashboard/device-exporters`.
2. Create an enrollment code for a connector id and local binding name.
3. On the device that has the local data, run:

```bash
pnpm --dir packages/polyfill-connectors exec tsx bin/local-device-exporter.ts enroll \
  --base-url http://127.0.0.1:7662 \
  --code <enrollment-code>
```

4. Use the returned `device_id`, `device_token`, and `source_instance_id` to run Codex export:

```bash
pnpm --dir packages/polyfill-connectors exec tsx bin/local-device-exporter.ts run \
  --base-url http://127.0.0.1:7662 \
  --device-id <device-id> \
  --device-token <device-token> \
  --source-instance-id <source-instance-id>
```

Environment equivalents:

- `PDPP_REFERENCE_BASE_URL`: reference AS base URL.
- `PDPP_LOCAL_DEVICE_ID`: enrolled device id.
- `PDPP_LOCAL_DEVICE_TOKEN`: device-scoped ingest token.
- `PDPP_SOURCE_INSTANCE_ID`: source instance id returned by enrollment.
- `PDPP_LOCAL_DEVICE_QUEUE`: durable queue path. Defaults to `packages/polyfill-connectors/.pdpp-data/local-device-exporter-queue.json`.

## Boundaries

- Device credentials are not owner or client grant tokens.
- Owner-token and client-token routes do not accept device credentials.
- Device ingest uses a reference-internal storage connector id derived from connector id plus source instance id to avoid overwriting same stream/key records from different devices.
- Device-scoped local collector STATE read/write is available through the same device-exporter authority at `GET|PUT /_ref/device-exporters/:deviceId/source-instances/:sourceInstanceId/state`. The route uses the existing device bearer credential, stores state under the same internal storage connector id used by device ingest, and never collides with the owner-auth `/v1/state/:connectorId` route (which remains keyed by public connector id plus grant). See OpenSpec `design-local-collector-state-sync` for the load/replay/persist contract.
- The public/source-instance vocabulary remains an open protocol question owned outside the RI. See `design-notes/source-authority-vs-schema-identity-2026-04-30.md`.
