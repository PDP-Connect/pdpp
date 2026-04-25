## Context

The repository now builds public Docker images for the reference AS/RS and web
targets. The existing Docker workflow validates pull requests and publishes
trusted refs, but it does not create releases or define how maintainers get
stable version tags.

Recent Vana repositories provide the baseline pattern:

- `vana-connect` uses semantic-release on `main`, resolves the next version
  before building release artifacts, and then runs semantic-release for the real
  GitHub/npm release.
- `vana-personal-server` uses semantic-release with Docker image publication.

PDPP is a pnpm 10.33.0 monorepo and does not currently publish an npm package.
Its release artifact is the GitHub release plus GHCR images.

## Goals / Non-Goals

**Goals:**

- Use semantic-release and Conventional Commits to create GitHub releases and
  `v${version}` tags from `main`.
- Publish stable GHCR image tags for both Docker targets from the same release
  pipeline.
- Validate release Docker images before the GitHub release is created.
- Keep PR Docker validation and trusted release publication separated.
- Avoid requiring npm publish credentials or committed release artifacts.

**Non-Goals:**

- Publishing PDPP packages to npm.
- Introducing prerelease channels such as `alpha` or `beta`.
- Requiring a personal access token or GitHub App only to fan out from a tag
  event.
- Replacing the existing Docker workflow's PR validation path.

## Decisions

### Semantic-release owns versioning and GitHub releases

Add a `.releaserc.yaml` using the Vana-standard `conventionalcommits` preset
with `@semantic-release/commit-analyzer`, release notes, GitHub publication,
and a small `@semantic-release/exec` hook that exports the published version to
the GitHub Actions step output.

Alternatives considered:

- Inline package.json release config: works, but Vana's recent repositories use
  `.releaserc.yaml`, which keeps release policy easier to inspect.
- `@semantic-release/git` and CHANGELOG commits: not needed because this repo
  does not need generated version commits, and semantic-release recommends
  avoiding package.json release commits where possible.
- npm publish plugin: out of scope for this repository today.

### Release workflow is multi-phase

The release workflow resolves the next semantic-release version in dry-run
mode, builds both Docker targets without pushing, runs semantic-release for the
real GitHub release, then pushes the versioned images only if semantic-release
published a release.

This follows the `vana-connect` pattern of discovering the next version before
release artifacts are built. For PDPP, the "artifact" is a pair of Docker image
targets rather than SEA binaries.

Alternatives considered:

- Publish images only from the existing `v*` tag workflow. This is brittle when
  semantic-release uses the built-in `GITHUB_TOKEN`, because GitHub does not
  create most downstream workflow runs from events triggered by that token.
- Use a PAT or GitHub App token only to make the tag workflow fire. That adds
  credential burden without improving the release artifact model.
- Let semantic-release run first and build images after. That could leave a
  GitHub release without corresponding images if the Docker build fails.

### Docker publication stays in GitHub Actions

Use `docker/build-push-action` and GHCR login in the workflow rather than a
semantic-release Docker plugin. The Dockerfile already exposes two targets, and
the existing workflow already uses Buildx cache, SBOM, and provenance settings.
Keeping those knobs in Actions makes the multi-image, multi-platform release
path explicit.

Alternatives considered:

- `@codedependant/semantic-release-docker`: used by `vana-personal-server`, but
  PDPP has two image targets and an existing GHCR workflow; an Actions matrix is
  clearer and avoids moving Docker-specific details into semantic-release
  plugin config.

### Image tags are release-friendly and reproducible

For each published release, the workflow SHALL push:

- `${version}` for the exact release version
- `${major}.${minor}` for a moving minor-series tag
- `latest` for the newest stable release
- `sha-${short_sha}` for commit-level traceability

The existing Docker workflow may still publish `main` from default-branch
builds and can publish images for manually created `v*` tags.

## Risks / Trade-offs

- Duplicate Docker builds in the release workflow increase CI cost. Buildx cache
  mitigates this, and the pre-release validation prevents broken image builds
  from following a successful GitHub release.
- If semantic-release determines a release is needed during dry-run but a
  concurrent release lands before the real release job, the real release may do
  nothing. The image publication job is gated on semantic-release's actual
  published-release output.
- Initial release behavior depends on repository commit history and existing
  tags. Maintainers should run the dry-run script before relying on the first
  automated release.
- GitHub-created GHCR packages may start private. Maintainers must make the
  first packages public in repository package settings, as already documented.
