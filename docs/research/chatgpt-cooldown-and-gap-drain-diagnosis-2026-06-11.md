# ChatGPT cooldown + gap-drain diagnosis (2026-06-11, live)

Diagnosis of why the live ChatGPT connection (run_1781188440730) shows
`blocked / Reconnect / next attempt in 15h` while simultaneously showing
`in progress` and `succeeded_with_gaps`, and why coverage is not reaching 100%.

## Live evidence (Postgres `pdpp`, 2026-06-11 ~14:40Z)

Recent scheduled runs — **all `skipped`, all `source_pressure_cooldown_applied`**,
NO `failed` runs in recent history:

```
skipped  source_pressure_cooldown_applied: 52 pending ... persistence 2; next attempt at 2026-06-11T18:34Z
skipped  source_pressure_cooldown_applied: 174 ... persistence 3
... (persistence was 16 at 02:40Z, now down to 2 — governor IS relaxing)
```

Pending gap breakdown (`connector_detail_gaps`, status=pending):

| reason | status | count | max_attempt | has next_attempt_after |
|---|---|---|---|---|
| `retry_exhausted` | pending | **964** | 0 | NO (NULL) |
| `upstream_pressure` | pending | 51 | 2 | — |
| `rate_limited` | pending | 1 | 2 | — |
| `retry_exhausted` | recovered | 795 | 17 | — |
| `upstream_pressure` | recovered | 709 | 17 | — |

## Two governors (both real, only one should drive the headline)

- **Governor A — source-pressure cooldown** (`scheduler-source-pressure-cooldown.ts`):
  reacts to `rate_limited`/`upstream_pressure` gaps, **caps at 6h**, **always
  recommends `cooling_off`, NEVER `blocked`**, relaxes as gaps recover. THIS IS
  THE SLVP-IDEAL MECHANISM AND IT IS WORKING (persistence 16→2, next attempt 4h
  out, not 15h).
- **Governor B — failure back-off ladder** (`scheduler-backoff.ts`): counts
  `failed` runs, escalates `[30s,2m,10m,1h,6h,24h]` toward `blocked`/`gave_up`/
  Reconnect. **NOT firing** — there are zero recent `failed` runs.

## Bug 1 (UI projection): `blocked`/Reconnect/15h is a MISLABEL

The live state is `cooling_off` (Governor A). The dashboard headline is rendering
it as `blocked` ("credentials expired … Reconnect", `connection-evidence.ts:1629`)
and showing `blocked` + `in progress` + `succeeded_with_gaps` **simultaneously**.
A rate-limited-but-succeeded connection must render `cooling_off`
(`connection-evidence.ts:1613` `isSourcePressure` branch), never `blocked`.
Root: the headline projection reads a stale/failed-shaped record instead of the
current cooling-off state, and does not reconcile against the in-flight run.

## Bug 2 (THE convergence bug): 964 `retry_exhausted` pending gaps are stranded

`retry_exhausted` is emitted by the **`run_cap_deferred`** path
(`chatgpt/index.ts:2475`) — the OPT-IN cap deferral — yet the live caps are OFF.
These 964 gaps have `attempt_count=0` and `next_attempt_after=NULL`.

- `retry_exhausted` is **NOT** in `SOURCE_PRESSURE_GAP_REASONS`
  (`scheduler-source-pressure-cooldown.ts:53` = only `rate_limited`,
  `upstream_pressure`). So Governor A ignores them — correct, they're not source
  pressure.
- BUT every scheduled tick is being **`skipped` for cooldown** on the 51
  `upstream_pressure` gaps. The cooldown defers the WHOLE dispatch
  (`isSourcePressureCooldownDeferring` gates the launch), so the recovery lane
  that WOULD drain the 964 `retry_exhausted` gaps (`listPendingGaps` selects all
  pending regardless of reason) **never runs**.
- Net: 51 source-pressure gaps hold 964 non-pressure gaps hostage. Coverage
  cannot reach 100% while any source-pressure gap keeps re-arming the cooldown.

### Open question for the fix
Where did 964 `retry_exhausted`/attempt-0 gaps come from with caps OFF? Either
(a) a prior run when a cap WAS set, or (b) another path emits `retry_exhausted`.
Must confirm before fixing so the fix addresses the real emitter.

## Fix directions (for lanes, not yet implemented)

1. **UI reconciliation (Bug 1):** headline must never show `blocked` when the
   live state is cooling_off / a run is in progress. Map source-pressure cooldown
   → `cooling_off` pill + "resumes automatically", drop Reconnect CTA. Add an
   invariant test forbidding simultaneous `blocked` + `in_progress`/`succeeded`.
2. **Gap-drain decoupling (Bug 2):** a cooldown driven by source-pressure gaps
   must NOT block the recovery of non-pressure (`retry_exhausted`) gaps. Options:
   (a) let the recovery lane drain non-pressure gaps even while the source-pressure
   cooldown defers NEW forward-walk fetches; (b) re-classify the stranded gaps;
   (c) confirm the emitter and stop producing `retry_exhausted` when caps are off.
3. **Confirm Governor A numbers are the SLVP ideal:** 6h cap, 2^attempt growth.
   Likely fine; verify the cap and growth match the researched ideal.
