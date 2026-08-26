// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A run-scoped logger seam for connector-runtime code paths — scheduler,
 * run-executor, maintenance sweeps — that know a run's identity but have no
 * way to reach the structured logger the server already builds.
 *
 * Why this exists (design-notes/failure-diagnosability-2026-08-18.md): the
 * server builds a real Pino instance (`transport.ts` `buildLogger`) and
 * passes it deep into `server/index.ts`'s boot/runtime closures — it is NOT
 * confined to route handlers, contrary to the note's open question. But
 * `runtime/scheduler.ts` and `runtime/scheduler/run-executor.ts`, which own
 * every `run_id` in the system, never receive it. Their failures go to
 * `console.error` with a `[scheduler]` tag and nothing else — no `run_id`,
 * no `connector_instance_id`. That is the mechanical reason a failed run's
 * own log lines cannot be found by grepping its run_id: the code that would
 * write them cannot reach a logger, let alone one that knows the run.
 *
 * This is NOT a new logging framework and does NOT require every module to
 * adopt it. It is one small factory: given a base logger (Pino, or anything
 * shaped like it) and a run's identity, return a logger whose every line
 * carries `run_id`, `connector_id`, and `connector_instance_id` — the same
 * `logger.warn({ ...fields }, message)` call convention already used at
 * `server/index.ts`'s `onNoProgressAlert`, so the JSON shape on disk is
 * unchanged and nothing downstream needs a new parser.
 *
 * Threading: `SchedulerOptions.logger` (runtime/scheduler-domain-types.ts)
 * is optional and flows through `createScheduler` -> `createRunExecutor` ->
 * `RunExecutorDeps.logger`. Every existing caller that does not pass one
 * gets `NOOP_RUN_BASE_LOGGER`, a silent no-op — this seam is additive and no
 * existing test/call site needs to change.
 *
 * PII: this module does not invent a new redaction policy. Any string field
 * a caller passes under `message` is run through `redactStderrTail` before
 * it reaches the base logger, using the SAME declared-reason-token allowlist
 * convention `runtime/stderr-redact.ts` documents. This matters because a
 * run-scoped logger, once it exists, is exactly the kind of seam a future
 * caller will be tempted to hand raw connector output — the module fails
 * toward safety rather than assuming every caller pre-redacts.
 */

import { type RedactedStderr, redactStderrTail, type StderrRedactionOptions } from "./stderr-redact.ts";

/**
 * Minimal shape this module needs from a base logger. Deliberately narrower
 * than `FastifyBaseLogger` / Pino's own type so `runtime/` does not take a
 * hard dependency on `fastify`'s types — any Pino instance (or a test double
 * shaped like one) satisfies this structurally.
 */
export interface RunBaseLogger {
  error: (fields: Record<string, unknown>, message: string) => void;
  info: (fields: Record<string, unknown>, message: string) => void;
  warn: (fields: Record<string, unknown>, message: string) => void;
}

/** Silent default so every existing scheduler/run-executor caller that does not inject a real logger stays byte-identical. */
export const NOOP_RUN_BASE_LOGGER: RunBaseLogger = {
  error: () => {
    // intentionally silent — see module doc
  },
  info: () => {
    // intentionally silent — see module doc
  },
  warn: () => {
    // intentionally silent — see module doc
  },
};

export interface RunLogIdentity {
  readonly connectorId: string;
  readonly connectorInstanceId?: string | null | undefined;
  readonly runId?: string | null | undefined;
}

export interface RunLogFields {
  /** Extra structured fields beyond the run identity (e.g. `phase`, `attempt`). Merged alongside the identity fields, never overwriting them. */
  readonly [key: string]: unknown;
}

export interface RunLogger {
  error: (message: string, fields?: RunLogFields) => void;
  info: (message: string, fields?: RunLogFields) => void;
  warn: (message: string, fields?: RunLogFields) => void;
}

/**
 * Declared reason tokens this run is allowed to keep verbatim through
 * redaction — see `runtime/stderr-redact.ts`'s module doc for why this must
 * be an explicit allowlist, not a shape heuristic. Optional: omitted callers
 * get exactly today's `redactStderrTail` behavior.
 */
export interface RunLoggerOptions {
  readonly declaredReasonTokens?: StderrRedactionOptions["declaredReasonTokens"];
}

function redactMessage(message: string, options: RunLoggerOptions | undefined): string {
  const result: RedactedStderr = redactStderrTail(message, {
    ...(options?.declaredReasonTokens ? { declaredReasonTokens: options.declaredReasonTokens } : {}),
  });
  return result.text;
}

/**
 * Build a logger bound to one run's identity. Every call merges
 * `{ run_id, connector_id, connector_instance_id }` into the structured
 * fields object ahead of caller-supplied fields (so a caller cannot
 * accidentally shadow the identity), and redacts `message` the same way
 * `boundConnectorErrorMessage` redacts a connector's terminal error text.
 *
 * `identity.runId`/`connectorInstanceId` are optional because some call
 * sites (e.g. a pre-run-gate probe) fire before a run id has been minted —
 * the field is simply omitted rather than logged as a misleading `null`.
 */
export function createRunLogger(base: RunBaseLogger, identity: RunLogIdentity, options?: RunLoggerOptions): RunLogger {
  const identityFields: Record<string, unknown> = { connector_id: identity.connectorId };
  if (identity.connectorInstanceId) {
    identityFields.connector_instance_id = identity.connectorInstanceId;
  }
  if (identity.runId) {
    identityFields.run_id = identity.runId;
  }

  function call(level: "error" | "info" | "warn", message: string, fields: RunLogFields | undefined): void {
    base[level]({ ...fields, ...identityFields }, redactMessage(message, options));
  }

  return {
    error: (message, fields) => call("error", message, fields),
    info: (message, fields) => call("info", message, fields),
    warn: (message, fields) => call("warn", message, fields),
  };
}
