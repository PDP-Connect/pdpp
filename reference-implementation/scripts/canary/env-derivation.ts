// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * canary/env-derivation
 *
 * Decides which environment variables to carry from the running container
 * onto its replacement.
 *
 * Why this file exists
 * --------------------
 * This one decision broke production twice in a single day, in both possible
 * directions, and each failure mode looks correct while you are making it.
 *
 * `docker inspect .Config.Env` returns the container's FULL environment: the
 * operator's `-e` flags AND everything baked into the image. Replaying all 97
 * vars onto a new image re-injects the OLD image's values — a stale `PATH` or
 * `NODE_VERSION` from the previous build, silently overriding the new image's
 * own. So some filtering is required.
 *
 * The tempting filter is by NAME: "drop anything the image also declares".
 * Measured against the live container, that rule drops 25 vars — and 5 of
 * them are real operator overrides that merely share a name with an image
 * default:
 *
 *     PDPP_DB_PATH              image=/var/lib/pdpp/pdpp.sqlite
 *                               live =/root/.pdpp/pdpp.sqlite      <-- the database
 *     PDPP_CONNECTOR_ARTIFACT_ROOT, PDPP_EMBEDDING_CACHE_DIR,
 *     PDPP_REFERENCE_ORIGIN, PDPP_REFERENCE_REVISION
 *
 * Dropping `PDPP_DB_PATH` points production at the WRONG DATABASE. The
 * name-based rule is confidently, catastrophically wrong, and nothing about
 * the name distinguishes a real override from an image default.
 *
 * The opposite over-correction also happened: filtering too aggressively by a
 * hand-written list dropped `NODE_ENV` and `PLAYWRIGHT_BROWSERS_PATH` and
 * broke connector execution.
 *
 * The rule that is actually right
 * ------------------------------
 * Drop a variable only when the image declares the SAME NAME AND THE SAME
 * VALUE. Then dropping it is provably a no-op: the new image supplies an
 * identical value, or a deliberately updated one that SHOULD win (this is how
 * a `PATH` or `NODE_VERSION` change in a new base image takes effect). Any
 * value that differs is, by construction, information the image does not
 * have — an operator override — and is carried forward.
 *
 * Measured live: 20 of 25 name-collisions are value-identical (safe), 5 are
 * real overrides (carried). Both failure modes are excluded by the same rule.
 *
 * Because "provably a no-op" is a claim about VALUES, and values are what the
 * caller cannot see at a glance, `deriveEnv` reports every variable it drops
 * so the operator can catch a wrong call before it reaches production.
 */

export interface EnvVar {
  readonly name: string;
  readonly value: string;
}

export interface EnvDerivation {
  /** Vars to pass as `-e NAME=value` on the replacement container. */
  readonly carried: readonly EnvVar[];
  /**
   * Carried DESPITE the image declaring the same name, because the values
   * differ. These are the operator overrides a name-based filter would have
   * destroyed; surfaced prominently so a wrong call is visible.
   */
  readonly carriedOverrides: readonly {
    readonly name: string;
    readonly liveValue: string;
    readonly imageValue: string;
  }[];
  /** Dropped because the new image declares an identical name AND value. */
  readonly droppedAsImageIdentical: readonly EnvVar[];
}

/**
 * Splits a `NAME=value` entry as Docker emits it. Values may contain `=`, so
 * only the first separator is significant. An entry with no `=` is a bare
 * name and yields an empty value rather than being discarded.
 */
export function parseEnvEntries(entries: readonly string[]): EnvVar[] {
  return entries.map((entry) => {
    const separator = entry.indexOf("=");
    if (separator === -1) {
      return { name: entry, value: "" };
    }
    return { name: entry.slice(0, separator), value: entry.slice(separator + 1) };
  });
}

/**
 * Derives the replacement container's environment as
 * `live minus image-value-identical`.
 *
 * @param liveEnv  `.Config.Env` of the currently running container.
 * @param imageEnv `.Config.Env` of the NEWLY BUILT image — not the old one.
 *                 Using the new image is what lets an intentionally changed
 *                 image default take effect instead of being masked.
 */
export function deriveEnv(liveEnv: readonly string[], imageEnv: readonly string[]): EnvDerivation {
  const live = parseEnvEntries(liveEnv);
  const image = new Map(parseEnvEntries(imageEnv).map((entry) => [entry.name, entry.value]));

  const carried: EnvVar[] = [];
  const droppedAsImageIdentical: EnvVar[] = [];
  const carriedOverrides: { name: string; liveValue: string; imageValue: string }[] = [];

  for (const entry of live) {
    const imageValue = image.get(entry.name);
    if (imageValue === undefined) {
      // The image knows nothing about this var: purely operator-supplied.
      carried.push(entry);
      continue;
    }
    if (imageValue === entry.value) {
      // Provably a no-op to drop: the image supplies this exact value.
      droppedAsImageIdentical.push(entry);
      continue;
    }
    // Same name, different value => a real override. Carry it, and say so.
    carried.push(entry);
    carriedOverrides.push({ imageValue, liveValue: entry.value, name: entry.name });
  }

  return { carried, carriedOverrides, droppedAsImageIdentical };
}

/**
 * Renders the derivation as `-e` arguments for `docker run`.
 *
 * Values are passed as separate argv entries (never interpolated into a
 * shell string), so a value containing spaces, quotes, or newlines cannot
 * break out into the command.
 */
export function toDockerEnvArgs(derivation: EnvDerivation): string[] {
  const args: string[] = [];
  for (const entry of derivation.carried) {
    args.push("-e", `${entry.name}=${entry.value}`);
  }
  return args;
}
