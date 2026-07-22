// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Chromium profile singleton-lock hygiene for PDPP browser-based connectors.
 *
 * Chromium tracks "this profile is in use" via three files inside the
 * user-data-dir:
 *
 *   - `SingletonLock`   — symlink whose target is `<hostname>-<pid>`.
 *                          The advisory ownership marker.
 *   - `SingletonCookie` — symlink to a random cookie value. Used to
 *                          defeat /tmp socket-squatting attacks.
 *   - `SingletonSocket` — symlink to a unix-domain socket in /tmp.
 *                          Used for actual IPC ("open URL in existing
 *                          browser").
 *
 * Source: `chrome/browser/process_singleton_posix.cc` in the Chromium tree.
 *
 * When a Chromium process exits cleanly, these files are removed. When it
 * dies non-gracefully (controller restart, OOM, container SIGKILL), they
 * are left behind. Chromium's own startup logic refuses to launch when it
 * sees a stale lock with a hostname that doesn't match its current
 * `gethostname()` — designed to protect NFS-shared profiles from
 * concurrent access on different hosts. In Docker that hostname check
 * fires on every container restart (each container gets a fresh hostname),
 * producing the failure mode:
 *
 *     The profile appears to be in use by another Google Chrome process
 *     (PID) on another computer (HOST). Chrome has locked the profile so
 *     that it doesn't get corrupted.
 *
 * The canonical fix in production deployments (Browserless, Playwright
 * docs, Puppeteer guides, chilipie-kiosk, etc.) is to remove all three
 * Singleton* files immediately before launching against the profile.
 *
 * This module provides that cleanup, gated by an in-process mutex keyed
 * by user-data-dir. The mutex is the load-bearing correctness primitive:
 * it ensures PDPP never has two of its own processes launching Chromium
 * against the same profile simultaneously. Given that invariant, any lock
 * we encounter at launch time is by definition residue from a prior
 * incarnation and is safe to remove.
 *
 * What this module does NOT touch:
 *   - Any other file in the user-data-dir. Cookies, IndexedDB, Local
 *     Storage, Preferences, Sessions, Extensions — none of that is part
 *     of the Singleton* trio and none of it is at risk from this cleanup.
 *   - Singleton* files in other profile directories. The cleanup is
 *     strictly scoped to the profileDir argument.
 *
 * Concurrent access concerns:
 *   - Two PDPP processes against the same profile is UNSUPPORTED. The
 *     mutex protects against in-process races, not inter-process. Cross-
 *     container access to a shared volume is an operator misconfiguration
 *     that no userland code can fix (and that Chromium's own design
 *     refuses to support).
 *
 * Research backing this design:
 *   - Chromium `process_singleton_posix.cc` header comment (algorithm,
 *     stable >12 years).
 *   - microsoft/playwright#35466 (persistent context corruption).
 *   - puppeteer/puppeteer#10517 (`SingletonLock: File exists`).
 *   - browserless/browserless#4284 (concurrent launch with userDataDir).
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

/** The three Chromium singleton files inside a user-data-dir. */
const SINGLETON_FILE_NAMES = ["SingletonLock", "SingletonCookie", "SingletonSocket"] as const;

/**
 * Per-userDataDir mutex. Serializes the cleanup-then-launch sequence so
 * that two concurrent callers don't race to remove each other's locks.
 *
 * Keyed by absolute path. A `Map<string, Promise>` with FIFO chaining: each
 * call awaits the prior call's completion before running its own critical
 * section. The map entry is preserved for the lifetime of the process —
 * the mutex is essentially a per-profile serialization channel.
 */
const profileMutex = new Map<string, Promise<unknown>>();

/**
 * Run `criticalSection` inside the per-profile mutex. Returns whatever the
 * critical section returns. Re-thrown errors propagate normally; the
 * mutex chain is preserved regardless (subsequent callers wait for
 * settlement, not for success).
 */
type MaybePromise<T> = T | Promise<T>;

export async function withProfileLockMutex<T>(profileDir: string, criticalSection: () => MaybePromise<T>): Promise<T> {
  const prior = profileMutex.get(profileDir) ?? Promise.resolve();
  let releaseAfter: () => void = () => undefined;
  const ours = new Promise<void>((resolve) => {
    releaseAfter = resolve;
  });
  // Chain: this call's slot in the mutex is `prior.then(() => ours)`. The
  // next caller will await `ours` (which resolves when WE release), so
  // they run strictly after us. Always-resolved chain so a thrown error
  // doesn't poison the queue for subsequent callers.
  profileMutex.set(
    profileDir,
    prior.then(() => ours)
  );
  await prior.catch(() => undefined);
  try {
    return await criticalSection();
  } finally {
    releaseAfter();
  }
}

/**
 * Remove the three Chromium singleton files from `profileDir` if they
 * exist. No-ops on missing files. Touches no other path. Idempotent.
 *
 * MUST be called inside `withProfileLockMutex(profileDir, ...)` to be safe
 * against concurrent in-process launches against the same profile.
 *
 * Returns the names of files that were actually removed (for logging /
 * test introspection).
 */
export async function removeChromiumSingletonResidue(profileDir: string): Promise<string[]> {
  const removed: string[] = [];
  for (const name of SINGLETON_FILE_NAMES) {
    const path = join(profileDir, name);
    try {
      // `unlink` removes a symlink itself (not its target), which is what
      // we want — the target either doesn't exist (SingletonLock's
      // hostname-pid string) or is owned by Chromium's IPC layer
      // (SingletonSocket's /tmp socket). We never follow.
      await fs.unlink(path);
      removed.push(name);
    } catch (err) {
      // ENOENT is the common case (file wasn't there). Anything else
      // (e.g. EACCES from a misconfigured permissions setup) should
      // surface — we'd rather fail loudly than silently leave a lock
      // file behind.
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        throw err;
      }
    }
  }
  return removed;
}
