# @pdpp/cli

Command-line tools for PDPP providers.

## Status

This package is the public npm home for the `pdpp` command. The beta CLI
supports four command namespaces:

- **`pdpp connect <provider-url>`** — delegated access: discovers provider
  metadata, self-registers a public client when the AS advertises dynamic
  registration, asks the owner to approve scoped access in the browser, and
  stores scoped client credentials in the project-local `.pdpp/` cache without
  asking for an owner bearer token.

- **`pdpp owner-agent <onboard|status|revoke>`** — trusted owner-agent
  onboarding for a local agent that acts as the operator (for example Daisy).
  This is owner-level local automation, deliberately separate from the default
  grant-scoped `pdpp connect` path; ordinary agents should not use it.
  `onboard <entrypoint-url>` discovers the `pdpp_owner_agent_onboarding`
  advisory block (falling back to the RFC 8628 device-authorization shape in
  authorization-server metadata), runs browser-mediated owner approval, and
  writes the issued credential to a local file with `0600` permissions. The
  bearer is never printed; only the verification URL, code, and non-secret
  status are shown. Pass `--credential-file` to target Daisy's first supported
  path `~/applications/daisy/.pi/agent/pdpp-owner-agent.json`; otherwise the
  credential defaults to `~/.pdpp/owner-agents/<host>.json`. `status`
  introspects the stored credential and `revoke` deletes its dynamically
  registered client via RFC 7592. Owner-agent bearers are REST/control-plane
  credentials; `/mcp` rejects them.

- **`pdpp collector <advertise|enroll|run>`** — operator surface for the
  local collector runner. Pairs a host the operator controls (Claude Code or
  Codex CLI data) with a remote PDPP reference deployment via device-scoped
  enrollment, then runs connectors that the provider/control-plane container
  cannot run on its own. The runner ships separately as
  `@pdpp/local-collector` and owns the `pdpp-local-collector` binary; `pdpp
  collector ...` is a slim `@pdpp/cli` shim that resolves that package lazily.
  Public onboarding should use `npx -y @pdpp/local-collector@beta ...` or
  `npm i -g @pdpp/local-collector@beta` until the package is promoted from beta
  to latest, unless the operator intentionally wants the `@pdpp/cli` shim.

- **`pdpp ref ...`** — reference operator diagnostics over `_ref` routes on a
  running reference deployment. Current subcommands: `pdpp ref run timeline
  <run-id>`, `pdpp ref grant timeline <grant-id>`, `pdpp ref trace show
  <trace-id>`. Requires `PDPP_OWNER_SESSION_COOKIE` when owner auth is enabled.
  These are reference-only operator tools, not core PDPP protocol.

## Install

```bash
# @pdpp/cli package, npx-launched pdpp binary
npx -y @pdpp/cli@beta --help
```

Use the `beta` dist-tag until PDPP intentionally enables stable `latest`
publication.

When working from this monorepo without installing or linking the binary, use
the workspace executable:

```bash
# @pdpp/cli package, workspace-launched pdpp binary
pnpm exec pdpp ref run timeline <run-id>
```

The public command surface is still the `pdpp` binary; `pnpm exec` is only the
local workspace launcher.

The local collector runtime is a separate public package:

```bash
# @pdpp/local-collector@beta package, npx-launched pdpp-local-collector binary
npx -y @pdpp/local-collector@beta advertise

# @pdpp/local-collector@beta package, installs the pdpp-local-collector binary
npm i -g @pdpp/local-collector@beta
pdpp-local-collector advertise
```

## Ownership And Publishing

The intended npm scope is `@pdpp`, owned by the durable PDPP/Vana project
organization rather than an individual maintainer. Normal publication is handled
by semantic-release from GitHub Actions using npm trusted publishing/OIDC and
registry provenance when the source repository is public. npm does not support
provenance for packages published from private GitHub repositories, so
`publishConfig.provenance` stays disabled until this repository is public.

After the package exists on npm, configure the trusted publisher with npm CLI
11.5.1+:

```bash
# npm trust command for the @pdpp/cli package publisher config
npm trust github @pdpp/cli --repo vana-com/pdpp --file semantic-release.yml
npm trust list @pdpp/cli
```

The existing organization `NPM_TOKEN` may be used only to bootstrap first
package creation or recover from an emergency publishing incident. It is not the
steady-state release credential. If used, it must be granular,
automation-scoped, time-limited, rotated after use, and removed from the normal
release path once npm trusted publishing is verified.
