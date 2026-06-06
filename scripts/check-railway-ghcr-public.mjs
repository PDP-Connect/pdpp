#!/usr/bin/env node
// Anonymous GHCR public-image probe for the Railway pushbutton publish gate.
//
// The selected first-button shape (deploy/railway/template.md Option 1) points
// both Railway app services at public, anonymously pullable GHCR images:
//
//   console   -> ghcr.io/vana-com/pdpp/web
//   reference -> ghcr.io/vana-com/pdpp/reference
//
// A reusable Railway Template CANNOT be published while those packages are
// private — Railway pulls the image with no credentials, and the template SHALL
// NOT carry credentials. As of 2026-06-05 both packages are private, so this is
// the single known blocker between the repo and a live "Deploy on Railway"
// button. This script is the runnable form of the probe embedded in
// deploy/railway/template.md "Source accessibility gate": it makes the blocker
// state machine-checkable instead of a copy-paste heredoc.
//
// What it does: for each image, request an anonymous GHCR pull token and, if the
// token is granted, list tags. The GHCR registry's anonymous responses are the
// discriminator (verified live 2026-06-05 against a public control image):
//
//   token 200 + tags/list 200  -> PUBLIC   (anonymously pullable; gate clear)
//   token 401                   -> PRIVATE  (auth required; gate BLOCKED)
//   token 403                   -> ABSENT   (no such package path)
//
// The blocker is cleared only when BOTH images report PUBLIC. The owner clears
// it by flipping each package's visibility to Public (GitHub -> org vana-com ->
// Packages -> the package -> Change visibility -> Public). This script does not
// perform the flip; it only reports the gate state and exits non-zero until the
// owner has cleared it.
//
// Usage:
//   node scripts/check-railway-ghcr-public.mjs
//   node scripts/check-railway-ghcr-public.mjs --json
//   node scripts/check-railway-ghcr-public.mjs --tag 0.1.0-beta.7   # also assert the pin exists
//
// Exit codes: 0 = both images PUBLIC (gate clear); 1 = one or more not pullable
// (gate blocked); 2 = bad usage.

import process from 'node:process';
import { fileURLToPath } from 'node:url';

// The two app-service images, mapped to their Railway service and Dockerfile
// stage. Repository path only — no registry host, no tag.
export const TEMPLATE_IMAGES = [
  { image: 'vana-com/pdpp/web', service: 'console', stage: 'console' },
  { image: 'vana-com/pdpp/reference', service: 'reference', stage: 'reference' },
];

// Map an anonymous GHCR pull-token HTTP status onto a package-visibility verdict.
// 200 grants a token (package is anonymously readable); 401 means auth required
// (private); 403 means the repository path does not exist. Anything else is an
// unclassified transport result we refuse to treat as "public".
export function classifyTokenStatus(status) {
  if (status === 200) {
    return { visibility: 'public', tokenGranted: true };
  }
  if (status === 401) {
    return { visibility: 'private', tokenGranted: false };
  }
  if (status === 403) {
    return { visibility: 'absent', tokenGranted: false };
  }
  return { visibility: 'unknown', tokenGranted: false };
}

// Collapse a token verdict (+ optional tags/list outcome and a required tag pin)
// into the final per-image result. An image is publishable only when a token was
// granted AND tags/list returned 200; when a --tag pin is requested it must also
// appear in the listed tags.
export function classifyProbeResult({ image, service, stage, tokenStatus, tagsStatus, tags, requiredTag }) {
  const { visibility, tokenGranted } = classifyTokenStatus(tokenStatus);
  const tagList = Array.isArray(tags) ? tags : [];
  const tagsReadable = tokenGranted && tagsStatus === 200;
  const tagPresent = requiredTag ? tagList.includes(requiredTag) : true;

  let ok = false;
  let reason;
  if (!tokenGranted) {
    ok = false;
    reason =
      visibility === 'private'
        ? 'private — anonymous pull token refused (401); owner must flip package visibility to Public'
        : visibility === 'absent'
          ? 'absent — no such GHCR package path (403); check the image name'
          : `unexpected GHCR token status ${tokenStatus}`;
  } else if (!tagsReadable) {
    ok = false;
    reason = `token granted but tags/list returned ${tagsStatus}`;
  } else if (!tagPresent) {
    ok = false;
    reason = `public, but required tag "${requiredTag}" is not published (have: ${tagList.join(', ') || 'none'})`;
  } else {
    ok = true;
    reason = requiredTag ? `public and tag "${requiredTag}" present` : 'public (anonymously pullable)';
  }

  return { image, service, stage, visibility, ok, reason, tags: tagList };
}

// The gate is clear only when every image is ok. Returns a verdict plus the
// exact owner action when blocked, so the caller can print a single source of
// truth for "what now".
export function summarizePublishReadiness(results) {
  const blocked = results.filter((r) => !r.ok);
  const ready = blocked.length === 0;
  return {
    ready,
    blocked,
    ownerAction: ready
      ? null
      : 'Flip each blocked package to Public: GitHub -> org vana-com -> Packages -> the package -> Change visibility -> Public, then re-run this probe.',
  };
}

export function parseArgs(argv) {
  const args = { json: false, tag: undefined, help: false };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--json') {
      args.json = true;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--tag') {
      args.tag = rest[i + 1];
      i += 1;
    } else {
      args.unknown = arg;
    }
  }
  return args;
}

const USAGE = `Usage: node scripts/check-railway-ghcr-public.mjs [--json] [--tag <version-tag>]

Probes the two Railway template images for anonymous (public) GHCR pullability:
  ${TEMPLATE_IMAGES.map((i) => `ghcr.io/${i.image} (${i.service})`).join('\n  ')}

Exit codes: 0 = both public (publish gate clear); 1 = blocked; 2 = bad usage.`;

async function ghcrGet(url, headers) {
  const response = await fetch(url, { headers: headers ?? {} });
  return { status: response.status, response };
}

// Live probe of one image: anonymous token, then (if granted) tags/list.
async function probeImage({ image, service, stage }, requiredTag) {
  let tokenStatus = 0;
  let tagsStatus;
  let tags;
  try {
    const tokenResult = await ghcrGet(`https://ghcr.io/token?scope=repository:${image}:pull`);
    tokenStatus = tokenResult.status;
    if (tokenStatus === 200) {
      const body = await tokenResult.response.json();
      const tagsResult = await ghcrGet(`https://ghcr.io/v2/${image}/tags/list`, {
        Authorization: `Bearer ${body.token}`,
        Accept: 'application/json',
      });
      tagsStatus = tagsResult.status;
      if (tagsStatus === 200) {
        const tagsBody = await tagsResult.response.json();
        tags = Array.isArray(tagsBody.tags) ? tagsBody.tags : [];
      }
    }
  } catch (error) {
    return {
      image,
      service,
      stage,
      visibility: 'unknown',
      ok: false,
      reason: `probe failed: ${error.message}`,
      tags: [],
    };
  }
  return classifyProbeResult({ image, service, stage, tokenStatus, tagsStatus, tags, requiredTag });
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (args.unknown) {
    process.stderr.write(`Unknown argument: ${args.unknown}\n${USAGE}\n`);
    return 2;
  }

  const results = [];
  for (const target of TEMPLATE_IMAGES) {
    results.push(await probeImage(target, args.tag));
  }
  const summary = summarizePublishReadiness(results);

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ ...summary, results }, null, 2)}\n`);
    return summary.ready ? 0 : 1;
  }

  for (const result of results) {
    const mark = result.ok ? 'OK ' : 'XX ';
    process.stdout.write(`${mark}ghcr.io/${result.image} (${result.service}): ${result.reason}\n`);
  }
  if (summary.ready) {
    process.stdout.write('\nPublish gate CLEAR: both template images are anonymously pullable.\n');
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
    (error) => {
      process.stderr.write(`${error?.stack ?? error}\n`);
      process.exitCode = 1;
    },
  );
}
