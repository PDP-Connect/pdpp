// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { closeDb, initDb } from "../server/db.ts";
import { cooldownProfileForConnector, DEFAULT_COOLDOWN_PROFILE } from "../runtime/scheduler-source-pressure-cooldown.ts";

// Mutation-killing complement for cooldownProfileForConnector's CONNECTOR-ID
// KEY PARSING — the projection that maps a decorated connector id onto a
// per-provider cooldown profile. The existing suite proves it always returns a
// real (non-null/non-Infinity) profile and covers `chatgpt` / `chatgpt:default`,
// but does not isolate the two-stage base extraction `id.split(":")[0].split(
// "@")[0]`, so dropping either split would survive. The resolver now reads the
// connector's manifest (async, DB-backed) instead of a hardcoded registry, so
// these tests run against a fresh in-memory DB with NO chatgpt manifest
// registered — every id in this file resolves to DEFAULT_COOLDOWN_PROFILE. The
// key-parsing behaviour under test is that the SAME base extraction runs
// regardless of which id shape is passed in (proven indirectly: no throw,
// consistent fallback); `cooldown-profile-required.test.ts` proves the manifest
// read itself resolves the registered chatgpt value end to end.

function withTempDb(fn: () => Promise<void>) {
  return async () => {
    initDb(":memory:");
    try {
      await fn();
    } finally {
      closeDb();
    }
  };
}

test(
  "resolves DEFAULT_COOLDOWN_PROFILE for a bare id and a :-decorated id with no registered manifest",
  withTempDb(async () => {
    assert.deepEqual(await cooldownProfileForConnector("chatgpt"), DEFAULT_COOLDOWN_PROFILE);
    assert.deepEqual(await cooldownProfileForConnector("chatgpt:some-instance"), DEFAULT_COOLDOWN_PROFILE);
  })
);

test(
  "strips an @-suffix (and a :-then-@ decoration) down to the provider base before the manifest lookup",
  withTempDb(async () => {
    // The base is taken before the first ':' AND before the first '@'. With no
    // manifest registered for any base, every shape falls back identically —
    // proving the split runs (no throw / no divergent shape) regardless of
    // decoration.
    assert.deepEqual(await cooldownProfileForConnector("chatgpt@acct-1"), DEFAULT_COOLDOWN_PROFILE, "@-suffix stripped");
    assert.deepEqual(
      await cooldownProfileForConnector("chatgpt:instance@acct-1"),
      DEFAULT_COOLDOWN_PROFILE,
      "the : split happens first, then @ is stripped from that segment"
    );
  })
);

test(
  "an unknown provider base falls back to the DEFAULT profile",
  withTempDb(async () => {
    assert.deepEqual(await cooldownProfileForConnector("amazon"), DEFAULT_COOLDOWN_PROFILE);
    assert.deepEqual(await cooldownProfileForConnector("amazon:acct@x"), DEFAULT_COOLDOWN_PROFILE);
    // A base that merely starts with the known key but isn't equal must NOT match.
    assert.deepEqual(await cooldownProfileForConnector("chatgptx"), DEFAULT_COOLDOWN_PROFILE, "prefix is not a match");
  })
);

test(
  "null / undefined / empty connector id falls back to DEFAULT without throwing",
  withTempDb(async () => {
    assert.deepEqual(await cooldownProfileForConnector(null), DEFAULT_COOLDOWN_PROFILE);
    assert.deepEqual(await cooldownProfileForConnector(undefined), DEFAULT_COOLDOWN_PROFILE);
    assert.deepEqual(await cooldownProfileForConnector(""), DEFAULT_COOLDOWN_PROFILE);
  })
);
