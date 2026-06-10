# Proposal: surface-local-collector-build-version

## Why

A local collector can be green on every health axis while running stale code. The
host resolves the collector through an `npm link` / repo-`dist/` override, so a
source fix that has landed on `main` does not deploy until the artifact is
rebuilt. The `ri-local-collector-permanent-green-current-v1` audit found exactly
this: a recurrence-prevention fix was an ancestor of `HEAD`, every collector
connection read `healthy`, yet the deployed `dist/` predated the fix by ~7.5
hours and still ran the pre-fix code. The drift was provable only by comparing
`dist/` mtimes against source commits by hand.

That drift was **invisible to telemetry**. The `device_exporters.agent_version`
column already exists, the enroll and heartbeat wire schemas already declare an
optional `agent_version`, the heartbeat handler already reads it, and the store
already persists it via `COALESCE`. But the collector never *populates* it: the
typed heartbeat request omits the field, the runner sends no version, the
owner-facing device-exporter diagnostics projection drops the column before it
reaches any owner surface, and the console never renders it. So every enrolled
device reports an empty `agent_version`, and an owner has no way to see "this host
is running old collector code" short of inspecting build mtimes on the machine.

This change makes stale-build drift visible by populating the existing
`agent_version` field with a build-derived identifier and surfacing it on the
owner diagnostics. The identifier is derived from the running artifact, never
hand-entered operator text. Because the published package version is the `0.0.0`
placeholder, the identifier carries a short build revision (a public git
short-SHA) so the signal distinguishes one build from another even while the
semantic version is unset. It is redaction-safe by construction: a package
version plus a short commit hash, never a filesystem path, home directory,
token, or source secret.

## What Changes

- Define, under `local-device-exporter-collection`, that a local collector SHALL
  report a build-derived **agent version** on its heartbeats, populating the
  existing optional `agent_version` wire field. The value SHALL be derived from
  the running package/artifact (package version plus a short build revision),
  never from hand-entered operator text.
- Require the agent version to be **honest about provenance**: a built/published
  artifact reports its real build revision; an unbuilt in-repo source run reports
  a stable `source` sentinel rather than guessing a revision. The reference
  SHALL NOT fabricate a revision it cannot derive.
- Require the agent version to be **redaction-safe**: it SHALL carry only the
  package version and a short revision token, and SHALL NOT carry a filesystem
  path, home directory, hostname, token, cookie, or any source secret.
- Require the owner-facing device-exporter diagnostics to **surface the stored
  `agent_version`** so an owner can read which build a device last reported
  without inspecting build mtimes on the host. The field is additive and
  nullable: a device that has never reported a version surfaces `null` and is not
  alarmed.
- Require the owner console device-exporter surface to **render the reported
  agent version** as an owner-only diagnostic, distinct from the connector
  protocol version and the freshness/health axes. It changes no headline state.

## Capabilities

Modified:
- `local-device-exporter-collection`

Added:
- None

Removed:
- None

## Impact

- Reference implementation and owner/operator surfaces only. Does not change the
  public record/query/search/schema/blob `/v1` API, the Collection Profile JSONL
  messages, connector manifests, or run terminal statuses.
- **No new wire field, table, or migration.** `device_exporters.agent_version`
  and the optional `agent_version` in the enroll/heartbeat schemas already exist;
  the heartbeat handler already reads it and the store already persists it via
  `COALESCE`. This change only *populates* the field on the collector side, threads
  it through the typed heartbeat request, exposes it in the owner diagnostics
  projection, and renders it.
- Adds a build-time revision stamp to the `@pdpp/local-collector` build so the
  artifact can report its own revision. A committed source default keeps dev /
  `tsx` / test runs deterministic (they report the `source` sentinel) without a
  dirty working tree; the build overrides the compiled copy with the real
  revision. The stamped build module also records an internal `builtAt`
  timestamp, but the heartbeat value remains `version+revision`. No build-hash
  mechanism existed before this change.
- The agent version is an owner-only diagnostic and SHALL NOT be exposed to
  grant-scoped clients. It does not alter freshness, coverage, the headline state,
  or the forward disposition; a device with a `null` agent version renders no
  version cue.
