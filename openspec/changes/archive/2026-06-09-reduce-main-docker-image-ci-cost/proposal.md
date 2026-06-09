## Why

June Actions usage shows the Docker image workflow as the dominant cost center:
in the first 500 runs, `docker-images` consumed roughly 3,429 job-minutes, mostly
from publishing `reference` and `web` images on `main` pushes. The release
workflow already owns beta/version GHCR publication, so default-branch pushes
should validate Docker buildability without pushing multi-arch images every
time.

## What Changes

- Stop publishing GHCR `reference` / `web` images from ordinary `main` pushes.
- Keep Docker build validation for pull requests and Docker-relevant
  default-branch pushes, but make validation non-publishing and single-platform.
- Keep explicit image publication available from trusted release refs (`v*` tags)
  and manual workflow dispatch.
- Narrow Docker workflow path filters so documentation/spec-only changes do not
  trigger image builds.
- Update documentation/spec wording that still implies default-branch image
  publication as a normal path.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `reference-implementation-architecture`: default-branch Docker CI validates
  buildability; image publication is reserved for release tags or explicit
  maintainer dispatch.

## Impact

- `.github/workflows/docker-images.yml`
- `README.md`
- OpenSpec release/Docker-publication wording
- No runtime, API, connector, or package behavior changes.
