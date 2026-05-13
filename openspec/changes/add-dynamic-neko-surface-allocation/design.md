## Context

`add-neko-browser-surface-leases` introduced the right control boundary: the reference controller decides whether a connector needs managed n.eko, acquires or queues a lease before launch, and passes lease-scoped CDP/stream metadata into the connector child. That tranche intentionally stayed static: one Compose `neko` service, one configured CDP URL, one stream base URL, cap `1`, and one compatible profile key.

That static mode is honest but insufficient for SLVP browser-backed collection. ChatGPT, Chase, USAA, and future browser connectors need isolated trusted-device/browser profiles while still running in the Docker deployment. Sharing one n.eko browser profile is not acceptable; silently falling back to local launch is also not acceptable for remote owner-operated runs.

## Goals / Non-Goals

**Goals:**

- Allocate n.eko browser surfaces dynamically per compatible profile key.
- Preserve profile isolation with persistent profile storage.
- Enforce a hard active-surface cap before container start.
- Gate connector spawn on n.eko, CDP, browser, and stream readiness.
- Keep connector code ignorant of Docker/container lifecycle.
- Stop idle dynamic containers while retaining profile volumes.
- Reconcile containers, profiles, surfaces, and leases after restart.
- Keep static single-surface mode as a supported development path.

**Non-Goals:**

- Do not make n.eko or Docker a PDPP Core requirement.
- Do not build a general-purpose cloud browser scheduler.
- Do not implement preemption in this tranche.
- Do not solve multi-account identity beyond carrying an account/profile seam.
- Do not replace the local collector path for filesystem-backed connectors such as `claude-code` and `codex`.
- Do not make connectors choose or switch browser surfaces directly.

## Decisions

### Add a Narrow n.eko Surface Allocator Boundary

The reference controller SHALL depend on a `NekoSurfaceAllocator` abstraction rather than directly constructing Docker commands inside connector launch code. The allocator owns surface lifecycle operations:

- `ensureSurface(request)` creates or finds a container for a `surface_id` and `profile_key`.
- `getSurfaceStatus(surface_id)` reports container, n.eko, CDP, browser, and stream readiness.
- `stopSurface(surface_id, reason)` stops an idle dynamic surface without deleting the profile volume.
- `listSurfaces()` supports boot reconciliation.

The production Docker deployment should realize this as a small local allocator/supervisor sidecar with a narrow HTTP API. That sidecar may own Docker Engine access; the main reference server should not need broad Docker socket access. Tests can use an in-process fake allocator.

Alternative considered: run Docker CLI/API calls directly from the reference server. That is simpler but gives the server broad host/container control and blurs the resource boundary. A narrow allocator sidecar is more explicit, easier to test, and safer to constrain with labels, image pins, network allowlists, and volume naming policy.

### Dynamic Mode Extends the Lease State Machine

Static mode may still promote a compatible ready surface immediately. Dynamic mode SHALL use the existing pre-spawn lease model but stop treating a newly created surface as ready synchronously.

When capacity is available and no compatible idle surface exists:

1. The controller persists a lease in `starting_surface`.
2. The allocator starts or reuses a container for the lease's `surface_id` and `profile_key`.
3. The controller polls or awaits readiness.
4. Only after readiness succeeds does the controller mark the lease `leased`, emit `run.browser_surface_leased`, and spawn the connector.

If capacity is full, the run stays `waiting_for_browser_surface`. If allocator startup or readiness fails, the lease becomes `surface_failed` or `deferred` with a runtime-resource wait reason; the connector child is not spawned.

### Profile Storage Is Stable and Explicit

Each dynamic surface SHALL mount persistent browser profile storage derived from a stable profile key. The first key may be connector-scoped, for example `https://registry.pdpp.org/connectors/chatgpt`; the data model already carries `account_key` so later multi-account profile identity can be stricter without replacing the surface concept.

The allocator SHALL sanitize and hash profile keys for container names and volume names. Raw connector URLs, account identifiers, or owner data SHALL NOT be used directly as Docker resource names.

Dynamic container shutdown SHALL preserve profile storage. A separate explicit maintenance operation may delete a profile later, but idle TTL cleanup must not.

### Readiness Gates Must Match the Owner-Visible Surface

A dynamic surface is not leaseable until all required checks pass:

- Container is running and on the expected Docker network.
- n.eko HTTP health endpoint responds.
- CDP `/json/version` responds through the lease-scoped endpoint.
- Chromium process is live and attached to the n.eko desktop.
- The n.eko stream base URL/proxy target is resolvable by the reference streaming route.

The controller SHALL classify readiness failures as runtime-resource failures, not connector authentication or connector output failures.

### Capacity Counts Containers, Not Only Leases

The active-surface cap SHALL count dynamic surfaces in `starting`, `ready`, `leased`, and `unhealthy` states until they are fully stopped or expired from the manager's active set. This prevents a burst of starts from exceeding the host resource budget while containers are still warming.

Idle TTL cleanup MAY stop ready idle dynamic containers. The queue pump SHALL run after cleanup because capacity may become available even when no connector completed.

### Streaming Uses the Leased Surface Descriptor

Manual-action streaming remains interaction-scoped. The connector requests a manual interaction as it does today; the runtime registers the streaming target from the lease-scoped n.eko descriptor. The dashboard/client should not receive raw CDP details and should not require a manual "switch stream here" affordance.

Dynamic mode therefore requires the streaming proxy/client config path to resolve per-surface n.eko origins from the registered descriptor, not a single global `PDPP_NEKO_BASE_URL`.

### Reconciliation Is Idempotent

On boot, the controller and allocator SHALL reconcile persisted surface rows, lease rows, and live allocator/container state before accepting new managed n.eko launches.

Rules:

- A live healthy idle surface may be retained for reuse if under cap.
- A live healthy leased surface whose run is not active is released and becomes idle.
- A missing dynamic container expires or fails affected non-terminal leases but preserves profile storage.
- A `starting_surface` lease may resume readiness if the allocator still sees the container, otherwise it fails/deferred according to policy.
- Queued leases stay queued if still within wait policy.
- Static mode keeps its existing compatibility behavior and does not create dynamic containers.

## Risks / Trade-offs

- Docker socket risk → keep Docker access inside a constrained allocator sidecar, label all managed resources, pin the n.eko image, and reject operations on unlabeled containers/volumes.
- More moving parts → keep the allocator API small, fakeable, and reference-only; connectors remain unchanged.
- Resource cost → enforce cap before start, use idle TTL cleanup, and expose operator diagnostics for active/starting/idle surfaces.
- Startup latency → accept first-run warmup for correctness; optional warm pools can be a later optimization.
- Profile corruption on preemption → do not preempt in this tranche; stop only idle surfaces.
- Multi-account ambiguity → carry `account_key` now but keep profile identity connector-scoped until account identity is explicit.
- WebRTC/network exposure → allocator must produce stream descriptors that work through the existing reference proxy/TURN configuration rather than exposing arbitrary container ports to clients.

## Migration Plan

1. Keep the current static Compose path working with `PDPP_NEKO_STATIC_PROFILE_KEY`, `PDPP_NEKO_CDP_HTTP_URL`, and `PDPP_NEKO_BASE_URL`.
2. Add explicit dynamic mode configuration, for example `PDPP_NEKO_SURFACE_MODE=dynamic` and `PDPP_NEKO_ALLOCATOR_URL`.
3. Fail startup if dynamic mode lacks an allocator, valid cap, profile storage root/volume policy, or stream proxy configuration.
4. Move ChatGPT to dynamic mode first in local Docker, then add Chase/USAA only after a real dynamic surface smoke passes.
5. Roll back by returning to static mode for ChatGPT only; dynamic lease rows should reconcile to deferred/expired without deleting profile volumes.

## Open Questions

- Whether the allocator sidecar should be implemented in Node inside `reference-implementation/` or as a smaller standalone script under `docker/neko/allocator`.
- Whether dynamic mode should initially allocate one WebRTC mux port per surface or route all client access through a reverse proxy path per `surface_id`.
- What exact profile-key shape should represent multiple accounts for the same connector once account identity is added.
