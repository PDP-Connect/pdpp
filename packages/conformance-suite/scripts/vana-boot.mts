// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { mkdir, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

const STATE = process.env.PDPP_VANA_STATE_DIR;
if (!STATE) {
  throw new Error("PDPP_VANA_STATE_DIR is required");
}
const PS = process.env.PDPP_VANA_PS;
if (!PS) {
  throw new Error("PDPP_VANA_PS is required");
}
const requestedPort = Number(process.env.PDPP_VANA_PORT ?? 0);
const portProbe = (await import("node:net")).createServer();
await new Promise<void>((resolve, reject) => {
  portProbe.once("error", reject);
  portProbe.listen(requestedPort, "127.0.0.1", resolve);
});
const PORT = (portProbe.address() as AddressInfo).port;
await new Promise<void>((resolve, reject) => portProbe.close((error) => (error ? reject(error) : resolve())));

process.env.VANA_MASTER_KEY_SIGNATURE =
  "0xedbb7743cce459345238442dcfb291f234a321d253485eaa58251aa0f28ea8f1410ab988bae2657b689cd24417b41e315efc22ba333024f4a6269c424ded8d361b";

process.env.PS_ACCESS_TOKEN = "conformance-operator-loopback-only";

const SOURCE_ID = "https://registry.pdpp.dev/connectors/spotify";
const CLIENT_ID = "music_recommendations";
const REDIRECT = "https://app.example.com/callback";
const EXPIRY_CLIENT_ID = "expiring_widget";
const EXPIRY_GRANT_LIFETIME_SECONDS = 3;
const MAIN_GRANT_LIFETIME_SECONDS = 31_536_000;
const SCOPES = [
  "spotify.top_artists",
  "spotify.saved_tracks",
  "spotify.playlists",
  "spotify.media",
  "spotify.events",
  "conformance.declarations",
];

const { ServerConfigSchema } = await import(join(PS, "packages/core/dist/schemas/server-config.js"));
const { createServer } = await import(join(PS, "packages/server/src/bootstrap.ts"));
const { listenHttpServer } = await import(join(PS, "packages/server/src/listen.ts"));
const { initializeDatabase } = await import(join(PS, "packages/server/src/storage/index-schema.ts"));

await mkdir(join(STATE, "declarations"), { recursive: true });
await mkdir(join(STATE, "data"), { recursive: true });

const declarationPath = join(STATE, "declarations", "spotify.json");
await writeFile(
  declarationPath,
  JSON.stringify({
    protocol_version: "0.1.0",
    source: { kind: "connector", id: SOURCE_ID },
    declaration_version: "2026-08-11",
    publisher: { id: "https://vana.org" },
    display: { name: "Spotify" },
    streams: [
      {
        name: "top_artists",
        description: "Seeded Spotify top artists for conformance tests.",
        display: { label: "Top artists" },
        semantics: "mutable_state",
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            genres: { type: "array", items: { type: "string" } },
            source_updated_at: { type: "string", format: "date-time" },
          },
          required: ["id"],
          additionalProperties: false,
        },
        primary_key: ["id"],
        cursor_field: "source_updated_at",
        consent_time_field: "source_updated_at",
        selection: { fields: true, resources: false },
      },
      {
        name: "saved_tracks",
        description: "Seeded Spotify saved tracks for conformance tests.",
        display: { label: "Saved tracks" },
        semantics: "mutable_state",
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            artist: { type: "string" },
            source_updated_at: { type: "string", format: "date-time" },
          },
          required: ["id", "title"],
          additionalProperties: false,
        },
        primary_key: ["id"],
        cursor_field: "source_updated_at",
        consent_time_field: "source_updated_at",
        selection: { fields: true, resources: false },
      },
      {
        name: "playlists",
        description: "Seeded Spotify playlists for conformance tests.",
        display: { label: "Playlists" },
        semantics: "mutable_state",
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            owner_id: { type: "string" },
            playlist_id: { type: "string" },
            title: { type: "string" },
          },
          required: ["owner_id", "playlist_id"],
          additionalProperties: false,
        },
        primary_key: ["owner_id", "playlist_id"],
        selection: { fields: true, resources: false },
      },
      {
        name: "media",
        description: "Seeded media records referencing blobs, for conformance tests.",
        display: { label: "Media" },
        semantics: "mutable_state",
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            id: { type: "string" },
            caption: { type: "string" },
            blob_ref: {
              type: "object",
              properties: {
                blob_id: { type: "string" },
                mime_type: { type: "string", const: "image/jpeg" },
              },
              required: ["blob_id", "mime_type"],
              additionalProperties: false,
            },
            source_updated_at: { type: "string", format: "date-time" },
          },
          required: ["id"],
          additionalProperties: false,
        },
        primary_key: ["id"],
        cursor_field: "source_updated_at",
        consent_time_field: "source_updated_at",
        selection: { fields: true, resources: false },
      },
    ],
    extensions: {},
  }),
  "utf-8"
);

const declaration = JSON.parse(await (await import("node:fs/promises")).readFile(declarationPath, "utf8"));
declaration.streams.push({ ...declaration.streams[0], name: "events", semantics: "append_only" });
declaration.streams.push({ ...declaration.streams[0], name: "multi_records" });
await writeFile(declarationPath, JSON.stringify(declaration));
const db = initializeDatabase(join(STATE, "index.db"));
const insertScope = db.prepare(
  `INSERT OR IGNORE INTO data_files (file_id, path, scope, collected_at, size_bytes)
   VALUES (?, ?, ?, ?, ?)`
);
SCOPES.forEach((scope, i) => {
  insertScope.run(
    `file-${i + 1}`,
    `${scope.split(".").join("/")}/2026-01-01T00:00:00Z.json`,
    scope,
    "2026-01-01T00:00:00Z",
    128
  );
});
db.close();

const config = ServerConfigSchema.parse({
  tunnel: { enabled: false },
  server: { origin: `http://127.0.0.1:${PORT}` },
  pdpp: {
    enabled: true,
    declarationPaths: [declarationPath],
    methods: [{ method_id: "conformance", declaration_path: declarationPath }],
    connectionMethods: [{ source_id: SOURCE_ID, method_id: "conformance" }],
    clients: [
      { clientId: CLIENT_ID, redirectUris: [REDIRECT], grantLifetimeSeconds: MAIN_GRANT_LIFETIME_SECONDS },
      {
        clientId: EXPIRY_CLIENT_ID,
        redirectUris: [REDIRECT],
        grantLifetimeSeconds: EXPIRY_GRANT_LIFETIME_SECONDS,
      },
    ],
  },
});

const ctx = await createServer(config, {
  serverDir: STATE,
  dataDir: join(STATE, "data"),
});

let bound: AddressInfo | undefined;
await listenHttpServer({
  fetch: ctx.app.fetch,
  port: PORT,
  hostname: "127.0.0.1",
  onListening: (info: AddressInfo) => {
    bound = info;
  },
});

console.log(
  JSON.stringify({
    ready: true,
    baseUrl: `http://127.0.0.1:${bound?.port ?? PORT}`,
    devToken: ctx.devToken,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT,
    sourceId: SOURCE_ID,
  })
);
