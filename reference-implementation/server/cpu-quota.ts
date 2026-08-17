// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Effective CPU and memory quota for THIS process, honoring cgroup limits
 * when set. `os.availableParallelism()`/`os.totalmem()` report the HOST's
 * topology and do not consult cgroup limits — inside a `--cpus=1
 * --memory=512m` container on a 24-core/124GB host they still report the
 * host's full numbers (verified locally: `docker run --rm --cpus=1
 * node:24-slim node -e "console.log(require('node:os').availableParallelism())"`
 * prints `24`, not `1`).
 *
 * Fly.io's own CPU-limit mechanism (`fly.io/docs/machines/cpu-performance/`)
 * enforces a `cpu.cfs_quota_us`-style quota (5ms per 80ms period for a
 * `shared, cpus=1` machine — 6.25% of one core, not the full-period "1.0
 * core" quota this module's CPU probe would compute if it read a value of
 * "80000 80000"), and — because Fly Machines are Firecracker microVMs — it
 * is UNCONFIRMED from this environment whether that quota is exposed inside
 * the guest's own cgroup filesystem at all, or enforced only on the
 * host-side cgroup wrapping the VMM process. See the accompanying report
 * for the exact residual: this needs a live `fly ssh console` check, which
 * this environment cannot perform.
 *
 * NESTED CGROUP RESOLUTION (the correctness-critical part of this module):
 * a process's cgroup is almost never the mount root. `/proc/self/cgroup`
 * on THIS development sandbox reads
 * `0::/user.slice/user-1000.slice/user@1000.service/app.slice/<scope>.scope`
 * — five levels below `/sys/fs/cgroup` — and that leaf's own
 * `cgroup.controllers` file lists only `memory pids` (no `cpu`): the `cpu`
 * controller is enabled at `app.slice`, one level up, not delegated all the
 * way down to the leaf (verified directly on this host: the leaf has no
 * `cpu.max` file at all; `app.slice`'s does). A systemd/Kubernetes/
 * container-runtime deployment can equally set a REAL quota at any level of
 * this hierarchy, deeper than the mount root. A reader that only ever
 * checks `/sys/fs/cgroup/cpu.max` (the mount root) — the reader this module
 * shipped with before this revision — silently misses any quota set at a
 * nested level, reading the root's "no limit configured there" as "no
 * limit for this process," which over-admits concurrency exactly on the
 * deployment shapes (systemd slices, Kubernetes pods, most container
 * runtimes) where a limit is most likely to actually be set.
 *
 * The correct resolution walks:
 *   1. Parse `/proc/self/mountinfo` (minimal correct parser, not a
 *      hardcoded path list) to find where cgroup2 is mounted, and where
 *      each cgroup v1 controller is mounted.
 *   2. Parse `/proc/self/cgroup` to find this process's own relative path
 *      within each hierarchy (v2: hierarchy id 0; v1: per named
 *      controller).
 *   3. Join mount-point + relative-path to get this process's actual leaf
 *      cgroup directory (not the mount root).
 *   4. Walk from that leaf UP toward (and including) the mount point,
 *      reading the quota from EVERY ancestor that has the quota file, and
 *      returning the TIGHTEST (minimum) numeric value found among them.
 *
 * That fourth step is NOT "nearest ancestor wins" — an earlier version of
 * this module made that mistake, and it is a real, confirmed-against-the-
 * kernel-source correctness defect, not a simplification: `cgroup.
 * subtree_control` delegation controls WHICH levels have a quota file at
 * all, but nothing in the kernel interface prevents a nearer ancestor's own
 * file from stating a numerically LOOSER value than a farther one (a
 * systemd slice tightened after its child scope was already configured, a
 * Kubernetes namespace-level ResourceQuota layered above a looser per-pod
 * limit, or simply an administrator retightening a parent without touching
 * every already-running child). What the kernel actually enforces is the
 * MINIMUM across the whole ancestor chain (`docs.kernel.org/scheduler/
 * sched-bwc.html`; `Documentation/admin-guide/cgroup-v2.rst`: "Resources
 * are distributed top-down and a cgroup can further distribute a resource
 * only if the resource has been distributed to it from the parent") —
 * reading only the nearest file can silently report a looser number than
 * what the kernel will actually grant. Live-reproduced on this host via a
 * real (unprivileged) nested systemd cgroup: a child scope's own `cpu.max`
 * declared 4.0 cores while its parent slice declared 0.1 cores, and a
 * 3-second busy loop inside the child completed ~67 iterations —
 * consistent with the parent's 0.1-core enforcement, not the child's
 * declared 4.0. `"unlimited"` (`"max"` / v1's `-1` sentinel) at any single
 * level does NOT participate in the minimum — it means "this level imposes
 * no additional constraint," not "0" or "ignore the whole chain"; if every
 * ancestor that has the file reads `"unlimited"`, the aggregate result is
 * `"unlimited"`. A level with no file at all (controller not delegated
 * there) is simply skipped, exactly as before.
 *
 * Every step fails closed to `"unknown"` (never silently falls through to
 * "no quota") on: a malformed/unparseable mountinfo or cgroup line, a
 * relative path containing `..` (path traversal — refused outright, never
 * resolved), MORE THAN ONE DISTINCT mount point surviving for a given
 * hierarchy/controller (`resolveSingleMountPoint`: mountinfo's own line
 * order is not proof that either the first or the last entry corresponds
 * to this process — `parseCgroupMounts` records every distinct mount point
 * seen, and picking one without evidence would be exactly the same class
 * of unproven guess as the mount-root-only and nearest-ancestor-wins
 * mistakes this module has already had to close; identical duplicate mount
 * strings are deduplicated first and are not treated as ambiguous), or no
 * matching mount found at all while `/proc/self/cgroup` claims one exists.
 * `"unknown"` is a THIRD state distinct from "no quota" (`"unlimited"`) and
 * "quota N" (`"known"`) — see `effectiveCpuCount`/`effectiveMemoryBudgetBytes`
 * for how callers must treat it (the safe floor, not the host's full
 * capacity). Only a platform with no cgroup filesystem mounted at all (bare
 * metal, most non-Linux dev machines) is treated as genuinely unconstrained.
 *
 * MOUNTINFO "ROOT" FIELD: field 4 (`man 5 proc`) is the subtree of the
 * underlying filesystem a mount exposes, distinct from field 5 ("mount
 * point"). `parseMountinfoLine` reads it explicitly and REJECTS any mount
 * whose root isn't `/` (an ordinary top-level cgroup2/cgroup mount always
 * has root `/`; every environment this module has actually been checked
 * against does). A bind-mounted cgroup SUBTREE (root != `/`) means
 * `/proc/self/cgroup`'s hierarchy-root-relative path is not directly
 * joinable against the mount point without double-counting the
 * bind-mounted prefix, so that mount is treated as if it doesn't exist —
 * the process's cgroup membership then has no matching mount, which
 * resolves to `"unknown"` through the same path an absent mount already
 * takes. This was previously an unverified, merely-traced residual (relying
 * on every read in the ancestor walk incidentally throwing rather than an
 * explicit check); it is now a deliberate, tested check, not an accident of
 * the surrounding code's failure mode.
 *
 * KNOWN, UNDOCUMENTED-UNTIL-NOW RESIDUAL (could not be reproduced without
 * elevated privilege in this sandbox — verify live before relying on this
 * module in a target deployment that uses cgroup namespaces): cgroup
 * NAMESPACES (`man 7 cgroup_namespaces`) change what path
 * `/proc/self/cgroup` reports (relative to the namespace's own root, not
 * the true hierarchy root) independently of mountinfo's root field, which
 * can itself show `/` after a namespace-aware remount. That combination
 * could in principle resolve to a directory that EXISTS on disk but belongs
 * to an unrelated cgroup — a wrong-but-plausible `"known"` answer rather
 * than a safe `"unknown"` fallback. Not reproducible in this sandbox
 * (unprivileged `unshare -C` refused: uid_map write not permitted).
 */

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Injectable seam for tests; real callers use the module-level defaults below. */
export interface CpuQuotaProbe {
  readonly availableParallelism: () => number;
  readonly cgroupMounted: () => boolean;
  readonly platform: NodeJS.Platform;
  readonly readFile: (path: string) => string;
  readonly totalMemoryBytes: () => number;
}

const REAL_PROBE: CpuQuotaProbe = {
  availableParallelism: () => os.availableParallelism(),
  cgroupMounted: () => {
    try {
      readFileSync("/sys/fs/cgroup/cgroup.controllers", "utf8");
      return true;
    } catch {
      try {
        readFileSync("/proc/self/cgroup", "utf8");
        return true;
      } catch {
        return false;
      }
    }
  },
  platform: process.platform,
  readFile: (filePath: string) => readFileSync(filePath, "utf8"),
  totalMemoryBytes: () => os.totalmem(),
};

const WHITESPACE_PATTERN = /\s+/;

/** A resolved quota, or the two distinct reasons a quota could not be resolved. */
export type QuotaResult =
  | { readonly state: "known"; readonly value: number }
  | { readonly state: "unlimited" }
  | { readonly state: "unknown" };

// ─── /proc mount-string unescaping ─────────────────────────────────────────
// The kernel's mountinfo/cgroup seq_show writers octal-escape space, tab,
// newline, and backslash in path fields (man 5 proc, "mountinfo"). A mount
// point or cgroup path containing one of those bytes would otherwise be
// misparsed as a field boundary.
const PROC_OCTAL_ESCAPE_PATTERN = /\\([0-7]{3})/g;

function unescapeProcOctal(value: string): string {
  return value.replace(PROC_OCTAL_ESCAPE_PATTERN, (_match, digits: string) =>
    String.fromCharCode(Number.parseInt(digits, 8))
  );
}

// ─── /proc/self/mountinfo parsing ──────────────────────────────────────────
// Format (man 5 proc): fixed fields 1-6, then a variable-length
// optional-fields run, then a literal "-" separator, then fixed fields for
// fs-type/mount-source/super-options. Splitting on whitespace alone is NOT
// sound because the optional-fields section can be empty or contain several
// tokens — the "-" is the only reliable anchor, so this locates it
// explicitly rather than assuming a fixed field count.
interface MountEntry {
  readonly fsType: string;
  readonly mountPoint: string;
  readonly superOptions: string;
}

function parseMountinfoLine(line: string): MountEntry | null {
  const fields = line.trim().split(WHITESPACE_PATTERN);
  // Fields 1-5 are mount-ID, parent-ID, major:minor, root, mount-point.
  // Anything shorter is unparseable.
  if (fields.length < 5) {
    return null;
  }
  const separatorIndex = fields.indexOf("-");
  // Need at least 3 fields after the separator: fs-type, mount-source,
  // super-options.
  if (separatorIndex === -1 || fields.length < separatorIndex + 4) {
    return null;
  }
  const [, , , rootRaw, mountPointRaw] = fields;
  const fsType = fields[separatorIndex + 1];
  const superOptions = fields[separatorIndex + 3];
  if (!(rootRaw && mountPointRaw && fsType && superOptions)) {
    return null;
  }
  // Field 4 ("root", man 5 proc): the subtree of the underlying filesystem
  // this mount exposes, distinct from field 5 ("mount point"). An ordinary
  // top-level cgroup2/cgroup mount has root "/" -- every environment this
  // module has actually been checked against. A bind-mounted cgroup
  // SUBTREE (root != "/") means /proc/self/cgroup's hierarchy-root-relative
  // path is NOT directly joinable against this mount point (joining them
  // would double-count the bind-mounted prefix and resolve to a path this
  // module cannot prove corresponds to the process's real cgroup) -- reject
  // this mount outright rather than trust an unverified join. This
  // propagates to the same "no matching mount found for this process's
  // cgroup membership" -> {state: "unknown"} path that already exists for
  // a genuinely absent mount, not a new failure mode.
  if (unescapeProcOctal(rootRaw) !== "/") {
    return null;
  }
  return {
    fsType,
    mountPoint: unescapeProcOctal(mountPointRaw),
    superOptions,
  };
}

/**
 * Every DISTINCT mount point seen for a given hierarchy/controller, not
 * just the first or last. A process's mount namespace has exactly one
 * legitimate cgroup2 mount and one legitimate per-controller v1 mount under
 * ordinary conditions; more than one DISTINCT mount point for the same
 * hierarchy is an ambiguous mapping this module cannot soundly resolve
 * (mountinfo's own line order is not proof the first — or last — entry is
 * the one that actually applies to this process; nothing in `proc(5)`
 * documents an ordering guarantee this module could rely on). Duplicate
 * IDENTICAL mount-point strings collapse to one entry (the same real mount
 * legitimately appearing on more than one mountinfo line, e.g. via a bind
 * mount of the exact same path, is not an ambiguity).
 */
interface CgroupMounts {
  /** cgroup v1 distinct mount points keyed by controller name (e.g. "cpu", "memory"). */
  readonly v1ByController: ReadonlyMap<string, ReadonlySet<string>>;
  /** cgroup v2 distinct unified mount points seen (empty if not mounted). */
  readonly v2: ReadonlySet<string>;
}

/**
 * Records `entry`'s mount point under every v1 controller name its own
 * super-options list names (super-options mix real controller names with
 * non-controller mount flags like `rw`/`relatime`; only names this module
 * ever looks up are recorded — an unrecognized token is silently not a
 * controller this module cares about, not a parse failure). Split out of
 * `parseCgroupMounts` purely to keep that function's own cognitive
 * complexity under budget; no behavior change from inlining it.
 */
function recordV1ControllerMounts(v1ByController: Map<string, Set<string>>, entry: MountEntry): void {
  for (const option of entry.superOptions.split(",")) {
    if (option !== "cpu" && option !== "memory") {
      continue;
    }
    let mountPoints = v1ByController.get(option);
    if (!mountPoints) {
      mountPoints = new Set<string>();
      v1ByController.set(option, mountPoints);
    }
    mountPoints.add(entry.mountPoint);
  }
}

function parseCgroupMounts(mountinfoText: string): CgroupMounts {
  const v1ByController = new Map<string, Set<string>>();
  const v2 = new Set<string>();
  for (const line of mountinfoText.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const entry = parseMountinfoLine(line);
    if (!entry) {
      continue;
    }
    if (entry.fsType === "cgroup2") {
      v2.add(entry.mountPoint);
      continue;
    }
    if (entry.fsType === "cgroup") {
      recordV1ControllerMounts(v1ByController, entry);
    }
  }
  return { v1ByController, v2 };
}

/**
 * Resolves a set of candidate mount points to exactly one, or signals why
 * it couldn't: `null` means genuinely no mount was found (the caller's
 * existing "v2/v1 doesn't apply here" path), `"ambiguous"` means more than
 * one DISTINCT mount point survived — a shape this module refuses to guess
 * at rather than silently pick one, since mountinfo's line order carries no
 * documented meaning this module could soundly rely on.
 */
function resolveSingleMountPoint(mountPoints: ReadonlySet<string> | undefined): string | null | "ambiguous" {
  if (!mountPoints || mountPoints.size === 0) {
    return null;
  }
  if (mountPoints.size > 1) {
    return "ambiguous";
  }
  const [only] = mountPoints;
  return only ?? null;
}

// ─── /proc/self/cgroup parsing ─────────────────────────────────────────────
// Format (man 7 cgroups): "hierarchy-ID:controller-list:cgroup-path" per
// line. v2's hierarchy-ID is always "0" with an empty controller-list; v1
// lines have a positive hierarchy-ID and a comma-separated controller list.
interface CgroupMembership {
  /** This process's v1 relative cgroup path, keyed by controller name. */
  readonly v1ByController: ReadonlyMap<string, string>;
  /** This process's v2 relative cgroup path, if it has one. */
  readonly v2: string | null;
}

/**
 * `null` on ANY malformed line (wrong field count, a path segment that is
 * exactly `..` or contains a `/../` traversal, an empty path) — the whole
 * file is rejected rather than salvaging the lines that did parse, since a
 * malformed line is itself evidence this environment's cgroup shape isn't
 * one this module can safely reason about.
 */
function parseProcSelfCgroup(cgroupText: string): CgroupMembership | null {
  const v1ByController = new Map<string, string>();
  let v2: string | null = null;
  for (const line of cgroupText.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const firstColon = line.indexOf(":");
    const secondColon = line.indexOf(":", firstColon + 1);
    if (firstColon === -1 || secondColon === -1) {
      return null;
    }
    const hierarchyId = line.slice(0, firstColon);
    const controllers = line.slice(firstColon + 1, secondColon);
    const cgroupPath = unescapeProcOctal(line.slice(secondColon + 1).trim());
    if (!isSafeRelativeCgroupPath(cgroupPath)) {
      return null;
    }
    if (hierarchyId === "0" && controllers === "") {
      v2 = cgroupPath;
      continue;
    }
    const parsedHierarchyId = Number(hierarchyId);
    if (!(Number.isInteger(parsedHierarchyId) && parsedHierarchyId > 0)) {
      return null;
    }
    for (const controller of controllers.split(",")) {
      if (controller === "cpu" || controller === "memory") {
        v1ByController.set(controller, cgroupPath);
      }
    }
  }
  return { v1ByController, v2 };
}

/**
 * Refuses a cgroup-path field that could escape the mount point it will be
 * joined against: `..` segments (path traversal), a non-absolute
 * (non-`/`-rooted) path, or an empty string. cgroup paths are always
 * `/`-rooted relative-to-the-hierarchy strings per the kernel's own
 * contract, so anything else is malformed input, not a shape this module
 * has ever legitimately seen — fail closed rather than guess.
 */
function isSafeRelativeCgroupPath(value: string): boolean {
  if (!value.startsWith("/")) {
    return false;
  }
  const segments = value.split("/");
  return segments.every((segment) => segment !== "..");
}

// ─── Ancestor walk ──────────────────────────────────────────────────────────

/**
 * Every directory from `path.join(mountPoint, relativeCgroupPath)` up to
 * (and including) `mountPoint` itself, nearest (leaf) first. Bounded by
 * construction: `relativeCgroupPath` was already proven traversal-free by
 * `isSafeRelativeCgroupPath`, so this can only walk upward through the
 * segments that path actually named — it cannot escape `mountPoint`.
 */
function ancestorCgroupDirs(mountPoint: string, relativeCgroupPath: string): string[] {
  const leaf = path.join(mountPoint, relativeCgroupPath);
  const dirs: string[] = [];
  let current = leaf;
  for (;;) {
    dirs.push(current);
    if (current === mountPoint) {
      break;
    }
    const parent = path.dirname(current);
    // path.dirname("/") === "/"; this only fires if `current` somehow
    // reached filesystem root without ever equaling `mountPoint` (e.g. a
    // mountinfo mount-point that isn't actually a prefix of the joined
    // path) — defensive termination, not an expected case given the inputs
    // are already validated.
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return dirs;
}

/**
 * Reduces the per-ancestor `QuotaResult`s collected by the two aggregation
 * functions below into the single effective quota: the MINIMUM numeric
 * value among every `"known"` reading (the kernel enforces the tightest
 * limit anywhere in the ancestor chain, regardless of which level's own
 * file happens to be nearest — see the module doc comment). `"unlimited"`
 * at a given level does not participate in the minimum (it asserts "no
 * additional constraint here," not "0" or "ignore this chain") — the
 * aggregate is `"unlimited"` only if EVERY level that had the file read
 * `"unlimited"`. A level whose file could not be parsed at all
 * (`"unknown"`) makes the WHOLE aggregate `"unknown"`: a malformed reading
 * anywhere in the chain means this module cannot prove what the true
 * effective quota is, and guessing by ignoring that level would be exactly
 * the "trust what's easy to read" mistake this module exists to avoid. An
 * empty `results` array (no ancestor had the file at all) returns `null`,
 * matching the pre-aggregation "file absent everywhere" signal callers
 * already turn into `{state: "unknown"}`.
 */
function aggregateTightestQuota(results: readonly QuotaResult[]): QuotaResult | null {
  if (results.length === 0) {
    return null;
  }
  let tightest: number | null = null;
  for (const result of results) {
    if (result.state === "unknown") {
      return { state: "unknown" };
    }
    if (result.state === "known" && (tightest === null || result.value < tightest)) {
      tightest = result.value;
    }
  }
  return tightest === null ? { state: "unlimited" } : { state: "known", value: tightest };
}

/**
 * Reads a single named file (e.g. `cpu.max`, `memory.max`, cgroup v1's
 * `memory.limit_in_bytes`) from EVERY ancestor (walking leaf-to-root) that
 * has it, parses each with `parse`, and reduces via `aggregateTightestQuota`.
 * Returns `null` if none of the candidate directories has the file at all
 * (distinct from the file existing but being malformed at every level that
 * has it, which `aggregateTightestQuota` turns into `{state: "unknown"}`
 * rather than `null`).
 */
function aggregateTightestSingleFile(
  probe: CpuQuotaProbe,
  mountPoint: string,
  relativeCgroupPath: string,
  fileName: string,
  parse: (raw: string) => QuotaResult
): QuotaResult | null {
  const results: QuotaResult[] = [];
  for (const dir of ancestorCgroupDirs(mountPoint, relativeCgroupPath)) {
    try {
      results.push(parse(probe.readFile(path.join(dir, fileName))));
    } catch {
      // This ancestor doesn't have the file (controller not delegated
      // there, or genuinely absent) — it simply contributes nothing to the
      // aggregate; continue checking the rest of the chain.
    }
  }
  return aggregateTightestQuota(results);
}

function parseCgroupV2Max(raw: string): QuotaResult {
  const [quotaRaw, periodRaw] = raw.trim().split(WHITESPACE_PATTERN);
  if (quotaRaw === "max") {
    return { state: "unlimited" };
  }
  if (!(quotaRaw && periodRaw)) {
    return { state: "unknown" };
  }
  const quota = Number(quotaRaw);
  const period = Number(periodRaw);
  if (!(Number.isFinite(quota) && Number.isFinite(period) && quota > 0 && period > 0)) {
    return { state: "unknown" };
  }
  return { state: "known", value: quota / period };
}

function parseCgroupV2MemoryMax(raw: string): QuotaResult {
  const trimmed = raw.trim();
  if (trimmed === "max") {
    return { state: "unlimited" };
  }
  const bytes = Number(trimmed);
  return Number.isFinite(bytes) && bytes > 0 ? { state: "known", value: bytes } : { state: "unknown" };
}

/**
 * Resolves this process's actual v2 cgroup directory (mount point joined
 * with its own relative path from `/proc/self/cgroup`, NOT the mount root)
 * and aggregates `cpu.max` across every ancestor up to (and including) the
 * mount point — see `aggregateTightestQuota` for why this is a minimum
 * across the chain, not just the nearest reading. Returns `null` (not
 * `"unknown"`) when v2 isn't mounted or this process has no v2 membership
 * at all, so the caller can fall through to the v1 reader; returns
 * `{state: "unknown"}` for every failure mode once v2 membership IS
 * established but something about resolving it is unsafe (malformed
 * mountinfo/cgroup file, no ancestor has the file at all, or a malformed
 * reading anywhere in the chain).
 */
function cgroupV2CpuQuota(probe: CpuQuotaProbe): QuotaResult | null {
  const resolved = resolveV2CgroupDir(probe);
  if (resolved === null) {
    return null;
  }
  if (resolved === "unknown") {
    return { state: "unknown" };
  }
  const aggregated = aggregateTightestSingleFile(
    probe,
    resolved.mountPoint,
    resolved.relativeCgroupPath,
    "cpu.max",
    parseCgroupV2Max
  );
  return aggregated ?? { state: "unknown" };
}

function cgroupV2MemoryQuota(probe: CpuQuotaProbe): QuotaResult | null {
  const resolved = resolveV2CgroupDir(probe);
  if (resolved === null) {
    return null;
  }
  if (resolved === "unknown") {
    return { state: "unknown" };
  }
  const aggregated = aggregateTightestSingleFile(
    probe,
    resolved.mountPoint,
    resolved.relativeCgroupPath,
    "memory.max",
    parseCgroupV2MemoryMax
  );
  return aggregated ?? { state: "unknown" };
}

interface ResolvedCgroupDir {
  readonly mountPoint: string;
  readonly relativeCgroupPath: string;
}

/**
 * `null`: v2 is not mounted, or this process has no v2 line in
 * `/proc/self/cgroup` at all — genuinely "v2 doesn't apply here," so the
 * caller falls through to v1, not a failure.
 * `"unknown"`: v2 clearly DOES apply (mounted, and/or this process has a
 * v2 line) but something about resolving exactly where is unsafe —
 * unreadable/malformed `/proc` files, a relative path that failed the
 * traversal check, or MORE THAN ONE DISTINCT cgroup2 mount point visible in
 * this mount namespace (ambiguous: mountinfo's line order is not proof
 * either one corresponds to this process, so neither is silently picked).
 * Never silently treated as "no quota."
 */
function resolveV2CgroupDir(probe: CpuQuotaProbe): ResolvedCgroupDir | "unknown" | null {
  let mountinfoText: string;
  let cgroupText: string;
  try {
    mountinfoText = probe.readFile("/proc/self/mountinfo");
  } catch {
    return null;
  }
  try {
    cgroupText = probe.readFile("/proc/self/cgroup");
  } catch {
    return "unknown";
  }
  const membership = parseProcSelfCgroup(cgroupText);
  if (membership === null) {
    return "unknown";
  }
  if (membership.v2 === null) {
    return null;
  }
  const mounts = parseCgroupMounts(mountinfoText);
  const mountPoint = resolveSingleMountPoint(mounts.v2);
  if (mountPoint === null) {
    // This process has v2 membership but no v2 mount is visible in this
    // mount namespace — an inconsistent/unreadable environment shape, not
    // "no v2 quota."
    return "unknown";
  }
  if (mountPoint === "ambiguous") {
    return "unknown";
  }
  return { mountPoint, relativeCgroupPath: membership.v2 };
}

// ─── cgroup v1 ──────────────────────────────────────────────────────────────

/**
 * Same leaf-resolution + ancestor-walk model as v2, but v1 controllers are
 * mounted separately per controller name and the quota is split across two
 * files (`cpu.cfs_quota_us` / `cpu.cfs_period_us`) that must both be read
 * from the SAME ancestor directory — reading quota from one level and
 * period from another would silently pair unrelated numbers.
 */
function resolveV1ControllerDir(
  probe: CpuQuotaProbe,
  controller: "cpu" | "memory"
): ResolvedCgroupDir | "unknown" | null {
  let mountinfoText: string;
  let cgroupText: string;
  try {
    mountinfoText = probe.readFile("/proc/self/mountinfo");
  } catch {
    return null;
  }
  try {
    cgroupText = probe.readFile("/proc/self/cgroup");
  } catch {
    return "unknown";
  }
  const membership = parseProcSelfCgroup(cgroupText);
  if (membership === null) {
    return "unknown";
  }
  const relativeCgroupPath = membership.v1ByController.get(controller);
  if (relativeCgroupPath === undefined) {
    return null;
  }
  const mounts = parseCgroupMounts(mountinfoText);
  const mountPoint = resolveSingleMountPoint(mounts.v1ByController.get(controller));
  if (mountPoint === null || mountPoint === "ambiguous") {
    // Both "no mount visible for this controller" and "more than one
    // distinct mount visible" are unsafe once this process's own v1
    // membership for this controller is already established — the only
    // difference from the v2 case is that v1 membership was already proven
    // non-null before this point, so there is no "genuinely doesn't apply"
    // branch left to take here.
    return "unknown";
  }
  return { mountPoint, relativeCgroupPath };
}

/**
 * Same-ancestor-pairing analog of `aggregateTightestSingleFile` for v1's
 * two-file quota (`cpu.cfs_quota_us` + `cpu.cfs_period_us`, which must come
 * from the SAME directory — reading quota from one level and period from
 * another would silently pair unrelated numbers). Collects one
 * `QuotaResult` per ancestor that has BOTH files, then reduces via
 * `aggregateTightestQuota` exactly like the single-file case.
 */
function aggregateTightestV1Pair(
  probe: CpuQuotaProbe,
  mountPoint: string,
  relativeCgroupPath: string,
  fileNames: readonly [string, string],
  parse: (quotaRaw: string, periodRaw: string) => QuotaResult
): QuotaResult | null {
  const results: QuotaResult[] = [];
  for (const dir of ancestorCgroupDirs(mountPoint, relativeCgroupPath)) {
    try {
      const quotaRaw = probe.readFile(path.join(dir, fileNames[0]));
      const periodRaw = probe.readFile(path.join(dir, fileNames[1]));
      results.push(parse(quotaRaw, periodRaw));
    } catch {
      // Try the next ancestor up; both files must exist at the SAME level,
      // and a level missing either one simply contributes nothing.
    }
  }
  return aggregateTightestQuota(results);
}

function parseCgroupV1CpuPair(quotaRaw: string, periodRaw: string): QuotaResult {
  const quota = Number(quotaRaw.trim());
  const period = Number(periodRaw.trim());
  if (!Number.isFinite(period) || period <= 0) {
    return { state: "unknown" };
  }
  // -1 is cgroup v1's own "no quota configured" sentinel, not an error.
  if (quota === -1) {
    return { state: "unlimited" };
  }
  if (!Number.isFinite(quota) || quota <= 0) {
    return { state: "unknown" };
  }
  return { state: "known", value: quota / period };
}

function cgroupV1CpuQuota(probe: CpuQuotaProbe): QuotaResult | null {
  const resolved = resolveV1ControllerDir(probe, "cpu");
  if (resolved === null) {
    return null;
  }
  if (resolved === "unknown") {
    return { state: "unknown" };
  }
  const aggregated = aggregateTightestV1Pair(
    probe,
    resolved.mountPoint,
    resolved.relativeCgroupPath,
    ["cpu.cfs_quota_us", "cpu.cfs_period_us"],
    parseCgroupV1CpuPair
  );
  return aggregated ?? { state: "unknown" };
}

// cgroup v1's unset-limit sentinel is the kernel's LONG_MAX rounded DOWN to
// the page boundary (LONG_MAX & PAGE_MASK on a 4KiB-page 64-bit system,
// i.e. 9223372036854775807n & ~4095n = 9223372036854771712n) — not a round
// power-of-two like 2^63-1 or 2^64-page_size. Expressed as a BigInt (via the
// constructor, not an `n`-suffixed literal — this file is reachable from
// apps/console's single tsc program, which type-checks it under console's
// own ES2017 target where BigInt literal syntax is unavailable, TS2737)
// so the source documents the EXACT kernel value without a lossy Number
// literal (9223372036854771712 is not exactly representable as a JS
// Number); converted to Number only where it's actually used, in a
// tolerance-based comparison that doesn't depend on bit-exactness. Any
// reading within 1% of this value (allowing for other common page sizes) is
// treated as "no real limit configured," not a literal ~8-exabyte quota.
const V1_MEMORY_UNSET_SENTINEL_BYTES = Number(BigInt("9223372036854771712"));

function parseCgroupV1MemoryLimit(raw: string): QuotaResult {
  const bytes = Number(raw.trim());
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return { state: "unknown" };
  }
  return bytes >= V1_MEMORY_UNSET_SENTINEL_BYTES * 0.99 ? { state: "unlimited" } : { state: "known", value: bytes };
}

function cgroupV1MemoryQuota(probe: CpuQuotaProbe): QuotaResult | null {
  const resolved = resolveV1ControllerDir(probe, "memory");
  if (resolved === null) {
    return null;
  }
  if (resolved === "unknown") {
    return { state: "unknown" };
  }
  const aggregated = aggregateTightestSingleFile(
    probe,
    resolved.mountPoint,
    resolved.relativeCgroupPath,
    "memory.limit_in_bytes",
    parseCgroupV1MemoryLimit
  );
  return aggregated ?? { state: "unknown" };
}

/**
 * CPU quota this process is bound by, in fractional cores (e.g. `0.5` for
 * `--cpus=0.5`). See the module doc comment for the `"unknown"` state: it
 * means this process's actual cgroup membership is established but the
 * quota could not be safely resolved there, which must be treated as "a
 * limit may exist and is not visible" — not as unlimited.
 */
export function cgroupCpuQuota(probe: CpuQuotaProbe = REAL_PROBE): QuotaResult {
  if (probe.platform !== "linux") {
    return { state: "unlimited" };
  }
  const v2 = cgroupV2CpuQuota(probe);
  if (v2 !== null) {
    return v2;
  }
  const v1 = cgroupV1CpuQuota(probe);
  if (v1 !== null) {
    return v1;
  }
  return probe.cgroupMounted() ? { state: "unknown" } : { state: "unlimited" };
}

/** Memory quota this process is bound by, in bytes. See `cgroupCpuQuota` for the `"unknown"` state's meaning. */
export function cgroupMemoryQuota(probe: CpuQuotaProbe = REAL_PROBE): QuotaResult {
  if (probe.platform !== "linux") {
    return { state: "unlimited" };
  }
  const v2 = cgroupV2MemoryQuota(probe);
  if (v2 !== null) {
    return v2;
  }
  const v1 = cgroupV1MemoryQuota(probe);
  if (v1 !== null) {
    return v1;
  }
  return probe.cgroupMounted() ? { state: "unknown" } : { state: "unlimited" };
}

/**
 * Effective whole-CPU count for sizing this process's own concurrency
 * defaults. Always >= 1: a quota below one whole CPU (shared/burstable
 * instances) still gets one worker rather than zero, since these callers
 * (embedding compute) have no zero-concurrency mode. An `"unknown"` quota
 * (cgroup membership established, quota not safely resolvable) is treated
 * as 1 — the safe floor — NOT as "fall back to the host's full core
 * count"; that fallback is reserved for genuinely uncontainerized platforms
 * (`"unlimited"`).
 */
export function effectiveCpuCount(probe: CpuQuotaProbe = REAL_PROBE): number {
  const quota = cgroupCpuQuota(probe);
  if (quota.state === "known") {
    return Math.max(1, Math.floor(quota.value));
  }
  if (quota.state === "unknown") {
    return 1;
  }
  const parallelism = probe.availableParallelism();
  return Number.isFinite(parallelism) && parallelism > 0 ? parallelism : 1;
}

/**
 * Effective memory budget in bytes for sizing this process's own
 * concurrency defaults. `"unknown"` is treated as a tight, conservative
 * budget (512MiB — the shipped Fly.io reference deploy's own configured
 * total, `deploy/flyio/fly.toml`) rather than the host's full memory: the
 * whole point of `"unknown"` is that a real limit may be in effect and
 * merely invisible from here.
 */
const UNKNOWN_MEMORY_BUDGET_BYTES = 512 * 1024 * 1024;

export function effectiveMemoryBudgetBytes(probe: CpuQuotaProbe = REAL_PROBE): number {
  const quota = cgroupMemoryQuota(probe);
  if (quota.state === "known") {
    return quota.value;
  }
  if (quota.state === "unknown") {
    return UNKNOWN_MEMORY_BUDGET_BYTES;
  }
  const total = probe.totalMemoryBytes();
  return Number.isFinite(total) && total > 0 ? total : UNKNOWN_MEMORY_BUDGET_BYTES;
}
