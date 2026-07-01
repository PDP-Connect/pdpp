/**
 * Behavioral proof of the isMainModule guard: importing a connector's
 * index.ts in a fresh child process must NOT fire the runtime bootstrap
 * (which would block on stdin waiting for a START message). The unit
 * tests in is-main-module.test.ts prove the predicate in isolation;
 * this proves the observable contract at a real module boundary.
 *
 * Method: spawn `tsx -e "import('./connectors/<name>/index.ts')"` with
 * a hard timeout + no stdin. The child must exit cleanly within a few
 * seconds. A hang (runtime waiting on stdin) fails the test.
 *
 * Coverage is intentionally narrow per the closure instruction — one
 * browser connector (chatgpt) and one non-browser connector
 * (claude_code). If either exhibits the hang-on-import bug, we'd add
 * more. If future connectors are added that wire bootstrap differently,
 * extend this matrix at that time.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "..");

// A generous per-import timeout. Cold tsx startup + the import's own
// module-initialization is usually <1.5s; anything over this is a
// hang. If the isMainModule guard were accidentally removed, the
// connector's runConnector or main() would fire and wait for stdin
// indefinitely.
const IMPORT_TIMEOUT_MS = 15_000;

interface ImportResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

interface EntrypointResult extends ImportResult {}

/** Spawn `tsx -e "import('<connector>/index.ts')"` and wait for exit.
 *  Stdin is 'ignore' so if the runtime fires, it can't receive a START
 *  and will park forever — surfacing as timedOut=true. */
function importConnectorInChild(connectorRelPath: string): Promise<ImportResult> {
  return new Promise((resolvePromise) => {
    const absPath = join(PACKAGE_ROOT, connectorRelPath);
    // Import as a file: URL so Node treats it as a module path under
    // ESM semantics; tsx handles .ts via --import tsx.
    const fileUrl = `file://${absPath}`;
    const code = `import(${JSON.stringify(fileUrl)}).then(() => process.exit(0)).catch((e) => { console.error('import failed:', e?.message ?? e); process.exit(2); });`;

    const child = spawn(process.execPath, ["--import", "tsx", "-e", code], {
      cwd: PACKAGE_ROOT,
      // stdin: ignore ensures a hung runtime waiting for START has no
      // way to receive one. stdout/stderr captured for diagnostic.
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // Ensure the child has a clean env for patchright; we're not
        // running browsers, just importing the module.
        PATCHRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
      },
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolvePromise({ code: null, signal: "SIGKILL", stderr, stdout, timedOut: true });
    }, IMPORT_TIMEOUT_MS);

    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stderr, stdout, timedOut: false });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({
        code: null,
        signal: null,
        stderr: `spawn error: ${err.message}\n${stderr}`,
        stdout,
        timedOut: false,
      });
    });
  });
}

/** Spawn a real connector entrypoint with stdin closed. This exercises the
 * protocol bootstrap path, not a module import. */
function runConnectorEntrypointWithClosedStdin(connectorRelPath: string): Promise<EntrypointResult> {
  return new Promise((resolvePromise) => {
    const absPath = join(PACKAGE_ROOT, connectorRelPath);
    const child = spawn(process.execPath, ["--import", "tsx/esm", absPath], {
      cwd: PACKAGE_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATCHRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
      },
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolvePromise({ code: null, signal: "SIGKILL", stderr, stdout, timedOut: true });
    }, IMPORT_TIMEOUT_MS);

    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stderr, stdout, timedOut: false });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({
        code: null,
        signal: null,
        stderr: `spawn error: ${err.message}\n${stderr}`,
        stdout,
        timedOut: false,
      });
    });
  });
}

test("importing chatgpt/index.ts (browser connector) in a child process exits cleanly without firing runConnector", {
  timeout: IMPORT_TIMEOUT_MS + 5000,
}, async () => {
  const result = await importConnectorInChild("connectors/chatgpt/index.ts");
  assert.equal(result.timedOut, false, `child hung: stderr=${result.stderr}`);
  assert.equal(
    result.code,
    0,
    `child exited non-zero: code=${result.code} signal=${result.signal} stderr=${result.stderr}`
  );
});

test("importing claude_code/index.ts (non-browser connector) in a child process exits cleanly without firing runConnector", {
  timeout: IMPORT_TIMEOUT_MS + 5000,
}, async () => {
  const result = await importConnectorInChild("connectors/claude_code/index.ts");
  assert.equal(result.timedOut, false, `child hung: stderr=${result.stderr}`);
  assert.equal(
    result.code,
    0,
    `child exited non-zero: code=${result.code} signal=${result.signal} stderr=${result.stderr}`
  );
});

test("a connector entrypoint with closed stdin fails closed instead of hanging before START", {
  timeout: IMPORT_TIMEOUT_MS + 5000,
}, async () => {
  const result = await runConnectorEntrypointWithClosedStdin("connectors/github/index.ts");
  assert.equal(result.timedOut, false, `child hung: stderr=${result.stderr}`);
  assert.equal(result.code, 1, `expected fail-closed exit code 1: stdout=${result.stdout} stderr=${result.stderr}`);
  assert.match(result.stdout, /"type":"DONE"/, "missing START should emit a terminal DONE envelope");
  assert.match(result.stdout, /"status":"failed"/, "missing START should fail the DONE envelope");
  assert.match(result.stdout, /Missing START message before stdin closed/);
});
