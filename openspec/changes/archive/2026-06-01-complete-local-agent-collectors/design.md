## Context

The 2026-05-15 completeness audit found that Docker scheduled success only covers declared streams. Claude Code currently declares sessions, messages, attachments, skills, memory notes, and slash commands. Codex currently declares sessions, messages, function calls, rules, prompts, and skills.

Local owner homes include more state than those manifests declare. Observed gaps include Claude `file-history`, debug, downloads, cache, and backups, plus Codex `history.jsonl`, `session_index.jsonl`, logs SQLite, shell snapshots, config, cache, and auth-adjacent files. Some installations also contain user-specific tool state such as `context-mode` or local memory directories. Stable Claude/Codex connector streams must not absorb those personal/tool-specific stores by default; they are accounted for through coverage diagnostics or explicit future opt-in source contracts.

This change is a design and spec lane only. Implementation must happen later against the tasks and requirements here.

## Goals / Non-Goals

**Goals:**

- Define a source inventory for 100% complete local Claude Code and Codex collection.
- Define durable stream names for stable, collectible local stores.
- Define privacy/security exclusions before collecting auth-adjacent or high-risk files.
- Define source-home and multi-device assumptions.
- Tie local source homes to connector instances so records, checkpoints, schedules, diagnostics, and artifacts do not collide.
- Require coverage diagnostics for mounted but uncollected local stores, including local/private stores that are intentionally outside the general Claude/Codex connector contract.

**Non-Goals:**

- Do not implement connector changes in this lane.
- Do not collect secrets, raw auth files, or machine credential material by default.
- Do not claim these local completeness contracts are PDPP Core semantics.
- Do not solve cross-instance deduplication across devices.
- Do not force every cache/debug/log file into a first-class stream before privacy review.
- Do not make user-specific tools or private local conventions, such as `context-mode`, part of the general Claude/Codex connector surface.

## Decisions

### Completeness Means Inventory Coverage

Completeness is defined as every known local store being either collected into an approved stream or reported as excluded/deferred with a reason. A run that only emits all currently requested declared streams is not complete unless the coverage diagnostic confirms no mounted source store is unaccounted for.

Alternative considered: keep scheduled success as the completeness signal. Rejected because it silently ignores newly discovered host stores.

### Durable Stream Names

Claude Code stream names:

- `file_history`: standalone `file-history/**` snapshots and metadata.
- `debug_artifacts`: redacted debug artifacts approved for collection.
- `downloads`: owner-visible downloaded artifacts approved for collection.
- `cache_inventory`: cache file inventory and safe metadata, not raw cache payloads by default.
- `backup_inventory`: backup file inventory and safe metadata, not raw backup payloads by default.
- `config_inventory`: non-secret configuration inventory and safe metadata only.

Codex stream names:

- `history`: `history.jsonl` prompt/activity history.
- `session_index`: `session_index.jsonl` session index entries.
- `logs`: redacted logs SQLite records approved for collection.
- `shell_snapshots`: shell snapshot files and metadata.
- `config_inventory`: non-secret configuration inventory and safe metadata only.
- `cache_inventory`: cache file inventory and safe metadata, not raw cache payloads by default.

Alternative considered: use one generic `local_files` stream. Rejected because stream-level contracts, grants, privacy review, and tests need stable semantics by store type.

Explicitly excluded from the general stream-name list:

- `context_mode`: a user-specific local tool convention, not a general Claude Code or Codex product surface.
- Codex `memories`: deferred until there is evidence of a stable general Codex memory surface and a reviewed privacy contract.

These stores may be reported by safe coverage diagnostics as `deferred`, `excluded`, or `unsupported`, but they should not be requested by default profiles or treated as complete general connector streams.

### Privacy And Security Classification

Every discovered local store must be classified before collection:

- `collect`: safe to emit records with content.
- `collect_redacted`: safe only after deterministic redaction of secrets and machine-local identifiers.
- `inventory_only`: emit path hash, size, mtime, type, and reason, but not payload.
- `exclude`: do not emit payload or inventory beyond a coarse diagnostic reason.
- `defer`: known store requiring owner/product decision before contract finalization.

Auth-adjacent files such as `auth.json`, installation IDs, token stores, raw credential material, browser cookies, and equivalent config entries default to `exclude` unless a later explicit security review moves a narrow subset to `inventory_only` or `collect_redacted`.

Alternative considered: collect all files under the tool home and rely on downstream grants. Rejected because collection itself would copy secrets into reference storage before owner-safe classification.

### Source Homes Are Instance-Scoped

Each local source home is a source binding on a connector instance. The binding must include a stable device/source-home identity that is not the raw local path. Records and blobs must be namespaced by `connector_instance_id`, connector id, stream, and connector-local key.

One device can host both Claude Code and Codex instances, and a single connector type can appear on multiple devices. A device is not a connector instance; the source home binding is.

Alternative considered: include device id in record ids without connector instances. Rejected because connector state, schedules, leases, diagnostics, and owner UX need the same namespace, not just records.

### Coverage Diagnostics

Each full local collector run must emit coverage diagnostics that list known stores as collected, inventory-only, excluded, deferred, missing, or unsupported. Diagnostics must be safe for owner/operator display and must not include raw secrets or unredacted local paths unless explicitly configured for local-only debugging.

Alternative considered: rely on tests to catch missing stores. Rejected because owner homes vary and new tool releases can add stores after tests were written.

## Risks / Trade-offs

- Secret leakage risk -> Default auth-adjacent and raw cache/config/log material to `exclude` or `inventory_only`; require redaction tests before content streams.
- Stream proliferation -> Use store-specific streams only where grant, privacy, or testing semantics differ; use inventory streams for risky payload classes.
- Multi-device migration complexity -> Require connector-instance design alignment before implementation writes new record ids or checkpoints.
- Tool store volatility -> Coverage diagnostics make unknown stores visible without forcing immediate payload collection.
- Large local history volume -> Tasks must add bounded scanning, checkpointing, and fixture tests before enabling high-volume streams.

## Migration Plan

Implementation should land in slices. First add source inventory and diagnostics without collecting new payload content. Then add low-risk payload streams such as Codex `history`, `session_index`, and Claude `file_history` after fixture and privacy tests. Finally evaluate redacted log/debug/download streams and inventory-only config/cache/backups. User-specific stores such as `context-mode` and unproven Codex memory directories remain outside the general connector contract unless a later source-specific opt-in design approves them.

Existing single-device deployments should migrate to one connector instance per owner, connector type, and source home. Compatibility reads or operator actions may accept connector-only identifiers only when exactly one local instance exists for that owner and connector type.

Rollback should disable newly declared streams while preserving coverage diagnostics so owners can still see which stores are uncollected.

## Open Questions

- Should user-specific local tools such as `context-mode` be represented later as separate custom local sources rather than Claude/Codex connector streams?
- Which fields in Codex `logs_2.sqlite` can be redacted deterministically without losing useful run diagnostics?
- Should Claude `downloads` and `backups` expose payload blobs, inventories, or both after owner review?
- Should local absolute paths ever appear in owner-only diagnostics, or should diagnostics always use source-home-relative paths and hashes?
- Which connector-instance identity fields, if any, should eventually be promoted into Collection Profile vocabulary?
