# Semantic-release incident report

## Root cause

`resolve next version` fails in the `generateNotes` phase of
`@semantic-release/release-notes-generator`. The release-notes plugin loads
`conventional-changelog-writer@8.4.0` through `semantic-release@25.0.9`.
`conventional-changelog-conventionalcommits@10.4.0` requires writer 9 or
newer, so its template fails before the release job can run.

The CI error is:

```
Missing helper: "conventional-changelog-conventionalcommits requires
conventional-changelog-writer@9 or newer ... Your changelog tooling loaded an
older writer which cannot render this preset."
```

This is not a token, GitHub permission, branch, package version, publishing, or
repository-secret problem. The resolver job has `contents: write`; it stops
before publishing. The downstream `publish GitHub and npm release` job is
skipped for the failing runs, so it has no failed job log to inspect.

## Regression boundary

The last resolver that completed `generateNotes` was run `33275234829`, at
commit `ab19825edcdbfc3bb174269deb0519566f7a98c6` (2026-08-29 21:07:15 UTC).
That workflow run later failed in release quality checks for a separate
`spawnSync ... pnpm ENOENT` error.

The first resolver failure for this defect was run `33279638935`, at commit
`a1620096a29084ab500dd4567cde992bfc1452b0` (2026-08-29 22:52:35 UTC), not
the 2026-09-02 run in the incident report. The causative commit is
`a1620096` (`chore(deps): bump the npm-minor-patch group across 1 directory
with 17 updates (#254)`): it changed
`conventional-changelog-conventionalcommits` from `^10.3.0` to `^10.4.0`.

The latest specified failing run, `33768017188` at `6c42c411e`, fails in the
same resolver phase. Its release job is skipped because the resolver produces
no release output. I inspected `gh run view <id> --log-failed` and the full
resolver logs for both the latest and transition runs; the failure is stable.

## Fix

Pin `conventional-changelog-conventionalcommits` to `10.3.0` in
`package.json` and `pnpm-lock.yaml`. Version 10.3.0 is the last compatible
preset and the exact version used by the successful resolver immediately
before the regression. This preserves the existing semantic-release version,
writer version, release configuration, and workflow permissions.

## Evidence

- `pnpm install --lockfile-only --ignore-scripts` resolves the exact 10.3.0
  pin in the lockfile.
- A direct invocation of the installed release-notes generator with the
  repository's `conventionalcommits` preset configuration and a scoped `fix`
  commit produced a `1.8.1` changelog without the missing-helper error.
- `git diff --check` passes.

Confidence: high. A post-merge push to `main` is still required to prove the
complete hosted workflow, because this workflow only resolves releases on
`main`.
