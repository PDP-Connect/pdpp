// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFile = promisify(execFileCallback);
const PROVIDERS_URL = pathToFileURL(fileURLToPath(new URL("./providers.ts", import.meta.url))).href;
const SITE_DIRECTORY = fileURLToPath(new URL("../../..", import.meta.url));

interface ProviderCall {
  body?: Record<string, unknown>;
  method: string;
  url: string;
}

interface ProviderResult {
  calls: ProviderCall[];
  error: { message: string; name: string } | null;
}

async function runProvider(operation: "write" | "withdraw", statuses: readonly number[], branch?: string): Promise<ProviderResult> {
  const scenario = JSON.stringify({ branch, operation, statuses });
  const program = `
    const scenario = ${scenario};
    Object.assign(process.env, {
      PDPP_PRIVATE_REPO_NAME: "supporters-private",
      PDPP_PRIVATE_REPO_OWNER: "PDP-Connect",
      PDPP_PRIVATE_REPO_TOKEN: "test-token",
    });
    if (scenario.branch === undefined) delete process.env.PDPP_PRIVATE_REPO_BRANCH;
    else process.env.PDPP_PRIVATE_REPO_BRANCH = scenario.branch;
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
  const result = await runProvider("write", [201], "staged-signatures");
  const request = result.calls[0];

  assert.equal(result.error, null);
  assert.equal(request?.method, "PUT");
  assert.equal(request?.url, "https://api.github.com/repos/PDP-Connect/supporters-private/contents/signatories/2026/signatory-id.json");
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
  assert.match(result.error?.message ?? "", /private repo branch signatures responded 404/);
});

test("withdrawal stops before probing files when its branch is unavailable", async () => {
  const result = await runProvider("withdraw", [404], "missing-branch");

  assert.deepEqual(result.calls, [
    {
      method: "GET",
      url: "https://api.github.com/repos/PDP-Connect/supporters-private/git/ref/heads/missing-branch",
    },
  ]);
  assert.equal(result.error?.name, "SigningUnavailableError");
  assert.match(result.error?.message ?? "", /private repo branch missing-branch is unavailable \(404\)/);
});
