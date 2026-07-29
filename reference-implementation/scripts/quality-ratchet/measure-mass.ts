// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MAX_ALLOWED_COMPLEXITY = 5;
export const TARGET_ROOTS = ["server", "lib", "runtime"];
export const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx"]);

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "../..");

export class BiomeToolchainError extends Error {}

/** File-path -> complexity-mass map, e.g. `{ "server/foo.ts": 3 }`. */
export type MassObject = Record<string, number>;

/** `measureMass`'s and `writeBaselineFile`'s shared `{files, total}` envelope. */
export interface MassWithTotal {
  files: MassObject;
  total: number;
}

export interface RunCommandResult {
  status: number | null;
  stderr: string;
  stdout: string;
}

export interface ResolvedBiomeBinary {
  binaryPath: string;
  version: string;
}

export interface ResolveBiomeOptions {
  rootDir?: string;
}

export type ResolveBiomeFn = (options: ResolveBiomeOptions) => Promise<ResolvedBiomeBinary>;

export interface MeasureMassOptions {
  commandCwd?: string;
  files?: string[] | null;
  resolveBiome?: ResolveBiomeFn;
  rootDir?: string;
}

interface BiomeDiagnosticLocation {
  path?: unknown;
}

interface BiomeDiagnostic {
  category?: unknown;
  location?: BiomeDiagnosticLocation;
  message?: unknown;
  severity?: unknown;
}

interface BiomeJsonReport {
  diagnostics?: BiomeDiagnostic[];
  summary?: { errors?: unknown };
}

export interface ParsedBiomeReport {
  errorCount: number;
  files: MassObject;
}

const REFERENCE_IMPLEMENTATION_PREFIX_PATTERN = /^reference-implementation\//;
const LEADING_DOT_SLASH_PATTERN = /^\.\//;

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function stripReferenceImplementationPrefix(value: string): string {
  return value.replace(REFERENCE_IMPLEMENTATION_PREFIX_PATTERN, "");
}

export function normalizeRepoPath(filePath: string, rootDir: string = PROJECT_ROOT): string {
  const normalized = filePath.replaceAll("\\", "/");
  if (path.isAbsolute(filePath)) {
    return stripReferenceImplementationPrefix(toPosix(path.relative(rootDir, filePath)));
  }
  return stripReferenceImplementationPrefix(normalized.replace(LEADING_DOT_SLASH_PATTERN, ""));
}

export function isTargetSourcePath(filePath: string): boolean {
  const normalized = normalizeRepoPath(filePath);
  const [root] = normalized.split("/");
  return root !== undefined && TARGET_ROOTS.includes(root) && SOURCE_EXTENSIONS.has(path.extname(normalized));
}

export function normalizeFileList(rawFiles: string[]): string[] {
  return [...new Set(rawFiles.map((file) => normalizeRepoPath(file)).filter(isTargetSourcePath))].sort();
}

function buildBiomeConfig() {
  return {
    $schema: "../node_modules/@biomejs/biome/configuration_schema.json",
    files: {
      ignoreUnknown: true,
    },
    linter: {
      enabled: true,
      rules: {
        complexity: {
          noExcessiveCognitiveComplexity: {
            level: "error",
            options: {
              maxAllowedComplexity: MAX_ALLOWED_COMPLEXITY,
            },
          },
          recommended: false,
        },
        recommended: false,
      },
    },
    root: true,
  };
}

function runCommand(command: string, args: string[], options: { cwd?: string } = {}): Promise<RunCommandResult> {
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
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ status, stderr, stdout });
    });
  });
}

function diagnosticPathToRepoPath(rawPath: string, rootDir: string): string {
  const resolved = path.isAbsolute(rawPath) ? rawPath : path.resolve(rootDir, rawPath);
  return normalizeRepoPath(resolved, rootDir);
}

const COMPLEXITY_CATEGORY = "lint/complexity/noExcessiveCognitiveComplexity";
const COMPLEXITY_MESSAGE_PATTERN = /\bExcessive complexity of (\d+) detected\b/;

export function parseBiomeJsonReport(rawOutput: string, rootDir: string = PROJECT_ROOT): ParsedBiomeReport {
  let report: BiomeJsonReport;
  try {
    report = JSON.parse(rawOutput) as BiomeJsonReport;
  } catch (error) {
    throw new BiomeToolchainError(
      `Biome --reporter=json output was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      }
    );
  }

  if (!report || typeof report.summary !== "object" || !Array.isArray(report.diagnostics)) {
    throw new BiomeToolchainError(
      "Biome --reporter=json output did not contain the expected summary/diagnostics shape."
    );
  }

  const massByFile = new Map<string, number>();
  let parseableErrorCount = 0;

  for (const diagnostic of report.diagnostics) {
    if (diagnostic?.severity !== "error") {
      continue;
    }

    if (diagnostic.category !== COMPLEXITY_CATEGORY) {
      throw new BiomeToolchainError(
        `Biome reported an error diagnostic outside ${COMPLEXITY_CATEGORY}, which the mass ratchet cannot safely ignore: ${JSON.stringify(diagnostic)}`
      );
    }

    const match = typeof diagnostic.message === "string" ? diagnostic.message.match(COMPLEXITY_MESSAGE_PATTERN) : null;
    const rawPath = diagnostic.location?.path;
    if (!(match?.[1] !== undefined && typeof rawPath === "string")) {
      throw new BiomeToolchainError(
        `Biome reported a ${COMPLEXITY_CATEGORY} diagnostic without a parseable complexity score or path: ${JSON.stringify(diagnostic)}`
      );
    }

    const score = Number.parseInt(match[1], 10);
    const excess = Math.max(0, score - MAX_ALLOWED_COMPLEXITY);
    const file = diagnosticPathToRepoPath(rawPath, rootDir);
    massByFile.set(file, (massByFile.get(file) ?? 0) + excess);
    parseableErrorCount += 1;
  }

  const reportedErrors = report.summary?.errors;
  if (parseableErrorCount !== reportedErrors) {
    throw new BiomeToolchainError(
      `Biome summary.errors (${JSON.stringify(reportedErrors)}) does not match the number of parseable ${COMPLEXITY_CATEGORY} error diagnostics (${parseableErrorCount}); refusing to trust a partially-parsed report.`
    );
  }

  return {
    errorCount: parseableErrorCount,
    files: sortMassObject(Object.fromEntries(massByFile)),
  };
}

export function sortMassObject(files: MassObject): MassObject {
  return Object.fromEntries(
    Object.entries(files)
      .filter(([, mass]) => Number.isFinite(mass) && mass > 0)
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

export function withTotal(files: MassObject): MassWithTotal {
  const sorted = sortMassObject(files);
  const total = Object.values(sorted).reduce((sum, mass) => sum + mass, 0);
  return { files: sorted, total };
}

export function resolveBiomeBinaryPath(rootDir: string = PROJECT_ROOT): string {
  return path.join(rootDir, "node_modules", ".bin", "biome");
}

export async function readPinnedBiomeVersion(rootDir: string = PROJECT_ROOT): Promise<string> {
  const packageJsonPath = path.join(rootDir, "package.json");
  let manifest: { devDependencies?: Record<string, string>; dependencies?: Record<string, string> };
  try {
    manifest = JSON.parse(await readFile(packageJsonPath, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new BiomeToolchainError(`Cannot verify Biome toolchain: ${packageJsonPath} does not exist.`, {
        cause: error,
      });
    }
    throw error;
  }

  const pinned = manifest.devDependencies?.["@biomejs/biome"] ?? manifest.dependencies?.["@biomejs/biome"];
  if (typeof pinned !== "string" || pinned.trim().length === 0) {
    throw new BiomeToolchainError(
      `Cannot verify Biome toolchain: no "@biomejs/biome" dependency declared in ${packageJsonPath}.`
    );
  }
  return pinned.trim();
}

const BIOME_VERSION_OUTPUT_PATTERN = /Version:\s*([0-9][^\s]*)/;

function parseBiomeVersionOutput(output: string): string | null {
  const match = output.match(BIOME_VERSION_OUTPUT_PATTERN);
  return match?.[1] ? match[1].trim() : null;
}

export async function resolveVerifiedBiomeBinary({
  rootDir = PROJECT_ROOT,
}: ResolveBiomeOptions = {}): Promise<ResolvedBiomeBinary> {
  const binaryPath = resolveBiomeBinaryPath(rootDir);
  try {
    await stat(binaryPath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new BiomeToolchainError(
        `Mass ratchet requires the workspace-local Biome binary at ${binaryPath}, which is missing. Run pnpm install (never npx or a global Biome) before measuring.`,
        { cause: error }
      );
    }
    throw error;
  }

  const pinnedVersion = await readPinnedBiomeVersion(rootDir);
  const versionResult = await runCommand(binaryPath, ["--version"], { cwd: rootDir });
  const resolvedVersion = parseBiomeVersionOutput(`${versionResult.stdout}\n${versionResult.stderr}`);

  if (versionResult.status !== 0 || !resolvedVersion) {
    throw new BiomeToolchainError(`Could not determine the version reported by ${binaryPath}.`);
  }
  if (resolvedVersion !== pinnedVersion) {
    throw new BiomeToolchainError(
      `Biome version mismatch: ${binaryPath} reports ${resolvedVersion}, but package.json pins ${pinnedVersion}. Run pnpm install and retry.`
    );
  }

  return { binaryPath, version: resolvedVersion };
}

function resolveMeasurePaths(files: string[] | null | undefined, rootDir: string): string[] {
  if (!files) {
    return TARGET_ROOTS.map((targetRoot) => path.join(rootDir, targetRoot));
  }
  return normalizeFileList(files).map((file) => path.join(rootDir, file));
}

async function existingPaths(paths: string[]): Promise<string[]> {
  const checks = await Promise.all(
    paths.map(async (filePath) => {
      try {
        await stat(filePath);
        return filePath;
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          return null;
        }
        throw error;
      }
    })
  );
  return checks.filter((filePath): filePath is string => filePath !== null);
}

export async function measureMass({
  files = null,
  rootDir = PROJECT_ROOT,
  commandCwd = PROJECT_ROOT,
  resolveBiome = resolveVerifiedBiomeBinary,
}: MeasureMassOptions = {}): Promise<MassWithTotal> {
  const paths = await existingPaths(resolveMeasurePaths(files, rootDir));
  if (paths.length === 0) {
    return withTotal({});
  }

  const { binaryPath } = await resolveBiome({ rootDir });

  const tempDir = await mkdtemp(path.join(tmpdir(), "pdpp-mass-ratchet-"));
  const configPath = path.join(tempDir, "biome.mass.json");

  try {
    await writeFile(configPath, `${JSON.stringify(buildBiomeConfig(), null, 2)}\n`);
    const result = await runCommand(
      binaryPath,
      ["lint", "--config-path", configPath, "--max-diagnostics=none", "--reporter=json", ...paths],
      { cwd: commandCwd }
    );

    if (result.status === null || result.status > 1) {
      throw new BiomeToolchainError(
        `Biome exited abnormally (status=${result.status === null ? "null (signal)" : result.status}):\n${result.stderr.trim()}`
      );
    }

    const { files: filesWithMass, errorCount } = parseBiomeJsonReport(result.stdout, rootDir);

    if (result.status === 0 && errorCount > 0) {
      throw new BiomeToolchainError(
        `Biome exited 0 but its report claims ${errorCount} error(s); the exit status and report are inconsistent.`
      );
    }
    if (result.status === 1 && errorCount === 0) {
      throw new BiomeToolchainError(
        "Biome exited 1 but its report claims zero errors; the exit status and report are inconsistent."
      );
    }

    return withTotal(filesWithMass);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

interface ParsedMeasureArgs {
  files: string[] | null;
}

function parseMeasureArgs(argv: string[]): ParsedMeasureArgs {
  const files: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--files") {
      let next = argv[i + 1];
      while (next && !next.startsWith("--")) {
        files.push(...splitFilesArgument(next));
        i += 1;
        next = argv[i + 1];
      }
    } else if (arg?.startsWith("--files=")) {
      files.push(...splitFilesArgument(arg.slice("--files=".length)));
    }
  }
  return { files: files.length > 0 ? files : null };
}

const FILES_ARGUMENT_SEPARATOR_PATTERN = /[,\s]+/;

export function splitFilesArgument(value: string): string[] {
  return value
    .split(FILES_ARGUMENT_SEPARATOR_PATTERN)
    .map((file) => file.trim())
    .filter(Boolean);
}

async function main(): Promise<void> {
  const args = parseMeasureArgs(process.argv.slice(2));
  const result = await measureMass(args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
