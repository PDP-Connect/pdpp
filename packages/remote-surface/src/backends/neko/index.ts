import type {
  RemoteSurfaceCapabilities,
  SafeRemoteSurfaceBackendDescriptor,
} from "../../protocol/index.ts";
import type {
  RemoteSurfaceBackendAdapter,
  RemoteSurfaceBackendAdapterFactory,
  RemoteSurfaceBackendLifecycle,
} from "../types.ts";

export * from "./media-settle.ts";

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
