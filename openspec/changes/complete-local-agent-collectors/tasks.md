## 1. Contract And Inventory

- [x] 1.1 Add Claude Code and Codex source-inventory modules that classify every known local store under the configured source home.
- [ ] 1.2 Add fixture directories covering declared streams, missing stores, unknown stores, auth-adjacent files, cache files, logs, backups, and multi-device source homes.
- [x] 1.3 Add manifest stream declarations for approved collectible streams and coverage diagnostics without enabling risky payload collection by default.
- [x] 1.4 Document stream contracts, record ids, redaction rules, checkpoint behavior, and blob behavior for each approved stream. (see `design-notes/stream-contracts.md`)

## 2. Privacy And Security

- [x] 2.1 Implement classification defaults: auth-adjacent files excluded, raw cache/config/backups inventory-only, logs/debug/downloads deferred or redacted until approved.
- [ ] 2.2 Add redaction tests for any stream that emits log, debug, config, or shell content.
- [x] 2.3 Add negative tests proving token files, installation identifiers, browser cookies, and raw credential material are not emitted as records or blobs.
- [x] 2.4 Add owner/operator copy explaining why excluded and inventory-only stores do not count as missing collection failures. (see `docs/operator/local-collector-runbook.md` §"Coverage and excluded stores")

## 3. Connector Instances And Multi-Device

- [ ] 3.1 Bind each local source home to a connector instance before accepting new local collector records, state, blobs, diagnostics, or schedules.
- [ ] 3.2 Namespace local record ids and checkpoints by connector instance so two devices cannot collide on skills, prompts, rules, sessions, or local filenames.
- [ ] 3.3 Add migration for existing single-device Claude Code and Codex state into one connector instance per owner, connector type, and source home.
- [ ] 3.4 Add tests proving two Claude or two Codex source homes can ingest the same connector-local keys without overwriting each other.

## 4. Stream Implementation

- [ ] 4.1 Add Claude `file_history` collection with bounded scanning, stable ids, checkpointing, and fixture tests.
- [ ] 4.2 Add Claude `context_mode` collection or mark it inventory-only with a documented deferral if file shapes are unstable.
- [ ] 4.3 Add Claude debug, downloads, cache, backup, and config inventory streams according to the privacy classification.
- [ ] 4.4 Add Codex `history`, `session_index`, `shell_snapshots`, `memories`, and `context_mode` streams with fixture tests.
- [ ] 4.5 Add Codex `logs`, config, and cache inventory/redacted streams according to the privacy classification.

## 5. Diagnostics And Validation

- [ ] 5.1 Emit a safe coverage diagnostic for every full local Claude Code and Codex run showing collected, inventory-only, excluded, deferred, missing, and unsupported stores.
- [ ] 5.2 Make scheduler/run success distinguish declared-stream success from completeness status.
- [ ] 5.3 Add dashboard or `_ref` diagnostics that expose local completeness without leaking raw local paths or secrets.
- [ ] 5.4 Run `openspec validate complete-local-agent-collectors --strict`.
- [ ] 5.5 Run relevant connector tests, source-preflight tests, scheduler tests, and multi-device ingest tests.
