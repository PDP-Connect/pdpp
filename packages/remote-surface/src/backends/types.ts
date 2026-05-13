import type {
  RemoteSurfaceCapabilities,
  RemoteSurfaceClipboardPayload,
  RemoteSurfaceEventPayload,
  RemoteSurfaceInputPayload,
  RemoteSurfaceViewportPayload,
  SafeRemoteSurfaceBackendDescriptor,
} from "../protocol/index.ts";

export interface RemoteSurfaceBackendAdapter<
  ClientDescriptor extends SafeRemoteSurfaceBackendDescriptor = SafeRemoteSurfaceBackendDescriptor,
> {
  readonly kind: ClientDescriptor["backend"];
  readonly capabilities: RemoteSurfaceCapabilities;
  start(viewport?: RemoteSurfaceViewportPayload): Promise<RemoteSurfaceBackendLifecycle<ClientDescriptor>>;
  stop(): Promise<void>;
}

export interface RemoteSurfaceBackendLifecycle<
  ClientDescriptor extends SafeRemoteSurfaceBackendDescriptor = SafeRemoteSurfaceBackendDescriptor,
> {
  readonly safeClientDescriptor: ClientDescriptor;
  onEvent(handler: (event: RemoteSurfaceEventPayload) => void): RemoteSurfaceBackendSubscription;
  input(payload: RemoteSurfaceInputPayload): Promise<void>;
  setViewport(payload: RemoteSurfaceViewportPayload): Promise<void>;
  clipboard?(payload: RemoteSurfaceClipboardPayload): Promise<void>;
}

export interface RemoteSurfaceBackendSubscription {
  unsubscribe(): void;
}

export type RemoteSurfaceBackendAdapterFactory<
  ClientDescriptor extends SafeRemoteSurfaceBackendDescriptor = SafeRemoteSurfaceBackendDescriptor,
> = (request: RemoteSurfaceBackendStartRequest) => Promise<RemoteSurfaceBackendAdapter<ClientDescriptor>>;

export interface RemoteSurfaceBackendStartRequest {
  targetId: string;
  viewport?: RemoteSurfaceViewportPayload;
}
