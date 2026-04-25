# Tranche A findings — A++ follow-ups

**Date:** 2026-04-23
**Scope:** the four diagnostic items the owner memo asked to complete before broader work: #2 (pre-decomposition audit), #5 (shape-validating emit mocks), #7 (stale `@ts-expect-error`), #6 (apple_health timeout investigation).
**Status:** all four complete.

The owner asked for one short artifact summarizing the outputs. This is it.

## Summary table

| Item | What we set out to answer | Finding |
|---|---|---|
| #2 | Is the decomposed `collect()` behavior-preserving vs. pre-decomposition? Did subagents introduce emit-order drift? | **No drift.** All 7 decompositions preserved emit order, scope gating, STATE timing, SKIP_RESULT shape, timestamps, and error handling. See `pre-decomposition-audit-2026-04-23.md`. |
| — | Was gmail's `messages before threads` introduced by decomposition? | **No — pre-existing.** |
| — | Was chatgpt's `messages before conversation record` introduced by decomposition? | **No — pre-existing.** |
| #5 | Do integration tests actually validate record shape, or do hand-rolled mocks let shape drift through? | **Mocks were letting drift through.** 2 connectors had fixture mismatches. See below. |
| #7 | Were the `@ts-expect-error` directives inside chatgpt's `page.evaluate` stale after we added DOM lib? | **Not stale, but replaceable with proper types.** All three removed via structural types + conditional RequestInit. |
| #6 | Was apple_health's 1.5s in the full suite pathological or warmup? | **Warmup.** Suite runs in ~700ms end-to-end once tsx is warm. |

## #2 — pre-decomposition behavior audit

**Zero drift, zero material intentional differences.** Audit details in `pre-decomposition-audit-2026-04-23.md` (240 lines, per-connector detail).

The three child-before-parent emit orderings flagged by the integration tests (`gmail: messages before threads`, `chatgpt: messages before conversation`, `claude_code: messages before sessions`) are **all pre-existing design decisions** preserved by the decompositions — not refactor drift. Owner decision on whether to standardize on parent-first (Item #1 / Tranche C) is unblocked: if we change any of them, we are changing pre-existing behavior on purpose, not fixing a regression.

## #5 — shape-validating integration emit

**Surfaced real fixture drift that the hand-rolled mocks let through:**

**amazon (commit `bccc65c`)** — five test ASINs were 11 characters (schema requires exactly 10) and two unit prices were missing cents (`"$10"` → schema requires `$N.NN`). Seven records that would have emitted `SKIP_RESULT(shape_check_failed)` in production were passing the test. Fixed.

**chatgpt (commit `5e6c4c2`)** — the test's `makeEmitConversation` was emitting a synthetic 3-field shape (`{id, title, detail_present}`). The real `conversationSchema` requires 10 fields. *Every* conversation record in these integration tests would have been a `SKIP_RESULT` in prod. Fixed by threading the real `buildConversationRecord` through the test callback.

**4 of 8 connectors (claude_code, codex, gmail, slack) have no `schemas.ts` / `validateRecord`.** For those, `makeRecordingEmit` runs in pass-through mode — matches runtime semantics exactly. A note in each commit message calls out that flipping to validating mode is a one-line change once those connectors ship schemas.

Shared helper lives at `src/test-harness.ts` with unit tests at `src/test-harness.test.ts`.

## #7 — stale `@ts-expect-error` in `page.evaluate`

Three active directives in chatgpt. Verified they were NOT stale after DOM lib — they were hiding two separate real issues:

1. `window.__NEXT_DATA__` (2 sites) — Next.js-injected global not in DOM lib. Suppression was load-bearing but lossy: a typo in the access path would pass typecheck. Replaced by reading the `<script id="__NEXT_DATA__">` element directly and parsing with a structural `NextDataShape` interface. Same runtime source (Next hydrates that global from this exact element), now typecheck-protected.

2. `fetch()` body param (1 site) — suppression was hiding a real `exactOptionalPropertyTypes` violation. Passing `{ body: undefined }` doesn't match `BodyInit | null`. Fixed by building `RequestInit` and conditionally assigning `body` only when present.

Net: 3 → 0 `@ts-expect-error` directives in chatgpt. The only remaining active directive in the package is in `src/browser-launch.ts` (formerly `src/browser-daemon.ts`, retired 2026-04-25) for patchright ↔ playwright nominal type mismatch — out of scope for Item #7.

## #6 — apple_health timeout

**Warmup, not pathology.** Timings:
- apple_health in isolation: `duration_ms 100`, `0.20s wall-clock` (including tsx cold start).
- Full suite of 548 tests: `duration_ms 367`, `0.70s wall-clock`.
- The original 1.5s observation was the first cold run of the full suite with tsx compiling every file for the first time. Subsequent runs are sub-second.

Added `--test-timeout=30000` to the `test` script so CI's first cold run can't silently hang. No per-test tuning warranted.

## What this unblocks

- **Tranche B (accidental complexity):** proceed. Item #3 (`collect-helpers.ts` removal via entrypoint helper) and Item #11 (CI workflow) have no dependencies on Tranche A findings.
- **Tranche C (behavior corrections):** owner decision on Item #1 is ready. Audit confirmed the three child-before-parent orderings are pre-existing. Default direction from the owner response is parent-first. If approved, the migration is: invert emit order in gmail/chatgpt/claude_code, update the integration tests that pin current behavior, update `docs/authoring-guide.md` with the convention.
- **Tranche D (protocol seam):** no blockers — proceed when Tranches B and C are settled.

## Commits created by Tranche A

- `bc394df` — Item #2 audit (pre-decomposition behavior comparison matrix)
- `a357f9d` — Item #5 shared `makeRecordingEmit` harness + unit tests
- `bccc65c` — Item #5 amazon integration (fixture drift fixed)
- `d689569` — Item #5 chase integration (mechanical)
- `5e6c4c2` — Item #5 chatgpt integration (fixture drift fixed)
- `963d69f` — Item #5 claude_code integration (pass-through; no schema)
- `2791258` — Item #5 codex integration (pass-through; no schema)
- `e5c61ac` — Item #5 gmail integration (pass-through; no schema)
- `dd2a46a` — Item #5 slack integration (pass-through; no schema)
- `62aca76` — Item #5 usaa integration (mechanical)
- `b121b76` — Item #7 chatgpt `@ts-expect-error` removal + proper narrowing
- (this doc + a package.json `--test-timeout` — landing here)
