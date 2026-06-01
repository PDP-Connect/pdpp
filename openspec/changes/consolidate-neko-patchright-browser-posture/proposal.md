## Why

The reference now treats Patchright-bundled Chromium as the stronger default browser posture for local browser-backed connectors, but the n.eko stream adapter still carries hand-rolled page-CDP helper paths for non-strict modes. That split leaves ChatGPT/Cloudflare investigations ambiguous because the operator cannot tell whether a run is using the intended Patchright-shaped posture or a legacy CDP helper path.

## What Changes

- Consolidate n.eko assistive browser control behind a Patchright-mediated browser-client seam rather than adapter-owned raw page CDP.
- Keep strict/browser-owner n.eko mode available as a no-page-CDP viewer/input path.
- Treat `balanced` as a compatibility spelling for the assistive Patchright path rather than a separate browser posture.
- Add regression gates that forbid n.eko routine controls from sending `Runtime.enable`, `Runtime.addBinding`, direct `Page.addScriptToEvaluateOnNewDocument`, browser-window mutation, or mid-page emulation/user-agent overrides.
- Preserve n.eko's HTTP screen configuration, frame polling, token-scoped proxy, and native input/clipboard path.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `reference-implementation-architecture`: tighten the n.eko streaming posture requirement so assistive n.eko browser control uses a Patchright-mediated driver seam and strict mode remains page-CDP-free.

## Impact

- Affects `reference-implementation/server/streaming/neko-adapter.js` and its tests.
- May add a small `reference-implementation/server/streaming/neko-browser-client.*` seam around Patchright `chromium.connectOverCDP`.
- Updates streaming posture tests and CDP anti-pattern grep gates.
- Does not change PDPP Core, resource-server public APIs, grant semantics, stream-token scope, connector manifests, or owner tokens.
