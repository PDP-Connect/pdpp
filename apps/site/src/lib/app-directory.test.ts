// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  appName,
  buildDirectory,
  type ConnectorSnapshot,
  type DirectoryEntry,
  formatDate,
  labelsLine,
  type RegisterEntry,
  searchDirectory,
} from "./app-directory.ts";
import { readConnectorSnapshot, readRegisterEntries } from "./app-directory-sources.ts";
import type { PublicSupporter } from "./public-supporters.ts";

const OURA_DATA = /your Oura data/;
const COMPANY_CLAIM = /\b(is on|is part of|supports|takes part|partner)\b/i;
const OPEN_SOURCE_CONNECTOR = /open-source connector/;
const COMPANY_OR_OFFICIAL = /company|official/i;

const SNAPSHOT: ConnectorSnapshot = {
  connectors: [
    { display_name: "Oura", key: "oura", labels: [], tier: "development" },
    { display_name: "Oura (Browser Sign-In)", key: "oura-browser", labels: ["Your sleep"], tier: "preview" },
    {
      display_name: "Spotify",
      key: "spotify",
      labels: [
        "Your playlists",
        "Your saved tracks",
        "Your top artists",
        "Your top tracks",
        "Your history",
        "Your podcasts",
      ],
      tier: "preview",
    },
    { display_name: "Strava", key: "strava", labels: ["Your activities"], tier: "supported" },
  ],
  generated_at: "2026-11-04T02:08:53.000Z",
  layer_digest: "sha256:layer",
  manifest_digest: "sha256:manifest",
  source: "ghcr.io/pdp-connect/connector-catalog",
  source_commit: "abc",
};

function supporter(publicName: string, type: string, signedOn = "2026-09-09"): PublicSupporter {
  return { country: "Germany", principlesVersion: "1.0", publicName, signedOn, type };
}

function registration(organisation: string, status: string, state = "Current"): RegisterEntry {
  return { organisation, role: "Source", since: "2026-12-01", specVersion: "0.2", state, status };
}

function directory(supporters: PublicSupporter[] = [], register: RegisterEntry[] = []) {
  return buildDirectory({ register, snapshot: SNAPSHOT, supporters }).entries;
}

function find(entries: readonly DirectoryEntry[], name: string): DirectoryEntry {
  const entry = entries.find((candidate) => candidate.name === name);
  assert.ok(entry, `no entry named ${name}`);
  return entry;
}

test("a connector alone: you can bring your data, and the company has not signed or registered", () => {
  const spotify = find(directory(), "Spotify");
  assert.equal(
    spotify.headline,
    "You can bring your Spotify data into PDPP today, with an open-source connector."
  );
  assert.equal(spotify.labels, "Your playlists, Your saved tracks, Your top artists, Your top tracks + 2 more");
  assert.equal(spotify.status, "Spotify has not signed the Principles or registered with PDPP.");
  assert.equal(spotify.tierLabel, "Preview");
});

test("a signed organisation with a connector shows the signing date", () => {
  const spotify = find(directory([supporter("Spotify", "Company", "2026-09-09")]), "Spotify");
  assert.equal(spotify.status, "Spotify signed the PDPP Principles on 9 Sep 2026. It has not registered with PDPP.");
  assert.equal(
    spotify.headline,
    "You can bring your Spotify data into PDPP today, with an open-source connector."
  );
});

test("a signed and registered organisation says both", () => {
  const spotify = find(
    directory([supporter("Spotify", "Company", "2026-09-09")], [registration("Spotify", "Registered Source")]),
    "Spotify"
  );
  assert.equal(spotify.status, "Spotify signed the PDPP Principles on 9 Sep 2026 and is a Registered Source.");
});

test("a Verified status also names the company a Partner", () => {
  const spotify = find(directory([], [registration("Spotify", "Verified Source")]), "Spotify");
  assert.equal(spotify.status, "Spotify has not signed the Principles. It is a Verified Source. It is a PDPP Partner.");
});

test("a Registered status alone does not make a Partner", () => {
  const spotify = find(directory([], [registration("Spotify", "Registered Source")]), "Spotify");
  assert.equal(spotify.status, "Spotify has not signed the Principles. It is a Registered Source.");
});

test("an ended registration is ignored", () => {
  const spotify = find(directory([], [registration("Spotify", "Verified Source", "Lapsed")]), "Spotify");
  assert.equal(spotify.status, "Spotify has not signed the Principles or registered with PDPP.");
});

test("a signed organisation without a connector is its own row, with no connector claim", () => {
  const kalo = find(directory([supporter("Kalo", "Company", "2026-09-05")]), "Kalo");
  assert.equal(kalo.kind, "company");
  assert.equal(kalo.headline, "There is no PDPP connector for Kalo yet.");
  assert.equal(kalo.status, "Kalo signed the PDPP Principles on 5 Sep 2026. It has not registered with PDPP.");
  assert.equal(kalo.tier, null);
});

test("individuals never appear", () => {
  const entries = directory([supporter("Tim N.", "Individual"), supporter("Spotify", "Individual")]);
  assert.equal(entries.length, SNAPSHOT.connectors.length);
  assert.equal(find(entries, "Spotify").status, "Spotify has not signed the Principles or registered with PDPP.");
  assert.deepEqual(searchDirectory(entries, "tim"), []);
});

test("a company is matched by whole name, not by substring", () => {
  const entries = directory([supporter("Spot", "Company")]);
  assert.equal(find(entries, "Spotify").status, "Spotify has not signed the Principles or registered with PDPP.");
  assert.equal(find(entries, "Spot").kind, "company");
});

test("a bracketed company name links the connector to its company", () => {
  const snapshot: ConnectorSnapshot = {
    ...SNAPSHOT,
    connectors: [{ display_name: "Claude (Anthropic)", key: "anthropic", labels: [], tier: "preview" }],
  };
  const { entries } = buildDirectory({
    register: [],
    snapshot,
    supporters: [supporter("Anthropic", "Company", "2026-10-01")],
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.status, "Claude signed the PDPP Principles on 1 Oct 2026. It has not registered with PDPP.");
});

test("separate connectors for the same app stay separate rows", () => {
  const oura = directory().filter((entry) => entry.name.startsWith("Oura"));
  assert.deepEqual(
    oura.map((entry) => entry.name),
    ["Oura", "Oura (Browser Sign-In)"]
  );
  assert.match(oura[1]?.headline ?? "", OURA_DATA);
});

test("a connector in development is not promised as available today", () => {
  const oura = find(directory(), "Oura");
  assert.equal(oura.tierLabel, "In development");
  assert.equal(oura.headline, "An open-source connector for Oura is in development.");
});

test("search is case-insensitive and matches a substring of the app name", () => {
  const entries = directory();
  assert.deepEqual(
    searchDirectory(entries, "  OURA ").map((entry) => entry.name),
    ["Oura", "Oura (Browser Sign-In)"]
  );
  assert.deepEqual(
    searchDirectory(entries, "potif").map((entry) => entry.name),
    ["Spotify"]
  );
});

test("search matches an organisation by name and shows company rows only then", () => {
  const entries = directory([supporter("Open Data Labs", "Company")]);
  assert.equal(searchDirectory(entries, "").length, SNAPSHOT.connectors.length);
  assert.deepEqual(
    searchDirectory(entries, "data LABS").map((entry) => entry.name),
    ["Open Data Labs"]
  );
});

test("search matches the linked company's name", () => {
  const { entries } = buildDirectory({
    register: [],
    snapshot: {
      ...SNAPSHOT,
      connectors: [{ display_name: "Claude (Anthropic)", key: "a", labels: [], tier: "preview" }],
    },
    supporters: [supporter("Anthropic", "Company")],
  });
  assert.equal(searchDirectory(entries, "anthropic").length, 1);
});

test("no match gives an empty list", () => {
  assert.deepEqual(searchDirectory(directory(), "zzz"), []);
});

test("the first line never says a company is on, supports or takes part in PDPP", () => {
  const entries = directory(
    [supporter("Spotify", "Company"), supporter("Kalo", "Company")],
    [registration("Strava", "Verified Source")]
  );
  for (const entry of entries) {
    assert.doesNotMatch(entry.headline, COMPANY_CLAIM, entry.headline);
  }
  for (const entry of entries.filter((candidate) => candidate.kind === "connector")) {
    assert.match(entry.headline, OPEN_SOURCE_CONNECTOR);
    assert.doesNotMatch(entry.headline, COMPANY_OR_OFFICIAL);
  }
});

test("formatDate, appName and labelsLine", () => {
  assert.equal(formatDate("2026-11-04T02:08:53.000Z"), "4 Nov 2026");
  assert.equal(formatDate("2026-09-05"), "5 Sep 2026");
  assert.equal(formatDate("soon"), "soon");
  assert.equal(appName("Oura (Browser Sign-In)"), "Oura");
  assert.equal(appName("Twitter/X Archive"), "Twitter/X Archive");
  assert.equal(labelsLine(["A", "B"]), "A, B");
  assert.equal(labelsLine(["A", "B", "C", "D"]), "A, B, C, D");
  assert.equal(labelsLine(["A", "B", "C", "D", "E"]), "A, B, C, D + 1 more");
});

test("the committed snapshot and register parse and build a directory", async () => {
  const snapshot = await readConnectorSnapshot();
  const register = await readRegisterEntries();
  const supporters = JSON.parse(
    await readFile(new URL("../../public/principles/supporters.json", import.meta.url), "utf8")
  ) as PublicSupporter[];
  const { entries } = buildDirectory({ register, snapshot, supporters });
  assert.ok(snapshot.connectors.length > 0);
  assert.equal(entries.filter((entry) => entry.kind === "connector").length, snapshot.connectors.length);
  assert.ok(entries.every((entry) => !entry.matchNames.includes("tim n.")));
});
