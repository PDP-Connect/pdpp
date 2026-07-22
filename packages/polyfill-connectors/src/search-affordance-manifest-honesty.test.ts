// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

interface JsonSchema {
  enum?: unknown[];
  maxLength?: number;
  type?: string | string[];
}

interface ManifestStream {
  name?: string;
  query?: {
    search?: {
      lexical_fields?: string[];
      semantic_fields?: string[];
    };
  };
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

const LEXICAL_FIELD_NAMES = new Set([
  "about",
  "author",
  "bio",
  "body",
  "body_text",
  "caption",
  "comment",
  "comments",
  "company",
  "content",
  "content_markdown",
  "description",
  "display_name",
  "fallback",
  "first_name",
  "from",
  "full_name",
  "headline",
  "instructions",
  "last_name",
  "location",
  "memo",
  "message",
  "name",
  "note",
  "notes",
  "position",
  "purpose",
  "real_name",
  "sender",
  "snippet",
  "subject",
  "summary",
  "text",
  "title",
  "to",
  "topic",
  "transcript",
  "username",
]);

const SEMANTIC_FIELD_NAMES = new Set([
  "about",
  "bio",
  "body",
  "body_text",
  "caption",
  "comment",
  "comments",
  "content",
  "content_markdown",
  "description",
  "fallback",
  "headline",
  "instructions",
  "memo",
  "message",
  "note",
  "notes",
  "purpose",
  "snippet",
  "subject",
  "summary",
  "text",
  "title",
  "topic",
  "transcript",
]);

const NON_TEXT_FIELD_NAME =
  /(^id$|_id$|id$|url|uri|href|link|path|sha|hash|email|phone|address|type$|status|code|token|currency|locale|timezone|mime|content_type|created|updated|date|time|ts$|at$|count|bytes|size|ordinal|index|version|etag|key$|ref$|fingerprint)/i;

function manifestFiles(): string[] {
  return readdirSync(MANIFESTS_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

function readManifest(file: string): ConnectorManifest {
  return JSON.parse(readFileSync(join(MANIFESTS_DIR, file), "utf8")) as ConnectorManifest;
}

function schemaTypes(schema: JsonSchema | undefined): string[] {
  const type = schema?.type;
  if (typeof type === "string") {
    return [type];
  }
  if (Array.isArray(type)) {
    return type.filter((entry): entry is string => typeof entry === "string");
  }
  return [];
}

function isSearchableStringSchema(schema: JsonSchema | undefined): boolean {
  return schemaTypes(schema).includes("string");
}

function fieldShouldBeLexical(field: string, schema: JsonSchema): boolean {
  return isSearchableStringSchema(schema) && !NON_TEXT_FIELD_NAME.test(field) && LEXICAL_FIELD_NAMES.has(field);
}

function fieldShouldBeSemantic(field: string, schema: JsonSchema): boolean {
  return (
    isSearchableStringSchema(schema) &&
    !NON_TEXT_FIELD_NAME.test(field) &&
    (SEMANTIC_FIELD_NAMES.has(field) || (typeof schema.maxLength === "number" && schema.maxLength >= 1024))
  );
}

test("connector manifests declare search for owner-visible natural-language string fields", () => {
  const violations: string[] = [];

  for (const file of manifestFiles()) {
    const manifest = readManifest(file);
    const connectorKey = manifest.connector_key ?? file.replace(/\.json$/, "");

    for (const stream of manifest.streams ?? []) {
      const streamName = stream.name ?? "<unnamed>";
      const properties = stream.schema?.properties ?? {};
      const lexicalFields = new Set(stream.query?.search?.lexical_fields ?? []);
      const semanticFields = new Set(stream.query?.search?.semantic_fields ?? []);

      for (const field of [...lexicalFields, ...semanticFields]) {
        if (!isSearchableStringSchema(properties[field])) {
          violations.push(
            `${connectorKey}.${streamName}.${field}: search field is not a top-level string schema field`
          );
        }
      }

      for (const [field, schema] of Object.entries(properties)) {
        if (fieldShouldBeLexical(field, schema) && !lexicalFields.has(field)) {
          violations.push(
            `${connectorKey}.${streamName}.${field}: natural-language field is missing query.search.lexical_fields`
          );
        }
        if (fieldShouldBeSemantic(field, schema) && !semanticFields.has(field)) {
          violations.push(
            `${connectorKey}.${streamName}.${field}: natural-language field is missing query.search.semantic_fields`
          );
        }
      }
    }
  }

  assert.deepEqual(violations, []);
});
