// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Runs the real connector entrypoint (connectors/jellyfin/index.ts) as a
 * child process and drives it over the actual stdin/stdout Collection
 * Profile protocol via `runConnectorProtocolSubprocess` — the same harness
 * `src/test-harness.test.ts` uses to prove other connectors' entrypoints.
 *
 * Unlike the other Jellyfin test files, which call `collect()` directly
 * with a hand-built `CollectContext`, this proves the FULL path: START
 * parsing, `runConnector`'s scope/requested wiring, real `emit`/`emitRecord`
 * JSONL framing over stdout, and the runtime's own terminal DONE emission.
 * If the connector's message shapes ever drift from the real protocol
 * again, this test — not just a hand-rolled context — will catch it.
 */

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "..", "..");
const ENTRYPOINT = join(__dirname, "index.ts");

function startFakeServer(): Promise<{ stop: () => Promise<void>; url: string }> {
  return new Promise((resolveServer, rejectServer) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const path = req.url || "";

      if (path === "/System/Info") {
        res.writeHead(200);
        res.end(JSON.stringify({ Id: "test", ServerName: "Test Jellyfin", Version: "10.11.11" }));
        return;
      }
      if (path === "/Users") {
        res.writeHead(200);
        res.end(JSON.stringify([{ Id: "user-123", Name: "Test" }]));
        return;
      }
      if (path === "/Users/user-123/Views") {
        res.writeHead(200);
        res.end(JSON.stringify({ Items: [{ Id: "lib1", Name: "Movies", CollectionType: "movies" }] }));
        return;
      }
      if (path.includes("/Users/user-123/Items")) {
        const url = new URL(path, "http://localhost");
        const startIndex = Number.parseInt(url.searchParams.get("StartIndex") || "0", 10);
        if (startIndex === 0) {
          res.writeHead(200);
          res.end(
            JSON.stringify({
              Items: [{ Id: "item-1", Name: "Item 1", Type: "Movie", UserData: { PlayCount: 0, Played: false } }],
              TotalRecordCount: 1,
            })
          );
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify({ Items: [], TotalRecordCount: 1 }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolveServer({
        stop: () => new Promise<void>((res2, rej2) => server.close((err) => (err ? rej2(err) : res2()))),
        url: `http://127.0.0.1:${port}`,
      });
    });
    server.on("error", rejectServer);
  });
}

test("protocol subprocess: jellyfin entrypoint completes START to DONE over real stdio protocol", async () => {
  const fake = await startFakeServer();

  try {
    const result = await runConnectorProtocolSubprocess({
      cwd: PACKAGE_ROOT,
      entrypoint: ENTRYPOINT,
      env: {
        JELLYFIN_BASE_URL: fake.url,
        JELLYFIN_API_KEY: "test-key",
      },
      start: {
        type: "START",
        scope: { streams: [{ name: "libraries" }, { name: "items" }] },
        state: { libraries: {}, items: {} },
      },
    });

    assert.equal(result.code, 0);

    const record = result.messages.find(
      (m): m is Extract<(typeof result.messages)[number], { type: "RECORD" }> => m.type === "RECORD"
    );
    assert.ok(record, "connector must emit at least one real RECORD message");
    assert.ok(
      "key" in record && "data" in record && "emitted_at" in record,
      "RECORD must use key/data/emitted_at protocol shape"
    );

    const stateMsgs = result.messages.filter(
      (m): m is Extract<(typeof result.messages)[number], { type: "STATE" }> => m.type === "STATE"
    );
    assert.ok(stateMsgs.length > 0, "connector must emit STATE messages");
    for (const s of stateMsgs) {
      assert.ok(typeof s.stream === "string" && s.stream.length > 0, "each STATE must carry a stream name");
      assert.ok("cursor" in s, "each STATE must carry a cursor field");
    }

    const done = result.messages.at(-1);
    assert.equal(done?.type, "DONE");
    if (done?.type === "DONE") {
      assert.equal(done.status, "succeeded");
      assert.equal(typeof done.records_emitted, "number");
      assert.ok(done.records_emitted >= 1);
    }
  } finally {
    await fake.stop();
  }
});
