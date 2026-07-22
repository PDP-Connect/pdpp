// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("stream debug route appends sanitized events to date-grouped JSONL", async () => {
  const originalCwd = process.cwd();
  const tempRoot = await mkdtemp(path.join(tmpdir(), "pdpp-stream-debug-"));
  process.chdir(tempRoot);

  const consoleInfo = console.info;
  const logs: string[] = [];
  console.info = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };

  try {
    const { POST } = await import("./route.ts");
    const response = await POST(
      new Request("http://localhost:3000/api/stream-debug", {
        body: JSON.stringify({
          events: [
            {
              name: "neko.clipboard_local_to_remote",
              clipboardChangeEventAvailable: true,
              password: "do-not-store-password",
              rawClipboardText: "do-not-store-clipboard",
              proxyUrl: "https://token:do-not-store@neko.internal/session",
              transportError: "upstream disconnected at wss://neko.internal/socket?token=do-not-store",
              safeLengthBucket: "17-64",
            },
          ],
        }),
        headers: {
          "content-type": "application/json",
          host: "localhost:3000",
          origin: "http://localhost:3000",
        },
        method: "POST",
      })
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, accepted: 1 });
    assert.equal(
      logs.some((line) => line.includes("pdpp_stream_debug")),
      true
    );

    const files = await readFile(
      path.join(tempRoot, "tmp", "stream-debug", `${new Date().toISOString().slice(0, 10)}.jsonl`),
      "utf8"
    );
    const lines = files.trim().split("\n");
    assert.equal(lines.length, 1);
    assert.equal(files.includes("do-not-store-clipboard"), false);
    assert.equal(files.includes("do-not-store-password"), false);
    assert.equal(files.includes("neko.internal"), false);
    assert.equal(files.includes("do-not-store"), false);

    const stored = JSON.parse(lines[0] ?? "{}") as {
      events?: Record<string, unknown>[];
      receivedAt?: string;
    };
    assert.equal(typeof stored.receivedAt, "string");
    assert.equal(stored.events?.[0]?.name, "neko.clipboard_local_to_remote");
    assert.equal(stored.events?.[0]?.clipboardChangeEventAvailable, true);
    assert.equal(stored.events?.[0]?.rawClipboardText, "[redacted]");
    assert.equal(stored.events?.[0]?.password, "[redacted]");
    assert.equal(stored.events?.[0]?.proxyUrl, "[redacted]");
    assert.equal(stored.events?.[0]?.transportError, "[redacted]");
    assert.equal(stored.events?.[0]?.safeLengthBucket, "17-64");
  } finally {
    console.info = consoleInfo;
    process.chdir(originalCwd);
  }
});
