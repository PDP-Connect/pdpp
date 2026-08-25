#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Read-only `/sources` probe for operators and agents.
//
// Prints, per connection, the SAME computed verdict the console `/sources`
// page renders: the per-source status dot and its owner-facing pill label,
// the per-stream coverage words, and the freshness / outbox / coverage axes.
//
// WHY: an agent reading raw `connector_summary_evidence` rows out of Postgres
// is reading the INPUTS to the health computation, while the owner reads the
// rendered verdict on the page — the OUTPUT. Those diverged badly enough to
// cause repeated miscommunication (the agent said "amber" where the page said
// "not measured"; said "green data" where the page drew a red "can't collect"
// marker). Every rendering-layer defect was invisible to the agent. This
// script closes that gap by reading the same projection the page reads.
//
// It does NOT recompute the verdict. `rendered_verdict.pill` is computed
// server-side and arrives over the wire; the console does not second-guess it
// and neither does this. The owner-facing axis words come from
// `@pdpp/display`, which is the single definition the console imports too, so
// the two cannot drift apart.
//
// Usage:
//   node reference-implementation/scripts/sources-report.ts               # AS=http://localhost:7662
//   node reference-implementation/scripts/sources-report.ts --json        # JSON to stdout only
//   node reference-implementation/scripts/sources-report.ts --streams     # per-stream coverage rows
//   node reference-implementation/scripts/sources-report.ts --checkpoints # flag complete-but-uncommitted streams
//   AS_URL=https://pdpp.example PDPP_OWNER_PASSWORD=... node ... sources-report.ts
//
// Auth:
//   - When PDPP_OWNER_PASSWORD is set (the production/Docker default), mint a
//     short-lived owner-session cookie locally using the same derivation as
//     `server/owner-session.ts`. The `_ref` routes accept exactly one
//     credential — a signed `pdpp_owner_session` cookie — and the secret is a
//     pure scrypt KDF over the password with no server-side state, so no
//     browser and no live login round-trip is required.
//   - Or set PDPP_OWNER_SESSION_COOKIE to a cookie obtained by any other
//     means (e.g. `pdpp ref login`).
//   - When neither is set (open local-dev mode), the server lets the request
//     through unauthenticated.
//
// Read-only: issues GET requests only, and mutates nothing.

import { deriveOwnerSessionSecret, encodeOwnerSession, OWNER_SESSION_COOKIE_NAME } from "../server/owner-session.ts";
import {
  type ConnectorSummaryLike,
  projectSourceRows,
  type SourceRow,
  uncommittedCompleteStreams,
} from "./sources-report-model.ts";

/** Parsed CLI flags: `--flag=value`, `--flag value`, or bare `--flag` (boolean). */
type CliFlags = Record<string, string | boolean>;

/**
 * `/_ref/connectors` fails closed without an explicit `limit` (it no longer
 * serves an unbounded fleet-wide response), and 100 is the max page size the
 * console itself requests.
 */
const PAGE_LIMIT = 100;
/** Bounds the page-follow loop so a cursor bug cannot spin forever. */
const PAGE_GUARD = 200;
/** The minted cookie only has to outlive this one process. */
const SESSION_TTL_SECONDS = 300;

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
  const cookieValue = encodeOwnerSession(
    { exp: nowSeconds + SESSION_TTL_SECONDS, iat: nowSeconds, sub: subjectId },
    secret
  );
  return `${OWNER_SESSION_COOKIE_NAME}=${encodeURIComponent(cookieValue)}`;
}

function fail(message: string, detail?: unknown): never {
  process.stderr.write(`${message}\n`);
  if (detail !== undefined) {
    process.stderr.write(`${typeof detail === "string" ? detail : JSON.stringify(detail, null, 2)}\n`);
  }
  process.exit(1);
}

interface ConnectorsPage {
  data?: ConnectorSummaryLike[];
  has_more?: boolean;
  next_cursor?: string | null;
}

async function fetchAllSummaries(
  baseUrl: string,
  requestHeaders: Record<string, string>
): Promise<ConnectorSummaryLike[]> {
  const summaries: ConnectorSummaryLike[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < PAGE_GUARD; page += 1) {
    const url = new URL(`${baseUrl}/_ref/connectors`);
    url.searchParams.set("limit", String(PAGE_LIMIT));
    // `sources_visibility=1` asks the reference to exclude recovered
    // historical fragments BEFORE its own LIMIT. The `/sources` page is the
    // only console surface that sets it, so omitting it here would list rows
    // the owner does not see.
    url.searchParams.set("sources_visibility", "1");
    if (cursor) {
      url.searchParams.set("cursor", cursor);
    }
    let response: Response;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: each page's cursor depends on the previous page's response.
      response = await fetch(url, { headers: requestHeaders });
    } catch (error) {
      return fail(`Request to ${url.pathname} failed: ${(error as Error).message}`);
    }
    const text = await response.text();
    if (!response.ok) {
      if (response.status === 401) {
        return fail(
          `HTTP 401 from ${url.pathname}. The _ref routes need an owner session: set PDPP_OWNER_PASSWORD ` +
            "(or PDPP_OWNER_SESSION_COOKIE) for this process.",
          text
        );
      }
      return fail(`HTTP ${response.status} from ${url.pathname}`, text);
    }
    let body: ConnectorsPage;
    try {
      body = JSON.parse(text) as ConnectorsPage;
    } catch {
      return fail(`Non-JSON response from ${url.pathname}`, text.slice(0, 400));
    }
    summaries.push(...(body.data ?? []));
    if (!(body.has_more && body.next_cursor)) {
      return summaries;
    }
    cursor = body.next_cursor;
  }
  return fail(`Page guard hit after ${PAGE_GUARD} pages of /_ref/connectors — refusing to loop further.`);
}

function renderRow(row: SourceRow, withStreams: boolean): string {
  const lines: string[] = [];
  // `row.fusedLine` is the exact text the `/sources` card row renders
  // (`fusedStatus.line` — state · freshness · syncing, worst-honest-axis
  // first). Printing it here, not the bare `status.label`, is what makes
  // this CLI say the same thing the owner reads on the page.
  lines.push(`${row.status.dot} ${row.displayName}  [${row.fusedLine}]`);
  const identity = [row.connectorId, row.connectionId].filter(Boolean).join("  ");
  if (identity) {
    lines.push(`    ${identity}`);
  }
  if (row.forwardStatement) {
    lines.push(`    ${row.forwardStatement}`);
  }
  if (row.headline) {
    lines.push(`    ${row.headline}`);
  }
  lines.push(`    axes: coverage ${row.axes.coverage} · freshness ${row.axes.freshness} · outbox ${row.axes.outbox}`);
  for (const action of row.requiredActions) {
    lines.push(`    action: ${action}`);
  }
  if (withStreams) {
    for (const stream of row.streams) {
      const parts = [stream.coverageLabel];
      if (stream.countsLabel) {
        parts.push(stream.countsLabel);
      }
      if (stream.skipped) {
        parts.push(`skipped: ${stream.skipped}`);
      }
      // `committed` is the uneventful case and `unknown` means the summary
      // carried no checkpoint fact at all — printing either on every stream
      // would bury the two values that actually say something.
      if (stream.checkpoint && stream.checkpoint !== "committed" && stream.checkpoint !== "unknown") {
        parts.push(`checkpoint: ${stream.checkpoint}`);
      }
      lines.push(`      ${stream.stream.padEnd(28)} ${parts.join(" / ")}`);
    }
  }
  return lines.join("\n");
}

const flags = parseArgs(process.argv.slice(2));
const asUrlFlag = flags["as-url"];
const asUrl = (
  (typeof asUrlFlag === "string" ? asUrlFlag : null) ||
  process.env.AS_URL ||
  process.env.PDPP_AS_URL ||
  `http://localhost:${process.env.AS_PORT || 7662}`
).replace(/\/$/, "");

/**
 * Resolves the one credential the `_ref` routes accept: a signed
 * `pdpp_owner_session` cookie. An explicit cookie wins; otherwise the cookie
 * is minted offline from the owner password. Empty means "open local-dev
 * mode", where the server lets the request through unauthenticated.
 */
function resolveCookieHeader(): string {
  const explicitCookie = process.env.PDPP_OWNER_SESSION_COOKIE || "";
  if (explicitCookie) {
    return explicitCookie.includes("=") ? explicitCookie : `${OWNER_SESSION_COOKIE_NAME}=${explicitCookie}`;
  }
  const ownerPassword = process.env.PDPP_OWNER_PASSWORD || "";
  if (ownerPassword) {
    return buildOwnerCookieHeader(ownerPassword, process.env.PDPP_OWNER_SUBJECT_ID || "owner_local");
  }
  return "";
}

const cookieHeader = resolveCookieHeader();
const topLevelHeaders: Record<string, string> = {
  Accept: "application/json",
  ...(cookieHeader ? { Cookie: cookieHeader } : {}),
};

const rows = await projectSourceRows(await fetchAllSummaries(asUrl, topLevelHeaders));
const streamsRequested = flags.streams === true || flags.streams === "true" || flags.json === true;

if (flags.json === true || flags.json === "true") {
  process.stdout.write(`${JSON.stringify({ as_url: asUrl, sources: rows }, null, 2)}\n`);
} else {
  process.stdout.write(`sources @ ${asUrl}  (${rows.length} visible)\n\n`);
  for (const row of rows) {
    process.stdout.write(`${renderRow(row, streamsRequested)}\n\n`);
  }
}

if (flags.checkpoints === true || flags.checkpoints === "true") {
  const flagged = uncommittedCompleteStreams(rows);
  process.stdout.write(`complete-but-uncommitted streams (${flagged.length}):\n`);
  for (const entry of flagged) {
    process.stdout.write(
      `  ${entry.displayName} / ${entry.stream}: coverage complete${entry.countsLabel ? `, ${entry.countsLabel}` : ""}, checkpoint not_committed\n`
    );
  }
}
