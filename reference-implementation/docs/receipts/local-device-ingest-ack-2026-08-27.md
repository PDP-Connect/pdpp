# Local-device ingest acknowledgement defect

## Root cause

`POST /_ref/device-exporters/:deviceId/ingest-batches` durably advanced the
record prefix and then awaited the shared lexical/semantic index lane before
completing the processing reservation. When semantic admission returned
`semantic_work_busy`, the already-durable batch returned `503` and remained in
`processing`, so retries repeated the same post-durability work. In
production this produced a self-sustaining livelock: one reservation reached
1058 attempts over ~8 hours while ~45% of live batches were wedged, with zero
error/warn lines to point at the cause (the collector's 503 envelope is a
fixed, bounded template and nothing was logged server-side either).

## Correction

The route now schedules final collapsed-key indexing on the existing ordered
per-connector-instance lane (`enqueueDeviceIndexMaintenance`) and does not
await index capacity before completing the durable reservation. A failed
deferred-index closure is caught and logged (identifiers only) rather than
propagated. The existing write-time dirty scope remains the crash-safe
backstop and is cleared only by whole-scope reconcile
(`runSearchIndexDirtyReconcileRound`). Index publication still uses the
existing record-version CAS, and accepted replay still returns the stored
terminal response without reapplying the prefix. No new queue was
introduced; the existing dirty-scope/reconcile machinery is reused as-is.

Also added a bounded diagnostic log line on deferred-index failure
(`[device-ingest] deferred index maintenance failed ...`), sanitizing the
error code through a strict `[a-z0-9_]+` allowlist before it reaches the log.

## Changed files

- `reference-implementation/server/routes/ref-device-exporters.ts` — defer
  final lexical/semantic maintenance (fire-and-forget with catch-and-log)
  while preserving durable acceptance; remove the now-meaningless deadline
  check inside the detached closure (nothing left to abandon into once the
  closure is detached from the response).
- `reference-implementation/server/records.ts` — document that the shared
  device index lane supports both awaited and acknowledgement-independent
  use.
- `reference-implementation/test/device-ingest-conformance.test.ts` —
  add `runDeviceAckWhileSemanticCapacityHeldOracle`, which holds semantic
  admission capacity and proves: 201 acceptance despite held capacity,
  durable prefix completeness, exactly-once reservation completion on
  replay, dirty-scope retention until reconcile, and eventual lexical/
  semantic convergence. Also rewrote three pre-existing oracles
  (`runPhaseFaultMatrix`'s two derived-index phases, `runDuplicateAndNewer-
  WriterOracle`, `runRepairAndCanonicalOracle`) that asserted the old
  contract (derived-index fault -> 503 -> stranded "processing" reservation)
  — these are now unreachable, so they were rewritten to assert 201
  acceptance, dirty-scope retention, and eventual reconcile convergence
  instead. Removed the now-dead `corruptDerived` test helper (its
  same-row-count content mutation is invisible to reconcile's count-based
  lexical drift check by design — see Risk) in favor of the existing
  `eraseDerived` helper, which exercises a real count-gap the reconcile
  mechanism is designed to detect. Added drains before two pre-existing
  lexical/semantic assertions (`runPhaseFaultMatrix`'s resume-to-accept
  check, `runStrandedDiagnosticsOracle`'s replay-immutability snapshot) that
  raced the now-deferred index work.
- `reference-implementation/test/device-exporter-routes.test.ts` — rewrote
  three pre-existing tests that also asserted the old awaited-index
  contract: the batch-attempt-deadline test (a slow embed can no longer
  blow the deadline mid-response, since nothing awaits it there anymore),
  the authoritative-interleave test (renamed to
  "reconcile repairs from the newer authoritative writer ..."; the faulted
  first call now accepts immediately and reconcile — not batch retry —
  proves the newer direct write wins), and the attempt-facts-drift test
  (renamed to "device ingest preflight rejects before reservation ...";
  manifest/model drift is now exercised explicitly between calls instead of
  as an embed-callback side effect, since that side effect could no longer
  race the same attempt once embedding is fire-and-forget — the repair
  claim now goes through `registerConnector`'s synchronous backfill against
  an already-accepted batch, which the test already exercised for other
  fields). Removed the now-unused `ATTEMPT_MODEL_PATTERN` constant.
  **Follow-up correction (test-only):** added a dedicated
  semantic-capability-identity-only drift test to close an independent
  review finding — see "Independent review finding" below.
- `openspec/changes/correct-local-collector-ingest-throughput/design.md` —
  align the acceptance decision with deferred derived work and dirty
  reconcile.
- `openspec/changes/correct-local-collector-ingest-throughput/specs/local-device-exporter-collection/spec.md` —
  specify non-blocking ordered derived maintenance after durability.
- `openspec/changes/correct-local-collector-ingest-throughput/tasks.md` —
  update the completed device-route task wording.

## Verification

All commands run from `reference-implementation/` against a real dedicated
Postgres test listener already running on `127.0.0.1:55447` (shared,
disposable; not started or stopped by this change) plus the SQLite backend
variant every oracle also runs:

```
PDPP_TEST_POSTGRES_URL="postgresql://postgres:postgres@127.0.0.1:55447/pdpp_test" \
  node --import tsx --test test/device-ingest-conformance.test.ts
# tests 22, pass 22, fail 0 (run three times across both sessions for stability)

PDPP_TEST_POSTGRES_URL="postgresql://postgres:postgres@127.0.0.1:55447/pdpp_test" \
  node --import tsx --test test/device-exporter-routes.test.ts
# tests 53, pass 53, fail 0 (run three times in the follow-up session for stability;
# 52/52 in the original session before the follow-up test was added)

npx tsc --noEmit
# clean

npx biome check reference-implementation/server/routes/ref-device-exporters.ts \
  reference-implementation/test/device-ingest-conformance.test.ts \
  reference-implementation/test/device-exporter-routes.test.ts
# clean except two pre-existing, unrelated findings (see Risk)

npx openspec validate correct-local-collector-ingest-throughput --strict
# "Change 'correct-local-collector-ingest-throughput' is valid"

git diff --check
# clean
```

Both suites were also run once before landing the test rewrites to confirm
the exact stale-assertion failure set (6 failures across 3 oracles in
device-ingest-conformance.test.ts; 3 failures in device-exporter-routes.test.ts),
and once more after, twice each, with zero flakes on the rewritten
assertions. Two flakes were observed and fixed during rewrite (both were
real races introduced by the fix, not by the test rewrites): a resume-to-
accept snapshot comparison in `runPhaseFaultMatrix` and
`runStrandedDiagnosticsOracle`'s replay-immutability check both read
lexical/semantic content immediately after an accept without draining the
now-deferred index work first; both now drain via
`waitForDeferredIndexWorkToDrain`/`drainConnectorInstanceIndexWorkForTests`
before asserting.

In the follow-up session closing the review finding below,
`openspec validate correct-local-collector-ingest-throughput --strict` was
run and confirmed valid (the openspec diff itself was not touched in either
session).

## Independent review finding (P2, closed)

An independent review of this change passed on production semantics but
flagged one attributable test-coverage regression: the original
`flipSemanticIdentity`/`attempt-model-c` scenario in the "attempt facts
fence drift" test exercised **semantic-capability-identity-only drift**
(the backend's model changes, the manifest does not) with assertions on
`semantic_capability_identity` and an accepted-backfill precondition check.
When that test was rewritten (see Risk below — the embed-callback-side-
effect trigger it used is unreachable under the new contract), only
manifest-fingerprint drift coverage was carried forward; the
semantic-identity-only case was dropped rather than reconstructed.

Closed by adding
`reference-implementation/test/device-exporter-routes.test.ts`'s new test
"semantic-capability-identity-only drift (no manifest change) is captured
at acceptance and repaired by registration backfill". It isolates the two
independently-derived attempt facts
(`compileDeviceAttemptContext`'s `manifestFingerprint` from the manifest
JSON vs. `semanticCapabilityIdentity` from
`ctx.getSemanticCapabilityIdentity()`) by changing only the backend's
`model()` return value between two explicit HTTP calls, with the manifest
byte-identical throughout — no embed-callback timing dependence, matching
the pattern already used for manifest-fingerprint drift. It asserts:
`semantic_capability_identity` on the accepted outcome row reflects the
pre-drift model; the vector publishes correctly before drift;
`registerConnector`'s synchronous backfill (unconditional on the manifest
text actually changing, confirmed by reading `registerConnector` in
`server/auth.ts`) detects the drifted `model_id` in `semantic_search_meta`
via `semanticIndexBackfillForManifest`'s independent `backendChanged` check
(`server/search-semantic.ts` around line 2871:
`metaRow.model_id !== currentModel`) and republishes the vector under the
new identity; and the accepted response remains an immutable replay
contract afterward. The scenario proved genuinely reachable and correctly
handled by existing, unmodified production code — no defect was found and
no production file was touched by this correction.

## Risk

The acknowledgement now guarantees durable record and reservation state, not
immediate search visibility. Derived work remains ordered and version-CAS
fenced; if the process exits or capacity stays unavailable, the durable
dirty scope remains for reconcile.

Reconcile's lexical half (`backfillLexicalStream` in `server/search.ts`) is a
**count-based** drift check (`indexCount === expectedIndexRows`), not a
content check. This was already true before this change; it becomes more
load-bearing now because the old per-batch "retry a still-processing
reservation" repair path (which force-republished unconditionally) no longer
runs once a batch accepts immediately. Concretely: if derived-index
maintenance fails after writing SOME but not all rows for a key, or if a key's
already-published row is corrupted out-of-band without changing its row
count, reconcile's lexical half will not detect or repair it — only an
actual count mismatch (missing/extra rows) triggers a lexical rebuild. This
gap is orthogonal to this fix (it existed before, just less reachable) and
was not fixed here; the removed `corruptDerived` test helper exercised
exactly this blind spot and had to be replaced with `eraseDerived` (a real
count gap) to get a passing, honest assertion. If this matters going forward,
`backfillLexicalStream`'s drift heuristic would need a content-fingerprint
check, out of scope for this change.

The `device-exporter-routes.test.ts` "attempt facts fence drift" test's
original design (manifest/model drift triggered as a side effect of the
embed callback, racing the SAME in-flight attempt) is provably unreachable
under the new contract: fire-and-forget embedding can no longer influence
whether the durable write that triggered it has already been acknowledged.
The rewrite preserves the same four claims (preflight rejection before
reservation, attempt-fact capture, drift-triggered repair, replay
immutability) but moves the drift-triggered repair's trigger from "same-
attempt retry" to "registerConnector's synchronous backfill against an
already-accepted batch" — a real, already-exercised repair path in the same
test, not a new mechanism invented for this fix.

Pre-existing, unrelated to this change (confirmed against `git stash`
baseline / untouched lines):
- `reference-implementation/server/records.ts:8078` and `:8134` — a
  pre-existing cognitive-complexity-21 and nested-ternary biome finding in
  `resolveReadRequestBindings`, nowhere near the lines this change touches.
- `reference-implementation/server/routes/ref-device-exporters.ts:1920` — a
  pre-existing unused-suppression biome warning, not on a line this change
  touches.
- `reference-implementation/test/device-exporter-routes.test.ts:8-9` — biome
  cannot resolve the vendored tarball dependency `@pdpp/collector-runtime`
  (`vendor/pdpp-collector-runtime-0.0.1.tgz`) in this fresh worktree; this is
  a tool-resolution limitation against a vendored tarball, not a real
  unresolved import (`tsc --noEmit` resolves it cleanly), and is present on
  unedited import lines.
- Fresh-worktree environment notes: `pnpm install` was required (no
  `node_modules` existed anywhere in the worktree at session start); the
  worktree already shared a running dedicated-test-Postgres container
  (`pdpp-test-postgres-0810`, `127.0.0.1:55447`) with the rest of the repo,
  which this session used read/write for tests but did not start, stop, or
  otherwise manage.

## Commit

Integrated rail commits: `80443ce67` (fix + test rewrites), `92f5285a7`
(receipt follow-up), and `d055a2085` (test-only follow-up restoring
semantic-capability-identity-only drift coverage per the independent review
finding above).
