## 1. Browser Assistance Stream Target

- [x] Preserve explicit streaming targets in the default companion factory type and runtime implementation.
- [x] Add a regression test covering no-response browser assistance with the production default factory path.

## 2. Source Summary Reconciliation

- [x] Reconcile dirty connector summary evidence before owner source list/detail reads.
- [x] Add route or read-model tests proving dirty evidence does not remain stale after a source read.

## 3. Owner-Facing Copy

- [x] Replace count-unavailable wording with a state that does not imply active checking.
- [x] Run focused console/source tests covering the updated wording.

## 4. Acceptance Checks

- [x] `openspec validate fix-source-control-deadends --strict`
- [x] Focused reference streaming tests.
- [x] Focused source/connection-health tests.
