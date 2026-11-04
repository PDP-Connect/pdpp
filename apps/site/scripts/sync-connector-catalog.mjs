#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Refreshes src/data/connector-catalog.json, the snapshot behind /apps.
//
// The source is the connector catalogue, an OCI artifact at
// ghcr.io/pdp-connect/connector-catalog:latest that anyone can read without a
// login. This script pulls it, checks the bytes against the layer digest and
// size the registry reports, then reads each connector's manifest at the
// catalogue's source commit for the labels of what a person can bring.
//
// TRUST: the snapshot is pinned to digests, not signed. The manifest digest and
// layer digest are written into the file so anyone can fetch the same artifact
// and compare. This script does NOT verify the catalogue's cosign signature. A
// reader who needs that guarantee must verify the artifact itself.
//
// Run: node scripts/sync-connector-catalog.mjs [--out <path>]

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REGISTRY = "ghcr.io";
const REPOSITORY = "pdp-connect/connector-catalog";
const SOURCE_NAME = `${REGISTRY}/${REPOSITORY}`;
const CATALOG_MEDIA_TYPE = "application/vnd.pdpp.connector-catalog.v1+json";
const MANIFEST_ACCEPT = "application/vnd.oci.image.manifest.v1+json";
const CONNECTOR_MANIFEST_BASE = "https://raw.githubusercontent.com/PDP-Connect/data-connectors";
const TIERS = new Set(["supported", "preview", "development"]);

const DEFAULT_OUTPUT = fileURLToPath(new URL("../src/data/connector-catalog.json", import.meta.url));

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
 * or undefined when that manifest was missing.
 */
export function buildSnapshot({ catalog, manifests, manifestDigest, layerDigest }) {
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

async function getJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return response;
}

/** Pulls the catalogue anonymously and checks its digest and size. */
export async function fetchCatalog() {
  const tokenResponse = await getJson(`https://${REGISTRY}/token?scope=repository:${REPOSITORY}:pull`);
  const { token } = await tokenResponse.json();
  const headers = { Authorization: `Bearer ${token}` };

  const manifestResponse = await getJson(`https://${REGISTRY}/v2/${REPOSITORY}/manifests/latest`, {
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

  const blobResponse = await getJson(`https://${REGISTRY}/v2/${REPOSITORY}/blobs/${layer.digest}`, {
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

async function fetchConnectorManifest(sourceCommit, key) {
  for (const folder of manifestFolderCandidates(key)) {
    const url = `${CONNECTOR_MANIFEST_BASE}/${sourceCommit}/connectors/${folder}/manifest.json`;
    // biome-ignore lint/performance/noAwaitInLoops: the second folder is tried only when the first is missing.
    const response = await fetch(url);
    if (response.status === 404) {
      continue;
    }
    if (!response.ok) {
      throw new Error(`${url} returned ${response.status}`);
    }
    return await response.json();
  }
  return null;
}

// One small request per connector, all at once: the catalogue lists a few
// dozen, and a missing manifest is a null rather than a failure.
async function fetchManifests(catalog) {
  const entries = await Promise.all(
    catalog.connectors.map(async (connector) => [
      connector.connector_key,
      await fetchConnectorManifest(catalog.source_commit, connector.connector_key),
    ])
  );
  return Object.fromEntries(entries);
}

// Measured against the repo formatter: it keeps a JSON array on one line up to this width.
const LINE_WIDTH = 80;
const TRAILING_COMMA = /,$/;
const STRING_ARRAY = /^( *)("[^"]+": )\[\n((?: +"(?:[^"\\]|\\.)*",?\n)+) *\]/gm;

/**
 * JSON.stringify output, with each short array of strings on one line. The
 * committed file is checked by the repo formatter, which lays arrays out the
 * same way, so a fresh sync leaves no formatting diff.
 */
export function formatSnapshot(snapshot) {
  const text = JSON.stringify(snapshot, null, 2).replace(STRING_ARRAY, (whole, indent, key, body) => {
    const items = body
      .trim()
      .split("\n")
      .map((item) => item.trim().replace(TRAILING_COMMA, ""));
    const line = `${indent}${key}[${items.join(", ")}]`;
    return line.length <= LINE_WIDTH ? line : whole;
  });
  return `${text}\n`;
}

export async function syncConnectorCatalog(outputPath = DEFAULT_OUTPUT) {
  const { catalog, manifestDigest, layerDigest } = await fetchCatalog();
  const manifests = await fetchManifests(catalog);
  const snapshot = buildSnapshot({ catalog, manifests, manifestDigest, layerDigest });
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, formatSnapshot(snapshot));
  return snapshot;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outIndex = process.argv.indexOf("--out");
  const outputPath = outIndex === -1 ? DEFAULT_OUTPUT : path.resolve(process.argv[outIndex + 1]);
  const snapshot = await syncConnectorCatalog(outputPath);
  const withLabels = snapshot.connectors.filter((connector) => connector.labels.length > 0).length;
  console.log(
    `Wrote ${snapshot.connectors.length} connectors (${withLabels} with labels) to ${outputPath}\n` +
      `manifest ${snapshot.manifest_digest}\nlayer    ${snapshot.layer_digest}\ncommit   ${snapshot.source_commit}`
  );
}
