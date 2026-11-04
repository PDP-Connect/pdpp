// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Reads the connector catalogue behind /apps.
//
// The source is the connector catalogue, an OCI artifact at
// ghcr.io/pdp-connect/connector-catalog:latest that anyone can read without a
// login. This module pulls it, checks the bytes against the layer digest and
// size the registry reports, then reads each connector's manifest at the
// catalogue's source commit for the labels of what a person can bring.
//
// Two callers: the /apps page loads it live (app-directory-sources.ts), and
// scripts/sync-connector-catalog.mjs writes it to src/data/connector-catalog.json,
// the copy the page falls back to when the live load fails.
//
// TRUST: the result is pinned to digests, not signed. The manifest digest and
// layer digest are kept in the result so anyone can fetch the same artifact
// and compare. This module does NOT verify the catalogue's cosign signature.
// A reader who needs that guarantee must verify the artifact itself.
//
// Plain JavaScript with no imports beyond node:crypto, so the sync script can
// run it with plain node and the site can bundle it.

import { createHash } from "node:crypto";

const REGISTRY = "ghcr.io";
const REPOSITORY = "pdp-connect/connector-catalog";
const SOURCE_NAME = `${REGISTRY}/${REPOSITORY}`;
const CATALOG_MEDIA_TYPE = "application/vnd.pdpp.connector-catalog.v1+json";
const MANIFEST_ACCEPT = "application/vnd.oci.image.manifest.v1+json";
const CONNECTOR_MANIFEST_BASE = "https://raw.githubusercontent.com/PDP-Connect/data-connectors";
const TIERS = new Set(["supported", "preview", "development"]);
// Per request. A slow registry must not hold up a build or a page regeneration.
const REQUEST_TIMEOUT_MS = 15_000;

function sha256Digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Reads the labels a connector declares for what it brings. Returns [] for a
 * missing or unreadable manifest: labels are an extra, and a connector with
 * none is still listed.
 */
export function labelsFromManifest(manifest) {
  const streams = Array.isArray(manifest?.streams) ? manifest.streams : [];
  const labels = [];
  for (const stream of streams) {
    const label = stream?.display?.label;
    if (typeof label === "string" && label.trim() && !labels.includes(label.trim())) {
      labels.push(label.trim());
    }
  }
  return labels;
}

/**
 * Pure transform: raw catalogue plus per-connector manifests to the snapshot
 * the page renders. Keeps only what the page needs. Nothing here touches the
 * network, so a test can feed it a small fixture.
 *
 * `manifests` maps connector_key to the parsed connector manifest, or to null
 * or undefined when that manifest was missing. `folders` maps connector_key to
 * the source folder the manifest was found in; the page links to it.
 */
export function buildSnapshot({ catalog, manifests, folders = {}, manifestDigest, layerDigest }) {
  if (!Array.isArray(catalog?.connectors)) {
    throw new Error("Catalogue has no connectors array");
  }
  const connectors = catalog.connectors.map((connector) => {
    if (!(connector.connector_key && connector.display_name)) {
      throw new Error("Catalogue connector is missing connector_key or display_name");
    }
    if (!TIERS.has(connector.tier)) {
      throw new Error(`Connector ${connector.connector_key} has unknown tier ${String(connector.tier)}`);
    }
    return {
      key: connector.connector_key,
      display_name: connector.display_name,
      tier: connector.tier,
      labels: labelsFromManifest(manifests[connector.connector_key]),
      source_path: folders[connector.connector_key] ? `connectors/${folders[connector.connector_key]}` : null,
    };
  });
  connectors.sort((a, b) => a.display_name.localeCompare(b.display_name, "en") || a.key.localeCompare(b.key, "en"));
  return {
    source: SOURCE_NAME,
    manifest_digest: manifestDigest,
    layer_digest: layerDigest,
    generated_at: catalog.generated_at,
    source_commit: catalog.source_commit,
    connectors,
  };
}

async function getJson(fetchFn, url, init) {
  const response = await fetchFn(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return response;
}

/** Pulls the catalogue anonymously and checks its digest and size. */
export async function fetchCatalog(fetchFn = fetch) {
  const tokenResponse = await getJson(fetchFn, `https://${REGISTRY}/token?scope=repository:${REPOSITORY}:pull`);
  const { token } = await tokenResponse.json();
  const headers = { Authorization: `Bearer ${token}` };

  const manifestResponse = await getJson(fetchFn, `https://${REGISTRY}/v2/${REPOSITORY}/manifests/latest`, {
    headers: { ...headers, Accept: MANIFEST_ACCEPT },
  });
  const manifestBytes = Buffer.from(await manifestResponse.arrayBuffer());
  const manifestDigest = sha256Digest(manifestBytes);
  const reported = manifestResponse.headers.get("docker-content-digest");
  if (reported && reported !== manifestDigest) {
    throw new Error(`Manifest digest mismatch: registry says ${reported}, bytes hash to ${manifestDigest}`);
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const layers = (manifest.layers ?? []).filter((candidate) => candidate.mediaType === CATALOG_MEDIA_TYPE);
  if (layers.length !== 1) {
    throw new Error(`Expected one ${CATALOG_MEDIA_TYPE} layer, found ${layers.length}`);
  }
  const [layer] = layers;

  const blobResponse = await getJson(fetchFn, `https://${REGISTRY}/v2/${REPOSITORY}/blobs/${layer.digest}`, {
    headers,
    redirect: "follow",
  });
  const blobBytes = Buffer.from(await blobResponse.arrayBuffer());
  verifyBlob(blobBytes, layer);

  return { catalog: JSON.parse(blobBytes.toString("utf8")), manifestDigest, layerDigest: layer.digest };
}

/** Throws unless the bytes match the layer's digest and size. */
export function verifyBlob(bytes, layer) {
  const actual = sha256Digest(bytes);
  if (actual !== layer.digest) {
    throw new Error(`Catalogue digest mismatch: expected ${layer.digest}, got ${actual}`);
  }
  if (bytes.length !== layer.size) {
    throw new Error(`Catalogue size mismatch: expected ${layer.size}, got ${bytes.length}`);
  }
}

// Catalogue keys use hyphens (`apple-health`); most source folders use
// underscores (`connectors/apple_health`). Try the key as written, then that form.
export function manifestFolderCandidates(key) {
  const underscored = key.replaceAll("-", "_");
  return underscored === key ? [key] : [key, underscored];
}

async function fetchConnectorManifest(fetchFn, sourceCommit, key) {
  for (const folder of manifestFolderCandidates(key)) {
    const url = `${CONNECTOR_MANIFEST_BASE}/${sourceCommit}/connectors/${folder}/manifest.json`;
    // biome-ignore lint/performance/noAwaitInLoops: the second folder is tried only when the first is missing.
    const response = await fetchFn(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (response.status === 404) {
      continue;
    }
    if (!response.ok) {
      throw new Error(`${url} returned ${response.status}`);
    }
    return { folder, manifest: await response.json() };
  }
  return null;
}

// One small request per connector, all at once: the catalogue lists a few
// dozen, and a missing manifest is a null rather than a failure.
export async function fetchManifests(catalog, fetchFn = fetch) {
  const found = await Promise.all(
    catalog.connectors.map(async (connector) => [
      connector.connector_key,
      await fetchConnectorManifest(fetchFn, catalog.source_commit, connector.connector_key),
    ])
  );
  return {
    folders: Object.fromEntries(found.map(([key, result]) => [key, result?.folder ?? null])),
    manifests: Object.fromEntries(found.map(([key, result]) => [key, result?.manifest ?? null])),
  };
}

/** The whole live load: catalogue, then every manifest, then the snapshot the page renders. */
export async function loadConnectorSnapshot(fetchFn = fetch) {
  const { catalog, manifestDigest, layerDigest } = await fetchCatalog(fetchFn);
  const { folders, manifests } = await fetchManifests(catalog, fetchFn);
  return buildSnapshot({ catalog, folders, layerDigest, manifestDigest, manifests });
}
