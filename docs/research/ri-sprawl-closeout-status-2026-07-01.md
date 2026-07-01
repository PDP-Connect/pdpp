# RI worktree, OpenSpec, and research sprawl closeout status - 2026-07-01

Status: durable closeout note for the RI-owner sprawl ledger.

## What is closed

The retroactive sprawl item is closed as an owner-ledger item. The repository
now has durable tracked artifacts for the major themes that were previously
only in workstream scratch files:

- source-actionability acceptance:
  `docs/research/source-actionability-acceptance-closeout-2026-07-01.md`;
- ChatGPT session/auth regression proof:
  `docs/research/chatgpt-session-reuse-regression-closeout-2026-06-29.md`;
- MCP read-evidence closeout:
  `docs/research/mcp-closeout-status-2026-07-01.md`;
- connector residual classification:
  `docs/research/connector-residual-classification-2026-07-01.md`.

The missing-`START` runtime incident also has archived OpenSpec evidence and a
live deployed fix at `5c3108d11`.

## What remains by design

Historical local worktrees and scratch workstream reports still exist. They are
not product truth and should not keep the RI owner ledger open. They are cleanup
inventory, subject to the deletion standard below.

Active OpenSpec changes also remain. That is not sprawl by itself. An active
OpenSpec is retained when it represents real proposed work or an accepted
residual risk. It becomes sprawl only when it is implemented-but-unarchived,
superseded, or no longer maps to an intended capability.

## Cleanup standard

No worktree is removed by name, age, or branch pattern alone. A cleanup batch is
allowed only when all of these are true:

- durable findings have been harvested into tracked docs, OpenSpec, specs, or
  code;
- the worktree is clean, or its dirty diff has been reviewed and intentionally
  abandoned;
- `git cherry origin/main HEAD` has no unique patches, or every unique patch has
  been harvested or rejected with a recorded reason;
- no active handoff, PR, or current branch references the worktree as a live
  source of truth.

Root-owned deploy scratch directories require a narrow local cleanup script
that rechecks the exact expected commit before deletion. A broad recursive
delete is not acceptable.

## Current inventory basis

A fresh worktree inventory on 2026-07-01 counted 153 registered worktrees. That
count is an inventory fact, not a mandate to retain them and not deletion
authorization. Cleanup should happen in small proof batches: deploy scratch
first, then already-harvested MCP/ChatGPT/source-actionability clusters, then
unknown-review branches only after diff review.

This closes the retroactive ledger by moving the cleanup policy and source of
truth into tracked artifacts. Future cleanup can proceed mechanically under the
standard above without re-opening the whole RI-owner ledger.
