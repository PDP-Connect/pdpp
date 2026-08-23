// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}page.tsx`;
const HANDLES_DETERMINISTIC_REQUEST_RE = /if \(isDeterministicSourcesReadError\(err\)\)/;
const RENDERS_SERVER_REASON_RE = /The reference server rejected the source catalog request: \{err\.message\}/;
const PRESERVES_FULL_HEADER_RE = /<AddSourceHeader \/>/;

test("Add Source renders a deterministic reference request failure before it reaches Next's error boundary", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, HANDLES_DETERMINISTIC_REQUEST_RE);
  assert.match(src, RENDERS_SERVER_REASON_RE);
  assert.match(src, PRESERVES_FULL_HEADER_RE);
  assert.doesNotMatch(src, /instanceof RefRequestError/);
  assert.ok(
    src.indexOf("if (isDeterministicSourcesReadError(err))") < src.indexOf("throw err;"),
    "the known 4xx path must render before the error boundary can redact it"
  );
});
