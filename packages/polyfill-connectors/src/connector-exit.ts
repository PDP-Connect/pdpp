// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

const STDOUT_DRAIN_TIMEOUT_MS = 3000;
const RUNTIME_ACK_TIMEOUT_MS = 30 * 60 * 1000;

interface FlushAndExitOptions {
  exit?: (code: number) => void;
  runtimeAckTimeoutMs?: number;
  stdin?: RuntimeAckReadable;
  stdout?: RuntimeAckWritable;
  stdoutDrainTimeoutMs?: number;
}

interface RuntimeAckReadable {
  destroyed: boolean;
  off: (event: "close" | "end" | "error", listener: () => void) => unknown;
  once: (event: "close" | "end" | "error", listener: () => void) => unknown;
  readableEnded: boolean;
}
interface RuntimeAckWritable {
  off: (event: "drain", listener: () => void) => unknown;
  once: (event: "drain", listener: () => void) => unknown;
  writableLength: number;
}

/**
 * Connector terminal handshake.
 *
 * Draining stdout only proves bytes reached the OS pipe. The reference runtime
 * closes connector stdin after it has consumed DONE and completed final ingest;
 * waiting for that EOF prevents records_emitted validation races on slow RS
 * flushes. The long ACK timeout is a last-resort orphan guard, not normal flow.
 */
export function flushAndExitAfterRuntimeAck(code: number, options: FlushAndExitOptions = {}): void {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const exit = options.exit ?? process.exit;
  const stdoutDrainTimeoutMs = options.stdoutDrainTimeoutMs ?? STDOUT_DRAIN_TIMEOUT_MS;
  const runtimeAckTimeoutMs = options.runtimeAckTimeoutMs ?? RUNTIME_ACK_TIMEOUT_MS;

  let finished = false;
  let drainTimer: NodeJS.Timeout | null = null;
  let ackTimer: NodeJS.Timeout | null = null;

  const finish = (): void => {
    if (finished) {
      return;
    }
    finished = true;
    if (drainTimer) {
      clearTimeout(drainTimer);
    }
    if (ackTimer) {
      clearTimeout(ackTimer);
    }
    exit(code);
  };

  const waitForRuntimeAck = (): void => {
    if (drainTimer) {
      clearTimeout(drainTimer);
      drainTimer = null;
    }
    if (stdin.readableEnded || stdin.destroyed) {
      finish();
      return;
    }

    const cleanup = (): void => {
      stdin.off("close", onRuntimeAck);
      stdin.off("end", onRuntimeAck);
      stdin.off("error", onRuntimeAck);
    };
    const onRuntimeAck = (): void => {
      cleanup();
      finish();
    };

    stdin.once("close", onRuntimeAck);
    stdin.once("end", onRuntimeAck);
    stdin.once("error", onRuntimeAck);
    ackTimer = setTimeout(() => {
      cleanup();
      finish();
    }, runtimeAckTimeoutMs);
    ackTimer.unref();
  };

  if (stdout.writableLength > 0) {
    stdout.once("drain", waitForRuntimeAck);
    drainTimer = setTimeout(() => {
      stdout.off("drain", waitForRuntimeAck);
      waitForRuntimeAck();
    }, stdoutDrainTimeoutMs);
    drainTimer.unref();
    return;
  }

  waitForRuntimeAck();
}
