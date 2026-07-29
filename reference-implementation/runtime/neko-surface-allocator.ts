// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// biome-ignore lint/performance/noBarrelFile: intentional compatibility shim — re-exports the neko surface allocator client from @opendatalabs/remote-surface so existing runtime import paths keep working.
export {
  createNekoSurfaceAllocatorClient,
  NekoSurfaceAllocatorClient,
  type NekoSurfaceAllocatorClientOptions,
  NekoSurfaceAllocatorError,
  // biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve this installed package export; Node and TypeScript resolve it.
} from "@opendatalabs/remote-surface";
