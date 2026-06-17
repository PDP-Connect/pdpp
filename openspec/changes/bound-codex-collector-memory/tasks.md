## 1. Runtime

- [x] Stream Codex `state_5.sqlite#threads` session rows instead of loading the full query result.
- [x] Bound retained unmatched function-call state during offset-zero rollout replay.
- [x] Replace whole-file static source reads in the Claude Code connector with bounded preview reads.
- [x] Replace whole-file static source reads in the Codex connector with bounded preview reads.

## 2. Tests

- [x] Add a regression guard for whole-file static source reads.
- [x] Add a regression guard for unbounded Codex thread DB reads.
- [x] Add a regression test for unmatched function calls during offset-zero rollout replay.
- [x] Add a regression test for late function-call output after pending-call eviction.
- [x] Run a local offset-zero RSS profile against the owner's 1.44 GB Codex rollout fixture.
- [x] Run focused connector tests.
- [x] Run typecheck or package verification.

## 3. OpenSpec

- [x] Add the OpenSpec change.
- [x] Validate the OpenSpec change with `openspec validate bound-codex-collector-memory --strict`.
