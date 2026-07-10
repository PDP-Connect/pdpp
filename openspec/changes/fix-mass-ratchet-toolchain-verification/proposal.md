## Why

The complexity mass ratchet shelled to `npx biome` without pinning or
verifying which binary/version ran. A worktree without `node_modules` let
`npx` silently resolve a stray global Biome 0.3.3, which measured an empty
diagnostic set; the ratchet auto-tightened every baseline entry to zero
while reporting pass. The checked-in baseline was stale relative to the
pinned `2.4.12`: pristine `origin/main` measures
`runtime/rendered-verdict.ts=71`, `runtime/scheduler-retry-classifier.ts=11`,
`runtime/scheduler/run-executor.ts=113`, `server/index.js=596` — all
different from the checked-in numbers. The gate failed closed on almost
nothing, and separately could be fooled by a mixed result set (one
non-complexity error diagnostic alongside one real complexity finding),
since it only checked whether *some* complexity diagnostic parsed, not
whether *every* error diagnostic was accounted for.

## What Changes

- Resolve the Biome binary only from the workspace install
  (`node_modules/.bin/biome`); never `npx`, global, or network fallback.
- Verify the resolved binary's version against the pinned
  `@biomejs/biome` version in `package.json`; mismatch fails closed.
- Measure via `biome lint --reporter=json` (Biome's structured diagnostic
  contract) instead of parsing human-readable CLI text.
- Fail closed unless every `severity: "error"` diagnostic is the
  configured complexity category and parseable, and the parsed count
  matches `summary.errors` exactly — a mixed complexity + syntax/config
  error no longer silently returns a partial mass.
- Fail closed on process-status/report inconsistency: signal/exit>1 always
  fails; exit 0 requires zero reported errors; exit 1 requires a nonzero,
  fully-accounted error count.
- Record a baseline fingerprint (Biome version + `MAX_ALLOWED_COMPLEXITY`)
  in `mass-baseline.json`; mismatch fails closed instead of silently
  auto-tightening or passing. Auto-tightening only runs on a match.
- Regenerate the entire `mass-baseline.json` under the pinned toolchain
  (all entries) via an explicit regeneration command.

## Capabilities

- Added: `reference-implementation-quality-tooling`

## Impact

- `check-mass-ratchet.mjs`, `measure-mass.mjs`, and `mass-baseline.json`
  change shape (baseline gains a metadata block).
- Any caller of `measureMass`/`runMassRatchet` inherits the fail-closed
  checks; a broken/wrong local toolchain or partially-parsed result now
  blocks instead of passing.
- No product, protocol, connector, or personal-data surface is touched.
