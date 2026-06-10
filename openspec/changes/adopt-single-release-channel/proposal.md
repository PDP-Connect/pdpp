# Proposal: adopt-single-release-channel

## Why

The release train ran two channels: publishable work landed on `main`, but
semantic-release published only when an owner advanced the `beta` branch and
pushed it, cutting `0.1.0-beta.N` prereleases to npm's `beta` dist-tag. The
`beta` branch was a second moving part with no countervailing benefit:

- It rotted. The branch drifted three weeks behind `main`, broke two release
  runs in one day (2026-06-10), and nearly regressed the live collector by
  re-publishing stale code over newer fixes.
- It was redundant. Semver 0.x already signals prelaunch; a `beta` dist-tag on
  top of `0.x` versions communicates nothing extra to operators.
- It taxed every surface. Docs, dashboard copy, CLI help, AS discovery
  metadata, and the doctor remediation all had to carry `@beta` pins (plus a
  dedicated cadence-lag guard, `check-beta-cadence.mjs`, built solely to detect
  the channel's own staleness failure mode).
- Prior art: Stripe, Vercel, and Plaid ship one stable channel with an
  optional canary; none run beta-only.

Owner decision, final: "no beta anywhere."

## What Changes

- **Release config** (`.releaserc.yaml`): release from `main` only; no
  prerelease branch. Versions stay 0.x (graduating from `0.1.0-beta.N` to
  `0.1.0`) and publish to npm's default `latest` dist-tag. `1.0.0` becomes an
  intentional owner milestone, not a commit-phrasing accident.
- **Workflow** (`.github/workflows/semantic-release.yml`): trigger on push to
  `main` (plus `workflow_dispatch`); Docker image tags publish `latest` instead
  of `beta`.
- **Retired machinery**: `beta-cadence.yml`, `check-beta-cadence.mjs` and its
  test, and the `release:cadence-check*` scripts are deleted — the lag they
  guarded against cannot exist with a single channel.
- **Policy inversion**: `check-package-release-policy.mjs` now requires
  `publishConfig.tag: "latest"`, forbids the retired `@beta` dist-tag in active
  install docs (instead of requiring it), and asserts the single-channel shape
  of `.releaserc.yaml` and the workflow.
- **Surface sweep**: every owner/agent-visible `@pdpp/*@beta` specifier becomes
  the plain package name — docs, dashboard/UI command builders, CLI help text,
  local-collector doctor remediation, AS discovery metadata
  (`version_policy: "latest"`), and the owner-journey harness manifest.
- **Spec deltas**: governance and surface-topology requirements that pinned the
  beta channel/wording are updated to the single-channel posture.

## Impact

- Affected specs: `reference-implementation-governance` (npm publish posture,
  CLI release scenarios), `reference-surface-topology` (operator copy and
  drift-warning wording). The active `publish-mcp-server-package` change's
  `mcp-adapter` delta is reworded in place (it had not yet been archived).
- Affected code: `.releaserc.yaml`, `.github/workflows/semantic-release.yml`,
  root `package.json` scripts, `packages/{cli,local-collector,mcp-server}`
  manifests and command/help surfaces, console/site command libraries, the
  owner-journey acceptance harness, release policy checks, and operator docs.
- Not in scope (owner steps after the first `main` release proves out): delete
  the `beta` git branch, deprecate the `0.0.0` npm placeholders, and retire or
  repoint the npm `beta` dist-tag.
- Version continuity: existing tags are `v0.0.0` and `v0.1.0-beta.1..N` on the
  `beta` lineage. The lane carries a `git merge -s ours beta` graduation merge
  so `v0.0.0` is reachable from `main`; semantic-release (which ignores
  prerelease tags on a release branch) then computes the next version from
  `v0.0.0` + Conventional Commits — `feat` commits exist and no
  breaking-change markers do, so the first single-channel release is `0.1.0`,
  not an accidental `1.0.0` and not a tag collision.
