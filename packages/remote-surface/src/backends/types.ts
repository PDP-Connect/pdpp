import type {
  RemoteSurfaceCapabilities,
  RemoteSurfaceBackendKind,
  RemoteSurfaceClipboardPayload,
  RemoteSurfaceEventPayload,
  RemoteSurfaceInputPayload,
  RemoteSurfaceViewportPayload,
  SafeRemoteSurfaceBackendDescriptor,
} from "../protocol/index.ts";

export const REMOTE_SURFACE_FUTURE_BACKEND_KINDS = ["vnc", "kasm", "custom"] as const;

export type RemoteSurfaceFutureBackendKind = (typeof REMOTE_SURFACE_FUTURE_BACKEND_KINDS)[number];

export interface FutureRemoteSurfaceBackendDescriptor extends SafeRemoteSurfaceBackendDescriptor {
  backend: RemoteSurfaceFutureBackendKind;
}

export interface FutureRemoteSurfaceBackendAdapter
  extends RemoteSurfaceBackendAdapter<FutureRemoteSurfaceBackendDescriptor> {
  readonly kind: RemoteSurfaceFutureBackendKind;
}

export type FutureRemoteSurfaceBackendAdapterFactory =
  RemoteSurfaceBackendAdapterFactory<FutureRemoteSurfaceBackendDescriptor>;

export function isRemoteSurfaceFutureBackendKind(
  kind: RemoteSurfaceBackendKind,
): kind is RemoteSurfaceFutureBackendKind {
  return REMOTE_SURFACE_FUTURE_BACKEND_KINDS.includes(kind as RemoteSurfaceFutureBackendKind);
}

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
