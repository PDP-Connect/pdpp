# Per-Connector Rate Profiles (WI-1b behavioral audit)

**Date:** 2026-06-13
**Scope:** The six governor-using API connectors (github, notion, oura, spotify,
strava, ynab). Replaces each connector's `unauditedConservativePacingProfile()`
1000ms placeholder with an **audited** per-provider pacing ceiling traced to that
provider's documented rate limit.
**Spec basis:** `docs/research/slvp-ideal-whole-system-spec-2026-06-11.md` §3
(ProviderProfile — each connector declares from ITS OWN observed behavior; no
shared default), §9-C5 (the per-connector audit closing the single-provider
validation gap).
**OpenSpec task:** `generalize-adaptive-collection-governor` task 7b.

ChatGPT is **out of scope** — it is fully audited on a separate factory
(`ProviderBudgetController`, `pacingMinIntervalMs=250` / `maxRecoveryAttempts=3`
/ `maxCooldownCycles=8`) and is not touched by this work.

---

## What `pacingMinIntervalMs` is (and the SLVP derivation rule)

`pacingMinIntervalMs` is the **rate ceiling**: the *fastest* inter-request
interval (= maximum sustained rate) the adaptive AIMD loop may ever reach. The
controller slow-starts well below it and only accelerates toward it under
sustained success; it backs off multiplicatively on any 429 / Retry-After.

**The SLVP principle (§3):** the ceiling is a **safety prior**, so it is set
**at or below the provider's documented sustained rate**, never at it. That way
even a fully-accelerated controller cannot exceed the provider's budget; the
documented limit is the wall, the ceiling is the speed limit we drive under it.

For long-window providers (Strava 15-min, YNAB 1-hour) the binding constraint is
the **window sustained average**: the ceiling is set at/below that average so a
sustained run can never drain the window budget faster than it refills. For
short-window / high-quota providers (GitHub, Notion, Oura, Spotify) the ceiling
sits at 24–72% of the documented sustained rate.

All six connectors are **single-threaded (concurrency 1)** and **read-only** (no
content-generating / upload endpoints), which is why the read/primary limit — not
the upload or content-creation secondary limits — is the binding axis.

---

## Per-connector derivations

### github — `1000ms` (60 req/min)

- **Documented limit:** 5,000 requests/hour for authenticated users (personal
  access token). Secondary limits: max 100 concurrent requests (we run 1); max
  80 *content-generating* requests/min and 500/hr (we make **none** — read-only);
  "no more than 900 points/min to a single endpoint". On exhaustion GitHub
  returns 403/429 with `x-ratelimit-remaining: 0` and `retry-after`.
  Source: <https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api>
- **Doc sustained:** 5000/hr = 1.389 req/s = **720ms** min interval at the limit
  (~83 req/min).
- **Chosen ceiling:** `1000ms` (60 req/min) = **72% of the 83/min primary
  ceiling**. Comfortably under the primary 5000/hr; the read-only profile is far
  under every secondary limit. (Coincidentally equal to the old placeholder, but
  this is now a *declared* GitHub value derived from 5000/hr, not a borrow.)

### notion — `500ms` (120 req/min)

- **Documented limit:** "an average of three requests per second" per
  integration; bursts beyond the average are allowed. 429 (`rate_limited`) and
  529 (`service_overload`) responses carry `Retry-After` (integer seconds).
  Source: <https://developers.notion.com/reference/request-limits>
- **Doc sustained:** 3 req/s = **333ms** min interval at the limit (180 req/min).
- **Chosen ceiling:** `500ms` (120 req/min) = 2 req/s = **67% of the documented
  3 req/s average**. Sits under the *average* (not just the burst peak), leaving
  the documented burst slack as headroom. A real tightening from the 1000ms
  placeholder.

### oura — `250ms` (240 req/min)

- **Documented limit:** "The API V1 and V2 API are rate limited to **5000
  requests in a 5 minute** [period]" (= 16.67 req/s); 429 on exceed. No separate
  documented per-day cap. (The connector's old "5000/day" header comment was
  wrong — corrected here.)
  Source: <https://cloud.ouraring.com/docs/error-handling>
- **Doc sustained:** 5000/5min = 16.67 req/s = **60ms** min interval at the limit
  (~1000 req/min).
- **Chosen ceiling:** `250ms` (240 req/min) = 4 req/s = **24% of the documented
  16.67 req/s ceiling** — a deliberate 4× safety margin. We do **not** push to
  the 60ms hardware ceiling: single-account daily-grain wellness data does not
  need 1000 req/min, and the wide margin protects against any undocumented
  per-account throttle. Still 4× faster than the placeholder.

### spotify — `500ms` (120 req/min)

- **Documented limit:** Spotify computes the limit over a **rolling 30-second
  window** and **does not publish the exact request count** (it differs between
  development mode and extended-quota mode). On exceed it returns 429 with a
  `Retry-After` header (seconds). The commonly-observed development-mode figure
  is ~180 req/min.
  Source: <https://developer.spotify.com/documentation/web-api/concepts/rate-limits>
- **Doc sustained (practical):** ~180 req/min = 3 req/s = **333ms** at the cited
  rate.
- **Chosen ceiling:** `500ms` (120 req/min) = **67% of the commonly-cited
  180/min**. Margin-heavy *on purpose* because the true limit is undisclosed; the
  connector honors `Retry-After` on 429 and the runtime cooldown catches any
  over-budget surprise. Faster than the placeholder, still conservative.

### strava — `10000ms` (6 req/min)

- **Documented limit:** Per-application 15-minute + daily limits. The PDPP
  connector reads only **non-upload** endpoints, whose **default** limit is
  **100 requests / 15 min** and **1,000 / day**. (The overall default is 200/15min
  + 2,000/day, but that includes upload endpoints we never call.) 15-min windows
  reset at natural :00/:15/:30/:45 boundaries; 429 + `X-RateLimit-Limit` /
  `X-RateLimit-Usage` headers. "Continuing to make requests while rate limited may
  result in banning."
  Source: <https://developers.strava.com/docs/rate-limits/>
- **Doc sustained (binding short window):** 100 req / 15 min = 0.111 req/s =
  **9000ms** min interval (~6.67 req/min).
- **Chosen ceiling:** `10000ms` (6 req/min) — set **below the 6.67/min 15-minute
  sustained rate** so a fully-accelerated controller can never drain the 100-req
  window budget faster than it refills. This is the most conservative of the six
  by design: Strava's short window is the tightest budget and its ban warning is
  explicit. A real owner sync (activities paginate 200/page; even 1,000 activities
  is ~5 requests) finishes in well under a minute regardless, so the slow ceiling
  costs nothing on the realistic workload while guaranteeing window safety on a
  pathological one.

### ynab — `20000ms` (3 req/min)

- **Documented limit:** "An access token may be used for up to **200 requests per
  hour**", enforced over a **rolling one-hour window**; 429 (`too_many_requests`)
  on exceed.
  Source: <https://api.ynab.com/> (Usage → Rate Limiting)
- **Doc sustained:** 200/hr = 0.0556 req/s = **18000ms** min interval (~3.33
  req/min).
- **Chosen ceiling:** `20000ms` (3 req/min) — set **below the 3.33/min hourly
  sustained rate** so even a long run cannot exceed the 200/hr budget at the
  ceiling. A typical YNAB run is only tens of requests (~7×budgets plus one per
  walked month — historical months are frozen and not refetched), so it completes
  in a minute or two and stays far under 200/hr; the conservative ceiling only
  binds a pathological multi-hundred-request run, which YNAB collection never does.

---

## Summary table

| Connector | Documented sustained | At-limit interval | **Chosen ceiling** | Rate | Margin / utilization |
|---|---|---|---|---|---|
| github | 5,000/hr | 720ms (83/min) | **1000ms** | 60/min | 72% of primary |
| notion | 3 req/s avg | 333ms (180/min) | **500ms** | 120/min | 67% of avg |
| oura | 5,000/5min | 60ms (1000/min) | **250ms** | 240/min | 24% (4× margin) |
| spotify | ~180/min (rolling 30s, undisclosed exact) | 333ms (180/min) | **500ms** | 120/min | 67% of cited |
| strava | 100/15min (non-upload) | 9000ms (6.67/min) | **10000ms** | 6/min | below limit |
| ynab | 200/hr | 18000ms (3.33/min) | **20000ms** | 3/min | below limit |

---

## Terminal-gap and cooldown profiles: NONE warranted (honest default)

Both the terminal-gap budget (`maxRecoveryAttempts`, §10-A) and the cross-run
cooldown budget (`maxCooldownCycles`, §10-B) are driven by **detail gaps** — the
terminal classifier runs on `DETAIL_GAP` records, and the source-pressure cooldown
escalation arms only on *pending source-pressure detail gaps*
(`reason ∈ {rate_limited, upstream_pressure}`).

**None of the six emit a source-pressure or recovery-retried gap** — so neither the
§10-A terminal-gap loop nor the §10-B cooldown loop ever runs for them, and the safe
shared defaults are correct. They are simple list-paginating API connectors: a 429
throws `<connector>_rate_limited` which surfaces as a *run-level* retryable failure
(cross-run deferral via each connector's `retryablePattern`), never a
source-pressure `DETAIL_GAP`. (NOTE: github does emit `SKIP_RESULT` coverage markers
— `pr_search_cap_truncated` / `pr_detail_fetch_failed` — but their `reason` is NOT in
`SOURCE_PRESSURE_GAP_REASONS = {rate_limited, upstream_pressure}`, so they never arm
the cooldown, and they carry no per-resource recovery loop, so `maybeTerminateGap`
never fires; the terminal-gap resolver's safe `DEFAULT_TERMINAL_GAP_PROFILE` would
catch one regardless.) This is the structural
difference from ChatGPT, whose private detail endpoint degrades individual
conversations to resumable `DETAIL_GAP` records under pressure.

Therefore:

- **Terminal-gap:** no override warranted. With no detail gaps emitted, the
  terminal classifier never runs for these connectors; the safe
  `DEFAULT_TERMINAL_GAP_PROFILE` (`maxRecoveryAttempts: 5`) applies by
  construction and is never even exercised. Registering an explicit profile would
  be *inventing a terminal policy for a connector that does not emit gaps* — the
  exact thing the §10-A audit warns against.
- **Cooldown:** no override warranted. With no pending source-pressure gaps, the
  §10-B no-progress escalation never arms; the safe `DEFAULT_COOLDOWN_PROFILE`
  (`maxCooldownCycles: 12`) applies by construction. Run-level 429s are handled by
  the scheduler's failure-class back-off, not the gap-driven cooldown.

So the substantive audited output of WI-1b is the **pacing ceiling per connector**;
the terminal/cooldown profiles legitimately stay on the safe shared defaults
(these are NOT §3-rule-6 safety/ban priors — they are terminalization /
no-progress-escalation budgets for which a safe default is correct, see
`terminal-gap-classifier.js` and `scheduler-source-pressure-cooldown.ts`).

If any of these connectors later grows a detail-hydration phase that emits
`DETAIL_GAP` records (e.g. a per-item enrichment endpoint that degrades under
pressure), THAT is the trigger to register an explicit terminal/cooldown profile
derived from the new endpoint's observed recovery behavior.

---

## Validation

Each pacing value traces to the provider's official documentation (URLs above).
Per spec task 7b.3, the new ceilings should additionally be confirmed by a
supervised live run per connector (owner-run) before they are considered
field-proven; this audit derives them from documented limits, which is the
correct conservative starting point (the AIMD only *approaches* the ceiling under
sustained success, so a value derived below the documented rate is safe to ship
ahead of the live confirmation).

### Sources

- GitHub REST API rate limits — <https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api>
- Notion request limits — <https://developers.notion.com/reference/request-limits>
- Oura API error handling (rate limit) — <https://cloud.ouraring.com/docs/error-handling>
- Spotify Web API rate limits — <https://developer.spotify.com/documentation/web-api/concepts/rate-limits>
- Strava API rate limits — <https://developers.strava.com/docs/rate-limits/>
- YNAB API (Usage → Rate Limiting) — <https://api.ynab.com/>
