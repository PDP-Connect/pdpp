#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Counts how many signatories named each app they would like to see join PDPP.
// Reads a local checkout of the private register and prints [{app, count}],
// highest count first. It prints counts only: no signatory name, email or id
// ever reaches the output, so the output can be shared with a company.

import { readSignatories } from "./publish-supporters.mjs";

const WHITESPACE = /\s+/g;

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

function foldName(name) {
  return String(name).trim().replace(WHITESPACE, " ").toLowerCase();
}

/** The names one record asks for, each once, as [countingKey, canonicalOrNull, spelling]. */
function namesInRecord(record) {
  const names = new Map();
  for (const raw of Array.isArray(record?.requestedApps) ? record.requestedApps : []) {
    const key = typeof raw === "string" ? foldName(raw) : "";
    if (!key) {
      continue;
    }
    const alias = ALIASES.get(key) ?? null;
    const countingKey = (alias ?? key).toLowerCase();
    if (!names.has(countingKey)) {
      names.set(countingKey, { alias, spelling: raw.trim().replace(WHITESPACE, " ") });
    }
  }
  return names;
}

/** Counts requested apps across records. Returns [{app, count}], count descending. */
export function countRequestedApps(records) {
  const groups = new Map();
  for (const record of records) {
    // One signatory counts once per app, however they spelled it.
    for (const [countingKey, { alias, spelling }] of namesInRecord(record)) {
      const group = groups.get(countingKey) ?? { alias, count: 0, spellings: new Map() };
      group.count += 1;
      group.spellings.set(spelling, (group.spellings.get(spelling) ?? 0) + 1);
      groups.set(countingKey, group);
    }
  }
  return [...groups.values()]
    .map((group) => ({
      app:
        group.alias ??
        // Most common spelling wins. A tie goes to the first by code point, which
        // puts a capitalised spelling ahead of a lower-case one.
        [...group.spellings.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0],
      count: group.count,
    }))
    .sort((a, b) => b.count - a.count || a.app.localeCompare(b.app));
}

async function main() {
  const [sourceDirectory] = process.argv.slice(2);
  if (!sourceDirectory) {
    console.error("Usage: count-requested-apps.mjs <private-register-directory>");
    process.exitCode = 1;
    return;
  }
  const counts = countRequestedApps(await readSignatories(sourceDirectory));
  console.log(JSON.stringify(counts, null, 2));
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
