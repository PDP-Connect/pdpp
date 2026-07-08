import type { FocusTextInputOptions, RemoteKeysymEvent, RemotePointerEvent, RemoteSurface, RemoteSurfaceConfig, RemoteSurfaceLifecycleState } from "../types.ts";
import type { RemoteSurfaceViewportPayload } from "../protocol/index.ts";
import { type CdpCommandTransport } from "../backends/cdp/index.ts";
import type { RemoteSurfaceLogger } from "./neko-surface-adapter.ts";
export type CdpSurfaceConfig = Extract<RemoteSurfaceConfig, {
    kind: "cdp";
}>;
export type CdpInputPayload = {
    type: "mouse";
    action: "mousemove" | "mousedown" | "mouseup";
    x: number;
    y: number;
    button?: number;
} | {
    type: "touch";
    action: "touchstart" | "touchmove" | "touchend";
    x: number;
    y: number;
    id?: number;
} | {
    type: "keyboard";
    action: "keydown" | "keyup";
    key: string;
    code: string;
    modifiers: number;
} | {
    type: "scroll";
    x: number;
    y: number;
    deltaX: number;
    deltaY: number;
} | {
    type: "paste";
    text: string;
};
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
export interface DirectCdpSurfaceClientApi {
    cdp: CdpCommandTransport;
    getViewportInfo(): CdpSurfaceViewportInfo | null;
    mediaSink: CdpSurfaceMediaSink;
    clipboardSink?: CdpSurfaceClipboardSink;
    getFrameElement?(): {
        getBoundingClientRect(): CdpSurfaceRect;
    } | null;
    getClipboardPolicy?(): CdpSurfaceClipboardPolicy;
    getRemoteFocusTarget?(opts?: FocusTextInputOptions): CdpSurfaceRemoteFocusTarget | null;
    getSoftKeyboardElement?(): {
        focus(): void;
    } | null;
    onInputDebug?(event: string, payload?: Record<string, unknown>): void;
}
export interface LegacyCdpSurfaceClientApi {
    sendInput(payload: CdpInputPayload): Promise<void> | void;
    getViewportInfo(): CdpSurfaceViewportInfo | null;
    getFrameElement?(): {
        getBoundingClientRect(): CdpSurfaceRect;
    } | null;
    getClipboardPolicy?(): CdpSurfaceClipboardPolicy;
    getSoftKeyboardElement?(): {
        focus(): void;
    } | null;
    onInputDebug?(event: string, payload?: Record<string, unknown>): void;
}
export type CdpSurfaceClientApi = DirectCdpSurfaceClientApi | LegacyCdpSurfaceClientApi;
export interface CdpSurfaceAdapterDeps {
    client: CdpSurfaceClientApi;
    config: CdpSurfaceConfig;
    logger?: RemoteSurfaceLogger;
}
export declare class CdpSurfaceAdapter implements RemoteSurface {
    private container;
    private lifecycleState;
    private readonly client;
    private readonly config;
    private readonly log;
    private frameSequence;
    private screencastStarted;
    private screencastSubscription;
    private disposeDomListeners;
    private motionThrottle;
    private activeTouchGesture;
    private suppressMouseUntil;
    constructor(deps: CdpSurfaceAdapterDeps);
    /** Test/inspection hook; not part of RemoteSurface. */
    getLifecycleState(): RemoteSurfaceLifecycleState;
    mount(el: HTMLElement): Promise<void>;
    unmount(): Promise<void>;
    focusTextInput(opts?: FocusTextInputOptions): void;
    blurTextInput(): void;
    setRemoteInputFocused(_focused: boolean): void;
    sendPointer(event: RemotePointerEvent): Promise<void>;
    setViewport(viewport: CdpSurfaceViewportInfo | RemoteSurfaceViewportPayload): Promise<void>;
    sendKeysym(event: RemoteKeysymEvent): Promise<void>;
    sendText(text: string): Promise<void>;
    pasteText(text: string): Promise<boolean>;
    copyRemoteSelection(): Promise<boolean>;
    private handleScreencastFrame;
    private focusRemoteTextInput;
    private sendPointerFromLocal;
    private sendWheelFromLocal;
    private sendMouseFromLocal;
    private blurRemoteActiveElement;
    private sendKeyboardEvent;
    private sendPasteEvent;
    private attachLegacyDomListeners;
    private attachDomListeners;
    private localCoords;
    private firstChangedTouch;
    private isCoarsePointer;
    private clearMotionThrottle;
    private debug;
    private reportAsync;
    private reportError;
    private directClient;
    private ensureMounted;
}
//# sourceMappingURL=cdp-surface-adapter.d.ts.map