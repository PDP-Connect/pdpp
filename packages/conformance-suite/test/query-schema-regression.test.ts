// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { it } from "node:test";
import { grantSchemaViolations } from "../src/harness/grant-schema.ts";
import { makeContext, runCase } from "../src/harness/runner.ts";
import { CLAUSE_MATRIX } from "../src/requirements/matrix.ts";
import { DEFAULT_FIXTURES, ReferenceTargetAdapter } from "../src/targets/reference-adapter.ts";
import { ReferenceServer } from "../src/targets/reference-server.ts";
import { QUERY_SURFACE_CASES } from "../src/tests/query-surface.ts";
import { APPEND_ONLY_ONLY } from "./fixtures/append-only-only-target.ts";

for (const type of [undefined, "integer"]) {
  it(`time_constraint rejects ${String(type)} type`, () => {
    const violations = grantSchemaViolations({
      version: "0.1.0",
      grant_id: "g",
      issued_at: "2026-01-01T00:00:00Z",
      subject: { id: "s" },
      client: { client_id: "c" },
      source: { kind: "connector", id: "https://example.test/source" },
      source_declaration: { version: "1" },
      purpose_code: "https://example.test/purpose",
      access_mode: "continuous",
      expires_at: "2027-01-01T00:00:00Z",
      streams: [
        {
          name: "events",
          instance_ids: ["i"],
          fields: ["id"],
          time_constraint: { field: "created", type, since: "2026-01-01T00:00:00Z" },
        },
      ],
    });
    assert.ok(violations.some((v) => v.path === "streams[0].time_constraint.type"));
  });
}

for (const id of [
  "6.8-8",
  "6.8-9",
  "6.8-12",
  "8.9-17",
  "4.3-6",
  "4.3-9",
  "4.3-11",
  "7.2-2",
  "7.5-7",
  "6.8-10",
  "6.8-11",
]) {
  it(`admitted multipart gap ${id} remains partial`, () => {
    assert.equal(CLAUSE_MATRIX.find((clause) => clause.clauseId === id)?.partial, true);
  });
}

for (const caseId of [
  "RS-8/terminal-page-carries-next-changes-since",
  "RS-6/cursor-not-accepted-as-changes-since",
  "RS-7/expired-sync-cursor-reported-as-gone",
]) {
  it(`append-only inventory exercises ${caseId}`, async () => {
    const adapter = new ReferenceTargetAdapter(APPEND_ONLY_ONLY);
    const { streams } = await adapter.setup();
    try {
      const test = QUERY_SURFACE_CASES.find((c) => c.caseId === caseId);
      assert.ok(test);
      const result = await runCase(test, makeContext(adapter, streams));
      assert.equal(result.outcome, "pass", result.detail ?? "(no detail)");
    } finally {
      await adapter.teardown();
    }
  });
}

it("sparse tombstones pass when owner sync tokens bind their query context", async () => {
  const adapter = new ReferenceTargetAdapter();
  const { streams } = await adapter.setup();
  const contexts = new Map<string, string>();
  const proxy = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", adapter.baseUrl);
    const context = JSON.stringify(
      [...url.searchParams.entries()]
        .filter(([key]) => key === "fields" || key === "view" || key.startsWith("filter["))
        .sort((a, b) => {
          // Default sort order: each entry as its "key,value" text, by UTF-16 code unit.
          const left = String(a);
          const right = String(b);
          if (left === right) {
            return 0;
          }
          return left < right ? -1 : 1;
        })
    );
    const token = url.searchParams.get("changes_since");
    if (token && contexts.has(token) && contexts.get(token) !== context) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { code: "invalid_cursor", type: "invalid_request_error", message: "Query context differs." },
        })
      );
      return;
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string" && key !== "host") {
        headers.set(key, value);
      }
    }
    const upstream = await fetch(url, { method: req.method ?? "GET", headers });
    const body = await upstream.text();
    const json = (body ? JSON.parse(body) : {}) as { next_changes_since?: string };
    if (json.next_changes_since) {
      contexts.set(json.next_changes_since, context);
    }
    res.writeHead(upstream.status, { "content-type": "application/json" });
    res.end(body);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  try {
    const wrapped = Object.create(adapter, {
      baseUrl: { value: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}` },
    }) as ReferenceTargetAdapter;
    const test = QUERY_SURFACE_CASES.find((c) => c.caseId === "RS-7/tombstone-envelope-survives-sparse-fields");
    assert.ok(test);
    const result = await runCase(test, makeContext(wrapped, streams));
    assert.equal(result.outcome, "pass", result.detail ?? "(no detail)");
  } finally {
    await new Promise<void>((resolve, reject) => proxy.close((error) => (error ? reject(error) : resolve())));
    await adapter.teardown();
  }
});

for (const type of ["date", "date-time"] as const) {
  it(`published grants freeze declaration-resolved ${type} type`, () => {
    const [fixture] = DEFAULT_FIXTURES;
    assert.ok(fixture);
    const server = new ReferenceServer([{ ...fixture, consentTimeField: "created", consentTimeFormat: type }]);
    const grant = server.issueGrant([
      {
        name: fixture.name,
        fields: [...fixture.fields],
        timeConstraint: { field: "created", from: type === "date" ? "2026-01-01" : "2026-01-01T00:00:00Z" },
      },
    ]);
    assert.ok(grant && "grantId" in grant);
    const artifact = server.issuedGrantArtifact(grant.grantId);
    assert.ok(artifact);
    const streams = artifact.streams as { time_constraint: { type?: string } }[];
    assert.equal(streams[0]?.time_constraint.type, type);
    assert.deepEqual(grantSchemaViolations(artifact), []);
  });
}

for (const [caseId, defect] of [
  ["RS-8/terminal-page-carries-next-changes-since", "omit-next-changes-since"],
  ["RS-6/cursor-not-accepted-as-changes-since", "accept-page-cursor-as-changes-since"],
  ["RS-7/expired-sync-cursor-reported-as-gone", "misclassify-expired-sync-cursor"],
] as const) {
  it(`append-only violation fails ${caseId}`, async () => {
    const adapter = new ReferenceTargetAdapter(APPEND_ONLY_ONLY, new Set([defect]));
    const { streams } = await adapter.setup();
    try {
      const test = QUERY_SURFACE_CASES.find((c) => c.caseId === caseId);
      assert.ok(test);
      const result = await runCase(test, makeContext(adapter, streams));
      assert.equal(result.outcome, "fail", result.detail ?? "(no detail)");
    } finally {
      await adapter.teardown();
    }
  });
}
