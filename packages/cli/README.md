# @pdpp/cli

Command-line tools for PDPP providers.

## Status

This package is the public npm home for the `pdpp` command. The beta CLI
supports two command namespaces:

- **`pdpp connect <provider-url>`** — delegated access: discovers provider
  metadata, self-registers a public client when the AS advertises dynamic
  registration, asks the owner to approve scoped access in the browser, and
  stores scoped client credentials in the project-local `.pdpp/` cache without
  asking for an owner bearer token.

- **`pdpp ref ...`** — reference operator diagnostics over `_ref` routes on a
  running reference deployment. Current subcommands: `pdpp ref run timeline
  <run-id>`, `pdpp ref grant timeline <grant-id>`, `pdpp ref trace show
  <trace-id>`. Requires `PDPP_OWNER_SESSION_COOKIE` when owner auth is enabled.
  These are reference-only operator tools, not core PDPP protocol.

## Install

```bash
npx -y @pdpp/cli@beta --help
```

Use the `beta` dist-tag until PDPP intentionally enables stable `latest`
publication.

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
npm trust github @pdpp/cli --repo vana-com/pdpp --file semantic-release.yml
npm trust list @pdpp/cli
```

The existing organization `NPM_TOKEN` may be used only to bootstrap first
package creation or recover from an emergency publishing incident. It is not the
steady-state release credential. If used, it must be granular,
automation-scoped, time-limited, rotated after use, and removed from the normal
release path once npm trusted publishing is verified.
