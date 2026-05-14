/**
 * Shared test harness for connector integration tests.
 *
 * Every integration test needs a fake `emit` + `emitRecord` pair that
 * captures what the collect() layer would push over the wire. Until
 * this file existed, each connector rolled its own, and the hand-rolled
 * `emitRecord` skipped the zod shape-check that the production runtime
 * applies. That meant a record that would SKIP_RESULT in production
 * silently landed in `.emitted` inside tests — tests looked green,
 * truth looked different.
 *
 * `makeRecordingEmit(validateRecord)` fixes that. It mirrors the
 * runtime's RECORD path: records that pass the zod check land in
 * `.emitted`; records that fail land in `.skipped`. Pass no validator
 * and you get pass-through mode for tests where the shape-check isn't
 * what's under test (e.g. pure scope-filter gates).
 *
 * This module has no side effects at import time. It exports only
 * factories and pure helpers.
 */

import { spawn } from "node:child_process";
import type { EmittedMessage, RecordData, ValidateRecord } from "./connector-runtime.ts";
import { stringifyForJsonl } from "./safe-emit.ts";

/** A record that passed (or bypassed) shape-check and would flow
 *  downstream as a RECORD in production. */
export interface EmittedRecord {
  data: RecordData;
  stream: string;
}

/** A record that failed shape-check — the runtime would convert this
 *  to a SKIP_RESULT. Tests can assert on `.skipped` to catch fixture
 *  drift. */
export interface SkippedRecord {
  issues: Array<{ message: string; path: string }>;
  stream: string;
}

/** A single event in the unified call-order trace. `.events` interleaves
 *  emitRecord() calls and emit() calls in the order the helper made
 *  them. Needed when a test has to prove something like "STATE emitted
 *  AFTER the last RECORD" — the separate `.emitted` / `.protocolMessages`
 *  arrays can't express cross-kind ordering because they're two lists
 *  with no shared sequence. */
export type RecordedEvent =
  | { kind: "record"; stream: string; data: RecordData; skipped: false }
  | { kind: "record-skipped"; stream: string; issues: Array<{ message: string; path: string }>; skipped: true }
  | { kind: "message"; message: EmittedMessage };

export interface RecordingEmit {
  emit: (msg: EmittedMessage) => Promise<void>;
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  emitted: EmittedRecord[];
  /** Unified time-ordered trace of every emit() and emitRecord() call,
   *  in invocation order. Use this when the assertion is cross-kind
   *  ordering (e.g. "STATE lands after the last RECORD"). */
  events: RecordedEvent[];
  protocolMessages: EmittedMessage[];
  skipped: SkippedRecord[];
}

export interface ConnectorSubprocessResult {
  code: number | null;
  messages: EmittedMessage[];
  rawStdout: string;
  signal: NodeJS.Signals | null;
  stderr: string;
}

export interface ConnectorSubprocessOptions {
  allowFailedDone?: boolean;
  cwd: string;
  entrypoint: string;
  env?: NodeJS.ProcessEnv;
  start: {
    scope: { streams: Array<{ name: string; resources?: string[]; time_range?: { since?: string; until?: string } }> };
    state?: Record<string, unknown>;
    type: "START";
  };
  timeoutMs?: number;
}

/**
 * Returns an emit/emitRecord pair that validates records through
 * `validateRecord`. Records that pass land in `.emitted`; records that
 * fail land in `.skipped` (same semantics as the runtime's RECORD
 * shape-check). The `.emit` side-channel records any direct protocol
 * messages (PROGRESS, STATE, SKIP_RESULT, INTERACTION) the helper
 * under test emits.
 *
 * If `validateRecord` is omitted, `emitRecord` is pass-through — useful
 * for tests where the helper is a pure function and the shape-check
 * isn't the point (e.g. scope-filter gates, ordering invariants on
 * synthetic data that intentionally omits fields).
 */
export function makeRecordingEmit(validateRecord?: ValidateRecord): RecordingEmit {
  const emitted: EmittedRecord[] = [];
  const skipped: SkippedRecord[] = [];
  const protocolMessages: EmittedMessage[] = [];
  const events: RecordedEvent[] = [];

  const emit = (msg: EmittedMessage): Promise<void> => {
    protocolMessages.push(msg);
    events.push({ kind: "message", message: msg });
    return Promise.resolve();
  };

  const emitRecord = (stream: string, data: RecordData): Promise<void> => {
    if (validateRecord) {
      const result = validateRecord(stream, data);
      if (!result.ok) {
        skipped.push({ stream, issues: result.issues });
        events.push({ kind: "record-skipped", stream, issues: result.issues, skipped: true });
        return Promise.resolve();
      }
    }
    emitted.push({ stream, data });
    events.push({ kind: "record", stream, data, skipped: false });
    return Promise.resolve();
  };

  return { emit, emitRecord, emitted, events, skipped, protocolMessages };
}

/**
 * Run a connector entrypoint as a real child process and drive the
 * Collection Profile protocol over stdio. Unlike `makeRecordingEmit`,
 * this proves START parsing, stdout JSONL framing, DONE emission, and
 * process exit behavior without importing the connector module directly.
 */
export function runConnectorProtocolSubprocess(
  options: ConnectorSubprocessOptions
): Promise<ConnectorSubprocessResult> {
  const timeoutMs = options.timeoutMs ?? 15_000;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", options.entrypoint], {
      cwd: options.cwd,
      env: {
        ...process.env,
        PATCHRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
        ...options.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const messages: EmittedMessage[] = [];
    let rawStdout = "";
    let stderr = "";
    let stdoutBuffer = "";
    let settled = false;
    let timer: NodeJS.Timeout;

    const finish = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const rejectAndKill = (error: Error): void => {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
      finish(() => reject(error));
    };

    const parseLine = (line: string): void => {
      if (!line.trim()) {
        return;
      }
      try {
        messages.push(JSON.parse(line) as EmittedMessage);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        rejectAndKill(new Error(`connector emitted invalid JSONL: ${message}; line=${line}`));
      }
    };

    timer = setTimeout(() => {
      rejectAndKill(new Error(`connector subprocess timed out after ${String(timeoutMs)}ms; stderr=${stderr}`));
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      rawStdout += text;
      stdoutBuffer += text;
      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex);
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        parseLine(line);
        newlineIndex = stdoutBuffer.indexOf("\n");
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      finish(() => reject(err));
    });

    child.on("exit", (code, signal) => {
      if (stdoutBuffer.trim()) {
        parseLine(stdoutBuffer);
      }
      if (settled) {
        return;
      }
      const done = messages.findLast((m) => m.type === "DONE");
      if (!done) {
        finish(() =>
          reject(
            new Error(
              `connector subprocess exited without DONE: code=${String(code)} signal=${String(signal)} stderr=${stderr}`
            )
          )
        );
        return;
      }
      if (done.status === "failed" && options.allowFailedDone === true) {
        finish(() => resolve({ code, signal, stderr, rawStdout, messages }));
        return;
      }
      if (code !== 0 || signal) {
        finish(() =>
          reject(
            new Error(
              `connector subprocess exited non-zero after DONE: code=${String(code)} signal=${String(signal)} stderr=${stderr}`
            )
          )
        );
        return;
      }
      if (done.status === "failed") {
        finish(() =>
          reject(
            new Error(
              `connector subprocess reported failed: ${done.error?.message ?? "unknown"}; code=${String(code)} stderr=${stderr}`
            )
          )
        );
        return;
      }
      finish(() => resolve({ code, signal, stderr, rawStdout, messages }));
    });

    child.stdin?.end(stringifyForJsonl(options.start));
  });
}
