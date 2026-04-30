## Why

Agent discovery currently works up to the protected-resource metadata and skill file, then fails because the advertised `pdpp agent` CLI is not installable outside this repo and the raw-HTTP fallback is too ambiguous for weaker agents. We need a Stripe/Vercel-style executable happy path: one public CLI package, one connect command, one browser approval flow, and no owner-token shortcut.

## What Changes

- Publish an npm-installable PDPP CLI package, preferably `@pdpp/cli`, with `bin.pdpp` and a focused agent-connect surface.
- Extend the existing semantic-release workflow to publish the CLI package to npm from `main` using the existing Conventional Commits release analysis, npm trusted publishing/OIDC, and provenance for the normal GitHub Actions release path.
- Make the root package private so release automation cannot accidentally publish the workspace root.
- Add a single-command agent flow, `pdpp connect <provider-url>` or equivalent, that discovers the provider, obtains a scoped client grant through owner approval, stores the token project-locally, and verifies `/v1/schema`.
- Upgrade `pdpp_agent_discovery`, the hosted skill, `llms.txt`, 401 error hints, docs, and the web dashboard/deployment surface to advertise an executable install/connect command.
- Remove owner-token fallback language from agent guidance except as an explicit operator-only escape hatch.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-implementation-governance`: npm package publication becomes a durable release artifact alongside GitHub releases and GHCR images.
- `reference-implementation-architecture`: protected-resource metadata and RS auth errors advertise an executable agent-connect path and a no-owner-token policy.
- `reference-surface-topology`: human-facing reference/deployment surfaces expose a copyable agent connection command.

## Impact

- `packages/cli` or equivalent package layout for the publishable CLI.
- `reference-implementation/cli/**` migration or delegation to the published CLI package.
- `.releaserc.yaml`, `.github/workflows/semantic-release.yml`, root `package.json`, lockfile.
- `reference-implementation/server/index.js` and metadata builders/tests for `pdpp_agent_discovery` and 401 body hints.
- `skills/pdpp-data-access/**`, `docs/agent-skills/pdpp-data-access/**`, `apps/web/src/app/**` docs/metadata/UI.
- New CLI pack/install/connect smoke tests and release validation.
