# Why

The publishable local collector currently derives its default outbox path from
the installed module directory. `npx` temporary installs, package upgrades,
global installs, cwd changes, and worktree cleanup therefore select different
SQLite files for the same source instance. A collector can report an empty
local queue while the server still reports pending work from the lost file.

# What Changes

- Resolve the default local collector outbox under the platform-appropriate
  user state directory, with a source-isolated stable filename.
- Preserve explicit `--queue`, `PDPP_COLLECTOR_QUEUE`, and profile-provided
  queue paths exactly as configured.
- Add bounded, source-aware discovery of recognized legacy SQLite outboxes,
  including the existing `~/.local/state/pdpp/collectors` stores.
- Migrate a uniquely identified package-local legacy SQLite store with an
  atomic snapshot install; never overwrite or delete the old store and fail
  closed when nonempty candidates are ambiguous.
- Route every local-collector queue operation through the shared resolver and
  add cwd/install-root, migration, ambiguity, crash/restart, and isolation
  tests.

# Impact

This changes local filesystem state selection for the publishable
`@pdpp/local-collector` CLI and its setup/run/recovery/inspection maintenance
paths. It does not change the PDPP wire protocol, server state, credentials,
outbox payloads, or token handling.
