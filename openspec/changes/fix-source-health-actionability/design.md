## Design

The server owns source health semantics. The console may choose layout, but it must not recover from contradictory server verdicts by inventing independent state. This change keeps the fix in the verdict/actionability layer:

- A non-owner `wait` action is valid only when the system is actually handling the work: active run, source-pressure cooldown, or queued recovery with a retry floor.
- A failed/backed-off owner-runnable source is not “collecting”; it should surface a retry action or the true blocker.
- Historical recovered detail gaps are useful progress evidence, but they are not current activity. They must not force `deferred` progress mode after a later failed run.
- Active-run evidence must be derived from durable active-run/read-model evidence, not only from schedule metadata that can be stale or absent.

## Acceptance Checks

- ChatGPT-like state: latest run failed, scheduler backoff/gave-up, no active run, recovered historical detail gaps. The verdict offers `Retry now` and does not say `Collecting — no action needed`.
- Chase-like state: active run row exists. The source renders as active/syncing or owner-attention if an interaction is open, never idle/not measured.
- Source-pressure cooldown still waits instead of encouraging unsafe repeated syncs.
- Stream coverage with no denominator remains `unmeasured`; the fix does not fabricate per-stream completeness.
- Vana Slack-like state (`idle`, schedule paused, freshness stale, prior successful run) and Amazon-Personal-like state (`idle`, `owner_refresh_due`, `stale_manual_refresh`, prior successful run) both render `amber`/`Needs refresh`/`advisory`, never `green`/`Healthy` and never `amber`/`Degraded`.
- A genuinely never-run connection (`last_success_at` is null, no stale/degrading evidence) is unaffected by this change and stays green (fresh axis) or grey/`Not measured` (unknown axis) — it is not forced amber for lack of evidence.
- Chase-like state (`resumable` disposition, `retryable_gap` coverage) and USAA-like state (`awaiting_owner` disposition, attention open) both keep `amber`/`Degraded`, never `Needs refresh` — these are real collection trouble, not a routine nudge.
- A `degraded`/`needs_attention`/`cooling_off` headline state always keeps `Degraded` regardless of which other axis triggered it, because those states only ever fire on a genuine degrading condition (`classifyDegradedEvidence` et al., `connection-health.ts`) — `idle` is the only state that can be amber-but-not-broken.
- Terminal/unsupported/blocked connections keep the existing `red`/`Can't collect` label, unaffected by the amber-label split.

### Superseded design note

The original `redesign-connection-health-verdict-and-recovery` design (archived
2026-06-17) deliberately chose `green/advisory` for stale-manual/`owner_refresh_due`
connections (D1, "Amazon-stale is `green / advisory`") to keep `tone` and `channel`
orthogonal and avoid "every non-green visibly alarms" fatigue. Live owner feedback
on `pdpp.vivid.fish` (2026-07-09) showed this reads as a false-positive `Healthy`
pill on connections that are not current and need an owner nudge (paused schedule,
stale manual refresh). This change keeps the `tone`/`channel` orthogonality (D1) —
`channel` stays `advisory`, never `attention`, so the connector is not misread as
broken and the owner is not interrupted — but moves the `tone` itself to `amber`
for connections that have run before and are no longer current. The distinguishing
signal is `last_success_at`: null means "no evidence yet" (stays green/grey);
non-null with stale/idle/`owner_refresh_due` evidence means "was healthy, is not
current now" (amber).

### Amber label split — `Needs refresh` vs `Degraded`

A first amber-tone-only fix (reusing the existing `Degraded` label for every amber
case) shipped ahead of this note and overstated connector failure for the
not-actually-broken idle/stale/`owner_refresh_due` cases — a stale manual
connector "works fine, just hasn't been run" reads very differently from a
connector with a stuck coverage gap. This revision adds a fourth `VerdictLabel`,
`"Needs refresh"`, reserved for amber verdicts where every contributing reason is
one of the not-actually-broken shapes:

- headline `state === "idle"` (never any other state — `degraded`/
  `needs_attention`/`cooling_off` only fire on a genuine degrading condition, so
  they always keep `Degraded`),
- `freshness === "stale"`,
- `forward_disposition === "owner_refresh_due"` (never `resumable`/
  `awaiting_owner`, which only ever arise from an outstanding coverage gap per
  `deriveForwardDisposition`).

Any `coverage`/`attention`/`outbox` axis reaching amber-or-worse — a real stream
gap, open owner attention, or a stalled outbox — keeps `Degraded`, matching the
Chase (`resumable`/`retryable_gap`) and USAA (`awaiting_owner`/attention-open)
golden cases. `channel` is unaffected by this split; it stays `advisory` for both
labels. The label decision (`amberLabel` in `rendered-verdict.ts`) reads the same
per-axis tone inputs and the same `disposition`/`state` values the tone rollup
already computed — no second, independently-derived classification.

### Console copy bridge — `sourceIssueStatus` keys off `pill.label`, not `tone`

The server-side label split (above) does not by itself fix the owner-visible
copy: `apps/console/src/app/(console)/lib/source-actionability.ts` derives its
own work-group taxonomy and copy from the rendered verdict, and its
`sourceIssueStatus`/`sourceWorkItemFromConnector` fallthrough branch keyed on
`verdict.pill.tone === "amber"` — which still matches `Needs refresh` — and
routed to the `systemIssue` group ("System or connector issue" / "PDPP needs to
fix or retry this; no account action is needed from you"). That group copy is
false for a `Needs refresh` connection: the owner IS the one who can act
(resume the schedule, run a refresh), and nothing about the connector is
broken. This is reachable whenever a `Needs refresh` verdict has no
required-action wired up yet — e.g. an owner-paused schedule with no other
stale signal, which the rendered-verdict layer does not currently emit a
`reattach_schedule` action for (a real gap, but out of scope for this
console-copy fix; a future change should wire that action).

Fixed by keying `sourceIssueStatus`'s amber branch on `verdict.pill.label`
first: `label === "Needs refresh"` now short-circuits to the copy string
`"needs a refresh"` before the generic `tone === "amber" || label ===
"Degraded"` branch. `sourceWorkItemFromConnector` also routes a `Needs refresh`
status to the `review` group ("Available actions" / "Optional refreshes and
retries you can start") instead of `systemIssue`, matching how a
`refresh_now`-bearing verdict is already routed earlier in the same function.
A `Degraded` verdict without a wired owner action (e.g. maintainer-only
`code_fix`) is unaffected and still routes to `systemIssue` with `"is
degraded"` copy.
