// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `pdpp ref event-subscriptions` — operator oversight of client event
 * subscriptions. Mirrors the `_ref/event-subscriptions*` HTTP routes
 * one-to-one. Owner-session-only; the CLI never sends or receives
 * subscription secret material because the `_ref` projection strips it.
 *
 * Spec: openspec/changes/add-client-event-subscription-management/specs/
 *       reference-implementation-architecture/spec.md
 */

import { parseArgs, requirePositional } from "../args.ts";
// biome-ignore lint/style/noExportedImports: PdppCliError is re-exported by design for callers of this module's shaped error surface, matching index.ts's re-export precedent; using `export from` here trips noBarrelFile instead.
import { PdppCliError, PdppUsageError } from "../errors.ts";
import { fetchJson, ownerSessionHeaders, resolveReferenceUrl } from "../fetch.ts";
import { resolveFormat, writeData, writeEnvelopeWarnings } from "../output.ts";
import type { CommandIo } from "./call.ts";

interface SubscriptionListRow {
  authority_kind?: string;
  callback_host?: string;
  client_id?: string;
  disabled_reason?: string;
  final_failure_count?: number;
  grant_id?: string;
  last_attempt_ok?: boolean | null;
  last_attempt_status_code?: number;
  last_attempted_at?: string;
  pending_queue_count?: number;
  status?: string;
  subscription_id?: string;
  updated_at?: string;
}

interface SubscriptionDetail extends SubscriptionListRow {
  callback_url?: string;
  created_at?: string;
  disabled_at?: string;
  recent_attempts?: unknown[];
}

function formatLastAttemptOk(value: boolean | null | undefined): "" | "ok" | "fail" {
  if (value === null || value === undefined) {
    return "";
  }
  return value ? "ok" : "fail";
}

function projectListRow(row: SubscriptionListRow) {
  return {
    subscription_id: row.subscription_id,
    authority: row.authority_kind || "client_grant",
    client_id: row.client_id,
    grant_id: row.grant_id || "",
    status: row.status,
    callback_host: row.callback_host,
    disabled_reason: row.disabled_reason ?? "",
    pending: row.pending_queue_count ?? 0,
    final_failures: row.final_failure_count ?? 0,
    last_attempt_at: row.last_attempted_at ?? "",
    last_attempt_ok: formatLastAttemptOk(row.last_attempt_ok),
    last_attempt_code: row.last_attempt_status_code ?? "",
    updated_at: row.updated_at,
  };
}

function projectDetail(detail: SubscriptionDetail) {
  return {
    subscription_id: detail.subscription_id,
    authority: detail.authority_kind || "client_grant",
    client_id: detail.client_id,
    grant_id: detail.grant_id || "",
    status: detail.status,
    disabled_reason: detail.disabled_reason ?? "",
    callback_url: detail.callback_url,
    created_at: detail.created_at,
    updated_at: detail.updated_at,
    disabled_at: detail.disabled_at ?? "",
    pending_queue_count: detail.pending_queue_count,
    final_failure_count: detail.final_failure_count,
    last_attempt_at: detail.last_attempted_at ?? "",
    last_attempt_ok: detail.last_attempt_ok ?? "",
    last_attempt_code: detail.last_attempt_status_code ?? "",
    recent_attempts: (detail.recent_attempts || []).length,
  };
}

function readConfirmation(io: CommandIo): Promise<string | null> {
  const stdin = io.stdin || process.stdin;
  if (!stdin || (stdin as NodeJS.ReadStream).isTTY === false) {
    return Promise.resolve(null);
  }
  return new Promise((resolvePromise) => {
    let buf = "";
    const onData = (chunk: string) => {
      buf += chunk;
      const newlineIdx = buf.indexOf("\n");
      if (newlineIdx !== -1) {
        stdin.removeListener("data", onData);
        const rawStdin = stdin as NodeJS.ReadStream;
        if (typeof rawStdin.setRawMode === "function") {
          try {
            rawStdin.setRawMode(false);
          } catch {
            /* ignore */
          }
        }
        try {
          stdin.pause();
        } catch {
          /* ignore */
        }
        resolvePromise(buf.slice(0, newlineIdx).trim());
      }
    };
    try {
      stdin.setEncoding("utf8");
    } catch {
      /* ignore */
    }
    stdin.on("data", onData);
    try {
      stdin.resume();
    } catch {
      /* ignore */
    }
  });
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: three subcommands (list/show/disable) each a linear request/format/output sequence, dispatched by a flat if-chain, with disable additionally gating on an interactive confirmation; splitting would scatter each subcommand's request handling across helpers for no reduction in real complexity.
export async function runRefEventSubscriptions(
  argv: string[],
  io: CommandIo = {},
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<number> {
  const [subcommand, ...rest] = argv;
  const { flags, positionals } = parseArgs(rest);
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;

  if (subcommand === "list") {
    const asUrl = resolveReferenceUrl(flags);
    const ownerSession = typeof flags["owner-session"] === "string" ? flags["owner-session"] : "";
    const cacheRoot = typeof flags["cache-root"] === "string" ? flags["cache-root"] : undefined;
    const query = new URLSearchParams();
    if (flags["client-id"]) {
      query.set("client_id", String(flags["client-id"]));
    }
    if (flags["grant-id"]) {
      query.set("grant_id", String(flags["grant-id"]));
    }
    if (flags.status) {
      query.set("status", String(flags.status));
    }
    const queryString = query.toString();
    const url = `${asUrl}/_ref/event-subscriptions${queryString ? `?${queryString}` : ""}`;
    const { body } = await fetchJson(
      url,
      { headers: { ...ownerSessionHeaders({ ownerSession, referenceUrl: asUrl, cacheRoot }) } },
      fetchImpl
    );
    const format = resolveFormat(flags, "table", "json");
    const rows = (body as { data?: SubscriptionListRow[] }).data || [];
    if (format === "table") {
      writeData(rows.map(projectListRow), "table", out);
    } else {
      writeData(body, format, out);
    }
    writeEnvelopeWarnings(body, err);
    return 0;
  }

  if (subcommand === "show") {
    const subscriptionId = requirePositional(positionals, 0, "subscription-id");
    const asUrl = resolveReferenceUrl(flags);
    const ownerSession = typeof flags["owner-session"] === "string" ? flags["owner-session"] : "";
    const cacheRoot = typeof flags["cache-root"] === "string" ? flags["cache-root"] : undefined;
    const { body } = await fetchJson(
      `${asUrl}/_ref/event-subscriptions/${encodeURIComponent(subscriptionId)}`,
      { headers: { ...ownerSessionHeaders({ ownerSession, referenceUrl: asUrl, cacheRoot }) } },
      fetchImpl
    );
    const format = resolveFormat(flags, "table", "json");
    if (format === "table") {
      writeData(projectDetail(body as SubscriptionDetail), "table", out);
    } else {
      writeData(body, format, out);
    }
    writeEnvelopeWarnings(body, err);
    return 0;
  }

  if (subcommand === "disable") {
    const subscriptionId = requirePositional(positionals, 0, "subscription-id");
    const asUrl = resolveReferenceUrl(flags);
    const ownerSession = typeof flags["owner-session"] === "string" ? flags["owner-session"] : "";
    const cacheRoot = typeof flags["cache-root"] === "string" ? flags["cache-root"] : undefined;
    const reason = typeof flags.reason === "string" ? flags.reason : null;
    const explicitYes = flags.yes === true || flags.yes === "true";

    if (!explicitYes) {
      const headers = { ...ownerSessionHeaders({ ownerSession, referenceUrl: asUrl, cacheRoot }) };
      const { body } = await fetchJson(
        `${asUrl}/_ref/event-subscriptions/${encodeURIComponent(subscriptionId)}`,
        { headers },
        fetchImpl
      );
      const detail = body as SubscriptionDetail;
      const authority = detail.authority_kind || "client_grant";
      const grant = detail.grant_id || "none";
      err.write(
        `Subscription ${detail.subscription_id} (authority=${authority}, client=${detail.client_id}, grant=${grant}, status=${detail.status})\n`
      );
      err.write(`Callback: ${detail.callback_url}\n`);
      err.write("Disable subscription? Type 'yes' to confirm: ");
      const answer = await readConfirmation(io);
      if (answer?.toLowerCase() !== "yes") {
        err.write("Aborted.\n");
        return 1;
      }
    }

    const requestBody = reason ? { reason } : {};
    const { body: detail } = await fetchJson(
      `${asUrl}/_ref/event-subscriptions/${encodeURIComponent(subscriptionId)}/disable`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...ownerSessionHeaders({ ownerSession, referenceUrl: asUrl, cacheRoot }),
        },
        body: JSON.stringify(requestBody),
      },
      fetchImpl
    );
    const format = resolveFormat(flags, "table", "json");
    if (format === "table") {
      writeData(projectDetail(detail as SubscriptionDetail), "table", out);
    } else {
      writeData(detail, format, out);
    }
    return 0;
  }

  throw new PdppUsageError(
    "Usage:\n" +
      "  pdpp ref event-subscriptions list [--client-id <id>] [--grant-id <id>] [--status <status>] [--as-url <url>] [--owner-session <cookie>] [--format json|table]\n" +
      "  pdpp ref event-subscriptions show <subscription-id> [--as-url <url>] [--owner-session <cookie>] [--format json|table]\n" +
      "  pdpp ref event-subscriptions disable <subscription-id> [--reason <text>] [--yes] [--as-url <url>] [--owner-session <cookie>]"
  );
}

// Re-export for shaped error surface in case the CLI dispatcher needs it.
export { PdppCliError };
