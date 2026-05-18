import type { JsonObject, RemoteSurfaceClipboardPayload, RemoteSurfaceEventPayload, RemoteSurfaceInputPayload, RemoteSurfaceViewportPayload } from "../protocol/index.ts";
import type { ViewportTransition } from "../client/viewport-classifier.ts";
export * from "./visual-quality.ts";
export type RemoteSurfaceDiagnosticsKind = "adapter.lifecycle" | "backend.readiness" | "clipboard.action" | "event.channel" | "input.pipeline" | "media.settle" | "viewport.transition";
export type RemoteSurfaceInputClassification = "clipboard-paste" | "keyboard" | "pointer" | "text" | "wheel";
export interface RemoteSurfaceDiagnosticReplay {
    readonly input?: JsonObject;
    readonly output: JsonObject;
}
interface BaseRemoteSurfaceDiagnosticsEvent {
    type: RemoteSurfaceDiagnosticsKind | string;
    timestamp: number;
    payload?: JsonObject;
    replay?: RemoteSurfaceDiagnosticReplay;
}
export interface InputPipelineDiagnosticsEvent extends BaseRemoteSurfaceDiagnosticsEvent {
    type: "input.pipeline";
    payload: {
        classification: RemoteSurfaceInputClassification;
        inputType: RemoteSurfaceInputPayload["type"];
        action?: string;
        replayable: true;
    };
    replay: RemoteSurfaceDiagnosticReplay;
}
export interface ViewportTransitionDiagnosticsEvent extends BaseRemoteSurfaceDiagnosticsEvent {
    type: "viewport.transition";
    payload: JsonObject & {
        kind: ViewportTransition["kind"];
        reason: string;
        remoteResize: ViewportTransition["remoteResize"];
        replayable: true;
    };
    replay: RemoteSurfaceDiagnosticReplay;
}
export interface ClipboardActionDiagnosticsEvent extends BaseRemoteSurfaceDiagnosticsEvent {
    type: "clipboard.action";
    payload: JsonObject & {
        action: RemoteSurfaceClipboardPayload["action"];
        textLengthBucket?: string;
    };
}
export interface EventChannelDiagnosticsEvent extends BaseRemoteSurfaceDiagnosticsEvent {
    type: "event.channel";
    payload: JsonObject & {
        eventType?: RemoteSurfaceEventPayload["type"];
        state?: string;
    };
}
export interface AdapterLifecycleDiagnosticsEvent extends BaseRemoteSurfaceDiagnosticsEvent {
    type: "adapter.lifecycle";
    payload: JsonObject & {
        adapter: string;
        lifecycle: "created" | "ready" | "closed" | "error" | "revoked";
    };
}
export interface BackendReadinessDiagnosticsEvent extends BaseRemoteSurfaceDiagnosticsEvent {
    type: "backend.readiness";
    payload: JsonObject & {
        backend: string;
        ready: boolean;
    };
}
export interface MediaSettleDiagnosticsEvent extends BaseRemoteSurfaceDiagnosticsEvent {
    type: "media.settle";
    payload: JsonObject & {
        status: "degraded" | "settled" | "settling";
    };
}
export type RemoteSurfaceDiagnosticsEvent = AdapterLifecycleDiagnosticsEvent | BackendReadinessDiagnosticsEvent | ClipboardActionDiagnosticsEvent | EventChannelDiagnosticsEvent | InputPipelineDiagnosticsEvent | MediaSettleDiagnosticsEvent | ViewportTransitionDiagnosticsEvent | BaseRemoteSurfaceDiagnosticsEvent;
export interface RedactDiagnosticsOptions {
    replacement?: string;
    redactKeys?: readonly string[];
}
export interface RemoteSurfaceDiagnosticsBuffer {
    push(event: RemoteSurfaceDiagnosticsEvent): RemoteSurfaceDiagnosticsEvent;
    read(cursor?: number): RemoteSurfaceDiagnosticsReadResult;
    subscribe(listener: RemoteSurfaceDiagnosticsListener): RemoteSurfaceDiagnosticsSubscription;
    clear(): void;
    size(): number;
}
export interface RemoteSurfaceDiagnosticsReadResult {
    cursor: number;
    events: readonly RemoteSurfaceDiagnosticsEvent[];
}
export type RemoteSurfaceDiagnosticsListener = (event: RemoteSurfaceDiagnosticsEvent) => void;
export interface RemoteSurfaceDiagnosticsSubscription {
    unsubscribe(): void;
}
export declare function redactDiagnosticsEvent(event: RemoteSurfaceDiagnosticsEvent, options?: RedactDiagnosticsOptions): RemoteSurfaceDiagnosticsEvent;
export declare function createDiagnosticsBuffer(options: {
    capacity: number;
    redact?: boolean;
    redaction?: RedactDiagnosticsOptions;
}): RemoteSurfaceDiagnosticsBuffer;
export declare function buildInputPipelineDiagnosticsEvent({ payload, timestamp, }: {
    payload: RemoteSurfaceInputPayload;
    timestamp?: number;
}): InputPipelineDiagnosticsEvent;
export declare function buildViewportTransitionDiagnosticsEvent({ next, previous, timestamp, transition, }: {
    next: RemoteSurfaceViewportPayload;
    previous?: RemoteSurfaceViewportPayload | null;
    timestamp?: number;
    transition: ViewportTransition;
}): ViewportTransitionDiagnosticsEvent;
export declare function buildClipboardActionDiagnosticsEvent({ payload, textLengthBucket, timestamp, }: {
    payload: RemoteSurfaceClipboardPayload;
    textLengthBucket?: string;
    timestamp?: number;
}): ClipboardActionDiagnosticsEvent;
export declare function buildEventChannelDiagnosticsEvent({ event, state, timestamp, }: {
    event?: RemoteSurfaceEventPayload;
    state?: string;
    timestamp?: number;
}): EventChannelDiagnosticsEvent;
export declare function buildAdapterLifecycleDiagnosticsEvent({ adapter, lifecycle, payload, timestamp, }: {
    adapter: string;
    lifecycle: AdapterLifecycleDiagnosticsEvent["payload"]["lifecycle"];
    payload?: JsonObject;
    timestamp?: number;
}): AdapterLifecycleDiagnosticsEvent;
export declare function buildBackendReadinessDiagnosticsEvent({ backend, payload, ready, timestamp, }: {
    backend: string;
    payload?: JsonObject;
    ready: boolean;
    timestamp?: number;
}): BackendReadinessDiagnosticsEvent;
export declare function buildMediaSettleDiagnosticsEvent({ payload, status, timestamp, }: {
    payload?: JsonObject;
    status: MediaSettleDiagnosticsEvent["payload"]["status"];
    timestamp?: number;
}): MediaSettleDiagnosticsEvent;
export declare function classifyRemoteSurfaceInput(payload: RemoteSurfaceInputPayload): RemoteSurfaceInputClassification;
//# sourceMappingURL=index.d.ts.map