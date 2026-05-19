export type RuntimeBindingName = "network" | "browser" | "filesystem" | "local_device";
export interface RuntimeCapabilityProfile {
    readonly bindings: ReadonlySet<RuntimeBindingName>;
    readonly id: string;
}
export declare const PROVIDER_RUNTIME_CAPABILITIES: RuntimeCapabilityProfile;
export declare const COLLECTOR_RUNTIME_CAPABILITIES: RuntimeCapabilityProfile;
export interface ConnectorRuntimeRequirements {
    readonly bindings?: Partial<Record<RuntimeBindingName, {
        readonly required?: boolean;
    }>>;
}
export interface ConnectorPlacementInput {
    readonly connector_id: string;
    readonly runtime_requirements?: ConnectorRuntimeRequirements;
}
export type PlacementDecision = {
    readonly kind: "ok";
    readonly satisfied: readonly RuntimeBindingName[];
} | {
    readonly kind: "missing_capability";
    readonly missing: readonly RuntimeBindingName[];
    readonly runtime: string;
    readonly connectorId: string;
};
export declare function diffRequiredBindings(connector: ConnectorPlacementInput, runtime: RuntimeCapabilityProfile): RuntimeBindingName[];
export declare function evaluatePlacement(connector: ConnectorPlacementInput, runtime: RuntimeCapabilityProfile): PlacementDecision;
export declare const RUNTIME_CAPABILITY_MISMATCH_CODE = "runtime_capability_mismatch";
export declare class RuntimeCapabilityMismatchError extends Error {
    readonly code: typeof RUNTIME_CAPABILITY_MISMATCH_CODE;
    readonly missing: readonly RuntimeBindingName[];
    readonly runtime: string;
    readonly connectorId: string;
    constructor(args: {
        connectorId: string;
        runtime: string;
        missing: readonly RuntimeBindingName[];
    });
}
export declare function assertPlacementOrThrow(connector: ConnectorPlacementInput, runtime: RuntimeCapabilityProfile): readonly RuntimeBindingName[];
