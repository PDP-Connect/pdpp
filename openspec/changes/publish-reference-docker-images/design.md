## Context

`support-reference-docker` added a production-style Dockerfile and Compose
assembly for the live reference stack. It still assumes local image builds.
That is good for contributors and smoke validation, but a public self-hosted
path should let operators pull images, pin tags, understand persistence, and
avoid baking secrets or local state into images.

Prior art:

- GitHub's Docker publishing guidance uses `docker/login-action`,
  `docker/metadata-action`, `docker/build-push-action`, and registry-backed
  attestations for image publishing.
- Docker's GitHub Actions guidance points to the official Docker actions for
  build, metadata, login, and multi-platform build workflows.
- Docker's GitHub Actions cache backend is the right default for BuildKit
  caching in workflows, with a distinct cache scope per image.
- Docker Compose's develop/watch model reinforces the existing split between
  production-style images and opt-in hot-reload development.

Current constraints remain:

- Root pnpm workspace install through Corepack.
- Debian/Ubuntu Node image, not Alpine.
- Two runtime images from one Dockerfile: `reference` and `web`.
- Browser-facing `PDPP_REFERENCE_ORIGIN` stays distinct from container-internal
  AS/RS URLs.
- SQLite, embedding cache, and browser connector state stay runtime-mounted.
- Secrets are runtime env/secrets only.

## Goals / Non-Goals

**Goals:**

- Publish public GHCR images for the reference AS/RS image and web image.
- Build both Docker targets in pull request CI without pushing images.
- Push images only from trusted refs such as `main`, version tags, and manual
  workflow dispatch.
- Attach useful OCI labels, SBOM/provenance metadata where BuildKit supports
  it, and practical tags for both convenience and reproducibility.
- Document a self-hosted operator flow that uses public images without pnpm or
  a local build.
- Keep the local `docker compose ... up --build` and `pnpm docker:smoke` paths.

**Non-Goals:**

- Do not publish connector/browser-profile state or sample personal data.
- Do not introduce a new hosted control plane or deployment platform.
- Do not guarantee every browser connector works unattended in a container.
- Do not require public images for local development.
- Do not add Docker Hub, ECR, or other registries in the first publication
  path.

## Decisions

### 1. Publish two images under the repository GHCR namespace

Publish:

- `ghcr.io/vana-com/pdpp/reference`
- `ghcr.io/vana-com/pdpp/web`

This matches the current Compose service boundary and avoids inventing a
supervisor image. Forks can override `PDPP_REFERENCE_IMAGE` and
`PDPP_WEB_IMAGE` if they want their own registry namespace.

Alternative considered: one all-in-one image. That may be useful for demos
later, but it would obscure the AS/RS plus web boundary that the reference
architecture is intentionally preserving.

### 2. Keep Compose buildable and pullable

Add `image:` names to the existing services while retaining `build:` blocks.
Operators can run `docker compose pull` and then `docker compose up`; local
contributors and smoke validation can keep using `--build`.

Alternative considered: a separate `docker-compose.images.yml`. That creates
another entrypoint for users to choose between. Keeping one Compose file with
both image names and build definitions is easier to explain and still supports
both workflows.

### 3. Use trusted-ref publishing and PR build validation

Pull requests should build both targets but not push. `main`, version tags, and
manual dispatch may push to GHCR. The workflow should use `GITHUB_TOKEN` with
minimum required package permissions and no registry secrets.

Tag policy:

- `main` tracks the latest successful build from the default branch.
- `sha-<short>` is immutable enough for issue reports and rollback.
- `vX.Y.Z` and `vX.Y` come from `v*` tags when releases exist.
- `latest` is only emitted for version tags, not every `main` push.

Operators should be told to pin a version tag, SHA tag, or digest for anything
more durable than local testing.

### 4. Use Docker metadata, cache, SBOM, and provenance support

Use Docker's official GitHub Actions to generate tags/labels and BuildKit
metadata. Export BuildKit cache to the GitHub Actions cache backend with a
separate scope per image target so `reference` and `web` builds do not evict
each other.

Use BuildKit `sbom` and `provenance` output on pushed images. If the registry
or action ecosystem changes, preserving successful image publication takes
priority over blocking the workflow on optional metadata.

### 5. Document the public-image operational posture

The README should lead with:

- Copy `.env.docker.example` to `.env.docker`.
- Set `PDPP_OWNER_PASSWORD`.
- Pull images.
- Start Compose.
- Open the browser-facing origin.

The docs should also cover image overrides, tag policy, volume persistence,
first-boot embedding cache behavior, browser connector caveats, upgrades, and
the distinction between public-image operation, local builds, smoke validation,
and hot reload.

## Risks / Trade-offs

- CI time increases -> Scope CI to Docker-relevant paths and use BuildKit
  cache.
- GHCR package defaults may not be public -> Document the package visibility
  step after first publish.
- Multi-arch native dependencies may fail or be slow -> Start with Buildx and
  keep the workflow easy to narrow to `linux/amd64` if native builds prove
  unreliable.
- Users may treat `main` as stable -> Document that `main` is moving and
  pinned tags/digests are preferred for durable self-hosting.
- Compose may build locally when users expected pulls -> Document `docker
  compose pull` for public images and `--build` for local source builds.

## Migration Plan

1. Add image names to Compose with env overrides.
2. Add a Docker image workflow that builds both targets and publishes from
   trusted refs.
3. Update `.env.docker.example`, root README, and reference README with the
   public-image flow and tag policy.
4. Validate Compose config, workflow YAML syntax, OpenSpec strict validation,
   and existing Docker smoke where ports permit.

Rollback: remove the workflow and image-name docs. The runtime stack remains
locally buildable because the existing Dockerfile and Compose build blocks stay
intact.

## Open Questions

- Should Docker Hub mirroring be added after GHCR is proven?
- Should public images become release-gated only once the reference reaches a
  stable external versioning policy?
- Should browser-connector-heavy images split into a larger optional image
  profile later?
