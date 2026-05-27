# Remote-Surface OSS Posture — Prior-Art Deep Dive

Status: captured
Owner: RI prior-art right-hand
Created: 2026-05-27
Updated: 2026-05-27
Companion to: `slvp-reference-implementation-prior-art-2026-05-27.md`
Related: `openspec/changes/make-remote-surface-oss-publishable`, `openspec/changes/republish-remote-surface-as-opendatalabs`, `design-notes/browser-binding-launch-direction-2026-05-18.md`

All URLs accessed 2026-05-27.

## Bottom-line decisions for `@opendatalabs/remote-surface`

1. **License Apache-2.0.** Matches n.eko / Guacamole; maximizes embedder adoption; includes patent grant.
2. **Default exports host-neutral** (substrate-only); PDPP semantics behind `/reference`. Confirmed by Anthropic's "host owns the loop," browserless's protocol-only OSS, and KasmVNC's clean separation.
3. **Small core + in-tree adapters** (Playwright model), not out-of-tree drivers (Selenium model).
4. **No pre-built plugin SPI.** n.eko has none after 6 years; export the package as a library + REST/WS surface and let adopters wrap.
5. **`SECURITY.md` is process-only**; explicitly disclaim multi-tenant safety; provide an advisory hardening guide under `/reference`.
6. **No API-stability guarantee pre-1.0.** Document it loudly. Use semver-major bumps freely.
7. **Avoid in the substrate, even tempting ones:** session-id tenancy, billing/quota, `live_url` style embeddable previews, agent-loop opinions, LLM keys, audit-retention promises, "secure" adjectives without threat model.

## 1. n.eko (m1k1o/neko)

- Apache-2.0; v3.1.0 (2026-04-02); ~21k stars; solo-maintainer governance (m1k1o, Discord, GitHub Sponsors).
- v3 added a public REST API with OpenAPI 3.0, Prometheus metrics, and the server is now consumable as a Go library (`github.com/m1k1o/neko/server`), with reusable pkgs `gst`, `xevent`, `xorg` exposed.
- No formal plugin SPI; extensibility = "fork or import the Go package."
- `SECURITY.md` only describes vuln reporting — no multi-tenant safety claim, no API-stability promise.
- Use-cases pitched (watch parties, persistent browser, jump host, automated browser) explicitly include single-tenant per container patterns; multi-tenant is delegated to `neko-rooms`, a separate orchestrator.

URLs: https://github.com/m1k1o/neko, https://neko.m1k1o.net/docs/v3/release-notes

**[SLVP]** Mirror n.eko's posture: Apache-2.0, lone-maintainer-tolerant governance, server-as-library + documented REST/WS surface. Do **not** promise API stability before 1.0. `SECURITY.md` is process-only.
**[OPEN]** Whether to ship an OpenAPI spec on day 1 (n.eko gained it only at v3). Recommend yes for `@opendatalabs/remote-surface` since adapters depend on it.
**[DEFER]** Plugin SPI. n.eko has none after 6 years.
**[ANTI]** "Secure & isolated" marketing in the README without backing claims (n.eko does this; it muddies threat-model conversations).

## 2. Kasm Workspaces

- Classic open-core. Open: `workspaces-core-images`, `workspaces-images`, `KasmVNC` (GPL-2.0). Proprietary/source-available: the Kasm Server orchestration/admin/auth/DLP plane, gated by EULA.
- Community Edition is gratis, not libre (5-session cap, non-commercial).
- KasmVNC is fully separable — it's a Xvnc fork that broke from RFB to add modern web transport and is usable standalone.

URLs: https://github.com/kasmtech/KasmVNC, https://kasm.com/community-edition, https://docs.kasm.com/docs/latest/license/index.html

**[SLVP]** The streaming substrate must be separable from orchestration. `@opendatalabs/remote-surface` is strictly substrate; never embed tenancy, billing, session-quota, or admin UI concepts. PDPP becomes the "Kasm Server" analog (proprietary or not — lives elsewhere).
**[ANTI]** Open-core where the substrate license (GPL-2.0) is more restrictive than the orchestrator. Apache-2.0 substrate avoids this trap.

## 3. Selkies / noVNC / Guacamole

- Selkies: MPL-2.0, ~1.8k stars, Google-origin then academic, actively soliciting maintainers (red flag for downstream betting).
- noVNC: MPL-2.0.
- Guacamole: Apache-2.0 + ASF governance (strongest governance signal in this cohort).
- All three share a clean boundary: transport + input + display; product semantics live above.
- Guacamole's `guacd` is the cleanest "small core + adapters" model — protocol-agnostic daemon, per-protocol adapters (VNC/RDP/SSH).

URLs: https://github.com/selkies-project/selkies

**[SLVP]** Adopt the guacd boundary: substrate handles transport, input mapping, clipboard, IME, geometry, leases, diagnostics. Adapters (n.eko / CDP / future RDP) are pluggable. Matches the worktree split already in `packages/remote-surface`.
**[OPEN]** MPL-2.0 (Selkies, noVNC) is file-level copyleft — friendly for SaaS embedders but adds compliance overhead for downstream. Apache-2.0 (Guacamole, n.eko) is dominant for substrate. **Recommend Apache-2.0** to maximize adoption.
**[DEFER]** ASF-style governance. Document a path to it ("if this attracts > 3 substantive contributors, consider a steering committee").

## 4. browserless / Browser-Use Cloud / Anthropic Computer Use

These are managed services; their public surfaces reveal what NOT to put in `@opendatalabs/remote-surface`.

- **browserless:** Dual-licensed SSPL-1.0 OR Browserless Commercial. Public contract is thin: `ws://host:3000` + Puppeteer/Playwright CDP — deliberately reuses someone else's protocol rather than inventing one. Managed-service assumptions (API tokens, concurrency caps, region routing, billing) all behind the WS endpoint, none in the protocol. URLs: https://github.com/browserless/browserless, https://github.com/browserless/browserless/issues/3850
- **Browser-Use Cloud (v3, 2026):** REST API at `api.browser-use.com/api/v3`, `X-Browser-Use-API-Key` auth, 15-min session cap, `live_url` for embeddable preview, BYO-LLM keys, "Browser Profile" for persistent cookies. Session/agent/profile/live_url are managed-service concepts. URLs: https://docs.browser-use.com/cloud/api-reference, https://github.com/browser-use/browser-use/blob/main/CLOUD.md
- **Anthropic computer-use (computer-use-2025-11-24):** Schema-less tool baked into the model. Host owns the loop: capture screenshot, transform coords, execute click, return `tool_result`. New: enhanced `zoom` action, self-hosted sandboxes (Cloudflare/Daytona/Modal/Vercel), Managed Agents (`managed-agents-2026-04-01`), MCP tunnels. Anthropic does not retain screenshots/inputs (ZDR-eligible); the host owns data. URL: https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool

**[SLVP]** `@opendatalabs/remote-surface` should look like browserless's protocol layer (thin, reuses prior art) plus Anthropic's "host owns the loop" contract (substrate hands you frames + accepts inputs; it does not own session/profile/quota). PDPP-specific concepts sit at the Browser-Use-Cloud altitude, not in the substrate — confirms the `/reference` subpath split.
**[ANTI]** (concrete list, do NOT put in the default export): API keys, concurrency quotas, billing/regions, session-id semantics tied to a tenant, `live_url` style embeddable preview tokens, agent-loop opinions, LLM provider config, audit-log retention promises.
**[DEFER]** A managed-control-plane reference impl. Anthropic's "self-hosted sandbox" pattern is the right shape — substrate stays neutral, control plane is swappable.

## 5. Playwright server/driver + Patchright (small core + adapters)

- Playwright = client SDK ↔ persistent WebSocket ↔ Playwright Server ↔ CDP-patched browsers. Single bi-directional channel is the source of stability and auto-wait.
- **Patchright** = drop-in fork that patches the driver (avoids `Runtime.enable`, uses Routes for init-scripts, strips telltale launch flags) while keeping the client API identical.
- Two-stage provisioning: standard npm/pip client, driver fetched from GitHub Releases.

URLs: https://github.com/Kaliiiiiiiiii-Vinyzu/patchright, https://testdino.com/blog/playwright-architecture

**[SLVP]** Mirror this split. `@opendatalabs/remote-surface` is the client/protocol layer; n.eko and CDP adapters live behind a stable internal interface so a future "stealth" or "hardened" adapter (Patchright-equivalent) can drop in without touching consumers. Pin adapter versions; don't make consumers re-implement coord mapping/IME/clipboard per adapter.
**[OPEN]** In-tree adapters (Playwright model — monorepo, version-pinned) vs out-of-tree (Selenium model — drivers shipped separately). In-tree is dramatically easier to support; choose it for SLVP.
**[ANTI]** Per-action HTTP. Use one persistent WS per session like Playwright; n.eko already does this.

## 6. License posture

| Project | License | Notes |
|---|---|---|
| n.eko | Apache-2.0 | substrate analog |
| Guacamole | Apache-2.0 + ASF | gold standard |
| Selkies, noVNC | MPL-2.0 | file-level copyleft |
| KasmVNC | GPL-2.0 | strong copyleft; downstream friction |
| browserless | SSPL-1.0 OR Commercial | not OSI; AGPL-shaped + commercial gate |

**[SLVP]** Apache-2.0, matching n.eko, Guacamole, and the existing intent. Best for OEM/SaaS embedders; patent grant matters for a control-protocol package. Avoid MPL-2.0 (per-file compliance overhead), GPL-2.0 (downstream friction), SSPL (not OSI; consumer FUD).
**[DEFER]** CLA/DCO. Start with DCO sign-offs; only add a CLA if a foundation comes calling.

## 7. Security & multi-tenant posture

None of these packages — n.eko, KasmVNC, Selkies, Guacamole, noVNC, browserless OSS — claim multi-tenant safety in their core repo. Anthropic's computer-use docs are blunt: "Operate in a dedicated VM or container with minimal privileges." Kasm punts isolation to per-container Docker/Xvnc. Multi-tenancy is universally a host-level concern.

**[SLVP]** Recommended `SECURITY.md` posture (three sentences):

> `@opendatalabs/remote-surface` provides transport, input, and display primitives. It assumes one trust boundary per session; the host is responsible for sandboxing, tenant isolation, network egress controls, and credential handling. Default configuration is not safe for multi-tenant production exposure.

**[OPEN]** Whether to ship an opinionated `/reference/hardening.md` checklist (egress allow-list, seccomp profile, no shared GPU). Yes — and label it advisory, not normative.
**[DEFER]** A "secure-by-default" mode. Every project in this cohort has tried and failed to make this meaningful at the substrate layer.
**[ANTI]** Implying security via README adjectives ("secure," "isolated," "private") without scoping the threat model — n.eko does this and it confuses contributors.

## Open browser-launch-direction question

Per `design-notes/browser-binding-launch-direction-2026-05-18.md`:

- Spec defines `browser_automation` as a runtime-provided CDP binding.
- RI uses connector-self-launched browsers (Patchright stealth depends on this).
- Reference manifests use an unqualified `browser` binding (not a spec name).

**[SLVP-adjacent]** Both patterns are legitimate. Recommend an OpenSpec change `add-browser-self-launch-binding-vocabulary` to formalize a second binding/capability for connector-self-launched browsers, then keep `browser_automation` for runtime-provided. The substrate package can support both adapters cleanly. **Do not create the change without owner approval; capture as design-note material per the existing note's promotion trigger.**

## Decision log

- 2026-05-27: Captured remote-surface OSS posture deep dive. Companion to the SLVP RI synthesis. Direction aligned with `make-remote-surface-oss-publishable` and `republish-remote-surface-as-opendatalabs`. The browser launch direction remains the load-bearing open question.
