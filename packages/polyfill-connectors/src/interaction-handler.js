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

import { readFile, writeFile, unlink, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { notify } from './ntfy.js';

function pathFor(id, suffix) {
  const safeId = String(id).replace(/[^a-zA-Z0-9_.-]/g, '_');
  return join(tmpdir(), `pdpp-interaction-${safeId}${suffix}`);
}

async function waitForFile(path, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await access(path, fsConstants.R_OK);
      const raw = await readFile(path, 'utf8');
      await unlink(path).catch(() => {});
      return JSON.parse(raw);
    } catch {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw new Error('interaction_timeout');
}

function promptStdin(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function respondViaTerminal(msg) {
  // Only handle the simple/common kinds inline. Anything else falls back to
  // file drop so we don't fake a response the user didn't intend.
  if (msg.kind === 'otp') {
    const code = await promptStdin(`[interaction] OTP required (${msg.message || ''}): `);
    return { status: 'success', data: { code: code.trim() } };
  }
  if (msg.kind === 'credentials' && msg.schema?.properties) {
    const data = {};
    for (const [key, schema] of Object.entries(msg.schema.properties)) {
      const hint = schema.description ? ` (${schema.description})` : '';
      const value = await promptStdin(`[interaction] ${key}${hint}: `);
      data[key] = value;
    }
    return { status: 'success', data };
  }
  return null;
}

/**
 * @param {object} msg  INTERACTION message shape from the connector/runtime.
 * @param {object} [opts]
 * @param {string} [opts.connectorName]
 * @returns {Promise<object>} INTERACTION_RESPONSE-shaped object
 */
export async function handleInteraction(msg, { connectorName = 'connector' } = {}) {
  const id = msg.request_id || `anon_${Date.now()}`;
  const timeoutSeconds = Math.min(Math.max(msg.timeout_seconds || 1800, 60), 3600);
  const timeoutMs = timeoutSeconds * 1000;
  const reqPath = pathFor(id, '.json');
  const respPath = pathFor(id, '.response.json');

  await writeFile(reqPath, JSON.stringify(msg, null, 2), 'utf8').catch(() => {});

  const instructions = [
    `[interaction] ${connectorName} needs ${msg.kind}: ${msg.message || '(no message)'}`,
    `[interaction] request written to ${reqPath}`,
    `[interaction] write response JSON to ${respPath} to resume`,
    `[interaction] example: echo '{"status":"success","data":{"code":"123456"}}' > ${respPath}`,
  ];
  for (const line of instructions) process.stderr.write(line + '\n');

  const ntfyPromise = notify({
    title: `PDPP ${connectorName}: ${msg.kind} needed`,
    message: `${msg.message || ''}\n\nReply: write to ${respPath}`,
    tags: msg.kind === 'otp' || msg.kind === 'credentials' ? ['key'] : ['construction'],
    priority: 'high',
  }).catch(() => {});

  // Terminal path if interactive — fires concurrently with file-drop watch.
  const terminalPromise =
    process.stdin.isTTY && (msg.kind === 'otp' || msg.kind === 'credentials')
      ? respondViaTerminal(msg).catch(() => null)
      : new Promise(() => {}); // never resolves

  const filePromise = waitForFile(respPath, timeoutMs);

  let response;
  try {
    response = await Promise.race([filePromise, terminalPromise]);
  } catch (err) {
    response = { status: 'failed', error: { code: 'timeout', message: err.message } };
  }
  await ntfyPromise;
  await unlink(reqPath).catch(() => {});

  if (!response) {
    response = { status: 'failed', error: { code: 'no_response', message: 'no response received' } };
  }

  return {
    type: 'INTERACTION_RESPONSE',
    request_id: msg.request_id,
    status: response.status || 'success',
    data: response.data,
    error: response.error,
  };
}
