#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Requeue terminal detail gaps for one explicit connection, for an
 * explicitly named, allowlisted terminal `reason`.
 *
 * This is an owner/operator repair tool for the reference implementation's
 * durable detail-gap substrate. It exists for the case where a connector or
 * runtime repair makes it reasonable to retry rows that previously exhausted
 * a bounded attempt budget and were terminalized under a reason that does
 * NOT represent durable impossibility.
 *
 * `--reason` defaults to `quarantined` (the original, narrower behavior this
 * tool shipped with) but may name any reason on the store's requeueable
 * allowlist: `quarantined`, `temporary_unavailable`, `retry_exhausted`,
 * `run_cap_deferred`. Every one of those is a BOUNDED-BUDGET exhaustion on a
 * signal that was never proven non-transient — retrying is a legitimate
 * re-measurement, not wishful thinking.
 *
 * Reasons that represent durable impossibility are refused categorically by
 * the store layer (`assertRequeueableReason` in
 * `server/stores/connector-detail-gap-store.ts`), not merely left out of a
 * suggested list here:
 *   - `not_found` / `gone` / `permanent_forbidden` — proven by an explicit
 *     non-transient HTTP signal (404/410/permanent-403); the resource is
 *     confirmed gone, not merely unretried.
 *   - `too_large` — Gmail's oversized-attachment terminal class. A `too_large`
 *     row can carry durable per-item proof (observed byte size recorded
 *     strictly greater than the configured cap). Requeuing a 29 MB
 *     attachment against a 25 MB cap can never converge — it would spin the
 *     recovery budget forever confirming the same impossibility. This tool
 *     has no way to check that per-row proof safely in bulk, so `too_large`
 *     is refused outright rather than requeued speculatively.
 *
 *     If you came here trying to requeue `too_large` rows: that refusal stands,
 *     and this tool will never accept the reason. A `too_large` proof CAN be
 *     false (a message-scoped size checked against a per-part cap condemns
 *     collectible items), but establishing that requires comparing each row
 *     against the item's OWN recorded size — per-row adjudication this bulk
 *     path deliberately does not do. Use
 *     `requeue-fabricated-too-large-detail-gaps.ts`, which requeues a row only
 *     when its claim is positively contradicted and leaves genuinely-oversized,
 *     uncorroborated, and unparseable rows terminal.
 *   - `auth_failure` — requires owner re-authentication, not a data retry.
 *   - `not_available_in_mode` / `out_of_scope` / `user_disabled` —
 *     informational, by-design terminal states, not failures to retry.
 *
 * See `assertRequeueableReason`'s doc comment for the full reasoning.
 *
 * Safety model:
 *   - Dry-run by default; `--apply` is required to write.
 *   - Requires one explicit connector id and connector instance id.
 *   - Optional `--stream` filters are additive; no payloads or locators print.
 *   - `--reason` is validated against the store's allowlist BEFORE any read
 *     or write; an unlisted reason (including `too_large`) fails closed with
 *     an explanatory error and touches zero rows.
 *   - The implementation's apply path uses the tested detail-gap store
 *     primitive, which re-checks `status = 'terminal' AND reason = <reason>`
 *     in the same UPDATE that flips a row back to pending.
 *
 * Usage:
 *   PDPP_DATABASE_URL=postgres://... \
 *   node reference-implementation/scripts/repair/requeue-quarantined-detail-gaps.ts \
 *     --connector-id=amazon \
 *     --connector-instance-id=cin_... \
 *     --stream=order_items \
 *     [--reason=temporary_unavailable] \
 *     [--limit=100 --apply]
 */

import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  closePostgresStorage,
  initExistingPostgresRepairStorage,
  POSTGRES_DETAIL_GAP_REPAIR_REQUIRED_TABLES,
  postgresQuery,
} from "../../server/postgres-storage.ts";
import {
  createPostgresConnectorDetailGapStore,
  TERMINAL_REQUEUE_REASON_ALLOWLIST,
} from "../../server/stores/connector-detail-gap-store.ts";

const DEFAULT_REQUEUE_REASON = "quarantined";

interface ParsedRequeueArgs {
  apply: boolean;
  connectorId: string | null;
  connectorInstanceId: string | null;
  limit: number;
  /** Value-taking flags given with no value (e.g. a trailing `--reason`). Collected
   *  rather than defaulted, so the tool refuses instead of acting on a guess. */
  missingValueFlags: string[];
  reason: string;
  streams: string[];
}

/**
 * Apply one parsed `--key[=value]` flag to `out` in place. Extracted from
 * `parseArgs`'s loop purely to keep that loop's own cognitive complexity
 * under Biome's budget -- the per-key dispatch and value-parsing behavior is
 * unchanged from the inline version it replaces.
 */
function applyParsedFlag(out: ParsedRequeueArgs, seenStreams: Set<string>, key: string, value: string | boolean): void {
  if (key === "apply") {
    out.apply = true;
  } else if (key === "connector-id") {
    out.connectorId = String(value);
  } else if (key === "connector-instance-id") {
    out.connectorInstanceId = String(value);
  } else if (key === "limit") {
    const parsed = Number.parseInt(String(value), 10);
    out.limit = Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 500) : out.limit;
  } else if (key === "reason") {
    const reason = String(value);
    if (reason) {
      out.reason = reason;
    }
  } else if (key === "stream") {
    const stream = String(value);
    if (stream && !seenStreams.has(stream)) {
      seenStreams.add(stream);
      out.streams.push(stream);
    }
  }
}

function parseArgs(argv: string[]): ParsedRequeueArgs {
  const out: ParsedRequeueArgs = {
    apply: false,
    connectorId: null,
    connectorInstanceId: null,
    limit: 100,
    missingValueFlags: [],
    reason: DEFAULT_REQUEUE_REASON,
    streams: [],
  };
  const seenStreams = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith("--")) {
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq > 0) {
      applyParsedFlag(out, seenStreams, arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const key = arg.slice(2);
    // `--apply` is the only genuine boolean. Every other flag takes a value, so
    // the space-separated form must consume the NEXT argv entry. It previously
    // substituted `true` and dropped the value: `--reason too_large` parsed as
    // `reason = "true"`, which the allowlist then rejected with a message naming
    // 'true' rather than the reason the operator actually typed. Silently
    // misreading its own arguments is unacceptable in a tool that writes to
    // production, so an unvalued non-boolean flag is now an explicit error
    // rather than a fabricated value.
    if (key === "apply") {
      applyParsedFlag(out, seenStreams, key, true);
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      out.missingValueFlags.push(key);
      continue;
    }
    index += 1;
    applyParsedFlag(out, seenStreams, key, next);
  }
  return out;
}

/**
 * Validate CLI args, INCLUDING the `--reason` allowlist check, before any
 * database access happens. An unlisted reason (e.g. `too_large`,
 * `not_found`, `auth_failure`) fails here with an explanatory error and the
 * command never opens a connection or reads a row — refusal is immediate
 * and total, not a zero-row no-op that could be mistaken for "nothing
 * matched". The store re-asserts the same allowlist independently
 * (`assertRequeueableReason`); this earlier check exists purely for a fast,
 * connection-free operator error message.
 */
function validateArgs(args: ParsedRequeueArgs): string | null {
  if (args.missingValueFlags.length) {
    return `missing value for: ${args.missingValueFlags.map((flag) => `--${flag}`).join(", ")}`;
  }
  if (!args.connectorId) {
    return "--connector-id is required";
  }
  if (!args.connectorInstanceId) {
    return "--connector-instance-id is required";
  }
  if (!TERMINAL_REQUEUE_REASON_ALLOWLIST.has(args.reason)) {
    return `--reason='${args.reason}' is not requeueable (allowed: ${[...TERMINAL_REQUEUE_REASON_ALLOWLIST].join(", ")}); durable-impossibility reasons such as 'too_large' and 'not_found' are refused by design`;
  }
  return null;
}

interface CountQuarantinedScope {
  connectorId: string;
  connectorInstanceId: string;
  reason: string;
  streams: string[];
}

/**
 * The subset of `postgresQuery`'s result shape this tool reads.
 * `server/postgres-storage.js` is untyped JS (checkJs: false); this
 * interface is the honest contract for exactly the row shape the
 * `COUNT(*) AS gap_count` query below returns.
 */
interface GapCountRow {
  gap_count: string | number;
}

interface PostgresQueryResult<Row> {
  rows: Row[];
}

async function countQuarantined({
  connectorId,
  connectorInstanceId,
  reason,
  streams,
}: CountQuarantinedScope): Promise<number> {
  const result: PostgresQueryResult<GapCountRow> = await postgresQuery(
    `
      SELECT COUNT(*) AS gap_count
      FROM connector_detail_gaps
      WHERE connector_id = $1
        AND connector_instance_id = $2
        AND status = 'terminal'
        AND reason = $3
        AND ($4::text[] IS NULL OR stream = ANY($4::text[]))
    `,
    [connectorId, connectorInstanceId, reason, streams.length ? streams : null]
  );
  // biome-ignore lint/suspicious/noUnnecessaryConditions: false positive -- Biome does not model noUncheckedIndexedAccess; `result.rows[0]` is genuinely `GapCountRow | undefined` (verified with an isolated tsc repro), so both `?.` and `?? 0` are live for the zero-rows case.
  return Number(result.rows[0]?.gap_count ?? 0);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const error = validateArgs(args);
  if (error) {
    console.error(error);
    process.exitCode = 2;
    return;
  }
  const databaseUrl = process.env.PDPP_DATABASE_URL || process.env.PDPP_TEST_POSTGRES_URL || null;
  if (!databaseUrl) {
    console.error("PDPP_DATABASE_URL is required");
    process.exitCode = 2;
    return;
  }
  const { connectorId, connectorInstanceId } = args;
  if (!(connectorId && connectorInstanceId)) {
    // Unreachable given validateArgs above; narrows the types for the calls below.
    console.error("--connector-id and --connector-instance-id are required");
    process.exitCode = 2;
    return;
  }

  // Repair tools target an already-migrated live database. Opening through the
  // existing-schema path is essential: full runtime bootstrap performs DDL in
  // one transaction and can deadlock with normal records writes.
  await initExistingPostgresRepairStorage(
    { backend: "postgres", databaseUrl },
    { requiredTables: POSTGRES_DETAIL_GAP_REPAIR_REQUIRED_TABLES }
  );
  try {
    const matched = await countQuarantined({
      connectorId,
      connectorInstanceId,
      reason: args.reason,
      streams: args.streams,
    });
    const summary = args.apply
      ? await createPostgresConnectorDetailGapStore().requeueQuarantinedTerminalGapsForConnectorInstance(
          connectorId,
          connectorInstanceId,
          {
            limit: args.limit,
            reason: args.reason,
            streams: args.streams,
          }
        )
      : { matched, requeued: 0 };

    console.log(
      JSON.stringify(
        {
          applied: args.apply,
          connector_id: connectorId,
          connector_instance_id: connectorInstanceId,
          limit: args.limit,
          matched,
          reason: args.reason,
          requeued: summary.requeued,
          streams: args.streams,
        },
        null,
        2
      )
    );
  } finally {
    await closePostgresStorage();
  }
}

/** Best-effort cleanup on the error path; a secondary close failure never masks the original error. */
async function closePostgresStorageBestEffort(): Promise<void> {
  try {
    await closePostgresStorage();
  } catch {
    // Intentionally swallowed; the caller's original error is what surfaces.
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(async (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    await closePostgresStorageBestEffort();
    process.exitCode = 1;
  });
}
