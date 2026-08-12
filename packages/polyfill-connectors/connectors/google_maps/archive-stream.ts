// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Bounded streaming reader for owner-provided Google Maps Timeline JSON.
// The upload validator uses the same parser shape, but the local collector
// also needs each normalized source element. Keeping that element stream here
// prevents the collector from holding both the raw artifact and a parsed
// object graph in memory at once.

import { createReadStream } from "node:fs";
import { JSONParser, TokenType } from "@streamparser/json";
import type { GoogleMapsSourceFormat } from "./types.ts";

const READ_BUFFER_SIZE = 65_536;
const DEFAULT_MAX_SINGLE_ELEMENT_BYTES = 4 * 1024 * 1024;
const FIRST_JSON_VALUE_RE = /[^\u0020\t\r\n\uFEFF]/u;
const ROOT_ARRAY_PATHS = ["$.*"];
const WRAPPED_ARRAY_ELEMENT_PATHS = ["$.locations.*", "$.semanticSegments.*", "$.timelineObjects.*"];

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

export class GoogleMapsUnsupportedShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleMapsUnsupportedShapeError";
  }
}

function formatForShapeKey(key: string): GoogleMapsSourceFormat | null {
  return (GOOGLE_MAPS_SHAPE_KEY_TO_FORMAT as Readonly<Record<string, GoogleMapsSourceFormat | undefined>>)[key] ?? null;
}

type ShapeFrame =
  | {
      kind: "object";
      pendingKey: string | undefined;
      state: "comma_or_end" | "colon" | "key_or_end" | "value";
    }
  | {
      confirmedFormat: GoogleMapsSourceFormat | undefined;
      kind: "array";
      state: "comma_or_end" | "value_or_end";
    };

/**
 * Tracks only the root object's property/value boundary. The JSON parser's
 * `paths` option cannot both select wrapped array elements and observe a
 * non-array value at the same property without retaining that whole value.
 * Token observation supplies the missing shape proof while retaining no
 * source data of its own.
 */
class RootShapeTracker {
  private readonly stack: ShapeFrame[] = [];
  private readonly onArrayConfirmed: (format: GoogleMapsSourceFormat) => void;
  private rootStarted = false;
  private invalidRecognizedKey: string | null = null;

  constructor(onArrayConfirmed: (format: GoogleMapsSourceFormat) => void) {
    this.onArrayConfirmed = onArrayConfirmed;
  }

  get invalidKey(): string | null {
    return this.invalidRecognizedKey;
  }

  /**
   * True while the parser is positioned inside an element of a confirmed
   * (recognized-shape) array -- i.e. an actual supported Timeline element is
   * being read, not the array's own brackets or an unrelated sibling field.
   * A confirmed array frame only reports "inside an element" once its first
   * value token has opened (`comma_or_end`), never while still awaiting that
   * first value (`value_or_end`) -- otherwise the still-empty gap between
   * `[` and the first element's opening token would wrongly count.
   */
  get insideConfirmedArrayElement(): boolean {
    return this.stack.some(
      (frame, index) =>
        frame.kind === "array" &&
        frame.confirmedFormat !== undefined &&
        (index < this.stack.length - 1 || frame.state === "comma_or_end")
    );
  }

  onToken(token: TokenType, value: unknown): void {
    if (token === TokenType.SEPARATOR) {
      return;
    }
    const frame = this.stack.at(-1);
    if (!frame) {
      this.startRoot(token);
      return;
    }
    if (frame.kind === "object") {
      this.onObjectToken(frame, token, value);
      return;
    }
    this.onArrayToken(frame, token);
  }

  private startRoot(token: TokenType): void {
    if (this.rootStarted) {
      return;
    }
    this.rootStarted = true;
    if (token === TokenType.LEFT_BRACE) {
      this.stack.push({ kind: "object", pendingKey: undefined, state: "key_or_end" });
      return;
    }
    if (token === TokenType.LEFT_BRACKET) {
      this.stack.push({ kind: "array", state: "value_or_end", confirmedFormat: "timeline_objects" });
    }
  }

  private onObjectToken(frame: Extract<ShapeFrame, { kind: "object" }>, token: TokenType, value: unknown): void {
    if (frame.state === "key_or_end") {
      if (token === TokenType.STRING && typeof value === "string") {
        frame.pendingKey = value;
        frame.state = "colon";
      } else if (token === TokenType.RIGHT_BRACE) {
        this.finishContainer();
      }
      return;
    }
    if (frame.state === "colon") {
      if (token === TokenType.COLON) {
        frame.state = "value";
      }
      return;
    }
    if (frame.state === "value") {
      this.startObjectValue(frame, token);
      return;
    }
    if (token === TokenType.COMMA) {
      frame.state = "key_or_end";
    } else if (token === TokenType.RIGHT_BRACE) {
      this.finishContainer();
    }
  }

  private startObjectValue(frame: Extract<ShapeFrame, { kind: "object" }>, token: TokenType): void {
    const key = frame.pendingKey;
    const format = this.stack.length === 1 && key ? formatForShapeKey(key) : null;
    frame.pendingKey = undefined;
    frame.state = "comma_or_end";

    if (format && token !== TokenType.LEFT_BRACKET) {
      this.invalidRecognizedKey ??= key ?? "(unknown)";
    }
    if (token === TokenType.LEFT_BRACE) {
      this.stack.push({ kind: "object", pendingKey: undefined, state: "key_or_end" });
      return;
    }
    if (token === TokenType.LEFT_BRACKET) {
      this.stack.push({ kind: "array", state: "value_or_end", confirmedFormat: format ?? undefined });
    }
  }

  private onArrayToken(frame: Extract<ShapeFrame, { kind: "array" }>, token: TokenType): void {
    if (frame.state === "value_or_end") {
      if (token === TokenType.RIGHT_BRACKET) {
        this.finishContainer();
        return;
      }
      frame.state = "comma_or_end";
      if (token === TokenType.LEFT_BRACE) {
        this.stack.push({ kind: "object", pendingKey: undefined, state: "key_or_end" });
      } else if (token === TokenType.LEFT_BRACKET) {
        this.stack.push({ kind: "array", state: "value_or_end", confirmedFormat: undefined });
      }
      return;
    }
    if (token === TokenType.COMMA) {
      frame.state = "value_or_end";
    } else if (token === TokenType.RIGHT_BRACKET) {
      this.finishContainer();
    }
  }

  private finishContainer(): void {
    const frame = this.stack.pop();
    if (frame?.kind === "array" && frame.confirmedFormat) {
      this.onArrayConfirmed(frame.confirmedFormat);
    }
  }
}

function formatForElementEvent(
  key: StreamStackKey,
  stack: readonly { readonly key: StreamStackKey }[],
  parent: unknown
): GoogleMapsSourceFormat | null {
  if (!Array.isArray(parent)) {
    return null;
  }
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

function createParser(
  paths: string[],
  shapeTracker: RootShapeTracker,
  onElement: (format: GoogleMapsSourceFormat, value: unknown) => void
): JSONParser {
  const parser = new JSONParser({ emitPartialValues: true, keepStack: false, paths });
  parser.onToken = ({ token, value }) => shapeTracker.onToken(token, value);
  parser.onValue = (info) => {
    if (info.partial) {
      return;
    }
    const format = formatForElementEvent(info.key, info.stack, info.parent);
    if (!format || info.value === undefined) {
      return;
    }
    onElement(format, info.value);
  };
  return parser;
}

function initializeParser(
  text: string,
  shapeTracker: RootShapeTracker,
  onElement: (format: GoogleMapsSourceFormat, value: unknown) => void
): { parser: JSONParser; text: string } | null {
  const firstIndex = text.search(FIRST_JSON_VALUE_RE);
  if (firstIndex === -1) {
    return null;
  }
  const paths = text[firstIndex] === "[" ? ROOT_ARRAY_PATHS : WRAPPED_ARRAY_ELEMENT_PATHS;
  return { parser: createParser(paths, shapeTracker, onElement), text: text.slice(firstIndex) };
}

async function feedParserChunk(
  parser: JSONParser,
  text: string,
  maxSingleElementBytes: number,
  bytesSinceElementStart: { value: number },
  shapeTracker: RootShapeTracker,
  pending: GoogleMapsStreamEvent[],
  onEvent: GoogleMapsStreamEventHandler
): Promise<void> {
  if (parser.isEnded) {
    // Keep feeding later chunks so the tokenizer can reject trailing
    // non-whitespace instead of silently stopping at the first root.
    parser.write(text);
    return;
  }
  // Only bytes read while actually inside a supported array's element count
  // toward the per-element bound. An unrelated/unselected trailing root
  // field (or any byte outside a confirmed array's element) cannot inflate
  // this counter, however large it is -- the bound protects against one
  // oversized SUPPORTED element, not against whatever else shares the root.
  if (shapeTracker.insideConfirmedArrayElement) {
    bytesSinceElementStart.value += Buffer.byteLength(text, "utf8");
    if (bytesSinceElementStart.value > maxSingleElementBytes) {
      throw new GoogleMapsElementTooLargeError(
        `a single Timeline array element exceeded ${String(maxSingleElementBytes)} bytes`
      );
    }
  } else {
    bytesSinceElementStart.value = 0;
  }
  parser.write(text);
  await drain(pending, onEvent);
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
  const pending: GoogleMapsStreamEvent[] = [];
  const seenShapes = new Set<GoogleMapsSourceFormat>();
  const bytesSinceElementStart = { value: 0 };

  const markShape = (format: GoogleMapsSourceFormat): void => {
    if (seenShapes.has(format)) {
      return;
    }
    seenShapes.add(format);
    pending.push({ format, kind: "shape" });
  };

  const shapeTracker = new RootShapeTracker(markShape);
  const onElement = (format: GoogleMapsSourceFormat, value: unknown): void => {
    bytesSinceElementStart.value = 0;
    pending.push({ format, kind: "element", value });
  };
  let parser: JSONParser | null = null;

  const stream = createReadStream(path, { encoding: "utf8", highWaterMark: READ_BUFFER_SIZE });
  try {
    for await (const chunk of stream as AsyncIterable<string | Buffer>) {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let toFeed = text;
      if (!parser) {
        const initialized = initializeParser(text, shapeTracker, onElement);
        if (!initialized) {
          continue;
        }
        ({ parser, text: toFeed } = initialized);
      }
      await feedParserChunk(
        parser,
        toFeed,
        maxSingleElementBytes,
        bytesSinceElementStart,
        shapeTracker,
        pending,
        onEvent
      );
    }
  } finally {
    stream.destroy();
  }

  if (!parser) {
    throw new Error("google_maps: Timeline document is empty or whitespace-only");
  }
  if (!parser.isEnded) {
    parser.end();
    if (!parser.isEnded) {
      throw new Error("google_maps: Timeline document did not close (truncated or malformed)");
    }
  }

  if (shapeTracker.invalidKey) {
    throw new GoogleMapsUnsupportedShapeError(
      `google_maps: recognized Timeline key ${shapeTracker.invalidKey} did not contain an array`
    );
  }
  if (seenShapes.size === 0) {
    throw new GoogleMapsUnsupportedShapeError(
      "google_maps: Timeline document did not contain a recognized Timeline array"
    );
  }
  await drain(pending, onEvent);
}
