// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * P2-1 (final-combined-uat-redteam-0811.md): one malformed registered
 * manifest must not blank the entire owner connector-template projection.
 *
 * `mountOwnerConnectorTemplates`'s projection loop calls `projectTemplate`,
 * which calls `buildConnectionSetupPlan` -> `classifyConnectorSetupModality`
 * -> `staticSecretCredentialCaptureFromManifest`, which can throw for a
 * manifest whose `setup.credential_capture` violates the shared contract
 * (see static-secret-credential-capture.ts). The read loop
 * (`collectConnectorTemplates`) already isolates a per-manifest failure with
 * a try/catch; this suite pins that the projection loop does the same,
 * independent of whatever gate exists at registration time.
 *
 * This test mounts the route directly with a minimal fake `ctx` rather than
 * booting a full server and registering through `/connectors`, because
 * registration now validates this exact shape (see P2-2 /
 * connector-manifest-validation.test.ts) — a malformed manifest can no
 * longer reach storage via that path. Exercising the route in isolation
 * proves the projection loop's own defense holds regardless of how a
 * malformed manifest reached the catalog (e.g. a pre-existing DB row from
 * before this contract existed).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { mountOwnerConnectorTemplates } from "../server/routes/owner-connector-templates.ts";

const VALID_MANIFEST = {
  capabilities: { public_listing: { tier: "supported" } },
  connector_id: "valid-one",
  connector_key: "valid-one",
  display_name: "Valid One",
  setup: { modality: "local_collector" },
  streams: [{ name: "items" }],
};

const OTHER_VALID_MANIFEST = {
  capabilities: { public_listing: { tier: "supported" } },
  connector_id: "valid-two",
  connector_key: "valid-two",
  display_name: "Valid Two",
  setup: { modality: "local_collector" },
  streams: [{ name: "items" }],
};

// Malformed the same way P2-2 rejects at registration: a secret field with
// no label. This manifest reaches `staticSecretCredentialCaptureFromManifest`
// unvalidated here on purpose, to prove the projection loop's own isolation.
const MALFORMED_MANIFEST = {
  capabilities: { public_listing: { tier: "supported" } },
  connector_id: "malformed-one",
  connector_key: "malformed-one",
  display_name: "Malformed One",
  setup: {
    credential_capture: {
      credential_kind: "static_secret",
      fields: [{ name: "password", secret: true }],
    },
  },
  streams: [{ name: "items" }],
};

interface CapturedRoute {
  handler: (req: unknown, res: { json: (body: unknown) => unknown }) => unknown;
}

function mountAndCaptureHandler(manifests: Record<string, unknown>[]): CapturedRoute {
  const byId = new Map(manifests.map((manifest) => [String(manifest.connector_id), manifest]));
  let captured: CapturedRoute["handler"] | null = null;
  const app = {
    get: (_path: string, ...args: unknown[]) => {
      captured = args.at(-1) as CapturedRoute["handler"];
      return app;
    },
  };
  mountOwnerConnectorTemplates(app, {
    canonicalConnectorKey: (value) => (typeof value === "string" && value.trim() ? value.trim() : null),
    createRequestConnectorInstanceStore: () => ({ listByOwner: async () => [] }),
    getConnectorManifest: async (connectorId: string) => byId.get(connectorId) ?? null,
    getOwnerTokenSubjectId: () => "owner_local",
    handleError: (res: unknown, err: unknown) => {
      (res as { json: (body: unknown) => unknown }).json({ error: String(err) });
    },
    listRegisteredConnectorIds: async () => Array.from(byId.keys()),
    projectStorageDisplayName: (displayName) => displayName ?? null,
    requireOwner: (...args: unknown[]) => (args[2] as () => void)(),
    requireToken: (...args: unknown[]) => (args[2] as () => void)(),
    resolveResource: () => "http://localhost",
  });
  assert.ok(captured, "route handler must be captured");
  return { handler: captured as CapturedRoute["handler"] };
}

async function invoke(handler: CapturedRoute["handler"]): Promise<unknown> {
  let body: unknown = null;
  await handler(
    { tokenInfo: { subject_id: "owner_local" } },
    {
      json: (value: unknown) => {
        body = value;
        return value;
      },
    }
  );
  return body;
}

test("one malformed registered manifest among valid ones does not blank the projection (fail-before/pass-after)", async () => {
  const { handler } = mountAndCaptureHandler([VALID_MANIFEST, MALFORMED_MANIFEST, OTHER_VALID_MANIFEST]);
  const body = await invoke(handler);
  const { data } = body as { data: Array<{ connector_key: string }> };

  assert.ok(Array.isArray(data), "response must still list templates, not blank the whole list");
  const keys = data.map((item) => item.connector_key).sort((left, right) => left.localeCompare(right));
  assert.deepEqual(keys, ["valid-one", "valid-two"], "valid templates remain visible; malformed one is dropped");
});

test("all-valid manifests project without loss (pass-after baseline)", async () => {
  const { handler } = mountAndCaptureHandler([VALID_MANIFEST, OTHER_VALID_MANIFEST]);
  const body = await invoke(handler);
  const { data } = body as { data: Array<{ connector_key: string }> };

  const keys = data.map((item) => item.connector_key).sort((left, right) => left.localeCompare(right));
  assert.deepEqual(keys, ["valid-one", "valid-two"]);
});
