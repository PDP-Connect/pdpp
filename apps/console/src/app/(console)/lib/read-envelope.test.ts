import assert from "node:assert/strict";
import { test } from "node:test";
import { adaptListEnvelope, extractReadWarnings } from "./read-envelope.ts";

test("adaptListEnvelope returns empty defaults for non-object input", () => {
  const env = adaptListEnvelope<unknown>(null);
  assert.deepEqual(env.data, []);
  assert.equal(env.has_more, false);
  assert.equal(env.next_cursor, null);
  assert.deepEqual(env.links, { next: null, self: null });
  assert.deepEqual(env.meta, { count: null, warnings: [] });
});

test("adaptListEnvelope preserves legacy { data, has_more, next_cursor }", () => {
  const env = adaptListEnvelope<{ id: string }>({
    data: [{ id: "rec_1" }],
    has_more: true,
    next_cursor: "cursor_abc",
  });
  assert.deepEqual(env.data, [{ id: "rec_1" }]);
  assert.equal(env.has_more, true);
  assert.equal(env.next_cursor, "cursor_abc");
  assert.equal(env.links.next, null);
});

test("adaptListEnvelope reads canonical links.next and meta.warnings when present", () => {
  const env = adaptListEnvelope<{ id: string }>({
    data: [],
    has_more: false,
    links: { self: "/v1/streams/x/records", next: "/v1/streams/x/records?cursor=abc" },
    meta: {
      warnings: [
        { code: "deprecated_alias", message: "connector_instance_id is deprecated" },
        { code: "count_downgraded", dropped_parameter: "count=exact" },
      ],
      count: { kind: "estimated", value: 42 },
    },
  });
  assert.equal(env.links.self, "/v1/streams/x/records");
  assert.equal(env.links.next, "/v1/streams/x/records?cursor=abc");
  assert.equal(env.meta.warnings.length, 2);
  assert.equal(env.meta.warnings[0]?.code, "deprecated_alias");
  assert.deepEqual(env.meta.count, { kind: "estimated", value: 42 });
});

test("adaptListEnvelope drops malformed warnings without throwing", () => {
  const env = adaptListEnvelope<unknown>({
    data: [],
    meta: {
      warnings: ["not-an-object", { message: "missing-code" }, { code: "ok" }, null],
    },
  });
  // Only the well-formed `{ code: 'ok' }` entry survives.
  assert.deepEqual(
    env.meta.warnings.map((w) => w.code),
    ["ok"]
  );
});

test("adaptListEnvelope ignores unknown count kinds", () => {
  const env = adaptListEnvelope<unknown>({
    data: [],
    meta: { count: { kind: "approximate", value: 7 } },
  });
  assert.equal(env.meta.count, null);
});

test("extractReadWarnings works on single-record envelopes", () => {
  const warnings = extractReadWarnings({
    object: "record",
    data: { id: "rec_1" },
    meta: { warnings: [{ code: "skipped_source", message: "x not applicable" }] },
  });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.code, "skipped_source");
});

test("extractReadWarnings tolerates missing meta", () => {
  assert.deepEqual(extractReadWarnings({ data: {} }), []);
  assert.deepEqual(extractReadWarnings(undefined), []);
});
