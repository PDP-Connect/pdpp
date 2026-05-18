import type { RemoteSurfaceCapabilities, SafeRemoteSurfaceBackendDescriptor } from "../../protocol/index.ts";
import type { RemoteSurfaceBackendAdapter, RemoteSurfaceBackendAdapterFactory, RemoteSurfaceBackendLifecycle } from "../types.ts";
export interface CdpSafeClientDescriptor extends SafeRemoteSurfaceBackendDescriptor {
    backend: "cdp";
    proxy?: never;
    session?: never;
}
export interface CdpBackendAdapter extends RemoteSurfaceBackendAdapter<CdpSafeClientDescriptor> {
    readonly kind: "cdp";
}
export type CdpBackendAdapterFactory = RemoteSurfaceBackendAdapterFactory<CdpSafeClientDescriptor>;
export interface CdpBackendLifecycle extends RemoteSurfaceBackendLifecycle<CdpSafeClientDescriptor> {
    readonly safeClientDescriptor: CdpSafeClientDescriptor;
}
export declare const CDP_BACKEND_CAPABILITIES: RemoteSurfaceCapabilities;
export interface CdpSafeClientDescriptorOptions {
    capabilities?: RemoteSurfaceCapabilities;
}
export declare function buildCdpSafeClientDescriptor({ capabilities, }?: CdpSafeClientDescriptorOptions): CdpSafeClientDescriptor;
export declare function parseCdpSafeClientDescriptor(value: unknown): CdpSafeClientDescriptor;
//# sourceMappingURL=index.d.ts.map