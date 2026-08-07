// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it, skip } from "node:test";
import { fileURLToPath } from "node:url";

const CONNECTOR_DIR = dirname(fileURLToPath(import.meta.url));
const MANIFESTS_DIR = join(CONNECTOR_DIR, "..", "..", "manifests");
const MANIFEST_PATH = join(MANIFESTS_DIR, "groupme.json");

interface Manifest {
  capabilities?: {
    human_interaction?: unknown[];
    refresh_policy?: {
      interaction_posture?: string;
    };
  };
  setup?: {
    modality?: string;
    credential_capture?: {
      kind?: string;
      fields?: Array<{
        type?: string;
        secret?: boolean;
        env?: string[];
      }>;
    };
  };
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
}

describe("GroupMe setup contract", () => {
  it("manifest declares static_secret modality wiring to generic UI", () => {
    const manifest = readManifest();
    assert.strictEqual(
      manifest.setup?.modality,
      "static_secret",
      "setup.modality must be 'static_secret' to wire through generic credential-capture UI"
    );
  });

  it("credential_capture declares access_token kind with password field", () => {
    const manifest = readManifest();
    const capture = manifest.setup?.credential_capture;
    assert.ok(capture, "setup.credential_capture must exist");
    assert.strictEqual(capture.kind, "access_token", "credential_capture.kind must be 'access_token'");

    const field = capture.fields?.[0];
    assert.ok(field, "credential_capture.fields must have at least one field");
    assert.strictEqual(field.type, "password", "first field type must be 'password'");
    assert.strictEqual(field.secret, true, "first field secret must be true");
    assert.ok(field.env?.includes("GROUPME_ACCESS_TOKEN"), "field env must include GROUPME_ACCESS_TOKEN");
  });

  it("capabilities declare no human interaction for automatic background safe scheduling", () => {
    const manifest = readManifest();
    const interaction = manifest.capabilities?.human_interaction;
    assert.ok(
      Array.isArray(interaction) && interaction.length === 0,
      "capabilities.human_interaction must be empty array (no re-auth needed)"
    );

    const posture = manifest.capabilities?.refresh_policy?.interaction_posture;
    assert.strictEqual(
      posture,
      "none",
      "refresh_policy.interaction_posture must be 'none' to enable background-safe scheduling"
    );
  });

  const testFn = process.env.GROUPME_ACCESS_TOKEN ? it : skip;

  testFn("live: accepts valid GROUPME_ACCESS_TOKEN via X-Access-Token header", async () => {
    const token = process.env.GROUPME_ACCESS_TOKEN;
    assert.ok(token && token.length > 0, "GROUPME_ACCESS_TOKEN must be non-empty");
    assert.strictEqual(typeof token, "string", "token must be a string");

    const res = await fetch("https://api.groupme.com/v3/users/me", {
      headers: { "X-Access-Token": token },
    });

    assert.strictEqual(
      res.status,
      200,
      `API should accept valid token; got ${res.status}. Verify token at dev.groupme.com/applications`
    );
  });
});
