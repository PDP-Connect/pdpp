#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Page } from "playwright";
import { manualAction } from "../../src/browser-handoff.ts";
import {
  type BrowserCollectContext,
  type EmittedMessage,
  type InteractionRequest,
  type InteractionResponse,
  type RecordData,
  runConnector,
} from "../../src/connector-runtime.ts";
import { isMainModule } from "../../src/is-main-module.ts";
import {
  bodyRecord,
  cycleRecord,
  parseBootstrapResponse,
  parseCyclesResponse,
  profileRecord,
  recoveryRecord,
  sleepRecords,
  workoutRecords,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type { WhoopBootstrap, WhoopCycleRecord, WhoopFetchResult } from "./types.ts";

const API_BASE = "https://api.prod.whoop.com";
const APP_URL = "https://app.whoop.com";
const BOOTSTRAP_PATH = "/users-service/v2/bootstrap?apiVersion=7";
const HISTORY_FALLBACK = "2015-09-01T00:00:00.000Z";
const WINDOW_DAYS = 200;
const OVERLAP_DAYS = 7;
const MAX_WINDOWS = 40;
const DAY_MS = 86_400_000;
const AGGREGATE_STREAMS = ["cycles", "recoveries", "sleeps", "workouts"] as const;

export type WhoopFetch = (path: string) => Promise<WhoopFetchResult>;

interface CollectWhoopArgs {
  emit: (message: EmittedMessage) => Promise<void>;
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  fetchPath: WhoopFetch;
  now: Date;
  requested: ReadonlySet<string>;
  state: Record<string, unknown>;
}

function decodeJsonResponse(status: number, text: string): WhoopFetchResult {
  try {
    return { status, json: JSON.parse(text) as unknown };
  } catch {
    return { status, json: null, invalidJson: true };
  }
}

export function makeWhoopPageFetch(page: Page): WhoopFetch {
  return async (path: string): Promise<WhoopFetchResult> => {
    const result = await page.evaluate(
      async ({ apiBase, requestPath }): Promise<{ invalidJson?: boolean; json: unknown; status: number }> => {
        let token: string | null = null;
        try {
          const cookiePrefix = "whoop-auth-token=";
          const authCookie = document.cookie
            .split(";")
            .map((cookie) => cookie.trim())
            .find((cookie) => cookie.startsWith(cookiePrefix));
          const cookieToken = authCookie?.slice(cookiePrefix.length);
          const tokenKey = cookieToken
            ? undefined
            : Object.keys(localStorage).find(
                (key) => key.startsWith("CognitoIdentityServiceProvider.") && key.endsWith(".accessToken")
              );
          token = cookieToken ?? (tokenKey ? localStorage.getItem(tokenKey) : null);
        } catch {
          return { status: 401, json: null };
        }
        if (!token) {
          return { status: 401, json: null };
        }
        let response: Response;
        try {
          response = await fetch(`${apiBase}${requestPath}`, {
            credentials: "include",
            headers: { accept: "application/json", authorization: `bearer ${token}` },
          });
        } catch {
          return { status: 0, json: null };
        }
        const text = await response.text();
        try {
          return { status: response.status, json: JSON.parse(text) as unknown };
        } catch {
          return { status: response.status, json: null, invalidJson: true };
        }
      },
      { apiBase: API_BASE, requestPath: path }
    );
    return result;
  };
}

function assertSourceResponse(result: WhoopFetchResult, endpoint: string): unknown {
  if (result.status === 401 || result.status === 403) {
    throw new Error(`whoop_owner_repair_required: ${String(result.status)} on ${endpoint}`);
  }
  if (result.status === 429) {
    throw new Error(`whoop_rate_limited: 429 on ${endpoint}`);
  }
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`whoop_http_${String(result.status)}: ${endpoint}`);
  }
  if (result.invalidJson) {
    throw new Error(`whoop_invalid_json: ${endpoint}`);
  }
  return result.json;
}

export async function fetchBootstrap(fetchPath: WhoopFetch): Promise<WhoopBootstrap> {
  const result = await fetchPath(BOOTSTRAP_PATH);
  return parseBootstrapResponse(assertSourceResponse(result, "bootstrap"));
}

export function whoopAllowsInteractiveAuthRepair(env: NodeJS.ProcessEnv = process.env): boolean {
  const trigger = env.PDPP_RUN_TRIGGER_KIND?.trim();
  return !trigger || trigger === "manual";
}

export async function ensureWhoopSession(args: {
  capture?: Parameters<typeof manualAction>[0]["capture"];
  fetchPath: WhoopFetch;
  interactive: boolean;
  manualLogin?: () => Promise<void>;
  page: Page;
  sendInteraction: (request: InteractionRequest) => Promise<InteractionResponse>;
}): Promise<void> {
  await args.page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch((): undefined => undefined);
  const initial = await args.fetchPath(BOOTSTRAP_PATH);
  if (initial.status >= 200 && initial.status < 300) {
    parseBootstrapResponse(assertSourceResponse(initial, "bootstrap"));
    return;
  }
  if (initial.status !== 401 && initial.status !== 403) {
    assertSourceResponse(initial, "bootstrap");
  }
  if (!args.interactive) {
    throw new Error("whoop_owner_repair_required: unattended refresh cannot open interactive login");
  }
  if (args.manualLogin) {
    await args.manualLogin();
  } else {
    await manualAction(
      {
        ...(args.capture ? { capture: args.capture } : {}),
        page: args.page,
        reason: "login",
        message:
          "Sign in to WHOOP in the secure browser, then respond success. PDPP will verify the session before collecting.",
        timeoutSeconds: 1800,
      },
      args.sendInteraction
    );
  }
  const reprobe = await args.fetchPath(BOOTSTRAP_PATH);
  parseBootstrapResponse(assertSourceResponse(reprobe, "bootstrap-after-owner-login"));
}

function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * DAY_MS);
}

function cursorThrough(state: Record<string, unknown>, stream: string): string | null {
  const streamState = state[stream];
  if (!streamState || typeof streamState !== "object" || Array.isArray(streamState)) {
    return null;
  }
  const through = Reflect.get(streamState, "through");
  return typeof through === "string" && Number.isFinite(Date.parse(through)) ? through : null;
}

function earliestAggregateCursor(state: Record<string, unknown>, requested: ReadonlySet<string>): string | null {
  const values = AGGREGATE_STREAMS.filter((stream) => requested.has(stream))
    .map((stream) => cursorThrough(state, stream))
    .filter((value): value is string => value !== null)
    .sort((left, right) => left.localeCompare(right));
  return values[0] ?? null;
}

function historyStart(bootstrap: WhoopBootstrap, cursor: string | null): Date {
  if (cursor) {
    return addDays(new Date(cursor), -OVERLAP_DAYS);
  }
  // WHOOP does not document account.created_at as an exhaustive-history
  // guarantee, but owner data cannot practically predate account creation.
  const candidate = bootstrap.account.created_at;
  return new Date(candidate && Number.isFinite(Date.parse(candidate)) ? candidate : HISTORY_FALLBACK);
}

function cyclesPath(userId: number, start: Date, end: Date): string {
  const query = new URLSearchParams({
    id: String(userId),
    startTime: start.toISOString(),
    endTime: end.toISOString(),
  });
  return `/core-details-bff/v0/cycles/details?${query.toString()}`;
}

async function emitAggregateRecord(
  record: WhoopCycleRecord,
  requested: ReadonlySet<string>,
  emitRecord: CollectWhoopArgs["emitRecord"]
): Promise<void> {
  if (requested.has("cycles")) {
    await emitRecord("cycles", cycleRecord(record));
  }
  if (requested.has("recoveries")) {
    const recovery = recoveryRecord(record);
    if (recovery) {
      await emitRecord("recoveries", recovery);
    }
  }
  if (requested.has("sleeps")) {
    for (const sleep of sleepRecords(record)) {
      await emitRecord("sleeps", sleep);
    }
  }
  if (requested.has("workouts")) {
    for (const workout of workoutRecords(record)) {
      await emitRecord("workouts", workout);
    }
  }
}

export async function collectWhoop(args: CollectWhoopArgs): Promise<void> {
  const bootstrap = await fetchBootstrap(args.fetchPath);
  if (args.requested.has("profile")) {
    await args.emitRecord("profile", profileRecord(bootstrap));
    await args.emit({ type: "STATE", stream: "profile", cursor: { observed_at: args.now.toISOString() } });
  }
  if (args.requested.has("body")) {
    await args.emitRecord("body", bodyRecord(bootstrap));
    await args.emit({ type: "STATE", stream: "body", cursor: { observed_at: args.now.toISOString() } });
  }

  const requestedAggregates = AGGREGATE_STREAMS.filter((stream) => args.requested.has(stream));
  if (requestedAggregates.length === 0) {
    return;
  }

  let start = historyStart(bootstrap, earliestAggregateCursor(args.state, args.requested));
  let windows = 0;
  while (start < args.now) {
    if (windows >= MAX_WINDOWS) {
      throw new Error("whoop_incomplete_pagination: history exceeded bounded window guard");
    }
    const end = new Date(Math.min(addDays(start, WINDOW_DAYS).getTime(), args.now.getTime()));
    const path = cyclesPath(bootstrap.user.id, start, end);
    const records = parseCyclesResponse(assertSourceResponse(await args.fetchPath(path), "cycles/details"));
    for (const record of records) {
      await emitAggregateRecord(record, args.requested, args.emitRecord);
    }
    start = end;
    windows += 1;
  }

  for (const stream of requestedAggregates) {
    await args.emit({ type: "STATE", stream, cursor: { through: args.now.toISOString() } });
  }
}

// Kept exported for hermetic tests that need to prove invalid JSON without a browser.
export const parseFetchTextForTest = decodeJsonResponse;

if (isMainModule(import.meta.url)) {
  runConnector({
    name: "whoop",
    validateRecord,
    retryablePattern: /ECONN|ETIMEDOUT|timeout|whoop_rate_limited|whoop_http_5\d\d/i,
    browser: { profileName: "whoop" },
    timeRangeField: (stream) => {
      if (stream === "recoveries") {
        return "created_at";
      }
      if (stream === "cycles") {
        return "start_date";
      }
      if (stream === "sleeps" || stream === "workouts") {
        return "start_at";
      }
      return "observed_at";
    },
    async ensureSession({ capture, page, sendInteraction }) {
      const fetchPath = makeWhoopPageFetch(page);
      await ensureWhoopSession({
        ...(capture ? { capture } : {}),
        fetchPath,
        interactive: whoopAllowsInteractiveAuthRepair(),
        page,
        sendInteraction,
      });
    },
    async collect(ctx: BrowserCollectContext): Promise<void> {
      await collectWhoop({
        emit: ctx.emit,
        emitRecord: ctx.emitRecord,
        fetchPath: makeWhoopPageFetch(ctx.page),
        now: new Date(ctx.emittedAt),
        requested: new Set(ctx.requested.keys()),
        state: ctx.state,
      });
    },
  });
}
