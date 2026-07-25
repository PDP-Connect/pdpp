#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

interface Args {
  file: string;
  viewer: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    file: path.join("tmp", "stream-debug", `${todayUtc()}.jsonl`),
    viewer: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--file" && argv[index + 1]) {
      args.file = argv[index + 1] as string;
      index += 1;
    } else if (arg === "--viewer" && argv[index + 1]) {
      args.viewer = argv[index + 1] as string;
      index += 1;
    }
  }
  return args;
}

function increment(map: Map<string, number>, key: unknown, by = 1): void {
  const value = key === undefined || key === null || key === "" ? "unknown" : String(key);
  map.set(value, (map.get(value) ?? 0) + by);
}

function sortedEntries(map: Map<string, number>, limit = 12): [string, number][] {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit);
}

interface TelemetryRecord {
  events?: unknown[];
  receivedAt?: string;
}
type TelemetryEvent = Record<string, unknown> & { type?: unknown; name?: unknown };

function parseJsonl(file: string): TelemetryRecord[] {
  if (!existsSync(file)) {
    throw new Error(`No telemetry file found at ${file}`);
  }
  const records: TelemetryRecord[] = [];
  const lines = readFileSync(file, "utf8").split("\n");
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      records.push(JSON.parse(trimmed));
    } catch (error) {
      throw new Error(`Invalid JSONL at line ${index + 1}: ${(error as Error).message}`, { cause: error });
    }
  }
  return records;
}

function flattenEvents(records: TelemetryRecord[]): TelemetryEvent[] {
  return records.flatMap((record) =>
    Array.isArray(record.events)
      ? record.events.map((event) => ({
          ...(event as TelemetryEvent),
          receivedAt: record.receivedAt,
          type: (event as TelemetryEvent).type ?? (event as TelemetryEvent).name ?? "unknown",
        }))
      : []
  );
}

function latestViewer(events: TelemetryEvent[]): string | null {
  const latestByViewer = new Map<string, number>();
  for (const event of events) {
    const { viewerId } = event;
    if (!viewerId) {
      continue;
    }
    const at = Date.parse(String(event.at ?? event.receivedAt ?? ""));
    const previous = latestByViewer.get(String(viewerId)) ?? 0;
    latestByViewer.set(String(viewerId), Number.isFinite(at) ? Math.max(previous, at) : previous);
  }
  return [...latestByViewer.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

function payload(event: TelemetryEvent): Record<string, unknown> {
  return event.payload && typeof event.payload === "object" ? (event.payload as Record<string, unknown>) : {};
}

interface LastPointer {
  client: unknown;
  eventType: unknown;
  insideMedia: unknown;
  insideOverlay: unknown;
  mapped: unknown;
  screenState: unknown;
}
interface LastKeyboard {
  active: unknown;
  focused: unknown;
  source: unknown;
  type: string;
}
interface LastClipboard {
  lengthBucket: unknown;
  method: unknown;
  phase: unknown;
  reason: unknown;
  type: string;
}

interface Summary {
  clipboardPhases: Map<string, number>;
  connection: Map<string, number>;
  counts: Map<string, number>;
  keyboardPhases: Map<string, number>;
  lastClipboard: LastClipboard | null;
  lastKeyboard: LastKeyboard | null;
  lastPointer: LastPointer | null;
  lastViewport: unknown;
  maxEmptyAreaRatio: number;
  maxStretchRatio: number;
  pointerIssues: Map<string, number>;
  viewportDecisions: Map<string, number>;
  viewportPosts: Map<string, number>;
  visualReasons: Map<string, number>;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this is a debug telemetry classifier — one independent per-event-type branch per signal family (viewport, pointer, keyboard, clipboard, connection), carried over unchanged from the .mjs source.
function summarize(events: TelemetryEvent[]): Summary {
  const counts = new Map<string, number>();
  const visualReasons = new Map<string, number>();
  const viewportDecisions = new Map<string, number>();
  const viewportPosts = new Map<string, number>();
  const pointerIssues = new Map<string, number>();
  const keyboardPhases = new Map<string, number>();
  const clipboardPhases = new Map<string, number>();
  const connection = new Map<string, number>();
  let maxEmptyAreaRatio = 0;
  let maxStretchRatio = 1;
  let lastViewport: unknown = null;
  let lastPointer: LastPointer | null = null;
  let lastKeyboard: LastKeyboard | null = null;
  let lastClipboard: LastClipboard | null = null;

  for (const event of events) {
    const type = String(event.type ?? "unknown");
    const data = payload(event);
    increment(counts, type);

    if (type.includes("visual_quality")) {
      for (const issue of Array.isArray(data.issues) ? data.issues : []) {
        for (const reason of Array.isArray(issue.reasons) ? issue.reasons : []) {
          increment(visualReasons, reason);
        }
      }
      const media = Array.isArray(data.media) ? data.media : [];
      const issues = Array.isArray(data.issues) ? data.issues : [];
      for (const item of [...media, ...issues]) {
        const fit = item?.pixelFit && typeof item.pixelFit === "object" ? item.pixelFit : null;
        const emptyAreaRatio = Number(fit?.emptyAreaRatio);
        const stretchRatio = Number(fit?.stretchRatio);
        if (Number.isFinite(emptyAreaRatio)) {
          maxEmptyAreaRatio = Math.max(maxEmptyAreaRatio, emptyAreaRatio);
        }
        if (Number.isFinite(stretchRatio)) {
          maxStretchRatio = Math.max(maxStretchRatio, stretchRatio);
        }
      }
    }

    if (type === "viewport.decision") {
      increment(viewportDecisions, `${data.action ?? "unknown"}:${data.reason ?? "unknown"}`);
      lastViewport = data.viewport ?? lastViewport;
    } else if (type.startsWith("viewport.post.")) {
      increment(viewportPosts, `${type}:${data.status ?? data.ok ?? "unknown"}`);
      lastViewport = data.viewport ?? lastViewport;
    } else if (
      type.startsWith("viewport.") ||
      type.startsWith("neko.layout") ||
      type.startsWith("neko.client.layout")
    ) {
      lastViewport = data.viewport ?? data.layout ?? lastViewport;
    }

    if (type.includes("pointer") || type.includes("touch_scroll_bridge") || type.startsWith("surface.neko.mouse")) {
      for (const reason of Array.isArray(data.reasons) ? data.reasons : []) {
        increment(pointerIssues, reason);
      }
      if (data.mapped || data.pos || data.client) {
        lastPointer = {
          client: data.client ?? null,
          eventType: data.eventType ?? type,
          insideMedia: data.insideMedia ?? null,
          insideOverlay: data.insideOverlay ?? null,
          mapped: data.mapped ?? data.pos ?? null,
          screenState: data.screenState ?? null,
        };
      }
    }

    if (type.includes("keyboard") || type.endsWith(".focusin") || type.endsWith(".focusout")) {
      increment(keyboardPhases, `${type}:${data.focused ?? data.active ?? data.phase ?? data.reason ?? "event"}`);
      lastKeyboard = { active: data.active ?? null, focused: data.focused ?? null, source: data.source ?? null, type };
    }

    if (type.includes("clipboard")) {
      increment(clipboardPhases, `${type}:${data.phase ?? data.reason ?? data.method ?? "event"}`);
      lastClipboard = {
        lengthBucket: data.lengthBucket ?? null,
        method: data.method ?? null,
        phase: data.phase ?? null,
        reason: data.reason ?? null,
        type,
      };
    }

    if (
      type === "debug.enabled" ||
      type === "neko.client.start" ||
      type.startsWith("neko.status.poll") ||
      type.endsWith(".telemetry.attached")
    ) {
      increment(connection, type);
    }
  }

  return {
    clipboardPhases,
    connection,
    counts,
    keyboardPhases,
    lastClipboard,
    lastKeyboard,
    lastPointer,
    lastViewport,
    maxEmptyAreaRatio,
    maxStretchRatio,
    pointerIssues,
    viewportDecisions,
    viewportPosts,
    visualReasons,
  };
}

function printMap(title: string, map: Map<string, number>, limit: number): void {
  const entries = sortedEntries(map, limit);
  console.log(`${title}: ${entries.length ? entries.map(([key, value]) => `${key}=${value}`).join(", ") : "none"}`);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const records = parseJsonl(args.file);
  const allEvents = flattenEvents(records);
  const viewer = args.viewer ?? latestViewer(allEvents);
  const events = viewer ? allEvents.filter((event) => event.viewerId === viewer) : allEvents;
  const summary = summarize(events);
  const first = events[0]?.at ?? events[0]?.receivedAt ?? "n/a";
  const last = events.at(-1)?.at ?? events.at(-1)?.receivedAt ?? "n/a";

  console.log(`file: ${args.file}`);
  console.log(`viewer: ${viewer ?? "all"}`);
  console.log(`events: ${events.length} (${first} -> ${last})`);
  printMap("top", summary.counts, 16);
  printMap("connection", summary.connection, 12);
  printMap("visual issues", summary.visualReasons, 12);
  console.log(
    `visual maxima: emptyAreaRatio=${summary.maxEmptyAreaRatio.toFixed(4)}, stretchRatio=${summary.maxStretchRatio.toFixed(4)}`
  );
  printMap("viewport decisions", summary.viewportDecisions, 12);
  printMap("viewport posts", summary.viewportPosts, 12);
  console.log(`last viewport: ${JSON.stringify(summary.lastViewport)}`);
  printMap("pointer issues", summary.pointerIssues, 12);
  console.log(`last pointer: ${JSON.stringify(summary.lastPointer)}`);
  printMap("keyboard", summary.keyboardPhases, 16);
  console.log(`last keyboard: ${JSON.stringify(summary.lastKeyboard)}`);
  printMap("clipboard", summary.clipboardPhases, 16);
  console.log(`last clipboard: ${JSON.stringify(summary.lastClipboard)}`);
}

main();
