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
// Auth follows the same env conventions as
// scripts/owner-journey-acceptance/live.mjs:
//   PDPP_ACCEPTANCE_ORIGIN or --origin   the instance origin
//   PDPP_OWNER_SESSION_COOKIE            full Cookie header for an owner session
//   PDPP_OWNER_TOKEN                     owner bearer token (fallback)
// Auth values are read from the environment and never printed — only
// whether auth was supplied (the resolved mode).

import { auditStreamHealth } from "./audit.mjs";

/**
 * Resolve owner auth from the environment without exposing its value.
 * Mirrors `resolveOwnerAuthFromEnv` in scripts/owner-journey-acceptance/live.mjs.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ header: Record<string,string>, mode: "cookie"|"bearer"|"none" }}
 */
export function resolveOwnerAuthFromEnv(env = process.env) {
  const cookie = env.PDPP_OWNER_SESSION_COOKIE?.trim();
  if (cookie) {
    return { header: { cookie }, mode: "cookie" };
  }
  const token = env.PDPP_OWNER_TOKEN?.trim();
  if (token) {
    return { header: { authorization: `Bearer ${token}` }, mode: "bearer" };
  }
  return { header: {}, mode: "none" };
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
 * @returns {Promise<{ origin: string, authMode: string, fetched: boolean,
 *   error: string|null, connectionCount: number, ok: boolean, failures: Array }>}
 */
export async function runLiveStreamHealthAudit({ origin, env = process.env, fetchImpl = fetch }) {
  const base = origin.replace(/\/+$/, "");
  const { header, mode } = resolveOwnerAuthFromEnv(env);

  try {
    const res = await fetchImpl(`${base}/_ref/connectors?limit=500`, {
      headers: { accept: "application/json", ...header },
      redirect: "manual",
    });
    if (res.status < 200 || res.status >= 300) {
      return {
        origin: base,
        authMode: mode,
        fetched: false,
        error: `GET /_ref/connectors returned status ${res.status}`,
        connectionCount: 0,
        ok: false,
        failures: [],
      };
    }
    const body = await res.text();
    const parsed = JSON.parse(body);
    const connections = asArrayList(parsed);
    const { ok, failures } = auditStreamHealth(connections);
    return {
      origin: base,
      authMode: mode,
      fetched: true,
      error: null,
      connectionCount: connections.length,
      ok,
      failures,
    };
  } catch (err) {
    return {
      origin: base,
      authMode: mode,
      fetched: false,
      error: err instanceof Error ? err.message : String(err),
      connectionCount: 0,
      ok: false,
      failures: [],
    };
  }
}
