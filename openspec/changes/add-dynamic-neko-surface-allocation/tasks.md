## 1. Allocator Boundary

- [x] 1.1 Build on the allocator interfaces extracted by `extract-remote-surface-substrate` for ensure, status, stop, and list operations.
- [x] 1.2 Add a fake allocator for controller/runtime tests.
- [x] 1.3 Add dynamic n.eko config parsing and validation, including mode, cap, allocator URL, profile storage policy, idle TTL, and readiness timeout.
- [x] 1.4 Preserve static mode config and fail fast if static and dynamic settings are mixed unsafely.

## 2. Lease State Integration

- [x] 2.1 Extend browser-surface lease state handling so dynamic capacity starts leases in `starting_surface` rather than immediately `leased`.
- [x] 2.2 Count starting, ready idle, leased, and unhealthy dynamic surfaces against `PDPP_NEKO_SURFACE_CAP`.
- [x] 2.3 Persist dynamic surface rows with allocator/container metadata and profile key before starting a connector child.
- [x] 2.4 Gate queued-run promotion on allocator readiness and emit browser-surface events before `run.started`.
- [x] 2.5 Classify allocator startup/readiness failures as runtime-resource browser-surface failures without spawning the connector.

## 3. Dynamic Allocator Implementation

- [x] 3.1 Implement a local allocator/supervisor service with a narrow HTTP API for dynamic n.eko surfaces.
- [x] 3.2 Start n.eko containers with reference-owned labels, configured image, configured network, CDP proxy, stream path, and per-surface environment.
- [x] 3.3 Mount persistent profile storage derived from sanitized/hashed profile keys.
- [x] 3.4 Implement allocator readiness probes for container state/network, n.eko HTTP health, CDP `/json/version`, and Chromium version shape; keep stream descriptor authorization server-side and defer authenticated stream readiness probing to the interaction adapter.
- [x] 3.5 Reject allocator operations against unlabeled or foreign Docker resources.

## 4. Streaming And Proxy Wiring

- [x] 4.1 Allow registered n.eko stream descriptors to carry per-surface stream origins instead of relying on one global `PDPP_NEKO_BASE_URL`.
- [x] 4.2 Ensure owner-facing stream routes proxy only to allocator-approved n.eko origins.
- [x] 4.3 Keep raw CDP URLs out of browser/client-visible stream config.
- [x] 4.4 Verify interaction-scoped streaming still works for static mode and dynamic mode.

## 5. Cleanup And Reconciliation

- [x] 5.1 Add idle TTL cleanup for ready idle dynamic surfaces while preserving profile storage.
- [x] 5.2 Run the queue pump after dynamic surface stop/release/reconcile events.
- [x] 5.3 Reconcile persisted leases and surfaces with allocator/container state before accepting new managed n.eko launches.
- [x] 5.4 Expire or surface-fail leases for missing/unhealthy containers without deleting profile storage.
- [x] 5.5 Keep static mode reconciliation behavior intact.

## 6. Docker And Operator Configuration

- [x] 6.1 Add Docker Compose wiring for the allocator sidecar and dynamic n.eko network/resource labels.
- [x] 6.2 Add `.env.docker.example` settings for dynamic mode without enabling multi-surface mode by accident.
- [x] 6.3 Document the resource/security tradeoff of the allocator sidecar and Docker Engine access.
- [x] 6.4 Document how to enable ChatGPT first, then add Chase/USAA after dynamic smoke passes.

## 7. Verification

- [x] 7.1 Add unit tests for dynamic config validation and static/dynamic incompatibilities.
- [x] 7.2 Add lease-manager tests for starting-surface cap accounting, readiness promotion, failure classification, idle cleanup, and restart reconciliation.
- [x] 7.3 Add controller tests proving no `run.started` event is emitted until a dynamic surface is ready and leased.
- [x] 7.4 Add allocator contract tests using the fake allocator.
- [x] 7.5 Add a gated Docker smoke or focused integration coverage that starts two managed connector runs with distinct profile keys and proves separate dynamic n.eko surfaces are allocated or queued according to cap. (`pnpm docker:neko:dynamic-allocator-smoke` is an allocator-level gated smoke: it creates two managed dynamic surfaces with distinct dummy profile keys and proves distinct containers/ports/profile paths when the two-port range allows. `reference-implementation/test/controller-browser-surface-leases.test.js` now covers the controller-level managed-run path with fake dynamic n.eko allocation: cap 2 allocates separate surfaces for distinct profile keys; cap 1 queues the second run before allocating a second surface.)
- [x] 7.6 Run `openspec validate add-dynamic-neko-surface-allocation --strict`.
