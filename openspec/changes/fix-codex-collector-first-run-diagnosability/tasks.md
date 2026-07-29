## 1. Runner: authoritative terminal-DONE error message

- [x] 1.1 `throwIfConnectorExitedUncleanly` (`packages/polyfill-connectors/
      src/collector-runner.ts`) now accepts `terminalDone` and prefers
      `terminalDone.error.message` (only when `terminalDone.status ===
      "failed"` and a message is present) over the generic
      `exit <code>: <stderr>` fallback. The call site now computes
      `terminalDone` before calling this function (previously computed
      after) so the value is available; the subsequent `terminalDone`-based
      completeness check is otherwise unchanged.
- [x] 1.2 Regression test:
      `"runCollectorConnector surfaces the connector's own terminal DONE
      error message into the durable connector_child_failure gap,
      sanitized"` (`collector-runner.test.ts`) — a fixture child emits
      `DONE {status:"failed", error:{message}}` (including a secret-shaped
      token in the message) then exits 1 with empty stderr. Asserts (a) the
      thrown run-failure error contains the connector's own message, not
      `"unknown error"`; (b) the durably queued `connector_child_failure`
      gap unit's own `payload.details` — read directly from the outbox, not
      inferred from the thrown error — also contains the connector's
      message; and (c) the secret-shaped token is redacted
      (`sanitizeCollectorGapDetails`'s `[REDACTED]` marker present) in that
      stored detail, never persisted raw. (b) is necessary because the
      thrown error and the gap row are populated by two separate code
      paths that could regress independently — see 3.3 for the targeted
      mutation proof that this is a real, independent assertion, not
      redundant with (a).

## 2. Codex connector: optional sources are not fatal

- [x] 2.1 `assertRequestedCodexSources` (`packages/polyfill-connectors/
      connectors/codex/index.ts`): removed the fatal `missing.push(...)`
      branches for `rules`, `prompts`, `skills`. `sessions` (and its
      `hasRollouts || hasThreadsDb` check) is unchanged and remains fatal.
- [x] 2.2 Updated the pre-existing
      `"codex connector fails instead of succeeding when requested local
      sources are missing"` test (renamed to `"...when a hard-required
      local source is missing"`) — its old assertion expected the removed
      fatal-on-`rules` behavior; now asserts `sessions` alone is sufficient
      to fail, and `CODEX_RULES_DIR=` explicitly does NOT appear in the
      failure message.
- [x] 2.3 Added
      `"codex connector succeeds when only optional rules/prompts/skills
      sources are missing"` (`source-preflight.test.ts`) — recreates the
      exact configuration observed on a remote collector host (a
      `sessions` directory present, `rules`/`prompts`/`skills` absent) and
      asserts a clean `DONE {status:"succeeded"}`.
- [x] 2.4 Reverified the pre-existing
      `"codex emits coverage diagnostics for a missing source home before
      failing"` test unmodified and still green — proves coverage
      diagnostics for `rules`/`prompts` still land as `"missing"` even
      though they are no longer fatal (that test's own failure trigger is
      the still-fatal `sessions` absence, unaffected by this change).

## 3. Mutation-grade proof

- [x] 3.1 Reverted `collector-runner.ts` only (`git stash push -- ...`),
      reran the new test 1.2 → failed, reproducing the EXACT live symptom
      (`"...connector exited 1: exit 1:"`, no detail). Restored
      (`git stash pop`), retest → green.
- [x] 3.2 Manually reverted `assertRequestedCodexSources`'s deletion to
      confirm the corresponding new test (2.3) fails against the pre-fix
      assert shape, then restored — see the non-committed operator
      evidence report's verification log for this session (the live
      direct-invocation repro against the deployed `0.0.0` package already
      constitutes the primary mutation-grade evidence for 2.1: the exact
      `CODEX_RULES_DIR=`/`CODEX_PROMPTS_DIR=` fatal message was reproduced
      byte-for-byte before any fix).
- [x] 3.3 Targeted mutation probe isolating the durable-gap assertion in
      1.2 from the thrown-exception assertion: patched
      `throwIfConnectorExitedUncleanly` so the thrown exception still uses
      the preferred `doneMessage` (unchanged) but the gap row's own
      `details` is computed from the OLD stderr-only fallback instead —
      simulating a regression that fixes only the visible error, not the
      durable evidence an operator would actually inspect. The gap-metadata
      assertions in 1.2 failed as expected (`payload.details` = `"exit 1:"`
      instead of the connector's message); the thrown-exception assertions
      alone would NOT have caught this. Reverted the probe afterward;
      `git diff` confirmed `collector-runner.ts` byte-identical to its
      committed state.

## 4. Verification

- [x] 4.1 `npx tsc --noEmit -p packages/polyfill-connectors/tsconfig.json`
      (also via `pnpm --dir packages/polyfill-connectors run typecheck`) —
      clean.
- [x] 4.2 `pnpm --dir packages/polyfill-connectors run check` (`ultracite
      check`) — clean, 410 files, no fixes needed after one auto-applied
      formatting pass on `collector-runner.ts`.
- [x] 4.3 `node --test connectors/codex/*.test.ts` — 112/112 pass (from
      `packages/polyfill-connectors`).
- [x] 4.4 `node --test src/collector-runner.test.ts` — 61/61 pass.
- [x] 4.5 `pnpm --dir packages/polyfill-connectors run test` (full package
      suite, official script) — 2727/2733 pass, 6 pre-existing skips, 0
      fail.
- [x] 4.6 No-double-cast gate
      (`grep -nE "as[[:space:]]+unknown[[:space:]]+as[[:space:]]"` against
      the diff) — zero matches.
- [x] 4.7 `openspec validate fix-codex-collector-first-run-diagnosability
      --strict` and `openspec validate --all --strict` — both pass.
- [x] 4.8 `git status --short` confirms only the intended 4 code/test files
      plus this change's OpenSpec artifacts are modified/added — nothing
      outside that set.

## 5. Landing

- [x] 5.1 Commit the 4 code/test files plus this OpenSpec change directory
      in one commit, with `Signed-off-by`/`Assisted-by: AI` trailers
      present per repository authorship convention.
- [x] 5.2 Update the non-committed operator evidence report's POST-DEPLOY
      RUNTIME section with the landing commit SHA and final LAND/REVISE
      verdict.

## Non-Goals (explicitly not done here)

- Publishing a new `@pdpp/local-collector` release.
- Re-pinning the remote collector host off the `0.0.0` placeholder.
- Pushing, opening a PR, deploying, or touching the remote host in any way
  beyond the prior turn's already-completed read-only investigation.
- Auditing every other connector for the same fatal-precondition-assert
  pattern found in Codex.
