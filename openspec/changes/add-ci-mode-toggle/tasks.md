## 1. CI Mode Tooling

- [ ] Add the CI-mode switch script.
- [ ] Add package scripts for status, hosted mode, local mode, and signoff.
- [ ] Add unit coverage for ruleset mutation and managed workflow-state behavior.

## 2. Documentation

- [ ] Document hosted mode, local mode, local signoff, and return-to-hosted flow.
- [ ] Add the governance spec delta.

## 3. Validation

- [ ] Run `pnpm ci:mode:test`.
- [ ] Run `openspec validate add-ci-mode-toggle --strict`.
- [ ] Use the switch for the current hosted-CI outage.
- [ ] Verify PR checks show the local signoff context as the required merge gate.
- [ ] Verify local mode disables managed GitHub Actions workflows.
