import { type RuntimeCapabilityProfile } from "../../polyfill-connectors/src/runner/index.js";
export { buildCollectorStartMessage, COLLECTOR_PROTOCOL_VERSION, CollectorStateReadError, drainCollectorQueue, emitToStdout, enrollCollector, evaluatePlacement, isMainModule, LocalDeviceClient, LocalDeviceHttpError, LocalDeviceQueue, PROVIDER_RUNTIME_CAPABILITIES, RUNTIME_CAPABILITY_MISMATCH_CODE, RuntimeCapabilityMismatchError, assertPlacementOrThrow, buildLocalDeviceRecordEnvelope, canonicalJson, diffRequiredBindings, hashCanonicalJson, parseJsonlLine, resourceSet, runCollectorConnector, stringifyForJsonl, transformRecordsToCollectorEnvelopes, type CollectorChildContext, type CollectorConnectorSpec, type CollectorEnrollmentConfig, type CollectorRunConfig, type CollectorRunResult, type ConnectorPlacementInput, type ConnectorRuntimeRequirements, type EmittedMessage, type EnrollmentExchangeResponse, type LocalDeviceRecordEnvelope, type PlacementDecision, type RuntimeBindingName, type RuntimeCapabilityProfile, type StartMessage, type StreamScope, } from "../../polyfill-connectors/src/runner/index.js";
export declare const COLLECTOR_RUNTIME_CAPABILITIES: RuntimeCapabilityProfile;
export interface BundledConnectorEntry {
    readonly connector_id: string;
    readonly args: readonly string[];
    readonly command: string;
    readonly bindings: Readonly<Record<string, {
        required: boolean;
    }>>;
    readonly streams: readonly string[];
}
export declare const BUNDLED_CONNECTORS: Readonly<Record<string, BundledConnectorEntry>>;
export declare const BUNDLED_CONNECTOR_IDS: readonly string[];
export declare function getBundledConnector(connectorId: string): BundledConnectorEntry | null;
export declare const BUNDLED_CONNECTOR_VERSIONS: Readonly<Record<string, string>>;
