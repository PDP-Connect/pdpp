# Streaming Target Resolution — Interaction-Scoped Refactor

**Date**: 2026-05-05
**Status**: Implementing
**Trigger**: Real-world test exposed a structural bug in how the streaming companion picks which browser page to attach to.

## Background — the bug this refactor addresses

The streaming companion attaches a CDP screencast to one specific Chromium page (tab) via that page's `webSocketDebuggerUrl`. Page-target wsUrls are per-tab and stable across navigation within the same tab; they do NOT cross between tabs.

Prior to this refactor, the connector runtime registered a wsUrl at *browser launch time*, picking whichever target was first in the DevTools `/json` response. That target was almost always the throwaway `about:blank` opened to keep the launcher's resolver from failing — NOT the page the connector subsequently navigated for its actual work.

Symptom: operator opens streaming viewer → SSE attaches cleanly → exactly one frame arrives (the blank page, captured before the connector navigated) → operator's clicks dispatch successfully (CDP returns 202) → no further frames arrive because the targeted page never repaints. The connector's real work happens on a *different* page that the operator never sees. White box.

## Diagnosis (ultra-condensed)

Three layered errors in the prior model, surfaced in this order:

1. **Wrong moment of registration.** The launcher doesn't know which page the connector will operate on. Registering at launch is structurally wrong; only the *binding code that emits the manual_action* knows which page the human should see.
2. **Wrong primary key.** Registering `runId → wsUrl` treats the run as the durable artifact. But a run can have multiple manual_actions over its lifetime, each potentially on a different page. The interaction is the durable artifact; the run is the container.
3. **Wrong layer ownership.** Page/CDP/wsUrl are browser-binding concepts. The generic connector runtime should not know about them. Streaming-target registration should live in the browser binding's code path, not the generic runtime.

## External advisor input

The advisor reviewing the architecture (memo at `tmp/question.md`, response at `tmp/answer.md`) recommended what they called **"browser-binding-local, interaction-scoped browser handoff."** That phrase is the clearest summary of the new model.

Key recommendations:
- Registry primary key: `(runId, interactionId)` not `runId`.
- Registration moment: *just before* the connector emits its `manual_action` interaction.
- Registration owner: the browser binding code path, not the generic runtime, not the launcher.
- Resolver: must correlate the *exact* Patchright `Page` object to a CDP wsUrl, not "first page in /json."
- Connector-author API: expose intent (`manualAction({ page, message, reason })`), not infrastructure.
- Endpoint shape: `PUT /admin/runs/:runId/interactions/:interactionId/streaming-target`, idempotent re-PUT semantics.

The advisor's full response is preserved in `tmp/answer.md`.

## What this refactor lands

### Architecture

```
Generic connector runtime
  - Run lifecycle, INTERACTION envelope routing
  - Knows about: runs, interactions, START/RECORD/DONE, INTERACTION
  - Does NOT know about: Page, CDP, wsUrl, screencast, focus

Browser binding code path
  - Patchright launch (delegated to acquireIsolatedBrowser)
  - Page lifecycle owned here
  - Page → CDP target wsUrl resolution (resolveWsUrlForExactPage)
  - manual_action handoff registration before sendInteraction
  - Knows about: Page, CDP, wsUrl

Streaming companion (reference server)
  - Mints viewer session bound to (runId, interactionId)
  - Registry: Map<(runId, interactionId), BrowserStreamingTarget>
  - PUT /admin/runs/:runId/interactions/:interactionId/streaming-target
  - Resolves target by composite key at viewer attach time
  - CDP screencast/input bridge
```

### Resolver — the spike output

The validated resolver (in `packages/polyfill-connectors/src/browser-handoff.ts`):

```ts
export async function resolveWsUrlForExactPage(
  page: Page,
  opts: { host: string; port: number }
): Promise<string> {
  const session = await page.context().newCDPSession(page);
  try {
    const { targetInfo } = await session.send("Target.getTargetInfo") as {
      targetInfo: { targetId: string; type: string };
    };
    if (targetInfo.type !== "page") throw new Error(`expected page, got ${targetInfo.type}`);
    return `ws://${opts.host}:${opts.port}/devtools/page/${targetInfo.targetId}`;
  } finally {
    await session.detach().catch(() => {});
  }
}
```

Spike-validated against six test cases including: blank page, navigated page, multiple pages distinguishable, popup target, page-closed-before-resolve (throws cleanly), page-closed-after-resolve (returns stale URL — caller's responsibility).

### Connector-author API

Two layers:

**Primitive** (low-level, escape hatch):
```ts
const { interactionId, registered } = await prepareManualAction({ page, reason });
await sendInteraction({ kind: "manual_action", request_id: interactionId, ... });
```

**Sugar** (recommended path):
```ts
await manualAction({ page, message, reason }, sendInteraction);
```

Connector authors use the sugar by default. The primitive exists so authors who need custom interaction envelope shapes (custom timeout, custom schema, etc.) can compose without re-implementing the helper.

### Spec posture

This refactor is **fully spec-consistent**:

- The spec at `spec-collection-profile.md:18-20` already states: "The runtime does not standardize the connector's source-specific collection logic; it standardizes only the runtime contract around bindings, scope, state, and emitted messages." The advisor's "generic runtime doesn't know about Page" is the spec's stated architecture — today's reference *violates* it; this refactor brings it into compliance.
- INTERACTION envelope, manual_action kind, run lifecycle — all unchanged. No spec mutation.
- Streaming target registration is reference-internal admin surface; no protocol vocabulary added.
- One latent question (separate openspec change at `reconcile-browser-binding-launch-direction`): the spec's `browser_automation` binding describes *runtime-provided* CDP, but the reference *connector self-launches* its browser. Orthogonal to this refactor; called out for spec-owner consideration.

### Endpoints, registry, auth

- `PUT /admin/runs/:runId/interactions/:interactionId/streaming-target` — idempotent (same-value re-PUT succeeds; different-value replaces with diagnostic warning, response field `action: "registered" | "reaffirmed" | "replaced"`).
- `DELETE /admin/runs/:runId/interactions/:interactionId/streaming-target` — clean unregister, deviceId-scoped (only the registering device can self-cleanup).
- `forceUnregister({ runId, interactionId })` — internal, called by the streaming routes when an interaction resolves; not deviceId-scoped (system-side cleanup).
- Auth: nonce-per-run (one shared secret per run, valid for any interactionId in that run) OR device-exporter bearer (Mode B path). Both flow through the same composed middleware.

### Observable bug fix

The white-box symptom is gone: the streaming companion now attaches to the *exact* page the connector is operating on at the moment it asks for human help. Multi-tab futures (OAuth popups, etc.) are handled by construction — the connector passes the relevant page; the resolver returns its specific wsUrl.

## What this refactor does NOT do

- Does not enforce the generic-runtime/browser-binding boundary anywhere else in the codebase. The boundary is now clean for streaming target ownership; other latent violations (e.g., the runtime opening pages on the connector's behalf) remain. Future work.
- Does not change the spec.
- Does not change the protocol for INTERACTION emission shape — `manual_action` is still emitted via `sendInteraction({ kind: "manual_action", request_id, ... })`. The new helper just packages this with the page registration.
- Does not address the `browser` vs `browser_automation` binding name reconciliation (separate openspec change).
- Does not address the latent ntfy duplication (controller's `fireNtfy` and `interaction-handler.ts`'s ntfy fire — both register URLs of the same shape but for different deployment paths). Not biting today.

## Implementation traceability

- Phase 1 (spike): `tmp/spikes/page-target-resolver/` — six test cases, all green.
- Phase 2 (registry refactor): `server/streaming/run-target-registry.js` rewritten with composite key.
- Phase 3 (handoff helper): `packages/polyfill-connectors/src/browser-handoff.ts` (new).
- Phase 4 (connector migration): ChatGPT connector first; pattern for other browser-backed connectors.
- Phase 5 (cleanup): launcher-time registration deleted from `browser-launch.ts`. Bootstrap placeholder `LAUNCHER_BOOTSTRAP_INTERACTION_ID` removed.
- Phase 6 (TTL hookup): `forceUnregister` called on interaction resolution.

## What to validate after the refactor lands

- E2E: Playwright drives full flow (mint → SSE attach → frames → input → resolve → success). Same harness as `tmp/spikes/...e2e` from Phase 3 prior session.
- Stealth: streaming companion still restricted to Page+Input+Emulation method allowlist. Source-grep test continues to enforce.
- Multi-tab: not exercised by any current connector but architecturally supported (connector passes `popup` page to `manualAction`).
