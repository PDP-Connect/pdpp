// CdpSurfaceAdapter — fallback / legacy / debug RemoteSurface implementation.
//
// TODO(remote-surface): wrap the existing BrowserSurface + cdp-adapter path
// used by the current dashboard streaming viewer. Keep this adapter behind a
// feature flag once NekoSurfaceAdapter is the default; CDP remains useful
// for debugging Playwright captures where n.eko isn't available.
// Reference: §54-62 of docs/5-12-26-chatgpt-remote-surface-brief-response.txt.

import type {
  FocusTextInputOptions,
  RemoteKeysymEvent,
  RemotePointerEvent,
  RemoteSurface,
  RemoteSurfaceConfig,
  RemoteSurfaceLifecycleState,
} from "../types.ts";
import { pointToStreamViewport } from "../client/geometry.ts";
import type { RemoteSurfaceLogger } from "./neko-surface-adapter.ts";

export type CdpSurfaceConfig = Extract<RemoteSurfaceConfig, { kind: "cdp" }>;

export type CdpInputPayload =
  | { type: "mouse"; action: "mousemove" | "mousedown" | "mouseup"; x: number; y: number; button?: number }
  | { type: "touch"; action: "touchstart" | "touchmove" | "touchend"; x: number; y: number; id?: number }
  | { type: "keyboard"; action: "keydown" | "keyup"; key: string; code: string; modifiers: number }
  | { type: "scroll"; x: number; y: number; deltaX: number; deltaY: number }
  | { type: "paste"; text: string };

export interface CdpSurfaceViewportInfo {
  height: number;
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
}

export interface CdpSurfaceClientApi {
  sendInput(payload: CdpInputPayload): Promise<void> | void;
  getViewportInfo(): CdpSurfaceViewportInfo | null;
  getFrameElement?(): { getBoundingClientRect(): CdpSurfaceRect } | null;
  getClipboardPolicy?(): CdpSurfaceClipboardPolicy;
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

export class CdpSurfaceAdapter implements RemoteSurface {
  private container: HTMLElement | null = null;
  private lifecycleState: RemoteSurfaceLifecycleState = "idle";
  private readonly client: CdpSurfaceClientApi;
  private readonly config: CdpSurfaceConfig;
  private readonly log: RemoteSurfaceLogger;
  private disposeDomListeners: (() => void) | null = null;
  private motionThrottle: {
    mousePendingCoords: { x: number; y: number } | null;
    mouseTimeoutId: ReturnType<typeof setTimeout> | null;
    touchPendingTouch: { id: number; x: number; y: number } | null;
    touchTimeoutId: ReturnType<typeof setTimeout> | null;
  } = {
    mousePendingCoords: null,
    mouseTimeoutId: null,
    touchPendingTouch: null,
    touchTimeoutId: null,
  };

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
      throw new Error(`CdpSurfaceAdapter.mount: invalid state ${this.lifecycleState}; expected idle`);
    }
    this.lifecycleState = "mounting";
    this.container = el;
    this.attachDomListeners(el);
    this.lifecycleState = "mounted";
    this.log("info", "cdp-surface-adapter.mounted");
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
    this.clearMotionThrottle();
    this.container = null;
    this.lifecycleState = "idle";
    this.log("info", "cdp-surface-adapter.unmounted");
  }

  focusTextInput(_opts?: FocusTextInputOptions): void {
    this.ensureMounted("focusTextInput");
    if (!this.isCoarsePointer()) {
      this.debug("surface.cdp-frame.soft_keyboard.skip", { reason: "fine-pointer" });
      return;
    }
    const input = this.client.getSoftKeyboardElement?.() ?? null;
    input?.focus();
    this.debug("surface.cdp-frame.soft_keyboard.focus", { active: true });
  }

  blurTextInput(): void {
    this.ensureMounted("blurTextInput");
  }

  setRemoteInputFocused(_focused: boolean): void {
    this.ensureMounted("setRemoteInputFocused");
  }

  async sendPointer(event: RemotePointerEvent): Promise<void> {
    this.ensureMounted("sendPointer");
    if (event.type === "pointermove") {
      await this.client.sendInput({ type: "mouse", action: "mousemove", x: event.x, y: event.y });
      return;
    }
    if (event.type === "pointerdown") {
      await this.client.sendInput({
        type: "mouse",
        action: "mousedown",
        x: event.x,
        y: event.y,
        button: event.button ?? 0,
      });
      return;
    }
    if (event.type === "pointerup" || event.type === "pointercancel") {
      await this.client.sendInput({
        type: "mouse",
        action: "mouseup",
        x: event.x,
        y: event.y,
        button: event.button ?? 0,
      });
    }
  }

  async sendKeysym(event: RemoteKeysymEvent): Promise<void> {
    this.ensureMounted("sendKeysym");
    await this.client.sendInput({
      type: "keyboard",
      action: event.type,
      key: String(event.keysym),
      code: "",
      modifiers: 0,
    });
  }

  async sendText(text: string): Promise<void> {
    this.ensureMounted("sendText");
    if (text.length > 0) {
      await this.client.sendInput({ type: "paste", text });
    }
  }

  async pasteText(text: string): Promise<boolean> {
    this.ensureMounted("pasteText");
    if (text.length === 0) {
      return false;
    }
    await this.client.sendInput({ type: "paste", text });
    return true;
  }

  copyRemoteSelection(): Promise<boolean> {
    this.ensureMounted("copyRemoteSelection");
    return Promise.resolve(false);
  }

  private attachDomListeners(node: HTMLElement): void {
    const onMouseMove = (event: MouseEvent) => {
      const coords = this.localCoords(event);
      if (!coords) {
        return;
      }
      const state = this.motionThrottle;
      state.mousePendingCoords = coords;
      if (state.mouseTimeoutId) {
        return;
      }
      void this.client.sendInput({ type: "mouse", action: "mousemove", x: coords.x, y: coords.y });
      state.mouseTimeoutId = setTimeout(() => {
        state.mouseTimeoutId = null;
        if (!state.mousePendingCoords) {
          return;
        }
        const pending = state.mousePendingCoords;
        state.mousePendingCoords = null;
        void this.client.sendInput({ type: "mouse", action: "mousemove", x: pending.x, y: pending.y });
      }, MOTION_THROTTLE_MS);
    };

    const onMouseDown = (event: MouseEvent) => {
      const coords = this.localCoords(event);
      if (coords) {
        void this.client.sendInput({
          type: "mouse",
          action: "mousedown",
          x: coords.x,
          y: coords.y,
          button: event.button ?? 0,
        });
      }
    };

    const onMouseUp = (event: MouseEvent) => {
      const coords = this.localCoords(event);
      if (coords) {
        void this.client.sendInput({
          type: "mouse",
          action: "mouseup",
          x: coords.x,
          y: coords.y,
          button: event.button ?? 0,
        });
      }
    };

    const onTouchStart = (event: TouchEvent) => {
      this.focusTextInput();
      const touch = this.firstChangedTouch(event);
      if (touch) {
        void this.client.sendInput({ type: "touch", action: "touchstart", x: touch.x, y: touch.y, id: touch.id });
      }
    };

    const onTouchMove = (event: TouchEvent) => {
      const touch = this.firstChangedTouch(event);
      if (!touch) {
        return;
      }
      const state = this.motionThrottle;
      state.touchPendingTouch = touch;
      if (state.touchTimeoutId) {
        return;
      }
      void this.client.sendInput({ type: "touch", action: "touchmove", x: touch.x, y: touch.y, id: touch.id });
      state.touchTimeoutId = setTimeout(() => {
        state.touchTimeoutId = null;
        if (!state.touchPendingTouch) {
          return;
        }
        const pending = state.touchPendingTouch;
        state.touchPendingTouch = null;
        void this.client.sendInput({ type: "touch", action: "touchmove", x: pending.x, y: pending.y, id: pending.id });
      }, MOTION_THROTTLE_MS);
    };

    const onTouchEnd = (event: TouchEvent) => {
      if (this.motionThrottle.touchTimeoutId) {
        clearTimeout(this.motionThrottle.touchTimeoutId);
        this.motionThrottle.touchTimeoutId = null;
      }
      this.motionThrottle.touchPendingTouch = null;
      const touch = this.firstChangedTouch(event);
      if (!touch) {
        void this.client.sendInput({ type: "touch", action: "touchend", x: 0, y: 0 });
        return;
      }
      void this.client.sendInput({ type: "touch", action: "touchend", x: touch.x, y: touch.y, id: touch.id });
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
      void this.client.sendInput({
        type: "keyboard",
        action,
        key: event.key,
        code: event.code,
        modifiers: (event.altKey ? 1 : 0) + (event.ctrlKey ? 2 : 0) + (event.metaKey ? 4 : 0) + (event.shiftKey ? 8 : 0),
      });
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const coords = this.localCoords(event);
      if (!coords) {
        return;
      }
      void this.client.sendInput({
        type: "scroll",
        x: coords.x,
        y: coords.y,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
      });
    };

    const onPaste = (event: ClipboardEvent) => {
      event.preventDefault();
      if (!this.client.getClipboardPolicy?.().canForwardNativePasteEvent) {
        this.debug("surface.cdp-frame.clipboard.paste", { phase: "skipped", reason: "policy-denied" });
        return;
      }
      const text = event.clipboardData?.getData("text") ?? "";
      this.debug("surface.cdp-frame.clipboard.paste", { length: text.length, phase: "native-paste" });
      if (text.length > 0) {
        void this.client.sendInput({ type: "paste", text });
      }
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

  private firstChangedTouch(event: TouchEvent): { id: number; x: number; y: number } | null {
    const touch = event.changedTouches[0];
    if (!touch) {
      return null;
    }
    const coords = this.localCoords({ clientX: touch.clientX, clientY: touch.clientY });
    return coords ? { ...coords, id: touch.identifier } : null;
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
    if (this.motionThrottle.touchTimeoutId) {
      clearTimeout(this.motionThrottle.touchTimeoutId);
    }
    this.motionThrottle = {
      mousePendingCoords: null,
      mouseTimeoutId: null,
      touchPendingTouch: null,
      touchTimeoutId: null,
    };
  }

  private debug(event: string, payload?: Record<string, unknown>): void {
    this.client.onInputDebug?.(event, payload);
  }

  private ensureMounted(method: string): void {
    if (this.lifecycleState !== "mounted") {
      throw new Error(`CdpSurfaceAdapter.${method}: invalid state ${this.lifecycleState}; expected mounted`);
    }
  }
}
