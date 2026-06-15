# Design — Live Cross-Boundary Tmux Agent Orchestration

## Context

This is owner-tooling/process work for the RI owner — not PDPP product code. The
buildable-from design is `docs/research/ri-owner-tmux-live-orchestration-2026-06-15.md`,
which corrected an earlier hand-waved pass with verified facts about the Claude and Codex
CLIs and surveyed the real prior art (Maniple, AWS CLI Agent Orchestrator, Groundcrew,
the Boris Cherny `/loops` pattern, the UltraCode-Shim lineage). This document records the
load-bearing decisions, the cross-provider ceiling, the failure modes, the safety
boundary, the per-capability confidence, and the build-vs-adopt-Maniple decision so the
spec deltas read against an explicit rationale.

The existing system: `scripts/claude-workstream.sh` launches a Claude worker inside a
`tmux new-window` named `ws-<lane>`, writes durable artifacts (`prompt.txt`,
`transcript.log`, `git-status-before/after.txt`, `status.json`), and runs a report-only
recovery pass if the report is missing. `docs/agent-workstream-playbook.md` encodes the
7-state owner-decision model (`waiting | review | revise | merge | delete | park | done`),
the `.git/workstreams` hub (cards, blockers, merge-queue, decisions log), and already
documents the `capture-pane` / `set-buffer` / `paste-buffer` send-keys patterns and the
timing caveat. `scripts/workstreams-status.mjs` reconciles `status.json` files into a
single owner status view. `~/.codex/agents/{explorer,worker,worker_low}.toml` define the
three Codex agent roles.

**Verified facts this design builds on (do not re-derive):**

- `claude` is **interactive by default**; `-p` / `--print` is the non-interactive opt-out.
  It supports `--continue` (resume most recent) and `--resume` / `-r` (resume by id or
  name), so a named session is durably resumable.
- Claude session JSONL lives at `~/.claude/projects/<project-hash>/<session-id>.jsonl`.
  Each assistant turn writes events carrying `stop_reason`; `stop_reason: "end_turn"` as
  the last event = the turn-idle ("waiting for input") signal. This is the reliable idle
  probe — strictly preferred over screen-scraping the prompt glyph.
- `codex` has `exec` (non-interactive, today's fire-and-forget path), **`resume`**
  (resume a prior session by id or `--last`), **and `fork`** (branch a session). A Codex
  revise-before-teardown loop is therefore genuinely achievable — better than the prior
  doc's cautious 65% framing, though still less battle-tested than Claude's path.
- Gemini live-control is **unverified**: interactive-mode behavior in a tmux pane, prompt
  characters, JSONL path, and session-resume equivalent are all unknown. Gemini stays
  fire-and-forget (`gemini -p` + report-to-disk) until empirically confirmed.
- `clawmeter status --agent` emits a one-line quota summary
  (`worst / current / projected_at_reset / status`); `clawmeter --check` exits 0
  (on-track) / 1 (warning) / 2 (critical). These gate launch.
- "ultracode" is `effort=xhigh` + adaptive thinking + large `max_tokens` + a system
  reminder (the Anthropic-shipped `/effort` session setting / UltraCode-Shim envelope),
  not a separate model or CLI flag. It is a per-session runtime setting and cannot be
  baked into agent frontmatter; out of scope for the harness change but noted so the
  effort knob is understood.

## Goals / Non-Goals

**Goals**

- Turn fire-and-forget delegation into live control: spawn, stream, attach/steer,
  revise-before-teardown, survive-compaction, reap — for Claude and Codex.
- Keep every change **additive** on `claude-workstream.sh`; the default `--print` path is
  byte-for-byte unchanged for existing callers.
- Make "is the worker waiting for input?" a **reliable signal** (JSONL `stop_reason`), not
  a screen-scrape guess.
- Preserve the owner safety boundary: workers never merge; the owner gates integration.

**Non-Goals**

- A meta-orchestrator that drives all providers in lockstep with shared intermediate
  state. The disk + git-worktree substrate is the integration point; providers stay
  independent, loosely-coupled, bounded lanes.
- A Gemini live-control path before the Gemini CLI's tmux interactive behavior is verified.
- A quota-aware scheduler/pacer. clawmeter + a 3-branch launch gate is sufficient; the
  single-operator mutex and bounded lane count mean there is nothing to schedule.
- Autonomous merge, branch reaping, or auto-advancing the 7 owner-decision states.

## Key decisions

### D1 — tmux is the control layer; disk + git-worktree is the cross-agent protocol

The owner agent drives workers through tmux (spawn/stream/steer/reap) and reconciles
them through the durable substrate the harness already writes: per-lane worktree,
`status.json`, `.git/workstreams` cards, and the worker's final report. Live panes are
the **interactive** channel; disk is the **durable, compaction-surviving** channel. There
is no shared runtime between providers — they coordinate only through files and the owner.

### D2 — the two flags are the entire blocker for capabilities c/d/e/f

Today's invocation is `claude --print --no-session-persistence ...` with stdout
redirected to `transcript.log`. `--print` makes the session one-shot (no live PTY to type
into); `--no-session-persistence` writes no resumable session file; the redirect means the
pane shows nothing live. Dropping the two flags, adding `--session-name "$lane"`, and
passing the prompt as a positional argument (not piped stdin) makes capabilities c, d, e,
and f real in one function change. Capabilities a and b already work. This is the smallest
change that unlocks live control.

### D3 — idle detection reads JSONL `stop_reason`, never the screen

The owner must know when a pane is "waiting for input" vs "mid-tool-call." The reliable
signal is the JSONL stop marker (`stop_reason: "end_turn"` as the last event in
`~/.claude/projects/<proj>/<session>.jsonl`), which is what Maniple uses. Screen patterns
(matching the `❯` glyph) change across CLI versions and are explicitly rejected. The
`wait-worker-idle.sh` helper polls the JSONL and exits when the turn ends; it is the
signal the owner uses to know when to intervene, revise, or reap.

### D4 — revise keeps the worker alive and resumable (the critical capability)

In `--interactive` mode the pane stays alive after a turn ends; the session file persists.
The owner sends a revision into the live pane (`paste-buffer` + `Enter`) and the worker
continues in the **same** session with full history. If the pane has exited, the owner
resumes by name: `claude -r "<lane>" "<revision>"` (Claude) or `codex resume`/`codex fork`
(Codex). Revise always ends with the **owner** reviewing and gating the merge — never the
worker.

### D5 — prefer wait-for-turn-end over interrupt; `Ctrl-C` is the runaway escape hatch

A message sent while the worker is mid-tool-call lands in the input buffer and submits when
the tool completes — the right default behavior. `Ctrl-C` interrupts immediately but risks
leaving a file half-written (partial tool state). The spec requires preferring
wait-for-turn-end (gated on the idle probe) and reserves `Ctrl-C` for clear runaway cases,
after which the owner inspects worktree state before continuing.

### D6 — compaction survival rests on persisted panes + `session_id` in `status.json`

tmux is a daemon: panes outlive the owner's own context compaction and terminal drops.
Adding `session_id` (the resumable session name / id) to `status.json` lets a compacted
owner reconstruct exactly which live worker maps to which lane via `pnpm
workstreams:status` + `tmux list-windows`, without a manual JSONL scan. This is the M2
field addition.

### D7 — cross-provider ceiling: one owner, N workers, asymmetric verification

One owner Claude session can drive N workers across providers, each in its own window with
its own worktree (proven by Maniple and AWS CLI Agent Orchestrator). The ceiling is not
architectural; it is operational and **asymmetric by provider**:

- **Claude:** full live control (spawn/stream/steer/revise/resume). High confidence.
- **Codex:** spawn/stream/steer work; revise via `codex resume`/`fork` is achievable but
  the `paste-buffer` PTY-injection path needs empirical confirmation, and multi-line
  injection may drop — file-based handoff (write to disk, tell Codex to read) is the safe
  fallback. Codex JSONL exists for idle detection.
- **Gemini:** unverified end-to-end. No known idle signal (screen-scrape only, fragile),
  unknown resume equivalent. Fire-and-forget only.
- **Shared-worktree racing:** prevented by the existing per-worker-worktree isolation.
- **Owner token budget:** running 4+ live workers burns a compacting owner's context fast;
  clawmeter-gating and bounded lane count hold this.

### D8 — safety boundary: single-operator mutex, no autonomous merge

The live stack holds real personal data and is single-operator. Workers never merge; the
revise flow (D4) ends with the owner reviewing the diff and gating integration. Launch is
clawmeter-gated: on `--check` exit 2 (critical) or `projected_at_reset >= ~95%`, no new
non-essential lanes spawn — finish/merge in-flight work only. On exit 1 (warning),
downshift the default model/effort one step and record it in `status.json`.

## The architecture (build sketch)

`--interactive` mode routes to a new `invoke_claude_interactive()` alongside the existing
`invoke_claude_main()`. Same artifact dir, git snapshot, and signal handling; the only diff
is the invocation: no `--print`, no `--no-session-persistence`, add `--session-name
"$lane"`, pass the prompt as a positional argument (read from the tmux PTY, not piped).
The existing `--tmux` flag already creates the window. `wait-worker-idle.sh <lane>` polls
the session JSONL for `stop_reason: "end_turn"`. `status.json` gains a `session_id` field
in interactive mode. A `revise` convenience wraps `set-buffer`/`load-buffer` +
`paste-buffer` + `Enter` against `main:ws-<lane>` (or `claude -r`/`codex resume` if the
pane exited). A reaper `kill-window`s and finalizes `status.json`.

```
owner Claude session
  ├─ tmux: spawn ws-<lane> ──> claude (interactive, --session-name <lane>)  [worktree A]
  │                       └─> codex  (interactive / resume-able)            [worktree B]
  ├─ capture-pane / pipe-pane ── live stream (b)
  ├─ paste-buffer + Enter ────── steer / revise (c, d)   ←─ idle probe (JSONL stop_reason)
  ├─ status.json{session_id} ─── compaction survival (e)
  └─ kill-window + finalize ──── reap (f)
        │
        └── disk + git-worktree + .git/workstreams = cross-agent protocol (no shared runtime)
```

## Build-vs-adopt: in-house `--interactive` vs Maniple vs hybrid

**Option 1 — Build (~55 lines, additive on `claude-workstream.sh`).** M1
(`--interactive` mode, ~30 lines), M2 (`session_id` in `status.json`, ~5 lines), M3
(`wait-worker-idle.sh` JSONL idle probe, ~20 lines). Zero new runtime dependency. Reuses
the harness's artifact/recovery/signal machinery and the `.git/workstreams` hub the owner
already operates. The owner uses raw `tmux` primitives (already documented in the
playbook) for steer/revise — functional but verbose.

**Option 2 — Adopt Maniple** (`Martian-Engineering/maniple`, a Python MCP server). The
owner loads it as an MCP server and calls `spawn_workers` / `message_workers` /
`wait_idle_workers` / `examine_worker` as tool calls; Maniple does the `tmux` work and the
JSONL idle detection for Claude **and** Codex. Cleanest interface, less owner bash. Costs:
a Python runtime (uv, already present), a `~/.maniple/config.json`, an MCP config entry,
and an external dependency whose worker identity/registry model is its own (Marx Brothers /
Beatles names) rather than the harness's lane/worktree/`status.json` contract — so it does
**not** by itself write the durable artifacts the owner's review and compaction-recovery
flow depend on.

**Option 3 — Hybrid (recommended).** Build M1–M3 now: they are tiny, dependency-free, and
keep the harness as the single source of truth for lanes, worktrees, artifacts, and
`status.json` (the substrate the owner's safety/review/compaction model already rests on).
Then run a bounded **Maniple evaluation spike** (M4) to decide whether to layer Maniple's
MCP tool-call ergonomics on top once cross-provider traffic justifies cleaner syntax — and
only if Maniple can be made to honor (or be bridged to) the lane/`status.json` contract.
**Recommendation: Option 3.** Build the in-house extension first because it is ~55 lines,
adds no dependency, and preserves the durable-artifact contract; treat Maniple as an
ergonomics layer to adopt after the spike, not a replacement for the substrate.

## Per-capability honest verdict

| Capability | Mechanism | Achievable now? | Confidence | Blocker / caveat |
|---|---|---|---|---|
| (a) Spawn into a tmux pane | `tmux new-window` + CLI invocation | Yes — already works | 95% | None; `--tmux` already does it |
| (b) Watch live stream | `capture-pane -p -S -N` / `pipe-pane` | Yes — already works | 95% | None; replace redirect-only with live capture |
| (c) Attach + steer / interrupt | `paste-buffer` + `Enter`; `C-c` | Yes, with `--interactive` (M1) | 80% | Requires dropping `--print`; `C-c` risks partial tool state |
| (d) Revise before teardown | live pane or resume by name/id | Yes, with `--interactive` + `--session-name` (M1) | 80% (Claude); ~70% (Codex) | Codex `resume`/`fork` exists (better than prior 65%) but `paste-buffer` PTY injection needs empirical confirmation |
| (e) Survive compaction | tmux daemon + JSONL + `session_id` | Yes, with M1 + M2 | 85% | Needs `session_id` in `status.json`; else manual JSONL scan |
| (f) Reap when done | `kill-window` + status finalize | Yes, with wrapper or manual | 75% | Auto-finalize of `status.json` needs the interactive wrapper |
| Cross-provider (Claude+Codex) | one owner, per-provider panes | Yes (Gemini deferred) | 75% | Codex revise unverified empirically; Gemini fire-and-forget only |

The two flags are the entire blocker for c/d/e/f. Drop them, add `--session-name`, and four
of six capabilities become real; a and b already work.

**Honest caveats (not overstated):** Codex interactive revision via `paste-buffer` is
plausible but unproven in this harness — `codex resume`/`fork` makes the resume path real,
the live-pane injection path is the unverified part. Gemini has no verified live-control
path; do not claim parity. The `Ctrl-C` mid-tool interrupt can corrupt partial file state;
the spec mandates preferring wait-for-turn-end.

## Failure modes (ranked)

| Failure | Probability | Mitigation |
|---|---|---|
| Message sits in input buffer (worker mid-tool-call) | High | Gate on JSONL idle probe; wait for turn end before sending |
| `Ctrl-C` interrupts mid-tool-write → partial file state | Medium | Prefer wait-for-turn-end; reserve `C-c` for runaways; inspect worktree after |
| Codex `paste-buffer` drops multi-line content | Medium | File-based handoff: write guidance to disk, tell Codex to read it |
| Owner compacts, loses which windows are alive | Medium | `tmux list-windows` + `pnpm workstreams:status` + `session_id` reconstruct |
| Claude JSONL id changes on restart (unresumable by id) | Low | Name-based resume (`-r "<lane>"`) is stabler than id-based |
| Two workers edit the same file via a shared dep | Low | Per-worker worktree isolation (existing) prevents it |
| Gemini pane hangs (no completion signal) | High if Gemini used | Do not use Gemini in live-control flows until CLI behavior verified |

## Alternatives considered and rejected

### A — Shared-runtime meta-orchestrator (rejected)
A runtime driving Claude + Codex + Gemini in lockstep with shared intermediate state.
**Rejected:** the providers are asynchronous and loosely coupled by design; a shared
runtime is a source of race conditions, not a feature, and it imports self-merge pressure
against a single-operator live stack holding real personal data. The disk + git-worktree
substrate is the integration point.

### B — MCP-only delegation (rejected as the endpoint, kept as a future layer)
Route all orchestration exclusively through an MCP server (e.g. Maniple) and drop the
harness. **Rejected as the endpoint:** the harness owns the durable-artifact contract
(lane, worktree, `status.json`, `.git/workstreams`) that the owner's review,
compaction-recovery, and safety model depend on; an MCP server with its own worker
registry does not write those artifacts. MCP ergonomics are kept as the optional M4
hybrid layer, evaluated by spike, not as a substrate replacement.

### C — Screen-scrape idle detection (rejected)
Detect "waiting for input" by matching the `❯` prompt glyph in `capture-pane` output.
**Rejected:** the glyph and layout change across CLI versions; the JSONL `stop_reason`
marker is version-stable and is what Maniple uses. Screen capture stays a human-facing
convenience, never the idle oracle.

### D — Gemini live-control parity now (rejected, deferred)
Claim spawn/steer/revise parity for Gemini. **Rejected:** Gemini's interactive tmux
behavior, prompt characters, JSONL path, and resume equivalent are unverified. Gemini stays
fire-and-forget until a verification spike confirms a live path.

### E — Auto-merge on owner satisfaction (rejected)
Let the revise loop end in an automatic merge. **Rejected:** violates the single-operator /
no-autonomous-merge boundary against the live personal-data stack. The owner reviews the
diff and gates integration; the worker never merges.

## Risks / trade-offs

- **Codex live-revise is unproven** in this harness (`resume`/`fork` exist; `paste-buffer`
  injection is the gap). Mitigation: the Maniple spike and a per-provider verification task
  confirm or fall back to file-based handoff before the spec claims Codex parity.
- **`Ctrl-C` partial-state risk** is real; mitigated by the wait-for-turn-end default and a
  worktree inspection step, not eliminated.
- **Owner context burn** under multiple live workers; mitigated by clawmeter-gating and
  bounded lane count, not removed.
- **Maniple registry vs harness contract mismatch** is the central build-vs-adopt risk;
  the hybrid recommendation resolves it by keeping the harness as the substrate.

## Acceptance Checks

- `--interactive` spawns a Claude worker whose pane stays alive after a turn; a revision
  sent via `paste-buffer` is answered in the same session; `claude -r "<lane>"` resumes it
  after pane exit. The default `--print` path is unchanged for existing callers.
- `wait-worker-idle.sh <lane>` exits exactly when the JSONL last event is
  `stop_reason: "end_turn"`; it never relies on the prompt glyph.
- `status.json` carries `session_id` in interactive mode; `pnpm workstreams:status`
  surfaces it; a simulated compaction reconstructs live lanes from disk + `tmux
  list-windows`.
- A clawmeter `--check` exit 2 (or `projected_at_reset >= ~95%`) refuses a new
  non-essential lane; exit 1 downshifts and records it.
- The Maniple evaluation spike returns a written build-vs-adopt recommendation honoring the
  lane/`status.json` contract; Codex and Gemini paths are verified or honestly marked
  unverified.
- `openspec validate add-live-tmux-agent-orchestration --strict` and `openspec validate
  --all --strict` pass.
