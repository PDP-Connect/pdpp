// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  buildSnapshot,
  labelsFromManifest,
  loadConnectorSnapshot,
  manifestFolderCandidates,
  verifyBlob,
} from "../src/lib/connector-catalog.mjs";
import { formatSnapshot } from "./sync-connector-catalog.mjs";

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
      { display_name: "Alpha", key: "no-manifest", labels: [], source_path: null, tier: "development" },
      {
        display_name: "Spotify",
        key: "spotify",
        labels: ["Your playlists", "Your saved tracks"],
        source_path: null,
        tier: "preview",
      },
      { display_name: "Strava", key: "strava", labels: [], source_path: null, tier: "supported" },
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

test("the snapshot records the source folder a manifest was found in", () => {
  const snapshot = buildSnapshot({
    catalog: CATALOG,
    folders: { spotify: "spotify_web" },
    layerDigest: "x",
    manifestDigest: "y",
    manifests: {},
  });
  const paths = Object.fromEntries(
    snapshot.connectors.map((connector: { key: string; source_path: string | null }) => [
      connector.key,
      connector.source_path,
    ])
  );
  assert.equal(paths.spotify, "connectors/spotify_web");
  assert.equal(paths.strava, null);
});

test("loadConnectorSnapshot pulls the catalogue, checks it and reads each manifest", async () => {
  const blob = Buffer.from(JSON.stringify(CATALOG));
  const layer = {
    digest: `sha256:${createHash("sha256").update(blob).digest("hex")}`,
    mediaType: "application/vnd.pdpp.connector-catalog.v1+json",
    size: blob.length,
  };
  const manifest = Buffer.from(JSON.stringify({ layers: [layer] }));
  const requested: string[] = [];
  const fakeFetch = (url: string) => {
    requested.push(url);
    if (url.includes("/token?")) {
      return Promise.resolve(Response.json({ token: "t" }));
    }
    if (url.endsWith("/manifests/latest")) {
      return Promise.resolve(new Response(manifest));
    }
    if (url.includes("/blobs/")) {
      return Promise.resolve(new Response(blob));
    }
    if (url.endsWith("/abc123/connectors/spotify/manifest.json")) {
      return Promise.resolve(Response.json(MANIFESTS.spotify));
    }
    return Promise.resolve(new Response("", { status: 404 }));
  };

  const snapshot = await loadConnectorSnapshot(fakeFetch as typeof fetch);
  const spotify = snapshot.connectors.find((connector: { key: string }) => connector.key === "spotify");
  assert.deepEqual(spotify?.labels, ["Your playlists", "Your saved tracks"]);
  assert.equal(spotify?.source_path, "connectors/spotify");
  assert.equal(snapshot.layer_digest, layer.digest);
  assert.ok(requested.some((url) => url.endsWith("/connectors/no_manifest/manifest.json")));
});

test("loadConnectorSnapshot rejects a catalogue whose bytes do not match the digest", async () => {
  const layer = { digest: "sha256:00", mediaType: "application/vnd.pdpp.connector-catalog.v1+json", size: 2 };
  const fakeFetch = (url: string) => {
    if (url.includes("/token?")) {
      return Promise.resolve(Response.json({ token: "t" }));
    }
    if (url.endsWith("/manifests/latest")) {
      return Promise.resolve(Response.json({ layers: [layer] }));
    }
    return Promise.resolve(new Response("{}"));
  };
  await assert.rejects(loadConnectorSnapshot(fakeFetch as typeof fetch), DIGEST_MISMATCH);
});
