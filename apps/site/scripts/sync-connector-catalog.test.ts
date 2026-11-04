// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  buildSnapshot,
  formatSnapshot,
  labelsFromManifest,
  manifestFolderCandidates,
  verifyBlob,
} from "./sync-connector-catalog.mjs";

const UNKNOWN_TIER = /unknown tier/;
const NO_CONNECTORS = /no connectors array/;
const DIGEST_MISMATCH = /digest mismatch/;
const SIZE_MISMATCH = /size mismatch/;

const CATALOG = {
  catalog_version: "1.0",
  connectors: [
    {
      connector_id: "https://registry.pdpp.dev/connectors/strava",
      connector_key: "strava",
      display_name: "Strava",
      latest: { digest: "sha256:aa", version: "1.0.0" },
      runtime_requirements: {},
      setup: { modality: "oauth" },
      tier: "supported",
      versions: [],
    },
    {
      connector_key: "spotify",
      display_name: "Spotify",
      tier: "preview",
    },
    {
      connector_key: "no-manifest",
      display_name: "Alpha",
      tier: "development",
    },
  ],
  generated_at: "2026-11-04T02:08:53.000Z",
  source_commit: "abc123",
};

const MANIFESTS = {
  spotify: {
    streams: [
      { display: { label: "Your playlists" }, name: "playlists" },
      { display: { label: "Your saved tracks" }, name: "saved" },
      { display: { label: "Your playlists" }, name: "duplicate" },
      { name: "no-display" },
      { display: { label: "  " }, name: "blank" },
    ],
  },
  strava: { streams: [] },
};

test("buildSnapshot keeps only what the page needs, sorted by display name", () => {
  const snapshot = buildSnapshot({
    catalog: CATALOG,
    layerDigest: "sha256:layer",
    manifestDigest: "sha256:manifest",
    manifests: { ...MANIFESTS, "no-manifest": null },
  });

  assert.deepEqual(snapshot, {
    connectors: [
      { display_name: "Alpha", key: "no-manifest", labels: [], tier: "development" },
      { display_name: "Spotify", key: "spotify", labels: ["Your playlists", "Your saved tracks"], tier: "preview" },
      { display_name: "Strava", key: "strava", labels: [], tier: "supported" },
    ],
    generated_at: "2026-11-04T02:08:53.000Z",
    layer_digest: "sha256:layer",
    manifest_digest: "sha256:manifest",
    source: "ghcr.io/pdp-connect/connector-catalog",
    source_commit: "abc123",
  });
});

test("buildSnapshot treats a manifest that was never fetched as no labels", () => {
  const snapshot = buildSnapshot({
    catalog: CATALOG,
    layerDigest: "sha256:layer",
    manifestDigest: "sha256:manifest",
    manifests: {},
  });
  assert.equal(snapshot.connectors.length, 3);
  assert.ok(snapshot.connectors.every((connector: { labels: unknown[] }) => connector.labels.length === 0));
});

test("buildSnapshot rejects an unknown tier and a catalogue without connectors", () => {
  const base = { layerDigest: "x", manifestDigest: "y", manifests: {} };
  assert.throws(
    () =>
      buildSnapshot({
        ...base,
        catalog: { connectors: [{ connector_key: "a", display_name: "A", tier: "beta" }] },
      }),
    UNKNOWN_TIER
  );
  assert.throws(() => buildSnapshot({ ...base, catalog: {} }), NO_CONNECTORS);
});

test("labelsFromManifest ignores a missing manifest", () => {
  assert.deepEqual(labelsFromManifest(null), []);
  assert.deepEqual(labelsFromManifest({}), []);
});

test("verifyBlob accepts matching bytes and rejects a wrong digest or size", () => {
  const bytes = Buffer.from('{"connectors":[]}');
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  verifyBlob(bytes, { digest, size: bytes.length });
  assert.throws(() => verifyBlob(bytes, { digest: "sha256:00", size: bytes.length }), DIGEST_MISMATCH);
  assert.throws(() => verifyBlob(bytes, { digest, size: bytes.length + 1 }), SIZE_MISMATCH);
});

test("formatSnapshot keeps short label lists on one line and round-trips", () => {
  const snapshot = buildSnapshot({
    catalog: CATALOG,
    layerDigest: "sha256:layer",
    manifestDigest: "sha256:manifest",
    manifests: MANIFESTS,
  });
  const text = formatSnapshot(snapshot);
  assert.ok(text.endsWith("}\n"));
  assert.ok(text.includes('"labels": ["Your playlists", "Your saved tracks"]'));
  assert.deepEqual(JSON.parse(text), snapshot);
});

test("a hyphenated catalogue key also looks in the underscored source folder", () => {
  assert.deepEqual(manifestFolderCandidates("apple-health"), ["apple-health", "apple_health"]);
  assert.deepEqual(manifestFolderCandidates("spotify"), ["spotify"]);
});
