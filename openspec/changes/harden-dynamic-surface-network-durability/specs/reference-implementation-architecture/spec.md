## ADDED Requirements

### Requirement: Dynamic n.eko surfaces SHALL survive an ordinary Compose redeploy

Dynamic n.eko surface containers and the network they depend on for
reachability SHALL NOT be destroyed or torn down as a side effect of an
ordinary `docker compose down` and `docker compose up` cycle against the
reference's Compose project. The network dynamic surfaces attach to SHALL be
externally managed (created and owned outside the Compose project's own
lifecycle), not a Compose-created project network subject to unconditional
removal on `down`.

#### Scenario: An operator runs `docker compose down` followed by `docker compose up`

- **WHEN** an operator or script runs `docker compose down` (with or without
  `--remove-orphans`) against the reference's Compose project, followed by
  `docker compose up`
- **THEN** any live dynamic n.eko container SHALL still be running afterward
  under the same container id
- **AND** `reference` and the n.eko allocator SHALL still be able to reach it
  over the network
- **AND** no ChatGPT (or other retained-surface) connection SHALL require
  re-authentication as a result

#### Scenario: The dynamic-surface network does not yet exist

- **WHEN** the reference stack starts cold, before the dynamic-surface
  network has ever been created
- **THEN** either the deploy script or the allocator itself SHALL create the
  network idempotently before any service attaches to it
- **AND** a concurrent creation race SHALL NOT be treated as a startup
  failure

#### Scenario: Genuine container loss still occurs

- **WHEN** a dynamic n.eko container's process is genuinely lost (host
  reboot, OOM-kill, image change forcing recreate, or an operator directly
  removing the container outside Compose)
- **THEN** the existing single clean `session_required` repair behavior
  SHALL apply unchanged
- **AND** this requirement SHALL NOT be read as promising recovery from
  genuine process loss

### Requirement: Existing surfaces SHALL migrate in-place to the externally-managed network

A dynamic n.eko container created before this change (attached only to the
Compose default network, or any other single explicitly-configured legacy
network) SHALL be migrated onto the allocator's externally-managed network
in place — without being replaced, recreated, or having its credential-
bearing session interrupted — the first time the allocator's `ensureSurface`,
`getSurfaceStatus`, or `listSurfaces` operations observe it.

#### Scenario: A legacy-network-only container is accessed after the allocator upgrades to an externally-managed network

- **WHEN** the allocator finds an owned, running container that is not
  attached to its configured expected network
- **THEN** it SHALL attach the expected network to that same container
  (idempotent; a concurrent attach by another process is treated as success)
- **AND** SHALL verify the attachment by re-inspecting the container before
  proceeding
- **AND** SHALL verify the container is actually reachable over the expected
  network specifically — by probing the container's own IP address on that
  network (read from the inspect response), never by container-name DNS,
  since an allocator attached to both the expected and legacy networks could
  resolve a name-based probe via either network and would prove nothing
  network-specific
- **AND**, only after both the attachment AND reachability are verified, and
  only if a legacy network name was explicitly configured, SHALL detach the
  container from that legacy network
- **AND** SHALL NOT detach, remove, or otherwise touch any network the
  container is attached to other than the one explicitly configured as
  legacy
- **AND** the container id and process (`StartedAt`) SHALL be unchanged
  before and after migration

#### Scenario: The network attach step fails

- **WHEN** attaching the expected network to an existing container fails
- **THEN** the existing container SHALL be preserved unchanged (not removed,
  not replaced)
- **AND** the surface SHALL report a bounded, non-terminal pending state
  (health `starting`, reason `legacy_network_migration_pending`), never
  `unhealthy`, so that callers do not fail an otherwise-recoverable lease
- **AND** the next access SHALL retry the migration

#### Scenario: The network attach succeeds but reachability verification or the legacy detach fails

- **WHEN** the expected network attaches successfully but either (a) the
  container is not yet reachable over that network, or (b) reachability is
  confirmed but detaching the configured legacy network fails
- **THEN** the legacy network SHALL remain attached until a later access
  confirms reachability and/or succeeds at detaching it
- **AND** in case (a), the surface SHALL report the bounded pending state
  from the prior scenario, never `unhealthy`
- **AND** in case (b), the surface SHALL report `ready` (it is confirmed
  reachable on the expected network already) and this SHALL NOT block or
  fail the surface's health

#### Scenario: No legacy network is configured

- **WHEN** the allocator has no explicitly configured legacy network name
- **THEN** it SHALL still attach the expected network to a legacy-only
  container
- **AND** SHALL NOT attempt to detach any network, since only an explicitly
  configured legacy network may ever be detached

#### Scenario: `docker compose down` after migration

- **WHEN** an operator runs `docker compose down` after every previously
  legacy-attached surface has migrated (no container remains attached only
  to the legacy Compose-created network)
- **THEN** `docker compose down` SHALL succeed and remove the (now-empty)
  legacy Compose-created network without error

### Requirement: Allocator container ownership SHALL be scoped to an explicit deployment identity

Every allocator instance SHALL be configured with a required deployment
identity with no code-level default value, and that identity SHALL equal
the Compose project identity (`COMPOSE_PROJECT_NAME`) this allocator
instance is running under, not a second, independently-configured identity
concept. The allocator SHALL only ever enumerate, inspect for management
purposes, migrate, reuse, or otherwise act on Docker containers carrying its
own exact deployment identity, or (only for containers with no deployment
identity label at all) whose Docker-Compose-assigned
`com.docker.compose.project` label matches this allocator's own deployment
identity — never a container belonging to a different deployment identity
or a different Compose project, and never a container discovered solely via
the generic ownership label without this check, regardless of what other
allocator instances or throwaway/test instances exist on the same Docker
host. Recognition of an unnamespaced legacy container SHALL NOT depend on
any separate opt-in flag — the Compose project match alone is both
necessary and sufficient.

#### Scenario: Two allocator instances share a Docker host

- **WHEN** two independently configured allocator instances (e.g. a real
  deployment and a throwaway smoke/test instance, each with its own
  `COMPOSE_PROJECT_NAME`) run against the same Docker daemon
- **THEN** neither instance's `ensureSurface`, `getSurfaceStatus`, or
  `listSurfaces` SHALL ever enumerate, inspect, migrate, reuse, or modify
  network attachments on a container belonging to the other instance's
  deployment identity or Compose project
- **AND** this SHALL hold even if both instances' surface ids or connector
  ids happen to collide

#### Scenario: A container has no deployment identity label and belongs to this instance's own Compose project

- **WHEN** the allocator finds a container carrying the generic ownership
  label, no deployment identity label at all, and a
  `com.docker.compose.project` label that exactly matches this instance's
  own deployment identity
- **THEN** the allocator SHALL treat that container as its own for listing,
  network migration, and reuse purposes, unconditionally — no separate
  opt-in configuration is required or consulted
- **AND** this recognition SHALL be re-derived fresh on every access from
  the container's actual current labels — never persisted onto the
  container itself, since Docker container labels are immutable after
  creation

#### Scenario: A container has no deployment identity label and belongs to a DIFFERENT Compose project

- **WHEN** the allocator finds a container carrying the generic ownership
  label and no deployment identity label at all, but its
  `com.docker.compose.project` label does NOT match this instance's own
  deployment identity
- **THEN** the allocator SHALL treat that container as not its own under any
  configuration — it SHALL NOT list, inspect for management, migrate, or
  reuse it, and SHALL create a new namespaced container for any surface
  request that would otherwise have matched it

#### Scenario: A container carries a deployment identity label that does not match

- **WHEN** the allocator finds a container carrying a deployment identity
  label that does not exactly match its own
- **THEN** the allocator SHALL treat that container as not its own,
  regardless of its `com.docker.compose.project` label — an explicit
  deployment identity mismatch is never overridden by Compose-project
  matching

#### Scenario: Every newly created container carries this deployment's identity

- **WHEN** the allocator creates a new container for any surface request
- **THEN** that container SHALL be labeled with this allocator's exact
  deployment identity at creation time
