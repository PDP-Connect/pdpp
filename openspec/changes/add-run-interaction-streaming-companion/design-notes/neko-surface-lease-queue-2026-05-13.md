# n.eko Surface Lease Queue

Status: researching
Owner: reference implementation maintainer
Created: 2026-05-13
Updated: 2026-05-13
Related: `openspec/changes/add-run-interaction-streaming-companion`, `openspec/changes/declare-polyfill-browser-runtime-binding`, `openspec/changes/design-host-browser-bridge-for-docker`

## Question

How should the reference implementation allocate a bounded number of n.eko browser surfaces when more connector runs need operator-visible browser sessions than the deployment can host concurrently?

## Context

Dedicated n.eko surfaces with unique browser profiles are the preferred direction for high-quality user-present browser automation:

- The user sees and controls the exact browser the connector drives.
- Each connector/account can retain isolated trusted-device state.
- The runtime avoids a manual "switch stream here" affordance in normal UX.

The resource cost is significant. A live n.eko surface is a browser/X/WebRTC stack and is currently about one GiB of memory on the local Docker setup. Keeping one always-on surface per connector does not scale cleanly.

## Stakes

If the cap is enforced poorly, the system either overcommits resources, silently falls back to a less trustworthy headless mode, or starts connector runs that block mid-auth with unclear UX. Any of those would weaken the reference implementation's operator trust.

## Current Leaning

Treat n.eko as a leased runtime resource, not as static connector configuration.

Core concepts:

- `BrowserSurfaceLease`: `{ lease_id, surface_id, connector_id, profile_key, run_id, interaction_id?, status, created_at, expires_at }`
- `BrowserSurface`: `{ surface_id, backend: "neko", profile_key, cdp_url, stream_base_url, health, last_used_at }`
- Queue states: `waiting_for_browser_surface`, `leased`, `released`, `expired`, `deferred`, `cancelled`
- Priority classes: interactive owner-launched runs before background refreshes; FIFO within a class
- Hard cap: never start more than `N` active n.eko surfaces

Expected behavior:

- If a compatible surface is available, lease it before launching the connector.
- If no surface is available and capacity remains, start one lazily and lease it.
- If capacity is full, leave the run queued before connector launch with visible `waiting_for_browser_surface` status.
- If wait exceeds policy, defer the run with retry metadata instead of failing it as a connector error.
- Do not silently fall back to headless/local launch for runs that require an operator-visible browser surface.
- Release idle surfaces after a TTL while preserving profile volumes.
- On reference restart, reconcile lease state against live containers and expire stale leases.

## Research Targets

Keep prior-art research narrow:

- Kubernetes scheduling vocabulary: pending pods, resource requests, priority classes, preemption avoided unless explicit.
- Selenium Grid/browserless session queues: browser sessions as scarce leases with wait timeouts.
- Local job queue patterns: retryable deferred work, visible wait states, operator-facing reason strings.

The goal is not to import a scheduler. The goal is to avoid inventing ambiguous lifecycle names or hidden fallback behavior.

## Implementation Shape

This should likely become a new OpenSpec change before implementation because it changes reference runtime scheduling, operator-visible status, and browser binding lifecycle.

Minimal first implementation can be static-process friendly:

- A small lease manager in the reference runtime.
- Configured cap and idle TTL via env.
- One static n.eko service in Docker for the first tranche, with the lease manager enforcing queue behavior.
- Dynamic multi-surface Docker allocation can follow after the lease model and UI semantics are proven.

## Promotion Trigger

Promote to an OpenSpec change before adding queue state, lease persistence, dynamic surface start/stop, or dashboard UX for queued runs.

## Decision Log

- 2026-05-13: Captured after owner alignment that dedicated n.eko surfaces with unique profiles are preferable, but must be lazy/capped rather than always-on per connector.
