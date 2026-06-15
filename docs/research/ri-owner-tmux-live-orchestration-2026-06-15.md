# Live Cross-Boundary Tmux Orchestration — Design

Status: design proposal  
Owner: reference implementation owner  
Created: 2026-06-15  
Author: research + design pass (grounded against live prior art, real URLs, existing codebase)  
Supersedes: §5 of `docs/research/ri-owner-orchestration-process-design-2026-06-15.md` ("aspirational / probably never")

---

## 0. What the prior pass got wrong

The prior doc (§5) declared live cross-boundary orchestration "aspirational / probably
never" and retreated to fire-and-forget bounded-lane + report-to-disk. That framing is
**wrong in practice**: the prior-art field has already built exactly the capability the owner
described, running in production, and the primitives are sitting inside the existing
`claude-workstream.sh`. The blocker is two flags — `--print` and
`--no-session-persistence` — not an architectural gap.

This doc pins the prior art, grounds the design in what already exists, and gives an
honest per-capability verdict.

---

## 1. Prior art — what they actually built

### 1.1 Maniple (Martian-Engineering/maniple, ~45 stars, updated 7 days ago)

**URL:** https://github.com/Martian-Engineering/maniple  
**What it is:** A Python MCP server that the manager (owner) Claude Code session loads.
The manager calls MCP tools (`spawn_workers`, `message_workers`, `wait_idle_workers`,
`examine_worker`) and Maniple does all the tmux work on behalf of the manager.

**Concrete mechanism:**
1. `spawn_workers` — calls `tmux new-window` (or new-session) per worker, starts
   `claude` (interactive, no `--print`) or `codex` in that window. Assigns each worker a
   named identity (Marx Brothers, Beatles, etc.) mapped in an in-memory session registry.
2. `message_workers` — calls `tmux send-keys` (via `load-buffer` + `paste-buffer` for
   multi-line messages, same pattern the playbook already documents). Supports
   `wait_mode: "any" | "all"` with a configurable timeout.
3. `examine_worker` — calls `tmux capture-pane -p -S -<N>` to read the pane's current
   scrollback, returns it to the manager as text.
4. **Idle detection** — reads Claude Code's JSONL session files (written by the Claude
   process to `~/.claude/projects/<hash>/`) for stop-hook markers. When Claude finishes a
   turn, the hook fires and writes a sentinel to the JSONL; Maniple's poller sees it.
   Codex writes similar JSONL. This is reliable where screen-scraping the prompt character
   is not.
5. `wait_idle_workers` — polls idle state until the worker is done or timeout fires.
6. **Session recovery** — on MCP server restart, `list_sessions` discovers orphaned tmux
   windows and re-adopts them by re-indexing the JSONL.
7. **Cross-provider** — a worker's config specifies `provider: "claude" | "codex"`;
   Maniple starts the right CLI in the pane. The manager sees all workers identically.

Architecture (from their README):

```
Manager Claude Code Session (has maniple MCP server)
    │
    ├─ spawn_workers / message_workers / wait_idle_workers
    │
    ├── Groucho (tmux window, Claude Code, worktree-A)
    ├── Harpo   (tmux window, Claude Code, worktree-B)
    └── Chico   (tmux window, Codex,        worktree-C)
```

**Assessment:** This is exactly the design the owner described. It is production code, not a
prototype. The MCP tool interface means the owner does NOT manage tmux directly — it calls
tools, and Maniple handles the terminal primitives.

### 1.2 AWS CLI Agent Orchestrator (awslabs/cli-agent-orchestrator)

**URL:** https://github.com/awslabs/cli-agent-orchestrator  
**What it is:** Full orchestration framework with three modes and a web UI.

**Mechanism:**
- Every agent runs in its own tmux session (not just window). `tmux attach` is explicitly
  documented as the human HITL intervention path.
- Three orchestration primitives exposed over MCP:
  - `handoff` — sync: spawns worker, waits for completion, tears down terminal after
    saving scrollback to `~/.cao/logs/terminal/`
  - `assign` — async: spawns worker, returns immediately. Worker calls back when done.
  - `send_message` — inbox delivery between running agents (no teardown)
- Cross-provider: worker profiles pin a provider; supervisor on one CLI (e.g. Kiro),
  workers on another (e.g. Claude Code)
- Human intervention: `tmux attach` to any session, or `cao session send-message`

### 1.3 Groundcrew (ClipboardHealth/groundcrew, ~48 stars, updated actively)

**URL:** https://github.com/ClipboardHealth/groundcrew  
**What it is:** Task-backlog dispatcher — one git worktree per task, one Claude Code
session per worktree, all interactive (no `--print`). Manager dispatches from a task
queue; workers run in dedicated tmux windows.

### 1.4 The /loops pattern (Boris Cherny, Claude Code creator)

**Source:** https://x.com/0xMovez/status/2066225922928181644 (quoting Boris Cherny
interview, June 14 2026):

> "100% of our pull requests at Anthropic are run by Claude Code. 80–90% of code review
> too. The feature I'm using the most today is /loops. I'm not prompting Claude anymore —
> I'm building loops."

The Codez article (https://x.com/0xCodez/status/2064374643729773029, "Loop engineering:
the 14-step roadmap from prompter to loop designer") frames this as the dominant
paradigm shift. The `/loop` skill in this repo is a first-class embodiment. The key
distinction from what the owner wants: `/loop` runs the owner agent in a poll cycle inside
**one** session; tmux-as-orchestration-layer fans out to **multiple simultaneous agents**
that the owner can interrupt individually.

### 1.5 Ultracode lineage

The prior doc hand-waved "ultracode" as "zeitgeist" and guessed "oh-my-pi/omp." That
was wrong. The real lineage:

**Ultracode is an effort/API configuration, not a separate model or tool.**  
At the API level, "ultracode" = `effort=xhigh` + adaptive thinking + large `max_tokens` +
a system reminder injection. There is no secret model. The UltraCode-Shim project
(https://github.com/OnlyTerp/UltraCode-Shim) reverse-engineered and documented this
(see their `docs/HOW_IT_WORKS.md`). The proxy adds that envelope to every request so
any backend gets the UltraCode treatment.

In Claude Code's own settings: `/effort` sets the per-session effort level. `xhigh`
exists on Opus 4.8/4.7; `max` runs on any supported model for the current session only.
The session `/effort ultracode` the owner has been using is the Anthropic-shipped interactive
session setting — it is not a separate tool, CLI flag, or external project. It cannot be
hardcoded in agent frontmatter (`.md` files only accept static fields; effort is a runtime
session command).

---

## 2. The existing system — what's already there

### 2.1 What `claude-workstream.sh` already does

```bash
# Current invocation (scripts/claude-workstream.sh, invoke_claude_main):
printf '%s' "$main_prompt" | \
claude \
  --print \                      # <-- one-shot, exits when done
  --no-session-persistence \     # <-- no session file written, not resumable
  --model "$model" \
  --dangerously-skip-permissions
```

The `--tmux` flag already creates a `tmux new-window` named `ws-<lane>` in the `main`
session. The playbook already documents `tmux capture-pane`, `tmux set-buffer` /
`paste-buffer`, and the multi-line message pattern. The playbook already warns about
timing: send-keys can sit in the input box if Claude is mid-tool-call.

**What works today:** spawn in tmux, watch live (capture-pane), tail transcript.  
**What doesn't work today:** type-into (interactive session killed by `--print`), revise
(no session file to resume), reap-and-continue (session exits on completion).

### 2.2 The two-flag block

| Flag | Effect | Blocks |
|---|---|---|
| `--print` (`-p`) | Non-interactive: reads stdin, runs, exits | (b) watch live streaming, (c) attach and type, (d) revise mid-run |
| `--no-session-persistence` | No JSONL session file written | (d) resume session by ID, (e) orchestrator-survives-compaction |

Both flags together create a one-shot subprocess. Drop them and you get a durable
interactive session.

### 2.3 Claude session resume — concrete API

From the official CLI reference (https://docs.anthropic.com/en/docs/claude-code/cli-reference):

```bash
claude -r "<session-name-or-id>" "continue the task"
# Resumes session by name or ID. Interactive session, not --print.

claude -c   # Continue most recent conversation in current directory
claude -c -p "query"  # Continue via SDK (headless)
```

The `--resume <session-id>` flag also exists for headless SDK use (`-p` mode), used for
the `defer` flow where a hook pauses Claude mid-tool-call and the calling process resumes
it with updated input. This is a different flow from the interactive resume the owner wants.

**For interactive tmux resume:** drop `--print` and `--no-session-persistence`; the
session file is written automatically; the worker can be resumed from a new tmux window
or by re-attaching the pane.

### 2.4 Codex resume

`codex exec` runs non-interactively (analogous to `claude --print`). Codex does have
session files written to `~/.codex/projects/` but its `--resume` equivalent is not
documented in the same way as Claude's `-r` flag. The practical path for Codex resume is
the Maniple-style JSONL read + `message_workers` re-injection, not a CLI resume flag.
**Honest assessment:** Codex interactive resume is harder than Claude; plan around it.

---

## 3. The design — live interactive cross-boundary tmux orchestration

### 3.1 The conceptual model

```
Owner session (Claude, interactive, this terminal)
│
│  calls Maniple MCP tools  ──OR──  calls owner bash helpers
│
├── ws-worker-A (tmux window, claude, no --print, no --no-session-persistence)
│     session-id: auth-refactor-2026-06-15
│     JSONL: ~/.claude/projects/<hash>/session.jsonl
│
├── ws-worker-B (tmux window, claude, same)
│
└── ws-codex-C  (tmux window, codex exec OR codex interactive)
```

The owner orchestrates via two surfaces:
1. **Programmatic (preferred):** Maniple MCP tools (`spawn_workers`, `message_workers`,
   `wait_idle_workers`) — the owner's Claude process calls them as tool calls; Maniple
   handles all tmux primitives. This is the Maniple model and it already exists.
2. **Direct bash (fallback/transparency):** The owner agent issues bash commands using
   the primitives already documented in the playbook.

### 3.2 The minimal change to `claude-workstream.sh`

Add a `--interactive` mode flag. When set:

```bash
# Drop --print and --no-session-persistence.
# Add --session-name "$lane" so the session is addressable by name.
# Do NOT pipe stdin (interactive mode reads from the tmux PTY).
# Pass the prompt as the initial chat message, not via stdin pipe.
claude \
  --model "$model" \
  "${effort_args[@]}" \
  --session-name "$lane" \         # makes it resumable by name
  --setting-sources user \
  --strict-mcp-config \
  --mcp-config "$mcp_config" \
  --dangerously-skip-permissions \
  "$initial_prompt_text"           # positional arg, not piped
```

The `--session-name` flag is documented in the CLI reference:
```
--session-name <name>   Human-readable session name (resumable via -r)
```

This produces a session resumable via:
```bash
claude -r "$lane" "here is the revision: ..."
```
or by re-attaching the pane if it's still alive:
```bash
tmux attach -t "main:ws-$lane"
```

The existing `--tmux` flag already handles the `tmux new-window` scaffolding. The only
diff is removing two flags and adding `--session-name`.

### 3.3 Spawn (capability a)

```bash
# Owner issues:
scripts/claude-workstream.sh \
  --lane auth-refactor \
  --worktree /path/to/worktree \
  --prompt tmp/workstreams/auth-refactor-prompt.md \
  --report tmp/workstreams/auth-refactor-report.md \
  --interactive \
  --tmux

# Creates: tmux window "ws-auth-refactor" in session "main"
# Claude starts interactive, session-name="auth-refactor"
```

For Codex workers:
```bash
tmux new-window -t main -n "ws-codex-worker" -- bash -c "
  cd /path/to/worktree && \
  codex --agent worker_low --quiet \
    'Task: <task text>. Write report to tmp/workstreams/codex-report.md when done.'
"
```

For Gemini workers (when gem/gemini CLI available):
```bash
tmux new-window -t main -n "ws-gemini-worker" -- bash -c "
  cd /path/to/worktree && \
  gemini -p '<task>' --model gemini-2.5-pro-preview
"
```

### 3.4 Watch live streaming (capability b)

```bash
# Non-destructive, runs from owner session:
tmux capture-pane -t "main:ws-auth-refactor" -p -S -100 | tail -50

# Or watch in a split pane (human only, not agent):
tmux split-window -t main:ws-auth-refactor -h "watch -n2 tmux capture-pane -t main:ws-auth-refactor -p -S-50 | tail -20"
```

The owner agent can poll `tmux capture-pane` at any interval. The JSONL file is the
more reliable idle signal (Maniple's approach).

**Prompt-completion detection (the hard part):** The owner needs to know when Claude
is "waiting for input" vs. "mid-tool-call." Three signals, in order of reliability:

1. **JSONL stop marker** — most reliable. Claude Code writes a stop event to
   `~/.claude/projects/<hash>/<session>.jsonl` when a turn ends. Poll this file.
   Pattern: `{"type":"assistant","stop_reason":"end_turn",...}` as the last event.
2. **Screen pattern** — less reliable but works: `tmux capture-pane` output contains the
   `❯` prompt at the bottom with no tool-call block above it. Maniple uses JSONL; the
   playbook warns against relying on screen patterns alone.
3. **Process state** — Claude stays alive (no `--print`); you can `kill -0 <pid>` to
   confirm it's running. Pane exits only if Claude itself crashes.

### 3.5 Attach and type / interrupt (capability c)

**Human attaches interactively:**
```bash
tmux attach -t main       # see all windows including ws-auth-refactor
# or
tmux select-window -t main:ws-auth-refactor && tmux attach -t main
```

**Owner agent sends revision:**
```bash
# Short message:
tmux set-buffer -- "The approach in auth.ts is wrong — use X instead of Y"
tmux paste-buffer -t "main:ws-auth-refactor"
tmux send-keys -t "main:ws-auth-refactor" Enter
sleep 1
tmux capture-pane -t "main:ws-auth-refactor" -p -S -40 | tail -20

# Long guidance (multi-line):
cat > tmp/workstreams/auth-revision.md << 'EOF'
...multi-line guidance...
EOF
tmux load-buffer tmp/workstreams/auth-revision.md
tmux paste-buffer -t "main:ws-auth-refactor"
tmux send-keys -t "main:ws-auth-refactor" Enter
```

**Interrupt a mid-run worker:**
```bash
# Send Ctrl-C to interrupt a running tool call:
tmux send-keys -t "main:ws-auth-refactor" C-c
sleep 0.5
# Then send the correction:
tmux set-buffer -- "Stop. The direction is wrong. Instead: ..."
tmux paste-buffer -t "main:ws-auth-refactor"
tmux send-keys -t "main:ws-auth-refactor" Enter
```

**Race condition on timing:** if Claude is mid-tool-call, the message lands in the input
buffer and submits only after the current tool completes. This is documented behavior in
the playbook and is the right behavior — Claude will process the message next turn. The
Ctrl-C approach interrupts immediately but risks leaving a file half-written; prefer
waiting for tool completion except for clear runaway cases.

### 3.6 Revise before teardown (capability d) — the critical one

**With `--interactive` mode (no `--print`, `--session-name` set):**

The pane stays alive after Claude finishes a turn. The session file persists. The owner
can type corrections directly into the pane, or send them via `paste-buffer`. Claude
responds in the same session with full conversation history. The worker is NOT torn down
until the owner explicitly kills the window:

```bash
# Worker is "done" but still in the pane, waiting:
tmux send-keys -t "main:ws-auth-refactor" \
  "The tests pass but the report is missing the failure mode section. Add it." Enter

# Claude responds in the same session, same JSONL, same context.
# When satisfied:
tmux send-keys -t "main:ws-auth-refactor" "Done. Exit." Enter
# Or kill the window:
tmux kill-window -t "main:ws-auth-refactor"
```

**Resume a session after pane exit (e.g. crash, or the owner closed the window):**
```bash
# The session file still exists on disk because --no-session-persistence was NOT used.
claude -r "auth-refactor" "Continue: the tests passed. Now add the failure mode section."
# This opens a NEW interactive session in the current terminal, resuming the same
# conversation history. If the owner wants it in a new tmux window:
tmux new-window -t main -n "ws-auth-refactor-r1" -- \
  bash -c 'claude -r "auth-refactor" "Continue: ..."'
```

**For Codex:** No equivalent `-r` flag is documented. The practical substitute is:
1. Keep the pane alive (don't `codex exec` — use interactive `codex` mode, or
2. Write revision instructions to a handoff file and inject via `paste-buffer`.
Codex session resume requires the session file path, which varies; JSONL is written
to `~/.codex/projects/` but the resume CLI is less mature than Claude's.

### 3.7 Orchestrator survives compaction (capability e)

With `--print` + `--no-session-persistence`, if the owner session compacts, the worker
session cannot be recovered — there's no session file. With interactive mode:

1. Worker JSONL session files persist in `~/.claude/projects/<hash>/` regardless of what
   happens to the owner.
2. The `pnpm workstreams:status` tool reads `status.json` per lane — this already
   survives compaction (it's on disk).
3. After owner compaction/restart, the owner can reconstruct state by:
   - Running `pnpm workstreams:status` (reads all status.json files)
   - Running `tmux list-windows -t main` (sees all live ws-* windows)
   - Running JSONL reader to see each worker's last message
   - Resuming the worker conversation via `claude -r "<lane>" "..."` if the pane exited
4. Add a `session_id` field to `status.json` (the `--session-name` value or the JSONL
   hash) so the status tool can surface the exact resume command.

This is **genuinely achievable** and directly improves on the current state.

### 3.8 Reap when done (capability f)

```bash
# After owner confirms the report is good and changes are committed:
tmux kill-window -t "main:ws-auth-refactor"
# status.json is already written by the script; update to "done":
# (currently done by the script's finalize_status step)
pnpm workstreams:status  # confirms lane is gone
```

In `--interactive` mode, the script cannot auto-finalize `status.json` on Claude
exit (the script itself exits immediately after launching the tmux window). The status
write moves to a post-exit hook or the owner's reap command. Options:

1. Add a `--interactive` sentinel: the launched tmux window runs a wrapper that updates
   `status.json` when the Claude process exits (naturally or by kill).
2. Owner does it manually: `pnpm workstreams:reaper` (B4 from prior doc).

---

## 4. Cross-provider ceiling and failure modes

### 4.1 What's achievable with one owner + Claude + Codex + Gemini in panes

**The ceiling:** One owner Claude session can drive N workers across providers. Each
worker runs in its own tmux window with its own git worktree. The owner reads live output
via `capture-pane` and sends revisions via `paste-buffer`. This is proven by Maniple and
CAO. The limit is not architectural — it's:

1. **Shared worktree racing:** Two workers on the same branch will conflict on edits.
   Solution already in place: each worker gets its own worktree (the existing system
   already does this).
2. **Codex interactive mode:** `codex exec` is non-interactive. The interactive `codex`
   CLI exists but its message-injection behavior is less well-tested than Claude's.
   The `paste-buffer` approach should work but requires empirical validation.
3. **Gemini CLI:** The `gemini` CLI is present (via `gemini -p` for headless) but its
   interactive mode behavior in a tmux pane is unverified. Risk: unknown prompt
   characters, different JSONL path, no session resume equivalent.
4. **Owner token budget:** Running 4+ workers simultaneously with a compacting owner
   session burns context fast. The existing playbook constraint (Codex budget reserved for
   owner) exists for this reason. Relaxing it for workers means the owner must be leaner.
5. **Knowing when a pane is "waiting for input":** Claude JSONL is reliable. Codex JSONL
   is similar. Gemini has no known equivalent — screen-scraping only, which is fragile.
6. **Race on `send-keys` timing:** if the owner sends a revision while Claude is
   mid-tool-call, the message queues in the input buffer. This is fine behavior but the
   owner needs to detect it (via `capture-pane` showing the message in the input line) and
   not assume Claude received it until it responds.

### 4.2 Failure modes, ranked by probability

| Failure | Probability | Mitigation |
|---|---|---|
| Message sits in input buffer (Claude mid-tool-call) | High | Check capture-pane after send; wait for turn end |
| Codex paste-buffer drops multi-line content | Medium | Use file-based handoff (write to disk, tell codex to read) |
| Owner compacts, forgets which windows are alive | Medium | `tmux list-windows` + `pnpm workstreams:status` reconstruct |
| Two workers edit same file via shared dep | Low | Worktree isolation (existing system) prevents this |
| Claude JSONL hash changes on restart (unresumable) | Low | Name-based resume (`-r "lane-name"`) is more stable than hash-based |
| Gemini pane hangs (no known completion signal) | High if Gemini used | Do not use Gemini in live-control flows until CLI behavior verified |

---

## 5. The minimal build — what to actually change

These are sorted by impact and smallest to largest diff.

### M1. Drop `--print` + `--no-session-persistence` in `--interactive` mode (1 function change)

In `scripts/claude-workstream.sh`, add `--interactive` flag that routes to a new
`invoke_claude_interactive()` function. Same structure as `invoke_claude_main()` but:
- No `--print`
- No `--no-session-persistence`
- Add `--session-name "$lane"`
- Pass prompt as positional argument instead of piped stdin

The `--tmux` flag already handles window creation; the interactive function just changes
the claude invocation inside the window. The rest of the harness (artifact dir, git
snapshot, signal handling) stays unchanged.

**Estimated diff:** ~30 lines added, 0 deleted.

### M2. Add `session_id` to `status.json` (1 field addition)

When `--interactive` mode runs, write `session_name: "$lane"` to `status.json`. The
status tool can then surface the exact resume command. This makes compaction recovery
a one-command operation.

**Estimated diff:** ~5 lines.

### M3. JSONL idle probe (new helper, ~20 lines)

```bash
# scripts/wait-worker-idle.sh <lane>
# Polls ~/.claude/projects/ for the session JSONL matching lane name.
# Exits when stop_reason=end_turn appears as the last event.
# Used by owner to know when to intervene or reap.
```

This replaces the "sleep + capture-pane" poll with a reliable signal. Maniple implements
this in Python; the bash version is a simple `tail -f + grep` loop.

### M4. (Optional, medium effort) Add Maniple as MCP server

Install Maniple (`pip install maniple`) and add it to the owner session's MCP config.
The owner then calls `spawn_workers`, `message_workers`, `wait_idle_workers` as tool
calls instead of raw bash. This is the cleanest interface but requires:
- Python runtime (uv, already in use)
- Maniple config file (`~/.maniple/config.json`)
- MCP config entry

The owner skill (or the playbook) can document this as the preferred path. Without
Maniple, the owner uses the bash primitives directly — functional but more verbose.

---

## 6. Per-capability honest verdict

| Capability | Description | Achievable now? | Confidence | Blocker |
|---|---|---|---|---|
| (a) Spawn agent of any provider into tmux pane | `new-window` + CLI invocation | Yes, already works | 95% | None — `--tmux` already does it |
| (b) Watch stream/think live | `capture-pane -p -S -N` | Yes, already works | 95% | None |
| (c) Attach and type / interrupt mid-run | `paste-buffer` + Enter; `C-c` | Yes, with `--interactive` mode | 80% | Requires dropping `--print` (M1). Ctrl-C interrupt works but risks partial tool state. |
| (d) Revise before teardown (worker stays alive) | Send message to waiting pane; resume by name | Yes, with `--interactive` + `--session-name` | 80% | Requires M1. Codex revision path is less tested (~65%). |
| (e) Orchestrator survives compaction (panes persist) | tmux daemon + JSONL + status.json session_id | Yes, with M1 + M2 | 85% | Requires adding session_id to status.json (M2). Without it, compaction recovery requires manual JSONL scan. |
| (f) Reap when done | `kill-window` + status update | Yes, with wrapper or manual reap | 75% | Auto-finalize of status.json needs a wrapper in `--interactive` mode (M1 side effect). |

**The two flags are the entire blocker for c, d, e, f.** Drop them, add `--session-name`,
and four of the six capabilities become real. Capabilities a and b already work today.

**Honest caveats:**
- Codex interactive revision: 65% confidence. The paste-buffer mechanism works for
  Claude; Codex's PTY behavior in tmux needs empirical confirmation.
- Gemini: do not claim live-control parity. Its CLI interactive mode is unverified for
  this workflow. Fire-and-forget + report-to-disk remains the safe Gemini path.
- The "type-into mid-run" interrupt (Ctrl-C + redirect) has a real partial-tool-state
  risk. Prefer waiting for turn end and sending the correction then.
- JSONL session-file path depends on the project directory hash (Claude Code uses a
  hash of the worktree path). Naming via `--session-name` makes it addressable by name
  without knowing the hash.

---

## 7. What NOT to build

- A meta-orchestrator that drives all three providers in lockstep with shared intermediate
  state. The three providers are asynchronous and loosely coupled by design; a shared
  runtime would be a source of race conditions, not a feature.
- A screen-scraper that detects "waiting for input" by matching the `❯` character. JSONL
  is more reliable; the screen pattern changes across CLI versions.
- A Gemini live-control path until the Gemini CLI interactive-mode behavior in tmux is
  empirically confirmed. Document it as "M4: future, requires verification."
- Anything that requires changing the playbook's "worker does not merge" constraint.
  The revision flow (capability d) ends with the owner reviewing and merging, not the
  worker.

---

## 8. Recommended build sequence

1. **M1 (this week, 30 lines):** Add `--interactive` mode to `claude-workstream.sh`.
   Drop `--print` + `--no-session-persistence`, add `--session-name`. Test by spawning
   one interactive Claude worker, sending a revision via `paste-buffer`, confirming it
   responds in the same session, and confirming `claude -r "lane"` resumes it after
   pane exit.

2. **M2 (same session, 5 lines):** Add `session_name` to `status.json` in interactive
   mode.

3. **M3 (next session, 20 lines):** JSONL idle probe helper. This turns the "is the
   worker done?" question from a screen-scrape guess into a reliable signal.

4. **M4 (optional, when cross-provider traffic justifies it):** Add Maniple as an MCP
   server. This gives the owner clean tool-call syntax instead of raw bash for all
   orchestration primitives.

The fire-and-forget `--print` mode should stay as the default (unchanged behavior for
all existing callers). `--interactive` is opt-in.

---

## 9. Sources

- Maniple: https://github.com/Martian-Engineering/maniple (Python MCP server, tmux +
  iTerm2 backends, Claude Code + Codex workers)
- AWS CLI Agent Orchestrator: https://github.com/awslabs/cli-agent-orchestrator
  (handoff / assign / send_message over MCP, tmux session isolation, cross-provider)
- Groundcrew: https://github.com/ClipboardHealth/groundcrew (task-backlog dispatch,
  one worktree per task, interactive agents)
- Boris Cherny on /loops: https://x.com/0xMovez/status/2066225922928181644
- Loop engineering article: https://x.com/0xCodez/status/2064374643729773029
- Claude Code CLI reference: https://docs.anthropic.com/en/docs/claude-code/cli-reference
- Claude Code sub-agents / resume: https://docs.anthropic.com/en/docs/claude-code/sub-agents
- Ultracode mechanism: https://github.com/OnlyTerp/UltraCode-Shim (effort=xhigh +
  adaptive thinking + max_tokens; no secret model)
- Existing system: `scripts/claude-workstream.sh`, `docs/agent-workstream-playbook.md`
