// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const PROVIDERS_URL = pathToFileURL(fileURLToPath(new URL("./providers.ts", import.meta.url))).href;
const SITE_DIRECTORY = fileURLToPath(new URL("../../..", import.meta.url));
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
    Object.assign(process.env, {
      PDPP_PRIVATE_REPO_NAME: "supporters-private",
      PDPP_PRIVATE_REPO_OWNER: "PDP-Connect",
      PDPP_PRIVATE_REPO_TOKEN: "test-token",
    });
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

test("off Vercel the branch defaults to signatures and an explicit branch is honoured", async () => {
  const defaulted = await runProvider("write", [201]);
  const explicit = await runProvider("write", [201], { branch: "signatures-preview" });

  assert.equal(defaulted.error, null);
  assert.equal(defaulted.calls[0]?.body?.branch, "signatures");
  assert.equal(explicit.error, null);
  assert.equal(explicit.calls[0]?.body?.branch, "signatures-preview");
});
