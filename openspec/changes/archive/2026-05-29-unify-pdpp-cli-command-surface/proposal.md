## Why

The PDPP CLI is now published for public delegated access, but the reference
dashboard also exposes repo-local `pdpp` operator commands. That split is
currently easy to misunderstand: users see one command name, but two different
install and support models.

## What Changes

- Define a single public `pdpp` command tree as the long-term user-facing CLI
  surface.
- Keep reference/operator diagnostics under an explicit namespace such as
  `pdpp ref ...` or `pdpp operator ...`, rather than a second ambiguous CLI.
- Decide which operator commands are safe to ship in `@pdpp/cli`, and keep
  unsafe or server-coupled commands repo-local until their auth and dependency
  posture are publishable.
- Make dashboard, docs, and CLI help distinguish public delegated-access
  commands from reference-operator commands with copy that matches the actual
  install path.
- Add acceptance checks proving the public npm package, repo-local reference
  wrapper, and dashboard examples all agree on the command tree.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-implementation-architecture`: clarify the durable CLI boundary
  between public delegated-access commands and reference/operator diagnostics.
- `reference-surface-topology`: require human-facing copy to advertise the
  correct install path and command namespace for each CLI task.
- `reference-implementation-governance`: require package validation to prove
  command ownership, namespace stability, and publishable dependency boundaries.

## Impact

- `packages/cli/**`
- `reference-implementation/cli/**`
- Root workspace package/bin wiring and lockfile
- Dashboard timeline/peek CLI copy and reference docs
- CLI tests, package smoke tests, and reference CLI tests
- Existing `publish-pdpp-cli` decisions and metadata source-of-truth helpers
