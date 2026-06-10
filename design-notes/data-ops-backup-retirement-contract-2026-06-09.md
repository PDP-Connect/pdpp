# Data-Ops Backup Retirement Contract

Status: captured
Owner: reference implementation owner
Created: 2026-06-09
Related: design-notes/full-context-refresh.md (Decision Log 2026-06-01, lane cleanup contracts), tmp/workstreams/db-hygiene-report-2026-06-09.md, openspec/changes/archive (compaction/migration/remediation tooling changes)

## Question

What contract should every data operation (compaction, migration, repair, replay, backfill) follow for the safety snapshots it creates, so scratch tables stop accreting unbounded in the live store?

## Context

The 2026-06-09 hygiene pass found 243 operation-scratch tables totaling 18.1GB in the live Postgres database — 35% of the entire database — accumulated over ~3 weeks across 9 tool families (`compact_record_history_backup_*`, `mig_*`, `rcpr_backup_*`, `ccr_backup_*`, `fix_*`, `repair_*`, `cleanup_*`, `backfill_*`, `backup_*`). Every one was created correctly: a point-in-time safety copy taken before a mutation. None was ever retired: no tool has a post-verification step that drops its own snapshot, no inventory exists, and nothing surfaces their count or size to the owner.

This is the data-plane twin of the worktree problem already solved by the lane cleanup contract (Decision Log 2026-06-01): "every delegated lane needs a cleanup contract at launch time" — but data operations were never given the same rule.

A second instance of the same gap: deleted heap space. Compaction deleted ~17M rows from `record_changes`, leaving an 11GB file holding 2GB of content; nothing in the operation's definition of "done" included reclaiming the space (`VACUUM FULL` recovered ~9.7GB).

## Current Leaning

Every mutating data-ops tool should ship with a retirement contract, declared at write time, not improvised later:

- **Registry**: snapshots are recorded in a small `data_ops_backups` ledger table (backup table name, source operation, created_at, verify_by, verified_at, retire_after, dropped_at) at creation time. Naming alone is not a registry.
- **Verify-then-retire is part of the operation**: an operation is not "done" until its verification step has either retired the snapshot or explicitly extended it with a reason. Default TTL on the order of days, not forever.
- **Space accounting is part of done**: operations that delete in bulk state the expected reclaim and either perform it (vacuum/repack window) or record it as owed in the ledger.
- **Visibility**: a deployment-diagnostics surface (or `_ref` route) reports pending scratch: count, total size, oldest. Warning-only, per the reference-heuristics rule (2026-06-01): visible, never auto-deleting.
- **Sweeper, not surgery**: a single owner-gated sweep command retires expired, verified entries — replacing ad-hoc SQL archaeology like the 2026-06-09 pass.

This is reference-implementation-owned semantics (operational diagnostics), not PDPP Core; it must not leak into protocol surfaces.

## Promotion Trigger

Promote into OpenSpec before shipping the next tool that snapshots live tables (any new compaction, migration, backfill, or repair lane), or before building the deployment-diagnostics storage tile — whichever comes first.

## Decision Log

- 2026-06-09: Captured after the owner-gated hygiene pass (52GB → 22GB: 18GB residue drop + ~12GB vacuum reclaim, manifest + dumps preserved). Conclusion: the failure was not any single tool but the absence of a shared retirement contract; fix by construction, not by periodic audits.
