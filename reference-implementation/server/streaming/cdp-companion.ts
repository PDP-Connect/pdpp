// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * CDP companion abstraction for the run-interaction streaming surface.
 *
 * The transport layer (mint route, viewer SSE, input POST) talks to a small
 * `Companion` interface that wraps either a real CDP session (see
 * `cdp-adapter.js`) or a deterministic mock used in tests. The mint route is
 * fail-closed when no real adapter is configured (it returns 503
 * `streaming_companion_unavailable`), so this module exposes only the wire
 * mapping helpers and the test mock — it never ships a fake-success companion.
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

/** An `Error` carrying a stable machine `code`. */
type CodedError = Error & { code?: string };

/** A single CDP command produced from a wire input event. */
export interface CdpCommand {
  method: string;
  params?: unknown;
}

/** A viewport hint from the viewer. */
type Viewport = { width?: number; height?: number; deviceScaleFactor?: number; mobile?: boolean } | null | undefined;

const BUTTON_MAP: Record<number, string> = { 0: "left", 1: "middle", 2: "right" };

// Wire touch action → CDP `Input.dispatchTouchEvent` type.
const TOUCH_TYPE_MAP: Record<string, string> = {
  touchstart: "touchStart",
  touchmove: "touchMove",
  touchend: "touchEnd",
};

// Browser-event vk codes we use for keys whose `key` is a name (Backspace, etc.)
const VIRTUAL_KEY_CODES: Record<string, number> = {
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

type WireInput = Record<string, any>;
type MouseCommandBuilder = (input: { x: number; y: number; button: string }) => CdpCommand[];

function mouseCommand(type: string, x: number, y: number, button: string, clickCount = 1): CdpCommand {
  return { method: "Input.dispatchMouseEvent", params: { type, x, y, button, clickCount } };
}

const MOUSE_COMMANDS: Record<string, MouseCommandBuilder> = {
  mousemove: ({ x, y }) => [
    { method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x, y, button: "none" } },
  ],
  click: ({ x, y, button }) => [
    mouseCommand("mousePressed", x, y, button),
    mouseCommand("mouseReleased", x, y, button),
  ],
  dblclick: ({ x, y }) => [
    mouseCommand("mousePressed", x, y, "left"),
    mouseCommand("mouseReleased", x, y, "left"),
    mouseCommand("mousePressed", x, y, "left", 2),
    mouseCommand("mouseReleased", x, y, "left", 2),
  ],
  mousedown: ({ x, y, button }) => [mouseCommand("mousePressed", x, y, button)],
  mouseup: ({ x, y, button }) => [mouseCommand("mouseReleased", x, y, button)],
};

function invalidInput(message: string): CodedError {
  const err: CodedError = new Error(message);
  err.code = "invalid_input";
  return err;
}

function ensureNumber(value: unknown, label: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw invalidInput(`${label} must be a finite number`);
  }
  return n;
}

/**
 * Map a `mouse` wire event to CDP mouse commands. Callers pass the already
 * shape-validated event; this focuses purely on the action dispatch.
 */
function mapMouseEventToCdp(event: WireInput): CdpCommand[] {
  const x = ensureNumber(event.x, "x");
  const y = ensureNumber(event.y, "y");
  const button = BUTTON_MAP[event.button ?? 0] ?? "left";
  const buildCommands = MOUSE_COMMANDS[event.action];
  if (!buildCommands) throw invalidInput(`unknown mouse action: ${event.action}`);
  return buildCommands({ x, y, button });
}

/**
 * Map a `keyboard` wire event to a CDP key command. Callers pass the already
 * shape-validated event; this focuses purely on the action dispatch.
 */
function virtualKeyCodeParams(vk: number | undefined) {
  return vk ? { windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk } : {};
}

function keyboardType(action: unknown, isPrintable: boolean): string {
  if (action === "keydown") return isPrintable ? "keyDown" : "rawKeyDown";
  if (action === "keyup") return "keyUp";
  throw invalidInput(`unknown keyboard action: ${action}`);
}

function mapKeyboardEventToCdp(event: WireInput): CdpCommand[] {
  if (typeof event.key !== "string" || event.key.length === 0) {
    throw invalidInput("keyboard.key is required");
  }
  const vk = VIRTUAL_KEY_CODES[event.key];
  const modifiers = Number.isFinite(event.modifiers) ? Number(event.modifiers) : 0;
  const code = typeof event.code === "string" ? event.code : undefined;
  const isPrintable = event.key.length === 1;
  const type = keyboardType(event.action, isPrintable);
  const text = type === "keyDown" ? { text: event.key } : {};
  return [
    {
      method: "Input.dispatchKeyEvent",
      params: { type, key: event.key, code, modifiers, ...text, ...virtualKeyCodeParams(vk) },
    },
  ];
}

function mapTouchEventToCdp(event: WireInput): CdpCommand[] {
  const x = ensureNumber(event.x, "x");
  const y = ensureNumber(event.y, "y");
  const id = Number.isFinite(event.id) ? Number(event.id) : 1;
  const cdpType = TOUCH_TYPE_MAP[event.action] ?? null;
  if (!cdpType) throw invalidInput(`unknown touch action: ${event.action}`);
  const touchPoints = cdpType === "touchEnd" ? [] : [{ x, y, id }];
  return [{ method: "Input.dispatchTouchEvent", params: { type: cdpType, touchPoints } }];
}

function mapScrollEventToCdp(event: WireInput): CdpCommand[] {
  const x = ensureNumber(event.x, "x");
  const y = ensureNumber(event.y, "y");
  const deltaX = ensureNumber(event.deltaX, "deltaX");
  const deltaY = ensureNumber(event.deltaY, "deltaY");
  return [{ method: "Input.dispatchMouseEvent", params: { type: "mouseWheel", x, y, deltaX, deltaY } }];
}

function mapPasteEventToCdp(event: WireInput): CdpCommand[] {
  if (typeof event.text !== "string") throw invalidInput("paste.text must be a string");
  return [{ method: "Input.insertText", params: { text: event.text } }];
}

function mapViewportEventToCdp(event: WireInput): CdpCommand[] {
  const width = ensureNumber(event.width, "width");
  const height = ensureNumber(event.height, "height");
  const deviceScaleFactor = Number.isFinite(event.deviceScaleFactor) ? Number(event.deviceScaleFactor) : 1;
  const mobile = event.mobile === true;
  return [
    { method: "Emulation.setDeviceMetricsOverride", params: { width, height, deviceScaleFactor, mobile } },
    { method: "Page.stopScreencast", params: undefined },
    { method: "Page.startScreencast", params: buildScreencastParams({ viewport: { width, height } }) },
  ];
}

const INPUT_EVENT_MAPPERS: Record<string, (event: WireInput) => CdpCommand[]> = {
  mouse: mapMouseEventToCdp,
  keyboard: mapKeyboardEventToCdp,
  touch: mapTouchEventToCdp,
  scroll: mapScrollEventToCdp,
  paste: mapPasteEventToCdp,
  viewport: mapViewportEventToCdp,
};

/**
 * Translate a wire input event into a list of CDP commands. Pure function
 * so it can be unit-tested without a real CDP session attached.
 *
 * `event` is untrusted wire JSON; the function validates shape at runtime.
 */
export function mapInputEventToCdp(event: any): CdpCommand[] {
  if (!event || typeof event !== "object") {
    throw invalidInput("input event must be an object");
  }
  const mapEvent = INPUT_EVENT_MAPPERS[event.type];
  if (!mapEvent) throw invalidInput(`unknown input event type: ${event.type}`);
  return mapEvent(event);
}

/** Screencast start parameters passed to `Page.startScreencast`. */
export interface ScreencastParams {
  everyNthFrame: number;
  format: string;
  maxHeight: number;
  maxWidth: number;
  quality: number;
}

/**
 * Build the screencast start params from a viewer-provided viewport. The
 * caller passes this to `Page.startScreencast`.
 */
export function buildScreencastParams({
  viewport,
  quality = 70,
}: {
  viewport?: Viewport;
  quality?: number;
} = {}): ScreencastParams {
  const width = viewport?.width;
  const height = viewport?.height;
  const maxWidth = Number.isFinite(width) && (width as number) > 0 ? Math.floor(width as number) : 1280;
  const maxHeight = Number.isFinite(height) && (height as number) > 0 ? Math.floor(height as number) : 720;
  return {
    format: "jpeg",
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

/** The deterministic mock companion returned by `createMockCompanion`. */
export interface MockCompanion {
  ackFrame(sessionId: unknown): Promise<void>;
  browser_session_id: string;
  cdpCalls: CdpCommand[];
  dispatch(event: unknown): Promise<void>;
  inputs: unknown[];
  lastViewport(): unknown;
  onEvent(fn: (event: unknown) => void): () => void;
  onFrame(fn: (frame: unknown) => void): () => void;
  pushEvent(event: unknown): void;
  pushFrame(frame: unknown): void;
  start(viewport?: unknown): Promise<void>;
  started(): boolean;
  stop(): Promise<void>;
}

/**
 * Mock companion for deterministic tests. Frames can be pushed manually via
 * `pushFrame`, out-of-band wire events via `pushEvent`, and dispatched input
 * events accumulate in `inputs` so tests can assert that the wire→CDP mapping
 * landed correctly.
 */
export function createMockCompanion({
  browser_session_id = "mock-session",
}: {
  browser_session_id?: string;
} = {}): MockCompanion {
  const handlers = new Set<(frame: unknown) => void>();
  const eventHandlers = new Set<(event: unknown) => void>();
  let started = false;
  let lastViewport: unknown = null;
  const inputs: unknown[] = [];
  const cdpCalls: CdpCommand[] = [];

  return {
    browser_session_id,
    started: () => started,
    lastViewport: () => lastViewport,
    inputs,
    cdpCalls,
    // biome-ignore lint/suspicious/useAwait: satisfies the MockCompanion/Companion contract (the real CDP companion twin awaits).
    async start(viewport) {
      started = true;
      lastViewport = viewport || null;
      cdpCalls.push({
        method: "Page.startScreencast",
        params: buildScreencastParams({ viewport: viewport as Viewport }),
      });
    },
    // biome-ignore lint/suspicious/useAwait: satisfies the MockCompanion/Companion contract (the real CDP companion twin awaits).
    async stop() {
      started = false;
      cdpCalls.push({ method: "Page.stopScreencast", params: {} });
      handlers.clear();
      eventHandlers.clear();
    },
    onFrame(fn) {
      handlers.add(fn);
      return () => handlers.delete(fn);
    },
    onEvent(fn) {
      eventHandlers.add(fn);
      return () => eventHandlers.delete(fn);
    },
    pushFrame(frame) {
      for (const handler of handlers) {
        handler(frame);
      }
    },
    pushEvent(event) {
      for (const handler of eventHandlers) {
        handler(event);
      }
    },
    // biome-ignore lint/suspicious/useAwait: satisfies the MockCompanion/Companion contract (the real CDP companion twin awaits).
    async dispatch(event) {
      const commands = mapInputEventToCdp(event);
      inputs.push(event);
      for (const cmd of commands) {
        cdpCalls.push(cmd);
      }
    },
    // biome-ignore lint/suspicious/useAwait: satisfies the MockCompanion/Companion contract (the real CDP companion twin awaits).
    async ackFrame(sessionId) {
      cdpCalls.push({ method: "Page.screencastFrameAck", params: { sessionId } });
    },
  };
}
