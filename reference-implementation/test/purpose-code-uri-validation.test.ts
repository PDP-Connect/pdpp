// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pins the AS purpose_code syntax contract (spec-core.md:428): a purpose_code
// MUST be a syntactically valid absolute URI; the AS rejects malformed/non-URI
// codes, but MUST NOT reject a code merely for being unrecognized (registry
// membership is advisory). Drives normalizeAuthorizationDetail via initiateGrant.

import assert from "node:assert/strict";
import { test } from "node:test";
import { initiateGrant, registerConnector, registerDynamicClient } from "../server/auth.ts";
import { initDb } from "../server/db.ts";

const TOP_LEVEL_REGEX_1 = /purpose_code/;
const CONNECTOR_ID = "demo";
const SOURCE_ID = "https://registry.pdpp.dev/connectors/demo";

let registeredClientId: string | null = null;

function isCodedError(error: unknown): error is Error & { code?: string } {
  return error instanceof Error && (!("code" in error) || typeof error.code === "string" || error.code === undefined);
}

const MANIFEST = {
  connector_id: CONNECTOR_ID,
  source_declaration: {
    declaration_version: "purpose-code-test.v1",
    display: { name: "Purpose Code Test" },
    protocol_version: "0.1.0",
    publisher: { id: "https://pdpp.dev/reference-implementation" },
    source: { id: SOURCE_ID, kind: "connector" },
    streams: [
      {
        name: "items",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, type: "object" },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
    ],
  },
  streams: [
    {
      name: "items",
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" } }, type: "object" },
      selection: { fields: true },
    },
  ],
  version: "1.0.0",
};

function baseRequest(purposeCode: string): Record<string, unknown> {
  return {
    authorization_details: [
      {
        access_mode: "single_use",
        purpose_code: purposeCode,
        purpose_description: "purpose-code syntax coverage",
        source: { id: SOURCE_ID, kind: "connector" },
        streams: [{ fields: ["id"], name: "items" }],
        type: "https://pdpp.dev/data-access",
      },
    ],
    client_id: registeredClientId,
  };
}

async function purposeCodeOutcome(
  purposeCode: string
): Promise<{ ok: boolean; code: string | undefined; message: string }> {
  initDb(":memory:");
  await registerConnector(MANIFEST);
  const reg = await registerDynamicClient({
    client_name: "purpose-code-test",
    redirect_uris: ["https://example.com/cb"],
  });
  if (typeof reg.client_id !== "string") {
    throw new Error("dynamic registration must return a client_id");
  }
  registeredClientId = reg.client_id;
  try {
    await initiateGrant(baseRequest(purposeCode));
    return { code: undefined, message: "", ok: true };
  } catch (err: unknown) {
    if (isCodedError(err)) {
      return { code: err.code, message: err.message, ok: false };
    }
    return { code: undefined, message: String(err), ok: false };
  }
}

test("a recognized absolute-URI purpose_code is accepted", async () => {
  const out = await purposeCodeOutcome("https://pdpp.dev/purpose/analytics");
  assert.equal(out.ok, true, `expected accept, got ${JSON.stringify(out)}`);
});

test("an UNKNOWN absolute-URI purpose_code is still accepted (registry is advisory)", async () => {
  const out = await purposeCodeOutcome("https://example.com/purpose/brand-new-unregistered");
  assert.equal(out.ok, true, `unknown absolute URIs must not be rejected: ${JSON.stringify(out)}`);
});

test("a bare non-URI purpose_code is rejected with source.authorization_details_invalid", async () => {
  const out = await purposeCodeOutcome("analytics");
  assert.equal(out.ok, false, "bare token must be rejected");
  assert.equal(out.code, "source.authorization_details_invalid");
  assert.match(out.message, TOP_LEVEL_REGEX_1);
});

test("a dotted non-URI purpose_code is rejected", async () => {
  const out = await purposeCodeOutcome("assist.summarize");
  assert.equal(out.ok, false);
  assert.equal(out.code, "source.authorization_details_invalid");
});
