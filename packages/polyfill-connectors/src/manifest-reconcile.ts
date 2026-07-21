// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Manifest-vs-schema-vs-emit reconciliation for first-party connectors.
 *
 * Three sources, one report:
 *   - manifest streams: `manifests/<conn>.json` `.streams[].name` — the
 *     public contract every consumer reads.
 *   - schema streams: keys of the connector's `SCHEMAS` registry — what
 *     `validateRecord` will shape-check.
 *   - emitted streams: stream-name literals passed to `emitRecord(...)`
 *     or to `emit({ type: "RECORD", stream: ... })` in the connector's
 *     `index.ts` and `parsers.ts`. Static-extracted; this misses
 *     dynamically-named streams (we don't have any today; if we ever
 *     did, the dynamic case would need a runtime probe).
 *
 * The reconciler returns a structured drift report, suitable for both
 * a CLI summary and a unit test that fails on regressions.
 *
 * Design constraints:
 *   - Pure I/O: takes paths in, returns data out. No globbing-from-cwd
 *     so tests can build virtual fixtures.
 *   - No DB dependency. The earlier `replay-schemas.ts` tool reads
 *     the local sqlite to validate records; this tool only reads
 *     committed manifest + source files.
 *   - The emit-scan is intentionally narrow. We match a small set of
 *     literal-string call patterns and accept misses; coverage gaps
 *     show up as schema/manifest drift instead.
 */

import { readFileSync } from "node:fs";

// Module-scoped regexes (Biome useTopLevelRegex). Each matches one shape
// of stream-name literal we look for in connector source.

// emitRecord("name", ...) — the most common path.
const EMIT_RECORD_RE = /emitRecord\s*\(\s*['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/g;
// emit({ type: "RECORD", stream: "name", ... }) — used by gmail, ynab,
// and other connectors that bypass runConnector or call emit directly.
const EMIT_OBJ_RE = /type\s*:\s*['"]RECORD['"][^}]*?stream\s*:\s*['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/g;
// SCHEMAS registry keys: { foo: fooSchema, bar: barSchema, ... }.
// Matches both shorthand (`foo: fooSchema`) and quoted (`"foo": fooSchema`)
// keys, but only inside the `SCHEMAS` object literal we anchor to.
const SCHEMAS_BLOCK_RE = /SCHEMAS[^=]*=\s*\{([^}]*)\}/;
const SCHEMAS_KEY_RE = /(?:^|,)\s*(?:"([^"]+)"|([a-zA-Z_][a-zA-Z0-9_]*))\s*:/g;

export interface ManifestStreams {
  /** Stream names declared in the manifest, preserving order. */
  declared: string[];
}

export interface SchemaStreams {
  /** Stream names registered in the connector's SCHEMAS object. */
  registered: string[];
}

export interface EmittedStreams {
  /** Stream-name literals scanned from connector source. */
  emitted: string[];
}

export interface ReconcileReport {
  connector: string;
  declared: string[];
  emitted: string[];
  /** Streams declared in the manifest but neither schema-registered nor emitted. */
  missing_emit: string[];
  /** Streams emitted but not in manifest. */
  missing_manifest: string[];
  /** Streams emitted but not in SCHEMAS — runtime won't validate them. */
  missing_schema: string[];
  /** True iff every set is consistent (3 empty drift arrays). */
  ok: boolean;
  registered: string[];
}

export function parseManifestStreams(json: string): ManifestStreams {
  const parsed = JSON.parse(json) as { streams?: Array<{ name?: unknown }> };
  const declared: string[] = [];
  for (const s of parsed.streams ?? []) {
    if (typeof s.name === "string" && s.name) {
      declared.push(s.name);
    }
  }
  return { declared };
}

export function parseSchemaStreams(source: string): SchemaStreams {
  const block = SCHEMAS_BLOCK_RE.exec(source);
  if (!block?.[1]) {
    return { registered: [] };
  }
  const body = block[1];
  const registered: string[] = [];
  // Reset regex state — global flag.
  SCHEMAS_KEY_RE.lastIndex = 0;
  let m: RegExpExecArray | null = SCHEMAS_KEY_RE.exec(body);
  while (m !== null) {
    const key = m[1] ?? m[2];
    if (key) {
      registered.push(key);
    }
    m = SCHEMAS_KEY_RE.exec(body);
  }
  return { registered };
}

export function scanEmittedStreams(sources: readonly string[]): EmittedStreams {
  const seen = new Set<string>();
  for (const src of sources) {
    EMIT_RECORD_RE.lastIndex = 0;
    let m: RegExpExecArray | null = EMIT_RECORD_RE.exec(src);
    while (m !== null) {
      if (m[1]) {
        seen.add(m[1]);
      }
      m = EMIT_RECORD_RE.exec(src);
    }
    EMIT_OBJ_RE.lastIndex = 0;
    m = EMIT_OBJ_RE.exec(src);
    while (m !== null) {
      if (m[1]) {
        seen.add(m[1]);
      }
      m = EMIT_OBJ_RE.exec(src);
    }
  }
  return { emitted: [...seen].sort() };
}

export function reconcile(args: {
  connector: string;
  declared: readonly string[];
  registered: readonly string[];
  emitted: readonly string[];
}): ReconcileReport {
  const declared = [...args.declared];
  const registered = [...args.registered];
  const emitted = [...args.emitted];
  const declaredSet = new Set(declared);
  const registeredSet = new Set(registered);
  const emittedSet = new Set(emitted);

  const missing_manifest = emitted.filter((s) => !declaredSet.has(s));
  const missing_schema = emitted.filter((s) => !registeredSet.has(s));
  const missing_emit = declared.filter((s) => !(emittedSet.has(s) || registeredSet.has(s)));

  return {
    connector: args.connector,
    declared,
    registered,
    emitted,
    missing_manifest,
    missing_schema,
    missing_emit,
    ok: missing_manifest.length === 0 && missing_schema.length === 0 && missing_emit.length === 0,
  };
}

export interface ReconcileFromDiskArgs {
  connector: string;
  /** Connector source files to scan for emit-stream literals. Typically
   *  `connectors/<name>/index.ts` and `connectors/<name>/parsers.ts`,
   *  but the caller decides — passing an empty list yields an empty
   *  emitted[] which can be intentional for static-only connectors. */
  emitSourcePaths: readonly string[];
  manifestPath: string;
  /** May be null for connectors that don't ship a schemas.ts. Reported
   *  as empty registered[] in that case. */
  schemaPath: string | null;
}

/** Top-level convenience: reads files from disk, runs the parsers, and
 *  returns the reconciliation report. CLI uses this; tests build the
 *  args directly via the parse* helpers above. */
export function reconcileFromDisk(args: ReconcileFromDiskArgs): ReconcileReport {
  const manifest = parseManifestStreams(readFileSync(args.manifestPath, "utf8"));
  const schema = args.schemaPath ? parseSchemaStreams(readFileSync(args.schemaPath, "utf8")) : { registered: [] };
  const sources = args.emitSourcePaths.map((p) => readFileSync(p, "utf8"));
  const emitted = scanEmittedStreams(sources);
  return reconcile({
    connector: args.connector,
    declared: manifest.declared,
    registered: schema.registered,
    emitted: emitted.emitted,
  });
}
