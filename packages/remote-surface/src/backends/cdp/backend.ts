import type {
  JsonObject,
  RemoteSurfaceClipboardPayload,
  RemoteSurfaceEventPayload,
  RemoteSurfaceInputPayload,
  RemoteSurfaceKeyModifier,
  RemoteSurfaceKeyboardInput,
  RemoteSurfacePointerInput,
  RemoteSurfaceViewportPayload,
} from "../../protocol/index.ts";
import {
  XK_BackSpace,
  XK_Delete,
  XK_Down,
  XK_End,
  XK_Escape,
  XK_Home,
  XK_Left,
  XK_PageDown,
  XK_PageUp,
  XK_Return,
  XK_Right,
  XK_Tab,
  XK_Up,
} from "../../ime/mobile-text-input-controller.ts";
import type {
  CdpBackendAdapter,
  CdpBackendAdapterFactory,
  CdpBackendLifecycle,
  CdpSafeClientDescriptor,
} from "./descriptor.ts";
import {
  buildCdpSafeClientDescriptor,
  CDP_BACKEND_CAPABILITIES,
} from "./descriptor.ts";

export type CdpCommandParams = Record<string, unknown>;

export interface CdpTransportSubscription {
  unsubscribe(): void;
}

export interface CdpCommandTransport {
  send<Result = unknown>(method: string, params?: CdpCommandParams): Promise<Result> | Result;
  on(eventName: string, handler: (params: unknown) => void): CdpTransportSubscription;
}

export type CdpScreencastFormat = "jpeg" | "png";

export interface CdpScreencastOptions {
  format?: CdpScreencastFormat;
  quality?: number;
  everyNthFrame?: number;
}

export interface CdpRemoteSurfaceBackendAdapterOptions {
  transport: CdpCommandTransport;
  targetId: string;
  clock?: () => number;
  descriptor?: CdpSafeClientDescriptor;
  screencast?: CdpScreencastOptions;
}

export interface CdpRemoteSurfaceBackendAdapterFactoryOptions {
  transportFactory(request: { targetId: string }): Promise<CdpCommandTransport> | CdpCommandTransport;
  clock?: () => number;
  descriptor?: CdpSafeClientDescriptor;
  screencast?: CdpScreencastOptions;
}

export class CdpBackendError extends Error {
  readonly code: "invalid_lifecycle" | "malformed_event";

  constructor(code: CdpBackendError["code"], message: string) {
    super(message);
    this.name = "CdpBackendError";
    this.code = code;
  }
}

type EventHandler = (event: RemoteSurfaceEventPayload) => void;

type ScreencastFrameParams = {
  data: string;
  metadata?: JsonObject;
  sessionId: number;
};

export interface CdpKeyDescriptor {
  code: string;
  key: string;
  text?: string;
  windowsVirtualKeyCode: number;
}

const DEFAULT_SCREENCAST: Required<CdpScreencastOptions> = {
  everyNthFrame: 1,
  format: "jpeg",
  quality: 80,
};
const LOWERCASE_ASCII_RE = /^[a-z]$/u;
const UPPERCASE_ASCII_RE = /^[A-Z]$/u;
const DIGIT_ASCII_RE = /^[0-9]$/u;

export class CdpRemoteSurfaceBackendAdapter implements CdpBackendAdapter {
  readonly kind = "cdp" as const;
  readonly capabilities = CDP_BACKEND_CAPABILITIES;

  private readonly clock: () => number;
  private readonly descriptor: CdpSafeClientDescriptor;
  private readonly screencast: Required<CdpScreencastOptions>;
  private readonly targetId: string;
  private readonly transport: CdpCommandTransport;
  private readonly handlers = new Set<EventHandler>();
  private frameSequence = 0;
  private lifecycle: CdpBackendLifecycle | null = null;
  private screencastSubscription: CdpTransportSubscription | null = null;
  private started = false;

  constructor(options: CdpRemoteSurfaceBackendAdapterOptions) {
    this.clock = options.clock ?? Date.now;
    this.descriptor = options.descriptor ?? buildCdpSafeClientDescriptor();
    this.screencast = { ...DEFAULT_SCREENCAST, ...options.screencast };
    this.targetId = options.targetId;
    this.transport = options.transport;
  }

  async start(viewport?: RemoteSurfaceViewportPayload): Promise<CdpBackendLifecycle> {
    if (this.started) {
      if (viewport) {
        await this.setViewport(viewport);
      }
      this.lifecycle ??= this.createLifecycle();
      return this.lifecycle;
    }
    this.started = true;
    try {
      this.screencastSubscription = this.transport.on("Page.screencastFrame", (params) => {
        void this.handleScreencastFrame(params).catch((error: unknown) => {
          this.emit({
            reason: error instanceof Error ? error.message : "CDP screencast frame handling failed",
            sessionId: this.targetId,
            state: "error",
            timestamp: this.clock(),
            type: "lifecycle",
          });
        });
      });

      if (viewport) {
        await this.setViewport(viewport);
      }
      await this.transport.send("Page.enable");
      await this.transport.send("Page.startScreencast", {
        everyNthFrame: this.screencast.everyNthFrame,
        format: this.screencast.format,
        quality: this.screencast.quality,
      });
      this.emit({
        sessionId: this.targetId,
        state: "ready",
        timestamp: this.clock(),
        type: "lifecycle",
      });

      this.lifecycle = this.createLifecycle();
      return this.lifecycle;
    } catch (error) {
      this.screencastSubscription?.unsubscribe();
      this.screencastSubscription = null;
      this.started = false;
      this.lifecycle = null;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.screencastSubscription?.unsubscribe();
    this.screencastSubscription = null;
    this.started = false;
    this.lifecycle = null;
    await this.transport.send("Page.stopScreencast");
    this.emit({
      sessionId: this.targetId,
      state: "closed",
      timestamp: this.clock(),
      type: "lifecycle",
    });
  }

  async input(payload: RemoteSurfaceInputPayload): Promise<void> {
    this.ensureStarted("input");
    if (payload.type === "pointer") {
      await dispatchCdpPointerInput(this.transport, payload);
      return;
    }
    if (payload.type === "keyboard") {
      await dispatchCdpKeyboardInput(this.transport, payload);
      return;
    }
    if (payload.type === "text") {
      if ((payload.composition === undefined || payload.composition === "commit") && payload.text.length > 0) {
        await insertCdpText(this.transport, payload.text);
      }
      return;
    }
    if (payload.text.length > 0) {
      await insertCdpText(this.transport, payload.text);
    }
  }

  async setViewport(payload: RemoteSurfaceViewportPayload): Promise<void> {
    this.ensureStarted("setViewport");
    await applyCdpViewport(this.transport, payload);
  }

  async clipboard(payload: RemoteSurfaceClipboardPayload): Promise<void> {
    this.ensureStarted("clipboard");
    if (payload.action === "local_to_remote" && payload.text.length > 0) {
      await insertCdpText(this.transport, payload.text);
      return;
    }
    this.emit({
      name: "cdp.clipboard.unsupported",
      payload: { action: payload.action },
      sessionId: this.targetId,
      timestamp: this.clock(),
      type: "backend_event",
    });
  }

  private onEvent(handler: EventHandler): CdpTransportSubscription {
    this.handlers.add(handler);
    return {
      unsubscribe: () => {
        this.handlers.delete(handler);
      },
    };
  }

  private createLifecycle(): CdpBackendLifecycle {
    return {
      safeClientDescriptor: this.descriptor,
      onEvent: (handler) => this.onEvent(handler),
      input: (payload) => this.input(payload),
      setViewport: (payload) => this.setViewport(payload),
      clipboard: (payload) => this.clipboard(payload),
    };
  }

  private async handleScreencastFrame(params: unknown): Promise<void> {
    const frame = parseScreencastFrame(params);
    await this.transport.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
    this.frameSequence += 1;
    this.emit({
      contentType: this.screencast.format === "png" ? "image/png" : "image/jpeg",
      data: frame.data,
      sequence: this.frameSequence,
      sessionId: this.targetId,
      timestamp: this.clock(),
      type: "frame",
    });
  }

  private emit(event: RemoteSurfaceEventPayload): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }

  private ensureStarted(method: string): void {
    if (!this.started) {
      throw new CdpBackendError("invalid_lifecycle", `Cannot call ${method} before CDP backend start`);
    }
  }
}

export function createCdpRemoteSurfaceBackendAdapter(
  options: CdpRemoteSurfaceBackendAdapterOptions,
): CdpRemoteSurfaceBackendAdapter {
  return new CdpRemoteSurfaceBackendAdapter(options);
}

export function createCdpRemoteSurfaceBackendAdapterFactory(
  options: CdpRemoteSurfaceBackendAdapterFactoryOptions,
): CdpBackendAdapterFactory {
  return async (request) => {
    const adapterOptions: CdpRemoteSurfaceBackendAdapterOptions = {
      targetId: request.targetId,
      transport: await options.transportFactory({ targetId: request.targetId }),
    };
    if (options.clock) {
      adapterOptions.clock = options.clock;
    }
    if (options.descriptor) {
      adapterOptions.descriptor = options.descriptor;
    }
    if (options.screencast) {
      adapterOptions.screencast = options.screencast;
    }
    return createCdpRemoteSurfaceBackendAdapter(adapterOptions);
  };
}

function parseScreencastFrame(params: unknown): ScreencastFrameParams {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new CdpBackendError("malformed_event", "Page.screencastFrame payload must be an object");
  }
  const record = params as Record<string, unknown>;
  if (typeof record.data !== "string" || typeof record.sessionId !== "number") {
    throw new CdpBackendError("malformed_event", "Page.screencastFrame payload missing data or sessionId");
  }
  return {
    data: record.data,
    ...(isJsonObject(record.metadata) ? { metadata: record.metadata } : {}),
    sessionId: record.sessionId,
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function insertCdpText(session: CdpCommandTransport, text: string): Promise<void> {
  if (text.length > 0) {
    await session.send("Input.insertText", { text });
  }
}

export async function applyCdpViewport(
  session: CdpCommandTransport,
  payload: RemoteSurfaceViewportPayload,
): Promise<void> {
  await session.send("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: payload.deviceScaleFactor ?? 1,
    height: payload.height,
    mobile: payload.mobile ?? false,
    screenHeight: payload.screenHeight ?? payload.height,
    screenWidth: payload.screenWidth ?? payload.width,
    width: payload.width,
    ...(payload.hasTouch === undefined ? {} : { hasTouch: payload.hasTouch }),
    ...(payload.orientation === undefined
      ? {}
      : {
          screenOrientation: {
            angle: payload.orientation === "portrait" ? 0 : 90,
            type: payload.orientation === "portrait" ? "portraitPrimary" : "landscapePrimary",
          },
      }),
  });
  await session.send("Emulation.setTouchEmulationEnabled", {
    enabled: payload.hasTouch ?? payload.mobile ?? false,
    maxTouchPoints: payload.hasTouch === false ? 1 : 5,
  });
}

export async function dispatchCdpPointerInput(
  session: CdpCommandTransport,
  payload: RemoteSurfacePointerInput,
): Promise<void> {
  const modifiers = toCdpModifierMask(payload.modifiers);
  if (payload.pointerType === "touch") {
    await dispatchCdpTouchInput(session, payload, modifiers);
    return;
  }
  if (payload.action === "wheel") {
    await session.send("Input.dispatchMouseEvent", {
      deltaX: payload.deltaX ?? 0,
      deltaY: payload.deltaY ?? 0,
      modifiers,
      type: "mouseWheel",
      x: payload.x,
      y: payload.y,
    });
    return;
  }
  await session.send("Input.dispatchMouseEvent", {
    button: toCdpMouseButton(payload.button),
    buttons: payload.buttons ?? (payload.action === "pointerdown" ? 1 : 0),
    modifiers,
    type: toCdpMouseEventType(payload.action),
    x: payload.x,
    y: payload.y,
  });
}

async function dispatchCdpTouchInput(
  session: CdpCommandTransport,
  payload: RemoteSurfacePointerInput,
  modifiers: number,
): Promise<void> {
  const touchPoint = {
    id: payload.pointerId ?? 0,
    radiusX: 1,
    radiusY: 1,
    x: payload.x,
    y: payload.y,
  };
  const action = toCdpTouchEventType(payload.action);
  await session.send("Input.dispatchTouchEvent", {
    modifiers,
    touchPoints: action === "touchEnd" || action === "touchCancel" ? [] : [touchPoint],
    type: action,
  });
}

export async function dispatchCdpKeyboardInput(
  session: CdpCommandTransport,
  payload: RemoteSurfaceKeyboardInput,
): Promise<void> {
  const key = payload.keysym === undefined ? keyEventFields(payload) : keysymToCdpKey(payload.keysym);
  await session.send("Input.dispatchKeyEvent", {
    code: payload.code ?? key.code,
    key: payload.key ?? key.key,
    modifiers: toCdpModifierMask(payload.modifiers),
    type: toCdpKeyEventType(payload.action, key.text),
    windowsVirtualKeyCode: key.windowsVirtualKeyCode,
    // CDP keyup releases by key/code/VK only. Text belongs on keydown/keypress;
    // sending text on keyup can synthesize an extra character in Chromium.
    ...(payload.action === "keyup" || key.text === undefined ? {} : { text: key.text, unmodifiedText: key.text }),
  });
}

function keyEventFields(payload: RemoteSurfaceKeyboardInput): CdpKeyDescriptor {
  const key = payload.key ?? "";
  return {
    code: payload.code ?? "",
    key,
    ...(payload.action === "keyup" || key.length !== 1 ? {} : { text: key }),
    windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
  };
}

export function keysymToCdpKey(keysym: number): CdpKeyDescriptor {
  const special = SPECIAL_KEYSYMS.get(keysym);
  if (special) {
    return special;
  }
  if (keysym >= 0x20 && keysym <= 0x7e) {
    return printableAsciiToCdpKey(String.fromCharCode(keysym));
  }
  return {
    code: "",
    key: String(keysym),
    windowsVirtualKeyCode: 0,
  };
}

const SPECIAL_KEYSYMS = new Map<number, CdpKeyDescriptor>([
  [XK_BackSpace, { code: "Backspace", key: "Backspace", windowsVirtualKeyCode: 8 }],
  [XK_Tab, { code: "Tab", key: "Tab", text: "\t", windowsVirtualKeyCode: 9 }],
  [XK_Return, { code: "Enter", key: "Enter", text: "\r", windowsVirtualKeyCode: 13 }],
  [XK_Escape, { code: "Escape", key: "Escape", windowsVirtualKeyCode: 27 }],
  [XK_Left, { code: "ArrowLeft", key: "ArrowLeft", windowsVirtualKeyCode: 37 }],
  [XK_Up, { code: "ArrowUp", key: "ArrowUp", windowsVirtualKeyCode: 38 }],
  [XK_Right, { code: "ArrowRight", key: "ArrowRight", windowsVirtualKeyCode: 39 }],
  [XK_Down, { code: "ArrowDown", key: "ArrowDown", windowsVirtualKeyCode: 40 }],
  [XK_Home, { code: "Home", key: "Home", windowsVirtualKeyCode: 36 }],
  [XK_End, { code: "End", key: "End", windowsVirtualKeyCode: 35 }],
  [XK_PageUp, { code: "PageUp", key: "PageUp", windowsVirtualKeyCode: 33 }],
  [XK_PageDown, { code: "PageDown", key: "PageDown", windowsVirtualKeyCode: 34 }],
  [XK_Delete, { code: "Delete", key: "Delete", windowsVirtualKeyCode: 46 }],
]);

function printableAsciiToCdpKey(char: string): CdpKeyDescriptor {
  if (LOWERCASE_ASCII_RE.test(char)) {
    return {
      code: `Key${char.toUpperCase()}`,
      key: char,
      text: char,
      windowsVirtualKeyCode: char.toUpperCase().charCodeAt(0),
    };
  }
  if (UPPERCASE_ASCII_RE.test(char)) {
    return {
      code: `Key${char}`,
      key: char,
      text: char,
      windowsVirtualKeyCode: char.charCodeAt(0),
    };
  }
  if (DIGIT_ASCII_RE.test(char)) {
    return {
      code: `Digit${char}`,
      key: char,
      text: char,
      windowsVirtualKeyCode: char.charCodeAt(0),
    };
  }
  if (char === " ") {
    return {
      code: "Space",
      key: " ",
      text: " ",
      windowsVirtualKeyCode: 32,
    };
  }
  return {
    code: "",
    key: char,
    text: char,
    windowsVirtualKeyCode: char.charCodeAt(0),
  };
}

function toCdpMouseEventType(action: "pointerdown" | "pointermove" | "pointerup" | "pointercancel" | "wheel"): string {
  if (action === "pointerdown") {
    return "mousePressed";
  }
  if (action === "pointerup" || action === "pointercancel") {
    return "mouseReleased";
  }
  return "mouseMoved";
}

function toCdpTouchEventType(action: "pointerdown" | "pointermove" | "pointerup" | "pointercancel" | "wheel"): string {
  if (action === "pointerdown") {
    return "touchStart";
  }
  if (action === "pointermove" || action === "wheel") {
    return "touchMove";
  }
  if (action === "pointercancel") {
    return "touchCancel";
  }
  return "touchEnd";
}

function toCdpMouseButton(button?: number): string {
  if (button === 1) {
    return "middle";
  }
  if (button === 2) {
    return "right";
  }
  if (button === 3) {
    return "back";
  }
  if (button === 4) {
    return "forward";
  }
  return "left";
}

function toCdpKeyEventType(action: "keydown" | "keyup" | "keypress", text?: string): string {
  if (action === "keyup") {
    return "keyUp";
  }
  if (action === "keypress") {
    return "char";
  }
  return text === undefined ? "rawKeyDown" : "keyDown";
}

function toCdpModifierMask(modifiers: readonly RemoteSurfaceKeyModifier[] | undefined): number {
  let mask = 0;
  for (const modifier of modifiers ?? []) {
    if (modifier === "Alt") {
      mask += 1;
    } else if (modifier === "Control") {
      mask += 2;
    } else if (modifier === "Meta") {
      mask += 4;
    } else if (modifier === "Shift") {
      mask += 8;
    }
  }
  return mask;
}
