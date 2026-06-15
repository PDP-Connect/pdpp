# Live Cross-Boundary Tmux Agent Orchestration

## Why

This is owner-tooling/process work, not PDPP product code. The RI owner already
delegates work to provider workers (Claude, Codex, Gemini) via
`scripts/claude-workstream.sh` + `tmux`, but only in **fire-and-forget** mode: a
worker is spawned with `claude --print --no-session-persistence` and its output is
redirected to a transcript file. The owner can spawn and tail, but cannot type into
a running worker, course-correct it mid-run, or **request a revision before
teardown** — because `--print` makes the session one-shot and
`--no-session-persistence` writes no resumable session file.

The owner wants **live control**, not delegation-then-wait: spawn a worker, watch its
live stream, attach and steer it, ask for a revision while the worker stays alive and
resumable, and reap it when done — across Claude and Codex, reconciling through the
disk + git-worktree substrate the harness already uses.

The blocker is small and verified. `claude` is **interactive by default**
(`--print` is the non-interactive opt-out) and supports `--continue`/`--resume` and
named sessions. Its session JSONL at `~/.claude/projects/<proj>/<id>.jsonl` carries a
`stop_reason` (`end_turn` = the turn-idle signal) that gives a reliable
"waiting-for-input" probe without screen-scraping. `codex` has `exec` (non-interactive)
**and** `resume` (by id or `--last`) **and** `fork` — so a Codex revise-before-teardown
loop is genuinely achievable, not merely hoped-for. Gemini live-control remains
**unverified**; it stays fire-and-forget. The fix is **additive** on the existing
harness: a new `--interactive` mode that drops the two blocking flags and adds a named
session, a JSONL idle-probe helper, and a `session_id` field in `status.json`.

Grounding: `docs/research/ri-owner-tmux-live-orchestration-2026-06-15.md` (verified
design), `scripts/claude-workstream.sh` (the harness to extend),
`docs/agent-workstream-playbook.md` (7-state owner model incl. `revise`; the
`.git/workstreams` hub), `scripts/workstreams-status.mjs` (status reconciliation),
`~/.codex/agents/*.toml` (the three Codex agent defs).

## What Changes

Add a `agent-orchestration` capability covering six live-control primitives plus the
safety and idle-detection invariants that make them honest:

- **(a) Spawn** an agent of any provider into a tmux pane/window (already works via
  `--tmux`; formalized here).
- **(b) Stream** — watch a worker's live output via `capture-pane`/`pipe-pane`, not
  redirect-to-file-only.
- **(c) Attach + steer** — `send-keys`/`paste-buffer` to type into, interrupt, or
  course-correct a worker mid-run.
- **(d) Revise before teardown** — the worker stays alive and resumable
  (`claude --resume <session>`, `codex resume`/`fork`) so the owner can request changes
  without re-spawning.
- **(e) Survive compaction** — panes persist (tmux daemon) and the worker's
  `session_id` is recorded in `status.json`, so a compacted owner reconstructs live
  state from disk + `tmux list-windows` + `pnpm workstreams:status`.
- **(f) Reap** — kill the window and finalize `status.json` when done.
- **Cross-provider** — one owner agent drives Claude + Codex (Gemini deferred until
  verified), each in its own pane, reconciling via live panes **and** the disk /
  git-worktree substrate. The disk + worktree is the cross-agent protocol; no shared
  runtime meta-orchestrator.

Encoded as **requirements and risks**, not aspirations: send-keys timing and
"is-the-pane-waiting?" detection (JSONL `stop_reason=end_turn`, never screen-scraping);
`Ctrl-C` mid-tool-call risks partial file state (prefer wait-for-turn-end);
Gemini unverified (fire-and-forget only); the single-operator-mutex / live-personal-data
safety boundary (NO autonomous merge — the owner gates integration); clawmeter-gated
launch (no non-essential lanes at `--check` exit 2 or `projected_at_reset >= ~95%`).

The build is additive on `claude-workstream.sh`: a new `--interactive` mode (drops
`--print` + `--no-session-persistence`, adds `--session-name`), a `wait-worker-idle.sh`
idle-probe helper, `session_id` in `status.json`, a `revise` convenience command, and a
reaper. This change also **poses one build-vs-adopt decision for the Codex RI owner**:
build the ~55-line in-house `--interactive` extension, adopt Maniple (the existing MCP
tmux-orchestrator that does spawn/message/wait_idle for Claude + Codex), or hybrid —
with a recommendation.

## Capabilities

- agent-orchestration (added)

## Impact

- Affected tooling: `scripts/claude-workstream.sh` (new `--interactive` mode, additive),
  new `scripts/wait-worker-idle.sh`, `scripts/workstreams-status.mjs` /
  `status.json` schema (`session_id` field), `docs/agent-workstream-playbook.md`
  (document the live-control flow).
- No PDPP product code, runtime, schema, or live-data path is touched. The fire-and-forget
  `--print` mode stays the default; `--interactive` is opt-in, so every existing caller is
  unaffected.
- Safety boundary unchanged: workers do not merge; the owner reviews diffs and gates
  integration against the single-operator live stack that holds real personal data.
