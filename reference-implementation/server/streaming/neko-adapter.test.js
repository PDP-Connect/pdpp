import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createNekoCompanion } from './neko-adapter.js';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}

function frameResponse() {
  return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
}

function createFetchMock({ screenConfigurations = [{ width: 2128, height: 816, rate: 30 }] } = {}) {
  const requests = [];
  const fetchImpl = async (url, request = {}) => {
    requests.push({ body: request.body || null, method: request.method || 'GET', url });
    if (url.endsWith('/json')) {
      return jsonResponse([
        {
          id: 'page-1',
          type: 'page',
          url: 'about:blank',
          webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/page-1',
        },
      ]);
    }
    if (url.endsWith('/json/version')) {
      return jsonResponse({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/browser-1' });
    }
    if (url.endsWith('/api/room/screen/configurations')) {
      return jsonResponse(screenConfigurations);
    }
    if (url.endsWith('/api/room/screen') && request.method === 'POST') {
      return jsonResponse(JSON.parse(request.body));
    }
    if (url.endsWith('/api/room/screen') && request.method === 'GET') {
      return jsonResponse({ width: 2128, height: 816 });
    }
    if (url.endsWith('/api/room/screen/cast.jpg') || url.endsWith('/api/room/screen/shot.jpg')) {
      return frameResponse();
    }
    return jsonResponse({});
  };
  fetchImpl.requests = requests;
  return fetchImpl;
}

function createWebSocketMock({ runtimeStatuses = [] } = {}) {
  const commands = [];

  class MockWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.listeners = new Map();
      setImmediate(() => {
        this.readyState = 1;
        this.emit('open', {});
      });
    }

    addEventListener(name, handler) {
      const listeners = this.listeners.get(name) || [];
      listeners.push(handler);
      this.listeners.set(name, listeners);
    }

    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.emit('close', {});
    }

    emit(name, event) {
      for (const handler of this.listeners.get(name) || []) handler(event);
    }

    send(raw) {
      const message = JSON.parse(raw);
      commands.push({ method: message.method, params: message.params || {}, sessionId: message.sessionId || null });
      const result = this.resultFor(message.method, message.params || {});
      setImmediate(() => {
        if (this.readyState === 1) {
          this.emit('message', { data: JSON.stringify({ id: message.id, result }) });
        }
      });
    }

    resultFor(method, params) {
      if (method === 'Target.attachToTarget') return { sessionId: `session-${commands.length}` };
      if (method === 'Browser.getWindowForTarget') return { windowId: 7 };
      const expression = String(params.expression || '');
      // The viewport-status expression is a self-invoking IIFE that
      // returns a JSON string. It started life as
      //   `(() => JSON.stringify({ ... }))()`
      // and was later extended to drain `__pdppPlaygroundEvents`:
      //   `(() => { const drained = ...; return JSON.stringify({ ... }); })()`
      // Match either shape via a stable identifier (`screenWidth`) plus
      // `JSON.stringify` — that combination uniquely identifies the
      // viewport-status expression and avoids accidentally swallowing
      // the focus-detection script (which also stringifies but does
      // NOT mention `screenWidth`).
      const looksLikeViewportStatus =
        method === 'Runtime.evaluate' &&
        expression.includes('JSON.stringify') &&
        expression.includes('screenWidth');
      if (looksLikeViewportStatus) {
        const next = runtimeStatuses.length > 0 ? runtimeStatuses.shift() : {};
        return { result: { value: JSON.stringify(next) } };
      }
      return {};
    }
  }

  MockWebSocket.commands = commands;
  return MockWebSocket;
}

function abortableSleep(_ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    signal?.addEventListener('abort', resolve, { once: true });
  });
}

const landscapeViewport = {
  width: 947,
  height: 364,
  deviceScaleFactor: 2.25,
  hasTouch: true,
  mobile: true,
  screenWidth: 2128,
  screenHeight: 816,
  userAgent: 'Mobile Test UA',
};

test('n.eko start reapplies page CDP viewport after initial navigation', async () => {
  const fetchImpl = createFetchMock();
  const WebSocketCtor = createWebSocketMock();
  const companion = createNekoCompanion({
    origin: 'http://neko.local/',
    cdpHttpUrl: 'http://cdp.local/',
    fetchImpl,
    WebSocketCtor,
    startUrl: 'https://example.test/',
    screenEndpoint: 'api/room/screen',
    screenConfigurationsEndpoint: 'api/room/screen/configurations',
    sleep: abortableSleep,
    stealthMode: 'balanced',
  });

  await companion.start(landscapeViewport);
  await companion.stop();

  const methods = WebSocketCtor.commands.map((command) => command.method);
  const navigateIndex = methods.indexOf('Page.navigate');
  const metricIndexes = methods
    .map((method, index) => (method === 'Emulation.setDeviceMetricsOverride' ? index : -1))
    .filter((index) => index >= 0);

  assert.equal(metricIndexes.length, 2);
  assert.ok(metricIndexes[0] < navigateIndex);
  assert.ok(navigateIndex < metricIndexes[1]);
  assert.deepEqual(WebSocketCtor.commands[metricIndexes[1]].params, {
    width: 947,
    height: 364,
    deviceScaleFactor: 2.25,
    mobile: true,
    screenWidth: 2128,
    screenHeight: 816,
    positionX: 0,
    positionY: 0,
    screenOrientation: { type: 'landscapePrimary', angle: 90 },
    viewport: { x: 0, y: 0, width: 2128, height: 816, scale: 1 },
  });
});

test('n.eko high-DPR CDP viewport exposes the full captured surface', async () => {
  const fetchImpl = createFetchMock({ screenConfigurations: [{ width: 1008, height: 1736, rate: 30 }] });
  const WebSocketCtor = createWebSocketMock();
  const companion = createNekoCompanion({
    origin: 'http://neko.local/',
    cdpHttpUrl: 'http://cdp.local/',
    fetchImpl,
    WebSocketCtor,
    screenEndpoint: 'api/room/screen',
    screenConfigurationsEndpoint: 'api/room/screen/configurations',
    sleep: abortableSleep,
    stealthMode: 'balanced',
  });

  await companion.start({
    width: 448,
    height: 771,
    deviceScaleFactor: 2.25,
    hasTouch: true,
    mobile: true,
    screenWidth: 1008,
    screenHeight: 1736,
    userAgent: 'Mobile Test UA',
  });
  await companion.stop();

  const metrics = WebSocketCtor.commands.find((command) => command.method === 'Emulation.setDeviceMetricsOverride');
  assert.deepEqual(metrics.params.viewport, { x: 0, y: 0, width: 1008, height: 1736, scale: 1 });
  assert.equal(metrics.params.width, 448);
  assert.equal(metrics.params.height, 771);
  assert.equal(metrics.params.deviceScaleFactor, 2.25);
  assert.equal('scale' in metrics.params, false);

  assert.ok(
    WebSocketCtor.commands.some(
      (command) =>
        command.method === 'Emulation.setTouchEmulationEnabled' &&
        command.params.enabled === true &&
        command.params.maxTouchPoints === 5,
    ),
  );
  assert.ok(
    WebSocketCtor.commands.some(
      (command) =>
        command.method === 'Emulation.setEmitTouchEventsForMouse' &&
        command.params.enabled === false &&
        command.params.configuration === 'mobile',
    ),
    'n.eko mouse/wheel controls must remain click-capable even when the remote browser advertises touch support',
  );
});

test('n.eko status reopens page CDP and reapplies viewport when page metrics mismatch', async () => {
  const WebSocketCtor = createWebSocketMock({
    runtimeStatuses: [
      {
        innerWidth: 800,
        innerHeight: 600,
        screenWidth: 800,
        screenHeight: 600,
        devicePixelRatio: 1,
        hasTouch: false,
        userAgent: 'Desktop UA',
      },
      {
        innerWidth: 947,
        innerHeight: 364,
        screenWidth: 2128,
        screenHeight: 816,
        devicePixelRatio: 2.25,
        hasTouch: true,
        userAgent: 'Mobile Test UA',
      },
    ],
  });
  const companion = createNekoCompanion({
    origin: 'http://neko.local/',
    cdpHttpUrl: 'http://cdp.local/',
    fetchImpl: createFetchMock(),
    WebSocketCtor,
    screenEndpoint: 'api/room/screen',
    screenConfigurationsEndpoint: 'api/room/screen/configurations',
    sleep: abortableSleep,
    stealthMode: 'assistive',
  });

  await companion.start(landscapeViewport);
  const metricsBeforeStatus = WebSocketCtor.commands.filter(
    (command) => command.method === 'Emulation.setDeviceMetricsOverride',
  ).length;
  const status = await companion.queryNekoStatus();
  await companion.stop();

  const metricCommands = WebSocketCtor.commands.filter(
    (command) => command.method === 'Emulation.setDeviceMetricsOverride',
  );
  const attachCommands = WebSocketCtor.commands.filter((command) => command.method === 'Target.attachToTarget');

  assert.equal(status.page_metrics_reapplied, true);
  assert.equal(status.page.innerWidth, 947);
  assert.equal(status.page.screenWidth, 2128);
  assert.ok(status.page_metrics_mismatch.innerWidth);
  assert.ok(metricCommands.length > metricsBeforeStatus);
  assert.ok(attachCommands.length >= 2);
});

test('n.eko desktop status does not reapply only because Chromium reports stale touch support', async () => {
  const WebSocketCtor = createWebSocketMock({
    runtimeStatuses: [
      {
        innerWidth: 2128,
        innerHeight: 816,
        screenWidth: 2128,
        screenHeight: 816,
        devicePixelRatio: 1.15,
        hasTouch: true,
        maxTouchPoints: 10,
        userAgent: 'Desktop UA',
      },
    ],
  });
  const companion = createNekoCompanion({
    origin: 'http://neko.local/',
    cdpHttpUrl: 'http://cdp.local/',
    fetchImpl: createFetchMock(),
    WebSocketCtor,
    screenEndpoint: 'api/room/screen',
    screenConfigurationsEndpoint: 'api/room/screen/configurations',
    sleep: abortableSleep,
    stealthMode: 'assistive',
  });

  await companion.start({
    width: 1117,
    height: 1123,
    deviceScaleFactor: 1.15,
    hasTouch: false,
    mobile: false,
  });
  const metricsBeforeStatus = WebSocketCtor.commands.filter(
    (command) => command.method === 'Emulation.setDeviceMetricsOverride',
  ).length;
  const status = await companion.queryNekoStatus();
  await companion.stop();

  const metricsAfterStatus = WebSocketCtor.commands.filter(
    (command) => command.method === 'Emulation.setDeviceMetricsOverride',
  ).length;
  assert.equal(status.page_metrics_reapplied, undefined);
  assert.equal(status.page_metrics_mismatch, undefined);
  assert.equal(metricsAfterStatus, metricsBeforeStatus);
});

test('n.eko strict stealth mode does not use CDP for viewport application', async () => {
  const WebSocketCtor = createWebSocketMock();
  const companion = createNekoCompanion({
    origin: 'http://neko.local/',
    cdpHttpUrl: 'http://cdp.local/',
    fetchImpl: createFetchMock(),
    WebSocketCtor,
    screenEndpoint: 'api/room/screen',
    screenConfigurationsEndpoint: 'api/room/screen/configurations',
    sleep: abortableSleep,
    stealthMode: 'strict',
  });

  await companion.start(landscapeViewport);
  await companion.stop();

  assert.deepEqual(WebSocketCtor.commands, []);
});

test('n.eko status drains playgroundEvents from the remote ring buffer', async () => {
  // The remote playground page maintains a small `__pdppPlaygroundEvents`
  // ring buffer of click/focus/scroll telemetry. The viewport-status
  // expression splices it on each poll so each event is reported
  // exactly once. This test verifies the full chain by assembling a
  // matching-shape runtime status and confirming `status.page.playgroundEvents`
  // round-trips through the adapter without dropping or duplicating.
  const samplePlaygroundEvents = [
    {
      seq: 1,
      type: 'pointerdown',
      atMs: 1_700_000_000_000,
      clientX: 70,
      clientY: 233,
      target: { tag: 'button', id: 'counter' },
      elementAtPoint: { tag: 'button', id: 'counter' },
    },
    {
      seq: 2,
      type: 'click',
      atMs: 1_700_000_000_050,
      clientX: 70,
      clientY: 233,
      target: { tag: 'button', id: 'counter' },
      elementAtPoint: { tag: 'button', id: 'counter' },
    },
  ];
  const WebSocketCtor = createWebSocketMock({
    runtimeStatuses: [
      {
        innerWidth: 947,
        innerHeight: 364,
        screenWidth: 2128,
        screenHeight: 816,
        devicePixelRatio: 2.25,
        hasTouch: true,
        userAgent: 'Mobile Test UA',
        playgroundEvents: samplePlaygroundEvents,
      },
    ],
  });
  const companion = createNekoCompanion({
    origin: 'http://neko.local/',
    cdpHttpUrl: 'http://cdp.local/',
    fetchImpl: createFetchMock(),
    WebSocketCtor,
    screenEndpoint: 'api/room/screen',
    screenConfigurationsEndpoint: 'api/room/screen/configurations',
    sleep: abortableSleep,
    stealthMode: 'assistive',
  });

  await companion.start(landscapeViewport);
  const status = await companion.queryNekoStatus();
  await companion.stop();

  assert.ok(status.page, 'status.page should be present');
  assert.deepEqual(
    status.page.playgroundEvents,
    samplePlaygroundEvents,
    'playgroundEvents from the remote buffer must round-trip through queryNekoStatus()'
  );
});

test('buildViewportStatusExpression drains __pdppPlaygroundEvents and includes screenWidth', async () => {
  const { default: mod } = await import('./neko-adapter.js');
  void mod;
  // The exported expression-builder is internal-ish, so test via its
  // observable string shape: it must reference both the
  // `__pdppPlaygroundEvents` buffer (so the playground page's events
  // get drained) and `screenWidth` (so the page metrics mismatch
  // detector can compare against the requested CSS-screen).
  const adapterSource = await (await import('node:fs/promises')).readFile(
    new URL('./neko-adapter.js', import.meta.url),
    'utf8',
  );
  assert.match(adapterSource, /__pdppPlaygroundEvents/, 'adapter drains __pdppPlaygroundEvents');
  assert.match(adapterSource, /playgroundEvents:\s*drained/, 'drained events surface as playgroundEvents');
  assert.match(adapterSource, /screenWidth:\s*window\.screen/, 'expression still reports window.screen.width');
});
