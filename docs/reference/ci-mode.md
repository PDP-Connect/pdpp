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

`pnpm ci:signoff` posts a successful commit status for the current pushed `HEAD`. It fails if the worktree has uncommitted changes or the branch has unpushed commits — there is no dirty-tree override. If `--sha` is given it must equal `HEAD`; `ci:signoff` refuses to post a status for a commit whose code it did not just test, so a stale or mismatched SHA fails closed instead of silently signing off unverified code.

Before posting, `ci:signoff` diffs `HEAD` against `--base` (default `origin/main`) using Git's NUL-delimited path output with rename detection disabled. That reports both the protected deletion and unprotected addition when a manifest moves, so a rename cannot hide a shipped manifest change. A change under either shipped manifest root — `packages/polyfill-connectors/` or `reference-implementation/manifests/` — runs the connector-conformance test files (`stream-evidence-strategy-manifest.test.ts`, `coverage-policy-manifest-honesty.test.ts`, `connector-conformance.test.ts`) and the source-derived `stream-evidence:check` inventory gate. A change to the inventory producer (`scripts/stream-evidence-inventory.mjs`) or generated artifact (`docs/reference/stream-evidence-inventory.md`) also runs the inventory gate. A change to the gate itself (`scripts/ci-mode.mjs`, `scripts/ci-mode.test.mjs`, `package.json`, or any of those three conformance test files) additionally runs `ci:mode:test`. This is a real gate, not a reminder or an opt-in: it closes the gap left by `.github/workflows/polyfill-connectors.yml` being explicitly non-blocking (see that file's header), so a scaffolded, dishonest, or stale-evidence connector manifest cannot be skipped by forgetting to run the suite locally. There is no bypass flag — if the diff cannot be computed at all (missing `base` ref, shallow clone), `ci:signoff` fails outright rather than silently skipping the gate.

If the diff touches the gate's own implementation, `ci:signoff` ALSO runs `ci:mode:test` — a change to the gate itself must run both the connector-conformance suite (to prove the gate's own logic still enforces what it claims) and its own unit tests, not just one or the other. A change to the gate cannot weaken its own enforcement without proving the weakened version still passes both.

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
