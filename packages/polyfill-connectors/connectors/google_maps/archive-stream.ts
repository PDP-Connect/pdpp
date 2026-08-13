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
const SEMANTIC_SEGMENT_PROJECTION_PATHS = [
  "$.semanticSegments.*.startTime",
  "$.semanticSegments.*.startTimestamp",
  "$.semanticSegments.*.endTime",
  "$.semanticSegments.*.endTimestamp",
  "$.semanticSegments.*.duration.startTimestamp",
  "$.semanticSegments.*.duration.startTime",
  "$.semanticSegments.*.duration.endTimestamp",
  "$.semanticSegments.*.duration.endTime",
  "$.semanticSegments.*.visit.topCandidate.placeLocation",
  "$.semanticSegments.*.visit.topCandidate.location",
  "$.semanticSegments.*.visit.topCandidate.placeId",
  "$.semanticSegments.*.visit.topCandidate.placeID",
  "$.semanticSegments.*.visit.topCandidate.semanticType",
  "$.semanticSegments.*.visit.topCandidate.probability",
  "$.semanticSegments.*.visit.topPlace.placeLocation",
  "$.semanticSegments.*.visit.topPlace.location",
  "$.semanticSegments.*.visit.topPlace.placeId",
  "$.semanticSegments.*.visit.topPlace.placeID",
  "$.semanticSegments.*.visit.topPlace.semanticType",
  "$.semanticSegments.*.visit.topPlace.probability",
  "$.semanticSegments.*.placeLocation",
  "$.semanticSegments.*.location",
  "$.semanticSegments.*.placeId",
  "$.semanticSegments.*.placeID",
  "$.semanticSegments.*.semanticType",
  "$.semanticSegments.*.probability",
  "$.semanticSegments.*.activity.topCandidate.type",
  "$.semanticSegments.*.activity.topCandidate.probability",
  "$.semanticSegments.*.activity.topActivity.type",
  "$.semanticSegments.*.activity.activityType",
  "$.semanticSegments.*.activity.probability",
  "$.semanticSegments.*.timelinePath.*",
];
const WRAPPED_ARRAY_ELEMENT_PATHS = ["$.locations.*", ...SEMANTIC_SEGMENT_PROJECTION_PATHS, "$.timelineObjects.*"];

export const GOOGLE_MAPS_SHAPE_KEYS = ["locations", "semanticSegments", "timelineObjects"] as const;
export const GOOGLE_MAPS_SHAPE_KEY_TO_FORMAT: Readonly<
  Record<(typeof GOOGLE_MAPS_SHAPE_KEYS)[number], GoogleMapsSourceFormat>
> = {
  locations: "legacy_records",
  semanticSegments: "semantic_segments",
  timelineObjects: "timeline_objects",
};

type StreamStackKey = string | number | undefined;

type SemanticProjection = Record<string, unknown> & { timelinePath: unknown[] | undefined };
interface SemanticProjectionRun {
  readonly onComplete: (index: number, projection: SemanticProjection, hasPath: boolean) => void;
  readonly onPoint?: (index: number, point: unknown) => void;
}

function semanticProjectionPath(
  stack: readonly { readonly key: StreamStackKey }[],
  key: StreamStackKey
): string[] | null {
  if (stack.length < 3 || stack[1]?.key !== "semanticSegments" || typeof stack[2]?.key !== "number") {
    return null;
  }
  return [...stack.slice(3).map((entry) => String(entry.key)), String(key)];
}

function setProjectionValue(target: SemanticProjection, path: readonly string[], value: unknown): void {
  let cursor: Record<string, unknown> = target;
  for (const part of path.slice(0, -1)) {
    const existing = cursor[part];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  const leaf = path.at(-1);
  if (leaf) {
    cursor[leaf] = value;
  }
}

function cloneProjection(projection: SemanticProjection): SemanticProjection {
  return structuredClone(projection);
}

const SEMANTIC_SEGMENT_KNOWN_KEYS = new Set([
  "startTime",
  "startTimestamp",
  "endTime",
  "endTimestamp",
  "duration",
  "visit",
  "activity",
  "timelinePath",
]);

class SemanticSegmentKeyTracker {
  private readonly stack: Array<{
    kind: "object" | "array";
    pendingKey: string | undefined;
    segmentIndex: number | undefined;
    format: GoogleMapsSourceFormat | undefined;
  }> = [];
  private readonly onUnknownKey: (index: number, key: string) => void;
  private nextSegmentIndex = 0;

  constructor(onUnknownKey: (index: number, key: string) => void) {
    this.onUnknownKey = onUnknownKey;
  }

  onToken(token: TokenType, value: unknown): void {
    if (token === TokenType.STRING) {
      this.handleString(value);
      return;
    }
    if (token === TokenType.LEFT_BRACE || token === TokenType.LEFT_BRACKET) {
      this.handleOpen(token);
      return;
    }
    if (token === TokenType.COMMA) {
      this.handleComma();
      return;
    }
    if (token === TokenType.RIGHT_BRACE || token === TokenType.RIGHT_BRACKET) {
      this.stack.pop();
    }
  }

  private handleString(value: unknown): void {
    const frame = this.stack.at(-1);
    if (frame?.kind !== "object" || frame.pendingKey !== undefined) {
      return;
    }
    const key = typeof value === "string" ? value : undefined;
    frame.pendingKey = key;
    if (
      key &&
      this.stack.length === 3 &&
      this.stack[1]?.format === "semantic_segments" &&
      !SEMANTIC_SEGMENT_KNOWN_KEYS.has(key) &&
      frame.segmentIndex !== undefined
    ) {
      this.onUnknownKey(frame.segmentIndex, key);
    }
  }

  private handleOpen(token: TokenType.LEFT_BRACE | TokenType.LEFT_BRACKET): void {
    const parent = this.stack.at(-1);
    const isSegment =
      token === TokenType.LEFT_BRACE &&
      parent?.kind === "array" &&
      parent.format === "semantic_segments" &&
      parent.segmentIndex === undefined;
    let segmentIndex = parent?.segmentIndex;
    if (isSegment) {
      segmentIndex = this.nextSegmentIndex;
      this.nextSegmentIndex += 1;
    }
    this.stack.push({
      kind: token === TokenType.LEFT_BRACE ? "object" : "array",
      pendingKey: undefined,
      segmentIndex,
      format:
        token === TokenType.LEFT_BRACKET &&
        (parent?.format === "semantic_segments" || parent?.pendingKey === "semanticSegments")
          ? "semantic_segments"
          : undefined,
    });
  }

  private handleComma(): void {
    const frame = this.stack.at(-1);
    if (frame?.kind === "object") {
      frame.pendingKey = undefined;
    } else if (frame?.kind === "array") {
      frame.segmentIndex = undefined;
    }
  }
}

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

type ByteTrackerFrame =
  | {
      kind: "object";
      pendingKey: string | undefined;
      root: boolean;
      state: "comma_or_end" | "colon" | "key_or_end" | "value";
    }
  | {
      activeElement: boolean;
      elementBytes: number;
      excludeFromParentElementBytes: boolean;
      format: GoogleMapsSourceFormat | undefined;
      kind: "array";
      state: "comma_or_end" | "primitive" | "value_or_end";
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

/**
 * Counts selected array-element bytes before the JSON tokenizer sees them.
 * Token callbacks cannot do this for primitive values because the tokenizer
 * buffers a primitive until its closing token. This scanner keeps only JSON
 * structure and the current root key; it never retains an element value.
 */
class ElementByteTracker {
  private readonly stack: ByteTrackerFrame[] = [];
  private mode: "normal" | "primitive" | "string" | "string_escape" = "normal";
  private primitiveIsDirectArrayElement = false;
  private stringIsKey = false;
  private stringRaw = "";
  private readonly maxElementBytes: number;

  constructor(maxElementBytes: number) {
    this.maxElementBytes = maxElementBytes;
  }

  consume(text: string): void {
    for (const char of text) {
      this.consumeChar(char, char.charCodeAt(0) < 0x80 ? 1 : Buffer.byteLength(char, "utf8"));
    }
  }

  private consumeChar(char: string, bytes: number): void {
    if (this.mode === "string" || this.mode === "string_escape") {
      this.consumeStringChar(char, bytes);
      return;
    }
    if (this.mode === "primitive") {
      this.consumePrimitiveChar(char, bytes);
      return;
    }

    this.consumeNormalChar(char, bytes);
  }

  private consumeStringChar(char: string, bytes: number): void {
    this.count(bytes);
    if (this.mode === "string_escape") {
      if (this.stringIsKey) {
        this.stringRaw += char;
      }
      this.mode = "string";
    } else if (char === "\\") {
      if (this.stringIsKey) {
        this.stringRaw += char;
      }
      this.mode = "string_escape";
    } else if (char === '"') {
      this.finishString();
    } else if (this.stringIsKey) {
      this.stringRaw += char;
    }
  }

  private consumePrimitiveChar(char: string, bytes: number): void {
    if (isJsonDelimiter(char)) {
      this.finishPrimitive();
      this.consumeChar(char, bytes);
      return;
    }
    this.count(bytes);
  }

  private consumeNormalChar(char: string, bytes: number): void {
    if (char === '"') {
      const frame = this.stack.at(-1);
      this.stringIsKey = frame?.kind === "object" && frame.root && frame.state === "key_or_end";
      if (!this.stringIsKey) {
        this.beginScalar();
      }
      this.count(bytes);
      this.stringRaw = "";
      this.mode = "string";
      return;
    }
    if (char === "{" || char === "[") {
      this.beginContainer(char === "{" ? "object" : "array");
      this.count(bytes);
      return;
    }
    if (char === "}" || char === "]") {
      this.count(bytes);
      this.finishContainer(char);
      return;
    }
    if (char === ":" || char === ",") {
      this.count(bytes);
      this.transition(char);
      return;
    }
    if (isJsonWhitespace(char)) {
      this.count(bytes);
      return;
    }
    this.beginScalar();
    this.count(bytes);
    this.mode = "primitive";
  }

  private beginContainer(kind: "object" | "array"): void {
    const parent = this.stack.at(-1);
    if (!parent) {
      this.stack.push(
        kind === "object"
          ? { kind, pendingKey: undefined, root: true, state: "key_or_end" }
          : {
              activeElement: false,
              elementBytes: 0,
              excludeFromParentElementBytes: false,
              format: "timeline_objects",
              kind,
              state: "value_or_end",
            }
      );
      return;
    }
    if (parent.kind === "object") {
      if (parent.state !== "value") {
        return;
      }
      const format = parent.root ? (formatForShapeKey(parent.pendingKey ?? "") ?? undefined) : undefined;
      const isTimelinePath = parent.pendingKey === "timelinePath";
      parent.pendingKey = undefined;
      parent.state = "comma_or_end";
      this.stack.push(
        kind === "object"
          ? { kind, pendingKey: undefined, root: false, state: "key_or_end" }
          : {
              activeElement: false,
              elementBytes: 0,
              excludeFromParentElementBytes: isTimelinePath,
              format,
              kind,
              state: "value_or_end",
            }
      );
      return;
    }
    if (parent.state !== "value_or_end") {
      return;
    }
    parent.activeElement = true;
    parent.state = "comma_or_end";
    this.stack.push(
      kind === "object"
        ? { kind, pendingKey: undefined, root: false, state: "key_or_end" }
        : {
            activeElement: false,
            elementBytes: 0,
            excludeFromParentElementBytes: false,
            format: undefined,
            kind,
            state: "value_or_end",
          }
    );
  }

  private beginScalar(): void {
    const frame = this.stack.at(-1);
    if (!frame) {
      return;
    }
    if (frame.kind === "object") {
      if (frame.state === "value") {
        frame.pendingKey = undefined;
        frame.state = "comma_or_end";
      }
      return;
    }
    if (frame.state === "value_or_end") {
      frame.activeElement = true;
      frame.elementBytes = 0;
      frame.state = "primitive";
      this.primitiveIsDirectArrayElement = true;
    }
  }

  private finishString(): void {
    if (this.stringIsKey) {
      const frame = this.stack.at(-1);
      if (frame?.kind === "object" && frame.state === "key_or_end") {
        frame.pendingKey = decodeJsonString(this.stringRaw);
        frame.state = "colon";
      }
    } else {
      this.finishPrimitive();
    }
    this.mode = "normal";
    this.stringIsKey = false;
    this.stringRaw = "";
  }

  private finishPrimitive(): void {
    if (this.primitiveIsDirectArrayElement) {
      const frame = this.stack.at(-1);
      if (frame?.kind === "array" && frame.state === "primitive") {
        frame.activeElement = false;
        frame.state = "comma_or_end";
        frame.elementBytes = 0;
      }
    }
    this.primitiveIsDirectArrayElement = false;
    this.mode = "normal";
  }

  private finishContainer(char: string): void {
    const frame = this.stack.at(-1);
    if (!frame || (char === "}" && frame.kind !== "object") || (char === "]" && frame.kind !== "array")) {
      return;
    }
    this.stack.pop();
    const parent = this.stack.at(-1);
    if (parent?.kind === "array" && parent.activeElement && parent.state === "comma_or_end") {
      parent.activeElement = false;
      parent.elementBytes = 0;
    }
  }

  private transition(char: ":" | ","): void {
    const frame = this.stack.at(-1);
    if (!frame) {
      return;
    }
    if (frame.kind === "object") {
      if (char === ":" && frame.state === "colon") {
        frame.state = "value";
      } else if (char === "," && frame.state === "comma_or_end") {
        frame.state = "key_or_end";
      }
      return;
    }
    if (char === "," && frame.state === "comma_or_end") {
      frame.state = "value_or_end";
      frame.activeElement = false;
    }
  }

  private count(bytes: number): void {
    const pathFrame = this.stack.find(
      (candidate): candidate is Extract<ByteTrackerFrame, { kind: "array" }> =>
        candidate.kind === "array" && candidate.excludeFromParentElementBytes && candidate.activeElement
    );
    if (pathFrame) {
      pathFrame.elementBytes += bytes;
      if (pathFrame.elementBytes > this.maxElementBytes) {
        throw new GoogleMapsElementTooLargeError(
          `a single Timeline path point exceeded ${String(this.maxElementBytes)} bytes`
        );
      }
      return;
    }
    const frame = this.stack.find(
      (candidate): candidate is Extract<ByteTrackerFrame, { kind: "array" }> =>
        candidate.kind === "array" && candidate.format !== undefined && candidate.activeElement
    );
    if (!frame) {
      return;
    }
    // `semanticSegments` entries are provider aggregates. In particular, a
    // single segment can contain an arbitrarily long timelinePath, while the
    // collector turns that path into one bounded point record per location.
    // Applying the per-element guard here rejects the aggregate before that
    // semantic normalization can happen and reports record_too_large on both
    // output streams. The guard remains active for the already-bounded
    // location/timeline-object element shapes.
    if (
      frame.format === "semantic_segments" &&
      this.stack.some((candidate) => candidate.kind === "array" && candidate.excludeFromParentElementBytes)
    ) {
      return;
    }
    frame.elementBytes += bytes;
    if (frame.elementBytes > this.maxElementBytes) {
      throw new GoogleMapsElementTooLargeError(
        `a single Timeline array element exceeded ${String(this.maxElementBytes)} bytes`
      );
    }
  }
}

function isJsonWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\r" || char === "\n";
}

function isJsonDelimiter(char: string): boolean {
  return isJsonWhitespace(char) || char === "," || char === "]" || char === "}";
}

function decodeJsonString(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
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
  paths: readonly string[],
  shapeTracker: RootShapeTracker,
  onElement: (format: GoogleMapsSourceFormat, value: unknown) => void,
  onEnd: () => void,
  semanticRun: SemanticProjectionRun | undefined
): JSONParser {
  const parser = new JSONParser({ emitPartialValues: true, keepStack: false, paths: [...paths] });
  const unknownKeys = new Map<number, Set<string>>();
  const keyTracker = new SemanticSegmentKeyTracker((index, key) => {
    const keys = unknownKeys.get(index) ?? new Set<string>();
    keys.add(key);
    unknownKeys.set(index, keys);
  });
  parser.onToken = ({ token, value }) => {
    shapeTracker.onToken(token, value);
    keyTracker.onToken(token, value);
  };
  let semanticIndex: number | null = null;
  let semanticProjection: SemanticProjection | null = null;
  let semanticHasPath = false;
  const flushSemanticProjection = (): void => {
    if (semanticProjection) {
      const index = semanticIndex;
      if (index !== null) {
        for (const key of unknownKeys.get(index) ?? []) {
          semanticProjection[key] ??= {};
        }
        if (semanticRun) {
          semanticRun.onComplete(index, cloneProjection(semanticProjection), semanticHasPath);
        } else if (!semanticHasPath) {
          onElement("semantic_segments", cloneProjection(semanticProjection));
        }
      }
    }
    if (semanticIndex !== null) {
      unknownKeys.delete(semanticIndex);
    }
    semanticProjection = null;
    semanticIndex = null;
    semanticHasPath = false;
  };
  const handleSemanticValue = (info: {
    readonly key?: StreamStackKey;
    readonly stack: readonly { readonly key: StreamStackKey }[];
    readonly value?: unknown;
  }): boolean => {
    const semanticPath = semanticProjectionPath(info.stack, info.key);
    if (!semanticPath) {
      return false;
    }
    const nextIndex = info.stack[2]?.key;
    if (typeof nextIndex !== "number") {
      return true;
    }
    if (semanticIndex !== null && semanticIndex !== nextIndex) {
      flushSemanticProjection();
    }
    semanticIndex = nextIndex;
    semanticProjection ??= { timelinePath: undefined };
    if (semanticPath.at(-2) === "timelinePath") {
      semanticHasPath = true;
      semanticProjection.timelinePath = [info.value];
      for (const key of unknownKeys.get(nextIndex) ?? []) {
        semanticProjection[key] ??= {};
      }
      semanticRun?.onPoint?.(nextIndex, info.value);
      if (!semanticRun) {
        onElement("semantic_segments", cloneProjection(semanticProjection));
      }
      semanticProjection.timelinePath = undefined;
    } else {
      setProjectionValue(semanticProjection, semanticPath, info.value);
    }
    return true;
  };
  parser.onValue = (info) => {
    if (info.partial) {
      return;
    }
    if (handleSemanticValue(info)) {
      return;
    }
    const format = formatForElementEvent(info.key, info.stack, info.parent);
    if (!format || info.value === undefined) {
      return;
    }
    onElement(format, info.value);
  };
  parser.onEnd = () => {
    flushSemanticProjection();
    onEnd();
  };
  return parser;
}

function initializeParser(
  text: string,
  shapeTracker: RootShapeTracker,
  onElement: (format: GoogleMapsSourceFormat, value: unknown) => void,
  onEnd: () => void,
  semanticRun: SemanticProjectionRun | undefined,
  pathsOverride?: readonly string[]
): { parser: JSONParser; text: string } | null {
  const firstIndex = text.search(FIRST_JSON_VALUE_RE);
  if (firstIndex === -1) {
    return null;
  }
  const paths = pathsOverride ?? (text[firstIndex] === "[" ? ROOT_ARRAY_PATHS : WRAPPED_ARRAY_ELEMENT_PATHS);
  return { parser: createParser(paths, shapeTracker, onElement, onEnd, semanticRun), text: text.slice(firstIndex) };
}

async function feedParserChunk(
  parser: JSONParser,
  text: string,
  elementByteTracker: ElementByteTracker,
  pending: GoogleMapsStreamEvent[],
  onEvent: GoogleMapsStreamEventHandler
): Promise<void> {
  if (parser.isEnded) {
    // Keep feeding later chunks so the tokenizer can reject trailing
    // non-whitespace instead of silently stopping at the first root.
    parser.write(text);
    return;
  }
  elementByteTracker.consume(text);
  parser.write(text);
  await drain(pending, onEvent);
}

async function replaySemanticPath(
  path: string,
  maxSingleElementBytes: number,
  semanticProjections: Map<number, SemanticProjection>,
  onEvent: GoogleMapsStreamEventHandler
): Promise<void> {
  const pending: GoogleMapsStreamEvent[] = [];
  const onElement = (format: GoogleMapsSourceFormat, value: unknown): void => {
    pending.push({ format, kind: "element", value });
  };
  const semanticRun: SemanticProjectionRun = {
    onComplete(index) {
      semanticProjections.delete(index);
    },
    onPoint(index, point) {
      const projection = semanticProjections.get(index);
      if (!projection) {
        return;
      }
      onElement("semantic_segments", { ...cloneProjection(projection), timelinePath: [point] });
    },
  };
  const shapeTracker = new RootShapeTracker(() => undefined);
  const elementByteTracker = new ElementByteTracker(maxSingleElementBytes);
  let parser: JSONParser | null = null;
  const stream = createReadStream(path, { encoding: "utf8", highWaterMark: READ_BUFFER_SIZE });
  try {
    for await (const chunk of stream as AsyncIterable<string | Buffer>) {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let toFeed = text;
      if (!parser) {
        const initialized = initializeParser(
          text,
          shapeTracker,
          onElement,
          () => undefined,
          semanticRun,
          SEMANTIC_SEGMENT_PROJECTION_PATHS
        );
        if (!initialized) {
          continue;
        }
        ({ parser, text: toFeed } = initialized);
      }
      await feedParserChunk(parser, toFeed, elementByteTracker, pending, onEvent);
    }
  } finally {
    stream.destroy();
  }
  if (parser && !parser.isEnded) {
    parser.end();
  }
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
  const semanticProjections = new Map<number, SemanticProjection>();

  const markShape = (format: GoogleMapsSourceFormat): void => {
    if (seenShapes.has(format)) {
      return;
    }
    seenShapes.add(format);
    pending.push({ format, kind: "shape" });
  };

  const shapeTracker = new RootShapeTracker(markShape);
  const elementByteTracker = new ElementByteTracker(maxSingleElementBytes);
  const onElement = (format: GoogleMapsSourceFormat, value: unknown): void => {
    pending.push({ format, kind: "element", value });
  };
  const firstSemanticRun: SemanticProjectionRun = {
    onComplete(index, projection, hasPath) {
      if (hasPath) {
        semanticProjections.set(index, projection);
      } else {
        onElement("semantic_segments", projection);
      }
    },
  };
  let parser: JSONParser | null = null;

  const stream = createReadStream(path, { encoding: "utf8", highWaterMark: READ_BUFFER_SIZE });
  try {
    for await (const chunk of stream as AsyncIterable<string | Buffer>) {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let toFeed = text;
      if (!parser) {
        const initialized = initializeParser(text, shapeTracker, onElement, () => undefined, firstSemanticRun);
        if (!initialized) {
          continue;
        }
        ({ parser, text: toFeed } = initialized);
      }
      await feedParserChunk(parser, toFeed, elementByteTracker, pending, onEvent);
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

  if (seenShapes.has("semantic_segments")) {
    await replaySemanticPath(path, maxSingleElementBytes, semanticProjections, onEvent);
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
