## Context

The current n.eko path proves that an owner can control the browser surface used by a connector, but it is still mostly static config: a connector discovers a remote CDP URL from env, and the streaming target is registered once an interaction exists. That is acceptable for a single dev surface, but it does not scale to multiple connectors or unique profiles.

The intended architecture is a reference-owned lease boundary:

- The controller decides whether a run requires an n.eko browser surface.
- The controller leases or queues before spawning the connector process.
- The connector receives a concrete lease-scoped remote CDP URL.
- Streaming remains interaction-scoped once the connector asks for manual action.

This keeps resource scheduling out of connector code and avoids a manual "switch stream here" UX.

## Goals

- Enforce a hard cap on active n.eko browser surfaces.
- Preserve isolated browser profiles per connector/account.
- Queue before connector launch when no surface is available.
- Make waiting/deferred states visible in reference run/operator surfaces.
- Avoid silent fallback from required n.eko to headless, local, or shared-profile modes.
- Reconcile stale leases after reference restart without deleting profile state.

## Non-Goals

- Do not build a general cloud browser scheduler.
- Do not implement preemption in the first tranche.
- Do not make n.eko a PDPP Core requirement.
- Do not require dynamic Docker allocation in the first tranche.
- Do not solve multi-account identity beyond a stable profile-key seam.

## Design

### Lease Ownership

The reference controller owns browser-surface leases. A connector requiring n.eko does not directly discover arbitrary `PDPP_<PROFILE>_REMOTE_CDP_URL` as the production path. Instead, the controller resolves a `BrowserSurfaceLease` before launch and passes env such as:

- `PDPP_BROWSER_SURFACE_LEASE_ID`
- `PDPP_BROWSER_SURFACE_PROFILE_KEY`
- `PDPP_BROWSER_SURFACE_REMOTE_CDP_URL`

Existing per-profile remote-CDP env remains a development override until the lease path is implemented, but managed runs should prefer the controller-provided lease env.

### Data Model

`BrowserSurface` describes a live or recently-live n.eko surface:

```ts
interface BrowserSurface {
  surface_id: string;
  backend: "neko";
  profile_key: string;
  connector_id: string;
  account_key?: string;
  cdp_url: string;
  stream_base_url: string;
  health: "starting" | "ready" | "unhealthy" | "stopping";
  container_id?: string;
  active_lease_id?: string;
  created_at: string;
  last_used_at: string;
}
```

`BrowserSurfaceLease` describes a run's claim on a surface:

```ts
interface BrowserSurfaceLease {
  lease_id: string;
  surface_id?: string;
  connector_id: string;
  profile_key: string;
  run_id: string;
  status:
    | "waiting_for_browser_surface"
    | "starting_surface"
    | "leased"
    | "released"
    | "expired"
    | "deferred"
    | "cancelled"
    | "surface_failed";
  priority_class: "owner_interactive" | "scheduled_refresh";
  requested_at: string;
  leased_at?: string;
  released_at?: string;
  expires_at: string;
  wait_reason?: "capacity_full" | "surface_starting" | "surface_unhealthy";
}
```

The first implementation may use `profile_key = connector profileName`, for example `chatgpt`. That is connector-isolated, not yet fully account-isolated. The model keeps `account_key` available so a later tranche can make multi-account profile identity explicit.

### Queue State Machine

Normal path:

```text
requested -> waiting_for_browser_surface -> starting_surface -> leased -> released
```

Side/terminal states:

```text
cancelled | expired | deferred | surface_failed
```

Rules:

- If a ready idle surface with the requested `profile_key` exists, lease it.
- Else if active n.eko surface count is below cap, start or allocate one lazily.
- Else persist `waiting_for_browser_surface` and do not spawn the connector child.
- If the wait exceeds policy, mark the lease and run projection `deferred` with retry metadata.
- If the owner cancels, mark `cancelled` and do not spawn.
- On connector completion, failure, cancellation, or child cleanup, release the lease.

### Priority And Fairness

The first policy should be deterministic:

- `owner_interactive` runs outrank `scheduled_refresh` runs.
- FIFO applies within a priority class.
- No preemption in tranche one because killing a browser surface can corrupt the owner-visible session and trusted-device state.
- Starvation prevention can be added later if background refreshes are observed to wait indefinitely.

### Restart Reconciliation

Lease state must be persisted. On reference boot:

- Load non-terminal leases and known surfaces.
- Reconcile them with live containers or static configured n.eko surfaces.
- If a surface is live and healthy but its run is no longer active, expire the lease and keep the surface idle.
- If a surface is missing or unhealthy, mark the lease `expired` or `deferred`, free capacity, and preserve profile volumes.
- Align run projection with existing abandoned-run cleanup behavior so queued runs do not look active after a crash.

### First Tranche

The first tranche should prove the scheduling semantics before dynamic multi-container allocation:

- Add a `BrowserSurfaceLeaseManager` with a hard cap env such as `PDPP_NEKO_SURFACE_CAP`.
- Support the current static n.eko service as one allocatable surface.
- Add queued run projection/status before connector spawn.
- Pass lease env into the connector child.
- Preserve existing interaction-scoped streaming target registration.

This can support cap `N=1` honestly. It should not claim multi-surface concurrency until dynamic surfaces or multiple configured services exist.

### Follow-Up Tranche

After the lease state machine is proven:

- Allocate n.eko containers dynamically per `surface_id`.
- Mount per-profile volumes.
- Add idle TTL shutdown while retaining volumes.
- Add health probes and optional warm-pool policy.
- Expose capacity metrics in the operator UI.

## Alternatives

### Manual Switch Stream Affordance

Rejected as the normal path. It pushes resource routing onto the owner and makes the system feel like a remote-desktop tool rather than a connector runtime.

### Always-On Surface Per Connector

Rejected for default operation. It is simpler but consumes too much RAM/CPU and scales poorly as browser-backed connectors grow.

### Connector-Owned Surface Discovery

Rejected for productionized n.eko support. Env-only connector discovery is useful for dev, but it cannot enforce capacity, queue fairness, or restart reconciliation.

### Silent Headless Fallback

Rejected. For runs that require an operator-visible n.eko surface, falling back silently weakens the user-present browser guarantee and makes failures harder to explain.

## Acceptance Checks

- A run requiring n.eko does not spawn while the surface cap is full.
- The operator sees `waiting_for_browser_surface` or equivalent queued status.
- Releasing a surface starts or unblocks the next queued run according to priority/FIFO policy.
- A run requiring n.eko does not silently use headless/local launch when no lease is available.
- Connector child env carries the lease-scoped CDP URL when the run is leased.
- Restart reconciliation expires stale leases without deleting profile volumes.
- Queue and lease transitions are visible in reference diagnostics or run timeline artifacts without leaking credentials.
