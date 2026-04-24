## 1. Compose Image Inputs

- [x] 1.1 Add public image names and env overrides to the Compose services.
- [x] 1.2 Add image override variables to `.env.docker.example`.

## 2. Public Image CI

- [x] 2.1 Add a GitHub Actions workflow that builds `reference` and `web` Docker targets on pull requests.
- [x] 2.2 Configure trusted-ref GHCR publishing with tag metadata, cache, SBOM, and provenance requests.
- [x] 2.3 Keep workflow permissions limited to source checkout, package publish, and attestation identity needs.

## 3. Documentation

- [x] 3.1 Update the root README with public-image quick start, tag policy, upgrade, local-build, smoke, and hot-reload paths.
- [x] 3.2 Update the reference implementation README with the same operator posture and persistence caveats.

## 4. Acceptance Checks

- [x] 4.1 Run `docker compose --env-file .env.docker.example config`.
- [x] 4.2 Parse the Docker image workflow YAML.
- [x] 4.3 Run `openspec validate publish-reference-docker-images --strict`.
- [x] 4.4 Run `openspec validate --all --strict`.
