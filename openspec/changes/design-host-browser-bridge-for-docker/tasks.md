## 1. Feasibility

- [x] Analyze the host Patchright/Playwright server options and document the persistent-profile constraint. (Finding: `launchServer()` does not accept `userDataDir`; persistent profiles require a host process owning a `launchPersistentContext`. Bridge shape captured in `design-notes/host-bridge-feasibility-spike.md`.)
- [ ] Prove the chosen host persistent-context bridge from Docker against a visible host browser with a dedicated PDPP profile. (Deferred to the implementation tranche; the design names this as a required validation, not a completed proof.)
- [x] Analyze host Chrome-over-CDP from Docker and document the Patchright stealth tradeoff. (Findings: loses Patchright launch-side stealth; remote-debugging-port broadcasts to all local processes; only acceptable as a documented escape hatch with a dedicated `--user-data-dir`.)
- [ ] Confirm host setup on macOS and Linux; note Windows requirements if not tested. (Expected: macOS/Windows have `host.docker.internal`; Linux Compose requires `extra_hosts: ["host.docker.internal:host-gateway"]`. Actual platform validation remains part of the implementation tranche.)
- [x] Decide whether the host bridge should be launched manually, by a helper script, or by Docker Compose instructions. (Decision: launched manually by the operator via a small in-repo CLI; Compose only documents the env vars and `extra_hosts`; Compose does not auto-start the bridge.)

## 2. Design

- [x] Pick the recommended first implementation path. (Host Patchright persistent-context bridge; see `design.md`.)
- [x] Specify environment variables and connection/auth model for the local bridge. (Host: `PDPP_HOST_BRIDGE_PORT`, `PDPP_HOST_BRIDGE_TOKEN`, `PDPP_HOST_BRIDGE_PROFILE_ROOT`, `PDPP_HOST_BRIDGE_LOG`. Container: `PDPP_HOST_BROWSER_BRIDGE_URL`, `PDPP_HOST_BROWSER_BRIDGE_TOKEN`, `PDPP_HOST_BROWSER_BRIDGE_DAILY_CHROME`. Loopback bind, shared-secret token, origin/host check.)
- [x] Specify default profile path and explicit daily-profile escape hatch, if any. (Default: `~/.pdpp/profiles/<connector-or-subject>/`. Escape hatch: `PDPP_HOST_BROWSER_BRIDGE_DAILY_CHROME`, off by default, name intentionally explicit.)
- [x] Specify run/timeline/dashboard behavior when the bridge is required but unavailable. (Typed `host_browser_bridge_unavailable` failure; distinct dashboard state; copy-paste fix in error copy. New `kind=host_browser_required` interaction for steps that need a real host window.)

## 3. Implementation Planning

- [x] Identify code touchpoints across `browser-launch.ts`, Docker/Compose docs, run interaction rendering, and connector runtime diagnostics. (Listed in `design.md` § "Implementation Touchpoints".)
- [x] Choose one connector for the first vertical slice. (ChatGPT — already browser-backed, no money-movement risk, exercises Cloudflare/login/OTP.)
- [x] Define validation steps for "user sees host browser, completes interaction, connector continues." (See `design.md` § "First Vertical Slice → Validation Flow".)

## 4. Validation

- [x] `openspec validate design-host-browser-bridge-for-docker --strict`
- [x] `openspec validate --all --strict`
