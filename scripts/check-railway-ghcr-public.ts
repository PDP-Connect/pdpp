#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Anonymous GHCR public-image probe for the Railway pushbutton publish gate.
//
// The selected first-button shape points the Railway app service at a public,
// anonymously pullable GHCR image:
//
//   core -> ghcr.io/pdp-connect/pdpp/railway-core
//
// A reusable Railway Template CANNOT be published while this package is
// private — Railway pulls the image with no credentials, and the template SHALL
// NOT carry credentials. Until this package is public, this is
// the single known blocker between the repo and a live "Deploy on Railway"
// button. This script is the runnable form of the probe embedded in
// deploy/railway/template.md "Source accessibility gate": it makes the blocker
// state machine-checkable instead of a copy-paste heredoc.
//
// What it does: for each image, request an anonymous GHCR pull token and, if the
// token is granted, list tags. When a pinned tag is required, the script also
// checks the tag's manifest directly because GHCR's tags/list response can lag
// a successful push even when the tag is already anonymously pullable. The GHCR
// registry's anonymous responses are the discriminator (verified live
// 2026-06-05 against a public control image):
//
//   token 200 + tags/list 200  -> PUBLIC   (anonymously pullable; gate clear)
//   token 401                   -> PRIVATE  (auth required; gate BLOCKED)
//   token 403                   -> ABSENT   (no such package path)
//
// The blocker is cleared only when the image reports PUBLIC. The owner clears
// it by flipping the package's visibility to Public (GitHub -> org pdp-connect ->
// Packages -> the package -> Change visibility -> Public). This script does not
// perform the flip; it only reports the gate state and exits non-zero until the
// owner has cleared it.
//
// Usage:
//   node scripts/check-railway-ghcr-public.ts
//   node scripts/check-railway-ghcr-public.ts --json
//   node scripts/check-railway-ghcr-public.ts --tag 0.1.0-beta.7   # also assert the pin exists
//
// Exit codes: 0 = template image PUBLIC (gate clear); 1 = image not pullable
// (gate blocked); 2 = bad usage.

import process from "node:process";
import { fileURLToPath } from "node:url";

// The app-service image, mapped to its Railway service and Dockerfile stage.
// Repository path only — no registry host, no tag.
export const TEMPLATE_IMAGES = [{ image: "pdp-connect/pdpp/railway-core", service: "core", stage: "railway-core" }];

export type Visibility = "absent" | "private" | "public" | "unknown";

export interface TokenStatusVerdict {
  tokenGranted: boolean;
  visibility: Visibility;
}

// Map an anonymous GHCR pull-token HTTP status onto a package-visibility verdict.
// 200 grants a token (package is anonymously readable); 401 means auth required
// (private); 403 means the repository path does not exist. Anything else is an
// unclassified transport result we refuse to treat as "public".
export function classifyTokenStatus(status: number): TokenStatusVerdict {
  if (status === 200) {
    return { visibility: "public", tokenGranted: true };
  }
  if (status === 401) {
    return { visibility: "private", tokenGranted: false };
  }
  if (status === 403) {
    return { visibility: "absent", tokenGranted: false };
  }
  return { visibility: "unknown", tokenGranted: false };
}

export interface ProbeResult {
  image: string;
  manifestStatus: number | undefined;
  ok: boolean;
  reason: string;
  service: string;
  stage: string;
  tags: string[];
  visibility: Visibility;
}

// Collapse a token verdict (+ optional tags/list outcome, a required tag pin,
// and direct manifest outcome) into the final per-image result. An image is
// publishable only when a token was granted. Without a required pin, tags/list
// must be readable. With a required pin, either tags/list contains the tag or the
// tag manifest is anonymously readable; the manifest check is the stronger
// Railway-relevant signal because Railway pulls by tag.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: exhaustive per-outcome GHCR probe classification, carried over unchanged from the .mjs source.
export function classifyProbeResult({
  image,
  service,
  stage,
  tokenStatus,
  tagsStatus,
  tags,
  requiredTag,
  manifestStatus,
}: {
  image: string;
  manifestStatus?: number | undefined;
  requiredTag?: string | undefined;
  service: string;
  stage: string;
  tags?: string[] | undefined;
  tagsStatus?: number | undefined;
  tokenStatus: number;
}): ProbeResult {
  const { visibility, tokenGranted } = classifyTokenStatus(tokenStatus);
  const tagList = Array.isArray(tags) ? tags : [];
  const tagsReadable = tokenGranted && tagsStatus === 200;
  const tagPresent = requiredTag ? tagList.includes(requiredTag) : true;
  const manifestReadable = requiredTag ? manifestStatus === 200 : true;

  let ok: boolean;
  let reason: string;
  if (!tokenGranted) {
    ok = false;
    if (visibility === "private") {
      reason = "private — anonymous pull token refused (401); owner must flip package visibility to Public";
    } else if (visibility === "absent") {
      reason = "absent — no such GHCR package path (403); check the image name";
    } else {
      reason = `unexpected GHCR token status ${tokenStatus}`;
    }
  } else if (requiredTag && (tagPresent || manifestReadable)) {
    ok = true;
    reason = manifestReadable
      ? `public and tag "${requiredTag}" manifest is anonymously readable`
      : `public and tag "${requiredTag}" present`;
  } else if (!tagsReadable) {
    ok = false;
    reason = `token granted but tags/list returned ${tagsStatus}`;
  } else if (requiredTag && !tagPresent) {
    ok = false;
    reason =
      manifestStatus === undefined
        ? `public, but required tag "${requiredTag}" is not published (have: ${tagList.join(", ") || "none"})`
        : `public, but required tag "${requiredTag}" is not anonymously readable (manifest status ${manifestStatus}; tags/list has: ${tagList.join(", ") || "none"})`;
  } else {
    ok = true;
    reason = "public (anonymously pullable)";
  }

  return { image, service, stage, visibility, ok, reason, tags: tagList, manifestStatus };
}

export interface PublishReadiness {
  blocked: ProbeResult[];
  ownerAction: string | null;
  ready: boolean;
}

// The gate is clear only when every image is ok. Returns a verdict plus the
// exact owner action when blocked, so the caller can print a single source of
// truth for "what now".
export function summarizePublishReadiness(results: ProbeResult[]): PublishReadiness {
  const blocked = results.filter((r) => !r.ok);
  const ready = blocked.length === 0;
  return {
    ready,
    blocked,
    ownerAction: ready
      ? null
      : "Flip each blocked package to Public: GitHub -> org pdp-connect -> Packages -> the package -> Change visibility -> Public, then re-run this probe.",
  };
}

export interface ParsedArgs {
  help: boolean;
  json: boolean;
  tag: string | undefined;
  unknown?: string | undefined;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { json: false, tag: undefined, help: false };
  const rest = argv.slice(2);
  let i = 0;
  while (i < rest.length) {
    const arg = rest[i];
    if (arg === "--json") {
      args.json = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--tag") {
      i += 1;
      args.tag = rest[i];
    } else {
      args.unknown = arg;
    }
    i += 1;
  }
  return args;
}

const USAGE = `Usage: node scripts/check-railway-ghcr-public.ts [--json] [--tag <version-tag>]

Probes the Railway template image for anonymous (public) GHCR pullability:
  ${TEMPLATE_IMAGES.map((i) => `ghcr.io/${i.image} (${i.service})`).join("\n  ")}

Exit codes: 0 = public (publish gate clear); 1 = blocked; 2 = bad usage.`;

async function ghcrGet(url: string, headers?: Record<string, string>): Promise<{ response: Response; status: number }> {
  const response = await fetch(url, { headers: headers ?? {} });
  return { status: response.status, response };
}

const MANIFEST_ACCEPT_HEADER = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(",");

// Live probe of one image: anonymous token, then (if granted) tags/list.
async function probeImage(
  { image, service, stage }: { image: string; service: string; stage: string },
  requiredTag?: string
): Promise<ProbeResult> {
  let tokenStatus = 0;
  let tagsStatus: number | undefined;
  let tags: string[] | undefined;
  let manifestStatus: number | undefined;
  try {
    const tokenResult = await ghcrGet(`https://ghcr.io/token?scope=repository:${image}:pull`);
    tokenStatus = tokenResult.status;
    if (tokenStatus === 200) {
      const body = (await tokenResult.response.json()) as { token: string };
      const headers = {
        Authorization: `Bearer ${body.token}`,
        Accept: "application/json",
      };
      const tagsResult = await ghcrGet(`https://ghcr.io/v2/${image}/tags/list`, {
        ...headers,
      });
      tagsStatus = tagsResult.status;
      if (tagsStatus === 200) {
        const tagsBody = (await tagsResult.response.json()) as { tags?: unknown };
        tags = Array.isArray(tagsBody.tags) ? tagsBody.tags : [];
      }
      if (requiredTag) {
        const manifestResult = await ghcrGet(`https://ghcr.io/v2/${image}/manifests/${requiredTag}`, {
          ...headers,
          Accept: MANIFEST_ACCEPT_HEADER,
        });
        manifestStatus = manifestResult.status;
      }
    }
  } catch (error) {
    return {
      image,
      service,
      stage,
      visibility: "unknown",
      ok: false,
      reason: `probe failed: ${error instanceof Error ? error.message : String(error)}`,
      tags: [],
      manifestStatus: undefined,
    };
  }
  return classifyProbeResult({
    image,
    service,
    stage,
    tokenStatus,
    tagsStatus,
    tags,
    requiredTag,
    manifestStatus,
  });
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (args.unknown) {
    process.stderr.write(`Unknown argument: ${args.unknown}\n${USAGE}\n`);
    return 2;
  }

  const results: ProbeResult[] = [];
  for (const target of TEMPLATE_IMAGES) {
    // biome-ignore lint/performance/noAwaitInLoops: probing multiple images sequentially matches the original semantics; parallelizing is a behavior change out of scope for a mechanical migration.
    results.push(await probeImage(target, args.tag));
  }
  const summary = summarizePublishReadiness(results);

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ ...summary, results }, null, 2)}\n`);
    return summary.ready ? 0 : 1;
  }

  for (const result of results) {
    const mark = result.ok ? "OK " : "XX ";
    process.stdout.write(`${mark}ghcr.io/${result.image} (${result.service}): ${result.reason}\n`);
  }
  if (summary.ready) {
    process.stdout.write("\nPublish gate CLEAR: the template image is anonymously pullable.\n");
  } else {
    process.stdout.write(`\nPublish gate BLOCKED.\n${summary.ownerAction}\n`);
  }
  return summary.ready ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      const asError = error as { stack?: string } | undefined;
      process.stderr.write(`${asError?.stack ?? error}\n`);
      process.exitCode = 1;
    }
  );
}
