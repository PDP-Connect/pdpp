// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export const publicExportNames = [
  "binaryFieldMetadata",
  "buildRecordContentLadder",
  "buildRecordSetContentLadder",
  "decodeContentHandle",
  "defaultEncodeResourceUri",
  "encodeContentHandle",
  "extractRecordRows",
  "formatEnvelopeHandles",
  "sanitizeRecordForEvidence",
  "stableInlineJson",
  "summarizeFieldWindowEvidence",
  "summarizeRecordEvidence",
  "truncateText",
];

export function installedPackageProbeSource(packageName: string, expectedNodeVersion: string): string {
  return [
    "import assert from 'node:assert/strict';",
    "import { createRequire } from 'node:module';",
    "const require = createRequire(import.meta.url);",
    `const resolved = require.resolve(${JSON.stringify(packageName)});`,
    "assert.match(resolved, /node_modules\\/@pdpp\\/read-core\\/dist\\/index\\.js$/);",
    `assert.equal(process.version, ${JSON.stringify(expectedNodeVersion)});`,
    `const readCore = await import(${JSON.stringify(packageName)});`,
    `assert.deepEqual(Object.keys(readCore).sort(), ${JSON.stringify(publicExportNames)}.sort());`,
    `for (const name of ${JSON.stringify(publicExportNames)}) {`,
    "  assert.equal(typeof readCore[name], 'function', 'missing imported export: ' + name);",
    "}",
    "process.stdout.write('runtime=' + process.version + '\\nresolved=' + resolved + '\\nexports=' + Object.keys(readCore).sort().join(',') + '\\n');",
    "",
  ].join("\n");
}
