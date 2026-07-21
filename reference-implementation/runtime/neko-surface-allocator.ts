// biome-ignore lint/performance/noBarrelFile: intentional compatibility shim — re-exports the neko surface allocator client from @opendatalabs/remote-surface so existing runtime import paths keep working.
export {
  createNekoSurfaceAllocatorClient,
  NekoSurfaceAllocatorClient,
  type NekoSurfaceAllocatorClientOptions,
  NekoSurfaceAllocatorError,
} from "@opendatalabs/remote-surface";
