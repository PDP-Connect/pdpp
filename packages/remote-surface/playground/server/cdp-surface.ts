import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "patchright";
import {
  CdpSurfaceAdapter,
  type CdpSurfaceFrame,
  type CdpSurfaceViewportInfo,
} from "../../src/adapters/cdp-surface-adapter.ts";
import {
  CDP_FORM_FIELD_DETECTION_EXPRESSION,
  parseCdpDetectedFormFields,
} from "../../src/backends/cdp/form-field-detector.ts";
import type {
  CdpCommandParams,
  CdpCommandTransport,
  CdpTransportSubscription,
} from "../../src/backends/cdp/index.ts";
import type { RemoteSurfaceFormFieldSnapshot } from "../../src/protocol/index.ts";
import type {
  FocusTextInputOptions,
  RemoteKeysymEvent,
  RemotePointerEvent,
  RemoteSurface,
} from "../../src/types.ts";

export type PlaygroundDriverKind = "package" | "legacy";

export type ProbeSnapshot = {
  active?: { id?: string; tag?: string; type?: string; value?: string };
  values?: { email?: string; password?: string; otp?: string };
  clickCount?: number;
  eventLog?: Array<Record<string, unknown>>;
  lastClick?: { x: number; y: number; target?: Record<string, unknown>; time: number } | null;
  submitCount?: number;
  targetRects?: Record<string, { height: number; left: number; top: number; width: number } | null>;
  effect?: string;
  viewport?: {
    width: number;
    height: number;
    visualWidth: number;
    visualHeight: number;
    devicePixelRatio: number;
  };
};

export type ScreencastFrame = {
  data: string;
  metadata: Record<string, unknown>;
  sessionId: number;
  byteLength: number;
  receivedAt: number;
};

export type InputDispatchTrace = {
  path: string;
  method: string;
  text: string;
  timestamp: number;
};

export type InputTelemetryFallback = {
  handler: string;
  key?: string;
  text?: string;
};

export interface CdpPlaygroundSurfaceDriver extends RemoteSurface {
  readonly driverKind: PlaygroundDriverKind;
  start(): Promise<void>;
  stop(): Promise<void>;
  onFrame(handler: (frame: ScreencastFrame) => void): void;
  setQuality(quality: number): Promise<void>;
  refreshScreencast(): Promise<void>;
  resize(width: number, height: number, deviceScaleFactor: number, mobile: boolean): Promise<void>;
  snapshot(): Promise<ProbeSnapshot>;
  clearProbe(): Promise<ProbeSnapshot>;
  readFormFields(): Promise<RemoteSurfaceFormFieldSnapshot>;
  click(x: number, y: number, pointerType?: "mouse" | "touch"): Promise<void>;
  clickSelector(selector: string): Promise<{ x: number; y: number; selector: string } | null>;
  dispatchKeyCommand(key: string, code: string, modifiers?: number): Promise<void>;
  dispatchRawKey(key: string, code: string, modifiers?: number): Promise<void>;
  consumeInputTelemetry(fallback: InputTelemetryFallback): InputDispatchTrace[];
}

const KEYSYM_TO_KEY: Record<number, { key: string; code: string; virtualKeyCode: number }> = {
  0xff08: { key: "Backspace", code: "Backspace", virtualKeyCode: 8 },
  0xff09: { key: "Tab", code: "Tab", virtualKeyCode: 9 },
  0xff0d: { key: "Enter", code: "Enter", virtualKeyCode: 13 },
  0xff1b: { key: "Escape", code: "Escape", virtualKeyCode: 27 },
};

const KEY_TO_VIRTUAL_CODE: Record<string, number> = {
  Backspace: 8,
  Delete: 46,
  Enter: 13,
  Escape: 27,
  Tab: 9,
};

function parseBooleanEnv(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes";
}

function resolveChromePath(): string | undefined {
  const configured = process.env.REMOTE_SURFACE_CHROME_PATH ?? process.env.CHROME_PATH;
  if (configured) {
    return configured;
  }
  return existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined;
}

function isTargetClosedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Target page, context or browser has been closed")
    || message.includes("Session closed")
    || message.includes("Target closed");
}

async function sendCdp<Result = unknown>(
  cdp: CDPSession,
  method: string,
  params?: CdpCommandParams,
): Promise<Result> {
  const send = cdp.send as unknown as (command: string, parameters?: CdpCommandParams) => Promise<Result>;
  return await send.call(cdp, method, params);
}

function onCdp(cdp: CDPSession, eventName: string, handler: (params: unknown) => void): void {
  const on = cdp.on as unknown as (event: string, listener: (params: unknown) => void) => void;
  on.call(cdp, eventName, handler);
}

function byteLengthFromBase64(data: string): number {
  return Math.ceil((data.length * 3) / 4);
}

function browserViewportPayload(viewport: ViewportState): CdpSurfaceViewportInfo {
  return {
    deviceScaleFactor: viewport.deviceScaleFactor,
    hasTouch: viewport.mobile,
    height: viewport.height,
    mobile: viewport.mobile,
    orientation: viewport.height >= viewport.width ? "portrait" : "landscape",
    screenHeight: viewport.height,
    screenWidth: viewport.width,
    width: viewport.width,
  };
}

function fallbackTelemetryPath(driverKind: PlaygroundDriverKind, fallback: InputTelemetryFallback): string {
  if (fallback.handler === "ime-commit" || fallback.handler === "paste" || fallback.handler === "synthetic") {
    return `${driverKind}:Input.insertText`;
  }
  return `${driverKind}:Input.dispatchKeyEvent`;
}

function splitTextTelemetry(path: string, method: string, text: string, timestamp: number): InputDispatchTrace[] {
  const chars = [...text];
  if (chars.length === 0) {
    return [{ method, path, text, timestamp }];
  }
  return chars.map((char) => ({ method, path, text: char, timestamp }));
}

function inputTelemetryFromCommand(
  driverKind: PlaygroundDriverKind,
  method: string,
  params: CdpCommandParams | undefined,
): InputDispatchTrace[] {
  if (!method.startsWith("Input.")) {
    return [];
  }
  const path = `${driverKind}:${method}`;
  const timestamp = Date.now();
  if (method === "Input.insertText") {
    const text = typeof params?.text === "string" ? params.text : "";
    return splitTextTelemetry(path, method, text, timestamp);
  }
  if (method === "Input.dispatchKeyEvent") {
    const text =
      typeof params?.text === "string" && params.text.length > 0
        ? params.text
        : typeof params?.key === "string"
          ? params.key
          : "";
    return splitTextTelemetry(path, method, text, timestamp);
  }
  return [{ method, path, text: method.replace(/^Input\./u, ""), timestamp }];
}

type ViewportState = {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
};

abstract class BaseCdpPlaygroundSurface implements CdpPlaygroundSurfaceDriver {
  readonly driverKind: PlaygroundDriverKind;
  protected browser: Browser | null = null;
  protected context: BrowserContext | null = null;
  protected page: Page | null = null;
  protected cdp: CDPSession | null = null;
  protected frameHandler: ((frame: ScreencastFrame) => void) | null = null;
  protected quality = 78;
  protected viewport: ViewportState = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };
  protected commandQueue: Promise<void> = Promise.resolve();
  private readonly inputTelemetry: InputDispatchTrace[] = [];
  private readonly probeUrl: string;

  protected constructor(driverKind: PlaygroundDriverKind, probeUrl: string) {
    this.driverKind = driverKind;
    this.probeUrl = probeUrl;
  }

  async start(): Promise<void> {
    if (this.browser) {
      return;
    }

    const headless = parseBooleanEnv(process.env.REMOTE_SURFACE_PLAYGROUND_HEADLESS);
    const executablePath = resolveChromePath();
    this.browser = await chromium.launch({
      headless,
      ...(executablePath ? { executablePath } : {}),
      args: [
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--window-size=430,900",
      ],
    });
    this.context = await this.browser.newContext({
      viewport: {
        width: this.viewport.width,
        height: this.viewport.height,
      },
      deviceScaleFactor: this.viewport.deviceScaleFactor,
      hasTouch: true,
      isMobile: this.viewport.mobile,
    });
    this.page = await this.context.newPage();
    await this.page.goto(this.probeUrl, { waitUntil: "domcontentloaded" });
    await this.page.bringToFront().catch(() => undefined);
    this.cdp = await this.context.newCDPSession(this.page);
    await this.cdp.send("Runtime.enable");
    await this.cdp.send("DOM.enable");
    await this.startDriver();
  }

  async stop(): Promise<void> {
    await this.stopDriver();
    await this.cdp?.detach().catch(() => undefined);
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.cdp = null;
    this.page = null;
    this.context = null;
    this.browser = null;
  }

  onFrame(handler: (frame: ScreencastFrame) => void): void {
    this.frameHandler = handler;
  }

  async setQuality(quality: number): Promise<void> {
    this.quality = Math.max(20, Math.min(100, Math.round(quality)));
    await this.applyQuality();
  }

  async resize(width: number, height: number, deviceScaleFactor: number, mobile: boolean): Promise<void> {
    this.viewport = {
      width: Math.max(240, Math.round(width)),
      height: Math.max(240, Math.round(height)),
      deviceScaleFactor: Math.max(1, Math.min(4, deviceScaleFactor)),
      mobile,
    };
    await this.resizeDriver();
  }

  async snapshot(): Promise<ProbeSnapshot> {
    if (!this.cdp) {
      return {};
    }
    const result = await sendCdp<{ result: { value?: unknown } }>(this.cdp, "Runtime.evaluate", {
      expression: "window.__remoteSurfaceProbe?.snapshot?.() ?? {}",
      returnByValue: true,
    });
    return (result.result.value ?? {}) as ProbeSnapshot;
  }

  async clearProbe(): Promise<ProbeSnapshot> {
    if (!this.cdp) {
      return {};
    }
    await this.cdp.send("Runtime.evaluate", {
      expression: "window.__remoteSurfaceProbe?.clear?.()",
      returnByValue: true,
    });
    return this.snapshot();
  }

  async readFormFields(): Promise<RemoteSurfaceFormFieldSnapshot> {
    if (!this.cdp) {
      return { type: "form_fields", fields: [], timestamp: Date.now() };
    }
    const result = await sendCdp<{ result: { value?: unknown } }>(this.cdp, "Runtime.evaluate", {
      expression: CDP_FORM_FIELD_DETECTION_EXPRESSION,
      returnByValue: true,
    });
    return {
      type: "form_fields",
      fields: parseCdpDetectedFormFields(result.result.value),
      timestamp: Date.now(),
    };
  }

  async mount(_el: HTMLElement): Promise<void> {
    await this.start();
  }

  async unmount(): Promise<void> {
    await this.stop();
  }

  focusTextInput(_opts?: FocusTextInputOptions): void {}

  blurTextInput(): void {}

  setRemoteInputFocused(_focused: boolean): void {}

  async click(x: number, y: number, pointerType: "mouse" | "touch" = "touch"): Promise<void> {
    await this.sendPointer({ type: "pointerdown", x, y, pointerType, pointerId: 1, button: 0, pressure: 1 });
    await this.sendPointer({ type: "pointerup", x, y, pointerType, pointerId: 1, button: 0, pressure: 0 });
  }

  async clickSelector(selector: string): Promise<{ x: number; y: number; selector: string } | null> {
    if (!this.cdp) {
      return null;
    }
    const result = await sendCdp<{ result: { value?: unknown } }>(this.cdp, "Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!(el instanceof HTMLElement)) return null;
        const rect = el.getBoundingClientRect();
        return {
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          selector: ${JSON.stringify(selector)}
        };
      })()`,
      returnByValue: true,
    });
    const value = result.result.value as { x: number; y: number; selector: string } | null;
    if (!value) {
      return null;
    }
    await this.click(value.x, value.y, "touch");
    return value;
  }

  consumeInputTelemetry(fallback: InputTelemetryFallback): InputDispatchTrace[] {
    const traces = this.inputTelemetry.splice(0);
    if (traces.length > 0) {
      return traces;
    }
    const text = fallback.text ?? fallback.key ?? "";
    return splitTextTelemetry(fallbackTelemetryPath(this.driverKind, fallback), "unknown", text, Date.now());
  }

  protected recordCdpCommand(method: string, params?: CdpCommandParams): void {
    this.inputTelemetry.push(...inputTelemetryFromCommand(this.driverKind, method, params));
  }

  protected viewportMetadata(): Record<string, unknown> {
    return {
      deviceHeight: this.viewport.height,
      deviceScaleFactor: this.viewport.deviceScaleFactor,
      deviceWidth: this.viewport.width,
      mobile: this.viewport.mobile,
    };
  }

  protected async dispatchKey(event: {
    type: "keydown" | "keyup" | "keyDown" | "rawKeyDown" | "keyUp";
    key: string;
    code: string;
    text?: string;
    modifiers?: number;
    windowsVirtualKeyCode?: number;
  }): Promise<void> {
    await this.enqueue(async () => {
      if (!this.cdp) {
        return;
      }
      const type = event.type === "keydown" ? "rawKeyDown" : event.type === "keyup" ? "keyUp" : event.type;
      const params = {
        code: event.code,
        key: event.key,
        modifiers: event.modifiers ?? 0,
        type,
        ...(event.text ? { text: event.text, unmodifiedText: event.text } : {}),
        ...(event.windowsVirtualKeyCode ? {
          nativeVirtualKeyCode: event.windowsVirtualKeyCode,
          windowsVirtualKeyCode: event.windowsVirtualKeyCode,
        } : {}),
      };
      this.recordCdpCommand("Input.dispatchKeyEvent", params);
      await sendCdp(this.cdp, "Input.dispatchKeyEvent", params);
    });
  }

  protected async enqueue(command: () => Promise<void>): Promise<void> {
    const next = this.commandQueue.then(command, command);
    this.commandQueue = next.catch(() => undefined);
    await next;
  }

  protected abstract startDriver(): Promise<void>;
  protected abstract stopDriver(): Promise<void>;
  protected abstract resizeDriver(): Promise<void>;
  protected abstract applyQuality(): Promise<void>;
  abstract refreshScreencast(): Promise<void>;
  abstract sendPointer(event: RemotePointerEvent): Promise<void>;
  abstract sendKeysym(event: RemoteKeysymEvent): Promise<void>;
  abstract sendText(text: string): Promise<void>;
  abstract pasteText(text: string): Promise<boolean>;
  abstract copyRemoteSelection(): Promise<boolean>;
  async dispatchKeyCommand(key: string, code: string, modifiers = 0): Promise<void> {
    const windowsVirtualKeyCode = KEY_TO_VIRTUAL_CODE[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
    await this.dispatchKey({
      type: "rawKeyDown",
      key,
      code,
      modifiers,
      windowsVirtualKeyCode,
    });
    await this.dispatchKey({
      type: "keyUp",
      key,
      code,
      modifiers,
      windowsVirtualKeyCode,
    });
  }
  abstract dispatchRawKey(key: string, code: string, modifiers?: number): Promise<void>;
}

export class PackageCdpPlaygroundSurface extends BaseCdpPlaygroundSurface {
  private adapter: CdpSurfaceAdapter | null = null;
  private adapterHost: HTMLElement | null = null;

  constructor(probeUrl: string) {
    super("package", probeUrl);
  }

  protected async startDriver(): Promise<void> {
    if (!this.cdp) {
      return;
    }
    const transport = this.createPackageTransport(this.cdp);
    this.adapterHost = this.createAdapterHost();
    this.adapter = new CdpSurfaceAdapter({
      client: {
        cdp: transport,
        getViewportInfo: () => browserViewportPayload(this.viewport),
        mediaSink: {
          onError(error) {
            console.warn("[playground] package CDP media error", error);
          },
          onFrame: (frame) => this.emitPackageFrame(frame),
        },
      },
      config: { kind: "cdp" },
      logger(level, event, payload) {
        console[level === "error" ? "warn" : "debug"]("[playground]", event, payload ?? "");
      },
    });
    await this.adapter.mount(this.adapterHost);
  }

  protected async stopDriver(): Promise<void> {
    await this.adapter?.unmount().catch((error: unknown) => {
      if (!isTargetClosedError(error)) {
        throw error;
      }
    });
    this.adapter = null;
    this.adapterHost = null;
  }

  protected async resizeDriver(): Promise<void> {
    await this.enqueue(async () => {
      if (!this.page || !this.adapter) {
        return;
      }
      await this.page.setViewportSize({ height: this.viewport.height, width: this.viewport.width });
      await this.adapter.setViewport(browserViewportPayload(this.viewport));
    });
  }

  protected async applyQuality(): Promise<void> {
    await this.refreshScreencast();
  }

  async refreshScreencast(): Promise<void> {
    if (!this.adapter || !this.adapterHost) {
      return;
    }
    await this.adapter.unmount();
    await this.adapter.mount(this.adapterHost);
  }

  async sendPointer(event: RemotePointerEvent): Promise<void> {
    await this.adapter?.sendPointer(event);
  }

  async sendKeysym(event: RemoteKeysymEvent): Promise<void> {
    await this.adapter?.sendKeysym(event);
  }

  async sendText(text: string): Promise<void> {
    if (!text) {
      return;
    }
    await this.adapter?.sendText(text);
  }

  async pasteText(text: string): Promise<boolean> {
    return await this.adapter?.pasteText(text) ?? false;
  }

  async copyRemoteSelection(): Promise<boolean> {
    return await this.adapter?.copyRemoteSelection() ?? false;
  }

  async dispatchRawKey(key: string, code: string, modifiers = 0): Promise<void> {
    const text = key.length === 1 ? key : undefined;
    const windowsVirtualKeyCode = KEY_TO_VIRTUAL_CODE[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
    await this.dispatchKey({
      type: text ? "keyDown" : "rawKeyDown",
      key,
      code,
      modifiers,
      windowsVirtualKeyCode,
      ...(text ? { text } : {}),
    });
    await this.dispatchKey({
      type: "keyUp",
      key,
      code,
      modifiers,
      windowsVirtualKeyCode,
    });
  }

  private createPackageTransport(cdp: CDPSession): CdpCommandTransport {
    return {
      on: (eventName, handler) => this.subscribeCdp(cdp, eventName, handler),
      send: async <Result = unknown>(method: string, params?: CdpCommandParams): Promise<Result> => {
        this.recordCdpCommand(method, params);
        return await sendCdp<Result>(cdp, method, params);
      },
    };
  }

  private subscribeCdp(cdp: CDPSession, eventName: string, handler: (params: unknown) => void): CdpTransportSubscription {
    onCdp(cdp, eventName, handler);
    return {
      unsubscribe() {
        const emitter = cdp as unknown as {
          off?: (event: string, listener: (params: unknown) => void) => void;
          removeListener?: (event: string, listener: (params: unknown) => void) => void;
        };
        if (emitter.off) {
          emitter.off(eventName, handler);
          return;
        }
        emitter.removeListener?.(eventName, handler);
      },
    };
  }

  private createAdapterHost(): HTMLElement {
    const getRect = () => ({
      bottom: this.viewport.height,
      height: this.viewport.height,
      left: 0,
      right: this.viewport.width,
      top: 0,
      width: this.viewport.width,
      x: 0,
      y: 0,
      toJSON() {
        return this;
      },
    });
    return {
      addEventListener() {
        /* no DOM in the Node playground driver */
      },
      getBoundingClientRect: getRect,
      removeEventListener() {
        /* no DOM in the Node playground driver */
      },
    } as unknown as HTMLElement;
  }

  private emitPackageFrame(frame: CdpSurfaceFrame): void {
    this.frameHandler?.({
      data: frame.data,
      metadata: { ...this.viewportMetadata(), ...(frame.metadata ?? {}) },
      sessionId: frame.sessionId,
      byteLength: byteLengthFromBase64(frame.data),
      receivedAt: frame.timestamp,
    });
  }
}

export class LegacyCdpPlaygroundSurface extends BaseCdpPlaygroundSurface {
  private screencastRunning = false;

  constructor(probeUrl: string) {
    super("legacy", probeUrl);
  }

  protected async startDriver(): Promise<void> {
    if (!this.cdp) {
      return;
    }
    await this.cdp.send("Page.enable");
    onCdp(this.cdp, "Page.screencastFrame", (params) => {
      const record = params as { data?: unknown; metadata?: unknown; sessionId?: unknown };
      const data = typeof record.data === "string" ? record.data : "";
      this.frameHandler?.({
        data,
        metadata: { ...this.viewportMetadata(), ...(isRecord(record.metadata) ? record.metadata : {}) },
        sessionId: Number(record.sessionId),
        byteLength: byteLengthFromBase64(data),
        receivedAt: Date.now(),
      });
      void (this.cdp ? sendCdp(this.cdp, "Page.screencastFrameAck", { sessionId: Number(record.sessionId) }) : Promise.resolve()).catch((error: unknown) => {
        if (!isTargetClosedError(error)) {
          console.warn("[playground] screencast ack failed", error);
        }
      });
    });
    await this.startScreencast();
  }

  protected async stopDriver(): Promise<void> {
    await this.stopScreencast();
  }

  protected async resizeDriver(): Promise<void> {
    await this.enqueue(async () => {
      if (!this.cdp || !this.page) {
        return;
      }
      await this.page.setViewportSize({ height: this.viewport.height, width: this.viewport.width });
      await this.cdp.send("Emulation.setDeviceMetricsOverride", {
        deviceScaleFactor: this.viewport.deviceScaleFactor,
        height: this.viewport.height,
        mobile: this.viewport.mobile,
        positionX: 0,
        positionY: 0,
        screenHeight: this.viewport.height,
        screenOrientation: this.viewport.height >= this.viewport.width
          ? { angle: 0, type: "portraitPrimary" }
          : { angle: 90, type: "landscapePrimary" },
        screenWidth: this.viewport.width,
        width: this.viewport.width,
      });
      await this.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      await this.cdp.send("Emulation.setEmitTouchEventsForMouse", {
        configuration: this.viewport.mobile ? "mobile" : "desktop",
        enabled: true,
      });
    });
    await this.refreshScreencast();
  }

  protected async applyQuality(): Promise<void> {
    await this.refreshScreencast();
  }

  async refreshScreencast(): Promise<void> {
    await this.stopScreencast();
    await this.startScreencast();
  }

  async sendPointer(event: RemotePointerEvent): Promise<void> {
    await this.enqueue(async () => {
      if (!this.cdp) {
        return;
      }
      const button = event.button === 1 ? "middle" : event.button === 2 ? "right" : "left";
      const type = event.type === "pointerdown"
        ? "mousePressed"
        : event.type === "pointerup" || event.type === "pointercancel"
          ? "mouseReleased"
          : "mouseMoved";
      const params = {
        button: type === "mouseMoved" ? "none" : button,
        buttons: event.type === "pointerdown" || event.type === "pointermove" ? 1 : 0,
        clickCount: event.type === "pointerdown" || event.type === "pointerup" ? 1 : 0,
        type,
        x: event.x,
        y: event.y,
      };
      this.recordCdpCommand("Input.dispatchMouseEvent", params);
      await sendCdp(this.cdp, "Input.dispatchMouseEvent", params);
    });
  }

  async sendKeysym(event: RemoteKeysymEvent): Promise<void> {
    const key = KEYSYM_TO_KEY[event.keysym];
    if (!key) {
      return;
    }
    await this.dispatchKey({
      type: event.type === "keydown" ? "keyDown" : "keyUp",
      key: key.key,
      code: key.code,
      windowsVirtualKeyCode: key.virtualKeyCode,
      ...(event.type === "keydown" && key.key === "Enter" ? { text: "\r" } : {}),
    });
  }

  async sendText(text: string): Promise<void> {
    if (!text) {
      return;
    }
    await this.enqueue(async () => {
      this.recordCdpCommand("Input.insertText", { text });
      if (this.cdp) {
        await sendCdp(this.cdp, "Input.insertText", { text });
      }
    });
  }

  async pasteText(text: string): Promise<boolean> {
    await this.sendText(text);
    return true;
  }

  async copyRemoteSelection(): Promise<boolean> {
    return false;
  }

  async dispatchRawKey(key: string, code: string, modifiers = 0): Promise<void> {
    const text = key.length === 1 ? key : undefined;
    const windowsVirtualKeyCode = KEY_TO_VIRTUAL_CODE[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
    await this.dispatchKey({
      type: text ? "keyDown" : "rawKeyDown",
      key,
      code,
      modifiers,
      windowsVirtualKeyCode,
      ...(text ? { text } : {}),
    });
    await this.dispatchKey({
      type: "keyUp",
      key,
      code,
      modifiers,
      windowsVirtualKeyCode,
    });
  }

  private async startScreencast(): Promise<void> {
    if (!this.cdp || this.screencastRunning) {
      return;
    }
    await this.cdp.send("Page.startScreencast", {
      everyNthFrame: 1,
      format: "jpeg",
      maxHeight: this.viewport.height,
      maxWidth: this.viewport.width,
      quality: this.quality,
    });
    this.screencastRunning = true;
  }

  private async stopScreencast(): Promise<void> {
    if (!this.cdp || !this.screencastRunning) {
      return;
    }
    await this.cdp.send("Page.stopScreencast").catch(() => undefined);
    this.screencastRunning = false;
  }
}

export function createCdpPlaygroundSurface(
  probeUrl: string,
  driverKind: PlaygroundDriverKind,
): CdpPlaygroundSurfaceDriver {
  return driverKind === "legacy"
    ? new LegacyCdpPlaygroundSurface(probeUrl)
    : new PackageCdpPlaygroundSurface(probeUrl);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
