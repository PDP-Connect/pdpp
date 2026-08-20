// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { proxyReferenceRequest } from "./reference-proxy.ts";

const UNREACHABLE_AS = "http://127.0.0.1:1";
const STARTUP_RETRY_COPY = /This page will retry automatically/;

test("the console distinguishes reference startup from a failed service", async (t) => {
  const readyFile = path.join(mkdtempSync(path.join(tmpdir(), "pdpp-reference-proxy-")), "ready");
  const previousAsUrl = process.env.PDPP_AS_URL;
  const previousReadyFile = process.env.PDPP_REFERENCE_READY_FILE;
  process.env.PDPP_AS_URL = UNREACHABLE_AS;
  process.env.PDPP_REFERENCE_READY_FILE = readyFile;
  t.after(() => {
    if (previousAsUrl === undefined) {
      delete process.env.PDPP_AS_URL;
    } else {
      process.env.PDPP_AS_URL = previousAsUrl;
    }
    if (previousReadyFile === undefined) {
      delete process.env.PDPP_REFERENCE_READY_FILE;
    } else {
      process.env.PDPP_REFERENCE_READY_FILE = previousReadyFile;
    }
    try {
      unlinkSync(readyFile);
    } catch {
      // The marker is absent on the first half of the test.
    }
  });

  const browserRequest = new Request("http://console.test/owner/login", {
    headers: { accept: "text/html" },
  });
  const starting = await proxyReferenceRequest(browserRequest, "as", ["owner"]);
  assert.equal(starting.status, 503);
  assert.equal(starting.headers.get("retry-after"), "2");
  assert.match(await starting.text(), STARTUP_RETRY_COPY);

  writeFileSync(readyFile, "ready\n");
  const failed = await proxyReferenceRequest(browserRequest, "as", ["owner"]);
  assert.equal(failed.status, 502);
  const body = (await failed.json()) as { error?: { code?: unknown; detail?: unknown; message?: unknown } };
  assert.equal(body.error?.code, "reference_unreachable");
  assert.equal(typeof body.error?.detail, "string");
  assert.equal(body.error?.message, "Cannot reach PDPP AS service.");
});
