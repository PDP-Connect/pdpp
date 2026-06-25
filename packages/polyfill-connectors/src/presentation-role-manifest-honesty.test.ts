import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

interface JsonSchema {
  type?: string | string[];
  x_pdpp_role?: string;
}

interface ManifestStream {
  name?: string;
  schema?: {
    properties?: Record<string, JsonSchema>;
  };
}

interface ConnectorManifest {
  connector_key?: string;
  streams?: ManifestStream[];
}

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MANIFESTS_DIR = join(PACKAGE_ROOT, "manifests");

const FIELD_ROLES = new Set(["primary-title", "secondary", "event-time", "actor", "amount", "media"]);
const STRING_ROLES = new Set(["primary-title", "secondary", "actor", "media"]);

function schemaTypes(schema: JsonSchema): string[] {
  const type = schema.type;
  if (typeof type === "string") {
    return [type];
  }
  if (Array.isArray(type)) {
    return type.filter((entry): entry is string => typeof entry === "string");
  }
  return [];
}

function manifestFiles(): string[] {
  return readdirSync(MANIFESTS_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

function readManifest(file: string): ConnectorManifest {
  return JSON.parse(readFileSync(join(MANIFESTS_DIR, file), "utf8")) as ConnectorManifest;
}

test("connector manifest streams declare presentation roles for model and UI surfaces", () => {
  const violations: string[] = [];

  for (const file of manifestFiles()) {
    const manifest = readManifest(file);
    const connectorKey = manifest.connector_key ?? file.replace(/\.json$/, "");

    for (const stream of manifest.streams ?? []) {
      const streamName = stream.name ?? "<unnamed>";
      const roleEntries = Object.entries(stream.schema?.properties ?? {}).flatMap(([field, schema]) => {
        const role = schema.x_pdpp_role;
        return typeof role === "string" && role.length > 0 ? [{ field, role }] : [];
      });

      if (roleEntries.length === 0) {
        violations.push(`${connectorKey}.${streamName}: no schema.properties[field].x_pdpp_role declarations`);
        continue;
      }

      for (const { field, role } of roleEntries) {
        if (!FIELD_ROLES.has(role)) {
          violations.push(`${connectorKey}.${streamName}.${field}: unknown x_pdpp_role="${role}"`);
        }
        const types = schemaTypes(stream.schema?.properties?.[field] ?? {});
        const stringCompatible = types.includes("string") || (role === "actor" && types.includes("array"));
        if (STRING_ROLES.has(role) && !stringCompatible) {
          violations.push(`${connectorKey}.${streamName}.${field}: x_pdpp_role="${role}" requires a string field`);
        }
      }

      const primaryTitleCount = roleEntries.filter(({ role }) => role === "primary-title").length;
      if (primaryTitleCount > 1) {
        violations.push(`${connectorKey}.${streamName}: declares ${primaryTitleCount} primary-title fields`);
      }
    }
  }

  assert.deepEqual(violations, []);
});
