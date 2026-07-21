## 1. Toolchain resolution

- [x] 1.1 Resolve the Biome binary from the workspace's own
      `node_modules/.bin/biome`; remove the `npx` invocation.
- [x] 1.2 Verify the resolved binary's `--version` against
      `reference-implementation/package.json`'s declared
      `@biomejs/biome` version; fail closed on mismatch or missing binary.

## 2. Fail-closed measurement

- [x] 2.1 Fail closed on unparseable JSON output (`--reporter=json`'s
      `summary.errors`/`diagnostics[]` machine contract, not English-text
      parsing, per owner steer).
- [x] 2.2 Fail closed unless every `severity: "error"` diagnostic is the
      configured complexity category and parseable, and the parsed count
      equals `summary.errors` exactly (owner-found gap: a mixed
      complexity + non-complexity error no longer silently returns a
      partial mass).
- [x] 2.3 Fail closed on process-status/report inconsistency: signal or
      status>1 always fails; status 0 requires zero parsed errors; status
      1 requires a nonzero, fully-accounted error count.

## 3. Baseline fingerprint

- [x] 3.1 Add `meta: { biomeVersion, maxAllowedComplexity }` to
      `mass-baseline.json` and to the read/write path in
      `check-mass-ratchet.mjs`.
- [x] 3.2 Fail closed when the recorded fingerprint doesn't match the
      currently resolved toolchain; gate auto-tightening on a fingerprint
      match.

## 4. Baseline regeneration

- [x] 4.1 Add an explicit whole-baseline regeneration command
      (`regenerate-mass-baseline.mjs`).
- [x] 4.2 Regenerate `mass-baseline.json` in full under Biome 2.4.12
      (all `TARGET_ROOTS` files, not a hand-picked subset).
- [x] 4.3 Reconcile `mass-justifications.json` against the regenerated
      baseline (drop/adjust entries that no longer need justification;
      keep entries still above the fresh baseline mass).

## 5. Tests

- [x] 5.1 Mutation-kill test: wrong/global binary resolved (missing local
      binary path).
- [x] 5.2 Mutation-kill test: version mismatch.
- [x] 5.3 Mutation-kill test: unparseable nonzero output.
- [x] 5.4 Mutation-kill test: true zero-diagnostic clean run passes when
      fingerprint matches.
- [x] 5.5 Mutation-kill test: real diagnostics still measured/compared
      correctly.
- [x] 5.6 Mutation-kill test: fingerprint mismatch fails closed.
- [x] 5.7 Mutation-kill test: non-complexity error diagnostic mixed with a
      real complexity finding fails closed (both at the pure-parser level
      and through `measureMass`).
- [x] 5.8 Mutation-kill test: `summary.errors` disagreeing with the parsed
      diagnostic count fails closed.
- [x] 5.9 Mutation-kill test: abnormal/signal exit fails closed even with
      otherwise valid-looking JSON.
- [x] 5.10 Mutation-kill test: exit-status-vs-report-count inconsistency
      fails closed in both directions (status 0 with errors; status 1
      with no errors).

## 6. Acceptance

- [x] 6.1 `node --test reference-implementation/scripts/quality-ratchet/*.test.mjs`
      green (27 tests).
- [x] 6.2 `node reference-implementation/scripts/quality-ratchet/check-mass-ratchet.mjs --all`
      passes against clean `origin/main` under the pinned toolchain.
- [x] 6.3 `pnpm --dir reference-implementation run typecheck` passes;
      touched files are `.mjs`/`.js` and are exempt from Biome lint by
      the existing JS→TS migration `includes` allowlist (unchanged by
      this change).
- [x] 6.4 `openspec validate fix-mass-ratchet-toolchain-verification --strict`
      and `openspec validate --all --strict` pass.
- [x] 6.5 `git diff --check` clean.
- [x] 6.6 Verified the underlying `check-mass-ratchet.mjs --files ...`
      invocation lefthook's `complexity-mass-ratchet` job runs; direct
      invocation on a real touched runtime file passes. `lefthook run
      pre-commit` itself skipped staged-file detection in this worktree
      because `core.hooksPath` is locally pointed at a different repo's
      `.git/hooks` (pre-existing worktree environment issue, unrelated to
      this change).
