const TOP_LEVEL_REGEX_1 = /detect has unsupported keys: command/u;
const TOP_LEVEL_REGEX_2 = /detect\.args must be an array of strings/u;
const TOP_LEVEL_REGEX_3 = /external_tools must be an array/u;
const TOP_LEVEL_REGEX_4 = /purpose must be a non-empty string/u;
const TOP_LEVEL_REGEX_5 = /detect\.executable must be a non-empty string/u;

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Validation coverage for connector `runtime_requirements.external_tools`.
 *
 * External subprocess tools are static deployment/supply-chain metadata.
 * The registry validates structured detection metadata; runtime readiness
 * executes detectors without a shell.
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

function makeManifest(externalTools: unknown) {
  return {
    connector_id: "https://registry.pdpp.test/connectors/external-tools-fixture",
    display_name: "External tools fixture",
    protocol_version: "0.1.0",
    runtime_requirements: {
      bindings: { network: { required: true } },
      external_tools: externalTools,
    },
    streams: [
      {
        cursor_field: "received_at",
        name: "notes",
        primary_key: ["id"],
        schema: {
          properties: {
            id: { type: "string" },
            received_at: { format: "date-time", type: "string" },
          },
          required: ["id", "received_at"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
    ],
    version: "0.1.0",
  };
}

test("valid external tool declaration is accepted", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest([
        {
          detect: { args: ["version"], executable: "slackdump", exit_code: 0 },
          install_hint: "go install github.com/rusq/slackdump/v4/cmd/slackdump@latest",
          license: "AGPL-3.0",
          name: "slackdump",
          purpose: "Session-token Slack archive export",
        },
      ])
    );
    assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
  });
});

test("external_tools must be an array", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(asUrl, makeManifest({ name: "slackdump" }));
    assert.equal(status, 400);
    assert.ok(hasErrorBody(body));
    assert.equal(body.error.code, "invalid_request");
    assert.match(body.error.message, TOP_LEVEL_REGEX_3);
  });
});

test("external tool declarations require name license and purpose", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest([{ license: "AGPL-3.0", name: "slackdump" }])
    );
    assert.equal(status, 400);
    assert.ok(hasErrorBody(body));
    assert.equal(body.error.code, "invalid_request");
    assert.match(body.error.message, TOP_LEVEL_REGEX_4);
  });
});

test("external tool detect executable must be a non-empty string", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest([
        {
          detect: { executable: "", exit_code: 0 },
          license: "AGPL-3.0",
          name: "slackdump",
          purpose: "Session-token Slack archive export",
        },
      ])
    );
    assert.equal(status, 400);
    assert.ok(hasErrorBody(body));
    assert.equal(body.error.code, "invalid_request");
    assert.match(body.error.message, TOP_LEVEL_REGEX_5);
  });
});

test("external tool legacy detect command is rejected", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest([
        {
          detect: { command: "slackdump version", exit_code: 0 },
          license: "AGPL-3.0",
          name: "slackdump",
          purpose: "Session-token Slack archive export",
        },
      ])
    );
    assert.equal(status, 400);
    assert.ok(hasErrorBody(body));
    assert.equal(body.error.code, "invalid_request");
    assert.match(body.error.message, TOP_LEVEL_REGEX_1);
  });
});

test("external tool detect args must be strings", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest([
        {
          detect: { args: ["version", 1], executable: "slackdump", exit_code: 0 },
          license: "AGPL-3.0",
          name: "slackdump",
          purpose: "Session-token Slack archive export",
        },
      ])
    );
    assert.equal(status, 400);
    assert.ok(hasErrorBody(body));
    assert.equal(body.error.code, "invalid_request");
    assert.match(body.error.message, TOP_LEVEL_REGEX_2);
  });
});
