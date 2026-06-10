import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = path.join(packageRoot, "package.json");
const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));

const EXPECTED_PACKAGE_NAME = "@opendatalabs/remote-surface";
assert.equal(
  packageJson.name,
  EXPECTED_PACKAGE_NAME,
  `package.json#name must be ${EXPECTED_PACKAGE_NAME}, got ${packageJson.name}`,
);

const allowedPackageFilePatterns = [
  /^package\.json$/,
  /^README\.md$/,
  /^LICENSE$/,
  /^SECURITY\.md$/,
  /^dist\/.+\.(js|js\.map|d\.ts|d\.ts\.map)$/,
];

const deniedPackageFilePatterns = [
  /^src\//,
  /(^|\/).+\.test\./,
  /^scripts\//,
  /^tsconfig/,
  /(^|\/)node_modules\//,
  /(^|\/)\.turbo\//,
  /(^|\/)\.tsbuildinfo$/,
];

const hostNeutralScanPatterns = [
  { name: "_ref", pattern: /(?<![A-Za-z0-9])_ref(?![A-Za-z0-9])/g },
  { name: "run_id", pattern: /run_id/g },
  { name: "interaction_id", pattern: /interaction_id/g },
  { name: "workspace:", pattern: /workspace:/g },
];

const hostNeutralCompatibilityAllowlist = [
  {
    name: "README documents the reference boundary and does not present reference fields as the default API",
    files: /^README\.md$/,
    patterns: new Set(["_ref", "run_id", "interaction_id"]),
  },
  {
    name: "reference-only subpath is the canonical home for PDPP-shaped wire and store fields",
    files: /^dist\/reference\/.+\.(d\.ts|js|js\.map)$/,
    patterns: new Set(["_ref", "run_id", "interaction_id"]),
  },
  {
    name: "host-neutral SurfaceSessionStore adapter must rename camelCase requests to the reference store's snake_case API at the call boundary; declarations stay host-neutral",
    files: /^dist\/server\/surface-session-store\.js(\.map)?$/,
    patterns: new Set(["run_id", "interaction_id"]),
  },
  {
    name: "deprecated @deprecated jsdoc blocks in re-export index files mention the reference field names as part of the migration notice",
    files: /^dist\/(leases|protocol|server|testing)\/(index|stream-viewer)\.(d\.ts|js|js\.map)$/,
    patterns: new Set(["run_id", "interaction_id"]),
  },
];

const publicPackageNamePattern = /@pdpp\/[a-z0-9._-]+/g;

const exportTargets = collectExportTargets(packageJson.exports);
const typeTargets = collectTypeTargets(packageJson.exports);
if (typeof packageJson.main === "string") {
  exportTargets.add(packageJson.main);
}
if (typeof packageJson.types === "string") {
  typeTargets.add(packageJson.types);
}

for (const target of [...exportTargets, ...typeTargets]) {
  assert.equal(target.startsWith("./dist/"), true, `${target} must point at ./dist`);
}

for (const [sectionName, deps] of Object.entries({
  dependencies: packageJson.dependencies,
  optionalDependencies: packageJson.optionalDependencies,
  peerDependencies: packageJson.peerDependencies,
})) {
  for (const [name, range] of Object.entries(deps ?? {})) {
    assert.equal(typeof range, "string", `${sectionName}.${name} must use a string range`);
    assert.equal(range.startsWith("workspace:"), false, `${sectionName}.${name} leaks workspace range ${range}`);
    assert.equal(range.startsWith("file:"), false, `${sectionName}.${name} leaks file range ${range}`);
    assert.equal(range.startsWith("link:"), false, `${sectionName}.${name} leaks link range ${range}`);
    assert.equal(name.startsWith("@pdpp/"), false, `${sectionName}.${name} leaks a private PDPP package dependency`);
    assert.equal(
      name.startsWith("@opendatalabs/") && name !== EXPECTED_PACKAGE_NAME,
      false,
      `${sectionName}.${name} declares a sibling OpenDataLabs workspace dependency; only ${EXPECTED_PACKAGE_NAME} may appear in this manifest`,
    );
  }
}

const { stdout: packJsonStdout } = await execFileAsync("npm", ["pack", "--json", "--ignore-scripts"], {
  cwd: packageRoot,
  maxBuffer: 1024 * 1024,
});
const packInfo = JSON.parse(packJsonStdout)[0];
const packedFiles = packInfo.files.map((file) => file.path).sort();
const tarballPath = path.join(packageRoot, packInfo.filename);

try {
  for (const file of packedFiles) {
    assert.equal(
      allowedPackageFilePatterns.some((pattern) => pattern.test(file)),
      true,
      `unexpected file in package tarball: ${file}`,
    );
    assert.equal(
      deniedPackageFilePatterns.some((pattern) => pattern.test(file)),
      false,
      `denied file in package tarball: ${file}`,
    );
  }

  for (const requiredFile of [
    "package.json",
    "README.md",
    "LICENSE",
    "SECURITY.md",
    "dist/index.js",
    "dist/index.d.ts",
  ]) {
    assert.equal(packedFiles.includes(requiredFile), true, `missing required package file: ${requiredFile}`);
  }

  for (const target of exportTargets) {
    const packedPath = target.replace(/^\.\//, "");
    assert.equal(packedFiles.includes(packedPath), true, `export target missing from tarball: ${target}`);
  }
  for (const target of typeTargets) {
    const packedPath = target.replace(/^\.\//, "");
    assert.equal(packedFiles.includes(packedPath), true, `type target missing from tarball: ${target}`);
  }

  await validatePublicArtifactBoundaries(packedFiles);
  await validateCleanConsumer(tarballPath);
} finally {
  await rm(tarballPath, { force: true });
}

function collectExportTargets(exportsField) {
  const targets = new Set();
  for (const entry of Object.values(exportsField ?? {})) {
    if (typeof entry === "string") {
      targets.add(entry);
      continue;
    }
    if (entry && typeof entry === "object" && typeof entry.import === "string") {
      targets.add(entry.import);
    }
  }
  return targets;
}

function collectTypeTargets(exportsField) {
  const targets = new Set();
  for (const entry of Object.values(exportsField ?? {})) {
    if (entry && typeof entry === "object" && typeof entry.types === "string") {
      targets.add(entry.types);
    }
  }
  return targets;
}

async function validatePublicArtifactBoundaries(packedFiles) {
  const unexpectedHostCoupling = [];
  const privatePackageLeaks = [];

  for (const file of packedFiles) {
    if (!(file === "README.md" || file === "SECURITY.md" || file.startsWith("dist/"))) {
      continue;
    }

    const text = await readFile(path.join(packageRoot, file), "utf8");
    for (const { name, pattern } of hostNeutralScanPatterns) {
      pattern.lastIndex = 0;
      if (!pattern.test(text)) {
        continue;
      }
      const compatibilityAllowance = hostNeutralCompatibilityAllowlist.find(
        (allowance) => allowance.patterns.has(name) && allowance.files.test(file),
      );
      if (!compatibilityAllowance) {
        unexpectedHostCoupling.push(`${file} contains ${name}`);
      }
    }

    publicPackageNamePattern.lastIndex = 0;
    const privateMatches = [...text.matchAll(publicPackageNamePattern)].map((match) => match[0]);
    for (const privatePackageName of new Set(privateMatches)) {
      privatePackageLeaks.push(`${file} references ${privatePackageName}`);
    }
  }

  assert.deepEqual(
    unexpectedHostCoupling,
    [],
    [
      "unexpected host-coupled public artifact leakage",
      "Known compatibility debt is pattern-allowlisted in validate-package.mjs; new _ref/run_id/interaction_id/workspace: matches need a host-neutral API or an explicit compatibility rationale.",
      ...unexpectedHostCoupling,
    ].join("\n"),
  );
  assert.deepEqual(
    privatePackageLeaks,
    [],
    ["unexpected private @pdpp package reference in public artifacts", ...privatePackageLeaks].join("\n"),
  );
}

async function validateCleanConsumer(tarballPath) {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "remote-surface-consumer-"));
  try {
    await writeFile(
      path.join(fixtureDir, "package.json"),
      JSON.stringify(
        {
          name: "remote-surface-clean-consumer",
          private: true,
          type: "module",
          dependencies: {
            "@opendatalabs/remote-surface": tarballPath,
            typescript: "^6.0.3",
          },
        },
        null,
        2,
      ),
    );
    await writeFile(
      path.join(fixtureDir, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            module: "NodeNext",
            moduleResolution: "NodeNext",
            noEmit: true,
            strict: true,
            target: "ES2023",
          },
          include: ["consumer.ts"],
        },
        null,
        2,
      ),
    );
    await writeFile(
      path.join(fixtureDir, "consumer.ts"),
      [
        'import { createSurfaceSessionStore } from "@opendatalabs/remote-surface/server";',
        'import "@opendatalabs/remote-surface";',
        'import "@opendatalabs/remote-surface/adapters";',
        'import "@opendatalabs/remote-surface/backends/cdp";',
        'import "@opendatalabs/remote-surface/backends/neko";',
        'import "@opendatalabs/remote-surface/backends/types";',
        'import "@opendatalabs/remote-surface/client";',
        'import "@opendatalabs/remote-surface/controllers";',
        'import "@opendatalabs/remote-surface/diagnostics";',
        'import "@opendatalabs/remote-surface/ime";',
        'import "@opendatalabs/remote-surface/leases";',
        'import "@opendatalabs/remote-surface/protocol";',
        'import "@opendatalabs/remote-surface/reference";',
        'import "@opendatalabs/remote-surface/server";',
        'import "@opendatalabs/remote-surface/testing";',
        'const store = createSurfaceSessionStore();',
        'const issued = store.mint({ surfaceSessionId: "surface", actionId: "action", browserSessionId: "browser" });',
        'store.attach({ token: issued.token, surfaceSessionId: "surface", actionId: "action" });',
        "",
      ].join("\n"),
    );

    await execFileAsync("pnpm", ["install", "--ignore-scripts", "--lockfile=false"], {
      cwd: fixtureDir,
      maxBuffer: 1024 * 1024,
    });
    await execFileAsync("pnpm", ["exec", "tsc", "--noEmit"], {
      cwd: fixtureDir,
      maxBuffer: 1024 * 1024,
    });
    await execFileAsync(
      "node",
      [
        "--input-type=module",
        "--eval",
        [
          'await import("@opendatalabs/remote-surface");',
          'await import("@opendatalabs/remote-surface/adapters");',
          'await import("@opendatalabs/remote-surface/backends/cdp");',
          'await import("@opendatalabs/remote-surface/backends/neko");',
          'await import("@opendatalabs/remote-surface/backends/types");',
          'await import("@opendatalabs/remote-surface/client");',
          'await import("@opendatalabs/remote-surface/controllers");',
          'await import("@opendatalabs/remote-surface/diagnostics");',
          'await import("@opendatalabs/remote-surface/ime");',
          'await import("@opendatalabs/remote-surface/leases");',
          'await import("@opendatalabs/remote-surface/protocol");',
          'await import("@opendatalabs/remote-surface/reference");',
          'await import("@opendatalabs/remote-surface/server");',
          'await import("@opendatalabs/remote-surface/testing");',
        ].join("\n"),
      ],
      { cwd: fixtureDir, maxBuffer: 1024 * 1024 },
    );
  } finally {
    await rm(fixtureDir, { force: true, recursive: true });
  }
}
