// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * canary/container-spec
 *
 * Reconstructs the `docker run` argv for the replacement container from the
 * running container's own `docker inspect` output.
 *
 * Why this file exists
 * --------------------
 * Production is a hand-rolled `docker run`, not compose-managed. There is no
 * declarative file to re-apply, so the ONLY authoritative description of how
 * production is configured is the running container itself. Anything this
 * module forgets to copy is silently lost at the next deploy: a dropped
 * `--restart` leaves production unable to survive a reboot, a dropped volume
 * detaches the database, a dropped memory limit lets one run take down the
 * host.
 *
 * `scripts/reference-stack.sh` is deliberately NOT used. It would start a
 * PARALLEL stack alongside production rather than replacing it, which during
 * an incident looks like a successful deploy while the old container keeps
 * serving traffic.
 *
 * Rollback posture
 * ----------------
 * The old container is RENAMED, never removed. A rename keeps the whole
 * object — its config, its logs, its writable layer — recoverable by a single
 * `docker rename` back, so rollback does not depend on this module having
 * reconstructed the spec correctly. That matters: if the reconstruction were
 * the only copy of the config, a bug here would make rollback impossible at
 * exactly the moment it is needed.
 */

/** Strips docker's leading `/` from a container Name (e.g. `/pdpp-core` -> `pdpp-core`). */
const LEADING_SLASH_PATTERN = /^\//u;

export interface PortBinding {
  readonly hostIp?: string;
  readonly hostPort: string;
}

export interface InspectedContainer {
  readonly binds: readonly string[];
  readonly cmd: readonly string[];
  readonly configImage: string;
  readonly entrypoint: readonly string[];
  readonly env: readonly string[];
  readonly imageId: string;
  readonly memoryBytes: number;
  readonly name: string;
  readonly nanoCpus: number;
  readonly networkMode: string;
  readonly portBindings: Readonly<Record<string, readonly PortBinding[]>>;
  readonly restartCount: number;
  readonly restartPolicyMaxRetry: number;
  readonly restartPolicyName: string;
  readonly startedAt: string;
  readonly user: string;
  readonly workingDir: string;
}

/**
 * Coerces a single raw `docker inspect` port-binding entry (one element of
 * `HostConfig.PortBindings["<port>/tcp"]`) into a typed `PortBinding`, or
 * drops it if it lacks a host port. Docker always supplies `HostIp` as an
 * empty string rather than omitting it, so an empty string is normalized to
 * `undefined` here rather than surviving into `buildRunArgs`.
 */
function parsePortBinding(binding: unknown): PortBinding[] {
  if (!binding || typeof binding !== "object") {
    return [];
  }
  const entry = binding as Record<string, unknown>;
  const hostPort = typeof entry.HostPort === "string" ? entry.HostPort : "";
  if (!hostPort) {
    return [];
  }
  const hostIp = typeof entry.HostIp === "string" && entry.HostIp.length > 0 ? entry.HostIp : undefined;
  return [hostIp === undefined ? { hostPort } : { hostIp, hostPort }];
}

/** Reads `HostConfig.PortBindings` into the container-port -> bindings map `buildRunArgs` walks. */
function parsePortBindings(hostConfig: Record<string, unknown>): Record<string, PortBinding[]> {
  const portBindings: Record<string, PortBinding[]> = {};
  const rawPorts = (hostConfig.PortBindings ?? {}) as Record<string, unknown>;
  for (const [containerPort, bindings] of Object.entries(rawPorts)) {
    if (!Array.isArray(bindings)) {
      continue;
    }
    portBindings[containerPort] = bindings.flatMap(parsePortBinding);
  }
  return portBindings;
}

/** Filters a raw JSON value down to its string elements, or `[]` if it is not an array. */
function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * Reads the fields the replacement needs out of raw `docker inspect` JSON.
 * Missing optional fields become empty rather than throwing, but the identity
 * fields (name, image) are required: a spec without them cannot be rebuilt.
 */
export function parseInspect(raw: unknown): InspectedContainer {
  if (!raw || typeof raw !== "object") {
    throw new Error("docker inspect output must be an object");
  }
  const container = raw as Record<string, unknown>;
  const config = (container.Config ?? {}) as Record<string, unknown>;
  const hostConfig = (container.HostConfig ?? {}) as Record<string, unknown>;
  const state = (container.State ?? {}) as Record<string, unknown>;
  const restartPolicy = (hostConfig.RestartPolicy ?? {}) as Record<string, unknown>;

  const name = typeof container.Name === "string" ? container.Name.replace(LEADING_SLASH_PATTERN, "") : "";
  if (!name) {
    throw new Error("docker inspect output has no container Name");
  }
  const configImage = typeof config.Image === "string" ? config.Image : "";
  if (!configImage) {
    throw new Error("docker inspect output has no Config.Image");
  }

  const portBindings = parsePortBindings(hostConfig);

  return {
    binds: stringsOf(hostConfig.Binds),
    cmd: stringsOf(config.Cmd),
    configImage,
    entrypoint: stringsOf(config.Entrypoint),
    env: stringsOf(config.Env),
    imageId: typeof container.Image === "string" ? container.Image : "",
    memoryBytes: typeof hostConfig.Memory === "number" ? hostConfig.Memory : 0,
    name,
    nanoCpus: typeof hostConfig.NanoCpus === "number" ? hostConfig.NanoCpus : 0,
    networkMode: typeof hostConfig.NetworkMode === "string" ? hostConfig.NetworkMode : "",
    portBindings,
    restartCount: typeof container.RestartCount === "number" ? container.RestartCount : 0,
    restartPolicyMaxRetry: typeof restartPolicy.MaximumRetryCount === "number" ? restartPolicy.MaximumRetryCount : 0,
    restartPolicyName: typeof restartPolicy.Name === "string" ? restartPolicy.Name : "",
    startedAt: typeof state.StartedAt === "string" ? state.StartedAt : "",
    user: typeof config.User === "string" ? config.User : "",
    workingDir: typeof config.WorkingDir === "string" ? config.WorkingDir : "",
  };
}

/**
 * Builds the `docker run` argv that recreates `spec` on `newImage`.
 *
 * Every host-level setting is copied explicitly. `--entrypoint` is only set
 * when the old container overrode the image's own, so a legitimately changed
 * entrypoint in the new image is not pinned to the old one.
 */
export function buildRunArgs(spec: InspectedContainer, newImage: string, envArgs: readonly string[]): string[] {
  const args: string[] = ["run", "-d", "--name", spec.name];

  if (spec.restartPolicyName) {
    const policy =
      spec.restartPolicyName === "on-failure" && spec.restartPolicyMaxRetry > 0
        ? `on-failure:${spec.restartPolicyMaxRetry}`
        : spec.restartPolicyName;
    args.push("--restart", policy);
  }
  if (spec.memoryBytes > 0) {
    args.push("--memory", String(spec.memoryBytes));
  }
  if (spec.nanoCpus > 0) {
    // Docker's --cpus is expressed in cores; NanoCpus is billionths of a core.
    args.push("--cpus", String(spec.nanoCpus / 1_000_000_000));
  }
  if (spec.networkMode) {
    args.push("--network", spec.networkMode);
  }
  for (const [containerPort, bindings] of Object.entries(spec.portBindings)) {
    for (const binding of bindings) {
      args.push(
        "-p",
        binding.hostIp
          ? `${binding.hostIp}:${binding.hostPort}:${containerPort}`
          : `${binding.hostPort}:${containerPort}`
      );
    }
  }
  // Binds carry both named volumes and host bind-mounts, including the `:ro`
  // suffix, exactly as the running container declares them.
  for (const bind of spec.binds) {
    args.push("-v", bind);
  }
  if (spec.workingDir) {
    args.push("-w", spec.workingDir);
  }
  if (spec.user) {
    args.push("-u", spec.user);
  }
  args.push(...envArgs);
  const [entrypointHead] = spec.entrypoint;
  if (entrypointHead !== undefined) {
    args.push("--entrypoint", entrypointHead);
  }
  args.push(newImage);
  if (spec.entrypoint.length > 1) {
    args.push(...spec.entrypoint.slice(1));
  }
  args.push(...spec.cmd);
  return args;
}

/**
 * The name the outgoing container is renamed to. Timestamped so repeated
 * deploys never collide, and prefixed so the rollback target is obvious in
 * `docker ps -a`.
 */
export function rollbackContainerName(originalName: string, at: Date): string {
  const stamp = at.toISOString().replace(/[:.]/gu, "-");
  return `${originalName}-prev-${stamp}`;
}
