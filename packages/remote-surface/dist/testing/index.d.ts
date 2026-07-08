import type { RemoteSurfaceCapabilities, RemoteSurfaceClipboardPayload, RemoteSurfaceDiagnosticsPayload, RemoteSurfaceEventPayload, RemoteSurfaceInputPayload, RemoteSurfaceSessionDescriptor, RemoteSurfaceTargetDescriptor, RemoteSurfaceViewportPayload } from "../protocol/index.ts";
import type { RemoteSurfaceAttachSessionResult, RemoteSurfaceAuthorizationScope, RemoteSurfaceChannelSubscription, RemoteSurfaceCreateSessionRequest, RemoteSurfaceCreateSessionResult, RemoteSurfaceEventSink, RemoteSurfaceSessionBroker, RemoteSurfaceSessionHandle, RemoteSurfaceSessionRef } from "../server/index.ts";
export declare const TEST_REMOTE_SURFACE_CAPABILITIES: RemoteSurfaceCapabilities;
export declare class FakeRemoteSurfaceSessionBroker implements RemoteSurfaceSessionBroker {
    private readonly sessions;
    private readonly tokens;
    private readonly targets;
    private readonly diagnostics;
    private nextId;
    createSession(request: RemoteSurfaceCreateSessionRequest): Promise<RemoteSurfaceCreateSessionResult>;
    registerTarget(ref: RemoteSurfaceSessionRef, target: RemoteSurfaceTargetDescriptor): Promise<RemoteSurfaceSessionDescriptor>;
    attachSession(handle: RemoteSurfaceSessionHandle): Promise<RemoteSurfaceAttachSessionResult>;
    authorizeSession(handle: RemoteSurfaceSessionHandle, _scope: RemoteSurfaceAuthorizationScope): Promise<RemoteSurfaceSessionDescriptor>;
    revokeSession(ref: RemoteSurfaceSessionRef, reason?: RemoteSurfaceSessionDescriptor["revocationReason"]): Promise<RemoteSurfaceSessionDescriptor | null>;
    openEventChannel(ref: RemoteSurfaceSessionRef, sink: RemoteSurfaceEventSink): Promise<RemoteSurfaceChannelSubscription>;
    dispatchInput(ref: RemoteSurfaceSessionRef, payload: RemoteSurfaceInputPayload): Promise<void>;
    reportViewport(ref: RemoteSurfaceSessionRef, payload: RemoteSurfaceViewportPayload): Promise<void>;
    dispatchClipboard(ref: RemoteSurfaceSessionRef, payload: RemoteSurfaceClipboardPayload): Promise<void>;
    readDiagnostics(_session: RemoteSurfaceSessionRef, cursor?: string): Promise<RemoteSurfaceDiagnosticsPayload>;
    emit(ref: RemoteSurfaceSessionRef, event: RemoteSurfaceEventPayload): RemoteSurfaceEventPayload;
    private requireHandle;
    private requireSession;
}
export { FIXTURE_REMOTE_SURFACE_CAPABILITIES, REMOTE_SURFACE_CLIPBOARD_FIXTURES, REMOTE_SURFACE_DIAGNOSTICS_FIXTURE, REMOTE_SURFACE_EVENT_FIXTURES, REMOTE_SURFACE_INPUT_FIXTURES, REMOTE_SURFACE_TARGET_FIXTURES, REMOTE_SURFACE_VIEWPORT_FIXTURES, } from "./protocol-fixtures.ts";
/**
 * @deprecated Reference-shaped wire fixtures moved to
 *   `@opendatalabs/remote-surface/reference`. This re-export is preserved
 *   for the deprecation horizon recorded in the
 *   `republish-remote-surface-as-opendatalabs` OpenSpec change (planned
 *   removal: first post-publish minor). Import directly from the
 *   `./reference` subpath instead.
 */
export { REFERENCE_WIRE_ALL_FIXTURES, REFERENCE_WIRE_BROWSER_SESSION_ID, REFERENCE_WIRE_BROWSER_VISIBLE_FIXTURES, REFERENCE_WIRE_BROWSER_VISIBLE_TARGET_DESCRIPTORS, REFERENCE_WIRE_DIAGNOSTICS_RECORD_FIXTURES, REFERENCE_WIRE_INPUT_ACK_FIXTURE, REFERENCE_WIRE_INPUT_PAYLOAD_FIXTURES, REFERENCE_WIRE_INPUT_TELEMETRY_FIXTURE, REFERENCE_WIRE_INTERACTION_ID, REFERENCE_WIRE_MINT_REQUEST_FIXTURE, REFERENCE_WIRE_MINT_RESPONSE_FIXTURE, REFERENCE_WIRE_NEKO_CLIENT_CONFIG_FIXTURE, REFERENCE_WIRE_NEKO_STATUS_FIXTURES, REFERENCE_WIRE_RUN_ID, REFERENCE_WIRE_SSE_EVENT_FIXTURES, REFERENCE_WIRE_TARGET_DELETE_RESPONSE_FIXTURE, REFERENCE_WIRE_TARGET_REGISTRATION_RESPONSE_FIXTURE, REFERENCE_WIRE_TOKEN, REFERENCE_WIRE_VIEWPORT_ACK_FIXTURE, REFERENCE_WIRE_VIEWPORT_PAYLOAD_FIXTURE, type ReferenceWireFixture, } from "../compat/pdpp-reference/reference-wire-fixtures.ts";
//# sourceMappingURL=index.d.ts.map