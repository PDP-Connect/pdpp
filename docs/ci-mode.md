# CI Mode

This repository can require either hosted GitHub Actions or an audited local signoff for the reference-implementation merge gate.

## Modes

- `hosted`: requires the GitHub Actions context `typecheck + full test suite`.
- `local`: requires the commit status `signoff/reference-implementation`.

The switch preserves the existing repository ruleset shape: pull requests remain required, squash merge remains the allowed merge method, and deletion/non-fast-forward protections stay in place. Only the required status-check context changes.

## Commands

```sh
pnpm ci:mode:status
pnpm ci:mode:hosted
pnpm ci:mode:local
pnpm ci:signoff -- --description "Local gate passed; GitHub Actions unavailable"
```

`pnpm ci:signoff` posts a successful commit status for the current pushed `HEAD`. It fails if the worktree has uncommitted changes or the branch has unpushed commits unless `--force` is passed.

## When to use local mode

Use local mode only when hosted CI is unavailable for infrastructure reasons and the local verification commands have been run and recorded. Local mode is not a weaker quality bar; it is a different execution venue for the same merge gate.

For a broad change, the signoff evidence should include:

- The exact commit SHA.
- The commands run locally.
- The pass/fail result of each command.
- Any known caveats, such as lint baselines or skipped environment-specific tests.

## Returning to hosted mode

Hosted mode is the default posture. After the outage or local-only need passes, run:

```sh
pnpm ci:mode:hosted
```

Then verify:

```sh
pnpm ci:mode:status
```
