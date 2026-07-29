#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Read-only scheduler-loop probe for operators and agents.
//
// Hits the running reference server's `/_ref/schedules` listing and cross-
// references it against `/_ref/connectors` so an agent can grep or parse
// the structured verdict and tell the difference between:
//   - FIRE    enabled schedule, manifest-eligible, and currently inside
//             its dispatch window (last_finished_at + interval has elapsed)
//   - IDLE    enabled, manifest-eligible, but interval has not elapsed
//             since the last persisted run, so not currently due to fire
//   - GATE    enabled schedule whose connector manifest has since drifted
//             to manual/paused/background-unsafe (ineligibility_reason set)
//   - PAUS    persisted schedule explicitly disabled
//   - NOSCHED registered connector with automatic, background-safe refresh
//             policy but no persisted schedule row (operator never enrolled)
//   - MANUAL  registered connector whose refresh policy is manual/paused
//             or not background-safe; no row is the correct state
//
// Designed to answer "are schedules actually firing inside the Docker
// `reference` container?" and "which auto-eligible connectors am I not
// running yet?" without spelunking server logs.
//
// Usage:
//   node reference-implementation/scripts/scheduler-doctor.ts             # AS=http://localhost:7662
//   node reference-implementation/scripts/scheduler-doctor.ts --json      # JSON to stdout only
//   AS_URL=... PDPP_OWNER_PASSWORD=... node ... scheduler-doctor.ts
//
// Auth:
//   - When PDPP_OWNER_PASSWORD is set (the production/Docker default),
//     mint a short-lived owner-session cookie locally using the same
//     derivation as `server/owner-session.ts`.
//   - When unset (open local-dev mode), the server lets the request through.

import { deriveOwnerSessionSecret, encodeOwnerSession, OWNER_SESSION_COOKIE_NAME } from "../server/owner-session.ts";

/** Parsed CLI flags: `--flag=value`, `--flag value`, or bare `--flag` (boolean). */
type CliFlags = Record<string, string | boolean>;

/** Verdict for a persisted `/_ref/schedules` row. */
interface PersistedVerdict {
  active_run_id: string | null;
  connector_id: string | null;
  effective_mode: string | null;
  enabled: boolean;
  ineligibility_reason: string | null;
  interval_seconds: number | null;
  kind: "persisted";
  last_error_code: string | null;
  last_finished_at: string | null;
  last_started_at: string | null;
  last_successful_at: string | null;
  next_due_at: string | null;
  would_fire: boolean;
}

/** Verdict for a registered connector with no persisted schedule row. */
interface EnrollmentVerdict {
  active_run_id: null;
  background_safe: boolean | null;
  connector_id: string;
  effective_mode: null;
  enabled: false;
  ineligibility_reason: string | null;
  interval_seconds: null;
  kind: "no_schedule_eligible" | "no_schedule_manual";
  last_error_code: null;
  last_finished_at: null;
  last_started_at: null;
  last_successful_at: null;
  next_due_at: null;
  recommended_mode: string | null;
  would_fire: false;
}

type Verdict = PersistedVerdict | EnrollmentVerdict;

interface DoctorSummary {
  as_url: string;
  automatic: number;
  eligible_unscheduled: number;
  enabled: number;
  has_active_run: number;
  ineligible: number;
  manual_unscheduled: number;
  never_ran: number;
  schedules: Verdict[];
  total: number;
}

/** Narrow an `unknown` value to a plain record for safe optional-chained field reads. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" ? value : null;
}

const args = parseArgs(process.argv.slice(2));
const asUrlFlag = args["as-url"];
const asUrl =
  (typeof asUrlFlag === "string" ? asUrlFlag : null) ||
  process.env.AS_URL ||
  process.env.PDPP_AS_URL ||
  `http://localhost:${process.env.AS_PORT || 7662}`;
const ownerPassword = process.env.PDPP_OWNER_PASSWORD || "";
const ownerSubjectId = process.env.PDPP_OWNER_SUBJECT_ID || "owner_local";
const jsonOnly = !!args.json;

const cookieHeader = ownerPassword ? buildOwnerCookieHeader(ownerPassword, ownerSubjectId) : "";

const baseUrl = asUrl.replace(/\/$/, "");
const headers: Record<string, string> = {
  Accept: "application/json",
  ...(cookieHeader ? { Cookie: cookieHeader } : {}),
};

const listingUrl = `${baseUrl}/_ref/schedules`;
let listing: unknown;
try {
  const resp = await fetch(listingUrl, { headers });
  if (!resp.ok) {
    fail(`HTTP ${resp.status} ${resp.statusText} GET ${listingUrl}`, await safeText(resp));
  }
  listing = await resp.json();
} catch (err) {
  fail(`cannot reach ${listingUrl}: ${err instanceof Error ? err.message : String(err)}`);
}

// Cross-reference against the registered connector catalog so the doctor
// can surface auto-eligible connectors the operator never enrolled.
// `/_ref/connectors` is reachable best-effort; if it isn't (older
// reference build, owner-auth mismatch, network blip), the doctor still
// returns persisted-schedule verdicts unchanged.
const connectorsUrl = `${baseUrl}/_ref/connectors`;
let connectorsListing: unknown = null;
try {
  const resp = await fetch(connectorsUrl, { headers });
  if (resp.ok) {
    connectorsListing = await resp.json();
  }
} catch {
  // Silent fallback: catalog cross-reference is opportunistic, not required.
}

const listingData = asRecord(listing)?.data;
const schedules: unknown[] = Array.isArray(listingData) ? listingData : [];
const persistedVerdicts = schedules.map(verdictFor);
const persistedIds = new Set(
  persistedVerdicts.map((v) => v.connector_id).filter((id): id is string => typeof id === "string")
);

const connectorsData = asRecord(connectorsListing)?.data;
const registeredConnectors: unknown[] = Array.isArray(connectorsData) ? connectorsData : [];
const enrollmentVerdicts = registeredConnectors
  .filter((c): c is Record<string, unknown> => {
    const record = asRecord(c);
    const id = stringField(record, "connector_id");
    return id !== null && !persistedIds.has(id);
  })
  .map(enrollmentVerdictFor);

const verdicts: Verdict[] = [...persistedVerdicts, ...enrollmentVerdicts];

const summary: DoctorSummary = {
  as_url: asUrl,
  // `automatic`: enabled, manifest-eligible, and currently inside its
  // dispatch window (i.e. would fire on the next tick). A schedule whose
  // last run was 30s ago with a 1h interval is enabled+automatic but is
  // NOT currently due, so it's not counted here. The previous-tick
  // dashboard read "automatic" as "manifest-eligible" only; this is the
  // honest tick-window-aware count.
  automatic: persistedVerdicts.filter((v) => v.would_fire).length,
  eligible_unscheduled: enrollmentVerdicts.filter((v) => v.kind === "no_schedule_eligible").length,
  enabled: persistedVerdicts.filter((v) => v.enabled).length,
  has_active_run: persistedVerdicts.filter((v) => Boolean(v.active_run_id)).length,
  // `ineligible`: enabled persisted rows that cannot fire under the
  // current manifest policy. Preserved verbatim; does not include
  // "enabled but interval has not elapsed" (that's just normal idle).
  ineligible: persistedVerdicts.filter(
    (v) => v.enabled && (v.effective_mode !== "automatic" || Boolean(v.ineligibility_reason))
  ).length,
  manual_unscheduled: enrollmentVerdicts.filter((v) => v.kind === "no_schedule_manual").length,
  // `never_ran` now reflects durable history. A persisted enabled,
  // manifest-eligible schedule with neither `last_started_at` nor
  // `last_finished_at` populated is genuinely never-ran. A connector
  // that has merely been skipped (skip records carry `started_at` but
  // not `last_started_at` since the runtime never spawned the child)
  // still surfaces `last_finished_at` from the persisted last-run-time
  // table, so it does not show up here.
  never_ran: persistedVerdicts.filter(
    (v) =>
      v.enabled &&
      v.effective_mode === "automatic" &&
      !v.ineligibility_reason &&
      !v.last_started_at &&
      !v.last_finished_at
  ).length,
  schedules: verdicts,
  total: persistedVerdicts.length,
};

if (jsonOnly) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} else {
  renderAscii(summary, process.stderr);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

// ─── helpers ────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): CliFlags {
  const out: CliFlags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === undefined || !tok.startsWith("--")) {
      continue;
    }
    const eq = tok.indexOf("=");
    if (eq >= 0) {
      out[tok.slice(2, eq)] = tok.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[tok.slice(2)] = next;
        i += 1;
      } else {
        out[tok.slice(2)] = true;
      }
    }
  }
  return out;
}

function buildOwnerCookieHeader(password: string, subjectId: string): string {
  const secret = deriveOwnerSessionSecret(password);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const cookieValue = encodeOwnerSession({ exp: nowSeconds + 300, iat: nowSeconds, sub: subjectId }, secret);
  return `${OWNER_SESSION_COOKIE_NAME}=${encodeURIComponent(cookieValue)}`;
}

function verdictFor(entryRaw: unknown): PersistedVerdict {
  const entry = asRecord(entryRaw);
  const enabled = entry?.enabled === true;
  const effectiveMode = stringField(entry, "effective_mode");
  const ineligibilityReason = stringField(entry, "ineligibility_reason");
  const lastStartedAt = stringField(entry, "last_started_at");
  const lastFinishedAt = stringField(entry, "last_finished_at");
  const nextDueAt = stringField(entry, "next_due_at");
  const intervalSecondsRaw = entry?.interval_seconds;
  const intervalSeconds = typeof intervalSecondsRaw === "number" ? intervalSecondsRaw : null;
  // `would_fire` historically meant "enabled, automatic, and not gated by
  // manifest". After the controller projects history into the schedule
  // listing, the doctor can refine it: a connector whose interval has
  // not elapsed since `next_due_at` is not currently due, so we report
  // it as not firing right now. This keeps "would_fire" honest after a
  // restart instead of treating every recently-completed schedule as if
  // it were about to fire immediately.
  const now = Date.now();
  const nextDueMs = nextDueAt ? Date.parse(nextDueAt) : Number.NaN;
  const dueElapsed = !Number.isFinite(nextDueMs) || nextDueMs <= now;
  const wouldFire = enabled && effectiveMode === "automatic" && !ineligibilityReason && dueElapsed;
  return {
    active_run_id: stringField(entry, "active_run_id"),
    connector_id: stringField(entry, "connector_id"),
    effective_mode: effectiveMode,
    enabled,
    ineligibility_reason: ineligibilityReason,
    interval_seconds: intervalSeconds,
    kind: "persisted",
    last_error_code: stringField(entry, "last_error_code"),
    last_finished_at: lastFinishedAt,
    last_started_at: lastStartedAt,
    last_successful_at: stringField(entry, "last_successful_at"),
    next_due_at: nextDueAt,
    would_fire: wouldFire,
  };
}

function enrollmentVerdictFor(connector: Record<string, unknown>): EnrollmentVerdict {
  const policyRaw = connector.refresh_policy;
  const policy = asRecord(policyRaw);
  const mode = stringField(policy, "recommended_mode");
  const backgroundSafeRaw = policy?.background_safe;
  const backgroundSafe = typeof backgroundSafeRaw === "boolean" ? backgroundSafeRaw : null;
  const eligible = mode === "automatic" && backgroundSafe !== false;
  const connectorId = stringField(connector, "connector_id");
  if (connectorId === null) {
    throw new Error("enrollmentVerdictFor requires a string connector_id (caller must pre-filter)");
  }
  return {
    active_run_id: null,
    background_safe: backgroundSafe,
    connector_id: connectorId,
    effective_mode: null,
    enabled: false,
    ineligibility_reason: eligible ? null : enrollmentIneligibilityReason(mode, backgroundSafe),
    interval_seconds: null,
    kind: eligible ? "no_schedule_eligible" : "no_schedule_manual",
    last_error_code: null,
    last_finished_at: null,
    last_started_at: null,
    last_successful_at: null,
    next_due_at: null,
    recommended_mode: mode,
    would_fire: false,
  };
}

function enrollmentIneligibilityReason(mode: string | null, backgroundSafe: boolean | null): string {
  if (mode === "manual") {
    return "manifest refresh_policy recommends manual";
  }
  if (mode === "paused") {
    return "manifest refresh_policy recommends paused";
  }
  if (backgroundSafe === false) {
    return "manifest refresh_policy is not background-safe";
  }
  if (!mode) {
    return "manifest declares no refresh_policy";
  }
  return `manifest refresh_policy mode=${mode}`;
}

function renderAscii(s: DoctorSummary, stream: NodeJS.WriteStream): void {
  stream.write(`scheduler-doctor → ${s.as_url}\n`);
  stream.write(
    `  total=${s.total} enabled=${s.enabled} would-fire-now=${s.automatic} ineligible-when-enabled=${s.ineligible} never-ran=${s.never_ran} active=${s.has_active_run} eligible-unscheduled=${s.eligible_unscheduled} manual-unscheduled=${s.manual_unscheduled}\n`
  );
  if (s.schedules.length === 0) {
    stream.write("  (no persisted schedules and no registered connectors)\n");
    return;
  }
  for (const v of s.schedules) {
    const tag = verdictTag(v);
    const reason = v.ineligibility_reason ? `  ineligible="${v.ineligibility_reason}"` : "";
    if (v.kind === "persisted") {
      // Prefer `last_started_at` (the connector child actually spawned)
      // for the human-readable "last=" anchor; fall back to
      // `last_finished_at` so persisted skip-only history still surfaces
      // a real timestamp instead of "never".
      const last = v.last_started_at ?? v.last_finished_at ?? "never";
      const nextDue = v.next_due_at ? `  next_due=${v.next_due_at}` : "";
      stream.write(
        `  [${tag}] ${v.connector_id ?? "?"}  every ${v.interval_seconds}s  last=${last}${nextDue}  mode=${v.effective_mode ?? "?"}${reason}\n`
      );
    } else {
      stream.write(
        `  [${tag}] ${v.connector_id ?? "?"}  no schedule row  policy=${v.recommended_mode ?? "?"}/background_safe=${v.background_safe ?? "?"}${reason}\n`
      );
    }
  }
}

function verdictTag(v: Verdict): string {
  if (v.kind === "no_schedule_eligible") {
    return "NOSCHED";
  }
  if (v.kind === "no_schedule_manual") {
    return "MANUAL";
  }
  if (v.would_fire) {
    return "FIRE";
  }
  // Enabled, manifest-eligible, but not currently due (next_due_at is in
  // the future). Distinguishes "ran but is currently idle" from a
  // genuine manifest GATE.
  if (
    v.enabled &&
    v.effective_mode === "automatic" &&
    !v.ineligibility_reason &&
    (v.last_started_at || v.last_finished_at)
  ) {
    return "IDLE";
  }
  if (v.enabled) {
    return "GATE";
  }
  return "PAUS";
}

async function safeText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}

function fail(message: string, detail = ""): never {
  process.stderr.write(`scheduler-doctor: ${message}\n`);
  if (detail) {
    process.stderr.write(`${detail}\n`);
  }
  process.exit(1);
}
