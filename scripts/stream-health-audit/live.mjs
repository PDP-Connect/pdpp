// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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

import { resolveOwnerAuthForLive } from "../lib/owner-session.mjs";
import { auditStreamHealth } from "./audit.mjs";

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
    return { error: null, header: { cookie }, mode: "cookie", supported: true };
  }

  const password = env.PDPP_OWNER_PASSWORD?.trim();
  if (password) {
    const result = await resolveOwnerAuthForLive({ base, env, fetchImpl });
    return { ...result, supported: !result.error };
  }

  const token = env.PDPP_OWNER_TOKEN?.trim();
  if (token) {
    return { error: null, header: {}, mode: "bearer", supported: false };
  }

  return { error: null, header: {}, mode: "none", supported: false };
}

const TRAILING_SLASHES_RE = /\/+$/;

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
  const base = origin.replace(TRAILING_SLASHES_RE, "");
  const {
    header,
    mode,
    supported,
    error: authError,
  } = await resolveOwnerAuthForStreamHealth({
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
      authCapability: "cookie_only",
      authMode: mode,
      connectionCount: 0,
      error,
      failures: [],
      fetched: false,
      inconclusive: [],
      ok: false,
      origin: base,
      status: "inconclusive",
    };
  }

  try {
    const res = await fetchImpl(`${base}/_ref/connectors?limit=500`, {
      headers: { accept: "application/json", ...header },
      redirect: "manual",
    });
    if (res.status < 200 || res.status >= 300) {
      return {
        authCapability: "cookie_only",
        authMode: mode,
        connectionCount: 0,
        error: `GET /_ref/connectors returned status ${res.status}`,
        failures: [],
        fetched: false,
        inconclusive: [],
        ok: false,
        origin: base,
        status: "inconclusive",
      };
    }
    const body = await res.text();
    const parsed = JSON.parse(body);
    const connections = asArrayList(parsed);
    const { ok, status, failures, inconclusive } = auditStreamHealth(connections);
    return {
      authCapability: "cookie_only",
      authMode: mode,
      connectionCount: connections.length,
      error: null,
      failures,
      fetched: true,
      inconclusive,
      ok,
      origin: base,
      status,
    };
  } catch (err) {
    return {
      authCapability: "cookie_only",
      authMode: mode,
      connectionCount: 0,
      error: err instanceof Error ? err.message : String(err),
      failures: [],
      fetched: false,
      inconclusive: [],
      ok: false,
      origin: base,
      status: "inconclusive",
    };
  }
}
