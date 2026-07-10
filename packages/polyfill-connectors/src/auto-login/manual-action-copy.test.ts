import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const AUTO_LOGIN_DIR = path.resolve(HERE);
const DIAGNOSTIC_TOKEN_RE = /(url=|inputs=|body-preview=)/;
const OWNER_COPY_CONST_PATTERN =
  /(?:^|\n)\s*(?:export\s+)?const\s+[A-Za-z0-9_]*(?:MESSAGE|ASSISTANCE_MESSAGE|FALLBACK_MESSAGE)\s*=\s*([`'"])([\s\S]*?)\1/g;
const OWNER_COPY_MANUAL_ACTION_PATTERN = /manualAction\(\s*\{[\s\S]*?message:\s*([`'"])([\s\S]*?)\1[\s\S]*?\}\s*,/g;

function stripNoise(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/throw new Error\([\s\S]*?\);/g, "");
}

function extractStringLiterals(source: string, pattern: RegExp): string[] {
  const values: string[] = [];
  for (const match of source.matchAll(pattern)) {
    const value = match[2];
    if (typeof value === "string") {
      values.push(value);
    }
  }
  return values;
}

test("auto-login owner-facing assistance copy stays concise and telemetry-free", async () => {
  const entries = await readdir(AUTO_LOGIN_DIR, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
    .map((entry) => path.join(AUTO_LOGIN_DIR, entry.name));

  for (const file of files) {
    const src = await readFile(file, "utf8");
    if (!src.includes("manualAction(")) {
      continue;
    }
    const sanitized = stripNoise(src);
    const ownerCopyStrings = [
      ...extractStringLiterals(sanitized, OWNER_COPY_CONST_PATTERN),
      ...extractStringLiterals(sanitized, OWNER_COPY_MANUAL_ACTION_PATTERN),
    ];
    for (const message of ownerCopyStrings) {
      assert.doesNotMatch(message, DIAGNOSTIC_TOKEN_RE, `owner copy in ${path.basename(file)} leaked raw telemetry`);
    }
  }
});
