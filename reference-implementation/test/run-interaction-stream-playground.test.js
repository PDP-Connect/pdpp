import test from 'node:test';
import assert from 'node:assert/strict';

import { createPlayground } from '../server/streaming/playground.js';
import { createRunTargetRegistry } from '../server/streaming/run-target-registry.js';

test('stream playground can register a cached n.eko backend session', async () => {
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
  runTargetRegistry.forceUnregister({
    runId: session.runId,
    interactionId: session.interactionId,
  });
  assert.equal(
    runTargetRegistry.get({
      runId: session.runId,
      interactionId: session.interactionId,
    }),
    null,
  );
  const cached = await playground.getOrCreatePlaygroundSession({ backend: 'neko' });

  assert.equal(session, cached);
  assert.equal(session.backend, 'neko');
  assert.match(session.runId, /^playground_neko_/);
  const target = runTargetRegistry.get({
    runId: session.runId,
    interactionId: session.interactionId,
  });
  assert.equal(target.backend, 'neko');
  assert.equal(target.base_url, baseUrl);
  assert.match(target.start_url, /^data:text\/html;charset=utf-8,/);
  assert.deepEqual(controller.getPendingInteraction(session.runId), {
    run_id: session.runId,
    connector_id: 'playground:dev',
    interaction_id: session.interactionId,
    kind: 'manual_action',
    stream: null,
  });

  await assert.rejects(
    () => playground.getOrCreatePlaygroundSession({ backend: 'unknown' }),
    /playground backend must be "cdp" or "neko"/,
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
  // The beacon ring is part of the visualViewport, not the document
  // flow, so they MUST NOT be inside the <main> grid (which would
  // change layout under landscape media queries).
  const beaconBlock = src.match(/<div aria-hidden="true" class="pdpp-calibration-beacon"[\s\S]{0,400}<main>/);
  assert.ok(beaconBlock, 'beacons render before <main>, outside the grid layout');
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
  // calibration_init must fire once at script boot so the operator
  // gets the authoritative beacon coordinates exactly once per page
  // load via the next status drain.
  assert.match(
    src,
    /pdppRecordPlaygroundEvent\(['"]calibration_init['"]/,
    'calibration_init event fires at script boot to publish beacon registry'
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
