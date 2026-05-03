/**
 * Runtime capability advertisement and pre-spawn placement gate.
 *
 * Connector manifests already declare their `runtime_requirements.bindings`
 * (network, browser, filesystem, local_device, etc). What was missing is
 * the runtime-side half of the contract: a runtime advertises which
 * bindings it can satisfy, and the orchestrator compares the two before
 * spawning the connector.
 *
 * This module is the runtime-side primitive. It does NOT duplicate
 * connector manifest semantics — it only describes what a runtime can
 * provide and how to compare a connector against it.
 *
 * Spec: openspec/changes/introduce-local-collector-runner/design.md
 */
export type RuntimeBindingName = "network" | "browser" | "filesystem" | "local_device";

export interface RuntimeCapabilityProfile {
  /** Bindings this runtime advertises as available. */
  readonly bindings: ReadonlySet<RuntimeBindingName>;
  /** Stable identifier of the runtime. Used in diagnostics. */
  readonly id: string;
}

/**
 * Default capability profile for the provider/control-plane runtime.
 *
 * The provider/control-plane runtime CAN reach the network and read its
 * own filesystem. It CANNOT render a visible browser (headless workloads
 * are allowed via the connector runtime's headless gate but never count
 * as advertising a `browser` binding) and CANNOT see the operator's
 * local devices.
 *
 * If a deployment proves the provider runtime can render a visible
 * browser (e.g. an X11/VNC environment with `PDPP_ALLOW_HEADED_CONTAINER_BROWSER=1`),
 * the deployment can override this profile by passing a different
 * profile to `evaluatePlacement`.
 */
export const PROVIDER_RUNTIME_CAPABILITIES: RuntimeCapabilityProfile = {
  id: "provider",
  bindings: new Set<RuntimeBindingName>(["network", "filesystem"]),
};

/**
 * Default capability profile for the local collector runtime.
 *
 * A local collector runs on a host the operator owns; it can render a
 * visible browser, reach the network, read the local filesystem, and
 * see local-device-style sources (Codex CLI, Claude Code, iMessage).
 */
export const COLLECTOR_RUNTIME_CAPABILITIES: RuntimeCapabilityProfile = {
  id: "collector",
  bindings: new Set<RuntimeBindingName>(["network", "browser", "filesystem", "local_device"]),
};

export interface ConnectorRuntimeRequirements {
  readonly bindings?: Partial<Record<RuntimeBindingName, { readonly required?: boolean }>>;
}

export interface ConnectorPlacementInput {
  readonly connector_id: string;
  readonly runtime_requirements?: ConnectorRuntimeRequirements;
}

export type PlacementDecision =
  | { readonly kind: "ok"; readonly satisfied: readonly RuntimeBindingName[] }
  | {
      readonly kind: "missing_capability";
      readonly missing: readonly RuntimeBindingName[];
      readonly runtime: string;
      readonly connectorId: string;
    };

/**
 * Returns the list of bindings the connector requires that the runtime
 * does NOT advertise. Empty array means the connector is eligible to
 * run in this runtime.
 */
export function diffRequiredBindings(
  connector: ConnectorPlacementInput,
  runtime: RuntimeCapabilityProfile
): RuntimeBindingName[] {
  const declared = connector.runtime_requirements?.bindings ?? {};
  const missing: RuntimeBindingName[] = [];
  for (const [name, decl] of Object.entries(declared) as [RuntimeBindingName, { required?: boolean }][]) {
    if (decl?.required && !runtime.bindings.has(name)) {
      missing.push(name);
    }
  }
  return missing;
}

/**
 * Pre-spawn placement decision. Compares connector requirements against
 * runtime capabilities and returns a typed result the orchestrator can
 * branch on.
 */
export function evaluatePlacement(
  connector: ConnectorPlacementInput,
  runtime: RuntimeCapabilityProfile
): PlacementDecision {
  const missing = diffRequiredBindings(connector, runtime);
  if (missing.length === 0) {
    const declared = connector.runtime_requirements?.bindings ?? {};
    const satisfied = (Object.keys(declared) as RuntimeBindingName[]).filter(
      (name) => declared[name]?.required && runtime.bindings.has(name)
    );
    return { kind: "ok", satisfied };
  }
  return {
    kind: "missing_capability",
    missing,
    runtime: runtime.id,
    connectorId: connector.connector_id,
  };
}

/**
 * Stable error code surfaced when pre-spawn capability gating refuses
 * to run a connector. Mirrored in dashboard error states.
 */
export const RUNTIME_CAPABILITY_MISMATCH_CODE = "runtime_capability_mismatch";

export class RuntimeCapabilityMismatchError extends Error {
  readonly code: typeof RUNTIME_CAPABILITY_MISMATCH_CODE;
  readonly missing: readonly RuntimeBindingName[];
  readonly runtime: string;
  readonly connectorId: string;

  constructor(args: {
    connectorId: string;
    runtime: string;
    missing: readonly RuntimeBindingName[];
  }) {
    super(
      `Runtime '${args.runtime}' cannot satisfy connector '${args.connectorId}': missing bindings [${args.missing.join(", ")}]. ` +
        "Run this connector in a runtime that advertises the required bindings (typically the local collector runtime)."
    );
    this.name = "RuntimeCapabilityMismatchError";
    this.code = RUNTIME_CAPABILITY_MISMATCH_CODE;
    this.missing = args.missing;
    this.runtime = args.runtime;
    this.connectorId = args.connectorId;
  }
}

/**
 * Convenience: throw a typed mismatch error if placement is not ok.
 * Returns the satisfied bindings on success so callers can record them
 * in run diagnostics.
 */
export function assertPlacementOrThrow(
  connector: ConnectorPlacementInput,
  runtime: RuntimeCapabilityProfile
): readonly RuntimeBindingName[] {
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
