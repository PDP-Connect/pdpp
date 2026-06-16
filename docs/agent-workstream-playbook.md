# Agent workstream playbook

This repo uses `waspflow` for live multi-agent orchestration. This playbook is
the PDPP-specific policy layer: it explains when to delegate, what evidence a
worker must leave, and what the RI owner must verify before merging or
deploying. The implementation lives in `~/code/waspflow`, not in repo-local
wrapper scripts.

## Sources of truth

- `AGENTS.md` owns repo-wide rules.
- OpenSpec owns durable product, protocol, reference, architecture, and UX
  scope.
- `design-notes/full-context-refresh.md` owns current RI-owner principles.
- `tmp/workstreams/ri-owner-current-state.md` owns live operational state and
  the live-stack mutex.
- `waspflow` owns spawn, watch, wait, revise, reap, lane state, deliverable
  contracts, and project integrity checks.

## Mandatory status gate

Before coordinating, launching workers, merging, pushing, deploying, reporting
current state, or declaring a multi-agent pass complete, run:

```bash
pnpm workstreams:status -- --no-fail
```

In this repo the script delegates to:

```bash
waspflow check --no-fail
```

The PDPP-specific policy is in `.waspflow/config.json`: the live-stack mutex,
blocker globs, recent workstream reports, lane staleness threshold, and
OpenSpec status command. If `waspflow check` reports risks, reconcile them or
name the residual risk before proceeding.

## Delegation rules

Use workers for bounded work that benefits from parallelism or live steering:

- read-only inventories, audits, and prior-art research;
- isolated implementation lanes with narrow file ownership;
- test/fixture generation after the target contract is known;
- review passes with explicit verdict/report files.

Do not delegate:

- owner-only live-stack deploy/restart/vacuum decisions;
- final merge readiness;
- protocol or UX authority without an OpenSpec/design artifact;
- broad cleanup with unclear ownership.

Workers may be Claude or Codex. Use low-cost/default effort for mechanical
lanes and reserve high reasoning for design, security, protocol, or owner-gate
review.

## Launch shape

Prefer `waspflow` lanes so the owner can observe and steer live:

```bash
waspflow spawn --provider codex --lane <short-name> --isolate --report tmp/workstreams/<lane>-report.md -- "<task>"
waspflow wait <short-name>
waspflow peek <short-name> --lines 80
waspflow revise <short-name> -- "<revision, if needed>"
waspflow reap <short-name>
```

Use `--isolate` for implementation lanes unless there is a specific reason the
worker must operate in the current checkout. Always use `--report` for worker
tasks whose output matters after compaction.

## Worker contract

Every worker task packet must state:

- exact objective;
- read/write scope;
- files or commands explicitly forbidden;
- report path under `tmp/workstreams/` or a change-local research path;
- validation expected;
- stop condition.

Workers do not merge, push, deploy, restart containers, run live data drains, or
vacuum databases unless the owner explicitly grants that authority in the task
packet.

## Owner review gate

Worker done is not owner done. The RI owner must:

- read the report;
- inspect the diff;
- run relevant tests/checks;
- validate OpenSpec when scope changed;
- merge only verified tranches;
- update live/current-state records if operational state changed;
- reap or park the lane.

If a worker report claims completion but evidence is missing, request a
revision through `waspflow revise` or mark the lane failed. Do not convert a
worker claim into project truth without verification.

## Live-stack mutex

The live stack is a single-operator boundary for real personal data. Before any
container stop/start, deploy, restart, database maintenance, or VACUUM against
`pdpp.vivid.fish` or the serving local stack, declare a mutex window in
`tmp/workstreams/ri-owner-current-state.md` with:

- operator;
- start time;
- scope;
- expected duration.

Close the window with outcome and smoke evidence. `waspflow check` flags an
open mutex from this file, but the owner remains responsible for reading the
scope before acting.

## Cleanup

Use `waspflow reap <lane>` when a lane is complete. Reaping finalizes the lane
state and preserves artifacts; it is not the same as deleting a branch or
discarding work.

Never delete a worktree or branch with dirty or unmerged work unless the owner
has explicitly decided it is abandoned. Use status output as inventory, not as
permission to destroy.
