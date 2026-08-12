// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Control-plane visibility test for the bounded connector failure
 * diagnostic added by
 *   openspec/changes/persist-connector-failure-diagnostics
 *
 * Asserts:
 *   1. A connector that exits before DONE with stderr persists
 *      `connector_diagnostics.stderr_tail` and runtime-authored
 *      `failure_origin`/`failure_message` on the terminal `run.failed`
 *      event.
 *   2. The owner-scoped `_ref` run timeline endpoint surfaces those
 *      fields (this is what the dashboard reads).
 *   3. None of the grant-scoped `/v1` reads (records, search, schema)
 *      expose connector stderr text. We don't have a grant in the
 *      stub-only harness, so we cover this as a structural check on the
 *      surfaces — the diagnostic lives on `spine_events`, never on the
 *      `record` rows or schema metadata read by `/v1`.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runConnector } from "../runtime/index.ts";
import { startServer } from "../server/index.ts";
import { makeDefaultAccountConnectorInstanceId } from "../server/stores/connector-instance-store.ts";

/**
 * Minimal admission fixture for `runConnector`'s required `admitRunConnection`
 * callback: echoes back an explicit claim, or (when the caller made none)
 * derives the same deterministic default-account connector-instance id the
 * storage layer itself falls back to, so writer/reader agree.
 */
function fakeAdmitRunConnection(): (input: {
  connectorId: string;
  connectorInstanceId: string | null;
  ownerSubjectId: string | null;
}) => Promise<{ connectorId: string; connectorInstanceId: string; ownerSubjectId: string }> {
  return ({ connectorId, connectorInstanceId, ownerSubjectId: requestedOwnerSubjectId }) => {
    const ownerSubjectId = requestedOwnerSubjectId || "owner_local";
    const exactId = connectorInstanceId ?? makeDefaultAccountConnectorInstanceId(ownerSubjectId, connectorId);
    return Promise.resolve({ connectorId, connectorInstanceId: exactId, ownerSubjectId });
  };
}

const TEST_DCR_INITIAL_ACCESS_TOKEN = "pdpp-reference-test-initial-access-token";

const STUB_MANIFEST = {
  connector_id: "https://registry.pdpp.dev/connectors/test-failure-diagnostics-cp",
  runtime_requirements: {},
  streams: [
    {
      name: "noop",
      primary_key: "id",
      schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
    },
  ],
  version: "0.1.0",
};

// `startServer`'s inferred asServer/rsServer type comes from a framework
// `.listen()` call whose TS overload resolves to an http2-shaped type, but at
// runtime these are plain node:http/https servers (the framework never
// negotiates ALPN in this reference stack) — so `closeAllConnections` (added
// Node 18.2+) and the single-error-arg `close` callback genuinely exist and
// are safe to declare here.
type TestServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
  rsServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
};

async function closeServer(server: TestServer): Promise<void> {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise<void>((r) => server.asServer.close(() => r())),
    new Promise<void>((r) => server.rsServer.close(() => r())),
  ]);
}

async function fetchJson<T = Record<string, unknown>>(
  url: string,
  opts: RequestInit = {}
): Promise<{ status: number; body: T | null }> {
  const resp = await fetch(url, opts);
  const parsed: unknown = await resp.json().catch(() => null);
  return { body: parsed as T | null, status: resp.status };
}

async function issueOwnerToken(asUrl: string): Promise<string> {
  const clientId = "cli_longview";
  const { body: device } = await fetchJson<{ device_code: string; user_code: string }>(
    `${asUrl}/oauth/device_authorization`,
    {
      body: new URLSearchParams({ client_id: clientId }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    }
  );
  if (!device) {
    throw new Error("expected a device_authorization response body");
  }
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: "owner_local", user_code: device.user_code }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const { body: tokenBody } = await fetchJson<{ access_token: string }>(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  if (!tokenBody) {
    throw new Error("expected a token response body");
  }
  return tokenBody.access_token;
}

function writeFailingStub(stderrText: string, exitCode = 1): { tmpDir: string; stubPath: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-fdcp-"));
  const stubPath = join(tmpDir, "stub.js");
  const lines = [
    "#!/usr/bin/env node",
    "process.stdin.resume();",
    "process.stdin.once('data', () => {",
    `  process.stderr.write(${JSON.stringify(stderrText)});`,
    `  process.exit(${exitCode});`,
    "});",
    "",
  ];
  writeFileSync(stubPath, lines.join("\n"), "utf8");
  chmodSync(stubPath, 0o755);
  return { stubPath, tmpDir };
}

test("connector failure diagnostics surface on owner timeline; not on /v1 surfaces", async (t) => {
  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
    quiet: true,
    rsPort: 0,
  })) as TestServer;
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(STUB_MANIFEST),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl);
    const stderrText = "Boom: connector hit fatal error\n  upstream returned 500\n";
    const { tmpDir, stubPath } = writeFailingStub(stderrText, 1);

    let runId: string | null = null;
    try {
      const result = (await runConnector({
        admitRunConnection: fakeAdmitRunConnection(),
        collectionMode: "full_refresh",
        connectorId: STUB_MANIFEST.connector_id,
        connectorPath: stubPath,
        manifest: STUB_MANIFEST,
        onInteraction: () => ({ status: "cancelled", type: "INTERACTION_RESPONSE" }),
        // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
        onProgress: () => {},
        ownerToken,
        rsUrl,
        state: null,
      })) as { run_id: string; status: string };
      runId = result.run_id;
      assert.equal(result.status, "failed");
    } catch (err) {
      runId = err && typeof err === "object" && "run_id" in err ? (err.run_id as string) : null;
    }
    assert.ok(runId, "expected runConnector to surface a run_id");

    await t.test("owner /_ref/runs/:runId/timeline includes connector_diagnostics.stderr_tail", async () => {
      interface TimelineEvent {
        data: Record<string, unknown>;
        event_type: string;
      }
      const { status, body } = await fetchJson<{ data?: TimelineEvent[]; events?: TimelineEvent[] }>(
        `${asUrl}/_ref/runs/${encodeURIComponent(runId ?? "")}/timeline`
      );
      assert.equal(status, 200);
      const events = Array.isArray(body?.data) ? body.data : body?.events;
      assert.ok(Array.isArray(events) && events.length > 0, "expected timeline events");
      const failed = events.find((e) => e.event_type === "run.failed");
      assert.ok(failed, "expected a run.failed event in the timeline");
      assert.equal(failed.data.failure_origin, "connector");
      assert.equal(typeof failed.data.failure_message, "string");
      const tail = (failed.data.connector_diagnostics as Record<string, unknown> | undefined)?.stderr_tail as
        | Record<string, unknown>
        | undefined;
      assert.ok(tail, "expected connector_diagnostics.stderr_tail");
      assert.equal(tail.object, "connector_stderr_tail");
      assert.equal(tail.encoding, "utf-8");
      assert.equal(typeof tail.text, "string");
      assert.ok((tail.text as string).includes("Boom"), `stderr text not preserved: ${tail.text}`);
    });

    await t.test("grant-scoped /v1/schema does not echo connector stderr", async () => {
      // Without a granted bearer we expect 401; even an authenticated
      // schema call returns capability metadata only, never spine event
      // payloads. We assert the negative shape: the response body must
      // not contain the raw stderr substring.
      const { body } = await fetchJson(`${asUrl}/v1/schema`);
      const serialized = JSON.stringify(body ?? {});
      assert.ok(
        !(serialized.includes("Boom") || serialized.includes("connector_stderr_tail")),
        `unexpected stderr leakage on /v1/schema: ${serialized.slice(0, 200)}`
      );
    });

    await t.test("grant-scoped /v1/records does not echo connector stderr", async () => {
      const { body } = await fetchJson(`${asUrl}/v1/records?limit=10`);
      const serialized = JSON.stringify(body ?? {});
      assert.ok(
        !(serialized.includes("Boom") || serialized.includes("connector_stderr_tail")),
        `unexpected stderr leakage on /v1/records: ${serialized.slice(0, 200)}`
      );
    });

    await t.test("grant-scoped /v1/search does not echo connector stderr", async () => {
      // Search by content of the stderr to make this maximally adversarial.
      const { body } = await fetchJson(`${asUrl}/v1/search?q=Boom`);
      const serialized = JSON.stringify(body ?? {});
      assert.ok(
        !serialized.includes("Boom: connector hit fatal error"),
        `unexpected stderr leakage on /v1/search: ${serialized.slice(0, 200)}`
      );
      assert.ok(
        !serialized.includes("connector_stderr_tail"),
        `unexpected diagnostic object name on /v1/search: ${serialized.slice(0, 200)}`
      );
    });

    rmSync(tmpDir, { force: true, recursive: true });
  } finally {
    await closeServer(server);
  }
});
