## Owner Decision

Short-term Docker interaction support is specifically **host browser control**:

- The connector/runtime may run in Docker.
- The visible headed browser runs on the user's host machine.
- The user interacts with a normal desktop browser window.
- Docker connects to that host browser through an explicitly configured local bridge.

This change SHALL NOT pursue noVNC, WebRTC, or browser streaming for the short-term local-device tranche. Remote browser streaming remains a separate future deployment question.

## Profile Posture

The default host-browser bridge should use dedicated PDPP host profiles, not the user's daily Chrome profile.

Recommended default:

```text
~/.pdpp/profiles/<connector-or-subject>/
```

Rationale:

- Preserves cookies and trusted-device state across connector runs.
- Avoids giving connector code access to all of the owner's daily Chrome cookies and sessions.
- Reduces cross-connector fingerprint/cookie contamination.
- Avoids lock collisions with the user's already-running daily Chrome.
- Leaves room for future multi-account profile keys.

The user's actual Chrome profile can be a documented, explicit escape hatch for local debugging or one-off bootstrap. It must not be the default because it broadens the trust boundary and risks mutating the daily browser profile.

## Candidate Directions

### Host Patchright / Playwright Server

Run a host-side Patchright/Playwright server that launches a visible host browser with a dedicated PDPP profile. The Dockerized connector runtime connects to the host server over a loopback-only, explicitly configured endpoint.

This is the preferred direction to investigate because it best matches the owner goal: the user sees a normal host browser while the connector keeps the Patchright-oriented runtime model.

Questions to answer:

- Does Patchright server preserve the stealth properties we need when controlled from a container?
- Can it launch persistent contexts with dedicated profile directories?
- What authentication or binding is needed so a malicious container/process cannot drive the owner's browser?
- How does this work on macOS, Linux, and Windows?

### Host Chrome Over CDP

Run Chrome on the host with remote debugging enabled and have Docker connect over CDP.

This may be the shortest path to "visible host browser," but it likely weakens Patchright's client-side stealth and opens a broad browser-control surface. It is acceptable only if documented as a local-owner/dev tradeoff and not as the default for high-friction connectors like Chase/Cloudflare-heavy flows.

### Full Host Connector Worker

Run the whole connector process on the host while AS/RS/web remain containerized. This avoids remote browser control and lets the connector use normal host browser APIs.

This is a larger architecture change and should be a fallback only if host browser control proves too brittle. It would need its own runtime-to-worker protocol design.

## Security Requirements

- The bridge SHALL be explicit opt-in. Docker SHALL NOT silently expose browser control.
- The bridge SHOULD bind to loopback or another local-only channel by default.
- The bridge SHALL use dedicated PDPP profiles by default.
- The bridge SHALL NOT use the owner's daily Chrome profile unless explicitly configured.
- The dashboard/run timeline SHALL identify when a run requires host-browser interaction.
- If the bridge is not configured, Docker runs SHALL fail or pause with an actionable message rather than launching an invisible headed browser.

## UX Requirements

- The owner path should be "run needs browser interaction -> visible host browser is already open or opens -> owner completes challenge -> connector continues."
- The run page should distinguish form-only interactions (OTP/credentials) from host-browser-required interactions.
- Setup docs should state which host command/process must be running before Docker browser-backed connectors can use the bridge.

## Non-Goals

- No noVNC/Xvfb sidecar in this tranche.
- No WebRTC/browser streaming in this tranche.
- No managed browser provider default.
- No use of the owner's daily Chrome profile by default.
- No full connector-worker protocol unless both host-browser approaches fail.

## Acceptance Checks

- The design chooses between host Patchright server and host Chrome-over-CDP as the recommended first implementation.
- The setup path is understandable for local Docker Compose users.
- Security review covers profile isolation, control-channel binding, explicit opt-in, and daily-profile risks.
- The implementation plan names the smallest vertical slice and one browser-backed connector to test.
