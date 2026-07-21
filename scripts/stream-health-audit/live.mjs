// Live-origin runner for the stream-health machine audit.
//
// Fetches connector summaries from a running reference instance and feeds
// them through the same pure `auditStreamHealth` used by the seeded test,
// per openspec/changes/define-stream-coverage-freshness-evidence tasks.md
// 9.1: "a seeded local test plus a live mode reusing the owner-journey
// acceptance harness."
//
// Route: GET /_ref/connectors (mounted by `mountRefConnectorsList` in
// reference-implementation/server/routes/ref-connectors.ts). Verified
// against the route, its operation (`ref.connectors.list` /
// `executeRefConnectorsList` in
// reference-implementation/operations/ref-connectors-list/index.ts), and
// `ConnectorSummary` in reference-implementation/server/ref-control.ts
// (~line 540): the route calls `ctx.listConnectorSummaries()` (host read,
// returns `ConnectorSummary[]`) and the operation wraps it as
// `{ object: "list", data: ConnectorSummary[] }` — the route forwards each
// item opaquely, so every `ConnectorSummary` field survives serialization
// even though the operation's own `RefConnectorsListItem` type doesn't
// re-declare them. The fields this audit reads: `connection_id`,
// `connector_id`, `connector_instance_id`, `display_name`,
// `connector_display_name`, `rendered_verdict` (`{ pill: { label, tone },
// ... }`), and `collection_report` (`CollectionReportEntry[]`: `stream`,
// `coverage_condition`, `forward_disposition`, `coverage_strategy`,
// `checkpoint`, `considered`, `covered`, `required`). `asArrayList` below
// unwraps both the `{ data: [...] }` envelope and a bare array so this
// stays correct if the envelope shape shifts.
//
// Failure rows carry a neutral evidence class (what the served entry
// shows), not an inferred cause. Investigation hints:
//   - `strategy_declaration_missing` — the served entry has no
//     `coverage_strategy`; SUGGESTS checking whether the instance's STORED
//     manifest predates the shipped strategy declarations (manifest
//     reconcile never ran or was skipped).
//   - `runtime_evidence_missing` — strategy declared but no checkpoint/
//     denominator/skip resolved the stream; SUGGESTS checking the
//     connector's coverage-evidence emission (producer side).
//   - `accepted_absence_on_required` — a required entry carries an
//     accepted-absence coverage condition; SUGGESTS a contradictory
//     manifest (`required: true` + accepted-absence `coverage_policy`).
//
// Auth is acquired through the shared `resolveOwnerAuthForLive` helper in
// scripts/lib/owner-session.mjs — the same owner-session acquisition path
// scripts/owner-journey-acceptance/live.mjs uses. Recognized environment
// variables (first match wins):
//   PDPP_ACCEPTANCE_ORIGIN or --origin   the instance origin
//   PDPP_OWNER_SESSION_COOKIE            full Cookie header for an owner session
//   PDPP_OWNER_PASSWORD                  owner password; logs in via /owner/login
//   PDPP_OWNER_TOKEN                     owner bearer token (unsupported here)
// This route family (/_ref/*) is cookie-only. A bearer token is rejected
// before any HTTP call instead of being claimed as supported — it is never
// sent as an Authorization header to a cookie-gated /_ref route.

import { auditStreamHealth } from "./audit.mjs";
import { resolveOwnerAuthForLive } from "../lib/owner-session.mjs";

/**
 * Resolve owner auth from the environment without exposing its value.
 * Cookie takes precedence over password; a bare PDPP_OWNER_TOKEN is reported
 * as unsupported rather than sent as a bearer header to a cookie-only route.
 *
 * @param {object} args
 * @param {string} args.base        origin, no trailing slash
 * @param {NodeJS.ProcessEnv} [args.env]
 * @param {Function} [args.fetchImpl]
 * @returns {Promise<{ header: Record<string,string>, mode: "cookie"|"password-session"|"bearer"|"none", supported: boolean, error: string|null }>}
 */
export async function resolveOwnerAuthForStreamHealth({ base, env = process.env, fetchImpl = fetch }) {
  const cookie = env.PDPP_OWNER_SESSION_COOKIE?.trim();
  if (cookie) {
    return { header: { cookie }, mode: "cookie", supported: true, error: null };
  }

  const password = env.PDPP_OWNER_PASSWORD?.trim();
  if (password) {
    const result = await resolveOwnerAuthForLive({ base, env, fetchImpl });
    return { ...result, supported: !result.error };
  }

  const token = env.PDPP_OWNER_TOKEN?.trim();
  if (token) {
    return { header: {}, mode: "bearer", supported: false, error: null };
  }

  return { header: {}, mode: "none", supported: false, error: null };
}

function asArrayList(raw) {
  if (Array.isArray(raw)) {
    return raw;
  }
  if (raw && typeof raw === "object" && Array.isArray(raw.data)) {
    return raw.data;
  }
  return [];
}

/**
 * Fetch `/_ref/connectors` from a live origin and run the pure audit over
 * the result.
 *
 * @param {object} args
 * @param {string} args.origin   e.g. https://pdpp.example.com
 * @param {object} [args.env]    defaults to process.env
 * @param {Function} [args.fetchImpl] injectable for tests; defaults to global fetch
 * @returns {Promise<{ origin: string, authMode: string, authCapability: string,
 *   fetched: boolean, error: string|null, connectionCount: number,
 *   ok: boolean, status: "pass"|"fail"|"inconclusive", failures: Array,
 *   inconclusive: Array }>}
 */
export async function runLiveStreamHealthAudit({ origin, env = process.env, fetchImpl = fetch }) {
  const base = origin.replace(/\/+$/, "");
  const { header, mode, supported, error: authError } = await resolveOwnerAuthForStreamHealth({
    base,
    env,
    fetchImpl,
  });

  if (!supported) {
    const error =
      mode === "bearer"
        ? "PDPP_OWNER_TOKEN is not supported for /_ref/connectors; set PDPP_OWNER_SESSION_COOKIE or PDPP_OWNER_PASSWORD instead."
        : mode === "password-session"
          ? `Owner login via PDPP_OWNER_PASSWORD failed: ${authError}`
          : "No owner session supplied. Set PDPP_OWNER_SESSION_COOKIE or PDPP_OWNER_PASSWORD to audit /_ref/connectors.";
    return {
      origin: base,
      authMode: mode,
      authCapability: "cookie_only",
      fetched: false,
      error,
      connectionCount: 0,
      ok: false,
      status: "inconclusive",
      failures: [],
      inconclusive: [],
    };
  }

  try {
    const res = await fetchImpl(`${base}/_ref/connectors?limit=500`, {
      headers: { accept: "application/json", ...header },
      redirect: "manual",
    });
    if (res.status < 200 || res.status >= 300) {
      return {
        origin: base,
        authMode: mode,
        authCapability: "cookie_only",
        fetched: false,
        error: `GET /_ref/connectors returned status ${res.status}`,
        connectionCount: 0,
        ok: false,
        status: "inconclusive",
        failures: [],
        inconclusive: [],
      };
    }
    const body = await res.text();
    const parsed = JSON.parse(body);
    const connections = asArrayList(parsed);
    const { ok, status, failures, inconclusive } = auditStreamHealth(connections);
    return {
      origin: base,
      authMode: mode,
      authCapability: "cookie_only",
      fetched: true,
      error: null,
      connectionCount: connections.length,
      ok,
      status,
      failures,
      inconclusive,
    };
  } catch (err) {
    return {
      origin: base,
      authMode: mode,
      authCapability: "cookie_only",
      fetched: false,
      error: err instanceof Error ? err.message : String(err),
      connectionCount: 0,
      ok: false,
      status: "inconclusive",
      failures: [],
      inconclusive: [],
    };
  }
}
