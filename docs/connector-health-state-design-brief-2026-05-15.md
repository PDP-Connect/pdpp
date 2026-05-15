# Connector Health State — Design Brief & Data-Layer Implementation Packet

**Date:** 2026-05-15
**Author:** Reference-implementation owner
**Status:** Decided. Ready for data-layer implementation.
**Companion:** `docs/connector-health-state-research-2026-05-15.md` (Worker E)
**Related code:** `reference-implementation/runtime/scheduler-backoff.ts` (Worker C, commit `1b3e09c`)

---

## 0. Purpose

Convert Worker E's research into an executable plan. The dashboard UI work is **out of scope** — that gets a separate design-driven workstream with mocks and visual review. This brief covers only the data-layer changes required to *support* the UI: the canonical state machine, the `display_message` plumbing, the `cooling_off → blocked` promotion, and the spine event additions.

The discipline: **everything the UI ever needs to render a connector health pill must be derivable from spine events and `RunRecord` history without the UI inventing semantics on the fly.** If the UI is computing `consecutiveFailures` by scanning rows, the data layer is wrong.

---

## 1. Decisions (adopted from Worker E research)

The following are decided. No further design loops.

### 1.1 Six-state taxonomy

```
healthy ──┬─► degraded ──┬─► needs_attention ──┬─► cooling_off ──► blocked
          │              │                     │
          └──────────────┴─── (clean run) ─────┴─────── healthy
                            (success transitions back to healthy or degraded)
```

Plus `idle` as the empty/paused/never-run state, reachable from any state on user action.

- **`healthy`** — last run `succeeded`, no `known_gaps`
- **`degraded`** — last run `succeeded_with_gaps`
- **`needs_attention`** — assistance event raised; runtime paused waiting on user
- **`cooling_off`** — scheduler back-off active after N consecutive same-reason failures
- **`blocked`** — scheduler has given up (back-off ceiling crossed, hard fatal, or revoked creds)
- **`idle`** — never run, user-paused, or deleted

Worker E §4 fully specifies entry/exit conditions. Adopt verbatim.

### 1.2 Plaid 3-layer copy model

Every connector reason code carries three messages, propagated through the spine:

| Layer | Field | Audience | Example |
|---|---|---|---|
| Machine | `reason_code` | Engineers, audit log | `reddit_login_unexpected_ui` |
| Engineer | `reason_message` | Logs, debug surfaces | "Reddit's login challenged with an unexpected UI shape" |
| End-user | `display_message` | Dashboard pill, toasts | "Reddit is asking for extra verification" |

`display_message` is owner-vetted per reason class, stored in a single source-of-truth registry. UI **never** synthesizes its own copy from `reason_code`.

### 1.3 `cooling_off → blocked` auto-promotion

Worker E §9 logged this as needing owner approval. Decided: **yes, promote.**

**Threshold: 7 consecutive same-class failures** triggers `blocked`. Rationale:
- Worker C's back-off curve plateaus at 24h. A connector hitting `consecutiveFailures = 7` has been failing daily for at least a week — it's not "cooling off," it's broken.
- 7 covers the typical "owner stopped paying attention for a workweek" gap without being so impatient that a transient outage (3-day cloud incident) flips a connector to red.
- The number is exposed as a config constant; not a runtime tunable, but easy to change if data argues otherwise.

Once `blocked`, the scheduler **stops scheduling automatic attempts**. Manual `runNow` is still available and a successful manual run transitions back to `healthy`.

### 1.4 Back-off pill spec (adopted verbatim from Worker E §7)

- Amber background, clock icon
- Primary: "Paused — retrying in 32m" (always finite duration)
- Secondary: "12 attempts in a row failed with the same problem. Last try 14m ago."
- CTA: "Try now"
- No sparkline on card; reserved for expanded view
- Expander shows `reason_code` in monospace + `display_message` in prose

### 1.5 Recovery toast on `cooling_off → healthy` and `blocked → healthy`

One-shot, dismissable, mirrors Plaid `LOGIN_REPAIRED`:
> "Reconnected — catching up on missed data."

Computed client-side from the transition between two consecutive spine events. No persistent badge.

---

## 2. Open items deferred (with rationale)

These are explicitly **not** in this brief's scope:

- **7-day expiring-consent warning (`PENDING_DISCONNECT` analogue)** — needs forward-looking consent expiry tracking that doesn't exist yet. Future workstream. Worker E §8 decision 9.
- **"Reset back-off without running" affordance** — needs a controller endpoint Worker C didn't add. Future. Worker E §9 item 5.
- **3-presses-per-slot cap on "Try now"** — UI-only debounce, no data-layer concern. Worker E §9 item 4.
- **Dashboard rendering itself** — separate design pass with mocks and visual review. Reuses this brief as data contract.

---

## 3. Data-layer implementation packet

### 3.1 Files to add

```
reference-implementation/runtime/connector-health.ts            # State machine + state classifier
reference-implementation/runtime/display-messages.ts            # Reason-code → display_message registry
reference-implementation/test/connector-health.test.js           # State classifier unit tests
reference-implementation/test/display-messages.test.js           # Registry completeness tests
```

### 3.2 Files to modify

```
reference-implementation/runtime/scheduler-backoff.ts            # Add blocked-promotion threshold check
reference-implementation/runtime/scheduler.ts                    # Emit schedule.gave_up on transition
reference-implementation/server/queries/                         # No schema changes — see §3.5
```

### 3.3 State classifier

`connector-health.ts` exposes a pure function:

```ts
type HealthState =
  | "healthy"
  | "degraded"
  | "needs_attention"
  | "cooling_off"
  | "blocked"
  | "idle";

interface HealthSnapshot {
  state: HealthState;
  reason_code: string | null;
  display_message: string | null;
  consecutive_failures: number;
  next_attempt_at: string | null;  // ISO
  last_success_at: string | null;
  manual_paused: boolean;
}

function computeConnectorHealth(input: {
  recentRuns: RunRecord[];        // newest first, bounded e.g. 50
  schedule: ScheduleRow | null;
  activeAssistance: AssistanceEvent | null;
  backoffState: BackoffState | null;  // from scheduler-backoff.ts
}): HealthSnapshot;
```

Rules (decision order):

1. `manual_paused` (schedule disabled by user) → `idle` with `manual_paused: true`
2. No `recentRuns` at all → `idle`
3. `activeAssistance != null` → `needs_attention` (uses assistance event's `reason_code`)
4. `backoffState.consecutiveFailures >= BLOCKED_PROMOTION_THRESHOLD` (7) → `blocked`
5. `backoffState.backoffApplied === true` → `cooling_off`
6. `recentRuns[0].outcome === "succeeded_with_gaps"` → `degraded`
7. `recentRuns[0].outcome === "succeeded"` → `healthy`
8. `recentRuns[0].outcome === "failed"` (no back-off applied yet) → `degraded` if next scheduled attempt < normal cadence + grace, else `cooling_off`/`blocked` per (4)/(5)

`display_message` is always populated when `reason_code` is non-null; falls back to "Connector ran into a problem we don't yet know how to describe" (loud-and-honest) if registry has no entry.

### 3.4 Display-message registry

`display-messages.ts` exports a `Record<string, string>` keyed by `reason_code`. From Worker E §6.3, the day-one entries:

```ts
export const DISPLAY_MESSAGES: Record<string, string> = {
  reddit_login_unexpected_ui:    "Reddit is asking for extra verification",
  chatgpt_login_unexpected_ui:   "ChatGPT needs you to sign in again",
  cloudflare_challenge:          "Cloudflare is checking it's really you",
  manual_action_required:        "Action needed to continue",  // see assistance.kind for more specific
  succeeded_with_gaps:           "Some data couldn't be collected",
  controller_restarted:          "We restarted in the middle — we'll try again",
  consent_expiring_soon:         "Your sign-in will expire soon",
  // ... grow as connectors raise new reasons
};
```

**Honesty bar:** the registry test (`display-messages.test.js`) asserts that every `reason_code` emitted by any connector in the catalog has a registered display message. If a connector raises an unregistered code, the test fails loudly. This is the SLVP equivalent of Plaid's "every error_code has a vetted display_message" discipline.

### 3.5 Scheduler back-off extension

`scheduler-backoff.ts::computeNextRunWithBackoff` already returns `{ backoffApplied, consecutiveFailures, effectiveIntervalMs, nextRunAt, reasonClass }`. Extend the return type:

```ts
recommendedHealthState: "cooling_off" | "blocked";
```

Logic: `consecutiveFailures >= BLOCKED_PROMOTION_THRESHOLD` returns `"blocked"`; otherwise `"cooling_off"`.

When `recommendedHealthState === "blocked"` and the prior state was `cooling_off`, `scheduler.ts` emits a one-time `schedule.gave_up` spine event with `{ reason_class, final_consecutive_failures, last_success_at }`. The same announce-once pattern as the existing back-off skip record (use a `announcedBlockedClass` map).

When `recommendedHealthState === "blocked"`, the scheduler **stops scheduling** new attempts (`shouldRun` returns false unless `manualBypass`). Manual `runNow` still works.

A successful run resets `announcedBlockedClass` so a future degradation can re-promote.

### 3.6 Spine event additions

Three new event types, all driven from the scheduler runtime (no protocol or schema change required — these slot into the existing `spine_events` table as new `event_type` values):

| Event | Emitted when | Payload |
|---|---|---|
| `schedule.back_off.started` | First skip in a streak | `{ reason_class, consecutive_failures, next_attempt_at }` |
| `schedule.back_off.cleared` | Streak resets via successful run | `{ resumed_at }` |
| `schedule.gave_up` | `cooling_off → blocked` transition | `{ reason_class, final_consecutive_failures, last_success_at }` |

These replace nothing; they augment the existing skip-record-on-spine that Worker C already emits. The skip record continues to fire every tick during back-off; these three are one-shot transition markers. The UI uses transitions for toasts and history banners.

### 3.7 No DB schema changes

The brief explicitly avoids schema migrations:

- `spine_events` already accepts arbitrary `event_type` values.
- `RunRecord` history already carries `connector_error.reason`, `terminal_reason`, `failure_reason` — Worker C's classifier consumes these.
- `manual_paused` is derivable from existing `schedules.enabled` column.
- No new tables.

This is intentional. Schema changes belong in OpenSpec and require a different process per handoff §24.

---

## 4. Validation

### 4.1 Unit tests

`connector-health.test.js`:
- All 6 states reachable from minimal inputs
- Decision-order precedence (manual_paused over assistance over backoff over outcome)
- `display_message` always populated when `reason_code` present
- Fallback when registry entry missing
- `blocked` requires `consecutiveFailures >= 7`
- `cooling_off → blocked` boundary at exactly 7 (boundary test)
- Mixed-reason streak does NOT promote to blocked (different from same-class)

`display-messages.test.js`:
- Registry contains entry for every reason code emitted by any connector in the catalog (scans `packages/polyfill-connectors/connectors/*/index.ts` for known emission sites)
- No empty strings
- No bare reason codes leaking in (registry values should not equal their keys)

### 4.2 Integration

- Existing scheduler tests still pass (`reference-implementation/test/scheduler-backoff.test.js` + new transitions)
- Add an integration test that drives a connector through `healthy → cooling_off → blocked → healthy` and verifies the spine event sequence

### 4.3 The 7 pre-existing failing tests in `browser-surface-leases.test.js` are NOT this brief's concern (they pre-dated Worker C and remain a separate issue).

---

## 5. Worker packet (for the implementation worker)

```
Title: Worker G — connector health-state data layer
Scope: §3 of this brief, end-to-end. Read this brief fully before starting.
       Read scheduler-backoff.ts (commit 1b3e09c) and the existing scheduler tests
       so the implementation matches the existing style.
Anti-requirements:
  - No UI changes
  - No DB schema migrations
  - No protocol changes / OpenSpec
  - No new connector code
  - Do NOT touch packages/polyfill-connectors/
Validation: §4 of this brief
Output: tmp/workstreams/worker-g-connector-health-data-layer-report.md
         Final line: WORKER_G_CONNECTOR_HEALTH_DATA_LAYER_READY_FOR_OWNER_REVIEW
```

---

## 6. After this lands

1. UI design workstream begins: mocks for all 6 states across catalog cards + connector detail page + timeline. Reuses this brief as the data contract.
2. UI implementation workstream lands the cards/pill/expanded view consuming `computeConnectorHealth()`.
3. Real-traffic shakedown: catalog audit run with the new health surface; verify the Reddit `cooling_off → blocked` promotion actually fires after the 7-day threshold (will need 7 days unless we time-skip in test mode).
4. If `display_message` registry grows quickly, consider promoting `display-messages.ts` from a runtime const to a JSON file co-located with the manifests so connectors can ship their own copy.

---

## Appendix — what this brief does NOT decide

- Whether to expose the streak count in the API (yes, via `HealthSnapshot.consecutive_failures` — but the API shape isn't in this brief).
- The exact CSS / animation timing for the pulse on `needs_attention`.
- Whether the "Reconnected — catching up" toast has a CTA or is purely informational.
- Whether `display_message` is i18n-pluggable on day one (no — single-locale for now; plug-in shape can be retrofitted).
- Whether `blocked` connectors are sorted to the top of the catalog (yes probably; UI concern).

These are all UI-side decisions or future work, not data-layer decisions.
