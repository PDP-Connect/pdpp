// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Classifier for a defect INSIDE Node's vendored undici HTTP parser that
// surfaces as an `uncaughtException` and kills the whole reference process,
// abandoning every unrelated in-flight run.
//
// The captured production fault (Node 24.19.0 / undici 7.29.0, and also
// observed on Node 25.8.2 / undici 7.24.4):
//
//   AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:
//     assert(!this.paused)
//       at Parser.finish (node:internal/deps/undici/undici:7388:9)
//       at Socket.onHttpSocketEnd (node:internal/deps/undici/undici:7827:34)
//       at Socket.emit (node:events:521:24)
//       at endReadableNT (node:internal/streams/readable:1736:12)
//
// Mechanism, read off the vendored source. `Parser.execute` sets
// `this.paused = true` when llhttp returns ERROR.PAUSED (the response body
// consumer applied backpressure). A socket half-close then reaches
// `onHttpSocketEnd`, which calls `parser.finish()` whenever the response had
// a status line and is not keep-alive. `finish()` opens with an UNGUARDED
// `assert(!this.paused)` and undici wraps none of it in try/catch, so the
// AssertionError escapes as an asynchronous `uncaughtException`. No
// application `try/catch` can intercept it: it is raised from a socket 'end'
// event on a later tick, not inside the awaited `fetch()` call.
//
// Why containing THIS is safe, where a blanket catch-all would not be:
//   - Every frame is inside Node's own vendored HTTP parser and stream
//     plumbing. No application frame is on the stack, so no reference-
//     implementation invariant was mid-update when it threw.
//   - It fires during socket TEARDOWN. The parser is being discarded; the
//     assertion guards undici's internal bookkeeping, not our data. undici
//     destroys the socket regardless, and the owning `fetch()` promise still
//     settles (it rejects), so the run that owned the request fails through
//     its normal error path with a real reason.
//   - It is a liveness bug in a dependency, not a signal that this process
//     holds corrupt state. A genuinely corrupt process SHOULD still die,
//     which is why everything outside this shape stays fatal.
//
// Anything that is not this exact shape — a different assertion, an
// AssertionError from application code, any error whose stack is not
// anchored in the vendored parser — SHALL fall through to the existing
// fatal-exit path.

/**
 * Stack-frame anchor for Node's vendored undici. Node reports these frames
 * with the `node:internal/deps/undici/undici` specifier regardless of the
 * bundled undici version, so matching the specifier (rather than a line
 * number, which moves with every Node release) keeps this stable across
 * upgrades while still proving the throw came from inside the parser.
 */
const VENDORED_UNDICI_FRAME = "node:internal/deps/undici/undici";

/**
 * The parser methods whose leading `assert(...)` calls are reachable during
 * socket teardown. `finish` is the captured production crash; `execute` runs
 * the same paused-state assertions from the readable path and can fail the
 * same way when a paused parser is handed a further chunk.
 */
const PARSER_TEARDOWN_FRAMES = ["at Parser.finish", "at Parser.execute"];

function stackOf(err: unknown): string | null {
  if (!err || typeof err !== "object") {
    return null;
  }
  const { stack } = err as { stack?: unknown };
  return typeof stack === "string" ? stack : null;
}

/**
 * Returns true iff `err` is the vendored-undici parser assertion described
 * above. The shape accepted is intentionally narrow; ALL of the following
 * must hold:
 *   - `err` is an Error with `code === "ERR_ASSERTION"`;
 *   - it is a generated assertion (`generatedMessage === true`), i.e. a bare
 *     `assert(expr)` rather than an assertion carrying an author-written
 *     message, which application code would use;
 *   - its stack contains a frame inside Node's vendored undici bundle; and
 *   - its stack contains a parser teardown frame (`Parser.finish` /
 *     `Parser.execute`).
 *
 * The stack anchor is the load-bearing condition: it proves the throw
 * originated inside Node's HTTP parser with no application frame involved.
 * An `ERR_ASSERTION` raised anywhere in reference-implementation code
 * returns false and stays fatal, even if it is also a bare `assert(expr)`.
 */
export function isVendoredUndiciParserAssertion(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  // biome-ignore lint/style/useDestructuring: Explicit property access documents this compatibility boundary.
  const code = (err as { code?: unknown }).code;
  if (code !== "ERR_ASSERTION") {
    return false;
  }
  // biome-ignore lint/style/useDestructuring: Explicit property access documents this compatibility boundary.
  const generatedMessage = (err as { generatedMessage?: unknown }).generatedMessage;
  if (generatedMessage !== true) {
    return false;
  }
  const stack = stackOf(err);
  if (!stack?.includes(VENDORED_UNDICI_FRAME)) {
    return false;
  }
  return PARSER_TEARDOWN_FRAMES.some((frame) => stack.includes(frame));
}

export const VENDORED_UNDICI_FRAME_SPECIFIER = VENDORED_UNDICI_FRAME;
