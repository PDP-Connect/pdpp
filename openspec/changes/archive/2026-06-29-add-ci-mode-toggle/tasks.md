## 1. CI Mode Tooling

- [x] Add the CI-mode switch script.
- [x] Add package scripts for status, hosted mode, local mode, and signoff.
- [x] Add unit coverage for ruleset mutation and managed workflow-state behavior.

## 2. Documentation

- [x] Document hosted mode, local mode, local signoff, and return-to-hosted flow.
- [x] Add the governance spec delta.

## 3. Validation

- [x] Run `pnpm ci:mode:test`.
- [x] Run `openspec validate add-ci-mode-toggle --strict`.
- [x] Use the switch for the current hosted-CI outage.
- [x] Verify PR checks show the local signoff context as the required merge gate.
- [x] Verify local mode disables managed GitHub Actions workflows.
