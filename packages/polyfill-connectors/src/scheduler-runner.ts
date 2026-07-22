// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Polyfill scheduler runner.
 *
 * Wraps reference-implementation/runtime/scheduler.js with:
 *   - ntfy notifications on INTERACTION and on run failures
 *   - inbox integration (INTERACTION → parkInteraction → wait)
 *   - per-connector interval + jitter
 *   - persistent sync state via RS /v1/state/{connector_id}
 *   - persistent scheduler history and last-run interval gates
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type InboxItemNotice, notifyInboxItem, notifyOvernightSummary } from "./ntfy.ts";
import { getConnectorPaths, issueOwnerToken, readManifest, registerManifest } from "./orchestrator.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..", "..", "..", "reference-implementation");

const DEFAULT_INTERVALS: Record<string, number> = {
  ynab: 4 * 60 * 60 * 1000, // 4h
  gmail: 30 * 60 * 1000, // 30m
  chatgpt: 6 * 60 * 60 * 1000, // 6h
  usaa: 4 * 60 * 60 * 1000, // 4h
  amazon: 12 * 60 * 60 * 1000, // 12h
};

function jitter(ms: number): number {
  const pct = 0.25; // ±25%
  const delta = (Math.random() * 2 - 1) * ms * pct;
  return Math.max(1000, Math.round(ms + delta));
}

export interface InteractionMessageShape {
  connectorId?: string;
  kind: string;
  message?: string;
  [extra: string]: unknown;
}

export interface InboxHandler {
  park: (msg: InteractionMessageShape) => Promise<string>;
  waitFor: (itemId: string) => Promise<unknown>;
}

export interface StartPolyfillSchedulerOptions {
  asUrl: string;
  connectors: readonly string[];
  inboxHandler: InboxHandler;
  nightlySummary?: false | NightlySummaryOptions;
  rsUrl: string;
  schedulerStore?: false | SchedulerPersistenceStore;
  subjectId?: string;
}

interface SchedulerRunRecord {
  connectorId: string;
  recordsEmitted: number;
  status: string;
}

interface SchedulerStats {
  lastRun?: { error?: string; status?: string };
  succeeded: number;
  totalRecords: number;
  totalRuns: number;
}

interface Scheduler {
  getStats: () => Record<string, SchedulerStats>;
  start: () => void;
  stop: () => void;
}

export interface SchedulerPersistenceStore {
  appendRunHistory: (record: unknown) => Promise<void> | void;
  listLastRunTimes: () => Promise<readonly unknown[]> | readonly unknown[];
  listRunHistory: (limit: number) => Promise<readonly unknown[]> | readonly unknown[];
  upsertLastRunTime: (connectorId: string, lastRunTimeMs: number, updatedAt: string) => Promise<void> | void;
}

interface CreateSchedulerArgs {
  connectors: Record<string, unknown>[];
  getState: (connectorId: string) => Promise<Record<string, unknown> | null>;
  onInteraction: (msg: InteractionMessageShape) => Promise<unknown>;
  onRunComplete: (record: SchedulerRunRecord) => void;
  rsUrl: string;
  schedulerStore?: SchedulerPersistenceStore;
  setState: () => Promise<void>;
}

export interface SchedulerSummary {
  counts: Record<string, string>;
  failures: string[];
  ok: boolean;
}

export interface PolyfillSchedulerHandle {
  notifySummary(): Promise<SchedulerSummary>;
  scheduler: Scheduler;
  stop: () => void;
  summarize(): Promise<SchedulerSummary>;
}

type SummaryNotifier = (summary: SchedulerSummary) => Promise<unknown>;

interface TimerLike {
  unref?: () => void;
}

export interface NightlySummarySchedule {
  stop: () => void;
}

export interface NightlySummaryOptions {
  clearTimeout?: (timer: TimerLike) => void;
  hour?: number;
  minute?: number;
  notify?: SummaryNotifier;
  now?: () => Date;
  setTimeout?: (callback: () => void, delayMs: number) => TimerLike;
}

export function millisecondsUntilNextNightlySummary(now: Date, hour = 7, minute = 0): number {
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - now.getTime();
}

export async function notifyOvernightSummarySafely(
  summary: SchedulerSummary,
  notify: SummaryNotifier = notifyOvernightSummary
): Promise<void> {
  try {
    await notify(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[scheduler] failed to send overnight summary: ${message}`);
  }
}

export function scheduleNightlySummary(
  handle: Pick<PolyfillSchedulerHandle, "summarize">,
  {
    hour = 7,
    minute = 0,
    now = () => new Date(),
    notify = notifyOvernightSummary,
    setTimeout: setTimer = setTimeout,
    clearTimeout: clearTimer = (pendingTimer) => {
      clearTimeout(pendingTimer as ReturnType<typeof setTimeout>);
    },
  }: NightlySummaryOptions = {}
): NightlySummarySchedule {
  let stopped = false;
  let timer: TimerLike | undefined;

  const scheduleNext = (): void => {
    if (stopped) {
      return;
    }
    const delayMs = millisecondsUntilNextNightlySummary(now(), hour, minute);
    timer = setTimer(() => {
      Promise.resolve()
        .then(async () => {
          const summary = await handle.summarize();
          await notifyOvernightSummarySafely(summary, notify);
          scheduleNext();
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[scheduler] failed to build overnight summary: ${message}`);
          scheduleNext();
        });
    }, delayMs);
    timer.unref?.();
  };

  scheduleNext();

  return {
    stop: (): void => {
      stopped = true;
      if (timer) {
        clearTimer(timer);
      }
    },
  };
}

export async function loadDefaultSchedulerPersistenceStore(): Promise<SchedulerPersistenceStore> {
  const { initPostgresStorage, resolveStorageBackend } = (await import(
    join(REFERENCE_IMPL_DIR, "server/postgres-storage.js")
  )) as {
    initPostgresStorage: (config: unknown) => Promise<unknown>;
    resolveStorageBackend: () => unknown;
  };
  await initPostgresStorage(resolveStorageBackend());

  const { getDefaultSchedulerStore } = (await import(join(REFERENCE_IMPL_DIR, "server/stores/scheduler-store.js"))) as {
    getDefaultSchedulerStore: () => SchedulerPersistenceStore;
  };
  return getDefaultSchedulerStore();
}

export function resolveSchedulerPersistenceStore(
  schedulerStore: false | SchedulerPersistenceStore | undefined,
  loadDefaultStore: () => Promise<SchedulerPersistenceStore> = loadDefaultSchedulerPersistenceStore
): Promise<SchedulerPersistenceStore | null> {
  if (schedulerStore === false) {
    return Promise.resolve(null);
  }
  if (schedulerStore) {
    return Promise.resolve(schedulerStore);
  }
  return loadDefaultStore();
}

export async function startPolyfillScheduler({
  asUrl,
  rsUrl,
  connectors,
  subjectId = "owner_local",
  inboxHandler,
  nightlySummary,
  schedulerStore: schedulerStoreOption,
}: StartPolyfillSchedulerOptions): Promise<PolyfillSchedulerHandle> {
  const { createScheduler } = (await import(join(REFERENCE_IMPL_DIR, "runtime/scheduler.js"))) as {
    createScheduler: (args: CreateSchedulerArgs) => Scheduler;
  };
  const { loadSyncState } = (await import(join(REFERENCE_IMPL_DIR, "runtime/index.js"))) as {
    loadSyncState: (args: {
      connectorId: string;
      ownerToken: string;
      rsUrl: string;
    }) => Promise<Record<string, unknown> | null>;
  };
  const schedulerStore = await resolveSchedulerPersistenceStore(schedulerStoreOption);

  // Register all requested manifests first
  const schedules: Record<string, unknown>[] = [];
  const ownerToken = await issueOwnerToken(asUrl, subjectId);
  for (const name of connectors) {
    const manifest = readManifest(name);
    const { connectorPath } = getConnectorPaths(name);
    try {
      await registerManifest(asUrl, manifest);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] failed to register ${name}: ${message}`);
      continue;
    }
    schedules.push({
      connectorId: manifest.connector_id,
      connectorPath,
      manifest,
      ownerToken,
      intervalMs: jitter(DEFAULT_INTERVALS[name] || 60 * 60 * 1000),
      maxRetries: 2,
      grantAccessMode: "continuous",
    });
  }

  const schedulerArgs: CreateSchedulerArgs = {
    connectors: schedules,
    rsUrl,
    onInteraction: async (msg) => {
      // Forward to inbox (parks until responded or timeout). The inboxHandler
      // is expected to return an INTERACTION_RESPONSE-shaped object.
      const itemId = await inboxHandler.park(msg);
      // Build the notice without setting `message: undefined`. Under
      // exactOptionalPropertyTypes, `{ message: undefined }` ≠ `{}`; we want
      // the key to be absent when there's no message.
      const notice: InboxItemNotice =
        msg.message === undefined
          ? { kind: msg.kind, connector_id: msg.connectorId || "unknown" }
          : {
              kind: msg.kind,
              connector_id: msg.connectorId || "unknown",
              message: msg.message,
            };
      await notifyInboxItem(notice);
      return inboxHandler.waitFor(itemId);
    },
    onRunComplete: (record) => {
      console.error(
        `[scheduler] run ${record.connectorId} status=${record.status} records=${String(record.recordsEmitted)}`
      );
    },
    getState: async (connectorId) => {
      try {
        return await loadSyncState({ connectorId, ownerToken, rsUrl });
      } catch {
        return null;
      }
    },
    setState: async (): Promise<void> => {
      // Scheduler-side no-op: runConnector with persistState=true already
      // handles state via /v1/state/{connector_id}. This hook is retained for
      // symmetry but isn't needed.
    },
  };
  if (schedulerStore) {
    schedulerArgs.schedulerStore = schedulerStore;
  }

  const scheduler = createScheduler(schedulerArgs);

  scheduler.start();
  let nightlySummarySchedule: NightlySummarySchedule | undefined;
  const handle: PolyfillSchedulerHandle = {
    scheduler,
    stop: (): void => {
      nightlySummarySchedule?.stop();
      scheduler.stop();
    },
    summarize(): Promise<SchedulerSummary> {
      const stats = scheduler.getStats();
      const counts: Record<string, string> = {};
      const failures: string[] = [];
      for (const [cid, s] of Object.entries(stats)) {
        counts[cid] = `${String(s.succeeded)}/${String(s.totalRuns)} succeeded, ${String(s.totalRecords)} records`;
        if (s.lastRun?.status === "failed") {
          failures.push(`${cid}: ${s.lastRun.error || "unknown"}`);
        }
      }
      return Promise.resolve({
        counts,
        failures,
        ok: failures.length === 0,
      });
    },
    async notifySummary(): Promise<SchedulerSummary> {
      const sum = await this.summarize();
      await notifyOvernightSummarySafely(sum);
      return sum;
    },
  };
  if (nightlySummary !== false) {
    nightlySummarySchedule = scheduleNightlySummary(handle, nightlySummary);
  }
  return handle;
}
