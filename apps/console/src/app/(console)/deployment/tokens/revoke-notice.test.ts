// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The revoke notice must describe the state the server confirmed, never the
 * fact that a request was sent.
 *
 * The defect: `revokeOwnerClientTokenAction` redirected to
 * `?notice=token_revoked` unconditionally. `revoked: false` is a successful
 * idempotent no-op — the store proves no ACTIVE matching token remains after
 * owner scoping — but it is NOT a new revocation. Reporting it as one is how
 * this surface told an operator "Token revoked" over a credential still listed
 * on the page, and it masked the stored-binding defect that was refusing the
 * revoke server-side.
 *
 * Idempotency is preserved deliberately: a retried DELETE must not error. What
 * changes is that success copy is earned by the confirmed state rather than
 * assumed. These are source-level guards because the action redirects (it does
 * not return), so its outcome is only observable as the notice it selects.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ACTIONS_FILE = `${HERE}actions.ts`;
const PAGE_FILE = `${HERE}page.tsx`;

function renderedCopy(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\stitle=\{?"[^"]*"\}?/g, "");
}

test("the revoke action branches on the confirmed `revoked` flag", async () => {
  const src = renderedCopy(await readFile(ACTIONS_FILE, "utf8"));
  assert.match(
    src,
    /result\.revoked\s*\?/,
    "success copy must be selected by the server-confirmed flag, not assumed"
  );
  assert.match(src, /notice=token_already_revoked/, "the no-op state needs its own notice");
});

test("a no-op revoke never reports a new revocation", async () => {
  const src = renderedCopy(await readFile(ACTIONS_FILE, "utf8"));
  // The un-branched form: assigning the success notice and then never
  // reconsidering it. If `token_revoked` is the only notice this action can
  // produce, a no-op is being reported as a revocation.
  const notices = [...src.matchAll(/notice=([a-z_]+)/g)].map((m) => m[1]);
  assert.ok(notices.includes("token_revoked"));
  assert.ok(
    notices.includes("token_already_revoked"),
    "an action that can only emit token_revoked cannot tell a no-op from a revocation"
  );
});

test("the page renders truthful copy for both confirmed states", async () => {
  const body = renderedCopy(await readFile(PAGE_FILE, "utf8"));
  assert.match(body, /notice === "token_already_revoked"/);
  assert.match(body, /No change was needed/i, "the no-op state must say no change happened");
  assert.match(body, /already revoked or is no longer active/i);
  // Must not claim continuing access on a path where the postcondition holds.
  assert.doesNotMatch(body, /access remains active/i);
});
