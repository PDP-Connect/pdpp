# W2 runtime/index decomposition report

## Outcome

Implemented one behavior-preserving decomposition in
`reference-implementation/runtime/index.js`: the runtime now consumes the
existing `runtime/connector-gap-bounding.ts` facade as the single owner of
connector-authored gap, diagnostic, recovery, and collection-facts policy.
The duplicate inline implementation was deleted after the facade was reconciled
to the live runtime behavior.

This is a cohesive policy boundary rather than relocation: the policy module
already existed, has no import back-edge to `runtime/index.js`, and now replaces
two copies of the same reason for change with one. The source diff is 33
insertions and 512 deletions across the two runtime files. No public export,
route, JSONL message, wire field, error string, event-order, or test-expectation
change was made.

## Decomposition and parity review

The facade reconciliation preserved the former inline runtime semantics,
including:

- `manifest_stream_unresolved` classifies as a transient known gap;
- the runtime's falsy fallbacks remain falsy fallbacks rather than being changed
  to nullish fallbacks;
- invalid top-level diagnostic `considered` evidence is omitted without
  mutating the caller's object;
- recovery-hint inference, explicit action handling, and retryability defaults
  retain their prior behavior;
- connector error strings, bounded strings/lists, gap scope, collection facts,
  and terminal known-gap shapes are unchanged.

A separate Terra checker read the cumulative diff and both complete runtime
files. Its verdict was **PASS**: it confirmed the parity points above, found no
surface or event-order change, no unused imported symbol, no duplicate helper,
and no back-edge, and judged the boundary to be policy consolidation rather
than relocation theater. Its stated residual risk was runtime/transpilation
integration; that risk is covered by the typecheck and database-backed tests
below.

## Evidence

### Complexity mass

| File | Before | After | Change |
| --- | ---: | ---: | ---: |
| `runtime/index.js` | 761 | 678 | -83 |
| `runtime/connector-gap-bounding.ts` | 84 | 80 | -4 |
| **Aggregate touched source** | **845** | **758** | **-87** |

The aggregate drop prevents a misleading filename-only transfer. The measured
`runtime/index.js` reduction is also independently positive.

### Passing gates

- `pnpm --dir reference-implementation typecheck`: pass.
- `pnpm --dir reference-implementation exec biome check runtime/connector-gap-bounding.ts`:
  pass with no fixes. The repository's mass script is the applicable Biome
  oracle for the legacy JavaScript file.
- `git diff --check`: pass.
- stale-definition, duplicate-import, and module back-edge sweeps: pass.
- No test source or expectation file is changed.
- Pinned PostgreSQL characterization set, run before and after the edit with a
  fresh database per file: **173/173 pass**:
  - `collection-profile.test.js`: 127/127
  - `runtime-cancel-run.test.js`: 2/2
  - `runtime-child-process-group.test.js`: 2/2
  - `runtime-pipe-resilience.test.js`: 18/18
  - `runtime-ingest-manifest-drift.test.js`: 4/4
  - `connector-failure-diagnostics.test.js`: 12/12
  - `connector-gap-severity.test.js`: 4/4
  - `detail-coverage-recovered-gap-regression.test.js`: 4/4

### Authoritative suite blocker

The required `pnpm test` gate was run from `reference-implementation/` with
`PDPP_TEST_POSTGRES_URL` configured so the runner allocated an ephemeral
PostgreSQL database for each of its 630 test files. It exited 1. An isolated
retry again executed the full runner and identified one failing test block:

```text
test/remote-surface-reference-boundary.test.js
Error: ENOENT: no such file or directory, open
  'packages/remote-surface/README.md'
```

The failure is outside this diff and reproduces when that test is run alone in
a fresh PostgreSQL database. The required README is absent from the filesystem,
from this branch's `HEAD`, and from `curation/lfdt-prep`; the runtime diff does
not touch `packages/remote-surface` or the failing test. I did not create the
missing package documentation or weaken the expectation because either would
expand this lane beyond the requested behavior-preserving runtime refactor.

Proposed follow-up: restore the intended `packages/remote-surface/README.md`
contract document (preferred if that package boundary is current), or have the
remote-surface owner explicitly retire/update the stale boundary assertion.
Until then, the repository-wide authoritative gate cannot be green from this
base branch.

## Deferred seams

The next highest-value `runtime/index.js` seams remain:

1. a protocol-session state machine that separates validation/decision from
   ordered effects;
2. a terminalization decision matrix with explicit inputs;
3. a pure START scope/binding compiler.

They were deliberately not forced into this commit. Each carries more event-
ordering or lifecycle risk and should receive its own characterization set and
aggregate-mass gate. No test-expectation proposal was implemented.

## Confidence

Confidence is **high** for the extracted policy behavior: the change is a
single-owner consolidation, the relevant PostgreSQL journeys pass 173/173, the
static and mass gates pass, and an independent checker found no parity defect.
I cannot claim a green repository-wide suite: it is blocked by the pre-existing
missing remote-surface README described above.
