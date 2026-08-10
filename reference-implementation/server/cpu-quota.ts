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
 * the guest's own `/sys/fs/cgroup` at all, or enforced only on the
 * host-side cgroup wrapping the VMM process (the standard Firecracker/KVM
 * pattern, which would leave the guest's cgroup files absent or reading
 * "unlimited"). See reference-implementation/docs (or the accompanying
 * report) for the exact residual: this needs a live `fly ssh console`
 * check, which this environment cannot perform.
 *
 * Because that ambiguity cannot be resolved here, `cgroupCpuQuota` and
 * `cgroupMemoryQuota` return `"unknown"` — a THIRD state distinct from "no
 * quota" and "quota N" — whenever a cgroup filesystem is mounted (proof the
 * process is very likely containerized) but the specific quota file is
 * absent or unreadable. Callers must treat `"unknown"` as the conservative
 * case, NOT as "unlimited": the entire point is that a real limit may exist
 * but not be visible from here. Only a platform with no cgroup filesystem
 * mounted at all (bare metal, most non-Linux dev machines) is treated as
 * genuinely unconstrained and falls back to `os.availableParallelism()` /
 * `os.totalmem()`.
 */

import { readFileSync } from "node:fs";
import os from "node:os";

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
  readFile: (path: string) => readFileSync(path, "utf8"),
  totalMemoryBytes: () => os.totalmem(),
};

const WHITESPACE_PATTERN = /\s+/;

/** A resolved quota, or the two distinct reasons a quota could not be resolved. */
export type QuotaResult =
  | { readonly state: "known"; readonly value: number }
  | { readonly state: "unlimited" }
  | { readonly state: "unknown" };

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

function cgroupV2CpuQuota(probe: CpuQuotaProbe): QuotaResult | null {
  try {
    return parseCgroupV2Max(probe.readFile("/sys/fs/cgroup/cpu.max"));
  } catch {
    return null;
  }
}

function cgroupV1CpuQuota(probe: CpuQuotaProbe): QuotaResult | null {
  try {
    const quota = Number(probe.readFile("/sys/fs/cgroup/cpu/cpu.cfs_quota_us").trim());
    const period = Number(probe.readFile("/sys/fs/cgroup/cpu/cpu.cfs_period_us").trim());
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
  } catch {
    return null;
  }
}

/**
 * CPU quota this process is bound by, in fractional cores (e.g. `0.5` for
 * `--cpus=0.5`). See the module doc comment for the `"unknown"` state: it
 * means a cgroup is mounted but the quota could not be read, which must be
 * treated as "a limit may exist and is not visible" — not as unlimited.
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

function cgroupV2MemoryQuota(probe: CpuQuotaProbe): QuotaResult | null {
  try {
    const raw = probe.readFile("/sys/fs/cgroup/memory.max").trim();
    if (raw === "max") {
      return { state: "unlimited" };
    }
    const bytes = Number(raw);
    return Number.isFinite(bytes) && bytes > 0 ? { state: "known", value: bytes } : { state: "unknown" };
  } catch {
    return null;
  }
}

function cgroupV1MemoryQuota(probe: CpuQuotaProbe): QuotaResult | null {
  try {
    const raw = probe.readFile("/sys/fs/cgroup/memory/memory.limit_in_bytes").trim();
    const bytes = Number(raw);
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return { state: "unknown" };
    }
    // cgroup v1's unset sentinel is architecture-dependent (commonly
    // 2^63-1 or 2^64-page_size); anything within 1% of the host's own
    // total memory is treated as "no real limit configured" rather than a
    // literal multi-exabyte quota.
    return bytes > Number.MAX_SAFE_INTEGER / 2 ? { state: "unlimited" } : { state: "known", value: bytes };
  } catch {
    return null;
  }
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
 * (cgroup mounted, file unreadable) is treated as 1 — the safe floor — NOT
 * as "fall back to the host's full core count"; that fallback is reserved
 * for genuinely uncontainerized platforms (`"unlimited"`).
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
