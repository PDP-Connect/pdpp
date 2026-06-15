# agent-orchestration

This capability is owner-tooling/process: how the RI owner agent spawns, watches, steers,
revises, and reaps provider workers (Claude, Codex; Gemini deferred) over a tmux control
layer, reconciling through the disk + git-worktree substrate. It governs
`scripts/claude-workstream.sh` (`--interactive` mode), the idle-probe helper,
`status.json`, and the documented owner flow. It does not govern any PDPP product runtime,
schema, or read path.

## ADDED Requirements

### Requirement: The owner SHALL spawn a worker of a supported provider into its own tmux window with an isolated worktree

The harness SHALL launch a worker inside a dedicated `tmux` window named `ws-<lane>` in the
target session, bound to a per-worker git worktree, so workers never race on the same
working tree and the pane survives terminal disconnection.

#### Scenario: Spawn a Claude worker into a named window

- **WHEN** the owner launches a lane with `--tmux` (and, for live control, `--interactive`)
- **THEN** the harness SHALL create a `tmux` window named `ws-<lane>` in the target session
- **AND** SHALL start the worker bound to the lane's own git worktree
- **AND** SHALL abort the launch if a window named `ws-<lane>` already exists, rather than
  clobber a live prior run.

#### Scenario: Two concurrent workers do not share a working tree

- **WHEN** two lanes are spawned concurrently
- **THEN** each SHALL run in its own git worktree
- **AND** neither SHALL edit the other's working tree.

### Requirement: The owner SHALL watch a worker's live output without disrupting it

The owner SHALL read a worker's live stream via `tmux capture-pane` (or `pipe-pane`) at any
interval. Live observation SHALL be non-destructive and SHALL NOT require redirecting the
worker's stdout to a file as the only output channel.

#### Scenario: Read live scrollback non-destructively

- **WHEN** the owner reads a running worker's pane with `capture-pane -p -S -<N>`
- **THEN** the harness SHALL return the current scrollback as text
- **AND** the read SHALL NOT interrupt, restart, or alter the worker.

#### Scenario: Live stream is available in interactive mode

- **WHEN** a worker runs in `--interactive` mode
- **THEN** its output SHALL be visible live in the pane
- **AND** SHALL NOT be redirected to a transcript file as the sole output channel.

### Requirement: The owner SHALL attach to and steer a running worker, preferring turn-end over interrupt

The owner SHALL send input to a running worker via `send-keys` / `paste-buffer` to
type into, course-correct, or interrupt it. The harness and owner flow SHALL prefer
waiting for the worker's turn to end (gated on the idle probe) over interrupting mid-tool,
and SHALL reserve `Ctrl-C` for clear runaway cases.

#### Scenario: Steer a worker that is waiting for input

- **WHEN** the idle probe reports the worker's turn has ended
- **THEN** the owner MAY send a correction via `paste-buffer` followed by `Enter`
- **AND** the worker SHALL process the correction in its next turn.

#### Scenario: A message sent mid-tool-call waits, it is not lost

- **WHEN** the owner sends a message while the worker is mid-tool-call
- **THEN** the message SHALL land in the worker's input buffer and submit when the current
  tool completes
- **AND** the owner flow SHALL NOT treat the buffered message as dropped.

#### Scenario: Interrupt is the runaway escape hatch, not the default

- **WHEN** the owner sends `Ctrl-C` to interrupt a mid-tool-call worker
- **THEN** the action SHALL be treated as a runaway-only escape hatch
- **AND** the owner SHALL inspect the worker's worktree for partial file state before
  continuing, because an interrupt mid-write can leave a file half-written.

### Requirement: The owner SHALL request a revision while the worker stays alive and resumable

In `--interactive` mode the worker SHALL remain alive after a turn ends and its session
SHALL be resumable. The owner SHALL be able to request a revision in the same session
(full history preserved) without re-spawning, and SHALL be able to resume the session by
name/id if the pane has exited (`claude --resume <session>`; `codex resume`/`fork`). A
revision SHALL always end with the owner reviewing and gating the merge — never the worker.

#### Scenario: Revise in a live session

- **WHEN** a worker has finished a turn but its pane is still alive
- **THEN** the owner MAY send a revision into the pane
- **AND** the worker SHALL continue in the SAME session with full prior conversation history
- **AND** the worker SHALL NOT be torn down until the owner explicitly reaps the window.

#### Scenario: Resume a Claude session after pane exit

- **WHEN** an interactive worker's pane has exited but its session file persists
- **THEN** the owner SHALL resume it by name with `claude -r "<lane>"` and a revision
  message
- **AND** the resumed session SHALL carry the prior conversation history.

#### Scenario: Resume a Codex session after pane exit

- **WHEN** a Codex worker's pane has exited
- **THEN** the owner SHALL resume it with `codex resume` (by id or `--last`) or branch it
  with `codex fork`
- **AND** if live `paste-buffer` injection is unconfirmed for Codex, the owner SHALL fall
  back to file-based handoff: write the revision to disk and instruct the worker to read it.

#### Scenario: Revision ends with owner review, not auto-merge

- **WHEN** the owner is satisfied with a revised worker's output
- **THEN** the owner SHALL review the diff and gate integration
- **AND** the worker SHALL NOT merge autonomously.

### Requirement: Worker readiness SHALL be detected from the session JSONL idle marker, never from screen patterns

The harness SHALL detect "the worker's turn has ended / it is waiting for input" by reading
the worker's session JSONL for the turn-end marker (`stop_reason: "end_turn"` as the last
event for Claude; the equivalent Codex JSONL marker). It SHALL NOT decide readiness by
matching a prompt glyph in `capture-pane` output.

#### Scenario: Idle probe fires on the JSONL turn-end marker

- **WHEN** `wait-worker-idle.sh <lane>` polls the worker's session JSONL
- **THEN** it SHALL exit successfully when the last event carries `stop_reason: "end_turn"`
- **AND** it SHALL NOT rely on the prompt glyph or other screen text as the readiness
  signal.

#### Scenario: Screen capture is a convenience, not the oracle

- **WHEN** the owner reads the pane via `capture-pane`
- **THEN** that output MAY inform a human
- **AND** SHALL NOT be the authoritative source for whether the worker is waiting for input.

### Requirement: The orchestrator SHALL survive its own compaction by persisting panes and the worker session id

Worker panes SHALL persist across the owner's context compaction and terminal drops (tmux
daemon). The harness SHALL record the worker's resumable `session_id` in `status.json` in
interactive mode, so a compacted owner reconstructs which live worker maps to which lane
from disk plus `tmux list-windows` plus `pnpm workstreams:status`, without a manual JSONL
scan.

#### Scenario: status.json carries the resumable session id

- **WHEN** a worker is launched in `--interactive` mode
- **THEN** `status.json` SHALL include the worker's resumable `session_id`
- **AND** `pnpm workstreams:status` SHALL surface it.

#### Scenario: A compacted owner reconstructs live lanes

- **WHEN** the owner has lost its conversation context but the worker panes are still alive
- **THEN** the owner SHALL reconstruct the live lane set from `tmux list-windows`,
  `pnpm workstreams:status`, and the recorded `session_id`
- **AND** SHALL resume any lane by its recorded `session_id`.

### Requirement: The owner SHALL reap a worker by killing its window and finalizing status

When a lane is done the owner SHALL reap it by killing the `ws-<lane>` window and
finalizing `status.json`. Reaping SHALL be explicit and owner-driven; it SHALL NOT delete
the lane's git worktree or branch.

#### Scenario: Reap a completed worker

- **WHEN** the owner reaps a finished lane
- **THEN** the harness SHALL kill the `ws-<lane>` window
- **AND** SHALL finalize `status.json` for that lane
- **AND** SHALL NOT delete the lane's worktree or branch.

### Requirement: One owner SHALL drive Claude and Codex workers in parallel panes; Gemini SHALL remain fire-and-forget until verified

A single owner agent SHALL drive multiple workers across Claude and Codex, each in its own
pane and worktree, reconciling via live panes AND the disk / git-worktree substrate. Gemini
SHALL be used in fire-and-forget mode only (no live steer/revise/idle-probe claim) until its
interactive tmux behavior is empirically verified.

#### Scenario: Cross-provider lanes reconcile through disk and worktrees

- **WHEN** the owner runs a Claude lane and a Codex lane in parallel
- **THEN** each SHALL run in its own pane and git worktree
- **AND** the owner SHALL reconcile their work through the disk / git-worktree substrate and
  each worker's report, NOT through a shared runtime between providers.

#### Scenario: Gemini stays fire-and-forget

- **WHEN** the owner delegates a lane to Gemini
- **THEN** the lane SHALL run fire-and-forget (`gemini -p` + report-to-disk)
- **AND** the owner SHALL NOT claim live steer, revise, or JSONL idle-probe parity for
  Gemini until its interactive tmux behavior is verified.

### Requirement: Workers SHALL NOT merge autonomously; the owner SHALL gate integration against the live personal-data stack

The orchestration SHALL preserve the single-operator safety boundary. Workers SHALL NOT
merge, deploy, or auto-advance owner-decision states. The owner SHALL review every diff and
gate integration, because the live stack holds real personal data and is single-operator.

#### Scenario: A revised, satisfactory worker still does not merge

- **WHEN** a worker's output is satisfactory after revision
- **THEN** integration SHALL require an explicit owner review and merge decision
- **AND** no worker, harness step, or revise loop SHALL merge or deploy autonomously.

### Requirement: Lane launch SHALL be clawmeter-gated

Before spawning a non-essential lane the owner/harness SHALL consult clawmeter. On
`clawmeter --check` exit 2 (critical) or `projected_at_reset >= ~95%`, no new non-essential
lane SHALL be spawned — only in-flight work is finished/merged. On exit 1 (warning), the
default model/effort SHALL be downshifted one step and the decision recorded in
`status.json`.

#### Scenario: Critical quota refuses a new non-essential lane

- **WHEN** the owner attempts to spawn a non-essential lane and `clawmeter --check` exits 2
  (or `projected_at_reset >= ~95%`)
- **THEN** the launch SHALL be refused
- **AND** the owner SHALL be told to finish or merge in-flight work only.

#### Scenario: Warning quota downshifts and records the decision

- **WHEN** `clawmeter --check` exits 1 at launch time
- **THEN** the harness SHALL downshift the default model/effort one step
- **AND** SHALL record the downshift in `status.json`.

### Requirement: The live-control mode SHALL be additive and opt-in

The live-control behavior SHALL be gated behind an opt-in `--interactive` mode. The default
fire-and-forget `--print` path SHALL be unchanged for every existing caller of the harness.

#### Scenario: Default callers are unaffected

- **WHEN** a caller invokes the harness without `--interactive`
- **THEN** the worker SHALL run in the existing fire-and-forget `--print`
  `--no-session-persistence` mode
- **AND** no existing artifact, recovery, or status behavior SHALL change.

#### Scenario: Interactive mode drops the two blocking flags

- **WHEN** a caller invokes the harness with `--interactive`
- **THEN** the worker SHALL be launched WITHOUT `--print` and WITHOUT
  `--no-session-persistence`
- **AND** WITH `--session-name "<lane>"` so the session is resumable by name.
