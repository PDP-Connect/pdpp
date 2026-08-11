// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Bounded streaming reader for owner-provided Google Maps Timeline JSON.
// The upload validator uses the same parser shape, but the local collector
// also needs each normalized source element. Keeping that element stream here
// prevents the collector from holding both the raw artifact and a parsed
// object graph in memory at once.

import { createReadStream } from "node:fs";
import { JSONParser } from "@streamparser/json";
import type { GoogleMapsSourceFormat } from "./types.ts";

const READ_BUFFER_SIZE = 65_536;
const DEFAULT_MAX_SINGLE_ELEMENT_BYTES = 4 * 1024 * 1024;
const FIRST_NON_WHITESPACE_RE = /\S/u;

export const GOOGLE_MAPS_SHAPE_KEYS = ["locations", "semanticSegments", "timelineObjects"] as const;
export const GOOGLE_MAPS_SHAPE_KEY_TO_FORMAT: Readonly<
  Record<(typeof GOOGLE_MAPS_SHAPE_KEYS)[number], GoogleMapsSourceFormat>
> = {
  locations: "legacy_records",
  semanticSegments: "semantic_segments",
  timelineObjects: "timeline_objects",
};

type StreamStackKey = string | number | undefined;

export type GoogleMapsStreamEvent =
  | { readonly format: GoogleMapsSourceFormat; readonly kind: "element"; readonly value: unknown }
  | { readonly format: GoogleMapsSourceFormat; readonly kind: "shape" };

export interface GoogleMapsStreamOptions {
  readonly maxSingleElementBytes?: number;
}

export class GoogleMapsElementTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleMapsElementTooLargeError";
  }
}

function formatForShapeKey(key: string): GoogleMapsSourceFormat | null {
  return (GOOGLE_MAPS_SHAPE_KEY_TO_FORMAT as Readonly<Record<string, GoogleMapsSourceFormat | undefined>>)[key] ?? null;
}

function formatForElementEvent(
  key: StreamStackKey,
  stack: readonly { readonly key: StreamStackKey }[]
): GoogleMapsSourceFormat | null {
  if (stack.length === 1) {
    return typeof key === "number" ? "timeline_objects" : null;
  }
  if (stack.length === 2) {
    const parentKey = stack[1]?.key;
    return typeof parentKey === "string" ? formatForShapeKey(parentKey) : null;
  }
  return null;
}

type GoogleMapsStreamEventHandler = (event: GoogleMapsStreamEvent) => void | Promise<void>;

async function drain(pending: GoogleMapsStreamEvent[], onEvent: GoogleMapsStreamEventHandler): Promise<void> {
  const batch = pending.splice(0);
  for (const event of batch) {
    const result = onEvent(event);
    if (result !== undefined) {
      await result;
    }
  }
}

/**
 * Stream Timeline array elements without materializing the source file.
 * `shape` events preserve the empty-container evidence needed by the upload
 * validator; collector callers only consume `element` events.
 */
export async function streamGoogleMapsExport(
  path: string,
  onEvent: GoogleMapsStreamEventHandler,
  options: GoogleMapsStreamOptions = {}
): Promise<void> {
  const maxSingleElementBytes = options.maxSingleElementBytes ?? DEFAULT_MAX_SINGLE_ELEMENT_BYTES;
  const parser = new JSONParser({
    emitPartialValues: true,
    keepStack: false,
    paths: ["$.*", "$.locations.*", "$.semanticSegments.*", "$.timelineObjects.*"],
  });
  const pending: GoogleMapsStreamEvent[] = [];
  const seenShapes = new Set<GoogleMapsSourceFormat>();
  let firstNonWhitespace: string | null = null;
  let bytesSinceElementStart = 0;

  const markShape = (format: GoogleMapsSourceFormat): void => {
    if (seenShapes.has(format)) {
      return;
    }
    seenShapes.add(format);
    pending.push({ format, kind: "shape" });
  };

  parser.onValue = (info) => {
    if (info.partial) {
      if (info.stack.length === 1 && typeof info.key === "string") {
        const format = formatForShapeKey(info.key);
        if (format) {
          markShape(format);
        }
      }
      return;
    }

    bytesSinceElementStart = 0;
    const format = formatForElementEvent(info.key, info.stack);
    if (!format || info.value === undefined) {
      return;
    }
    markShape(format);
    pending.push({ format, kind: "element", value: info.value });
  };

  const stream = createReadStream(path, { encoding: "utf8", highWaterMark: READ_BUFFER_SIZE });
  try {
    for await (const chunk of stream as AsyncIterable<string | Buffer>) {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (firstNonWhitespace === null) {
        const first = text.match(FIRST_NON_WHITESPACE_RE)?.[0];
        if (first) {
          firstNonWhitespace = first;
        }
      }
      if (parser.isEnded) {
        // Keep feeding later chunks so the tokenizer can reject trailing
        // non-whitespace instead of silently stopping at the first root.
        parser.write(text);
        continue;
      }
      bytesSinceElementStart += Buffer.byteLength(text, "utf8");
      if (bytesSinceElementStart > maxSingleElementBytes) {
        throw new GoogleMapsElementTooLargeError(
          `a single Timeline array element exceeded ${String(maxSingleElementBytes)} bytes`
        );
      }
      parser.write(text);
      await drain(pending, onEvent);
    }
  } finally {
    stream.destroy();
  }

  if (!parser.isEnded) {
    parser.end();
    if (!parser.isEnded) {
      throw new Error("google_maps: Timeline document did not close (truncated or malformed)");
    }
  }

  if (firstNonWhitespace === "[") {
    markShape("timeline_objects");
  }
  await drain(pending, onEvent);
}
