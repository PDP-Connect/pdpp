// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const CONFIRMATION_URL = pathToFileURL(fileURLToPath(new URL("./confirmation.ts", import.meta.url))).href;
const PROVIDERS_URL = pathToFileURL(fileURLToPath(new URL("./providers.ts", import.meta.url))).href;
const SIGNING_URL = pathToFileURL(fileURLToPath(new URL("./index.ts", import.meta.url))).href;
const SITE_DIRECTORY = fileURLToPath(new URL("../../..", import.meta.url));
const ERROR_LOCATION = /\/principles\?signed=error#sign$/;
const DEFAULT_BRANCH_WRITE_ERROR = /private repo branch signatures responded 404/;
const MISSING_BRANCH_ERROR = /private repo branch missing-branch is unavailable \(404\)/;
const PRODUCTION_MISMATCH_ERROR = /production deployments write signatures, not signatures-preview/;
const PREVIEW_MISMATCH_ERROR = /preview deployments write signatures-preview, not signatures/;
const MISSING_VERCEL_ENV_ERROR = /VERCEL_ENV is not set, so no register branch policy applies/;
const UNKNOWN_VERCEL_ENV_ERROR = /VERCEL_ENV development has no register branch policy/;

interface ProviderCall {
  body?: Record<string, unknown>;
  method: string;
  url: string;
}

interface ProviderResult {
  calls: ProviderCall[];
  error: { message: string; name: string } | null;
}

interface DeploymentEnvironment {
  branch?: string;
  /** Set false to delete every repo credential, so only the guard can refuse. */
  credentials?: boolean;
  vercel?: string;
  vercelEnv?: string;
}

async function runProvider(
  operation: "write" | "withdraw",
  statuses: readonly number[],
  environment: DeploymentEnvironment = {}
): Promise<ProviderResult> {
  const scenario = JSON.stringify({ environment, operation, statuses });
  const program = `
    const scenario = ${scenario};
    const credentials = {
      PDPP_PRIVATE_REPO_NAME: "supporters-private",
      PDPP_PRIVATE_REPO_OWNER: "PDP-Connect",
      PDPP_PRIVATE_REPO_TOKEN: "test-token",
    };
    if (scenario.environment.credentials === false) {
      for (const name of Object.keys(credentials)) delete process.env[name];
    } else {
      Object.assign(process.env, credentials);
    }
    for (const [key, name] of [["branch", "PDPP_PRIVATE_REPO_BRANCH"], ["vercel", "VERCEL"], ["vercelEnv", "VERCEL_ENV"]]) {
      if (scenario.environment[key] === undefined) delete process.env[name];
      else process.env[name] = scenario.environment[key];
    }
    const calls = [];
    const statuses = [...scenario.statuses];
    globalThis.fetch = async (input, init = {}) => {
      calls.push({ body: init.body ? JSON.parse(init.body) : undefined, method: init.method ?? "GET", url: String(input) });
      return new Response(null, { status: statuses.shift() ?? 200 });
    };
    const providers = await import(${JSON.stringify(PROVIDERS_URL)});
    let error = null;
    try {
      if (scenario.operation === "write") {
        await providers.writeSignatory({
          confirmedAt: "2026-09-03T00:00:00.000Z",
          consent: { ageOrAuthority: true, principles: true, register: true, updates: false },
          country: "United States", displayName: "Private Display Name", email: "private@example.test", id: "signatory-id",
          organisation: null, principlesVersion: "v1.0", publicName: "Public P.", signatoryName: null, signatoryRole: null, type: "Individual",
        }, "signatories/2026/signatory-id.json");
      } else await providers.withdrawSignatory("signatory-id");
    } catch (caught) { error = { message: caught.message, name: caught.name }; }
    process.stdout.write(JSON.stringify({ calls, error }));
  `;
  const { stdout } = await execFile(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", "--input-type=module", "--eval", program],
    { cwd: SITE_DIRECTORY }
  );
  return JSON.parse(stdout) as ProviderResult;
}

interface PendingRetryResult {
  githubCalls: number;
  location: string | null;
  pendingSurvived: boolean;
  status: number;
}

/**
 * Drives a real confirmation POST on a deployment the guard refuses, against a
 * simulated pending store, and reports the signatory's outcome and whether the
 * submission is still retrievable afterwards.
 *
 * The handler comes from `confirmation.ts` and the pending functions from
 * `providers.ts`, both unmocked, so this exercises the ordering the confirm
 * path actually ships: read (GET), write, delete (DEL) only once the record is
 * durable. A destructive read (GETDEL) in `readPending`'s place makes
 * `pendingSurvived` false.
 */
async function runPendingRetry(): Promise<PendingRetryResult> {
  const program = `
    Object.assign(process.env, {
      PDPP_KV_REST_API_TOKEN: "kv-token",
      PDPP_KV_REST_API_URL: "https://kv.test",
      PDPP_PRIVATE_REPO_NAME: "supporters-private",
      PDPP_PRIVATE_REPO_OWNER: "PDP-Connect",
      PDPP_PRIVATE_REPO_TOKEN: "test-token",
      // The misconfiguration this branch exists to catch: a preview deployment
      // still pointed at the production register.
      PDPP_PRIVATE_REPO_BRANCH: "signatures",
      VERCEL: "1",
      VERCEL_ENV: "preview",
    });

    const submission = {
      affiliation: "PDP-Connect", consent_age: true, consent_principles: true, consent_register: true,
      consent_updates: false, country: "United States", email: "private@example.test",
      name: "Private Display Name", principles_version: "v1.0", signatory_kind: "individual",
    };
    const store = new Map([["pending:signatory-id", JSON.stringify(submission)]]);
    let githubCalls = 0;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.startsWith("https://api.github.com/")) {
        githubCalls += 1;
        return new Response(null, { status: 201 });
      }
      const read = url.match(/\\/(get|getdel)\\/([^/?]+)/);
      if (read) {
        const key = decodeURIComponent(read[2]);
        const value = store.get(key) ?? null;
        if (read[1] === "getdel") store.delete(key);
        return new Response(JSON.stringify({ result: value }), { status: 200 });
      }
      const removed = url.match(/\\/del\\/([^/?]+)/);
      if (removed) {
        store.delete(decodeURIComponent(removed[1]));
        return new Response(JSON.stringify({ result: 1 }), { status: 200 });
      }
      return new Response(JSON.stringify({ result: null }), { status: 200 });
    };

    console.error = () => {};
    const { NextRequest } = await import("next/server");
    const { createConfirmationHandlers } = await import(${JSON.stringify(CONFIRMATION_URL)});
    const { buildRecord, hasSameImmutableFields, recordPath } = await import(${JSON.stringify(SIGNING_URL)});
    const providers = await import(${JSON.stringify(PROVIDERS_URL)});

    const { POST } = createConfirmationHandlers({
      buildRecord,
      deletePending: providers.deletePending,
      hasSameImmutableFields,
      isSigningLive: () => true,
      readPending: providers.readPending,
      readSignatory: providers.readSignatory,
      recordPath,
      verifyToken: (value) => (value === "confirm-token" ? "signatory-id" : null),
      writeSignatory: providers.writeSignatory,
    });

    const response = await POST(new NextRequest("https://pdpp.example.test/api/sign/confirm", {
      body: new URLSearchParams({ token: "confirm-token" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    }));

    const retried = await providers.readPending("signatory-id");
    process.stdout.write(JSON.stringify({
      githubCalls,
      location: response.headers.get("location"),
      pendingSurvived: retried !== null,
      status: response.status,
    }));
  `;
  const { stdout } = await execFile(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", "--input-type=module", "--eval", program],
    { cwd: SITE_DIRECTORY }
  );
  return JSON.parse(stdout) as PendingRetryResult;
}

test("signatory PUT sends the configured branch and bot DCO trailer", async () => {
  const result = await runProvider("write", [201], { branch: "staged-signatures" });
  const [request] = result.calls;

  assert.equal(result.error, null);
  assert.equal(request?.method, "PUT");
  assert.equal(
    request?.url,
    "https://api.github.com/repos/PDP-Connect/supporters-private/contents/signatories/2026/signatory-id.json"
  );
  assert.equal(request?.body?.branch, "staged-signatures");
  assert.equal(
    request?.body?.message,
    "Add signatory signatory-id\n\nSigned-off-by: pdpp-supporters-bot <bot@pdpp.dev>"
  );
});

test("default branch write failures are SigningUnavailableError responses", async () => {
  const result = await runProvider("write", [404]);

  assert.equal(result.calls[0]?.body?.branch, "signatures");
  assert.equal(result.error?.name, "SigningUnavailableError");
  assert.match(result.error?.message ?? "", DEFAULT_BRANCH_WRITE_ERROR);
});

test("withdrawal stops before probing files when its branch is unavailable", async () => {
  const result = await runProvider("withdraw", [404], { branch: "missing-branch" });

  assert.deepEqual(result.calls, [
    {
      method: "GET",
      url: "https://api.github.com/repos/PDP-Connect/supporters-private/git/ref/heads/missing-branch",
    },
  ]);
  assert.equal(result.error?.name, "SigningUnavailableError");
  assert.match(result.error?.message ?? "", MISSING_BRANCH_ERROR);
});

// ------------------------------------------------------ deployment branch guard
//
// Each mismatch case asserts an EMPTY call list, not just the error: the point
// of the guard is that a preview deployment never reaches GitHub with the
// production branch, and an error raised after the write would satisfy an
// error-only assertion while the rehearsal record already existed.

test("a production deployment writes the production register", async () => {
  const result = await runProvider("write", [201], {
    branch: "signatures",
    vercel: "1",
    vercelEnv: "production",
  });

  assert.equal(result.error, null);
  assert.equal(result.calls[0]?.body?.branch, "signatures");
});

test("a production deployment pointed at the preview branch fails before fetch", async () => {
  const result = await runProvider("write", [201], {
    branch: "signatures-preview",
    vercel: "1",
    vercelEnv: "production",
  });

  assert.deepEqual(result.calls, []);
  assert.equal(result.error?.name, "SigningUnavailableError");
  assert.match(result.error?.message ?? "", PRODUCTION_MISMATCH_ERROR);
});

test("a preview deployment writes the preview register", async () => {
  const result = await runProvider("write", [201], {
    branch: "signatures-preview",
    vercel: "1",
    vercelEnv: "preview",
  });

  assert.equal(result.error, null);
  assert.equal(result.calls[0]?.body?.branch, "signatures-preview");
});

test("a preview deployment pointed at the production register fails before fetch", async () => {
  const result = await runProvider("write", [201], {
    branch: "signatures",
    vercel: "1",
    vercelEnv: "preview",
  });

  assert.deepEqual(result.calls, []);
  assert.equal(result.error?.name, "SigningUnavailableError");
  assert.match(result.error?.message ?? "", PREVIEW_MISMATCH_ERROR);
});

test("a Vercel deployment with no VERCEL_ENV fails closed", async () => {
  const result = await runProvider("write", [201], { vercel: "1" });

  assert.deepEqual(result.calls, []);
  assert.equal(result.error?.name, "SigningUnavailableError");
  assert.match(result.error?.message ?? "", MISSING_VERCEL_ENV_ERROR);
});

test("a Vercel deployment with an unknown VERCEL_ENV fails closed", async () => {
  const result = await runProvider("write", [201], {
    branch: "signatures-preview",
    vercel: "1",
    vercelEnv: "development",
  });

  assert.deepEqual(result.calls, []);
  assert.equal(result.error?.name, "SigningUnavailableError");
  assert.match(result.error?.message ?? "", UNKNOWN_VERCEL_ENV_ERROR);
});

test("the branch policy is decided before any credential is read", async () => {
  // The shipped cases above always populate the repo credentials, so they
  // cannot tell "the guard ran first" from "the guard ran after env() happened
  // to succeed". With every credential removed, the branch-policy message must
  // still win: otherwise a misconfigured deployment reports a missing token and
  // the real fault — the branch it is pointed at — never surfaces.
  const result = await runProvider("write", [201], {
    branch: "signatures",
    credentials: false,
    vercel: "1",
    vercelEnv: "preview",
  });

  assert.deepEqual(result.calls, []);
  assert.equal(result.error?.name, "SigningUnavailableError");
  assert.match(result.error?.message ?? "", PREVIEW_MISMATCH_ERROR);
});

// ------------------------------------------------ guard rejection and the pending record
//
// The guard throws inside repoConfig(), which runs when the record is WRITTEN —
// on the confirm path that is after the pending submission has been read. If
// that read also consumes the submission, a rejected write spends the
// signatory's single-use link and the signature is unrecoverable: they have to
// start again. So the read and the delete must be separate operations, with the
// delete after a successful write.
//
// The confirmation handler's own suite (`confirmation.test.ts`) drives that
// ordering against injected fakes. This drives it against the REAL providers on
// a refused deployment, which is the only way the guard participates: nothing
// injected can refuse a branch.

test("a guard refusal leaves the pending record and reports the write as unavailable", async () => {
  const result = await runPendingRetry();

  // The guard refused before any GitHub request, the signatory is told the
  // write failed, and the submission is still there to retry once the branch
  // configuration is corrected.
  assert.equal(result.githubCalls, 0);
  assert.equal(result.status, 303);
  assert.match(result.location ?? "", ERROR_LOCATION);
  assert.equal(result.pendingSurvived, true);
});

test("off Vercel the branch defaults to signatures and an explicit branch is honoured", async () => {
  const defaulted = await runProvider("write", [201]);
  const explicit = await runProvider("write", [201], { branch: "signatures-preview" });

  assert.equal(defaulted.error, null);
  assert.equal(defaulted.calls[0]?.body?.branch, "signatures");
  assert.equal(explicit.error, null);
  assert.equal(explicit.calls[0]?.body?.branch, "signatures-preview");
});
