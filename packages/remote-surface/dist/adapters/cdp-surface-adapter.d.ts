import type { FocusTextInputOptions, RemoteKeysymEvent, RemotePointerEvent, RemoteSurface, RemoteSurfaceConfig, RemoteSurfaceLifecycleState } from "../types.ts";
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
    getFrameElement?(): {
        getBoundingClientRect(): CdpSurfaceRect;
    } | null;
    getClipboardPolicy?(): CdpSurfaceClipboardPolicy;
    getSoftKeyboardElement?(): {
        focus(): void;
    } | null;
    onInputDebug?(event: string, payload?: Record<string, unknown>): void;
}
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
    private disposeDomListeners;
    private motionThrottle;
    constructor(deps: CdpSurfaceAdapterDeps);
    /** Test/inspection hook; not part of RemoteSurface. */
    getLifecycleState(): RemoteSurfaceLifecycleState;
    mount(el: HTMLElement): Promise<void>;
    unmount(): Promise<void>;
    focusTextInput(_opts?: FocusTextInputOptions): void;
    blurTextInput(): void;
    setRemoteInputFocused(_focused: boolean): void;
    sendPointer(event: RemotePointerEvent): Promise<void>;
    sendKeysym(event: RemoteKeysymEvent): Promise<void>;
    sendText(text: string): Promise<void>;
    pasteText(text: string): Promise<boolean>;
    copyRemoteSelection(): Promise<boolean>;
    private attachDomListeners;
    private localCoords;
    private firstChangedTouch;
    private isCoarsePointer;
    private clearMotionThrottle;
    private debug;
    private ensureMounted;
}
//# sourceMappingURL=cdp-surface-adapter.d.ts.map