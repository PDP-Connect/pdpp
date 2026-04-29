/**
 * Canonical `ref.deployment` operation.
 *
 * Owns the envelope semantics for the reference-only operator-console
 * deployment-diagnostics page that powers `GET /_ref/deployment`. Host
 * adapters (Fastify route in `reference-implementation/server/index.js`)
 * supply a fully-redacted, fully-projected diagnostics report via the
 * dependency contract; the operation owns:
 *
 *   - the explicit diagnostic-capability boundary
 *     (`collectDeploymentReport` is the only seam between the operation
 *     and the substrate);
 *   - the well-known top-level shape so a future report-rev cannot
 *     accidentally drop a section without an obvious operation diff.
 *
 * Secret redaction is the dependency's responsibility (today
 * `collectDeploymentDiagnostics` in `server/deployment-diagnostics.ts`
 * enforces a strict allowlist + name-pattern guard, with the raw
 * env values and the bridge token never crossing the boundary). The
 * operation re-asserts a defensive invariant: every emitted
 * `environment` entry MUST have a `provenance` set so a regressed
 * dependency cannot silently leak an unredacted secret.
 *
 * This is reference/operator surface, not PDPP protocol. Clients must
 * not depend on the response shape.
 *
 * Boundary rules (see openspec/changes/complete-reference-operation-refactor):
 * - This module SHALL NOT import Fastify, Express, Next, SQLite,
 *   Postgres, a raw SQL handle, sandbox modules,
 *   `reference-implementation/server/*` route or auth modules, the
 *   `deployment-diagnostics` helper, or `process` / `process.env`.
 * - The diagnostics report flows in through the
 *   `collectDeploymentReport` dependency. The host wires the concrete
 *   substrate read (semantic backend, vector index, manifests, env
 *   redaction, host-browser-bridge probe) behind that capability; the
 *   operation does not look at substrate internals.
 */

export type RefDeploymentEnvProvenance = "present" | "absent" | "redacted";

export interface RefDeploymentEnvEntry {
  readonly name: string;
  readonly provenance: RefDeploymentEnvProvenance;
  readonly secret: boolean;
  readonly value: string | null;
}

/**
 * The structural type the operation emits. Mirrors
 * `DeploymentDiagnosticsReport` from
 * `reference-implementation/server/deployment-diagnostics.ts`. We
 * declare it locally rather than importing it so the operation does
 * not reach into the substrate helper — the dependency MUST already
 * have produced a value of this shape.
 */
export interface RefDeploymentReport {
  readonly database: { readonly path: string };
  readonly environment: readonly RefDeploymentEnvEntry[];
  readonly host_browser_bridge: Readonly<Record<string, unknown>>;
  readonly lexical: Readonly<Record<string, unknown>>;
  readonly manifests: readonly Readonly<Record<string, unknown>>[];
  readonly semantic: Readonly<Record<string, unknown>>;
  readonly warnings: readonly Readonly<Record<string, unknown>>[];
}

export interface RefDeploymentDependencies {
  /**
   * Produce the deployment-diagnostics report. The host implementation
   * (currently `collectDeploymentDiagnostics` wired through
   * `server/deployment-diagnostics.ts`) is the source of truth for the
   * field-level shape and for secret redaction. The operation calls
   * this once per execution.
   */
  collectDeploymentReport(): Promise<RefDeploymentReport> | RefDeploymentReport;
}

export type RefDeploymentEnvelope = RefDeploymentReport;

/**
 * Execute the canonical `ref.deployment` operation.
 *
 * Hosts pass capability-shaped dependencies; the operation calls the
 * report collector and returns the report unchanged after a defensive
 * invariant check on the env-redaction posture. The operation has no
 * notion of HTTP, owner sessions, headers, or framework.
 */
export async function executeRefDeployment(
  dependencies: RefDeploymentDependencies,
): Promise<RefDeploymentEnvelope> {
  const report = await dependencies.collectDeploymentReport();

  // Defensive: a regressed dependency must not be able to leak
  // unredacted secrets through a missing `provenance` marker. The
  // dependency's `environment` shape is already enforced upstream;
  // re-asserting here keeps a one-line operation contract on the
  // public surface.
  for (const entry of report.environment) {
    if (
      entry.provenance !== "present" &&
      entry.provenance !== "absent" &&
      entry.provenance !== "redacted"
    ) {
      throw new Error(
        `ref.deployment: dependency emitted environment entry with invalid provenance for ${entry.name}`,
      );
    }
    if (entry.secret && entry.provenance === "present" && entry.value !== null) {
      throw new Error(
        `ref.deployment: dependency leaked a secret env value for ${entry.name}; secret entries MUST be redacted`,
      );
    }
  }

  return report;
}
