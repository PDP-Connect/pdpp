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

import { parseArgs, requirePositional } from "../args.js";
import { PdppCliError, PdppUsageError } from "../errors.js";
import { fetchJson, ownerSessionHeaders, resolveReferenceUrl } from "../fetch.js";
import { resolveFormat, writeData, writeEnvelopeWarnings } from "../output.js";

function projectListRow(row) {
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
    last_attempt_ok:
      row.last_attempt_ok === null || row.last_attempt_ok === undefined ? "" : row.last_attempt_ok ? "ok" : "fail",
    last_attempt_code: row.last_attempt_status_code ?? "",
    updated_at: row.updated_at,
  };
}

function projectDetail(detail) {
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

async function readConfirmation(io) {
  const stdin = io.stdin || process.stdin;
  if (!stdin || stdin.isTTY === false) {
    return null;
  }
  return new Promise((resolve) => {
    let buf = "";
    const onData = (chunk) => {
      buf += chunk;
      const newlineIdx = buf.indexOf("\n");
      if (newlineIdx !== -1) {
        stdin.removeListener("data", onData);
        if (typeof stdin.setRawMode === "function") {
          try {
            stdin.setRawMode(false);
          } catch {
            /* ignore */
          }
        }
        try {
          stdin.pause();
        } catch {
          /* ignore */
        }
        resolve(buf.slice(0, newlineIdx).trim());
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

export async function runRefEventSubscriptions(argv, io = {}, fetchImpl = globalThis.fetch) {
  const [subcommand, ...rest] = argv;
  const { flags, positionals } = parseArgs(rest);
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;

  if (subcommand === "list") {
    const asUrl = resolveReferenceUrl(flags);
    const ownerSession = flags["owner-session"] || "";
    const cacheRoot = flags["cache-root"];
    const query = new URLSearchParams();
    if (flags["client-id"]) query.set("client_id", String(flags["client-id"]));
    if (flags["grant-id"]) query.set("grant_id", String(flags["grant-id"]));
    if (flags.status) query.set("status", String(flags.status));
    const queryString = query.toString();
    const url = `${asUrl}/_ref/event-subscriptions${queryString ? `?${queryString}` : ""}`;
    const { body } = await fetchJson(
      url,
      { headers: { ...ownerSessionHeaders({ ownerSession, referenceUrl: asUrl, cacheRoot }) } },
      fetchImpl
    );
    const format = resolveFormat(flags, "table", "json");
    const rows = body?.data || [];
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
    const ownerSession = flags["owner-session"] || "";
    const cacheRoot = flags["cache-root"];
    const { body } = await fetchJson(
      `${asUrl}/_ref/event-subscriptions/${encodeURIComponent(subscriptionId)}`,
      { headers: { ...ownerSessionHeaders({ ownerSession, referenceUrl: asUrl, cacheRoot }) } },
      fetchImpl
    );
    const format = resolveFormat(flags, "table", "json");
    if (format === "table") {
      writeData(projectDetail(body), "table", out);
    } else {
      writeData(body, format, out);
    }
    writeEnvelopeWarnings(body, err);
    return 0;
  }

  if (subcommand === "disable") {
    const subscriptionId = requirePositional(positionals, 0, "subscription-id");
    const asUrl = resolveReferenceUrl(flags);
    const ownerSession = flags["owner-session"] || "";
    const cacheRoot = flags["cache-root"];
    const reason = typeof flags.reason === "string" ? flags.reason : null;
    const explicitYes = flags.yes === true || flags.yes === "true";

    if (!explicitYes) {
      const headers = { ...ownerSessionHeaders({ ownerSession, referenceUrl: asUrl, cacheRoot }) };
      const { body } = await fetchJson(
        `${asUrl}/_ref/event-subscriptions/${encodeURIComponent(subscriptionId)}`,
        { headers },
        fetchImpl
      );
      const authority = body.authority_kind || "client_grant";
      const grant = body.grant_id || "none";
      err.write(
        `Subscription ${body.subscription_id} (authority=${authority}, client=${body.client_id}, grant=${grant}, status=${body.status})\n`
      );
      err.write(`Callback: ${body.callback_url}\n`);
      err.write(`Disable subscription? Type 'yes' to confirm: `);
      const answer = await readConfirmation(io);
      if (!answer || answer.toLowerCase() !== "yes") {
        err.write("Aborted.\n");
        return 1;
      }
    }

    const body = reason ? { reason } : {};
    const { body: detail } = await fetchJson(
      `${asUrl}/_ref/event-subscriptions/${encodeURIComponent(subscriptionId)}/disable`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...ownerSessionHeaders({ ownerSession, referenceUrl: asUrl, cacheRoot }),
        },
        body: JSON.stringify(body),
      },
      fetchImpl
    );
    const format = resolveFormat(flags, "table", "json");
    if (format === "table") {
      writeData(projectDetail(detail), "table", out);
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
