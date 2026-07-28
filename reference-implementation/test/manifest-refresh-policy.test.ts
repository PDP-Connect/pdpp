const TOP_LEVEL_REGEX_1 = /interaction_posture/;
const TOP_LEVEL_REGEX_2 = /refresh_policy/;
const TOP_LEVEL_REGEX_3 = /recommended_mode/;
const TOP_LEVEL_REGEX_4 = /recommended_mode/;
const TOP_LEVEL_REGEX_5 = /rationale/;
const TOP_LEVEL_REGEX_6 = /recommended_interval_seconds/;
const TOP_LEVEL_REGEX_7 = /minimum_interval_seconds/;
const TOP_LEVEL_REGEX_8 = /background_safe/;
const TOP_LEVEL_REGEX_9 = /assisted_after_owner_auth/;
const TOP_LEVEL_REGEX_10 = /rate_limit_sensitivity/;
const TOP_LEVEL_REGEX_11 = /retry_after_seconds/;

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Validation coverage for `capabilities.refresh_policy` declarations.
 *
 * `refresh_policy` is reference/polyfill metadata, not finalized PDPP core
 * protocol. The reference's connector registry validator should accept
 * conservative declarations and reject obviously malformed ones so connector
 * authors get fast feedback instead of silently shipping bad scheduling
 * hints. See:
 *   openspec/changes/add-connector-refresh-policy-controls/specs/polyfill-runtime/spec.md
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

function makeManifest({ connectorIdSuffix, refreshPolicy }: { connectorIdSuffix: string; refreshPolicy?: unknown }) {
  const manifest: {
    protocol_version: string;
    connector_id: string;
    version: string;
    display_name: string;
    runtime_requirements: { bindings: { network: { required: boolean } } };
    streams: unknown[];
    capabilities?: { refresh_policy: unknown };
  } = {
    connector_id: `https://registry.pdpp.test/connectors/refresh-policy-${connectorIdSuffix}`,
    display_name: "Refresh policy fixture",
    protocol_version: "0.1.0",
    runtime_requirements: { bindings: { network: { required: true } } },
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
  if (refreshPolicy !== undefined) {
    manifest.capabilities = { refresh_policy: refreshPolicy };
  }
  return manifest;
}

test("manifest without capabilities still registers (refresh_policy is optional)", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(asUrl, makeManifest({ connectorIdSuffix: "absent" }));
    assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
  });
});

test("valid full refresh_policy is accepted", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({
        connectorIdSuffix: "full-valid",
        refreshPolicy: {
          assisted_after_owner_auth: true,
          background_safe: true,
          bot_detection_sensitivity: "low",
          interaction_posture: "credentials",
          maximum_staleness_seconds: 3600,
          minimum_interval_seconds: 300,
          rate_limit_sensitivity: "low",
          rationale: "Durable credentials, low rate-limit risk.",
          recommended_interval_seconds: 900,
          recommended_mode: "automatic",
          session_lifetime_seconds: 1800,
        },
      })
    );
    assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
  });
});

test("minimal valid refresh_policy (mode + rationale) is accepted", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status } = await registerConnectorManifest(
      asUrl,
      makeManifest({
        connectorIdSuffix: "minimal-valid",
        refreshPolicy: {
          rationale: "Bank login requires owner attention.",
          recommended_mode: "manual",
        },
      })
    );
    assert.equal(status, 201);
  });
});

test("refresh_policy missing recommended_mode is rejected", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({
        connectorIdSuffix: "missing-mode",
        refreshPolicy: { rationale: "No mode declared." },
      })
    );
    assert.equal(status, 400);
    assert.ok(hasErrorBody(body));
    assert.equal(body.error.code, "invalid_request");
    assert.match(body.error.message, TOP_LEVEL_REGEX_3);
  });
});

test("refresh_policy with unknown recommended_mode is rejected", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({
        connectorIdSuffix: "bad-mode",
        refreshPolicy: {
          rationale: "Made-up mode.",
          recommended_mode: "frequent",
        },
      })
    );
    assert.equal(status, 400);
    assert.ok(hasErrorBody(body));
    assert.equal(body.error.code, "invalid_request");
    assert.match(body.error.message, TOP_LEVEL_REGEX_4);
  });
});

test("refresh_policy missing rationale is rejected", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({
        connectorIdSuffix: "missing-rationale",
        refreshPolicy: { recommended_mode: "automatic" },
      })
    );
    assert.equal(status, 400);
    assert.ok(hasErrorBody(body));
    assert.equal(body.error.code, "invalid_request");
    assert.match(body.error.message, TOP_LEVEL_REGEX_5);
  });
});

test("refresh_policy interval seconds must be positive integers", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({
        connectorIdSuffix: "bad-interval",
        refreshPolicy: {
          rationale: "Zero interval.",
          recommended_interval_seconds: 0,
          recommended_mode: "automatic",
        },
      })
    );
    assert.equal(status, 400);
    assert.ok(hasErrorBody(body));
    assert.equal(body.error.code, "invalid_request");
    assert.match(body.error.message, TOP_LEVEL_REGEX_6);
  });
});

test("refresh_policy recommended_interval_seconds must be >= minimum_interval_seconds", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({
        connectorIdSuffix: "recommended-below-minimum",
        refreshPolicy: {
          minimum_interval_seconds: 300,
          rationale: "Recommended below minimum.",
          recommended_interval_seconds: 60,
          recommended_mode: "automatic",
        },
      })
    );
    assert.equal(status, 400);
    assert.ok(hasErrorBody(body));
    assert.equal(body.error.code, "invalid_request");
    assert.match(body.error.message, TOP_LEVEL_REGEX_7);
  });
});

test("refresh_policy with unknown interaction_posture is rejected", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({
        connectorIdSuffix: "bad-posture",
        refreshPolicy: {
          interaction_posture: "biometric_likely",
          rationale: "Made-up posture.",
          recommended_mode: "automatic",
        },
      })
    );
    assert.equal(status, 400);
    assert.ok(hasErrorBody(body));
    assert.equal(body.error.code, "invalid_request");
    assert.match(body.error.message, TOP_LEVEL_REGEX_1);
  });
});

test("refresh_policy with non-boolean background_safe is rejected", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({
        connectorIdSuffix: "bad-background-safe",
        refreshPolicy: {
          background_safe: "yes",
          rationale: "String instead of boolean.",
          recommended_mode: "automatic",
        },
      })
    );
    assert.equal(status, 400);
    assert.ok(hasErrorBody(body));
    assert.equal(body.error.code, "invalid_request");
    assert.match(body.error.message, TOP_LEVEL_REGEX_8);
  });
});

test("refresh_policy with non-boolean assisted_after_owner_auth is rejected", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({
        connectorIdSuffix: "bad-assisted-after-owner-auth",
        refreshPolicy: {
          assisted_after_owner_auth: "yes",
          rationale: "String instead of boolean.",
          recommended_mode: "automatic",
        },
      })
    );
    assert.equal(status, 400);
    assert.ok(hasErrorBody(body));
    assert.equal(body.error.code, "invalid_request");
    assert.match(body.error.message, TOP_LEVEL_REGEX_9);
  });
});

test("refresh_policy with unknown sensitivity level is rejected", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({
        connectorIdSuffix: "bad-sensitivity",
        refreshPolicy: {
          rate_limit_sensitivity: "extreme",
          rationale: "Made-up sensitivity level.",
          recommended_mode: "automatic",
        },
      })
    );
    assert.equal(status, 400);
    assert.ok(hasErrorBody(body));
    assert.equal(body.error.code, "invalid_request");
    assert.match(body.error.message, TOP_LEVEL_REGEX_10);
  });
});

test("refresh_policy with unknown keys is rejected", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({
        connectorIdSuffix: "unknown-key",
        refreshPolicy: {
          rationale: "Unknown key declared.",
          recommended_mode: "automatic",
          retry_after_seconds: 60,
        },
      })
    );
    assert.equal(status, 400);
    assert.ok(hasErrorBody(body));
    assert.equal(body.error.code, "invalid_request");
    assert.match(body.error.message, TOP_LEVEL_REGEX_11);
  });
});

test("non-object refresh_policy is rejected", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({
        connectorIdSuffix: "array-policy",
        refreshPolicy: ["automatic"],
      })
    );
    assert.equal(status, 400);
    assert.ok(hasErrorBody(body));
    assert.equal(body.error.code, "invalid_request");
    assert.match(body.error.message, TOP_LEVEL_REGEX_2);
  });
});
