#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Google Messages Connector (v0.1.0) — subprocess-wraps `gmcli`
 * (github.com/johnlindquist/gmkit) and reads its `--json` query output.
 *
 * WHAT THIS IS: Google Messages (Android SMS/RCS), reached through a
 * QR-paired web-protocol session, NOT via ADB and NOT via any Google cloud
 * API (there is no public Google Messages API). `gmkit` is a Go CLI, beta,
 * single maintainer, first commit ~April 2026, that vendors mautrix's
 * pkg/libgm (the same low-level protocol client mautrix-gmessages uses for
 * its Matrix bridge) and wraps it in a scriptable command surface. This
 * connector never imports/vendors gmkit or libgm source — it spawns the
 * `gmcli` binary as an arms-length subprocess only, exactly like this
 * repo's Slack connector wraps its own AGPL-3.0 CLI dependency (see
 * connectors/slack/index.ts).
 *
 * LICENSE: gmkit is AGPL-3.0. We invoke it as a subprocess rather than
 * importing it as a Go/Node library; PDPP's codebase is not covered by the
 * copyleft under FSF's own "mere aggregation" interpretation of arms-length
 * subprocess invocation — the same posture and rationale already applied to
 * the Slack connector's own AGPL-3.0 dependency.
 *
 * Install: see github.com/johnlindquist/gmkit. Put `gmcli` on PATH or set
 * GMCLI_BIN to its absolute path.
 *
 * NEVER SEND-CAPABLE: this connector NEVER invokes `gmcli auth`, `gmcli serve`,
 * `gmcli mcp`, or any send-capable subcommand. It only calls
 * read-only query/sync/backfill subcommands (`gmcli chats list --json`,
 * `gmcli messages search --json`, `gmcli history backfill ...`). Initial
 * QR pairing (`gmcli auth`) is interactive and MUST be run by the user
 * outside this connector — this connector cannot perform it and will not
 * attempt to.
 *
 * HONEST LIMITATIONS (also surfaced in the manifest):
 *   - The paired Android phone must stay online and reachable for gmcli to
 *     sync; this is not a headless cloud-API connector.
 *   - Session/pairing tokens require full re-pairing (`gmcli auth`, run by
 *     the user) after roughly 14 days of inactivity.
 *   - gmkit is beta software from a single maintainer with no numbered
 *     release tags (pre-1.0, git-describe-injected version) — treat its
 *     behavior and CLI surface as subject to change without notice.
 *   - Resume/incremental semantics are best-effort only: gmcli's exact
 *     resume-cursor behavior was not independently verified from source, so
 *     this connector makes NO exactly-once/gapless resume claim. Cursor
 *     advancement here is a courtesy "don't re-emit what we've already
 *     seen" optimization, not a durable guarantee.
 *   - Media attachments are NOT downloaded. gmcli has a `gmcli media
 *     download` subcommand; it is explicitly out of scope for this cut.
 *
 * FIELD PROVENANCE: gmcli's `--json` struct field names ARE independently
 * verified against gmkit's actual Go source (fetched from
 * raw.githubusercontent.com/johnlindquist/gmkit/main/internal/store/*.go —
 * not the CLI's live output, since no paired device/binary is available in
 * this environment). See schemas.ts's header comment for the exact structs
 * and field names this connector's schema is built from. No exotic fields
 * beyond what those structs declare are claimed; RCS-vs-SMS transport is
 * not a field gmcli's Message struct exposes (only `source_platform`,
 * which is honored as-is), and reactions arrive as an opaque
 * `reactions_json` string this connector does not attempt to parse.
 *
 * COVERAGE_DIAGNOSTICS: this connector reports one coverage row (store
 * "gmcli_archive") describing whether gmcli is installed, paired, and
 * queryable — emitted BEFORE any early-return SKIP_RESULT path, mirroring
 * apple_photos's "always leave durable, honest coverage evidence" rule
 * (see apple_photos/index.ts's COVERAGE_DIAGNOSTICS header comment).
 */

import { spawn } from "node:child_process";
import { runConnector } from "../../src/connector-runtime.ts";
import { isMainModule } from "../../src/is-main-module.ts";
import type { CoverageRecord } from "../../src/local-source-inventory.ts";
import type { GmcliResult } from "./fixtures.ts";
import { validateRecord } from "./schemas.ts";

// ─── gmcli binary resolution + subprocess wrapping ─────────────────────

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

export function resolveGmcliBin(): string {
  return process.env.GMCLI_BIN || "gmcli";
}

export function formatGmcliMissingError(bin: string): string {
  return [
    `gmcli binary not found: ${bin}`,
    "Install gmcli from github.com/johnlindquist/gmkit and either put it on PATH or set GMCLI_BIN to its absolute path.",
    "This connector never runs `gmcli auth` for you — pair your Android device manually first (see the gmkit README).",
  ].join(" ");
}

/**
 * Redact token/session-shaped substrings from gmcli stdout/stderr before
 * surfacing it in a diagnostic. Mirrors slack/index.ts's redaction pattern
 * for its own AGPL-3.0 CLI dependency: strip known env-sourced secrets
 * first, then a conservative generic pattern for anything token/session-
 * shaped that slips through unexpected error text.
 */
const TOKEN_SHAPED_RE = /\b[a-z0-9_-]{24,}\.[a-z0-9_-]{6,}\.[a-z0-9_-]{6,}\b/giu;
const BEARER_LIKE_RE = /\b(session|token|bearer)[=:]\s*\S+/giu;
const BEARER_LIKE_KEY_SPLIT_RE = /[=:]/u;

export function redactGmcliOutput(output: string): string {
  return output
    .replace(TOKEN_SHAPED_RE, "[REDACTED]")
    .replace(BEARER_LIKE_RE, (m) => `${m.split(BEARER_LIKE_KEY_SPLIT_RE)[0]}=[REDACTED]`);
}

const GMCLI_TIMEOUT_MS = Number(process.env.GMCLI_TIMEOUT_MS) || 2 * 60 * 1000;
const NOT_PAIRED_OUTPUT_RE =
  /not[\s_-]?paired|no[\s_-]?session|please run ["'`]?gmcli auth|auth(entication)? required/iu;

/**
 * gmcli invocation errors carry a `kind` so callers can distinguish
 * "binary missing" / "not paired" / "other query failure" without
 * re-parsing message text.
 */
export class GmcliError extends Error {
  readonly kind: "not_installed" | "not_paired" | "query_failed";
  constructor(
    message: string,
    kind: "not_installed" | "not_paired" | "query_failed",
    options: { cause?: unknown } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GmcliError";
    this.kind = kind;
  }
}

/**
 * Spawn `gmcli <args>` and collect stdout/stderr. Read-only query/sync
 * subcommands only — callers MUST NOT pass "auth", "serve", "mcp", or any
 * send-capable subcommand here.
 */
export function runGmcli(args: readonly string[], opts: { timeoutMs?: number } = {}): Promise<GmcliResult> {
  const timeoutMs = opts.timeoutMs ?? GMCLI_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const bin = resolveGmcliBin();
    const child = spawn(bin, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new GmcliError(`gmcli timed out after ${String(timeoutMs)}ms running: ${args.join(" ")}`, "query_failed"));
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr, exitCode: code });
        return;
      }
      const combined = redactGmcliOutput(`${stderr}\n${stdout}`).slice(0, 400);
      if (NOT_PAIRED_OUTPUT_RE.test(combined)) {
        reject(
          new GmcliError(
            `gmcli reports the device is not paired (exit ${String(code)}). Run \`gmcli auth\` yourself to pair — this connector cannot do it for you. Detail: ${combined}`,
            "not_paired"
          )
        );
        return;
      }
      reject(new GmcliError(`gmcli exited ${String(code)}: ${combined}`, "query_failed"));
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      if (isErrnoException(e) && e.code === "ENOENT") {
        reject(new GmcliError(formatGmcliMissingError(bin), "not_installed"));
        return;
      }
      reject(new GmcliError(redactGmcliOutput(e.message), "query_failed"));
    });
  });
}

// ─── Parsing ─────────────────────────────────────────────────────────────
//
// gmcli's `messages search --json` output is the RichHit struct
// (github.com/johnlindquist/gmkit, internal/store/search.go — verified
// from source, see schemas.ts's header comment for the full struct quote):
// message_id, conversation_id, conversation_name?, sender_name?, body,
// snippet, timestamp_ms, timestamp_iso?, is_from_me.

interface ParsedGmcliMessage {
  readonly body: string;
  readonly chat_id: string;
  readonly chat_name: string | null;
  readonly direction: "incoming" | "outgoing";
  readonly id: string;
  readonly sender_name: string | null;
  readonly sent_at: string;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * RichHit's `timestamp_iso` is `omitempty` — prefer it when present (it's
 * already a formatted timestamp gmcli computed), else derive ISO-8601 from
 * the always-present `timestamp_ms` epoch-millis field.
 */
function resolveSentAt(row: Record<string, unknown>): string | null {
  if (typeof row.timestamp_iso === "string" && row.timestamp_iso.length > 0) {
    return row.timestamp_iso;
  }
  if (typeof row.timestamp_ms === "number" && Number.isFinite(row.timestamp_ms)) {
    return new Date(row.timestamp_ms).toISOString();
  }
  return null;
}

/**
 * Parse gmcli's `--json` output for the messages stream (RichHit rows).
 * Throws on malformed JSON or a shape that lacks the required fields — the
 * caller converts that into a typed error rather than silently emitting a
 * wrong-shape record.
 */
/**
 * Convert one raw RichHit JSON row into a ParsedGmcliMessage, or throw a
 * typed GmcliError when a required field is absent/wrong-typed. Split out
 * of parseGmcliMessagesJson to keep the array-level parse loop simple.
 */
function parseGmcliMessageRow(raw: unknown): ParsedGmcliMessage {
  if (typeof raw !== "object" || raw === null) {
    throw new GmcliError("gmcli messages output contained a non-object entry", "query_failed");
  }
  const row = raw as Record<string, unknown>;
  const id = typeof row.message_id === "string" ? row.message_id : null;
  const chatId = typeof row.conversation_id === "string" ? row.conversation_id : null;
  const body = typeof row.body === "string" ? row.body : null;
  const sentAt = resolveSentAt(row);
  const isFromMe = typeof row.is_from_me === "boolean" ? row.is_from_me : null;
  if (!(id && chatId && body !== null && sentAt && isFromMe !== null)) {
    throw new GmcliError(
      "gmcli RichHit entry is missing a required field (message_id, conversation_id, body, timestamp_ms/timestamp_iso, is_from_me) — schema drift from what this connector expects",
      "query_failed"
    );
  }
  return {
    id,
    chat_id: chatId,
    chat_name: asNullableString(row.conversation_name),
    sender_name: asNullableString(row.sender_name),
    body,
    sent_at: sentAt,
    direction: isFromMe ? "outgoing" : "incoming",
  };
}

export function parseGmcliMessagesJson(stdout: string): ParsedGmcliMessage[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    // biome-ignore lint/style/useErrorCause: GmcliError's 3rd constructor arg forwards to super(message, { cause })
    throw new GmcliError(
      `gmcli messages output was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      "query_failed",
      { cause: err }
    );
  }
  if (!Array.isArray(parsed)) {
    throw new GmcliError("gmcli messages output was not a JSON array", "query_failed");
  }
  return parsed.map(parseGmcliMessageRow);
}

// ─── Coverage diagnostics ────────────────────────────────────────────────

const GMCLI_ARCHIVE_STORE = "gmcli_archive";

function buildCoverageRecord(status: CoverageRecord["status"], reason: string): CoverageRecord {
  return {
    id: `coverage:${GMCLI_ARCHIVE_STORE}`,
    store: GMCLI_ARCHIVE_STORE,
    stream: "messages",
    status,
    reason,
  };
}

// ─── Fetch + classify (extracted so `collect()` stays a thin dispatcher) ──

interface GmcliFetchOutcome {
  readonly coverageReason: string;
  readonly coverageStatus: CoverageRecord["status"];
  readonly parsed?: ParsedGmcliMessage[];
  readonly skip?: { reason: string; message: string };
}

function classifyGmcliFetchError(err: unknown): GmcliFetchOutcome {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof GmcliError && err.kind === "not_installed") {
    return {
      coverageStatus: "missing",
      coverageReason: "gmcli binary not found on PATH/GMCLI_BIN.",
      skip: { reason: "gmcli_not_installed", message },
    };
  }
  if (err instanceof GmcliError && err.kind === "not_paired") {
    return {
      coverageStatus: "excluded",
      coverageReason: "gmcli is installed but the Android device is not paired.",
      skip: { reason: "gmcli_not_paired", message },
    };
  }
  return {
    coverageStatus: "unsupported",
    coverageReason: `gmcli query failed: ${message}`,
    skip: { reason: "gmcli_query_failed", message },
  };
}

/**
 * Query gmcli for messages and parse its `--json` output, collapsing every
 * failure mode (binary missing, not paired, query failure, schema drift)
 * into one discriminated outcome. `collect()` only has to branch on
 * `outcome.skip` vs `outcome.parsed` — the fine-grained SKIP_RESULT reason
 * and coverage status/reason live here.
 */
async function fetchAndParseGmcliMessages(): Promise<GmcliFetchOutcome> {
  let result: GmcliResult;
  try {
    result = await runGmcli(["messages", "search", "--json"]);
  } catch (err) {
    return classifyGmcliFetchError(err);
  }

  try {
    const parsed = parseGmcliMessagesJson(result.stdout);
    return {
      coverageStatus: "collected",
      coverageReason: `gmcli reported ${String(parsed.length)} message(s) from the paired-device archive.`,
      parsed,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      coverageStatus: "unsupported",
      coverageReason: `gmcli messages output did not match the expected shape: ${message}`,
      skip: { reason: "gmcli_schema_drift", message },
    };
  }
}

// ─── Connector ─────────────────────────────────────────────────────────

export type GmcliInvoker = typeof runGmcli;

runConnectorGuarded();

function runConnectorGuarded(): void {
  if (!isMainModule(import.meta.url)) {
    return;
  }
  runConnector({
    name: "google_messages",
    validateRecord,
    async collect({ requested, emit, emitRecord, progress }) {
      const outcome = await fetchAndParseGmcliMessages();

      if (requested.has("coverage_diagnostics")) {
        await emitRecord("coverage_diagnostics", buildCoverageRecord(outcome.coverageStatus, outcome.coverageReason));
      }

      if (outcome.skip) {
        await emit({ type: "SKIP_RESULT", stream: "messages", ...outcome.skip });
        return;
      }

      const parsed = outcome.parsed ?? [];
      if (!requested.has("messages")) {
        return;
      }

      await progress(`Google Messages phase=emit pass=emit messages=${String(parsed.length)}`);
      for (const message of parsed) {
        await emitRecord("messages", { ...message });
      }
      await progress(`Google Messages phase=emit pass=emit done messages=${String(parsed.length)}`);
    },
  });
}
