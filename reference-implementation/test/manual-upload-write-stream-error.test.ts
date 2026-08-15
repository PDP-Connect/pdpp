// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic, route-level regression test for manual-upload-terminal-redteam-0810
 * finding #1: `writeUploadBodyToPath`'s `createWriteStream` never had an
 * `'error'` listener attached, so a disk-full/IO error mid-write (ENOSPC,
 * EIO, permission revoked) was delivered to Node as an uncaught exception
 * REGARDLESS of the `end()` callback also observing the same error --
 * killing the entire server process for every in-flight request, not just
 * the one triggering the failing upload.
 *
 * This test spawns a REAL child server process (test/fixtures/manual-upload-write-error-server.ts)
 * with `node:fs`'s `createWriteStream` mocked to emit a genuine `'error'`
 * event after a partial write (simulating ENOSPC without needing an actual
 * full disk), POSTs a real streamed upload to it over HTTP, and asserts:
 *   1. the child process is STILL ALIVE after the request settles (proving
 *      no uncaught exception reached the process-level handler);
 *   2. the HTTP response is a clean typed 4xx/5xx error, not a hung
 *      connection or a raw socket reset from a crashed server;
 *   3. a SECOND, unrelated request against the SAME still-alive server
 *      succeeds normally -- proving the fix isn't just "this one response
 *      degrades gracefully" but that the whole process genuinely survived
 *      to serve other requests, which is the actual blast-radius property
 *      the finding is about.
 *
 * Must run as a genuinely separate OS process, not in-process via
 * `withServer`: if the fix regresses, the write-stream error becomes an
 * uncaught exception that would kill the SAME process running the test
 * runner, making "did it crash" unobservable from inside that process.
 *
 * Requires --experimental-test-module-mocks (the fixture throws immediately
 * if it's missing) -- checked at runtime via feature detection, same
 * pattern as manual-upload-whatsapp-no-whole-file-read.test.ts, so this
 * file loads and skips cleanly under a plain `pnpm test` run instead of
 * crashing at import time. Use `npm run test:whatsapp-no-whole-file-read`-style
 * invocation (see package.json's dedicated script) to actually run it.
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const FIXTURE_PATH = join(__dirname, "fixtures", "manual-upload-write-error-server.ts");
const OWNER_PASSWORD = "write-error-fixture-owner-password";

const MODULE_MOCKS_AVAILABLE = typeof (test.mock as { module?: unknown }).module === "function";

interface SpawnedServer {
  asUrl: string;
  child: ChildProcess;
  isAlive: () => boolean;
}

function spawnWriteErrorServer(): Promise<SpawnedServer> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--experimental-test-module-mocks", "--import", "tsx", FIXTURE_PATH], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let alive = true;
    child.once("exit", () => {
      alive = false;
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const lines = createInterface({ crlfDelay: Number.POSITIVE_INFINITY, input: child.stdout });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`write-error-server fixture did not become ready in time. stderr: ${stderr}`));
    }, 20_000);
    lines.on("line", (line) => {
      try {
        const parsed = JSON.parse(line) as { asPort?: number; ready?: boolean };
        if (parsed.ready === true && typeof parsed.asPort === "number") {
          clearTimeout(timeout);
          resolvePromise({
            asUrl: `http://127.0.0.1:${parsed.asPort}`,
            child,
            isAlive: () => alive,
          });
        }
      } catch {
        // Non-JSON diagnostic output before the ready line; ignore.
      }
    });
    child.once("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `write-error-server fixture exited before ready: code=${String(code)} signal=${String(signal)} stderr: ${stderr}`
        )
      );
    });
  });
}

function getRawSetCookieList(resp: Response): string[] {
  if (typeof resp.headers.getSetCookie === "function") {
    return resp.headers.getSetCookie();
  }
  const single = resp.headers.get("set-cookie");
  return single ? [single] : [];
}

function findSetCookiePair(setCookies: readonly string[], name: string): string | null {
  for (const header of setCookies) {
    const [firstPair] = header.split(";");
    if (firstPair?.startsWith(`${name}=`)) {
      return firstPair;
    }
  }
  return null;
}

const CSRF_FIELD_VALUE_RE = /<input type="hidden" name="_csrf" value="([^"]+)"\s*\/>/;

function extractCsrfFieldValue(html: string): string | null {
  const match = html.match(CSRF_FIELD_VALUE_RE);
  return match?.[1] ?? null;
}

async function login(asUrl: string): Promise<string> {
  const getLogin = await fetch(`${asUrl}/owner/login`, {
    headers: { Accept: "text/html" },
    redirect: "manual",
  });
  const csrfCookie = findSetCookiePair(getRawSetCookieList(getLogin), "pdpp_owner_csrf");
  const csrfField = extractCsrfFieldValue(await getLogin.text());
  const resp = await fetch(`${asUrl}/owner/login`, {
    body: new URLSearchParams({ _csrf: csrfField || "", password: OWNER_PASSWORD, return_to: "/" }).toString(),
    headers: {
      Accept: "text/html",
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: csrfCookie || "",
    },
    method: "POST",
    redirect: "manual",
  });
  const sessionCookie = findSetCookiePair(getRawSetCookieList(resp), "pdpp_owner_session");
  assert.ok(sessionCookie, `expected owner session cookie, got status ${resp.status}`);
  return sessionCookie;
}

async function registerConnector(asUrl: string, name: string): Promise<void> {
  const { readFileSync } = await import("node:fs");
  const manifest = JSON.parse(
    readFileSync(new URL(`../../packages/polyfill-connectors/manifests/${name}.json`, import.meta.url), "utf8")
  );
  const resp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(resp.status, 201, `register ${name} failed: ${resp.status}`);
}

test("manual-upload-terminal-redteam-0810 #1: a write-stream ENOSPC mid-upload does not crash the server process", {
  skip: MODULE_MOCKS_AVAILABLE
    ? false
    : "requires --experimental-test-module-mocks (spawns test/fixtures/manual-upload-write-error-server.ts directly)",
}, async () => {
  const server = await spawnWriteErrorServer();
  try {
    await registerConnector(server.asUrl, "whatsapp");
    const cookie = await login(server.asUrl);

    // Larger than the fixture's BYTES_BEFORE_ERROR (64) so the mocked
    // stream's error genuinely fires mid-write, not before any byte is
    // accepted.
    const body = "[6/5/24, 9:15:22 AM] Alice: ".padEnd(4096, "x");

    const url = new URL(`${server.asUrl}/_ref/connectors/whatsapp/manual-upload-staged-artifact`);
    url.searchParams.set("file_name", "WhatsApp Chat - WriteErrorProbe.txt");

    let resp: Response;
    try {
      resp = await fetch(url, {
        body,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/vnd.pdpp.manual-upload",
          Cookie: cookie,
        },
        method: "POST",
        // A regression here does not always fail fast: a crashed server
        // can leave the client's socket open with no response ever
        // arriving, which would otherwise hang this test (and the whole
        // suite) indefinitely instead of failing cleanly. Bound it so a
        // real regression is a fast, readable failure.
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      assert.fail(
        `expected a clean HTTP response even on a write-stream error, got a fetch-level failure (server likely crashed or hung mid-request): ${String(err)}`
      );
    }

    // Give the process a moment to have crashed if it were going to --
    // an uncaught exception triggers server/index.ts's own
    // process.exit(1) on nextTick, which would have already fired by
    // the time the HTTP response above was received in the working
    // case; this extra wait catches a slower crash path too.
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.ok(
      server.isAlive(),
      "the server process must still be alive after a write-stream error -- a disk-full condition on one upload must not kill the whole process"
    );

    // The failing request itself must get a clean typed error, not hang
    // or reset.
    assert.ok(
      resp.status >= 400 && resp.status < 600,
      `expected a clean error status for the failing upload, got ${resp.status}`
    );
    const body2 = (await resp.json().catch(() => null)) as { error?: { code?: string } } | null;
    assert.ok(body2?.error?.code, `expected a typed error envelope, got: ${JSON.stringify(body2)}`);

    // The real blast-radius proof: the SAME still-alive process serves a
    // completely unrelated, well-formed second request normally.
    const secondUpload = [
      "[6/5/24, 9:15:22 AM] Alice: Hello",
      "[6/5/24, 9:16:00 AM] Bob: This one is small and should stage fine.",
    ].join("\n");
    const secondUrl = new URL(`${server.asUrl}/_ref/connectors/whatsapp/manual-upload-staged-artifact`);
    secondUrl.searchParams.set("file_name", "WhatsApp Chat - AfterCrashProbe.txt");
    // This second request will ALSO hit the same mocked write stream
    // (every createWriteStream call in this fixture process errors after
    // BYTES_BEFORE_ERROR bytes) -- its own request must still fail
    // cleanly too, proving the SERVER stays healthy across repeated
    // failures, not just survives exactly once.
    const secondResp = await fetch(secondUrl, {
      body: secondUpload,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/vnd.pdpp.manual-upload",
        Cookie: cookie,
      },
      method: "POST",
    });
    assert.ok(server.isAlive(), "the server process must still be alive after a SECOND write-stream error");
    assert.ok(
      secondResp.status >= 400 && secondResp.status < 600,
      `expected a clean error status for the second failing upload too, got ${secondResp.status}`
    );
  } finally {
    server.child.kill("SIGTERM");
  }
});
