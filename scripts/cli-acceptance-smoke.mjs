// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [, , mode] = process.argv;
const repoRoot = new URL("..", import.meta.url).pathname;
const cliBin = join(repoRoot, "packages/cli/bin/pdpp.js");

if (mode === "published-help") {
  const result = run("npx", ["-y", "@pdpp/cli@latest", "--help"], { cwd: repoRoot });
  requireSuccess(result, "published @pdpp/cli --help");
  requireMatch(result.stdout, /PDPP CLI/, "published help output should identify the PDPP CLI");
  process.stdout.write("PASS published @pdpp/cli --help\n");
  process.exit(0);
}

if (mode === "local-connect") {
  try {
    await runLocalConnectSmoke();
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

process.stderr.write(
  [
    "Usage: node scripts/cli-acceptance-smoke.mjs <mode>",
    "",
    "Modes:",
    "  published-help   Run npx -y @pdpp/cli@latest --help.",
    "  local-connect    Run local pdpp connect smoke.",
    "",
  ].join("\n")
);
process.exit(64);

function run(command, args, options) {
  return spawnSync(command, args, {
    ...options,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
}

function requireSuccess(result, label) {
  if (result.status === 0) {
    return;
  }

  process.stderr.write(`FAIL ${label}\n`);
  process.stderr.write(`exit=${result.status}\n`);
  if (result.error) {
    process.stderr.write(`error=${result.error.message}\n`);
  }
  if (result.stdout) {
    process.stderr.write(`stdout:\n${result.stdout}\n`);
  }
  if (result.stderr) {
    process.stderr.write(`stderr:\n${result.stderr}\n`);
  }
  process.exit(1);
}

function requireMatch(value, pattern, message) {
  if (pattern.test(value)) {
    return;
  }

  process.stderr.write(`FAIL ${message}\n`);
  process.stderr.write(`stdout:\n${value}\n`);
  process.exit(1);
}

async function runLocalConnectSmoke() {
  if (!existsSync(cliBin)) {
    throw new Error(`FAIL local CLI bin missing: ${cliBin}`);
  }

  if (process.env.PDPP_CONNECT_SMOKE_PROVIDER_URL) {
    return runExternalLocalConnectSmoke(process.env.PDPP_CONNECT_SMOKE_PROVIDER_URL);
  }

  const tmpRoot = await mkdtemp(join(tmpdir(), "pdpp-cli-connect-smoke-"));
  let server = null;
  try {
    const [{ startServer }, nativeManifest] = await Promise.all([
      import("../reference-implementation/server/index.js"),
      readFile(join(repoRoot, "reference-implementation/manifests/northstar-hr.json"), "utf8").then(JSON.parse),
    ]);
    server = await startServer({
      asPort: 0,
      awaitStartupBackfill: true,
      bindHost: "127.0.0.1",
      dbPath: join(tmpRoot, "reference.sqlite"),
      hybridRetrievalSupported: false,
      lexicalRetrievalSupported: false,
      nativeManifest,
      quiet: true,
      rsPort: 0,
      semanticRetrievalSupported: false,
    });

    const providerUrl = `http://localhost:${server.rsPort}`;
    const result = await runConnectAndApprove({
      cwd: tmpRoot,
      providerUrl,
      timeoutMs: 15_000,
    });
    if (result.status !== 0) {
      throw formatConnectFailure(providerUrl, result);
    }
    process.stdout.write(`PASS local pdpp connect ${providerUrl}\n`);
  } finally {
    await closeReferenceServer(server);
    await rm(tmpRoot, { force: true, recursive: true });
  }
}

function runExternalLocalConnectSmoke(providerUrl) {
  const result = run(process.execPath, [cliBin, "connect", providerUrl], { cwd: repoRoot });

  if (result.status === 0) {
    process.stdout.write(`PASS local pdpp connect ${providerUrl}\n`);
    return;
  }

  const blockedReason = getConnectBlockedReason(result.stderr);
  const gated = result.status === 69 && blockedReason;
  if (gated && process.env.PDPP_CONNECT_SMOKE_REQUIRE_ENABLED !== "1") {
    process.stdout.write(
      [
        `SKIP local pdpp connect ${providerUrl}`,
        `Reason: ${blockedReason}`,
        "Set PDPP_CONNECT_SMOKE_REQUIRE_ENABLED=1 to require the external provider to be connect-ready.",
        "",
      ].join("\n")
    );
    return;
  }

  throw formatConnectFailure(providerUrl, result);
}

function runConnectAndApprove({ providerUrl, cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliBin, "connect", providerUrl], {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let approvalPosted = false;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(
        new Error(
          `FAIL local pdpp connect ${providerUrl}\nTimed out waiting for approval flow.\nstdout:\n${stdout}\nstderr:\n${stderr}`
        )
      );
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (!approvalPosted) {
        const approvalUrl = extractApprovalUrl(stdout);
        if (approvalUrl) {
          approvalPosted = true;
          approveAccess(approvalUrl).catch((error) => {
            child.kill("SIGTERM");
            reject(error);
          });
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (status) => {
      clearTimeout(timeout);
      resolve({ status, stderr, stdout });
    });
  });
}

function extractApprovalUrl(stdout) {
  const match = stdout.match(/https?:\/\/[^\s]+\/consent\?request_uri=[^\s]+/);
  return match?.[0] ?? null;
}

async function approveAccess(approvalUrl) {
  const url = new URL(approvalUrl);
  const requestUri = url.searchParams.get("request_uri");
  if (!requestUri) {
    throw new Error(`FAIL approval URL missing request_uri: ${approvalUrl}`);
  }
  const response = await fetch(new URL("/consent/approve", url), {
    body: new URLSearchParams({ request_uri: requestUri, subject_id: "owner_local" }).toString(),
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
    redirect: "manual",
  });
  if (!response.ok && response.status !== 302 && response.status !== 303) {
    throw new Error(`FAIL test approval failed: HTTP ${response.status}`);
  }
}

async function closeReferenceServer(server) {
  if (!server) {
    return;
  }
  server.abortStartupBackfill?.("cli-connect-smoke complete");
  await Promise.all([closeNodeServer(server.asServer), closeNodeServer(server.rsServer)]);
}

function closeNodeServer(server) {
  if (!server) {
    return Promise.resolve();
  }
  server.closeAllConnections?.();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function formatConnectFailure(providerUrl, result) {
  const lines = [`FAIL local pdpp connect ${providerUrl}`, `exit=${result.status}`];
  if (result.error) {
    lines.push(`error=${result.error.message}`);
  }
  if (result.stdout) {
    lines.push(`stdout:\n${result.stdout}`);
  }
  if (result.stderr) {
    lines.push(`stderr:\n${result.stderr}`);
  }
  return new Error(lines.join("\n"));
}

function getConnectBlockedReason(stderr) {
  if (/not enabled yet|no-owner-token scoped grant completion/i.test(stderr)) {
    return "CLI reported that no-owner-token scoped grant completion is not enabled.";
  }

  if (stderr.includes("/.well-known/oauth-protected-resource") && /HTTP 404/i.test(stderr)) {
    return "local reference server did not expose protected-resource metadata for connect smoke.";
  }

  if (/fetch failed|ECONNREFUSED|ENOTFOUND/i.test(stderr)) {
    return "local reference provider was unavailable for connect smoke.";
  }

  return null;
}
