# Site register branch report

## Finding

The confirmation endpoint wrote to the private repository through GitHub's
Contents API without a `branch` field. GitHub therefore selected the default
branch, where the PDP-Connect DCO ruleset rejects the bot's direct commit.

## Change

- `apps/site/src/lib/signing/providers.ts` defaults
  `PDPP_PRIVATE_REPO_BRANCH` to `signatures` and sends it in signatory and
  withdrawal-log PUTs. Withdrawal reads use that branch as `ref`, its delete
  carries the branch, and the branch is checked before a withdrawal can treat a
  missing file as ordinary.
- Every bot commit message now includes
  `Signed-off-by: pdpp-supporters-bot <bot@pdpp.dev>`.
- `docs/registers.md` records that the public repository's scheduled workflow
  reads `signatures`, while maintainers merge that private branch into its
  protected default branch.

The public repository now owns the daily `publish-supporters` workflow. It
checks out the private `signatures` branch with the existing
`PDPP_PRIVATE_REPO_TOKEN`, runs an allowlist-only publisher, and commits only
`supporters.json` with the public repository's `GITHUB_TOKEN`. The private
repository's publish workflow is retired.

The private publish/export scripts are not present in this repository. Their
current `signatures`-branch contents were retrieved to port the public-field
publisher; the export script remains a manual private-repository operation.

## Verification

- `pnpm --dir apps/site test -- --test-name-pattern='private register PUTs'`
  passed: 203 tests.
- `pnpm --dir apps/site build` passed after the final provider change.
- `pnpm exec biome check --write apps/site/src/lib/signing/providers.ts
  apps/site/src/lib/signing/providers.test.ts docs/registers.md` passed.
- `pnpm --dir apps/site test -- --test-name-pattern='publish supporters'`
  passed: 205 tests. Its fixture proves private record values do not appear in
  the generated public JSON.
- `actionlint .github/workflows/publish-supporters.yml` passed.

The provider is marked `server-only`, so its test is a source-level regression
guard for the exact GitHub request shapes rather than an importable unit test in
the Node test runner. A live preview confirmation remains the needed final
integration check against the private repository and its branch rules.
