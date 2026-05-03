/**
 * CDP companion abstraction for the run-interaction streaming surface.
 *
 * The transport layer (mint route, viewer SSE, input POST) talks to a small
 * `Companion` interface that wraps either a real CDP session or a deterministic
 * fake used in tests. We do NOT take a runtime dependency on a specific CDP
 * client here; the real adapter is wired in when a host browser provider is
 * present, and falls back to an `unsupported` companion that fails closed.
 *
 * Wire shape — frames (server → viewer, JSON over SSE):
 *
 *   { type: 'frame', session_id: number, data_base64: string,
 *     metadata: { device_width, device_height, offset_top, page_scale_factor,
 *                 timestamp, scroll_offset_x, scroll_offset_y } }
 *
 * Wire shape — input (viewer → server, JSON):
 *
 *   { type: 'mouse',     action: 'mousemove'|'click'|'mousedown'|'mouseup'|'dblclick',
 *     x: number, y: number, button?: 0|1|2 }
 *   { type: 'keyboard',  action: 'keydown'|'keyup',
 *     key: string, code?: string, modifiers?: number }
 *   { type: 'touch',     action: 'touchstart'|'touchmove'|'touchend',
 *     x: number, y: number, id?: number }
 *   { type: 'scroll',    x: number, y: number, deltaX: number, deltaY: number }
 *   { type: 'paste',     text: string }
 *   { type: 'viewport',  width: number, height: number, deviceScaleFactor?: number,
 *     mobile?: boolean }
 *
 * Patterns ported and trimmed from `remote-browser-sandbox/server/src/input.ts`
 * and `remote-browser-service/sprite-server/src/{streamer,input-handler}.ts`.
 * We intentionally keep the surface small: no rrweb, no neko, no audio stream.
 */

const BUTTON_MAP = { 0: 'left', 1: 'middle', 2: 'right' };

// Browser-event vk codes we use for keys whose `key` is a name (Backspace, etc.)
const VIRTUAL_KEY_CODES = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Escape: 27,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
};

function ensureNumber(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    const err = new Error(`${label} must be a finite number`);
    err.code = 'invalid_input';
    throw err;
  }
  return n;
}

/**
 * Translate a wire input event into a list of CDP commands. Pure function
 * so it can be unit-tested without a real CDP session attached.
 */
export function mapInputEventToCdp(event) {
  if (!event || typeof event !== 'object') {
    const err = new Error('input event must be an object');
    err.code = 'invalid_input';
    throw err;
  }
  switch (event.type) {
    case 'mouse': {
      const x = ensureNumber(event.x, 'x');
      const y = ensureNumber(event.y, 'y');
      const button = BUTTON_MAP[event.button ?? 0] ?? 'left';
      switch (event.action) {
        case 'mousemove':
          return [{ method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x, y, button: 'none' } }];
        case 'click':
          return [
            { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x, y, button, clickCount: 1 } },
            { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x, y, button, clickCount: 1 } },
          ];
        case 'dblclick':
          return [
            { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x, y, button: 'left', clickCount: 1 } },
            { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 } },
            { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x, y, button: 'left', clickCount: 2 } },
            { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x, y, button: 'left', clickCount: 2 } },
          ];
        case 'mousedown':
          return [{ method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x, y, button, clickCount: 1 } }];
        case 'mouseup':
          return [{ method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x, y, button, clickCount: 1 } }];
        default: {
          const err = new Error(`unknown mouse action: ${event.action}`);
          err.code = 'invalid_input';
          throw err;
        }
      }
    }

    case 'keyboard': {
      if (typeof event.key !== 'string' || event.key.length === 0) {
        const err = new Error('keyboard.key is required');
        err.code = 'invalid_input';
        throw err;
      }
      const vk = VIRTUAL_KEY_CODES[event.key];
      const modifiers = Number.isFinite(event.modifiers) ? Number(event.modifiers) : 0;
      const code = typeof event.code === 'string' ? event.code : undefined;
      const isPrintable = event.key.length === 1;
      if (event.action === 'keydown') {
        return [
          {
            method: 'Input.dispatchKeyEvent',
            params: {
              type: isPrintable ? 'keyDown' : 'rawKeyDown',
              key: event.key,
              code,
              modifiers,
              ...(isPrintable ? { text: event.key } : {}),
              ...(vk ? { windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk } : {}),
            },
          },
        ];
      }
      if (event.action === 'keyup') {
        return [
          {
            method: 'Input.dispatchKeyEvent',
            params: {
              type: 'keyUp',
              key: event.key,
              code,
              modifiers,
              ...(vk ? { windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk } : {}),
            },
          },
        ];
      }
      const err = new Error(`unknown keyboard action: ${event.action}`);
      err.code = 'invalid_input';
      throw err;
    }

    case 'touch': {
      const x = ensureNumber(event.x, 'x');
      const y = ensureNumber(event.y, 'y');
      const id = Number.isFinite(event.id) ? Number(event.id) : 1;
      const action = event.action;
      const cdpType =
        action === 'touchstart'
          ? 'touchStart'
          : action === 'touchmove'
            ? 'touchMove'
            : action === 'touchend'
              ? 'touchEnd'
              : null;
      if (!cdpType) {
        const err = new Error(`unknown touch action: ${event.action}`);
        err.code = 'invalid_input';
        throw err;
      }
      return [
        {
          method: 'Input.dispatchTouchEvent',
          params: {
            type: cdpType,
            touchPoints: cdpType === 'touchEnd' ? [] : [{ x, y, id }],
          },
        },
      ];
    }

    case 'scroll': {
      const x = ensureNumber(event.x, 'x');
      const y = ensureNumber(event.y, 'y');
      const deltaX = ensureNumber(event.deltaX, 'deltaX');
      const deltaY = ensureNumber(event.deltaY, 'deltaY');
      return [{ method: 'Input.dispatchMouseEvent', params: { type: 'mouseWheel', x, y, deltaX, deltaY } }];
    }

    case 'paste': {
      if (typeof event.text !== 'string') {
        const err = new Error('paste.text must be a string');
        err.code = 'invalid_input';
        throw err;
      }
      return [{ method: 'Input.insertText', params: { text: event.text } }];
    }

    case 'viewport': {
      const width = ensureNumber(event.width, 'width');
      const height = ensureNumber(event.height, 'height');
      const deviceScaleFactor = Number.isFinite(event.deviceScaleFactor) ? Number(event.deviceScaleFactor) : 1;
      const mobile = event.mobile === true;
      return [
        {
          method: 'Emulation.setDeviceMetricsOverride',
          params: { width, height, deviceScaleFactor, mobile },
        },
      ];
    }

    default: {
      const err = new Error(`unknown input event type: ${event.type}`);
      err.code = 'invalid_input';
      throw err;
    }
  }
}

/**
 * Build the screencast start params from a viewer-provided viewport. The
 * caller passes this to `Page.startScreencast`.
 */
export function buildScreencastParams({ viewport, quality = 70 } = {}) {
  const maxWidth = Number.isFinite(viewport?.width) && viewport.width > 0 ? Math.floor(viewport.width) : 1280;
  const maxHeight = Number.isFinite(viewport?.height) && viewport.height > 0 ? Math.floor(viewport.height) : 720;
  return {
    format: 'jpeg',
    quality: Math.max(1, Math.min(100, Math.floor(quality))),
    maxWidth,
    maxHeight,
    everyNthFrame: 1,
  };
}

/**
 * Companion contract:
 *   start(viewport): Promise<void>      — begin frame production
 *   stop(): Promise<void>               — stop frames, release CDP resources
 *   onFrame(handler): unsubscribe       — register a frame consumer
 *   dispatch(event): Promise<void>      — handle a wire input event
 *   ackFrame(sessionId): Promise<void>  — back-pressure ack
 *   browser_session_id: string          — opaque id of the underlying session
 */

/**
 * Default companion that fails closed. Used when no CDP provider is wired:
 * the mint route still runs and the spec is exercised, but a real attach
 * receives a clean unsupported error.
 */
export function createUnsupportedCompanion({ browser_session_id }) {
  const id = browser_session_id || 'unsupported';
  const handlers = new Set();
  return {
    browser_session_id: id,
    async start() {
      throw Object.assign(new Error('Streaming companion not configured'), { code: 'companion_unavailable' });
    },
    async stop() {},
    onFrame(fn) {
      handlers.add(fn);
      return () => handlers.delete(fn);
    },
    async dispatch() {
      throw Object.assign(new Error('Streaming companion not configured'), { code: 'companion_unavailable' });
    },
    async ackFrame() {},
  };
}

/**
 * Mock companion for deterministic tests. Frames can be pushed manually via
 * `pushFrame`, and dispatched input events accumulate in `inputs` so tests can
 * assert that the wire→CDP mapping landed correctly.
 */
export function createMockCompanion({ browser_session_id = 'mock-session' } = {}) {
  const handlers = new Set();
  let started = false;
  let lastViewport = null;
  const inputs = [];
  const cdpCalls = [];

  return {
    browser_session_id,
    started: () => started,
    lastViewport: () => lastViewport,
    inputs,
    cdpCalls,
    async start(viewport) {
      started = true;
      lastViewport = viewport || null;
      cdpCalls.push({ method: 'Page.startScreencast', params: buildScreencastParams({ viewport }) });
    },
    async stop() {
      started = false;
      cdpCalls.push({ method: 'Page.stopScreencast', params: {} });
    },
    onFrame(fn) {
      handlers.add(fn);
      return () => handlers.delete(fn);
    },
    pushFrame(frame) {
      for (const handler of handlers) {
        handler(frame);
      }
    },
    async dispatch(event) {
      const commands = mapInputEventToCdp(event);
      inputs.push(event);
      for (const cmd of commands) {
        cdpCalls.push(cmd);
      }
    },
    async ackFrame(sessionId) {
      cdpCalls.push({ method: 'Page.screencastFrameAck', params: { sessionId } });
    },
  };
}
