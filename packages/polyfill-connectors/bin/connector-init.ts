#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * connector-init — scaffold a new API-class connector, declaration-first.
 *
 * Generates the minimal set of files a new connector needs to pass the
 * fleet's build-time guardrails (manifest-honesty suite, pilot-fixture
 * shape lock, manifest/schema/emit reconciliation) on day one:
 *
 *   manifests/<name>.json              — one stream, honest minimal schema
 *   connectors/<name>/index.ts         — runConnector wiring, one TODO endpoint
 *   connectors/<name>/schemas.ts       — makeValidateRecord over the manifest schema
 *   connectors/<name>/types.ts         — upstream API response shape stub
 *   connectors/<name>/parsers.ts       — pure record builder stub
 *   connectors/<name>/pilot-fixture.test.ts — wired via the shared helper
 *   fixtures/<name>/scrubbed/pilot-real-shape/records/<stream>.jsonl
 *   fixtures/<name>/scrubbed/pilot-real-shape/provenance.json
 *
 * Usage:
 *   pnpm exec tsx bin/connector-init.ts <name> [--display-name <n>] [--stream <stream-name>]
 *
 * `<name>` becomes the connector key (directory name, manifest filename,
 * `connector_key`). It must be a lowercase snake_case identifier — the same
 * shape every existing connector key uses.
 *
 * Refuses to run if any target file/directory already exists (lists every
 * collision and exits non-zero) — init never overwrites.
 *
 * The scaffold is deliberately tiny: one stream, one synthetic pilot
 * record, one TODO'd HTTP call. It exists to get a new connector past the
 * "does the fleet's plumbing accept this shape" question immediately, so a
 * connector author's first `node --test` run is green and every edit from
 * there on is adding real behavior, not fighting the harness.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "@pdpp/connector-protocol";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, "..");

const NAME_RE = /^[a-z][a-z0-9_]*$/;
const STREAM_RE = /^[a-z][a-z0-9_]*$/;

interface InitArgs {
  displayName: string;
  name: string;
  stream: string;
}

const USAGE = "usage: pnpm exec tsx bin/connector-init.ts <name> [--display-name <n>] [--stream <stream-name>]";

/** Thrown by parseArgs on any invalid invocation. main() maps this to a printed usage + exit(2). */
export class InitArgsError extends Error {}

function titleCase(name: string): string {
  return name
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Pure argument parser: never touches process.exit/console so it is directly
 * unit-testable. Throws InitArgsError on any invalid invocation; the CLI
 * entry point (main()) is the only place that turns a thrown error into
 * printed usage text and a process exit code.
 */
function parseArgs(argv: string[]): InitArgs {
  const [name, ...rest] = argv;
  if (!name || name.startsWith("--")) {
    throw new InitArgsError(USAGE);
  }
  if (!NAME_RE.test(name)) {
    throw new InitArgsError(`invalid connector name "${name}": must be lowercase snake_case (e.g. "acme_widgets")`);
  }
  let displayName = titleCase(name);
  let stream = "items";
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--display-name") {
      const value = rest[i + 1];
      if (!value) {
        throw new InitArgsError(USAGE);
      }
      displayName = value;
      i += 1;
    } else if (arg === "--stream") {
      const value = rest[i + 1];
      if (!value) {
        throw new InitArgsError(USAGE);
      }
      stream = value;
      i += 1;
    } else {
      throw new InitArgsError(`unrecognized argument: ${String(arg)}`);
    }
  }
  if (!STREAM_RE.test(stream)) {
    throw new InitArgsError(`invalid stream name "${stream}": must be lowercase snake_case (e.g. "items")`);
  }
  return { name, displayName, stream };
}

// ─── Target file plan ───────────────────────────────────────────────────

interface TargetPlan {
  connectorDir: string;
  files: {
    fixtureJsonl: string;
    indexTs: string;
    manifestJson: string;
    parsersTs: string;
    pilotFixtureTestTs: string;
    provenanceJson: string;
    schemasTs: string;
    typesTs: string;
  };
  fixtureRecordsDir: string;
}

function planTargets(name: string, stream: string): TargetPlan {
  const connectorDir = join(PKG_ROOT, "connectors", name);
  const fixtureDir = join(PKG_ROOT, "fixtures", name, "scrubbed", "pilot-real-shape");
  const fixtureRecordsDir = join(fixtureDir, "records");
  return {
    connectorDir,
    fixtureRecordsDir,
    files: {
      manifestJson: join(PKG_ROOT, "manifests", `${name}.json`),
      indexTs: join(connectorDir, "index.ts"),
      schemasTs: join(connectorDir, "schemas.ts"),
      typesTs: join(connectorDir, "types.ts"),
      parsersTs: join(connectorDir, "parsers.ts"),
      pilotFixtureTestTs: join(connectorDir, "pilot-fixture.test.ts"),
      fixtureJsonl: join(fixtureRecordsDir, `${stream}.jsonl`),
      provenanceJson: join(fixtureDir, "provenance.json"),
    },
  };
}

function findCollisions(plan: TargetPlan): string[] {
  const candidates = [plan.connectorDir, ...Object.values(plan.files)];
  return candidates.filter((path) => existsSync(path));
}

// ─── File content builders ──────────────────────────────────────────────
//
// The manifest is the declaration-first source of truth: one stream with an
// `id` primary key and a `created_at` event-time cursor field, plus one
// example free-text field (`title`). This exact shape is chosen to satisfy
// the manifest-honesty test family without any per-field allowlisting:
//
//   - `required: true` is declared explicitly on the stream (the
//     coverage-policy honesty test's ratchet requires every NEW stream to
//     state this rather than rely on the implicit default).
//   - `created_at` carries `x_pdpp_role: "event-time"` and is BOTH the
//     stream's `cursor_field` and `consent_time_field` — the
//     query-affordance honesty tests exempt a field from the mandatory
//     `range_filters`/`group_by_time` declarations exactly when it IS the
//     stream's own cursor_field (see src/query-affordance-manifest-honesty
//     .test.ts's isRangeRequiredTimeField/isGroupByTimeRequiredField), so
//     no range/group_by_time declaration is needed for it.
//   - `title` carries `x_pdpp_role: "primary-title"` (presentation-role
//     honesty requires >=1 role per stream, and the primary-title role
//     must land on a string field) and is declared in both
//     `query.search.lexical_fields` and `query.search.semantic_fields`
//     (the search-affordance honesty test requires this for any
//     string field named "title" — see LEXICAL_FIELD_NAMES /
//     SEMANTIC_FIELD_NAMES in src/search-affordance-manifest-honesty.test.ts).
//   - `public_listing.tier: "development"` — the only tier a brand-new,
//     unverified connector can honestly claim.

function buildManifest(name: string, displayName: string, stream: string): string {
  const manifest = {
    protocol_version: "0.1.0",
    connector_id: `https://registry.pdpp.dev/connectors/${name}`,
    connector_key: name,
    manifest_uri: `https://registry.pdpp.dev/connectors/${name}`,
    version: "0.1.0",
    display_name: displayName,
    runtime_requirements: {
      bindings: {
        network: {
          required: true,
        },
      },
    },
    capabilities: {
      human_interaction: [],
      refresh_policy: {
        recommended_mode: "manual",
        recommended_interval_seconds: 21_600,
        minimum_interval_seconds: 3600,
        maximum_staleness_seconds: 86_400,
        interaction_posture: "none",
        rate_limit_sensitivity: "medium",
        bot_detection_sensitivity: "low",
        background_safe: false,
        rationale: "Scaffolded connector: manual refresh until a real rate profile is measured against the live API.",
      },
      public_listing: {
        tier: "development",
      },
      auth: {
        kind: "env",
        required: [`${name.toUpperCase()}_API_TOKEN`],
      },
    },
    streams: [
      {
        name: stream,
        description: `TODO: describe the ${stream} stream (what it is, one sentence).`,
        display: {
          label: `Your ${displayName} ${stream}`,
          detail: "TODO: describe the fields an owner will see for this stream.",
        },
        semantics: "mutable_state",
        schema: {
          type: "object",
          properties: {
            id: {
              type: "string",
            },
            created_at: {
              type: "string",
              format: "date-time",
              x_pdpp_role: "event-time",
            },
            title: {
              type: ["string", "null"],
              x_pdpp_role: "primary-title",
            },
          },
          required: ["id", "created_at"],
        },
        primary_key: ["id"],
        cursor_field: "created_at",
        consent_time_field: "created_at",
        required: true,
        selection: {
          fields: true,
          resources: true,
        },
        incremental: true,
        query: {
          search: {
            lexical_fields: ["title"],
            semantic_fields: ["title"],
          },
          aggregations: {
            count: true,
          },
        },
        coverage_strategy: "checkpoint_window",
        freshness_strategy: "manual_as_of",
      },
    ],
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function buildTypesTs(displayName: string, stream: string): string {
  return `// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Shared types for the ${displayName} connector. Kept out of index.ts so the
// pure record builders in parsers.ts can import them without pulling in the
// runtime entry point (see connectors/github/types.ts for the pattern this
// scaffold follows).

// TODO: replace with the real upstream ${displayName} API response shape
// for the "${stream}" stream.
export interface ${pascalCase(stream)}Item {
  created_at: string;
  id: number | string;
  title?: string | null;
}
`;
}

function buildParsersTs(name: string, stream: string): string {
  const typeName = `${pascalCase(stream)}Item`;
  return `// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure parsers for the ${name} connector. Kept free of fetch / Node I/O so
// they can be unit-tested in isolation. The HTTP client and pagination
// loop live in index.ts (see connectors/github/parsers.ts for the pattern
// this scaffold follows).

import type { RecordData } from "../../src/connector-runtime.ts";
import type { ${typeName} } from "./types.ts";

// TODO: fill in the record builder once the real upstream shape is known.
// Must emit exactly the fields declared in manifests/${name}.json's
// "${stream}" stream schema (id, created_at, title).
export function ${camelCase(stream)}Record(item: ${typeName}): RecordData {
  return {
    id: String(item.id),
    created_at: item.created_at,
    title: item.title ?? null,
  };
}
`;
}

function buildIndexTs(name: string, stream: string): string {
  const envVar = `${name.toUpperCase()}_API_TOKEN`;
  const typeName = `${pascalCase(stream)}Item`;
  const recordFn = `${camelCase(stream)}Record`;
  return `#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP ${name} Connector (v0.1.0) — scaffolded by bin/connector-init.ts.
 *
 * Auth: TODO document the real auth flow. Placeholder: bearer token via
 * ${envVar} env var.
 *
 * TODO: document the real upstream API base URL, endpoint(s), and rate
 * limits here, following the header comment style in
 * connectors/strava/index.ts or connectors/github/index.ts.
 */

import { type RecordData, runConnector } from "../../src/connector-runtime.ts";
import { isMainModule } from "@pdpp/connector-protocol";
import { ${recordFn} } from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type { ${typeName} } from "./types.ts";

// TODO: replace with the real upstream endpoint.
const API_URL = "https://api.example.invalid/v1/${stream}";

async function fetch${pascalCase(stream)}(token: string, since: string | undefined): Promise<${typeName}[]> {
  const url = new URL(API_URL);
  if (since) {
    url.searchParams.set("since", since);
  }
  const res = await fetch(url, { headers: { Authorization: \`Bearer \${token}\` } });
  if (res.status === 401) {
    throw new Error("${name}_auth_failed");
  }
  if (!res.ok) {
    const text = (await res.text()).slice(0, 200);
    throw new Error(\`${name}_http_\${String(res.status)}: \${text}\`);
  }
  // TODO: adjust to the real response envelope (this assumes a bare array).
  return (await res.json()) as ${typeName}[];
}

if (isMainModule(import.meta.url)) {
  runConnector({
    name: "${name}",
    validateRecord,
    retryablePattern: /ECONN|fetch failed/i,
    auth: { kind: "env", required: ["${envVar}"] },
    async collect({ state, requested, credentials, emit, emitRecord, progress }) {
      const token = credentials.${envVar};
      if (!token) {
        throw new Error("${name}_auth_failed");
      }

      if (!requested.has("${stream}")) {
        return;
      }
      await progress("Fetching ${stream}", { stream: "${stream}" });
      const streamState = state.${stream} as { last_created_at?: string } | undefined;
      const since = streamState?.last_created_at;
      let latest = since;

      const items = await fetch${pascalCase(stream)}(token, since);
      for (const item of items) {
        const record: RecordData = ${recordFn}(item);
        await emitRecord("${stream}", record);
        if (!latest || item.created_at > latest) {
          latest = item.created_at;
        }
      }

      await emit({
        type: "STATE",
        stream: "${stream}",
        cursor: { last_created_at: latest ?? null },
      });
    },
  });
}
`;
}

function buildSchemasTs(name: string, stream: string): string {
  const schemaVar = `${camelCase(stream)}Schema`;
  return `// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for ${name} stream records. Shape-check-before-emit per
 * docs/connector-authoring-guide.md §3. Mirrors manifests/${name}.json's
 * "${stream}" stream schema exactly — see src/manifest-reconcile.ts (run
 * via bin/reconcile-manifests.test.ts) for the drift check across
 * manifest / SCHEMAS registry / emitted-stream literals.
 *
 * TODO: as the real upstream shape lands in parsers.ts's record builder,
 * widen these fields (and manifests/${name}.json's schema in lockstep) to
 * match the real payload instead of this placeholder id/created_at/title
 * shape.
 */

import { z } from "zod";
import { pdppSafeText } from "../../src/pdpp-safe-text.ts";
import { makeValidateRecord } from "../../src/schema-registry.ts";

// Module-scoped regex (Biome useTopLevelRegex).
const ISO_DT_RE = /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}/;

/**
 * ${stream} stream: one record per ${name} ${stream} item.
 * Cursor: last_created_at (derived from created_at).
 */
export const ${schemaVar} = z.object({
  id: z.string().min(1),
  created_at: z.string().regex(ISO_DT_RE, "created_at must be an ISO-8601 datetime"),
  title: pdppSafeText.max(2000).nullable(),
});

/**
 * Stream → schema registry. Single source of truth for emitted streams.
 */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  ${stream}: ${schemaVar},
};

export const validateRecord = makeValidateRecord(SCHEMAS);
`;
}

function buildPilotFixtureTestTs(name: string): string {
  return `// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { registerPilotFixtureTests } from "../../src/pilot-fixture-test-helper.ts";
import { validateRecord } from "./schemas.ts";

registerPilotFixtureTests({ connector: "${name}", validateRecord });
`;
}

function buildFixtureJsonl(name: string): string {
  const record = {
    id: "1",
    created_at: "2026-01-15T09:30:00Z",
    title: `Example ${name} item`,
  };
  return `${JSON.stringify(record)}\n`;
}

function buildProvenanceJson(): string {
  const today = new Date().toISOString().slice(0, 10);
  const provenance = {
    format: "pdpp.fixture-provenance/1",
    class: "synthetic",
    labeled_by: "tool:connector-init/1",
    labeled_at: today,
  };
  return `${JSON.stringify(provenance, null, 2)}\n`;
}

// ─── Small string helpers (no deps) ─────────────────────────────────────

const WORD_SPLIT_RE = /[_-]+/;

function pascalCase(input: string): string {
  return input
    .split(WORD_SPLIT_RE)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function camelCase(input: string): string {
  const pascal = pascalCase(input);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

// ─── Writer ──────────────────────────────────────────────────────────────

export function writeScaffold(args: InitArgs): TargetPlan {
  const { name, displayName, stream } = args;
  const plan = planTargets(name, stream);

  mkdirSync(plan.connectorDir, { recursive: true });
  mkdirSync(plan.fixtureRecordsDir, { recursive: true });

  writeFileSync(plan.files.manifestJson, buildManifest(name, displayName, stream));
  writeFileSync(plan.files.typesTs, buildTypesTs(displayName, stream));
  writeFileSync(plan.files.parsersTs, buildParsersTs(name, stream));
  writeFileSync(plan.files.indexTs, buildIndexTs(name, stream));
  writeFileSync(plan.files.schemasTs, buildSchemasTs(name, stream));
  writeFileSync(plan.files.pilotFixtureTestTs, buildPilotFixtureTestTs(name));
  writeFileSync(plan.files.fixtureJsonl, buildFixtureJsonl(name));
  writeFileSync(plan.files.provenanceJson, buildProvenanceJson());

  return plan;
}

export type { InitArgs, TargetPlan };
export { findCollisions, parseArgs, planTargets };

// ─── CLI entry point ─────────────────────────────────────────────────────

function printNextSteps(name: string, stream: string): void {
  console.log(`
Scaffolded connector "${name}" (stream: "${stream}").

Next steps:
  1. Read docs/connector-authoring-guide.md — the authoring conventions
     (source-of-truth ranking, fail-loud schema discipline, naming, cursor
     discipline) every connector in this fleet follows.
  2. Edit connectors/${name}/index.ts: replace the TODO endpoint (API_URL,
     auth header shape, response envelope) with the real upstream call.
  3. Widen connectors/${name}/types.ts, parsers.ts, and schemas.ts (in
     lockstep with manifests/${name}.json's stream schema) to match the
     real payload shape as you discover it.
  4. Run the connector against the real API and watch it live:
       pnpm exec tsx bin/connector-dev.ts ${name}
  5. Capture a real run, then replay it strictly offline to prove the
     connector against fixed evidence:
       pnpm exec tsx bin/scenario-record.ts ${name}
       pnpm exec tsx bin/scenario-verify.ts ${name}
     Scrub the capture (see bin/scrub-fixtures.ts) before committing
     anything under fixtures/${name}/scrubbed/, and replace this
     scaffold's synthetic pilot-real-shape fixture with a scrubbed real
     one once you have it.
  6. Run the test suite for this connector:
       node --test --import tsx "connectors/${name}/**/*.test.ts"
  7. Wire the connector into the fleet (this scaffold does not edit
     existing files, so these are manual — a connector implementation
     alone is incomplete):
       - register it in src/orchestrator.ts's KNOWN_CONNECTORS map
         (connector-dev/scenario-record resolve entrypoints through it);
       - check bin/register-all.ts and bin/orchestrate.ts pick it up;
       - if the reference implementation should offer it to owners, add
         the canonical-key / setup-planner / console wiring (see
         docs/whoop-connector-learnings.md for the checklist a real
         first-time contribution surfaced).
`);
}

function main(): void {
  let args: InitArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof InitArgsError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }
  const plan = planTargets(args.name, args.stream);
  const collisions = findCollisions(plan);
  if (collisions.length > 0) {
    console.error(
      `connector-init: refusing to overwrite existing path(s):\n${collisions.map((p) => `  ${p}`).join("\n")}`
    );
    process.exit(1);
  }
  writeScaffold(args);
  printNextSteps(args.name, args.stream);
}

if (isMainModule(import.meta.url)) {
  main();
}
