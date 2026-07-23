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

test("buildParRequest lifts flat data-access inputs into authorization_details", () => {
  assert.deepEqual(
    buildParRequest({
      access_mode: "single_use",
      client_id: "concert_recommendation_app",
      purpose_code: "https://pdpp.org/purpose/personalization",
      purpose_description: "Suggest concerts based on listening history",
      scenario_id: "scenario_contract_builders",
      source: { id: "spotify", kind: "connector" },
      streams: [{ fields: ["id", "name"], name: "top_artists" }],
    }),
    {
      authorization_details: [
        {
          access_mode: "single_use",
          purpose_code: "https://pdpp.org/purpose/personalization",
          purpose_description: "Suggest concerts based on listening history",
          source: { id: "spotify", kind: "connector" },
          streams: [{ fields: ["id", "name"], name: "top_artists" }],
          type: "https://pdpp.org/data-access",
        },
      ],
      client_id: "concert_recommendation_app",
      scenario_id: "scenario_contract_builders",
    }
  );
});

test("buildParRequest rejects legacy source scalar inputs", () => {
  assert.throws(
    () =>
      buildParRequest({
        connector_id: "spotify",
        purpose_code: "https://pdpp.org/purpose/personalization",
      }),
    /source: \{ kind: 'connector' \| 'provider_native', id \}/
  );
});
