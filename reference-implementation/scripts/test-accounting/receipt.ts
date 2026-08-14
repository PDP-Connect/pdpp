// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

const RESULT_PREFIX = "PDPP_TEST_ACCOUNTING_RESULT ";
const EVENT_PREFIX = "PDPP_TEST_ACCOUNTING_EVENT ";

function fail(message: string): never {
  throw new Error(`test accounting result: ${message}`);
}
function compareStrings(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

export function accountingResultLine(result: unknown): string {
  return `${RESULT_PREFIX}${JSON.stringify(result)}`;
}
export function accountingEventLine(event: unknown): string {
  return `${EVENT_PREFIX}${JSON.stringify(event)}`;
}

// Node's boolean `skip: !X` tests carry no reason on the wire, only their name.
// Most name their reason inline as `(skipped: ...)`, but a cohort of RI tests
// skip via a bare boolean with no name suffix. Each exact name below was
// traced to its literal `skip:` expression in source (not guessed from the
// name), so this is a closed, exact set — not a wildcard on "any unexplained
// skip while some env var happens to be unset".
//
// This is an EXACT NAMED MAPPING from an emitted skipped-test identity to its
// declared reason. It is authored as an ORDER-PRESERVING ARRAY, not a Set,
// precisely so a duplicated row is detectable: `assertNoDuplicateMappingRows`
// rejects duplicates BEFORE any lookup Set is built (a Set would silently
// collapse them). The set-equality join in the accounting suite then requires
// every configured row here to be CONSUMED by a real emitted skip and every
// emitted named-mapping skip to be configured here — so a stale row (matching
// no emitted identity, e.g. after a test is renamed or its title gains a
// `(skipped: ...)` suffix and moves to the self-describing path) fails closed,
// and loop-generated 1-to-N identities resolve naturally because the join is
// over emitted identities, never over static source occurrences.
export const POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS: readonly string[] = [
  "PostgreSQL device-ingest conformance: derived repair and canonical records",
  "PostgreSQL device-ingest conformance: device/direct writer collision matrix",
  "PostgreSQL device-ingest conformance: duplicate and newer writer matrix",
  "PostgreSQL device-ingest conformance: phase fault/resume matrix",
  "PostgreSQL device-ingest conformance: registration/backfill ordering",
  "PostgreSQL device-ingest conformance: simultaneous identity matrix",
  "PostgreSQL device-ingest conformance: stranded processing diagnostics",
  "PostgreSQL scheduler page batches match SQLite semantics and use one typed-array query per non-empty axis",
  "PostgreSQL: a crash before the reconciliation transaction commits leaves scheduler_run_history fully intact for a clean retry",
  "PostgreSQL: an accepted replay of an already-committed batch prefix advances neither the checkpoint nor repair work",
  "PostgreSQL: connector-wide invalidation (deleteAllRecordsForConnector) is detected and repaired by the summary primitive without a per-record dirty hook",
  "PostgreSQL: a fresh install is unaffected by the fleet-migration repair",
  "PostgreSQL: a pre-renamed-stuck database is repaired on the next boot, idempotently, with row/id/index preservation",
  "PostgreSQL: a run.started write succeeds against a database migrated from legacy scheduler_run_history",
  "PostgreSQL: interrupted migration reconciles losslessly against real Postgres — overlap merges, disjoint rows preserved, duplicate run_id across connections survives",
  "PostgreSQL: migration builds the composite unique index over live duplicate-run_id data (the exact 42P10 failure this fix closes), preserving both connections' rows",
  "PostgreSQL: two different connections sharing a run_id each get their own run_history row via the live spine writer",
  "PostgreSQL: two scheduler_run_history rows sharing the identical composite key deduplicate to the latest (highest id) before merge — the exact fourth-pass gate reproduction",
  "PostgreSQL: zero spine_events statements for a connection with no run at all",
  "PostgreSQL: zero spine_events statements for a terminal run's GET",
  "PostgreSQL: zero spine_events statements for an in-progress run's GET (collection_rate merged via run.progress_reported)",
  "Postgres ClientEventSubscriptionStore round-trips a full lifecycle",
  "Postgres ConnectorInstanceStore conforms when PDPP_TEST_POSTGRES_URL is set",
  "Postgres DeviceExporterStore conforms when PDPP_TEST_POSTGRES_URL is set",
  "Postgres SourceWebhookEventStore claims each source event once when PDPP_TEST_POSTGRES_URL is set",
  "Postgres WebPushSubscriptionStore conforms when PDPP_TEST_POSTGRES_URL is set",
  "Postgres bootstrap widens a legacy connector_instances status CHECK to draft",
  "Postgres browser generation hash upsert preserves same-container state and clears on container replacement",
  "Postgres scoped browser-surface reads match filtered global rows for 0, 1, and 25 identities",
  "Postgres clears stale profile provenance on a profile-key change and accepts an explicit replacement",
  "Postgres connector-summary evidence reaches the same rebuild/dirty/reconcile shape",
  "Postgres ground-truth streams + for-keys produce the same shaped facts as SQLite",
  "Postgres introspection keeps the issued declaration snapshot authoritative",
  "Postgres migrates legacy accepted outcomes to equal named terminal cursor facts",
  "Postgres pool saturation and unlock uncertainty destroy the lock session",
  "Postgres preserves new run identity and rejects an unbound writer",
  "Postgres replacement ledger matches SQLite append/order/selection contract",
  "Postgres retained-size reads shape identically to SQLite for global/connection/stream/record-family/top grains",
  "Postgres retained-size top rows preserve rejection byte and count measures after reconcile",
  "Postgres revokeDevice cascades revoked status when PDPP_TEST_POSTGRES_URL is set",
  "Postgres revokeDevice spares shared connector_instance when PDPP_TEST_POSTGRES_URL is set",
  "Postgres simultaneous empty public bootstraps use polling without concurrent-index deadlock",
  "Postgres simultaneous legacy boots serialize priority migration before catalog discovery",
  "Postgres sort repair fences all manifest streams for an instance and blob binding respects the same fence",
  "Postgres startup does not require pg_search and keeps native FTS as fallback",
  "Postgres store factory is consistent with the resolver",
  "Postgres terminal LIST projection rejects late canonical snapshots",
  "an actual PostgreSQL advisory-session disconnect leaks no lock and the same key recovers",
  "dedicated PostgreSQL manifest generations fence historical facts and undeclared-write provenance",
  "dedicated Postgres processing reservation acceptance locks and fences current manifest and semantic identity",
  "deleteAllRecordsForConnector (PostgreSQL) dirties every instance it clears",
  "real PostgreSQL persisted private coverage STATE fails closed and does not echo the sentinel",
  "real PostgreSQL probe 3: simultaneous fold failure AND terminal-facts-failed-marker write failure still fails closed through the real production read",
  "real PostgreSQL probe 4: simultaneous discovery failure AND discovery-failed-marker write failure still fails closed through the real production read",
  "real PostgreSQL: a bounded pass (maxEvents:1) processes AT MOST one event and stays stale/incomplete, never current",
  "real PostgreSQL: a future-version row is never folded/replayed/mutated durably — this binary fails it closed at read time only",
  "real PostgreSQL: a later cancelled/not_committed attempt does not regress an already-durably-proven stream",
  "real PostgreSQL: a later committed success still advances past a prior committed proof (forward progress unaffected)",
  "real PostgreSQL: discovery query count for N=25 is within a small constant factor of N=1, never N=25x",
  "real PostgreSQL: exact-boundary convergence — a maxEvents budget equal to the remaining history reads current, not falsely incomplete",
  "real PostgreSQL: existing-row self-heal — a row pre-seeded in the exact pre-fix corrupted shape heals via an ordinary reconcile call",
  "real PostgreSQL: foldConnectorSummaryStreamFacts respects an explicit maxEvents budget, reports incomplete, and a follow-up call resumes to the unbounded oracle value",
  "real PostgreSQL: getConnectorSummaryForRoute (discovery + fold + synthesis) query count for N=25 stays within a small constant factor of N=1",
  "real PostgreSQL: multi-round resume — bounded rounds accumulate and only the genuinely converged final round reads current",
  "real PostgreSQL: recompute/self-heal — a full rebuild from existing event history reproduces the same monotonic result as the incremental fold",
  "real PostgreSQL: recovery-only interaction — genuine success -> recovery-only successes -> interleaved cancelled attempt -> stored fact still reads the original committed proof",
  "real PostgreSQL: repair work is proportional to K candidates, not N total connections",
  "real PostgreSQL: runBoundedSummaryEvidenceSweep reports incomplete and skips complete pruning when a page's fold does not converge, then resumes",
  "real PostgreSQL: scoped fold reads/folds ONLY the target connection's terminal history despite 4,001 unrelated terminal events",
  "real PostgreSQL: the backfill does not cross connections and leaves genuinely unattributable legacy events NULL",
  "real PostgreSQL: the real mounted route resolves correctly despite thousands of unrelated terminal events",
  "real disposable PostgreSQL reset-generation matches the SQLite union-rule contract",
  "real disposable PostgreSQL: connector-wide reset discovers and clears a counter-only namespace on production connector invalidation (Sol third-verdict P2.2)",
  "real PostgreSQL: the 25-row first-page starvation shape folds before slow generic repairs and survives restart/resume",
  "real PostgreSQL mutation: a 1ms cold 25-row page starts at most one slow repair and later converges",
  "real PostgreSQL mutation: a 1ms 2,001-event fold is capped and resumes from its durable checkpoint",
  "real PostgreSQL mutation: an expired fold stops its delayed participant checkpoint-write tail after one started write",
];
// Every row above uses a PER-TEST boolean `skip` (e.g. `skip: !PDPP_TEST_POSTGRES_URL`)
// inside a file that still REGISTERS the test under every profile. Under
// memory-default it emits a named skip event; under postgres it runs for real,
// so this table applies only to memory-default.
//
// A DIFFERENT shape exists: a named test nested inside a file's OUTER
// structural gate (`if (!DEDICATED_POSTGRES_URL) {...} else { test(...) }`)
// does not register AT ALL under the profile where the outer gate is closed —
// only the outer synthetic self-describing skip fires there, consuming no
// row. Such a row must be scoped to ONLY the profile(s) under which its test
// structurally registers, or the opposite-direction profile's run would fail
// closed on a stale row it could never have consumed. This table is exactly
// those rows, each declaring its exact registering profile(s) explicitly.
const PROFILE_SCOPED_POSTGRES_SKIP_TEST_NAME_ROWS: readonly (readonly [string, readonly MappingProfileScope[]])[] = [
  [
    "real local child + PostgreSQL HTTP preserves exact 100-record output, latency, lifecycle, and privacy",
    ["postgres"],
  ],
];
// Order-preserving rows for the per-name mapping too, so a duplicate emitted
// identity (mapped to two different or identical reasons) is rejected before
// the lookup Map is built, exactly like the postgres cohort above. Each row
// carries the SUITE SCOPE under which its emitted identity is expected to be
// consumed, because a mapping row is only valid within the suite whose run
// emits it — the `parse*` fixture skips belong to the polyfill-connectors
// suite, not the RI custom-runner suite. The consumed-vs-configured join must
// be scoped to the suite whose transcript it validates.
type MappingSuiteScope = "ri-default" | "polyfill-connectors";
// The ri-default suite runs under more than one PROFILE (memory-default,
// postgres), and a named-mapping row can be structurally reachable under only
// ONE of them. `device-exporter-postgres-proof.test.js` is the proof case:
// under memory-default, the file's OUTER `if (!DEDICATED_POSTGRES_URL)` gate
// collapses the whole file to a single self-describing synthetic skip, so its
// real named subtests (each individually boolean-`skip`-gated on
// PDPP_REAL_LOCAL_TRANSFORMER_POSTGRES_ORACLE) never register at all — their
// row can never be consumed under that profile, and the "stale row" arm of
// assertNamedSkipMappingsFullyConsumed would fire on a run that did nothing
// wrong. Under the postgres profile the outer gate opens, the named subtest
// registers as a real boolean-skip test, and its row MUST be present or the
// "unexplained skip" arm fires instead. Both are correct, opposite-direction
// requirements — so each row declares the exact profile(s) under which it is
// EXPECTED to be consumed, and the suite finalizer (run-tests.ts) filters the
// configured set down to the running profile before the join. A row scoped to
// a profile that is not running is simply not asked to be consumed — it is
// never silently dropped from enforcement, only removed from THIS profile's
// obligations, and it still fails closed under any profile it lists.
type MappingProfileScope = "memory-default" | "postgres";
const UNNAMED_SKIP_REASON_ROWS: readonly (readonly [string, string, MappingSuiteScope])[] = [
  [
    "live CDP smoke proves frame, click, and viewport resize against Chromium",
    "set PDPP_TEST_LIVE_CDP=1 and PDPP_TEST_CDP_BIN or PDPP_TEST_CDP_WS_URL to run",
    "ri-default",
  ],
  [
    "live-shadow-comparison: production projection has no unexpected drift",
    "set PDPP_LIVE_CONNECTOR_HEALTH_GATE=1 to run",
    "ri-default",
  ],
  [
    "parseOrdersListDom: local real fixture parses ≥5 orders with ids + dates",
    "local Amazon raw-DOM fixture directory not present",
    "polyfill-connectors",
  ],
  [
    "parseOrderDetailDom: local real fixtures yield items and grand_total",
    "local Amazon raw-DOM fixture directory not present",
    "polyfill-connectors",
  ],
  [
    "parseDashboardAccountsDom: local real capture parses ≥1 account",
    "local Chase raw-DOM fixture directory not present",
    "polyfill-connectors",
  ],
  [
    "parseStatementsListDom: local real capture parses ≥1 statement row",
    "local Chase raw-DOM fixture directory not present",
    "polyfill-connectors",
  ],
  [
    "parseCurrentActivityDom: local real capture — dashboard-accounts.html parses ≥1 MDS row",
    "local Chase raw-DOM fixture directory not present",
    "polyfill-connectors",
  ],
  [
    "parseModernCheckingEra: local statement text parses ≥1 txn (smoke)",
    "local USAA raw fixture directory not present",
    "polyfill-connectors",
  ],
];

// Reject duplicate configured rows BEFORE building any lookup Set/Map — a Set
// silently collapses duplicates, which would make a duplicate configured row
// undetectable and let a stale/duplicated mapping ship behind a gate that
// cannot see its own failure mode. Validate the array first, then derive the
// lookup structures from the validated rows.
function assertNoDuplicateMappingRows(names: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      fail(`${label} contains a duplicate configured mapping row: ${name}`);
    }
    seen.add(name);
  }
}
assertNoDuplicateMappingRows(POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS, "POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS");
assertNoDuplicateMappingRows(
  PROFILE_SCOPED_POSTGRES_SKIP_TEST_NAME_ROWS.map(([name]) => name),
  "PROFILE_SCOPED_POSTGRES_SKIP_TEST_NAME_ROWS"
);
assertNoDuplicateMappingRows(
  UNNAMED_SKIP_REASON_ROWS.map(([name]) => name),
  "UNNAMED_SKIP_REASON_ROWS"
);
// A name may not be configured in more than one table — one emitted identity
// resolves through exactly one row, or the "consumed" join could
// double-attribute it.
assertNoDuplicateMappingRows(
  [
    ...POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS,
    ...PROFILE_SCOPED_POSTGRES_SKIP_TEST_NAME_ROWS.map(([name]) => name),
    ...UNNAMED_SKIP_REASON_ROWS.map(([name]) => name),
  ],
  "named skip mapping identities (across all tables)"
);

// Lookup Set/Map derived from the validated, de-duplicated rows.
export const POSTGRES_UNNAMED_SKIP_TEST_NAMES: ReadonlySet<string> = new Set(POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS);
const PROFILE_SCOPED_POSTGRES_SKIP_PROFILES_BY_TEST_NAME = new Map(PROFILE_SCOPED_POSTGRES_SKIP_TEST_NAME_ROWS);
const UNNAMED_SKIP_REASONS_BY_TEST_NAME = new Map(UNNAMED_SKIP_REASON_ROWS.map(([name, reason]) => [name, reason]));

// The configured named-mapping identities that a run of a given SUITE, under a
// given PROFILE, is expected to consume. The PostgreSQL-URL rows apply only to
// memory-default, where their tests emit skips instead of running. Explicitly
// profile-scoped rows apply only to their declared profiles, while the
// suite-scoped live/fixture gates apply to every profile of their suite.
function configuredMappingIdentitiesForSuite(
  suite: MappingSuiteScope,
  profile: MappingProfileScope
): readonly string[] {
  return [
    ...(suite === "ri-default" && profile === "memory-default" ? POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS : []),
    ...(suite === "ri-default"
      ? PROFILE_SCOPED_POSTGRES_SKIP_TEST_NAME_ROWS.filter(([, profiles]) => profiles.includes(profile)).map(
          ([name]) => name
        )
      : []),
    ...UNNAMED_SKIP_REASON_ROWS.filter(([, , scope]) => scope === suite).map(([name]) => name),
  ];
}
const MAPPING_PROFILE_SCOPES: readonly MappingProfileScope[] = ["memory-default", "postgres"];
function isMappingProfileScope(profile: string): profile is MappingProfileScope {
  return (MAPPING_PROFILE_SCOPES as readonly string[]).includes(profile);
}
// The caller (run-tests.ts) only knows its selected profile as a raw string
// (it may come from an env var), so this is the boundary where that string is
// validated into the closed MappingProfileScope. An unrecognized profile
// fails closed rather than silently falling back to an empty/permissive
// configured set — a run under a profile this module does not know about
// must not be told it owes nothing.
export function riConfiguredNamedSkipMappingIdentities(profile: string): readonly string[] {
  if (!isMappingProfileScope(profile)) {
    fail(`named skip mapping has no configured rows for unrecognized ri-default profile: ${profile}`);
  }
  return configuredMappingIdentitiesForSuite("ri-default", profile);
}

// Resolve an emitted skipped-test identity to its declared reason via the exact
// named mappings, returning the matched mapping identity so callers can record
// which configured rows were consumed. Returns undefined when no mapping
// applies (the caller then fails closed on the unexplained skip). This is the
// SINGLE point of identity->reason resolution; the summary path and the
// consumed-set join both route through it so they cannot drift apart.
export function resolveNamedSkipMapping(name: string | undefined): { reason: string; identity: string } | undefined {
  if (name === undefined) {
    return;
  }
  if (PROFILE_SCOPED_POSTGRES_SKIP_PROFILES_BY_TEST_NAME.has(name)) {
    return { reason: "PDPP_REAL_LOCAL_TRANSFORMER_POSTGRES_ORACLE unset", identity: name };
  }
  if (POSTGRES_UNNAMED_SKIP_TEST_NAMES.has(name)) {
    return { reason: "PDPP_TEST_POSTGRES_URL unset", identity: name };
  }
  const reason = UNNAMED_SKIP_REASONS_BY_TEST_NAME.get(name);
  return reason === undefined ? undefined : { reason, identity: name };
}
// Property 3 — the exact-set runtime join. Given the identities a complete run
// actually CONSUMED (each emitted skip that resolved through a named-mapping
// row) and the CONFIGURED rows for that suite scope, require exact set
// equality. Stale/unmatched configured rows (configured MINUS consumed) fail
// closed; a consumed identity absent from the configured set (which cannot
// happen while resolution routes through the same rows, but is checked for
// defence in depth) also fails. Loop-generated 1-to-N identities pass
// naturally because the join is over emitted identities, never over static
// source occurrences. This is NOT a count of source text — it is identity
// membership, which is the only sound join across a runner that expands loops.
export function assertNamedSkipMappingsFullyConsumed(consumed: Iterable<string>, configured: readonly string[]): void {
  const consumedSet = new Set(consumed);
  const configuredSet = new Set(configured);
  const staleRows = configured.filter((identity) => !consumedSet.has(identity));
  if (staleRows.length > 0) {
    fail(`stale named skip mapping rows (configured but no emitted skip consumed them): ${staleRows.join("; ")}`);
  }
  const unconfigured = [...consumedSet].filter((identity) => !configuredSet.has(identity));
  if (unconfigured.length > 0) {
    fail(`emitted skip consumed a named mapping that is not configured for this suite: ${unconfigured.join("; ")}`);
  }
}

export interface StructuredSummary {
  assertions: number;
  // The named-mapping identities this (per-file) summary CONSUMED — i.e. the
  // emitted skips whose reason came from an exact named mapping row rather than
  // from a self-describing skip value or a `(skipped: ...)` title suffix. The
  // suite finalizer unions these across all files and joins them against the
  // configured rows for the suite scope (property 3). A single file cannot see
  // the whole configured set, so this carries the per-file evidence upward.
  consumed_mapping_identities: string[];
  failed: number;
  passed: number;
  skip_reasons: Record<string, number>;
  skipped: number;
}

interface NodeTestEventDetails {
  name?: string;
  skip?: boolean | string;
  type?: string;
}
interface NodeTestEvent {
  details?: NodeTestEventDetails;
  type: string;
}

const SKIP_REASON_SUFFIX_PATTERN = /\(skipped:\s*([^)]+)\)|:\s*skipped\s*\(([^)]+)\)/i;

// Resolve one emitted skip to its declared reason, in the same precedence the
// authority trusts: (1) a string skip value is self-describing; (2) a
// `(skipped: ...)` title suffix is self-describing; (3) otherwise an exact
// named-mapping row supplies the reason and is recorded as CONSUMED so the
// suite finalizer's property-3 join can see it. `consumedIdentity` is set only
// for path (3) — the two self-describing paths consume no configured row.
function resolveEmittedSkipReason(
  skip: boolean | string,
  name: string | undefined
): { reason: string | undefined; consumedIdentity?: string } {
  if (typeof skip === "string") {
    return { reason: skip.trim() };
  }
  const suffix = name?.match(SKIP_REASON_SUFFIX_PATTERN)?.slice(1).find(Boolean)?.trim();
  if (suffix) {
    return { reason: suffix };
  }
  const mapping = resolveNamedSkipMapping(name);
  return mapping ? { reason: mapping.reason, consumedIdentity: mapping.identity } : { reason: undefined };
}

export function structuredNodeSummary(output: string): StructuredSummary {
  const events: NodeTestEvent[] = output
    .split("\n")
    .filter((line) => line.startsWith(EVENT_PREFIX))
    .map((line) => {
      try {
        return JSON.parse(line.slice(EVENT_PREFIX.length));
      } catch {
        return fail("reporter emitted malformed structured event");
      }
    });
  if (events.length === 0) {
    fail("runner emitted no structured node events");
  }
  const skipReasons: Record<string, number> = {};
  const consumedMappingIdentities: string[] = [];
  let assertions = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const event of events) {
    if (!["test:pass", "test:fail"].includes(event.type) || event.details?.type !== "test") {
      continue;
    }
    assertions += 1;
    const { skip } = event.details;
    if (skip !== false && skip !== undefined && skip !== null) {
      const { reason, consumedIdentity } = resolveEmittedSkipReason(skip, event.details.name);
      if (!reason) {
        fail(`unexplained skip: ${event.details.name ?? "unnamed test"}`);
      }
      if (consumedIdentity !== undefined) {
        consumedMappingIdentities.push(consumedIdentity);
      }
      skipped += 1;
      skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
    } else if (event.type === "test:pass") {
      passed += 1;
    } else {
      failed += 1;
    }
  }
  return {
    assertions,
    passed,
    failed,
    skipped,
    skip_reasons: skipReasons,
    consumed_mapping_identities: consumedMappingIdentities,
  };
}

export function structuredPythonSummary(output: string, status: number): StructuredSummary {
  const assertions = [...output.matchAll(/Ran (\d+) tests? in /g)].reduce(
    (sum, match) => sum + Number.parseInt(match[1] ?? "0", 10),
    0
  );
  if (assertions === 0) {
    fail("python runner emitted no test count");
  }
  const skipReasons: Record<string, number> = {};
  for (const match of output.matchAll(/^.+\.\.\. skipped ['"](.+)['"]$/gm)) {
    const reason = match[1]?.trim() ?? "";
    if (!reason) {
      fail("python runner emitted an unexplained skip");
    }
    skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
  }
  const reportedSkips = [...output.matchAll(/skipped=(\d+)/g)].reduce(
    (sum, match) => sum + Number.parseInt(match[1] ?? "0", 10),
    0
  );
  if (reportedSkips !== Object.values(skipReasons).reduce((sum, count) => sum + count, 0)) {
    fail("python runner omitted a skip reason");
  }
  const failed = [...output.matchAll(/(?:failures|errors|unexpected successes)=(\d+)/g)].reduce(
    (sum, match) => sum + Number.parseInt(match[1] ?? "0", 10),
    0
  );
  if (status !== 0 && failed === 0) {
    fail("python runner failed without structured failure count");
  }
  const passed = assertions - failed - reportedSkips;
  if (passed < 0) {
    fail("python runner emitted inconsistent counts");
  }
  // Python's verbose runner names its skip reason inline (`skipped '...'`), so
  // no exact named-mapping row is consumed — the Python path never routes
  // through resolveNamedSkipMapping.
  return {
    assertions,
    passed,
    failed,
    skipped: reportedSkips,
    skip_reasons: skipReasons,
    consumed_mapping_identities: [],
  };
}

export function readStructuredChildResult(output: string): unknown {
  const lines = output.split("\n").filter((line) => line.startsWith(RESULT_PREFIX));
  if (lines.length !== 1) {
    fail("runner must emit exactly one structured result");
  }
  try {
    return JSON.parse(lines[0]?.slice(RESULT_PREFIX.length) ?? "");
  } catch {
    fail("runner emitted malformed structured result");
  }
}

export function repositoryPaths(directory: string, paths: string[]): string[] {
  return paths.map((path) => `${directory}/${path}`.replaceAll("\\", "/")).sort(compareStrings);
}
