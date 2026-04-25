## Why

Browser-backed polyfill connectors can require human interaction: Cloudflare challenges, OTP prompts, "is this you?" confirmations, and archive-export verification steps. In a native local deployment, the headed browser appears on the owner's desktop. In Docker, the connector process can launch Chrome inside the container, but the owner cannot see or control that browser.

The owner decision for the short-term local-device story is explicit: **Docker should be able to drive a visible browser on the user's host machine**. This is not noVNC, WebRTC, or remote browser streaming. It is a local host-browser bridge for Docker/Compose deployments.

## What Changes

- Design a host-browser bridge for local Docker deployments.
- Prefer a host-side Patchright/Playwright server if it can preserve Patchright behavior and dedicated PDPP profiles.
- Evaluate host Chrome over CDP only as a fallback and document the stealth tradeoff.
- Require explicit opt-in and actionable failure when the bridge is not configured.
- Keep remote streaming and full connector-worker protocols out of scope.

## Capabilities

### Modified Capabilities

- `reference-implementation-architecture`: add requirements that local Docker deployments running browser-backed connectors must either use an explicitly configured host-browser bridge or report that browser interaction is unavailable.

## Impact

- OpenSpec only for this tranche.
- Related future implementation areas may include Docker/Compose env, `packages/polyfill-connectors/src/browser-launch.ts`, `reference-implementation/runtime/controller.ts`, and `/dashboard/runs/:runId` interaction copy.
