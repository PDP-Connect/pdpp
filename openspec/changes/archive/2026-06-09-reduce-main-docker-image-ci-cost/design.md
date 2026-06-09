## Context

The `docker-images` workflow currently publishes two multi-arch GHCR images on
ordinary `main` pushes. The June 2026 Actions audit found this workflow consumed
roughly 3,429 job-minutes in the first 500 runs, with `publish web` and
`publish reference` accounting for the largest share. The release policy already
makes the semantic-release workflow the durable path for beta/version public
images, so the default-branch publish behavior is both expensive and
duplicative.

## Goals / Non-Goals

**Goals:**

- Preserve Docker build validation on pull requests and Docker-relevant
  default-branch pushes.
- Stop pushing GHCR images from every qualifying `main` push.
- Keep explicit trusted publication for release tags or maintainer-dispatched
  image refreshes.
- Avoid Docker workflow runs for spec/design-note-only edits.

**Non-Goals:**

- No change to semantic-release, npm publication, or stable release image tags.
- No change to Dockerfile contents, runtime image contracts, or compose defaults.
- No attempt to tune the reference full-test workflow in this tranche.

## Decisions

1. **Default branch validates, it does not publish.**
   The workflow still catches Docker breakage after direct default-branch edits,
   but it no longer spends multi-arch publish minutes on every commit. Release
   images remain owned by semantic-release, while manual dispatch remains an
   explicit escape hatch for refreshing a moving development image.

2. **Validation uses a cheaper platform shape.**
   Pull request and default-branch validation can build `linux/amd64` only. The
   release/publish path remains responsible for the published platform set,
   provenance, SBOM, and registry push.

3. **Path filters match image-affecting inputs.**
   Documentation, design notes, OpenSpec artifacts, and root spec markdown do not
   change runtime image behavior. The Docker workflow should not run for those
   paths unless another image-affecting file also changed.

## Risks / Trade-offs

- `ghcr.io/vana-com/pdpp/*:main` no longer updates on every commit. Mitigation:
  document it as a maintainer-refreshed development tag and keep manual dispatch
  available.
- A direct default-branch commit can pass single-platform validation while an
  arm64 build would fail. Mitigation: release image validation and publication
  still use the published platform set before stable tags ship.
- Manual dispatch can still incur heavy image-publish cost. Mitigation: that cost
  becomes intentional and auditable instead of automatic for every merge.
