## 1. Local signoff gate

- [x] 1.1 Add `CONNECTOR_SURFACE_PATH_PREFIXES` / `CI_GATE_SELF_PATHS` and
      `changeTouchesConnectorSurface` / `changeTouchesCiGateSelf` (pure,
      exported) to `scripts/ci-mode.mjs`.
- [x] 1.2 `signoff` diffs `HEAD` against `--base` (default `origin/main`) via
      `git merge-base` + `git diff --no-renames --name-only -z`; throws (fails
      closed) if the diff cannot be computed.
- [x] 1.3 Run the connector-conformance test files
      (`stream-evidence-strategy-manifest.test.ts`,
      `coverage-policy-manifest-honesty.test.ts`, `connector-conformance.test.ts`)
      whenever the connector surface changed OR the gate's own files
      changed (`connectorGateRequired` is an OR of both conditions — a
      change to `scripts/ci-mode.mjs` alone must still prove the conformance
      suite it wraps passes, not just `ci:mode:test`); run `ci:mode:test`
      whenever the gate's own files changed, in addition to (not instead
      of) the conformance suite.
- [x] 1.4 Remove `--force`; `isCleanAndPushed()` is unconditional. Reject
      `--sha` that does not equal `HEAD`.
- [x] 1.5 Do not append a receipt/gate note to the posted GitHub status
      description — the status is already SHA-bound via the API path.
- [x] 1.6 Update `docs/reference/ci-mode.md` to describe the new mechanics.
- [x] 1.7 Tests: `changeTouchesConnectorSurface`, `connectorGateRequired`
      (including the gate-self-only case — `connectorGateRequired(['scripts/ci-mode.mjs'])`
      must be `true` even with no `packages/polyfill-connectors/` path in the
      diff), `changeTouchesCiGateSelf`, `ciModeSelfTestRequired` (all pure).
      Subprocess tests against an isolated temp git repo (bare "origin" +
      clone, no shared/real repo state, no stash) for: dirty-worktree
      rejection, `--sha` mismatch rejection, unresolvable `--base` failing
      closed.
- [x] 1.8 Include `reference-implementation/manifests/` in the local-signoff
      connector surface because `stream-evidence-strategy-manifest.test.ts`
      audits that root as well as the bundled polyfill manifests. Regression:
      a reference-manifest-only path makes both `changeTouchesConnectorSurface`
      and `connectorGateRequired` return true.
- [x] 1.9 Run `stream-evidence-inventory.mjs --check` before local signoff
      success whenever either shipped manifest root, the inventory producer,
      or the generated artifact changes. Subprocess regression: a
      reference-only `required` flip with a stale inventory fails before the
      fake `gh` status endpoint is reached.
- [x] 1.10 Read changed paths from `git diff --no-renames --name-only -z`; do
      not split Git's quoted/newline-delimited display output. Subprocess
      regression proves Unicode and embedded-newline paths below both
      protected manifest roots still run the connector and inventory gates.
- [x] 1.11 Treat each pinned connector-conformance test path as gate-self
      input requiring `ci:mode:test`, and pin the exact classification in the
      pure gate tests.
- [x] 1.12 Disable Git rename detection for the NUL-delimited signoff diff so
      a manifest moved out of either protected root remains visible as a
      protected deletion. End-to-end regressions move a manifest from each
      root, retain the stale generated inventory, and prove the fake `gh`
      status endpoint is not reached.

## 2. Write-time manifest validation

- [x] 2.1 Add the accepted-coverage-policy + `required` contradiction check
      to `validateStreamEvidenceDeclarations` (unconditional — mirrors
      `coverage-policy-manifest-honesty.test.ts`'s existing build-time
      check; safe for legacy/third-party manifests since the combination was
      always a logical contradiction).
- [x] 2.2 Evaluated and REJECTED an unconditional
      `coverage_strategy`/`freshness_strategy` write-time presence
      requirement: broke registration for 80+ existing minimal test/legacy
      manifests across ~217 test contexts when tried (full
      `pnpm reference-implementation:test` run). Reverted; presence stays a
      build-time-only guardrail (already 100% enforced,
      `stream-evidence-strategy-manifest.test.ts`), now reachable from
      merge via task 1's `ci:signoff` gate.
- [x] 2.3 Evaluated and REJECTED unconditional `required` presence at write
      time for the same reason — `required` defaults to `true` by
      established semantics; omission is not itself a defect, and a
      build-time-only ratchet (`KNOWN_MISSING_REQUIRED`) already exists.
- [x] 2.4 Test: `validateConnectorManifest` accepts a stream missing
      `coverage_strategy`/`freshness_strategy` (documents the deliberate
      non-enforcement); rejects the accepted-policy/`required` contradiction
      in both directions (declared `required: true` and omitted-defaults-true).

## 3. Conformance roster exhaustiveness

- [x] 3.1 Add `REAL_UNLISTED_CONNECTORS` (apple_health, google_takeout, ical,
      imessage, spotify, twitter_archive — verified real, non-scaffold
      collectors with real behavioral-oracle test files, `listed: false`,
      `status: "unproven"`) as an explicit roster bucket independent of
      `public_listing.listed`.
- [x] 3.2 Add `DEPRECATED_UPSTREAM_STATUS` (manifest-derived, not
      hand-maintained) covering `pocket` (`status: "deprecated_upstream"` —
      Mozilla shut Pocket down 2026-07-08).
- [x] 3.3 Rewrite the exhaustiveness test: every one of the 33 manifest
      connector keys resolves to exactly one of
      `PRODUCTION_READY_CONNECTORS` / `REAL_UNLISTED_CONNECTORS` /
      `KNOWN_SCAFFOLD_CONNECTORS` / deprecated-upstream. Fails on both
      unaccounted-for keys and keys claimed by more than one bucket.
- [x] 3.4 Evaluated and REMOVED a line-count/text heuristic
      (`hasOnlyUnconditionalSkipResult`) considered for auto-verifying
      `REAL_UNLISTED_CONNECTORS` membership — a heuristic is not a semantic
      gate; category membership is an explicit, reviewable roster edit.
- [x] 3.5 Fixed stale doc comments: dropped `heb` from the scaffold-roster
      doc comment (heb graduated to `PRODUCTION_READY_CONNECTORS`); ensured
      the real-unlisted doc comment/roster includes `ical`.

## 4. `parent_detail_accounting` sibling audit (Gmail served-gap defect class)

- [x] 4.1 Enumerated all 10 manifests declaring `coverage_strategy:
      "parent_detail_accounting"` on any stream: amazon, chase, chatgpt,
      doordash, gmail, heb, loom, usaa, whatsapp, wholefoods.
- [x] 4.2 Audited the 6 real (non-scaffold) siblings other than gmail —
      amazon, chase, chatgpt, heb, usaa, whatsapp — for whether they consume
      `START.detail_gaps`/`recovery_only` into their forward walk, the exact
      shape of Gmail's fixed bug (#324/#325).
- [x] 4.3 Result: amazon, heb, chatgpt are full consumers (dedicated
      recovery-pass-then-forward-walk shape, same pattern as Gmail's fix).
      chase, usaa, whatsapp do not consume served gaps but are structurally
      exempt — each performs an unconditional full re-scan every run (chase,
      usaa) or has no addressable remote locator to recover against at all
      (whatsapp static-file import) — so the "forward walk skips
      already-served items" failure shape does not apply. doordash/loom/
      wholefoods are scaffolds with no real collect path (already covered by
      §3's scaffold bucket).
- [x] 4.4 No connector-runtime or connector-local code change required — no
      definitive defect found. Findings recorded in
      `tmp/workstreams/connector-green-default-impl-0715.md` (this change's
      companion report) rather than a new test asserting a negative.

## 5. Verification

- [x] 5.1 `node --test --test-timeout=30000 --import tsx
      packages/polyfill-connectors/src/{stream-evidence-strategy-manifest,coverage-policy-manifest-honesty,connector-conformance}.test.ts`
      — 12/12 pass.
- [x] 5.2 `pnpm --dir packages/polyfill-connectors run typecheck` — clean.
- [x] 5.3 `node --test scripts/ci-mode.test.mjs` — 18/18 pass, including
      stale-inventory, Unicode/newline, and both manifest rename-out
      subprocess regressions.
- [x] 5.4 `pnpm --dir reference-implementation run typecheck` — clean.
- [x] 5.5 `node --test reference-implementation/test/{connector-manifest-validation,connector-instances-acceptance}.test.js`
      — 25/6 pass respectively; the acceptance suite was the one that caught
      task 2.2's rejected approach.
- [x] 5.6 Biome check on every changed TS file (root + both packages) —
      clean; `scripts/*.mjs` confirmed out of Biome's lint scope in this
      repo (pre-existing, unrelated to this change).
- [x] 5.7 `openspec validate harden-connector-green-default-boundary --strict`
      and `openspec validate --all --strict`.
- [ ] 5.8 Full `pnpm reference-implementation:test` run (deferred to the end
      of the tranche per owner instruction to avoid repeated expensive
      validation loops; one pre-existing unrelated failure noted in the
      report, `ref-connectors-browser-surface-hoist.test.js`, confirmed
      untouched by this diff).
- [x] 5.9 `git diff --check` clean.
- [x] 5.10 Regenerate `docs/reference/stream-evidence-inventory.md` after
      the Slack optional-stream `required: false` correction, then prove
      `pnpm stream-evidence:check` is current and debt-free.
