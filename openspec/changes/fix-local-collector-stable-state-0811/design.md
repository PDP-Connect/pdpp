# Context

The current CLI uses a path below the package's resolved module directory and
then adds the source instance id to the filename. That makes source isolation
work only while the package directory survives. The package directory is not
a durable owner of user state: `npx` may replace it, global package upgrades
may replace it, and a reaped worktree removes it.

# Decisions

1. The canonical root is the platform user state directory: `XDG_STATE_HOME`
   or `~/.local/state` on Linux/other Unix systems, `~/Library/Application
   Support` on macOS, and `%LOCALAPPDATA%` or the user's local
   application-data directory on Windows. The collector uses
   `<root>/pdpp/collectors`.
2. A source-aware default is named `<connector-id>-<source-instance-id>.sqlite`
   when the connector is known. If only the source id is available, the
   fallback name is `collector-runner-queue.<source-instance-id>.sqlite`.
   Both names are filesystem-safe and keep independent source/connector lanes
   from sharing a default database. An unscoped maintenance operation uses
   `collector-runner-queue.sqlite` and does not guess a source-specific legacy
   file.
3. Explicit queue configuration is a hard boundary. A `--queue` argument,
   `PDPP_COLLECTOR_QUEUE`, or queue path loaded from a saved profile is passed
   to the outbox unchanged; it is not source-scoped, migrated, or replaced by
   discovery.
4. Default discovery is deliberately bounded. It examines only direct regular
   files in the stable collectors directory, its historical parent state
   directory, and the package-local `.pdpp-data` directory used by the old
   module-relative default. It caps candidate entries, recognizes SQLite
   headers, and asks only whether the outbox contains a row for the requested
   source. It never reads payload JSON or credentials. More than one matching
   nonempty candidate is an actionable ambiguity error; empty or unrelated
   files do not win by accident.
5. A matching store already under the stable state directory remains the
   active store, so the existing legacy
   `~/.local/state/pdpp/collectors/*.{sqlite,...}` state is discoverable without
   copying a multi-gigabyte database. A uniquely matching package-local store
   is copied with SQLite `VACUUM INTO` to a same-directory temporary file,
   synced, and installed with an exclusive hard-link step. The old file is
   retained. A crash before installation leaves the old store and an ignored
   temporary snapshot; a restart retries discovery without selecting the
   partial file. A concurrent installer never overwrites the winner.
6. The CLI bin owns one resolver call for run/sample and all outbox
   status/doctor/recover/retry/prune/compact operations. Setup/connect reach
   the same seam through their optional sample. Profile lookup remains the
   credential source and never puts a token in queue metadata or diagnostics.

# Rejected alternatives

- Keep using the package directory: it is the defect and is not durable across
  package lifecycle events.
- Use cwd-relative or repository-root state: cwd and worktrees are not stable
  user-state owners.
- Silently prefer the newest or largest legacy file: timestamps and size do
  not prove source identity, and that can discard a pending lane.
- Rename or delete the old store: migration must be recoverable and must not
  destroy the only copy of durable work.
- Copy SQLite bytes directly: a live WAL can make a main-file copy incomplete;
  `VACUUM INTO` provides a consistent snapshot.
- Put tokens, profile contents, or payload metadata in a resolver marker:
  path selection needs only source identity and filesystem facts.

# Verification strategy

- Pure resolver tests change cwd and synthetic module/install roots and assert
  the same source resolves to the same canonical path.
- SQLite fixtures prove stable legacy discovery, unique package-local
  migration, ambiguity refusal, old-state retention, source isolation, and
  restart after an unfinished migration artifact.
- Existing local-collector tests prove explicit queue/profile precedence and
  all maintenance paths continue to operate on the resolved database.
- Run the focused local-collector tests, package validation, package
  typecheck, and changed-file lint. Do not run the full repository suite.
