## Why

The Collection Profile spec defines `browser_automation` as a binding the **runtime provides** to the connector:

> `browser_automation` | `{ interface: "cdp", ws_url: string, headed_supported?: boolean }` | Runtime provides a CDP WebSocket to a managed browser.
> — `spec-collection-profile.md:64`

The reference implementation does the **opposite**: the connector child process imports patchright, launches its own Chromium, and then registers the page-target wsUrl back with the runtime (for streaming-companion attach). The flow is connector → registry → streaming, not runtime → connector.

Today's reference manifests reflect this inversion. ChatGPT and other browser-backed connectors declare:

```json
"bindings": {
  "browser": { "required": true }
}
```

`browser` is not in the spec's standard binding list (`browser_automation`, `browser_profile`, `filesystem`, `network`, `interactive`, `loopback_listen`). The spec at line 56 reserves unqualified binding names for the spec-defined registry — so `browser` as an unqualified name is technically a contract violation. It's also semantically distinct from `browser_automation`: it means "I will launch my own browser" rather than "give me a CDP WS to a browser you launched."

This proposal does NOT pick a fix. It captures the inconsistency for spec-owner consideration.

## What Changes

This is a **note proposal** — no implementation work in this change. Two reconciliation directions are possible (not pre-judged):

### Direction A — Spec absorbs the self-launch variant

Add a new standard binding to the Collection Profile spec for "connector self-launches browser." Possible name: `browser_self_launch`. Descriptor would carry the *capabilities the runtime grants the self-launching connector* — e.g., loopback port range, profile dir, channel preference. The connector imports a browser library; the runtime acknowledges and constrains.

This direction:
- Legitimizes today's reference behavior at the spec level.
- Acknowledges that browser-automation libraries (Patchright, Playwright, Puppeteer) are real-world dependencies; not all connectors want to speak raw CDP.
- Adds spec surface area.

### Direction B — Reference adopts the spec's model

Rearchitect the reference so the runtime launches the browser and hands the connector a CDP WebSocket URL. Connectors then connect via `chromium.connectOverCDP(ws_url)` instead of `chromium.launchPersistentContext(...)`.

This direction:
- Makes the reference match the spec.
- Forfeits patchright's *client-side* stealth patches (per browser-launch.ts:13-17 — patchright's full stealth requires importing patchright in the launching module, not just attaching to a CDP target). The reference's own design notes explicitly chose patchright launch for this reason. Reverting would weaken stealth.
- Removes the wsUrl-flow inversion that the streaming companion currently has to thread through.

### Direction C — Spec acknowledges both

Keep `browser_automation` as today (runtime-provided WS) AND add `browser_self_launch` as a parallel option. Connectors pick which they want; runtimes advertise which they support.

## Capabilities

### Modified Capabilities

- `connector-runtime` (Collection Profile bindings vocabulary) — open question, no code change yet.

## Impact

This is a note, not a change. Filed so future spec-owner work has the question recorded.

If Direction A or C is chosen: spec-collection-profile.md additions, manifest schema additions, connector manifests audited.

If Direction B is chosen: significant rework in `packages/polyfill-connectors/src/browser-launch.ts` (replace launch with attach), `packages/polyfill-connectors/src/connector-runtime.ts`, every browser-backed connector. Stealth loss must be evaluated.

## Out of scope

- Picking a direction.
- Any implementation work.
- The streaming-companion refactor (separate change at `add-run-interaction-streaming-companion`) — that work proceeds with the existing `browser` binding name and does not depend on this reconciliation. If the binding name changes later, the streaming code uses the new name; no architectural coupling.

## Owner Self-Review

- This is a spec-shaped question, not a reference choice. The reference will continue to work either way until spec owners decide.
- Adjacent open question: should the `browser_automation` binding's descriptor (currently `{ interface: "cdp", ws_url, headed_supported? }`) ever evolve to include screencast capability advertisement, given the streaming-companion work? Probably not — streaming is an operator-side concern, not a connector-runtime contract. But noting in case it surfaces later.
- Filed for visibility and to prevent the inconsistency from being absorbed silently into the codebase.
