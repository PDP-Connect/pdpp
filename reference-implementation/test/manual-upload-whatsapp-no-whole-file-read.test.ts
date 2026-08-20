// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic countertests: prove the production staged-upload route
 * (POST /_ref/connectors/whatsapp/manual-upload-staged-artifact ->
 * validateAndStageArtifact -> validateStagedArtifact) never buffers a
 * staged WhatsApp artifact's whole content in memory.
 *
 * Two complementary proofs, each catching a different regression shape:
 *
 * 1. A call-interception proof (not a memory-growth heuristic):
 *    `node:fs/promises.readFile` is mocked BEFORE `server/index.ts` (and
 *    everything it transitively imports, including
 *    ref-manual-upload-draft-connection.ts) is loaded, so every call the
 *    production code makes through that import binding is observed. Only
 *    catches THAT specific symbol — a rewrite that buffers via
 *    `node:fs`'s `readFileSync`, or `createReadStream` + manual chunk
 *    concatenation, would slip past this proof undetected (this is exactly
 *    how an earlier version of this route regressed past an
 *    import-mock-only proof — see the independent review that flagged it).
 *
 * 2. An OUTCOME-based memory proof that doesn't care which API caused the
 *    buffering: a 1.9 GiB WhatsApp .txt export (realistic message density,
 *    ~13.6M messages — the exact scale an independent review flagged as
 *    still crashing) is uploaded via node:http + a Readable stream, with
 *    `global.gc()` forced immediately before and after the upload settles
 *    (this test runs the server in-process via `withServer`, so GC can be
 *    forced directly rather than relying on RSS sampling, eliminating
 *    GC-timing noise entirely). node:http, NOT fetch()/ReadableStream:
 *    this task's own investigation found that Node's fetch() client, when
 *    sending a ReadableStream body against an in-process server, can
 *    attribute several GB of the CLIENT's own send-side buffering to what
 *    looks like server memory growth if measured via peak-RSS sampling
 *    during the request — a false positive that would make a genuinely
 *    bounded server look broken. node:http + Readable.pipe() showed no
 *    such artifact in isolation testing. A route that ever holds the whole
 *    file (or a same-order-of-magnitude copy of it) in memory at once
 *    produces a measurable, repeatable `external`-memory delta; one that
 *    only ever holds a single disk-read chunk at a time does not.
 *
 * A complementary DETERMINISTIC (non-RSS) bounded-memory capability oracle
 * lives at the connector level — see parsers.test.ts's "bounded-memory
 * oracle" tests, which assert on the streaming API's own concurrency
 * contract (peak concurrently-alive message count) rather than any
 * absolute byte measurement.
 *
 * manual-upload-final-redteam-0810 finding #1: this file's original two
 * proofs only ever POSTed to manual-upload-staged-artifact, leaving
 * manual-upload-validation-preview and the legacy manual-upload-draft-connection
 * completely unproven — both fully buffered the request body via
 * bodyAsBuffer(req.body) before validation, reachable from the console's
 * "Preview" button with no client-side size gate. Both routes now share the
 * SAME streaming primitive (stageAcceptedUpload -> writeUploadBodyToPath)
 * the staged-artifact route already used exclusively; the tests below prove
 * it for these two routes specifically, at a smaller (150 MiB) scale than
 * the 1.9 GiB staged-artifact proof above -- the underlying primitive's
 * boundedness is already proven at full scale; these two tests prove these
 * two NEW call sites genuinely route through it rather than reintroducing
 * their own buffering.
 *
 * Each test's flag requirement is independent (the call-interception proof
 * needs --experimental-test-module-mocks; the outcome proof needs
 * --expose-gc) and is checked at RUNTIME via feature detection, not an
 * assumed flag name -- `test.mock.module` is `undefined` (not a throwing
 * stub) when the flag is absent, confirmed directly:
 * `node --import tsx -e "import t from 'node:test'; console.log(typeof
 * t.mock.module)"` prints `undefined` without the flag, `function` with it.
 * This means the file loads cleanly either way; each test SKIPS (via
 * node:test's native `{ skip }` option, the same pattern
 * run-interaction-stream-cdp-live.test.ts already uses for its own
 * opt-in-only live proof) rather than crashing at module-import time under
 * a plain `pnpm test` run, which has no per-file way to forward these
 * flags (scripts/run-tests.ts's `effectiveArgs` is shared across every
 * discovered file). Use `npm run test:whatsapp-no-whole-file-read` (which
 * does pass both flags) to actually exercise both proofs.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import * as realFsPromises from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

const OWNER_PASSWORD = "no-whole-file-read-owner-password";
const OWNER_SUBJECT_ID = "owner_local";

const readFileCallArgs: unknown[][] = [];

// biome-ignore lint/suspicious/noExplicitAny: node:test's MockTracker.module is only present with --experimental-test-module-mocks; the base @types/node signature doesn't expose it unconditionally.
const MODULE_MOCKS_AVAILABLE = typeof (test.mock as any).module === "function";

if (MODULE_MOCKS_AVAILABLE) {
  // Called as `test.mock.module(...)`, not through an extracted reference:
  // MockTracker.module is a bound method relying on `this` being the
  // tracker instance itself -- capturing it as `const mockModule =
  // test.mock.module` and invoking `mockModule(...)` loses that binding
  // and throws `Cannot read properties of undefined (reading '#mocks')`
  // (a private class field access with no `this`), confirmed by direct
  // reproduction while writing this guard.
  test.mock.module("node:fs/promises", {
    namedExports: {
      ...realFsPromises,
      readFile: (...args: Parameters<typeof realFsPromises.readFile>) => {
        readFileCallArgs.push(args);
        // biome-ignore lint/suspicious/noExplicitAny: passthrough to the real implementation; args shape is whatever the real overload accepts.
        return (realFsPromises.readFile as any)(...args);
      },
    },
  });
}

interface CloseableServer {
  close: (callback?: (err?: Error) => void) => unknown;
  closeAllConnections: () => void;
}
interface SchedulerManager {
  stop?: () => void;
}

// os.tmpdir() (/tmp) is typically RAM-backed (tmpfs) in this environment --
// fine for small fixtures, but the 1.9 GiB upload this file's H3 test
// stages can exceed tmpfs's free space (measured: 1.7 GiB free against a
// 16 GiB tmpfs sized for RAM, not disk). Prefer a disk-backed location when
// one is available, mirroring the connector-side large-fixture tests'
// PDPP_TEST_LARGE_FIXTURE_DIR override.
function largeFixtureBaseDir(): string {
  return process.env.PDPP_TEST_LARGE_FIXTURE_DIR || tmpdir();
}

async function withServer<T>(fn: (ctx: { asUrl: string; tmp: string }) => Promise<T>): Promise<T> {
  const { startServer } = await import("../server/index.ts");
  type StartedServer = Awaited<ReturnType<typeof startServer>> & {
    asServer: CloseableServer;
    rsServer: CloseableServer;
    schedulerManager?: SchedulerManager;
  };
  const tmp = mkdtempSync(join(largeFixtureBaseDir(), "pdpp-manual-upload-no-whole-read-"));
  const server = (await startServer({
    asPort: 0,
    autoEnrollEligibleSchedules: false,
    dbPath: join(tmp, "pdpp.sqlite"),
    ownerAuthPassword: OWNER_PASSWORD,
    ownerAuthSubjectId: OWNER_SUBJECT_ID,
    quiet: true,
    rsPort: 0,
  })) as StartedServer;
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    return await fn({ asUrl, tmp });
  } finally {
    server.schedulerManager?.stop?.();
    server.asServer.closeAllConnections();
    server.rsServer.closeAllConnections();
    await Promise.allSettled([
      new Promise((resolve) => server.asServer.close(resolve)),
      new Promise((resolve) => server.rsServer.close(resolve)),
    ]);
    rmSync(tmp, { force: true, recursive: true });
  }
}

interface RawHttpResponse {
  body: string;
  headers: http.IncomingHttpHeaders;
  status: number | undefined;
}

/**
 * node:http (not fetch + ReadableStream): this task's own investigation
 * found that Node's fetch()/undici, when sending a ReadableStream body
 * against an in-process server (client and server sharing one Node
 * process, as withServer does), attributes the CLIENT's own send-side
 * buffering to what looks like server memory growth if measured via peak
 * RSS sampling during the request -- up to several GB of false signal on
 * a ~2 GiB body in one measured case. node:http + a Readable .pipe()
 * showed no such artifact in the same isolation test. This test's
 * before/after-settle `external` delta (not peak-during-request sampling)
 * is less exposed to that specific failure mode, but node:http removes
 * the risk entirely rather than relying on that distinction holding.
 */
function httpRequestStream(options: http.RequestOptions, bodyStream?: Readable): Promise<RawHttpResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({ body: Buffer.concat(chunks).toString(), headers: res.headers, status: res.statusCode })
      );
    });
    req.on("error", reject);
    if (bodyStream) {
      bodyStream.pipe(req);
    } else {
      req.end();
    }
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
    const firstPair = header.split(";")[0];
    if (firstPair?.startsWith(`${name}=`)) {
      return firstPair;
    }
  }
  return null;
}

function extractCsrfFieldValue(html: string): string | null {
  const match = html.match(/<input type="hidden" name="_csrf" value="([^"]+)"\s*\/>/);
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

interface ArtifactBody {
  artifact_id?: string;
  status?: string;
  validation?: { status?: string };
}

async function waitForArtifact(
  asUrl: string,
  cookie: string,
  artifactId: string,
  expectedStatuses: readonly string[],
  maxAttempts = 80
): Promise<ArtifactBody> {
  const statuses = new Set(expectedStatuses);
  let latest: ArtifactBody = {};
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: bounded poll loop, mirrors the sibling route test's helper.
    const resp = await fetch(`${asUrl}/_ref/manual-upload/artifacts/${encodeURIComponent(artifactId)}`, {
      headers: { Accept: "application/json", Cookie: cookie },
    });
    latest = (await resp.json()) as ArtifactBody;
    if (resp.status === 200 && latest.status !== undefined && statuses.has(latest.status)) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return latest;
}

test("production staged WhatsApp .txt upload never calls fs/promises.readFile on the staged artifact path", {
  skip: MODULE_MOCKS_AVAILABLE
    ? false
    : "requires --experimental-test-module-mocks (npm run test:whatsapp-no-whole-file-read)",
}, async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, "whatsapp");
    const cookie = await login(asUrl);

    const body = [
      "[6/5/24, 9:15:22 AM] Alice: Hello",
      "[6/5/24, 9:16:00 AM] Bob: <attached: IMG-20240605-WA0001.jpg>",
    ].join("\n");

    const callsBefore = readFileCallArgs.length;

    const url = new URL(`${asUrl}/_ref/connectors/whatsapp/manual-upload-staged-artifact`);
    url.searchParams.set("file_name", "WhatsApp Chat - Alice.txt");
    const resp = await fetch(url, {
      body,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/vnd.pdpp.manual-upload",
        Cookie: cookie,
      },
      method: "POST",
    });
    const staged = (await resp.json()) as ArtifactBody;
    assert.equal(resp.status, 202, JSON.stringify(staged));
    assert.ok(staged.artifact_id, "expected an artifact_id");

    const done = await waitForArtifact(asUrl, cookie, staged.artifact_id ?? "", ["staged", "failed"]);
    assert.equal(done.status, "staged", JSON.stringify(done));
    assert.equal(done.validation?.status, "valid");

    // The one and only assertion that matters: across the ENTIRE
    // upload-write + validate + stage lifecycle for this WhatsApp .txt
    // artifact, node:fs/promises.readFile was never called with a path
    // pointing at this artifact's own staged file (whether _staging/... or
    // its post-rename final location). registerConnector/login/etc may
    // legitimately call readFile for unrelated setup (manifest JSON, HTML
    // templates) — this assertion is scoped to THIS artifact's own bytes,
    // not "readFile was never called at all".
    const callsDuringThisUpload = readFileCallArgs.slice(callsBefore);
    const readFileCallsOnStagedContent = callsDuringThisUpload.filter(([pathArg]) => {
      const pathStr = String(pathArg);
      return pathStr.includes("_staging") || pathStr.toLowerCase().includes("whatsapp chat");
    });
    assert.deepEqual(
      readFileCallsOnStagedContent,
      [],
      `expected zero readFile() calls against the staged WhatsApp artifact's own path, found: ${JSON.stringify(readFileCallsOnStagedContent)}`
    );
  });
});

test("outcome proof (H3): a 1.9 GiB staged WhatsApp .txt upload with realistic message density does not raise server external memory anywhere near the file size", {
  skip: typeof global.gc === "function" ? false : "requires --expose-gc (npm run test:whatsapp-no-whole-file-read)",
}, async () => {
  const originalCap = process.env.WHATSAPP_MAX_MESSAGE_COUNT;
  // Realistic message DENSITY (not the pathological single-multi-line-
  // message shape the smaller predecessor test used), at a scale (1.9 GiB,
  // ~13.6M messages) that reproduces the exact scenario an independent
  // review flagged as still crashing: WHATSAPP_MAX_MESSAGE_COUNT is raised
  // so the run isn't short-circuited by H1's cap before this test's memory
  // proof (about raw file bytes, not message count) gets to run.
  process.env.WHATSAPP_MAX_MESSAGE_COUNT = "20000000";
  try {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, "whatsapp");
      const cookie = await login(asUrl);
      const port = Number(new URL(asUrl).port);

      const targetBytes = Math.floor(1.9 * 1024 * 1024 * 1024);
      const oneMessage =
        "[6/5/24, 9:15:22 AM] Alice: This is a realistic conversational message with a moderate amount of text content.\n";
      const chunkText = oneMessage.repeat(200);
      const chunkBytes = Buffer.byteLength(chunkText, "utf8");
      let sent = 0;
      const bodyStream = new Readable({
        read() {
          if (sent >= targetBytes) {
            this.push(null);
            return;
          }
          this.push(Buffer.from(chunkText, "utf8"));
          sent += chunkBytes;
        },
      });

      global.gc?.();
      const before = process.memoryUsage();

      const uploadResp = await httpRequestStream(
        {
          headers: { Accept: "application/json", "Content-Type": "application/vnd.pdpp.manual-upload", Cookie: cookie },
          hostname: "localhost",
          method: "POST",
          path: `/_ref/connectors/whatsapp/manual-upload-staged-artifact?file_name=${encodeURIComponent("WhatsApp Chat - HeapDelta.txt")}`,
          port,
        },
        bodyStream
      );
      const staged = JSON.parse(uploadResp.body) as ArtifactBody;
      assert.equal(uploadResp.status, 202, JSON.stringify(staged));
      assert.ok(staged.artifact_id, "expected an artifact_id");

      const done = await waitForArtifact(asUrl, cookie, staged.artifact_id ?? "", ["staged", "failed"], 6000);
      assert.equal(done.status, "staged", JSON.stringify(done));
      assert.equal(done.validation?.status, "valid");

      global.gc?.();
      const after = process.memoryUsage();
      const externalGrowthBytes = after.external - before.external;

      // `external` (V8's own accounting of ArrayBuffer/Buffer-backed
      // allocations), NOT `heapUsed` or `rss`: a whole-file readFileSync()/
      // Buffer.alloc() allocates OUTSIDE the V8-managed heap `heapUsed`
      // tracks, so a whole-file-buffered regression shows as ~0 MiB of
      // heapUsed growth (measured) -- a threshold on heapUsed would never
      // catch it. `rss` was tried too and rejected: an injected
      // readFileSync() regression measured a SIMILAR rss delta to the
      // correct streaming path at some scales (page-cache/paging effects
      // swamp the signal), while `external` cleanly separated them at the
      // 200 MiB scale this test was originally calibrated at (~0-1 MiB
      // legitimate vs. ~200-202 MiB regression, reproducible). 300 MiB is
      // asserted here (not the measured legitimate delta) to leave real
      // margin at this larger 1.9 GiB scale while staying far below "a
      // whole-file-scale buffer got retained".
      assert.ok(
        externalGrowthBytes < 300 * 1024 * 1024,
        `expected server external (Buffer/ArrayBuffer) memory to grow by well under the 1.9 GiB file size, grew by ${String(
          Math.round(externalGrowthBytes / 1024 / 1024)
        )} MiB -- staged-upload path may be buffering the whole artifact`
      );
    });
  } finally {
    if (originalCap === undefined) {
      delete process.env.WHATSAPP_MAX_MESSAGE_COUNT;
    } else {
      process.env.WHATSAPP_MAX_MESSAGE_COUNT = originalCap;
    }
  }
});

function largeWhatsAppBodyStream(targetBytes: number): Readable {
  const oneMessage =
    "[6/5/24, 9:15:22 AM] Alice: This is a realistic conversational message with a moderate amount of text content.\n";
  const chunkText = oneMessage.repeat(200);
  const chunkBytes = Buffer.byteLength(chunkText, "utf8");
  let sent = 0;
  return new Readable({
    read() {
      if (sent >= targetBytes) {
        this.push(null);
        return;
      }
      this.push(Buffer.from(chunkText, "utf8"));
      sent += chunkBytes;
    },
  });
}

test("manual-upload-final-redteam-0810 #1: production validation-preview never calls fs/promises.readFile on the staged artifact path", {
  skip: MODULE_MOCKS_AVAILABLE
    ? false
    : "requires --experimental-test-module-mocks (npm run test:whatsapp-no-whole-file-read)",
}, async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, "whatsapp");
    const cookie = await login(asUrl);

    const body = [
      "[6/5/24, 9:15:22 AM] Alice: Hello",
      "[6/5/24, 9:16:00 AM] Bob: <attached: IMG-20240605-WA0001.jpg>",
    ].join("\n");

    const callsBefore = readFileCallArgs.length;

    const url = new URL(`${asUrl}/_ref/connectors/whatsapp/manual-upload-validation-preview`);
    url.searchParams.set("file_name", "WhatsApp Chat - Alice.txt");
    const resp = await fetch(url, {
      body,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/vnd.pdpp.manual-upload",
        Cookie: cookie,
      },
      method: "POST",
    });
    const preview = (await resp.json()) as { validation?: { status?: string } };
    assert.equal(resp.status, 200, JSON.stringify(preview));
    assert.equal(preview.validation?.status, "valid");

    const callsDuringThisPreview = readFileCallArgs.slice(callsBefore);
    const readFileCallsOnStagedContent = callsDuringThisPreview.filter(([pathArg]) => {
      const pathStr = String(pathArg);
      return pathStr.includes("_staging") || pathStr.toLowerCase().includes("whatsapp chat");
    });
    assert.deepEqual(
      readFileCallsOnStagedContent,
      [],
      `expected zero readFile() calls against the previewed WhatsApp artifact's own path, found: ${JSON.stringify(readFileCallsOnStagedContent)}`
    );
  });
});

test("manual-upload-final-redteam-0810 #1: outcome proof, a 150 MiB validation-preview upload does not raise server external memory anywhere near the file size", {
  skip: typeof global.gc === "function" ? false : "requires --expose-gc (npm run test:whatsapp-no-whole-file-read)",
}, async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, "whatsapp");
    const cookie = await login(asUrl);
    const port = Number(new URL(asUrl).port);

    const targetBytes = 150 * 1024 * 1024;
    const bodyStream = largeWhatsAppBodyStream(targetBytes);

    global.gc?.();
    const before = process.memoryUsage();

    const previewResp = await httpRequestStream(
      {
        headers: { Accept: "application/json", "Content-Type": "application/vnd.pdpp.manual-upload", Cookie: cookie },
        hostname: "localhost",
        method: "POST",
        path: `/_ref/connectors/whatsapp/manual-upload-validation-preview?file_name=${encodeURIComponent("WhatsApp Chat - PreviewDelta.txt")}`,
        port,
      },
      bodyStream
    );
    const preview = JSON.parse(previewResp.body) as { validation?: { status?: string } };
    assert.equal(previewResp.status, 200, JSON.stringify(preview));
    assert.equal(preview.validation?.status, "valid");

    global.gc?.();
    const after = process.memoryUsage();
    const externalGrowthBytes = after.external - before.external;

    assert.ok(
      externalGrowthBytes < 100 * 1024 * 1024,
      `expected server external (Buffer/ArrayBuffer) memory to grow by well under the 150 MiB file size, grew by ${String(
        Math.round(externalGrowthBytes / 1024 / 1024)
      )} MiB -- validation-preview may be buffering the whole artifact`
    );
  });
});

test("manual-upload-final-redteam-0810 #1: outcome proof, a 150 MiB legacy manual-upload-draft-connection upload does not raise server external memory anywhere near the file size", {
  skip: typeof global.gc === "function" ? false : "requires --expose-gc (npm run test:whatsapp-no-whole-file-read)",
}, async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, "whatsapp");
    const cookie = await login(asUrl);
    const port = Number(new URL(asUrl).port);

    const targetBytes = 150 * 1024 * 1024;
    const bodyStream = largeWhatsAppBodyStream(targetBytes);

    global.gc?.();
    const before = process.memoryUsage();

    const createResp = await httpRequestStream(
      {
        headers: { Accept: "application/json", "Content-Type": "application/vnd.pdpp.manual-upload", Cookie: cookie },
        hostname: "localhost",
        method: "POST",
        path: `/_ref/connectors/whatsapp/manual-upload-draft-connection?file_name=${encodeURIComponent("WhatsApp Chat - CreateDelta.txt")}`,
        port,
      },
      bodyStream
    );
    const created = JSON.parse(createResp.body) as { validation?: { status?: string }; connection_id?: string };
    assert.equal(createResp.status, 201, JSON.stringify(created));
    assert.equal(created.validation?.status, "valid");
    assert.ok(created.connection_id, "expected a connection_id");

    global.gc?.();
    const after = process.memoryUsage();
    const externalGrowthBytes = after.external - before.external;

    assert.ok(
      externalGrowthBytes < 100 * 1024 * 1024,
      `expected server external (Buffer/ArrayBuffer) memory to grow by well under the 150 MiB file size, grew by ${String(
        Math.round(externalGrowthBytes / 1024 / 1024)
      )} MiB -- manual-upload-draft-connection may be buffering the whole artifact`
    );
  });
});
