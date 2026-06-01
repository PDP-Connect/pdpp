import { type RuntimeCapabilityProfile } from "../../polyfill-connectors/src/runner/index.js";
export { buildCollectorStartMessage, COLLECTOR_COVERAGE_STATUSES, COLLECTOR_PROTOCOL_VERSION, CollectorStateReadError, drainCollectorQueue, emitToStdout, enrollCollector, evaluatePlacement, isMainModule, LocalDeviceClient, LocalDeviceHttpError, LocalDeviceOutbox, LocalDeviceQueue, PROVIDER_RUNTIME_CAPABILITIES, RUNTIME_CAPABILITY_MISMATCH_CODE, RuntimeCapabilityMismatchError, assertPlacementOrThrow, buildLocalDeviceRecordEnvelope, buildLocalDeviceOutboxId, canonicalJson, diffRequiredBindings, hashCanonicalJson, parseJsonlLine, resourceSet, runCollectorConnector, stringifyForJsonl, summarizeCollectorCompleteness, transformRecordsToCollectorEnvelopes, type CollectorChildContext, type CollectorCompletenessSummary, type CollectorConnectorSpec, type CollectorCoverageStatus, type CollectorEnrollmentConfig, type CollectorRunConfig, type CollectorRunResult, type ConnectorPlacementInput, type ConnectorRuntimeRequirements, type EmittedMessage, type EnrollmentExchangeResponse, type LocalDeviceRecordEnvelope, type BuildLocalDeviceOutboxIdInput, type LocalDeviceOutboxClaimInput, type LocalDeviceOutboxDeadLetterInput, type LocalDeviceOutboxEnqueueInput, type LocalDeviceOutboxFailInput, type LocalDeviceOutboxItem, type LocalDeviceOutboxKind, type LocalDeviceOutboxLeaseInput, type LocalDeviceOutboxOptions, type LocalDeviceOutboxStatus, type LocalDeviceOutboxSummary, type PlacementDecision, type RuntimeBindingName, type RuntimeCapabilityProfile, type StartMessage, type StreamScope, } from "../../polyfill-connectors/src/runner/index.js";
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
