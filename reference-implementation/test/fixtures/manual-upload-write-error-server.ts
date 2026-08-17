// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Standalone child-process fixture for the P1 write-stream-error regression
 * test (manual-upload-terminal-redteam-0810 finding #1): starts a real
 * server with `node:fs`'s `createWriteStream` mocked to return a stream
 * that emits a genuine `'error'` event (ENOSPC) after a partial write --
 * simulating a real disk-full/IO condition without needing an actual full
 * disk. The mock is registered via `test.mock.module` BEFORE `server/index.ts`
 * (and everything it transitively imports, including
 * `ref-manual-upload-draft-connection.ts`) is loaded, so the production
 * `writeUploadBodyToPath` call goes through the mocked stream exactly as it
 * would through a real one.
 *
 * Must run as a genuinely separate OS process: if `writeUploadBodyToPath`'s
 * fix regresses, the write-stream error becomes an uncaught exception that
 * kills the process it runs in. Running this in the SAME process as the
 * test runner would take the whole test run down with it, making "did it
 * crash" unobservable from inside that same process. This fixture reports
 * its own readiness over stdout, then the parent test POSTs a real HTTP
 * request and observes whether THIS child process is still alive and
 * returned a clean response, or died.
 *
 * Requires --experimental-test-module-mocks (passed by the spawning test).
 */

// biome-ignore lint/performance/noNamespaceImport: the mock's namedExports needs the FULL real node:fs export surface to spread from (see realFsExportsExcludingNonConfigurable below); a named-import subset would silently drop every other node:fs export server/index.ts transitively uses.
import * as realFs from "node:fs";
import { Writable } from "node:stream";
import test from "node:test";

const MODULE_MOCKS_AVAILABLE = typeof (test.mock as { module?: unknown }).module === "function";
if (!MODULE_MOCKS_AVAILABLE) {
  throw new Error(
    "manual-upload-write-error-server fixture requires --experimental-test-module-mocks (spawned with it missing)"
  );
}

// The number of bytes to accept before the mocked stream errors -- large
// enough that at least one real write() call succeeds (proving the error
// fires mid-write, not before any byte is accepted), small enough the test
// fixture body can stay tiny.
const BYTES_BEFORE_ERROR = 64;

// F_OK/R_OK/W_OK/X_OK/constants are non-configurable own properties on
// node:fs's real module namespace object -- spreading them back into a
// mock's namedExports throws "Cannot redefine property" from node:test's
// own module-mock machinery. Every OTHER export (readFileSync, mkdir,
// closeSync, openSync, ...) must still be real: the rest of this server
// process's code (and everything server/index.ts transitively imports)
// depends on the genuine implementations, not just createWriteStream.
// The four F_OK/R_OK/W_OK/X_OK legacy access-mode constants exist on the
// real node:fs module at runtime but are not part of @types/node's typed
// export surface (only fs.constants.* is), so the exclusion is done via a
// runtime property-name filter rather than object destructuring.
const NON_CONFIGURABLE_FS_EXPORT_NAMES = new Set(["F_OK", "R_OK", "W_OK", "X_OK", "constants"]);
const realFsExportsExcludingNonConfigurable = Object.fromEntries(
  Object.entries(realFs).filter(([name]) => !NON_CONFIGURABLE_FS_EXPORT_NAMES.has(name))
);

test.mock.module("node:fs", {
  namedExports: {
    ...realFsExportsExcludingNonConfigurable,
    createWriteStream: (_path: string, _opts?: unknown) => {
      let written = 0;
      let errored = false;
      const stream = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          written += chunk.length;
          if (!errored && written >= BYTES_BEFORE_ERROR) {
            errored = true;
            const err = Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
            // Emitting asynchronously (not throwing synchronously from
            // write()) matches how a real disk-full condition surfaces --
            // the kernel/libuv layer reports it back to the stream via its
            // own 'error' event, not a synchronous throw from write().
            process.nextTick(() => stream.emit("error", err));
            return;
          }
          callback();
        },
      });
      return stream;
    },
  },
});

const { mkdtempSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { startServer } = await import("../../server/index.ts");

interface CloseableServer {
  close: (callback?: (err?: Error) => void) => unknown;
  closeAllConnections: () => void;
}
interface SchedulerManager {
  stop?: () => void;
}

const tmp = mkdtempSync(join(tmpdir(), "pdpp-manual-upload-write-error-"));
const server = (await startServer({
  asPort: 0,
  autoEnrollEligibleSchedules: false,
  dbPath: join(tmp, "pdpp.sqlite"),
  ownerAuthPassword: "write-error-fixture-owner-password",
  ownerAuthSubjectId: "owner_local",
  quiet: true,
  rsPort: 0,
})) as Awaited<ReturnType<typeof startServer>> & {
  asServer: CloseableServer;
  rsServer: CloseableServer;
  schedulerManager?: SchedulerManager;
};

process.stdout.write(`${JSON.stringify({ asPort: server.asPort, ready: true })}\n`);

async function shutdown(): Promise<void> {
  server.schedulerManager?.stop?.();
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(resolve)),
    new Promise((resolve) => server.rsServer.close(resolve)),
  ]);
  rmSync(tmp, { force: true, recursive: true });
  process.exit(0);
}

process.once("SIGTERM", () => {
  shutdown().catch(() => process.exit(2));
});
process.once("SIGINT", () => {
  shutdown().catch(() => process.exit(2));
});
