# Release self-service smoke

This gate proves the forkable reference implementation from a fresh Docker
Compose project. It uses the existing release matrix, owner-journey acceptance
scan, hosted MCP OAuth tests, and a stable fixture-source smoke. It does
not change the operator UI or reference runtime.

Run it after a release has published one exact version to npm and immutable
image digests to GHCR:

```sh
pnpm install --frozen-lockfile

pnpm release:selfservice-smoke -- \
  --version 0.4.0 \
  --reference-image ghcr.io/pdp-connect/pdpp/reference:0.4.0@sha256:<reference-digest> \
  --web-image ghcr.io/pdp-connect/pdpp/web:0.4.0@sha256:<web-digest> \
  --postgres-image pgvector/pgvector:pg16@sha256:<postgres-digest> \
  --receipt /tmp/pdpp-release-selfservice-0.4.0.json
```

The command fails before starting Compose when the exact npm artifacts, image
digests, Docker daemon, or Docker Compose are unavailable. A passing run
proves, in order:

- the committed SHA, Node `>=22.14`, release policy, pinned package matrix, and
  exact published npm tarballs;
- the public landing artifact does not advertise a non-hosted MCP origin;
- Compose config, image resolution, startup, service health, metadata, and the
  unauthenticated owner redirect;
- a stable non-secret fixture source produces records, then hosted
  OAuth/PKCE issues a scoped client that can query them; anonymous access,
  owner bearers, revoked access tokens, and revoked refresh tokens are denied;
- all containers in the Compose project, its labeled volumes, and same-project
  orphans are removed.

The receipt is secret-free and separates stable outcome evidence from per-run
metadata. It binds the source HEAD and source closure, the resolved image
digests, and OCI source/revision labels when images advertise them. Missing
labels are recorded as unavailable; the smoke does not infer image-to-SHA
provenance. The Compose project nonce, loopback port, owner credentials, PKCE
verifier, and observation timestamp are intentionally different per run.
Verify that the stable outcome is still bound to the same committed source
before replaying:

```sh
pnpm release:selfservice-smoke -- \
  --verify-receipt /tmp/pdpp-release-selfservice-0.4.0.json
```

Gmail plus Claude Code is a separate live UAT named `selfservice-live-uat`. It
must use a real deployed origin, a real Gmail account/app password, and the
real Claude Code OAuth callback. The fixture gate never fakes that UAT;
follow [`hosted-mcp-setup.md`](./hosted-mcp-setup.md) only after the fixture
gate passes. No live deploy, registry publish, or external mutation is part of
this command.
