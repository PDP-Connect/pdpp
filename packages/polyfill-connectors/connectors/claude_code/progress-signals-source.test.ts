import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const CONNECTOR_INDEXES = ["apple_health", "claude_code", "codex", "google_takeout", "imessage", "twitter_archive"].map(
  (name) => join(import.meta.dirname, "..", name, "index.ts")
);

const UNSAFE_OPERATOR_MESSAGE_PATTERNS: [RegExp, string][] = [
  [
    /message:\s*`[^`]*\$\{[^}`]*(?:path|Path|file|File|projectDir|sessionId|baseDir|importDir|dir)[^}`]*\}/,
    "message interpolates a local/archive identifier",
  ],
  [
    /progress\(\s*`[^`]*\$\{[^}`]*(?:path|Path|file|File|projectDir|sessionId|baseDir|importDir|dir)[^}`]*\}/,
    "progress interpolates a local/archive identifier",
  ],
  [/message:\s*`[^`]*(?:\.jsonl|\.json|\.js|\.xml|\.db)[^`]*`/, "message includes a concrete source filename"],
  [/progress\(\s*`[^`]*(?:\.jsonl|\.json|\.js|\.xml|\.db)[^`]*`/, "progress includes a concrete source filename"],
];

test("large local/archive connector operator messages do not expose source identifiers", () => {
  const failures: string[] = [];
  for (const path of CONNECTOR_INDEXES) {
    const source = readFileSync(path, "utf8");
    for (const [pattern, reason] of UNSAFE_OPERATOR_MESSAGE_PATTERNS) {
      const match = source.match(pattern);
      if (match) {
        failures.push(`${path}: ${reason}: ${match[0]}`);
      }
    }
  }
  assert.deepEqual(failures, []);
});
