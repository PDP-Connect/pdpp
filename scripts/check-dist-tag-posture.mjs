#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Network-aware release-readiness check for publishable PDPP npm packages.
//
// This is intentionally NOT part of the hermetic `release:policy-check` that
// runs before every publish. It queries the live npm registry and is meant to
// be run by the release owner (or a non-blocking lane), because:
//
//   - the always-on policy check must stay offline and deterministic; and
//   - the placeholder `latest` it detects is a leftover of the npm bootstrap
//     (see docs/reference/package-release-policy.md) that only a real stable release plus
//     owner cleanup of the placeholder can clear.
//
// What it catches: a publishable package whose default `latest` dist-tag
// resolves to the placeholder 0.0.0 (or otherwise lags the published `beta`
// version), so `npm install <pkg>` with no tag would hand an operator an empty
// package. Run it with `pnpm release:dist-tag-check`.
//
// Usage:
//   node scripts/check-dist-tag-posture.mjs [--require-reachable] [--json]
//
// Waiver: set PDPP_RELEASE_DIST_TAG_WAIVER="<reason>" to acknowledge a known,
// temporary posture (e.g. the window before the first stable release lands).
// The reason is printed and the check exits 0, but the
// finding is still reported so the waiver stays honest and visible.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
export const placeholderVersion = "0.0.0";

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function listPublishablePackageNames(rootDir = "packages") {
  const root = path.join(repoRoot, rootDir);
  const names = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const manifestPath = path.join(root, entry.name, "package.json");
    let manifest;
    try {
      manifest = readJson(manifestPath);
    } catch {
      continue;
    }
    if (manifest.name?.startsWith("@pdpp/") && manifest.private !== true) {
      names.push(manifest.name);
    }
  }
  return names.sort();
}

// Pure decision logic for one package's dist-tags. `distTags` is the parsed
// `npm view <pkg> dist-tags --json` object, or null when the package was not
// found / the registry was unreachable.
//
// Returns { status, detail } where status is one of:
//   - 'ok'          latest is a real, non-placeholder version
//   - 'hazard'      latest is the placeholder 0.0.0 (or missing while beta exists)
//   - 'skip'        package not published yet / registry unreachable
export function classifyDistTagPosture(packageName, distTags) {
  if (!distTags) {
    return {
      status: "skip",
      detail: `${packageName}: not published yet or registry unreachable; nothing to verify`,
    };
  }
  const latest = distTags.latest;
  const beta = distTags.beta;
  if (!latest) {
    if (beta) {
      return {
        status: "hazard",
        detail: `${packageName}: no "latest" dist-tag while "beta" is ${beta}; a bare install has no stable target`,
      };
    }
    return {
      status: "skip",
      detail: `${packageName}: no dist-tags published yet; nothing to verify`,
    };
  }
  if (latest === placeholderVersion) {
    return {
      status: "hazard",
      detail: `${packageName}: "latest" resolves to placeholder ${placeholderVersion}${
        beta ? ` while "beta" is ${beta}` : ""
      }; a bare \`npm install ${packageName}\` would install an empty package`,
    };
  }
  return {
    status: "ok",
    detail: `${packageName}: "latest" is ${latest}${beta ? ` ("beta" is ${beta})` : ""}`,
  };
}

async function fetchDistTags(packageName) {
  try {
    const { stdout } = await execFileAsync("npm", ["view", packageName, "dist-tags", "--json"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    const trimmed = stdout.trim();
    if (!trimmed) {
      return null;
    }
    return JSON.parse(trimmed);
  } catch (error) {
    // `npm view` exits non-zero for E404 (package does not exist) and for
    // network failures. Both are non-fatal "skip" signals here.
    const text = `${error.stdout ?? ""}${error.stderr ?? ""}${error.message ?? ""}`;
    if (/E404|404 Not Found|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|network/i.test(text)) {
      return null;
    }
    throw error;
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const requireReachable = args.has("--require-reachable");
  const asJson = args.has("--json");
  const waiver = process.env.PDPP_RELEASE_DIST_TAG_WAIVER?.trim();

  const packageNames = listPublishablePackageNames();
  const results = [];
  for (const packageName of packageNames) {
    const distTags = await fetchDistTags(packageName);
    results.push({ packageName, distTags, ...classifyDistTagPosture(packageName, distTags) });
  }

  const hazards = results.filter((result) => result.status === "hazard");
  const skips = results.filter((result) => result.status === "skip");

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ results, waiver: waiver ?? null }, null, 2)}\n`);
  } else {
    for (const result of results) {
      const marker = result.status === "ok" ? "OK  " : result.status === "skip" ? "SKIP" : "FAIL";
      process.stdout.write(`${marker} ${result.detail}\n`);
    }
  }

  if (requireReachable && skips.length > 0) {
    process.stderr.write(
      `\nFAIL --require-reachable was set but ${skips.length} package(s) could not be verified against the registry.\n`
    );
    process.exit(1);
  }

  if (hazards.length === 0) {
    process.stdout.write('\nPDPP dist-tag posture OK: no publishable package resolves "latest" to a placeholder.\n');
    process.exit(0);
  }

  if (waiver) {
    process.stdout.write(
      `\nPDPP dist-tag posture WAIVED: ${hazards.length} known hazard(s) acknowledged.\nReason: ${waiver}\n` +
        "Clear the waiver and run the owner promotion step in docs/reference/package-release-policy.md to make this pass cleanly.\n"
    );
    process.exit(0);
  }

  process.stderr.write(
    "\nPDPP dist-tag posture check failed:\n" +
      hazards.map((hazard) => `- ${hazard.detail}`).join("\n") +
      "\n\nThe default install target is broken for operators. Either:\n" +
      "  1. promote the package to a real stable `latest` (owner release-readiness step in\n" +
      "     docs/reference/package-release-policy.md), or\n" +
      '  2. set PDPP_RELEASE_DIST_TAG_WAIVER="<reason>" to acknowledge it explicitly.\n' +
      "Until then, a bare `npm install` of the package hands operators the empty placeholder.\n"
  );
  process.exit(1);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exit(1);
  });
}
