// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CredentialError, loadScopedCredential, readStoredCredentialOptionsFor } from "../src/credentials.ts";

async function makeCacheRoot() {
  return await mkdtemp(join(tmpdir(), "pdpp-mcp-cred-"));
}

async function writeCacheEntry(cacheRoot: string, providerUrl: string, payload: unknown) {
  const host = new URL(providerUrl).host.replace(/[^a-zA-Z0-9.-]/g, "_");
  const dir = join(cacheRoot, "clients");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${host}.json`);
  await writeFile(path, JSON.stringify(payload), { mode: 0o600 });
  return path;
}

test("readStoredCredentialOptionsFor omits cacheRoot entirely when absent, forwards it when present", () => {
  // Discriminates absent-vs-present forwarding by key presence, not value:
  // `readStoredCredential`'s options type declares `cacheRoot?: string`
  // under exactOptionalPropertyTypes, so a present key with value `undefined`
  // is a real, rejected shape distinct from an omitted key — an
  // `assert.equal(result.cacheRoot, undefined)` check alone would not catch
  // a regression back to `{ cacheRoot: options.cacheRoot }`. Only exercised
  // with inputs the function's own (unweakened) type signature accepts;
  // tsc is the authority on the upstream exactOptionalPropertyTypes mismatch
  // this helper exists to satisfy, not a runtime probe with a bypassed type.
  const withoutCacheRoot = readStoredCredentialOptionsFor({});
  assert.equal("cacheRoot" in withoutCacheRoot, false, "cacheRoot key must be omitted, not set to undefined");
  assert.deepEqual(Object.keys(withoutCacheRoot), []);

  const withCacheRoot = readStoredCredentialOptionsFor({ cacheRoot: "/tmp/custom-root" });
  assert.equal("cacheRoot" in withCacheRoot, true, "a present cacheRoot must be forwarded");
  assert.equal(withCacheRoot.cacheRoot, "/tmp/custom-root");
});

test("loads scoped credential from cache", async () => {
  const cacheRoot = await makeCacheRoot();
  await writeCacheEntry(cacheRoot, "https://provider.test", {
    credential: { access_token: "scoped-abc", token_type: "Bearer" },
    scope: "pdpp:read",
    grant_id: "grant-1",
  });

  const result = await loadScopedCredential("https://provider.test", { cacheRoot });
  assert.equal(result.accessToken, "scoped-abc");
  assert.equal(result.providerUrl, "https://provider.test");
  assert.equal(result.scope, "pdpp:read");
});

test("fails closed with not_connected when cache is empty", async () => {
  const cacheRoot = await makeCacheRoot();
  await assert.rejects(
    () => loadScopedCredential("https://provider.test", { cacheRoot }),
    (error) => error instanceof CredentialError && error.code === "not_connected"
  );
});

test("refuses owner credential by pdpp_token_kind", async () => {
  const cacheRoot = await makeCacheRoot();
  await writeCacheEntry(cacheRoot, "https://provider.test", {
    credential: { access_token: "owner-abc", pdpp_token_kind: "owner" },
  });

  await assert.rejects(
    () => loadScopedCredential("https://provider.test", { cacheRoot }),
    (error) => error instanceof CredentialError && error.code === "owner_token_refused"
  );
});

test("rejects missing provider URL with usage exit code", async () => {
  // loadScopedCredential's own `if (!providerUrl)` runtime guard is the actual
  // boundary defense against a caller that bypassed CLI arg parsing (its TS
  // signature only narrows callers already known to hold a string).
  await assert.rejects(
    () => loadScopedCredential(undefined as unknown as string),
    (error) => error instanceof CredentialError && error.exitCode === 64
  );
});

test("rejects expired credential", async () => {
  const cacheRoot = await makeCacheRoot();
  await writeCacheEntry(cacheRoot, "https://provider.test", {
    credential: {
      access_token: "expired",
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    },
  });

  await assert.rejects(
    () => loadScopedCredential("https://provider.test", { cacheRoot }),
    (error) => error instanceof CredentialError && error.code === "credential_expired"
  );
});
