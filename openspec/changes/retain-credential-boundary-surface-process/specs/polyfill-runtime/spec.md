## ADDED Requirements

### Requirement: Credential-boundary surfaces SHALL retain their live process across routine idle and capacity events

The managed surface layer SHALL mark a connector's surface as **retained** when that
connector's authentication state is carried by the live browser process rather than
durable browser storage — the same connectors whose implementation preserves the run
page after successful runs — and SHALL NOT stop a retained surface's process under
routine idle-TTL cleanup or routine capacity-pressure reclaim. Retention SHALL be
decided at the reference-implementation orchestration boundary and passed to the
generic surface layer as a connector-neutral boolean; the surface layer SHALL NOT
inspect connector identity or manifests. Retention SHALL NOT be expressed as a
manifest browser-auth taxonomy, a connector-specific allocator branch, or a second
credential/session-token store.

Retention SHALL apply only to a healthy surface. A retained surface whose browser
target is proven unusable SHALL still be recyclable, and the surface lease SHALL
still be released after each run so the retained surface remains reusable rather
than permanently leased.

#### Scenario: Idle cleanup skips a retained surface

- **WHEN** a retained managed surface has been idle past the configured idle TTL
- **THEN** idle cleanup SHALL NOT stop the retained surface
- **AND** an ordinary (non-retained) idle surface past the idle TTL SHALL still be stopped.

#### Scenario: Capacity pressure reclaims ordinary surfaces first and never a retained surface

- **WHEN** a waiting lease is blocked on full capacity and an idle surface must be reclaimed
- **THEN** capacity-pressure reclaim SHALL select the oldest idle ordinary incompatible surface
- **AND** it SHALL NOT select a retained surface
- **AND** when only retained surfaces are idle, the waiting lease SHALL remain queued rather than evicting a retained surface.

#### Scenario: Retained surface releases its lease and is reacquired without a new process

- **WHEN** a run on a retained surface completes and its lease is released
- **THEN** the retained surface SHALL remain available for reuse
- **AND** the same connection's next run SHALL reacquire the retained surface without creating a new browser process.

#### Scenario: A proven-unusable retained surface is still recycled

- **WHEN** a readiness or attach probe proves a retained surface's browser target is dead or attach-exhausted
- **THEN** the runtime SHALL recycle that retained surface rather than keep the poisoned renderer
- **AND** a running managed container that the container healthcheck reports unhealthy SHALL still be replaced on the next ensure.

### Requirement: A retained surface configuration SHALL guarantee at least one transient surface slot, failing closed otherwise

The managed surface capacity SHALL guarantee that retained credential-boundary
surfaces can never consume all capacity: at least one transient slot SHALL always
remain acquirable by non-retained scheduled work. The configured surface cap SHALL
strictly exceed the number of retained managed connectors (enforced fail-closed at
configuration time), and retained surfaces SHALL be capped at one fewer than the
surface cap, enforced when a retained surface is created rather than by counting
already-observed surfaces. A retained surface creation that would consume the last
transient slot SHALL be refused with a typed terminal outcome rather than an
indefinite capacity wait, so excess retained demand fails closed rather than
starving non-retained connectors or deadlocking.

The creation-time reserve check SHALL count total nonterminal retained demand —
materialized retained surfaces plus any other retained lease already queued without
a materialized surface — not materialized surfaces alone, so that two retained
leases queuing before either has a surface cannot both pass the check. At restart,
rehydrated non-terminal retained leases still queued SHALL be re-checked against the
reserve in priority/FIFO order (the same order routine promotion would serve them),
deterministically keeping at most `surfaceCap - 1` retained demand and terminalizing
any excess with the same typed terminal outcome, rather than leaving the overcommit
to be discovered non-deterministically by whichever lease routine promotion
considers first.

#### Scenario: Retained connector with no transient headroom fails config

- **WHEN** a retained credential-boundary connector is managed and the surface cap does not exceed the number of retained managed connectors
- **THEN** configuration SHALL fail closed with an explicit error rather than start.

#### Scenario: A retained surface that would consume the reserve is refused

- **WHEN** retained surfaces already occupy one fewer than the surface cap
- **AND** another retained credential-boundary connection requests a surface, including a connection that had never previously acquired one
- **THEN** the request SHALL be refused with a typed terminal outcome rather than creating a surface or waiting indefinitely
- **AND** a non-retained connection SHALL still be able to acquire the remaining transient slot.

#### Scenario: Two retained connections leave one transient slot

- **WHEN** two retained credential-boundary connections request surfaces with a surface cap of three
- **THEN** both retained surfaces SHALL be created and one transient slot SHALL remain for non-retained scheduled connectors.

#### Scenario: A queued retained lease without a surface still counts as reserve demand

- **WHEN** a retained credential-boundary lease is already queued without a materialized surface
- **AND** another retained credential-boundary connection requests a surface
- **THEN** the request SHALL be refused with the same typed terminal outcome as if the queued lease had already materialized a surface.

#### Scenario: Rehydrated retained demand exceeding the reserve terminalizes deterministically at restart

- **WHEN** the reference restarts with more rehydrated non-terminal retained leases queued than the reserve allows
- **THEN** reconciliation SHALL keep the highest-priority (priority-class, then earliest-requested) retained leases up to `surfaceCap - 1` total retained demand
- **AND** SHALL terminalize the remaining retained leases with the same typed terminal outcome used at creation time, deterministically regardless of rehydration order.

### Requirement: Retained surfaces SHALL be reconstructed across ordinary restart without an intentional process stop, and true process loss SHALL be an honest repair condition

Ordinary reference restart and boot reconciliation SHALL reconstruct retained
surfaces without intentionally stopping their containers, and SHALL NOT stop a
healthy retained container merely for being idle. The reference SHALL NOT claim that
a credential-boundary connector's provider API session survives loss of the live
browser process. When the container process is genuinely lost — for example a host
reboot or an image change that forces container recreation — the connection SHALL
be surfaced as one connection-scoped browser-session repair condition rather than a
silent failure, a false-healthy state, or a repeated scheduled retry.

#### Scenario: Boot reconcile preserves a healthy retained container

- **WHEN** the reference restarts and reconciles managed surfaces against the allocator
- **AND** a retained surface's container is still healthy
- **THEN** reconciliation SHALL leave that container in place and SHALL NOT stop it for being idle.

#### Scenario: A rehydrated non-terminal lease without a surface is re-derived retained before it can materialize one

- **WHEN** the reference restarts with a persisted non-terminal lease for a credential-boundary connector that has no surface row yet
- **THEN** the reference SHALL re-derive that lease as retained before the surface layer can create a surface for it
- **AND** the surface later materialized for that lease SHALL be retained.

#### Scenario: Lost retained process becomes one browser-session repair

- **WHEN** a retained surface's container process is genuinely lost across a restart or host event
- **AND** the credential-boundary connector's provider API session cannot be re-established from the persistent profile alone
- **THEN** the connection SHALL present one connection-scoped browser-session repair action
- **AND** scheduled automation SHALL NOT launch a repeated auth-retry burst for that definitive session-required state.
