## Why

Browser-backed polyfill connectors can require human interaction: Cloudflare challenges, OTP prompts, "is this you?" confirmations, and archive-export verification steps. In a native local deployment, the headed browser appears on the owner's desktop. In Docker, the connector process can launch Chrome inside the container, but the owner cannot see or control that browser.

The owner decision for the short-term local-device story is explicit: **Docker should be able to drive a visible browser on the user's host machine**. This is not noVNC, WebRTC, or remote browser streaming. It is a local host-browser bridge for Docker/Compose deployments.

## What Changes

- Design a host-browser bridge for local Docker deployments.
- Recommend a host-side **PDPP browser bridge process** that owns a Patchright `launchPersistentContext` against `~/.pdpp/profiles/<name>/` and exposes an explicitly configured local bridge endpoint over loopback. (`launchServer()` cannot preserve persistent profiles, so a host process must own the persistent context directly. The implementation tranche must prove whether the handoff is direct CDP or a bridge-owned broker. See `design.md` and `design-notes/host-bridge-feasibility-spike.md`.)
- Treat host Chrome over plain CDP as a documented escape hatch only; it forfeits Patchright's launch-side stealth and risks exposing the user's daily browser.
- Require explicit opt-in (loopback bind, shared-secret token) and actionable failure (`host_browser_bridge_unavailable`) when the bridge is not configured.
- Name **ChatGPT** as the first vertical slice for "user sees host browser, completes interaction, connector continues."
- Keep remote streaming, noVNC, and full connector-worker protocols out of scope.

## Capabilities

### Modified Capabilities

- `reference-implementation-architecture`: add requirements that local Docker deployments running browser-backed connectors must either use an explicitly configured host-browser bridge or report that browser interaction is unavailable.

## Impact

- OpenSpec only for this tranche.
- Related future implementation areas may include Docker/Compose env, `packages/polyfill-connectors/src/browser-launch.ts`, `reference-implementation/runtime/controller.ts`, and `/dashboard/runs/:runId` interaction copy.
