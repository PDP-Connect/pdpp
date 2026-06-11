# Tasks: generalize-adaptive-collection-governor

## 1. Make adaptive collection the default in the shared governor

- [x] 1.1 Add shared constants `DEFAULT_PACING_INITIAL_INTERVAL_MS = 1000`
  (slow-start discovery seed) and `DEFAULT_PACING_MIN_INTERVAL_MS = 250` (the one
  owner number — the rate ceiling), exported from `connector-http-governor.ts`.
- [x] 1.2 Default `pacingInitialIntervalMs` / `pacingMinIntervalMs` to those
  constants so a bare `createConnectorHttpGovernor({ name })` yields adaptive
  pacing; keep `pacingInitialIntervalMs: 0` as the explicit opt-out (no-pacing,
  byte-identical pre-convergence path, `snapshot() === null`).
- [x] 1.3 Add tests proving the bare governor cold-starts at the discovery seed,
  ACCELERATES under sustained success toward the ceiling, BACKS OFF on a throttle
  (legible in the snapshot), and never crosses the ceiling.

## 2. Warm-start runtime seam (persist learned rate across runs)

- [x] 2.1 Add the `restoredIntervalMs` option to `createConnectorHttpGovernor`
  (seed `ProviderPacing` warm-started, clamped to the ceiling).
- [x] 2.2 Expose `snapshot(): PacingSnapshot | null` on the returned governor.
- [x] 2.3 Add shared helpers `readPersistedPacingInterval(stateSlice, opts)`
  (restore + staleness guard), `buildPacingStateFields(governor, opts)`
  (persist), with default state keys + a derived staleness window.
- [x] 2.4 Tests: warm-start round-trip (a run persists; the next restores),
  stale-discard, absent/malformed → cold start.

## 3. Six API connectors inherit adaptive behavior with no per-connector rate code

- [x] 3.1 Confirm the adoption smoke (github/ynab/notion/strava/oura/spotify)
  still throws `<name>_rate_limited` byte-identically under default-on pacing.
- [x] 3.2 Confirm each connector's full suite stays green and FAST (instant-timer
  the one suite — github index — that exercises the real `gh()` pacing path).
- [x] 3.3 Wire github as the reference warm-start adoption: re-seed the governor
  from `state.user` at run start; persist the FINAL learned interval onto the
  declared `user` stream cursor at run end (a real cursor — the runtime gates STATE
  on declared streams, so warm-start state never rides a synthetic stream).

## 4. collection_rate observability for all governor-using connectors

- [x] 4.1 Add `buildCollectionRateProgress(governor)` returning the
  `CollectionRateProgress` shape (carries only rate numbers + last back-off reason,
  no account content), or `null` when pacing is opted out (honest absence).
- [x] 4.2 Emit `collection_rate` from github via the shared helper; it flows
  through the existing runtime→spine→console path with no new UI.
- [x] 4.3 Test: the bare governor's snapshot yields legible rate state with no
  account-content leakage; opting out yields `null` (no false zero).

## 5. New-connector experience documented

- [x] 5.1 Document in the governor module header: "to add an API connector with
  fastest-safe adaptive collection, call `createConnectorHttpGovernor({ name })`
  — discovery, warm-start, back-off, and observability are automatic," and make
  that true.
- [x] 5.2 Note in the module header that browser-bound connectors and reddit are
  Phase B and do NOT use this factory.

## 6. Gates

- [x] 6.1 chatgpt suite green (controller path untouched; 155/155).
- [x] 6.2 All six API connector suites green (144/144).
- [x] 6.3 governor / pacing / budget / send-governor / adoption suites green,
  with the adaptive-parity tests proving accelerate-under-success.
- [x] 6.4 `tsc --noEmit` clean; biome/ultracite clean on changed files.
- [x] 6.5 openspec change validates `--strict`.
