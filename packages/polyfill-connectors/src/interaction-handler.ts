// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Lightweight INTERACTION handler for the CLI orchestrator.
 *
 * Implements the owner side of the Collection Profile INTERACTION protocol:
 * receives a message from the runtime (already unwrapped from the child
 * process), surfaces it to the human, and returns an INTERACTION_RESPONSE.
 *
 * Three surfaces, in priority order:
 *   1. File drop     — always available. Writes request to /tmp/pdpp-interaction-<id>.json;
 *                      polls for /tmp/pdpp-interaction-<id>.response.json.
 *                      Usable over SSH or from another agent.
 *   2. Terminal      — if stdin is a TTY, prompt inline for `credentials`/`otp`.
 *   3. ntfy          — fire-and-forget notification with instructions.
 *
 * Timeout is taken from msg.timeout_seconds if present (clamped to [60, 3600]);
 * otherwise 30 minutes.
 */

import { constants as fsConstants } from "node:fs";
import { access, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { notify } from "./ntfy.ts";

const UNSAFE_ID = /[^a-zA-Z0-9_.-]/g;

export interface InteractionMessage {
  kind: string;
  message?: string;
  request_id?: string;
  schema?: {
    properties?: Record<string, { description?: string }>;
  };
  timeout_seconds?: number;
}

export interface InteractionResponseInner {
  data?: Record<string, string>;
  error?: { code?: string; message?: string };
  status?: string;
  value?: string;
}

// The runtime envelope validator (reference-implementation/runtime/index.js
// ~line 2074) only accepts these three terminal statuses on
// INTERACTION_RESPONSE. Anything else trips
// `interaction_handler_invalid_response`, which terminates the run before any
// pending owner action can be recorded — see the live ChatGPT failure mode
// repaired in commit e0dfb8f and tracked in tmp/workstreams/pwa-scheduler-status-memo.md.
export type InteractionResponseStatus = "success" | "cancelled" | "timeout";

export interface InteractionResponse {
  data?: Record<string, string>;
  error?: { code?: string; message?: string };
  request_id: string;
  status: InteractionResponseStatus;
  type: "INTERACTION_RESPONSE";
}

// Normalize any free-form status (legacy file-drop responses or
// handler-internal failure paths) to one of the contract-allowed terminal
// statuses. Unknown / "failed" / "error" map to "cancelled" so the runtime
// can record a clean terminal state instead of throwing.
function normalizeStatus(raw: string | undefined): InteractionResponseStatus {
  if (raw === "success" || raw === "cancelled" || raw === "timeout") {
    return raw;
  }
  return "cancelled";
}

function pathFor(id: string, suffix: string): string {
  const safeId = String(id).replace(UNSAFE_ID, "_");
  return join(tmpdir(), `pdpp-interaction-${safeId}${suffix}`);
}

async function waitForFile(path: string, timeoutMs: number): Promise<InteractionResponseInner> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await access(path, fsConstants.R_OK);
      const raw = await readFile(path, "utf8");
      await unlink(path).catch((): undefined => undefined);
      return JSON.parse(raw) as InteractionResponseInner;
    } catch {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw new Error("interaction_timeout");
}

function promptStdin(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

const SECRET_FIELD_RE = /password|secret|token|passphrase|pin\b|api_key/i;

/**
 * Like `promptStdin`, but never echoes what the user types (each keystroke
 * renders as `*`). Implemented with raw-mode stdin rather than readline's
 * private `_writeToOutput` hook: the hook redraws the whole line per
 * keystroke, which erased the question text in practice (found live by the
 * owner). Handles Enter, Backspace, and Ctrl-C; falls back to the plain
 * prompt when stdin has no raw mode (non-TTY callers never reach this —
 * they use --answer flags or fail loudly upstream).
 */
function promptStdinMasked(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    return promptStdin(question);
  }
  return new Promise((resolve) => {
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    let buffer = "";
    const onData = (chunk: Buffer) => {
      const ch = chunk.toString("utf8");
      if (ch === "\r" || ch === "\n") {
        stdin.setRawMode(false);
        stdin.off("data", onData);
        stdin.pause();
        process.stdout.write("\n");
        resolve(buffer);
        return;
      }
      if (ch === "\u0003") {
        // Ctrl-C: restore the terminal before letting the process die.
        stdin.setRawMode(false);
        process.stdout.write("\n");
        process.kill(process.pid, "SIGINT");
        return;
      }
      if (ch === "\u007f" || ch === "\b") {
        if (buffer.length > 0) {
          buffer = buffer.slice(0, -1);
          process.stdout.write("\b \b");
        }
        return;
      }
      buffer += ch;
      process.stdout.write("*".repeat(ch.length));
    };
    stdin.on("data", onData);
  });
}

async function respondViaTerminal(msg: InteractionMessage): Promise<InteractionResponseInner | null> {
  // Only handle the simple/common kinds inline. Anything else falls back to
  // file drop so we don't fake a response the user didn't intend.
  if (msg.kind === "otp") {
    const code = await promptStdinMasked(`[interaction] OTP required (${msg.message || ""}): `);
    return { status: "success", data: { code: code.trim() } };
  }
  if (msg.kind === "credentials" && msg.schema?.properties) {
    const data: Record<string, string> = {};
    for (const [key, schema] of Object.entries(msg.schema.properties)) {
      const hint = schema.description ? ` (${schema.description})` : "";
      // Mask secret-named fields (passwords, tokens); usernames stay
      // visible so the operator can see what they typed.
      const ask = SECRET_FIELD_RE.test(key) ? promptStdinMasked : promptStdin;
      const value = await ask(`[interaction] ${key}${hint}: `);
      data[key] = value;
    }
    return { status: "success", data };
  }
  return null;
}

export interface HandleInteractionOptions {
  connectorName?: string;
  runId?: string;
}

/**
 * Resolve the web app base URL the operator clicks through to from a
 * notification. The reference's "unified personal server" deployment
 * (concept 76) hosts the dashboard alongside the AS/RS, so the web URL
 * is the reference origin by default; `PDPP_WEB_BASE_URL` is an explicit
 * override for operators who deploy the dashboard on a separate host.
 * The localhost fallback exists only so a dev session without either
 * env var still produces a working notification, with a warning.
 */
function resolveWebBaseUrl(): string {
  const explicit = process.env.PDPP_WEB_BASE_URL?.trim();
  if (explicit) {
    return explicit;
  }
  const referenceOrigin = process.env.PDPP_REFERENCE_ORIGIN?.trim();
  if (referenceOrigin) {
    return referenceOrigin;
  }
  return "http://localhost:3000";
}

function buildClickUrl(runId: string | undefined, kind: string, interactionId: string | undefined): string | undefined {
  if (!runId) {
    return;
  }
  const webBaseUrl = resolveWebBaseUrl();
  const encodedRunId = encodeURIComponent(runId);
  const encodedInteractionId = encodeURIComponent(interactionId || "");
  if (kind === "manual_action") {
    return `${webBaseUrl}/syncs/${encodedRunId}/stream?interaction_id=${encodedInteractionId}`;
  }
  return `${webBaseUrl}/syncs/${encodedRunId}`;
}

export async function handleInteraction(
  msg: InteractionMessage,
  { connectorName = "connector", runId }: HandleInteractionOptions = {}
): Promise<InteractionResponse> {
  const id = msg.request_id || `anon_${Date.now()}`;
  const timeoutSeconds = Math.min(Math.max(msg.timeout_seconds || 1800, 60), 3600);
  const timeoutMs = timeoutSeconds * 1000;
  const reqPath = pathFor(id, ".json");
  const respPath = pathFor(id, ".response.json");

  await writeFile(reqPath, JSON.stringify(msg, null, 2), "utf8").catch((): undefined => undefined);

  // On an interactive terminal the operator answers the prompt below, so the
  // file-drop channel is noise that competes with it (observed live: the
  // echo-example line printed directly above a live prompt, with no
  // indication either channel would work). Keep the full instructions for
  // non-TTY runs, where file drop is the only way in, and a single pointer
  // line otherwise.
  const interactive = process.stdin.isTTY === true;
  const instructions = interactive
    ? [
        `[interaction] ${connectorName} needs ${msg.kind}: ${msg.message || "(no message)"}`,
        `[interaction] answer below, or drop a response file at ${respPath}`,
      ]
    : [
        `[interaction] ${connectorName} needs ${msg.kind}: ${msg.message || "(no message)"}`,
        `[interaction] request written to ${reqPath}`,
        `[interaction] write response JSON to ${respPath} to resume`,
        `[interaction] example: echo '{"status":"success","data":{"code":"123456"}}' > ${respPath}`,
      ];
  for (const line of instructions) {
    process.stderr.write(`${line}\n`);
  }

  const clickUrl = buildClickUrl(runId, msg.kind, id);

  const ntfyPromise = notify({
    title: `PDPP ${connectorName}: ${msg.kind} needed`,
    message: `${msg.message || ""}\n\nReply: write to ${respPath}`,
    tags: msg.kind === "otp" || msg.kind === "credentials" ? ["key"] : ["construction"],
    priority: "high",
    ...(clickUrl && { clickUrl }),
  }).catch((): undefined => undefined);

  // Terminal path if interactive — fires concurrently with file-drop watch.
  const terminalPromise: Promise<InteractionResponseInner | null> =
    process.stdin.isTTY && (msg.kind === "otp" || msg.kind === "credentials")
      ? respondViaTerminal(msg).catch((): null => null)
      : new Promise<InteractionResponseInner | null>(() => {
          /* never resolves */
        });

  const filePromise = waitForFile(respPath, timeoutMs);

  let response: InteractionResponseInner | null = null;
  try {
    response = await Promise.race([filePromise, terminalPromise]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    response = {
      status: "timeout",
      error: { code: "timeout", message },
    };
  }
  await ntfyPromise;
  await unlink(reqPath).catch((): undefined => undefined);

  if (!response) {
    response = {
      status: "cancelled",
      error: { code: "no_response", message: "no response received" },
    };
  }

  // The runtime validator requires `request_id === msg.request_id` AND a
  // status in {success, cancelled, timeout}. msg.request_id can in principle
  // be undefined (the InteractionMessage type allows it), but the runtime
  // already rejects INTERACTION envelopes without a non-empty request_id, so
  // we only ever reach this point when msg.request_id is a string. Falling
  // back to the generated `id` keeps the envelope valid even if a future
  // caller relaxes that upstream contract.
  const out: InteractionResponse = {
    type: "INTERACTION_RESPONSE",
    request_id: msg.request_id ?? id,
    status: normalizeStatus(response.status),
  };
  if (response.data !== undefined) {
    out.data = response.data;
  }
  if (response.error !== undefined) {
    out.error = response.error;
  }
  return out;
}

export const __testing = { buildClickUrl, normalizeStatus };
