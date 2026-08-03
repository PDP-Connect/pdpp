#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Friend self-host acceptance harness — CLI entry.
//
// Drives the documented friend/self-service path end to end against the
// blessed deploy/docker/docker-compose.yml stack: clean startup, owner
// login, first source add, a Gmail-style static-secret connector, the
// ChatGPT browser-backed connector, a second static-secret connector,
// credential issue/revoke, an MCP client connect+query, and clean teardown.
//
// Fails closed on missing release artifacts (Compose file, Dockerfile build
// targets) before attempting a live run. Never uses real provider
// credentials — every connector step captures a synthetic fixture secret
// through the real credential-capture route; a browser-required connector
// (ChatGPT) is proven either via the fail-closed 503 refusal (no browser
// surface configured) or, with `--profile browser`, the real capture path.
//
// Usage:
//   node scripts/check-friend-journey-acceptance.ts --check-artifacts-only
//   node scripts/check-friend-journey-acceptance.ts --live
//   node scripts/check-friend-journey-acceptance.ts --live --profile browser
//   node scripts/check-friend-journey-acceptance.ts --live --json
//
// `--live` runs a real `docker compose up`, the journey, and
// `docker compose down --volumes` against a throrowaway project name so it
// never collides with a developer's own running stack. Without `--live`,
// only the offline release-artifact check runs — safe to run in CI on every
// PR; `--live` is for a manual or scheduled acceptance run with Docker
// available.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  composeDown,
  composeUp,
  type DockerComposeConfig,
  generateCredentialEncryptionKey,
  generateOwnerPassword,
  verifyCleanTeardown,
  waitForHttpOk,
} from "./friend-journey-acceptance/docker-lifecycle.ts";
import {
  CHATGPT_FIXTURE,
  GMAIL_FIXTURE,
  runFriendJourney,
  THIRD_CONNECTOR_FIXTURE,
} from "./friend-journey-acceptance/journey.ts";
import { checkReleaseArtifacts } from "./friend-journey-acceptance/release-artifacts.ts";
import { renderReport } from "./friend-journey-acceptance/report.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

interface Args {
  checkArtifactsOnly: boolean;
  json: boolean;
  live: boolean;
  profileBrowser: boolean;
  report: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { checkArtifactsOnly: false, json: false, live: false, profileBrowser: false, report: true };
  for (const arg of argv) {
    if (arg === "--check-artifacts-only") {
      args.checkArtifactsOnly = true;
    } else if (arg === "--live") {
      args.live = true;
    } else if (arg === "--profile") {
      // consumed alongside the following "browser" token below
    } else if (arg === "browser") {
      args.profileBrowser = true;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--no-report") {
      args.report = false;
    }
  }
  return args;
}

function fileStamp(iso: string): string {
  return iso.replace(/[:.]/g, "-");
}

async function loadManifest(connectorId: string): Promise<{ connector_id: string; [key: string]: unknown }> {
  const raw = await readFile(
    path.join(REPO_ROOT, "packages", "polyfill-connectors", "manifests", `${connectorId}.json`),
    "utf8"
  );
  return JSON.parse(raw);
}

async function runLive(args: Args, timestamp: string): Promise<{ journeyOk: boolean; markdown: string }> {
  const projectName = `pdpp-friend-e2e-${fileStamp(timestamp).toLowerCase()}`;
  const ownerPassword = generateOwnerPassword();
  const credentialEncryptionKey = generateCredentialEncryptionKey();
  const port = 3000 + (process.pid % 1000);
  const origin = `http://localhost:${port}`;

  const config: DockerComposeConfig = {
    composeFile: path.join(REPO_ROOT, "deploy", "docker", "docker-compose.yml"),
    cwd: REPO_ROOT,
    projectName,
    env: {
      ...process.env,
      COMPOSE_PROJECT_NAME: projectName,
      PDPP_OWNER_PASSWORD: ownerPassword,
      PDPP_CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey,
      PDPP_REFERENCE_ORIGIN: origin,
      PDPP_WEB_PORT: String(port),
      PDPP_EMBEDDING_DOWNLOAD_ALLOWED: "0",
      ...(args.profileBrowser ? { COMPOSE_PROFILES: "browser" } : {}),
    },
  };

  let journeyResult: Awaited<ReturnType<typeof runFriendJourney>> | null = null;
  let teardown: { detail: string; ok: boolean } | null = null;
  try {
    await composeUp(config);
    await waitForHttpOk(`${origin}/.well-known/oauth-authorization-server`, { timeoutMs: 120_000 });
    await waitForHttpOk(`${origin}/.well-known/oauth-protected-resource`, { timeoutMs: 30_000 });

    const manifests = {
      [GMAIL_FIXTURE.connectorId]: await loadManifest(GMAIL_FIXTURE.connectorId),
      [CHATGPT_FIXTURE.connectorId]: await loadManifest(CHATGPT_FIXTURE.connectorId),
      [THIRD_CONNECTOR_FIXTURE.connectorId]: await loadManifest(THIRD_CONNECTOR_FIXTURE.connectorId),
    };

    journeyResult = await runFriendJourney({
      asUrl: origin,
      rsUrl: origin,
      ownerPassword,
      ownerSubjectId: "owner_local",
      browserAvailable: args.profileBrowser,
      manifests,
    });
  } finally {
    await composeDown(config);
    teardown = await verifyCleanTeardown(config);
  }

  const releaseArtifacts = checkReleaseArtifacts(REPO_ROOT);
  const markdown = renderReport({ releaseArtifacts, journey: journeyResult, teardown, timestamp, origin });
  const journeyOk = Boolean(journeyResult?.ok) && teardown.ok;
  return { journeyOk, markdown };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const timestamp = new Date().toISOString();

  const releaseArtifacts = checkReleaseArtifacts(REPO_ROOT);

  let overallOk = releaseArtifacts.ok;
  let markdown: string;

  if (args.checkArtifactsOnly || !args.live) {
    markdown = renderReport({ releaseArtifacts, journey: null, teardown: null, timestamp, origin: null });
  } else if (releaseArtifacts.ok) {
    const { journeyOk, markdown: liveMarkdown } = await runLive(args, timestamp);
    overallOk = journeyOk;
    markdown = liveMarkdown;
  } else {
    // Fail closed: never attempt docker compose up when required artifacts
    // are missing from this checkout.
    markdown = renderReport({ releaseArtifacts, journey: null, teardown: null, timestamp, origin: null });
  }

  let reportPath: string | null = null;
  if (args.report) {
    const dir = path.join(REPO_ROOT, "tmp", "workstreams");
    await mkdir(dir, { recursive: true });
    reportPath = path.join(dir, `friend-journey-acceptance-${fileStamp(timestamp)}.md`);
    await writeFile(reportPath, markdown, "utf8");
  }

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify({ ok: overallOk, reportPath: reportPath ? path.relative(REPO_ROOT, reportPath) : null }, null, 2)}\n`
    );
  } else {
    process.stdout.write(`friend-journey acceptance: ${overallOk ? "PASS" : "FAIL"}\n`);
    if (reportPath) {
      process.stdout.write(`report: ${path.relative(REPO_ROOT, reportPath)}\n`);
    }
  }

  process.exitCode = overallOk ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
