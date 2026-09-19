// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Path composition against a target's declared query base.
//
// Protected risk: the suite hardcoding "/v1" and thereby failing a conforming
// server that mounts its query surface elsewhere. Core does not fix the prefix —
// Section 8 publishes `pdpp_core_query_base` in the RFC 9728 metadata document
// specifically "so a client composes a record query without assuming a version
// segment". A suite that assumed it would be testing its own convention rather
// than the specification, and would report a conforming target as broken.
//
// This is not hypothetical: the first real target the suite ran against (the
// PDP-Connect reference operations served by apps/site) mounts its surface at
// `/sandbox/v1`, and every case would have 404'd against it.
//
// A cheaper test is insufficient because the defect is in how a case composes
// its URL, which only shows up once a context is built from a target whose base
// differs from the default.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SeededStream } from "../src/harness/adapter.ts";
import { makeContext } from "../src/harness/runner.ts";
import { HttpTargetAdapter } from "../src/targets/http-target.ts";
import { ReferenceTargetAdapter } from "../src/targets/reference-adapter.ts";

const STREAMS: readonly SeededStream[] = [
  {
    name: "conversations",
    fields: ["id", "title"],
    primaryKey: ["id"],
    semantics: "append_only",
    recordCount: 1,
  },
];

describe("endpoint paths follow the target's declared query base", () => {
  it("defaults to /v1 when a target declares no base", () => {
    const context = makeContext(new ReferenceTargetAdapter(), STREAMS);
    assert.equal(context.path("/streams"), "/v1/streams");
    assert.equal(context.wellKnownPath(), "/.well-known/oauth-protected-resource");
  });

  it("uses a declared base, so a target mounting elsewhere is not falsely failed", () => {
    const adapter = new HttpTargetAdapter({
      targetId: "example",
      targetVersion: "0",
      baseUrl: "http://127.0.0.1:1",
      queryBase: "/sandbox/v1",
      wellKnownPath: "/sandbox/well-known/oauth-protected-resource",
      roles: ["resource-server"],
      capabilities: {
        separatedDeployment: false,
        ownerTokens: false,
        selfExport: false,
        incrementalSync: false,
        views: false,
        singleUseGrants: false,
        refreshTokens: false,
        blobs: false,
      },
      streams: STREAMS,
    });
    const context = makeContext(adapter, STREAMS);
    assert.equal(context.path("/streams"), "/sandbox/v1/streams");
    assert.equal(context.path("/streams/conversations/records"), "/sandbox/v1/streams/conversations/records");
    assert.equal(context.wellKnownPath(), "/sandbox/well-known/oauth-protected-resource");
  });

  it("tolerates a trailing slash in the declared base rather than doubling it", () => {
    const adapter = new HttpTargetAdapter({
      targetId: "example",
      targetVersion: "0",
      baseUrl: "http://127.0.0.1:1",
      queryBase: "/api/",
      roles: ["resource-server"],
      capabilities: {
        separatedDeployment: false,
        ownerTokens: false,
        selfExport: false,
        incrementalSync: false,
        views: false,
        singleUseGrants: false,
        refreshTokens: false,
        blobs: false,
      },
      streams: STREAMS,
    });
    assert.equal(makeContext(adapter, STREAMS).path("/streams"), "/api/streams");
  });
});
