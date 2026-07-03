/**
 * Stream playground (dev-only).
 *
 * Exposes `getOrCreatePlaygroundSession`, which mints a synthetic
 * (runId, interactionId) pair, registers a CDP or n.eko streaming target with
 * the run-target registry, and shims `getPendingInteraction(runId)` so the
 * standard streaming-mint route accepts the playground runId as if a real
 * connector were awaiting a manual_action.
 *
 * The point: a developer can open `/stream-playground` in the web app, see the
 * real <StreamSurface> backed by CDP or n.eko, and exercise
 * browser interaction without wiring up a connector run.
 *
 * NOT for production: the helper bypasses the connector lifecycle, mints
 * tokens that authorize CDP input on a long-lived page, and never expires the
 * underlying browser. Callers MUST gate on `process.env.NODE_ENV !== "production"`
 * before invoking.
 */

import { emitRemoteTelemetry } from './remote-telemetry-registry.js';

const PROFILE_NAME = 'stream-playground';
const DEFAULT_PLAYGROUND_BACKEND = 'cdp';
const DEFAULT_NEKO_BASE_URL = 'http://127.0.0.1:8080/neko';
const DEFAULT_DOCKER_NEKO_BASE_URL = 'http://neko:8080/neko';
// One device-id constant, used both when registering the wsUrl with the
// run-target registry and when minting future runIds. Synthetic — does not
// collide with real device-exporter ids (those have a uuid-style prefix).
const PLAYGROUND_DEVICE_ID = 'playground:dev';
const CALIBRATION_BEACON_HTML = `<!-- Calibration beacons. Each is fixed-positioned at a known viewport
     corner or centre; their data-beacon-id gets stamped into every
     playground event whose elementFromPoint hits the beacon, plus
     the nearest-beacon delta for any event in the surface. This is
     the ground-truth signal the operator uses to verify whether the
     user-visible pixel under the finger maps to the same coords the
     remote hit-tested at. -->
<div aria-hidden="true" class="pdpp-calibration-beacon" data-pdpp-calibration-beacon="" data-beacon-id="tl"></div>
<div aria-hidden="true" class="pdpp-calibration-beacon" data-pdpp-calibration-beacon="" data-beacon-id="tr"></div>
<div aria-hidden="true" class="pdpp-calibration-beacon" data-pdpp-calibration-beacon="" data-beacon-id="bl"></div>
<div aria-hidden="true" class="pdpp-calibration-beacon" data-pdpp-calibration-beacon="" data-beacon-id="br"></div>
<div aria-hidden="true" class="pdpp-calibration-beacon" data-pdpp-calibration-beacon="" data-beacon-id="center"></div>`;
const TEST_PAGE_HTML = `<!doctype html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<style>
:root { color-scheme: light; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
* { box-sizing: border-box; }
html { min-height: 100%; }
body { margin: 0; min-height: 100dvh; overflow-y: auto; overscroll-behavior-y: contain; background: #f7f5ef; color: #181713; -webkit-overflow-scrolling: touch; }
main { display: grid; gap: 14px; width: 100%; min-height: 100dvh; margin: 0; padding: max(14px, env(safe-area-inset-top)) max(14px, env(safe-area-inset-right)) max(18px, env(safe-area-inset-bottom)) max(14px, env(safe-area-inset-left)); }
h1 { margin: 0; font-size: clamp(30px, 11vw, 44px); line-height: 0.95; letter-spacing: -0.045em; }
p { margin: 0; color: #5e584c; font-size: 15px; line-height: 1.35; }
button, input { width: 100%; min-height: 48px; border: 1px solid #797266; border-radius: 10px; background: #fffdf7; color: #181713; font: inherit; font-size: 18px; }
button { padding: 12px 16px; text-align: left; font-weight: 650; }
input { padding: 12px 14px; }
#event-log { min-height: 220px; max-height: min(42dvh, 320px); overflow: auto; overscroll-behavior: auto; border-radius: 10px; background: #ebe8df; padding: 10px; font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; font-size: 13px; line-height: 1.35; white-space: pre-wrap; overflow-wrap: anywhere; }
#scroll-probe { display: grid; gap: 10px; min-height: 44dvh; border-radius: 14px; background: #fffaf0; padding: 14px; border: 1px solid #d8d0c0; }
.probe-card { border-radius: 10px; background: #ebe8df; padding: 12px; color: #373126; }
.probe-card strong { display: block; margin-bottom: 4px; color: #181713; }
/* Calibration beacons: visible enough to aim at on a phone, unobtrusive
   enough not to dominate the visual frame. Each beacon is a 32x32 ring
   with a 6px crosshair drawn at its exact centre. position: fixed pins
   them to the visualViewport, so the ground-truth coordinates the
   operator reads from telemetry are always relative to the visible
   viewport corner regardless of scroll. */
.pdpp-calibration-beacon {
  position: fixed;
  /* Inset 24px from each viewport edge so the touch target sits OUTSIDE
     the Android/iOS edge-gesture zones (typically the outer 16-20px,
     which trigger back-gesture / multitasking / notification-shade
     pulls). 24px keeps the beacon within the OS-respected page area
     even on devices with curved displays. */
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 2px solid rgba(220, 38, 38, 0.85);
  background: rgba(255, 255, 255, 0.55);
  z-index: 2147483646;
  pointer-events: auto;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.18);
  display: flex;
  align-items: center;
  justify-content: center;
  /* Disable native gestures on the beacon itself: no scroll capture, no
     long-press selection, no double-tap zoom. The beacon is a plain
     hit-test target; anything else corrupts the calibration signal. */
  touch-action: none;
  -webkit-user-select: none;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}
.pdpp-calibration-beacon::before,
.pdpp-calibration-beacon::after {
  content: '';
  position: absolute;
  background: rgba(220, 38, 38, 0.9);
}
.pdpp-calibration-beacon::before { width: 8px; height: 1px; }
.pdpp-calibration-beacon::after  { width: 1px; height: 8px; }
.pdpp-calibration-beacon[data-beacon-id="tl"] { top: 24px;    left: 24px; }
.pdpp-calibration-beacon[data-beacon-id="tr"] { top: 24px;    right: 24px; }
.pdpp-calibration-beacon[data-beacon-id="bl"] { bottom: 24px; left: 24px; }
.pdpp-calibration-beacon[data-beacon-id="br"] { bottom: 24px; right: 24px; }
.pdpp-calibration-beacon[data-beacon-id="center"] {
  top: 50%; left: 50%; transform: translate(-50%, -50%);
}
@media (min-width: 640px) {
  button { width: fit-content; min-width: 260px; }
}
@media (max-height: 42rem) and (orientation: landscape) {
  main { width: min(100%, 900px); grid-template-columns: minmax(240px, 0.85fr) minmax(280px, 1fr); align-items: start; padding-block: max(14px, env(safe-area-inset-top)) max(18px, env(safe-area-inset-bottom)); }
  h1, p { grid-column: 1; }
  button, input, #event-log { grid-column: 2; }
  #scroll-probe { grid-column: 1 / -1; min-height: 260px; }
  h1 { font-size: clamp(26px, 7vw, 38px); }
  #event-log { min-height: 160px; max-height: none; overflow: visible; }
}
</style>
</head><body>
${CALIBRATION_BEACON_HTML}
<main>
<h1>Stream Playground</h1>
<p>Exercise click, touch, type, scroll, and paste. On mobile, composed keyboard text may appear as a paste-style event because n.eko forwards IME text through its paste channel.</p>
<button id="counter">Click me (count: 0)</button>
<input id="text-input" placeholder="Type here" autocomplete="off" autocapitalize="none" spellcheck="false" />
<div id="event-log" aria-live="polite"></div>
<section id="scroll-probe" aria-label="Page scroll probe">
  <div class="probe-card"><strong>Page scroll target</strong>Drag vertically here to verify the remote page scrolls, not only this log.</div>
  <div class="probe-card"><strong>Nested scroll guard</strong>The log still records events, but landscape should let the document move.</div>
  <div class="probe-card"><strong>Bottom marker</strong>If you can reach this card on a phone in landscape, stream scrolling is working.</div>
</section>
<script>
let count = 0;
const counter = document.getElementById('counter');
const log = document.getElementById('event-log');
const input = document.getElementById('text-input');
	function logEvent(msg) {
	  const line = document.createElement('div');
	  line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
	  log.insertBefore(line, log.firstChild);
	  while (log.childElementCount > 80) log.lastElementChild.remove();
	}
// PDPP debug telemetry: record a small ring buffer of recent remote
// events so the n.eko adapter's status poll can surface them up to the
// viewer for correlation against local touch/click telemetry. We record
// only target shape (tag, role, id, classes, text/value LENGTHS) plus
// coordinates and elementFromPoint — never raw text content, selected
// text, or clipboard payloads.
window.__pdppPlaygroundEvents = window.__pdppPlaygroundEvents || [];
const PDPP_EVENT_BUFFER_MAX = 24;
let pdppPlaygroundSeq = 0;
// Per-page-load identifier. Stamped on every event so the viewer can
// dedupe across status polls AND distinguish events from a previous
// playground page-load (e.g. n.eko-driven Page.navigate, manual
// reload, soft-refresh) — without that, a remote reload restarts
// pdppPlaygroundSeq at 1 and a high-watermark dedupe would silently
// swallow every event from the new page until seq exceeds the
// pre-reload watermark. Use crypto.randomUUID where available, fall
// back to a high-entropy string otherwise.
const pdppPlaygroundPageId = (function () {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch (_err) {
    // fall through
  }
  return 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
})();
window.__pdppPlaygroundPageId = pdppPlaygroundPageId;
function pdppSummariseElement(el) {
  if (!el || el.nodeType !== 1) return null;
  const summary = {
    tag: el.tagName ? el.tagName.toLowerCase() : null,
    id: el.id || null,
    role: el.getAttribute ? el.getAttribute('role') : null,
    cls: el.className && typeof el.className === 'string' ? el.className.slice(0, 80) : null,
  };
  if (typeof el.value === 'string') summary.valueLength = el.value.length;
  if (typeof el.placeholder === 'string') summary.placeholderLength = el.placeholder.length;
  if (typeof el.textContent === 'string' && el.children && el.children.length === 0) {
    summary.textLength = el.textContent.length;
  }
  return summary;
}
function pdppRecordPlaygroundEvent(type, extras) {
  pdppPlaygroundSeq += 1;
  const entry = {
    pageId: pdppPlaygroundPageId,
    seq: pdppPlaygroundSeq,
    type: type,
    atMs: Date.now(),
    perfNow: Math.round(performance.now()),
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    scrollX: Math.round(window.scrollX || 0),
    scrollY: Math.round(window.scrollY || 0),
    activeElement: pdppSummariseElement(document.activeElement),
  };
  if (extras) {
    for (const key in extras) entry[key] = extras[key];
  }
  window.__pdppPlaygroundEvents.push(entry);
  while (window.__pdppPlaygroundEvents.length > PDPP_EVENT_BUFFER_MAX) {
    window.__pdppPlaygroundEvents.shift();
  }
  // Layer-D push: if the Patchright binding is installed (CDP /
  // neko-remote-cdp backends), forward the event immediately so the viewer
  // can correlate remote DOM events with phone-side input by approximate
  // timestamp. Best-effort — the binding may not exist (e.g. n.eko HTTP
  // backend, which has no Patchright handle).
  try {
    if (typeof window.__pdppRemoteTelemetry === 'function') {
      window.__pdppRemoteTelemetry(entry);
    }
  } catch (_err) {
    /* binding errors must not break the page */
  }
}
// Tolerance in CSS px: a press inside this radius of a beacon centre
// counts as a calibration hit. 16px is half the beacon diameter (the
// outer edge of the painted ring), giving the user the full visible
// target as a hit zone — slightly forgiving on a touchscreen.
const PDPP_CALIBRATION_HIT_RADIUS_PX = 16;
function pdppRectCentre(rect) {
  return { cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2 };
}
function pdppListBeacons() {
  const nodes = document.querySelectorAll('[data-pdpp-calibration-beacon]');
  const out = [];
  for (let i = 0; i < nodes.length; i += 1) {
    const el = nodes[i];
    const id = el.getAttribute('data-beacon-id') || String(i);
    const rect = el.getBoundingClientRect();
    out.push({
      id,
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      centre: {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      },
    });
  }
  return out;
}
function pdppControlRects() {
  const controls = [
    ['counter', counter],
    ['text-input', input],
  ];
  const out = {};
  for (const [id, el] of controls) {
    if (!el || typeof el.getBoundingClientRect !== 'function') continue;
    const rect = el.getBoundingClientRect();
    out[id] = {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      centre: {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      },
    };
  }
  return out;
}
// Exposed for adapter introspection if needed; primary path is the
// per-event calibration field below.
window.__pdppPlaygroundBeacons = pdppListBeacons;
function pdppCalibrationFor(clientX, clientY, beaconUnderPoint) {
  if (clientX === null || clientY === null) return null;
  const beacons = pdppListBeacons();
  if (beacons.length === 0) return null;
  let nearest = null;
  let nearestDelta = Infinity;
  for (const beacon of beacons) {
    const dx = clientX - beacon.centre.x;
    const dy = clientY - beacon.centre.y;
    const distance = Math.hypot(dx, dy);
    if (distance < nearestDelta) {
      nearestDelta = distance;
      nearest = { beacon, dx: Math.round(dx), dy: Math.round(dy), distancePx: Math.round(distance) };
    }
  }
  if (!nearest) return null;
  return {
    nearestBeacon: nearest.beacon.id,
    beaconRect: nearest.beacon.rect,
    beaconCentre: nearest.beacon.centre,
    deltaPx: { x: nearest.dx, y: nearest.dy, distance: nearest.distancePx },
    hitWithinTolerance: nearest.distancePx <= PDPP_CALIBRATION_HIT_RADIUS_PX,
    toleranceRadiusPx: PDPP_CALIBRATION_HIT_RADIUS_PX,
    beaconUnderPoint: beaconUnderPoint || null,
    beaconCount: beacons.length,
  };
}
function pdppPointerExtras(event) {
  const x = typeof event.clientX === 'number' ? event.clientX : null;
  const y = typeof event.clientY === 'number' ? event.clientY : null;
  let elementAtPoint = null;
  let beaconUnderPoint = null;
  if (x !== null && y !== null) {
    try {
      const at = document.elementFromPoint(x, y);
      elementAtPoint = pdppSummariseElement(at);
      // Did the rendered pixel under the finger belong to a beacon?
      // This is the unfalsifiable hit-test signal: if this fires, the
      // user-visible target and the remote-hit target are *the same*
      // by construction.
      const beaconEl = at && typeof at.closest === 'function' ? at.closest('[data-pdpp-calibration-beacon]') : null;
      if (beaconEl) {
        beaconUnderPoint = beaconEl.getAttribute('data-beacon-id') || null;
      }
    } catch (_err) {
      elementAtPoint = null;
      beaconUnderPoint = null;
    }
  }
  const calibration = pdppCalibrationFor(x, y, beaconUnderPoint);
  return {
    clientX: x,
    clientY: y,
    pageX: typeof event.pageX === 'number' ? Math.round(event.pageX) : null,
    pageY: typeof event.pageY === 'number' ? Math.round(event.pageY) : null,
    button: typeof event.button === 'number' ? event.button : null,
    buttons: typeof event.buttons === 'number' ? event.buttons : null,
    pointerType: typeof event.pointerType === 'string' ? event.pointerType : null,
    target: pdppSummariseElement(event.target),
    elementAtPoint: elementAtPoint,
    calibration: calibration,
  };
}
// Stamp the beacon registry once at boot AND every time the layout
// container changes (Chromium emulation re-applying device metrics
// late, soft-keyboard activation, orientation flip). Without the
// resize-driven re-emit, an operator parsing JSONL only sees beacon
// coordinates from the *initial* layout — which under n.eko is often
// the X server's pre-emulation CSS size, not the post-emulation page
// the user actually interacts with. Coalesced via rAF + 100ms
// throttle so a burst of resize events emits at most one
// calibration_init per ~100ms.
function pdppEmitCalibrationInit() {
  pdppRecordPlaygroundEvent('calibration_init', {
    beacons: pdppListBeacons(),
    controls: pdppControlRects(),
    toleranceRadiusPx: PDPP_CALIBRATION_HIT_RADIUS_PX,
    visualViewport: window.visualViewport ? {
      width: Math.round(window.visualViewport.width),
      height: Math.round(window.visualViewport.height),
      offsetTop: Math.round(window.visualViewport.offsetTop),
      offsetLeft: Math.round(window.visualViewport.offsetLeft),
      scale: Number.isFinite(window.visualViewport.scale) ? window.visualViewport.scale : null
    } : null,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio
  });
}
pdppEmitCalibrationInit();
pdppRecordPlaygroundEvent('ready', {
  controls: pdppControlRects(),
  beacons: pdppListBeacons(),
});
let pdppCalibrationInitPending = false;
let pdppLastCalibrationInitAt = performance.now();
function pdppQueueCalibrationInit() {
  if (pdppCalibrationInitPending) return;
  pdppCalibrationInitPending = true;
  const since = performance.now() - pdppLastCalibrationInitAt;
  const wait = since >= 100 ? 0 : 100 - since;
  setTimeout(() => {
    pdppCalibrationInitPending = false;
    pdppLastCalibrationInitAt = performance.now();
    pdppEmitCalibrationInit();
  }, wait);
}
window.addEventListener('resize', pdppQueueCalibrationInit, { passive: true });
if (window.visualViewport && typeof window.visualViewport.addEventListener === 'function') {
  window.visualViewport.addEventListener('resize', pdppQueueCalibrationInit, { passive: true });
  // visualViewport scroll fires when the soft keyboard shifts the
  // visible region; beacons are position:fixed against visualViewport
  // and their absolute coords change accordingly.
  window.visualViewport.addEventListener('scroll', pdppQueueCalibrationInit, { passive: true });
}
window.addEventListener('orientationchange', pdppQueueCalibrationInit, { passive: true });
window.addEventListener('pointerdown', (e) => pdppRecordPlaygroundEvent('pointerdown', pdppPointerExtras(e)), { capture: true, passive: true });
window.addEventListener('pointerup', (e) => pdppRecordPlaygroundEvent('pointerup', pdppPointerExtras(e)), { capture: true, passive: true });
window.addEventListener('click', (e) => pdppRecordPlaygroundEvent('click', pdppPointerExtras(e)), { capture: true, passive: true });
window.addEventListener('focusin', (e) => pdppRecordPlaygroundEvent('focusin', { target: pdppSummariseElement(e.target) }), { capture: true, passive: true });
window.addEventListener('focusout', (e) => pdppRecordPlaygroundEvent('focusout', { target: pdppSummariseElement(e.target) }), { capture: true, passive: true });
let pdppLastScrollAt = 0;
window.addEventListener('scroll', () => {
  const now = performance.now();
  if (now - pdppLastScrollAt < 100) return;
  pdppLastScrollAt = now;
  pdppRecordPlaygroundEvent('scroll', null);
}, { passive: true });
counter.addEventListener('click', (event) => {
  count++;
  counter.textContent = 'Click me (count: ' + count + ')';
  logEvent('click at (' + event.clientX + ', ' + event.clientY + ')');
  // Mirror the canonical click-count into telemetry so the operator can
  // see exactly when (and how many times) the streamed button observed a
  // click. Diagnoses "tap once, counter increments twice" by exposing the
  // remote ground truth alongside the wire dispatch log.
  pdppRecordPlaygroundEvent('counter_click', {
    count: count,
    clientX: event.clientX,
    clientY: event.clientY,
  });
});
input.addEventListener('keydown', (e) => logEvent('keydown: ' + e.key));
input.addEventListener('beforeinput', (e) => logEvent('beforeinput: ' + e.inputType + (e.data ? ' "' + e.data + '"' : '')));
input.addEventListener('input', (event) => {
  logEvent('text now: "' + input.value + '"');
  pdppRecordPlaygroundEvent('input', {
    inputType: event.inputType || null,
    smokeTokenPresent: /pdpp-smoke-[a-z0-9-]+/.test(input.value),
    target: pdppSummariseElement(input),
    valueLength: input.value.length,
  });
});
window.addEventListener('scroll', () => logEvent('page scrollY=' + Math.round(window.scrollY)), { passive: true });
window.addEventListener('wheel', (e) => logEvent('wheel deltaY=' + e.deltaY), { passive: true });
window.addEventListener('touchstart', (e) => logEvent('touchstart (' + e.touches.length + ' touches)'), { passive: true });
window.addEventListener('paste', (e) => logEvent('paste: "' + e.clipboardData.getData('text') + '"'));
</script>
</main></body></html>`;

function isDebugEnabled(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'stream' || raw === 'neko';
}

function buildTestPageHtml({ debug = false } = {}) {
  if (debug) return TEST_PAGE_HTML;
  return TEST_PAGE_HTML.replace(CALIBRATION_BEACON_HTML, '');
}

function buildTestPageUrl(options = {}) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(buildTestPageHtml(options))}`;
}

/**
 * Module-level singleton state. The first caller wins the launch race; all
 * concurrent callers await the same in-flight promise. Subsequent calls
 * return the cached CDP session unchanged. CDP owns a Patchright page, so
 * reuse avoids relaunching a browser. n.eko sessions are different: they are
 * lightweight synthetic stream targets pointed at the same n.eko browser, so a
 * fresh page load should get a fresh run/interaction pair instead of reusing a
 * possibly wedged WebRTC client session.
 *
 * The patchright `release` callback is held in `cleanupBrowser` so the
 * `process.on('exit')` shutdown hook can tear it down. We don't await the
 * close on exit — Node's exit handlers are synchronous.
 */
const inFlights = new Map();
// cachedSessions: keyed by backend name, holds the session to REUSE on the
// next call. `neko` deliberately never appears here — see
// getOrCreatePlaygroundSession for the rationale.
const cachedSessions = new Map();
// activeSessions: every minted session lives here, keyed by runId, so the
// controller shim can resolve `getPendingInteraction(runId)` for ANY
// playground session regardless of whether its backend caches for reuse.
// This is the source of truth for "does this runId belong to a playground
// session?" — separated from cachedSessions so the cache-reuse policy is
// orthogonal to the runId-resolution policy.
const activeSessions = new Map();
let cleanupBrowser = null;
let exitHookRegistered = false;
let controllerShimInstalled = false;

/**
 * Build the playground accessor bound to the caller-supplied dependencies.
 *
 * The reference server passes:
 *   - `runTargetRegistry`     — to register the wsUrl under (runId, interactionId)
 *   - `controller`            — to monkey-patch getPendingInteraction so the
 *                                streaming mint route accepts the synthetic runId
 *   - `logger`                — pino-style; optional
 *
 * Returns `{ getOrCreatePlaygroundSession }`. Wiring this through a factory
 * (rather than module-globals) keeps the test seam clean and avoids circular
 * imports — `playground.js` does not need to import `index.js`.
 */
export function createPlayground({ runTargetRegistry, controller, logger = null, env = process.env } = {}) {
  if (!runTargetRegistry || typeof runTargetRegistry.register !== 'function') {
    throw new Error('createPlayground: runTargetRegistry with .register() is required');
  }
  if (!controller || typeof controller.getPendingInteraction !== 'function') {
    throw new Error('createPlayground: controller with .getPendingInteraction() is required');
  }

  function log(level, msg, data) {
    if (!logger || typeof logger[level] !== 'function') return;
    try {
      logger[level]({ msg, ...(data || {}) });
    } catch {
      /* logger errors must not break the playground path */
    }
  }

  function normalizeBackend(value) {
    const raw = String(value || env.PDPP_STREAM_PLAYGROUND_BACKEND || DEFAULT_PLAYGROUND_BACKEND)
      .trim()
      .toLowerCase();
    if (raw === 'cdp' || raw === 'neko' || raw === 'neko-remote-cdp') return raw;
    const err = new Error('playground backend must be "cdp", "neko", or "neko-remote-cdp"');
    err.code = 'invalid_playground_backend';
    throw err;
  }

  function resolveNekoBaseUrl() {
    return String(
      env.PDPP_STREAM_PLAYGROUND_NEKO_BASE_URL ||
        env.PDPP_NEKO_BASE_URL ||
        env.NEKO_ORIGIN ||
        (env.PDPP_STREAM_PLAYGROUND_DOCKER === '1' ? DEFAULT_DOCKER_NEKO_BASE_URL : DEFAULT_NEKO_BASE_URL),
    ).trim();
  }

  function resolveNekoCdpHttpUrl(baseUrl) {
    const configured = String(
      env.PDPP_STREAM_PLAYGROUND_NEKO_CDP_HTTP_URL ||
        env.PDPP_NEKO_CDP_HTTP_URL ||
        env.NEKO_CDP_HTTP_URL ||
        env.NEKO_CDP_ORIGIN ||
        '',
    ).trim();
    if (configured) return configured;
    try {
      const parsed = new URL(baseUrl || resolveNekoBaseUrl());
      if (parsed.hostname === 'neko') return 'http://neko:9223/';
      if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') {
        return `${parsed.protocol}//${parsed.hostname}:9223/`;
      }
    } catch {
      /* fall through: no safe inferred CDP URL */
    }
    return null;
  }

  // Monotonic counter to ensure each call to makeIds() produces a unique
  // suffix, even when called twice in the same Date.now() millisecond.
  // Date.now() millisecond resolution is the source of the previous
  // intermittent test flake — two `getOrCreatePlaygroundSession({backend:'neko'})`
  // calls in quick succession could mint identical runIds, which then
  // collided in activeSessions and the run-target registry, producing
  // assertions that compared two structurally-equal-but-not-identical
  // objects (notStrictEqual on the same runId string).
  let makeIdsCounter = 0;
  function makeIds(backend) {
    const ts = Date.now();
    const seq = ++makeIdsCounter;
    const suffix = backend === 'neko' ? `neko_${ts}_${seq}` : `${ts}_${seq}`;
    return {
      runId: `playground_${suffix}`,
      interactionId: `int_playground_${suffix}`,
    };
  }

  function getCachedSessionForRunId(runId) {
    // Source of truth is `activeSessions` (runId → session). This includes
    // backends that opt out of cache-for-reuse (currently `neko`). The
    // controller shim relies on this to resolve any playground runId.
    return activeSessions.get(runId) ?? null;
  }

  /**
   * Install the Patchright binding that lets the streamed test page push
   * remote-DOM events back to the reference process. Best-effort — failure
   * never blocks playground startup; we just lose Layer-D telemetry.
   *
   * The binding callback receives the raw payload object the page passed.
   * We forward it to the per-runId remote-telemetry registry; routes.js
   * subscribes when the companion is created.
   */
  async function installRemoteTelemetryBinding(page, runId) {
    try {
      await page.exposeBinding('__pdppRemoteTelemetry', (_source, payload) => {
        try {
          emitRemoteTelemetry(runId, payload);
        } catch {
          /* never throw back into the page binding */
        }
      });
      log('info', 'playground_remote_telemetry_binding_ready', { runId });
    } catch (err) {
      log('warn', 'playground_remote_telemetry_binding_failed', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function registerPlaygroundTarget(session) {
    const startUrl = buildTestPageUrl({ debug: session.debugCalibration === true });
    if (session.backend === 'neko') {
      const baseUrl = session.baseUrl || resolveNekoBaseUrl();
      const cdpHttpUrl = session.cdpHttpUrl || resolveNekoCdpHttpUrl(baseUrl);
      runTargetRegistry.register({
        runId: session.runId,
        interactionId: session.interactionId,
        backend: 'neko',
        base_url: baseUrl,
        ...(cdpHttpUrl ? { cdp_http_url: cdpHttpUrl } : {}),
        start_url: startUrl,
        deviceId: PLAYGROUND_DEVICE_ID,
        pageUrl: 'neko:playground',
        pageTitle: 'n.eko Stream Playground',
        reason: 'manual_action',
      });
      session.baseUrl = baseUrl;
      session.cdpHttpUrl = cdpHttpUrl;
      return session;
    }

    if ((session.backend === 'cdp' || session.backend === 'neko-remote-cdp') && session.wsUrl) {
      runTargetRegistry.register({
        runId: session.runId,
        interactionId: session.interactionId,
        wsUrl: session.wsUrl,
        deviceId: PLAYGROUND_DEVICE_ID,
        pageUrl: 'data:text/html,playground',
        pageTitle: 'Stream Playground',
        reason: 'manual_action',
      });
    }
    return session;
  }

  /**
   * Wrap controller.getPendingInteraction so the standard streaming-mint
   * route (`POST /_ref/runs/:runId/run-interaction-stream`) accepts the
   * synthetic playground runId as if a real connector were awaiting a
   * manual_action. For any non-playground runId we delegate to the
   * original function — the shim is purely additive and idempotent.
   *
   * Installed once per process. Re-entrant calls (same shim installed twice)
   * would create an infinite delegation loop; the `controllerShimInstalled`
   * flag prevents that.
   */
  function installControllerShim() {
    if (controllerShimInstalled) return;
    controllerShimInstalled = true;
    const original = controller.getPendingInteraction.bind(controller);
    controller.getPendingInteraction = function getPendingInteractionWithPlayground(runId) {
      const session = getCachedSessionForRunId(runId);
      if (session) {
        return {
          run_id: session.runId,
          connector_id: 'playground:dev',
          interaction_id: session.interactionId,
          kind: 'manual_action',
          stream: null,
        };
      }
      return original(runId);
    };
  }

  function registerExitHook() {
    if (exitHookRegistered) return;
    exitHookRegistered = true;
    // `exit` is synchronous; we kick off the close but do not await. The
    // OS will reap the patchright child either way once Node exits.
    const tearDown = () => {
      if (cleanupBrowser) {
        try {
          Promise.resolve(cleanupBrowser()).catch(() => {
            /* best-effort */
          });
        } catch {
          /* best-effort */
        }
        cleanupBrowser = null;
      }
    };
    process.once('exit', tearDown);
    process.once('SIGINT', tearDown);
    process.once('SIGTERM', tearDown);
  }

  /**
   * Idempotent accessor. Lazy-launches on first call and reuses the same
   * browser/page across subsequent calls. Returns `{ runId, interactionId }`.
   * Throws on launch / navigation failure — the page-side fetch will surface
   * that to the developer as a server-side error in dev.
   */
  async function createCdpPlaygroundSession({ debugCalibration = false } = {}) {
    // Dynamic import: keeps patchright off the cold-start path for
    // production builds that never instantiate the playground. The two
    // imports follow the same conventions as the connector runtime.
    const { acquireIsolatedBrowser } = await import(
      '../../../packages/polyfill-connectors/src/browser-launch.ts'
    );
    const { resolveWsUrlForExactPage } = await import(
      '../../../packages/polyfill-connectors/src/browser-handoff.ts'
    );

    log('info', 'playground_launching');
    const isolated = await acquireIsolatedBrowser({
      profileName: PROFILE_NAME,
      // Headless is correct: the developer sees the page through the
      // streamed dashboard surface, not directly. A headed Chromium would
      // pop a window the developer doesn't need and would also fail the
      // in-container fail-closed gate when the reference server runs in
      // Docker.
      headless: true,
      streamingEnabled: true,
    });
    cleanupBrowser = isolated.release;
    registerExitHook();

    // Reuse the first page that patchright auto-opens; patchright always
    // gives us at least one page on launchPersistentContext.
    const pages = isolated.context.pages();
    const page = pages.length > 0 ? pages[0] : await isolated.context.newPage();
    // Allocate the runId early so we can install the Layer-D telemetry
    // binding BEFORE goto — that way the page's inline <script> sees the
    // global `__pdppRemoteTelemetry` at first execution. We thread the
    // same id through to `registerPlaygroundTarget` below.
    const cdpIds = makeIds('cdp');
    await installRemoteTelemetryBinding(page, cdpIds.runId);
    try {
      await page.goto(buildTestPageUrl({ debug: debugCalibration }), { waitUntil: 'load', timeout: 15_000 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log('warn', 'playground_navigation_failed', { error: message });
      // Surface to the caller; the page-load helper will present the error.
      await isolated.release().catch(() => {
        /* best-effort */
      });
      cleanupBrowser = null;
      throw err;
    }

    // Pull the CDP host:port the launcher published into env vars. The
    // launcher writes them after a successful `streamingEnabled: true`
    // launch (see browser-launch.ts publishCdpEndpointToEnv).
    const host = process.env.PDPP_BROWSER_CDP_HOST?.trim();
    const portRaw = process.env.PDPP_BROWSER_CDP_PORT?.trim();
    if (!(host && portRaw)) {
      await isolated.release().catch(() => {
        /* best-effort */
      });
      cleanupBrowser = null;
      throw new Error(
        'playground: launcher did not publish PDPP_BROWSER_CDP_HOST/PDPP_BROWSER_CDP_PORT; cannot resolve wsUrl',
      );
    }
    const port = Number.parseInt(portRaw, 10);
    if (!(Number.isFinite(port) && port > 0)) {
      await isolated.release().catch(() => {
        /* best-effort */
      });
      cleanupBrowser = null;
      throw new Error(`playground: invalid PDPP_BROWSER_CDP_PORT: ${portRaw}`);
    }

    const wsUrl = await resolveWsUrlForExactPage(page, { host, port });

    const { runId, interactionId } = cdpIds;

    // Register directly against the in-process registry. We're inside the
    // same Node process — there is no boundary to cross via HTTP, and the
    // synthetic deviceId never collides with a real device-exporter id.
    // pageUrl is the short literal `data:text/html` instead of the full
    // encoded HTML (which is multi-KB) — the registry surfaces this on
    // debug paths only, so a label is more useful than the full payload.
    const session = registerPlaygroundTarget({ backend: 'cdp', debugCalibration, runId, interactionId, wsUrl });
    installControllerShim();

    log('info', 'playground_ready', { runId, interactionId });
    return session;
  }

  async function createNekoPlaygroundSession({ debugCalibration = false } = {}) {
    const baseUrl = resolveNekoBaseUrl();
    const { runId, interactionId } = makeIds('neko');

    const session = registerPlaygroundTarget({ backend: 'neko', debugCalibration, runId, interactionId, baseUrl });
    installControllerShim();

    log('info', 'playground_ready', { backend: 'neko', runId, interactionId });
    return session;
  }

  /**
   * Test-bench equivalent of the chatgpt connector's browser path.
   *
   * Exercises EXACTLY the production code path that human-in-the-loop
   * connectors use when `PDPP_<CONNECTOR>_REMOTE_CDP_URL` is set:
   *
   *   1. `acquireBrowserForConnector({ remoteCdpUrl: "http://neko:9223" })`
   *      → `chromium.connectOverCDP(...)` against neko's Patchright Chromium.
   *      This publishes `PDPP_BROWSER_CDP_HOST`/`PORT` into process.env.
   *   2. `context.newPage()` + `page.goto(buildTestPageUrl())` — gives us a
   *      navigated page in the neko-displayed browser, same way the
   *      chatgpt connector navigates to chatgpt.com.
   *   3. `resolveWsUrlForExactPage(page, { host, port })` — composes
   *      `ws://neko:9223/devtools/page/${targetId}` using the same code
   *      `browser-handoff.ts` uses to register handoffs.
   *   4. Register with the in-process run-target registry (NOT via the
   *      HTTP `PUT /admin/...` route — we're in-process — but the registry
   *      record is identical to what an HTTP register would produce).
   *
   * If this backend reproduces `companion_start_failed` we'll have an
   * isolated repro for the bug we hit on the chatgpt manual_action flow,
   * with no Cloudflare, no real auth state, no out-of-band 2FA, and a
   * known data: URL test fixture to interact with.
   *
   * If this backend WORKS — you see the page, click in it, see the click
   * land — then the chatgpt streaming failure was something specific to
   * that interaction's lifecycle, not the architecture itself.
   */
  async function createNekoRemoteCdpPlaygroundSession({ debugCalibration = false } = {}) {
    const remoteCdpUrl = String(
      env.PDPP_STREAM_PLAYGROUND_NEKO_CDP_HTTP_URL || env.PDPP_NEKO_CDP_HTTP_URL || 'http://neko:9223',
    ).trim();
    const { acquireBrowserForConnector } = await import(
      '../../../packages/polyfill-connectors/src/browser-launch.ts'
    );
    const { resolveWsUrlForExactPage } = await import(
      '../../../packages/polyfill-connectors/src/browser-handoff.ts'
    );

    log('info', 'playground_launching', { backend: 'neko-remote-cdp', remoteCdpUrl });
    const isolated = await acquireBrowserForConnector({
      profileName: PROFILE_NAME,
      // headless flag is meaningless for remoteCdpUrl — the binary is
      // already running on neko's X server — but pass `true` so the
      // in-container fail-closed gate is satisfied for any path that
      // re-checks it.
      headless: true,
      streamingEnabled: true,
      remoteCdpUrl,
    });
    // Remote-CDP release ONLY disconnects the Patchright client; it does
    // not close the remote browser. Still register for process-exit
    // cleanup so we don't leak sockets on a hot-reload restart.
    cleanupBrowser = isolated.release;
    registerExitHook();

    // Open a fresh page so init scripts (if any) arm before navigation.
    // Reusing pre-existing pages would skip Patchright's route-based
    // injection — see docs/patchright-integration-spec.md §4c.
    const page = await isolated.context.newPage();
    // Allocate the runId early so the Layer-D remote-telemetry binding is
    // installed BEFORE goto. The streamed test page's inline <script>
    // calls `window.__pdppRemoteTelemetry(payload)` if present; if the
    // binding install fails we just lose Layer-D telemetry.
    const neRemoteCdpIds = makeIds('neko_remote_cdp');
    await installRemoteTelemetryBinding(page, neRemoteCdpIds.runId);
    try {
      await page.goto(buildTestPageUrl({ debug: debugCalibration }), { waitUntil: 'load', timeout: 15_000 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log('warn', 'playground_navigation_failed', { error: message });
      await page.close().catch(() => {
        /* best-effort */
      });
      await isolated.release().catch(() => {
        /* best-effort */
      });
      cleanupBrowser = null;
      throw err;
    }

    // `acquireBrowserForConnector` published these into process.env as
    // part of its remote-CDP-attach path. They're the host:port the
    // streaming companion will dial back through (cdp-proxy.py).
    const host = process.env.PDPP_BROWSER_CDP_HOST?.trim();
    const portRaw = process.env.PDPP_BROWSER_CDP_PORT?.trim();
    if (!(host && portRaw)) {
      await page.close().catch(() => {
        /* best-effort */
      });
      await isolated.release().catch(() => {
        /* best-effort */
      });
      cleanupBrowser = null;
      throw new Error(
        'playground neko-remote-cdp: launcher did not publish PDPP_BROWSER_CDP_HOST/PORT; cannot resolve wsUrl',
      );
    }
    const port = Number.parseInt(portRaw, 10);
    if (!(Number.isFinite(port) && port > 0)) {
      await page.close().catch(() => {});
      await isolated.release().catch(() => {});
      cleanupBrowser = null;
      throw new Error(`playground neko-remote-cdp: invalid PDPP_BROWSER_CDP_PORT: ${portRaw}`);
    }

    const wsUrl = await resolveWsUrlForExactPage(page, { host, port });
    const { runId, interactionId } = neRemoteCdpIds;

    const session = registerPlaygroundTarget({
      backend: 'neko-remote-cdp',
      debugCalibration,
      runId,
      interactionId,
      wsUrl,
    });
    installControllerShim();

    log('info', 'playground_ready', { backend: 'neko-remote-cdp', runId, interactionId, wsUrl });
    return session;
  }

  async function getOrCreatePlaygroundSession(options = {}) {
    const backend = normalizeBackend(options.backend);
    const debugCalibration = isDebugEnabled(options.streamDebug ?? options.debug ?? env.PDPP_STREAM_PLAYGROUND_DEBUG);
    // n.eko-backed sessions are never cached: the runId is per-call so
    // the run-target registry's lifetime/eviction semantics match what a
    // real connector run would experience. The local-CDP and
    // neko-remote-cdp sessions own a browser and reuse it (caching by
    // backend so consecutive playground pageloads attach to the same
    // long-lived Chromium instead of re-launching).
    //
    // Symmetric keying invariant: read and write MUST use the same key
    // for a given backend, otherwise cache entries leak (write-only) or
    // are unreachable (read-only). For `neko` we intentionally skip both
    // sides — see prior incident in run-interaction-stream-playground
    // test where the previous asymmetric keying (write by runId, read by
    // backend) caused a stale entry to be returned only when two
    // sequential calls landed in the same Date.now() millisecond.
    const isCacheable = backend !== 'neko';
    const cached = isCacheable ? cachedSessions.get(backend) : null;
    if (cached) {
      cached.debugCalibration = debugCalibration;
      return registerPlaygroundTarget(cached);
    }
    const existing = inFlights.get(backend);
    if (existing) return existing;

    let factory;
    if (backend === 'neko') {
      factory = createNekoPlaygroundSession;
    } else if (backend === 'neko-remote-cdp') {
      factory = createNekoRemoteCdpPlaygroundSession;
    } else {
      factory = createCdpPlaygroundSession;
    }
    const promise = factory({ debugCalibration });
    inFlights.set(backend, promise);
    try {
      const session = await promise;
      // Every minted session is discoverable by runId via activeSessions,
      // regardless of whether its backend caches for reuse. This separation
      // ensures the controller shim can resolve any playground runId — the
      // earlier code conflated cache-reuse and runId-resolution into one
      // map and produced unreachable entries for `neko`.
      session.debugCalibration = debugCalibration;
      activeSessions.set(session.runId, session);
      if (isCacheable) {
        cachedSessions.set(backend, session);
      }
      return session;
    } finally {
      inFlights.delete(backend);
    }
  }

  return { getOrCreatePlaygroundSession };
}
