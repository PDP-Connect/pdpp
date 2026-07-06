import { spawn } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MAX_ALLOWED_COMPLEXITY = 5;
export const TARGET_ROOTS = ["server", "lib", "runtime"];
export const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx"]);

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "../..");

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function stripReferenceImplementationPrefix(value) {
  return value.replace(/^reference-implementation\//, "");
}

export function normalizeRepoPath(filePath, rootDir = PROJECT_ROOT) {
  const normalized = filePath.replaceAll("\\", "/");
  if (path.isAbsolute(filePath)) {
    return stripReferenceImplementationPrefix(toPosix(path.relative(rootDir, filePath)));
  }
  return stripReferenceImplementationPrefix(normalized.replace(/^\.\//, ""));
}

export function isTargetSourcePath(filePath) {
  const normalized = normalizeRepoPath(filePath);
  const root = normalized.split("/")[0];
  return TARGET_ROOTS.includes(root) && SOURCE_EXTENSIONS.has(path.extname(normalized));
}

export function normalizeFileList(rawFiles) {
  return [...new Set(rawFiles.map((file) => normalizeRepoPath(file)).filter(isTargetSourcePath))].sort();
}

function buildBiomeConfig() {
  return {
    $schema: "../node_modules/@biomejs/biome/configuration_schema.json",
    root: true,
    files: {
      ignoreUnknown: true,
    },
    linter: {
      enabled: true,
      rules: {
        recommended: false,
        complexity: {
          recommended: false,
          noExcessiveCognitiveComplexity: {
            level: "error",
            options: {
              maxAllowedComplexity: MAX_ALLOWED_COMPLEXITY,
            },
          },
        },
      },
    },
  };
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

function diagnosticPathToRepoPath(rawPath, rootDir) {
  const withoutLocation = rawPath.replace(/:\d+:\d+$/, "");
  const resolved = path.isAbsolute(withoutLocation) ? withoutLocation : path.resolve(rootDir, withoutLocation);
  return normalizeRepoPath(resolved, rootDir);
}

export function parseBiomeMassOutput(output, rootDir = PROJECT_ROOT) {
  const massByFile = new Map();
  let currentFile = null;

  for (const line of output.split(/\r?\n/)) {
    const header = line.match(/^(.+?):\d+:\d+\s+lint\/complexity\/noExcessiveCognitiveComplexity\b/);
    if (header) {
      currentFile = diagnosticPathToRepoPath(header[1], rootDir);
      continue;
    }

    const complexity = line.match(/\bExcessive complexity of (\d+) detected\b/);
    if (!(currentFile && complexity)) {
      continue;
    }

    const score = Number.parseInt(complexity[1], 10);
    const excess = Math.max(0, score - MAX_ALLOWED_COMPLEXITY);
    massByFile.set(currentFile, (massByFile.get(currentFile) ?? 0) + excess);
  }

  return sortMassObject(Object.fromEntries(massByFile));
}

export function sortMassObject(files) {
  return Object.fromEntries(
    Object.entries(files)
      .filter(([, mass]) => Number.isFinite(mass) && mass > 0)
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

export function withTotal(files) {
  const sorted = sortMassObject(files);
  const total = Object.values(sorted).reduce((sum, mass) => sum + mass, 0);
  return { files: sorted, total };
}

function resolveMeasurePaths(files, rootDir) {
  if (!files) {
    return TARGET_ROOTS.map((targetRoot) => path.join(rootDir, targetRoot));
  }
  return normalizeFileList(files).map((file) => path.join(rootDir, file));
}

async function existingPaths(paths) {
  const checks = await Promise.all(
    paths.map(async (filePath) => {
      try {
        await stat(filePath);
        return filePath;
      } catch (error) {
        if (error?.code === "ENOENT") {
          return null;
        }
        throw error;
      }
    })
  );
  return checks.filter(Boolean);
}

export async function measureMass({ files = null, rootDir = PROJECT_ROOT, commandCwd = PROJECT_ROOT } = {}) {
  const paths = await existingPaths(resolveMeasurePaths(files, rootDir));
  if (paths.length === 0) {
    return withTotal({});
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), "pdpp-mass-ratchet-"));
  const configPath = path.join(tempDir, "biome.mass.json");

  try {
    await writeFile(configPath, `${JSON.stringify(buildBiomeConfig(), null, 2)}\n`);
    const result = await runCommand(
      "npx",
      ["biome", "lint", "--config-path", configPath, "--max-diagnostics=none", "--colors=off", ...paths],
      { cwd: commandCwd }
    );

    const output = `${result.stderr}\n${result.stdout}`;
    const filesWithMass = parseBiomeMassOutput(output, rootDir);

    if (result.status !== 0 && Object.keys(filesWithMass).length === 0 && /configuration|No files were processed/i.test(output)) {
      throw new Error(`Biome mass measurement failed:\n${output.trim()}`);
    }

    return withTotal(filesWithMass);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

function parseMeasureArgs(argv) {
  const files = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--files") {
      while (argv[i + 1] && !argv[i + 1].startsWith("--")) {
        files.push(...splitFilesArgument(argv[i + 1]));
        i += 1;
      }
    } else if (arg.startsWith("--files=")) {
      files.push(...splitFilesArgument(arg.slice("--files=".length)));
    }
  }
  return { files: files.length > 0 ? files : null };
}

export function splitFilesArgument(value) {
  return value
    .split(/[,\s]+/)
    .map((file) => file.trim())
    .filter(Boolean);
}

async function main() {
  const args = parseMeasureArgs(process.argv.slice(2));
  const result = await measureMass(args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
