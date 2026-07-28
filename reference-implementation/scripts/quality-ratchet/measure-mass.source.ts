// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

interface FakeWorkspaceOptions {
  binaryScript?: string | null;
  pinnedVersion?: string;
}
interface MeasureMassWorkspaceOptions {
  exitStatus: number;
  jsonReport: Record<string, unknown>;
}

import { BiomeToolchainError, measureMass, parseBiomeJsonReport, resolveVerifiedBiomeBinary } from "./measure-mass.ts";

async function withFakeWorkspace({
  pinnedVersion = "2.4.12",
  binaryScript = null,
}: FakeWorkspaceOptions = {}): Promise<string> {
  const rootDir = await mkdtemp(path.join(tmpdir(), "pdpp-mass-toolchain-test-"));
  await writeFile(
    path.join(rootDir, "package.json"),
    JSON.stringify({ devDependencies: { "@biomejs/biome": pinnedVersion } })
  );
  if (binaryScript !== null) {
    const binDir = path.join(rootDir, "node_modules", ".bin");
    await mkdir(binDir, { recursive: true });
    const binaryPath = path.join(binDir, "biome");
    await writeFile(binaryPath, binaryScript);
    await chmod(binaryPath, 0o755);
  }
  return rootDir;
}

function lintOrVersionScript({ jsonReport, exitStatus }: MeasureMassWorkspaceOptions): string {
  return [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then',
    '  echo "Version: 2.4.12"',
    "  exit 0",
    "fi",
    `cat <<'BIOME_JSON_EOF'`,
    JSON.stringify(jsonReport),
    "BIOME_JSON_EOF",
    `exit ${exitStatus}`,
    "",
  ].join("\n");
}

async function withMeasureMassWorkspace({ jsonReport, exitStatus }: MeasureMassWorkspaceOptions): Promise<string> {
  const rootDir = await withFakeWorkspace({
    binaryScript: lintOrVersionScript({ exitStatus, jsonReport }),
    pinnedVersion: "2.4.12",
  });
  await mkdir(path.join(rootDir, "server"), { recursive: true });
  await writeFile(path.join(rootDir, "server", "a.js"), "export const a = 1;\n");
  return rootDir;
}

async function cleanup(rootDir: string): Promise<void> {
  await rm(rootDir, { force: true, recursive: true });
}

test("missing local Biome binary fails closed", async () => {
  const rootDir = await withFakeWorkspace();
  try {
    await assert.rejects(resolveVerifiedBiomeBinary({ rootDir }), BiomeToolchainError);
  } finally {
    await cleanup(rootDir);
  }
});

test("resolved binary reporting a different version than package.json fails closed", async () => {
  const rootDir = await withFakeWorkspace({
    binaryScript: '#!/bin/sh\necho "Version: 0.3.3"\n',
    pinnedVersion: "2.4.12",
  });
  try {
    // biome-ignore lint/performance/useTopLevelRegex: This parser-local expression intentionally avoids shared regular-expression state.
    await assert.rejects(resolveVerifiedBiomeBinary({ rootDir }), /version mismatch/i);
  } finally {
    await cleanup(rootDir);
  }
});

test("resolved binary matching the pinned version passes", async () => {
  const rootDir = await withFakeWorkspace({
    binaryScript: '#!/bin/sh\necho "Version: 2.4.12"\n',
    pinnedVersion: "2.4.12",
  });
  try {
    const { version } = await resolveVerifiedBiomeBinary({ rootDir });
    assert.equal(version, "2.4.12");
  } finally {
    await cleanup(rootDir);
  }
});

test("measureMass fails closed when the resolved toolchain is wrong", async () => {
  const rootDir = await withFakeWorkspace({
    binaryScript: '#!/bin/sh\necho "Version: 0.3.3"\n',
    pinnedVersion: "2.4.12",
  });
  await mkdir(path.join(rootDir, "server"), { recursive: true });
  await writeFile(path.join(rootDir, "server", "a.js"), "export const a = 1;\n");
  try {
    // biome-ignore lint/performance/useTopLevelRegex: This parser-local expression intentionally avoids shared regular-expression state.
    await assert.rejects(measureMass({ commandCwd: rootDir, rootDir }), /version mismatch/i);
  } finally {
    await cleanup(rootDir);
  }
});

test("parseBiomeJsonReport fails closed on unparseable output", () => {
  assert.throws(() => parseBiomeJsonReport("not json"), BiomeToolchainError);
});

test("parseBiomeJsonReport fails closed on unexpected shape", () => {
  assert.throws(() => parseBiomeJsonReport(JSON.stringify({ foo: "bar" })), BiomeToolchainError);
});

test("parseBiomeJsonReport reports a true zero-diagnostic clean run", () => {
  const report = JSON.stringify({ diagnostics: [], summary: { errors: 0 } });
  const { files, errorCount } = parseBiomeJsonReport(report, "/repo");
  assert.deepEqual(files, {});
  assert.equal(errorCount, 0);
});

test("parseBiomeJsonReport sums complexity mass per file from real diagnostics", () => {
  const report = JSON.stringify({
    diagnostics: [
      {
        category: "lint/complexity/noExcessiveCognitiveComplexity",
        location: { path: "runtime/a.ts" },
        message: "Excessive complexity of 13 detected (max: 5).",
        severity: "error",
      },
      {
        category: "lint/complexity/noExcessiveCognitiveComplexity",
        location: { path: "runtime/a.ts" },
        message: "Excessive complexity of 8 detected (max: 5).",
        severity: "error",
      },
    ],
    summary: { errors: 2 },
  });
  const { files, errorCount } = parseBiomeJsonReport(report, "/repo");
  assert.deepEqual(files, { "runtime/a.ts": 8 + 3 });
  assert.equal(errorCount, 2);
});

test("parseBiomeJsonReport fails closed on a complexity diagnostic missing a parseable score", () => {
  const report = JSON.stringify({
    diagnostics: [
      {
        category: "lint/complexity/noExcessiveCognitiveComplexity",
        location: { path: "runtime/a.ts" },
        message: "Something changed shape upstream.",
        severity: "error",
      },
    ],
    summary: { errors: 1 },
  });
  assert.throws(() => parseBiomeJsonReport(report, "/repo"), BiomeToolchainError);
});

test("parseBiomeJsonReport fails closed on a non-complexity error diagnostic mixed with a real complexity finding", () => {
  const report = JSON.stringify({
    diagnostics: [
      {
        category: "parse",
        location: { path: "runtime/bad.ts" },
        message: "expected `)` but instead the file ends",
        severity: "error",
      },
      {
        category: "lint/complexity/noExcessiveCognitiveComplexity",
        location: { path: "runtime/a.ts" },
        message: "Excessive complexity of 8 detected (max: 5).",
        severity: "error",
      },
    ],
    summary: { errors: 2 },
  });
  assert.throws(
    () => parseBiomeJsonReport(report, "/repo"),
    // biome-ignore lint/performance/useTopLevelRegex: This parser-local expression intentionally avoids shared regular-expression state.
    /outside lint\/complexity\/noExcessiveCognitiveComplexity/
  );
});

test("parseBiomeJsonReport fails closed when summary.errors overcounts parseable diagnostics", () => {
  const report = JSON.stringify({
    diagnostics: [
      {
        category: "lint/complexity/noExcessiveCognitiveComplexity",
        location: { path: "runtime/a.ts" },
        message: "Excessive complexity of 8 detected (max: 5).",
        severity: "error",
      },
    ],
    summary: { errors: 2 },
  });
  // biome-ignore lint/performance/useTopLevelRegex: This parser-local expression intentionally avoids shared regular-expression state.
  assert.throws(() => parseBiomeJsonReport(report, "/repo"), /summary\.errors/);
});

test("parseBiomeJsonReport ignores non-error severities (warnings/advice)", () => {
  const report = JSON.stringify({
    diagnostics: [
      {
        category: "lint/style/someRule",
        location: { path: "runtime/a.ts" },
        message: "unrelated warning",
        severity: "warning",
      },
      {
        category: "lint/complexity/noExcessiveCognitiveComplexity",
        location: { path: "runtime/a.ts" },
        message: "Excessive complexity of 8 detected (max: 5).",
        severity: "error",
      },
    ],
    summary: { errors: 1 },
  });
  const { files, errorCount } = parseBiomeJsonReport(report, "/repo");
  assert.deepEqual(files, { "runtime/a.ts": 3 });
  assert.equal(errorCount, 1);
});

test("measureMass fails closed on a mixed syntax-error-plus-complexity result even though a complexity diagnostic parses fine", async () => {
  const rootDir = await withMeasureMassWorkspace({
    exitStatus: 1,
    jsonReport: {
      diagnostics: [
        {
          category: "parse",
          location: { path: "server/bad.ts" },
          message: "expected `)` but instead the file ends",
          severity: "error",
        },
        {
          category: "lint/complexity/noExcessiveCognitiveComplexity",
          location: { path: "server/a.js" },
          message: "Excessive complexity of 8 detected (max: 5).",
          severity: "error",
        },
      ],
      summary: { errors: 2 },
    },
  });
  try {
    await assert.rejects(
      measureMass({ commandCwd: rootDir, rootDir }),
      // biome-ignore lint/performance/useTopLevelRegex: This parser-local expression intentionally avoids shared regular-expression state.
      /outside lint\/complexity\/noExcessiveCognitiveComplexity/
    );
  } finally {
    await cleanup(rootDir);
  }
});

test("measureMass fails closed on abnormal (signal-killed) exit even with otherwise valid-looking JSON", async () => {
  const rootDir = await withMeasureMassWorkspace({
    exitStatus: 137,
    jsonReport: { diagnostics: [], summary: { errors: 0 } },
  });
  try {
    // biome-ignore lint/performance/useTopLevelRegex: This parser-local expression intentionally avoids shared regular-expression state.
    await assert.rejects(measureMass({ commandCwd: rootDir, rootDir }), /exited abnormally/);
  } finally {
    await cleanup(rootDir);
  }
});

test("measureMass fails closed when exit status 0 disagrees with a nonzero reported error count", async () => {
  const rootDir = await withMeasureMassWorkspace({
    exitStatus: 0,
    jsonReport: {
      diagnostics: [
        {
          category: "lint/complexity/noExcessiveCognitiveComplexity",
          location: { path: "server/a.js" },
          message: "Excessive complexity of 8 detected (max: 5).",
          severity: "error",
        },
      ],
      summary: { errors: 1 },
    },
  });
  try {
    // biome-ignore lint/performance/useTopLevelRegex: This parser-local expression intentionally avoids shared regular-expression state.
    await assert.rejects(measureMass({ commandCwd: rootDir, rootDir }), /inconsistent/);
  } finally {
    await cleanup(rootDir);
  }
});

test("measureMass fails closed when exit status 1 disagrees with a zero reported error count", async () => {
  const rootDir = await withMeasureMassWorkspace({
    exitStatus: 1,
    jsonReport: { diagnostics: [], summary: { errors: 0 } },
  });
  try {
    // biome-ignore lint/performance/useTopLevelRegex: This parser-local expression intentionally avoids shared regular-expression state.
    await assert.rejects(measureMass({ commandCwd: rootDir, rootDir }), /inconsistent/);
  } finally {
    await cleanup(rootDir);
  }
});

test("measureMass accepts a real, consistent complexity failure (status 1, matching errors)", async () => {
  const rootDir = await withMeasureMassWorkspace({
    exitStatus: 1,
    jsonReport: {
      diagnostics: [
        {
          category: "lint/complexity/noExcessiveCognitiveComplexity",
          location: { path: "server/a.js" },
          message: "Excessive complexity of 8 detected (max: 5).",
          severity: "error",
        },
      ],
      summary: { errors: 1 },
    },
  });
  try {
    const result = await measureMass({ commandCwd: rootDir, rootDir });
    assert.deepEqual(result.files, { "server/a.js": 3 });
  } finally {
    await cleanup(rootDir);
  }
});
