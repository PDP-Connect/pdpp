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

export interface InteractionResponse {
  data?: Record<string, string>;
  error?: { code?: string; message?: string };
  request_id: string | undefined;
  status: string;
  type: "INTERACTION_RESPONSE";
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

async function respondViaTerminal(msg: InteractionMessage): Promise<InteractionResponseInner | null> {
  // Only handle the simple/common kinds inline. Anything else falls back to
  // file drop so we don't fake a response the user didn't intend.
  if (msg.kind === "otp") {
    const code = await promptStdin(`[interaction] OTP required (${msg.message || ""}): `);
    return { status: "success", data: { code: code.trim() } };
  }
  if (msg.kind === "credentials" && msg.schema?.properties) {
    const data: Record<string, string> = {};
    for (const [key, schema] of Object.entries(msg.schema.properties)) {
      const hint = schema.description ? ` (${schema.description})` : "";
      const value = await promptStdin(`[interaction] ${key}${hint}: `);
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
    return `${webBaseUrl}/dashboard/runs/${encodedRunId}/stream?interaction_id=${encodedInteractionId}`;
  }
  return `${webBaseUrl}/dashboard/runs/${encodedRunId}`;
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

  const instructions = [
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
      status: "failed",
      error: { code: "timeout", message },
    };
  }
  await ntfyPromise;
  await unlink(reqPath).catch((): undefined => undefined);

  if (!response) {
    response = {
      status: "failed",
      error: { code: "no_response", message: "no response received" },
    };
  }

  const out: InteractionResponse = {
    type: "INTERACTION_RESPONSE",
    request_id: msg.request_id,
    status: response.status || "success",
  };
  if (response.data !== undefined) {
    out.data = response.data;
  }
  if (response.error !== undefined) {
    out.error = response.error;
  }
  return out;
}

export const __testing = { buildClickUrl };
