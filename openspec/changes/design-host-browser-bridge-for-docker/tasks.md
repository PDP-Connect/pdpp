## 1. Feasibility

- [x] Analyze the host Patchright/Playwright server options and document the persistent-profile constraint. (Finding: `launchServer()` does not accept `userDataDir`; persistent profiles require a host process owning a `launchPersistentContext`. Bridge shape captured in `design-notes/host-bridge-feasibility-spike.md`.)
- [ ] Prove the chosen host persistent-context bridge from Docker against a visible host browser with a dedicated PDPP profile. (BLOCKED: requires owner to run the bridge on a host machine with a live Docker Compose stack. Runbook: `pnpm --dir packages/polyfill-connectors exec tsx bin/host-browser-bridge.ts --profile chatgpt`, then export the printed URL+token into Compose and trigger a ChatGPT run from the dashboard. Mark done after the connector completes a run through the bridge against a real Chrome window.)
- [x] Analyze host Chrome-over-CDP from Docker and document the Patchright stealth tradeoff. (Findings: loses Patchright launch-side stealth; remote-debugging-port broadcasts to all local processes; only acceptable as a documented escape hatch with a dedicated `--user-data-dir`.)
- [x] Confirm host setup on macOS and Linux; note Windows requirements if not tested. (macOS/Windows Docker Desktop: default `127.0.0.1` bind works; `host.docker.internal` is forwarded to host loopback automatically. Linux Docker: `host.docker.internal:host-gateway` resolves to docker bridge IP (typically `172.17.0.1`), NOT loopback — verified empirically. Linux operators must pass `--bind-host=<docker-bridge-ip>`. Compose `extra_hosts: ["host.docker.internal:host-gateway"]` required on Linux; already in `docker-compose.yml`. Windows: same as macOS Docker Desktop; not directly tested but DNS alias behavior is identical. All documented in `.env.docker.example` and `bin/host-browser-bridge.ts` header comments.)
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

## 5. Implementation Slice (branch `implement-host-browser-bridge`)

- [x] Container-side env resolver (`packages/polyfill-connectors/src/host-browser-bridge-config.ts`) — fail-closed parsing with stable failure code `host_browser_bridge_unavailable`, unit-tested.
- [x] Container-side acquisition router (`packages/polyfill-connectors/src/browser-launch.ts:acquireBrowserForConnector`) — picks bridge vs native isolated launcher; throws `HostBrowserBridgeUnavailableError` on misconfig or unreachable bridge; emits the daily-Chrome warning on opt-in.
- [x] Connector runtime wiring (`packages/polyfill-connectors/src/connector-runtime.ts:acquireBrowser`) — surfaces the stable failure code in the terminal-error message so the controller renders the deployment-config error state.
- [x] Host bridge CLI (`packages/polyfill-connectors/bin/host-browser-bridge.ts`) — owns Patchright `launchPersistentContext`, reads `DevToolsActivePort`, exposes a token-gated WebSocket reverse proxy, prints the env exports operators need, closes the host browser on SIGINT/SIGTERM.
- [x] Bind-host parameter (`--bind-host` / `PDPP_HOST_BRIDGE_BIND_HOST`) with safe default `127.0.0.1` and explicit acknowledgement (`--allow-public-bind`) for `0.0.0.0`. Linux operators must set this to the docker bridge IP (typically `172.17.0.1`); the bridge emits a startup warning on Linux when 127.0.0.1 is used. Empirically validated end-to-end: Linux container reaches a `172.17.0.1`-bound bridge through `host.docker.internal`, and is correctly unreachable for a `127.0.0.1`-bound bridge — the original assumption that "host-gateway delivers to host loopback" was wrong.
- [x] Compose passthrough (`docker-compose.yml`) — declares the three bridge env vars and adds `extra_hosts: ["host.docker.internal:host-gateway"]` so Linux Compose can reach the host (when the bridge is bound to the docker bridge IP).
- [x] Operator docs (`README.md`, `.env.docker.example`) — split macOS/Windows vs Linux flows; honest about which bind host each platform needs.
- [x] Unit tests for env resolution, token/auth behavior, bridge-unavailable failure, CLI argv parsing, bind-host validation, banner content.
- [x] Integration tests for the bridge proxy (`bin/host-browser-bridge-proxy.test.ts`) covering: HTTP root, 401 on missing token, frame round-trip with right token, Host-header rejection, non-loopback bind path. These exercise the same `startBridgeServer` the CLI uses.
- [x] CDP-frame proxy correctness — `WebSocket.RawData` typing instead of `as Buffer`; sanitizer for receive-only close codes (1004, 1005, 1006, 1015) so a clean client `ws.close()` doesn't crash the proxy.
- [x] `pnpm --dir packages/polyfill-connectors run verify` (typecheck + ultracite).
- [x] `pnpm --dir packages/polyfill-connectors run test` (751/751 pass; 5 baseline skipped).
- [ ] Manual end-to-end proof: run the host bridge against a real ChatGPT profile, attach from a Compose run, complete an OTP/Cloudflare interaction in the visible host browser, observe the connector finish. (BLOCKED: requires owner authentication. Owner action needed: (1) start the bridge: `pnpm --dir packages/polyfill-connectors exec tsx bin/host-browser-bridge.ts --profile chatgpt`; (2) export the printed URL+token; (3) start Compose: `docker compose --env-file .env.docker up`; (4) trigger a ChatGPT run from the dashboard; (5) complete any login/OTP in the visible Chrome window; (6) verify the run completes successfully. Mark done after observing a complete run.)
- [x] Dashboard render of `host_browser_bridge_unavailable` as a distinct deployment-config state. (`apps/web/src/app/dashboard/runs/[runId]/page.tsx`: `extractBridgeUnavailable` detects the stable code in `run.failed` data; `BridgeUnavailableSection` renders a deployment-config callout with copy-paste fix commands for both macOS/Windows and Linux Docker. `pnpm --dir apps/web exec tsc --noEmit` passes; `pnpm --dir apps/web run check` passes.)
- [ ] `kind=host_browser_required` interaction emission from connectors. (Deferred. Today the visible-host-browser flow is implicit: the bridge launches a window the operator sees while the connector blocks on its existing `auto-login` interaction handshake. Adding an explicit kind is a connector-side spec change worth its own slice.)
