/**
 * Tiny predicate: "is this module the process entry point?"
 *
 * Usage at the end of a connector's index.ts:
 *
 *   import { isMainModule } from "../../src/is-main-module.ts";
 *
 *   if (isMainModule(import.meta.url)) {
 *     runConnector({ ... });
 *   }
 *
 * Why this exists: previously, connectors called `runConnector({...})`
 * unconditionally at module load. That's correct for CLI runs — the
 * process IS the connector — but it meant importing `index.ts` in a
 * test kept the Node event loop alive waiting for the stdin protocol.
 * Workaround was an extra `collect-helpers.ts` per connector that
 * re-exported the testable helpers. This helper removes the need for
 * that workaround: tests can import `index.ts` directly because
 * `runConnector` only fires when index.ts IS the entry point.
 *
 * Kept as a pure predicate (not `runConnectorIfMain(config)`) so the
 * runtime doesn't need to know or care about process-launch semantics.
 * Connectors control their own bootstrap.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export function isMainModule(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  if (importMetaUrl === pathToFileURL(entry).href) {
    return true;
  }

  // npm exposes package bins as symlinks. Compare real paths too so
  // installed CLI entrypoints still bootstrap while import-time tests stay
  // safe.
  try {
    return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(entry);
  } catch {
    return false;
  }
}
