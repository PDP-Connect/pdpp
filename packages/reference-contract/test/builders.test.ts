// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExpandParams,
  buildOwnerDeviceAuthorizationRequest,
  buildParRequest,
  buildRecordsQuery,
} from "../src/builders/index.ts";

const LEGACY_SOURCE_RE = /source: \{ id, kind\? \}/;

test("buildExpandParams normalizes repeated relation names and expand limits", () => {
  assert.deepEqual(
    buildExpandParams({
      expand: ["albums", "albums,artists", "artists"],
      expand_limit: { albums: 5, artists: 2, empty: "" },
    }),
    {
      expand: ["albums", "artists"],
      expand_limit: { albums: 5, artists: 2 },
    }
  );
});

test("buildRecordsQuery composes record-list query params without empty values", () => {
  assert.deepEqual(
    buildRecordsQuery({
      connector_id: "spotify",
      expand: ["artist"],
      expand_limit: { artist: 1 },
      fields: ["id", "name"],
      filter: { source_updated_at: { gte: "2026-04-01T00:00:00Z" } },
      limit: 25,
      order: "desc",
    }),
    {
      connector_id: "spotify",
      expand: ["artist"],
      expand_limit: { artist: 1 },
      fields: "id,name",
      filter: { source_updated_at: { gte: "2026-04-01T00:00:00Z" } },
      limit: 25,
      order: "desc",
    }
  );
});

test("buildRecordsQuery preserves zero and false for downstream validation", () => {
  assert.deepEqual(
    buildRecordsQuery({ limit: 0, view: false, cursor: "", fields: [], changes_since: null }),
    { limit: 0, view: false }
  );
});

test("buildRecordsQuery keeps the order of normalized expansions and omits empty limits", () => {
  assert.deepEqual(
    buildRecordsQuery({ expand: ["artists,, albums ", "artists,tracks"], expand_limit: { albums: null, tracks: [] } }),
    { expand: ["artists", "albums", "tracks"] }
  );
});

test("buildRecordsQuery preserves malformed filters for downstream rejection", () => {
  assert.deepEqual(
    buildRecordsQuery({
      filter: "date.gte=2026-01-01",
      limit: 25,
    }),
    {
      filter: "date.gte=2026-01-01",
      limit: 25,
    }
  );

  assert.deepEqual(
    buildRecordsQuery({
      filter: ["date.gte=2026-01-01"],
    }),
    {
      filter: ["date.gte=2026-01-01"],
    }
  );
});

test("buildRecordsQuery keeps an opaque continuation and projection-free query", () => {
  assert.deepEqual(
    buildRecordsQuery({
      cursor: "fictional-next:part/2+3",
      fields: [],
      expand: [" ", ","],
      expand_limit: { related: null },
      view: "",
    }),
    { cursor: "fictional-next:part/2+3" }
  );
});

test("buildRecordsQuery preserves false and zero filter operands", () => {
  assert.deepEqual(
    buildRecordsQuery({ filter: { active: false, size: { eq: 0 } } }),
    { filter: { active: false, size: { eq: 0 } } }
  );
});

test("buildOwnerDeviceAuthorizationRequest builds x-www-form-urlencoded payloads", () => {
  const params = buildOwnerDeviceAuthorizationRequest({
    audience: "pdpp",
    client_id: "cli_longview",
    scope: "owner",
  });

  assert.equal(params.get("client_id"), "cli_longview");
  assert.equal(params.get("scope"), "owner");
  assert.equal(params.get("audience"), "pdpp");
});

test("buildRecordsQuery preserves an opaque continuation and connector selection exactly", () => {
  const cursor = "opaque+page/2==";
  assert.deepEqual(
    buildRecordsQuery({ cursor, connector_id: "fixture", view: "", fields: [], limit: 1 }),
    { cursor, connector_id: "fixture", limit: 1 }
  );
});

test("buildOwnerDeviceAuthorizationRequest preserves ordered repeated form values", () => {
  const form = buildOwnerDeviceAuthorizationRequest({
    client_id: "  fixture_cli  ",
    resource: ["urn:example:first?a=1&b=2", "", null, "urn:example:second + more"],
  });
  assert.deepEqual([...new URLSearchParams(form.toString())], [
    ["client_id", "fixture_cli"],
    ["resource", "urn:example:first?a=1&b=2"],
    ["resource", "urn:example:second + more"],
  ]);
});

test("buildParRequest lifts flat data-access inputs into authorization_details", () => {
  assert.deepEqual(
    buildParRequest({
      access_mode: "single_use",
      client_id: "concert_recommendation_app",
      purpose_code: "https://pdpp.dev/purpose/personalization",
      purpose_description: "Suggest concerts based on listening history",
      scenario_id: "scenario_contract_builders",
      source: { id: "spotify", kind: "connector" },
      streams: [{ fields: ["id", "name"], name: "top_artists" }],
    }),
    {
      authorization_details: [
        {
          access_mode: "single_use",
          purpose_code: "https://pdpp.dev/purpose/personalization",
          purpose_description: "Suggest concerts based on listening history",
          source: { id: "spotify", kind: "connector" },
          streams: [{ fields: ["id", "name"], name: "top_artists" }],
          type: "https://pdpp.dev/data-access",
        },
      ],
      client_id: "concert_recommendation_app",
      scenario_id: "scenario_contract_builders",
    }
  );
});

test("buildParRequest rejects legacy source scalar inputs", () => {
  const legacyInput: Record<string, unknown> = {
    connector_id: "spotify",
    purpose_code: "https://pdpp.dev/purpose/personalization",
  };
  assert.throws(() => buildParRequest(legacyInput), LEGACY_SOURCE_RE);
});
