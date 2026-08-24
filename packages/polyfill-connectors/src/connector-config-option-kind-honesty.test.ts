// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Build-time guardrail: a manifest's options_schema[key].declared_option_kind
 * must agree with the platform's registered classification
 * (connector-config-option-kind-registry.ts) wherever both exist.
 *
 * Proves D10 ("qualification is proven, never self-declared") for config
 * options specifically: a connector cannot widen its own eligibility by
 * mislabeling a collection-shaping knob as merely "transport" (which the
 * config store self-activates without owner confirmation), because a
 * disagreement fails the build rather than silently trusting the
 * manifest's claim at runtime.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { platformOptionKind } from "./connector-config-option-kind-registry.ts";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MANIFESTS_DIR = join(PACKAGE_ROOT, "manifests");

interface OptionsSchemaProperty {
  declared_option_kind?: string;
  type?: string;
}

interface ManifestWithOptionsSchema {
  connector_key?: string;
  options_schema?: { properties?: Record<string, OptionsSchemaProperty> };
}

function listManifestNames(): string[] {
  return readdirSync(MANIFESTS_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.replace(/\.json$/, ""))
    .sort();
}

function readManifest(name: string): ManifestWithOptionsSchema {
  return JSON.parse(readFileSync(join(MANIFESTS_DIR, `${name}.json`), "utf8")) as ManifestWithOptionsSchema;
}

test("no manifest's declared_option_kind disagrees with the platform-owned registry", () => {
  const offenders: string[] = [];
  for (const name of listManifestNames()) {
    const manifest = readManifest(name);
    const connectorKey = manifest.connector_key ?? name;
    const properties = manifest.options_schema?.properties;
    if (!properties) {
      continue;
    }
    for (const [optionKey, prop] of Object.entries(properties)) {
      const declared = prop.declared_option_kind;
      if (!declared) {
        continue;
      }
      const platformKind = platformOptionKind(connectorKey, optionKey);
      if (platformKind && platformKind !== declared) {
        offenders.push(
          `${name}.options_schema.${optionKey}: manifest declares "${declared}" but the platform registry ` +
            `requires "${platformKind}"`
        );
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `a connector must not self-declare a more permissive option_kind than the platform registry allows: ${offenders.join("; ")}`
  );
});

/**
 * The disagreement check above compares only where BOTH sides know a key, so a
 * lookup that returns null slips past it silently. That is exactly what
 * happened: manifests carry the hyphenated `connector_key` (`claude-code`)
 * while the registry is keyed on the directory form (`claude_code`), so every
 * lookup missed and all five options fell through to the `collection_scope`
 * default. Safe, but the registry's decisions were dead letters and the
 * honesty test had nothing to compare -- a guard blind to its own blind spot.
 *
 * This pins the missing invariant: if a manifest bothered to declare a kind,
 * the platform must actually HAVE an opinion to check it against.
 */
test("every manifest-declared option_kind resolves to a real platform registry entry", () => {
  const unmatched: string[] = [];
  for (const name of listManifestNames()) {
    const manifest = readManifest(name);
    const connectorKey = manifest.connector_key ?? name;
    const properties = manifest.options_schema?.properties;
    if (!properties) {
      continue;
    }
    for (const [optionKey, prop] of Object.entries(properties)) {
      if (!prop.declared_option_kind) {
        continue;
      }
      if (platformOptionKind(connectorKey, optionKey) === null) {
        unmatched.push(`${name} (connector_key "${connectorKey}").options_schema.${optionKey}`);
      }
    }
  }
  assert.deepEqual(
    unmatched,
    [],
    `a declared option_kind the registry cannot resolve is unenforceable and silently unverified: ${unmatched.join("; ")}`
  );
});

test(
  "sanity: the disagreement check actually fires when a manifest mislabels a known collection_scope key as transport",
  () => {
    const hostileManifest: ManifestWithOptionsSchema = {
      connector_key: "slack",
      options_schema: {
        properties: {
          // The real slack.json declares CHANNEL_ALLOWLIST as
          // collection_scope; a hostile manifest claiming "transport" here
          // would let it self-activate without owner confirmation.
          CHANNEL_ALLOWLIST: { type: "array", declared_option_kind: "transport" },
        },
      },
    };
    const platformKind = platformOptionKind("slack", "CHANNEL_ALLOWLIST");
    assert.equal(platformKind, "collection_scope");
    const declared = hostileManifest.options_schema?.properties?.CHANNEL_ALLOWLIST?.declared_option_kind;
    assert.notEqual(declared, platformKind, "the sanity fixture itself must disagree with the registry, or this test proves nothing");
  }
);
