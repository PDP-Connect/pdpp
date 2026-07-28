// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export const EXECUTABLE_TEST_SUFFIX = /\.(?:test|spec)\.(?:js|mjs|cjs|ts|tsx|py|sh)$/;
export const EXECUTABLE_SMOKES = new Set(["packages/mcp-server/test/smoke-stdio.ts"]);
export const MANIFEST_SCHEMA = "pdpp.test-accounting/v3";
export const RECEIPT_SCHEMA = "pdpp.test-receipt/v3";
export const RUN_AUTHORITY_SCHEMA = "pdpp.test-run-authority/v1";
export const RUN_COMPLETION_SCHEMA = "pdpp.test-run-completion/v1";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function compareStrings(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}
const genericSkipReasons = new Set(["", "true", "unknown", "unspecified", "node-tap-no-reason"]);
const LEADING_DOT_SLASH_PATTERN = /^\.\//;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const RUN_ID_PATTERN = /^[a-f0-9-]{36}$/;
const SUITE_PROFILE_KEY_PATTERN = /^[^/]+\/[^/]+$/;

export interface Profile {
  id?: string;
  optional_predicate?: string;
  required?: boolean;
  skip_reasons?: Record<string, number>;
  zero_tests?: boolean;
}
export type ProfileEntry = string | Profile;
export interface Suite {
  authority_argument: string | null;
  command: string[] | null;
  cwd: string;
  environment?: Record<string, string>;
  execution?: string;
  id: string;
  include: string[];
  loader: string;
  profiles: ProfileEntry[];
  zero_tests?: boolean;
}
export interface Exclusion {
  expires: string;
  owner: string;
  path: string;
  profile: string;
  reason: string;
  suite: string;
}
export interface Manifest {
  exclusions?: Exclusion[];
  inventory_base_sha: string;
  schema: string;
  suites: Suite[];
}
export interface Counts {
  assertions: number;
  completed_files?: number;
  failed: number;
  passed: number;
  planned_files?: number;
  protocol_error?: string;
  skip_reasons: Record<string, number>;
  skipped: number;
  zero_test_declaration?: boolean;
}
export interface Receipt {
  argv: string[];
  authority_sha256: string;
  base_sha: string;
  binding_sha256?: string;
  completion_sha256: string;
  counts: Counts;
  cwd: string;
  ended_at: string;
  exit_code: number;
  expires_at: string;
  files: string[];
  head_sha: string;
  issued_at: string;
  manifest_sha256: string;
  nonce: string;
  profile: string;
  run_id: string;
  schema: string;
  selection_tree_sha256: string;
  signal: string | null;
  source_tree_sha256: string;
  started_at: string;
  suite: string;
  transcript: string;
  transcript_sha256: string;
}
interface RunAuthority {
  argv: string[];
  base_sha: string;
  cwd: string;
  expires_at: string;
  files: string[];
  head_sha: string;
  issued_at: string;
  manifest_sha256: string;
  nonce: string;
  profile: string;
  run_id: string;
  schema: string;
  selection_tree_sha256: string;
  source_tree_sha256: string;
  suite: string;
}
interface RunCompletion {
  nonce: string;
  observed: {
    exit_code: number;
    signal: string | null;
    transcript: string;
    transcript_sha256: string;
    counts: Counts;
    files: string[];
  };
  run_id: string;
  schema: string;
}

function fail(message: string): never {
  throw new Error(`test accounting: ${message}`);
}
function git(args: string[], cwd: string = process.cwd()): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
export function gitRoot(cwd: string = process.cwd()): string {
  return git(["rev-parse", "--show-toplevel"], cwd).trim();
}
export function gitHead(cwd: string = process.cwd()): string {
  return git(["rev-parse", "HEAD"], cwd).trim();
}
export function gitPath(path: string, cwd: string = process.cwd()): string {
  return resolve(cwd, git(["rev-parse", "--git-path", path], cwd).trim());
}
export function trackedFiles(cwd: string = process.cwd()): string[] {
  return git(["ls-files", "-z"], cwd).split("\0").filter(Boolean).map(normalizePath).sort();
}

export function normalizePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    fail("path must be a non-empty string");
  }
  const path = value.replaceAll("\\", "/").replace(LEADING_DOT_SLASH_PATTERN, "");
  if (path.startsWith("/") || path.split("/").includes("..")) {
    fail(`path must be repository-relative: ${value}`);
  }
  return path;
}

export function containedPath(
  root: string,
  path: string,
  { existing = false, label = "path" }: { existing?: boolean; label?: string } = {}
): string {
  const rootReal = realpathSync(root);
  const candidate = resolve(rootReal, normalizePath(path));
  if (candidate !== rootReal && !candidate.startsWith(`${rootReal}/`)) {
    fail(`${label} escapes repository: ${path}`);
  }
  if (!existing) {
    return candidate;
  }
  let target: string;
  try {
    target = realpathSync(candidate);
  } catch {
    fail(`${label} is missing: ${path}`);
  }
  if (target !== rootReal && !target.startsWith(`${rootReal}/`)) {
    fail(`${label} escapes repository: ${path}`);
  }
  return target;
}

export function stable(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stable).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
export function contentDigest(value: string | Buffer): string {
  return hash(value);
}
export function fileDigest(root: string, path: string): string {
  return hash(readFileSync(containedPath(root, path, { existing: true, label: "file" })));
}
export function treeDigest(root: string, head: string, files: Iterable<string>): string {
  return hash(
    stable({
      head,
      files: [...files]
        .map(normalizePath)
        .sort(compareStrings)
        .map((path) => [path, fileDigest(root, path)]),
    })
  );
}
export function sourceTreeDigest(root: string, head: string = gitHead(root)): string {
  const entries = git(["ls-tree", "-rz", "--full-tree", head], root).split("\0").filter(Boolean);
  return hash(stable({ head, entries }));
}
export function assertCleanSourceTree(root: string = gitRoot()): void {
  try {
    git(["diff", "--quiet", "HEAD", "--"], root);
  } catch {
    fail("worktree must be clean before accounting execution");
  }
  try {
    git(["diff", "--cached", "--quiet", "--"], root);
  } catch {
    fail("index must be clean before accounting execution");
  }
  const status = git(["status", "--porcelain=v1"], root).split("\n").filter(Boolean);
  if (status.length) {
    fail(`worktree has untracked or changed paths: ${status.join(", ")}`);
  }
}

const RECEIPT_BINDING_FIELDS = [
  "run_id",
  "nonce",
  "suite",
  "profile",
  "issued_at",
  "started_at",
  "ended_at",
  "expires_at",
  "base_sha",
  "head_sha",
  "source_tree_sha256",
  "selection_tree_sha256",
  "manifest_sha256",
  "cwd",
  "argv",
  "files",
  "transcript",
  "transcript_sha256",
  "exit_code",
  "signal",
  "counts",
  "authority_sha256",
  "completion_sha256",
] as const;
export function receiptBinding(receipt: Record<string, unknown> | Receipt): string {
  const record = receipt as Record<string, unknown>;
  return hash(stable(Object.fromEntries(RECEIPT_BINDING_FIELDS.map((field) => [field, record[field] ?? null]))));
}

export function classifyTrackedPath(path: string): {
  path: string;
  kind: "executable" | "helper-or-fixture" | "other";
} {
  const normalized = normalizePath(path);
  let kind: "executable" | "helper-or-fixture" | "other";
  if (EXECUTABLE_TEST_SUFFIX.test(normalized) || EXECUTABLE_SMOKES.has(normalized)) {
    kind = "executable";
  } else if (normalized.split("/").some((part) => part === "test" || part === "tests")) {
    kind = "helper-or-fixture";
  } else {
    kind = "other";
  }
  return { path: normalized, kind };
}
const GLOB_METACHARACTER_PATTERN = /[|\\{}()[\]^$+?.]/g;
function globToRegExp(glob: string): RegExp {
  let source = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") {
        index += 1;
        if (glob[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char?.replace(GLOB_METACHARACTER_PATTERN, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}
export function matchesGlob(path: string, glob: string): boolean {
  return globToRegExp(normalizePath(glob)).test(normalizePath(path));
}
function profileId(profile: ProfileEntry): string | undefined {
  return typeof profile === "string" ? profile : profile.id;
}
function validDate(date: string): boolean {
  if (!ISO_DATE_PATTERN.test(date)) {
    return false;
  }
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === date;
}
export function validInstant(value: unknown): value is string {
  return (
    typeof value === "string" && !Number.isNaN(new Date(value).valueOf()) && new Date(value).toISOString() === value
  );
}
function suiteProfiles(suite: Suite): (string | undefined)[] {
  const ids = suite.profiles.map(profileId);
  if (ids.some((id) => typeof id !== "string" || !id) || new Set(ids).size !== ids.length) {
    fail(`${suite.id} has invalid or duplicate profiles`);
  }
  return ids;
}
function zeroTestSuite(suite: Suite): boolean {
  return suite.zero_tests === true;
}
function validateSkipReasons(reasons: unknown, label: string): void {
  if (!reasons || typeof reasons !== "object" || Array.isArray(reasons)) {
    fail(`${label} skip_reasons must be an object`);
  }
  for (const [reason, count] of Object.entries(reasons as Record<string, unknown>)) {
    if (genericSkipReasons.has(reason.trim().toLowerCase()) || !Number.isInteger(count) || (count as number) < 0) {
      fail(`${label} has a generic or invalid skip reason: ${reason}`);
    }
  }
}
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this is the manifest schema validator's real invariant checklist (one fail-closed check per manifest field), carried over unchanged from the .mjs source; splitting it would spread a single reviewable contract across multiple functions.
export async function readManifest(
  manifestPath = "test-accounting.manifest.json",
  { root = process.cwd(), intendedBase }: { root?: string; intendedBase?: string | undefined } = {}
): Promise<Manifest> {
  const manifest: Manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.schema !== MANIFEST_SCHEMA) {
    fail(`unsupported manifest schema in ${manifestPath}`);
  }
  if (typeof manifest.inventory_base_sha !== "string" || !COMMIT_SHA_PATTERN.test(manifest.inventory_base_sha)) {
    fail("inventory_base_sha is required");
  }
  if (intendedBase && manifest.inventory_base_sha !== intendedBase) {
    fail(`inventory_base_sha does not match intended integration base ${intendedBase}`);
  }
  try {
    git(["rev-parse", "--verify", `${manifest.inventory_base_sha}^{commit}`], root);
  } catch {
    fail(`inventory_base_sha is not a commit: ${manifest.inventory_base_sha}`);
  }
  try {
    git(["merge-base", "--is-ancestor", manifest.inventory_base_sha, gitHead(root)], root);
  } catch {
    fail(`inventory_base_sha ${manifest.inventory_base_sha} is not an ancestor of the current integration SHA`);
  }
  if (!Array.isArray(manifest.suites) || manifest.suites.length === 0) {
    fail("manifest must declare suites");
  }
  const ids = new Set<string>();
  for (const suite of manifest.suites) {
    if (typeof suite.id !== "string" || !suite.id || ids.has(suite.id)) {
      fail(`invalid or duplicate suite id: ${suite.id}`);
    }
    ids.add(suite.id);
    suiteProfiles(suite);
    if (
      !Array.isArray(suite.include) ||
      (!zeroTestSuite(suite) && suite.include.length === 0) ||
      (zeroTestSuite(suite) && suite.include.length !== 0)
    ) {
      fail(`${suite.id} must declare the correct inventory plan`);
    }
    if (zeroTestSuite(suite)) {
      if (suite.execution !== "zero-test-declaration" || suite.command !== null) {
        fail(`${suite.id} zero-test declaration is malformed`);
      }
    } else if (
      !Array.isArray(suite.command) ||
      suite.command.length === 0 ||
      suite.command.some((part) => typeof part !== "string" || !part) ||
      suite.command[0] === "false"
    ) {
      fail(`${suite.id} must declare a real command`);
    }
    if (!["--authority", "--accounting-authority", null].includes(suite.authority_argument)) {
      fail(`${suite.id} must declare a supported authority argument`);
    }
    if (suite.execution === undefined) {
      suite.execution = suite.authority_argument ? "authority-runner" : "direct";
    }
    if (!["direct", "authority-runner", "zero-test-declaration"].includes(suite.execution)) {
      fail(`${suite.id} must declare a supported execution mode`);
    }
    if (
      zeroTestSuite(suite) &&
      !suite.profiles.every((entry) => typeof entry !== "string" && entry.zero_tests === true)
    ) {
      fail(`${suite.id} zero-test profiles must be declared`);
    }
    if (!zeroTestSuite(suite) && suite.execution === "direct" && suite.authority_argument !== null) {
      fail(`${suite.id} direct leaf must not call authority`);
    }
    if (typeof suite.cwd !== "string" || !suite.cwd || suite.cwd.startsWith("/") || suite.cwd.includes("..")) {
      fail(`${suite.id} must declare a repository-relative cwd`);
    }
    if (!["node-test", "python-unittest", "shell"].includes(suite.loader)) {
      fail(`${suite.id} must declare a supported loader`);
    }
    for (const entry of suite.profiles) {
      validateSkipReasons(
        typeof entry === "string" ? {} : (entry.skip_reasons ?? {}),
        `${suite.id}/${profileId(entry)}`
      );
    }
  }
  return manifest;
}
function selectedSuites(manifest: Manifest, ids: string[]): Suite[] {
  if (ids.length === 0 || ids.includes("all")) {
    return manifest.suites;
  }
  const wanted = new Set(ids);
  const suites = manifest.suites.filter((suite) => wanted.has(suite.id));
  if (suites.length !== wanted.size) {
    fail(`unknown suite: ${[...wanted].find((id) => !suites.some((suite) => suite.id === id))}`);
  }
  return suites;
}
function exclusionsFor(manifest: Manifest, path: string): Exclusion[] {
  return (manifest.exclusions ?? []).filter((entry) => entry.path === path);
}
function validateExclusions(manifest: Manifest, tracked: Set<string>): void {
  const paths = new Set<string>();
  for (const exclusion of manifest.exclusions ?? []) {
    for (const key of ["path", "reason", "owner", "suite", "profile", "expires"] as const) {
      if (typeof exclusion[key] !== "string" || !exclusion[key]) {
        fail(`exclusion requires ${key}`);
      }
    }
    exclusion.path = normalizePath(exclusion.path);
    if (paths.has(exclusion.path)) {
      fail(`duplicate exclusion: ${exclusion.path}`);
    }
    paths.add(exclusion.path);
    if (!validDate(exclusion.expires)) {
      fail(`exclusion expiry is malformed: ${exclusion.path}`);
    }
    if (new Date(`${exclusion.expires}T00:00:00.000Z`) < new Date()) {
      fail(`exclusion expired: ${exclusion.path}`);
    }
    const suite = manifest.suites.find((entry) => entry.id === exclusion.suite);
    if (!(suite && suiteProfiles(suite).includes(exclusion.profile))) {
      fail(`exclusion has unknown suite/profile: ${exclusion.path}`);
    }
    if (!tracked.has(exclusion.path)) {
      fail(`exclusion is not tracked: ${exclusion.path}`);
    }
  }
}
export function validateIncludeGlobsClassifyExecutable(
  manifest: Manifest,
  files: string[],
  suiteIds: string[] = []
): void {
  for (const suite of selectedSuites(manifest, suiteIds)) {
    if (zeroTestSuite(suite)) {
      continue;
    }
    const suiteMatches = files.filter((path) => suite.include.some((glob) => matchesGlob(path, glob)));
    if (suiteMatches.length === 0) {
      fail(`${suite.id} include list matches no tracked file: ${suite.include.join(", ")}`);
    }
    for (const glob of suite.include) {
      for (const path of files.filter((entry) => matchesGlob(entry, glob))) {
        if (classifyTrackedPath(path).kind !== "executable") {
          fail(`${suite.id} include glob matches a non-executable-classified file: ${path} (glob: ${glob})`);
        }
      }
    }
  }
}
// Builds per-suite plans without failing on a suite whose plan comes up
// empty. `planFor` (below) is the fail-closed production entry point most
// callers want; this tolerant variant exists only so a global,
// whole-manifest computation (e.g. "is every executable file owned by some
// suite") can run without being derailed by an unrelated, already-known,
// separately-reported empty suite — mirroring the scoping rationale
// `verifyReceipts` already applies to its own plan check (see
// `965708787`: planning every manifest suite unconditionally made a
// single-suite run fail closed on a stale, unrelated suite it never
// selected).
function tolerantPlanFor(manifest: Manifest, files: string[], suiteIds: string[] = []) {
  const suites = selectedSuites(manifest, suiteIds);
  const executable = files.filter((path) => classifyTrackedPath(path).kind === "executable");
  const plans = new Map<string, string[]>();
  const owners = new Map<string, string>();
  for (const suite of suites) {
    if (zeroTestSuite(suite)) {
      plans.set(suite.id, []);
      continue;
    }
    const plan = executable
      .filter(
        (path) => suite.include.some((glob) => matchesGlob(path, glob)) && exclusionsFor(manifest, path).length === 0
      )
      .sort(compareStrings);
    plans.set(suite.id, plan);
    for (const path of plan) {
      if (owners.has(path)) {
        fail(`${path} is planned by both ${owners.get(path)} and ${suite.id}`);
      }
      owners.set(path, suite.id);
    }
  }
  return { executable, owners, plans, suites };
}
export function planFor(manifest: Manifest, files: string[], suiteIds: string[] = []) {
  const result = tolerantPlanFor(manifest, files, suiteIds);
  for (const suite of result.suites) {
    if (!(zeroTestSuite(suite) || result.plans.get(suite.id)?.length)) {
      fail(`${suite.id} selects no executable tests`);
    }
  }
  return result;
}
// Fails closed if any executable-classified, non-excluded file is not owned
// by ANY suite anywhere in the manifest — the defect class a suite-local
// check cannot see, because a file that silently drops out of every glob it
// used to match (e.g. renamed off its suite's expected extension while a
// sibling glob keeps that suite's own plan non-empty) never shows up as
// that suite "selecting no executable tests". This computation is
// necessarily whole-manifest (ownership is a global property), but it never
// throws on an unrelated suite's empty plan — only `suiteIds`' own empty
// plans are enforced, via `planFor`, by the caller.
export function unaccountedExecutableTests(manifest: Manifest, files: string[]): string[] {
  const { executable, owners } = tolerantPlanFor(manifest, files, []);
  return executable.filter((path) => !owners.has(path) && exclusionsFor(manifest, path).length === 0);
}
export function selectedRuns(
  manifest: Manifest,
  files: string[],
  { suites = [], profile }: { suites?: string[]; profile?: string | undefined } = {}
) {
  const plan = planFor(manifest, files, suites);
  const runs: { suite: Suite; profile: ProfileEntry; files: string[] }[] = [];
  for (const suite of plan.suites) {
    for (const entry of suite.profiles) {
      const id = profileId(entry);
      if (!profile || id === profile) {
        runs.push({ suite, profile: entry, files: plan.plans.get(suite.id) ?? [] });
      }
    }
  }
  if (profile && runs.length === 0) {
    fail(`unknown selected profile: ${profile}`);
  }
  return { ...plan, runs };
}
export function checkInventory(
  manifest: Manifest,
  files: string[],
  suiteIds: string[] = [],
  options: { failOnUnknown?: boolean; failOnEmpty?: boolean } = {}
) {
  validateExclusions(manifest, new Set(files));
  validateIncludeGlobsClassifyExecutable(manifest, files);
  const { executable, owners, plans, suites } = planFor(manifest, files, suiteIds);
  for (const path of executable) {
    const ownership = (owners.has(path) ? 1 : 0) + exclusionsFor(manifest, path).length;
    if (ownership > 1) {
      fail(`${path} has multiple accounting owners`);
    }
  }
  const unknown = executable.filter((path) => !owners.has(path) && exclusionsFor(manifest, path).length === 0);
  if ((suiteIds.length === 0 || suiteIds.includes("all") || options.failOnUnknown) && unknown.length) {
    fail(`unaccounted executable tests: ${unknown.join(", ")}`);
  }
  if (options.failOnEmpty && suites.some((suite) => !(zeroTestSuite(suite) || plans.get(suite.id)?.length))) {
    fail("a suite selected no executable tests");
  }
  return {
    executable,
    helpers: files.filter((path) => classifyTrackedPath(path).kind === "helper-or-fixture"),
    plans: Object.fromEntries(plans),
    suites: suites.map((suite) => suite.id),
    unaccounted: unknown,
  };
}
function sortedUnique(paths: unknown, label: string): string[] {
  if (!Array.isArray(paths)) {
    fail(`${label} must be a path array`);
  }
  const normalized = paths.map(normalizePath);
  if (stable(normalized) !== stable([...normalized].sort()) || new Set(normalized).size !== normalized.length) {
    fail(`${label} must be sorted and unique`);
  }
  return normalized;
}
function findProfile(suite: Suite, id: string): Profile | undefined {
  const found = suite.profiles.find((entry) => profileId(entry) === id);
  return typeof found === "string" ? { id: found } : found;
}
function authorityContained(directory: string, path: string, label: string): string {
  const directoryReal = realpathSync(directory);
  const candidate = resolve(directoryReal, normalizePath(path));
  if (candidate !== directoryReal && !candidate.startsWith(`${directoryReal}/`)) {
    fail(`${label} is outside its authority directory`);
  }
  let target: string;
  try {
    target = realpathSync(candidate);
  } catch {
    fail(`${label} is missing: ${path}`);
  }
  if (target !== directoryReal && !target.startsWith(`${directoryReal}/`)) {
    fail(`${label} is outside its authority directory`);
  }
  return target;
}
function readAuthorityRecord(_root: string, directory: string, runId: string, suffix: "authority" | "completion") {
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
    fail("run_id is invalid");
  }
  const path = authorityContained(directory, `${runId}.${suffix}.json`, `authority ${suffix}`);
  return { path, value: JSON.parse(readFileSync(path, "utf8")) as RunAuthority | RunCompletion };
}
function verifyTranscript(receipt: Receipt, _root: string, authorityDirectory: string): void {
  const transcriptPath = authorityContained(authorityDirectory, receipt.transcript, "transcript");
  const body = readFileSync(transcriptPath);
  if (hash(body) !== receipt.transcript_sha256) {
    fail(`${receipt.suite} transcript digest does not match`);
  }
  const lines = body.toString("utf8").split("\n").filter(Boolean);
  let first: { event?: string; run_id?: string };
  let last: { event?: string; run_id?: string; exit_code?: number; signal?: string | null };
  try {
    first = JSON.parse(lines[0] ?? "");
    last = JSON.parse(lines.at(-1) ?? "");
  } catch {
    fail(`${receipt.suite} transcript envelope is malformed`);
  }
  if (
    first.event !== "start" ||
    last.event !== "end" ||
    first.run_id !== receipt.run_id ||
    last.run_id !== receipt.run_id ||
    last.exit_code !== receipt.exit_code ||
    last.signal !== receipt.signal
  ) {
    fail(`${receipt.suite} transcript does not bind the receipt`);
  }
}
function assertCounts(counts: Counts, key: string): void {
  if (!counts || typeof counts !== "object") {
    fail(`${key} has no structured counts`);
  }
  if (counts.zero_test_declaration === true) {
    if (
      counts.assertions !== 0 ||
      counts.passed !== 0 ||
      counts.failed !== 0 ||
      counts.skipped !== 0 ||
      counts.planned_files !== 0 ||
      counts.completed_files !== 0 ||
      Object.keys(counts.skip_reasons).length !== 0
    ) {
      fail(`${key} zero-test declaration has observed tests`);
    }
    return;
  }
  for (const field of ["assertions", "passed", "failed", "skipped", "planned_files", "completed_files"] as const) {
    if (!Number.isInteger(counts[field]) || (counts[field] as number) < 0) {
      fail(`${key} has invalid ${field}`);
    }
  }
  if (counts.assertions === 0 || counts.assertions !== counts.passed + counts.failed + counts.skipped) {
    fail(`${key} has incomplete structured assertion counts`);
  }
  validateSkipReasons(counts.skip_reasons, key);
  if (counts.skipped !== Object.values(counts.skip_reasons).reduce((sum, count) => sum + count, 0)) {
    fail(`${key} skip count does not match skip reasons`);
  }
}
async function consumeRun(_root: string, authorityDirectory: string, receipt: Receipt): Promise<void> {
  const ledger = resolve(authorityDirectory, "verified");
  const target = resolve(ledger, `${receipt.run_id}.json`);
  await mkdir(ledger, { recursive: true });
  try {
    const fd = await open(target, "wx");
    await fd.writeFile(
      `${JSON.stringify({ run_id: receipt.run_id, nonce: receipt.nonce, verified_at: new Date().toISOString() })}\n`
    );
    await fd.close();
  } catch {
    fail(`${receipt.suite}/${receipt.profile} receipt was already verified or replayed`);
  }
}
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this is the receipt-verification invariant chain (schema, nonce, timing, plan, tree, binding, counts, skip-baseline — each check independently fails closed), carried over unchanged from the .mjs source; splitting it would obscure the single audited security boundary.
export async function verifyReceipts(
  manifest: Manifest,
  files: string[],
  receipts: Receipt[],
  {
    head = gitHead(),
    root = gitRoot(),
    authorityDirectory,
    now = new Date(),
    consume = true,
    sourceTree = sourceTreeDigest(root, head),
    requiredKeys,
  }: {
    head?: string;
    root?: string;
    authorityDirectory: string;
    now?: Date;
    consume?: boolean;
    sourceTree?: string;
    requiredKeys?: string[];
  }
) {
  if (!(authorityDirectory && existsSync(authorityDirectory))) {
    fail("verifier-issued authority directory is required");
  }
  // Plans are only computed for the suites these receipts actually claim
  // (plus any suite named in requiredKeys, so a missing-receipt check below
  // can still report it by id). Planning every manifest suite here would
  // reject a suite-scoped run over an unrelated suite's stale, empty-matching
  // include glob, even though that suite was never selected or run.
  const receiptSuiteIds = new Set(receipts.map((receipt) => receipt.suite));
  for (const key of requiredKeys ?? []) {
    const [suiteId] = key.split("/");
    if (suiteId) {
      receiptSuiteIds.add(suiteId);
    }
  }
  const { plans } = planFor(manifest, files, [...receiptSuiteIds]);
  const suites = new Map(manifest.suites.map((suite) => [suite.id, suite]));
  const seen = new Set<string>();
  const manifestHash = fileDigest(root, "test-accounting.manifest.json");
  const base = manifest.inventory_base_sha;
  const verified: Receipt[] = [];
  for (const receipt of receipts) {
    if (receipt.schema !== RECEIPT_SCHEMA || typeof receipt.run_id !== "string" || typeof receipt.nonce !== "string") {
      fail("receipt schema, run_id, or nonce is invalid");
    }
    const key = `${receipt.suite}/${receipt.profile}`;
    if (seen.has(key)) {
      fail(`duplicate receipt for ${key}`);
    }
    seen.add(key);
    const suite = suites.get(receipt.suite);
    if (!suite) {
      fail(`receipt has unknown suite: ${receipt.suite}`);
    }
    const selected = findProfile(suite, receipt.profile);
    if (!selected) {
      fail(`receipt profile is undeclared: ${key}`);
    }
    const authority = readAuthorityRecord(root, authorityDirectory, receipt.run_id, "authority");
    const completion = readAuthorityRecord(root, authorityDirectory, receipt.run_id, "completion");
    if (authority.value.schema !== RUN_AUTHORITY_SCHEMA || completion.value.schema !== RUN_COMPLETION_SCHEMA) {
      fail(`${key} authority records have invalid schemas`);
    }
    if (
      receipt.authority_sha256 !== hash(readFileSync(authority.path)) ||
      receipt.completion_sha256 !== hash(readFileSync(completion.path))
    ) {
      fail(`${key} authority provenance changed`);
    }
    const issued = authority.value as RunAuthority;
    const completionValue = completion.value as RunCompletion;
    if (
      issued.nonce !== receipt.nonce ||
      completionValue.nonce !== receipt.nonce ||
      completionValue.run_id !== receipt.run_id
    ) {
      fail(`${key} authority nonce does not bind receipt`);
    }
    if (
      !(
        validInstant(receipt.issued_at) &&
        validInstant(receipt.started_at) &&
        validInstant(receipt.ended_at) &&
        validInstant(receipt.expires_at)
      ) ||
      receipt.started_at > receipt.ended_at ||
      receipt.ended_at > receipt.expires_at ||
      new Date(receipt.expires_at) < now
    ) {
      fail(`${key} receipt is expired or has invalid times`);
    }
    if (
      stable({
        suite: receipt.suite,
        profile: receipt.profile,
        files: receipt.files,
        cwd: receipt.cwd,
        argv: receipt.argv,
        base_sha: receipt.base_sha,
        head_sha: receipt.head_sha,
        source_tree_sha256: receipt.source_tree_sha256,
        selection_tree_sha256: receipt.selection_tree_sha256,
        manifest_sha256: receipt.manifest_sha256,
        issued_at: receipt.issued_at,
        expires_at: receipt.expires_at,
      }) !==
      stable({
        suite: issued.suite,
        profile: issued.profile,
        files: issued.files,
        cwd: issued.cwd,
        argv: issued.argv,
        base_sha: issued.base_sha,
        head_sha: issued.head_sha,
        source_tree_sha256: issued.source_tree_sha256,
        selection_tree_sha256: issued.selection_tree_sha256,
        manifest_sha256: issued.manifest_sha256,
        issued_at: issued.issued_at,
        expires_at: issued.expires_at,
      })
    ) {
      fail(`${key} receipt does not match issued authority`);
    }
    if (
      receipt.base_sha !== base ||
      receipt.head_sha !== head ||
      receipt.manifest_sha256 !== manifestHash ||
      receipt.source_tree_sha256 !== sourceTree
    ) {
      fail(`${key} has stale base, SHA, tree, or manifest`);
    }
    const planned = plans.get(suite.id) ?? [];
    const paths = sortedUnique(receipt.files, `${key} files`);
    if (stable(paths) !== stable(planned)) {
      fail(`${key} files do not match its plan`);
    }
    if (receipt.selection_tree_sha256 !== treeDigest(root, head, planned)) {
      fail(`${key} selected test tree changed`);
    }
    if (receipt.binding_sha256 !== receiptBinding(receipt)) {
      fail(`${key} receipt binding is invalid`);
    }
    verifyTranscript(receipt, root, authorityDirectory);
    if (
      stable(completionValue.observed) !==
      stable({
        exit_code: receipt.exit_code,
        signal: receipt.signal,
        transcript: receipt.transcript,
        transcript_sha256: receipt.transcript_sha256,
        counts: receipt.counts,
        files: receipt.files,
      })
    ) {
      fail(`${key} completion does not bind observed child result`);
    }
    if (!Number.isInteger(receipt.exit_code) || receipt.exit_code !== 0 || receipt.signal !== null) {
      fail(`${key} did not pass`);
    }
    assertCounts(receipt.counts, key);
    const expectedSkips = selected.skip_reasons ?? {};
    if (stable(receipt.counts.skip_reasons) !== stable(expectedSkips)) {
      fail(`${key} skips do not exactly match the profile baseline`);
    }
    if (selected.zero_tests === true) {
      if (receipt.files.length !== 0 || receipt.counts.zero_test_declaration !== true) {
        fail(`${key} zero-test declaration is not exact`);
      }
    } else if (receipt.counts.planned_files !== planned.length || receipt.counts.completed_files !== planned.length) {
      fail(`${key} child selection was not completely observed`);
    }
    verified.push(receipt);
  }
  const required =
    requiredKeys ??
    manifest.suites.flatMap((suite) =>
      suite.profiles
        .filter((entry) => typeof entry !== "string" && entry.required !== false)
        .map((entry) => `${suite.id}/${profileId(entry)}`)
    );
  if (
    !Array.isArray(required) ||
    new Set(required).size !== required.length ||
    required.some((key) => !SUITE_PROFILE_KEY_PATTERN.test(key))
  ) {
    fail("required receipt selection is invalid");
  }
  const missing = required.filter((key) => !seen.has(key));
  if (missing.length) {
    fail(`missing required receipts: ${missing.join(", ")}`);
  }
  if (consume) {
    await Promise.all(verified.map((receipt) => consumeRun(root, authorityDirectory, receipt)));
  }
  return { verified: [...seen].sort(), required };
}

interface InventoryArgs {
  base?: string;
  failOnEmpty: boolean;
  failOnUnknown: boolean;
  json?: string;
  manifest?: string;
  mode?: string;
  profile?: string;
  receipts: string[];
  sha?: string;
  suites: string[];
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: exhaustive CLI-flag parser (one branch per --flag), carried over unchanged from the .mjs source.
export function parseInventoryArgs(argv: string[]): InventoryArgs {
  const result: InventoryArgs = { suites: [], receipts: [], failOnEmpty: false, failOnUnknown: false };
  const take = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail(`${flag} requires exactly one value`);
    }
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check" || arg === "--plan" || arg === "--verify") {
      if (result.mode) {
        fail("choose exactly one mode");
      }
      result.mode = arg.slice(2);
    } else if (arg === "--suite") {
      result.suites.push(take(index, arg));
      index += 1;
    } else if (arg === "--manifest") {
      result.manifest = take(index, arg);
      index += 1;
    } else if (arg === "--json") {
      result.json = take(index, arg);
      index += 1;
    } else if (arg === "--receipt") {
      result.receipts.push(take(index, arg));
      index += 1;
    } else if (arg === "--fail-on-empty") {
      result.failOnEmpty = true;
    } else if (arg === "--fail-on-unaccounted") {
      result.failOnUnknown = true;
    } else if (arg === "--sha") {
      result.sha = take(index, arg);
      index += 1;
    } else if (arg === "--base") {
      result.base = take(index, arg);
      index += 1;
    } else if (arg === "--profile") {
      result.profile = take(index, arg);
      index += 1;
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  if (!result.mode) {
    fail("choose exactly one of --check, --plan, or --verify");
  }
  if (
    new Set(result.suites).size !== result.suites.length ||
    (result.suites.includes("all") && result.suites.length !== 1)
  ) {
    fail("suite selection must be unique and cannot combine all with other suites");
  }
  return result;
}
async function main() {
  const args = parseInventoryArgs(process.argv.slice(2));
  const root = gitRoot();
  const head = gitHead(root);
  if (args.sha && args.sha !== head) {
    fail(`requested SHA ${args.sha} does not match ${head}`);
  }
  const manifest = await readManifest(resolve(root, args.manifest ?? "test-accounting.manifest.json"), {
    root,
    intendedBase: args.base,
  });
  try {
    git(["merge-base", "--is-ancestor", manifest.inventory_base_sha, head], root);
  } catch {
    fail(`inventory_base_sha ${manifest.inventory_base_sha} is not an ancestor of ${head}`);
  }
  const files = trackedFiles(root);
  assertCleanSourceTree(root);
  if (args.mode === "verify") {
    if (!args.receipts.length) {
      fail("--verify needs at least one --receipt");
    }
    const directory = resolve(gitPath("test-accounting", root), "runs");
    const receipts: Receipt[] = await Promise.all(
      args.receipts.map(async (path) =>
        JSON.parse(await readFile(authorityContained(directory, path, "receipt"), "utf8"))
      )
    );
    process.stdout.write(
      `${JSON.stringify(await verifyReceipts(manifest, files, receipts, { head, root, authorityDirectory: directory }))}\n`
    );
    return;
  }
  const outcome = checkInventory(manifest, files, args.suites, args);
  const selected = selectedRuns(manifest, files, { suites: args.suites, profile: args.profile });
  const value = {
    ...outcome,
    runs: selected.runs.map((run) => ({ suite: run.suite.id, profile: profileId(run.profile), files: run.files })),
  };
  if (args.json) {
    await writeFile(containedPath(root, args.json, { label: "plan output" }), `${JSON.stringify(value, null, 2)}\n`);
  }
  const planned = Object.values(outcome.plans).reduce((sum, plan) => sum + plan.length, 0);
  process.stdout.write(
    `test accounting: ${outcome.executable.length} executable, ${outcome.helpers.length} helpers, ${planned} planned, ${outcome.executable.length - planned} excluded\n`
  );
}
if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
