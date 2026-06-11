# Sources SLVP Redesign + Live Data-Health — Definitive One-Pass Plan

Date: 2026-06-11
Author: lead designer + architect (RI)
Audience: implementer lanes + the owner (the cleanup section is owner-runnable)

## Why this document exists

The owner is weary of repeated nudging. The goal here is to get this RIGHT in **one
pass**: the Sources page reaches SLVP tier as actual implementation, and the owner's
live data reaches clean health with **minimal owner effort on return** — ideally the
owner runs ~nothing and the rest is RI-owner-autonomous-with-care.

This plan honors design decisions already made (Frame 3 prior art; the
`owner-journey-slvp-realignment-plan-2026-06-10.md` ruling) and does not relitigate
them:

- **Dense Stripe-register** console list (not airy cards) [Frame 3 P12].
- **One `StatusBadge`** per row, bound to status tokens — the existing primitive in
  `packages/operator-ui/src/components/primitives.tsx:271`, keyed by
  `CONNECTION_HEALTH_VOCABULARY` in
  `packages/operator-ui/src/components/status-vocabularies.ts:87` via `data-status-tone`
  [Frame 3 P1, P11].
- **Danger-row-tint** reserved for genuinely actionable danger only [Frame 3 P4].
- **Authorship / disposition tokens** in secondary text, not amber warning tone
  [Frame 3 P8].
- The **"Packaged path pending" label set** — NEVER demotion copy
  ("not self-service yet"). The agreed vocabulary, from the realignment plan
  §"Source card projection":
  `Add now / Finish on this device / Needs deployment setup / Existing data only /
  Developer proof only / Not supported yet / Setting up / Needs attention`.

Source grounding for every claim below: the defect register (Frame 1), the live
churn-disposition map (Frame 2), the transferable patterns (Frame 3), and the live
source files read for this plan (cited inline).

---

## 1. The Sources SLVP redesign

### 1.1 The current architecture (what we are changing)

The Sources page (`apps/console/src/app/dashboard/components/views/records-list-view.tsx`)
renders **three** stacked sections:

1. A 5-cell **health summary bar** (`Sources / Needs attention / Degraded / Running /
   Stale`) — `HealthStat` grid, lines 315–342. The cells are inert: they count but do
   not filter or scroll [Defect 5].
2. **"Your sources"** — `SourceAccountsSummary` → `SourceAccountCard`, lines 446–534. One
   card per *connector type* the owner already has, carrying the add-account support
   chip.
3. **"Sources (N)"** — a flat `DataList` of `ConnectorRow` (lines 352–371), one card per
   *connection*, each rendering the full status soup via `ConnectorRowEvidence`
   (`apps/console/src/app/dashboard/records/connector-row.tsx:450`).

The failures: §2 and §3 are the same data at two zoom levels with no IA cue
[Defect 7]; the flat list has no health sort [Defect 5]; every `ConnectorRow` stacks the
status badge **plus** axis chips **plus** dominant-condition notice **plus** next-action
pill **plus** next-step guidance **plus** the partial-coverage link [Defects 4, 8].

### 1.2 The target row anatomy — collapse status-soup into ONE state + ONE action + peek

This is the academic "scorecard → detail" hierarchy [Frame 3 P9]: the list row is a
**threshold judgment**, not a data dump. Per-row, desktop, at Stripe density
(44–48px row, 14px medium name, 13px secondary tabular-nums) [Frame 3 P5, P12]:

```
[connector glyph + name]   [ONE StatusBadge]   [last run · N records]   [▸ one CTA or none]
   group-hover underline      data-status-tone     13px secondary tabular     state-specific verb
```

Exactly five row slots, nothing else competing for attention [Frame 3 P5]:

1. **Identity** — display name (14px/medium) + connector type (12px caption). Already
   correct in `connector-row.tsx:258-277`; keep.
2. **One `StatusBadge`** — the existing primitive, `status={health.state}`,
   `vocabulary={CONNECTION_HEALTH_VOCABULARY}` (already wired at
   `connector-row.tsx:755-758`). The badge encodes the **dominant** health verdict only.
   Severity precedence: `blocked/degraded` (danger) ▸ `needs_attention/cooling_off`
   (warning) ▸ `stale` (warning) ▸ `running` ▸ `healthy` (success) ▸ `idle/ready`
   (neutral). This is the one place color lives in the row [Frame 3 P1, P8].
3. **Secondary metrics** — `last success: <ts> · N records · M streams` in 13px secondary
   tabular-nums, right-aligned. Reuse `ConnectorStats` (lines 391–448) but **demote** it:
   it must not contain any colored link (see the partial-coverage move below).
4. **One CTA, weighted by the verb** [Frame 3 P6]: healthy rows render **no button** —
   the whole row links to the peek/detail. A row needing owner action renders **one
   right-anchored button** with an imperative verb (`Reconnect`, `Authorize`,
   `Resume`). A cooling-off / scheduled-refresh row renders **no button** (or a
   ghost-weight "View schedule"), because the system is handling it [Frame 3 P3].
5. **Disclosure affordance** — the row is clickable into the peek (inline expansion) or
   the detail page. Everything that is currently a sibling badge moves here.

What **moves to detail/peek** (i.e. everything `ConnectorRowEvidence` stacks today,
`connector-row.tsx:450-516`):

| Currently rendered inline in the row | New home |
|---|---|
| `axisChips` strip (Coverage/Freshness/Outbox/Retry) — lines 483-498 | Peek body + `StatusBadge` tooltip [Frame 3 P1] |
| `DominantConditionNotice` — line 510 | Folded into the **synthesized one-line** message (see §1.3); no separate notice |
| `NextActionPill` — line 511 | Becomes the row's single CTA (slot 4) or the peek's "what to do" line |
| `NextStepGuidanceRow` — line 512 | Peek body, "what the system tried / what you do next" runbook line [Frame 3 P7] |
| `projectionFreshness.unreliable` notice — lines 500-508 | Peek body only |
| `Partial source coverage` link — `ConnectorStats`, lines 437-445 | Peek body; **never** rendered next to a green badge [Defect 8, Frame 3 P9] |

The **`StatusBadge` tooltip** is the sub-second pressure valve [Frame 3 P1]: hovering the
badge shows the dominant-condition title (already computed —
`deriveConnectionStatusDisplay(...).title`, `connection-evidence.ts:964`). The owner gets
depth without navigation; the row stays singular.

### 1.3 How degraded / rate-limited reads as "handling it" — the blocked ChatGPT card

This is the highest-value fix [Defect 4]. The live ChatGPT card simultaneously shows
`blocked` + `Cooling off` + `Coverage · retryable gap` + `Freshness · fresh` + a repeated
"Retry policy has reached the blocked threshold" advisory — four independent failure
signals on a card whose last run actually **succeeded**. The true state: ChatGPT 429'd,
the scheduler hit its retry threshold from those 429s, and it is now in a cross-run
source-pressure cooldown that self-resolves on the next scheduler window. The owner should
read **"rate-limited; cooling off; will retry; your data is fine."**

The fix is a **single-voice synthesis layer** [Frame 3 P3 — Plaid update-mode semantics:
the system-managed transient state never reads as broken and shows no reconnect button].
Three concrete changes:

1. **Collapse `blocked` + `cooling_off` into one verdict when they share a root cause.**
   Both mechanisms here are downstream of the same ChatGPT 429s. The evidence model
   already carries the signal: `summarizeSchedule` stamps
   `reason_class === "source_pressure"` and emits the honest copy "Cooling off under
   source pressure · captured progress retained" (`connection-evidence.ts:858-863`), and
   `deriveConnectionStatusDisplay` already special-cases the cooling-off
   `SOURCE_PRESSURE_REASON_CODE` to frame it as catch-up, not failure (lines 989-1004).
   The redesign makes the **badge** read this: when `reason_code === source_pressure`,
   the dominant badge is `cooling off` (warning, NOT danger) — the `blocked` label is
   suppressed because the scheduler-retry exhaustion is a *consequence* of the cooldown,
   not an independent failure. **No danger tint** [Frame 3 P4]: cooling-off is the system
   handling it.

2. **Replace the four stacked signals with ONE synthesized line** in the peek (and as the
   badge tooltip): *"ChatGPT throttled this sync. The scheduler is spacing out the next
   attempt; 100+ detail items will fill on the next window. Captured progress is safe —
   no action needed."* This is the plain-language synthesis Defect 4 says is missing.
   The retryable-gap + fresh "incoherence" dissolves once the owner reads one sentence:
   fresh = last run succeeded; the gap = throttled detail that resumes on its own.

3. **Suppress the duplicate renders.** "Retry policy has reached the blocked threshold"
   appears three times today (pill text, tooltip, standalone advisory —
   `connection-evidence.ts:863, 999, 1636-1651`). The synthesis layer renders the
   message **once**, in the peek. The `Coverage · retryable gap` and `Freshness · fresh`
   chips move to the peek's axis detail, no longer competing as row-level signals.

CTA discipline for this state [Frame 3 P3, P6]: cooling-off / scheduled-refresh →
**no button** (it is handling itself). Reserve the imperative `Reconnect` button strictly
for credential-expired / `needs_attention` states where the owner must act.

**The verb must match the path it leads to** [Defect 6, P2; Frame 3 P3, P6]. Today the
Reddit revoked row labels its action `Reconnect`, but the href is
`addSourceHrefForConnector` → `/dashboard/records/add?source_q=reddit`
(`connector-row.tsx:67, 240`), which lands on the **setup picker** — and for Reddit
(`browser_bound_runbook`) that picker shows `Packaged path pending`, a dead end. "Reconnect"
implies re-auth; the path is a new-setup start. Fix per the two-axis rule [Frame 3 P10]:
for browser-bound dispositions with **no packaged reconnect path**, do not show an
imperative `Reconnect` button on the revoked/needs-attention row. Show the honest state
(`Existing data only` / `Packaged path pending`) and, if anything, a secondary-weight
"Start new setup" link whose verb matches the destination. The grouped
`SourceAccountActions` reconnect (`records-list-view.tsx:563-572`) routes to the same
`add?source_q=` and must be corrected the same way. When a packaged reconnect path *does*
exist (Plaid update-mode shape), `Reconnect` lands directly on the detail repair step
[realignment plan §"Reconnect / update mode"] — that case is already correct for
needs-attention rows (`records-list-view.tsx:555-562`).

### 1.4 The add-new-vs-existing two-axis presentation

The two orthogonal facts — *does this source have working data* vs *can I add another
account* — must never collide in one signal [Frame 3 P10; realignment plan
§"Existing-working vs add-new support"]. The current `SourceAccountCard` already separates
them structurally (`records-list-view.tsx:478-534`): existing-state line +
add-account chip + one priority action. Keep that separation; fix the **labels and tone**:

- The add-account chip uses the **agreed vocabulary** (§2 below), in **secondary text
  color** for non-actionable dispositions — not amber [Frame 3 P8]. Amber is reserved for
  "act soon but not urgent" (assisted-refresh due), and danger tint for actionable danger
  only [Frame 3 P4].
- The "Add account" affordance is **always a secondary/ghost button**; the health-repair
  CTA (`Reconnect`) is **always primary/filled** [Frame 3 P10]. An owner scanning for
  broken sources must never see "Add account" and wonder if it means the connection broke.
- Visual hierarchy makes the tiers distinguishable so two add-account phrases never read
  as two contradictory claims about the same thing [Defect 2].

### 1.5 Resolving the dual-list IA confusion [Defect 7]

"Your sources" and "Sources (N)" are the same data at two zoom levels. Two acceptable
resolutions; **recommend Option A** (lowest churn, biggest legibility win):

- **Option A (recommended): collapse to ONE list with health-triage ordering** [Frame 3
  P2, P5]. Drop the separate "Sources (N)" flat section; fold the per-connection
  `ConnectorRow` rows **under their connector group** as an expandable child of each
  `SourceAccountCard` (the group card is the summary, its connections are the detail —
  one IA, one zoom). The default sort floats degraded/needs-attention groups to the top
  so the 4 unhealthy connections [Defect 5] are never buried under 15 healthy ones. The
  inert health-summary bar becomes the **filter control**: clicking "Degraded (4)"
  filters the list to those — answering triage before the owner touches a control
  [Frame 3 P2].
- **Option B (minimal): keep two sections but add the IA cue.** Label "Your sources" as
  the summary ("14 sources, expand for connections") and make each group card's expand
  reveal its own `ConnectorRow`s inline, so the owner sees the relationship. Heavier to
  read; only if Option A is too large for one pass.

Either way: **default to the opinionated "Needs attention" view** when any source is
unhealthy [Frame 3 P2]. An owner with 17/19 healthy should not scroll past green rows to
find the 2 red ones.

### 1.6 Mobile (390px) [Defect 5; Frame 3 P12]

Cards are the **mobile** anatomy (the desktop list is dense rows, not cards). Per the
already-decided mobile design: one card = **one status, one metric, one CTA**. Stack:
name + `StatusBadge` on row 1; `last success · N records` on row 2; the single CTA (or
none) on row 3. The peek detail opens as a full-width disclosure. The health-summary
chips become horizontally-scrollable filter pills at the top so the most important action
items surface first (today the page is 7,000+px tall with action items buried).

### 1.7 Components touched (implementation map)

| File | Change |
|---|---|
| `apps/console/src/app/dashboard/records/connector-row.tsx` | Collapse `ConnectorRowEvidence` (450-516): remove inline axis-chip strip, dominant-condition notice, next-action pill, next-step guidance, projection-unreliable notice from the row body; move to peek/tooltip. Keep `ConnectionHealthStatus` badge (755-758). Add the cooling-off-suppresses-blocked synthesis. |
| `apps/console/src/app/dashboard/records/connector-row.tsx` (`ConnectorStats`, 391-448) | Remove the `Partial source coverage` link (437-445) from the row; it moves to the peek [Defect 8]. |
| `apps/console/src/app/dashboard/components/views/records-list-view.tsx` | IA collapse (§1.5): fold `ConnectorRow`s under their `SourceAccountCard` group; make health-summary bar (315-342) a filter; default-sort unhealthy first. |
| `apps/console/src/app/dashboard/lib/connection-evidence.ts` | Add the single-voice synthesis function (one sentence per non-green state); make `cooling_off`+`source_pressure` suppress the `blocked` badge label (§1.3). Pure function, node-testable. |
| `packages/operator-ui/src/components/status-vocabularies.ts` | No new enum — `CONNECTION_HEALTH_VOCABULARY` (87-95) already covers the states. Verify `cooling_off` stays warning (it does, line 91). Do NOT introduce an onboarding-only status enum [realignment plan Tech-Design §1]. |
| `apps/console/src/app/dashboard/records/[connector]/connection-diagnostics.tsx` | The peek/detail target. The expanded state functions as a mini-runbook: last failure in plain English + what the system tried + what the owner does next + direct repair link [Frame 3 P7]. Header badge uses the **identical** `StatusBadge` + label as the list row — no vocabulary drift between surfaces [Frame 3 P11]. |

`StatusBadge` usage stays exactly one component, one vocabulary, `data-status-tone`-bound
[Frame 3 P1, P11]. No new badge component.

---

## 2. The copy fix

Every contradictory / overruled string, where it is generated, and the corrected value.

### 2.1 [Defect 1, P0] "not self-service yet" — the overruled demotion copy

`apps/console/src/app/dashboard/lib/source-add-support.ts:48`:

```js
not_self_service: "Adding another account is not self-service yet",
```

The owner explicitly overruled this on 2026-06-10 (realignment plan §"Owner Decision":
"productize, do not demote … never demotion copy"). It is live on Notion, Slack, Oura,
Strava, YNAB (all `provider_auth_proof_gated` → `addAccountSupport` returns
`not_self_service`, `source-setup-presentation.ts:171-185`). Fix to the agreed vocabulary:

```js
not_self_service: "Existing data only",
```

Rationale: these connectors **have working data** but no shipped owner add-path. "Existing
data only" is in the agreed label set and is honest without demotion. ("Not supported yet"
is the agreed label for the truly-unsupported `api_network_unsupported` /
`unknown_unsupported` tier — already correct at `source-setup-presentation.ts:104`.) The
`not_self_service` **tone** at `source-add-support.ts:55` is already secondary
(`text-muted-foreground`, not amber) — correct per Frame 3 P8; keep it.

### 2.2 [Defect 2, P0] Two contradictory "adding another account" phrases on one screen

Same source file. `packaged_path_pending` says "moves into the dashboard soon" (amber,
positive) while `not_self_service` says "is not self-service yet" (the demotion). Fixing
§2.1 removes the direct contradiction. Then resolve the "moves into the dashboard soon"
**duplication / vagueness** [the owner asked "which is it?"]: the
`packaged_path_pending` label at `source-add-support.ts:46` should align with the agreed
short label `Packaged path pending` rather than a second long sentence that competes with
the now-`Existing data only` line. Recommended:

```js
packaged_path_pending: "Packaged path pending",      // was "Adding another account moves into the dashboard soon"
```

The longer "browser setup will move into the dashboard…" explanation already exists as
**guidance** (not the chip) in `source-setup-presentation.ts:114, 126` — keep it there as
the peek/tooltip detail, so the chip is the short agreed label and the sentence is
disclosure, not a competing claim. After this, the four chips read as one coherent
vocabulary: `Add another account` (self-service) / `Packaged path pending` (browser-bound)
/ `Adding another account needs deployment setup` (deployment) / `Existing data only`
(proof-gated). Two of these still differ in length; if the owner wants strict parity,
shorten the deployment one to the agreed `Needs deployment setup`
(`source-add-support.ts:47`).

### 2.3 First-account vocabulary already correct — verify, do not regress

`source-setup-presentation.ts` `sourceSetupStatus` (84-106) already uses the agreed set
(`Add now`, `Packaged path pending`, `Add account`, `Not supported yet`). The lone outlier
is `local_collector_unproven` / `provider_auth_proof_gated` → `"Not self-service yet"`
(line 102). For **first-account setup** this is the status label, not the add-another
chip; per the agreed set it should be `Existing data only` when the source has data, or
`Developer proof only` for the unproven-collector tier. Align it to `Existing data only`
to match §2.1 and kill the last "not self-service" string on the surface. Grep gate
(below) enforces zero `not self-service` / `not self-service yet` strings post-fix.

### 2.4 Copy-regression test (must ship in the same lane)

Add a test that fails if any owner-facing source string contains: `not self-service`,
`Track only`, `packages/`, `pnpm --dir`, an unpublished `pdpp ` CLI command, or env-var
jargon [realignment plan §"Negative acceptance checks"]. This is the harness that would
have caught Defect 1 before it shipped.

---

## 3. The read-error resilience fix [Defect 3, P1]

`apps/console/src/app/dashboard/records/error.tsx` is a Next.js **segment error boundary**:
when the records segment throws (e.g. a `router.refresh()` data re-read fails after a
successful Sync-Now / run-start — `connector-row.tsx:117-122` calls `router.refresh()`),
the boundary **replaces the entire page** with "Couldn't load your connections" — all 19
cards vanish [Defect 3]. The copy is accurate and non-alarming, but a transient 500
(precisely when ChatGPT is consuming deployment resources mid-run) blanks the page at the
highest-value moment to see it.

The fix is **stale-while-revalidate with a partial fallback** — never blank the page; show
last-known data + a quiet retry. Two layers, in order of robustness:

1. **Decouple the refresh from a full re-throw (primary fix).** The crash path is
   `router.refresh()` re-reading data and the read failing. Instead of letting that throw
   to the boundary, the list view should treat a refresh read-error as a **soft** state:
   keep the already-rendered server payload mounted, overlay a dismissible inline banner
   ("Couldn't refresh — showing last-known status from <ts>. Retry."), and offer a retry
   that re-runs the read. This is the "degrade gracefully on a transient read" requirement.
   Concretely: have the run-start action’s success path do an **optimistic local** update
   (the row already does this — `optimisticRunning`, `connector-row.tsx:87-94`) and make
   the subsequent revalidation **non-throwing** — a failed background read sets a
   `staleSince` flag rather than throwing into the segment boundary.

2. **Make the boundary itself partial-aware (defense in depth).** If a read *does* reach
   the boundary, `error.tsx` should not be a full-viewport takeover. Render the last-known
   list from a cached/last-good snapshot when available (e.g. a client-cached
   `overviews` payload or the RSC's previous render), with the read-failure banner **above**
   the cards rather than instead of them. The owner keeps all 19 cards + status context and
   one retry button. The "read failure, not a change" copy stays — it is correct — but it
   becomes a banner, not a blank.

Where: `apps/console/src/app/dashboard/records/error.tsx` (boundary → partial banner) and
`records-list-view.tsx` / `connector-row.tsx` (soft-revalidate so transient reads never
reach the boundary). Note: `error.tsx` is `"use client"` and must stay self-contained (it
cannot import server-only modules — the dashboard shell transitively pulls
`server-only` via `lib/owner-token.ts`; see the file's own header comment, lines 18-22).
The last-known snapshot for the boundary must therefore come from a client-cached payload,
not a server read inside the boundary.

This is **Frame 3 P11 applied to failure**: status propagates to every surface, including
the degraded one — the owner never loses the cockpit.

---

## 4. The data-cleanup plan

Source of truth: the live churn-disposition map (Frame 2). The headline:

> **The genuinely actionable churn is ~4,800–6,000 rows / ~3–3.5 MB**, compactable
> **losslessly NOW** with shipped tooling. The June 3 compaction already removed the major
> churn (8,033 rows / 3.5 MB). The remaining >2× ratios are overwhelmingly **legitimate
> retained history** (order lifecycle, session snapshots, score changes) — not defects.

So the owner's perception of "still a big problem" is mostly the dashboard surfacing real
history as alarming ratios. The redesign (§1, §5) softens that perception; the cleanup
below removes the small real residue.

### 4.1 Disposition table (condensed from Frame 2)

| Disposition | Streams | Action | Owner effort |
|---|---|---|---|
| **(A) Compactable NOW — lossless** | chase/transactions (canonical, 3,460 rows), usaa/transactions (audit, ~857), chase/current_activity (~5), chase/balances (~4), usaa/credit_card_billing (~2), slack/users (~8), ynab/budgets (small), codex/history (inventory policy) | `compact-record-history.mjs --apply` | **~none** — RI-owner runs, dry-run gated |
| **(B) Fingerprint-pending** | chase/statements (0/5 fingerprinted → needs a fresh Chase run), usaa/statements (10/15 fingerprinted → re-run to finish) | wait for next scheduled run, then canonical compaction | none now |
| **(B) Migration residue — DO NOT compact** | usaa/accounts (35 redundant; pre-split balances are the SOLE copy) | gated on `backfill-usaa-pre-split-balances-to-account-stats` | none |
| **(C) Retention-policy — leave** | codex/sessions (5,333), claude-code/sessions all 3 devices (~2,145), amazon/orders + order_items (~7,000 real lifecycle), reddit upvoted/downvoted/hidden, ynab categories | none — real history | none |
| **(D) Active defect, no policy** | github/gists (98 byte-identical no-op re-emits, one 100-version gist) | needs a new compaction policy + fingerprint cursor (OpenSpec, not a today cleanup) | none |

### 4.2 The EXACT command sequence to compact the compactable churn losslessly NOW

Sequenced so the **owner does ~nothing** — this is RI-owner-autonomous-with-care: every
mutating step is **dry-run gated** (the script reports `removableVersions` before
`--apply`), and only (A)-category streams with a registered policy are touched.

Prereqs:
```bash
export PDPP_DATABASE_URL=postgres://pdpp:pdpp@127.0.0.1:55432/pdpp
cd /home/user/code/pdpp
```

**Step 0 — read-only survey of all registered policies (safe anytime):**
```bash
node reference-implementation/scripts/compact-record-history-dry-run-all.mjs --connector-instance-id=cin_029a67a16d8a252f6e3eb896  # Chase
node reference-implementation/scripts/compact-record-history-dry-run-all.mjs --connector-instance-id=cin_bc1efca69a1c386d610f0924  # USAA
node reference-implementation/scripts/compact-record-history-dry-run-all.mjs --connector-instance-id=cin_cd523fe54af1881cc18d7368  # Amazon
node reference-implementation/scripts/compact-record-history-dry-run-all.mjs --connector-instance-id=cin_f565a96cb0a114b0a27e9606  # Vana Slack
node reference-implementation/scripts/compact-record-history-dry-run-all.mjs --connector-instance-id=cin_ece4bfe5096b8bf67a1468c2  # peregrine Codex
```

**Step 1 — chase/transactions (highest value, canonical mode — all 3,460 pre-gate rows):**
```bash
# dry-run first; confirm 3,460 removable
node reference-implementation/scripts/compact-record-history.mjs --connector-instance-id=cin_029a67a16d8a252f6e3eb896 --stream=transactions --mode=canonical
# apply when confirmed
node reference-implementation/scripts/compact-record-history.mjs --connector-instance-id=cin_029a67a16d8a252f6e3eb896 --stream=transactions --mode=canonical --apply
```

**Step 2 — usaa/transactions (audit mode, ~857 pre-gate rows):**
```bash
node reference-implementation/scripts/compact-record-history.mjs --connector-instance-id=cin_bc1efca69a1c386d610f0924 --stream=transactions --apply
```

**Step 3 — remaining small (A) policy-covered streams (audit mode, dry-run each first):**
```bash
node reference-implementation/scripts/compact-record-history.mjs --connector-instance-id=cin_029a67a16d8a252f6e3eb896 --stream=current_activity --apply   # ~5
node reference-implementation/scripts/compact-record-history.mjs --connector-instance-id=cin_029a67a16d8a252f6e3eb896 --stream=balances --apply            # ~4
node reference-implementation/scripts/compact-record-history.mjs --connector-instance-id=cin_bc1efca69a1c386d610f0924 --stream=credit_card_billing --apply # ~2
node reference-implementation/scripts/compact-record-history.mjs --connector-instance-id=cin_f565a96cb0a114b0a27e9606 --stream=users --apply               # ~8
node reference-implementation/scripts/compact-record-history.mjs --connector-instance-id=cin_ece4bfe5096b8bf67a1468c2 --stream=history --apply             # inventory policy
```

**Step 4 — usaa/statements (canonical; 10/15 now fingerprinted — re-alarmed since review):**
```bash
node reference-implementation/scripts/compact-record-history.mjs --connector-instance-id=cin_bc1efca69a1c386d610f0924 --stream=statements --mode=canonical          # dry-run
node reference-implementation/scripts/compact-record-history.mjs --connector-instance-id=cin_bc1efca69a1c386d610f0924 --stream=statements --mode=canonical --apply  # after confirming count + accepting the reviewed_at re-alarm
```

### 4.3 What needs fresh runs (fingerprint-pending) — owner does nothing

- **chase/statements** — 0/5 records carry `pdf_text_sha256`. The next **scheduled** Chase
  run stamps fingerprints; then run canonical compaction. No owner action — it lands on
  the schedule.
- **usaa/statements** — 10/15 fingerprinted; another USAA run likely stamps all 15 and
  enables fuller collapse. Step 4 handles the available 10 now; the rest finishes on the
  next run.

### 4.4 What is legitimately retained — LEAVE [Frame 2 §C, §"Why the owner perceives…"]

codex/sessions (16 MB of real session snapshots, mtime gate working, 0 adjacent same-fp),
claude-code/sessions (all 3 devices, ~2,145 real snapshots), amazon/orders + order_items
(~7,000 rows = real delivery/item lifecycle, only ~58 noise), reddit votes, ynab
categories. These compact to `removableVersions = 0` and that is correct — do not force
them.

### 4.5 DO-NOT list (owner gates — never auto-run)

- **usaa/accounts** — `owner_migration_pending`: the pre-split balance observations are the
  sole surviving copy. Do not compact until the account_stats backfill is done.
- **Any `*/sessions`** (`recurring_point_in_time_snapshot`) — every version is real.
- **github/gists** — the one true unmitigated defect (98 byte-identical re-emits). It has
  **no** registered `COMPACTION_POLICIES` entry, so the script refuses ("no compaction
  policy registered"). Fixing it needs a new policy + a connector fingerprint cursor — a
  **separate OpenSpec task**, not a today cleanup. ~57 KB; low urgency.

### 4.6 One-line verdict

**~4,800–6,000 rows (~3–3.5 MB) compact away losslessly right now via the dry-run-gated
sequence above; the rest of the >2× churn is real retained history (leave it), two
statement streams finish themselves on their next scheduled run, and github/gists is the
lone real defect needing a small OpenSpec policy — none of which requires the owner to do
anything.**

---

## 5. The dispatch plan

Five lanes. The first three are UI implementation (with a collision note); the fourth is
copy; the fifth is the live data cleanup. Sequencing maximizes parallelism while honoring
the one real file collision.

### Lane A — Copy fix (smallest, ship first, unblocks the redesign's vocabulary)

- Files: `source-add-support.ts` (lines 46, 48), `source-setup-presentation.ts` (line 102).
- Work: §2 — `not_self_service` → `Existing data only`; `packaged_path_pending` →
  `Packaged path pending`; `local_collector_unproven`/`provider_auth_proof_gated` status →
  `Existing data only`; add the negative-copy regression test (§2.4).
- Why first: tiny, isolated, and it establishes the exact label set the redesign binds to.
- **Verification gate** (per the owner's working style #4): after the edit, grep the whole
  console source tree for `not self-service`, `not_self_service` label strings, and
  `moves into the dashboard soon`; confirm zero owner-facing occurrences before reporting
  done.

### Lane B — Read-resilience fix (P1; **collision note**)

- Files: `records/error.tsx` + soft-revalidate touchpoints in `records-list-view.tsx` and
  `connector-row.tsx`.
- **Collision risk:** `connector-row.tsx` and `records-list-view.tsx` are *also* touched by
  Lane C (the redesign), and **Codex may be working in connect/sources files** concurrently
  (the connect-agent / sources surfaces have active Codex workstreams in this repo). To
  avoid stomping:
  1. Scope Lane B to `error.tsx` (boundary → partial banner) **plus** the minimal
     `staleSince` soft-revalidate flag, and land it **before** Lane C touches the same two
     files, OR sequence B→C on the same lane/worktree.
  2. Before editing `connector-row.tsx` / `records-list-view.tsx`, check for in-flight
     Codex edits (uncommitted changes / concurrent worktree writers — this repo has many
     `.claude/worktrees/agent-*` trees). If a concurrent writer is churning these files,
     **wait for settle and re-read the final tree** before contributing the gap (a known
     gotcha in this repo's worktree workflow).

### Lane C — Sources-view redesign (the big one; serialize after/with Lane B on shared files)

- Files: `connector-row.tsx` (collapse `ConnectorRowEvidence`, demote `ConnectorStats`,
  add cooling-off-suppresses-blocked synthesis), `records-list-view.tsx` (IA collapse +
  health-summary-as-filter + unhealthy-first sort), `connection-evidence.ts` (single-voice
  synthesis function — pure, node-testable), `connection-diagnostics.tsx` (peek = runbook),
  `status-vocabularies.ts` (verify only — no new enum).
- Work: §1.2–§1.7. Keep `StatusBadge` as the one badge; everything else moves to peek.
- Sequencing vs Lane B: same two files (`connector-row.tsx`, `records-list-view.tsx`) →
  **do B and C on one worktree, B first** (resilience is the smaller diff and is a clean
  base for the row restructure). Do not run B and C as independent parallel writers on
  those files.
- Co-design constraint: the synthesis layer (`connection-evidence.ts`) is a **pure
  function** — build it test-first (node `--test`) so the ChatGPT-card behavior is locked
  by unit tests before any JSX, per the owner's fail-fast preference. Use the live ChatGPT
  evidence shape from Defect 4 as the fixture.

### Lane D — Data cleanup (live, careful, RI-owner-runnable; fully parallel to A–C)

- No code-file overlap with A–C → runs in parallel from the start.
- Work: §4.2 sequence. Every mutating step **dry-run gated**; only (A) streams with a
  registered policy. Honor the DO-NOT list (§4.5) absolutely.
- Owner effort: **~none.** RI-owner executes against the live DB with the dry-run gate as
  the safety interlock. The two fingerprint-pending statement streams (§4.3) self-finish on
  their next scheduled run — no owner step.
- Gotcha (from prior RI cleanup work): the live store is SQLite while these tools are
  Postgres-oriented; confirm the live connection-instance ids resolve against the actual
  live DB before `--apply`, and run the dry-run-all survey (Step 0) first — it is the
  authoritative count, more reliable than the disposition-map estimates.

### Lane E — github/gists defect (OpenSpec, not this pass)

- Out of scope for the one-pass owner-effort goal. File an OpenSpec change to add a
  `github/gists` compaction policy (`excludeKeys: []`, exact-JSON, same pattern as
  codex/claude-code) **plus** a connector fingerprint cursor so re-emits stop accruing.
  ~57 KB; low urgency; sequence after A–D.

### Sequencing summary

```
Lane A (copy)        ──┐
Lane D (data cleanup)──┼── start in parallel (no shared files)
Lane B (resilience)  ──┤   B and C share connector-row.tsx + records-list-view.tsx:
Lane C (redesign)    ──┘   run B→C on ONE worktree; watch for concurrent Codex writers
Lane E (gists)       ────  after A–D; OpenSpec, separate
```

Owner returns to: a Sources page that reads "handling it, not broken," correct
non-contradictory copy, a page that never blanks on a transient read, and a live store
whose actionable churn has been compacted away losslessly — having done nothing but,
optionally, glance at the dry-run output.

---

## Appendix — final synthesis (the one-paragraph version)

**Row anatomy:** every Sources row is `[glyph + name] · [one StatusBadge, the dominant
verdict, the only color] · [last-success + record count, 13px tabular secondary] · [one
state-specific CTA or none]`, with the entire axis-chip / dominant-condition / next-action
/ next-step / partial-coverage soup demoted into the badge tooltip and a peek that reads as
a one-sentence runbook ("ChatGPT throttled this sync; the scheduler is spacing out the
next attempt; captured progress is safe — no action needed"), and cooling-off /
source-pressure suppressing the `blocked` label and the danger tint so a rate-limited
connection reads as *handling it*.

**Top 5 implementation changes:**
1. Collapse `ConnectorRowEvidence` to one `StatusBadge` + tooltip + peek; move every
   sibling badge and the partial-coverage link out of the row.
2. Add a pure single-voice synthesis in `connection-evidence.ts` that maps
   `cooling_off`+`source_pressure` to one honest, non-danger "handling it" verdict and
   one sentence (kills the four-signal ChatGPT stack).
3. `source-add-support.ts:48` `not_self_service` → `"Existing data only"`;
   `:46` → `"Packaged path pending"` (kills the overruled demotion copy and the two
   contradictory add-account phrases) + ship the negative-copy regression test.
4. Make `records/error.tsx` partial-aware and the post-Sync `router.refresh()` a
   non-throwing soft-revalidate, so a transient read shows last-known + retry, never a
   blank page.
5. Collapse the dual list into one health-triage-ordered IA (unhealthy first; the
   health-summary bar becomes the filter), with cards as the mobile anatomy.

**Data-cleanup verdict:** **~4,800–6,000 rows / ~3–3.5 MB compact away losslessly right
now** via the dry-run-gated `compact-record-history.mjs --apply` sequence (chase/transactions
canonical is the bulk at 3,460); the rest of the >2× churn is legitimate retained history
to leave alone, two statement streams finish themselves on their next scheduled run, and
github/gists is the lone real defect (a small future OpenSpec policy).

**What genuinely needs the owner:** essentially nothing for this pass — RI-owner runs the
dry-run-gated cleanup and the UI lanes; the only true owner-gated items are the
deferred-by-design ones (the usaa/accounts pre-split backfill before its migration residue
can clear, and the github/gists OpenSpec policy), neither of which blocks clean health
today.
