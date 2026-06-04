/**
 * Build-time guardrail: no `options_schema` field name overlaps a
 * `credentials_schema` field name in any manifest. An overlap would allow a
 * secret to be smuggled through the options channel, violating the
 * credential-leakage boundary.
 *
 * Backs OpenSpec `polyfill-runtime`: "A manifest SHALL NOT declare the same
 * field name in both `options_schema` and `credentials_schema`. A build-time
 * honesty check SHALL enforce the no-overlap invariant and SHALL fail with the
 * offending connector name when violated."
 *
 * See openspec/changes/promote-connector-config-schema/specs/polyfill-runtime/spec.md
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MANIFESTS_DIR = join(PACKAGE_ROOT, "manifests");

interface ConfigSchema {
  properties?: Record<string, unknown>;
}

interface ManifestWithConfigSchemas {
  credentials_schema?: ConfigSchema;
  options_schema?: ConfigSchema;
}

function listManifestNames(): string[] {
  return readdirSync(MANIFESTS_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.replace(/\.json$/, ""))
    .sort();
}

function readManifest(name: string): ManifestWithConfigSchemas {
  return JSON.parse(readFileSync(join(MANIFESTS_DIR, `${name}.json`), "utf8")) as ManifestWithConfigSchemas;
}

function propertyKeys(schema: ConfigSchema | undefined): Set<string> {
  return new Set(Object.keys(schema?.properties ?? {}));
}

test("no manifest has overlapping options_schema and credentials_schema field names", () => {
  const offenders: string[] = [];
  for (const name of listManifestNames()) {
    const m = readManifest(name);
    if (!(m.options_schema || m.credentials_schema)) {
      continue;
    }
    const optionFields = propertyKeys(m.options_schema);
    const credentialFields = propertyKeys(m.credentials_schema);
    const overlap = [...optionFields].filter((f) => credentialFields.has(f));
    if (overlap.length > 0) {
      offenders.push(`${name} (overlap: ${overlap.join(", ")})`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "manifests must not declare the same field name in both options_schema and " +
      "credentials_schema — a secret must never be smuggled through the options " +
      `channel: ${offenders.join("; ")}`
  );
});

test("options_schema and credentials_schema properties must have a type declared", () => {
  const offenders: string[] = [];
  for (const name of listManifestNames()) {
    const m = readManifest(name);
    for (const [schemaKey, schema] of [
      ["options_schema", m.options_schema],
      ["credentials_schema", m.credentials_schema],
    ] as const) {
      if (!schema?.properties) {
        continue;
      }
      for (const [field, prop] of Object.entries(schema.properties)) {
        if (typeof (prop as Record<string, unknown>).type === "undefined") {
          offenders.push(`${name}.${schemaKey}.${field} (missing type)`);
        }
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `every options_schema and credentials_schema property must declare a JSON-Schema type: ${offenders.join(", ")}`
  );
});
