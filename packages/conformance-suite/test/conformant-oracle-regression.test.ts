// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import { it } from "node:test";
import type { GrantRequest, TargetAdapter } from "../src/harness/adapter.ts";
import { createPdppClientUnderTest } from "../src/harness/client-adapter.ts";
import { makeContext, runCase } from "../src/harness/runner.ts";
import { ALL_CASES } from "../src/suite.ts";
import { ReferenceTargetAdapter } from "../src/targets/reference-adapter.ts";
import { compareDateTimes, parseDateTime } from "../src/targets/rfc3339.ts";

const SOURCE_CASE = "AS-16/client-does-not-introduce-authority-or-declaration-uri";
const COPY_CASE = "CL-5/beginning-session-replaces-the-stored-copy";
const BOUND_CASE = "AS-15/final-approval-artifact-states-bound-inclusivity";
const RANGE_CASE = "RS-1/blob-range-support-is-advertised";
const WINDOW_CASE = "RS-7/record-leaving-time-window-surfaces-as-a-tombstone";
const INSTANT_CASE = "RS-22/time-window-compared-as-instants-not-text";
function caseById(id: string) {
  const found = ALL_CASES.find((c) => c.caseId === id);
  assert.ok(found);
  return found;
}
it("finding 3: a complete envelope may contain type, purpose and view URIs", async () => {
  const client = await createPdppClientUnderTest([]);
  const authorize = client.authorize.bind(client);
  const variant = Object.create(client) as typeof client;
  variant.authorize = (selection) =>
    authorize({
      ...selection,
      type: "https://pdpp.dev/data-access",
      purpose_code: "https://example.test/purpose",
      streams: [{ name: "fixture_stream", view: "https://example.test/view" }],
    });
  try {
    const result = await runCase(caseById(SOURCE_CASE), {
      ...makeContext(new ReferenceTargetAdapter(), []),
      client: variant,
    });
    assert.equal(result.outcome, "pass", result.detail ?? "(no detail)");
  } finally {
    await client.fixture.close();
  }
});
it("finding 12: stored copies are sets, not sorted arrays", async () => {
  const client = await createPdppClientUnderTest([]);
  const variant = Object.create(client) as typeof client;
  variant.storedCopy = (stream) => [...(client.storedCopy?.(stream) ?? [])].reverse();
  try {
    const result = await runCase(caseById(COPY_CASE), {
      ...makeContext(new ReferenceTargetAdapter(), []),
      client: variant,
    });
    assert.equal(result.outcome, "pass", result.detail ?? "(no detail)");
  } finally {
    await client.fixture.close();
  }
});
it("finding 12: duplicate IDs are not a valid replacement set", async () => {
  const client = await createPdppClientUnderTest([]);
  const variant = Object.create(client) as typeof client;
  variant.storedCopy = (stream) => {
    const copy = [...(client.storedCopy?.(stream) ?? [])];
    return [...copy, ...copy];
  };
  try {
    const result = await runCase(caseById(COPY_CASE), {
      ...makeContext(new ReferenceTargetAdapter(), []),
      client: variant,
    });
    assert.equal(result.outcome, "fail", result.detail ?? "(no detail)");
  } finally {
    await client.fixture.close();
  }
});

const streams = [
  {
    name: "events",
    fields: ["id", "time"],
    primaryKey: ["id"],
    recordCount: 4,
    semantics: "mutable_state",
    consentTimeField: "time",
  },
] as Parameters<typeof makeContext>[1];
async function runHttp(id: string, listener: RequestListener, hooks: Record<string, unknown> = {}) {
  const server = createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const adapter = Object.create(new ReferenceTargetAdapter()) as TargetAdapter;
  Object.defineProperties(
    adapter,
    Object.fromEntries(
      Object.entries({
        baseUrl: `http://127.0.0.1:${address.port}`,
        ownerToken: async (): Promise<string> => "owner",
        issueGrant: async () => ({ accessToken: "grant", grantId: "g" }),
        ...hooks,
      }).map(([key, value]) => [key, { value, configurable: true }])
    )
  );
  try {
    return await runCase(caseById(id), makeContext(adapter, streams));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}
for (const length of [1, 2, 3]) {
  it(`finding 9: accepts a conformant ${length}-byte range fixture`, async () => {
    const bytes = Buffer.alloc(length, 65);
    const result = await runHttp(
      RANGE_CASE,
      (req, res) => {
        const { range } = req.headers;
        const end = range ? Math.min(Number(range.split("-")[1]), bytes.length - 1) : bytes.length - 1;
        const body = bytes.subarray(0, end + 1);
        res
          .writeHead(range ? 206 : 200, {
            "accept-ranges": "bytes",
            "content-length": String(body.length),
            ...(range ? { "content-range": `bytes 0-${end}/${length}` } : {}),
          })
          .end(body);
      },
      { blobFixture: async () => ({ blobId: "blob", grantRequest: { streams: [{ name: "events" }] } }) }
    );
    assert.equal(result.outcome, "pass", result.detail ?? "(no detail)");
  });
}
it("finding 9: an empty blob cannot arrange a satisfiable byte range", async () => {
  const result = await runHttp(RANGE_CASE, (req, res) => res.writeHead(req.headers.range ? 416 : 200).end(), {
    blobFixture: async () => ({ blobId: "blob", grantRequest: { streams: [{ name: "events" }] } }),
  });
  assert.equal(result.outcome, "skip", result.detail ?? "(no detail)");
});

for (const dateOnly of [false, true]) {
  it(`finding 10: moves a record before a 1999 cutoff (${dateOnly ? "date" : "date-time"})`, async () => {
    const rows = [1, 2, 3, 4].map((day) => ({
      id: String(day),
      data: { time: `1999-01-0${day}${dateOnly ? "" : "T00:00:00Z"}` },
    }));
    let since = "";
    let moved = "";
    let original = "";
    // A resumed sync reports the moved record as a tombstone once it falls before the bound.
    const grantedPage = (changesSince: string | null) => {
      if (changesSince !== "next") {
        return rows.filter((r) => r.data.time >= since);
      }
      if (!moved) {
        return [];
      }
      const movedRow = rows.find((r) => r.id === moved);
      assert.ok(movedRow);
      return movedRow.data.time < since ? [{ id: moved, deleted: true }] : [];
    };
    const result = await runHttp(
      WINDOW_CASE,
      (req, res) => {
        const query = new URL(req.url ?? "/", "http://fixture.test").searchParams;
        const owner = req.headers.authorization === "Bearer owner";
        const data = owner ? rows : grantedPage(query.get("changes_since"));
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            object: "list",
            data,
            has_more: false,
            next_changes_since: "next",
          })
        );
      },
      {
        issueGrant: (request: GrantRequest) => {
          const from = request.timeConstraint?.from;
          assert.ok(from !== undefined, "the window grant must carry a from bound");
          since = from;
          return Promise.resolve({ accessToken: "grant", grantId: "g" });
        },
        writeRecordField: (_stream: string, id: string, _field: string, value: string) => {
          const row = rows.find((r) => r.id === id);
          assert.ok(row, `no fixture row ${id}`);
          moved = id;
          original = row.data.time;
          row.data.time = value;
          return Promise.resolve(true);
        },
      }
    );
    assert.equal(result.outcome, "pass", result.detail ?? "(no detail)");
    const finalRow = rows.find((r) => r.id === moved);
    assert.ok(moved && original >= since && finalRow && finalRow.data.time < since);
  });
}
async function runFractional(paginated: false | "owner" | "grant" = false, pivot = "12:00:00.500Z") {
  const rows = ["11:00:00.250Z", pivot, "13:00:00.750Z"].map((time, index) => ({
    id: String(index),
    data: { time: `2026-01-01T${time}` },
  }));
  let bound = "";
  const result = await runHttp(
    INSTANT_CASE,
    (req, res) => {
      const owner = req.headers.authorization === "Bearer owner";
      const data = owner ? rows : rows.filter((r) => Date.parse(r.data.time) >= Date.parse(bound));
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          object: "list",
          data,
          has_more: paginated === (owner ? "owner" : "grant"),
          ...(paginated ? { next_cursor: "more" } : {}),
        })
      );
    },
    {
      issueGrant: (request: GrantRequest) => {
        const from = request.timeConstraint?.from;
        assert.ok(from !== undefined, "the grant must carry a from bound");
        bound = from;
        return Promise.resolve({ accessToken: "grant", grantId: "g" });
      },
    }
  );
  if (!paginated) {
    assert.equal(bound, `2026-01-02T01:${pivot.slice(3, -1)}+14:00`, "The serialized bound keeps all fraction digits");
  }
  return result;
}
it("finding 11: offset bounds preserve a fractional pivot", async () => {
  const result = await runFractional();
  assert.equal(result.outcome, "pass", result.detail ?? "(no detail)");
});
it("finding 11: an incomplete listing does not claim a full comparison", async () => {
  const result = await runFractional("owner");
  assert.equal(result.outcome, "skip", result.detail ?? "(no detail)");
});

it("finding 11: a paginated granted read cannot claim a full comparison", async () => {
  const result = await runFractional("grant");
  assert.equal(result.outcome, "skip", result.detail ?? "(no detail)");
});
it("finding 11: offset serialization retains sub-millisecond digits", async () => {
  const result = await runFractional(false, "12:00:00.50000000000001Z");
  assert.equal(result.outcome, "pass", result.detail ?? "(no detail)");
});

for (const artifact of [
  {
    since: { value: "2026-01-01T00:00:00Z", comparison: "gte" },
    until: { value: "2026-12-01T00:00:00Z", comparison: "lt" },
  },
  { since: "2026-01-01T00:00:00Z", until: "2026-12-01T00:00:00Z", description: "desde incluido; hasta excluido" },
]) {
  it("finding 4: non-English or operator semantics are not falsely failed", async () => {
    const adapter = Object.create(new ReferenceTargetAdapter()) as TargetAdapter;
    Object.defineProperty(adapter, "stageApproval", {
      configurable: true,
      value: async () => ({
        handle: "review",
        approvalArtifact: async () => artifact,
        approve: async () => null,
      }),
    });
    const result = await runCase(caseById(BOUND_CASE), makeContext(adapter, streams));
    assert.equal(result.outcome, "skip", result.detail ?? "(no detail)");
    assert.ok(result.evidence?.length, "Review-only results retain the artifact");
  });
}
it("finding 4: reversed bound words must not earn a pass", async () => {
  const adapter = Object.create(new ReferenceTargetAdapter()) as TargetAdapter;
  Object.defineProperty(adapter, "stageApproval", {
    configurable: true,
    value: async () => ({
      handle: "review",
      approvalArtifact: async () => ({
        since: "2026-01-01T00:00:00Z",
        until: "2026-12-01T00:00:00Z",
        semantics: { since: "exclusive", until: "inclusive" },
      }),
      approve: async () => null,
    }),
  });
  const result = await runCase(caseById(BOUND_CASE), makeContext(adapter, streams));
  assert.notEqual(result.outcome, "pass", result.detail ?? "(no detail)");
});
it("finding 14: UTC and offset leap seconds are valid and strictly ordered", () => {
  const before = parseDateTime("2016-12-31T23:59:59.999999Z");
  const leap = parseDateTime("2016-12-31T23:59:60.123456Z");
  const offset = parseDateTime("2017-01-01T00:59:60.123456+01:00");
  const after = parseDateTime("2017-01-01T00:00:00Z");
  assert.ok(before && leap && offset && after);
  assert.ok(compareDateTimes(before, leap) < 0);
  assert.equal(compareDateTimes(leap, offset), 0);
  assert.ok(compareDateTimes(leap, after) < 0);
});
it("finding 14: invalid leap dates, minutes and offsets remain invalid", () => {
  for (const value of [
    "2016-12-30T23:59:60Z",
    "2016-12-31T12:59:60Z",
    "2017-01-01T00:59:60Z",
    "2016-12-31T23:59:61Z",
    "2016-12-31T23:59:60+01:00",
  ]) {
    assert.equal(parseDateTime(value), null, value);
  }
});
