## Context

The current n.eko adapter has two different browser-control postures:

- `strict` avoids page-level CDP and keeps baseline viewing/input available through n.eko.
- non-strict modes use adapter-owned raw CDP for navigation, viewport/emulation, focus detection, status reads, copy, and paste.

The raw CDP path includes `Runtime.enable`, `Runtime.addBinding`, direct `Page.addScriptToEvaluateOnNewDocument`, `Browser.setWindowBounds`, and `Emulation.*` commands. Those are exactly the patterns the Patchright research notes identify as avoidable or high-risk for stealth-sensitive sources. Local non-n.eko browser launch has already moved toward Patchright-bundled Chromium by default, so the remaining n.eko path is the main posture divergence.

Relevant source artifacts already exist:

- `docs/patchright-integration-spec.md`
- `docs/neko-adapter-refactor-spec.md`
- `tmp/workstreams/ri-streaming-stealth-rbs-audit-2026-06-01.md`

## Goals / Non-Goals

**Goals:**

- Make n.eko assistive browser control use one Patchright-shaped browser-client seam.
- Remove routine n.eko adapter ownership of raw page-CDP helper commands.
- Keep strict/browser-owner mode usable without any page-level browser attach.
- Preserve the existing n.eko stream-token lifecycle, native input path, and same-origin proxy.
- Add tests that make the posture falsifiable from code review and CI.

**Non-Goals:**

- Do not bypass Cloudflare, CAPTCHA, rate limits, or source-side anti-abuse systems.
- Do not claim that Patchright guarantees ChatGPT success.
- Do not remove the separate CDP fallback streaming adapter used for explicit debug/fallback sessions.
- Do not make remote-surface package publication decisions.
- Do not require a physical-phone or live ChatGPT run before merging the no-human posture refactor, though those remain valuable smoke checks.

## Decisions

### Use a `neko-browser-client` seam

The n.eko adapter should depend on a minimal browser-client interface rather than importing Patchright throughout the adapter. The seam should expose only the operations the adapter needs: connect, get page, set viewport size, navigate, add init script, expose binding, evaluate, keyboard insert text, and close/disconnect.

This keeps unit tests at the right level. Tests should assert that the adapter calls the browser-client operations, not Patchright internals or raw CDP wire frames.

Alternative considered: call Patchright directly from the adapter. That is simpler initially but makes the adapter harder to test and easier to regress into mixed Patchright/raw-CDP behavior.

### Keep strict mode as no page attach

Strict/browser-owner mode should continue to avoid page attach entirely. The owner still gets n.eko viewing and native input through the stream, but no focus bridge, page status, CDP paste/copy, or viewport mutation is required for the baseline path.

Alternative considered: make Patchright attach the default for every n.eko stream. That would reduce branches but remove the useful "viewer/input only" mode for the most sensitive browser-owner sessions.

### Collapse `balanced` into assistive compatibility

Under Patchright, the old distinction between `balanced` and `assistive` is not meaningful enough to keep as a separate posture. Once the adapter attaches through Patchright, navigation, focus bridge, status, and paste/copy all travel through the same browser-driver seam. Existing `balanced` configuration should keep working, but it should normalize to assistive behavior with a compatibility warning.

Alternative considered: preserve three modes. That would keep old vocabulary but continue implying a posture distinction the implementation can no longer defend.

### Preserve n.eko-owned screen/input paths

The refactor should keep n.eko HTTP screen configuration, frame polling, same-origin proxying, and native input/clipboard flow. Patchright should not replace n.eko as the owner-facing stream substrate; it should replace only the adapter's hand-rolled page-control helpers.

Alternative considered: replace the n.eko path with CDP screencast/input for assistive mode. That would move backward from the native n.eko owner UX and reintroduce the CDP-streaming limitations that n.eko was introduced to solve.

### Treat live source success as evidence, not acceptance for the refactor

The no-human acceptance gate is code-level posture: strict avoids attach, assistive uses Patchright seam, forbidden raw CDP commands are absent from n.eko routine controls, and existing stream behavior remains tested. A later live ChatGPT or phone smoke can provide confidence in the deployment, but failure there may still reflect source risk, network reputation, profile age, or rate limiting rather than the adapter posture refactor itself.

## Risks / Trade-offs

- Patchright through the CDP proxy may fail if the proxy does not rewrite `webSocketDebuggerUrl` for the runtime side. Mitigation: add a gated canary smoke or a focused proxy test before relying on live n.eko.
- Dropping `Browser.setWindowBounds` and `Emulation.*` may expose geometry differences. Mitigation: keep n.eko screen configuration and rely on replayable media/geometry diagnostics; fix the n.eko window-manager layer if letterboxing appears.
- `addInitScript` does not affect already-loaded pages. Mitigation: attach before first navigation and also evaluate the focus script once on the current page for compatibility.
- `balanced` normalization can surprise operators who expected weaker assistive behavior. Mitigation: warn and document that `strict` is the only no-attach mode.
- Over-claiming stealth would be misleading. Mitigation: docs and tests should say "Patchright-shaped posture" and "forbidden helper commands absent", not "undetectable" or "Cloudflare-proof".

## Migration Plan

1. Add the browser-client seam and fake-client tests.
2. Wire n.eko assistive control through the seam while preserving strict no-attach behavior.
3. Remove adapter-owned raw page-CDP helpers from routine n.eko controls.
4. Add grep/static tests for forbidden n.eko helper commands.
5. Run targeted streaming tests and OpenSpec validation.
6. Optionally run a local n.eko canary smoke to prove Patchright attach, init script, focus bridge, and navigation work through the configured CDP proxy.
