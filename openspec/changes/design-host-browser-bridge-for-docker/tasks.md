## 1. Feasibility

- [ ] Spike host Patchright/Playwright server from Docker against a visible host browser with a dedicated PDPP profile.
- [ ] Spike host Chrome-over-CDP from Docker and document the Patchright stealth tradeoff.
- [ ] Confirm host setup on macOS and Linux; note Windows requirements if not tested.
- [ ] Decide whether the host bridge should be launched manually, by a helper script, or by Docker Compose instructions.

## 2. Design

- [ ] Pick the recommended first implementation path.
- [ ] Specify environment variables and connection/auth model for the local bridge.
- [ ] Specify default profile path and explicit daily-profile escape hatch, if any.
- [ ] Specify run/timeline/dashboard behavior when the bridge is required but unavailable.

## 3. Implementation Planning

- [ ] Identify code touchpoints across `browser-launch.ts`, Docker/Compose docs, run interaction rendering, and connector runtime diagnostics.
- [ ] Choose one connector for the first vertical slice.
- [ ] Define validation steps for "user sees host browser, completes interaction, connector continues."

## 4. Validation

- [ ] `openspec validate design-host-browser-bridge-for-docker --strict`
- [ ] `openspec validate --all --strict`
