// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A browser_session connection reaches `first_sync_running` /
 * `first_sync_pending` from run evidence ALONE — see `hasDraftSetupProgress`
 * in `reference-implementation/runtime/static-secret-setup-status.ts`, which
 * returns true for `setupKind === "browser_session"` whenever an active or
 * last run row exists. For this setup kind the run IS the login attempt: it
 * starts so the owner can sign in inside the streamed browser.
 *
 * So a run row proves a sign-in was ATTEMPTED, never that it completed.
 * `defaultSetupMaterial` pins `present: false` for browser sessions precisely
 * because nothing was captured. The console previously rendered "Login is
 * complete" from that evidence, telling the owner a session was live while the
 * stream still sat on the provider's sign-in form (owner-reported 2026-08-19,
 * Reddit).
 *
 * These are source-text invariants, matching the convention of the sibling
 * `*.invariants.test.ts` files: this page is a React server component with no
 * DOM harness in this suite, so the rendered copy is asserted against the
 * source. See design-notes/browser-stream-status-honesty-2026-08-22.md.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const STATUS_PAGE_FILE = fileURLToPath(new URL("./status/[connectionId]/page.tsx", import.meta.url));

// Hoisted to satisfy useTopLevelRegex.
const BROWSER_SESSION_FN = /function describeBrowserSessionState\(/;
const STATIC_SECRET_FN = /function describeConnectionState\(/;
// The claim that must never return: any assertion that the login itself
// succeeded, in any of the phrasings that read as a completed sign-in.
const LOGIN_COMPLETE_CLAIM = /Login is complete|You(?:'re| are) (?:signed|logged) in|Already (?:signed|logged) in/i;
// The honest replacement must point the owner back at the browser, because
// this page genuinely cannot tell whether the sign-in finished.
const FINISH_SIGNING_IN_CUE = /finish signing in there/;
const CANNOT_CONFIRM_CUE = /can't confirm the login by itself/;
// The static-secret claim that must be PRESERVED — it is evidence-backed.
const CREDENTIAL_CAPTURED_CLAIM = /The provider credential is captured/;
// Function-boundary marker used to slice one `describe*State` body.
const NEXT_TOP_LEVEL_FUNCTION = /\nfunction /;

function readStatusPage(): Promise<string> {
  return readFile(STATUS_PAGE_FILE, "utf8");
}

/**
 * Slices out one `describe*State` function body so an assertion about the
 * browser-session branch cannot be satisfied by copy that lives in the
 * static-secret or manual-upload branch of the same file.
 */
function sliceFunctionBody(src: string, startPattern: RegExp): string {
  const start = src.search(startPattern);
  assert.notEqual(start, -1, `expected to find ${String(startPattern)} in the status page`);
  const nextFn = src.slice(start + 1).search(NEXT_TOP_LEVEL_FUNCTION);
  return nextFn === -1 ? src.slice(start) : src.slice(start, start + 1 + nextFn);
}

test("the browser-session branch never claims the login completed", async () => {
  const src = await readStatusPage();
  const body = sliceFunctionBody(src, BROWSER_SESSION_FN);

  assert.doesNotMatch(
    body,
    LOGIN_COMPLETE_CLAIM,
    "a browser_session run row proves only that a sign-in was attempted — the console has no evidence the login succeeded, so it must not assert that it did"
  );
});

test("the browser-session in-flight copy sends the owner back to the browser instead", async () => {
  const src = await readStatusPage();
  const body = sliceFunctionBody(src, BROWSER_SESSION_FN);

  assert.match(body, FINISH_SIGNING_IN_CUE, "the owner must be told where to finish an unfinished sign-in");
  assert.match(body, CANNOT_CONFIRM_CUE, "the page must admit it cannot confirm the login itself");
});

test("the static-secret branch keeps its capture claim, which IS backed by setup material", async () => {
  const src = await readStatusPage();
  const body = sliceFunctionBody(src, STATIC_SECRET_FN);

  // Guards against over-correcting: unlike browser_session, a static_secret
  // connection reaches these states via `hasSetupMaterial`
  // (`credential.present === true`), so naming the captured credential is a
  // claim the projection actually supports. Scrubbing it would trade one
  // dishonesty for a needless loss of information.
  assert.match(
    body,
    CREDENTIAL_CAPTURED_CLAIM,
    "static-secret copy cites setup_material.present === true and must be preserved"
  );
});
