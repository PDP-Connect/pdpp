import { createHash } from "node:crypto";
import { getPostgresLockPool, getPostgresLockPoolCapacity, isPostgresStorageBackend } from "./postgres-storage.js";

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
  query(sql: string, params: readonly unknown[]): Promise<{ rows: Array<{ acquired?: boolean; unlocked?: boolean }> }>;
  release(error?: boolean): void;
}

interface ManagedPostgresLockClient {
  readonly client: PostgresLockClient;
  dispose(poison: boolean): void;
}

interface PostgresLockPool {
  connect(): Promise<PostgresLockClient>;
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
    | ((stage: "before_key_acquire" | "after_acquire", context: { connectorInstanceId: string }) => Promise<void> | void)
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
    waiter = { resolve, reject, timer };
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
      const attempt = await boundedQuery<{ rows: Array<{ acquired?: boolean }> }>(
        managed,
        "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
        [key]
      );
      if (attempt.rows[0]?.acquired) {
        return { managed, key };
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

  await acquireAdmission();
  let releaseKey: (() => void) | null = null;
  let postgresLock: Awaited<ReturnType<typeof acquirePostgresAdvisoryLock>> | null = null;
  let nextOwnership: ConnectorInstanceWriteOwnership | null = null;
  try {
    if (writePhaseHookForTest) {
      await writePhaseHookForTest("before_key_acquire", { connectorInstanceId });
    }
    releaseKey = await acquireKey(connectorInstanceId);
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
    releaseKey?.();
    releaseAdmission();
  }
}

export function connectorInstanceWriteCoordinatorStatsForTests() {
  return {
    activeWriters,
    activeOwnerships: activeOwnerships.size,
    keyedEntries: keyedGates.size,
    queuedWriters: admissionWaiters.length,
  };
}
