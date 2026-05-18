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

const allowedPackageFilePatterns = [
  /^package\.json$/,
  /^README\.md$/,
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

  for (const requiredFile of ["package.json", "README.md", "dist/index.js", "dist/index.d.ts"]) {
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
            "@pdpp/remote-surface": tarballPath,
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
        'import "@pdpp/remote-surface";',
        'import "@pdpp/remote-surface/adapters";',
        'import "@pdpp/remote-surface/backends/cdp";',
        'import "@pdpp/remote-surface/backends/neko";',
        'import "@pdpp/remote-surface/backends/types";',
        'import "@pdpp/remote-surface/client";',
        'import "@pdpp/remote-surface/controllers";',
        'import "@pdpp/remote-surface/diagnostics";',
        'import "@pdpp/remote-surface/ime";',
        'import "@pdpp/remote-surface/leases";',
        'import "@pdpp/remote-surface/protocol";',
        'import "@pdpp/remote-surface/server";',
        'import "@pdpp/remote-surface/testing";',
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
          'await import("@pdpp/remote-surface");',
          'await import("@pdpp/remote-surface/adapters");',
          'await import("@pdpp/remote-surface/backends/cdp");',
          'await import("@pdpp/remote-surface/backends/neko");',
          'await import("@pdpp/remote-surface/backends/types");',
          'await import("@pdpp/remote-surface/client");',
          'await import("@pdpp/remote-surface/controllers");',
          'await import("@pdpp/remote-surface/diagnostics");',
          'await import("@pdpp/remote-surface/ime");',
          'await import("@pdpp/remote-surface/leases");',
          'await import("@pdpp/remote-surface/protocol");',
          'await import("@pdpp/remote-surface/server");',
          'await import("@pdpp/remote-surface/testing");',
        ].join("\n"),
      ],
      { cwd: fixtureDir, maxBuffer: 1024 * 1024 },
    );
  } finally {
    await rm(fixtureDir, { force: true, recursive: true });
  }
}
