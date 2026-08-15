// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic countertest: proves the production
 * `manual-upload-validation-preview` route never buffers a Netflix .zip
 * export's whole content in memory when validating it.
 *
 * manual-upload-terminal-redteam-0810 finding (Netflix .zip whole-buffer
 * gap): `netflix_export/validation.ts` — the module actually invoked by
 * `POST /manual-upload-validation-preview` — still constructed a `Buffer`
 * and called the buffer-only zip reader, because `netflix_export.json`
 * never declared `validation.file_backed: true` and
 * `validateManualUploadArtifactFromFileByKind` had no entry for
 * `netflix_viewing_activity`. The connector-level tests in
 * `netflix_export/no-whole-file-read.test.ts` only ever exercise
 * `extractViewingActivityArtifactFromFile` and `index.ts`'s collection
 * path directly -- neither one ever POSTs through the real RS validation
 * route, so the exact call site the finding named (`validation.ts`'s zip
 * branch, reached from Preview) had zero test coverage of this property.
 *
 * `node:fs/promises.readFile` is mocked BEFORE `server/index.ts` (and
 * everything it transitively imports, including
 * `ref-manual-upload-draft-connection.ts`) is loaded, so every call the
 * production code makes through that import binding is observed --
 * mirroring `manual-upload-whatsapp-no-whole-file-read.test.ts`'s proof
 * shape exactly. Flag requirement checked at RUNTIME via feature
 * detection (`test.mock.module` is `undefined`, not a throwing stub, when
 * `--experimental-test-module-mocks` is absent), so this file loads and
 * skips cleanly under a plain `pnpm test` run instead of crashing at
 * import time. Use `npm run test:whatsapp-no-whole-file-read` (which
 * passes the flag) to actually exercise this proof -- same dedicated
 * script the WhatsApp proof already uses, since both need the identical
 * flag.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
// biome-ignore lint/performance/noNamespaceImport: test.mock.module's namedExports needs the FULL real export surface to spread from (see below); a named-import subset would silently drop every other node:fs/promises export this server transitively uses.
import * as realFsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const OWNER_PASSWORD = "netflix-no-whole-file-read-owner-password";
const OWNER_SUBJECT_ID = "owner_local";

const readFileCallArgs: unknown[][] = [];

const MODULE_MOCKS_AVAILABLE = typeof (test.mock as { module?: unknown }).module === "function";

if (MODULE_MOCKS_AVAILABLE) {
  // Called as `test.mock.module(...)`, not through an extracted reference --
  // see manual-upload-whatsapp-no-whole-file-read.test.ts's identical guard
  // for why (MockTracker.module's `this`-binding).
  test.mock.module("node:fs/promises", {
    namedExports: {
      ...realFsPromises,
      readFile: (...args: Parameters<typeof realFsPromises.readFile>) => {
        readFileCallArgs.push(args);
        return (realFsPromises.readFile as typeof realFsPromises.readFile)(...args);
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
  const tmp = mkdtempSync(join(largeFixtureBaseDir(), "pdpp-netflix-no-whole-read-"));
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

function zipHeader(signature: number, size: number): Buffer {
  const header = Buffer.alloc(size);
  header.writeUInt32LE(signature, 0);
  return header;
}

/** Minimal well-formed STORED-method zip containing a ViewingActivity.csv
 *  entry, mirroring the shared fixture shape used across this connector's
 *  own test suite. */
function makeNetflixZip(csvContent: string): Buffer {
  const name = Buffer.from("ViewingActivity.csv", "utf8");
  const data = Buffer.from(csvContent, "utf8");
  const local = zipHeader(0x04_03_4b_50, 30);
  local.writeUInt16LE(0x08_00, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(0, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);

  const directory = zipHeader(0x02_01_4b_50, 46);
  directory.writeUInt16LE(20, 4);
  directory.writeUInt16LE(20, 6);
  directory.writeUInt16LE(0x08_00, 8);
  directory.writeUInt16LE(0, 10);
  directory.writeUInt32LE(0, 16);
  directory.writeUInt32LE(data.length, 20);
  directory.writeUInt32LE(data.length, 24);
  directory.writeUInt16LE(name.length, 28);
  directory.writeUInt32LE(0, 42);

  const centralBytes = Buffer.concat([directory, name]);
  const end = zipHeader(0x06_05_4b_50, 22);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(local.length + name.length + data.length, 16);

  return Buffer.concat([local, name, data, centralBytes, end]);
}

test("manual-upload-terminal-redteam-0810: production validation-preview never calls fs/promises.readFile on a Netflix .zip staged artifact path", {
  skip: MODULE_MOCKS_AVAILABLE
    ? false
    : "requires --experimental-test-module-mocks (npm run test:whatsapp-no-whole-file-read)",
}, async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, "netflix_export");
    const cookie = await login(asUrl);

    const csv = [
      "Title,Date",
      '"Some Show: Season 1: Episode 1",01/15/2024',
      '"Some Show: Season 1: Episode 2",01/16/2024',
    ].join("\n");
    const zip = makeNetflixZip(csv);

    const callsBefore = readFileCallArgs.length;

    const url = new URL(`${asUrl}/_ref/connectors/netflix-export/manual-upload-validation-preview`);
    url.searchParams.set("file_name", "netflix-export.zip");
    const resp = await fetch(url, {
      body: zip,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/vnd.pdpp.manual-upload",
        Cookie: cookie,
      },
      method: "POST",
    });
    const preview = (await resp.json()) as { validation?: { status?: string; detected_format?: string } };
    assert.equal(resp.status, 200, JSON.stringify(preview));
    assert.equal(preview.validation?.status, "valid", JSON.stringify(preview));
    assert.equal(preview.validation?.detected_format, "viewing_activity_zip", JSON.stringify(preview));

    // The one and only assertion that matters: across the entire
    // staging + validation lifecycle for this Netflix .zip preview,
    // node:fs/promises.readFile was never called with a path pointing
    // at this artifact's own staged file. registerConnector/login/etc
    // may legitimately call readFile for unrelated setup (manifest
    // JSON, HTML templates) -- this assertion is scoped to THIS
    // artifact's own bytes.
    const callsDuringThisPreview = readFileCallArgs.slice(callsBefore);
    const readFileCallsOnStagedContent = callsDuringThisPreview.filter(([pathArg]) => {
      const pathStr = String(pathArg);
      return pathStr.includes("_staging") || pathStr.toLowerCase().includes("netflix");
    });
    assert.deepEqual(
      readFileCallsOnStagedContent,
      [],
      `expected zero readFile() calls against the previewed Netflix .zip artifact's own path, found: ${JSON.stringify(readFileCallsOnStagedContent)}`
    );
  });
});
