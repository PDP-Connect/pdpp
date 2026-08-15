// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic countertest: proves the production
 * `manual-upload-validation-preview` route never buffers a Google Maps
 * Timeline export's whole content in memory when validating it.
 *
 * Exercises the fix end-to-end through the REAL route, not just the
 * connector module in isolation: `node:fs/promises.readFile` is mocked
 * before `server/index.ts` loads, a large sparse Timeline export (many
 * small, independently-timestamped points, the real shape of a multi-year
 * export) is POSTed through the actual route, and zero `readFile()` calls
 * against the staged artifact's own path are asserted.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
// biome-ignore lint/performance/noNamespaceImport: test.mock.module's namedExports needs the FULL real export surface to spread from; a named-import subset would silently drop every other node:fs/promises export this server transitively uses.
import * as realFsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const OWNER_PASSWORD = "google-maps-no-whole-file-read-owner-password";
const OWNER_SUBJECT_ID = "owner_local";

const readFileCallArgs: unknown[][] = [];

const MODULE_MOCKS_AVAILABLE = typeof (test.mock as { module?: unknown }).module === "function";

if (MODULE_MOCKS_AVAILABLE) {
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
  const tmp = mkdtempSync(join(largeFixtureBaseDir(), "pdpp-google-maps-no-whole-read-"));
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

/** Streams a sparse Timeline export body directly, without ever holding the
 *  whole thing as one in-memory string -- the client-side proof mirrors the
 *  server-side one: neither end of this test buffers the large artifact. */
function* sparseTimelineChunks(pointCount: number): Generator<string> {
  yield '{"locations":[';
  for (let i = 0; i < pointCount; i += 1) {
    const point = {
      accuracy: 5,
      latitudeE7: 377_749_000 + i,
      longitudeE7: -1_224_194_000 - i,
      timestampMs: String(1_717_595_122_000 + i * 1000),
    };
    yield (i === 0 ? "" : ",") + JSON.stringify(point);
  }
  yield "]}";
}

test("production validation-preview never calls fs/promises.readFile on a large sparse Google Maps Timeline staged artifact path", {
  skip: MODULE_MOCKS_AVAILABLE
    ? false
    : "requires --experimental-test-module-mocks (npm run test:whatsapp-no-whole-file-read)",
}, async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, "google_maps");
    const cookie = await login(asUrl);

    // 20,000 small, independently-timestamped points spread across the
    // body -- sparse, the real shape of a multi-year Timeline export, not
    // one giant element.
    const POINT_COUNT = 20_000;

    const callsBefore = readFileCallArgs.length;

    const url = new URL(`${asUrl}/_ref/connectors/google-maps/manual-upload-validation-preview`);
    url.searchParams.set("file_name", "Timeline.json");
    // fetch's TS-lib RequestInit type doesn't accept a ReadableStream body
    // even with duplex: "half" set, though it's valid at runtime (and
    // required for streaming a request body without buffering it first) --
    // the same gap Node's own fetch implementation has relative to the
    // whatwg-fetch spec's BodyInit union. Cast through unknown, not `any`,
    // to keep every OTHER field in this object still type-checked.
    const requestInit = {
      body: ReadableStream.from(sparseTimelineChunks(POINT_COUNT)),
      duplex: "half",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/vnd.pdpp.manual-upload",
        Cookie: cookie,
      },
      method: "POST",
    } satisfies Record<string, unknown>;
    const resp = await fetch(url, requestInit as unknown as RequestInit);
    const preview = (await resp.json()) as {
      validation?: { detected_format?: string; estimated_points?: number; status?: string };
    };
    assert.equal(resp.status, 200, JSON.stringify(preview));
    assert.equal(preview.validation?.status, "valid", JSON.stringify(preview));
    assert.equal(preview.validation?.detected_format, "legacy_records", JSON.stringify(preview));
    assert.equal(preview.validation?.estimated_points, POINT_COUNT, JSON.stringify(preview));

    // The one and only assertion that matters: across the entire
    // staging + validation lifecycle for this large sparse Google Maps
    // preview, node:fs/promises.readFile was never called with a path
    // pointing at this artifact's own staged file. registerConnector/
    // login/etc may legitimately call readFile for unrelated setup
    // (manifest JSON, HTML templates) -- this assertion is scoped to
    // THIS artifact's own bytes.
    const callsDuringThisPreview = readFileCallArgs.slice(callsBefore);
    const readFileCallsOnStagedContent = callsDuringThisPreview.filter(([pathArg]) => {
      const pathStr = String(pathArg);
      return pathStr.includes("_staging") || pathStr.toLowerCase().includes("timeline");
    });
    assert.deepEqual(
      readFileCallsOnStagedContent,
      [],
      `expected zero readFile() calls against the previewed Google Maps Timeline artifact's own path, found: ${JSON.stringify(readFileCallsOnStagedContent)}`
    );
  });
});
