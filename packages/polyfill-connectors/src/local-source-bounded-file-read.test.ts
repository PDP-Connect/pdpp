import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import {
  BOUNDED_READ_EXCEPTIONS,
  type BoundedReadException,
  discoverLocalSourceConnectors,
  findUnapprovedBoundedReads,
} from "./local-source-bounded-read-guard.ts";

const CONNECTORS_ROOT = new URL("../connectors/", import.meta.url);

test("filesystem/local-DB connectors are discovered by manifest binding", () => {
  const discovered = discoverLocalSourceConnectors();
  const expected = [
    "apple_health",
    "claude_code",
    "codex",
    "google_maps",
    "google_takeout",
    "ical",
    "imessage",
    "slack",
    "twitter_archive",
    "whatsapp",
  ];
  for (const connector of expected) {
    assert.ok(
      discovered.includes(connector),
      `${connector} declares a filesystem binding and must be guarded; discovered: ${discovered.join(", ")}`
    );
  }
});

test("no unapproved whole-file reads or unbounded .all() in local-source connectors", () => {
  const findings = findUnapprovedBoundedReads();
  assert.deepEqual(
    findings,
    [],
    `Unapproved bounded-read pattern(s) in filesystem/local-DB connector(s):\n${findings
      .map((finding) => `  ${finding.connector}/${finding.file}:${finding.line} [${finding.pattern}] ${finding.text}`)
      .join("\n")}\nConvert the connector to a streaming/iterating read, or add a reviewed line-specific exception.`
  );
});

test("the codex collector streams SQLite thread rows with iterate()", () => {
  const codexSource = readFileSync(new URL("codex/index.ts", CONNECTORS_ROOT), "utf8");
  assert.match(codexSource, /\.iterate\(\)/, "Codex connector should use the SQLite row iterator");
});

test("iMessage message collection streams chat.db rows with iterate()", () => {
  const imessageSource = readFileSync(new URL("imessage/index.ts", CONNECTORS_ROOT), "utf8");
  assert.doesNotMatch(
    imessageSource,
    /\.all\(/,
    "iMessage connector must stream chat.db message rows with iterate(), not materialize them with .all()"
  );
  assert.match(imessageSource, /\.iterate\(/, "iMessage connector should use the SQLite row iterator");
});

test("every exception names a real connector, file, pattern, line fragment, and reason", () => {
  const validPatterns = new Set<BoundedReadException["pattern"]>(["readFile", "readFileSync", "all"]);
  for (const exception of BOUNDED_READ_EXCEPTIONS) {
    const connectorDir = new URL(`${exception.connector}/`, CONNECTORS_ROOT);
    const files = readdirSync(connectorDir);
    assert.ok(
      files.includes(exception.file),
      `exception for ${exception.connector}/${exception.file} points at a file that does not exist`
    );
    assert.ok(validPatterns.has(exception.pattern), `exception has unknown pattern "${exception.pattern}"`);
    assert.ok(exception.lineIncludes.trim().length >= 8, "exception needs a specific line fragment");
    assert.ok(exception.reason.trim().length >= 20, "exception needs a substantive reason");
  }
});

test("exceptions are live and line-specific", () => {
  for (const exception of BOUNDED_READ_EXCEPTIONS) {
    const source = readFileSync(new URL(`${exception.connector}/${exception.file}`, CONNECTORS_ROOT), "utf8");
    assert.ok(
      source.includes(exception.lineIncludes),
      `stale exception: ${exception.connector}/${exception.file} no longer contains ${JSON.stringify(
        exception.lineIncludes
      )}`
    );
  }
});

test("twitter_archive streams its JS archive instead of whole-file reading", () => {
  const indexSource = readFileSync(new URL("twitter_archive/index.ts", CONNECTORS_ROOT), "utf8");
  assert.doesNotMatch(
    indexSource,
    /\breadFile\b/,
    "twitter_archive must not import or await readFile; it streams the archive via archive-stream.ts"
  );
  const streamSource = readFileSync(new URL("twitter_archive/archive-stream.ts", CONNECTORS_ROOT), "utf8");
  assert.match(
    streamSource,
    /createReadStream/,
    "twitter_archive streaming helper should read the archive with createReadStream"
  );
  assert.match(
    streamSource,
    /@streamparser\/json/,
    "twitter_archive streaming helper should parse the array with the streaming JSON parser"
  );
});

test("the guard fires when a reviewed exception is removed", () => {
  // Negative control against a still-present exception (whatsapp per-export
  // chat read). Removing it must surface the otherwise-allowlisted readFile.
  const withoutWhatsappRead = BOUNDED_READ_EXCEPTIONS.filter(
    (exception) =>
      !(
        exception.connector === "whatsapp" &&
        exception.pattern === "readFile" &&
        exception.lineIncludes.includes("const content = await readFile")
      )
  );
  const findings = findUnapprovedBoundedReads({ exceptions: withoutWhatsappRead });
  assert.ok(
    findings.some(
      (finding) =>
        finding.connector === "whatsapp" &&
        finding.pattern === "readFile" &&
        finding.text.includes("const content = await readFile")
    ),
    "removing the WhatsApp per-export read exception must surface the unbounded read"
  );
});
