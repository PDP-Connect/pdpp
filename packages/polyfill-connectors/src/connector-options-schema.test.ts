// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Covers `connector-options-schema.ts`, whose job is to merge a
 * connector-owned SHAPE with a platform-owned KIND.
 *
 * The load-bearing tests are the guardrail ones: a manifest must not be
 * able to make a collection-shaping option self-activating no matter how it
 * is written. Those are stated as "however the manifest is written" --
 * each hostile fixture writes `declared_option_kind: "transport"` a
 * different way and every one must still resolve to `collection_scope`.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { platformOptionKind } from "./connector-config-option-kind-registry.ts";
import {
  ConnectorOptionsSchemaError,
  connectorOptionsSchema,
  connectorOptionsSchemas,
  resolveOptionsSchemaFromManifest,
} from "./connector-options-schema.ts";

const MANIFESTS_DIR = join(fileURLToPath(import.meta.url), "..", "..", "manifests");

function readRealManifest(key: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(MANIFESTS_DIR, `${key}.json`), "utf8")) as Record<string, unknown>;
}

function optionOf(schema: { options: readonly { optionKey: string }[] } | null, key: string) {
  assert.ok(schema, "expected a resolved schema");
  const found = schema.options.find((option) => option.optionKey === key);
  assert.ok(found, `expected option ${key}`);
  return found as unknown as {
    defaultValue: unknown;
    description: string;
    enumValues: readonly string[] | null;
    maximum: number | null;
    minimum: number | null;
    optionKind: string;
    optionKey: string;
    platformClassified: boolean;
    type: string;
  };
}

/** A manifest whose only distinguishing feature is how it writes its kind claim. */
function manifestClaiming(connectorKey: string, optionKey: string, claim: unknown): Record<string, unknown> {
  const prop: Record<string, unknown> = {
    default: [],
    description: "hostile fixture",
    items: { type: "string" },
    type: "array",
  };
  if (claim !== undefined) {
    prop.declared_option_kind = claim;
  }
  return {
    connector_key: connectorKey,
    options_schema: { properties: { [optionKey]: prop }, type: "object" },
  };
}

// ---------------------------------------------------------------------------
// THE GUARDRAIL
// ---------------------------------------------------------------------------

test("a manifest cannot make a registry-classified collection_scope option self-activating", () => {
  // Precondition: the platform really does classify this key as collection_scope.
  assert.equal(platformOptionKind("slack", "CHANNEL_ALLOWLIST"), "collection_scope");

  // Every way a manifest might try to claim `transport` for it.
  const hostileClaims: unknown[] = [
    "transport",
    "TRANSPORT",
    " transport ",
    ["transport"],
    { kind: "transport" },
    true,
    1,
    null,
    undefined,
  ];

  for (const claim of hostileClaims) {
    const resolved = resolveOptionsSchemaFromManifest(
      manifestClaiming("slack", "CHANNEL_ALLOWLIST", claim),
      "hostile.json"
    );
    const option = optionOf(resolved, "CHANNEL_ALLOWLIST");
    assert.equal(
      option.optionKind,
      "collection_scope",
      `a manifest claiming ${JSON.stringify(claim)} must not win over the platform registry`
    );
  }
});

test("an option the registry does not know fails closed to collection_scope", () => {
  // Precondition: the registry has genuinely never heard of this key.
  assert.equal(platformOptionKind("slack", "TOTALLY_UNKNOWN_KNOB"), null);

  const resolved = resolveOptionsSchemaFromManifest(
    manifestClaiming("slack", "TOTALLY_UNKNOWN_KNOB", "transport"),
    "unknown.json"
  );
  const option = optionOf(resolved, "TOTALLY_UNKNOWN_KNOB");
  assert.equal(option.optionKind, "collection_scope");
  assert.equal(option.platformClassified, false, "an unclassified key must say so, not pose as a platform decision");
});

test("an entirely unregistered connector gets a renderable form in which nothing self-activates", () => {
  assert.equal(platformOptionKind("brand_new_connector", "ANYTHING"), null);

  const resolved = resolveOptionsSchemaFromManifest(
    manifestClaiming("brand_new_connector", "ANYTHING", "transport"),
    "brand_new_connector.json"
  );
  assert.ok(resolved);
  assert.equal(resolved.options.length, 1);
  for (const option of resolved.options) {
    assert.equal(option.optionKind, "collection_scope");
  }
});

test("the registry, not the manifest, is what makes an option transport", () => {
  // SKIP_FILES is registry-classified transport. A manifest claiming
  // `collection_scope` for it does not change that either -- the manifest
  // is not consulted in EITHER direction.
  assert.equal(platformOptionKind("slack", "SKIP_FILES"), "transport");

  const resolved = resolveOptionsSchemaFromManifest(
    {
      connector_key: "slack",
      options_schema: {
        properties: {
          SKIP_FILES: {
            declared_option_kind: "collection_scope",
            default: true,
            description: "hostile fixture",
            type: "boolean",
          },
        },
        type: "object",
      },
    },
    "hostile.json"
  );
  const option = optionOf(resolved, "SKIP_FILES");
  assert.equal(option.optionKind, "transport");
  assert.equal(option.platformClassified, true);
});

// ---------------------------------------------------------------------------
// SHAPE
// ---------------------------------------------------------------------------

test("the real slack manifest resolves to the same fields its code reads", () => {
  // connectors/slack/index.ts readSlackOptions() reads exactly these six.
  const resolved = resolveOptionsSchemaFromManifest(readRealManifest("slack"), "slack.json");
  assert.ok(resolved);
  assert.deepEqual(
    resolved.options.map((option) => option.optionKey),
    ["CHANNEL_ALLOWLIST", "CHANNEL_TYPES", "LOOKBACK_DAYS", "MEMBER_ONLY", "RECLAIM_UPLOADS", "SKIP_FILES"]
  );

  const lookback = optionOf(resolved, "LOOKBACK_DAYS");
  assert.equal(lookback.type, "integer");
  assert.equal(lookback.defaultValue, 7);
  assert.equal(lookback.optionKind, "collection_scope");

  const skipFiles = optionOf(resolved, "SKIP_FILES");
  assert.equal(skipFiles.type, "boolean");
  assert.equal(skipFiles.defaultValue, true);
  assert.equal(skipFiles.optionKind, "transport");

  const channelTypes = optionOf(resolved, "CHANNEL_TYPES");
  assert.equal(channelTypes.type, "string_array");
  assert.deepEqual(channelTypes.defaultValue, ["public", "private", "im", "mpim"]);
  assert.deepEqual(channelTypes.enumValues, ["public", "private", "im", "mpim"]);
});

test("options are sorted by key so a rendered form is order-stable", () => {
  const resolved = resolveOptionsSchemaFromManifest(
    {
      connector_key: "slack",
      options_schema: {
        properties: {
          ZULU: { default: true, description: "z", type: "boolean" },
          ALPHA: { default: true, description: "a", type: "boolean" },
          MIKE: { default: true, description: "m", type: "boolean" },
        },
        type: "object",
      },
    },
    "sort.json"
  );
  assert.ok(resolved);
  assert.deepEqual(
    resolved.options.map((option) => option.optionKey),
    ["ALPHA", "MIKE", "ZULU"]
  );
});

test("a connector declaring no options_schema resolves to null rather than an empty form", () => {
  assert.equal(resolveOptionsSchemaFromManifest({ connector_key: "amazon" }, "amazon.json"), null);
});

test("every shipped manifest that declares an options_schema parses", () => {
  const schemas = connectorOptionsSchemas();
  assert.ok(Object.keys(schemas).length >= 3, "expected the worked examples to be present");
  assert.ok(schemas.slack, "slack is the reference example");
  for (const [connectorKey, schema] of Object.entries(schemas)) {
    assert.equal(schema.connectorKey, connectorKey);
    assert.ok(schema.options.length > 0, `${connectorKey} declared an options_schema with no options`);
  }
});

test("connectorOptionsSchema looks a connector up by key", () => {
  assert.ok(connectorOptionsSchema("slack"));
  assert.equal(connectorOptionsSchema("definitely_not_a_connector"), null);
  assert.equal(connectorOptionsSchema(null), null);
});

// ---------------------------------------------------------------------------
// SHAPE VALIDATION -- reject malformed manifests rather than guessing
// ---------------------------------------------------------------------------

const malformed: ReadonlyArray<readonly [string, Record<string, unknown>, RegExp]> = [
  ["a non-object options_schema", { connector_key: "slack", options_schema: [] }, /must be an object/],
  [
    "a missing properties map",
    { connector_key: "slack", options_schema: { type: "object" } },
    /properties must be an object/,
  ],
  [
    "an unsupported type",
    {
      connector_key: "slack",
      options_schema: { properties: { X: { default: 1, description: "d", type: "number" } }, type: "object" },
    },
    /type must be one of/,
  ],
  [
    "an array without string items",
    {
      connector_key: "slack",
      options_schema: {
        properties: { X: { default: [], description: "d", items: { type: "number" }, type: "array" } },
        type: "object",
      },
    },
    /items\.type "string"/,
  ],
  [
    "a missing default",
    {
      connector_key: "slack",
      options_schema: { properties: { X: { description: "d", type: "boolean" } }, type: "object" },
    },
    /default is required/,
  ],
  [
    "a default of the wrong type",
    {
      connector_key: "slack",
      options_schema: { properties: { X: { default: "yes", description: "d", type: "boolean" } }, type: "object" },
    },
    /default must be a boolean/,
  ],
  [
    "a non-integer default for an integer option",
    {
      connector_key: "slack",
      options_schema: { properties: { X: { default: 1.5, description: "d", type: "integer" } }, type: "object" },
    },
    /default must be an integer/,
  ],
  [
    "a missing description",
    {
      connector_key: "slack",
      options_schema: { properties: { X: { default: true, type: "boolean" } }, type: "object" },
    },
    /description must be a non-empty string/,
  ],
  [
    "an inverted min/max",
    {
      connector_key: "slack",
      options_schema: {
        properties: { X: { default: 5, description: "d", maximum: 1, minimum: 10, type: "integer" } },
        type: "object",
      },
    },
    /minimum 10 exceeds maximum 1/,
  ],
  [
    "an empty enum",
    {
      connector_key: "slack",
      options_schema: {
        properties: { X: { default: "a", description: "d", enum: [], type: "string" } },
        type: "object",
      },
    },
    /enum must be a non-empty array/,
  ],
];

for (const [label, manifest, expected] of malformed) {
  test(`rejects ${label}`, () => {
    assert.throws(
      () => resolveOptionsSchemaFromManifest(manifest, "bad.json"),
      (err: unknown) => err instanceof ConnectorOptionsSchemaError && expected.test((err as Error).message),
      `expected ${label} to be rejected with ${expected}`
    );
  });
}

test("a scratch manifests dir is picked up, so the resolver reads real files not a hardcoded list", () => {
  const scratch = mkdtempSync(join(tmpdir(), "pdpp-options-schema-"));
  writeFileSync(
    join(scratch, "scratch_connector.json"),
    JSON.stringify(manifestClaiming("scratch_connector", "SOME_KNOB", "transport"))
  );
  const previous = process.env.PDPP_POLYFILL_MANIFESTS_DIR;
  process.env.PDPP_POLYFILL_MANIFESTS_DIR = scratch;
  try {
    const schemas = connectorOptionsSchemas();
    assert.deepEqual(Object.keys(schemas), ["scratch_connector"]);
    assert.equal(optionOf(schemas.scratch_connector ?? null, "SOME_KNOB").optionKind, "collection_scope");
  } finally {
    if (previous === undefined) {
      delete process.env.PDPP_POLYFILL_MANIFESTS_DIR;
    } else {
      process.env.PDPP_POLYFILL_MANIFESTS_DIR = previous;
    }
  }
});
