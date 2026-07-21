import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Proves the OpenSpec acceptance check for `complete-connector-query-affordances`:
 * "the response SHALL expose the manifest-declared search, range, and aggregation
 * affordances in field capabilities ... clients SHALL NOT need to inspect raw
 * manifest JSON to discover the supported query behavior."
 *
 * The reference server builds `field_capabilities[field]` generically in
 * `reference-implementation/server/index.js` (`buildFieldCapabilities`):
 *   - range_filter.declared  = Boolean(query.range_filters[field])
 *   - lexical_search.declared = query.search.lexical_fields.includes(field)
 *   - semantic_search.declared = query.search.semantic_fields.includes(field)
 *   - aggregation.group_by.declared = query.aggregations.group_by.includes(field)
 *   - aggregation.group_by_time.declared = query.aggregations.group_by_time.includes(field)
 *   - role = schema.properties[field].x_pdpp_role
 *
 * This test re-applies that exact projection rule to the SHIPPED manifests and
 * asserts that the affordances this change declared surface per-field. It pins
 * the projection contract against the manifest data without importing the
 * monolithic server module, and fails if a future manifest edit drops one of
 * these declarations.
 */

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MANIFESTS_DIR = join(PACKAGE_ROOT, "manifests");

interface JsonSchema {
  format?: string;
  type?: string | string[];
  x_pdpp_role?: string;
}
interface ManifestStream {
  name?: string;
  query?: {
    search?: { lexical_fields?: string[]; semantic_fields?: string[] };
    range_filters?: Record<string, unknown>;
    aggregations?: { group_by?: string[]; group_by_time?: string[] };
  };
  schema?: { properties?: Record<string, JsonSchema> };
}
interface ConnectorManifest {
  streams?: ManifestStream[];
}

interface Capability {
  declared: boolean;
  operators?: string[];
  usable: boolean;
}
interface FieldCapability {
  aggregation: { group_by: Capability; group_by_time: Capability };
  lexical_search: Capability;
  range_filter: Capability;
  role?: string;
  semantic_search: Capability;
}

/** Mirror of reference-implementation/server/index.js buildFieldCapabilities for the
 * affordance flags this change touches (granted=true: no field-scoped grant). */
function projectFieldCapabilities(stream: ManifestStream): Record<string, FieldCapability> {
  const properties = stream.schema?.properties ?? {};
  const range = stream.query?.range_filters ?? {};
  const lexical = new Set(stream.query?.search?.lexical_fields ?? []);
  const semantic = new Set(stream.query?.search?.semantic_fields ?? []);
  const groupBy = new Set(stream.query?.aggregations?.group_by ?? []);
  const groupByTime = new Set(stream.query?.aggregations?.group_by_time ?? []);

  const out: Record<string, FieldCapability> = {};
  for (const [field, schema] of Object.entries(properties)) {
    const operators = Array.isArray(range[field]) ? (range[field] as string[]) : null;
    const flag = (declared: boolean, ops?: string[] | null): Capability => ({
      declared,
      usable: declared,
      ...(declared && ops ? { operators: ops } : {}),
    });
    out[field] = {
      ...(schema.x_pdpp_role ? { role: schema.x_pdpp_role } : {}),
      range_filter: flag(Boolean(operators), operators),
      lexical_search: flag(lexical.has(field)),
      semantic_search: flag(semantic.has(field)),
      aggregation: {
        group_by: flag(groupBy.has(field)),
        group_by_time: flag(groupByTime.has(field)),
      },
    };
  }
  return out;
}

function loadStream(connectorKey: string, streamName: string): ManifestStream {
  const manifest = JSON.parse(readFileSync(join(MANIFESTS_DIR, `${connectorKey}.json`), "utf8")) as ConnectorManifest;
  const stream = (manifest.streams ?? []).find((s) => s.name === streamName);
  assert.ok(stream, `${connectorKey}.${streamName} not found`);
  return stream;
}

// Representative spot-checks across each affordance kind this change introduced.
const EXPECTATIONS: Array<{
  file: string;
  stream: string;
  field: string;
  check: (cap: FieldCapability) => void;
}> = [
  {
    file: "ical",
    stream: "events",
    field: "start",
    check: (c) => {
      assert.equal(c.range_filter.declared, true, "ical.events.start range");
      assert.equal(c.aggregation.group_by_time.declared, true, "ical.events.start group_by_time");
      assert.equal(c.role, "event-time", "ical.events.start role");
    },
  },
  {
    file: "ical",
    stream: "events",
    field: "status",
    check: (c) => assert.equal(c.aggregation.group_by.declared, true, "ical.events.status facet"),
  },
  {
    file: "google_takeout",
    stream: "search_history",
    field: "query",
    check: (c) => {
      assert.equal(c.lexical_search.declared, true, "search_history.query lexical");
      assert.equal(c.semantic_search.declared, true, "search_history.query semantic");
    },
  },
  {
    file: "oura",
    stream: "sleep",
    field: "day",
    check: (c) => {
      assert.equal(c.range_filter.declared, true, "oura.sleep.day range");
      assert.deepEqual(c.range_filter.operators, ["gte", "gt", "lte", "lt"], "range operators surface");
      assert.equal(c.aggregation.group_by_time.declared, true, "oura.sleep.day group_by_time");
    },
  },
  {
    file: "uber",
    stream: "trips",
    field: "status",
    check: (c) => assert.equal(c.aggregation.group_by.declared, true, "uber.trips.status facet"),
  },
  {
    file: "uber",
    stream: "trips",
    field: "driver_name",
    check: (c) => assert.equal(c.lexical_search.declared, true, "uber.trips.driver_name lexical"),
  },
  {
    file: "meta",
    stream: "posts",
    field: "taken_at",
    check: (c) => assert.equal(c.role, "event-time", "meta.posts.taken_at role"),
  },
];

test("declared query affordances project into field_capabilities", () => {
  for (const { file, stream, field, check } of EXPECTATIONS) {
    const caps = projectFieldCapabilities(loadStream(file, stream));
    const cap = caps[field];
    assert.ok(cap, `${file}.${stream}.${field} missing from projection`);
    check(cap);
  }
});
