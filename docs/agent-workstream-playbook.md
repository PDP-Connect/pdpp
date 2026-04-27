# Agent Workstream Playbook

This document is the operating system for multi-agent work in this repo. It
does not replace `AGENTS.md` or OpenSpec:

- `AGENTS.md` contains the hard repo rules every agent must follow.
- OpenSpec contains durable product, protocol, reference, and architecture truth.
- This playbook explains how to split, run, report, review, and merge agent work
  without losing state or letting parallel branches drift.

## Roles

## Delegation Backend

Current constraint: do not use Codex sub-agents for worker lanes. Codex token
budget is reserved for the owner/integration pass. Parallel implementation,
investigation, and review lanes should run through Claude Code workers in local
worktrees, usually attached to tmux and coordinated through the local workstream
hub described below.

This constraint is operational, not architectural. If the human owner explicitly
reverses it, this section can be updated. Until then, worker task packets should
be written for Claude Code, and the owner agent should not call Codex sub-agent
delegation tools.

### Owner Agent

The owner agent is the integration gatekeeper. The owner:

- classifies work before implementation starts;
- decides whether OpenSpec is required;
- assigns bounded, non-overlapping worker lanes;
- reviews worker commits before merge;
- runs final validation after integration;
- keeps the canonical task list up to date;
- stops work when a branch, worktree, or repository state looks unsafe.

Workers do not merge to `main` unless explicitly told to do so. They should use
normal Git commands for branch work and commits, but should not directly edit
the local `.git/workstreams` hub unless the owner has explicitly allowed it for
that toolchain.

## Communication Model

### Mandatory Owner Checkpoint

Codex must not coordinate from memory. Before answering status, launching worker
lanes, sending merge/closeout instructions, merging to `main`, pushing, or
declaring a multi-agent pass complete, the owner agent must run:

```bash
pnpm workstreams:status
```

The command inventories tmux Claude panes, git worktrees, dirty paths,
ahead/behind state, unmerged branch commits, recent `tmp/workstreams/*.md`
reports, local merge-queue entries, blockers, and active OpenSpec changes.
It exits non-zero when action-blocking risks are present. Use
`pnpm workstreams:status -- --no-fail` only when you need a readable snapshot
without failing a larger command; do not use `--no-fail` to bypass owner
reconciliation.

If the command reports risks, reconcile them before acting:

- dirty worktree: inspect or ask the worker to finish/commit/revert its own
  changes;
- branch ahead of upstream: decide whether it is merge-ready, blocked,
  abandoned, or intentionally held;
- active Claude pane without a known workstream: inspect the pane before
  launching more workers or reporting "no active workers";
- merge-queue entry: owner-review the diff and evidence before merging;
- blocker file: resolve or explicitly leave blocked;
- local `main` ahead of `origin/main`: validate and push or state why it is
  intentionally unpushed.

Old/stale worktrees and branches with commits not in `main` are still listed as
inventory, but they are not automatically risks. Otherwise long-lived parked
worktrees make the checkpoint permanently red and train the owner to ignore it.
Treat those inventory lines as prompts for cleanup when they are relevant to the
current decision.

This checkpoint is the source of truth for local orchestration. The playbook,
cards, and worker reports support the decision; they do not replace the status
command.

Use GitHub pull requests when a branch is pushed and intended to merge. A draft
PR is the best branch-scoped communication channel: it has a diff, status,
review, comments, CI, and a durable merge record.

For local-only work, use the same shape without GitHub:

- branch/worktree = PR branch;
- local workstream card = PR description;
- local blocker file = PR review thread;
- local merge-queue entry = ready-for-review label;
- OpenSpec/design notes = durable design truth, not status chatter.

Do not use the human owner as the message bus. Use the repository and local
workstream hub for routine status. Escalate to the human only when an owner
judgment is genuinely required.

### Messaging Claude Workers In Tmux

When sending follow-up guidance to an interactive Claude worker, do not assume a
raw `tmux send-keys` call was submitted. Claude panes may be mid-tool-call, and
text can sit in the input box until an explicit submit reaches the pane.

Use this owner-side pattern:

```bash
tmux set-buffer -- "$message"
tmux paste-buffer -t "main:<window>"
tmux send-keys -t "main:<window>" Enter
sleep 1
tmux capture-pane -t "main:<window>" -p -S -40 | tail -40
```

After sending, verify one of these is true before moving on:

- Claude shows the message in the transcript or queued-message area.
- Claude begins responding to the message.
- The prompt is empty and waiting for the next instruction.

If the message is still visible after the `❯` prompt as editable input, submit it
again with `tmux send-keys -t "main:<window>" Enter` and re-check. For critical
instructions, prefer writing the guidance into a non-sensitive handoff file under
`tmp/workstreams/` and tell the worker to read that file, so the instruction is
auditable even if the interactive pane is interrupted.

### Local Workstream Hub

The reliable local channel is a shared directory under Git's common directory:

```bash
WORKSTREAM_HUB="$(git rev-parse --git-common-dir)/workstreams"
mkdir -p "$WORKSTREAM_HUB"/{cards,blockers,merge-queue,archive}
touch "$WORKSTREAM_HUB/decisions.md" "$WORKSTREAM_HUB/events.ndjson"
```

Why this location:

- every worktree for the repo resolves the same `git-common-dir`;
- the files are local-only and cannot be accidentally committed;
- the hub survives branch switches and worktree rebuilds;
- one file per workstream avoids merge conflicts and queue-file contention.

Operational rule: normal Git commands are always allowed, but worker agents
should not directly edit files under `.git/workstreams`. Some coding tools treat
all direct writes under `.git/` as protected repository-internal mutation and
will pause for approval even when `git add`, `git commit`, `git status`, and
other normal Git commands are safe. The owner agent owns direct hub writes. A
worker should instead print its final report or write it to a non-sensitive
handoff path such as `tmp/workstreams/<branch>.md`; the owner copies reviewed
handoffs into `.git/workstreams` as needed.

Do not put active queue state in `docs/` or `openspec/`. Those are committed
artifacts, not a local message bus. Commit only stable process docs, design
decisions, proposals, specs, and final reports that should survive as project
history.

### Workstream Card

Each active branch gets one card:

```bash
branch="$(git branch --show-current)"
card="$(git rev-parse --git-common-dir)/workstreams/cards/$branch.md"
```

Card template:

```md
# <branch>

Status: active | blocked | merge-ready | merged | abandoned
Owner lane: runtime/search | docker/ops | connector:<name> | web/operator | openspec | polish
Worktree:
Base:
Last updated:

## Objective

## Scope

## Out Of Scope

## Current State

## Validation

## Blockers

## Merge Notes

Distinctive last line: <copyable phrase for thread lookup>
```

The owner updates cards from worker reports. Workers may read existing cards,
but should avoid direct `.git/workstreams` writes unless explicitly instructed
for a toolchain that does not prompt on `.git` edits. If two agents need to
collaborate, they report the dependency in their final report or in a
non-sensitive handoff file; the owner records the dependency in the relevant
card.

### Blockers

Use a blocker file only when work is stopped:

```bash
blocker="$(git rev-parse --git-common-dir)/workstreams/blockers/$branch.md"
```

Blocker files must include:

- branch/worktree;
- exact blocking question;
- options considered;
- recommended path;
- commands already run;
- whether code was changed before the blocker.

Delete or archive the blocker file when resolved, and record the decision in the
workstream card or `decisions.md` if it affects more than one branch.

### Merge Queue

A branch is ready when the owner creates:

```bash
ready="$(git rev-parse --git-common-dir)/workstreams/merge-queue/$branch.md"
```

The merge-queue entry should be copied from the worker's final report, not used
as a status conversation. It must include commit hashes, files changed,
validation, known baseline failures, residual risks, and `git status --short`.
Workers should not write this file directly unless explicitly instructed by the
owner for the current toolchain.

The owner reviews merge-queue entries in dependency order, not arrival order.

### Decisions Log

Use `decisions.md` only for cross-lane decisions, such as:

- "filtered search requires an OpenSpec change before implementation";
- "local Docker compose persists `~/.pdpp` as a volume";
- "semantic score remains server-internal for this tranche";
- "GitHub connector should add `commits` stream rather than suppress progress."

Do not use it for branch-local implementation notes.

### Event Journal

`events.ndjson` is optional but useful for automation. Append one JSON object per
meaningful transition:

```json
{"ts":"2026-04-24T15:10:00-05:00","branch":"fix-github-progress-stream","event":"blocked","summary":"Need owner choice: add commits stream or suppress progress"}
```

Keep entries single-line and append-only. The card remains the human-readable
source of truth.

### Worker Agent

A worker owns one bounded lane. A worker:

- works in a separate worktree or clearly named branch;
- commits its own completed slice;
- does not rewrite, reset, or rebase over local-only commits without preserving
  them first;
- does not broaden scope without reporting;
- validates the slice before reporting;
- returns exact files changed, tests run, residual risks, and next slice.

### Explorer / Reviewer Agent

Use explorer-style agents for short, read-only audits, design comparison,
failure triage, and review. They should usually produce a memo, matrix, or
recommendation, not code.

## Work Categories

Classify work before assigning it. This avoids forcing every task through the
same process.

| Category | Examples | OpenSpec? | Default Owner Action |
| --- | --- | --- | --- |
| Trivial fix | typo, one-line test correction, small copy tweak | No | Implement directly |
| Bug fix | crash, SQL error, routing loop, connector regression | Usually no, unless contract behavior changes | Assign or fix with regression test |
| Implementation gap | `expand[]` promised but broken, attachment blobs missing | Usually yes if durable behavior is affected | Audit first, then implement |
| New contract | new endpoint, response field, header, manifest field | Yes | OpenSpec proposal before code |
| New dependency | Docker base, embedding model, database driver | Yes | OpenSpec proposal before code |
| UI/operator polish | dashboard liveness, progress UI, diagnostics copy | Sometimes | Use judgment; spec if durable/operator contract changes |
| Investigation | "why is GitHub failing?" | No, unless it becomes design work | Produce memo + repro |
| Refactor | TS migration, query extraction, module split | Yes if broad or architecture-shaping | Slice by module, validate per slice |
| Open question | credentials, identity graph, partial-run honesty | Design note first | Promote to OpenSpec when actionable |

When unsure, ask the owner for classification before writing code.

## OpenSpec Rules For Workers

Use OpenSpec when work changes durable behavior that future reviewers should be
able to audit. Examples:

- public endpoints, request parameters, response shapes, headers, or error codes;
- manifest fields, schema semantics, grant shape, or collection-profile messages;
- reference architecture, storage topology, security posture, or deployment model;
- multi-step user-visible behavior such as search semantics or run interactions;
- new dependencies that operators must understand.

Do not use OpenSpec for:

- one-off bug fixes that preserve existing contract;
- pure investigation memos;
- isolated test repairs;
- local-only process documentation like this playbook.

If a worker discovers that its task requires OpenSpec and no change exists, it
must stop and report. Do not invent a durable contract inside code.

## Worktree And Branch Rules

- Use a separate worktree for worker implementation.
- Name branches by outcome, not agent identity: `fix-github-progress-stream`,
  `add-reference-docker`, `audit-query-capabilities`.
- Before changing code, record:
  - `git status --short`
  - `git branch --show-current`
  - `git rev-parse --short HEAD`
  - `git worktree list`
- Treat existing dirty files as user or other-agent work unless proven otherwise.
- Never run `git reset --hard`, `git checkout -- <path>`, `git clean`, or
  destructive rebase commands unless explicitly approved for that exact state.
- If a commit, object, or worktree looks corrupt, back up the worktree contents
  before repair.
- If a rebase or merge would drop local-only commits, stop and report the exact
  commit range.

## Worker Task Packet

Use this shape when assigning work to a worker.

```text
Task: <one-sentence outcome>

Repo/worktree:
- Work in a fresh worktree from current main unless told otherwise.
- Do not merge to main.
- Do not revert unrelated changes.

Context:
- <links to OpenSpec change, design note, bug report, run id, or file paths>

Owned scope:
- <files, modules, connector, endpoint, or UI surface the worker may change>

Out of scope:
- <nearby things they must not touch>

Implementation requirements:
- <specific behavior>
- <tests that must be added or updated>
- <docs/OpenSpec updates if required>

Validation:
- <commands to run>
- Known acceptable baseline failures: <exact names only>

Stop-and-report triggers:
- <decisions owner must make>
- <unexpected contract/design implications>
- <repo corruption / dropped commits / external dirty conflicts>

Final report must include:
- commit hash(es)
- exact files changed
- root cause or design decision
- tests/checks run
- residual risks
- next recommended slice
- `git status --short`
- draft PR description or handoff report path under `tmp/workstreams/`
```

## Standard Validation Matrix

Pick the smallest set that proves the slice. Do not claim readiness without
running the relevant checks.

| Area | Minimum checks |
| --- | --- |
| OpenSpec change | `openspec validate <change> --strict`; often also `openspec validate --all --strict` |
| Reference server | targeted `node --test ...`; `pnpm --dir reference-implementation run verify` |
| Full reference behavior | `pnpm --dir reference-implementation run test`; note known `composed-origin.test.js` only if still baseline |
| Web UI | `pnpm --dir apps/web run types:check`; `pnpm --dir apps/web run check`; `pnpm --dir apps/web run build` when routing/build output changes |
| Contract generation | `pnpm --filter @pdpp/reference-contract run verify`; `pnpm --filter @pdpp/reference-contract run check:generated` |
| Connector package | `pnpm --dir packages/polyfill-connectors run verify`; targeted connector tests |
| Runtime/connector live bug | targeted unit test plus one reproducible smoke or captured run timeline |
| Markdown-only process doc | read the changed docs, run `git diff --check`, and verify links/paths exist |

If a known baseline failure appears, verify it still fails on unchanged `main`
or cite the prior owner-approved baseline report.

## Report Format

Use concise, evidence-first reports.

```text
Status: complete | blocked | needs owner review
Branch/worktree:
Commit(s):

Files changed:
- <path> — <purpose>

What changed:
- <behavioral summary>

Validation:
- <command> — pass/fail

Residual risks:
- <risk and why it remains>

Next slice:
- <one concrete recommendation>

git status --short:
<output>
```

For blocked reports, include the last line or distinctive phrase the owner can
quote back to locate the right agent.

## Merge Queue

The owner should merge in dependency order:

1. safety and data-loss fixes;
2. contract/spec changes;
3. backend behavior changes;
4. web/operator surfaces that depend on backend behavior;
5. docs and cleanup.

Before each merge:

- inspect `git log --oneline main..branch`;
- skim each commit or review the aggregate diff;
- run the relevant validation matrix;
- confirm no unrelated dirty files are staged;
- commit or merge with a message that names the capability, not the agent.

After merge:

- rerun the narrow checks most likely to catch integration fallout;
- update OpenSpec task checkboxes if the merge completed a task;
- close or remove the worker worktree only after the branch is merged and clean.

## Stop-And-Report Triggers

Stop instead of guessing when:

- the implementation would change a public contract but no OpenSpec change covers it;
- an approved design appears wrong or incomplete;
- a dependency choice affects deployment, security, or operator burden;
- a branch contains local-only commits that would be dropped;
- Git reports corrupt objects or missing refs;
- tests fail in a way not already verified as baseline;
- live connector behavior contradicts the manifest or docs;
- fixing the bug requires touching unrelated hot files.

Do not stop for ordinary implementation details that are local and reversible.
Make a reasonable assumption, document it in the report, and continue.

## Current High-Throughput Lanes

Use these buckets when spinning up multiple workers. They are intentionally
non-overlapping.

| Lane | Owner | Example tasks |
| --- | --- | --- |
| Runtime/search core | Owner agent | semantic backfill resume, query semantics, auth gates |
| Docker/ops | Worker | image, compose, volumes, env, cache, runbook |
| Connector reliability | One worker per connector | GitHub progress stream, Gmail runtime failure, USAA login, Claude Code ingest |
| Query/API audit | Explorer or worker | range filters, schema endpoint, `expand[]`, `changes_since`, attachments |
| Web/operator UI | Worker | live run refresh, progress cards, interaction UX, last-sync display |
| OpenSpec cleanup | Worker | split broad changes, archive completed changes, normalize design notes |
| Small polish | Worker | revision header, diagnostics copy, docs links |

The owner should keep new contract work out of implementation lanes until a
proposal exists.

## Anti-Patterns

- One worker owns "the dashboard" or "all connectors."
- A worker combines investigation, proposal, implementation, and cleanup in one
  unreviewed branch.
- A branch says "all tests pass" but omits exact commands.
- An agent marks OpenSpec tasks complete without code or tests proving them.
- A worker fixes a live connector by weakening runtime protocol validation.
- A dashboard hides backend uncertainty instead of linking to inspectable data.
- A process doc starts duplicating durable protocol requirements that belong in
  OpenSpec.

## Owner Checklist Before Saying "Done"

- The implemented behavior matches the applicable OpenSpec change or the task
  was correctly classified as non-OpenSpec.
- The final diff contains no unrelated files.
- Relevant tests/checks ran and are reported.
- Known failures are verified as baseline, not assumed.
- OpenSpec tasks and docs are updated if the work changes durable behavior.
- The worker branch is clean or remaining uncommitted files are explicitly
  accounted for.
- The next action is either obvious from the report or captured in a task list.
