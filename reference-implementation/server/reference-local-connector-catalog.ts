import { readFileSync } from "node:fs";
import { exec, referenceQueries } from "../lib/db.ts";
import { registerConnector } from "./auth.js";
import { canonicalConnectorKey } from "./connector-key.js";
import { isPostgresStorageBackend, postgresQuery } from "./postgres-storage.js";

// Keyed by canonical connector_key. The local-collector manifest files
// retain their historical snake_case filenames (`claude_code.json`), but the
// catalog row, the connector_instances row, and the record storage target all
// use the canonical key (`claude-code`, `codex`) so a legacy-alias enroll
// cannot fork the connector type away from its canonical identity.
const REFERENCE_LOCAL_CONNECTOR_CATALOG_MANIFESTS = new Map([
  ["claude-code", { entryName: "claude_code.json", displayName: "Claude Code" }],
  ["codex", { entryName: "codex.json", displayName: "OpenAI Codex CLI" }],
]);

export function readReferenceLocalConnectorCatalogManifest(connectorId: string) {
  const connectorKey = canonicalConnectorKey(connectorId) ?? connectorId;
  const local = REFERENCE_LOCAL_CONNECTOR_CATALOG_MANIFESTS.get(connectorKey);
  if (!local) {
    return null;
  }
  try {
    const raw = readFileSync(
      new URL(`../../packages/polyfill-connectors/manifests/${local.entryName}`, import.meta.url),
      "utf8"
    );
    const manifest = JSON.parse(raw) as Record<string, unknown>;
    return {
      ...manifest,
      connector_id: connectorKey,
      display_name: (manifest.display_name as string | undefined) || local.displayName,
    };
  } catch {
    return {
      connector_id: connectorKey,
      display_name: local.displayName,
      streams: [],
    };
  }
}

export function listReferenceLocalConnectorCatalogManifests() {
  return Array.from(REFERENCE_LOCAL_CONNECTOR_CATALOG_MANIFESTS.keys())
    .map((connectorId) => readReferenceLocalConnectorCatalogManifest(connectorId))
    .filter(Boolean);
}

export async function ensureReferenceConnectorCatalogEntry(connectorId: string, connectorDisplayName?: string) {
  const localCollectorManifest = readReferenceLocalConnectorCatalogManifest(connectorId);
  if (localCollectorManifest) {
    await registerConnector(localCollectorManifest);
    return;
  }
  const connectorKey = canonicalConnectorKey(connectorId) ?? connectorId;
  const manifest = {
    connector_id: connectorKey,
    ...(connectorKey === connectorId ? {} : { manifest_uri: connectorId }),
    display_name: connectorDisplayName || connectorKey,
    streams: [],
  };
  if (isPostgresStorageBackend()) {
    await postgresQuery(
      `INSERT INTO connectors(connector_id, manifest)
       VALUES($1, $2::jsonb)
       ON CONFLICT(connector_id) DO NOTHING`,
      [connectorKey, JSON.stringify(manifest)]
    );
    return;
  }
  // Insert the minimal catalog stub only when the connector is not already
  // registered. A real manifest (e.g. a browser-bound connector like amazon
  // registered via POST /connectors) MUST NOT be clobbered by this stub on
  // enroll — otherwise a second enrollment for the same connector type would
  // read a manifest stripped of its runtime bindings. This matches the
  // postgres branch's DO NOTHING semantics. (Without this guard the shared
  // authConnectorsUpsert query DO-UPDATEs the manifest.)
  exec(referenceQueries.authConnectorsInsertIfAbsent, [connectorKey, JSON.stringify(manifest)]);
}
