import type { RemoteSurfaceClipboardPayload, RemoteSurfaceInputPayload, RemoteSurfaceKeyboardInput, RemoteSurfacePointerInput, RemoteSurfaceViewportPayload } from "../../protocol/index.ts";
import type { CdpBackendAdapter, CdpBackendAdapterFactory, CdpBackendLifecycle, CdpSafeClientDescriptor } from "./descriptor.ts";
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
    transportFactory(request: {
        targetId: string;
    }): Promise<CdpCommandTransport> | CdpCommandTransport;
    clock?: () => number;
    descriptor?: CdpSafeClientDescriptor;
    screencast?: CdpScreencastOptions;
}
export declare class CdpBackendError extends Error {
    readonly code: "invalid_lifecycle" | "malformed_event";
    constructor(code: CdpBackendError["code"], message: string);
}
export interface CdpKeyDescriptor {
    code: string;
    key: string;
    text?: string;
    windowsVirtualKeyCode: number;
}
export declare class CdpRemoteSurfaceBackendAdapter implements CdpBackendAdapter {
    readonly kind: "cdp";
    readonly capabilities: import("../../protocol/index.ts").RemoteSurfaceCapabilities;
    private readonly clock;
    private readonly descriptor;
    private readonly screencast;
    private readonly targetId;
    private readonly transport;
    private readonly handlers;
    private frameSequence;
    private lifecycle;
    private screencastSubscription;
    private started;
    constructor(options: CdpRemoteSurfaceBackendAdapterOptions);
    start(viewport?: RemoteSurfaceViewportPayload): Promise<CdpBackendLifecycle>;
    stop(): Promise<void>;
    input(payload: RemoteSurfaceInputPayload): Promise<void>;
    setViewport(payload: RemoteSurfaceViewportPayload): Promise<void>;
    clipboard(payload: RemoteSurfaceClipboardPayload): Promise<void>;
    private onEvent;
    private createLifecycle;
    private handleScreencastFrame;
    private emit;
    private ensureStarted;
}
export declare function createCdpRemoteSurfaceBackendAdapter(options: CdpRemoteSurfaceBackendAdapterOptions): CdpRemoteSurfaceBackendAdapter;
export declare function createCdpRemoteSurfaceBackendAdapterFactory(options: CdpRemoteSurfaceBackendAdapterFactoryOptions): CdpBackendAdapterFactory;
export declare function insertCdpText(session: CdpCommandTransport, text: string): Promise<void>;
export declare function applyCdpViewport(session: CdpCommandTransport, payload: RemoteSurfaceViewportPayload): Promise<void>;
export declare function dispatchCdpPointerInput(session: CdpCommandTransport, payload: RemoteSurfacePointerInput): Promise<void>;
export declare function dispatchCdpKeyboardInput(session: CdpCommandTransport, payload: RemoteSurfaceKeyboardInput): Promise<void>;
export declare function keysymToCdpKey(keysym: number): CdpKeyDescriptor;
//# sourceMappingURL=backend.d.ts.map