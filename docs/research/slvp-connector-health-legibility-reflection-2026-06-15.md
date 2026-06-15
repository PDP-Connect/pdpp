# Connector-State Legibility & the Self-Healing Loop — a foundational reflection

**Date:** 2026-06-15
**Author:** ink-carbon-polish lane (RI worker)
**Status:** foundational reflection — diagnosis + target model + prioritized plan. NOT an implementation.
**Scope:** the two halves of the owner's framing, taken verbatim:
  1. *Clearly seeing each connector's state is very bad, and there seem to be bugs.*
  2. *It is ALSO about the system getting BACK to the right state — does the user need to update a credential? backfill? then it should just work.*

**Hard constraint honored:** we do **not** start from scratch. `connection-health.ts` is **2679 lines** of a genuinely good projection. The thesis of this document is that the model is largely *right* and the **render and recovery seams** are where it fails. The fix is mostly *deletion of divergence*, not new machinery.

**Prior art already on disk (do not re-research, build on it):**
- `docs/research/sources-slvp-redesign-and-data-health-2026-06-11.md` — Plaid update-mode shape, "single-voice synthesis layer", Stripe-register density, the two-axis rule.
- `docs/research/pdpp-status-map.md` — the status vocabulary map.
- `docs/research/acquisition-coverage-profile-slvp-evaluation-2026-06-13.md` — coverage-profile evaluation.

---

## 0. The one-paragraph version

We built a 7-state health *machine* with orthogonal coverage/freshness/attention/outbox *axes* — and that model is honest. The header of `connection-health.ts` (lines 19–22) makes the load-bearing decision explicit: **`stale` is not a headline state; it is an orthogonal axis/badge, so the green pill can stay green while a separate badge carries the freshness truth.** The honesty of the model *lives in the pairing of state WITH its axes*. Every render seam then honors the first half of that contract and silently drops the second: the live Sources list maps `health.state` → dot and never reads `badges.stale`; the detail headline returns "Required coverage is current and complete." for a month-stale connection because `case "healthy"` never consults `axes.freshness`; per-stream chips are each formatted by an independent pure function with no cross-chip invariant, so "3/2 collected" and "coverage·unknown · resumes collection" print verbatim. **The model split state from its axes to be honest; the view split them again and became dishonest.** Meanwhile the recovery story was never modeled at all: `next_action` is a CTA string, not a typed required-action with a satisfaction condition, so the system can name a problem but cannot prove it is solved, and "resumes collection" promises a self-heal the QFX/selector failures cannot deliver.

---

## 1. The four real connections, as ground truth

These are not hypotheticals; they are the live state on `pdpp.vivid.fish` at audit time, and each one breaks a *different* seam.

| Connection | True state | What the owner sees | The lie |
|---|---|---|---|
| **Amazon – Personal** (2,868 recs) | **stale** — 10 scheduler runs ended 2026‑05‑15, then scheduling *stopped* (no `connector_schedules` row, no credential). A later ad‑hoc run produced June records, so the projection anchors freshness on that newer run. | Green **"Healthy"** pill + dot. `order_items` chip: **"Coverage·complete · 3/2 collected"**. `orders` chip: "Coverage·unknown · resumes collection". | Green/fresh headline but **nothing refreshes** — there is no schedule. The stale month is hidden because freshness rides a one‑off run. **3 collected > 2 considered** is arithmetically impossible and prints anyway. |
| **Chase – Personal** (1,169 recs) | **broken** — 0 schedule, 0 credential, `transactions` frozen since 2026‑04‑22 on `qfx_download_failed` (retryable_gap, 1 pending gap), `current_activity` is a **terminal_gap** needing a connector *code* fix (stale selectors). | Amber **"degraded"** pill. `transactions`: "retryable · resumes collection · 1 pending gap". `current_activity`: "won't backfill · skipped·selectors pending". | The amber headline is *roughly* honest, but the UI buries that the **core stream has been stuck for ~2 months** and that one stream is **permanently broken pending code I cannot self‑heal**. "resumes collection" implies the next run fixes it; the next run will fail identically. |
| **ChatGPT** (126,653 recs) | **collecting‑fresh** — scheduled 3600s, 44 succeeded runs, latest today, clean backoff. Every run reports `records_emitted=0` because ChatGPT collects via deferred detail‑gap materialization (2,532 gaps). | (Per the audit, the headline reads as fresh/working — correctly — but `records_emitted=0` is a footgun: the surface that reads "records this run" shows **0** for a healthy, productive connection.) | The success metric the eye reaches for (records emitted) is **structurally zero** for this connector's collection model, so a working connection looks idle on any naive per‑run readout. |
| **(general)** | | | |

The pattern across the table: **the model knows the truth in every case** (Amazon's `axes.freshness` is `stale`; Chase's `current_activity` is a `terminal_gap`; ChatGPT's productivity lives in detail‑gap drain, not `records_emitted`). The truth is **lost between the snapshot and the pixels**, and the recovery instruction is **either absent, wrong, or unprovable**.

---

## 2. How it got here — the architectural drift

**A rich projection was built first, well, and in the right place.** `connection-health.ts` computes a `ConnectionHealthSnapshot` (the public type at lines 712–781) that carries a 7‑state headline (`unknown | idle | needs_attention | blocked | cooling_off | degraded | healthy`), four orthogonal `axes`, `badges` (stale/syncing), a fused `forward_disposition`, a `dominant_condition_id`, a `conditions[]` array, and a `next_action`. The header's precedence ladder (lines 24–36) and its explicit decision to model `stale`/`syncing` as **axes, not pills** is exactly the design a mature product converges on — it is what stops you inventing a new pill every time you add an evidence source. `ref-control.ts` forwards the *whole* snapshot to the console verbatim (`connection_health: ConnectionHealthSnapshot`), and `RefConnectionHealthSnapshot` in `ref-client.ts` re‑types `axes.freshness`, `badges.stale`, and `forward_disposition` faithfully. **The API loses nothing.** The drift is entirely on the *consumer* side of a lossless wire.

**Then the surfaces grew independently, each re‑picking fields.** The console did not grow *one* function that takes a snapshot and returns *one* reconciled verdict. It grew **N formatters**, each authored at a different time for a different surface, each reading the *one or two* fields its author had in mind:
- `sources-view-model.ts:deriveSourceStatus` reads **only** `health?.state` (`HEALTHY_STATES = new Set(["healthy","idle"])`, line 134). Its own doc comment (lines 46–53) enshrines "state is the whole contract" — it literally documents the bug as the design. This is the **live** list (`records/page.tsx` renders `SourcesView` via `toSourcesView`), so Amazon shows a bare green dot with the only freshness trace being a raw "last run" KV string.
- `connection-evidence.ts:deriveConnectionStatusDisplay` (lines 982–999): `case "healthy"` returns `"Required coverage is current and complete."` **without consulting `axes.freshness` or `badges.stale`**. The same file's `synthesizeConnectionVerdict` (~line 1183) repeats the claim. The function *named* "synthesize" is the one that **un‑synthesizes** — it asserts "current and complete" over month‑stale data. (Notably, the *next‑step guidance* path in the same file DOES read `health.axes.freshness === "stale"` at line 1415 and has a `staleFreshnessGuidance` helper — so the freshness fact is reachable; the **headline branch just doesn't reach for it**.)
- `collection-report.ts:buildCountsLine` (lines 93–123) has an honesty gate for an *unknown* denominator (lines 110–122 — never fabricate a fraction) but **no consistency gate for the known case**: line 106 prints `${collectedText} / ${considered} collected` with no `collected <= considered` invariant, so Amazon's `3 / 2` prints verbatim.
- The per‑stream chips render `formatCoverageAxis` and `formatForwardDisposition` as **adjacent independent chips** with no reconciliation, so "Coverage·unknown" can sit next to "resumes collection" — two facts that, together, are internally contradictory (we have no coverage evidence, yet we assert a run will resume collecting it).

**Why the drift was invisible.** Each formatter is *individually* defensible and *individually* tested. `collection-report.test.ts` proves the unknown‑denominator gate works; `sources-view-model` is honest about *its* contract. There is no test, and no type, that asserts **the composite is consistent** — that the pill, the badge, and the chips agree, and that no chip prints an impossible tuple. Because the orthogonal‑axis design made it *safe* to separate `state` from `stale` in the **data**, separating them again in the **view** re‑introduced exactly the dishonesty the model was built to prevent — and did so one field, one surface, one PR at a time, each change passing its own gate.

**The recovery half never had a model at all.** `next_action` is a non‑secret CTA (a label + a route). It is not a typed *required action* with: (a) a machine‑checkable **satisfaction condition** ("credential present and non‑rejected"), (b) a **terminal‑vs‑recoverable** flag, or (c) an **auto‑resume** contract that re‑attaches a schedule and re‑runs when the action is satisfied. So `forward_disposition: "resumes collection"` is emitted for *both* Chase's recoverable QFX gap *and* its terminal selector gap, because nothing forces a forward disposition to be *false* when the only path forward is human or code intervention the runtime can't perform. The model can *name* a problem; it cannot *prove the cure* or *drive itself back to green*.

---

## 3. The core problems (root‑caused, not symptoms)

> Ordered by severity. Each is a *class*, with the live instance that proves it.

### P3‑critical · Selective‑projection drop: the headline is rendered from `state` alone
**Root cause:** every render seam reads `health.state` and discards the co‑required `badges.stale` / `axes.freshness` that the projection *deliberately split out so the pill could stay green*. The contract is "render state **and** its orthogonal axes together"; the view honors the first half. `sources-view-model.ts:134` drops them entirely; `connection-evidence.ts:991` drops freshness from the `healthy` headline. **There is no single render‑time owner of "what is the ONE thing this connection's health says right now."**
**Proof:** Amazon — `state:healthy`, `axes.freshness:stale`, renders bare green "Healthy / current and complete."

### P3‑critical · No required‑action model → the recovery loop cannot be expressed or proven
**Root cause:** `next_action` is a CTA, not a typed required‑action with a satisfaction condition, a terminal flag, and an auto‑resume contract. The system can say "do X" but cannot detect that X is done, cannot distinguish "X will fix it" from "only a code change fixes it", and cannot re‑attach‑schedule‑and‑rerun on its own.
**Proof:** Chase — identical "resumes collection" disposition on a recoverable QFX gap and a terminal selector gap; Amazon — no schedule means *nothing* will ever resume, yet the disposition implies it will.

### P2‑high · No composite invariant gate → impossible tuples reach the screen
**Root cause:** each axis/count is formatted by an independent pure function; nothing checks the *composite* before paint. There is no `collected <= considered` invariant, no "coverage‑unknown may not co‑render with resumes‑collection without a caveat", no "green pill may not render without its mandatory freshness annotation."
**Proof:** Amazon — "3/2 collected"; "Coverage·unknown · resumes collection."

### P2‑high · Impossible *configurations* are allowed to exist (creation has no invariants)
**Root cause (the deepest one):** Amazon and Chase are in states the data model *should not permit*: **records exist + connection is "active" + there is no `connector_schedules` row and no credential.** A connection that has collected data but has no schedule and no credential is a structurally broken configuration — it can only ever go stale, and no run is even scheduled to discover that. Nothing at **creation/lifecycle time** enforces "an active account connection MUST have a schedule and a credential (or be explicitly marked manual/push)." The health projection then has to *paper over* an impossible input, and the cleanest thing it can say — "succeeded, no gaps" off the last ad‑hoc run — is the most misleading thing.
**Proof:** Amazon (no schedule, no credential, healthy headline); Chase (no schedule, no credential, degraded headline).

### P1‑medium · `records_emitted` is a structurally‑wrong success signal for deferred‑collection connectors
**Root cause:** the per‑run readout privileges `records_emitted`, but ChatGPT (and any detail‑gap‑materialization connector) emits 0 there by design and produces records via gap drain. The "did it work?" eye lands on a 0.
**Proof:** ChatGPT — 44 succeeded runs, 126k records, every run `records_emitted=0`.

---

## 4. Design goals that were NEVER formed or prioritized

The projection‑side goal *was* formed and executed: **"model state and axes as orthogonal, honest data."** Its render‑side and recovery‑side duals were never written down, so nobody owned them:

1. **One synthesized per‑connector verdict the UI MUST render verbatim.** There should be exactly one function — owned by the projection (server) side, not re‑implemented per surface — that takes a `ConnectionHealthSnapshot` and returns a single `RenderedVerdict { pill, mandatory_annotations[], reconciled_forward_statement, required_action? }`. Every surface renders *that object*, never `health.state` directly. (Prior art on disk already names this the **"single‑voice synthesis layer"** — `sources-slvp-redesign-and-data-health-2026-06-11.md:120`.) The goal that was missing: *the headline pill may never be shown without its co‑required freshness/disposition annotation.*

2. **A render‑time consistency invariant, enforced as a gate.** "A rendered verdict is a composite of `{state, freshness, forward_disposition, per‑stream counts}` that must be internally consistent." Concretely: `collected <= considered`; coverage‑unknown cannot co‑render with resumes‑collection un‑caveated; a green pill must carry its freshness annotation. This is a *typed invariant + a test that paints the composite and asserts it*, not N independently‑tested formatters.

3. **Every unhealthy state names its required action, and the required action has a satisfaction condition.** A `degraded`/`needs_attention`/`stale` verdict is incomplete unless it carries a typed `RequiredAction { kind: reauth | backfill | reattach_schedule | code_fix | owner_run, satisfied_when: <condition>, terminal: bool }`. "Does the user need to update a credential? backfill?" must be a *field*, not buried prose. Terminal actions (Chase selectors) must say **"this needs a code fix — your action won't help"** instead of "resumes collection."

4. **Repair self‑heals and auto‑resumes.** When a `RequiredAction` becomes satisfied (credential updated, schedule re‑attached), the system MUST automatically re‑attach the schedule and trigger a confirming run, then transition the verdict — *"then it should just work"* (the owner's words). This is the Plaid update‑mode contract: reconnect → confirming pull → green, with **no separate "now go run it" step.** Today nothing closes that loop.

5. **Creation/lifecycle enforces state invariants so impossible configs cannot exist.** An account connection that has retained records MUST have a schedule and a credential, or be explicitly typed manual/push. The invariant belongs at the write boundary (connection create / schedule detach), so the health projection never has to render a structurally impossible input. *The cheapest way to make Amazon legible is to make Amazon's state un‑constructable.*

6. **A collection‑model‑aware productivity signal.** "Did this connection make progress?" must be computed from the connector's *actual* collection model (records committed, gaps drained) — not `records_emitted`, which is zero by design for deferred‑collection connectors.

---

## 5. The SLVP‑target model (grounded in Plaid / Stripe)

The target is the shape Plaid, Stripe, Linear, and Vercel converged on, and which our *model* already half‑embodies. **The data is mostly there; we are adding a synthesis layer, a required‑action type, a recovery loop, and creation invariants — not a new state machine.**

**(a) One honest per‑connector state, synthesized once, rendered verbatim.**
Plaid collapses an Item to a single human verdict (`HEALTHY` / `ITEM_LOGIN_REQUIRED` / `PENDING_EXPIRATION`) plus an error envelope; Stripe shows one account/connection status with a required‑action banner. We mirror this with a single server‑owned `synthesizeRenderedVerdict(snapshot) → RenderedVerdict`. The pill is `state`; **but the pill always ships with its mandatory freshness/disposition annotations** — green + "stale 31 days · nothing scheduled" is one verdict, not a green pill and a hidden badge. No surface reads `health.state` directly ever again.

**(b) Every unhealthy verdict names a typed required action with a satisfaction condition.**
Like Stripe's `requirements.currently_due` and Plaid's update‑mode token: the verdict carries `RequiredAction { kind, satisfied_when, terminal }`. Chase's `current_activity` → `kind: code_fix, terminal: true` ("we must update the connector; your action won't help"). Amazon → `kind: reattach_schedule` + `kind: reauth`. Recoverable QFX → `kind: owner_run`/auto‑retry. **`forward_disposition` may not say "resumes collection" when the required action is terminal or owner‑blocked** — it must reconcile against the required action.

**(c) A self‑healing repair loop: satisfy → auto‑reattach → confirming run → green.**
This is the Plaid update‑mode UX: the owner clicks **Reconnect**, lands on the *existing* connection (not a fresh setup), updates the credential, and the system **automatically** re‑attaches the schedule, fires a confirming run, drains the recoverable gaps, and flips the verdict — *"then it should just work."* Backfill is the same loop: satisfying a `backfill` action enqueues the backfill and the verdict tracks it to completion. The loop is driven by the `satisfied_when` condition on each required action; no human "now run it" step.

**(d) Enforced invariants at both creation and render.**
Creation‑time: an active account connection cannot exist without a schedule + credential (or an explicit manual/push type) — Amazon's and Chase's configs become un‑constructable. Render‑time: a composite‑consistency check (`collected <= considered`, freshness‑annotation‑required, disposition‑reconciliation) runs before paint and is covered by a test that *renders the whole verdict and asserts it*, so impossible tuples can never ship again.

---

## 6. Prioritized plan — building on what EXISTS

Ordered so each step is shippable, test‑gated, and *reduces* divergence rather than adding a parallel system. Sizes are relative effort.

| # | Step | Why | Surface | Size |
|---|---|---|---|---|
| 1 | **Add a `collected <= considered` invariant + caveat reconciliation to `buildCountsLine` and the chip composer; pin with a test that renders the composite.** Make "3/2 collected" un‑renderable and "coverage‑unknown + resumes‑collection" force a caveat. | Kills the most visibly absurd, most cheaply fixable lie; establishes the *first* composite‑invariant test as the pattern. | `apps/console/src/app/dashboard/lib/collection-report.ts` (+ test) | small |
| 2 | **Make the `healthy` headline freshness‑aware.** In `deriveConnectionStatusDisplay`/`synthesizeConnectionVerdict`, when `state==="healthy"` and `axes.freshness==="stale"` (or `badges.stale`), return a stale‑annotated verdict reusing the already‑existing `staleFreshnessGuidance` (line 1311). | The detail headline stops asserting "current and complete" over month‑stale data; reuses code already in the file. | `apps/console/src/app/dashboard/lib/connection-evidence.ts` | small |
| 3 | **Teach the live Sources list to read `badges.stale` / `axes.freshness`.** `deriveSourceStatus` keeps `state` for the dot color but must append a mandatory freshness annotation; update its doc comment (it currently documents the bug). | This is the **live** list — the first surface owners see; it currently shows a bare green dot for Amazon. | `apps/console/src/app/dashboard/records/sources-view-model.ts` | small |
| 4 | **Extract one server‑owned `synthesizeRenderedVerdict(snapshot) → RenderedVerdict`** and route every surface (list, detail, passport) through it. Forbid raw `health.state` reads in the console with a lint/grep gate. | Establishes the *single owner* of the verdict so steps 1–3 can never silently re‑diverge; this is the "single‑voice synthesis layer" the prior‑art doc already named. | new `reference-implementation/runtime/rendered-verdict.ts` (synthesis lives server‑side, forwarded like the snapshot) + console consumers | medium |
| 5 | **Promote `next_action` to a typed `RequiredAction { kind, satisfied_when, terminal }`** in `ConnectionHealthSnapshot`; reconcile `forward_disposition` against it so terminal/owner‑blocked actions can't claim "resumes collection." Chase `current_activity` becomes `terminal: code_fix`. | Makes "does the user need to update a credential / backfill?" a *field*, and stops the false self‑heal promise. | `connection-health.ts`, `ref-control.ts`, `ref-client.ts` | medium |
| 6 | **Add creation/lifecycle invariants:** an active account connection MUST have a schedule + credential (or explicit manual/push type). Backfill a migration that flags existing Amazon/Chase‑shaped rows for repair. | Makes the impossible configs un‑constructable; the cheapest legibility fix is to delete the illegible state. | connection create + schedule‑detach write paths | medium |
| 7 | **Build the self‑healing repair loop:** when a `RequiredAction.satisfied_when` flips true (credential updated / schedule re‑attached / backfill done), auto‑reattach schedule + fire a confirming run + drain recoverable gaps + transition the verdict. Plaid update‑mode "Reconnect lands on the existing connection" path. | This is the *second half* of the owner's ask — "then it should just work." Without it, every fix still needs a manual "now go run it." | scheduler + connection controller + console Reconnect flow | large |
| 8 | **Replace `records_emitted` as the productivity signal** with a collection‑model‑aware "progress this run" (records committed + gaps drained), so deferred‑collection connectors (ChatGPT) don't read as idle. | Removes the last "working connection looks dead" footgun. | run‑summary projection + console run readout | small |

**Sequencing rationale:** 1–3 are independently shippable honesty fixes that stop active lies *today* and seed the invariant‑test pattern. 4 consolidates them so they can't re‑diverge. 5–7 are the recovery arc (name the action → enforce valid configs → close the self‑heal loop), each gated on the prior. 8 is orthogonal and can land any time. **Nothing here rewrites the 2679‑line projection** — every step either reads fields the snapshot already carries, adds one typed field, or moves a divergent re‑derivation behind a single synthesizer.

---

## 7. What I verified vs. what I'm asserting

**Verified by reading source at HEAD `f267876e`:**
- `connection-health.ts` header lines 19–22 (stale‑is‑an‑axis decision) and the `ConnectionHealthSnapshot` type (lines 712–781): `axes`, `badges`, `forward_disposition`, `next_action`, `conditions`, `dominant_condition_id` all present.
- `sources-view-model.ts:deriveSourceStatus` (lines 134–167) reads only `health?.state`; doc comment 46–53 documents that as the contract.
- `connection-evidence.ts:deriveConnectionStatusDisplay` line 999 returns "Required coverage is current and complete." for `healthy` with no freshness check; line 1415 *does* read `axes.freshness === "stale"` in the next‑step path (so the fact is reachable but unused by the headline).
- `collection-report.ts:buildCountsLine` lines 93–123: honesty gate for unknown denominators, **no** `collected <= considered` invariant for the known case (line 106).

**Asserted from the audit (not independently re‑run against the live DB):** the four connections' live states (schedules/credentials/run history), the exact rendered chip strings, and ChatGPT's `records_emitted=0`. These are the phase‑1/phase‑2 audit findings; they are consistent with the source seams above, which is why I trust them, but the live‑DB facts themselves are the audit's, not mine.

---

*This document is the corpus artifact for the connector‑health‑legibility reflection. It supersedes nothing; it names the never‑formed render‑side and recovery‑side design goals so they can finally be owned.*
