import type { Credentials } from "./auth.js";
import type { EmittedMessage, InteractionRequest, InteractionResponse } from "./connector-runtime-protocol.js";
export interface TimeRange {
    since?: string;
    until?: string;
}
export interface StreamRequest {
    resources?: readonly unknown[];
    time_range?: TimeRange;
}
export declare function resourceSet(streamRequest: StreamRequest | null | undefined): Set<string> | null;
export declare function passesResourceFilter(resSet: ReadonlySet<string> | null, primaryKey: unknown): boolean;
export declare function passesTimeRange(isoValue: string | null | undefined, timeRange: TimeRange | null | undefined): boolean;
export interface EmitGateRecord {
    [field: string]: unknown;
}
export interface EmitGate {
    emittedSet: () => Set<string>;
    (stream: string, data: EmitGateRecord, keyField?: string): boolean;
}
export interface MakeEmitGateOptions {
    consentTimeField?: string;
}
export declare function makeEmitGate(emitRecord: (stream: string, data: EmitGateRecord) => void, streamRequest: StreamRequest | null | undefined, { consentTimeField }?: MakeEmitGateOptions): EmitGate;
export interface EmitTombstonesArgs {
    currentIds: ReadonlySet<string>;
    emit: (msg: EmittedMessage) => unknown;
    emittedAt: string;
    priorIds: Iterable<string> | null | undefined;
    stream: string;
}
export declare function emitTombstones({ emit, stream, priorIds, currentIds, emittedAt }: EmitTombstonesArgs): number;
export interface RequireCredentialsOrAskArgs {
    connectorName: string;
    required: ReadonlyArray<string | readonly string[]>;
    sendInteraction: (req: InteractionRequest) => Promise<InteractionResponse>;
}
export declare function requireCredentialsOrAsk({ required, connectorName, sendInteraction, }: RequireCredentialsOrAskArgs): Promise<Credentials>;
