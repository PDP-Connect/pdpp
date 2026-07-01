# Tasks: generalize-adaptive-collection-governor

## 1. Make adaptive collection the default in the shared governor

- [x] 1.1 Add shared constants `DEFAULT_PACING_INITIAL_INTERVAL_MS = 1000`
  (slow-start discovery seed) and `DEFAULT_PACING_MIN_INTERVAL_MS = 250` (the one
  owner number — the rate ceiling), exported from `connector-http-governor.ts`.
- [x] 1.2 Default `pacingInitialIntervalMs` to the conservative discovery seed
  while requiring a per-provider `profile.pacingMinIntervalMs` for the ceiling;
  keep `pacingInitialIntervalMs: 0` as the explicit opt-out (no-pacing,
  byte-identical pre-convergence path, `snapshot() === null`). Supersedes the
  initial shared-ceiling version of this task.
- [x] 1.3 Add tests proving the minimal profiled governor cold-starts at the
  discovery seed, ACCELERATES under sustained success toward the declared
  ceiling, BACKS OFF on a throttle (legible in the snapshot), and never crosses
  the ceiling.

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
- [x] 4.3 Test: the profiled governor's snapshot yields legible rate state with
  no account-content leakage; opting out yields `null` (no false zero).

## 5. New-connector experience documented

- [x] 5.1 Document in the governor module header: "to add an API connector with
  fastest-safe adaptive collection, call
  `createConnectorHttpGovernor({ name, profile })` — discovery, warm-start,
  back-off, and observability are automatic once the provider-specific ceiling is
  declared," and make that true.
- [x] 5.2 Note in the module header that browser-bound connectors and reddit are
  Phase B and do NOT use this factory.

## 6. Gates

- [x] 6.1 chatgpt suite green (controller path untouched; 155/155).
- [x] 6.2 All six API connector suites green (144/144).
- [x] 6.3 governor / pacing / budget / send-governor / adoption suites green,
  with the adaptive-parity tests proving accelerate-under-success.
- [x] 6.4 `tsc --noEmit` clean; biome/ultracite clean on changed files.
- [x] 6.5 openspec change validates `--strict`.

## 7. ProviderProfile: the safety/pressure quantity is a REQUIRED declaration (spec §3, §9-C5)

> Closes the §3/§9-C5 architectural gap: §1.2 above hoisted ChatGPT's
> `pacingMinIntervalMs=250` as a *shared default*; the spec's bar is the opposite
> — "no shared default for a safety- or pressure-shaped quantity; a missing field
> is a BUILD ERROR, not a silent borrow of ChatGPT's number." This section makes
> the pacing ceiling a REQUIRED per-provider declaration and SUPERSEDES the
> default-fallback in §1.2. (The terminal-gap `maxRecoveryAttempts` and cooldown
> `maxCooldownCycles` slices were already lifted into required per-provider
> profiles in commit 753012ab — §10-A/§10-B; this section completes the set by
> doing the same for the pacing ceiling.)

- [x] 7.1 Add `packages/polyfill-connectors/src/provider-profile.ts` — the ONE
  declared home for the profile field set: `ProviderPacingProfile`
  (`pacingMinIntervalMs`, compile-time required on the governor),
  `ProviderTerminalGapProfile` (`maxRecoveryAttempts`),
  `ProviderCooldownProfile` (`maxCooldownCycles`), and the union `ProviderProfile`.
  These are the safety-/pressure-/terminal-shaped quantities (getting them wrong
  off the wrong provider's numbers risks a ban, a stall, or a dishonest health
  verdict); discovery seeds / AIMD horizons stay derived defaults, NOT forced here.
- [x] 7.2 Make the pacing ceiling REQUIRED at the type level: replace the optional
  `pacingMinIntervalMs?: number` on `ConnectorHttpGovernorOptions` with a
  non-optional `profile: ProviderPacingProfile`. A bare
  `createConnectorHttpGovernor({ name })` is now a `tsc` error (the spec's
  build-error bar). Add a loud startup throw as the JS-caller backstop (no silent
  shared default). `DEFAULT_PACING_MIN_INTERVAL_MS` survives only as a NAMED,
  AUDITED reference for tests — the governor no longer falls back to it.
- [x] 7.3 ChatGPT is unchanged (pure refactor): ChatGPT runs on
  `ProviderBudgetController`, not this factory, and keeps
  `CHATGPT_DEFAULT_PACING_MIN_INTERVAL_MS = 250`. Terminal `maxRecoveryAttempts=3`
  and cooldown `maxCooldownCycles=8` are unchanged. No live-behavior change.
- [x] 7.4 The six governor-using connectors (github/notion/oura/spotify/strava/
  ynab) each declare `unauditedConservativePacingProfile()` (a DELIBERATE 1000ms
  conservative placeholder, ~4× slower than ChatGPT's audited 250ms — NOT a borrow).
  Terminal/cooldown slices are NOT declared for them: they opt OUT of those loops
  (terminalization skipped via `terminalGapProfileForConnector` → null; cooldown
  escalation disabled) rather than inheriting ChatGPT's budgets.
- [x] 7.5 Conformance test `src/provider-profile-conformance.test.ts` PINS the
  build-error bar: a `@ts-expect-error` on the bare governor call (unused
  suppression ⇒ tsc fails if the field is ever made optional again), the runtime
  backstop throw, a static source scan proving every governor-using connector
  declares a `profile` and never hard-codes 250, and that the conservative
  placeholder is slower than ChatGPT's number. Verified to FAIL when a connector's
  profile is removed (both the conformance test and `tsc` go red).
- [x] 7.6 Gates: `tsc --noEmit` clean in polyfill-connectors (RI clean except the
  pre-existing unrelated `google-data-portability.ts` error); full
  polyfill-connectors suite 2086/2086; the 5 SLVP suites green (terminal-gap 18,
  cooldown-recovery-eligibility 4, escalation-l5 12, push-escalation-l8 5,
  provider-pacing 35); ultracite clean on all changed files.

### 7b. Per-connector behavioral audit (the §9-C5 follow-up) — WI-1b

> Landed on branch `slvp-wi1b-per-connector-profiles`. Research +
> derivations: `docs/research/per-connector-rate-profiles-2026-06-13.md`.

- [x] 7b.1 Audited each of the six governor-using connectors against its
  provider's DOCUMENTED rate limit (official doc URLs cited per connector) and
  replaced `unauditedConservativePacingProfile()` with a per-connector AUDITED
  ceiling, set AT OR BELOW the documented sustained rate (a safety prior, §3):
  github 1000ms (5000/hr), notion 500ms (3 req/s avg), oura 250ms (5000/5min),
  spotify 500ms (~180/min, rolling 30s, undisclosed exact), strava 10000ms
  (100/15min non-upload), ynab 20000ms (200/hr). Each value lives in a named
  factory in `src/provider-profile.ts` with its doc URL. The 1000ms placeholder
  helper + its GAP-3 forcing function are RETIRED now that all six are audited.
- [x] 7b.2 No connector warrants a terminal-gap (§10-A) or cooldown (§10-B)
  override: all six emit ZERO detail gaps (verified by source scan — a 429 throws
  a run-level `<connector>_rate_limited` retryable, never a `DETAIL_GAP`), so the
  terminal classifier and source-pressure cooldown never run for them. They
  legitimately use the safe shared defaults (`DEFAULT_TERMINAL_GAP_PROFILE` 5 /
  `DEFAULT_COOLDOWN_PROFILE` 12). Declaring a terminal/cooldown policy for a
  gap-free connector would be inventing one — the honest call is the default.
  (The trigger to add one later: a connector grows a detail-hydration phase that
  emits `DETAIL_GAP` records under pressure.)
- [x] 7b.3 Each new ceiling validated by a supervised live run (owner-run). The
  values are derived from documented limits below the provider's flagging
  threshold (conservative starting point: the AIMD only approaches the ceiling
  under sustained success), so they are safe to ship ahead of the live
  confirmation. Converted to a residual risk in `proposal.md` for archive; the
  remaining proof is owner-run evidence, not implementation work.
