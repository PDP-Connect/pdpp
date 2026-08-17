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
 * `gmcli mcp`, `gmcli sync --follow`, or any send-capable/streaming
 * subcommand. It only calls two read-only, single-invocation, bounded
 * subcommands: `gmcli --json --full chats list` (enumerate conversations)
 * and, per conversation, `gmcli messages list --conv <id> --json --full
 * --limit <N> --order desc` (that conversation's NEWEST N messages, up to
 * the bound — see BOUNDING below for why newest-first, not oldest-first).
 * Both open the local SQLite archive, run one query, print,
 * and exit — there is no daemon/streaming mode for reads; `--follow` exists
 * only on the separate `gmcli sync` ingest command, which this connector
 * never invokes. Initial QR pairing (`gmcli auth`) is interactive and MUST
 * be run by the user outside this connector — this connector cannot
 * perform it and will not attempt to.
 *
 * COMMAND CONTRACT (verified from gmkit source, not guessed): global flags
 * (`--json`, `--full`, `--store`, `--log-level`, `--read-only`) are Cobra
 * root persistent flags — this connector places them before the
 * subcommand for clarity, though Cobra accepts them after too.
 * `messages search` requires a query term (cobra.MinimumNArgs(1)) and
 * returns a different struct (RichHit) meant for keyword search, NOT a
 * complete per-conversation archive — this connector deliberately does
 * NOT use it for that reason. `messages list --conv <id>` is the correct
 * complete-listing command and has no query-term requirement.
 *
 * BOUNDING: `messages list` exposes only `--limit` (no offset/cursor flag
 * exists in gmkit's CLI) — there is no built-in pagination beyond a flat
 * count cap. This connector treats `--limit` as a hard per-conversation
 * cap (GMCLI_MESSAGES_PER_CHAT_LIMIT, default below) and fetches with
 * `--order desc` (newest-first, see fetchChatMessages's doc comment) so a
 * conversation that keeps hitting the cap always has its NEWEST activity
 * inside the fetched window on every run — new messages remain observable
 * indefinitely, not just up to whatever a fixed oldest-first prefix once
 * captured. The cost moves to the OTHER end: history older than the newest
 * N in a limit-hitting conversation is not fetched. This connector emits an
 * explicit `coverage_diagnostics` reason plus a dedicated SKIP_RESULT
 * diagnostic when any conversation hits that cap, rather than silently
 * returning a partial history as if it were complete. Similarly, the
 * number of conversations scanned per run is capped (GMCLI_MAX_CHATS).
 * `chats list` is always called with an explicit `--limit` sized to
 * `GMCLI_MAX_CHATS + 1` — never left unset, since gmcli's own `chats list`
 * defaults `--limit` to 50 server-side (verified from gmkit's Go source),
 * which would otherwise silently cap enumeration to 50 UPSTREAM of this
 * connector's own bounding, defeating GMCLI_MAX_CHATS entirely for any
 * archive over 50 conversations. When that probe fetch confirms truncation
 * (more than GMCLI_MAX_CHATS chats returned), the chats kept are the
 * GMCLI_MAX_CHATS most-recently-active ones (sorted by
 * `last_message_time_ms` descending, ties broken by `conversation_id` for
 * a documented total order — see sortChatsByRecency), and a `messages`
 * SKIP_RESULT documents that a lower bound of chats exist beyond what was
 * scanned this run (an honest "at least N", never a precise total the
 * connector cannot actually see past its own bounded probe).
 *
 * HONEST LIMITATIONS (also surfaced in the manifest):
 *   - The paired Android phone must stay online and reachable for gmcli to
 *     sync; this is not a headless cloud-API connector.
 *   - Session/pairing tokens require full re-pairing (`gmcli auth`, run by
 *     the user) after roughly 14 days of inactivity.
 *   - gmkit is beta software from a single maintainer with no numbered
 *     release tags (pre-1.0, git-describe-injected version) — treat its
 *     behavior and CLI surface as subject to change without notice.
 *   - Resume/incremental semantics are best-effort only: gmcli exposes no
 *     "since" cursor (see BOUNDING above — `--limit` is a flat cap, not a
 *     pagination token), so every run re-fetches a bounded window per
 *     conversation from scratch. This connector's own STATE cursor (see
 *     STATE below) is therefore a connector-side, not gmcli-side,
 *     de-duplication courtesy: it makes NO exactly-once/gapless resume
 *     claim, only "don't re-emit a message whose fetched content is
 *     byte-identical to what a prior run already emitted." It does NOT
 *     provide historical convergence: a conversation that has ever hit its
 *     per-chat limit has a permanent gap between the newest N messages
 *     (fetched every run) and whatever came before them — that gap is never
 *     backfilled by this connector on its own. Raising
 *     GMCLI_MESSAGES_PER_CHAT_LIMIT and re-running is the only way to widen
 *     the fetched window and recover more of a truncated conversation's
 *     older history, per the existing `gmcli_per_chat_limit_reached`
 *     SKIP_RESULT's own guidance.
 *
 * STATE: `state.messages` carries a per-message-id content fingerprint
 * (`openFingerprintCursor`, shared with groupme/slack/gmail/ynab) seeded
 * from the prior run's cursor. A re-fetched message whose fingerprint is
 * unchanged is NOT re-emitted as a RECORD this run — this is what stops
 * every run from duplicating the same bounded per-chat window into
 * downstream storage. The cursor is carry-forward only (no `pruneStale`):
 * gmcli gives no deletion signal for messages that scroll out of the
 * `--limit` window or a conversation gmcli stops returning, so an id once
 * seen stays remembered rather than being dropped and re-emitted as "new"
 * later. STATE is written after every message in this run's fetch has been
 * evaluated by the cursor and queued for emission — never before — and the
 * local-collector runtime itself only durably commits a buffered STATE
 * cursor after the record batches emitted in the same run have been
 * enqueued (see collector-runner.ts's flushPendingBatch-before-checkpoint
 * ordering), so a crash or interruption before that point leaves the prior
 * checkpoint (or none) in place rather than a checkpoint claiming coverage
 * this run never durably queued.
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
import { type CollectContext, emitDetailCoverage, runConnector } from "../../src/connector-runtime.ts";
import { openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
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
// `gmcli --json --full chats list` and `gmcli messages list --conv <id>
// --json --full` both serialize gmkit's `store.Message`/`store.Conversation`
// structs (github.com/johnlindquist/gmkit, internal/store/messages.go +
// conversations.go — verified from source, see schemas.ts's header comment
// for the exact struct quotes):
//   Conversation: conversation_id, name, is_group, last_message_time_ms, ...
//   Message: message_id, conversation_id, source_platform, sender_id,
//            body?, timestamp_ms, is_from_me, media_id?, mime_type?,
//            reactions_json?, reply_to_id?

interface ParsedGmcliChat {
  readonly id: string;
  readonly lastMessageTimeMs: number | null;
  readonly name: string | null;
}

interface ParsedGmcliMessage {
  readonly body: string;
  readonly chat_id: string;
  readonly chat_name: string | null;
  readonly direction: "incoming" | "outgoing";
  readonly id: string;
  readonly sender_id: string | null;
  readonly sent_at: string;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// A zero/negative timestamp_ms is gmcli reporting "no timestamp", not the
// epoch — returning null routes it to the missing-required-field throw below
// rather than stamping 1970-01-01 on `sent_at` (the semantic-time source).
function isoFromEpochMs(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : null;
}

// Same "zero/negative/missing means no timestamp" rule as isoFromEpochMs,
// but returns the raw epoch-ms number (not an ISO string) — this value is
// only ever used for chat recency sorting (see sortChatsByRecency), never
// emitted as a record field.
function nullableEpochMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Parse `gmcli --json --full chats list` output into chat ids (+ optional
 * display name). Throws a typed GmcliError on malformed JSON/shape — never
 * silently returns a wrong-shape/empty result on a parse failure.
 */
export function parseGmcliChatsJson(stdout: string): ParsedGmcliChat[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    // biome-ignore lint/style/useErrorCause: GmcliError's 3rd constructor arg forwards to super(message, { cause })
    throw new GmcliError(
      `gmcli chats output was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      "query_failed",
      { cause: err }
    );
  }
  if (!Array.isArray(parsed)) {
    throw new GmcliError("gmcli chats output was not a JSON array", "query_failed");
  }
  return parsed.map((raw) => {
    if (typeof raw !== "object" || raw === null) {
      throw new GmcliError("gmcli chats output contained a non-object entry", "query_failed");
    }
    const row = raw as Record<string, unknown>;
    const id = typeof row.conversation_id === "string" ? row.conversation_id : null;
    if (!id) {
      throw new GmcliError(
        "gmcli chat entry is missing conversation_id — schema drift from what this connector expects",
        "query_failed"
      );
    }
    return { id, name: asNullableString(row.name), lastMessageTimeMs: nullableEpochMs(row.last_message_time_ms) };
  });
}

/**
 * Convert one raw Message JSON row into a ParsedGmcliMessage, or throw a
 * typed GmcliError when a required field is absent/wrong-typed.
 */
function parseGmcliMessageRow(raw: unknown, chatName: string | null): ParsedGmcliMessage {
  if (typeof raw !== "object" || raw === null) {
    throw new GmcliError("gmcli messages output contained a non-object entry", "query_failed");
  }
  const row = raw as Record<string, unknown>;
  const id = typeof row.message_id === "string" ? row.message_id : null;
  const chatId = typeof row.conversation_id === "string" ? row.conversation_id : null;
  const body = typeof row.body === "string" ? row.body : null;
  const sentAt = isoFromEpochMs(row.timestamp_ms);
  const isFromMe = typeof row.is_from_me === "boolean" ? row.is_from_me : null;
  if (!(id && chatId && body !== null && sentAt && isFromMe !== null)) {
    throw new GmcliError(
      "gmcli Message entry is missing a required field (message_id, conversation_id, body, timestamp_ms, is_from_me) — schema drift from what this connector expects",
      "query_failed"
    );
  }
  return {
    id,
    chat_id: chatId,
    chat_name: chatName,
    sender_id: asNullableString(row.sender_id),
    body,
    sent_at: sentAt,
    direction: isFromMe ? "outgoing" : "incoming",
  };
}

/**
 * Parse `gmcli messages list --conv <id> --json --full` output (Message
 * rows) for one conversation into ParsedGmcliMessage records.
 */
export function parseGmcliMessagesJson(stdout: string, chatName: string | null = null): ParsedGmcliMessage[] {
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
  return parsed.map((row) => parseGmcliMessageRow(row, chatName));
}

// ─── Bounding ────────────────────────────────────────────────────────────
//
// gmkit's `messages list` exposes only a flat `--limit` — no offset/cursor
// pagination flag exists in the CLI. These caps bound total subprocess
// output/runtime per run; a chat that returns exactly the limit is treated
// as POSSIBLY truncated (gmcli gives no "there were more" signal), and a
// dedicated coverage_diagnostics/SKIP-adjacent diagnostic surfaces that
// honestly rather than silently presenting a partial history as complete.

const DEFAULT_MESSAGES_PER_CHAT_LIMIT = 500;
const DEFAULT_MAX_CHATS = 200;

function resolveMessagesPerChatLimit(): number {
  const raw = Number(process.env.GMCLI_MESSAGES_PER_CHAT_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MESSAGES_PER_CHAT_LIMIT;
}

function resolveMaxChats(): number {
  const raw = Number(process.env.GMCLI_MAX_CHATS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_CHATS;
}

/**
 * Deterministic recency ordering for `chats list` output, applied BEFORE the
 * `GMCLI_MAX_CHATS` slice. gmcli's own `chats list` already returns
 * conversations in `last_message_ts DESC, updated_at DESC` order server-side
 * (verified from gmkit's Go source: `internal/store/conversations.go`'s
 * `ListConversations` — the query is genuinely `ORDER BY c.last_message_ts
 * DESC, c.updated_at DESC LIMIT ?`), so this connector is NOT correcting an
 * unordered or arbitrarily-ordered response. What this sort adds on top:
 * (1) a documented, connector-owned contract this code does not have to
 * trust gmcli's exact secondary-sort tie-breaking behavior to satisfy — the
 * `updated_at DESC` secondary key is not guaranteed to be a total order
 * (two conversations can share both `last_message_ts` and `updated_at`),
 * whereas this connector's own `conversation_id` tie-break IS a documented
 * total order; and (2) resilience to gmcli response order in the face of a
 * schema/behavior change in a beta, single-maintainer CLI this connector
 * does not control — re-deriving the same guarantee locally rather than
 * assuming an external, unversioned contract holds forever. Re-sorting an
 * already-recency-sorted list is a cheap no-op in the common case; it only
 * changes anything at a tie gmcli's own ordering left ambiguous. A
 * missing/invalid `last_message_time_ms` sorts as the OLDEST possible value
 * (last), never treated as "most recent" — an absent signal must never win
 * priority over a chat with a real, verified recent-activity timestamp.
 */
function compareChatIdAscending(a: ParsedGmcliChat, b: ParsedGmcliChat): number {
  if (a.id < b.id) {
    return -1;
  }
  if (a.id > b.id) {
    return 1;
  }
  return 0;
}

export function sortChatsByRecency(chats: readonly ParsedGmcliChat[]): ParsedGmcliChat[] {
  return [...chats].sort((a, b) => {
    const aTime = a.lastMessageTimeMs ?? Number.NEGATIVE_INFINITY;
    const bTime = b.lastMessageTimeMs ?? Number.NEGATIVE_INFINITY;
    if (aTime !== bTime) {
      return bTime - aTime;
    }
    return compareChatIdAscending(a, b);
  });
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
  /** Present when the chat list itself was cut to GMCLI_MAX_CHATS — distinct
   *  from `truncated` (per-chat message-limit truncation). `collect()` turns
   *  this into its own `messages` SKIP_RESULT so a run that silently
   *  dropped whole conversations cannot read as complete coverage.
   *
   *  `atLeastTotalCount` is a LOWER BOUND, not the true total: the
   *  `chats list --limit` probe (see fetchAndParseGmcliMessages's doc
   *  comment) only fetches `maxChats + 1` rows, so once truncation is
   *  detected the real archive could hold far more conversations than that
   *  — this connector has no way to learn the exact true count without an
   *  unbounded fetch, which would defeat the whole purpose of the cap. */
  readonly chatsTruncated?: { atLeastTotalCount: number; scannedCount: number };
  readonly coverageReason: string;
  readonly coverageStatus: CoverageRecord["status"];
  /**
   * Flat `reason`/`message` fields (not a nested `skip: { reason, message
   * }` object) so the emission call site in `collect()` can write a
   * literal `reason:` property whose value is `outcome.reason` — a plain
   * one-hop `x.reason` MemberExpression the reason-code completeness
   * scanner already resolves via its existing same-file-call-result bound
   * — instead of `outcome.skip.reason`/`...outcome.skip`, both of which
   * need resolution depth beyond that deliberately bounded one hop (see
   * `reason-emission-scan.ts`'s doc comment on why this scanner does not
   * chase nested member chains or spreads).
   */
  readonly message?: string;
  readonly parsed?: ParsedGmcliMessage[];
  readonly reason?: string;
  readonly truncated?: readonly string[];
}

function classifyGmcliFetchError(err: unknown): GmcliFetchOutcome {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof GmcliError && err.kind === "not_installed") {
    return {
      coverageStatus: "missing",
      coverageReason: "gmcli binary not found on PATH/GMCLI_BIN.",
      reason: "gmcli_not_installed",
      message,
    };
  }
  if (err instanceof GmcliError && err.kind === "not_paired") {
    return {
      coverageStatus: "excluded",
      coverageReason: "gmcli is installed but the Android device is not paired.",
      reason: "gmcli_not_paired",
      message,
    };
  }
  return {
    coverageStatus: "unsupported",
    coverageReason: `gmcli query failed: ${message}`,
    reason: "gmcli_query_failed",
    message,
  };
}

/**
 * Fetch one conversation's messages, bounded by `limit`. Returns the parsed
 * rows plus whether this chat hit the bound (rows.length === limit) —
 * gmcli's `--limit` gives no "there were more" signal, so a full page is
 * the only detectable proxy for "this conversation may have more history
 * than we fetched."
 *
 * `--order desc` (newest-first), not `asc`: with a flat `--limit` and no
 * pagination cursor, a full page always drops whatever falls outside the
 * fetched N. `asc` would fetch and permanently re-fetch the OLDEST N
 * messages every run — a conversation that grows past the limit would never
 * surface a single new message, forever, since the newest activity always
 * falls in the untouched tail beyond the fixed oldest-N window. `desc`
 * fetches the NEWEST N instead, so new activity is always inside the
 * fetched window on the very next run; the truncation cost moves to the
 * OLDER end (older history beyond the newest N goes unfetched), which is
 * what `gmcli_per_chat_limit_reached` below already communicates. Record
 * order downstream is not semantically load-bearing (storage keys by `id`
 * and reads sort by each record's own `sent_at`), so this is a pure
 * fetch-boundary change, not a display-order change.
 */
async function fetchChatMessages(
  invoke: GmcliInvoker,
  chat: ParsedGmcliChat,
  limit: number
): Promise<{ messages: ParsedGmcliMessage[]; possiblyTruncated: boolean }> {
  const result = await invoke([
    "messages",
    "list",
    "--conv",
    chat.id,
    "--json",
    "--full",
    "--limit",
    String(limit),
    "--order",
    "desc",
  ]);
  const messages = parseGmcliMessagesJson(result.stdout, chat.name);
  return { messages, possiblyTruncated: messages.length >= limit };
}

/**
 * Enumerate chats (`gmcli --json --full chats list`), then fetch each
 * chat's messages (`gmcli messages list --conv <id> ...`), bounded by
 * GMCLI_MAX_CHATS/GMCLI_MESSAGES_PER_CHAT_LIMIT. Collapses every failure
 * mode (binary missing, not paired, query failure, schema drift) into one
 * discriminated outcome. `collect()` only has to branch on `outcome.reason`
 * vs `outcome.parsed` — the fine-grained SKIP_RESULT reason and coverage
 * status/reason live here.
 *
 * `chats list` is called with an explicit `--limit`, sized to `maxChats + 1`
 * — NOT left unset. gmcli's own `chats list` defaults `--limit` to 50
 * server-side when the flag is absent (verified from gmkit's Go source:
 * `internal/cmd/chats.go`'s `chatsListCmd`, `IntVar(&limit, "limit", 50,
 * ...)`, clamped again in `internal/store/conversations.go`'s
 * `ListConversations` if `<= 0`). An unset `--limit` would silently cap the
 * chat enumeration at 50 UPSTREAM of this connector's own
 * `GMCLI_MAX_CHATS` bookkeeping — for any archive with more than 50
 * conversations and the default `GMCLI_MAX_CHATS` (200), the fetch would
 * never see chats 51+ at all, so `orderedChats.length > maxChats` could
 * never be true and the `gmcli_chat_scan_limit_reached` truncation signal
 * below would never fire, even though real conversations were silently
 * dropped from the scan.
 *
 * The probe is `maxChats + 1`, not `maxChats`, because fetching exactly
 * `maxChats` rows is indistinguishable between "the archive has exactly
 * `maxChats` conversations" (no truncation) and "the archive has more, but
 * gmcli's own `--limit` cut the response at exactly `maxChats`" (silent
 * truncation) — the same "exact cap vs. truncation" ambiguity this
 * connector already refuses to accept for the per-chat message limit (see
 * `fetchChatMessages`'s `possiblyTruncated: messages.length >= limit`).
 * Fetching one extra row resolves the ambiguity: exactly `maxChats + 1`
 * rows back means "at least one more exists beyond the cap" (truncated);
 * `maxChats` or fewer means "this is the true, complete count" (not
 * truncated). The 1 extra row is used only for this detection — it is
 * never scanned for messages; the connector still retains only the
 * `maxChats` most recently active chats (see sortChatsByRecency below).
 * gmcli's `--limit` has no documented upper clamp beyond the `<= 0` case
 * (verified from the same store source), so `maxChats + 1` is honored as a
 * literal SQL `LIMIT`, not silently re-capped to 50 by passing it explicitly.
 */
export async function fetchAndParseGmcliMessages(invoke: GmcliInvoker = runGmcli): Promise<GmcliFetchOutcome> {
  const maxChats = resolveMaxChats();
  const chatsListProbeLimit = maxChats + 1;

  let chatsResult: GmcliResult;
  try {
    chatsResult = await invoke(["--json", "--full", "chats", "list", "--limit", String(chatsListProbeLimit)]);
  } catch (err) {
    return classifyGmcliFetchError(err);
  }

  let chats: ParsedGmcliChat[];
  try {
    chats = parseGmcliChatsJson(chatsResult.stdout);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      coverageStatus: "unsupported",
      coverageReason: `gmcli chats output did not match the expected shape: ${message}`,
      reason: "gmcli_schema_drift",
      message,
    };
  }

  const perChatLimit = resolveMessagesPerChatLimit();
  // Sort by recency BEFORE slicing: a truncated run must keep the most
  // recently active chats, not an arbitrary gmcli-response-order prefix
  // (see sortChatsByRecency's doc comment).
  const orderedChats = sortChatsByRecency(chats);
  const boundedChats = orderedChats.slice(0, maxChats);
  // `orderedChats.length` is bounded above by `chatsListProbeLimit`
  // (`maxChats + 1`) — it is the true total ONLY when the archive has
  // `maxChats` or fewer conversations. When the fetch itself returned the
  // full `maxChats + 1` probe, the real total may be far larger; this
  // connector deliberately does NOT claim to know the real total in that
  // case (see the `chatsTruncated` result below), only that at least one
  // conversation beyond `maxChats` exists.
  const chatsTruncated = orderedChats.length > maxChats;

  const parsed: ParsedGmcliMessage[] = [];
  const truncatedChatIds: string[] = [];
  for (const chat of boundedChats) {
    let outcome: { messages: ParsedGmcliMessage[]; possiblyTruncated: boolean };
    try {
      outcome = await fetchChatMessages(invoke, chat, perChatLimit);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        coverageStatus: "unsupported",
        coverageReason: `gmcli messages query failed for a conversation: ${message}`,
        reason: "gmcli_query_failed",
        message,
      };
    }
    parsed.push(...outcome.messages);
    if (outcome.possiblyTruncated) {
      truncatedChatIds.push(chat.id);
    }
  }

  const truncationNote =
    truncatedChatIds.length > 0
      ? ` ${String(truncatedChatIds.length)} conversation(s) hit the per-chat limit (${String(perChatLimit)}) and may have older messages not fetched this run.`
      : "";
  // `orderedChats.length` here is exactly `chatsListProbeLimit`
  // (`maxChats + 1`) whenever truncated — it is a LOWER BOUND on the real
  // total, not the true count (see GmcliFetchOutcome's chatsTruncated doc).
  const chatsBoundNote = chatsTruncated
    ? ` Only the ${String(maxChats)} most recently active of at least ${String(orderedChats.length)} conversations were scanned this run.`
    : "";

  return {
    ...(chatsTruncated
      ? {
          chatsTruncated: {
            atLeastTotalCount: orderedChats.length,
            scannedCount: boundedChats.length,
          },
        }
      : {}),
    coverageStatus: "collected",
    coverageReason: `gmcli reported ${String(parsed.length)} message(s) across ${String(boundedChats.length)} conversation(s).${truncationNote}${chatsBoundNote}`,
    parsed,
    truncated: truncatedChatIds,
  };
}

// ─── Connector ─────────────────────────────────────────────────────────

export type GmcliInvoker = (args: readonly string[]) => Promise<GmcliResult>;

export async function collect({ state, requested, emit, emitRecord, progress }: CollectContext): Promise<void> {
  const outcome = await fetchAndParseGmcliMessages();

  if (requested.has("coverage_diagnostics")) {
    await emitRecord("coverage_diagnostics", buildCoverageRecord(outcome.coverageStatus, outcome.coverageReason));
  }

  if (outcome.reason) {
    // outcome.reason/outcome.message are flat fields on GmcliFetchOutcome
    // (not a nested `skip: { reason, message }` object, and not spread from
    // one) specifically so this is a literal `reason:` property whose
    // value is a plain one-hop `x.reason` MemberExpression — the shape the
    // bounded, AST-based reason-emission scanner already resolves (see
    // packages/polyfill-connectors/src/reason-emission-scan.ts). A spread
    // (`...outcome.skip`) or a nested member chain (`outcome.skip.reason`)
    // both need resolution depth beyond that scanner's deliberately bounded
    // one hop, so every reason code emitted through either shape would
    // silently evade completeness checking.
    await emit({
      type: "SKIP_RESULT",
      stream: "messages",
      reason: outcome.reason,
      message: outcome.message ?? outcome.reason,
    });
    return;
  }

  const parsed = outcome.parsed ?? [];
  if (outcome.truncated && outcome.truncated.length > 0) {
    await emit({
      type: "SKIP_RESULT",
      stream: "messages",
      reason: "gmcli_per_chat_limit_reached",
      message: `${String(outcome.truncated.length)} conversation(s) reached the per-chat message limit; older history in those conversations was not fetched this run. Increase GMCLI_MESSAGES_PER_CHAT_LIMIT and re-run to fetch more.`,
    });
  }
  // Whole conversations dropped by the GMCLI_MAX_CHATS cap are a distinct
  // gap from a per-chat message-limit truncation above: those chats
  // contributed ZERO messages this run, not a partial history. This must
  // surface its own SKIP_RESULT — without it, a run that silently dropped
  // entire conversations would look identical to one that scanned
  // everything, and health/coverage could read complete when it is not.
  // `reason` is a generic, connector-authored code (not gmcli jargon) so it
  // can carry vetted end-user display copy from this connector's own
  // manifest (`reason_display_messages`), never RI-side connector-specific
  // copy. This does NOT claim historical convergence — it only says which
  // chats were left unscanned this run and how to recover them.
  // `atLeastTotalCount` is a lower bound (see GmcliFetchOutcome's doc
  // comment) — the message is phrased "at least N", never a precise count,
  // since the chats-list probe itself is bounded and cannot see past it.
  if (outcome.chatsTruncated) {
    await emit({
      type: "SKIP_RESULT",
      stream: "messages",
      reason: "gmcli_chat_scan_limit_reached",
      message: `Only the ${String(outcome.chatsTruncated.scannedCount)} most recently active conversations were scanned this run; at least ${String(outcome.chatsTruncated.atLeastTotalCount)} conversation(s) exist in total. Increase GMCLI_MAX_CHATS and re-run to scan more.`,
    });
  }
  if (!requested.has("messages")) {
    return;
  }

  // Per-message-id content fingerprint, seeded from the prior run's
  // STATE cursor (see the file header's STATE section). gmcli returns
  // the same bounded per-conversation window every run (no server-side
  // "since" cursor exists to narrow the re-fetch) — this gate is what
  // stops that repeated fetch from re-emitting a RECORD for a message
  // this run already durably queued in a prior run. A message whose
  // fingerprint changed (or is new) is always emitted; `considered`/
  // `covered` below still count every fetched message regardless of
  // whether the gate emitted it, since a fetched-but-unchanged message
  // was genuinely considered and is already durably covered from its
  // prior emission.
  const cursor = openFingerprintCursor(state.messages);

  await progress(`Google Messages phase=emit pass=emit messages=${String(parsed.length)}`);
  for (const message of parsed) {
    const record = { ...message };
    if (cursor.shouldEmit(record)) {
      await emitRecord("messages", record);
    }
  }
  await progress(`Google Messages phase=emit pass=emit done messages=${String(parsed.length)}`);

  // STATE is written only after every fetched message has passed
  // through the cursor and any resulting RECORD has been handed to
  // emitRecord above — never before. The local-collector runtime only
  // durably commits a buffered STATE cursor after this run's record
  // batches have been enqueued (collector-runner.ts flushes pending
  // record batches before it drains the checkpoint), so a crash or
  // interruption between here and that commit leaves the prior
  // checkpoint (or none, on a first run) in place rather than a
  // checkpoint claiming coverage this run never durably queued.
  await emit({
    type: "STATE",
    stream: "messages",
    cursor: { fingerprints: cursor.toState() },
  });

  // `messages` is this connector's only required stream and previously
  // never proved its own coverage, leaving it permanently unmeasured
  // even on a fully successful run. gmcli's per-conversation query
  // already gives an exact enumerated count (`parsed.length`) every
  // run — every fetched message is unconditionally considered above, so
  // considered === covered even though the fingerprint gate may not
  // re-emit an unchanged one as a fresh RECORD. A truncated run's
  // SKIP_RESULT (emitted above) already outranks this in the coverage
  // precedence order, so this always-emit is safe even when the fetch
  // was bounded.
  await emitDetailCoverage(
    { emit },
    {
      stream: "messages",
      stateStream: "messages",
      requiredKeys: [],
      hydratedKeys: [],
      considered: parsed.length,
      covered: parsed.length,
    }
  );
}

runConnectorGuarded();

function runConnectorGuarded(): void {
  if (!isMainModule(import.meta.url)) {
    return;
  }
  runConnector({
    name: "google_messages",
    validateRecord,
    collect,
  });
}
