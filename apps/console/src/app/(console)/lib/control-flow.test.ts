// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { unstable_rethrow } from "next/navigation";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}../page.tsx`;
const CONTROL_FLOW_FILE = `${HERE}control-flow.ts`;

const NAVIGATION_IMPORT = /import \{ unstable_rethrow \} from "next\/navigation";/;
const RETHROW_WRAPPER =
  /export function rethrowControlFlow\(err: unknown\): void \{[\s\S]*unstable_rethrow\(err\);[\s\S]*\}/;
const CONTROL_FLOW_IMPORT = /import \{ rethrowControlFlow \} from "\.\/lib\/control-flow\.ts";/;
// Each overview section's catch must call the rethrow guard immediately before
// its fallback return, so a swallowed redirect can never leak "NEXT_REDIRECT".
const OVERVIEW_HERO_GUARDED = /rethrowControlFlow\(err\);\s*return <OverviewHeroError /;
const ATTENTION_GUARDED = /rethrowControlFlow\(err\);\s*return <AttentionOverviewError \/>;/;
const RECENT_ACTIVITY_GUARDED = /rethrowControlFlow\(err\);\s*return <RecentActivityError \/>;/;
const WEB_PUSH_GUARDED = /rethrowControlFlow\(err\);\s*return null;/;
// A bare `catch {` cannot name `err` to re-throw it; every overview catch binds it.
const BARE_CATCH_RETURNING_JSX = /\} catch \{\s*\n\s*return </;

/**
 * Construct a `NEXT_REDIRECT`-digest error exactly as Next.js's `redirect()`
 * does (digest `NEXT_REDIRECT;<kind>;<dest>;<status>;`). This is the error the
 * dashboard read path throws via `verifyDashboardSession()` →
 * `redirectToOwnerLogin()`; the regression we are pinning is that a server-side
 * catch must re-throw it (so the navigation runs) rather than render its
 * placeholder `"NEXT_REDIRECT"` message as a data-load error.
 *
 * The behavioral tests exercise `unstable_rethrow` directly — the exact
 * primitive `control-flow.ts#rethrowControlFlow` wraps — because that module
 * carries an `import "server-only"` guard that throws under the bare
 * `node --test` runner (no RSC bundler shims it). The wiring test below pins
 * that the helper is a thin `unstable_rethrow` wrapper, so this is the same
 * contract the dashboard relies on.
 */
function makeRedirectError(dest = "/owner/login?return_to=%2F"): Error & { digest: string } {
  const err = new Error("NEXT_REDIRECT") as Error & { digest: string };
  err.digest = `NEXT_REDIRECT;replace;${dest};307;`;
  return err;
}

test("the control-flow guard re-throws a NEXT_REDIRECT control-flow error", () => {
  const redirectError = makeRedirectError();
  assert.throws(
    () => unstable_rethrow(redirectError),
    (thrown: unknown) =>
      thrown === redirectError &&
      typeof (thrown as { digest?: unknown }).digest === "string" &&
      (thrown as { digest: string }).digest.startsWith("NEXT_REDIRECT")
  );
});

test("the control-flow guard re-throws a redirect wrapped in error.cause", () => {
  // ref-client wraps transport failures as `new ReferenceServerUnreachableError(msg, cause)`;
  // unstable_rethrow unwraps `.cause`, so a redirect surfaced as a cause is still honored.
  const wrapped = new Error("wrapper") as Error & { cause: unknown };
  wrapped.cause = makeRedirectError();
  assert.throws(() => unstable_rethrow(wrapped));
});

test("the control-flow guard does NOT throw on a real data error (graceful fallback path runs)", () => {
  // A genuine read failure must fall through so the caller can render its
  // "Could not load …" fallback.
  assert.doesNotThrow(() => unstable_rethrow(new Error("authorization server unreachable")));
  assert.doesNotThrow(() => unstable_rethrow("string error"));
  assert.doesNotThrow(() => unstable_rethrow(undefined));
});

test("rethrowControlFlow is a thin wrapper over next/navigation's unstable_rethrow", async () => {
  const src = await readFile(CONTROL_FLOW_FILE, "utf8");
  assert.match(src, NAVIGATION_IMPORT);
  assert.match(src, RETHROW_WRAPPER);
});

test("every dashboard overview section catch re-throws control flow before its fallback", async () => {
  const src = await readFile(PAGE_FILE, "utf8");

  assert.match(src, CONTROL_FLOW_IMPORT);
  assert.match(src, OVERVIEW_HERO_GUARDED);
  assert.match(src, ATTENTION_GUARDED);
  assert.match(src, RECENT_ACTIVITY_GUARDED);
  assert.match(src, WEB_PUSH_GUARDED);
  assert.doesNotMatch(src, BARE_CATCH_RETURNING_JSX);
});
