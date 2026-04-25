# Open question: host-browser bridge for connectors running in containers

**Status:** scoped 2026-04-25 — owner narrowed scope to a host-browser bridge (NOT noVNC, NOT WebRTC, NOT remote streaming). See "Owner-narrowed scope" below.
**Raised:** 2026-04-25
**Trigger:** `run_1777088309243` (chatgpt) failed inside the dev Docker image because `channel: "chrome"` requires `/opt/google/chrome/chrome`, which the image doesn't install. Discussion broadened to: even after the image installs Chrome, browser-backed connectors that need human intervention (Cloudflare challenges, OTP, "unusual activity" prompts) have no way to surface a real interactive browser window to the owner from inside the container.

## Owner-narrowed scope (2026-04-25)

The short-term answer to "human-attended browser access for connectors in Docker" is specifically **host-browser control**, not noVNC, not browser streaming, not a connector-worker protocol. The follow-up work should be scoped around a deliberately configured local bridge:

- The connector / runtime may run in Docker.
- The visible headed browser runs on the user's host machine.
- The user interacts with their normal desktop browser window.
- Docker connects to that host browser through a deliberately configured local bridge.

**Investigation/implementation order:**

1. **Host Patchright/Playwright server** if it preserves Patchright behavior and can use isolated per-connector profiles. (Patchright's `chromium.connect(wsEndpoint)` against `npx patchright run-server` on the host. Client-side stealth is preserved because the patchright client is still in the connector process.)
2. **Host Chrome over CDP** only if the Patchright server path is not viable for some reason. Document the stealth tradeoff clearly — CDP-attach forfeits patchright's client-side stealth layer (the same regression the retired daemon had).
3. **Do not pursue** noVNC / WebRTC / remote streaming for this tranche.
4. **Do not design** a full connector-worker protocol unless both host-browser bridge options above fail.

**Hard requirements:**

- Explicit opt-in. The bridge SHALL never silently take control of a host browser. Operator must set a config value (e.g. `PDPP_BROWSER_BRIDGE_URL`) before any host-browser launch happens.
- Local-only by deployment posture. The bridge SHALL be intended for local Docker / dev use; production self-hosted personal-server deployments should run the connector natively on the user's machine where this question doesn't arise.
- Per-connector profiles by default. The bridge SHALL use dedicated PDPP profile dirs (e.g. `~/.pdpp/profiles/<connector-or-subject>/` on the host), not the user's daily Chrome profile. See "Profile model" below for the deliberate exception case.
- Documented setup, security posture, and failure behavior. The "what runs on the host, what runs in the container, what the bridge URL means, who can drive my browser if they get the URL" model must be written down before the feature ships.
- Actionable failure when the bridge isn't configured. Docker runs that need an interactive browser SHALL fail or pause with a clear "configure `PDPP_BROWSER_BRIDGE_URL` and start the host bridge" message, not launch an invisible browser inside the container.

## Profile model (2026-04-25)

**Default: dedicated PDPP host Chrome profiles per connector / account.**

- Path: `~/.pdpp/profiles/<connector-or-subject>/` on the host.
- Reason: preserves cookies across runs, keeps platform fingerprints stable, avoids contaminating the user's daily browser, avoids giving connector code access to the user's broader personal Chrome cookies/sessions.
- This is the same profile-isolation model the in-container `acquireIsolatedBrowser` already uses; the bridge just relocates the profile to the host while keeping the per-connector keying.

**Optional documented "bring your own profile" mode:**

- An operator MAY explicitly point the bridge at an existing user Chrome profile for local-owner debugging or one-off bootstrap.
- Risks the operator must accept, documented at the opt-in point: (a) connector code can see much broader browser state; (b) profile locks will collide with the user's open Chrome; (c) automation may mutate the daily profile; (d) cross-platform fingerprints and cookies leak between connectors via the shared profile.
- Not the default. Not a recommended posture. Available because some debugging/bootstrap flows are easier with the user's actual logged-in state, and because forbidding it doesn't make it not happen — it just makes it happen via clumsier workarounds.

**Bonus capability under investigation: import cookies from the user's real Chrome profile (one-time or refreshable).**

Prior art exists in `vana-com/data-connect` (`playwright-runner/index.cjs`, function `importChromecookies`). Mechanism summary:

- Locate the user's last-used Chrome profile via `~/Library/Application Support/Google/Chrome/Local State` (macOS) or `%LOCALAPPDATA%\Google\Chrome\User Data\Local State` (Windows), reading `profile.last_used`.
- After the runner's per-profile Chrome creates its own `Cookies` SQLite db, copy entries from the user's profile via `sqlite3 ATTACH DATABASE ... INSERT OR REPLACE INTO cookies SELECT * FROM src.cookies; DETACH`.
- The encrypted-value blobs use the same Keychain key (Chrome's `v10` encryption format), so the runner's Chrome can decrypt them transparently — no Keychain prompt because Chrome itself is doing the read.

**Hard constraints inherited from the data-connect implementation:**

- Only works when the runner is using **system Chrome** (the `isSystemChrome(browserPath)` gate). Chrome-for-Testing and bundled Chromium can't decrypt the v10-encrypted cookies — they don't share the user's Keychain identity.
- macOS/Windows only as written. Linux Chrome uses a different secret-storage path (Secret Service / kwallet); the SQLite copy alone isn't sufficient on Linux.
- One-shot per runner profile (gated by a `.cookies-imported` marker file). **The owner has explicitly flagged this as a limitation** to address: a refresh path (re-import on demand, or scheduled re-sync, or "the user just logged in fresh somewhere — pick that up") would make this materially more useful than data-connect's one-shot.

**Why this is "bonus" and not core:** the host-browser bridge already lets the user log in directly in their visible browser, so this trick is not necessary for correctness. It is a UX shortcut: it lets the very first connector run start with the user already logged in to most platforms (because their daily Chrome already has those cookies), which can dramatically reduce first-run friction for a new owner.

**Open design questions specific to this capability:**

1. Refresh model: time-based (re-import on every Nth run), event-based (operator clicks "re-sync from my browser"), or fingerprint-driven (re-import when a connector hits a re-auth challenge that suggests cookies expired)? The owner is opposed to the data-connect "one-shot" model.
2. Scope: import all cookies (data-connect does this), or filter to only cookies for hosts that some connector actually targets? The first is simpler and matches the upstream behavior; the second is materially more privacy-preserving but requires a manifest-driven host allowlist.
3. Surface area: does this surface as an explicit operator action ("import from my Chrome now"), an automatic part of bridge setup, or both?
4. The Linux story (Secret Service / kwallet) needs design work even for the v1 if Linux is a target host platform. Could be deferred if "macOS + Windows host first" is acceptable.

## The problem

Browser-backed polyfill connectors (chatgpt, amazon, chase, usaa, and most scaffolded ones) periodically need a human to interact with the platform's web UI:

- Solve a Cloudflare or anti-bot challenge.
- Enter an OTP code into a login form.
- Click through an "unusual activity" / "is this you?" prompt.
- Re-establish a trusted-device fingerprint.

When the connector runs on the owner's host (e.g. `tsx connectors/chatgpt/index.ts`), this works: the headed Chrome window appears on the owner's desktop, the owner interacts with it, the connector continues. This is the ergonomics the polyfill system was designed against.

When the connector runs inside a container (the published `ghcr.io/vana-com/pdpp/reference:main` image, the dev `docker-compose` setup, or any equivalent), there is no display server inside the container and no straightforward path for the owner to see or click on the connector's browser window. Today the run either fails silently in the timeline (no Chrome installed) or would launch a window into a void if Chrome were installed.

Adjacent symptom: the dev image can't run any browser-backed connector to completion, even on the happy path, because of the missing Chrome binary. That's a smaller, more local fix (install Chrome in the image). The interactive-browser-from-container question is the larger unresolved one.

## What the spec implies (and what it doesn't)

`spec-core.md:52` is topology-agnostic: the AS, RS, and Connector Runtime "may be co-located in a single deployment ... or separated. The spec defines the interfaces between roles, not the deployment topology."

`spec-core.md:65` and `spec-architecture.md:23-93` lean toward a **co-located "personal server"** as the modal deployment shape — one process or one host doing all three roles. `add-polyfill-connector-system/proposal.md:17` framed the polyfill MVP explicitly as co-located on the owner's laptop.

`spec-core.md:1363` recommends connector-process *sandboxing* (restricted egress, trusted registries) as a malicious-connector mitigation, but does not prescribe network/host topology. Process isolation in a sibling container, sibling VM, or microVM all satisfy that recommendation.

What is **not** in the spec or design history:

- A normative or implied claim that connectors must run remote-from-runtime in production.
- A recommendation that the runtime broker connector execution to remote workers.
- A reason the production deployment shape would be Docker-on-someone-else's-infrastructure rather than personal-server-on-user's-infrastructure.

So the implied production posture is: the personal server runs where the user runs things (laptop, home server, NAS), where a desktop browser already exists. Docker is a developer convenience, not the implied production target. Whether that posture is durable is itself a question worth asking.

## Why this is now load-bearing

Several near-term threads collide on this question:

1. **The dev Docker image doesn't currently support browser connectors.** Operators trying the published image hit the symptom from `run_1777088309243` immediately. The minimal fix (install Chrome in the image) makes happy-path runs work but does not address human-in-the-loop steps.
2. **The retire-browser-daemon change** removed shared-profile and CDP-attach paths. The remaining `acquireIsolatedBrowser` launches a per-connector Chromium in whatever process is calling it. Inside a container, that's a browser with nowhere to render.
3. **GDPR/archive-export flows** (`platform-archive-requests-open-question.md`) inherently include an "owner clicks an email verification link" step that needs a human-attended browser somewhere.
4. **Unattended-operation principle** (`unattended-operation.md`) explicitly calls out that exception paths *do* require human attention via INTERACTION, ntfy, and a browser the owner can reach. The mechanism for "browser the owner can reach" was always implicit; in a container deployment it can't be.

## Implementation paths under the host-browser-bridge scope

Per the owner's narrowed scope above, only host-browser-bridge mechanisms are in play. Two are in the investigation order; three are explicitly out.

### In scope

#### Path 1 (preferred): host Patchright server
Host runs `npx patchright run-server`; connector imports patchright and calls `chromium.connect(wsEndpoint)`. Patchright client is still in the connector process, so the full client-side stealth stack is preserved. Owner sees and interacts with their real browser on the host desktop. Per-connector isolation comes from `newContext({ storageState })` keyed on the same `profileName` the in-container launcher uses today, with the storage-state file living under `~/.pdpp/profiles/<connector-or-subject>/storage-state.json` on the host.

**To validate before committing:** confirm `chromium.connect()` against `patchright run-server` actually preserves client-side stealth for the connectors most sensitive to it (Chase, USAA, ChatGPT). The patchright README's "client-side stealth requires importing patchright in the connector" claim is consistent with this preserving stealth, but it is worth empirically confirming against at least one Cloudflare-protected target before standardizing on this path.

**Tradeoffs to surface in docs when this ships:** owner runs a small server process on the host; storage-state serialization is a behavioral change from in-container `launchPersistentContext`; auth on the WebSocket channel is a real attack surface (anyone with the URL can drive the host browser) and needs an explicit security model, even on loopback.

#### Path 2 (fallback only): CDP-attach to a host-launched Chrome
Host launches Chrome with `--remote-debugging-port=9222`; connector calls `chromium.connectOverCDP()`. Owner sees and interacts with their real browser. Available only if Path 1 turns out to be infeasible for a specific concrete reason. **Forfeits patchright's client-side stealth layer** — same architectural compromise the retired daemon made. Document the stealth tradeoff clearly at the bridge configuration point and at the per-connector level for any connector where it materially regresses behavior (Chase / Akamai-protected sites are the canonical example, per `chase-anti-bot.md`).

### Out of scope (per owner)

- **noVNC / WebRTC / remote streaming.** Not pursued in this tranche. The user's actual browser on the user's actual desktop is the target experience; streaming a remote desktop into a web tab is a different product.
- **Mount host display socket into container** (X11 / Wayland socket mount). Not pursued in this tranche. Cross-platform story is uneven; would also be "host browser" in a sense but via a different mechanism than the bridge model.
- **Connector-worker protocol** (run the connector itself on the host, broker results back into the container). Not pursued unless both Path 1 and Path 2 fail. Would be a meaningful architectural change without spec backing.

## What this connects to

- `unattended-operation.md` — the assumed mechanism for surfacing a browser to an absent human (ntfy → owner unlocks phone/laptop → completes browser interaction → connector resumes) implicitly assumes the browser is on a machine the owner can reach. In a container deployment that assumption breaks.
- `platform-archive-requests-open-question.md` — GDPR-export flows include human-attended browser steps (email link clicks) that are downstream of the same constraint.
- `account-risk-from-repeated-automation-open-question.md` — anti-bot detection risk depends on stealth quality; A1 vs A2 has direct consequences here.
- `chase-anti-bot.md` — Chase's documented sensitivity to fingerprint and to CDP detection is a concrete instance of why A1's "client-side stealth forfeit" is not academic.
- `external-tool-dependencies-open-question.md` — patchright + Chrome installation is itself an external-tool dependency the deployment must declare.
- `openspec/changes/retire-browser-daemon` — the recently-shipped retirement removed the shared-daemon path, which means the question above can no longer be deferred by "the daemon handles it."

## Constraints

- Whatever the answer is, browser-backed connectors must be inspectable and recoverable when human interaction is required. A run that silently launches a browser into a container void is the worst outcome.
- Stealth posture matters: patchright's own README is explicit that `channel: "chrome"` and full client-side stealth are the recommended configuration. Solutions that downgrade either of these (A1 forfeiting client-side patches, the legacy paths using shared profiles) need to justify the regression against the connectors most affected.
- Cross-platform: macOS, Linux, and Windows operators all eventually exist. The bridge mechanism should be cross-platform; Path 1 (patchright server over WebSocket) is OS-agnostic. The cookie-import bonus is currently macOS/Windows only.
- The owner UX target is "ntfy on phone → tap link → complete interaction → done." Whatever browser path is chosen needs to compose with that flow.
- Trust boundary: a host-side patchright server accepts connections that drive the user's browser. Authentication for that channel is non-trivial and is a real attack surface, especially on shared machines.

## Action items

- [x] _Decided 2026-04-25:_ short-term scope is host-browser bridge only; not noVNC, not WebRTC, not connector-worker protocol. See "Owner-narrowed scope" above.
- [x] _Resolved 2026-04-25:_ install Chrome in the dev Docker image so non-interactive browser runs work. Shipped as part of `openspec/changes/retire-browser-daemon` (Dockerfile `reference` stage installs Chrome + Chromium via patchright).
- [ ] **Validate Path 1 (host patchright server) preserves client-side stealth** against at least one Cloudflare-protected connector (chatgpt) and one Akamai-protected connector (chase or USAA) before standardizing on it.
- [ ] If Path 1 validates: spec `PDPP_BROWSER_BRIDGE_URL`, the patchright-server lifecycle, the storage-state-vs-launchPersistentContext behavioral migration, and the auth model for the WebSocket channel.
- [ ] If Path 1 doesn't validate: document the specific failure mode and fall back to Path 2 (CDP-attach) with the stealth tradeoff documented at the bridge configuration point and at every connector affected.
- [ ] Document the implied production posture explicitly in `spec-architecture.md` or in a reference-implementation deployment note, so the "personal server runs where the user runs things" assumption is text rather than implicit.
- [ ] **Bonus capability:** prototype the cookie-import-from-user-Chrome trick (per "Bonus capability" section above) with a refresh model, not data-connect's one-shot. Decide refresh model, scope (all-cookies vs filtered), and operator surface.
