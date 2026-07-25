// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { selectNekoMediaDisplayForLayout } from "@opendatalabs/remote-surface/backends/neko";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const NEKO_CLIENT_FILE = `${HERE}neko-client.ts`;

/**
 * LIVE UAT re-review regression: the CDP contain-fit fix (17dbf438f,
 * stream-dialog-layout.test.ts) covered only `BrowserSurface`'s CDP fallback.
 * An independent reviewer opened the REAL, authenticated n.eko playground
 * (`/stream-playground?backend=neko`) at 1981x960, and measured the actual
 * rendered n.eko media box: `x=0, y=-137.5, width=1976, height=1235,
 * bottom=1097.5` — inside a correctly full-bleed 1976x960 host. The media
 * overflowed vertically by 275px (1235 - 960), offset by a negative `top`
 * (-137.5 = -(1235-960)/2, the exact centering math a COVER fit produces),
 * and was silently cropped by the dialog's `overflow: hidden`.
 *
 * Original fix (c06e27b7c): `@opendatalabs/remote-surface` had no "contain"
 * option for n.eko to defer to, so `applyViewportLayout` computed a local
 * `containSize` override unconditionally — a PDPP product-policy decision,
 * not a re-derivation of RS's own geometry math, but still local fit/scale
 * arithmetic living in the console.
 *
 * remote-surface 1.5.0 closed that gap: `selectNekoMediaDisplayForLayout`
 * now accepts a host-selected `NekoDisplayFitPolicy` ("contain" | "cover")
 * directly and returns the authoritative `displayRect`/`overlayRect`/
 * `pointerMapping` for it. `applyViewportLayout`'s steady-state branch now
 * passes `NEKO_STEADY_STATE_DISPLAY_FIT` ("contain") into the library call
 * and consumes its returned geometry verbatim — PDPP's local `containSize`
 * function no longer exists (planes.md §6: "hosts MUST consume it, never
 * re-derive it"). The transient rotation-mismatch path
 * (`applyPendingViewportLayout`) is untouched and keeps its own separate,
 * deliberate cover-during-transition behavior via the still-present local
 * `coverSize` helper.
 */

const APPLY_VIEWPORT_LAYOUT_START_RE = /^function applyViewportLayout\(\): void \{/m;
const STEADY_STATE_MEDIA_LOOP_RE =
  /for \(const mediaEl of mediaEls\) \{\s*const intrinsic = getMediaIntrinsicSize\(mediaEl\);[\s\S]*?applyElementLayout\(mediaEl, display, \{ objectFit: "fill" \}\);/;
const SELECT_MEDIA_DISPLAY_STEADY_STATE_CALL_RE =
  /selectNekoMediaDisplayForLayout\(viewportLayout, intrinsic, NEKO_STEADY_STATE_DISPLAY_FIT\)/;
const DISPLAY_RECT_CONSUMPTION_RE =
  /const \{ displayRect \} = selection;\s*const display = \{\s*height: displayRect\.height,\s*left: displayRect\.offsetX,\s*top: displayRect\.offsetY,\s*width: displayRect\.width,?\s*\};/;
const OVERLAY_SELECTION_CALL_RE =
  /selectNekoMediaDisplayForLayout\(\s*viewportLayout,\s*primaryIntrinsic,\s*NEKO_STEADY_STATE_DISPLAY_FIT\s*\)/;
const OVERLAY_RECT_CONSUMPTION_RE =
  /const overlayDisplay = \{\s*height: overlaySelection\.overlayRect\.height,\s*left: overlaySelection\.overlayRect\.offsetX,\s*top: overlaySelection\.overlayRect\.offsetY,\s*width: overlaySelection\.overlayRect\.width,?\s*\};/;
const CONTAIN_SIZE_DEFINITION_RE = /function containSize\(/;
const COVER_SIZE_CALL_RE = /coverSize\(/;
const APPLY_PENDING_FN_RE = /function applyPendingViewportLayout\([\s\S]*?\n\}\n/;
const STEADY_STATE_FIT_CONSTANT_RE = /const NEKO_STEADY_STATE_DISPLAY_FIT: NekoDisplayFitPolicy = "contain";/;

function extractApplyViewportLayoutBody(src: string): string {
  const startMatch = src.match(APPLY_VIEWPORT_LAYOUT_START_RE);
  if (!startMatch || startMatch.index === undefined) {
    throw new Error("applyViewportLayout function must exist in neko-client.ts");
  }
  const start = startMatch.index;
  // Bounded by the next top-level `export async function startNeko` — the
  // function immediately following applyViewportLayout in source order.
  const end = src.indexOf("export async function startNeko", start);
  if (end === -1) {
    throw new Error("could not bound applyViewportLayout's body (expected startNeko to follow it)");
  }
  return src.slice(start, end);
}

test("steady-state display-fit policy is the module-level contain constant, not an inline literal scattered per call site", async () => {
  const src = await readFile(NEKO_CLIENT_FILE, "utf8");
  assert.match(
    src,
    STEADY_STATE_FIT_CONSTANT_RE,
    'NEKO_STEADY_STATE_DISPLAY_FIT must be declared as "contain" — the operator host must show the whole remote screen, never crop it'
  );
});

test("n.eko steady-state media layout calls remote-surface's selectNekoMediaDisplayForLayout with the contain policy and consumes its displayRect/pointerMapping directly", async () => {
  const src = await readFile(NEKO_CLIENT_FILE, "utf8");
  const body = extractApplyViewportLayoutBody(src);

  const mediaLoopMatch = body.match(STEADY_STATE_MEDIA_LOOP_RE);
  if (!mediaLoopMatch) {
    throw new Error(
      "applyViewportLayout's steady-state per-media-element loop must exist and apply a computed display via applyElementLayout"
    );
  }
  const [mediaLoop] = mediaLoopMatch;

  assert.match(
    mediaLoop,
    SELECT_MEDIA_DISPLAY_STEADY_STATE_CALL_RE,
    "the steady-state media loop must call remote-surface's selectNekoMediaDisplayForLayout(viewportLayout, intrinsic, NEKO_STEADY_STATE_DISPLAY_FIT) — the library, not a local re-derivation, must pick the fit geometry"
  );
  assert.match(
    mediaLoop,
    DISPLAY_RECT_CONSUMPTION_RE,
    "the steady-state media loop must consume selection.displayRect verbatim (height/offsetX/offsetY/width mapped straight to the applied CSS box), not recompute a fit rect locally"
  );

  assert.ok(
    !CONTAIN_SIZE_DEFINITION_RE.test(src),
    "a local containSize function must not exist — remote-surface 1.5.0's selectNekoMediaDisplayForLayout now owns contain-fit geometry for n.eko; re-adding a local containSize would be exactly the local re-derivation planes.md §6 forbids"
  );
  assert.ok(
    !COVER_SIZE_CALL_RE.test(mediaLoop),
    "the steady-state media layout loop must never call coverSize — the operator's host must show the whole remote screen, never crop it (reproduced live: n.eko media rendered 1976x1235 inside a 1976x960 host, y=-137.5)"
  );

  assert.match(
    body,
    OVERLAY_SELECTION_CALL_RE,
    "the overlay textarea (n.eko's own pointer-mapping surface, getMousePos) must be laid out from the SAME library call (viewportLayout, primaryIntrinsic, NEKO_STEADY_STATE_DISPLAY_FIT) as the media element, so pointer mapping stays consistent with where the media is actually drawn"
  );
  assert.match(
    body,
    OVERLAY_RECT_CONSUMPTION_RE,
    "the overlay layout must consume overlaySelection.overlayRect verbatim, not a locally recomputed rect"
  );
});

test("n.eko transient rotation-mismatch path (applyPendingViewportLayout) is unaffected — cover-during-transition is a distinct, deliberate case", async () => {
  const src = await readFile(NEKO_CLIENT_FILE, "utf8");
  const pendingMatch = src.match(APPLY_PENDING_FN_RE);
  if (!pendingMatch) {
    throw new Error("applyPendingViewportLayout must exist in neko-client.ts");
  }
  const [pendingBody] = pendingMatch;

  // This function's cover-during-transition behavior is EXPLICITLY NOT part
  // of the contain-fit fix — it exists for a different, deliberate reason
  // (avoid a letterboxed flash while a mobile rotation's CSS container flips
  // before the remote capture does). This test guards against the fix
  // silently spreading here instead of the intended steady-state function.
  assert.match(
    pendingBody,
    COVER_SIZE_CALL_RE,
    "applyPendingViewportLayout must still use coverSize for the transient/mismatched-container case — this is a deliberate, separate behavior, not part of the steady-state contain-fit fix"
  );
});

// ─── Value-level parity against remote-surface's own geometry ───────────────
// Mirrors stream-parity-geometry.test.ts's approach: rather than asserting
// against a private local reimplementation of the fit math, call the SAME
// library export applyViewportLayout calls (selectNekoMediaDisplayForLayout)
// directly and assert its output against the reviewer's live measurement and
// the required UAT viewports. This test would fail to even compile against
// remote-surface < 1.5.0 (the 3-arg signature and displayRect/overlayRect/
// pointerMapping fields did not exist), and it exercises the library's real
// runtime behavior, not a hand-rolled numeric oracle.

test("parity: remote-surface's contain-fit reproduces the reviewer's exact live scenario without vertical overflow", () => {
  // The reviewer's live numbers: cover-fit media at 1976x1235 inside a
  // 1976x960 host, top=-137.5. That implies a capture aspect ratio of
  // 1976/1235 ≈ 1.6 (16:10) — the SAME default aspect the CDP fallback uses
  // before a real viewport is known. Reconstruct that exact case.
  const captureRatio = 1976 / 1235;
  const captureWidth = 1400;
  const captureHeight = captureWidth / captureRatio;
  const layout = {
    screenHeight: captureHeight,
    screenWidth: captureWidth,
    viewportHeight: 960,
    viewportWidth: 1976,
  };
  const intrinsic = { height: captureHeight, width: captureWidth };

  const cover = selectNekoMediaDisplayForLayout(layout, intrinsic, "cover");
  assert.ok(
    cover.displayRect.height > layout.viewportHeight,
    `sanity: this capture/host combination must reproduce the cover-fit overflow the reviewer measured (got displayRect.height=${cover.displayRect.height}, host=${layout.viewportHeight})`
  );
  assert.ok(
    cover.displayRect.offsetY < 0,
    `sanity: cover-fit must produce a negative offsetY like the reviewer's -137.5 (got ${cover.displayRect.offsetY})`
  );

  const contain = selectNekoMediaDisplayForLayout(layout, intrinsic, "contain");
  assert.ok(
    contain.displayRect.width <= layout.viewportWidth + 0.01,
    `contain-fit width (${contain.displayRect.width}) must not exceed the host width (${layout.viewportWidth})`
  );
  assert.ok(
    contain.displayRect.height <= layout.viewportHeight + 0.01,
    `contain-fit height (${contain.displayRect.height}) must not exceed the host height (${layout.viewportHeight}) — this is the exact axis the live bug overflowed`
  );
  assert.ok(
    contain.displayRect.offsetY >= -0.01,
    `contain-fit must never produce a negative offsetY (got ${contain.displayRect.offsetY})`
  );
  assert.ok(
    contain.displayRect.offsetX >= -0.01,
    `contain-fit must never produce a negative offsetX (got ${contain.displayRect.offsetX})`
  );
  assert.equal(contain.fit, "contain");
  assert.equal(contain.settling, false);
});

test("parity: remote-surface's contain-fit never exceeds either host dimension across the required UAT viewports", () => {
  const cases: Array<{ captureHeight: number; captureWidth: number; hostHeight: number; hostWidth: number }> = [
    { captureHeight: 875, captureWidth: 1400, hostHeight: 960, hostWidth: 1981 }, // desktop, 16:10-ish neko screen mode
    { captureHeight: 875, captureWidth: 1400, hostHeight: 1005, hostWidth: 1400 },
    { captureHeight: 915, captureWidth: 412, hostHeight: 844, hostWidth: 390 }, // phone portrait neko mode
    { captureHeight: 412, captureWidth: 915, hostHeight: 390, hostWidth: 844 }, // phone landscape neko mode
  ];

  for (const { hostWidth, hostHeight, captureWidth, captureHeight } of cases) {
    const layout = {
      screenHeight: captureHeight,
      screenWidth: captureWidth,
      viewportHeight: hostHeight,
      viewportWidth: hostWidth,
    };
    const selection = selectNekoMediaDisplayForLayout(
      layout,
      { height: captureHeight, width: captureWidth },
      "contain"
    );
    const { displayRect } = selection;
    assert.ok(
      displayRect.width <= hostWidth + 0.01,
      `width ${displayRect.width} must not exceed host width ${hostWidth}`
    );
    assert.ok(
      displayRect.height <= hostHeight + 0.01,
      `height ${displayRect.height} must not exceed host height ${hostHeight}`
    );
    assert.ok(
      displayRect.offsetY >= -0.01,
      `offsetY ${displayRect.offsetY} must never be negative (no crop off the top)`
    );
    assert.ok(
      displayRect.offsetX >= -0.01,
      `offsetX ${displayRect.offsetX} must never be negative (no crop off the left)`
    );
    assert.equal(selection.fit, "contain");
  }
});

test("parity: an aspect/orientation mismatch forces cover regardless of the requested contain policy (settling override)", () => {
  // remote-surface classifies mismatch by comparing the media element's
  // reported intrinsic size against layout.screenHeight/screenWidth (the
  // n.eko-reported screen size), not the viewport. A landscape screen size
  // with a portrait intrinsic is orientation-mismatch — the transient state
  // during a rotation before n.eko's own screen-size report catches up. Per
  // remote-surface's own settling override, this must force "cover" even
  // though PDPP requests "contain", so applyViewportLayout must not assume
  // its NEKO_STEADY_STATE_DISPLAY_FIT request always wins.
  const layout = { screenHeight: 1080, screenWidth: 1920, viewportHeight: 960, viewportWidth: 1976 };
  const intrinsic = { height: 1920, width: 1080 };

  const selection = selectNekoMediaDisplayForLayout(layout, intrinsic, "contain");
  assert.equal(selection.settling, true);
  assert.equal(selection.fit, "cover");
});
