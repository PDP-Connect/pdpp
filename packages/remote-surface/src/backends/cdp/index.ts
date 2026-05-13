import type {
  RemoteSurfaceCapabilities,
  SafeRemoteSurfaceBackendDescriptor,
} from "../../protocol/index.ts";
import type {
  RemoteSurfaceBackendAdapter,
  RemoteSurfaceBackendAdapterFactory,
  RemoteSurfaceBackendLifecycle,
} from "../types.ts";

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

export const CDP_BACKEND_CAPABILITIES: RemoteSurfaceCapabilities = {
  eventChannel: "sse",
  input: ["pointer", "keyboard", "text", "paste", "touch", "scroll"],
  clipboard: ["local_to_remote", "remote_to_local", "manual_fallback"],
  viewport: ["report", "resize", "classify_occlusion"],
  diagnostics: ["events", "replay", "redacted_buffer"],
  ownerBrowser: true,
  serverSideAutomationEndpoint: true,
};
