// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Streaming reader for Twitter/X archive `.js` files. The archive ships a
// JavaScript assignment — `window.YTD.tweets.part0 = [ ... ];` — not plain
// JSON, and a heavy archive can be hundreds of MB. Reading the whole file
// and JSON.parsing it (the previous shape) held both the raw string and the
// parsed array in process heap at once.
//
// This module streams the file off disk, strips the assignment prefix up to
// the array opener, and feeds the remainder into a vetted, dependency-free
// streaming JSON parser (`@streamparser/json`). With `paths: ['$.*']` and
// `keepStack: false` the parser emits each top-level array element and then
// nulls it out of the containing array, so the per-element payload never
// accumulates — process memory is bounded by the parser window plus the
// current element, not by source byte size. This mirrors the apple_health
// streaming-XML reference shape.

import { createReadStream, existsSync } from "node:fs";
import { JSONParser } from "@streamparser/json";

// 64 KB read buffer balances memory against syscalls on large archives,
// matching the apple_health streaming reader.
const READ_BUFFER_SIZE = 65_536;

// The assignment opener is `window.YTD.<name>.partN = ` followed by the array
// literal. We strip everything up to (but not including) the first `[`, which
// is the array opener — the LHS member expression never contains a `[` in any
// Twitter Data Download we have seen. Bracket-notation LHS (`window["YTD"]`)
// is not a shape Twitter emits; such a file would parse as malformed and skip.
const ARRAY_OPEN = "[";

/**
 * Strip the leading `window.YTD... = ` assignment prefix from a buffered head,
 * returning the text from the array opener onward, or null when no array
 * opener has been seen yet (caller should keep buffering).
 */
export function stripAssignmentPrefix(head: string): string | null {
  const idx = head.indexOf(ARRAY_OPEN);
  if (idx === -1) {
    return null;
  }
  return head.slice(idx);
}

/**
 * Stream the top-level array elements of a Twitter archive `.js` file without
 * materializing the whole archive. Yields each entry (still wrapped, e.g.
 * `{ tweet: {...} }`) for the caller's pure record builders to unwrap.
 *
 * Returns immediately (yielding nothing) when the file is absent — callers
 * distinguish "absent" from "present but empty" via {@link archiveExists}.
 *
 * Throws when the file is present but is not a well-formed
 * `window.YTD... = [ ... ]` archive, preserving the previous parser's
 * "malformed archive → treated as no records" behavior at the call site.
 */
export async function* streamJsArchive(path: string): AsyncGenerator<unknown> {
  if (!existsSync(path)) {
    return;
  }

  const parser = new JSONParser({ paths: ["$.*"], keepStack: false });
  const pending: unknown[] = [];
  parser.onValue = ({ value, stack }): void => {
    // stack.length === 1 → a direct child of the root array. The root array
    // itself is never emitted under the `$.*` path, so this is the only depth
    // we observe here.
    if (stack.length === 1) {
      pending.push(value);
    }
  };

  const stream = createReadStream(path, {
    encoding: "utf8",
    highWaterMark: READ_BUFFER_SIZE,
  });

  let head = "";
  let started = false;

  for await (const chunk of stream as AsyncIterable<string | Buffer>) {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");

    let toFeed: string | null;
    if (started) {
      toFeed = text;
    } else {
      head += text;
      toFeed = stripAssignmentPrefix(head);
      if (toFeed === null) {
        // Array opener not seen yet; keep buffering the prefix.
        continue;
      }
      started = true;
      head = "";
    }

    feedParser(parser, toFeed);
    yield* drain(pending);

    if (parser.isEnded) {
      // The top-level array has closed; anything left in the file is the
      // assignment terminator (`;`, whitespace). Stop reading.
      stream.destroy();
      break;
    }
  }

  yield* drain(pending);

  if (parser.isEnded) {
    return;
  }
  if (!started) {
    // The whole file was consumed without ever seeing an array opener. Either
    // it is empty/whitespace or it is not a `window.YTD... = [ ... ]` archive.
    // Whitespace-only is treated as malformed too: a real archive always
    // assigns an array. This mirrors the previous parser returning null for a
    // non-array body, which the call site reports as a missing archive.
    if (head.trim().length > 0) {
      throw new Error("twitter_archive: file is not a window.YTD assignment archive");
    }
    throw new Error("twitter_archive: archive file is empty");
  }
  // We saw an array opener but the stream ended before the array closed:
  // truncated or malformed body. Flushing surfaces the tokenizer error.
  parser.end();
  throw new Error("twitter_archive: archive array did not close");
}

/**
 * Feed a chunk into the streaming parser. Once the top-level array has closed
 * the parser is in its ENDED state and any trailing assignment terminator
 * (`;`, whitespace) makes `write` throw; that throw is benign and swallowed.
 * A throw while the parser is NOT ended is a real malformed-archive error and
 * is re-thrown.
 */
function feedParser(parser: JSONParser, text: string): void {
  try {
    parser.write(text);
  } catch (err) {
    if (!parser.isEnded) {
      throw err;
    }
  }
}

/** Yield and clear everything the parser has emitted so far. */
function* drain(pending: unknown[]): Generator<unknown> {
  for (const value of pending) {
    yield value;
  }
  pending.length = 0;
}

/** Whether the archive file exists on disk (present-but-empty vs. absent). */
export function archiveExists(path: string): boolean {
  return existsSync(path);
}
