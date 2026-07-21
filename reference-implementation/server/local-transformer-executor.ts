// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";

export class LocalTransformerExecutorError extends Error {
  code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "LocalTransformerExecutorError";
  }
}

interface PendingJob {
  readonly attempt: number;
  readonly backendIdentity: string;
  readonly generation: number;
  readonly reject: (error: Error) => void;
  readonly resolve: (vector: Float32Array) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface ChildTelemetry {
  readonly active?: unknown;
  readonly highWater?: unknown;
  readonly queueDepth?: unknown;
  readonly rssBytes?: unknown;
}

interface ChildReply {
  readonly attempt?: number;
  readonly backendIdentity?: string;
  readonly error?: string;
  readonly generation?: number;
  readonly jobId?: string;
  readonly telemetry?: ChildTelemetry;
  readonly vector?: unknown;
}

interface ChildStdin {
  end(): void;
  on?(event: "error", listener: (error: Error) => void): ChildStdin;
  write(value: string): boolean;
}

export interface TransformerChild {
  readonly exitCode?: number | null;
  kill(signal: NodeJS.Signals): boolean;
  once(event: "error", listener: (error: Error) => void): TransformerChild;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): TransformerChild;
  readonly pid?: number;
  readonly signalCode?: NodeJS.Signals | null;
  readonly stdin: ChildStdin | null;
  readonly stdout: NodeJS.ReadableStream | null;
}

export interface LocalTransformerSpawnOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly stdio: ["pipe", "pipe", "ignore"];
}

export interface LocalTransformerExecutorOptions {
  readonly command?: string;
  readonly deadlineMs?: number;
  readonly failStop?: (reason: string) => void;
  readonly killGraceMs?: number;
  readonly queueLimit?: number;
  readonly spawnChild?: (
    command: string,
    args: readonly string[],
    options: LocalTransformerSpawnOptions
  ) => TransformerChild;
  readonly termGraceMs?: number;
  readonly workerPath?: string;
  readonly workLimit?: number;
}

export interface LocalTransformerExecutionTelemetry {
  readonly childHighWater: number;
  readonly childPid: number | null;
  readonly childQueueDepth: number;
  readonly childRssBytes: number | null;
  readonly generation: number;
  readonly peakChildRssBytes: number;
  readonly pendingJobs: number;
  readonly stopped: boolean;
  readonly terminating: boolean;
}

interface ChildSession {
  readonly child: TransformerChild;
  exitConfirmed: boolean;
  readonly exited: Promise<void>;
  fenced: boolean;
  finalized: boolean;
  readonly generation: number;
  readonly reader: Interface;
  readonly resolveExited: () => void;
  termination: Promise<void> | null;
}

const DEFAULT_DEADLINE_MS = 30_000;
const DEFAULT_TERM_GRACE_MS = 5000;
const DEFAULT_KILL_GRACE_MS = 2000;
const DEFAULT_WORK_LIMIT = 1;
const DEFAULT_QUEUE_LIMIT = 32;
const MAX_WORK_LIMIT = 8;
const MAX_QUEUE_LIMIT = 256;
const PROC_RSS_PATTERN = /^VmRSS:\s+(\d+)\s+kB$/m;

function positiveEnv(name: string, fallback: number, maximum: number) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, maximum);
}

function boundedPositive(value: number | undefined, envName: string, fallback: number, maximum: number) {
  if (value === undefined) {
    return positiveEnv(envName, fallback, maximum);
  }
  if (!Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return Math.min(value, maximum);
}

function safeChildRssBytes(pid: number | undefined) {
  if (!pid || pid <= 0 || process.platform !== "linux") {
    return null;
  }
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const match = PROC_RSS_PATTERN.exec(status);
    return match ? Number(match[1]) * 1024 : null;
  } catch {
    return null;
  }
}

function asPositiveInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function defaultFailStop(_reason: string) {
  // An unconfirmed SIGKILL leaves process-wide semantic/index permits unsafe to
  // release. A supervised production process must terminate instead of serving
  // alongside unaccounted-for transformer work.
  process.exit(1);
}

function defaultSpawnChild(command: string, args: readonly string[], options: LocalTransformerSpawnOptions) {
  return spawn(command, [...args], options) as unknown as TransformerChild;
}

export class LocalTransformerExecutor {
  #session: ChildSession | null = null;
  #generation = 0;
  #jobNumber = 0;
  readonly #pending = new Map<string, PendingJob>();
  #closed = false;
  #stopped = false;
  #peakChildRssBytes = 0;
  #childHighWater = 0;
  #childQueueDepth = 0;
  readonly #command: string;
  readonly #deadlineMs: number;
  readonly #failStop: (reason: string) => void;
  readonly #killGraceMs: number;
  readonly #queueLimit: number;
  readonly #spawnChild: (
    command: string,
    args: readonly string[],
    options: LocalTransformerSpawnOptions
  ) => TransformerChild;
  readonly #termGraceMs: number;
  readonly #workLimit: number;
  readonly #workerPath: string;

  constructor(options: LocalTransformerExecutorOptions = {}) {
    this.#command = options.command ?? process.execPath;
    this.#deadlineMs = boundedPositive(
      options.deadlineMs,
      "PDPP_LOCAL_TRANSFORMER_DEADLINE_MS",
      DEFAULT_DEADLINE_MS,
      10 * 60_000
    );
    this.#termGraceMs = boundedPositive(
      options.termGraceMs,
      "PDPP_LOCAL_TRANSFORMER_TERM_GRACE_MS",
      DEFAULT_TERM_GRACE_MS,
      60_000
    );
    this.#killGraceMs = boundedPositive(
      options.killGraceMs,
      "PDPP_LOCAL_TRANSFORMER_KILL_GRACE_MS",
      DEFAULT_KILL_GRACE_MS,
      60_000
    );
    this.#workLimit = boundedPositive(
      options.workLimit,
      "PDPP_LOCAL_TRANSFORMER_WORK_LIMIT",
      DEFAULT_WORK_LIMIT,
      MAX_WORK_LIMIT
    );
    this.#queueLimit = boundedPositive(
      options.queueLimit,
      "PDPP_LOCAL_TRANSFORMER_QUEUE_LIMIT",
      DEFAULT_QUEUE_LIMIT,
      MAX_QUEUE_LIMIT
    );
    this.#failStop = options.failStop ?? defaultFailStop;
    this.#spawnChild = options.spawnChild ?? defaultSpawnChild;
    this.#workerPath = options.workerPath ?? fileURLToPath(new URL("./local-transformer-child.js", import.meta.url));
  }

  embed(text: string, backendIdentity: string, config: Record<string, unknown>): Promise<Float32Array> {
    if (this.#closed) {
      return Promise.reject(new LocalTransformerExecutorError("transformer_closed"));
    }
    if (this.#stopped) {
      return Promise.reject(new LocalTransformerExecutorError("transformer_fail_stop"));
    }
    if (this.#session?.termination) {
      return Promise.reject(new LocalTransformerExecutorError("transformer_terminating"));
    }
    if (this.#pending.size >= this.#workLimit + this.#queueLimit) {
      return Promise.reject(new LocalTransformerExecutorError("transformer_work_busy"));
    }

    let session: ChildSession;
    try {
      session = this.#ensureSession();
    } catch {
      return Promise.reject(new LocalTransformerExecutorError("transformer_spawn_failed"));
    }
    if (session.termination || session.fenced) {
      return Promise.reject(new LocalTransformerExecutorError("transformer_terminating"));
    }

    const jobId = `job_${++this.#jobNumber}`;
    // Each submitted job receives the current monotonic ordinal. This is the
    // attempt identity carried through the child-generation fence; a
    // replacement generation cannot accidentally reuse an old job ordinal.
    const attempt = this.#jobNumber;
    const job = new Promise<Float32Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#beginTermination(session, "transformer_deadline").catch(() => undefined);
      }, this.#deadlineMs);
      this.#pending.set(jobId, {
        generation: session.generation,
        attempt,
        backendIdentity,
        resolve,
        reject,
        timer,
      });
    });

    try {
      const stdin = session.child.stdin;
      if (!stdin) {
        throw new Error("transformer child stdin is unavailable");
      }
      stdin.write(
        `${JSON.stringify({
          generation: session.generation,
          jobId,
          attempt,
          backendIdentity,
          text,
          config,
        })}\n`
      );
      this.#sampleChildRss(session);
    } catch {
      this.#beginTermination(session, "transformer_child_io_failed").catch(() => undefined);
    }
    return job;
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    const session = this.#session;
    if (!session) {
      this.#stopped = true;
      return;
    }
    await this.#beginTermination(session, "transformer_closed", true);
  }

  telemetry(): LocalTransformerExecutionTelemetry {
    const session = this.#session;
    if (session) {
      this.#sampleChildRss(session);
    }
    return {
      generation: this.#generation,
      pendingJobs: this.#pending.size,
      stopped: this.#stopped,
      terminating: Boolean(session?.termination),
      childPid: session?.child.pid ?? null,
      childRssBytes: session ? safeChildRssBytes(session.child.pid) : null,
      peakChildRssBytes: this.#peakChildRssBytes,
      childHighWater: this.#childHighWater,
      childQueueDepth: this.#childQueueDepth,
    };
  }

  resetTelemetry() {
    this.#peakChildRssBytes = 0;
    this.#childHighWater = 0;
    this.#childQueueDepth = 0;
    if (this.#session) {
      this.#sampleChildRss(this.#session);
    }
  }

  #ensureSession(): ChildSession {
    if (this.#session) {
      return this.#session;
    }
    const child = this.#spawnChild(this.#command, [this.#workerPath], {
      // The child receives only execution limits. Model/cache settings travel in
      // a job payload; no parent credentials or service configuration are inherited.
      env: {
        PDPP_LOCAL_TRANSFORMER_QUEUE_LIMIT: String(this.#queueLimit),
        PDPP_LOCAL_TRANSFORMER_WORK_LIMIT: String(this.#workLimit),
      },
      stdio: ["pipe", "pipe", "ignore"],
    });
    if (!(child.stdin && child.stdout)) {
      try {
        child.kill("SIGKILL");
      } catch {
        // The child could have exited while spawn was being inspected.
      }
      throw new Error("transformer child streams unavailable");
    }

    let resolveExited!: () => void;
    const exited = new Promise<void>((resolve) => {
      resolveExited = resolve;
    });
    const session: ChildSession = {
      child,
      generation: this.#generation,
      reader: createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY }),
      exited,
      resolveExited,
      exitConfirmed: false,
      fenced: false,
      finalized: false,
      termination: null,
    };
    this.#session = session;
    session.reader.on("line", (line) => this.#handleReply(session, line));
    child.once("exit", () => this.#handleExit(session));
    child.once("error", () => this.#handleChildFault(session));
    child.stdin.on?.("error", () => this.#handleChildFault(session));
    (child.stdout as NodeJS.ReadableStream & { on?: (event: "error", listener: () => void) => unknown }).on?.(
      "error",
      () => this.#handleChildFault(session)
    );
    if (child.exitCode !== null && child.exitCode !== undefined) {
      this.#handleExit(session);
    }
    this.#sampleChildRss(session);
    return session;
  }

  #handleReply(session: ChildSession, line: string) {
    let reply: ChildReply;
    try {
      reply = JSON.parse(line) as ChildReply;
    } catch {
      return;
    }
    this.#recordChildTelemetry(session, reply.telemetry);
    if (
      this.#session !== session ||
      session.fenced ||
      reply.generation !== session.generation ||
      typeof reply.jobId !== "string"
    ) {
      return;
    }
    const pending = this.#pending.get(reply.jobId);
    if (
      !pending ||
      pending.generation !== reply.generation ||
      pending.attempt !== reply.attempt ||
      pending.backendIdentity !== reply.backendIdentity
    ) {
      return;
    }
    this.#pending.delete(reply.jobId);
    clearTimeout(pending.timer);
    if (reply.error || !Array.isArray(reply.vector)) {
      pending.reject(new LocalTransformerExecutorError("transformer_compute_failed"));
      return;
    }
    pending.resolve(Float32Array.from(reply.vector));
  }

  #handleChildFault(session: ChildSession) {
    if (this.#session !== session || session.exitConfirmed || session.termination) {
      return;
    }
    this.#beginTermination(session, "transformer_child_io_failed").catch(() => undefined);
  }

  #handleExit(session: ChildSession) {
    if (session.exitConfirmed) {
      return;
    }
    session.exitConfirmed = true;
    session.resolveExited();
    session.reader.close();
    if (this.#session !== session || session.termination) {
      return;
    }
    this.#fence(session);
    this.#finalizeGeneration(session, "transformer_child_exited");
  }

  #fence(session: ChildSession) {
    if (session.fenced) {
      return;
    }
    session.fenced = true;
    this.#generation += 1;
    for (const pending of this.#pending.values()) {
      if (pending.generation === session.generation) {
        clearTimeout(pending.timer);
      }
    }
  }

  #beginTermination(session: ChildSession, reason: string, gracefulClose = false): Promise<void> {
    if (session.termination) {
      return session.termination;
    }
    this.#fence(session);
    session.termination = this.#terminate(session, reason, gracefulClose);
    return session.termination;
  }

  async #terminate(session: ChildSession, reason: string, gracefulClose: boolean) {
    // Assign session.termination before an exit/error handler can classify this
    // as an unexpected exit. This also forbids replacement during shutdown.
    await Promise.resolve();

    if (gracefulClose) {
      try {
        session.child.stdin?.end();
      } catch {
        // The TERM/KILL path below owns disposal after an I/O failure.
      }
      if (await this.#waitForExit(session, this.#termGraceMs)) {
        this.#finalizeGeneration(session, reason);
        return;
      }
    }

    try {
      session.child.kill("SIGTERM");
    } catch {
      // A raced exit is confirmed only by #waitForExit.
    }
    if (await this.#waitForExit(session, this.#termGraceMs)) {
      this.#finalizeGeneration(session, reason);
      return;
    }

    try {
      session.child.kill("SIGKILL");
    } catch {
      // A raced exit is confirmed only by #waitForExit.
    }
    if (await this.#waitForExit(session, this.#killGraceMs)) {
      this.#finalizeGeneration(session, reason);
      return;
    }

    // Intentionally retain the unresolved jobs and their upstream permits. The
    // old process may still be computing, so releasing them would violate the
    // execution fence. Production's default hook terminates nonzero.
    this.#stopped = true;
    this.#failStop("transformer_exit_unconfirmed");
  }

  async #waitForExit(session: ChildSession, timeoutMs: number): Promise<boolean> {
    if (session.exitConfirmed) {
      return true;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const confirmed = session.exited.then(() => true);
    const result = await Promise.race([confirmed, timedOut]);
    if (timer) {
      clearTimeout(timer);
    }
    return result;
  }

  #finalizeGeneration(session: ChildSession, reason: string) {
    if (session.finalized) {
      return;
    }
    session.finalized = true;
    session.reader.close();
    if (this.#session === session) {
      this.#session = null;
    }
    for (const [jobId, pending] of this.#pending) {
      if (pending.generation !== session.generation) {
        continue;
      }
      this.#pending.delete(jobId);
      clearTimeout(pending.timer);
      pending.reject(new LocalTransformerExecutorError(reason));
    }
  }

  #recordChildTelemetry(session: ChildSession, telemetry: ChildTelemetry | undefined) {
    this.#sampleChildRss(session);
    if (!telemetry) {
      return;
    }
    const rssBytes = asPositiveInteger(telemetry.rssBytes);
    if (rssBytes !== null) {
      this.#peakChildRssBytes = Math.max(this.#peakChildRssBytes, rssBytes);
    }
    const highWater = asPositiveInteger(telemetry.highWater);
    if (highWater !== null) {
      this.#childHighWater = Math.max(this.#childHighWater, highWater);
    }
    const queueDepth = asPositiveInteger(telemetry.queueDepth);
    if (queueDepth !== null) {
      this.#childQueueDepth = queueDepth;
    }
  }

  #sampleChildRss(session: ChildSession) {
    const rssBytes = safeChildRssBytes(session.child.pid);
    if (rssBytes !== null) {
      this.#peakChildRssBytes = Math.max(this.#peakChildRssBytes, rssBytes);
    }
  }
}
