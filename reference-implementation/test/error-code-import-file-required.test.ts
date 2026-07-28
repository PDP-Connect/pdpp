// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Mutation-killing coverage for the `import_file_required` typed-error code
 * (server/routes/ref-manual-upload-draft-connection.ts).
 *
 * The manual-upload validation-preview endpoint requires a non-empty import
 * file body. When the request supplies an accepted `file_name` but an empty
 * body, the route refuses with HTTP 400 and code `import_file_required` rather
 * than proceeding to validate/stage an empty artifact.
 *
 * No `test/` file exercised `import_file_required` by name, so a mutation
 * dropping the empty-body guard (or corrupting the code string) went
 * undetected. This test pins the empty-body branch against a real registered
 * manual-upload connector (`google-maps`) and contrasts it with a non-empty
 * body, which passes the guard and reaches validation instead.
 *
 * Owner auth is left disabled so the owner session auto-passes and the only
 * thing under test is the import-file precondition.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { startServer } from "../server/index.ts";

type StartedServer = Awaited<ReturnType<typeof startServer>>;
type StoppableServer = StartedServer["asServer"] | StartedServer["rsServer"];

function hasCloseAllConnections(server: object): server is { closeAllConnections: () => void } {
  return "closeAllConnections" in server && typeof server.closeAllConnections === "function";
}

async function closeServer(server: StartedServer): Promise<void> {
  const closeOne = (httpServer: StoppableServer) =>
    new Promise<void>((resolve) => {
      if (!httpServer) {
        resolve();
        return;
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve();
        }
      }, 2000);
      if (hasCloseAllConnections(httpServer)) {
        httpServer.closeAllConnections();
      }
      httpServer.close(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      });
    });
  await Promise.allSettled([closeOne(server.asServer), closeOne(server.rsServer)]);
}

interface ConnectorManifest {
  connector_id: string;
  [key: string]: unknown;
}

interface ErrorEnvelope {
  error: { code: string; type: string };
}

function loadManifest(name: string): ConnectorManifest {
  return JSON.parse(
    readFileSync(new URL(`../../packages/polyfill-connectors/manifests/${name}.json`, import.meta.url), "utf8")
  ) as ConnectorManifest;
}

test("manual-upload validation-preview refuses an empty body with import_file_required (400)", async () => {
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const manifest = loadManifest("google_maps");
    const connectorId = manifest.connector_id;
    const register = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(register.status, 201, "connector registration precondition");

    const previewUrl = new URL(`${asUrl}/_ref/connectors/${connectorId}/manual-upload-validation-preview`);
    previewUrl.searchParams.set("file_name", "Timeline.json");

    // Empty body -> import_file_required.
    const empty = await fetch(previewUrl, {
      body: "",
      headers: { Accept: "application/json", "Content-Type": "application/octet-stream" },
      method: "POST",
      redirect: "manual",
    });
    assert.equal(empty.status, 400, "empty body SHALL 400");
    const emptyBody = (await empty.json()) as ErrorEnvelope;
    assert.equal(emptyBody.error.code, "import_file_required");
    assert.equal(emptyBody.error.type, "invalid_request_error", "400 envelope type");

    // Non-empty body -> passes the import-file guard (does NOT report
    // import_file_required; it proceeds to content validation instead).
    const validTimeline = JSON.stringify({
      locations: [{ latitudeE7: 377_749_000, longitudeE7: -1_224_194_000, timestampMs: "1717595122000" }],
    });
    const nonEmpty = await fetch(previewUrl, {
      body: validTimeline,
      headers: { Accept: "application/json", "Content-Type": "application/octet-stream" },
      method: "POST",
      redirect: "manual",
    });
    const nonEmptyBody = (await nonEmpty.json()) as Partial<ErrorEnvelope>;
    assert.notEqual(
      nonEmptyBody.error?.code,
      "import_file_required",
      "a non-empty body SHALL pass the import-file guard"
    );
  } finally {
    await closeServer(server);
  }
});
