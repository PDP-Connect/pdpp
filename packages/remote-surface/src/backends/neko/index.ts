import type {
  RemoteSurfaceCapabilities,
  SafeRemoteSurfaceBackendDescriptor,
} from "../../protocol/index.ts";
import { parseSafeRemoteSurfaceBackendDescriptor } from "../../protocol/index.ts";
import type {
  RemoteSurfaceBackendAdapter,
  RemoteSurfaceBackendAdapterFactory,
  RemoteSurfaceBackendLifecycle,
} from "../types.ts";

export * from "./media-settle.ts";
export * from "./layout.ts";
export * from "./pointer-diagnostics.ts";
export * from "./touch-scroll.ts";
export * from "./viewport-apply.ts";
export {
  NekoSurfaceAllocatorClient,
  NekoSurfaceAllocatorError,
  createNekoSurfaceAllocatorClient,
} from "./allocator-client.ts";
export type { NekoSurfaceAllocatorClientOptions } from "./allocator-client.ts";

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

export const NEKO_BACKEND_CAPABILITIES: RemoteSurfaceCapabilities = {
  eventChannel: "sse",
  input: ["pointer", "keyboard", "keysym", "text", "paste", "touch", "scroll"],
  clipboard: ["local_to_remote", "remote_to_local", "manual_fallback"],
  viewport: ["report", "resize", "classify_occlusion"],
  diagnostics: ["events", "replay", "redacted_buffer"],
  ownerBrowser: true,
  serverSideAutomationEndpoint: true,
};

export interface NekoSafeClientDescriptorOptions {
  proxyPath: string;
  sessionPath?: string;
  allowedMethods?: readonly string[];
  expiresAt?: number;
  capabilities?: RemoteSurfaceCapabilities;
}

export function buildNekoSafeClientDescriptor({
  proxyPath,
  sessionPath,
  allowedMethods,
  expiresAt,
  capabilities = NEKO_BACKEND_CAPABILITIES,
}: NekoSafeClientDescriptorOptions): NekoSafeClientDescriptor {
  return parseNekoSafeClientDescriptor({
    backend: "neko",
    capabilities,
    proxy: {
      path: proxyPath,
      sameOrigin: true,
      ...(allowedMethods === undefined ? {} : { allowedMethods }),
    },
    ...(sessionPath === undefined
      ? {}
      : {
          session: {
            path: sessionPath,
            sameOrigin: true,
            ...(expiresAt === undefined ? {} : { expiresAt }),
          },
        }),
  });
}

export function parseNekoSafeClientDescriptor(value: unknown): NekoSafeClientDescriptor {
  const descriptor = parseSafeRemoteSurfaceBackendDescriptor(value);
  if (descriptor.backend !== "neko" || !descriptor.proxy) {
    throw new TypeError("n.eko client descriptors must include a same-origin proxy path");
  }
  return descriptor as NekoSafeClientDescriptor;
}
