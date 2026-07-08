import type {
  FocusTextInputOptions,
  RemoteKeysymEvent,
  RemotePointerEvent,
  RemoteSurface,
  RemoteSurfaceConfig,
  RemoteSurfaceLifecycleState,
} from "../types.ts";
import { pointToStreamViewport } from "../client/geometry.ts";
import type { RemoteSurfaceViewportPayload } from "../protocol/index.ts";
import {
  applyCdpViewport,
  type CdpCommandTransport,
  dispatchCdpKeyboardInput,
  dispatchCdpPointerInput,
  insertCdpText,
  keysymToCdpKey,
} from "../backends/cdp/index.ts";
import type { RemoteSurfaceLogger } from "./neko-surface-adapter.ts";

export type CdpSurfaceConfig = Extract<RemoteSurfaceConfig, { kind: "cdp" }>;

export interface CdpSurfaceViewportInfo {
  deviceScaleFactor?: number;
  height: number;
  hasTouch?: boolean;
  mobile?: boolean;
  orientation?: "portrait" | "landscape";
  screenHeight?: number;
  screenWidth?: number;
  width: number;
}

export interface CdpSurfaceRect {
  height: number;
  left: number;
  top: number;
  width: number;
}

export interface CdpSurfaceClipboardPolicy {
  canForwardNativePasteEvent: boolean;
  canReadRemoteSelection?: boolean;
}

export interface CdpSurfaceFrame {
  contentType: "image/jpeg" | "image/png";
  data: string;
  metadata?: Record<string, unknown>;
  sequence: number;
  sessionId: number;
  timestamp: number;
}

export interface CdpSurfaceMediaSink {
  onFrame(frame: CdpSurfaceFrame): Promise<void> | void;
  onError?(error: Error): Promise<void> | void;
}

export interface CdpSurfaceRemoteFocusTarget {
  /**
   * Raw Runtime.evaluate is visible to page-level detection in ways that the
   * strict n.eko path avoids. Use this backend only for non-strict-stealth
   * sessions where CDP page interaction is an accepted tradeoff.
   */
  expression?: string;
  selector?: string;
}

export interface CdpSurfaceClipboardSink {
  writeText(text: string): Promise<void> | void;
}

export interface CdpSurfaceClientApi {
  cdp: CdpCommandTransport;
  getViewportInfo(): CdpSurfaceViewportInfo | null;
  mediaSink: CdpSurfaceMediaSink;
  clipboardSink?: CdpSurfaceClipboardSink;
  getFrameElement?(): { getBoundingClientRect(): CdpSurfaceRect } | null;
  getClipboardPolicy?(): CdpSurfaceClipboardPolicy;
  getRemoteFocusTarget?(opts?: FocusTextInputOptions): CdpSurfaceRemoteFocusTarget | null;
  getSoftKeyboardElement?(): { focus(): void } | null;
  onInputDebug?(event: string, payload?: Record<string, unknown>): void;
}

export interface CdpSurfaceAdapterDeps {
  client: CdpSurfaceClientApi;
  config: CdpSurfaceConfig;
  logger?: RemoteSurfaceLogger;
}

const noopLogger: RemoteSurfaceLogger = () => {
  /* no-op */
};

const MOTION_THROTTLE_MS = 33;
const SYNTHETIC_MOUSE_SUPPRESSION_MS = 1000;
const TOUCH_DRAG_THRESHOLD_PX = 8;

interface ActiveTouchGesture {
  dragging: boolean;
  identifier: number;
  lastClientX: number;
  lastClientY: number;
  pressed: boolean;
  startClientX: number;
  startClientY: number;
}

export class CdpSurfaceAdapter implements RemoteSurface {
  private container: HTMLElement | null = null;
  private lifecycleState: RemoteSurfaceLifecycleState = "idle";
  private readonly client: CdpSurfaceClientApi;
  private readonly config: CdpSurfaceConfig;
  private readonly log: RemoteSurfaceLogger;
  private frameSequence = 0;
  private screencastStarted = false;
  private screencastSubscription: { unsubscribe(): void } | null = null;
  private disposeDomListeners: (() => void) | null = null;
  private motionThrottle: {
    mousePendingCoords: { x: number; y: number } | null;
    mouseTimeoutId: ReturnType<typeof setTimeout> | null;
  } = {
    mousePendingCoords: null,
    mouseTimeoutId: null,
  };
  private activeTouchGesture: ActiveTouchGesture | null = null;
  private suppressMouseUntil = 0;

  constructor(deps: CdpSurfaceAdapterDeps) {
    this.client = deps.client;
    this.config = deps.config;
    this.log = deps.logger ?? noopLogger;
    void this.config;
  }

  /** Test/inspection hook; not part of RemoteSurface. */
  getLifecycleState(): RemoteSurfaceLifecycleState {
    return this.lifecycleState;
  }

  async mount(el: HTMLElement): Promise<void> {
    if (this.lifecycleState !== "idle") {
      if (this.lifecycleState === "mounted") {
        return;
      }
      throw new Error(`CdpSurfaceAdapter.mount: invalid state ${this.lifecycleState}; expected idle`);
    }
    this.lifecycleState = "mounting";
    this.container = el;
    try {
      this.screencastSubscription = this.client.cdp.on("Page.screencastFrame", (params) => {
        void this.handleScreencastFrame(params);
      });
      const viewport = this.client.getViewportInfo();
      if (viewport) {
        await this.setViewport(viewport);
      }
      await this.client.cdp.send("Page.enable");
      await this.client.cdp.send("Page.startScreencast", {
        everyNthFrame: 1,
        format: "jpeg",
        quality: 80,
      });
      this.screencastStarted = true;
      this.attachDomListeners(el);
      this.lifecycleState = "mounted";
      this.log("info", "cdp-surface-adapter.mounted");
    } catch (error) {
      if (this.screencastStarted) {
        try {
          await this.client.cdp.send("Page.stopScreencast");
          this.screencastStarted = false;
        } catch (stopError) {
          await this.reportError(stopError);
        }
      }
      this.screencastSubscription?.unsubscribe();
      this.screencastSubscription = null;
      this.disposeDomListeners?.();
      this.disposeDomListeners = null;
      this.clearMotionThrottle();
      this.container = null;
      this.lifecycleState = "error";
      this.log("error", "cdp-surface-adapter.mount-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async unmount(): Promise<void> {
    if (this.lifecycleState === "idle") {
      return;
    }
    if (this.lifecycleState === "unmounting") {
      throw new Error("CdpSurfaceAdapter.unmount: already unmounting");
    }
    this.lifecycleState = "unmounting";
    this.disposeDomListeners?.();
    this.disposeDomListeners = null;
    this.screencastSubscription?.unsubscribe();
    this.screencastSubscription = null;
    this.clearMotionThrottle();
    if (this.screencastStarted) {
      await this.client.cdp.send("Page.stopScreencast");
      this.screencastStarted = false;
    }
    this.container = null;
    this.frameSequence = 0;
    this.lifecycleState = "idle";
    this.log("info", "cdp-surface-adapter.unmounted");
  }

  focusTextInput(opts?: FocusTextInputOptions): void {
    this.ensureMounted("focusTextInput");
    if (this.isCoarsePointer()) {
      const input = this.client.getSoftKeyboardElement?.() ?? null;
      input?.focus();
      this.debug("surface.cdp-frame.soft_keyboard.focus", { active: true });
    } else {
      this.debug("surface.cdp-frame.soft_keyboard.skip", { reason: "fine-pointer" });
    }
    this.reportAsync(this.focusRemoteTextInput(opts));
  }

  blurTextInput(): void {
    this.ensureMounted("blurTextInput");
  }

  setRemoteInputFocused(_focused: boolean): void {
    this.ensureMounted("setRemoteInputFocused");
  }

  async sendPointer(event: RemotePointerEvent): Promise<void> {
    this.ensureMounted("sendPointer");
    await dispatchCdpPointerInput(this.client.cdp, {
      action: event.type,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      type: "pointer",
      x: event.x,
      y: event.y,
      ...(event.button === undefined ? {} : { button: event.button }),
    });
  }

  async setViewport(viewport: CdpSurfaceViewportInfo | RemoteSurfaceViewportPayload): Promise<void> {
    await applyCdpViewport(this.client.cdp, toViewportPayload(viewport));
  }

  async sendKeysym(event: RemoteKeysymEvent): Promise<void> {
    this.ensureMounted("sendKeysym");
    const key = keysymToCdpKey(event.keysym);
    await dispatchCdpKeyboardInput(this.client.cdp, {
      action: event.type,
      code: key.code,
      key: key.key,
      keysym: event.keysym,
      type: "keyboard",
    });
  }

  async sendText(text: string): Promise<void> {
    this.ensureMounted("sendText");
    await insertCdpText(this.client.cdp, text);
  }

  async pasteText(text: string): Promise<boolean> {
    this.ensureMounted("pasteText");
    if (text.length === 0) {
      return false;
    }
    await insertCdpText(this.client.cdp, text);
    return true;
  }

  async copyRemoteSelection(): Promise<boolean> {
    this.ensureMounted("copyRemoteSelection");
    const policy = this.client.getClipboardPolicy?.();
    if (policy?.canReadRemoteSelection === false || !this.client.clipboardSink) {
      return false;
    }
    const result = await this.client.cdp.send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
      awaitPromise: true,
      expression: "String(globalThis.getSelection?.() ?? '')",
      returnByValue: true,
    });
    const text = typeof result.result?.value === "string" ? result.result.value : "";
    if (text.length === 0) {
      return false;
    }
    await this.client.clipboardSink.writeText(text);
    return true;
  }

  private async handleScreencastFrame(params: unknown): Promise<void> {
    try {
      const frame = parseScreencastFrame(params);
      await this.client.cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
      this.frameSequence += 1;
      await this.client.mediaSink.onFrame({
        contentType: "image/jpeg",
        data: frame.data,
        ...(frame.metadata ? { metadata: frame.metadata } : {}),
        sequence: this.frameSequence,
        sessionId: frame.sessionId,
        timestamp: Date.now(),
      });
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error("CDP screencast frame handling failed");
      await this.client.mediaSink.onError?.(normalized);
    }
  }

  private async focusRemoteTextInput(opts?: FocusTextInputOptions): Promise<void> {
    const target = this.client.getRemoteFocusTarget?.(opts) ?? null;
    if (!target) {
      return;
    }
    const expression =
      target.expression ??
      `(() => {
        const element = document.querySelector(${JSON.stringify(target.selector ?? "")});
        if (element instanceof HTMLElement) {
          element.focus({ preventScroll: true });
          return true;
        }
        return false;
      })()`;
    await this.client.cdp.send("Runtime.evaluate", {
      awaitPromise: true,
      expression,
      returnByValue: true,
    });
  }

  private async sendPointerFromLocal(
    action: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
    event: { button?: number; clientX: number; clientY: number },
    pointerType: "mouse" | "touch" | "pen",
    pointerId = 0
  ): Promise<void> {
    const coords = this.localCoords(event);
    if (!coords) {
      return;
    }
    await dispatchCdpPointerInput(this.client.cdp, {
      action,
      pointerId,
      pointerType,
      type: "pointer",
      x: coords.x,
      y: coords.y,
      ...(event.button === undefined ? {} : { button: event.button }),
    });
  }

  private async sendWheelFromLocal(event: WheelEvent): Promise<void> {
    const coords = this.localCoords(event);
    if (!coords) {
      return;
    }
    await dispatchCdpPointerInput(this.client.cdp, {
      action: "wheel",
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      pointerType: "mouse",
      type: "pointer",
      x: coords.x,
      y: coords.y,
    });
  }

  private async sendMouseFromLocal(
    action: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
    event: { clientX: number; clientY: number },
    opts: { buttons?: number } = {}
  ): Promise<void> {
    const coords = this.localCoords(event);
    if (!coords) {
      return;
    }
    await dispatchCdpPointerInput(this.client.cdp, {
      action,
      button: 0,
      pointerType: "mouse",
      type: "pointer",
      x: coords.x,
      y: coords.y,
      ...(opts.buttons === undefined ? {} : { buttons: opts.buttons }),
    });
  }

  private async blurRemoteActiveElement(): Promise<void> {
    await this.client.cdp.send("Runtime.evaluate", {
      awaitPromise: true,
      expression: `(() => {
        const active = document.activeElement;
        if (active instanceof HTMLElement && active !== document.body) {
          active.blur();
          return true;
        }
        return false;
      })()`,
      returnByValue: true,
    });
  }

  private async sendKeyboardEvent(event: KeyboardEvent): Promise<void> {
    await dispatchCdpKeyboardInput(this.client.cdp, {
      action: event.type === "keyup" ? "keyup" : "keydown",
      code: event.code,
      key: event.key,
      modifiers: keyboardModifiers(event),
      type: "keyboard",
    });
  }

  private async sendPasteEvent(event: ClipboardEvent): Promise<void> {
    if (!this.client.getClipboardPolicy?.().canForwardNativePasteEvent) {
      this.debug("surface.cdp-frame.clipboard.paste", { phase: "skipped", reason: "policy-denied" });
      return;
    }
    const text = event.clipboardData?.getData("text") ?? "";
    this.debug("surface.cdp-frame.clipboard.paste", { length: text.length, phase: "native-paste" });
    await insertCdpText(this.client.cdp, text);
  }

  private attachDomListeners(node: HTMLElement): void {
    const markTouchActivity = () => {
      this.suppressMouseUntil = Date.now() + SYNTHETIC_MOUSE_SUPPRESSION_MS;
    };

    const isMouseSuppressed = () => Date.now() < this.suppressMouseUntil;

    const changedTouchForActiveGesture = (event: TouchEvent): Touch | null => {
      const active = this.activeTouchGesture;
      if (!active) {
        return event.changedTouches[0] ?? null;
      }
      for (const touch of Array.from(event.changedTouches)) {
        if (touch.identifier === active.identifier) {
          return touch;
        }
      }
      return event.changedTouches[0] ?? null;
    };

    const onMouseMove = (event: MouseEvent) => {
      if (isMouseSuppressed()) {
        return;
      }
      const coords = this.localCoords(event);
      if (!coords) {
        return;
      }
      const state = this.motionThrottle;
      state.mousePendingCoords = coords;
      if (state.mouseTimeoutId) {
        return;
      }
      this.reportAsync(dispatchCdpPointerInput(this.client.cdp, {
        action: "pointermove",
        pointerType: "mouse",
        type: "pointer",
        x: coords.x,
        y: coords.y,
      }));
      state.mouseTimeoutId = setTimeout(() => {
        state.mouseTimeoutId = null;
        if (!state.mousePendingCoords) {
          return;
        }
        const pending = state.mousePendingCoords;
        state.mousePendingCoords = null;
        this.reportAsync(dispatchCdpPointerInput(this.client.cdp, {
          action: "pointermove",
          pointerType: "mouse",
          type: "pointer",
          x: pending.x,
          y: pending.y,
        }));
      }, MOTION_THROTTLE_MS);
    };

    const onMouseDown = (event: MouseEvent) => {
      if (isMouseSuppressed()) {
        return;
      }
      this.reportAsync(this.sendPointerFromLocal("pointerdown", event, "mouse"));
    };

    const onMouseUp = (event: MouseEvent) => {
      if (isMouseSuppressed()) {
        return;
      }
      this.reportAsync(this.sendPointerFromLocal("pointerup", event, "mouse"));
    };

    const onTouchStart = (event: TouchEvent) => {
      event.preventDefault();
      markTouchActivity();
      const touch = event.changedTouches[0] ?? event.touches[0] ?? null;
      if (!touch) {
        return;
      }
      this.reportAsync(this.blurRemoteActiveElement());
      node.focus({ preventScroll: true });
      this.activeTouchGesture = {
        dragging: false,
        identifier: touch.identifier,
        lastClientX: touch.clientX,
        lastClientY: touch.clientY,
        pressed: false,
        startClientX: touch.clientX,
        startClientY: touch.clientY,
      };
    };

    const onTouchMove = (event: TouchEvent) => {
      event.preventDefault();
      markTouchActivity();
      const active = this.activeTouchGesture;
      if (!active) {
        return;
      }
      const changed = changedTouchForActiveGesture(event);
      if (!changed) {
        return;
      }
      active.lastClientX = changed.clientX;
      active.lastClientY = changed.clientY;

      const distance = Math.hypot(
        changed.clientX - active.startClientX,
        changed.clientY - active.startClientY,
      );
      if (!active.dragging && distance < TOUCH_DRAG_THRESHOLD_PX) {
        return;
      }
      if (!active.pressed) {
        this.reportAsync(this.sendMouseFromLocal("pointerdown", {
          clientX: active.startClientX,
          clientY: active.startClientY,
        }));
        active.pressed = true;
      }
      active.dragging = true;
      this.reportAsync(this.sendMouseFromLocal("pointermove", changed, { buttons: 1 }));
    };

    const onTouchEnd = (event: TouchEvent) => {
      event.preventDefault();
      markTouchActivity();
      const active = this.activeTouchGesture;
      if (!active) {
        return;
      }
      const changed = changedTouchForActiveGesture(event);
      this.activeTouchGesture = null;
      const endPoint = {
        clientX: changed?.clientX ?? active.lastClientX,
        clientY: changed?.clientY ?? active.lastClientY,
      };

      if (event.type === "touchcancel") {
        if (active.pressed) {
          this.reportAsync(this.sendMouseFromLocal("pointercancel", endPoint));
        }
        return;
      }
      if (active.dragging) {
        if (active.pressed) {
          this.reportAsync(this.sendMouseFromLocal("pointerup", endPoint));
        }
        return;
      }

      this.reportAsync((async () => {
        await this.sendMouseFromLocal("pointerdown", endPoint);
        await this.sendMouseFromLocal("pointerup", endPoint);
      })());
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        return;
      }
      event.preventDefault();
      const action = event.type === "keyup" ? "keyup" : "keydown";
      this.debug("surface.cdp-frame.keyboard.forward", {
        action,
        code: event.code,
        key: event.key,
      });
      this.reportAsync(this.sendKeyboardEvent(event));
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const coords = this.localCoords(event);
      if (!coords) {
        return;
      }
      this.reportAsync(this.sendWheelFromLocal(event));
    };

    const onPaste = (event: ClipboardEvent) => {
      event.preventDefault();
      this.reportAsync(this.sendPasteEvent(event));
    };

    node.addEventListener("mousemove", onMouseMove);
    node.addEventListener("mousedown", onMouseDown);
    node.addEventListener("mouseup", onMouseUp);
    node.addEventListener("touchstart", onTouchStart);
    node.addEventListener("touchmove", onTouchMove);
    node.addEventListener("touchend", onTouchEnd);
    node.addEventListener("touchcancel", onTouchEnd);
    node.addEventListener("keydown", onKey);
    node.addEventListener("keyup", onKey);
    node.addEventListener("wheel", onWheel, { passive: false });
    node.addEventListener("paste", onPaste);

    this.disposeDomListeners = () => {
      node.removeEventListener("mousemove", onMouseMove);
      node.removeEventListener("mousedown", onMouseDown);
      node.removeEventListener("mouseup", onMouseUp);
      node.removeEventListener("touchstart", onTouchStart);
      node.removeEventListener("touchmove", onTouchMove);
      node.removeEventListener("touchend", onTouchEnd);
      node.removeEventListener("touchcancel", onTouchEnd);
      node.removeEventListener("keydown", onKey);
      node.removeEventListener("keyup", onKey);
      node.removeEventListener("wheel", onWheel);
      node.removeEventListener("paste", onPaste);
    };
  }

  private localCoords(event: { clientX: number; clientY: number }): { x: number; y: number } | null {
    const node = this.container;
    const viewport = this.client.getViewportInfo();
    if (!node || !viewport) {
      return null;
    }
    return pointToStreamViewport(event, {
      containerBox: node.getBoundingClientRect(),
      imageBox: this.client.getFrameElement?.()?.getBoundingClientRect() ?? null,
      viewport,
    });
  }

  private isCoarsePointer(): boolean {
    if (typeof window === "undefined") {
      return false;
    }
    try {
      return window.matchMedia("(pointer: coarse)").matches;
    } catch {
      this.debug("surface.cdp-frame.soft_keyboard.skip", { reason: "match-media-error" });
      return false;
    }
  }

  private clearMotionThrottle(): void {
    if (this.motionThrottle.mouseTimeoutId) {
      clearTimeout(this.motionThrottle.mouseTimeoutId);
    }
    this.motionThrottle = {
      mousePendingCoords: null,
      mouseTimeoutId: null,
    };
    this.activeTouchGesture = null;
  }

  private debug(event: string, payload?: Record<string, unknown>): void {
    this.client.onInputDebug?.(event, payload);
  }

  private reportAsync(work: Promise<void>): void {
    void work.catch((error: unknown) => {
      void this.reportError(error);
    });
  }

  private async reportError(error: unknown): Promise<void> {
    const normalized = error instanceof Error ? error : new Error("CDP asynchronous command failed");
    await Promise.resolve(this.client.mediaSink.onError?.(normalized)).catch(() => {
      /* swallow secondary reporting failure */
    });
  }

  private ensureMounted(method: string): void {
    if (this.lifecycleState !== "mounted") {
      throw new Error(`CdpSurfaceAdapter.${method}: invalid state ${this.lifecycleState}; expected mounted`);
    }
  }
}

function toViewportPayload(viewport: CdpSurfaceViewportInfo | RemoteSurfaceViewportPayload): RemoteSurfaceViewportPayload {
  if ("type" in viewport) {
    return viewport;
  }
  return {
    type: "viewport",
    width: viewport.width,
    height: viewport.height,
    ...(viewport.deviceScaleFactor === undefined ? {} : { deviceScaleFactor: viewport.deviceScaleFactor }),
    ...(viewport.screenWidth === undefined ? {} : { screenWidth: viewport.screenWidth }),
    ...(viewport.screenHeight === undefined ? {} : { screenHeight: viewport.screenHeight }),
    ...(viewport.hasTouch === undefined ? {} : { hasTouch: viewport.hasTouch }),
    ...(viewport.mobile === undefined ? {} : { mobile: viewport.mobile }),
    ...(viewport.orientation === undefined ? {} : { orientation: viewport.orientation }),
  };
}

function keyboardModifiers(event: KeyboardEvent): Array<"Alt" | "Control" | "Meta" | "Shift"> {
  const modifiers: Array<"Alt" | "Control" | "Meta" | "Shift"> = [];
  if (event.altKey) {
    modifiers.push("Alt");
  }
  if (event.ctrlKey) {
    modifiers.push("Control");
  }
  if (event.metaKey) {
    modifiers.push("Meta");
  }
  if (event.shiftKey) {
    modifiers.push("Shift");
  }
  return modifiers;
}

function parseScreencastFrame(params: unknown): {
  data: string;
  metadata?: Record<string, unknown>;
  sessionId: number;
} {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("Page.screencastFrame payload must be an object");
  }
  const record = params as Record<string, unknown>;
  if (typeof record.data !== "string" || typeof record.sessionId !== "number") {
    throw new Error("Page.screencastFrame payload missing data or sessionId");
  }
  return {
    data: record.data,
    ...(isRecord(record.metadata) ? { metadata: record.metadata } : {}),
    sessionId: record.sessionId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
