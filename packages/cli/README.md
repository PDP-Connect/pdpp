# @pdpp/cli

Command-line tools for PDPP providers.

## Status

This package is the public npm home for the `pdpp` command. The initial package
scaffold is intentionally narrow: package startup, help output, and shared
package metadata are in place before the no-owner-token `pdpp connect` flow is
advertised by provider metadata or hosted docs.

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
