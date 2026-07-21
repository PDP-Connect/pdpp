## Context

`measureMass()` spawned `npx biome lint ...` with no binary resolution or
version check. `npx` resolves a global/cached Biome first if the local
workspace has no `node_modules` (a read-only worker checkout, e.g.). The
only failure detection was a text substring match on nonzero exit + zero
diagnostics — a wrong binary that exits 0 with zero diagnostics for rules
it doesn't recognize looks identical to "the files are clean."

`runMassRatchet` auto-tightens (lowers) the baseline whenever measured mass
drops below the recorded value. A false zero measurement is
indistinguishable from "someone fixed the complexity," so every baseline
entry silently ratchets to zero — a class-wide false pass that keeps
re-confirming itself on every subsequent run.

## Goals / Non-Goals

Goals: deterministic fail-closed toolchain resolution; a baseline provably
measured under the pinned toolchain; preserve existing ratchet semantics
(compare/auto-tighten/justifications) once the toolchain is verified.

Non-goals: changing Biome, `MAX_ALLOWED_COMPLEXITY`, or measured rules;
a general toolchain-resolution framework beyond the mass-ratchet family;
changing how the ratchet is wired into `lefthook.yml` (already wired).

## Decisions

- **Binary resolution**: resolve `node_modules/.bin/biome` under
  `PROJECT_ROOT` only. Missing binary fails closed ("run pnpm install").
  Rejected: `npx --offline` — `npx` still checks global installs first, so
  it doesn't close the hole that caused the incident.
- **Version verification**: compare the resolved binary's `--version`
  against `package.json`'s declared `@biomejs/biome` version (the same
  value the lockfile tracks). Rejected: hash-pinning the binary — adds a
  re-hash-on-bump maintenance surface for no benefit over the
  already-authoritative declared version.
- **Machine-readable diagnostics, not text parsing**: measure via
  `biome lint --reporter=json`, whose `summary.errors` / `diagnostics[]`
  shape is Biome's own structured contract (rule `category`, `location.path`,
  numeric complexity embedded in `message`). This replaces regex-over-text
  parsing of the human CLI output.
- **Complete-accounting oracle, not "any complexity diagnostic parsed"**:
  every `severity: "error"` diagnostic must be the configured complexity
  category and parseable; any other error category (`parse`, config
  errors, etc.) fails closed even when a real complexity finding is also
  present. `parseableErrorCount` must equal `summary.errors` exactly — a
  count mismatch (e.g. a diagnostic Biome didn't emit in the array, or one
  this parser silently skipped) fails closed rather than trusting a
  partially-parsed report.
- **Process status is cross-checked against the report, not read alone**:
  `status === null` (signal) or `status > 1` fails closed immediately.
  `status === 0` requires `errorCount === 0`; `status === 1` requires
  `errorCount > 0`. Either inconsistency (e.g. status 0 with a nonzero
  error count, or status 1 with zero reported errors) fails closed instead
  of trusting either signal alone.
- **Baseline fingerprint**: `mass-baseline.json` gains
  `meta: { biomeVersion, maxAllowedComplexity }`. `runMassRatchet` computes
  the current fingerprint and requires an exact match before comparing or
  auto-tightening anything; a missing or mismatched fingerprint fails
  closed with a message pointing at the regeneration script. Auto-tightening
  stays gated on this match, preserving the ratchet's value once the
  toolchain is verified.
- **Baseline regeneration**: `regenerate-mass-baseline.mjs` remeasures the
  entire `TARGET_ROOTS` tree under the verified toolchain and rewrites
  `mass-baseline.json` in full (including `meta`). This is the only
  sanctioned way to intentionally rebaseline outside of per-file
  auto-tightening during a passing check.

## Risks / Trade-offs

- A workspace without `node_modules` now hard-fails instead of silently
  passing — intentional; a check that can't prove it measured anything
  must not report success.
- Regenerating the whole baseline under Biome 2.4.12 changed many entries
  at once (confirmed drift, e.g. `rendered-verdict.ts` vs. the stale
  checked-in value). One-time, fully-attributed regeneration, auditable via
  the commit diff and the new fingerprint metadata — not a hand-edit.

## Acceptance Checks

- Mutation-kill tests cover: missing/wrong-version binary, unparseable
  output, true zero-diagnostic clean run, real complexity diagnostics,
  a non-complexity error diagnostic mixed with a real complexity finding,
  a `summary.errors`/parsed-count mismatch, abnormal/signal exit, and
  exit-status-vs-report-count inconsistency in both directions —
  each proven to fail closed (or pass only when genuinely clean).
- `mass-baseline.json` regenerated in full under Biome 2.4.12 with `meta`
  populated; `--all` check passes against clean `origin/main`.
- `openspec validate fix-mass-ratchet-toolchain-verification --strict` and
  `openspec validate --all --strict` pass.
