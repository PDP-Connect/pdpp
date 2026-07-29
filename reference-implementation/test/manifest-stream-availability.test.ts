const TOP_LEVEL_REGEX_1 = /availability\.mode/;
const TOP_LEVEL_REGEX_2 = /availability\.state/;
const TOP_LEVEL_REGEX_3 = /unsupported keys/;

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Validation coverage for stream-level availability declarations.
 *
 * `availability` is reference/polyfill metadata used to distinguish connector
 * capability from run outcome. It keeps expected unsupported-in-mode streams
 * from being treated as selected-data loss.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { startServer } from "../server/index.ts";

type StartedServer = Awaited<ReturnType<typeof startServer>>;

function hasCloseAllConnections(server: object): server is { closeAllConnections: () => void } {
  return "closeAllConnections" in server && typeof server.closeAllConnections === "function";
}

async function closeServer(server: StartedServer): Promise<void> {
  if (hasCloseAllConnections(server.asServer)) {
    server.asServer.closeAllConnections();
  }
  if (hasCloseAllConnections(server.rsServer)) {
    server.rsServer.closeAllConnections();
  }
  await Promise.allSettled([
    new Promise((r) => server.asServer.close(r)),
    new Promise((r) => server.rsServer.close(r)),
  ]);
}

async function withHarness(fn: (harness: { asUrl: string }) => Promise<void>): Promise<void> {
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
  });
  try {
    await fn({ asUrl: `http://localhost:${server.asPort}` });
  } finally {
    await closeServer(server);
  }
}

interface ErrorBody {
  error: { code: string; message: string };
}

interface RegisterResult {
  body: ErrorBody | string | null;
  status: number;
}

function hasErrorBody(body: RegisterResult["body"]): body is ErrorBody {
  return typeof body === "object" && body !== null && "error" in body;
}

async function registerConnectorManifest(asUrl: string, manifest: unknown): Promise<RegisterResult> {
  const resp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const text = await resp.text();
  let body: RegisterResult["body"] = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { body, status: resp.status };
}

function makeManifest({ availability }: { availability?: unknown } = {}) {
  return {
    connector_id: "https://registry.pdpp.test/connectors/stream-availability",
    display_name: "Stream availability fixture",
    protocol_version: "0.1.0",
    runtime_requirements: { bindings: { network: { required: true } } },
    streams: [
      {
        name: "items",
        semantics: "mutable_state",
        ...(availability === undefined ? {} : { availability }),
        primary_key: ["id"],
        schema: {
          properties: {
            id: { type: "string" },
          },
          required: ["id"],
          type: "object",
        },
      },
    ],
    version: "0.1.0",
  };
}

test("valid unsupported-in-mode stream availability is accepted", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({
        availability: {
          future_modes: ["api"],
          mode: "archive",
          reason: "external archive does not expose this stream",
          state: "unsupported_in_mode",
        },
      })
    );
    assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
  });
});

test("unsupported-in-mode availability requires a mode", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({
        availability: {
          reason: "missing mode should fail",
          state: "unsupported_in_mode",
        },
      })
    );
    assert.equal(status, 400);
    assert.ok(hasErrorBody(body));
    assert.match(body.error.message, TOP_LEVEL_REGEX_1);
  });
});

test("stream availability rejects unknown states and keys", async () => {
  await withHarness(async ({ asUrl }) => {
    const badState = await registerConnectorManifest(
      asUrl,
      makeManifest({
        availability: {
          state: "maybe",
        },
      })
    );
    assert.equal(badState.status, 400);
    assert.ok(hasErrorBody(badState.body));
    assert.match(badState.body.error.message, TOP_LEVEL_REGEX_2);

    const unknownKey = await registerConnectorManifest(
      asUrl,
      makeManifest({
        availability: {
          state: "supported",
          unsupported_reason: "unknown key",
        },
      })
    );
    assert.equal(unknownKey.status, 400);
    assert.ok(hasErrorBody(unknownKey.body));
    assert.match(unknownKey.body.error.message, TOP_LEVEL_REGEX_3);
  });
});
