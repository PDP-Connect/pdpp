# PDPP Shippability Audit — confused-owner journey walk (2026-06-16)

Live stack: https://pdpp.vivid.fish. Method: headed Playwright, real owner session,
walking JOURNEYS as a confused first-time user (not testing components). Severity is
ranked by JOURNEY FAILURE (does a real person reach their goal / form a correct mental
model?), not by component flaw. Screenshots in apps/console/.playwright-mcp/ and
.playwright-mcp/.

Trigger: the owner's live walkthrough where the recovery journey we shipped failed end-to-end
(loud alarm -> wrong-page CTA -> diagnostics wall -> CLI ritual that returned "nothing
to do"). His instruction: validate the WHOLE surface to a real shippability confidence,
because isolated component fixes pass tests and still fail humans.

Severity legend: **P0 blocks-delight / actively-misleads** · **P1 confusing / erodes
trust** · **P2 cosmetic / polish**.

---

## JOURNEY A — "Something is wrong, what do I do?" (the recovery journey)

### A1 [P0] The dashboard gives THREE inconsistent answers to "what's broken?"
On `/dashboard` hero (screenshot journey-01-dashboard-hero.png), three surfaces disagree:
- Hero count: **"2 things need you"**, headline **"Something stopped working."**
- Hero primary CTA **"See what's wrong" → `/dashboard/traces`** (DOM-confirmed href).
- "Anything wrong" list below names: **ynab stopped syncing (orphaned_started_run)** →
  `/dashboard/runs/run_1781622328066`, and **"A reader could not read"
  (orphaned_started_run)** → a trace.

Three problems:
1. **The primary CTA points to the wrong page.** `/traces` is the read-audit log; it
   shows reads succeeding ("amazon read 146 records"), NOT the broken connections. This
   is the dead-end the owner hit: loud alarm -> "See what's wrong" -> a page that says
   everything succeeded.
2. **The hero's "anything wrong" list disagrees with `/runs`.** The hero headlines
   **YNAB** + "a reader could not read" — but `/runs` shows the two `attention` cards as
   **Chase (code fix)** and **peregrine Claude Code (check the collector)**. YNAB is
   `healthy` in the live verdict (recovered). So the dashboard surfaces a stale/different
   problem set than the actual attention connections.
3. **The count is unanchored.** "2 things need you" can't be reconciled with either the
   CTA (1 destination) or the list (2 different items) or `/runs` ("1 need your hand" +
   2 warning cards). Four surfaces, four different counts.

Why it's P0: the FIRST thing an owner does when alarmed is follow the big CTA. It lands
on a page that contradicts the alarm. There is no single trustworthy answer to "what
needs me and where do I go." This is the spine of the recovery journey and it's broken.

Fix direction (shared boundary, both owners): the hero alarm, its count, its CTA, and
the "anything wrong" list must derive from ONE source of attention truth (the same
rendered-verdict attention set that drives `/runs`), and the CTA must land on a focused
recovery destination for the actual attention connection(s), never `/traces`.

### A2 [P0] The CTA lands on a forensic AUDIT log, not a recovery view
Following "See what's wrong" -> `/dashboard/traces` (screenshot journey-02-traces-deadend.png).
The page header literally reads: **"AUDIT SURFACE — Traces: provider-connect · owner
device · /v1 reads · every protocol interaction recorded."** Rows are protocol traces:
`run.started, run.progress_reported, run.detail_coverage_declared` (22 events), statuses
`failed / succeeded / in_progress`. There is ONE `failed ynab` row at top, but it's buried
in technical events and the page frames itself as a forensic log, not "what's wrong + what
to do." This fully explains the owner's "everything says succeeded, I have no idea what I'm
looking at." A confused owner who clicked the alarm CTA lands in a developer audit tool.

Fix direction: `/traces` stays an inspection tool (correct as such). The recovery CTA must
NOT route here. It routes to a focused per-connection recovery panel (Journey A fix).

---

## JOURNEY B — "Connect a new source" (the amazon hosted-browser connect)

### B1 [P0/intermittent] `/connect/browser-session/amazon` throws to the error boundary
the owner hit a hard "Something went wrong — display failure" page here. Reproduced the
fragility, not the full crash, on this pass (the page rendered, but with errors). Two
concrete defects:
- **Deterministic 404:** the page requests `/docs/operator/browser-collector-proof-
  runbook.md` -> **404** (console-confirmed, every load). A referenced runbook doc is
  missing at that path.
- **Network-fragile fetch (the crash cause):** the owner's console showed `net::ERR_NETWORK_
  CHANGED` + `installHook.js TypeError: Failed to fetch` + a throw in chunk `5546-*.js`.
  The hosted-browser connect surface streams/fetches a remote browser session; when that
  fetch fails (network blip, or no neko session ready) it throws to the error boundary
  -> the full-page "Something went wrong." It's INTERMITTENT (rendered fine this pass),
  which is worse for trust — a new user's first connect attempt randomly crashes.

Why P0: this is the PRIMARY new-user action ("connect a source"). An intermittent
full-page crash on the connect flow is a delight-killer and a trust-killer. Needs: the
remote-surface fetch wrapped with retry + a graceful inline error (not the whole-page
boundary), and the missing runbook doc either created or the link removed.

---

## JOURNEY C — Sources / Records list (`/dashboard/records`)

### C1 [P1] Source name repeated 3-4x per card (the owner's "Amazon shown 4 times")
Screenshot journey-03-sources-redundant.png. Each source card renders the name three+
ways stacked: **"Amazon - Personal"** (title) + **"Amazon · Amazon - Personal · AMAZON"**
(meta line: display · qualified · connector-key) — reads as "Amazon" four times in one
box. Confirmed live (13 "Amazon" occurrences on the page; two Amazon cards). The meta
line shows redundant identity facets that mean nothing to an owner. Fix: one name, drop
the connector-key/qualified-name triple unless meaningfully different.

### C2 [P1] "Amazon - Personal": idle + coverage=unknown rendered as "Degraded · Retry now"
CORRECTION (my first inference was wrong; Codex flagged it; live data confirms): the amber
is NOT caused by `freshness=unknown`. Live `/_ref/connectors` for the three Amazon rows:
- **"Amazon - Personal":** `state=idle`, `coverage=UNKNOWN`, freshness=unknown -> pill
  **Degraded/amber**, forward **"Retry now to give the recoverable gap another run."** ← BUG.
- Two **"Amazon":** `state=degraded`, `coverage=retryable_gap` -> Degraded/amber + Retry now
  ← CORRECT (legitimate retryable gap; this is our verdict fix working as intended).

The bug: "Amazon - Personal" has **coverage=unknown** (no evidence either way) on an **idle**
connection, yet renders a confident **Degraded + "recoverable gap" + Retry now**. Per the
FINAL design, unknown evidence -> grey **"Checking", never an alarm or a confident
"recoverable gap" claim.** Claiming a recoverable gap when coverage is unknown is a
false-confidence inversion of the same honesty rule. SHARED/Codex (synthesizer): the
resumable/retry-gap action + amber tone must not fire when coverage is `unknown` (vs
`retryable_gap`). the owner's "how can coverage be unknown??" was exactly right.

### C3 [P1] Vocabulary collision: "sources" vs "connections" vs "add a source"
Page is titled **Sources** ("your loading dock · each source pushes into your streams"),
but the model underneath is "connections," and the add flow is "add a source," while the
nav calls the connect surface "Connect AI apps." A first-timer can't tell if a source, a
connection, and an AI app are the same thing. Needs ONE consistent noun for the
owner-facing concept.

### C4 [P2] (the owner) streams table always shows "no records / cursor / search"; can't click
into a source. To be evidenced on the source-detail walk.

---

## JOURNEY D — `/records/add` (add a source)

### D1 [P0] 18 cards dead-end in "no setup action yet / setup path pending / existing data only"
Live count: **18 dead-end labels** across the catalog (`No setup action yet` / `Setup path
pending` / `Existing data only`). This directly violates the owner's standing rule: "there can't
be any 'coming soon' / 'not yet implemented' copy in the app and the fix is to build that
all out, properly." A first-timer browsing "add a source" hits 18 cards that offer no way
forward. (Fix path already scoped in tmp/workstreams/add-source-deadends-p2-proposal —
import-only sources -> "Import an export"; unwired APIs -> build the static-secret/OAuth
form or a real runbook link; nothing reads "pending.")

### D2 [P1] "Why this, and what to expect" repeated 33x — pure visual noise
The phrase renders **33 times**, once per card. A per-row restated label that never varies
is noise; it should be an implicit column/affordance, not repeated copy. (Screenshot
journey-04-add-source.png.)

### D3 [P1] Non-comparable rows: Maps + WhatsApp blow out the uniform layout
Most cards are uniform compact rows; Google Maps Timeline + WhatsApp render with extra
text, CTAs, and detail inline, breaking the scannable comparison grid. The richer
acquisition detail should live behind an interaction (expand/detail), not inline in the
list, so rows stay comparable.

### D4 [P1] vocabulary again: page is "Add source" but explains it's NOT "Connect AI apps"
The page has to disambiguate itself: "Add source accounts that populate this PDPP instance.
AI app and agent access is configured separately under Connect AI apps." The fact the UI
must explain the difference is the symptom of C3's noun collision.

---

## Interim shippability read (3.5 journeys walked)
- **Recovery journey (A): broken at the spine** — 3 inconsistent answers to "what's wrong,"
  CTA to the wrong page, diagnostics wall, CLI ritual that returns "nothing to do." P0.
- **Connect journey (B): intermittent full-page crash** + deterministic 404. P0.
- **Sources (C): redundant identity, unknown-as-alarm, noun collision.** P1 cluster.
- **Add-source (D): 18 dead-ends, 33x repeated copy, non-comparable rows.** P0+P1.

Root cause is consistent across all four: **surfaces were built in isolation and never
walked as a goal-directed journey.** The defects are not random — they cluster into (1) no
single source of "attention truth" feeding the recovery surfaces, (2) raw
identity/condition facets leaking into owner copy, (3) dead-ends where a feature wasn't
finished, (4) one component's rich case breaking a list's uniformity.

Honest shippability for "delight a friend/Reddit/colleague" today: **~10-15%** — confirmed,
not softened. The recovery + connect P0s alone would bounce most first-time users.
_(audit continues if more journeys walked; this is enough to drive P0/P1 fixes.)_
