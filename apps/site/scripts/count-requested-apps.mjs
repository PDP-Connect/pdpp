#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Counts how many signatories named each app they would like to see join PDPP.
// Reads a local checkout of the private register and prints, to stdout:
//   {"apps": [{app, count}], "unreviewedAnswers": N}
// `apps` holds only canonical names: the reviewed names below plus the targets
// of the alias map. Anything else a signer typed is free
// text and can be personal data (an email, a name, a phone number), so it is
// counted but never printed. The stdout output is safe to share with a company.
//
// `--review` additionally prints the unreviewed raw values and their counts to
// STDERR, so a maintainer can extend the alias map. That output is private.

import { readSignatories } from "./publish-supporters.mjs";

const WHITESPACE = /\s+/g;

// App names a maintainer has reviewed and may print. The form is free text;
// extend this list (and ALIASES) from what `--review` shows.
const REVIEWED_APP_NAMES = [
  "Amazon",
  "Apple Health",
  "ChatGPT",
  "Clue",
  "Fitbit",
  "Flo",
  "Garmin",
  "Google",
  "Instagram",
  "LinkedIn",
  "Netflix",
  "Oura",
  "Reddit",
  "Spotify",
  "Strava",
  "TikTok",
  "Uber",
  "WhatsApp",
  "X",
  "YouTube",
];

// Lower-cased, space-collapsed spelling -> the name to count it under.
const ALIASES = new Map([
  ["insta", "Instagram"],
  ["ig", "Instagram"],
  ["chat gpt", "ChatGPT"],
  ["chatgpt", "ChatGPT"],
  ["openai", "ChatGPT"],
  ["open ai", "ChatGPT"],
  ["apple health kit", "Apple Health"],
  ["healthkit", "Apple Health"],
  ["twitter", "X"],
  ["yt", "YouTube"],
  ["you tube", "YouTube"],
  ["whats app", "WhatsApp"],
  ["tik tok", "TikTok"],
]);

// Folded spelling -> canonical name, for every name that may be printed.
const CANONICAL = new Map([...REVIEWED_APP_NAMES, ...ALIASES.values()].map((name) => [foldName(name), name]));

function foldName(name) {
  return String(name).trim().replace(WHITESPACE, " ").toLowerCase();
}

/** The distinct folded spellings one record asks for, with their trimmed raw form. */
function namesInRecord(record) {
  const names = new Map();
  for (const raw of Array.isArray(record?.requestedApps) ? record.requestedApps : []) {
    const key = typeof raw === "string" ? foldName(raw) : "";
    if (key && !names.has(key)) {
      names.set(key, raw.trim().replace(WHITESPACE, " "));
    }
  }
  return names;
}

function mostCommonSpelling(spellings) {
  // A tie goes to the first by code point, which puts a capitalised spelling
  // ahead of a lower-case one.
  return [...spellings.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
}

/**
 * Counts requested apps across records. One signatory counts once per app,
 * however they spelled it.
 *
 * Returns:
 * - apps: [{app, count}] for canonical names only, count descending. Safe to share.
 * - unreviewedAnswers: how many answers matched no canonical name. A count only. Safe to share.
 * - unreviewed: [{value, count}] the raw unmatched values. PRIVATE: may be personal data.
 */
export function countRequestedApps(records) {
  const canonicalCounts = new Map();
  const unreviewedGroups = new Map();
  for (const record of records) {
    const seenCanonical = new Set();
    for (const [key, spelling] of namesInRecord(record)) {
      const canonical = ALIASES.get(key) ?? CANONICAL.get(key) ?? null;
      if (canonical) {
        seenCanonical.add(canonical);
        continue;
      }
      const group = unreviewedGroups.get(key) ?? { count: 0, spellings: new Map() };
      group.count += 1;
      group.spellings.set(spelling, (group.spellings.get(spelling) ?? 0) + 1);
      unreviewedGroups.set(key, group);
    }
    for (const canonical of seenCanonical) {
      canonicalCounts.set(canonical, (canonicalCounts.get(canonical) ?? 0) + 1);
    }
  }
  const apps = [...canonicalCounts.entries()]
    .map(([app, count]) => ({ app, count }))
    .sort((a, b) => b.count - a.count || a.app.localeCompare(b.app));
  const unreviewed = [...unreviewedGroups.values()]
    .map((group) => ({ value: mostCommonSpelling(group.spellings), count: group.count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  return {
    apps,
    unreviewed,
    unreviewedAnswers: unreviewed.reduce((total, entry) => total + entry.count, 0),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const review = args.includes("--review");
  const [sourceDirectory] = args.filter((arg) => arg !== "--review");
  if (!sourceDirectory) {
    console.error("Usage: count-requested-apps.mjs [--review] <private-register-directory>");
    process.exitCode = 1;
    return;
  }
  const { apps, unreviewed, unreviewedAnswers } = countRequestedApps(await readSignatories(sourceDirectory));
  console.log(JSON.stringify({ apps, unreviewedAnswers }, null, 2));
  if (review) {
    console.error(
      "PRIVATE: unreviewed values typed by signatories. They may be personal data. Do not share, paste or commit."
    );
    console.error(JSON.stringify(unreviewed, null, 2));
  }
}

if (import.meta.main) {
  main().catch((error) => {
    // A JSON SyntaxError message quotes a snippet of the file, which is
    // personal data, so it is replaced rather than passed through.
    console.error(
      error instanceof SyntaxError ? "A signatory file is not valid JSON." : (error?.message ?? "count failed")
    );
    process.exitCode = 1;
  });
}
