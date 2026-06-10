# local-device-exporter-collection Specification

## Purpose
TBD - created by archiving change design-local-device-exporter-collection. Update Purpose after archive.
## Requirements
### Requirement: Local device exporter collection SHALL preserve source-instance identity

Any local-device exporter collection design SHALL distinguish multiple devices or source instances for the same connector before records are stored or queried.

#### Scenario: Two devices export the same connector

- **WHEN** two enrolled devices export records for the same connector and stream
- **THEN** the reference SHALL preserve which source instance produced each record
- **AND** record keys from one device SHALL NOT overwrite or merge with records from another device unless an explicit cross-device identity rule says they are the same logical record.

### Requirement: Device exporters SHALL be enrolled and revocable

Local device exporters SHALL use explicit owner enrollment and revocable device credentials rather than owner tokens or public client read tokens.

#### Scenario: Owner revokes a device exporter

- **WHEN** the owner revokes an enrolled device exporter
- **THEN** the exporter SHALL no longer be able to ingest records or report trusted health for that device
- **AND** existing records SHALL remain governed by the normal grant/query model.

### Requirement: Device exporter ingest SHALL be separate from client disclosure

Device exporter credentials SHALL authorize collection-side ingest and health reporting only. They SHALL NOT authorize arbitrary RS reads as a client.

#### Scenario: A device exporter credential is used against a client query endpoint

- **WHEN** a device exporter credential is presented to a normal RS record or search endpoint
- **THEN** the reference SHALL reject it unless a separate client grant authorizes that read.

### Requirement: Local device exporters SHALL avoid broad remote filesystem exposure

The local-device exporter topology SHALL NOT require the central personal server to mount or browse the device's home directory.

#### Scenario: A filesystem-backed connector runs through a device exporter

- **WHEN** a device exporter collects Codex CLI, Claude Code, or another filesystem-backed source
- **THEN** local filesystem access SHALL remain on the device
- **AND** the central personal server SHALL receive normalized records, state, health, and diagnostics rather than raw remote filesystem access.

### Requirement: Exported batches SHALL be idempotent and replay-resistant

Pushed or scraped device-exporter batches SHALL provide enough identity to avoid duplicate logical records and to reject stale or replayed submissions where the transport claims freshness or sequencing.

#### Scenario: A device retries after a network failure

- **WHEN** a device exporter retries a batch after a transient failure
- **THEN** the server SHALL treat repeated delivery of the same logical records as idempotent
- **AND** retry SHALL NOT create duplicate records or advance freshness incorrectly.

### Requirement: Device exporters SHALL report collection freshness and health

The reference SHALL distinguish "server has old data" from "device/exporter is unreachable" and from "source produced no new data".

#### Scenario: A device stops reporting

- **WHEN** an enrolled device exporter has not reported within its expected interval
- **THEN** owner-facing diagnostics SHALL show stale or unreachable status for that device
- **AND** client-facing freshness metadata SHALL remain advisory and grant-safe.

### Requirement: Protocol status SHALL remain proposed until promoted

Local-device exporter collection SHALL remain proposed until source-instance identity, device enrollment, credential scope, ingest idempotency, and Collection Profile boundary decisions are reviewed and accepted.

#### Scenario: Experimental implementation ships in the reference

- **WHEN** the reference ships an experimental local-device exporter
- **THEN** documentation SHALL label it as reference experimental
- **AND** it SHALL NOT claim finalized PDPP protocol or Collection Profile status until this change is accepted and archived.

### Requirement: Local collectors SHALL report a build-derived agent version

A local collector SHALL report a build-derived agent version on its heartbeats so
an owner can tell which build a device is running without inspecting build
artifacts on the host. The reference SHALL store the reported value on the device
exporter and SHALL surface it on owner-facing diagnostics. The agent version SHALL
be derived from the running package/artifact and SHALL NOT be hand-entered
operator text.

The agent version SHALL be honest about provenance: a built or published artifact
SHALL report its real build revision, and an unbuilt in-repo source run SHALL
report a stable source sentinel rather than a fabricated revision. The reference
SHALL NOT invent a revision it cannot derive.

The agent version SHALL be redaction-safe: it SHALL carry only a package version
and a short revision token, and SHALL NOT carry a filesystem path, home
directory, hostname, branch name, token, cookie, or any source content.

The reported agent version is an owner-only diagnostic. It SHALL NOT be exposed to
grant-scoped clients, and it SHALL NOT alter the device's freshness, coverage,
headline state, or forward disposition. A device that has never reported an agent
version SHALL surface a null version and SHALL NOT be alarmed on its absence.

#### Scenario: A collector reports its build on heartbeat

- **WHEN** an enrolled local collector emits a heartbeat
- **THEN** the heartbeat SHALL carry a build-derived agent version composed of the
  collector package version and a short build revision
- **AND** the reference SHALL persist the reported agent version on the device
  exporter.

#### Scenario: An owner sees which build a device is running

- **WHEN** an owner views device-exporter diagnostics for a device that has
  reported an agent version
- **THEN** the diagnostics SHALL surface the stored agent version as an owner-only
  field, distinct from the collector protocol version and the freshness/health
  axes
- **AND** a device that has never reported an agent version SHALL surface a null
  version rather than an error or an alarmed state.

#### Scenario: An unbuilt source run reports an honest sentinel

- **WHEN** the collector runs from unbuilt in-repo source rather than a built
  artifact
- **THEN** the reported agent version SHALL carry a stable source sentinel as its
  revision rather than a fabricated commit identifier
- **AND** the reported value SHALL NOT contain a filesystem path, home directory,
  token, or other source secret.

