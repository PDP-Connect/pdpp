## 1. Server Storage And Credentials

- [x] 1.1 Add SQLite and Postgres tables/adapters for device exporters, source instances, device ingest credentials, enrollment codes, and ingest batch outcomes.
- [x] 1.2 Add storage conformance tests covering enrollment lifecycle, token lookup, revocation, source-instance lookup, batch idempotency, and batch conflict rejection.
- [ ] 1.3 Add a dedicated device credential verifier that rejects owner tokens and client grant tokens on device routes.
- [x] 1.4 Add migration/bootstrap behavior so existing reference instances start with zero enrolled devices and no behavior change.

## 2. Server Routes And Ingest

- [ ] 2.1 Add owner-authenticated reference routes to create enrollment codes, list devices/source instances, revoke devices, and read diagnostics.
- [ ] 2.2 Add device-authenticated routes to exchange enrollment codes, heartbeat, and submit ingest batches.
- [ ] 2.3 Add the reference-only device ingest envelope parser and validation for `device_id`, `source_instance_id`, `batch_id`, `batch_seq`, `body_hash`, connector id, stream, record key, emitted time, and normalized record data.
- [ ] 2.4 Route accepted device records through source-instance-aware storage before reusing existing record ingest and index maintenance.
- [ ] 2.5 Add server tests proving duplicate same-body batches are idempotent, conflicting batch bodies are rejected, and unknown/revoked device credentials cannot ingest.
- [ ] 2.6 Add multi-device collision tests proving two Codex source instances can push the same stream/key without overwriting each other.

## 3. Local Codex Exporter Agent

- [ ] 3.1 Add a Codex-first local device exporter CLI under `packages/polyfill-connectors` that can enroll with a reference server using a one-time code.
- [ ] 3.2 Run the existing Codex connector locally through the Collection Profile runtime and transform emitted records into the device ingest envelope.
- [x] 3.3 Add a small durable local queue with per-source-instance ordering, retry backoff, and permanent-error recording.
- [x] 3.4 Add tests for queue persistence, retry ordering, permanent validation failures, and heartbeat diagnostics payloads.
- [ ] 3.5 Document required environment variables and local state paths without requiring owner tokens in the agent.

## 4. Dashboard And Reference UI

- [ ] 4.1 Add web data clients/actions for device exporter enrollment, listing, revocation, and diagnostics.
- [ ] 4.2 Add owner dashboard UI for enrolled devices, source instances, heartbeat freshness, ingest counts, stale/revoked state, and last error.
- [ ] 4.3 Add dashboard tests proving owner auth is preserved and diagnostics render from the reference data source.
- [ ] 4.4 Ensure sandbox/mock-owner pages do not present local device exporter controls as public protocol or hosted documentation.

## 5. Documentation And Validation

- [ ] 5.1 Update RI docs with the local device exporter runbook and reference-experimental boundary.
- [ ] 5.2 Link the device/source-instance protocol questions to `design-notes/source-authority-vs-schema-identity-2026-04-30.md`.
- [ ] 5.3 Run SQLite-focused server and CLI tests for device enrollment, ingest, and query behavior.
- [ ] 5.4 Run Postgres-focused server tests for equivalent storage and idempotency behavior.
- [ ] 5.5 Run `pnpm --dir packages/polyfill-connectors run test` and `pnpm --dir packages/polyfill-connectors run verify`.
- [ ] 5.6 Run relevant web tests for dashboard device diagnostics.
- [ ] 5.7 Run `openspec validate implement-local-device-exporter --strict`, `openspec validate --all --strict`, and `git diff --check`.
