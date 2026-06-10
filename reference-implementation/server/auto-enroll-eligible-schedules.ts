/**
 * Reference-server boot pass that enrolls a default enabled schedule for
 * every first-party connector whose manifest is automatic, background-safe,
 * publicly listed with `status: proven`, AND whose declared
 * `capabilities.auth.required` env names are populated in `process.env`.
 *
 * Spec: openspec/changes/auto-enroll-eligible-connector-schedules/.
 *
 * Idempotency contract:
 *   - Never overwrite an existing schedule row. Operator intent (paused,
 *     custom interval, custom jitter) is preserved across boots.
 *   - Never inspect, copy, or log the env values themselves; only their
 *     presence and trimmed non-emptiness are checked.
 *   - Never enroll a connector that fails any single eligibility fact;
 *     unenrolled connectors continue to surface honestly as `NOSCHED` in
 *     `scheduler-doctor` and the dashboard.
 *
 * Designed to be wired into `server/index.js` between
 * `reconcilePolyfillManifests` and `createReferenceSchedulerManager` so the
 * scheduler manager's initial hydration sees the newly enrolled rows.
 */

import type { ConnectorSchedulePatch, ScheduleApi, ScheduleUpsertResult } from "../runtime/controller.ts";

const DEFAULT_INTERVAL_SECONDS = 3600;

export interface AutoEnrollControllerLike {
  getSchedule(connectorId: string): Promise<ScheduleApi | null>;
  upsertSchedule(connectorId: string, input: ConnectorSchedulePatch): Promise<ScheduleUpsertResult>;
}

export interface AutoEnrollConnectorRow {
  readonly connector_id: string;
  readonly manifest: unknown;
}

export type AutoEnrollListConnectors = () => Promise<readonly AutoEnrollConnectorRow[]>;

export interface AutoEnrollOptions {
  controller: AutoEnrollControllerLike;
  /**
   * Whether the pass should run at all. Defaults to true. The caller is
   * responsible for resolving the operator override
   * (`PDPP_SKIP_AUTO_SCHEDULE_ENROLLMENT=1`) and the constructor opt and
   * passing the resolved boolean here.
   */
  enabled?: boolean;
  /**
   * Snapshot of `process.env` (or an injected stand-in for tests). Defaults
   * to `process.env`. The only operation performed against this object is
   * a key lookup; values are never logged or stored.
   */
  env?: Readonly<Record<string, string | undefined>>;
  /**
   * Store-aware credential probe: true when at least one ACTIVE connection of
   * this connector holds an active credential in the encrypted per-connection
   * store. Env presence is no longer the only way to prove a connector can
   * authenticate — an env-free deployment whose credentials live in the store
   * must still auto-enroll. Only presence is consulted; never secret bytes.
   */
  hasStoredCredential?: (connectorId: string) => Promise<boolean>;
  listConnectors: AutoEnrollListConnectors;
  log?: (line: string) => void;
}

export interface AutoEnrollSummary {
  enrolled: number;
  errors: number;
  scanned: number;
  skipped_env: number;
  skipped_existing: number;
  skipped_policy: number;
}

const EMPTY_SUMMARY = (): AutoEnrollSummary => ({
  scanned: 0,
  enrolled: 0,
  errors: 0,
  skipped_env: 0,
  skipped_existing: 0,
  skipped_policy: 0,
});

interface ManifestCapabilities {
  readonly auth?: unknown;
  readonly public_listing?: unknown;
  readonly refresh_policy?: unknown;
}

function getCapabilities(manifest: unknown): ManifestCapabilities | null {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return null;
  }
  const caps = (manifest as { capabilities?: unknown }).capabilities;
  if (!caps || typeof caps !== "object" || Array.isArray(caps)) {
    return null;
  }
  return caps as ManifestCapabilities;
}

interface PolicyFacts {
  readonly assistedAfterOwnerAuth: boolean | null;
  readonly backgroundSafe: boolean | null;
  readonly recommendedIntervalSeconds: number | null;
  readonly recommendedMode: string | null;
}

function getPolicyFacts(caps: ManifestCapabilities): PolicyFacts {
  const policy = caps.refresh_policy;
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return {
      assistedAfterOwnerAuth: null,
      backgroundSafe: null,
      recommendedIntervalSeconds: null,
      recommendedMode: null,
    };
  }
  const p = policy as Record<string, unknown>;
  const mode = typeof p.recommended_mode === "string" ? p.recommended_mode : null;
  const safe = typeof p.background_safe === "boolean" ? (p.background_safe as boolean) : null;
  const assisted =
    typeof p.assisted_after_owner_auth === "boolean" ? (p.assisted_after_owner_auth as boolean) : null;
  const interval =
    typeof p.recommended_interval_seconds === "number" && Number.isFinite(p.recommended_interval_seconds)
      ? (p.recommended_interval_seconds as number)
      : null;
  return {
    assistedAfterOwnerAuth: assisted,
    backgroundSafe: safe,
    recommendedIntervalSeconds: interval,
    recommendedMode: mode,
  };
}

interface ListingFacts {
  readonly listed: boolean | null;
  readonly status: string | null;
}

function getListingFacts(caps: ManifestCapabilities): ListingFacts {
  const listing = caps.public_listing;
  if (!listing || typeof listing !== "object" || Array.isArray(listing)) {
    return { listed: null, status: null };
  }
  const l = listing as Record<string, unknown>;
  return {
    listed: typeof l.listed === "boolean" ? l.listed : null,
    status: typeof l.status === "string" ? l.status : null,
  };
}

function readAuthRequiredList(caps: ManifestCapabilities): readonly unknown[] | null {
  const auth = caps.auth;
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
    return null;
  }
  const a = auth as Record<string, unknown>;
  if (a.kind !== "env") {
    return null;
  }
  const required = a.required;
  if (!Array.isArray(required) || required.length === 0) {
    return null;
  }
  return required;
}

function encodeAliasEntry(entry: readonly unknown[]): string | null {
  const variants: string[] = [];
  for (const v of entry) {
    if (typeof v === "string" && v.trim().length > 0) {
      variants.push(v.trim());
    }
  }
  if (variants.length === 0) {
    return null;
  }
  return variants.join("|");
}

function encodeEnvEntry(entry: unknown): string | null {
  if (typeof entry === "string" && entry.trim().length > 0) {
    return entry.trim();
  }
  if (Array.isArray(entry)) {
    return encodeAliasEntry(entry);
  }
  return null;
}

/**
 * Manifest `capabilities.auth.required` entries are either a string env name
 * or an alias array (`[primary, ...fallbacks]`). The runtime auth resolver in
 * `packages/polyfill-connectors/src/auth.ts::resolveEnvEntry` uses first-set-
 * wins: any one alias being non-empty is enough to satisfy the requirement.
 * The enrollment gate must agree with that resolution so we never refuse to
 * enroll a connector that the runtime would happily authenticate from a
 * fallback alias. Alias arrays are encoded here as a `"a|b|c"` token; the
 * presence check downstream splits on `|` and tests for any non-empty value.
 */
function extractEnvRequirement(caps: ManifestCapabilities): readonly string[] | null {
  const required = readAuthRequiredList(caps);
  if (!required) {
    return null;
  }
  const names: string[] = [];
  for (const entry of required) {
    const encoded = encodeEnvEntry(entry);
    if (encoded === null) {
      return null;
    }
    names.push(encoded);
  }
  return names;
}

function envValueIsPresent(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function allRequiredEnvPresent(
  requirements: readonly string[],
  env: Readonly<Record<string, string | undefined>>
): boolean {
  for (const requirement of requirements) {
    if (requirement.includes("|")) {
      const variants = requirement.split("|");
      const anySet = variants.some((name) => envValueIsPresent(env[name]));
      if (!anySet) {
        return false;
      }
      continue;
    }
    if (!envValueIsPresent(env[requirement])) {
      return false;
    }
  }
  return true;
}

/**
 * Evaluates the auth requirement for one connector. Populated env names (or
 * aliases) satisfy it; otherwise an active per-connection credential in the
 * encrypted store does. Env-free deployments whose credentials were migrated
 * env→store must keep auto-enrolling — and compose `${VAR:-}` mappings leave
 * EMPTY STRINGS behind, which the env gate already treats as absent, so the
 * store probe is the only honest signal in that posture. Returns `null` when
 * satisfied, otherwise the summary counter to increment.
 */
async function evaluateAuthRequirementGate(args: {
  connectorId: string;
  env: Readonly<Record<string, string | undefined>>;
  hasStoredCredential: ((connectorId: string) => Promise<boolean>) | undefined;
  log: (line: string) => void;
  requirements: readonly string[];
}): Promise<"errors" | "skipped_env" | null> {
  if (allRequiredEnvPresent(args.requirements, args.env)) {
    return null;
  }
  if (!args.hasStoredCredential) {
    return "skipped_env";
  }
  try {
    return (await args.hasStoredCredential(args.connectorId)) ? null : "skipped_env";
  } catch (err) {
    args.log(`[auto-enroll] stored-credential probe failed for ${args.connectorId}: ${errorMessage(err)}`);
    return "errors";
  }
}

interface PolicyEligibility {
  readonly eligible: boolean;
  readonly reason?: string;
}

function checkPolicyEligibility(caps: ManifestCapabilities): PolicyEligibility {
  const policy = getPolicyFacts(caps);
  if (policy.recommendedMode !== "automatic") {
    return { eligible: false, reason: `recommended_mode=${policy.recommendedMode ?? "<missing>"}` };
  }
  if (policy.backgroundSafe === false) {
    return { eligible: false, reason: "background_safe=false" };
  }
  if (policy.assistedAfterOwnerAuth === true) {
    return { eligible: false, reason: "assisted_after_owner_auth=true" };
  }
  const listing = getListingFacts(caps);
  if (listing.listed !== true) {
    return { eligible: false, reason: `public_listing.listed=${listing.listed ?? "<missing>"}` };
  }
  if (listing.status !== "proven") {
    return { eligible: false, reason: `public_listing.status=${listing.status ?? "<missing>"}` };
  }
  return { eligible: true };
}

function resolveIntervalSeconds(caps: ManifestCapabilities): number {
  const { recommendedIntervalSeconds } = getPolicyFacts(caps);
  if (recommendedIntervalSeconds && recommendedIntervalSeconds > 0) {
    return recommendedIntervalSeconds;
  }
  return DEFAULT_INTERVAL_SECONDS;
}

/**
 * Enroll every eligible-with-env registered connector that lacks a
 * persisted schedule row. Returns a summary counter that callers can log
 * and tests can assert against. Never throws on a single-connector
 * failure; per-connector errors are counted and the loop continues.
 */
export async function autoEnrollEligibleSchedules(opts: AutoEnrollOptions): Promise<AutoEnrollSummary> {
  const {
    enabled = true,
    env = process.env,
    controller,
    hasStoredCredential,
    listConnectors,
    log = () => {
      /* default no-op logger */
    },
  } = opts;
  const summary = EMPTY_SUMMARY();
  if (!enabled) {
    return summary;
  }
  let connectors: readonly AutoEnrollConnectorRow[];
  try {
    connectors = await listConnectors();
  } catch (err) {
    log(`[auto-enroll] cannot list connectors: ${errorMessage(err)}`);
    return summary;
  }
  for (const row of connectors) {
    const connectorId = row.connector_id;
    if (typeof connectorId !== "string" || connectorId.length === 0) {
      continue;
    }
    summary.scanned += 1;
    const caps = getCapabilities(row.manifest);
    if (!caps) {
      summary.skipped_policy += 1;
      continue;
    }
    const policy = checkPolicyEligibility(caps);
    if (!policy.eligible) {
      summary.skipped_policy += 1;
      continue;
    }
    const requirements = extractEnvRequirement(caps);
    if (!requirements) {
      // Eligibility includes "manifest declares its env requirements".
      // A proven, automatic connector without auth.required cannot be
      // auto-enrolled by this pass because we have nothing to gate on.
      summary.skipped_policy += 1;
      continue;
    }
    const authGateFailure = await evaluateAuthRequirementGate({
      connectorId,
      env,
      hasStoredCredential,
      log,
      requirements,
    });
    if (authGateFailure) {
      summary[authGateFailure] += 1;
      continue;
    }
    let existing: ScheduleApi | null;
    try {
      existing = await controller.getSchedule(connectorId);
    } catch (err) {
      summary.errors += 1;
      log(`[auto-enroll] getSchedule failed for ${connectorId}: ${errorMessage(err)}`);
      continue;
    }
    if (existing) {
      summary.skipped_existing += 1;
      continue;
    }
    const intervalSeconds = resolveIntervalSeconds(caps);
    try {
      await controller.upsertSchedule(connectorId, {
        enabled: true,
        interval_seconds: intervalSeconds,
        jitter_seconds: 0,
      });
      summary.enrolled += 1;
      log(`[auto-enroll] enrolled ${connectorId} at ${intervalSeconds}s interval`);
    } catch (err) {
      summary.errors += 1;
      log(`[auto-enroll] upsertSchedule failed for ${connectorId}: ${errorMessage(err)}`);
    }
  }
  return summary;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) {
      return `${code}: ${err.message}`;
    }
    return err.message;
  }
  return String(err);
}
