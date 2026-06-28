import { type BrowserSurface, type BrowserSurfaceAllocator, type EnsureBrowserSurfaceRequest, type StopBrowserSurfaceRequest } from "../../leases/index.ts";
type AllocatorFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export interface NekoSurfaceAllocatorClientOptions {
    readonly baseUrl: string | URL;
    readonly fetchImpl?: AllocatorFetch;
    readonly timeoutMs?: number;
}
export declare class NekoSurfaceAllocatorError extends Error {
    readonly code: "allocator_http_error" | "allocator_fetch_error" | "allocator_timeout" | "allocator_malformed_response";
    readonly status?: number;
    constructor(code: NekoSurfaceAllocatorError["code"], message: string, options?: {
        status?: number;
        cause?: unknown;
    });
}
export declare class NekoSurfaceAllocatorClient implements BrowserSurfaceAllocator {
    #private;
    constructor(options: NekoSurfaceAllocatorClientOptions);
    ensureSurface(request: EnsureBrowserSurfaceRequest): Promise<BrowserSurface>;
    getSurfaceStatus(surfaceId: string): Promise<BrowserSurface | null>;
    stopSurface(request: StopBrowserSurfaceRequest): Promise<BrowserSurface | null>;
    listSurfaces(): Promise<BrowserSurface[]>;
}
export declare function createNekoSurfaceAllocatorClient(options: NekoSurfaceAllocatorClientOptions): BrowserSurfaceAllocator;
export {};
//# sourceMappingURL=allocator-client.d.ts.map