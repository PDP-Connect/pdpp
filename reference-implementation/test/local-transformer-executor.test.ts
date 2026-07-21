// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  LocalTransformerExecutor,
  LocalTransformerExecutorError,
  type LocalTransformerExecutorOptions,
  type TransformerChild,
} from "../server/local-transformer-executor.ts";
import { makeLocalTransformerBackend, resolveSemanticBackendFromEnv } from "../server/search-semantic.js";

let nextPid = 40_000;
const SPAWN_PRIVACY_PATTERN = /secret input|do not expose this/;
const STDIN_PRIVACY_PATTERN = /secret input|stdin failure/;
const SUPERVISOR_CONTRACT_PATTERN = /PDPP_LOCAL_TRANSFORMER_SUPERVISOR_RESTART_CONTRACT=1/;

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly pid = nextPid++;
  readonly signals: NodeJS.Signals[] = [];
  readonly writes: string[] = [];
  readonly stdin = new EventEmitter() as EventEmitter & {
    end: () => void;
    write: (value: string) => boolean;
  };
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  onEnd: (() => void) | null = null;
  onKill: ((signal: NodeJS.Signals) => void) | null = null;
  onWrite: ((value: string) => void) | null = null;

  constructor() {
    super();
    this.stdin.end = () => this.onEnd?.();
    this.stdin.write = (value) => {
      this.writes.push(value);
      this.onWrite?.(value);
      return true;
    };
  }

  kill(signal: NodeJS.Signals) {
    this.signals.push(signal);
    this.onKill?.(signal);
    return true;
  }

  exit(code = 0, signal: NodeJS.Signals | null = null) {
    if (this.exitCode !== null || this.signalCode !== null) {
      return;
    }
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
    this.stdout.end();
  }

  reply(value: Record<string, unknown>) {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }

  job() {
    assert.equal(this.writes.length, 1, "one job should have been written");
    return JSON.parse(this.writes[0] ?? "{}") as {
      attempt: number;
      backendIdentity: string;
      generation: number;
      jobId: string;
    };
  }
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function afterIo() {
  await new Promise((resolve) => setImmediate(resolve));
}

function executorFor(children: FakeChild[], options: Omit<LocalTransformerExecutorOptions, "spawnChild"> = {}) {
  return new LocalTransformerExecutor({
    deadlineMs: 100,
    termGraceMs: 10,
    killGraceMs: 10,
    ...options,
    spawnChild: () => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as TransformerChild;
    },
  });
}

function assertCode(code: string) {
  return (error: unknown) => error instanceof LocalTransformerExecutorError && error.code === code;
}

function promiseState(promise: Promise<unknown>) {
  return Promise.race([
    promise.then(
      () => "settled",
      () => "settled"
    ),
    delay(5).then(() => "pending"),
  ]);
}

test("local transformer executor accepts only an exact current-generation reply", async () => {
  const children: FakeChild[] = [];
  const executor = executorFor(children);
  const work = executor.embed("private input", "backend-a", { modelId: "model" });
  const child = children[0];
  assert.ok(child);
  const job = child.job();

  child.reply({ ...job, generation: job.generation + 1, vector: [9] });
  child.reply({ ...job, attempt: job.attempt + 1, vector: [9] });
  child.reply({ ...job, backendIdentity: "forged", vector: [9] });
  await afterIo();
  assert.equal(await promiseState(work), "pending", "forged or stale replies cannot settle work");

  child.reply({ ...job, vector: [1, 2, 3] });
  assert.deepEqual(Array.from(await work), [1, 2, 3]);
  const second = executor.embed("second input", "backend-a", { modelId: "model" });
  const secondJob = JSON.parse(child.writes[1] ?? "{}") as {
    attempt: number;
    jobId: string;
    generation: number;
    backendIdentity: string;
  };
  assert.equal(secondJob.attempt, job.attempt + 1, "job attempt ordinals must advance across submissions");
  child.reply({ ...secondJob, vector: [4, 5, 6] });
  assert.deepEqual(Array.from(await second), [4, 5, 6]);
  child.onEnd = () => child.exit();
  await executor.close();
});

test("local transformer executor bounds parent admission before writing and recovers after a reply", async () => {
  const children: FakeChild[] = [];
  const executor = executorFor(children, { queueLimit: 1, workLimit: 1 });
  const first = executor.embed("first", "backend-a", {});
  const second = executor.embed("second", "backend-a", {});
  await assert.rejects(executor.embed("third private input", "backend-a", {}), assertCode("transformer_work_busy"));
  const child = children[0];
  assert.ok(child);
  assert.equal(child.writes.length, 2, "saturated admission must not write a third job");
  assert.equal(children.length, 1, "saturated admission must not spawn another child");

  const firstJob = JSON.parse(child.writes[0] ?? "{}") as Record<string, unknown>;
  child.reply({ ...firstJob, vector: [1] });
  await assert.doesNotReject(first);
  const third = executor.embed("third", "backend-a", {});
  assert.equal(child.writes.length, 3, "a settled job restores exactly one admission slot");
  const secondJob = JSON.parse(child.writes[1] ?? "{}") as Record<string, unknown>;
  const thirdJob = JSON.parse(child.writes[2] ?? "{}") as Record<string, unknown>;
  child.reply({ ...secondJob, vector: [2] });
  child.reply({ ...thirdJob, vector: [3] });
  await assert.doesNotReject(Promise.all([second, third]));
  child.onEnd = () => child.exit();
  await executor.close();
});

test("unexpected child exit fences and rejects the generation after confirmed exit", async () => {
  const children: FakeChild[] = [];
  const executor = executorFor(children);
  const work = executor.embed("input", "backend-a", {});
  children[0]?.exit();
  await assert.rejects(work, assertCode("transformer_child_exited"));
  assert.deepEqual(executor.telemetry(), {
    generation: 1,
    pendingJobs: 0,
    stopped: false,
    terminating: false,
    childPid: null,
    childRssBytes: null,
    peakChildRssBytes: 0,
    childHighWater: 0,
    childQueueDepth: 0,
  });
  await executor.close();
});

test("deadline fences immediately, then rejects only after confirmed TERM exit", async () => {
  const children: FakeChild[] = [];
  const executor = executorFor(children, { deadlineMs: 5, termGraceMs: 30 });
  const work = executor.embed("input", "backend-a", {});
  const child = children[0];
  assert.ok(child);
  await delay(7);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  child.reply({ ...child.job(), vector: [99] });
  await afterIo();
  assert.equal(await promiseState(work), "pending", "a late reply cannot escape the deadline fence");
  child.exit(0, "SIGTERM");
  await assert.rejects(work, assertCode("transformer_deadline"));
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.equal(executor.telemetry().pendingJobs, 0);
  assert.equal(executor.telemetry().childPid, null, "confirmed exit leaves no tracked child");
});

test("TERM-ignore uses KILL and still waits for confirmed exit before cleanup", async () => {
  const children: FakeChild[] = [];
  const executor = executorFor(children, { deadlineMs: 5, termGraceMs: 5, killGraceMs: 15 });
  const work = executor.embed("input", "backend-a", {});
  const child = children[0];
  assert.ok(child);
  child.onKill = (signal) => {
    if (signal === "SIGKILL") {
      child.exit(0, signal);
    }
  };

  await assert.rejects(work, assertCode("transformer_deadline"));
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(executor.telemetry().childPid, null, "KILL exit is confirmed before child state is released");
});

test("termination rejects new admission and cannot replace before the old child exits", async () => {
  const children: FakeChild[] = [];
  const executor = executorFor(children, { deadlineMs: 5, termGraceMs: 40, killGraceMs: 40 });
  const first = executor.embed("input", "backend-a", {});
  const firstChild = children[0];
  assert.ok(firstChild);
  await delay(10);
  await assert.rejects(executor.embed("new input", "backend-a", {}), assertCode("transformer_terminating"));
  assert.equal(children.length, 1, "no replacement starts while termination is unresolved");

  firstChild.exit();
  await assert.rejects(first, assertCode("transformer_deadline"));
  const second = executor.embed("new input", "backend-a", {});
  assert.equal(children.length, 2, "replacement starts only after confirmed old exit");
  const secondChild = children[1];
  assert.ok(secondChild);
  secondChild.reply({ ...secondChild.job(), vector: [2] });
  await assert.doesNotReject(second);
  secondChild.onEnd = () => secondChild.exit();
  await executor.close();
});

test("local backend keeps semantic preflight available across a confirmed deadline and replacement generation", async () => {
  const children: FakeChild[] = [];
  const backend = makeLocalTransformerBackend(
    {
      profileId: "test",
      modelId: "test-model",
      dimensions: 3,
      distanceMetric: "cosine",
      dtype: "q4",
      cacheDir: "/tmp/pdpp-test-transformer-cache",
      downloadAllowed: true,
      languageBias: null,
    },
    {
      executorOptions: {
        deadlineMs: 5,
        termGraceMs: 20,
        killGraceMs: 20,
        spawnChild: () => {
          const child = new FakeChild();
          children.push(child);
          return child as unknown as TransformerChild;
        },
      },
    }
  );
  const first = backend.embedDocument("first");
  const firstChild = children[0];
  assert.ok(firstChild);
  firstChild.onKill = (signal) => {
    if (signal === "SIGTERM") {
      firstChild.exit(0, signal);
    }
  };
  await assert.rejects(first, assertCode("transformer_deadline"));
  assert.equal(backend.available(), true, "a confirmed lifecycle failure must not deadlock preflight");

  const second = backend.embedDocument("second");
  const secondChild = children[1];
  assert.ok(secondChild, "the confirmed old exit permits a replacement generation");
  secondChild.reply({ ...secondChild.job(), vector: [0.1, 0.2, 0.3] });
  assert.deepEqual(
    Array.from(await second).map((value) => Number(value.toFixed(6))),
    [0.1, 0.2, 0.3]
  );
  secondChild.onEnd = () => secondChild.exit();
  await backend.close();
});

test("spawn and stdin failure fence safely without exposing source input", async () => {
  const spawnFailure = new LocalTransformerExecutor({
    spawnChild: () => {
      throw new Error("do not expose this");
    },
  });
  await assert.rejects(spawnFailure.embed("secret input", "backend-a", {}), (error: unknown) => {
    assert.doesNotMatch(String(error), SPAWN_PRIVACY_PATTERN);
    return assertCode("transformer_spawn_failed")(error);
  });

  const children: FakeChild[] = [];
  const executor = executorFor(children);
  const child = new FakeChild();
  child.stdin.write = () => {
    throw new Error("stdin failure with secret input");
  };
  child.onKill = (signal) => {
    if (signal === "SIGTERM") {
      child.exit(0, signal);
    }
  };
  const writingExecutor = new LocalTransformerExecutor({
    deadlineMs: 100,
    termGraceMs: 10,
    killGraceMs: 10,
    spawnChild: () => {
      children.push(child);
      return child as unknown as TransformerChild;
    },
  });
  const work = writingExecutor.embed("secret input", "backend-a", {});
  await assert.rejects(work, (error: unknown) => {
    assert.doesNotMatch(String(error), STDIN_PRIVACY_PATTERN);
    return assertCode("transformer_child_io_failed")(error);
  });
  assert.equal(writingExecutor.telemetry().pendingJobs, 0);

  const asyncErrorChildren: FakeChild[] = [];
  const asyncErrorExecutor = executorFor(asyncErrorChildren);
  const asyncErrorWork = asyncErrorExecutor.embed("secret input", "backend-a", {});
  const asyncErrorChild = asyncErrorChildren[0];
  assert.ok(asyncErrorChild);
  asyncErrorChild.onKill = (signal) => {
    if (signal === "SIGTERM") {
      asyncErrorChild.exit(0, signal);
    }
  };
  asyncErrorChild.emit("error", new Error("spawn diagnostic must not escape"));
  await assert.rejects(asyncErrorWork, assertCode("transformer_child_io_failed"));
  assert.equal(asyncErrorExecutor.telemetry().pendingJobs, 0);
  await executor.close();
});

test("KILL-unconfirmed invokes fail-stop and deliberately retains generation promises", async () => {
  const children: FakeChild[] = [];
  const failStops: string[] = [];
  const executor = executorFor(children, {
    deadlineMs: 5,
    termGraceMs: 5,
    killGraceMs: 5,
    failStop: (reason) => failStops.push(reason),
  });
  const work = executor.embed("input", "backend-a", {});
  await delay(30);
  assert.deepEqual(children[0]?.signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(failStops, ["transformer_exit_unconfirmed"]);
  assert.equal(await promiseState(work), "pending", "unconfirmed compute must retain its permit-bearing promise");
  assert.equal(executor.telemetry().pendingJobs, 1);
  assert.equal(executor.telemetry().stopped, true);
  await assert.rejects(executor.embed("new input", "backend-a", {}), assertCode("transformer_fail_stop"));
});

test("close handles an already-exited child without waiting a full grace period", async () => {
  const children: FakeChild[] = [];
  const executor = executorFor(children, { termGraceMs: 80 });
  const work = executor.embed("input", "backend-a", {});
  const child = children[0];
  assert.ok(child);
  child.onEnd = () => child.exit();
  const started = performance.now();
  await executor.close();
  assert.ok(performance.now() - started < 40, "already-exited child must not consume a full termination grace");
  await assert.rejects(work, assertCode("transformer_closed"));
  await assert.rejects(executor.embed("new input", "backend-a", {}), assertCode("transformer_closed"));
  assert.equal(executor.telemetry().childPid, null);
});

test("production local mode reads the supplied supervisor contract environment", () => {
  assert.throws(
    () =>
      resolveSemanticBackendFromEnv({
        NODE_ENV: "production",
        PDPP_SEMANTIC_EMBEDDING_BACKEND: "local",
      }),
    SUPERVISOR_CONTRACT_PATTERN
  );
  assert.doesNotThrow(() =>
    resolveSemanticBackendFromEnv({
      NODE_ENV: "production",
      PDPP_SEMANTIC_EMBEDDING_BACKEND: "local",
      PDPP_LOCAL_TRANSFORMER_SUPERVISOR_RESTART_CONTRACT: "1",
      PDPP_EMBEDDING_DOWNLOAD_ALLOWED: "0",
    })
  );
});
