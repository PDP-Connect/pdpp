# Owner-console studio critique and reconciliation — 2026-07-09

Method: two blind assessments that could not see each other's conclusions — a
product/design-studio critique (Reviewer A) and a product-systems/state-model
critique (Reviewer B) — plus a deterministic code audit (Auditor C) and a
prior-art gap-research lane. The synthesis director verified every load-bearing
code claim independently before accepting it (verification appendix below).
Lane reports live under `tmp/studio/` (untracked working evidence:
`design-critique-blind-A.md`, `systems-critique-blind-B.md`, `code-audit-C.md`);
this note is the durable record. New durable research:
`docs/research/owner-console-operator-prior-art-gaps-2026-07-09.md`.

Primary friction evidence: the owner's 2026-06-18 voice-dictated walkthrough
(the untracked `docs/inbox/` owner-feedback note this change's proposal already
names), `tmp/workstreams/2026-07-09-owner-operating-reset/ROLLUP.md` (the
owner's acceptance object), `tmp/workstreams/2026-07-09-instance-health/*`
(live health inventory, verdict-rollup report), `chatgpt-green-ui-audit.md`,
`owner-console-d8-review-0703.md`.

## Verdict

**Overall: C+ — strong bones, product-grade components, not yet a product in
the aggregate.** The engineering of the UX outclasses the experience of the UX.
The path up is subtraction and honesty over an already-correct spine, not a
restyle and not a rewrite.

Both blind reviewers, working independently, converged on the same root cause
stack:

1. **The console is forensic when it should be calm** (A's top finding). The
   internal state machine — verdict axes, coverage taxonomy, disposition
   vocabulary, diagnostics narration — is the primary owner-facing surface.
   The recovery page renders the same red verdict twice ("Verdict:" row and
   "PROJECTED STATE / Health:" row) plus four raw axis chips and a CLI
   transcript.
2. **The state model is good but re-derived, frozen, and un-collapsed** (B's
   top finding). The server spine (`computeConnectionHealth` 12-step
   precedence + `synthesizeRenderedVerdict` 6-axis worst-wins rollup +
   `OwnerActionSurface` routing) is legitimately well designed. The defects:
   - **Frozen snapshot, no evidence age.** Degraded/Can't-collect verdicts are
     read verbatim from the last terminal run and can persist for weeks
     (USAA ~23 days; Chase red from pre-fix evidence — both 07-09 macro lanes
     concluded "validation-needed, not code-defect"). The owner cannot tell
     "broken now" from "was broken, unretried."
   - **At least three verdict authorities.** The console re-derives its own
     taxonomy in `source-actionability.ts`; `sources-view-model.ts:226`
     `deriveSourceStatus` computes the Sources-list pill from RAW
     `health.state` with `HEALTHY_STATES = {"healthy","idle"}` — bypassing the
     verdict pill entirely and contradicting the 07-09 server fix that made
     idle-with-prior-success amber; `connection-diagnostics.tsx:480` still
     computes a legacy client-side verdict fallback. The 07-09 "false green"
     fix had to be applied twice and still missed the third path.
   - **Un-collapsed cartesian product.** ~5 axes × ~7 labels exposed raw;
     each surface renders a different slice; the owner's walkthrough is a
     line-by-line record of failing to reconcile them.
3. **The July commit stream is the model paying interest.** Fifteen changes to
   `rendered-verdict.ts` since 6-20, each a correct local fix to one evidence
   shape's tone/audience mapping, each discovered in production by the owner.
   The auth-repair convergence (`OwnerActionSurface`, "decide in server,
   switch in console") is the healthy counter-example and the template.

The deterministic audit independently confirmed the duplication mechanics:
live duplicate verdict computation on source detail; two same-named
`runConnectorNowAction` functions with incompatible signatures (one dead);
`IcTimestamp` is a hand-copied fork of `Timestamp`, both in live use, plus a
raw `toLocaleString()` bypass; a triple hand-maintained enum→tone/label/badge
mapping in the deployment readiness panel; five confirmed-dead exported
components; three differently-worded "paused" copies with no stated semantics.

## Reconciled agreements (both blind lanes, independently)

- One server-derived owner state per source; console consumes, never
  re-derives. Mostly **deletion** over the existing spine.
- Green must be trustworthy: stale/idle/paused never renders the success tone
  (07-09 server fix is right; finish it by deleting the bypassing console
  paths).
- Headline counts must definitionally equal the listed subjects (same
  predicate, server-owned) — kills "One thing needs you / three things wrong".
- Every advertised state carries its action: "needs a refresh" with nothing to
  click (`reattach_schedule` declared but never emitted) is a dead end.
- Evidence age must be visible: "last run found X (2d ago) — re-check" not a
  bare persistent red.
- Recovery leads with one human cause + one action; axes/diagnostics one
  click down.
- "Checking"/"Unknown" reserved for active work / genuine absence
  (owner-operating-reset ROLLUP names this; `define-stream-coverage-
  freshness-evidence` is the contract vehicle — do not duplicate it).
- Preserve aggressively: `OwnerActionSurface` routing, `amberLabel`
  Needs-refresh/Degraded split, tone/channel orthogonality, `audience:
  maintainer` no-dead-owner-button invariant, revoke/reactivate ceremonies,
  `scopeHuman` plain-language lexicon, the three-question Overview framing,
  shared attention truth, Ink Carbon token thesis, 10.A–10.D landed work.

## Recorded disagreements (not averaged away)

1. **State cardinality.** A: collapse to ≤3 visible owner states (Working /
   Needs you / We're on it) with one legend. B: a closed 9-state enum
   (Collecting, Healthy, Paused, Needs refresh, Needs you, Degraded—system,
   Blocked—maintainer, Not measured, Retired), each with a named owner.
   **Ruling (owner-refined 2026-07-09):** neither taxonomy is the owner-facing
   contract. B's closed set survives only as the internal server-side resolver
   (it makes derivation exhaustive and console-deletion safe); A's three
   groups organize lists. What the owner sees per source is ownership-first:
   what is happening in plain language, who acts next, the one wired action,
   and evidence age — concrete cause/progress copy, not an enum label, and no
   persistent legend. The owner's own feedback that a complex taxonomy is not
   itself useful settles this. Final labels/copy principles are recommended
   from the prior-art research and comprehension-tested inside the design
   gate (tasks 10.E.1) — not deferred to the owner as a blocking decision.
2. **Which defect is primary.** A: forensic presentation. B: model
   plurality/freeze. **Ruling:** B's defects are causal (presentation
   subtraction on top of three disagreeing authorities just hides the
   disagreement); sequence model-first, presentation-second. The governing-
   brief split (below) can proceed in parallel because it is an artifact, not
   code.
3. **Explore time-distribution chart.** A wants it restored as a filter
   affordance; B is silent. Already in Wave 4 scope; no design change needed —
   noted to prevent it being dropped as "polish."

## The `.impeccable.md` audience assessment

**Confirmed: the leadership/demo brief is the wrong governing document for the
owner console, and the console has effectively drifted with no governing brief
at all.** `.impeccable.md` names a CEO/standards-body/head-of-product audience,
declares "Not a dashboard," and prescribes light editorial minimalism — a
coherent brief for `apps/site`, `/reference`, `/sandbox`, `/docs`. The console
is definitionally a dashboard; the atlas era shipped it dark-terminal-forensic
(the opposite of the brief), and the current Ink Carbon light "paper" build is
governed only by token-level taste. The distortion shows where "protocol
precision" became taxonomy leakage and "dense information" became forensic
density: impressive to an engineer for thirty seconds, exhausting for the
owner every day. The one honest audience overlap is trust/consent UX
(grants/revoke ceremonies) — protect it.

**Decision:** the console gets its own one-page governing charter — calm,
legible, action-first; the owner never learns internal taxonomy to operate
their own data; alarm reserved for owner-actionable breakage; Ink Carbon
tokens retained (this is a charter, NOT a parallel design system).
`.impeccable.md` continues to govern the public/reference surfaces. The voice
guide already draws this line (§3, §7); the console must be governed by the
operator half.

## Keep / Change / Delete map

### KEEP (protect through any refactor)
- Server spine: `computeConnectionHealth` precedence, `synthesizeRenderedVerdict`
  worst-wins tone + orthogonal channel, `OwnerActionSurface` +
  `reauthActionPresentation` switch, `amberLabel` split, `audience: maintainer`
  invariant.
- Ink Carbon token foundation (two-temperature palette, square paper, tabular
  numerics); Overview MetricStrip + single-hue distribution.
- Three-question Overview framing; shared attention truth between Overview and
  Syncs; `scopeHuman`/`grantReads` lexicon; revoke/reactivate ceremonies +
  "nothing is erased" copy; sync-now in-place toast + run deep-link.
- Command palette (single listener, explicit search fallback); mobile
  master→detail push for Sources; 10.C access contracts (rename, per-token
  drilldown, package count) — settled, do not relitigate.
- Source-scoped credential contracts and identity-echo requirements (A2
  corrections) — load-bearing.

### CHANGE
- **One state authority:** server-derived closed owner state (+ `as_of`,
  posture, owner-of-state); console view-models consume it; wire types shared
  or generated, not hand-mirrored (`ref-client.ts`).
- **Evidence age:** frozen defect verdicts render "last run found X (Nd ago)"
  + re-check affordance where owner-runnable.
- **Headline counts:** derive from the same server predicate as the lists.
- **Paused/refresh-due:** emit the missing `reattach_schedule`/`refresh_now`
  actions; paused sources state pause semantics (no scheduled runs until
  resume; manual sync still available) with one consistent copy.
- **Recovery/detail page:** one cause, one action, one banner (today the same
  verdict renders twice); axes and diagnostics behind an advanced disclosure;
  per-stream blast radius one-liner for mixed-stream sources ("3 of 5 streams
  collecting; 1 needs a code fix" — GitHub-Actions-matrix pattern).
- **Every CTA honest:** performs its verb or routes to a subject-scoped
  surface that can (generalize the OwnerActionSurface discipline to all
  actions; hide capability-derived no-op buttons like push-collector "Run").
- **Long-running ops:** run-lifecycle live-status contract on every branch
  (the chatgpt-green audit found a branch without the poller); progress shown
  as movement + position (Fivetran date-cursor pattern) not fabricated
  percentages.
- **Add-data journey:** "Add source" promoted to a primary header action;
  second connection for an existing connector supported; completed runs show a
  plain receipt ("N records across M streams").
- **Timestamps:** one canonical component (fix the `IcTimestamp`/`Timestamp`
  fork and the raw `toLocaleString()` bypass).
- **Radius language:** one (square paper + 2px controls); retire stray
  `rounded-full` pill language or formally scope it.
- **Timeline primitive:** one dense scannable event list for grant + audit
  timelines (no accordion-per-row, no overflow/shift).

### DELETE (from owner-facing surfaces, not from the system)
- Console re-derivations: `deriveSourceStatus` raw-state path
  (`sources-view-model.ts:226`), the `source-actionability.ts` parallel
  taxonomy (`SourceStatusKind`/`SourceWorkGroupId`/`VERDICT_TONE_STATUS`/
  `sourceAttentionHeadline`), the legacy client verdict fallback
  (`connection-diagnostics.tsx:480`), `badgeState` in
  `connection-evidence.ts`, the client-only recovery stall threshold.
- Dead code the audit confirmed: `sources/[connector]/actions.ts` dead
  FormData action set (incompatible-signature landmine), `RecordsExplorerView`,
  `ScheduleReadRow`, `KIND_GLYPHS`, orphaned Overview placeholder/error pairs.
- Internal ontology as owner copy: verdict/axis chip rows as primary UI,
  "Deprecated alias", "Connector instance ID", "PG Lexical Backfill",
  "Context Mode", "sink", hard-coded agent names, "Suppressed evidence /
  Drain detail-gap backlog" phrasing.
- Space-wasting Explore chrome and advertised caps ("capped at 32" — replace
  with pagination, don't advertise the cap).

## What this explicitly does NOT restart

- 10.A–10.D (routes, brand, palette, access contracts): landed and accepted
  2026-07-03; only the 10.D.8 evidence archive remains.
- The Runs/Syncs and Explore/stream merge decisions (tasks 2.5/2.6): still
  owner-gated; nothing here forecloses them.
- Active point changes that already own their defect:
  `fix-detail-gap-locator-identity` (the gap-identity bug that makes green
  unreachable — highest-value data fix, already chartered),
  `define-stream-coverage-freshness-evidence` (coverage/freshness strategy
  contract), `show-sync-start-feedback`, `fix-source-control-deadends`,
  `complete-connection-repair-action-surfaces`, `use-connection-scoped-
  scheduler-history`, `add-owner-notifications-surface`. Wave 10 sequences
  with them; it does not duplicate them.

## Verification appendix (director-checked before acceptance)

- `sources-view-model.ts:226` `deriveSourceStatus` derives from raw state;
  `:184 HEALTHY_STATES = new Set(["healthy","idle"])` — verified by grep.
- `sourceAttentionHeadline` recomputes the needs-you count console-side
  (`source-actionability.ts:134`) — verified.
- `reattach_schedule` occurs exactly once in `rendered-verdict.ts` (union
  declaration `:116`, never emitted) — verified.
- `synthesizeConnectionVerdict` legacy client fallback at
  `connection-diagnostics.tsx:480` — verified.
- Recovery page double-verdict render — verified visually
  (`full-spine-atlas-20260701/source-recovery-desktop.png`).
- Frozen-verdict evidence (USAA 23d, Chase stale red) — from
  `2026-07-09-owner-operating-reset/{usaa,chase}-macro-lane-report.md` and
  `2026-07-09-instance-health/*` (primary workstream evidence).

## Prior-art anchors added this pass

See `docs/research/owner-console-operator-prior-art-gaps-2026-07-09.md`:
home-server operator consoles (Home Assistant Repairs vs System Health;
Start9 every-check-carries-an-action; Tailscale machine health) independently
never collapse "configured / credential valid / data fresh" into one boolean;
Fivetran/Airbyte long-sync progress (date-cursor over fabricated percentage;
explicit pause semantics); Plaid update mode as the one-affordance reconnect
(GoCardless as the cautionary wrong-object-refresh counterexample); GitHub /
Statuspage status hierarchies (aggregate status as a provable cascade function
of child states — the acceptance-test framing for headline counts).
