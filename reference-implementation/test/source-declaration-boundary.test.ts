// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { SourceDeclaration } from "@pdpp/reference-contract/public/source";
import { requireSourceDeclaration, snapshotSourceDeclaration } from "../server/source-declaration.ts";
import {
  COLLECTION_PROFILE_URI,
  snapshotContentAddressedSourceDeclarationFromLegacyConnectorManifest,
  snapshotSourceDeclarationFromLegacyConnectorManifest,
  sourceDeclarationFromLegacyConnectorManifest,
} from "../server/source-declaration-legacy-collection.ts";

const INVALID_DECLARATION_REGEX = /Invalid SourceDeclaration/;
const INVALID_EMBEDDED_SCHEMA_REGEX = /Invalid SourceDeclaration stream schema/;
const NONLOCAL_SCHEMA_REFERENCE_REGEX = /must be a local fragment reference/;
const INVALID_PUBLISHER_REGEX = /publisherId must be an absolute URI/;
const INVALID_SOURCE_REGEX = /sourceId must be an absolute URI/;
const MALFORMED_STREAM_REGEX = /manifest\.streams\[1\] must be an object/;
const IMPORT_REGEX = /from\s+["']([^"']+)["']/g;
const NO_CORE_COLLECTION_REGEX = /collection|legacy|connector-manifest-validation/i;
const RUNTIME_IMPORT_REGEX = /import\s+(?!type\s)[\s\S]*?from\s+["']([^"']+)["']/g;
const SOURCE_CONTRACT_PATH_REGEX = /\/src\/public\/source\.ts$/;
const PROJECTED_DECLARATION_VERSION_REGEX = /^reference\.legacy-connector-projection\.v1:sha256:[0-9a-f]{64}$/;

const query = {
  aggregations: {
    count: true as const,
    count_distinct: ["id"],
    group_by: ["id"],
    group_by_time: ["updated_at"],
    max: ["updated_at"],
    min: ["updated_at"],
    sum: ["score"],
  },
  expand: [{ default_limit: 1, max_limit: 2, name: "children" }],
  range_filters: { updated_at: ["gte" as const, "lt" as const] },
  search: { lexical_fields: ["id"], semantic_fields: ["id"] },
};

const stream = {
  consent_time_field: "updated_at",
  cursor_field: "updated_at",
  description: "Items",
  display: { detail: "Item records", label: "Items" },
  incremental: true,
  name: "items",
  primary_key: ["id"],
  query,
  relationships: [{ cardinality: "has_many" as const, foreign_key: "parent_id", name: "children", stream: "items" }],
  schema: {
    properties: {
      id: { type: "string" },
      parent_id: { type: "string" },
      score: { type: "number" },
      updated_at: { format: "date-time", type: "string" },
    },
    type: "object",
  },
  selection: { fields: true, resources: true },
  semantics: "mutable_state" as const,
  views: [{ fields: ["id", "updated_at"], id: "summary", label: "Summary" }],
};

const legacy = {
  capabilities: { human_interaction: ["credentials"] },
  connector_id: "https://implementations.example/connectors/items",
  connector_key: "items-local-key",
  display_name: "Items",
  profiles: [{ id: "summary", label: "Summary", streams: [{ name: "items", view: "summary" }] }],
  protocol_version: "0.1.0",
  runtime_requirements: { bindings: { network: { required: true } } },
  streams: [stream],
  version: "7.2.0",
};

const attribution = {
  declarationVersion: "accepted-declaration-v1",
  publisherId: "https://local.example/publishers/accepted-connectors",
  sourceId: "https://sources.example/items",
};

function coreDeclaration(kind: "connector" | "provider_native"): SourceDeclaration {
  const { incremental: _incremental, ...commonStream } = stream;
  return {
    declaration_version: "native-v1",
    display: { name: "Items" },
    protocol_version: "0.1.0",
    publisher: { id: "https://local.example/publishers/accepted-sources" },
    source: { id: "https://sources.example/items", kind },
    streams: [commonStream],
  } as SourceDeclaration;
}

test("Core-only connector and provider-native declarations use identical validation", () => {
  const connector = requireSourceDeclaration(coreDeclaration("connector"));
  const native = requireSourceDeclaration(coreDeclaration("provider_native"));
  assert.deepEqual(connector.streams, native.streams);
  assert.equal(connector.extensions, undefined);
  assert.equal(native.extensions, undefined);

  for (const kind of ["connector", "provider_native"] as const) {
    assert.throws(
      () => requireSourceDeclaration({ ...coreDeclaration(kind), source: { id: "items-local", kind } }),
      INVALID_DECLARATION_REGEX
    );
  }
});

test("embedded stream schemas are valid 2020-12 schemas with local references", () => {
  const malformed = coreDeclaration("connector");
  const [malformedStream] = malformed.streams;
  assert.ok(malformedStream);
  malformed.streams[0] = {
    ...malformedStream,
    schema: { properties: { id: { type: "string" } }, type: "bananas" },
  };
  assert.throws(() => requireSourceDeclaration(malformed), INVALID_EMBEDDED_SCHEMA_REGEX);

  const remoteReference = coreDeclaration("provider_native");
  const [remoteReferenceStream] = remoteReference.streams;
  assert.ok(remoteReferenceStream);
  remoteReference.streams[0] = {
    ...remoteReferenceStream,
    schema: {
      properties: { id: { $ref: "https://schemas.example/identity.json" } },
      type: "object",
    },
  };
  assert.throws(() => requireSourceDeclaration(remoteReference), NONLOCAL_SCHEMA_REFERENCE_REGEX);

  const localReference = coreDeclaration("connector");
  const [localReferenceStream] = localReference.streams;
  assert.ok(localReferenceStream);
  localReference.streams[0] = {
    ...localReferenceStream,
    schema: {
      $defs: { identifier: { type: "string" } },
      ...localReferenceStream.schema,
      properties: {
        ...(localReferenceStream.schema.properties as Record<string, unknown>),
        local_id: { $ref: "#/$defs/identifier" },
      },
      type: "object",
    },
  };
  assert.doesNotThrow(() => requireSourceDeclaration(localReference));
});

test("trusted native declaration stays in parity with duplicated serving metadata", () => {
  const nativeManifest = JSON.parse(
    readFileSync(fileURLToPath(new URL("../fixtures/seed-manifests/northstar-hr.json", import.meta.url)), "utf8")
  ) as Record<string, unknown>;
  const declaration = requireSourceDeclaration(nativeManifest.source_declaration);
  assert.deepEqual(declaration.source, {
    id: nativeManifest.provider_id,
    kind: "provider_native",
  });

  const servingStreams = nativeManifest.streams as Record<string, unknown>[];
  assert.deepEqual(
    declaration.streams.map((declarationStream) => declarationStream.name),
    servingStreams.map((servingStream) => servingStream.name)
  );
  for (const declarationStream of declaration.streams) {
    const servingStream = servingStreams.find((candidate) => candidate.name === declarationStream.name);
    assert.ok(servingStream, `serving metadata includes ${declarationStream.name}`);
    assert.deepEqual(
      declarationStream.schema,
      servingStream.schema,
      `${declarationStream.name} schema remains identical`
    );
    const servingPrimaryKey = Array.isArray(servingStream.primary_key)
      ? servingStream.primary_key
      : [servingStream.primary_key];
    assert.deepEqual(
      declarationStream.primary_key,
      servingPrimaryKey,
      `${declarationStream.name} primary key remains identical`
    );
  }
});

test("legacy adapter separates public source identity and Collection execution metadata", () => {
  const declaration = sourceDeclarationFromLegacyConnectorManifest(legacy, attribution);
  assert.deepEqual(declaration.source, { id: attribution.sourceId, kind: "connector" });
  assert.equal(declaration.publisher.id, attribution.publisherId);
  assert.equal(declaration.declaration_version, attribution.declarationVersion);
  assert.notEqual(declaration.declaration_version, legacy.version);
  assert.equal(JSON.stringify(declaration).includes("items-local-key"), false);
  assert.deepEqual(declaration.streams[0]?.query, query);
  assert.equal("incremental" in (declaration.streams[0] as object), false);
  assert.deepEqual(declaration.extensions?.[COLLECTION_PROFILE_URI], {
    capabilities: legacy.capabilities,
    connector: { id: legacy.connector_id, version: legacy.version },
    runtime_requirements: legacy.runtime_requirements,
    streams: [{ incremental: true, name: "items" }],
  });
  assert.equal(JSON.stringify(declaration).includes("connection_id"), false);
});

test("legacy projection revision identifies the exact normalized declaration content", () => {
  const projectionAttribution = {
    connectorImplementationId: legacy.connector_id,
    publisherId: attribution.publisherId,
    sourceId: attribution.sourceId,
  };
  const original = snapshotContentAddressedSourceDeclarationFromLegacyConnectorManifest(
    structuredClone(legacy),
    projectionAttribution
  );
  const reordered = Object.fromEntries(Object.entries(structuredClone(legacy)).reverse());
  const sameContent = snapshotContentAddressedSourceDeclarationFromLegacyConnectorManifest(
    reordered,
    projectionAttribution
  );
  assert.equal(sameContent.declaration_version, original.declaration_version);
  assert.match(original.declaration_version, PROJECTED_DECLARATION_VERSION_REGEX);

  const connectorRelease = structuredClone(legacy);
  connectorRelease.version = "7.2.1";
  const changedConnectorRelease = snapshotContentAddressedSourceDeclarationFromLegacyConnectorManifest(
    connectorRelease,
    projectionAttribution
  );
  assert.notEqual(changedConnectorRelease.declaration_version, original.declaration_version);

  const changedSelection = structuredClone(legacy);
  const [changedStream] = changedSelection.streams;
  assert.ok(changedStream);
  changedStream.selection.resources = false;
  const changedAuthorizationContent = snapshotContentAddressedSourceDeclarationFromLegacyConnectorManifest(
    changedSelection,
    projectionAttribution
  );
  assert.notEqual(changedAuthorizationContent.declaration_version, original.declaration_version);
});

test("legacy adapter represents zero runtime binding requirements explicitly", () => {
  const { runtime_requirements: _runtimeRequirements, ...legacyWithoutRequirements } = legacy;
  const declaration = sourceDeclarationFromLegacyConnectorManifest(legacyWithoutRequirements, attribution);
  assert.deepEqual(declaration.extensions?.[COLLECTION_PROFILE_URI], {
    capabilities: legacy.capabilities,
    connector: { id: legacy.connector_id, version: legacy.version },
    runtime_requirements: { bindings: {} },
    streams: [{ incremental: true, name: "items" }],
  });
});

test("legacy adapter requires accepted attribution and never invents provider authority", () => {
  assert.throws(
    () => sourceDeclarationFromLegacyConnectorManifest(legacy, { ...attribution, publisherId: "local" }),
    INVALID_PUBLISHER_REGEX
  );
  assert.throws(
    () => sourceDeclarationFromLegacyConnectorManifest(legacy, { ...attribution, sourceId: "items-local" }),
    INVALID_SOURCE_REGEX
  );
});

test("common snapshot returns a detached immutable value for either source kind", () => {
  for (const kind of ["connector", "provider_native"] as const) {
    const input = coreDeclaration(kind);
    const snapshot = snapshotSourceDeclaration(input);
    input.display.name = "Changed input";
    assert.equal(snapshot.display.name, "Items");
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.streams[0]), true);
  }

  const legacyInput = structuredClone(legacy);
  const snapshot = snapshotSourceDeclarationFromLegacyConnectorManifest(legacyInput, attribution);
  legacyInput.display_name = "Changed legacy runtime manifest";
  assert.equal(snapshot.display.name, "Items");
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.streams[0]), true);
});

test("legacy adapter normalizes only the exact append semantics alias and rejects malformed streams", () => {
  const appendLegacy = { ...legacy, streams: [{ ...stream, semantics: "append" }] };
  const declaration = sourceDeclarationFromLegacyConnectorManifest(appendLegacy, attribution);
  assert.equal(declaration.streams[0]?.semantics, "append_only");

  assert.throws(
    () =>
      sourceDeclarationFromLegacyConnectorManifest(
        { ...legacy, streams: [legacy.streams[0], "not-a-stream"] },
        attribution
      ),
    MALFORMED_STREAM_REGEX
  );
});

test("legacy corpus projects into the neutral SourceDeclaration contract", () => {
  const manifestDirectory = fileURLToPath(new URL("../../packages/polyfill-connectors/manifests/", import.meta.url));
  const rejected = new Map<string, string>();
  for (const filename of readdirSync(manifestDirectory)
    .filter((name) => name.endsWith(".json"))
    .sort()) {
    const manifest = JSON.parse(readFileSync(`${manifestDirectory}/${filename}`, "utf8")) as Record<string, unknown>;
    try {
      sourceDeclarationFromLegacyConnectorManifest(manifest, {
        connectorImplementationId:
          typeof manifest.manifest_uri === "string" ? manifest.manifest_uri : String(manifest.connector_id),
        declarationVersion: `legacy-projection:${String(manifest.version)}`,
        publisherId: "https://local.example/publishers/accepted-connectors",
        sourceId: `https://sources.example/${filename.slice(0, -5)}`,
      });
    } catch (error) {
      rejected.set(filename, error instanceof Error ? error.message : String(error));
    }
  }
  assert.deepEqual([...rejected.entries()], []);
});

test("Core-only dependency oracle resolves a standalone source contract module", () => {
  const moduleText = readFileSync(new URL("../server/source-declaration.ts", import.meta.url), "utf8");
  const imports = [...moduleText.matchAll(IMPORT_REGEX)].map((match) => match[1]);
  assert.deepEqual(imports, ["node:module", "@pdpp/reference-contract/public/source"]);
  assert.doesNotMatch(moduleText, NO_CORE_COLLECTION_REGEX);

  const contractUrl = import.meta.resolve("@pdpp/reference-contract/public/source");
  assert.match(contractUrl, SOURCE_CONTRACT_PATH_REGEX);
  const contractText = readFileSync(fileURLToPath(contractUrl), "utf8");
  const runtimeImports = [...contractText.matchAll(RUNTIME_IMPORT_REGEX)].map((match) => match[1]);
  assert.deepEqual(runtimeImports, []);
});
