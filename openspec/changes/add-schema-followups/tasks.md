## 1. Reconciliation primitive

- [x] Add `src/manifest-reconcile.ts` exporting `parseManifestStreams`, `parseSchemaStreams`, `scanEmittedStreams`, `reconcile`, and `reconcileFromDisk`. Pure functions only — no globbing or DB access.
- [x] Add 16 unit tests under `src/manifest-reconcile.test.ts` covering every parser branch and reconcile case (aligned, undeclared-emit, schemaless-emit, ghost-stream, dynamic-emit-miss).
- [x] Add `bin/reconcile-manifests.ts` CLI that checks schema-bearing connectors by default, finds matching manifests/connectors, reports drift, exits nonzero on any drift, and exposes `--all` for the broader schemaless-connector audit.
- [x] Add `bin/reconcile-manifests.test.ts` — regression net that asserts every connector with a `schemas.ts` aligns. 11 tests today (amazon, chase, chatgpt, claude_code, codex, github, gmail, reddit, slack, usaa, ynab).

## 2. Pilot fixtures

- [x] Author 42 fixture files (62 total records) at `fixtures/<connector>/scrubbed/pilot-real-shape/records/<stream>.jsonl` for the six newly-schemed connectors. Authored by sub-agents from `schemas.ts` + `parsers.ts` + `types.ts`; reviewed and replayed.
- [x] Synthetic content uses `[REDACTED_*]` placeholders for identifying fields. No real owner data, no DB extracts. Records are committable.
- [x] Add `bin/replay-pilot-fixtures.ts` — diagnostic that replays every committed fixture through `validateRecord` and reports drift.
- [x] Add `src/pilot-fixture-test-helper.ts` — `registerPilotFixtureTests({ connector, validateRecord })`. Each invocation registers one test per stream file; missing fixtures or schema-failing records fail the test loud.
- [x] Add per-connector `pilot-fixture.test.ts` for github, gmail, ynab, codex, claude_code, slack. Three lines each.

## 3. zod cleanup

- [x] Replace `z.string().url()` with `z.url()` in amazon, chase, usaa schemas (zod 4 idiomatic; deprecation hint cleared).

## 4. Followups documented

- [x] Update `add-polyfill-connector-system/tasks.md` usaa row with the schema-replay findings (4 stale-currency records, 2 empty-string records) and the decision: re-ingest, do not loosen schema.
- [x] Confirm reddit re-ingest tracking exists in `add-polyfill-layer-two-stream-coverage/tasks.md` (it does, both in §1.7 and §1.8). No new tracking needed.

## 5. Validation gates

- [x] `pnpm --dir packages/polyfill-connectors run typecheck` clean.
- [x] All previously-existing tests continue to pass.
- [x] 42 new pilot-fixture replay tests pass.
- [x] 11 new fleet-reconciliation tests pass.
- [x] 16 new manifest-reconcile unit tests pass.
- [ ] `pnpm --dir packages/polyfill-connectors run verify`.
- [ ] `openspec validate add-schema-validation-coverage --strict` (per directive).
- [ ] `openspec validate --all --strict`.

## 6. Out of scope

- USAA data cleanup (re-ingest the 6 stale records). Tracked in `add-polyfill-connector-system/tasks.md`.
- Reddit re-ingest. Tracked in `add-polyfill-layer-two-stream-coverage/tasks.md`.
- Browser-daemon retirement. Owner-reviewed separately.
- The 12 connectors with `parsers.ts` but no `schemas.ts` (apple_health, github prior to this tranche, ical, imessage, pocket, slack-extra-streams, spotify, strava, twitter_archive, whatsapp, etc.) — out of scope for this change; tracked separately as a connector-by-connector effort.
