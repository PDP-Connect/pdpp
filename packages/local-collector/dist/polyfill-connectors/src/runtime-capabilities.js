export const PROVIDER_RUNTIME_CAPABILITIES = {
    id: "provider",
    bindings: new Set(["network", "filesystem"]),
};
export const COLLECTOR_RUNTIME_CAPABILITIES = {
    id: "collector",
    bindings: new Set(["network", "browser", "filesystem", "local_device"]),
};
export function diffRequiredBindings(connector, runtime) {
    const declared = connector.runtime_requirements?.bindings ?? {};
    const missing = [];
    for (const [name, decl] of Object.entries(declared)) {
        if (decl?.required && !runtime.bindings.has(name)) {
            missing.push(name);
        }
    }
    return missing;
}
export function evaluatePlacement(connector, runtime) {
    const missing = diffRequiredBindings(connector, runtime);
    if (missing.length === 0) {
        const declared = connector.runtime_requirements?.bindings ?? {};
        const satisfied = Object.keys(declared).filter((name) => declared[name]?.required && runtime.bindings.has(name));
        return { kind: "ok", satisfied };
    }
    return {
        kind: "missing_capability",
        missing,
        runtime: runtime.id,
        connectorId: connector.connector_id,
    };
}
export const RUNTIME_CAPABILITY_MISMATCH_CODE = "runtime_capability_mismatch";
export class RuntimeCapabilityMismatchError extends Error {
    code;
    missing;
    runtime;
    connectorId;
    constructor(args) {
        super(`Runtime '${args.runtime}' cannot satisfy connector '${args.connectorId}': missing bindings [${args.missing.join(", ")}]. ` +
            "Run this connector in a runtime that advertises the required bindings (typically the local collector runtime).");
        this.name = "RuntimeCapabilityMismatchError";
        this.code = RUNTIME_CAPABILITY_MISMATCH_CODE;
        this.missing = args.missing;
        this.runtime = args.runtime;
        this.connectorId = args.connectorId;
    }
}
export function assertPlacementOrThrow(connector, runtime) {
    const decision = evaluatePlacement(connector, runtime);
    if (decision.kind === "ok") {
        return decision.satisfied;
    }
    throw new RuntimeCapabilityMismatchError({
        connectorId: decision.connectorId,
        runtime: decision.runtime,
        missing: decision.missing,
    });
}
