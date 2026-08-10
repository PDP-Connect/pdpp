// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Effective CPU count for THIS process, honoring a cgroup CPU quota when one
 * is set. `os.availableParallelism()` reports the host's physical/logical
 * core count and does not consult cgroup limits — inside a `--cpus=1`
 * container on a 24-core host it still reports 24 (verified locally:
 * `docker run --rm --cpus=1 node:24-slim node -e
 * "console.log(require('node:os').availableParallelism())"` prints `24`).
 * A concurrency default derived from that number would oversubscribe a
 * CPU-constrained deployment (e.g. the shipped Fly.io reference config,
 * `deploy/flyio/fly.toml`: `cpus = 1, cpu_kind = "shared"`) by 24x.
 *
 * Reads the quota this process is actually bound by, in order:
 *   1. cgroup v2 `/sys/fs/cgroup/cpu.max` — "$MAX $PERIOD" or "max $PERIOD".
 *   2. cgroup v1 `cpu.cfs_quota_us` / `cpu.cfs_period_us` (quota -1 = unset).
 *   3. `os.availableParallelism()` when neither file exists/applies
 *      (non-Linux, no cgroup, or an unlimited quota) — the same value the
 *      previous hardcoded defaults implicitly assumed for "no limit found".
 */

import { readFileSync } from "node:fs";
import os from "node:os";

/** Injectable seam for tests; real callers use the module-level defaults below. */
export interface CpuQuotaProbe {
  readonly availableParallelism: () => number;
  readonly platform: NodeJS.Platform;
  readonly readFile: (path: string) => string;
}

const REAL_PROBE: CpuQuotaProbe = {
  availableParallelism: () => os.availableParallelism(),
  platform: process.platform,
  readFile: (path: string) => readFileSync(path, "utf8"),
};

const WHITESPACE_PATTERN = /\s+/;

function parseCgroupV2Max(raw: string): number | null {
  const [quotaRaw, periodRaw] = raw.trim().split(WHITESPACE_PATTERN);
  if (quotaRaw === "max" || !quotaRaw || !periodRaw) {
    return null;
  }
  const quota = Number(quotaRaw);
  const period = Number(periodRaw);
  if (!(Number.isFinite(quota) && Number.isFinite(period) && quota > 0 && period > 0)) {
    return null;
  }
  return quota / period;
}

function cgroupV2Quota(probe: CpuQuotaProbe): number | null {
  try {
    return parseCgroupV2Max(probe.readFile("/sys/fs/cgroup/cpu.max"));
  } catch {
    return null;
  }
}

function cgroupV1Quota(probe: CpuQuotaProbe): number | null {
  try {
    const quota = Number(probe.readFile("/sys/fs/cgroup/cpu/cpu.cfs_quota_us").trim());
    const period = Number(probe.readFile("/sys/fs/cgroup/cpu/cpu.cfs_period_us").trim());
    if (!(Number.isFinite(quota) && Number.isFinite(period) && quota > 0 && period > 0)) {
      return null;
    }
    return quota / period;
  } catch {
    return null;
  }
}

/**
 * Fractional CPU quota (e.g. `0.5` for `--cpus=0.5`), or `null` when no
 * cgroup quota applies and the caller should fall back to
 * `os.availableParallelism()`.
 */
export function cgroupCpuQuota(probe: CpuQuotaProbe = REAL_PROBE): number | null {
  if (probe.platform !== "linux") {
    return null;
  }
  return cgroupV2Quota(probe) ?? cgroupV1Quota(probe);
}

/**
 * Effective whole-CPU count for sizing this process's own concurrency
 * defaults. Always >= 1: a quota below one whole CPU (shared/burstable
 * instances) still gets one worker rather than zero, since these callers
 * (embedding compute) have no zero-concurrency mode.
 */
export function effectiveCpuCount(probe: CpuQuotaProbe = REAL_PROBE): number {
  const quota = cgroupCpuQuota(probe);
  if (quota !== null) {
    return Math.max(1, Math.floor(quota));
  }
  const parallelism = probe.availableParallelism();
  return Number.isFinite(parallelism) && parallelism > 0 ? parallelism : 1;
}
