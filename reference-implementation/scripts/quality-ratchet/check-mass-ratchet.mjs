import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  BiomeToolchainError,
  MAX_ALLOWED_COMPLEXITY,
  PROJECT_ROOT,
  measureMass,
  normalizeFileList,
  resolveVerifiedBiomeBinary,
  sortMassObject,
  splitFilesArgument,
  withTotal,
} from "./measure-mass.mjs";

export const BASELINE_PATH = path.join(PROJECT_ROOT, "scripts/quality-ratchet/mass-baseline.json");
export const JUSTIFICATIONS_PATH = path.join(PROJECT_ROOT, "scripts/quality-ratchet/mass-justifications.json");

async function readJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (fallback !== null && error?.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

function normalizeBaseline(raw) {
  if (raw && typeof raw === "object" && raw.files && typeof raw.files === "object") {
    return sortMassObject(raw.files);
  }
  if (raw && typeof raw === "object") {
    return sortMassObject(raw);
  }
  return {};
}

function normalizeBaselineMeta(raw) {
  if (raw && typeof raw === "object" && raw.meta && typeof raw.meta === "object") {
    return raw.meta;
  }
  return null;
}

export async function resolveCurrentFingerprint({ rootDir = PROJECT_ROOT, resolveBiome = resolveVerifiedBiomeBinary } = {}) {
  const { version } = await resolveBiome({ rootDir });
  return { biomeVersion: version, maxAllowedComplexity: MAX_ALLOWED_COMPLEXITY };
}

function fingerprintsMatch(a, b) {
  return Boolean(a) && Boolean(b) && a.biomeVersion === b.biomeVersion && a.maxAllowedComplexity === b.maxAllowedComplexity;
}

function validateJustifications(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }

  const normalized = {};
  for (const [file, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== "object") {
      throw new Error(`Invalid mass justification for ${file}: expected an object.`);
    }
    const allowedMass = entry.allowed_mass;
    if (!Number.isInteger(allowedMass) || allowedMass < 0) {
      throw new Error(`Invalid mass justification for ${file}: allowed_mass must be a non-negative integer.`);
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length === 0) {
      throw new Error(`Invalid mass justification for ${file}: reason is required.`);
    }
    if (typeof entry.date !== "string" || entry.date.trim().length === 0) {
      throw new Error(`Invalid mass justification for ${file}: date is required.`);
    }
    normalized[file] = {
      allowed_mass: allowedMass,
      reason: entry.reason,
      date: entry.date,
    };
  }
  return Object.fromEntries(Object.entries(normalized).sort(([left], [right]) => left.localeCompare(right)));
}

function formatJustifications(justifications, baseline) {
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

function selectFilesForCheck({ all, files, baseline, measured }) {
  if (all) {
    return [...new Set([...Object.keys(baseline), ...Object.keys(measured)])].sort();
  }
  return normalizeFileList(files);
}

export function writeBaselineFile(baselinePath, files, meta) {
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
} = {}) {
  const rawBaseline = await readJsonFile(baselinePath, { files: {}, total: 0, meta: null });
  const baseline = normalizeBaseline(rawBaseline);
  const baselineMeta = normalizeBaselineMeta(rawBaseline);
  const justifications = validateJustifications(await readJsonFile(justificationsPath, {}));
  const currentFingerprint = await resolveFingerprint();

  if (!fingerprintsMatch(baselineMeta, currentFingerprint)) {
    throw new BiomeToolchainError(
      `Mass baseline fingerprint mismatch: baseline was recorded under ${JSON.stringify(baselineMeta)}, but the current toolchain is ${JSON.stringify(
        currentFingerprint
      )}. Regenerate the baseline (scripts/quality-ratchet/regenerate-mass-baseline.mjs) before checking.`
    );
  }

  const measureInput = all ? { files: null } : { files: normalizeFileList(files) };
  const measuredResult = await measure(measureInput);
  const measured = sortMassObject(measuredResult.files ?? measuredResult);
  const checkedFiles = selectFilesForCheck({ all, files, baseline, measured });
  const nextBaseline = { ...baseline };
  const failures = [];
  const tightened = [];

  for (const file of checkedFiles) {
    const current = measured[file] ?? 0;
    const baselineMass = baseline[file] ?? 0;
    const justification = justifications[file];
    const allowed = justification ? Math.max(baselineMass, justification.allowed_mass) : baselineMass;

    if (current > allowed) {
      failures.push({ file, baseline: baselineMass, current, allowed, justified: Boolean(justification) });
      continue;
    }

    if (current < baselineMass) {
      if (current > 0) {
        nextBaseline[file] = current;
      } else {
        delete nextBaseline[file];
      }
      tightened.push({ file, before: baselineMass, after: current });
    }
  }

  if (tightened.length > 0 && writeBaseline) {
    await writeBaselineFile(baselinePath, nextBaseline, currentFingerprint);
  }

  return {
    ok: failures.length === 0,
    failures,
    tightened,
    checkedFiles,
    baseline,
    measured,
    justifications,
    messages: [
      ...formatJustifications(justifications, baseline),
      ...tightened.map(({ file, before, after }) => `TIGHTENED ${file}: baseline ${before} -> ${after}`),
    ],
  };
}

function parseCheckArgs(argv) {
  let all = false;
  const files = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--all") {
      all = true;
    } else if (arg === "--files") {
      while (argv[i + 1] && !argv[i + 1].startsWith("--")) {
        files.push(...splitFilesArgument(argv[i + 1]));
        i += 1;
      }
    } else if (arg.startsWith("--files=")) {
      files.push(...splitFilesArgument(arg.slice("--files=".length)));
    }
  }

  if (!all && files.length === 0) {
    throw new Error("Usage: check-mass-ratchet.mjs --all | --files a,b,c");
  }

  return { all, files };
}

function printResult(result) {
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

async function main() {
  const args = parseCheckArgs(process.argv.slice(2));
  const result = await runMassRatchet(args);
  printResult(result);
  if (!result.ok) {
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
