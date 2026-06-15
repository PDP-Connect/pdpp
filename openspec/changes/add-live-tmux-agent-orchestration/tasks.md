# Tasks — add-live-tmux-agent-orchestration

All work is additive on `scripts/claude-workstream.sh` and owner-tooling artifacts. No PDPP
product code, runtime, schema, or live-data path is modified. The default `--print` path
stays byte-for-byte unchanged.

## 1. Spec and design

- [ ] 1.1 Confirm the proposal, design, and spec deltas read against the verified design
  `docs/research/ri-owner-tmux-live-orchestration-2026-06-15.md` (interactive-by-default
  Claude, Codex `resume`/`fork`, JSONL `stop_reason` idle probe, Gemini unverified,
  clawmeter gating).
- [ ] 1.2 Validate the change: `openspec validate add-live-tmux-agent-orchestration --strict`.
- [ ] 1.3 Validate the whole set: `openspec validate --all --strict`.

## 2. M1 — `--interactive` mode (drop the two flags, add a named session)

- [x] 2.1 Add an `--interactive` flag to `scripts/claude-workstream.sh` arg parsing,
  defaulting off; record the mode in `status.json`. Verify: `--help`/usage shows the flag;
  a run without it is byte-identical in behavior to today.
- [x] 2.2 Add `invoke_claude_interactive()` alongside `invoke_claude_main()`: same artifact
  dir, git snapshot, and signal handling, but launch `claude` WITHOUT `--print` and WITHOUT
  `--no-session-persistence`, WITH a deterministic `--session-id "$session_id"` (resumable via `claude --resume`) and an optional `--name "$lane"` display label, passing the prompt as a
  positional argument (read from the tmux PTY, not piped stdin). Verify: spawn one
  interactive Claude worker in `--tmux` mode and confirm the pane stays alive after the
  first turn ends (does not exit).
- [x] 2.3 Confirm the live stream is visible in the pane (not redirected-to-file-only) via
  `tmux capture-pane -t main:ws-<lane> -p -S -50`. Verify: scrollback shows live worker
  output.
- [x] 2.4 Send a revision into the live pane (`send-keys` / `paste-buffer` + `Enter`) and
  confirm the worker answers in the SAME session. Verify: the JSONL shows the revision and
  response in one session file. (Proven: send-keys "STEERED" answered in-session; JSONL
  carried both `OK` and `STEERED` assistant turns.)
- [x] 2.5 Confirm resume-after-pane-exit: kill the pane, then `claude --resume <session_id>
  "<msg>"` resumes with prior history. Verify: the resumed session continues the same
  conversation. (Proven: after `tmux kill-window`, `claude --resume <id>` recalled "OK,
  STEERED" — both prior turns.)

## 3. M2 — `session_id` in `status.json`

- [x] 3.1 In `--interactive` mode write the resumable `session_id` (the `--session-id` value
  value / resolved session id) into `status.json`. Verify: `status.json` contains the field
  after launch. (Proven: live status.json carried `session_id` + `mode:"interactive"`.)
- [x] 3.2 Surface `session_id` through `scripts/workstreams-status.mjs` /
  `pnpm workstreams:status`. Verify: the status view shows the session id per live lane.
  (Interactive lanes render ` mode=interactive session_id=<id>`; print lanes unchanged.)
- [ ] 3.3 Simulate compaction recovery: from a clean shell, reconstruct the live lane set
  from `tmux list-windows` + `pnpm workstreams:status` + recorded `session_id`, and resume a
  lane by its id. Verify: the lane resumes without a manual JSONL scan.

## 4. M3 — JSONL idle-probe helper

- [x] 4.1 Add `scripts/wait-worker-idle.sh <lane>`: locate the worker's session JSONL under
  `~/.claude/projects/<proj>/` and exit successfully when the last event carries
  `stop_reason: "end_turn"`. Do NOT match the prompt glyph. Verify: the helper exits exactly
  when a turn ends, not before. (Probe checks the last `assistant` event's
  `.message.stop_reason`; accepts a lane name or session-id; jq, not screen-scrape.)
- [x] 4.2 Add a bounded timeout and a non-zero exit on timeout. Verify: a worker that never
  goes idle within the timeout makes the helper exit non-zero. (`--timeout` default 600;
  exit 1 on timeout — proven for both missing-JSONL and still-busy sessions.)
- [ ] 4.3 Document the helper as the gate for steer/revise/reap timing in
  `docs/agent-workstream-playbook.md` (prefer wait-for-turn-end over interrupt). Verify: the
  playbook's send-keys section references the probe.

## 5. Revise command and reaper

- [ ] 5.1 Add a `revise` convenience (subcommand or sibling script) that, given a lane and a
  message-or-file, gates on the idle probe, sends the revision to `main:ws-<lane>` via
  `paste-buffer` + `Enter` (or `claude -r`/`codex resume` if the pane exited), and
  re-captures the pane. Verify: a revision round-trips into a live worker and into a
  resumed one.
- [ ] 5.2 Add a reaper that kills `ws-<lane>` and finalizes `status.json`, WITHOUT deleting
  the worktree or branch. Verify: after reap the window is gone, `status.json` is finalized,
  and the worktree/branch remain.
- [ ] 5.3 Encode the interrupt safety step: when `Ctrl-C` is used (runaway only), the flow
  prints a worktree-inspection reminder before allowing continuation. Verify: the reminder
  appears on the interrupt path.

## 6. Clawmeter launch gate

- [ ] 6.1 Add a `clawmeter --check` preflight to lane launch: refuse a new non-essential
  lane on exit 2 (or `projected_at_reset >= ~95%`); downshift default model/effort one step
  on exit 1 and record the decision in `status.json`. Verify: exit 2 refuses launch; exit 1
  downshifts and the downshift is recorded.
- [ ] 6.2 Confirm the gate is a 3-branch decision table, NOT a scheduler/pacer. Verify: no
  queueing/pacing code is added; the gate only branches on the clawmeter signal.

## 7. Cross-provider verification (honest per provider)

- [ ] 7.1 Verify Codex live control empirically: spawn a Codex worker interactive, attempt
  a `paste-buffer` revision and a `codex resume`/`fork` round-trip. Record the result. If
  `paste-buffer` injection is unreliable, document the file-based-handoff fallback as the
  Codex revise path. Verify: a written Codex pass/fail with the working revise mechanism.
- [ ] 7.2 Keep Gemini fire-and-forget: confirm no live-control claim is wired for Gemini and
  the harness/playbook mark it unverified. Verify: grep shows no Gemini steer/revise/idle
  path; the playbook states the deferral.
- [ ] 7.3 Confirm worktree isolation across a concurrent Claude+Codex pair (no shared
  working tree). Verify: each lane has its own worktree; neither edits the other's.

## 8. Maniple evaluation spike (build-vs-adopt)

- [ ] 8.1 Run a bounded spike: install Maniple in a throwaway env, load it as an MCP server,
  and exercise `spawn_workers` / `message_workers` / `wait_idle_workers` / `examine_worker`
  against a Claude and a Codex worker. Verify: a written record of what worked.
- [ ] 8.2 Assess whether Maniple can honor (or be bridged to) the lane / worktree /
  `status.json` / `.git/workstreams` contract the owner's review and compaction-recovery
  flow depend on. Verify: an explicit yes/no with evidence.
- [ ] 8.3 Produce the build-vs-adopt-vs-hybrid recommendation for the Codex RI owner. The
  design's standing recommendation is the **hybrid**: ship M1–M3 in-house now (≈55 lines,
  no dependency, preserves the durable-artifact contract) and adopt Maniple's MCP ergonomics
  later only if 8.2 passes. Verify: the recommendation is recorded with its rationale.

## 9. Documentation

- [ ] 9.1 Document the live-control flow (spawn → stream → steer → revise → resume → reap)
  in `docs/agent-workstream-playbook.md`, including the idle-probe gate, the
  prefer-turn-end-over-interrupt rule, and the no-autonomous-merge boundary. Verify: the
  playbook's Communication Model section covers the interactive path.
- [ ] 9.2 Note that `--print` fire-and-forget stays the default and `--interactive` is
  opt-in. Verify: the playbook and the script usage both say so.

## 10. Validation

- [x] 10.1 Run the harness smoke: a `--print` run is unchanged; an `--interactive` run
  spawns, streams, accepts a revision, resumes after pane exit, and reaps cleanly. Verify:
  all steps pass on a real spawn. (2026-06-15: existing reliability/abort/tmux suites green;
  live sonnet lane spawned, streamed `OK`, accepted send-keys `STEERED`, idle-probe exited 0
  on end_turn, reaped via kill-window, resumed with full prior context.)
- [ ] 10.2 Re-run `openspec validate add-live-tmux-agent-orchestration --strict` and
  `openspec validate --all --strict` after implementation.

## 11. Codex RI-owner review (residual)

- [ ] 11.1 Codex RI owner review: confirm the build-vs-adopt recommendation (hybrid), the
  per-capability confidence (Claude high, Codex revise empirically confirmed-or-flagged,
  Gemini deferred), the clawmeter gate, and the no-autonomous-merge safety boundary against
  the live single-operator stack. Decide build / adopt / hybrid and record any residual as a
  named risk rather than leaving the change pseudo-active.
