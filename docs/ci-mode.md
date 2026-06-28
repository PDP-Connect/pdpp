# CI Mode

This repository can require either hosted GitHub Actions or an audited local signoff for the reference-implementation merge gate.

## Modes

- `hosted`: enables the repo-managed GitHub Actions workflows and requires the GitHub Actions context `typecheck + full test suite`.
- `local`: disables every GitHub Actions workflow known to the repository and requires the commit status `signoff/reference-implementation`.

The switch preserves the existing repository ruleset shape: pull requests remain required, squash merge remains the allowed merge method, and deletion/non-fast-forward protections stay in place. Only the required status-check context and managed workflow states change.

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

Local mode also disables GitHub Actions workflows so the repository does not keep spending hosted-CI minutes on PR and main-branch events while those checks are not the active merge gate. It disables every workflow returned by the GitHub Actions API, including historical workflow records that are no longer present in the checkout. Hosted mode re-enables only the repo-managed workflow files in the current tree unless `PDPP_CI_MANAGED_WORKFLOWS` is set. The switch does not affect external providers such as Vercel.

## Agent responsibility

The agent or maintainer owning a PR owns the CI-mode path end to end:

- Check `pnpm ci:mode:status` before relying on a required check.
- If local mode is active, run the relevant local verification commands for the change.
- Record the commit SHA, commands, results, and caveats in the PR or handoff.
- Post `pnpm ci:signoff` for the exact commit that will merge.
- Leave GitHub Actions workflows disabled while local mode is active; do not manually re-enable them to chase non-required checks.
- Do not ask the owner to resolve hosted-CI billing failures, rerun failed hosted jobs caused by infrastructure, or post routine signoffs.
- Escalate only for actual platform/admin access problems, missing credentials, or a product decision about the verification bar.

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
