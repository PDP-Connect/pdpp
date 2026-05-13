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

The reference controller owns browser-surface leases. A connector requiring managed n.eko does not directly discover arbitrary `PDPP_<PROFILE>_REMOTE_CDP_URL` as the production path. Instead, the controller resolves a `BrowserSurfaceLease` before launch and passes env such as:

- `PDPP_BROWSER_SURFACE_REQUIRED=neko`
- `PDPP_BROWSER_SURFACE_LEASE_ID`
- `PDPP_BROWSER_SURFACE_PROFILE_KEY`
- `PDPP_BROWSER_SURFACE_REMOTE_CDP_URL`

The first tranche uses explicit reference configuration as the source of truth for "requires managed n.eko":

- `PDPP_NEKO_MANAGED_CONNECTORS` is a comma-separated list of connector ids, for example `chatgpt`.
- `PDPP_NEKO_SURFACE_CAP` is required and must be an integer `>= 1` when managed connectors are configured.
- `PDPP_NEKO_STATIC_PROFILE_KEY` names the only profile key supported by the static Compose n.eko surface. With one managed connector it may default to that connector id; with multiple managed connectors it must be explicit.
- `PDPP_NEKO_CDP_HTTP_URL` and `PDPP_NEKO_BASE_URL` describe the static surface's private CDP endpoint and n.eko stream base URL. They are controller inputs, not connector child launch overrides.

Browser binding alone does not imply managed n.eko. Connectors not listed in `PDPP_NEKO_MANAGED_CONNECTORS` keep the existing local/Patchright launch behavior unless a development remote-CDP override is set.

Managed launch env is fail-closed:

| Connector child env | Launch behavior |
| --- | --- |
| `PDPP_BROWSER_SURFACE_REQUIRED=neko` and `PDPP_BROWSER_SURFACE_REMOTE_CDP_URL` present | Attach to the lease-scoped CDP URL. |
| `PDPP_BROWSER_SURFACE_REQUIRED=neko` and no lease-scoped CDP URL | Throw a runtime resource error before browser launch. Do not use local, headless, or per-profile remote-CDP fallback. |
| No managed requirement and `PDPP_<PROFILE>_REMOTE_CDP_URL` present | Use the existing development remote-CDP override. |
| No managed requirement and no remote-CDP override | Use the existing isolated local/Patchright launch path. |

The static Docker overlay should stop injecting `PDPP_<PROFILE>_REMOTE_CDP_URL` as the managed path. It should configure the reference controller with the n.eko surface URL and managed connector policy, then let the controller inject lease-scoped env into the connector child.

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
  fencing_token: number;
  wait_reason?:
    | "capacity_full"
    | "surface_starting"
    | "surface_unhealthy"
    | "incompatible_static_profile"
    | "launch_precondition_failed"
    | "lease_wait_timeout";
}
```

The first implementation may use `profile_key = connector profileName`, for example `chatgpt`. That is connector-isolated, not yet fully account-isolated. The model keeps `account_key` available so a later tranche can make multi-account profile identity explicit.

The lease store is separate from `controller_active_runs`. Queued runs are launch requests, not spawned connector children. They need a durable row keyed by `run_id`, `connector_id`, `profile_key`, `status`, `priority_class`, and trace context; they must not create `activeRuns`, `activeRunPromises`, `activeRunInteractions`, streaming nonces, or `run.started` events until the lease is actually promoted to a spawned connector child.

### Atomicity And Fencing

Lease acquire, queue, promote, and release decisions must be atomic. The implementation can use a storage transaction, a single-process mutex plus storage constraints, or both, but the externally visible behavior must be the same under concurrent manual and scheduled starts:

- Active surface cap is checked and updated in the same critical section as lease creation.
- A surface can have at most one active leased row.
- A run can have at most one non-terminal browser-surface lease row.
- A connector can have at most one pending queued managed-n.eko run unless the caller explicitly targets a different account/profile seam added later.
- Release is idempotent and fenced by `lease_id` plus `fencing_token`; a stale release from an older lease cannot release a newer lease on the same surface.
- The queue pump runs under the same atomic boundary as release or promotion so two waiters cannot both observe and claim the same freed surface.

Storage should enforce the important invariants with unique indexes or equivalent checks, not only by optimistic in-memory assumptions. If the reference is ever run with multiple controller processes, the same store-level fencing must still prevent over-cap leasing; if that is not available for a configured store, managed n.eko should fail configuration validation rather than run unsafely.

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
- Else if active n.eko surface count is below cap and the configured surface mode can create or use a compatible surface, start or allocate one lazily.
- Else persist `waiting_for_browser_surface` and do not spawn the connector child.
- If the wait exceeds policy, mark the lease and run projection `deferred` with `wait_reason = "lease_wait_timeout"` and retry metadata.
- If the owner cancels, mark `cancelled` and do not spawn.
- On connector completion, failure, cancellation, or child cleanup, release the lease.

Static single-surface mode has one fixed profile key. If a required run asks for an incompatible profile key, the manager marks the lease `deferred` with `wait_reason = "incompatible_static_profile"` instead of waiting forever or reusing the wrong profile. If the compatible static surface is busy, the run waits by priority/FIFO until release.

Promotion from queued to spawned must happen through a controller-owned pump. A lease release, cancellation, timeout, or boot reconciliation runs the pump, which selects the next eligible queued lease by priority/FIFO, re-resolves the connector manifest/path/state, and only then persists the active run and spawns the connector. If promotion preconditions fail, the lease is marked `deferred` with a runtime-resource or launch-precondition reason.

Queued launch requests reserve the connector's pending slot but not its active child slot. A second request for the same connector while one is queued should return the existing queued run or a conflict that names it; it must not enqueue unbounded duplicate waits.

### Run Projection And Events

`active_run_id` remains reserved for spawned connector children. Browser-surface waits add separate reference-only projection fields such as:

- `pending_run_id`
- `browser_surface_status`
- `browser_surface_wait_reason`
- `browser_surface_lease_id`

The run-start route may return either:

```ts
type RunNowResult =
  | { run_id: string; trace_id: string; status: "started" }
  | {
      run_id: string;
      trace_id: string;
      status: "waiting_for_browser_surface" | "deferred";
      browser_surface: {
        lease_id: string;
        status: BrowserSurfaceLease["status"];
        profile_key: string;
        wait_reason?: BrowserSurfaceLease["wait_reason"];
      };
    };
```

Pre-spawn browser-surface events are explicit and separate from connector lifecycle events:

- `run.browser_surface_requested`
- `run.browser_surface_queued`
- `run.browser_surface_starting`
- `run.browser_surface_leased`
- `run.browser_surface_released`
- `run.browser_surface_deferred`
- `run.browser_surface_expired`
- `run.browser_surface_cancelled`
- `run.browser_surface_failed`

The reference must not emit `run.started` until the connector child is actually spawned. A pre-spawn queue timeout is not a connector `run.failed`; it is runtime resource backpressure surfaced through lease state, projection, and diagnostics.

### Connector Launch Environment

The controller passes lease metadata into `runConnector`, which forwards it into the connector child env. The polyfill launch resolver should centralize browser launch selection so the precedence is testable:

1. Managed required n.eko with lease CDP URL.
2. Managed required n.eko without lease CDP URL: fail closed.
3. Unmanaged development per-profile remote-CDP override.
4. Existing local isolated browser launch.

This keeps dev overrides useful while making production managed n.eko impossible to bypass accidentally.

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
- If a surface is live and healthy but its leased run is no longer active, release the stale lease and keep the surface idle.
- If a leased surface is missing after restart, mark the lease `expired`, free capacity, and preserve profile volumes.
- If a queued run is still within the wait policy, keep it `waiting_for_browser_surface`; if it has exceeded the wait policy, mark it `deferred` with `wait_reason = "lease_wait_timeout"`.
- If a configured static surface is present but incompatible with a queued run's profile key, mark the lease `deferred` with `wait_reason = "incompatible_static_profile"`.
- If a surface is live but unhealthy, mark leases targeting it `surface_failed`, free capacity only after release/cleanup has been recorded, and preserve profile volumes.
- Restore queued launch requests as pending lease state, not abandoned active runs.
- Run reconciliation after storage/spine initialization and before routes or schedules can launch new connector runs.

### First Tranche

The first tranche should prove the scheduling semantics before dynamic multi-container allocation:

- Add a `BrowserSurfaceLeaseManager` with validated `PDPP_NEKO_MANAGED_CONNECTORS`, `PDPP_NEKO_SURFACE_CAP`, lease wait timeout, idle TTL, and priority defaults.
- Support the current static n.eko service as exactly one configured surface with one compatible profile key.
- Add queued run projection/status before connector spawn.
- Pass lease env into the connector child.
- Preserve existing interaction-scoped streaming target registration.

This can support cap `N=1` honestly. It should not claim multi-surface concurrency until dynamic surfaces or multiple configured services exist.

For manual-action streaming, the existing interaction-scoped registration remains the owner-visible stream boundary. Managed n.eko should register a n.eko backend descriptor from the leased surface metadata when the connector asks for manual action; the browser client should not need to know or receive raw CDP details.

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
- A queued run has `pending_run_id` or browser-surface status but no `active_run_id`, active child process, streaming nonce, or `run.started` event.
- In static cap `N=1`, a second compatible required run queues while the first lease is active; an incompatible profile is deferred rather than reusing the static profile.
- Managed required n.eko ignores legacy per-profile remote-CDP overrides unless the controller injected a lease-scoped URL.
- Concurrent start attempts cannot overrun the configured surface cap, double-lease one surface, create duplicate non-terminal leases for one run, or let a stale release free a newer lease.
