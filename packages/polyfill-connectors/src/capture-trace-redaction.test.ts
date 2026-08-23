// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression tests for the CONFIRMED trace leak.
 *
 * A real owner password was recovered from 8 of 14 trace zips in a single
 * Venmo run. The bytes were in the `trace.trace` entry of each archive.
 *
 * The reason it went unnoticed matters as much as the leak: a trace is a ZIP,
 * so `grep` over the file finds NOTHING — the plaintext only exists after
 * inflation. A grep-based test would pass while the credential sat on disk.
 * Every assertion here therefore opens the archive and inspects each entry's
 * DECOMPRESSED bytes. `assertZipFreeOfSecret` is the shared oracle, and
 * `trace zip hides the secret from grep` pins the false-negative itself so
 * nobody "simplifies" these tests back into a grep.
 *
 * Root cause, measured against Playwright 1.62.1 rather than assumed:
 * Playwright's action recorder writes each call's PARAMETERS into the trace,
 * so `page.fill(sel, password)` is logged as
 *   {"method":"fill","params":{"value":"<password>"}}
 * plus an echoing {"type":"log","message":"fill(\"<password>\")"}.
 * With screenshots/snapshots/sources ALL false the password still appeared 4x.
 * No tracing option suppresses it, so a run that touched a credential does not
 * get to keep a trace.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { chromium } from "playwright";

import { makeTracer } from "./connector-runtime.ts";
import { type CaptureSession, createCaptureSession } from "./fixture-capture.ts";

/** The credential shape that actually leaked, kept distinct enough to grep for. */
const SECRET = "BG54aFvxSENTINEL";

const LOGIN_PAGE_HTML =
  '<html><body><label for="p">Password</label>' +
  '<input id="p" name="password" type="password">' +
  '<label for="t">One-time code</label>' +
  '<input id="t" name="otp" autocomplete="one-time-code">' +
  "</body></html>";

/** Trace zips are large; allow a generous buffer when inflating entries. */
const UNZIP_MAX_BUFFER_BYTES = 268_435_456;

/** Entry names inside a zip, via the stdlib-free `unzip -Z1` listing. */
function zipEntries(zipPath: string): string[] {
  return execFileSync("unzip", ["-Z1", zipPath], { maxBuffer: UNZIP_MAX_BUFFER_BYTES })
    .toString()
    .trim()
    .split("\n")
    .filter((entry) => entry.length > 0);
}

/**
 * Inflate every entry and report which ones contain `secret`.
 *
 * This is the whole point of the file: reading the zip's raw bytes cannot see
 * a compressed secret, so we decompress entry by entry.
 */
function zipEntriesContainingSecret(zipPath: string, secret: string): string[] {
  return zipEntries(zipPath).filter((entry) => {
    try {
      return execFileSync("unzip", ["-p", zipPath, entry], { maxBuffer: UNZIP_MAX_BUFFER_BYTES }).includes(secret);
    } catch {
      return false;
    }
  });
}

function assertZipFreeOfSecret(zipPath: string, secret: string): void {
  const leaking = zipEntriesContainingSecret(zipPath, secret);
  assert.deepEqual(leaking, [], `secret found inside ${zipPath} entries: ${leaking.join(", ")}`);
}

function traceZipsUnder(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => name.endsWith(".zip"))
    .map((name) => join(dir, name));
}

/**
 * A capture session stub exposing only what makeTracer consumes. Using the
 * real session would drag in env-var plumbing irrelevant to the trace gate.
 */
function fakeCapture(baseDir: string, hasSecrets: boolean): CaptureSession {
  return {
    baseDir,
    captureDom: () => Promise.resolve(),
    captureHttp: () => undefined,
    finalize: () => undefined,
    hasRegisteredSecrets: () => hasSecrets,
    keepOnSuccess: true,
    markSucceeded: () => undefined,
    recordRecord: () => undefined,
    registerSecrets: () => undefined,
    runId: "test-run",
  } as unknown as CaptureSession;
}

/**
 * Drive a real browser through a real credential fill under a real tracer,
 * then hand back whatever trace files survived.
 */
async function runTracedLogin(options: { hasSecrets: boolean }): Promise<{ dir: string; traces: string[] }> {
  const baseDir = mkdtempSync(join(tmpdir(), "pdpp-trace-test-"));
  const tracesDir = join(baseDir, "traces");
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const capture = fakeCapture(baseDir, options.hasSecrets);
    const tracer = makeTracer(context, "venmo", capture);
    await tracer.start();
    const page = await context.newPage();
    await page.setContent(LOGIN_PAGE_HTML);
    // The exact shape of the confirmed leak: a credential typed into a login
    // form while tracing is live.
    await page.fill("#p", SECRET);
    await page.fill("#t", SECRET);
    // The run FAILED (markSucceeded is never called), which is precisely the
    // path that retained traces before this fix.
    await tracer.stop();
    await context.close();
  } finally {
    await browser.close();
  }
  return { dir: tracesDir, traces: traceZipsUnder(tracesDir) };
}

test("trace zip hides the secret from grep — why these tests are zip-aware", async (t) => {
  const baseDir = mkdtempSync(join(tmpdir(), "pdpp-trace-grep-"));
  t.after(() => rmSync(baseDir, { force: true, recursive: true }));
  const zipPath = join(baseDir, "trace.zip");
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const page = await context.newPage();
    await page.setContent(LOGIN_PAGE_HTML);
    await page.fill("#p", SECRET);
    await context.tracing.stop({ path: zipPath });
    await context.close();
  } finally {
    await browser.close();
  }

  // Reading the archive's raw bytes — the check that produced a false
  // negative on the real incident — sees nothing.
  assert.equal(readFileSync(zipPath).includes(SECRET), false, "precondition: the secret is compressed, not plaintext");
  // Inflating the entries finds it. This asymmetry is the defect's signature.
  assert.ok(
    zipEntriesContainingSecret(zipPath, SECRET).includes("trace.trace"),
    "expected the unredacted control trace to carry the secret in trace.trace"
  );
});

test("no tracing option suppresses the leak — screenshots/snapshots/sources all false still leaks", async (t) => {
  const baseDir = mkdtempSync(join(tmpdir(), "pdpp-trace-opts-"));
  t.after(() => rmSync(baseDir, { force: true, recursive: true }));
  const zipPath = join(baseDir, "trace.zip");
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    // The tempting "just turn off DOM snapshots" fix.
    await context.tracing.start({ screenshots: false, snapshots: false, sources: false });
    const page = await context.newPage();
    await page.setContent(LOGIN_PAGE_HTML);
    await page.fill("#p", SECRET);
    await context.tracing.stop({ path: zipPath });
    await context.close();
  } finally {
    await browser.close();
  }

  // This is why the fix is "do not persist the trace" rather than a flag: the
  // credential rides in the fill() ACTION PARAMETERS, not the DOM snapshot.
  assert.ok(
    zipEntriesContainingSecret(zipPath, SECRET).includes("trace.trace"),
    "expected fill() params to leak even with snapshots/screenshots/sources disabled"
  );
});

test("a run that registered credentials persists no trace zip at all", async (t) => {
  const { dir, traces } = await runTracedLogin({ hasSecrets: true });
  t.after(() => rmSync(dir, { force: true, recursive: true }));

  assert.deepEqual(traces, [], `expected no retained traces, found: ${traces.join(", ")}`);
  // Belt and braces: whatever else is in the directory must be secret-free.
  for (const zip of traceZipsUnder(dir)) {
    assertZipFreeOfSecret(zip, SECRET);
  }
});

test("suppression leaves a breadcrumb explaining the missing trace", async (t) => {
  const { dir } = await runTracedLogin({ hasSecrets: true });
  t.after(() => rmSync(dir, { force: true, recursive: true }));

  const notes = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".suppressed.json")) : [];
  assert.equal(notes.length, 1, `expected one suppression note, found: ${notes.join(", ")}`);
  const note = JSON.parse(readFileSync(join(dir, notes[0] as string), "utf8")) as { reason?: string };
  assert.equal(note.reason, "credentials_registered");
});

test("a run with no registered credentials keeps its trace for diagnostics", async (t) => {
  const { dir, traces } = await runTracedLogin({ hasSecrets: false });
  t.after(() => rmSync(dir, { force: true, recursive: true }));

  // The guard must be targeted, not a blanket disabling of tracing: an
  // API-only connector or a stored-session run still needs its artifact.
  assert.ok(traces.length > 0, "expected a trace to be retained when no credential was registered");
});

// ─── The real CaptureSession, not a stub ────────────────────────────────
//
// The tests above hand makeTracer a hand-written `hasRegisteredSecrets`, so
// they prove the TRACER honours the gate but say nothing about whether the
// session ever reports it. These close that loop against the real object.

function withCaptureEnv<T>(body: () => T): T {
  const previous = process.env.PDPP_CAPTURE_FIXTURES;
  process.env.PDPP_CAPTURE_FIXTURES = "1";
  try {
    return body();
  } finally {
    if (previous === undefined) {
      delete process.env.PDPP_CAPTURE_FIXTURES;
    } else {
      process.env.PDPP_CAPTURE_FIXTURES = previous;
    }
  }
}

test("registering a credential arms the trace gate on the real session", () => {
  withCaptureEnv(() => {
    const capture = createCaptureSession(`gate_${process.pid}_${Date.now()}`);
    assert.ok(capture);

    assert.equal(capture.hasRegisteredSecrets(), false, "a fresh session must not suppress traces");
    capture.registerSecrets([SECRET]);
    assert.equal(capture.hasRegisteredSecrets(), true, "a registered credential must arm the gate");
    rmSync(capture.baseDir, { force: true, recursive: true });
  });
});

test("a credential too short to match still arms the trace gate", () => {
  withCaptureEnv(() => {
    const capture = createCaptureSession(`gate_short_${process.pid}_${Date.now()}`);
    assert.ok(capture);

    // Below the substring-matching floor, so no text rule can redact it — all
    // the more reason the trace must not survive.
    capture.registerSecrets(["123"]);
    assert.equal(capture.hasRegisteredSecrets(), true, "a sub-floor credential is still a credential");
    rmSync(capture.baseDir, { force: true, recursive: true });
  });
});

test("http capture redacts a credential in a url or response body", () => {
  withCaptureEnv(() => {
    const capture = createCaptureSession(`http_${process.pid}_${Date.now()}`);
    assert.ok(capture);
    capture.registerSecrets([SECRET]);

    capture.captureHttp(
      "token-exchange",
      { access_token: SECRET, user: "tim" },
      { method: "GET", path: `https://venmo.test/cb?code=${SECRET}`, status: 200 }
    );

    const file = join(capture.baseDir, "http", "0001-token-exchange.json");
    const written = readFileSync(file, "utf8");
    assert.ok(!written.includes(SECRET), `credential leaked into http capture:\n${written}`);
    // Still diagnostically useful: the request and its shape survive.
    assert.match(written, /"status": 200/);
    assert.match(written, /"user": "tim"/);
    rmSync(capture.baseDir, { force: true, recursive: true });
  });
});

test("record capture redacts a credential echoed back by an api", () => {
  withCaptureEnv(() => {
    const capture = createCaptureSession(`rec_${process.pid}_${Date.now()}`);
    assert.ok(capture);
    capture.registerSecrets([SECRET]);

    capture.recordRecord({ stream: "profile", data: { id: "u1", session_token: SECRET } });

    const written = readFileSync(join(capture.baseDir, "records", "profile.jsonl"), "utf8");
    assert.ok(!written.includes(SECRET), `credential leaked into records capture:\n${written}`);
    assert.match(written, /"id":"u1"/);
    rmSync(capture.baseDir, { force: true, recursive: true });
  });
});

test("no screenshot is written when the page cannot build a credential mask", async () => {
  await withCaptureEnv(async () => {
    const capture = createCaptureSession(`nomask_${process.pid}_${Date.now()}`);
    assert.ok(capture);
    capture.registerSecrets([SECRET]);

    // A page surface with no `locator` cannot be masked. The safe outcome is
    // no screenshot, not an unmasked one.
    const page = {
      ariaSnapshot: () => Promise.resolve("- generic:"),
      content: () => Promise.resolve("<html></html>"),
      screenshot: () => Promise.resolve(Buffer.from("png")),
      title: () => Promise.resolve("Login"),
      url: () => "https://venmo.test/login",
    };
    await capture.captureDom(page as unknown as Parameters<CaptureSession["captureDom"]>[0], "unmaskable");

    assert.equal(
      existsSync(join(capture.baseDir, "screenshots", "unmaskable.png")),
      false,
      "an unmaskable page must not produce a screenshot"
    );
    rmSync(capture.baseDir, { force: true, recursive: true });
  });
});

test("screenshot capture masks a one-time code rendered as readable text", async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(LOGIN_PAGE_HTML);
    // An OTP input is type-less, so the digits render PLAINLY — the case a
    // `type="password"` argument does not cover.
    await page.fill("#t", "482913");

    const captured = await withCaptureEnv(async () => {
      const capture = createCaptureSession(`shot_${process.pid}_${Date.now()}`);
      assert.ok(capture);
      capture.registerSecrets([SECRET]);
      await capture.captureDom(page, "otp-after-submit");
      return capture.baseDir;
    });

    // Playwright paints an opaque #FF00FF box over each masked element before
    // the pixels are read, so proving the overlay exists proves the digits
    // were never encoded into the file.
    const png = readFileSync(join(captured, "screenshots", "otp-after-submit.png"));
    const magenta = await page.evaluate(
      async (dataUrl) => {
        const img = new Image();
        img.src = dataUrl;
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx2d = canvas.getContext("2d");
        if (!ctx2d) {
          return 0;
        }
        ctx2d.drawImage(img, 0, 0);
        const { data } = ctx2d.getImageData(0, 0, canvas.width, canvas.height);
        let count = 0;
        for (let i = 0; i < data.length; i += 4) {
          if ((data[i] ?? 0) > 240 && (data[i + 1] ?? 0) < 20 && (data[i + 2] ?? 0) > 240) {
            count += 1;
          }
        }
        return count;
      },
      `data:image/png;base64,${png.toString("base64")}`
    );

    assert.ok(magenta > 0, "expected a mask overlay covering the credential fields in the screenshot");
    rmSync(captured, { force: true, recursive: true });
    await context.close();
  } finally {
    await browser.close();
  }
});
