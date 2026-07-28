// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Mutation-killing coverage for the `manual_upload_artifact_not_found` typed-
 * error code (server/routes/ref-manual-upload-draft-connection.ts).
 *
 * `GET /_ref/manual-upload/artifacts/:artifactId` returns HTTP 404 with code
 * `manual_upload_artifact_not_found` in two distinct situations:
 *   1. the artifactId does not match the `mua_[A-Za-z0-9_-]+` id shape
 *      (rejected before any store lookup), and
 *   2. the id is well-formed but no artifact exists for it (or it belongs to a
 *      different owner) — a fail-closed existence check that never leaks whether
 *      the id exists under another owner.
 *
 * No `test/` file exercised `manual_upload_artifact_not_found` by name, so a
 * mutation dropping either 404 branch (e.g. 200-ing a missing artifact) or
 * corrupting the code string went undetected. This test pins both branches.
 *
 * Owner auth is left disabled so the owner session auto-passes and the only
 * thing under test is the artifact-existence / id-shape guard.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { startServer } from "../server/index.ts";

type StartedServer = Awaited<ReturnType<typeof startServer>>;
type StoppableServer = StartedServer["asServer"] | StartedServer["rsServer"];

interface ErrorEnvelope {
  error: { code: string; type: string };
}

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

test("GET manual-upload artifact 404s with manual_upload_artifact_not_found for missing/malformed ids", async () => {
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;

  const cases = [
    // Well-formed id shape, but no such artifact exists -> store-miss branch.
    { id: "mua_doesnotexist12345", label: "well-formed but nonexistent" },
    // Id fails the `mua_...` shape regex -> pre-lookup reject branch.
    { id: "not-a-valid-id", label: "malformed id shape" },
    // Decodes to contain a space, which the id regex rejects.
    { id: "mua_%20bad", label: "id with disallowed char" },
  ];

  try {
    for (const { label, id } of cases) {
      // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
      const resp = await fetch(`${asUrl}/_ref/manual-upload/artifacts/${id}`, {
        headers: { Accept: "application/json" },
        redirect: "manual",
      });
      assert.equal(resp.status, 404, `${label}: SHALL be 404`);
      const body = (await resp.json()) as ErrorEnvelope;
      assert.equal(
        body.error.code,
        "manual_upload_artifact_not_found",
        `${label}: SHALL carry manual_upload_artifact_not_found`
      );
      assert.equal(body.error.type, "not_found_error", `${label}: 404 envelope type`);
    }
  } finally {
    await closeServer(server);
  }
});
