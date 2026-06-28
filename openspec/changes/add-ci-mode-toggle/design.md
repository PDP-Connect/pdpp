## Context

The active main-branch ruleset requires one status context, `typecheck + full test suite`. During a GitHub Actions billing outage, that check failed before code ran. The local gate for the affected PR had already run successfully, but the repository had no clean way to switch the required context to a local signoff.

Basecamp's `gh-signoff` model is a good fit for the local mode: a maintainer runs the checks locally and posts a green commit status. The repository should not depend on installing a GitHub CLI extension, and it should not use `gh signoff install` because that path edits classic branch protection and can overwrite unrelated protection settings. This repository uses a ruleset, so the switch must operate on the ruleset directly.

## Decision

Add `scripts/ci-mode.mjs` with four commands:

- `status`: show the active ruleset, required contexts, and detected mode.
- `hosted`: set the required context to `typecheck + full test suite`.
- `local`: set the required context to `signoff/reference-implementation`.
- `signoff`: post a successful `signoff/reference-implementation` status on the current pushed commit.

The script finds the ruleset by name (`main: require PR + reference-implementation check`) unless `PDPP_CI_RULESET_ID` or `PDPP_CI_RULESET_NAME` is set. It preserves the existing ruleset shape and changes only the required status-check contexts.

## Alternatives

- Install and use `gh-signoff` directly: rejected as the only interface because the extension's `install` command targets classic branch protection, while this repository uses a ruleset. The local status context remains compatible with the extension's partial-signoff naming.
- Post a green status named `typecheck + full test suite`: rejected because it conflates hosted execution and local execution under one context name.
- Permanently disable the hosted check: rejected because hosted CI should remain the default once platform availability is restored.

## Acceptance Checks

- `pnpm ci:mode:test` proves the ruleset mutation preserves unrelated rules and only changes required status contexts.
- `openspec validate add-ci-mode-toggle --strict` passes.
- `pnpm ci:mode:status` reports the current mode from the live repository ruleset.
- Switching to local mode changes the required context to `signoff/reference-implementation`.
- `pnpm ci:signoff` posts a successful status on the pushed PR head.
