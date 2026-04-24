# Active Change Inventory — 2026-04-24

Owner-decision report. One row per active change. Recommendation is advisory — no archives or material rewrites are performed in this report.

## Summary table

| Change | Status | Recommendation | Next owner action |
| --- | --- | --- | --- |
| `swap-sqlite-driver` | 9/39 — dep swap shipped, query extraction + crash re-verify open | **Split**: keep dep+crash verification here; move query-tree extraction to a new inspectability change | Decide whether query-extraction is still worth the investment given `better-sqlite3` already resolves the crash |
| `reference-implementation-program` | 26/27 — one deferred follow-up remains | **Archive** after migrating three design-notes links; the program has landed | Decide how to preserve `design-notes/` links (keep in place vs. migrate to root `design-notes/`) |
| `add-polyfill-connector-system` | 45/81 — mixed shipped / backlog / open-questions / fixture pipeline | **Split**: keep the running MVP scope here; promote Layer 2 coverage, partial-run honesty trio, and fixture pipeline into their own follow-up changes | Decide which clusters promote now vs. defer, and whether Layer 2 is one change or one-per-connector |
| `define-reference-surface-topology` | 0/22 — freshly proposed | **Keep**, but narrow scope 1 tranche at a time before a worker starts | Decide whether topology rollout is a single change or a phased program |
| `make-semantic-retrieval-operational` | 0/30 — freshly proposed, blocked on local-embedding decisions | **Keep**, but sequence after diagnostics baseline | Decide the default profile (English vs. multilingual) and whether `/dashboard/deployment` ships in this change or a follow-up |
| `clean-up-openspec-corpus` | 0/28 — this change | **Keep** | Execute sections 5–7 once sections 1–4 reports are reviewed |

## `swap-sqlite-driver`

- **Scope on paper**: remove `@databases/sqlite`, adopt `better-sqlite3`, extract ~190 static SQL call sites into `server/queries/**/*.sql` across runtime + tests, rerun crash repro.
- **Actual shipped state** (per the `Status note` the change's `tasks.md` opens with):
  - **Done**: dep swap (1.1–1.5), `db.js` import rewrite (3.1), the two polyfill-connectors consumers (6.1–6.3).
  - **Not done**: query-tree extraction (sections 2, 3.2–3.4, 4.x, 5.x), crash re-verification (7.x), capability-spec confirmation (8.x), cleanup of repro harnesses + `[diag]` prints (9.x).
- **Two distinct motivations bundled together**:
  - *Crash fix*. This is the forcing function that justified the change. The dep swap alone closes that; the remaining crash-regression task (7.3) is what proves it.
  - *Inspectability*. Extracting static SQL into `.sql` files so reviewers can see the query surface without grepping JS. This is a separable "reference-quality" improvement, not a pre-condition for the crash fix.
- **Risk of leaving both coupled**: the change has been sitting at 9/39 for ~1h (but materially for longer — dep swap is dated in the status note). The crash-fix half is done and merged; the query-extraction half is a bigger rewrite than the crash fix. Keeping them fused makes the change read as "still in progress" when the high-risk native-stability work is actually already live.
- **Follow-ups block (10.x)** already acknowledges at least three deferrable items: `/dashboard/reference/queries` surface, static SQL-vs-schema analyzer, polyfill-connectors runtime DB migration.
- **Recommendation**: **split**.
  1. Narrow `swap-sqlite-driver` to "Driver swap + crash re-verification": keep sections 1 (done), 3.1 (done), 6.x (done), 7.x (re-verify current repro against the new driver), 8.x (confirm capability spec), the trimmed cleanup subset of 9.x.
  2. Move sections 2, 3.2–3.4, 4.x, 5.x, 9.1, 10.1–10.2 into a new change proposed as `make-reference-queries-inspectable` (or similar). That change's "Why" is inspectability, not stability.
  3. If owner decides query-extraction is no longer worth the churn, **retire** it into `deferred/` design-notes with an explicit "not pursued unless a reviewer asks" framing instead of carrying it as open work.
- **Exact blockers to closing the narrowed `swap-sqlite-driver` in this cleanup pass**:
  - Re-run the crash repro (task 7.3) against `better-sqlite3`. Should be cheap; may already effectively be done but is not marked.
  - Decide whether crash-reproducer scripts stay under `reference-implementation/` or move to `scripts/` with a README (task 9.1).
  - Remove the `[diag] exit code=…` prints (task 9.2).
  - Decide the `--watch` question in 9.3.

## `reference-implementation-program`

- **Scope on paper**: canonical OpenSpec program artifact for the reference-implementation program. Track `done` / `in progress` / `next` / `deferred`.
- **Actual shipped state**: 26/27 boxes checked. The only unchecked line is:
  > *Deferred follow-up: broad storage abstraction beyond the current explicit seams. Captured in `design-notes/broad-storage-abstraction-2026-04-24.md`; promote only when a concrete second backend or deployment target exists.*
  That is a deliberately-deferred follow-up, not active work. The corresponding design-note is already in the root `design-notes/` directory with a `decided-defer` status.
- **Exact blockers to archival**:
  1. The one unchecked box is a `decided-defer` pointer, not real open work. It can be moved into an explicit `Deferred` section (already is) and safely ship as a closed program.
  2. The change's `design-notes/` directory contains 43 files — most of which are historical research for phases that shipped (dashboard hero prior-art dossier, control-plane implementation plan, record-query contract audit). A subset is referenced elsewhere:
     - `design-notes/dashboard-hero-plan-2026-04-22.md` is referenced by the RIP program itself.
     - `design-notes/control-plane-discovery-brief.md`, `control-plane-implementation-plan.md`, `control-plane-v1-follow-up.md` are all cited directly in `reference-implementation-program/design.md`.
     - `design-notes/owner-auth-placeholder-open-question-2026-04-22.md`, `single-origin-reference-composition-plan-2026-04-22.md`, and `reference-local-third-party-connect-defaults-2026-04-22.md` are cited from `design.md` as evidence for landed decisions.
     Archiving RIP without migrating those links breaks six named references from `design.md` plus the hero-plan reference from the deferred-control-plane checklist.
  3. Capability delta in `specs/reference-implementation-governance` + `reference-implementation-architecture` needs to fold into canonical specs on archive. This is the standard OpenSpec archive step — no custom blocker.
- **Recommendation**: **Archive in this cleanup change** (`clean-up-openspec-corpus` §5.4), with three explicit pre-archive steps handled in §5.3:
  - Move the small subset of notes still referenced from `design.md` (owner-auth placeholder, single-origin composition, reference-local third-party defaults, control-plane brief + plan + follow-up, dashboard-hero plan) into `design-notes/` at the root if they are cross-cutting, or rewrite the `design.md` references to inline the decision they captured (several are already settled — the note is historical justification, not active intake).
  - Drop references in `design.md` to the one `decided-defer` note by either pointing at the already-relocated root `design-notes/broad-storage-abstraction-2026-04-24.md` or rewriting the line to acknowledge the note is now at the root.
  - Leave historical research notes (dashboard-hero prior-art dossier, capability-discovery audit, control-plane UI/run audits, record-query contract dossier) inside the archived change's directory so `openspec archive` preserves them as program-historical artifacts.

## `add-polyfill-connector-system`

Largest, oldest, and most mixed of the active changes. The change is doing too many things at once and has grown 50 design-notes while doing them.

- **Scope as originally proposed (2026-04-19 → 21)**: MVP polyfill connectors for YNAB / Gmail / ChatGPT / USAA / Amazon, scheduler extension, inbox, ntfy notifications, browser profile.
- **Scope since then**: +21 connectors, Chase v0.1, fleet-wide JSONL fixes, browser daemon, fixture pipeline plan, Layer 2 coverage gap audits, connector-configuration + credential-storage + storage-topology open questions, partial-run honesty trio, post-refactor review follow-up, scrubber pipeline. The scope has roughly quadrupled.

### Task clusters, classified

Rows are shipped / stale / backlog / open-question / ready-to-split.

| Cluster | Representative tasks | State | Classification |
| --- | --- | --- | --- |
| Status table (31 manifests, 951k records) | lines 6–23 | Shipped | **Shipped** — freeze as record, not as running task list |
| Infrastructure delivered | lines 63–72 | Shipped | **Shipped** |
| Infrastructure pending — scheduler persistence, inbox module, pause/resume INTERACTION, nightly ntfy summary, partial-run honesty mechanism | lines 77–83 | Active, still real work | **Backlog — keep here** |
| Spec-conformance upgrade | lines 85–97 | Shipped | **Shipped** |
| Claude Code + Codex connectors (done + in-progress ingest) | lines 99–107 | Mostly shipped, last two rows `[~]` | **Shipped or near-shipped** |
| OpenSpec hygiene (design.md, per-connector notes) | lines 109–121 | Mostly shipped; last two rows are doc-level | **Shipped** |
| Post-refactor quality follow-up tranches A–D | lines 123–161 | Tranches A–C shipped; Tranche D (subprocess-level protocol harness) open | **Split-ready — could be own change** |
| Deferred / open (tombstones, USAA transfers, selector-wiring, 7 open-questions) | lines 163–177 | Deferred and research-only | **Open-question or defer — promote a few, keep the rest as notes** |
| Layer 2 implementation follow-up (ChatGPT/Claude Code/Codex/GitHub/YNAB/USAA/Gmail/Slack stream additions + Gmail attachment blob hydration) | lines 179–220 | Real coded work, distinct per-connector shape | **Split-ready — single Layer 2 follow-up change, or per-connector** |
| Fixture pipeline (LLM scrubber + per-connector scrub-rules) | lines 221–224 | Blocking parser test coverage | **Split-ready — own change** |
| Review checklist for the owner `[?]` | lines 226–232 | Owner-only decision items | **Historical — once decisions land, convert to settled notes** |

### What looks stale

- The two `[~]` ingest rows for Claude Code and Codex (lines 105–106) have been in that state long enough that they should either be closed (ingest ran, deliver the record count) or retired as "ongoing background ingest" with no task state.
- The "OpenSpec hygiene" section (lines 109–121) has internal contradictions: `[x] design.md written` plus `[ ] Move OpenAI/Anthropic token data from scaffolded to implemented once selectors wired` — the latter is a real backlog item in the wrong section. Move it to Layer 2 or selector-wiring.
- The "Spec-conformance upgrade" tombstones row deliberately says "ChatGPT has no deletion signal; USAA statements are append-only; ChatGPT memories mutate — follow-up pass." That follow-up lives in "Deferred / open" but the framing in 2026-04-19 is now old enough to be its own decision item.

### Recommendations

1. **Keep `add-polyfill-connector-system` alive**, but treat it as "the running MVP fleet + its infrastructure." Trim it to:
   - The status table (frozen, no task-state).
   - Infrastructure pending (scheduler persistence, inbox, pause/resume INTERACTION, nightly ntfy summary, partial-run honesty mechanism).
   - Deferred / open **with their open-questions explicitly pulled out** into a notes-only section — because tasks like `[ ] Connector configuration surface` are requirements-discovery, not implementation work.
2. **Split off `add-layer-2-stream-coverage`** (or similar). Candidate tasks are the ~20 bullets under "Layer 2 implementation follow-up". Decision needed: one change that covers all seven connectors, or one per connector? Recommend one change so stream-shape and Gmail-style deferred-hydration patterns stay coherent.
3. **Split off `add-connector-fixture-scrubber-pipeline`** for the LLM scrubber + per-connector scrub-rules (lines 221–224). This is blocking committed golden fixtures and is orthogonal to the running MVP.
4. **Split off (optional) `prove-polyfill-protocol-harness`** for Tranche D (subprocess-level protocol harness). Owner-approved with a Phase-1 success gate; keeping it in APCS makes APCS look perpetually half-done.
5. **Promote high-value open questions to changes, not the others**:
   - Promote: `partial-run-semantics` + `cursor-finality-and-gap-awareness` + `gap-recovery-execution` — the linked trio the change explicitly says "must be decided together." That is protocol-shape work.
   - Defer as `decided-defer` notes: account risk from repeated automation, platform archive requests, identity graph, settings stream convention, raw-provenance capture, browser-automation tools, agent-generated custom connectors, connector-configuration surface — these are exploratory until a second forcing function.
   - Reclassify as connector-background: per-connector notes (amazon, chase, chatgpt, gmail, usaa, ynab, slack*, claude-code-codex) — they are connector docs, not open questions.

## `define-reference-surface-topology`

- **State**: freshly proposed. 0/22 tasks, validated, no worker-prompts yet. `proposal.md` articulates the problem well (website blurs protocol vs. reference vs. live dashboard vs. sandbox vs. planning).
- **Risks of leaving the change as-is**:
  - Task §1 (inventory + classify) is a research phase that belongs inside an early tranche, not inside a single atomic change. If a worker picks this up and just inventories, the change won't appear to move.
  - Task §5 (Sandbox placeholder) is a different surface (`/sandbox` as mock-backed pedagogy) from everything else — separable.
  - Tasks §2.3 and §2.4 mix live-dashboard policy with hosted OpenSpec-viewer policy. Those are distinct permission/indexing stories.
- **Recommendation**: **keep**, but before a worker begins, ask owner whether this should be:
  1. One change delivering the inventory + the minimal `/reference` explainer + the `/dashboard` repositioning, with the coverage matrix and `/sandbox` as follow-ups.
  2. Or a program (like `reference-implementation-program` was) whose follow-ups are phased.
  No task rewrite attempted in this cleanup pass; flagged for owner.

## `make-semantic-retrieval-operational`

- **State**: freshly proposed. 0/30 tasks, validated.
- **Scope**: operational diagnostics, first-party semantic coverage, local embedding backend, multilingual profile, backfill/reconcile, dashboard integration.
- **Dependency shape**: §2 diagnostics is the prerequisite for every other section — without it, zero-participation and backend unavailability can't be distinguished. §5 multilingual profile decision (English vs. multilingual as default, 5.3) is load-bearing because it changes install size and first-run behavior.
- **Recommendation**: **keep**. Sequence so §1 baseline + §2 diagnostics land as Tranche 1, §3 + §4 as Tranche 2, §5 + §6 as Tranche 3, §7 + §8 as Tranche 4. No decomposition needed yet — the change is scoped tightly for one feature.
- **Flag for owner**: §5.3 "decide whether default operational profile should be multilingual or English-biased" — this decision likely should precede starting §4.1 rather than happening inside §5. Worth moving up.

## `clean-up-openspec-corpus`

- **State**: this change. 0/28 tasks. Reports from §§1–4 land in `reports/`; §§5–7 are execution.
- **Recommendation**: **keep**. After §§1–4 reports are reviewed by owner, execute §5 splits + §6 swap-sqlite-driver closeout + §7 final validation.

## Owner decision queue, in priority order

The decisions below are written so owner can answer each one without re-reading every change.

1. **Archive `reference-implementation-program`?** — Recommend yes. Requires handling the six `design.md` → `design-notes/` references listed above. Proposed in `clean-up-openspec-corpus` §5.4.
2. **Split `swap-sqlite-driver`?** — Recommend yes: dep/crash change vs. query-inspectability change. Or retire the inspectability half. Proposed in `clean-up-openspec-corpus` §§6.1–6.3.
3. **Split `add-polyfill-connector-system` into up to four children?** — Layer 2 coverage, fixture/scrubber pipeline, protocol harness (Tranche D), partial-run honesty trio. Proposed in `clean-up-openspec-corpus` §§5.1–5.2. Each split needs owner sign-off on whether to create the stub now or defer.
4. **Promote or defer each APCS open-question note?** — See design-note triage report. 15 open-question notes need a verdict; three are recommended for promotion together (partial-run / cursor-finality / gap-recovery trio).
5. **`define-reference-surface-topology` — one change or a program?** — Owner decision. No triage action until decided.
6. **`make-semantic-retrieval-operational` — default profile English or multilingual?** — Owner decision drives §5 ordering. No triage action until decided.
