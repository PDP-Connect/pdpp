// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runConnector } from "../runtime/index.ts";
import { startServer } from "../server/index.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { admitOwnerRunConnection } from "../server/stores/connector-instance-store.ts";

// Real ingest resolves the acting owner subject from the request's bearer
// token (`getOwnerTokenSubjectId` in server/index.ts), independent of
// `runConnector`'s own `ownerSubjectId` option (always null here). This
// file's harness mints its owner token for subject 'gap_severity_user', so
// admission must materialize/resolve that same subject via the real store —
// mirrors the exact production wiring in server/index.ts's
// `createController({ admitRunConnection: ... })`.
function fakeAdmitRunConnection(): (input: {
  connectorId: string;
  connectorInstanceId: string | null;
  ownerSubjectId: string | null;
}) => Promise<{ connectorId: string; connectorInstanceId: string; ownerSubjectId: string }> {
  return async ({ connectorId, connectorInstanceId, ownerSubjectId: requestedOwnerSubjectId }) => {
    const ownerSubjectId = requestedOwnerSubjectId || "gap_severity_user";
    const namespace = await admitOwnerRunConnection({
      connectorId,
      connectorInstanceId,
      connectorInstanceStore: createRequestConnectorInstanceStore(),
      ownerSubjectId,
    });
    return { connectorId: namespace.connectorId, connectorInstanceId: namespace.connectorInstanceId, ownerSubjectId };
  };
}

// `startServer`'s inferred asServer/rsServer type comes from a framework
// `.listen()` call whose TS overload resolves to an http2-shaped type, but at
// runtime these are plain node:http/https servers (the framework never
// negotiates ALPN in this reference stack) — so `closeAllConnections` (added
// Node 18.2+) and the single-error-arg `close` callback genuinely exist and
// are safe to declare here. Established pattern, see
// connector-failure-diagnostics-control-plane.test.ts.
type TestServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
  rsServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
};

async function closeServer(server: TestServer): Promise<void> {
  server.schedulerManager?.stop?.();
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise<void>((resolve) => server.asServer.close(() => resolve())),
    new Promise<void>((resolve) => server.rsServer.close(() => resolve())),
  ]);
}

async function fetchJson<T = Record<string, unknown>>(
  url: string,
  opts: RequestInit = {}
): Promise<{ status: number; body: T | null }> {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  return { body: text ? (JSON.parse(text) as T) : null, status: resp.status };
}

async function issueOwnerToken(asUrl: string, subjectId = "owner_local"): Promise<string> {
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

  const approveResp = await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({
      subject_id: subjectId,
      user_code: device.user_code,
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.equal(approveResp.status, 200);

  const { body: token } = await fetchJson<{ access_token: string }>(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });

  if (!token) {
    throw new Error("expected a token response body");
  }
  return token.access_token;
}

function makeManifest(connectorId = "https://registry.pdpp.test/connectors/gap-severity") {
  return {
    connector_id: connectorId,
    display_name: "Gap severity fixture",
    protocol_version: "0.1.0",
    streams: [
      {
        name: "items",
        primary_key: ["id"],
        schema: {
          properties: { id: { type: "string" } },
          required: ["id"],
          type: "object",
        },
        semantics: "append_only",
      },
      {
        availability: {
          future_modes: ["api"],
          mode: "slackdump_archive",
          reason: "archive mode does not expose stars",
          state: "unsupported_in_mode",
        },
        name: "stars",
        primary_key: ["id"],
        schema: {
          properties: { id: { type: "string" } },
          required: ["id"],
          type: "object",
        },
        semantics: "mutable_state",
      },
    ],
    version: "0.1.0",
  };
}

function createScopeAwareConnector(
  capturePath: string,
  { itemSkipReason = null }: { itemSkipReason?: string | null } = {}
): { connectorPath: string; cleanup: () => void } {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-gap-severity-"));
  const connectorPath = join(tmpDir, "connector.mjs");
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';

const capturePath = ${JSON.stringify(capturePath)};
const itemSkipReason = ${JSON.stringify(itemSkipReason)};
const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  writeFileSync(capturePath, JSON.stringify(msg.scope, null, 2));
  const requested = new Set((msg.scope?.streams || []).map((stream) => stream.name));
  if (itemSkipReason && requested.has('items')) {
    process.stdout.write(JSON.stringify({
      type: 'SKIP_RESULT',
      stream: 'items',
      reason: itemSkipReason,
      message: 'items selected but unavailable',
    }) + '\\n');
  }
  if (requested.has('stars')) {
    process.stdout.write(JSON.stringify({
      type: 'SKIP_RESULT',
      stream: 'stars',
      reason: 'not_available',
      message: 'archive mode does not expose stars',
    }) + '\\n');
  }
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
  rl.close();
  process.exit(0);
});
`,
    "utf8"
  );
  return { cleanup: () => rmSync(tmpDir, { force: true, recursive: true }), connectorPath };
}

interface RuntimeHarness {
  manifest: ReturnType<typeof makeManifest>;
  ownerToken: string;
  rsUrl: string;
}

async function withRuntimeHarness(fn: (harness: RuntimeHarness) => Promise<void>): Promise<void> {
  const server = (await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 })) as TestServer;
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const manifest = makeManifest();
  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    const ownerToken = await issueOwnerToken(asUrl, "gap_severity_user");
    await fn({ manifest, ownerToken, rsUrl });
  } finally {
    await closeServer(server);
  }
}

test("default START.scope excludes unsupported-in-mode streams", async () => {
  await withRuntimeHarness(async ({ manifest, ownerToken, rsUrl }) => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-gap-scope-"));
    const capturePath = join(tmpDir, "scope.json");
    const { connectorPath, cleanup } = createScopeAwareConnector(capturePath);
    try {
      const result = await runConnector({
        admitRunConnection: fakeAdmitRunConnection(),
        collectionMode: "incremental",
        connectorId: manifest.connector_id,
        connectorPath,
        manifest,
        onInteraction: async () => ({}),
        ownerToken,
        persistState: true,
        rsUrl,
        state: null,
      });

      const capturedScope: { streams: Array<{ name: string }> } = JSON.parse(readFileSync(capturePath, "utf8"));
      assert.deepEqual(
        capturedScope.streams.map((stream) => stream.name),
        ["items"]
      );
      assert.deepEqual(result.known_gaps, []);
    } finally {
      cleanup();
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });
});

test("explicit unsupported-in-mode stream skip is actionable", async () => {
  await withRuntimeHarness(async ({ manifest, ownerToken, rsUrl }) => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-gap-explicit-"));
    const capturePath = join(tmpDir, "scope.json");
    const { connectorPath, cleanup } = createScopeAwareConnector(capturePath);
    try {
      const result = await runConnector({
        admitRunConnection: fakeAdmitRunConnection(),
        collectionMode: "incremental",
        connectorId: manifest.connector_id,
        connectorPath,
        manifest,
        onInteraction: async () => ({}),
        ownerToken,
        persistState: true,
        rsUrl,
        scope: { streams: [{ name: "stars" }] },
        state: null,
      });

      assert.ok(result.known_gaps, "expected known_gaps to be present");
      assert.equal(result.known_gaps.length, 1);
      const [gap] = result.known_gaps;
      assert.ok(gap, "expected a known gap entry");
      assert.equal(gap.stream, "stars");
      assert.equal(gap.reason, "not_available");
      assert.equal(gap.severity, "actionable");
    } finally {
      cleanup();
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });
});

test("default-selected supported stream not_available stays actionable", async () => {
  await withRuntimeHarness(async ({ manifest, ownerToken, rsUrl }) => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-gap-supported-"));
    const capturePath = join(tmpDir, "scope.json");
    const { connectorPath, cleanup } = createScopeAwareConnector(capturePath, { itemSkipReason: "not_available" });
    try {
      const result = await runConnector({
        admitRunConnection: fakeAdmitRunConnection(),
        collectionMode: "incremental",
        connectorId: manifest.connector_id,
        connectorPath,
        manifest,
        onInteraction: async () => ({}),
        ownerToken,
        persistState: true,
        rsUrl,
        state: null,
      });

      assert.ok(result.known_gaps, "expected known_gaps to be present");
      assert.equal(result.known_gaps.length, 1);
      const [gap] = result.known_gaps;
      assert.ok(gap, "expected a known gap entry");
      assert.equal(gap.stream, "items");
      assert.equal(gap.reason, "not_available");
      assert.equal(gap.severity, "actionable");
    } finally {
      cleanup();
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });
});

test("transient skip reasons are persisted with transient severity", async () => {
  await withRuntimeHarness(async ({ manifest, ownerToken, rsUrl }) => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-gap-transient-"));
    const capturePath = join(tmpDir, "scope.json");
    const { connectorPath, cleanup } = createScopeAwareConnector(capturePath, { itemSkipReason: "http_429" });
    try {
      const result = await runConnector({
        admitRunConnection: fakeAdmitRunConnection(),
        collectionMode: "incremental",
        connectorId: manifest.connector_id,
        connectorPath,
        manifest,
        onInteraction: async () => ({}),
        ownerToken,
        persistState: true,
        rsUrl,
        state: null,
      });

      assert.ok(result.known_gaps, "expected known_gaps to be present");
      assert.equal(result.known_gaps.length, 1);
      const [gap] = result.known_gaps;
      assert.ok(gap, "expected a known gap entry");
      assert.equal(gap.stream, "items");
      assert.equal(gap.severity, "transient");
    } finally {
      cleanup();
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });
});
