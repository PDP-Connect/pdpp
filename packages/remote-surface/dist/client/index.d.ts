import type { RemoteSurfaceClipboardPayload, RemoteSurfaceEventPayload, RemoteSurfaceInputPayload, RemoteSurfaceViewportPayload } from "../protocol/index.ts";
export { type CdpSurfaceConfig, CdpSurfaceAdapter, type NekoClientApi, type NekoSurfaceAdapterDeps, type NekoSurfaceConfig, NekoSurfaceAdapter, type RemoteSurfaceLogger, } from "../adapters/index.ts";
export { type NekoPointerControl } from "../controllers/index.ts";
export * from "./clipboard-policy.ts";
export * from "./form-overlay/index.ts";
export * from "./geometry.ts";
export * from "./stream-viewer-surface.ts";
export * from "./stream-viewer-control.ts";
export * from "./stream-viewer-media.ts";
export * from "./viewport-classifier.ts";
export * from "./viewport-match-controller.ts";
export type RemoteSurfaceViewerState = "idle" | "mounting" | "mounted" | "ready" | "closing" | "closed" | "error";
export interface RemoteSurfaceViewerMountConfig {
    backend: "neko" | "cdp" | "vnc" | "kasm" | "custom";
    eventUrl?: string;
    inputUrl?: string;
    viewportUrl?: string;
    clipboardUrl?: string;
    clientDescriptor?: unknown;
}
export interface RemoteSurfaceViewer {
    mount(element: HTMLElement, config: RemoteSurfaceViewerMountConfig): Promise<void>;
    unmount(): Promise<void>;
    dispatchPointer(payload: Extract<RemoteSurfaceInputPayload, {
        type: "pointer";
    }>): Promise<void>;
    dispatchKeyboard(payload: Extract<RemoteSurfaceInputPayload, {
        type: "keyboard";
    }>): Promise<void>;
    dispatchText(payload: Extract<RemoteSurfaceInputPayload, {
        type: "text";
    }>): Promise<void>;
    dispatchPaste(text: string): Promise<void>;
    copyRemoteSelection(): Promise<RemoteSurfaceClipboardPayload | null>;
    focusTextInput(options?: RemoteSurfaceTextInputFocusOptions): void;
    reportViewport(payload: RemoteSurfaceViewportPayload): Promise<void>;
    configureClipboard(policy: RemoteSurfaceClipboardPolicy): void;
    subscribeTelemetry(handler: RemoteSurfaceTelemetryHandler): () => void;
    getLifecycleState(): RemoteSurfaceViewerState;
    getCapabilities(): RemoteSurfaceClientCapabilities;
}
export interface RemoteSurfaceTextInputFocusOptions {
    inputMode?: "text" | "email" | "numeric" | "password" | "search" | "url" | "tel";
    preventScroll?: boolean;
}
export interface RemoteSurfaceClipboardPolicy {
    canReadLocal: boolean;
    canWriteLocal: boolean;
    canReadRemote: boolean;
    canWriteRemote: boolean;
    requireExplicitGesture: boolean;
    manualFallback: boolean;
}
export type RemoteSurfaceTelemetryHandler = (event: RemoteSurfaceEventPayload) => void;
export interface RemoteSurfaceClientCapabilities {
    pointer: boolean;
    keyboard: boolean;
    text: boolean;
    clipboard: RemoteSurfaceClipboardPolicy;
    viewportReporting: boolean;
    diagnostics: boolean;
}
//# sourceMappingURL=index.d.ts.map