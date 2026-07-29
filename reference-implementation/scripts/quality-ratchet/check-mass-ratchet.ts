// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  MassObject,
  MassWithTotal,
  MeasureMassOptions,
  ResolveBiomeOptions,
  ResolvedBiomeBinary,
} from "./measure-mass.ts";
import {
  BiomeToolchainError,
  MAX_ALLOWED_COMPLEXITY,
  measureMass,
  normalizeFileList,
  PROJECT_ROOT,
  resolveVerifiedBiomeBinary,
  sortMassObject,
  splitFilesArgument,
  withTotal,
} from "./measure-mass.ts";

export const BASELINE_PATH = path.join(PROJECT_ROOT, "scripts/quality-ratchet/mass-baseline.json");
export const JUSTIFICATIONS_PATH = path.join(PROJECT_ROOT, "scripts/quality-ratchet/mass-justifications.json");

/** The fingerprint pinned into a baseline's `meta` field; must match the current toolchain to trust it. */
export interface MassFingerprint {
  biomeVersion: string;
  maxAllowedComplexity: number;
}

export interface MassJustificationEntry {
  allowed_mass: number;
  date: string;
  reason: string;
}

export type MassJustifications = Record<string, MassJustificationEntry>;

/**
 * The on-disk baseline JSON shape. Modern baselines carry the `{files, total,
 * meta}` envelope; a legacy baseline predating that envelope is a bare
 * file->mass map with no wrapper at all, so this also carries an index
 * signature for arbitrary top-level keys (the legacy fallback in
 * `normalizeBaseline` treats those keys as mass entries directly).
 */
interface RawBaselineFile {
  files?: Record<string, unknown>;
  meta?: unknown;
  total?: number;
  [key: string]: unknown;
}

interface MassRatchetFailure {
  allowed: number;
  baseline: number;
  current: number;
  file: string;
  justified: boolean;
}

interface MassRatchetTightened {
  after: number;
  before: number;
  file: string;
}

export interface RunMassRatchetOptions {
  all?: boolean;
  baselinePath?: string;
  files?: string[];
  justificationsPath?: string;
  measure?: (options: MeasureMassOptions) => Promise<MassWithTotal>;
  resolveFingerprint?: (options?: ResolveFingerprintOptions) => Promise<MassFingerprint>;
  writeBaseline?: boolean;
}

export interface MassRatchetResult {
  baseline: MassObject;
  checkedFiles: string[];
  failures: MassRatchetFailure[];
  justifications: MassJustifications;
  measured: MassObject;
  messages: string[];
  ok: boolean;
  tightened: MassRatchetTightened[];
}

async function readJsonFile<T>(filePath: string, fallback: T | null = null): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (fallback !== null && error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

/**
 * Coerce an object whose values are expected to be numeric mass scores, but
 * whose static type only guarantees `unknown` (raw JSON input), into a real
 * `MassObject`. Non-numeric values become `NaN`, which `sortMassObject`'s own
 * `Number.isFinite` filter already drops -- this mirrors that same runtime
 * defense instead of trusting an unchecked cast.
 */
function coerceToMassObject(raw: Record<string, unknown>): MassObject {
  return Object.fromEntries(
    Object.entries(raw).map(([file, mass]) => [file, typeof mass === "number" ? mass : Number.NaN])
  );
}

function normalizeBaseline(raw: RawBaselineFile): MassObject {
  if (raw && typeof raw === "object" && raw.files && typeof raw.files === "object") {
    return sortMassObject(coerceToMassObject(raw.files));
  }
  if (raw && typeof raw === "object") {
    // Legacy baseline shape: no `{files, total, meta}` envelope -- the whole
    // object IS the file->mass map.
    return sortMassObject(coerceToMassObject(raw));
  }
  return {};
}

function normalizeBaselineMeta(raw: RawBaselineFile): MassFingerprint | null {
  if (raw && typeof raw === "object" && raw.meta && typeof raw.meta === "object") {
    return raw.meta as MassFingerprint;
  }
  return null;
}

interface ResolveFingerprintOptions {
  resolveBiome?: (options: ResolveBiomeOptions) => Promise<ResolvedBiomeBinary>;
  rootDir?: string;
}

export async function resolveCurrentFingerprint({
  rootDir = PROJECT_ROOT,
  resolveBiome = resolveVerifiedBiomeBinary,
}: ResolveFingerprintOptions = {}): Promise<MassFingerprint> {
  const { version } = await resolveBiome({ rootDir });
  return { biomeVersion: version, maxAllowedComplexity: MAX_ALLOWED_COMPLEXITY };
}

function fingerprintsMatch(a: MassFingerprint | null, b: MassFingerprint | null): boolean {
  return (
    Boolean(a) &&
    Boolean(b) &&
    a?.biomeVersion === b?.biomeVersion &&
    a?.maxAllowedComplexity === b?.maxAllowedComplexity
  );
}

function validateJustifications(raw: unknown): MassJustifications {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }

  const normalized: MassJustifications = {};
  for (const [file, entryRaw] of Object.entries(raw as Record<string, unknown>)) {
    if (!entryRaw || typeof entryRaw !== "object") {
      throw new Error(`Invalid mass justification for ${file}: expected an object.`);
    }
    const entry = entryRaw as Record<string, unknown>;
    const allowedMass = entry.allowed_mass;
    if (!Number.isInteger(allowedMass) || (typeof allowedMass === "number" && allowedMass < 0)) {
      throw new Error(`Invalid mass justification for ${file}: allowed_mass must be a non-negative integer.`);
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length === 0) {
      throw new Error(`Invalid mass justification for ${file}: reason is required.`);
    }
    if (typeof entry.date !== "string" || entry.date.trim().length === 0) {
      throw new Error(`Invalid mass justification for ${file}: date is required.`);
    }
    normalized[file] = {
      allowed_mass: allowedMass as number,
      date: entry.date,
      reason: entry.reason,
    };
  }
  return Object.fromEntries(Object.entries(normalized).sort(([left], [right]) => left.localeCompare(right)));
}

function formatJustifications(justifications: MassJustifications, baseline: MassObject): string[] {
  const entries = Object.entries(justifications);
  if (entries.length === 0) {
    return [];
  }
  return [
    "ACTIVE MASS JUSTIFICATIONS:",
    ...entries.map(
      ([file, entry]) =>
        `  ${file}: allowed_mass=${entry.allowed_mass}, baseline=${baseline[file] ?? 0}, date=${entry.date}, reason=${entry.reason}`
    ),
  ];
}

function selectFilesForCheck({
  all,
  files,
  baseline,
  measured,
}: {
  all: boolean;
  files: string[];
  baseline: MassObject;
  measured: MassObject;
}): string[] {
  if (all) {
    return [...new Set([...Object.keys(baseline), ...Object.keys(measured)])].sort();
  }
  return normalizeFileList(files);
}

export function writeBaselineFile(
  baselinePath: string,
  files: MassObject,
  meta: MassFingerprint | null
): Promise<void> {
  return writeFile(baselinePath, `${JSON.stringify({ ...withTotal(files), meta }, null, 2)}\n`);
}

export async function runMassRatchet({
  all = false,
  files = [],
  baselinePath = BASELINE_PATH,
  justificationsPath = JUSTIFICATIONS_PATH,
  measure = measureMass,
  writeBaseline = true,
  resolveFingerprint = resolveCurrentFingerprint,
}: RunMassRatchetOptions = {}): Promise<MassRatchetResult> {
  const rawBaseline = await readJsonFile<RawBaselineFile>(baselinePath, { files: {}, meta: null, total: 0 });
  const baseline = normalizeBaseline(rawBaseline);
  const baselineMeta = normalizeBaselineMeta(rawBaseline);
  const justifications = validateJustifications(await readJsonFile<unknown>(justificationsPath, {}));
  const currentFingerprint = await resolveFingerprint();

  if (!fingerprintsMatch(baselineMeta, currentFingerprint)) {
    throw new BiomeToolchainError(
      `Mass baseline fingerprint mismatch: baseline was recorded under ${JSON.stringify(baselineMeta)}, but the current toolchain is ${JSON.stringify(
        currentFingerprint
      )}. Regenerate the baseline (scripts/quality-ratchet/regenerate-mass-baseline.ts) before checking.`
    );
  }

  const measureInput: MeasureMassOptions = all ? { files: null } : { files: normalizeFileList(files) };
  const measuredResult = await measure(measureInput);
  const measured = sortMassObject(measuredResult.files);
  const checkedFiles = selectFilesForCheck({ all, baseline, files, measured });
  const nextBaseline: MassObject = { ...baseline };
  const failures: MassRatchetFailure[] = [];
  const tightened: MassRatchetTightened[] = [];

  for (const file of checkedFiles) {
    const current = measured[file] ?? 0;
    const baselineMass = baseline[file] ?? 0;
    const justification = justifications[file];
    const allowed = justification ? Math.max(baselineMass, justification.allowed_mass) : baselineMass;

    if (current > allowed) {
      failures.push({ allowed, baseline: baselineMass, current, file, justified: Boolean(justification) });
      continue;
    }

    if (current < baselineMass) {
      if (current > 0) {
        nextBaseline[file] = current;
      } else {
        delete nextBaseline[file];
      }
      tightened.push({ after: current, before: baselineMass, file });
    }
  }

  if (tightened.length > 0 && writeBaseline) {
    await writeBaselineFile(baselinePath, nextBaseline, currentFingerprint);
  }

  return {
    baseline,
    checkedFiles,
    failures,
    justifications,
    measured,
    messages: [
      ...formatJustifications(justifications, baseline),
      ...tightened.map(({ file, before, after }) => `TIGHTENED ${file}: baseline ${before} -> ${after}`),
    ],
    ok: failures.length === 0,
    tightened,
  };
}

interface ParsedCheckArgs {
  all: boolean;
  files: string[];
}

function parseCheckArgs(argv: string[]): ParsedCheckArgs {
  let all = false;
  const files: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--all") {
      all = true;
    } else if (arg === "--files") {
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

  if (!all && files.length === 0) {
    throw new Error("Usage: check-mass-ratchet.ts --all | --files a,b,c");
  }

  return { all, files };
}

function printResult(result: MassRatchetResult): void {
  for (const message of result.messages) {
    console.log(message);
  }

  if (result.checkedFiles.length === 0) {
    console.log("MASS RATCHET PASS: no staged server/lib/runtime source files.");
    return;
  }

  if (result.ok) {
    console.log(`MASS RATCHET PASS: ${result.checkedFiles.length} file(s) checked.`);
    return;
  }

  console.error("MASS RATCHET FAIL: complexity mass increased above the allowed baseline.");
  for (const failure of result.failures) {
    const suffix = failure.justified ? `, justified allowed ${failure.allowed}` : "";
    console.error(`  ${failure.file}: baseline ${failure.baseline}, current ${failure.current}${suffix}`);
  }
}

async function main(): Promise<void> {
  const args = parseCheckArgs(process.argv.slice(2));
  const result = await runMassRatchet(args);
  printResult(result);
  if (!result.ok) {
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
