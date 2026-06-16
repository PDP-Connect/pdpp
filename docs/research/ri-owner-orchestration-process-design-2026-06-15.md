# Integrated PDPP RI-Owner Orchestration Process — Grounded Design

Status: design proposal
Owner: reference implementation owner
Created: 2026-06-15
Author: synthesis pass (grounded against live artifacts + ultracode/loop-engineering prior art)

Related: design-notes/full-context-refresh.md, docs/agent-workstream-playbook.md, scripts/claude-workstream.sh, scripts/workstreams-status.mjs, dotfiles/ai/skills/local/agent-steering-audit/SKILL.md, .codex/agents/gpt55-low-worker.toml

---

## 0. The honest framing

the owner's warning is the spine of this document: **"be careful not to over-engineer; the
process is pretty good but too manual."** The diagnosed real problem is **steering loss**
(the 2026-05-28 audit primitive families: stop-rule/human boundary, object continuity,
expected-state reconciliation, confidence+evidence+scope, delegation authority) — **not
branch sprawl.** `workstreams-status.mjs` already inventories worktrees, panes, OpenSpec,
and wrapper lanes well. We do not have a read-side problem. We have a **continuity and
selection** problem:

1. The owner re-derives "what is live and what does it need next" every time a session
   compacts or a worker hands off. The ledger (`ri-owner-current-state.md`) is the cure,
   but it is **hand-maintained prose** — it goes stale silently, which is itself a
   steering-loss vector.
2. Model/effort/provider selection for each lane is **a manual judgment the owner makes
   blind to quota**. clawmeter exists and is agent-readable but is **not wired into the
   loop**.
3. The 7-state owner-decision model is **enforced by owner attention, not by the tooling**.
   A lane in `review` that the owner forgets is indistinguishable from one in `waiting`.

Everything below is scoped to those three gaps and nothing more. The temptation —
amplified by the ultracode / "loop engineering" zeitgeist — is to rebuild this as a
dynamic-workflow auto-pilot that fans out hundreds of agents and self-merges. **That is
the trap.** PDPP's live stack is a single-operator mutex against real personal data; the
binding constraint is owner trust and integration judgment, not worker throughput.

---

## 1. Thesis — what the integrated RI-owner process IS

**The integrated RI-owner process is the existing manual loop with three thin
machine-maintained surfaces bolted onto the artifacts that already exist — so the owner
agent spends its scarce judgment on integration decisions, not on reconstructing state or
guessing model/quota.**

It is *not* a new orchestrator, *not* a workflow runtime, *not* an autonomous merger. The
loop stays: classify → delegate bounded lane → worker reports to disk → owner reconciles →
owner decides (one of 7 states) → owner integrates/validates/merges. The change is that
three points in that loop stop being pure owner memory:

- **State continuity:** the live ledger gains a *machine-derived* section so it cannot
  silently go stale (the status tool already computes everything needed; we just emit it
  into the ledger as a regenerable block).
- **Selection:** model/effort/provider choice for a new lane becomes a *rule fed by
  clawmeter*, not a blind judgment.
- **Lifecycle:** the 7 owner-decision states get *machine-surfaced staleness* (a lane in
  `review` for N hours with no owner action is a flagged risk), and dead tmux/worktree
  lanes get a *one-command reaper* instead of hand-typed `tmux kill-window`.

The whole design is "make the artifacts that already encode the right model
self-maintaining at their thinnest possible surface." Loop engineering's genuinely
useful primitive — **state lives in script variables / on disk, not in the agent's
context window** — is *already how this system works* (workers write reports to disk; the
harness captures status.json). We lean into that, we do not import the runtime.

---

## 2. What to build (each piece builds on an existing artifact)

Ordered by leverage. Sizes and over-engineering risk are explicit.

### B1. `workstreams:ledger-sync` — machine-derived ledger block (SMALL, low risk) — BUILD FIRST

**Builds on:** `scripts/workstreams-status.mjs` + `tmp/workstreams/ri-owner-current-state.md`.

The status tool already computes the live-object inventory the ledger is supposed to hold:
worktrees (dirty/ahead/behind/unmerged), tmux panes, recent reports, merge-queue/blocker
cards, OpenSpec buckets, wrapper-lane state from status.json. Today the owner *retypes* a
subset of that into the ledger as prose, and it drifts.

Add a `--emit-ledger-block` flag (or a tiny sibling script) that writes a delimited,
regenerable block into the ledger:

```
<!-- BEGIN MACHINE-DERIVED (workstreams:status @ <ts>) -->
... live objects table, per-lane state, action-blocking risks ...
<!-- END MACHINE-DERIVED -->
```

The owner's prose (intent, decisions, what-next narrative) lives *above* the block and is
never touched. The block is overwritten each run. This makes the ledger's factual half
**impossible to silently stale** — it carries a timestamp, and `workstreams:status`
already exits non-zero on action-blocking risk, so a stale block is loud.

This is the single highest-leverage piece: it directly attacks steering-loss primitive
#2 (object continuity / state ledger) and #3 (expected-state reconciliation) at near-zero
cost, reusing code that already exists. **Over-eng risk: low** — it is an emit format, not
new logic.

### B2. `clawmeter`-aware selection rule (SMALL, low risk) — BUILD FIRST

**Builds on:** `scripts/claude-workstream.sh` (already takes `--model`/`--effort`) +
clawmeter (`clawmeter status --agent`, `clawmeter --check`).

Today the owner picks model/effort blind to quota. clawmeter already emits exactly what's
needed in one line:

```
Quota: worst=Claude 7d All; current=39%; projected_at_reset=74.1%; reset_in=3d7h; status=on_track.
```

The integration is a **rule the owner agent applies before launching a lane**, plus an
optional preflight gate in the harness. The rule (see §4) is deliberately a *decision
table*, not an optimizer. The harness change is one preflight: call `clawmeter --check`;
if exit 2 (critical), refuse to launch and tell the owner; if exit 1 (warning), downshift
the default model/effort one step and log it in status.json. **Over-eng risk: low** —
clawmeter does the measurement; we add a 3-branch gate.

### B3. Claude `~/.claude/agents/` tier set mirroring `.codex/agents/` (SMALL, low risk)

**Builds on:** `.codex/agents/gpt55-low-worker.toml` (the *only* existing agent def) + the
playbook's role model + the worker WORKSTREAM CONTRACT in the harness.

`~/.claude/agents/` is currently **empty**. We mirror the Codex tier idea — but note the
honest fact that Codex itself only has *one* tier today (`gpt55-low-worker`). The proposal
is to define the matching Claude tiers so the owner can route by named role. See §3 for
concrete defs. **Over-eng risk: low** — these are static frontmatter files; the risk is
defining tiers nobody routes to, so we keep the set to four and tie each to an actual
work-category from the playbook.

### B4. `workstreams:reaper` — one-command dead-lane cleanup (SMALL, low–med risk)

**Builds on:** `workstreams-status.mjs` idle-tmux-cleanup-candidate + stale-running
detection + parked-marker logic (all already implemented).

The status tool *already identifies* idle tmux panes and stale-running (SIGKILLed) lanes
and even prints the exact `tmux kill-window` command. The reaper just **executes** those
already-computed, already-safe candidates behind a confirmation, and finalizes orphaned
status.json files to a terminal state. It must respect `parked/<lane>` markers (already a
concept) and must **never** touch a worktree with unmerged commits or a dirty tree —
those are inventory, not garbage (playbook §"Old/stale worktrees... are still listed as
inventory, but they are not automatically risks"). **Over-eng risk: medium** — the trap
is letting the reaper delete branches/worktrees; scope it to *tmux panes + status.json
finalization only*, never `git branch -d` / `worktree remove`. Branch lifecycle stays
owner-driven.

### B5. 7-state staleness surfacing in `workstreams:status` (SMALL, low risk)

**Builds on:** the playbook's 7-state model (`waiting/review/revise/merge/delete/park/done`)
+ the ledger's per-object decision-state field.

Today the 7 states live in the ledger prose and are enforced by owner memory. Add a thin
check: parse the per-object decision state from the machine block / ledger, and emit a
risk when a lane has been in a *non-terminal, owner-action-required* state
(`review`, `revise`, `merge`) past a threshold with no new report or commit. This converts
"owner forgot a lane in review" — a pure steering-loss event — into an action-blocking
risk the existing non-zero exit already surfaces. **Over-eng risk: low**, provided the
threshold is generous and `park` suppresses it (parked markers already do this).

### B6. (DEFER) `live-stream` — append-only owner-decision event stream

**Builds on:** `.git/workstreams/events.ndjson` (already exists) + `decisions.md`.

The hub already has `events.ndjson`. A "live stream" of owner decisions (who decided what,
when, why) would strengthen the integrity spine and survive compaction better than prose.
But it overlaps the Decision Log in `full-context-refresh.md` and the existing ndjson.
**Defer** until B1–B5 are in use and a *demonstrated* gap exists. Building a second event
log before the first is consistently written is classic over-engineering.

---

## 3. Concrete Claude agent defs (`~/.claude/agents/`, mirroring `.codex/agents/`)

The Codex side has exactly one def today (`gpt55-low-worker.toml`). The proposed Claude
mirror defines a four-tier set so the owner can route by role. Each tier ties to a
playbook work-category and carries the **same non-overridable worker contract** the harness
already injects (read-only default, no live-stack mutation, report-to-disk). These are
Claude Code subagent markdown files with frontmatter.

**`~/.claude/agents/ri-owner.md`** — the integration gatekeeper. `model: opus`,
`effort: high` (xhigh/ultracode is a *session* setting, not persistable in frontmatter —
the owner toggles `/effort ultracode` interactively for hard integration passes; do not
hardcode it). Role: classify, delegate, reconcile, decide (7 states), validate, merge.
**Holds authority. Never delegated to.**

**`~/.claude/agents/ri-explorer.md`** — read-only investigation/audit/triage. `model: opus`
or `sonnet` per depth, `effort: high`. Produces memos/matrices, never edits. Mirrors the
playbook's Explorer/Reviewer role.

**`~/.claude/agents/ri-worker.md`** — bounded implementation lane. `model: sonnet`,
`effort: high`. One non-overlapping target, writes report to `$report_abs`, does not merge.
The standard Claude worker the harness launches today.

**`~/.claude/agents/ri-worker-low.md`** — direct counterpart to `gpt55-low-worker.toml`.
`model: haiku` (or sonnet at `effort: low`), `effort: low`. Mechanical lanes: grep sweeps,
call-site inventory, fixture replay, mechanical edits after the target shape is chosen.
Read-only by default.

Each file's body is the worker contract, near-verbatim from the harness injection and the
Codex `developer_instructions`: *follow the task packet exactly; default read-only unless
the packet assigns implementation; never deploy/restart/vacuum/touch the live stack; no
broad UI edits unless assigned; write concise reports to the requested tmp/workstreams
path; preserve web-research sources to docs/research per the HARD RULE.*

This gives a symmetric routing vocabulary across Codex and Claude (and, aspirationally,
Gemini) without inventing capability the harness doesn't already enforce.

---

## 4. clawmeter-awareness — the simplest rule

The owner agent becomes clawmeter-aware via **one decision table, applied at lane-launch
time**, fed by `clawmeter status --agent` (one line) and `clawmeter --check` (exit code).
No optimizer, no scheduler.

| clawmeter signal | Owner action |
| --- | --- |
| `status=on_track` and `--check` exit 0 | Launch lane at its tier's default model/effort. |
| `status` warning / `--check` exit 1 | Downshift one step (opus→sonnet, or effort high→medium); prefer `ri-worker-low` for mechanical lanes; log the downshift. |
| `--check` exit 2 (critical) or projected_at_reset ≥ ~95% | **Do not launch** new non-essential lanes. Finish/merge in-flight work only. Tell the owner. |
| Cross-provider: Claude worst but Codex/Gemini healthy | Route the next *delegatable, non-authority* lane to the healthy provider's worker (see §5). |

The harness enforces the floor: a `clawmeter --check` preflight that refuses launch on
exit 2 and downshifts the default on exit 1, recording the decision in status.json. That
is the entire integration — measurement is clawmeter's job; the owner/harness only branch
on it. **The trap to avoid:** building a quota-aware *scheduler* that queues and paces
lanes. The single-operator mutex and bounded lane count make that unnecessary.

---

## 5. Cross-boundary (Codex / Claude / Gemini) orchestration — realistic vs aspirational

**What is actually achievable now (minimal):** The owner agent (running in any one
harness) treats the *other* providers as **named worker backends selected by the §4 quota
rule**, launched as bounded lanes that write reports to the same `tmp/workstreams` disk
convention. The unifying substrate already exists and is provider-neutral: **bounded lane
+ report-to-disk + `workstreams-status.mjs` reconciliation.** A Codex worker
(`gpt55-low-worker`) and a Claude worker both end as "a branch + a report file the owner
reviews." That is real, shippable cross-boundary orchestration: *route by quota, reconcile
by disk.*

Concretely: extend the wrapper/ledger so a lane records its `provider` and `agent` tier;
the status tool already reads status.json and could surface provider per lane. clawmeter
already polls Claude/Copilot/Gemini/Kimi, so the §4 cross-provider routing branch has real
data.

**The honest constraints (today):**
- The playbook *currently forbids Codex worker lanes* (token budget reserved for the
  owner/integration pass). So cross-boundary routing is **gated on the owner relaxing that
  rule** — it is an operational, not architectural, block, and the playbook says so.
- Gemini is presently **setup-needed** in clawmeter (token expired). Cross-provider routing
  to Gemini is aspirational until that's fixed.
- There is **no shared session/runtime** across providers and there should not be. Each
  provider runs its own bounded lane; the *only* shared state is the disk convention and
  the git worktree. Do not build a meta-orchestrator that drives three CLIs in lockstep —
  that is the aspirational over-build. The owner agent in one harness, launching
  bounded lanes in others and reconciling via the status tool, is the realistic ceiling.

**Aspirational (defer / probably never):** a single workflow runtime that fans out across
all three providers with shared intermediate state. PDPP does not need it; the bounded-lane
+ disk-report substrate is strictly simpler and already proven.

---

## 6. Lifecycle automation (reaper + revise-state + live-stream), scoped minimally

This is the area most at risk of over-engineering. Scope each to its thinnest form:

- **Reaper (B4):** executes *only* the idle-tmux-cleanup and stale-status.json candidates
  the status tool **already computes**, behind confirmation, respecting parked markers,
  **never touching branches or non-empty/unmerged worktrees**. It is an executor of an
  existing safe list, not a garbage collector with its own policy.

- **Revise-state (B5):** the 7-state model gains *machine-surfaced staleness only*. A lane
  stuck in `review`/`revise`/`merge` past a generous threshold becomes a status risk. We do
  **not** auto-transition states — state transitions are owner decisions; the machine only
  makes a *forgotten* state loud. This directly fixes a steering-loss vector (the
  human-in-loop boundary going silent) without removing the human from the loop.

- **Live-stream (B6, DEFER):** an append-only owner-decision event stream. The hub already
  has `events.ndjson` and `decisions.md` and the refresh.md Decision Log. Adding a third
  channel before the first two are reliably written is premature. Defer until a concrete,
  demonstrated continuity gap survives B1's machine-derived ledger block.

Everything here reuses detection/state that already exists. The automation is *execution
and surfacing*, never *new policy or autonomous mutation*.

---

## 7. What NOT to build (over-engineering traps)

1. **A dynamic-workflow / ultracode auto-pilot runtime for RI ownership.** The "state in
   script variables not context" win is *already achieved* by report-to-disk + status.json.
   Importing the runtime adds an isolated executor, 16-agent fan-out, and self-merge
   pressure against a single-operator live stack holding real personal data. Wrong fit.
2. **A quota-aware scheduler/pacer.** clawmeter + a 3-branch launch gate is enough. Bounded
   lane count + mutex means there's nothing to schedule.
3. **A second event log / live-stream before the first is reliably written** (B6 deferral).
4. **A reaper that deletes branches or worktrees.** Inventory ≠ garbage; the playbook is
   explicit. Branch lifecycle stays owner-driven.
5. **A meta-orchestrator driving Codex+Claude+Gemini in lockstep with shared session
   state.** The disk + worktree substrate is the integration point; keep providers
   independent bounded lanes.
6. **Auto-transitioning the 7 owner-decision states.** Surfacing staleness preserves the
   human boundary; auto-advancing destroys it — the exact steering-loss failure the audit
   warned about.
7. **Rewriting the playbook/refresh.md into a "system."** They encode the right model. The
   fix is making their artifacts self-maintaining at the edges, not replacing them.
8. **Tiers/agents nobody routes to.** Keep the Claude agent set to four, each tied to a
   real work-category and the existing worker contract.

---

## 8. Honest recommendation

**Build first (this week), in order — all SMALL, all low-risk, all reuse existing code:**

1. **B1 ledger-sync** (machine-derived ledger block) — highest leverage against
   steering-loss, near-zero cost, reuses the whole status tool.
2. **B2 clawmeter launch gate + selection rule** — removes the blind model/effort/quota
   judgment, the most repetitive owner decision.
3. **B3 Claude agent tier set** — gives a routing vocabulary; `~/.claude/agents/` is empty
   today and the Codex side is a single file, so this is also the moment to decide whether
   the four-tier model is even worth formalizing on the Codex side.

**Build next (after B1–B3 are in daily use):**

4. **B5 7-state staleness surfacing** — small, fixes a real forgotten-lane vector.
5. **B4 reaper** — convenience executor of already-safe candidates; medium risk, so it
   lands *after* the cheaper wins and stays scoped to tmux+status.json only.

**Defer (until demonstrated need):**

6. **B6 live-stream**, full cross-provider routing to Gemini (blocked on token), and any
   relaxation of the Codex-worker prohibition (owner call).

**Is the full ambition worth it?** *No — not the full ambition.* The loop-engineering
framing is seductive and the underlying primitive (state off the context window) is sound,
but PDPP **already has it** via report-to-disk. The honest read is that **B1 + B2 alone
capture ~70% of the value** by killing the two most repetitive steering-loss events
(reconstructing live state; choosing model/quota blind). B3–B5 are real but incremental.
Everything past B5 risks rebuilding a good manual process into a fragile auto-pilot that
fights the single-operator mutex. The process is, as the owner said, *pretty good* — the work is
to make its existing artifacts self-maintaining at the thinnest possible surface, not to
replace the judgment loop with a runtime.

---

## 9. Confidence

**Medium-high.** Grounded against the live artifacts: confirmed `.codex/agents/` holds only
`gpt55-low-worker.toml`, `~/.claude/agents/` is empty, `clawmeter status --agent`/`--check`
emit exactly the signals §4 needs, `claude-workstream.sh` already accepts `--model/--effort`
but has no quota awareness, and `workstreams-status.mjs` already computes idle-tmux,
stale-running, parked-marker, and per-lane state. The B1/B2 leverage claim and the
anti-over-engineering verdict are high-confidence. Lower-confidence: the exact staleness
thresholds (B5) and whether the four-tier Claude set is worth formalizing vs. just two
tiers (worker + worker-low) — those should be tuned in use, not designed up front.
