## Why

The reference stack now has a supported Docker Compose path, but operators still
need to build images locally and infer the public-image story from source. That
is a weak first impression for self-hosters and implementation reviewers who
expect a documented, pullable image path with CI provenance.

## What Changes

- Publish public reference Docker images for the `reference` AS/RS target and
  the `web` target from CI.
- Add GitHub Actions coverage that builds both targets on pull requests and
  pushes GHCR images from trusted refs.
- Tag images with useful moving and immutable tags so users can choose between
  convenience and reproducibility.
- Add README documentation for pull-based Compose usage, image names, tag
  policy, required env, persistence, secrets, upgrades, and dev hot reload.
- Keep local `--build` Compose support for contributors and smoke validation.
- Keep secrets, SQLite data, model caches, and connector browser profiles out
  of images.

## Capabilities

### New Capabilities

*(none)*

### Modified Capabilities

- `reference-implementation-architecture`: add requirements for public Docker
  image publication, image metadata/tagging, and operator-facing Docker docs.

## Impact

- New GitHub Actions workflow under `.github/workflows/`.
- Compose image names for the existing `reference` and `web` targets.
- README/reference documentation for public image consumption and publishing.
- Possible CI build time increase from building two Docker targets.
- No PDPP protocol changes and no runtime API changes.
