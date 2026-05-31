## 1. Contract And Inventory

- [x] 1.1 Add Claude Code and Codex source-inventory modules that classify every known local store under the configured source home.
- [x] 1.2 Add fixture directories covering declared streams, missing stores, unknown stores, auth-adjacent files, cache files, logs, backups, and multi-device source homes. (see `packages/polyfill-connectors/fixtures/{claude_code,codex}/source-home/`)
- [x] 1.3 Add manifest stream declarations for approved collectible streams and coverage diagnostics without enabling risky payload collection by default.
- [x] 1.4 Document stream contracts, record ids, redaction rules, checkpoint behavior, and blob behavior for each approved stream. (see `design-notes/stream-contracts.md`)

## 2. Privacy And Security

- [x] 2.1 Implement classification defaults: auth-adjacent files excluded, raw cache/config/backups inventory-only, logs/debug/downloads deferred or redacted until approved.
- [x] 2.2 Add redaction tests for any stream that emits log, debug, config, or shell content. (current approved contract keeps risky stores inventory-only/deferred/excluded; `source-inventory.fixture.test.ts` asserts planted sentinels never emit)
- [x] 2.3 Add negative tests proving token files, installation identifiers, browser cookies, and raw credential material are not emitted as records or blobs.
- [x] 2.4 Add owner/operator copy explaining why excluded and inventory-only stores do not count as missing collection failures. (see `docs/operator/local-collector-runbook.md` §"Coverage and excluded stores")

## 3. Connector Instances And Multi-Device

- [x] 3.1 Bind each local source home to a connector instance before accepting new local collector records, state, blobs, diagnostics, or schedules. (Enroll mints a `source_instance_id`+`connector_instance_id` per source home; the local-device exporter is connector-agnostic so Claude Code and Codex bind through the same envelope path. Each accept path resolves the authorized connector instance from `(device, source_instance)` before writing: records (`device-exporter-routes.test.js` two-device + two-claude-home tests), state/checkpoints (`device-exporter-state-routes.test.js` rejects owner token / cross-device / revoked / unknown source before any write; new `device-exporter-routes.test.js` "two source homes keep collector state/checkpoints isolated by connector instance"), diagnostics (`device-exporter-routes.test.js` "diagnostics scope … to the source instance"), schedules + active runs (`connector-instance-admission-routes.test.js` "reference run and schedule actions reject ambiguous connector-only admission" — schedule read/PUT/pause/resume/delete and run all operate on the instance), blobs (`connector-instance-admission-routes.test.js` instance-scoped blob isolation; the local-device ingest path shares the same `(connector_instance_id, stream, record_key)` storage target). Active-run *leases* (`browser_surface_leases`) are a browser-surface mechanism the local-device collector path does not use — see Residual.)
- [x] 3.2 Namespace local record ids and checkpoints by connector instance so two devices cannot collide on skills, prompts, rules, sessions, or local filenames. (Records persist under `UNIQUE(connector_instance_id, stream, record_key)`; checkpoints/state persist under `PRIMARY KEY(connector_instance_id, stream)` (`connector_state`) and `PRIMARY KEY(grant_id, connector_instance_id, stream)` (`grant_connector_state`). Proven for both halves: records (`device-exporter-routes.test.js` shared-key two-home test) and checkpoints (`device-exporter-state-routes.test.js` "Two-device isolation" + "Single device with two source instances"; new `device-exporter-routes.test.js` state test asserts two `(connector-code, sessions)` checkpoint rows coexist under distinct `connector_instance_id`s).)
- [x] 3.3 Add migration for existing single-device Claude Code and Codex state into one connector instance per owner, connector type, and source home. (`migrateLocalDeviceConnectorInstances` (server/db.js) walks each `device_source_instances` row, derives the canonical `(owner, connector, local_device, local_binding_name)` instance, and re-homes legacy `local-device:<id>:<source>` rows across records/state/blobs/schedules/active-runs/gaps/search to that one instance. It backfills `device_source_instances.connector_instance_id` when NULL and **fails clearly** when re-homing is ambiguous (NULL source-row instance + disagreeing legacy instance ids, or a binding/source instance-id conflict). Proven by `device-exporter-state-routes.test.js` "startup migrates legacy local-device source namespaces to connector-instance scope" and new "startup migration fails clearly when a legacy local-device source maps to more than one connector instance". The connector-only ambiguity guard for live operations is also covered by `connector-instance-admission-routes.test.js`. Note: the migration re-homes rows that already carry a `local-device:`-namespaced `connector_id`; rows with no source-home identity at all cannot be re-homed deterministically — see Residual.)
- [x] 3.4 Add tests proving two Claude or two Codex source homes can ingest the same connector-local keys without overwriting each other. (Codex: `device-exporter-routes.test.js` two-device `same-key` test. Claude Code: new `device-exporter-routes.test.js` canonical `claude-code` route+storage test, plus connector+envelope-level `packages/polyfill-connectors/connectors/claude_code/multidevice-binding.fixture.test.ts` proving both fixture homes emit the identical `skills:demo-skill` key yet stay isolated per source instance.)

## 4. Stream Implementation

- [ ] 4.1 Add Claude `file_history` collection with bounded scanning, stable ids, checkpointing, and fixture tests.
- [ ] 4.2 Remove or hide Claude `context_mode` from the general connector surface; if discovered locally, account for it only through safe diagnostics or a future explicit opt-in source.
- [ ] 4.3 Add Claude debug, downloads, cache, backup, and config inventory streams according to the privacy classification.
- [ ] 4.4 Add Codex `history`, `session_index`, and reviewed `shell_snapshots` handling with fixture tests; keep Codex `memories` and `context_mode` out of the general connector surface unless a later review approves them.
- [ ] 4.5 Add Codex `logs`, config, and cache inventory/redacted streams according to the privacy classification.

## 5. Diagnostics And Validation

- [ ] 5.1 Emit a safe coverage diagnostic for every full local Claude Code and Codex run showing collected, inventory-only, excluded, deferred, missing, and unsupported stores.
- [ ] 5.2 Make scheduler/run success distinguish declared-stream success from completeness status.
- [ ] 5.3 Add dashboard or `_ref` diagnostics that expose local completeness without leaking raw local paths or secrets.
- [ ] 5.4 Run `openspec validate complete-local-agent-collectors --strict`.
- [ ] 5.5 Run relevant connector tests, source-preflight tests, scheduler tests, and multi-device ingest tests.
