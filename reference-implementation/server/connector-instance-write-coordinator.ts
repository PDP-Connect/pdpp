// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { getPostgresLockPool, getPostgresLockPoolCapacity, isPostgresStorageBackend } from "./postgres-storage.ts";

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

interface PostgresLockClient {
  query: (
    sql: string,
    params: readonly unknown[]
  ) => Promise<{ rows: Array<{ acquired?: boolean; unlocked?: boolean }> }>;
  release: (error?: boolean) => void;
}

interface ManagedPostgresLockClient {
  readonly client: PostgresLockClient;
  dispose: (poison: boolean) => void;
}

interface PostgresLockPool {
  connect: () => Promise<PostgresLockClient>;
}

interface KeyedGate {
  held: boolean;
  readonly waiters: Waiter[];
}

let activeWriters = 0;
const admissionWaiters: Waiter[] = [];
const keyedGates = new Map<string, KeyedGate>();
const activeOwnerships = new Map<symbol, string>();
let advisoryLifecycleFaultHook: ((stage: "before_unlock") => void) | null = null;
let postgresLockPoolForTest: { pool: PostgresLockPool; capacity: number } | null = null;
let writePhaseHookForTest:
  | ((stage: "before_key_acquire" | "after_acquire", context: { connectorInstanceId: string }) => Promise<void> | void)
  | null = null;

export function __setConnectorInstanceAdvisoryLifecycleFaultHookForTest(
  hook: ((stage: "before_unlock") => void) | null
): void {
  advisoryLifecycleFaultHook = hook;
}

/** A narrow seam for deterministic lifecycle tests; production always uses the dedicated pool. */
export function __setConnectorInstancePostgresLockPoolForTest(
  override: { pool: PostgresLockPool; capacity: number } | null
): void {
  postgresLockPoolForTest = override;
}

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
  const configured = configuredPositiveInteger("PDPP_INGEST_ACTIVE_BATCH_LIMIT", DEFAULT_ACTIVE_LIMIT);
  return postgresCoordinationEnabled()
    ? Math.min(configured, postgresLockPoolForTest?.capacity ?? getPostgresLockPoolCapacity())
    : configured;
}

function postgresCoordinationEnabled(): boolean {
  return postgresLockPoolForTest !== null || isPostgresStorageBackend();
}

function queueLimit(): number {
  return configuredPositiveInteger("PDPP_INGEST_ADMISSION_QUEUE_LIMIT", DEFAULT_QUEUE_LIMIT);
}

function lockWaitMs(): number {
  return configuredPositiveInteger("PDPP_INGEST_LOCK_WAIT_MS", DEFAULT_LOCK_WAIT_MS);
}

function queryWaitMs(): number {
  return configuredPositiveInteger("PDPP_INGEST_LOCK_QUERY_WAIT_MS", 1000);
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
    }, lockWaitMs());
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

function advisoryKey(connectorInstanceId: string): string {
  const bytes = createHash("sha256")
    .update("pdpp:connector-instance-write:v1:\u0000")
    .update(connectorInstanceId)
    .digest();
  return bytes.readBigInt64BE(0).toString();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function manageClient(client: PostgresLockClient): ManagedPostgresLockClient {
  let disposed = false;
  return {
    client,
    dispose(poison: boolean) {
      if (disposed) {
        return;
      }
      disposed = true;
      try {
        client.release(poison);
      } catch {
        // The session is already unusable from this coordinator's perspective.
      }
    },
  };
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number, onLateResult: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new ConnectorInstanceAdmissionError());
    }, timeoutMs);
    promise.then(
      (value) => {
        if (settled) {
          onLateResult(value);
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function boundedConnect(): Promise<ManagedPostgresLockClient> {
  const pool = postgresLockPoolForTest?.pool ?? getPostgresLockPool();
  const client = await withDeadline(pool.connect() as Promise<PostgresLockClient>, lockWaitMs(), (lateClient) =>
    manageClient(lateClient).dispose(true)
  );
  return manageClient(client);
}

async function boundedQuery<T>(
  managed: ManagedPostgresLockClient,
  sql: string,
  params: readonly unknown[]
): Promise<T> {
  try {
    return await withDeadline(managed.client.query(sql, params) as Promise<T>, queryWaitMs(), () =>
      managed.dispose(true)
    );
  } catch (error) {
    managed.dispose(true);
    throw error;
  }
}

async function acquirePostgresAdvisoryLock(connectorInstanceId: string) {
  const managed = await boundedConnect();
  const key = advisoryKey(connectorInstanceId);
  const deadline = performance.now() + lockWaitMs();
  try {
    while (performance.now() < deadline) {
      // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
      const attempt = await boundedQuery<{ rows: Array<{ acquired?: boolean }> }>(
        managed,
        "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
        [key]
      );
      if (attempt.rows[0]?.acquired) {
        return { key, managed };
      }
      await delay(25);
    }
    throw new ConnectorInstanceAdmissionError();
  } catch (error) {
    managed.dispose(true);
    throw error;
  }
}

async function releasePostgresAdvisoryLock(lock: { managed: ManagedPostgresLockClient; key: string }): Promise<void> {
  try {
    advisoryLifecycleFaultHook?.("before_unlock");
    const result = await boundedQuery<{ rows: Array<{ unlocked?: boolean }> }>(
      lock.managed,
      "SELECT pg_advisory_unlock($1::bigint) AS unlocked",
      [lock.key]
    );
    if (!result.rows[0]?.unlocked) {
      throw new Error("Postgres advisory unlock did not release a held lock");
    }
    lock.managed.dispose(false);
  } catch {
    lock.managed.dispose(true);
  }
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
 * Serializes one authoritative-plus-derived writer scope per connector instance.
 * Re-entry requires the exact still-live module-issued ownership capability.
 *
 * Acquisition order is key-then-admission, not admission-then-key: the
 * per-instance keyed gate (`acquireKey`) is a free, in-process Map lookup,
 * while the global admission gate (`acquireAdmission`) bounds genuinely
 * concurrent ACTIVE work (and, under Postgres coordination, the lock-pool's
 * connection capacity — see `activeLimit()`). Acquiring admission first
 * meant a caller merely queued behind a hot connector instance's key still
 * consumed one of the (default 4) global admission slots while doing zero
 * useful work, so `activeLimit()`-many same-key waiters could saturate
 * admission for every OTHER connector instance's writers too — observed in
 * production as UAT :3012's GroupMe blob-upload 503s (run_1786339135735_1):
 * sustained record-ingest/reconcile traffic on one hot connector instance
 * starved that SAME instance's own blob writes at the global admission gate,
 * not the per-key FIFO. Acquiring the key first means a caller only takes an
 * admission slot once it actually holds the resource it needs, matching
 * `withConnectorInstanceControlPlaneWrite`'s existing key-only design (see
 * its docstring: "allowing enrollment to proceed when unrelated bulk ingest
 * has saturated the bounded data-plane admission gate").
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
  let postgresLock: Awaited<ReturnType<typeof acquirePostgresAdvisoryLock>> | null = null;
  let nextOwnership: ConnectorInstanceWriteOwnership | null = null;
  try {
    if (writePhaseHookForTest) {
      await writePhaseHookForTest("before_key_acquire", { connectorInstanceId });
    }
    releaseKey = await acquireKey(connectorInstanceId);
    await acquireAdmission();
    admitted = true;
    if (postgresCoordinationEnabled()) {
      postgresLock = await acquirePostgresAdvisoryLock(connectorInstanceId);
    }
    nextOwnership = createOwnership(connectorInstanceId);
    if (writePhaseHookForTest) {
      await writePhaseHookForTest("after_acquire", { connectorInstanceId });
    }
    return await operation(nextOwnership);
  } finally {
    if (nextOwnership) {
      activeOwnerships.delete(nextOwnership.token);
    }
    if (postgresLock) {
      await releasePostgresAdvisoryLock(postgresLock);
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
  let postgresLock: Awaited<ReturnType<typeof acquirePostgresAdvisoryLock>> | null = null;
  try {
    releaseKey = await acquireKey(connectorInstanceId);
    if (postgresCoordinationEnabled()) {
      postgresLock = await acquirePostgresAdvisoryLock(connectorInstanceId);
    }
    return await operation();
  } finally {
    if (postgresLock) {
      await releasePostgresAdvisoryLock(postgresLock);
    }
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
