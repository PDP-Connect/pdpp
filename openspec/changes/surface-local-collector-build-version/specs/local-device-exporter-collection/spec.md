# Spec delta: local-device-exporter-collection

## ADDED Requirements

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

The agent version SHALL be redaction-safe: it SHALL carry only a package version,
a short revision token, and (on local diagnostics) a build timestamp, and SHALL
NOT carry a filesystem path, home directory, hostname, branch name, token, cookie,
or any source content.

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
