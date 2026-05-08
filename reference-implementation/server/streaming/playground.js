/**
 * Stream playground (dev-only).
 *
 * Exposes `getOrCreatePlaygroundSession`, which mints a synthetic
 * (runId, interactionId) pair, registers a CDP or n.eko streaming target with
 * the run-target registry, and shims `getPendingInteraction(runId)` so the
 * standard streaming-mint route accepts the playground runId as if a real
 * connector were awaiting a manual_action.
 *
 * The point: a developer can open `/dashboard/stream-playground` in the web
 * app, see the real <StreamSurface> backed by CDP or n.eko, and exercise
 * browser interaction without wiring up a connector run.
 *
 * NOT for production: the helper bypasses the connector lifecycle, mints
 * tokens that authorize CDP input on a long-lived page, and never expires the
 * underlying browser. Callers MUST gate on `process.env.NODE_ENV !== "production"`
 * before invoking.
 */

const PROFILE_NAME = 'stream-playground';
const DEFAULT_PLAYGROUND_BACKEND = 'cdp';
const DEFAULT_NEKO_BASE_URL = 'http://127.0.0.1:8080/neko';
// One device-id constant, used both when registering the wsUrl with the
// run-target registry and when minting future runIds. Synthetic — does not
// collide with real device-exporter ids (those have a uuid-style prefix).
const PLAYGROUND_DEVICE_ID = 'playground:dev';
const TEST_PAGE_HTML = `<!doctype html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<style>
:root { color-scheme: light; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
* { box-sizing: border-box; }
html { min-height: 100%; }
body { margin: 0; min-height: 100dvh; overflow-y: auto; overscroll-behavior-y: contain; background: #f7f5ef; color: #181713; -webkit-overflow-scrolling: touch; }
main { display: grid; gap: 14px; width: min(100%, 760px); margin: 0 auto; padding: clamp(16px, 5vw, 40px); padding-bottom: calc(clamp(16px, 5vw, 40px) + env(safe-area-inset-bottom)); }
h1 { margin: 0; font-size: clamp(30px, 11vw, 44px); line-height: 0.95; letter-spacing: -0.045em; }
p { margin: 0; color: #5e584c; font-size: 15px; line-height: 1.35; }
button, input { width: 100%; min-height: 48px; border: 1px solid #797266; border-radius: 10px; background: #fffdf7; color: #181713; font: inherit; font-size: 18px; }
button { padding: 12px 16px; text-align: left; font-weight: 650; }
input { padding: 12px 14px; }
#event-log { min-height: 220px; max-height: min(42dvh, 320px); overflow: auto; overscroll-behavior: auto; border-radius: 10px; background: #ebe8df; padding: 10px; font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; font-size: 13px; line-height: 1.35; white-space: pre-wrap; overflow-wrap: anywhere; }
#scroll-probe { display: grid; gap: 10px; min-height: 44dvh; border-radius: 14px; background: #fffaf0; padding: 14px; border: 1px solid #d8d0c0; }
.probe-card { border-radius: 10px; background: #ebe8df; padding: 12px; color: #373126; }
.probe-card strong { display: block; margin-bottom: 4px; color: #181713; }
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
</head><body><main>
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
counter.addEventListener('click', (event) => {
  count++;
  counter.textContent = 'Click me (count: ' + count + ')';
  logEvent('click at (' + event.clientX + ', ' + event.clientY + ')');
});
input.addEventListener('keydown', (e) => logEvent('keydown: ' + e.key));
input.addEventListener('beforeinput', (e) => logEvent('beforeinput: ' + e.inputType + (e.data ? ' "' + e.data + '"' : '')));
input.addEventListener('input', () => logEvent('text now: "' + input.value + '"'));
window.addEventListener('scroll', () => logEvent('page scrollY=' + Math.round(window.scrollY)), { passive: true });
window.addEventListener('wheel', (e) => logEvent('wheel deltaY=' + e.deltaY), { passive: true });
window.addEventListener('touchstart', (e) => logEvent('touchstart (' + e.touches.length + ' touches)'), { passive: true });
window.addEventListener('paste', (e) => logEvent('paste: "' + e.clipboardData.getData('text') + '"'));
</script>
</main></body></html>`;

const TEST_PAGE_URL = `data:text/html;charset=utf-8,${encodeURIComponent(TEST_PAGE_HTML)}`;

/**
 * Module-level singleton state. The first caller wins the launch race; all
 * concurrent callers await the same in-flight promise. Subsequent calls
 * return the cached session unchanged. We deliberately do NOT expire the
 * session on TTL — a developer poking the dashboard might come back to it
 * 30 minutes later and would expect the stream to still work; reaching back
 * out to relaunch a browser would surprise them.
 *
 * The patchright `release` callback is held in `cleanupBrowser` so the
 * `process.on('exit')` shutdown hook can tear it down. We don't await the
 * close on exit — Node's exit handlers are synchronous.
 */
const inFlights = new Map();
const cachedSessions = new Map();
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
    if (raw === 'cdp' || raw === 'neko') return raw;
    const err = new Error('playground backend must be "cdp" or "neko"');
    err.code = 'invalid_playground_backend';
    throw err;
  }

  function resolveNekoBaseUrl() {
    return String(env.PDPP_NEKO_BASE_URL || env.NEKO_ORIGIN || DEFAULT_NEKO_BASE_URL).trim();
  }

  function makeIds(backend) {
    const ts = Date.now();
    const suffix = backend === 'neko' ? `neko_${ts}` : `${ts}`;
    return {
      runId: `playground_${suffix}`,
      interactionId: `int_playground_${suffix}`,
    };
  }

  function getCachedSessionForRunId(runId) {
    for (const session of cachedSessions.values()) {
      if (session.runId === runId) return session;
    }
    return null;
  }

  function registerPlaygroundTarget(session) {
    if (session.backend === 'neko') {
      const baseUrl = session.baseUrl || resolveNekoBaseUrl();
      runTargetRegistry.register({
        runId: session.runId,
        interactionId: session.interactionId,
        backend: 'neko',
        base_url: baseUrl,
        start_url: TEST_PAGE_URL,
        deviceId: PLAYGROUND_DEVICE_ID,
        pageUrl: 'neko:playground',
        pageTitle: 'n.eko Stream Playground',
        reason: 'manual_action',
      });
      session.baseUrl = baseUrl;
      return session;
    }

    if (session.backend === 'cdp' && session.wsUrl) {
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
  async function createCdpPlaygroundSession() {
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
    try {
      await page.goto(TEST_PAGE_URL, { waitUntil: 'load', timeout: 15_000 });
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

    const { runId, interactionId } = makeIds('cdp');

    // Register directly against the in-process registry. We're inside the
    // same Node process — there is no boundary to cross via HTTP, and the
    // synthetic deviceId never collides with a real device-exporter id.
    // pageUrl is the short literal `data:text/html` instead of the full
    // encoded HTML (which is multi-KB) — the registry surfaces this on
    // debug paths only, so a label is more useful than the full payload.
    const session = registerPlaygroundTarget({ backend: 'cdp', runId, interactionId, wsUrl });
    installControllerShim();

    log('info', 'playground_ready', { runId, interactionId });
    return session;
  }

  async function createNekoPlaygroundSession() {
    const baseUrl = resolveNekoBaseUrl();
    const { runId, interactionId } = makeIds('neko');

    const session = registerPlaygroundTarget({ backend: 'neko', runId, interactionId, baseUrl });
    installControllerShim();

    log('info', 'playground_ready', { backend: 'neko', runId, interactionId });
    return session;
  }

  async function getOrCreatePlaygroundSession(options = {}) {
    const backend = normalizeBackend(options.backend);
    const cached = cachedSessions.get(backend);
    if (cached) return registerPlaygroundTarget(cached);
    const existing = inFlights.get(backend);
    if (existing) return existing;

    const promise =
      backend === 'neko' ? createNekoPlaygroundSession() : createCdpPlaygroundSession();
    inFlights.set(backend, promise);
    try {
      const session = await promise;
      cachedSessions.set(backend, session);
      return session;
    } finally {
      inFlights.delete(backend);
    }
  }

  return { getOrCreatePlaygroundSession };
}
