// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Gmail connector must not flatten an IMAP error to `.message`.
 *
 * imapflow raises a bare `new Error("Command failed")` for EVERY IMAP NO/BAD
 * response, putting the server's real explanation on `.responseText` and the
 * triggering command on `.executedCommand`. `describeUnexpectedFailure`
 * (src/connector-runtime.ts) folds those side fields back in.
 *
 * The runtime applies that helper to throws it catches — but this connector's
 * `handleMainRejection` emits DONE **itself**, bypassing the runtime entirely.
 * So the connector has to do the extraction on its own path, and a fix applied
 * only to the runtime leaves this one untouched: exactly what happened on the
 * owner's instance, where a real Gmail failure still reported nothing but
 * "Command failed" after the runtime was already patched.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const INDEX_FILE = fileURLToPath(new URL("./index.ts", import.meta.url));

function functionBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  assert.notEqual(start, -1, `${signature} must exist`);
  const end = src.indexOf("\n}", start);
  return src.slice(start, end);
}

test("the top-level rejection handler keeps the IMAP server's explanation", async () => {
  const src = await readFile(INDEX_FILE, "utf8");
  const body = functionBody(src, "function handleMainRejection(e: unknown): void {");
  assert.match(body, /describeUnexpectedFailure\(e\)/, "must fold in responseText/executedCommand");
  assert.doesNotMatch(
    body,
    /e instanceof Error \? e\.message : String\(e\)/,
    "flattening to .message discards the only useful part of an imapflow error"
  );
});

test("attachment hydration errors keep it too", async () => {
  // Attachment downloads also go over IMAP, so they hit the same generic message.
  const src = await readFile(INDEX_FILE, "utf8");
  const body = functionBody(src, "function boundedHydrationError(err: unknown): string {");
  assert.match(body, /describeUnexpectedFailure\(err\)/);
});

test("the helper is imported from the shared runtime, not re-implemented", async () => {
  // A second copy would drift from the runtime's redaction guarantees — the
  // reason executedCommand is safe to surface at all.
  const src = await readFile(INDEX_FILE, "utf8");
  assert.match(src, /describeUnexpectedFailure,?\n?[\s\S]{0,400}from "\.\.\/\.\.\/src\/connector-runtime\.ts"/);
});
