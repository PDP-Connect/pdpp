# Plan: Get PDPP onto remote-surface, minimally and properly (2026-07-17)

**Goal.** Today, in <1–2 hours of agent work, move PDPP's console stream viewer to
consume the primitives `@opendatalabs/remote-surface@0.4.0` **already provides**,
deleting the equivalent hand-rolled PDPP code — no more, no less. This solidifies the
PDPP↔remote-surface boundary for the Linux Foundation handoff and is a strict,
non-throwaway down-payment on Codex's full architecture plan.

**Non-goals (explicitly deferred, do NOT solve now).**
- Building a neko-capable *assembled session* (`createRemoteSurfaceSession` speaks the
  CDP wire protocol; the neko `createRemoteSurfaceViewer` factory does not exist — only
  the `NekoBackendAdapter` *interface* + `createUnimplementedNekoApplyViewport`). That is
  Codex Phases 2–3, RS-repo work, not today.
- Switching PDPP's live user path to CDP. Forbidden by the stealth contract
  (`docs/reference/neko-stealth-design-brief.md`: "never send raw CDP against the user's
  tab"; `--remote-debugging-port` is detected by Turnstile). CDP-in-front-of-users is a
  product regression, and it would force a *second* migration later. Off the table.
- Deleting `neko-client.ts` (the 2,393-line WebRTC/allocator client). It wraps RS's real
  `NekoSurfaceAdapter`; replacing it is Codex Phase 6, not today.
- Any RS-repo change. This plan is PDPP-only and depends solely on the published 0.4.0.

## Ground truth (verified 2026-07-17 against installed 0.4.0 + live tree)

1. **RS ships a real neko surface adapter and PDPP already uses it.** `stream-viewer.tsx`
   does `new NekoSurfaceAdapter({...})` (line ~3447) from
   `@opendatalabs/remote-surface/adapters` — a concrete `class ... implements RemoteSurface`,
   not the unimplemented interface. So PDPP is *already* on RS for the neko surface itself.
2. **PDPP is already partway onto RS's session primitives.** `stream-viewer.tsx` imports
   and uses `assessClipboardCapabilities`, `decideClipboardPolicy`,
   `createMobileKeyboardResizeState` from `@opendatalabs/remote-surface/client`
   (lines 18–30, used at 638/1702/1731/2285/2517/…). Clipboard-policy and keyboard-resize
   are **done**.
3. **RS 0.4.0 `/client` exposes ~78 callable, backend-neutral primitives** PDPP has NOT
   yet adopted, including: `createViewportMatchController`, `buildViewportPayload`,
   `pointToStreamViewport`, `containedStreamRect`, `viewportsAreEquivalent`,
   `toNekoNativeViewportInfo` (neko-aware), `createFrameDecodeQueue`,
   `createContainerFitStreamViewerSurface`, `createRemoteSurfaceInputController`,
   `createLocalCursorController`, `createStreamViewerControlState` /
   `reduceStreamViewerControl`. These are the dedup targets.
4. **PDPP re-derives those same concerns locally** inside the 5,241-line
   `stream-viewer.tsx` (viewport math, frame decode, pointer→viewport mapping,
   container-fit, control-state reducer). These are what get replaced.
5. **Names don't collide** between PDPP-local defs and RS exports — this is *semantic*
   replacement (behavior-equivalent swap), not a mechanical rename. Higher care required.
6. **Strong test safety net exists**: 17 colocated test files (~3,000 lines) already pin
   the exact behaviors — `stream-viewport-classifier`, `stream-geometry`,
   `stream-clipboard-policy`, `stream-viewer-keyboard`, `stream-media-settle`,
   `stream-viewer-control`, `stream-viewer-protocol`, etc. These are the oracle.
7. **Console `types:check` is green against 0.4.0** (verified this session). Repin lives on
   branch `chore/repin-remote-surface-0.4.0` (needs rebase onto current `origin/main`,
   which is 36 commits ahead).

## Strategy: swap-one-primitive-at-a-time, tests as the oracle

Each lane replaces ONE re-derived concern in `stream-viewer.tsx` with the corresponding
RS `/client` primitive, keeping observable behavior identical, proven by the existing
colocated test file for that concern staying green (plus `types:check`). Because names
don't collide, every swap is: import the RS primitive → route the call site through it →
delete the local implementation → run that concern's test file → run full console
`types:check` + `test`. Behavior-preservation is a GATE, not a hope.

Ordering is by **risk-ascending, dependency-respecting**: pure functions first (lowest
blast radius), stateful controllers last.

### Lanes (each independently committable, each behind its own green gate)

- **L1 — viewport math (pure).** Replace local viewport equivalence / capture-size /
  point-mapping with `viewportsAreEquivalent`, `buildViewportPayload`, `pointToStreamViewport`,
  `containedStreamRect`, `viewportCaptureSize`, `toNekoNativeViewportInfo`.
  Oracle: `stream-viewport-classifier.test.ts`, `stream-geometry.test.ts`.
- **L2 — container-fit surface.** Replace the local container-fit/geometry measurement with
  `createContainerFitStreamViewerSurface`. Oracle: `stream-geometry.test.ts`.
- **L3 — frame decode queue.** Replace the local decode/draw path with
  `createFrameDecodeQueue` + `frameSourceToBlob`. Oracle: `stream-visual-quality.test.ts`,
  visual smoke.
- **L4 — control-state reducer.** Replace the local stream-viewer control state with
  `createStreamViewerControlState` / `reduceStreamViewerControl` / `replayStreamViewerControl`.
  Oracle: `stream-viewer-control.test.ts`.
- **L5 — viewport-match controller (stateful).** Replace local viewport-match orchestration
  with `createViewportMatchController`. Oracle: `stream-viewport-classifier.test.ts`,
  `stream-media-settle.test.ts`.
- **L6 — local cursor (optional, if time).** `createLocalCursorController` /
  `reduceLocalCursor`. Oracle: interaction-dock / control tests.

`createRemoteSurfaceInputController` (full input controller) is **conditionally in scope**:
adopt it ONLY if L1–L5 land with time to spare AND its behavior matches PDPP's neko input
path under test; otherwise defer (it is the largest single swap and closest to the
neko-specific input seam). Default: **defer** to stay inside the 1–2h box.

### Per-lane definition of done (the gate)

1. RS primitive imported; local equivalent deleted (not left dead).
2. The concern's colocated test file passes **unchanged** (if a test must change, that lane
   is a behavior change — STOP, flag it, do not proceed).
3. `pnpm --filter <console> types:check` green.
4. Full console test suite green.
5. Committed as `tnunamak@gmail.com`, one lane per commit, message states which local code
   was deleted and which RS primitive replaced it.

### Hard stops (escalate, do not improvise)

- Any lane where the concern's test file must be edited to pass → behavior drift, stop.
- Any lane that pulls in a neko-specific behavior RS's primitive doesn't cover → defer that
  lane, note the gap (it's a Codex-Phase-2/3 signal), continue with others.
- Do NOT touch `neko-client.ts` internals, the stealth path, `_ref` routes, run-timeline UI,
  owner controls, or product copy. Those stay PDPP-owned.

## Workflow shape (dynamic, to be launched after Codex review)

Pipeline over lanes L1..L5(+L6), each lane a 3-stage chain:
`implement (swap+delete)` → `verify (concern-test + types:check + full test)` →
`adversarial review (a second agent confirms behavior-preservation from the diff, not the
narration)`. Lanes are independent files-of-concern within one file, so they run as a
bounded sequence (not parallel worktrees — they all edit `stream-viewer.tsx` and would
conflict). A barrier at the end runs the **whole** console suite once more and a viewer
smoke check. Budget-bounded: stop cleanly at the 1–2h mark with whatever lanes are green;
partial adoption is still a strict improvement and fully shippable.

## Integration + deploy (owner, after workflow returns green)

1. Rebase `chore/repin-remote-surface-0.4.0` onto current `origin/main`; open PR.
2. Land the lane commits on a branch off current `origin/main`; open PR (independent of the
   spec PR — verified zero file overlap).
3. Land the spec PR (`chore/spec-remote-surface-external-dependency`, already committed:
   external-dependency framing + publication ownership moved to RS repo + superseded change
   archived).
4. Full `pnpm verify` / console suite green; deploy per live-stack window discipline.
5. Hand to Linux Foundation: the public record (durable spec) now truthfully states RS is an
   external published dependency PDPP consumes, and the code demonstrably consumes RS's
   assembled primitives rather than shadow-reimplementing them.

## Why this is "aligned with Codex's plan but solves nothing extra"

Codex Phase 6 is "migrate PDPP behind the package's viewer seam; each retained
responsibility must be demonstrably PDPP-specific." This plan executes the *safe, available-
today slice* of exactly that: it moves every session concern RS **already** implements out
of PDPP and into RS consumption, leaving behind only the genuinely PDPP-specific shell +
the neko-client whose full replacement is gated on RS work that doesn't exist yet. Nothing
here is thrown away when Phases 2–3 later deliver the neko assembled viewer; those phases
then replace `neko-client.ts` and the input seam, on top of a viewer that already delegates
everything else to RS.

## Addendum (2026-07-17, post-Codex review)

Codex red-team verdict: NO-GO on the L1-L5 lane inventory as written (L1/L4 were already adopted; L3 frame-decode is likely CDP-fallback-only; unchanged unit tests are necessary but not sufficient). Re-scoped to: evidence-first symbol inventory -> owner adjudication -> swaps only for confirmed locally-owned leaves with exact RS equivalents, batched verification with the owner as final gate. This document is retained as the record of the pre-review plan.
