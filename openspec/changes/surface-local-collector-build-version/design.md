# Design: surface-local-collector-build-version

## Problem

`device_exporters.agent_version` is fully plumbed end-to-end except for the one
step that gives it a value. The wire schemas (`DeviceEnrollmentExchangeBodySchema`,
`DeviceHeartbeatBodySchema` in `packages/reference-contract/src/reference/index.ts`)
already declare an optional `agent_version: { type: "string" }`. The heartbeat
route handler (`reference-implementation/server/routes/ref-device-exporters.ts`)
already reads `body.agent_version` and passes it to the store. The store
(`device-exporter-store.js`) already persists it on both backends — SQLite and
Postgres — using `agent_version = COALESCE($3, agent_version)` so a `null` in a
heartbeat preserves a previously-stored value. `mapDevice` already returns
`agentVersion: row.agent_version`.

But the value is always empty, because:

1. The typed `HeartbeatRequest` (`local-device-client.ts`) has no `agent_version`
   field, so the client cannot type-safely send one.
2. The collector runner (`collector-runner.ts`) never computes or sends a version
   on any of its heartbeat call sites.
3. The owner diagnostics projection (`projectDeviceExporter`) drops `agentVersion`
   — the projected `device_exporter` object omits it entirely.
4. The console device-exporter page never renders it.

So the audited failure mode — a host running stale collector `dist/` while every
health axis reads green — is invisible. The remedy is to populate the existing
field with a build-derived identifier and surface it, not to invent a new
contract.

## What "agent version" is

The value SHALL be derived from the running artifact, in the form:

```
<package-version>+<revision>
```

- `<package-version>` is the resolved `@pdpp/local-collector` package version
  (today the `0.0.0` placeholder; a real version once published).
- `<revision>` is a short build identifier: a public git short-SHA for a built
  artifact, or the stable `source` sentinel for an unbuilt in-repo / `tsx` run.

Example built value: `0.0.0+43f63825f03a`. Example dev/source value:
`0.0.0+source`.

This is sufficient to answer the audit's question ("is the host on old code?"):
an owner compares the reported `<revision>` against `main`. The `+source` sentinel
truthfully says "this is an unbuilt source run, not a published build" — the same
honesty the existing `deployment_posture` surface already encodes with its
`repo_dist_override` / `is_placeholder_version` flags.

### Why a build-time revision, not a runtime git read

The host runs a built `dist/`, often with no git checkout adjacent to the
installed package. Reading git at runtime is therefore unreliable and would leak
nothing useful when absent. The revision is instead stamped **at build time**,
when the build is necessarily running inside the repo and `git rev-parse` is
available. A committed source-default module reports `+source`; the build
overrides the compiled copy with the real revision.

### Redaction

The agent version carries only: a semantic version string and a short revision
token (`[0-9a-f]{7,40}` or the literal `source`). It SHALL NOT carry a filesystem
path, home directory, hostname, branch name, token, cookie, or any source
content. The compiled build-info module also records an internal `builtAt`
timestamp for artifact provenance, but that timestamp is not part of the
heartbeat string. A short commit SHA is public information for an open-source
repository and is the same identifier already printed by `git log` on `main`.

## Mechanism

### Build-info module (`packages/polyfill-connectors/src/collector-build-info.ts`)

A new committed module exports the build identity:

```ts
export interface CollectorBuildInfo {
  builtAt: string | null;   // ISO-8601 build timestamp, or null for source runs
  revision: string;          // short git SHA, or the "source" sentinel
  version: string;           // resolved package version (placeholder default)
}
export const COLLECTOR_BUILD_INFO: CollectorBuildInfo = {
  builtAt: null,
  revision: "source",
  version: "0.0.0",
};
export function buildAgentVersion(info = COLLECTOR_BUILD_INFO): string {
  return `${info.version}+${info.revision}`;
}
```

The committed default is the **source** identity: `0.0.0+source`. Dev runs,
`tsx`, and unit tests import this module directly and deterministically read
`+source`, with no working-tree mutation and no build step required.

### Build-time override (`packages/local-collector/scripts/postbuild.mjs`)

`postbuild.mjs` already runs on every `pnpm --filter @pdpp/local-collector build`
(after `tsc`, over `dist/`). It will additionally overwrite the compiled
`dist/polyfill-connectors/src/collector-build-info.js` with a freshly-generated
module body carrying the real `version` (read from the resolved package.json),
`revision` (`PDPP_BUILD_REVISION` env override, falling back to
`git rev-parse --short=12 HEAD`, then to `source` when neither is available so a
git-less CI build still produces an honest sentinel rather than crashing the
build), and `builtAt` (the build's ISO timestamp). The override is a full module
rewrite, not a fragile in-place patch.

`collector-build-info.ts` is added to `local-collector/tsconfig.build.json`'s
explicit `include` list so it compiles into `dist`, and its `.d.ts` is kept by
`postbuild.mjs`'s `declarationKeep` set.

### Heartbeat population (`collector-runner.ts` + `local-device-client.ts`)

`HeartbeatRequest` gains an optional `agent_version?: string`. The runner computes
`buildAgentVersion()` once and includes it on every heartbeat it emits: the
initial `starting` heartbeat, the final status heartbeat, the corrective
post-throw heartbeat, and the skip-for-backlog heartbeat. The COALESCE store
update means even heartbeats that omit it (none, after this change) would preserve
the last value; sending it on every heartbeat keeps the stored value fresh and
self-healing across restarts.

The enroll path is intentionally **not** changed to send a version: the heartbeat
is the recurring, authenticated channel that already updates the device row, and
it carries the live build on every run. Populating it on enroll would set the
value once at pairing and then never refresh it across rebuilds — strictly worse
for drift detection. Enroll keeps its existing behavior; the schema's optional
enroll `agent_version` stays available but unused by this change.

### Owner surfacing

- `projectDeviceExporter` adds `agent_version: device.agentVersion ?? null` to the
  projected `device_exporter` object. Additive and nullable.
- The console device-exporters page (`apps/console/.../device-exporters/page.tsx`)
  renders the reported agent version in the device metadata block as an
  owner-only diagnostic, shown only when present.

## Alternatives considered

- **New `build_revision` wire field.** Rejected: `agent_version` already exists on
  the wire and in storage for exactly this purpose; adding a parallel field would
  be redundant contract surface.
- **Runtime git read on the host.** Rejected: unreliable (host has no adjacent
  checkout) and a path-leak risk. Build-time stamping is deterministic and
  redaction-safe.
- **Populate on enroll instead of heartbeat.** Rejected: enroll fires once at
  pairing; it would never refresh across rebuilds, defeating drift detection.
- **Embed the full 40-char SHA / branch / dirty flag.** Rejected as over-scope and
  mild redaction risk (branch names can leak intent). A short SHA is enough to
  compare against `main`.

## Acceptance checks

- A collector run sends a non-empty, build-derived `agent_version` on its
  heartbeats; in dev/test it is `0.0.0+source`. (`collector-runner.test.ts`)
- `buildAgentVersion()` composes `version+revision`; the committed default is
  `0.0.0+source`. (new `collector-build-info` unit test)
- The device-exporter diagnostics projection includes `agent_version`, `null`
  when unset and the stored string after a versioned heartbeat. (device-exporter
  route test)
- The agent version string matches `^[^+]+\+([0-9a-f]{7,40}|source)$` and contains
  no path separator, home dir, or secret token. (unit assertion)
- `openspec validate surface-local-collector-build-version --strict` passes.
- `pnpm --filter @pdpp/reference-contract run check:generated` stays clean (no
  schema change — the wire field already exists).
