// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

const DEFAULT_ACTIVE_LIMIT = 4;
const DEFAULT_QUEUE_LIMIT = 16;
const DEFAULT_LOCK_WAIT_MS = 2000;

export class ConnectorInstanceAdmissionError extends Error {
  readonly code = "connector_instance_busy";

  constructor() {
    super("connector-instance writer admission is saturated");
    this.name = "ConnectorInstanceAdmissionError";
  }
}

/**
 * This shape is exported for type propagation only. Construction is private:
 * re-entry is accepted only when the capability token is still live in the
 * module-private registry below.
 */
export interface ConnectorInstanceWriteOwnership {
  readonly connectorInstanceId: string;
  readonly token: symbol;
}

interface Waiter {
  readonly reject: (error: Error) => void;
  readonly resolve: () => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface KeyedGate {
  held: boolean;
  readonly waiters: Waiter[];
}

let activeWriters = 0;
const admissionWaiters: Waiter[] = [];
const keyedGates = new Map<string, KeyedGate>();
const activeOwnerships = new Map<symbol, string>();
let writePhaseHookForTest:
  | ((stage: "before_key_acquire" | "after_acquire", context: { connectorInstanceId: string }) => Promise<void> | void)
  | null = null;

/** Narrow deterministic ordering seam; production never installs a hook. */
export function __setConnectorInstanceWritePhaseHookForTest(
  hook:
    | ((
        stage: "before_key_acquire" | "after_acquire",
        context: { connectorInstanceId: string }
      ) => Promise<void> | void)
    | null
): void {
  writePhaseHookForTest = hook;
}

function configuredPositiveInteger(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function activeLimit(): number {
  return configuredPositiveInteger("PDPP_INGEST_ACTIVE_BATCH_LIMIT", DEFAULT_ACTIVE_LIMIT);
}

function queueLimit(): number {
  return configuredPositiveInteger("PDPP_INGEST_ADMISSION_QUEUE_LIMIT", DEFAULT_QUEUE_LIMIT);
}

/**
 * Bounded-wait budget for the connector-instance write coordinator's
 * in-process gates AND (see postgres-storage.ts's `withPostgresTransaction`
 * `lockConnectorInstanceId` option) the transaction-scoped Postgres advisory
 * lock every durable mutation now acquires directly on its own connection.
 * One shared knob, because both are the same conceptual "how long may a
 * writer queue behind this connector instance" budget — see
 * harden-connector-instance-write-fence-transaction-native.
 */
export function connectorInstanceLockWaitMs(): number {
  return configuredPositiveInteger("PDPP_INGEST_LOCK_WAIT_MS", DEFAULT_LOCK_WAIT_MS);
}

function removeWaiter(waiters: Waiter[], waiter: Waiter): void {
  const index = waiters.indexOf(waiter);
  if (index >= 0) {
    waiters.splice(index, 1);
  }
}

function boundedWait(waiters: Waiter[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let waiter: Waiter;
    const timer = setTimeout(() => {
      removeWaiter(waiters, waiter);
      reject(new ConnectorInstanceAdmissionError());
    }, connectorInstanceLockWaitMs());
    waiter = { reject, resolve, timer };
    waiters.push(waiter);
  });
}

async function acquireAdmission(): Promise<void> {
  if (activeWriters < activeLimit()) {
    activeWriters += 1;
    return;
  }
  if (admissionWaiters.length >= queueLimit()) {
    throw new ConnectorInstanceAdmissionError();
  }
  await boundedWait(admissionWaiters);
}

function releaseAdmission(): void {
  const next = admissionWaiters.shift();
  if (next) {
    clearTimeout(next.timer);
    next.resolve();
    return;
  }
  activeWriters = Math.max(0, activeWriters - 1);
}

async function acquireKey(connectorInstanceId: string): Promise<() => void> {
  const gate = keyedGates.get(connectorInstanceId) ?? { held: false, waiters: [] };
  keyedGates.set(connectorInstanceId, gate);
  if (!gate.held) {
    gate.held = true;
    return () => releaseKey(connectorInstanceId, gate);
  }
  if (gate.waiters.length >= queueLimit()) {
    throw new ConnectorInstanceAdmissionError();
  }
  await boundedWait(gate.waiters);
  return () => releaseKey(connectorInstanceId, gate);
}

function releaseKey(connectorInstanceId: string, gate: KeyedGate): void {
  const next = gate.waiters.shift();
  if (next) {
    clearTimeout(next.timer);
    next.resolve();
    return;
  }
  gate.held = false;
  if (keyedGates.get(connectorInstanceId) === gate) {
    keyedGates.delete(connectorInstanceId);
  }
}

/**
 * Stable Postgres advisory-lock key for a connector instance. Shared by
 * `postgres-storage.ts`'s `withPostgresTransaction` `lockConnectorInstanceId`
 * option — the SAME key space this module used when it held the lock itself,
 * so a lock acquired under the old session-held design and one acquired
 * under the new transaction-scoped design always contend on the same
 * Postgres advisory-lock id for a given connector instance.
 */
export function connectorInstanceAdvisoryLockKey(connectorInstanceId: string): string {
  const bytes = createHash("sha256")
    .update("pdpp:connector-instance-write:v1:\u0000")
    .update(connectorInstanceId)
    .digest();
  return bytes.readBigInt64BE(0).toString();
}

function validOwnership(
  connectorInstanceId: string,
  ownership: ConnectorInstanceWriteOwnership | undefined
): ownership is ConnectorInstanceWriteOwnership {
  return Boolean(ownership && activeOwnerships.get(ownership.token) === connectorInstanceId);
}

function createOwnership(connectorInstanceId: string): ConnectorInstanceWriteOwnership {
  const ownership = Object.freeze({ connectorInstanceId, token: Symbol(connectorInstanceId) });
  activeOwnerships.set(ownership.token, connectorInstanceId);
  return ownership;
}

/**
 * Serializes one authoritative-plus-derived writer scope per connector
 * instance, IN-PROCESS ONLY. Re-entry requires the exact still-live
 * module-issued ownership capability.
 *
 * Cross-session/cross-process exclusion is no longer this module's job. It
 * used to hold a session-scoped `pg_try_advisory_lock` on a dedicated
 * connection for the operation's ENTIRE duration (a whole HTTP batch, every
 * `afterRecord` await included) — a scarce resource held for O(batch), not
 * O(one durable unit of work), observed in production as UAT :3012's GroupMe
 * blob-upload 503s (run_1786339135735_1) and, independently, as same-instance
 * batch/blob-write starvation under `PDPP_INGEST_LOCK_WAIT_MS`. Every
 * production caller now acquires a TRANSACTION-scoped `pg_advisory_xact_lock`
 * directly inside its own `withPostgresTransaction` call via the
 * `lockConnectorInstanceId` option (postgres-storage.ts) — held only for
 * that transaction's true durable critical section, on that transaction's
 * own connection (zero extra pool connections), and released automatically
 * at COMMIT/ROLLBACK. A caller that performs several transactions under one
 * held ownership (e.g. `ingestRecords`'s per-record loop) reacquires the
 * SAME advisory-lock key once per transaction, not once for the whole batch.
 * See harden-connector-instance-write-fence-transaction-native.
 *
 * Acquisition order is key-then-admission, not admission-then-key: the
 * per-instance keyed gate (`acquireKey`) is a free, in-process Map lookup,
 * while the global admission gate (`acquireAdmission`) bounds genuinely
 * concurrent ACTIVE work. Acquiring admission first meant a caller merely
 * queued behind a hot connector instance's key still consumed one of the
 * (default 4) global admission slots while doing zero useful work, so
 * `activeLimit()`-many same-key waiters could saturate admission for every
 * OTHER connector instance's writers too. Acquiring the key first means a
 * caller only takes an admission slot once it actually holds the resource it
 * needs, matching `withConnectorInstanceControlPlaneWrite`'s existing
 * key-only design (see its docstring: "allowing enrollment to proceed when
 * unrelated bulk ingest has saturated the bounded data-plane admission
 * gate").
 */
export async function withConnectorInstanceWrite<T>(
  connectorInstanceId: string,
  operation: (ownership: ConnectorInstanceWriteOwnership) => Promise<T>,
  ownership?: ConnectorInstanceWriteOwnership
): Promise<T> {
  if (ownership) {
    if (!validOwnership(connectorInstanceId, ownership)) {
      throw new Error("connector-instance write ownership is forged, stale, or bound to another instance");
    }
    return operation(ownership);
  }
  if (!connectorInstanceId) {
    throw new Error("connector_instance_id is required for write coordination");
  }

  // biome-ignore lint/suspicious/noShadow: The local name follows the external payload vocabulary at this boundary.
  let releaseKey: (() => void) | null = null;
  let admitted = false;
  let nextOwnership: ConnectorInstanceWriteOwnership | null = null;
  try {
    if (writePhaseHookForTest) {
      await writePhaseHookForTest("before_key_acquire", { connectorInstanceId });
    }
    releaseKey = await acquireKey(connectorInstanceId);
    await acquireAdmission();
    admitted = true;
    nextOwnership = createOwnership(connectorInstanceId);
    if (writePhaseHookForTest) {
      await writePhaseHookForTest("after_acquire", { connectorInstanceId });
    }
    return await operation(nextOwnership);
  } finally {
    if (nextOwnership) {
      activeOwnerships.delete(nextOwnership.token);
    }
    if (admitted) {
      releaseAdmission();
    }
    releaseKey?.();
  }
}

/**
 * Serialize a control-plane mutation with the same per-instance exclusion as
 * writers, without consuming an ingest writer-admission slot. This preserves
 * delete/upsert ordering while allowing enrollment to proceed when unrelated
 * bulk ingest has saturated the bounded data-plane admission gate.
 */
export async function withConnectorInstanceControlPlaneWrite<T>(
  connectorInstanceId: string,
  operation: () => Promise<T>
): Promise<T> {
  if (!connectorInstanceId) {
    throw new Error("connector_instance_id is required for control-plane write coordination");
  }

  // biome-ignore lint/suspicious/noShadow: The local name follows the external payload vocabulary at this boundary.
  let releaseKey: (() => void) | null = null;
  try {
    releaseKey = await acquireKey(connectorInstanceId);
    return await operation();
  } finally {
    releaseKey?.();
  }
}

export function connectorInstanceWriteCoordinatorStatsForTests() {
  return {
    activeOwnerships: activeOwnerships.size,
    activeWriters,
    keyedEntries: keyedGates.size,
    queuedWriters: admissionWaiters.length,
  };
}
