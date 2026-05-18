import type { RemoteSurfaceCapabilities, SafeRemoteSurfaceBackendDescriptor } from "../../protocol/index.ts";
import type { RemoteSurfaceBackendAdapter, RemoteSurfaceBackendAdapterFactory, RemoteSurfaceBackendLifecycle } from "../types.ts";
export * from "./media-settle.ts";
export * from "./layout.ts";
export * from "./pointer-diagnostics.ts";
export * from "./touch-scroll.ts";
export interface NekoSafeClientDescriptor extends SafeRemoteSurfaceBackendDescriptor {
    backend: "neko";
    proxy: {
        path: string;
        sameOrigin: true;
        allowedMethods?: readonly string[];
    };
    session?: {
        path: string;
        sameOrigin: true;
        expiresAt?: number;
    };
}
export interface NekoBackendControl {
    focusKeyboard(): Promise<void> | void;
    sendText(text: string): Promise<void> | void;
    copySelection?(): Promise<void> | void;
}
export interface NekoBackendAdapter extends RemoteSurfaceBackendAdapter<NekoSafeClientDescriptor> {
    readonly kind: "neko";
    readonly control?: NekoBackendControl;
}
export type NekoBackendAdapterFactory = RemoteSurfaceBackendAdapterFactory<NekoSafeClientDescriptor>;
export interface NekoBackendLifecycle extends RemoteSurfaceBackendLifecycle<NekoSafeClientDescriptor> {
    readonly safeClientDescriptor: NekoSafeClientDescriptor;
}
export declare const NEKO_BACKEND_CAPABILITIES: RemoteSurfaceCapabilities;
export interface NekoSafeClientDescriptorOptions {
    proxyPath: string;
    sessionPath?: string;
    allowedMethods?: readonly string[];
    expiresAt?: number;
    capabilities?: RemoteSurfaceCapabilities;
}
export declare function buildNekoSafeClientDescriptor({ proxyPath, sessionPath, allowedMethods, expiresAt, capabilities, }: NekoSafeClientDescriptorOptions): NekoSafeClientDescriptor;
export declare function parseNekoSafeClientDescriptor(value: unknown): NekoSafeClientDescriptor;
//# sourceMappingURL=index.d.ts.map