// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regenerates `src/generated/collector-definitions.generated.ts` from
 * `@pdpp/polyfill-connectors`'s `LOCAL_COLLECTOR_DEFINITIONS`
 * (`packages/polyfill-connectors/src/collector-registry.ts`).
 *
 * Why this exists: `@pdpp/local-collector` is the publishable runner
 * package; it must not carry a source dependency on
 * `@pdpp/polyfill-connectors` (the content package that owns connector
 * definitions), because that would reintroduce the exact coupling the
 * engine split is removing — the runner reaching into content's source tree
 * for anything beyond the authoring contract it already gets from
 * `@pdpp/connector-protocol`. But the runner's CLI composition root
 * (`bin/pdpp-local-collector.ts`) still needs to know which connectors are
 * bundled and how, to build its `BundledConnectorRegistry`.
 *
 * The resolution: a generated, checked-in snapshot. `polyfill-connectors`
 * remains the one place `LOCAL_COLLECTOR_DEFINITIONS` is authored (connector
 * defines its own collector; the runtime discovers definitions — see
 * `collector-registry.ts`'s own module doc). This script reads that
 * authority ONCE, at build/CI time, and bakes the result into a plain data
 * literal this package imports at runtime with zero cross-package source
 * reach. A drift test
 * (`test/collector-definitions-snapshot-drift.test.ts`) fails CI if the
 * checked-in snapshot no longer matches what regenerating from
 * `polyfill-connectors` would produce, so a definition change there cannot
 * silently go stale here.
 *
 * Update path: after changing any connector's `LocalCollectorDefinition` (or
 * adding/removing a bundled connector) in `polyfill-connectors`, regenerate
 * with `node --experimental-strip-types
 * scripts/generate-collector-definitions-snapshot.ts` from
 * `packages/local-collector`, then commit the updated
 * `src/generated/collector-definitions.generated.ts` alongside the source
 * change. The drift test enforces this — an un-regenerated snapshot fails
 * CI, not silently ships stale.
 *
 * Takes one optional CLI arg: an output path to write to instead of the
 * tracked `src/generated/collector-definitions.generated.ts` (used by the
 * drift test to render into a scratch directory).
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, "..");
const targetPath = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(packageDir, "src/generated/collector-definitions.generated.ts");

const { LOCAL_COLLECTOR_DEFINITIONS } = (await import(
  resolve(packageDir, "../polyfill-connectors/src/collector-registry.ts")
)) as {
  LOCAL_COLLECTOR_DEFINITIONS: readonly {
    bindings: Readonly<Record<string, { required: boolean }>>;
    connector_id: string;
    enforces_source_roots?: boolean;
    entry: string;
    source_root_scopable_streams?: readonly string[];
    streams: readonly string[];
    time_scopable_streams?: readonly string[];
  }[];
};

function jsonStringArray(values: readonly string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}

function bindingsLiteral(bindings: Readonly<Record<string, { required: boolean }>>): string {
  const keys = Object.keys(bindings).sort((a, b) => a.localeCompare(b));
  const lines = keys.map((key) => `      ${JSON.stringify(key)}: { required: ${bindings[key]?.required === true} },`);
  return `{\n${lines.join("\n")}\n    }`;
}

function definitionLiteral(definition: (typeof LOCAL_COLLECTOR_DEFINITIONS)[number]): string {
  const lines: string[] = [
    `    connector_id: ${JSON.stringify(definition.connector_id)},`,
    `    entry: ${JSON.stringify(definition.entry)},`,
    `    bindings: ${bindingsLiteral(definition.bindings)},`,
    `    streams: ${jsonStringArray(definition.streams)},`,
  ];
  if (definition.time_scopable_streams) {
    lines.push(`    time_scopable_streams: ${jsonStringArray(definition.time_scopable_streams)},`);
  }
  if (definition.source_root_scopable_streams) {
    lines.push(`    source_root_scopable_streams: ${jsonStringArray(definition.source_root_scopable_streams)},`);
  }
  if (definition.enforces_source_roots) {
    lines.push("    enforces_source_roots: true,");
  }
  return `  {\n${lines.join("\n")}\n  },`;
}

const entriesBody = LOCAL_COLLECTOR_DEFINITIONS.map((definition) => definitionLiteral(definition)).join("\n");

const output = `// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// GENERATED FILE — do not hand-edit. Produced by
// scripts/generate-collector-definitions-snapshot.ts from
// @pdpp/polyfill-connectors's LOCAL_COLLECTOR_DEFINITIONS
// (packages/polyfill-connectors/src/collector-registry.ts), the one place a
// connector declares its local-collector participation. Runtime injection
// here stays a frozen snapshot, not a live cross-package source import, so
// @pdpp/local-collector (the publishable runner) never depends on
// @pdpp/polyfill-connectors (the content package) at build or publish time.
// test/collector-definitions-snapshot-drift.test.ts fails CI if this file
// drifts from what the generator would produce for polyfill-connectors'
// current definitions.
//
// Update path: after changing a connector's LocalCollectorDefinition (or
// adding/removing a bundled connector) in polyfill-connectors, regenerate
// with \`node --experimental-strip-types
// scripts/generate-collector-definitions-snapshot.ts\` from
// packages/local-collector, then commit this file alongside that change.

import type { LocalCollectorDefinition } from "@pdpp/connector-protocol/collector-definition";

/**
 * Frozen snapshot of every connector's local-collector participation, in the
 * order polyfill-connectors declares them. See this file's header for the
 * update path.
 */
export const LOCAL_COLLECTOR_DEFINITIONS: readonly LocalCollectorDefinition[] = Object.freeze([
${entriesBody}
]);
`;

const { mkdirSync, writeFileSync } = await import("node:fs");
mkdirSync(dirname(targetPath), { recursive: true });
writeFileSync(targetPath, output);
console.log(`wrote ${targetPath}`);
