// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// `semantic_time` answers exactly one question: where does this record belong
// on the OWNER'S personal timeline? The ingest path resolves it from a stream's
// declared `consent_time_field` (then `cursor_field`) against the record's own
// payload, and falls back to the ingest stamp when neither resolves. That
// fallback is why an UNDECLARED field is not a neutral omission: it silently
// turns "no owner-moment" into "emitted_at", which reads downstream as real
// data and makes a null-rate check report 0% nulls on a fully ingest-stamped
// stream.
//
// So this file pins two things per stream:
//   1. A stream that HAS an owner-moment declares the field naming it.
//   2. A stream whose declared field exists in its own schema (no join is
//      performed at ingest, so a field that lives only on a parent stream
//      resolves to nothing and degrades to the ingest stamp).
//
// Entity streams with genuinely no owner-moment (a label, an account, a
// top-artist entry) are listed as deliberately timeless. Null is the correct,
// complete answer for those — not a gap to paper over.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

interface ManifestStream {
  consent_time_field?: string;
  cursor_field?: string;
  name?: string;
  schema?: {
    properties?: Record<string, unknown>;
  };
}

interface ConnectorManifest {
  streams?: ManifestStream[];
}

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MANIFESTS_DIR = join(PACKAGE_ROOT, "manifests");

// Streams that correspond to NO moment in the owner's life. Each entry records
// why, because "we couldn't find a date" and "there is no date" are different
// claims and only the second one justifies a timeless stream.
const DELIBERATELY_TIMELESS: Record<string, string> = {
  "chase/accounts": "an account is a standing entity; its only timestamp is the run-clock fetched_at",
  "gmail/labels": "a label is a folder, not an event; Gmail exposes no created/applied time",
  "spotify/playlists": "playlist rows carry no owner-scoped created/followed time",
  "spotify/top_artists": "a computed ranking over a window, not a moment the owner lived",
  "steam/profile": "a standing profile snapshot",
  "steam/steam_level": "a standing scalar with no timestamp",
  "usaa/accounts": "an account is a standing entity; its only timestamp is the run-clock fetched_at",
  "usaa/credit_card_billing": "standing billing terms (APR, limit), not an event",
};

// The connectors this suite governs. Scoped rather than global so it states a
// verified claim about streams that were actually read, instead of asserting a
// contract over connectors nobody audited.
const AUDITED_CONNECTORS = ["chase", "chatgpt", "gmail", "spotify", "steam", "usaa"];

function readManifest(connector: string): ConnectorManifest {
  return JSON.parse(readFileSync(join(MANIFESTS_DIR, `${connector}.json`), "utf8")) as ConnectorManifest;
}

test("every audited stream either declares an owner-moment field or is recorded as timeless", () => {
  const violations: string[] = [];
  for (const connector of AUDITED_CONNECTORS) {
    for (const stream of readManifest(connector).streams ?? []) {
      const id = `${connector}/${stream.name}`;
      const declared = stream.consent_time_field ?? stream.cursor_field;
      const timeless = id in DELIBERATELY_TIMELESS;
      if (declared && timeless) {
        violations.push(`${id}: listed as timeless but declares "${declared}"`);
      }
      if (!(declared || timeless)) {
        violations.push(
          `${id}: no consent_time_field/cursor_field and not recorded as timeless — ingest will stamp it`
        );
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("a declared semantic-time field exists in the stream's own schema", () => {
  const violations: string[] = [];
  for (const connector of AUDITED_CONNECTORS) {
    for (const stream of readManifest(connector).streams ?? []) {
      const properties = stream.schema?.properties ?? {};
      for (const field of [stream.consent_time_field, stream.cursor_field]) {
        // Ingest reads the record's own payload only — there is no join to a
        // parent stream, so an unresolvable field degrades to the ingest stamp.
        if (field && !(field in properties)) {
          violations.push(`${connector}/${stream.name}: declares "${field}", absent from its schema`);
        }
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("steam owned_games is positioned by when the OWNER last played, not the game's properties", () => {
  const owned = readManifest("steam").streams?.find((s) => s.name === "owned_games");
  // rtime_last_played describes the owner's relationship to the game. Playtime
  // totals and store metadata describe the game itself and never qualify.
  assert.equal(owned?.consent_time_field, "rtime_last_played");
});

test("gmail message_bodies is positioned by its parent message's received time", () => {
  const bodies = readManifest("gmail").streams?.find((s) => s.name === "message_bodies");
  // Denormalized onto the body payload precisely because ingest cannot join.
  assert.equal(bodies?.consent_time_field, "message_received_at");
  assert.ok(bodies?.schema?.properties && "message_received_at" in bodies.schema.properties);
});
