import test from 'node:test';
import assert from 'node:assert/strict';

import { createPlayground } from '../server/streaming/playground.js';
import { createRunTargetRegistry } from '../server/streaming/run-target-registry.js';

test('stream playground n.eko backend mints a fresh session per call (never cached)', async () => {
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
    sweepIntervalMs: 0,
    now: () => 1_000,
  });
  const controller = {
    getPendingInteraction() {
      return null;
    },
  };
  const baseUrl = 'http://neko:8080/neko';
  const playground = createPlayground({
    runTargetRegistry,
    controller,
    env: {
      PDPP_NEKO_BASE_URL: baseUrl,
    },
  });

  const session = await playground.getOrCreatePlaygroundSession({ backend: 'neko' });
  // Re-mint; this MUST be a different session.
  const second = await playground.getOrCreatePlaygroundSession({ backend: 'neko' });

  assert.notStrictEqual(session, second);
  assert.notEqual(session.runId, second.runId);
  assert.equal(session.backend, 'neko');
  assert.equal(second.backend, 'neko');
  assert.match(session.runId, /^playground_neko_/);
  assert.match(second.runId, /^playground_neko_/);

  // Both sessions must be registered in the run-target registry — and both
  // must be discoverable by the controller shim. The shim is what allows
  // the streaming-mint route to accept a synthetic playground runId; if a
  // session weren't reachable, opening the stream URL would 404.
  for (const s of [session, second]) {
    const target = runTargetRegistry.get({ runId: s.runId, interactionId: s.interactionId });
    assert.equal(target.backend, 'neko', `target.backend for ${s.runId}`);
    assert.equal(target.base_url, baseUrl, `target.base_url for ${s.runId}`);
    assert.match(target.start_url, /^data:text\/html;charset=utf-8,/);
    assert.deepEqual(
      controller.getPendingInteraction(s.runId),
      {
        run_id: s.runId,
        connector_id: 'playground:dev',
        interaction_id: s.interactionId,
        kind: 'manual_action',
        stream: null,
      },
      `controller shim must resolve ${s.runId}`,
    );
  }

  await assert.rejects(
    () => playground.getOrCreatePlaygroundSession({ backend: 'unknown' }),
    /playground backend must be "cdp", "neko", or "neko-remote-cdp"/,
  );
});

test('stream playground HTML installs five fixed-positioned calibration beacons with stable ids', async () => {
  // Five beacons at known visualViewport-relative positions: TL, TR,
  // BL, BR, and CENTER. Each carries a stable data-beacon-id and is
  // discoverable via the data-pdpp-calibration-beacon attribute. CSS
  // pins them with position: fixed so their on-screen pixel position
  // is exactly the visualViewport corner regardless of scroll. This
  // is the ground-truth surface the operator uses to verify whether
  // the user-visible pixel maps to the same coords the remote
  // hit-tested at — a feedback loop the prior arithmetic-only
  // telemetry could not close.
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { dirname, resolve } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const src = await readFile(resolve(here, '..', 'server', 'streaming', 'playground.js'), 'utf8');
  for (const beaconId of ['tl', 'tr', 'bl', 'br', 'center']) {
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
  assert.match(src, /position:\s*fixed/, 'beacons use position: fixed (visualViewport-anchored)');
  // The beacons must NOT sit on the exact viewport edges — Android and
  // iOS reserve the outer 16-20px for system gestures (back-swipe,
  // multitasking, notification shade). 24px keeps the touch target
  // safely inside the OS-respected page area, even on devices with
  // curved displays.
  for (const corner of ['tl', 'tr', 'bl', 'br']) {
    const re = new RegExp(`\\.pdpp-calibration-beacon\\[data-beacon-id="${corner}"\\]\\s*\\{[^}]*\\b(?:top|right|bottom|left):\\s*24px`);
    assert.match(src, re, `beacon id="${corner}" inset by 24px from the viewport edge`);
  }
  // Block native gestures on the beacon itself: scroll-pan, long-press
  // selection, and double-tap zoom can each masquerade as miss-presses
  // and corrupt the calibration signal.
  assert.match(src, /touch-action:\s*none/, 'beacons disable native touch gestures');
  assert.match(src, /user-select:\s*none/, 'beacons disable text selection');
  assert.match(src, /-webkit-tap-highlight-color:\s*transparent/, 'beacons disable WebKit tap highlight');
  // The beacon ring is part of the visualViewport, not the document
  // flow, so they MUST NOT be inside the <main> grid (which would
  // change layout under landscape media queries).
  assert.match(src, /\$\{CALIBRATION_BEACON_HTML\}\s*<main>/, 'beacons render before <main>, outside the grid layout');
});

test('stream playground registers calibration beacons only for debug sessions', async () => {
  const runTargetRegistry = createRunTargetRegistry({
    sweepIntervalMs: 0,
    now: () => 1_000,
  });
  const controller = {
    getPendingInteraction() {
      return null;
    },
  };
  const playground = createPlayground({
    runTargetRegistry,
    controller,
    env: {
      PDPP_NEKO_BASE_URL: 'http://neko:8080/neko',
    },
  });

  const normal = await playground.getOrCreatePlaygroundSession({ backend: 'neko' });
  const normalTarget = runTargetRegistry.get({ runId: normal.runId, interactionId: normal.interactionId });
  const normalHtml = decodeURIComponent(normalTarget.start_url.replace(/^data:text\/html;charset=utf-8,/, ''));
  assert.doesNotMatch(
    normalHtml,
    /<div aria-hidden="true" class="pdpp-calibration-beacon" data-pdpp-calibration-beacon=/,
    'normal playground omits beacon hit targets'
  );

  const debug = await playground.getOrCreatePlaygroundSession({ backend: 'neko', streamDebug: '1' });
  const debugTarget = runTargetRegistry.get({ runId: debug.runId, interactionId: debug.interactionId });
  const debugHtml = decodeURIComponent(debugTarget.start_url.replace(/^data:text\/html;charset=utf-8,/, ''));
  assert.match(
    debugHtml,
    /<div aria-hidden="true" class="pdpp-calibration-beacon" data-pdpp-calibration-beacon=/,
    'debug playground includes beacon hit targets'
  );
});

test('stream playground records calibration data on every pointer/click event', async () => {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { dirname, resolve } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const src = await readFile(resolve(here, '..', 'server', 'streaming', 'playground.js'), 'utf8');
  // The calibration helper must compute nearest-beacon delta and a
  // hit-within-tolerance boolean. Without these the operator can't
  // tell from JSONL alone whether the user successfully pressed the
  // beacon they aimed at.
  assert.match(src, /function pdppCalibrationFor\(/, 'pdppCalibrationFor helper exists');
  assert.match(src, /nearestBeacon:\s*nearest\.beacon\.id/, 'reports nearestBeacon id');
  assert.match(src, /deltaPx:\s*\{/, 'reports deltaPx { x, y, distance }');
  assert.match(src, /hitWithinTolerance:/, 'reports hitWithinTolerance boolean');
  assert.match(
    src,
    /PDPP_CALIBRATION_HIT_RADIUS_PX\s*=\s*\d+/,
    'tolerance radius is an explicit constant (not a magic number)'
  );
  // pdppPointerExtras must enrich the event with the calibration field
  // — the per-event surface the adapter drains via the status poll.
  const extrasFn = src.split('function pdppPointerExtras(')[1]?.split('\nfunction ')[0] ?? '';
  assert.match(extrasFn, /calibration:\s*calibration/, 'pointer events carry calibration field');
  assert.match(
    extrasFn,
    /closest\(['"]\[data-pdpp-calibration-beacon\]['"]\)/,
    'beaconUnderPoint resolved via elementFromPoint().closest()'
  );
  // Every event carries a per-page-load identifier so the viewer
  // dedupe survives a remote reload (n.eko Page.navigate, manual
  // refresh) without silently dropping the new page's events.
  assert.match(
    src,
    /const pdppPlaygroundPageId = /,
    'playground generates a per-page-load identifier'
  );
  assert.match(
    src,
    /pageId: pdppPlaygroundPageId,/,
    'every recorded event is stamped with pageId'
  );
  // calibration_init must fire once at script boot so the operator
  // gets the authoritative beacon coordinates exactly once per page
  // load via the next status drain.
  assert.match(
    src,
    /pdppRecordPlaygroundEvent\(['"]calibration_init['"]/,
    'calibration_init event fires at script boot to publish beacon registry'
  );
  // And it must re-emit on resize / visualViewport.resize / orientation
  // change. Without these, beacon coordinates captured at boot reflect
  // the pre-emulation X-server layout rather than the post-emulation
  // page the user actually interacts with — symptom: "I tapped four
  // beacons and then the page changed and they vanished."
  assert.match(
    src,
    /pdppEmitCalibrationInit/,
    'calibration_init emit helper is named so it can be reused on resize'
  );
  assert.match(
    src,
    /window\.addEventListener\(['"]resize['"],\s*pdppQueueCalibrationInit/,
    'calibration_init re-emits on window resize'
  );
  assert.match(
    src,
    /window\.visualViewport[\s\S]{0,200}addEventListener\(['"]resize['"],\s*pdppQueueCalibrationInit/,
    'calibration_init re-emits on visualViewport resize'
  );
  assert.match(
    src,
    /window\.addEventListener\(['"]orientationchange['"],\s*pdppQueueCalibrationInit/,
    'calibration_init re-emits on orientationchange'
  );
});

test('stream playground HTML installs a __pdppPlaygroundEvents ring buffer for click/focus/scroll telemetry', async () => {
  // Inline source check: the playground page must record pointerdown,
  // pointerup, click, focusin, focusout, and scroll into the
  // ring buffer used by the n.eko adapter to surface remote-side
  // telemetry. The buffer must NOT log raw text, selected text, or
  // clipboard contents; it summarises target elements by tag/role/id/
  // class plus length-only fields. This test pins those invariants
  // by source-shape assertions so a future contributor can't quietly
  // regress to logging raw input values.
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { dirname, resolve } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const src = await readFile(resolve(here, '..', 'server', 'streaming', 'playground.js'), 'utf8');
  assert.match(src, /window\.__pdppPlaygroundEvents/, 'playground exposes the ring buffer');
  assert.match(src, /pdppRecordPlaygroundEvent\(['"]pointerdown['"]/, 'records pointerdown');
  assert.match(src, /pdppRecordPlaygroundEvent\(['"]pointerup['"]/, 'records pointerup');
  assert.match(src, /pdppRecordPlaygroundEvent\(['"]click['"]/, 'records click');
  assert.match(src, /pdppRecordPlaygroundEvent\(['"]focusin['"]/, 'records focusin');
  assert.match(src, /pdppRecordPlaygroundEvent\(['"]focusout['"]/, 'records focusout');
  assert.match(src, /pdppRecordPlaygroundEvent\(['"]scroll['"]/, 'records scroll');
  // Privacy: text content / selection / clipboard payloads are NEVER
  // logged. We summarise via lengths only.
  assert.match(src, /summary\.valueLength\s*=\s*el\.value\.length/, 'value reported only by length');
  assert.match(src, /summary\.textLength\s*=\s*el\.textContent\.length/, 'text content reported only by length');
  // The pointer-extras helper must call elementFromPoint so we can
  // catch wrong-position press cases (target differs from element-at-
  // point indicates a coordinate mismatch).
  assert.match(src, /document\.elementFromPoint/, 'records elementAtPoint for wrong-target detection');
  // The full-text playground ring buffer must NOT capture clipboard
  // payload content; the existing local logEvent paste handler is
  // unrelated and stays as a developer convenience.
  assert.doesNotMatch(src, /pdppRecordPlaygroundEvent\([^)]*clipboardData\.getData/);
});
