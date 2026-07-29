const TOP_LEVEL_REGEX_1 = /valueLength:/;
const TOP_LEVEL_REGEX_2 = /playground backend must be "cdp", "neko", or "neko-remote-cdp"/;
const TOP_LEVEL_REGEX_3 = /position:\s*fixed/;
const TOP_LEVEL_REGEX_4 = /^playground_neko_/;
const TOP_LEVEL_REGEX_5 = /^playground_neko_/;
const TOP_LEVEL_REGEX_6 = /touch-action:\s*none/;
const TOP_LEVEL_REGEX_7 = /user-select:\s*none/;
const TOP_LEVEL_REGEX_8 = /-webkit-tap-highlight-color:\s*transparent/;
const TOP_LEVEL_REGEX_9 = /\$\{CALIBRATION_BEACON_HTML\}\s*<main>/;
const TOP_LEVEL_REGEX_10 = /^data:text\/html;charset=utf-8,/;
const TOP_LEVEL_REGEX_11 = /<div aria-hidden="true" class="pdpp-calibration-beacon" data-pdpp-calibration-beacon=/;
const TOP_LEVEL_REGEX_12 = /^data:text\/html;charset=utf-8,/;
const TOP_LEVEL_REGEX_13 = /<div aria-hidden="true" class="pdpp-calibration-beacon" data-pdpp-calibration-beacon=/;
const TOP_LEVEL_REGEX_14 = /function pdppCalibrationFor\(/;
const TOP_LEVEL_REGEX_15 = /nearestBeacon:\s*nearest\.beacon\.id/;
const TOP_LEVEL_REGEX_16 = /deltaPx:\s*\{/;
const TOP_LEVEL_REGEX_17 = /hitWithinTolerance:/;
const TOP_LEVEL_REGEX_18 = /PDPP_CALIBRATION_HIT_RADIUS_PX\s*=\s*\d+/;
const TOP_LEVEL_REGEX_19 = /^data:text\/html;charset=utf-8,/;
const TOP_LEVEL_REGEX_20 = /closest\(['"]\[data-pdpp-calibration-beacon\]['"]\)/;
const TOP_LEVEL_REGEX_21 = /const pdppPlaygroundPageId = /;
const TOP_LEVEL_REGEX_22 = /pageId: pdppPlaygroundPageId,/;
const TOP_LEVEL_REGEX_23 = /pdppRecordPlaygroundEvent\(['"]calibration_init['"]/;
const TOP_LEVEL_REGEX_24 = /function pdppControlRects\(/;
const TOP_LEVEL_REGEX_25 = /controls:\s*pdppControlRects\(\)/;
const TOP_LEVEL_REGEX_26 = /pdppRecordPlaygroundEvent\(['"]ready['"]/;
const TOP_LEVEL_REGEX_27 = /pdppEmitCalibrationInit/;
const TOP_LEVEL_REGEX_28 = /window\.addEventListener\(['"]resize['"],\s*pdppQueueCalibrationInit/;
const TOP_LEVEL_REGEX_29 =
  /window\.visualViewport[\s\S]{0,200}addEventListener\(['"]resize['"],\s*pdppQueueCalibrationInit/;
const TOP_LEVEL_REGEX_30 = /window\.addEventListener\(['"]orientationchange['"],\s*pdppQueueCalibrationInit/;
const TOP_LEVEL_REGEX_31 = /window\.__pdppPlaygroundEvents/;
const TOP_LEVEL_REGEX_32 = /pdppRecordPlaygroundEvent\(['"]pointerdown['"]/;
const TOP_LEVEL_REGEX_33 = /pdppRecordPlaygroundEvent\(['"]pointerup['"]/;
const TOP_LEVEL_REGEX_34 = /pdppRecordPlaygroundEvent\(['"]click['"]/;
const TOP_LEVEL_REGEX_35 = /pdppRecordPlaygroundEvent\(['"]focusin['"]/;
const TOP_LEVEL_REGEX_36 = /pdppRecordPlaygroundEvent\(['"]focusout['"]/;
const TOP_LEVEL_REGEX_37 = /pdppRecordPlaygroundEvent\(['"]scroll['"]/;
const TOP_LEVEL_REGEX_38 = /pdppRecordPlaygroundEvent\(['"]input['"]/;
const TOP_LEVEL_REGEX_39 = /smokeTokenPresent:/;
const TOP_LEVEL_REGEX_40 = /summary\.valueLength\s*=\s*el\.value\.length/;
const TOP_LEVEL_REGEX_41 = /summary\.textLength\s*=\s*el\.textContent\.length/;
const TOP_LEVEL_REGEX_42 = /document\.elementFromPoint/;
const TOP_LEVEL_REGEX_43 = /pdppRecordPlaygroundEvent\([^)]*clipboardData\.getData/;
const TOP_LEVEL_REGEX_44 = /calibration:\s*calibration/;

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { createPlayground } from "../server/streaming/playground.ts";
import { createRunTargetRegistry, type RunTargetRegistry } from "../server/streaming/run-target-registry.ts";

type RegistryTarget = ReturnType<RunTargetRegistry["get"]>;
type NekoRegistryTarget = Exclude<RegistryTarget, string | null> & { start_url: string };

function requireNekoTarget(target: RegistryTarget): NekoRegistryTarget {
  assert.ok(target !== null && typeof target !== "string");
  assert.ok(typeof target.start_url === "string");
  return { ...target, start_url: target.start_url };
}

test("stream playground n.eko backend mints a fresh session per call (never cached)", async () => {
  // SLVP fidelity: a real connector's manual_action interactions each get a
  // new runId from the controller. The playground's n.eko backend mirrors
  // this — repeated calls produce distinct (runId, interactionId) pairs so
  // the run-target registry's lifetime/eviction semantics behave the same
  // as a real connector run. The cdp/neko-remote-cdp backends cache because
  // they each own a browser process that's expensive to launch; n.eko does
  // not own the Chromium (n.eko itself does), so there's nothing to reuse.
  //
  // This test previously asserted `cached === session` (cache hit). That
  // accidentally passed only when two consecutive Date.now() calls landed
  // in the same millisecond — the keying asymmetry returned the prior
  // entry. Fixing the asymmetry exposes the original intent.
  const runTargetRegistry = createRunTargetRegistry({
    now: () => 1000,
    sweepIntervalMs: 0,
  });
  const controller = {
    getPendingInteraction(_runId?: string) {
      return null;
    },
  };
  const baseUrl = "http://neko:8080/neko";
  const playground = createPlayground({
    controller,
    env: {
      PDPP_NEKO_BASE_URL: baseUrl,
    },
    runTargetRegistry,
  });

  const session = await playground.getOrCreatePlaygroundSession({ backend: "neko" });
  // Re-mint; this MUST be a different session.
  const second = await playground.getOrCreatePlaygroundSession({ backend: "neko" });

  assert.notStrictEqual(session, second);
  assert.notEqual(session.runId, second.runId);
  assert.equal(session.backend, "neko");
  assert.equal(second.backend, "neko");
  assert.match(session.runId, TOP_LEVEL_REGEX_4);
  assert.match(second.runId, TOP_LEVEL_REGEX_5);

  // Both sessions must be registered in the run-target registry — and both
  // must be discoverable by the controller shim. The shim is what allows
  // the streaming-mint route to accept a synthetic playground runId; if a
  // session weren't reachable, opening the stream URL would 404.
  for (const s of [session, second]) {
    const target = requireNekoTarget(runTargetRegistry.get({ interactionId: s.interactionId, runId: s.runId }));
    assert.equal(target.backend, "neko", `target.backend for ${s.runId}`);
    assert.equal(target.base_url, baseUrl, `target.base_url for ${s.runId}`);
    assert.equal(target.cdp_http_url, "http://neko:9223/", `target.cdp_http_url for ${s.runId}`);
    assert.match(target.start_url, TOP_LEVEL_REGEX_19);
    assert.deepEqual(
      controller.getPendingInteraction(s.runId),
      {
        connector_id: "playground:dev",
        interaction_id: s.interactionId,
        kind: "manual_action",
        run_id: s.runId,
        stream: null,
      },
      `controller shim must resolve ${s.runId}`
    );
  }

  await assert.rejects(() => playground.getOrCreatePlaygroundSession({ backend: "unknown" }), TOP_LEVEL_REGEX_2);
});

test("stream playground HTML installs five fixed-positioned calibration beacons with stable ids", async () => {
  // Five beacons at known visualViewport-relative positions: TL, TR,
  // BL, BR, and CENTER. Each carries a stable data-beacon-id and is
  // discoverable via the data-pdpp-calibration-beacon attribute. CSS
  // pins them with position: fixed so their on-screen pixel position
  // is exactly the visualViewport corner regardless of scroll. This
  // is the ground-truth surface the operator uses to verify whether
  // the user-visible pixel maps to the same coords the remote
  // hit-tested at — a feedback loop the prior arithmetic-only
  // telemetry could not close.
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { dirname, resolve } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const src = await readFile(resolve(here, "..", "server", "streaming", "playground.ts"), "utf8");
  for (const beaconId of ["tl", "tr", "bl", "br", "center"]) {
    assert.match(
      src,
      new RegExp(`data-pdpp-calibration-beacon=""\\s+data-beacon-id="${beaconId}"`),
      `beacon id="${beaconId}" present in HTML`
    );
    assert.match(
      src,
      new RegExp(`\\.pdpp-calibration-beacon\\[data-beacon-id="${beaconId}"\\]`),
      `beacon id="${beaconId}" has CSS positioning rule`
    );
  }
  assert.match(src, TOP_LEVEL_REGEX_3, "beacons use position: fixed (visualViewport-anchored)");
  // The beacons must NOT sit on the exact viewport edges — Android and
  // iOS reserve the outer 16-20px for system gestures (back-swipe,
  // multitasking, notification shade). 24px keeps the touch target
  // safely inside the OS-respected page area, even on devices with
  // curved displays.
  for (const corner of ["tl", "tr", "bl", "br"]) {
    const re = new RegExp(
      `\\.pdpp-calibration-beacon\\[data-beacon-id="${corner}"\\]\\s*\\{[^}]*\\b(?:top|right|bottom|left):\\s*24px`
    );
    assert.match(src, re, `beacon id="${corner}" inset by 24px from the viewport edge`);
  }
  // Block native gestures on the beacon itself: scroll-pan, long-press
  // selection, and double-tap zoom can each masquerade as miss-presses
  // and corrupt the calibration signal.
  assert.match(src, TOP_LEVEL_REGEX_6, "beacons disable native touch gestures");
  assert.match(src, TOP_LEVEL_REGEX_7, "beacons disable text selection");
  assert.match(src, TOP_LEVEL_REGEX_8, "beacons disable WebKit tap highlight");
  // The beacon ring is part of the visualViewport, not the document
  // flow, so they MUST NOT be inside the <main> grid (which would
  // change layout under landscape media queries).
  assert.match(src, TOP_LEVEL_REGEX_9, "beacons render before <main>, outside the grid layout");
});

test("stream playground registers calibration beacons only for debug sessions", async () => {
  const runTargetRegistry = createRunTargetRegistry({
    now: () => 1000,
    sweepIntervalMs: 0,
  });
  const controller = {
    getPendingInteraction(_runId?: string) {
      return null;
    },
  };
  const playground = createPlayground({
    controller,
    env: {
      PDPP_NEKO_BASE_URL: "http://neko:8080/neko",
    },
    runTargetRegistry,
  });

  const normal = await playground.getOrCreatePlaygroundSession({ backend: "neko" });
  const normalTarget = requireNekoTarget(
    runTargetRegistry.get({ interactionId: normal.interactionId, runId: normal.runId })
  );
  const normalHtml = decodeURIComponent(normalTarget.start_url.replace(TOP_LEVEL_REGEX_10, ""));
  assert.doesNotMatch(normalHtml, TOP_LEVEL_REGEX_11, "normal playground omits beacon hit targets");

  const debug = await playground.getOrCreatePlaygroundSession({ backend: "neko", streamDebug: "1" });
  const debugTarget = requireNekoTarget(
    runTargetRegistry.get({ interactionId: debug.interactionId, runId: debug.runId })
  );
  const debugHtml = decodeURIComponent(debugTarget.start_url.replace(TOP_LEVEL_REGEX_12, ""));
  assert.match(debugHtml, TOP_LEVEL_REGEX_13, "debug playground includes beacon hit targets");
});

test("stream playground records calibration data on every pointer/click event", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { dirname, resolve } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const src = await readFile(resolve(here, "..", "server", "streaming", "playground.ts"), "utf8");
  // The calibration helper must compute nearest-beacon delta and a
  // hit-within-tolerance boolean. Without these the operator can't
  // tell from JSONL alone whether the user successfully pressed the
  // beacon they aimed at.
  assert.match(src, TOP_LEVEL_REGEX_14, "pdppCalibrationFor helper exists");
  assert.match(src, TOP_LEVEL_REGEX_15, "reports nearestBeacon id");
  assert.match(src, TOP_LEVEL_REGEX_16, "reports deltaPx { x, y, distance }");
  assert.match(src, TOP_LEVEL_REGEX_17, "reports hitWithinTolerance boolean");
  assert.match(src, TOP_LEVEL_REGEX_18, "tolerance radius is an explicit constant (not a magic number)");
  // pdppPointerExtras must enrich the event with the calibration field
  // — the per-event surface the adapter drains via the status poll.
  const extrasFn = src.split("function pdppPointerExtras(")[1]?.split("\nfunction ")[0] ?? "";
  assert.match(extrasFn, TOP_LEVEL_REGEX_44, "pointer events carry calibration field");
  assert.match(extrasFn, TOP_LEVEL_REGEX_20, "beaconUnderPoint resolved via elementFromPoint().closest()");
  // Every event carries a per-page-load identifier so the viewer
  // dedupe survives a remote reload (n.eko Page.navigate, manual
  // refresh) without silently dropping the new page's events.
  assert.match(src, TOP_LEVEL_REGEX_21, "playground generates a per-page-load identifier");
  assert.match(src, TOP_LEVEL_REGEX_22, "every recorded event is stamped with pageId");
  // calibration_init must fire once at script boot so the operator
  // gets the authoritative beacon coordinates exactly once per page
  // load via the next status drain.
  assert.match(src, TOP_LEVEL_REGEX_23, "calibration_init event fires at script boot to publish beacon registry");
  assert.match(src, TOP_LEVEL_REGEX_24, "debug telemetry exposes control rectangles for smoke targeting");
  assert.match(src, TOP_LEVEL_REGEX_25, "calibration_init includes control rectangles for counter/input targeting");
  assert.match(src, TOP_LEVEL_REGEX_26, "ready event publishes playground telemetry readiness");
  // And it must re-emit on resize / visualViewport.resize / orientation
  // change. Without these, beacon coordinates captured at boot reflect
  // the pre-emulation X-server layout rather than the post-emulation
  // page the user actually interacts with — symptom: "I tapped four
  // beacons and then the page changed and they vanished."
  assert.match(src, TOP_LEVEL_REGEX_27, "calibration_init emit helper is named so it can be reused on resize");
  assert.match(src, TOP_LEVEL_REGEX_28, "calibration_init re-emits on window resize");
  assert.match(src, TOP_LEVEL_REGEX_29, "calibration_init re-emits on visualViewport resize");
  assert.match(src, TOP_LEVEL_REGEX_30, "calibration_init re-emits on orientationchange");
});

test("stream playground HTML installs a __pdppPlaygroundEvents ring buffer for click/focus/scroll telemetry", async () => {
  // Inline source check: the playground page must record pointerdown,
  // pointerup, click, focusin, focusout, and scroll into the
  // ring buffer used by the n.eko adapter to surface remote-side
  // telemetry. The buffer must NOT log raw text, selected text, or
  // clipboard contents; it summarises target elements by tag/role/id/
  // class plus length-only fields. This test pins those invariants
  // by source-shape assertions so a future contributor can't quietly
  // regress to logging raw input values.
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { dirname, resolve } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const src = await readFile(resolve(here, "..", "server", "streaming", "playground.ts"), "utf8");
  assert.match(src, TOP_LEVEL_REGEX_31, "playground exposes the ring buffer");
  assert.match(src, TOP_LEVEL_REGEX_32, "records pointerdown");
  assert.match(src, TOP_LEVEL_REGEX_33, "records pointerup");
  assert.match(src, TOP_LEVEL_REGEX_34, "records click");
  assert.match(src, TOP_LEVEL_REGEX_35, "records focusin");
  assert.match(src, TOP_LEVEL_REGEX_36, "records focusout");
  assert.match(src, TOP_LEVEL_REGEX_37, "records scroll");
  assert.match(src, TOP_LEVEL_REGEX_38, "records input");
  assert.match(src, TOP_LEVEL_REGEX_39, "input telemetry can prove smoke-token delivery without logging raw text");
  assert.match(src, TOP_LEVEL_REGEX_1, "input telemetry reports length-only input state");
  // Privacy: text content / selection / clipboard payloads are NEVER
  // logged. We summarise via lengths only.
  assert.match(src, TOP_LEVEL_REGEX_40, "value reported only by length");
  assert.match(src, TOP_LEVEL_REGEX_41, "text content reported only by length");
  // The pointer-extras helper must call elementFromPoint so we can
  // catch wrong-position press cases (target differs from element-at-
  // point indicates a coordinate mismatch).
  assert.match(src, TOP_LEVEL_REGEX_42, "records elementAtPoint for wrong-target detection");
  // The full-text playground ring buffer must NOT capture clipboard
  // payload content; the existing local logEvent paste handler is
  // unrelated and stays as a developer convenience.
  assert.doesNotMatch(src, TOP_LEVEL_REGEX_43);
});
