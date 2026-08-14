const TOP_LEVEL_REGEX_1 = /effectiveArgs\s*=\s*\[?['"]--test-force-exit['"]/;
const FAILURE_CODE_PATTERN = /ERR_TEST_FAILURE/;
const FAILURE_MESSAGE_PATTERN = /failure message context/;
const FAILURE_STACK_PATTERN = /"stack":"Error \[ERR_TEST_FAILURE\]: failure message context/;
const FAILURE_TEST_NAME_PATTERN = /reporter preserves intentional failure diagnostics/;
const LIFECYCLE_EVENT_PATTERN =
  /"type":"(test:enqueue|test:dequeue|test:start|test:complete|test:plan|test:summary|test:stderr|test:diagnostic)"/;
const REDACTED_PATTERN = /\[REDACTED\]/;
const RETAINED_CONTEXT_PATTERN = /stderr context|useful trailing context|\[REDACTED\]/;
const SPLIT_MARKER_PATTERN = /marker-direct-split/;
const SPLIT_REDACTION_PATTERN = /GITHUB_TOKEN=\[REDACTED\]/;
const BOUNDED_DIAGNOSTIC_MARKER_PATTERN = /marker-bounded-diagnostic/;
const SAFE_QUERY_CONTEXT_PATTERN = /&safe=retained/;
const REDACTED_AUTHORIZATION_PATTERN = /Authorization: \[REDACTED\]/;
const SAFE_EMPTY_PASSWORD_URL_PATTERN = /postgres:\/\/alice:@example\.test\/db/;
const SAFE_NAMED_USER_URL_PATTERN = /postgres:\/\/alice@example\.test\/db/;
const SAFE_NO_USER_URL_PATTERN = /postgres:\/\/example\.test\/db/;
const REDACTED_EXAMPLE_USERINFO_PATTERN = /\[REDACTED\]@example\.test/;
const BUDGET_EXHAUSTED_PATTERN = /\[REDACTED scan budget exhausted\]/;

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression oracle for a reporter-stream race that made
 * `pnpm test-accounting:check` flip its RI skip count between 104 and 105
 * across identical clean-tree runs.
 *
 * Root cause: `--test-force-exit` makes Node's test runner call
 * process.exit() as soon as its own internal bookkeeping considers a file
 * "done", without waiting for the custom reporter (an async generator
 * consuming the runner's internal event stream) to finish draining that
 * file's trailing test:pass/test:fail/test:complete events. The reporter's
 * `for await` loop is then cut short mid-stream, non-deterministically
 * dropping a variable number of trailing events even though every test in
 * the file actually ran and passed. `structuredNodeSummary` (receipt.ts)
 * stays internally consistent on the truncated stream (assertions still
 * equals passed+failed+skipped), so this does not crash — it silently
 * undercounts, which is what let it slip past every non-repeated run.
 *
 * The fix (reference-implementation/scripts/run-tests.ts) stops forwarding
 * --test-force-exit to child `node --test` processes and instead bounds a
 * genuinely hung file with a runner-level SIGKILL watchdog. The watchdog
 * fires after PDPP_TEST_FILE_TIMEOUT_MS without output or at the separate
 * PDPP_TEST_FILE_HARD_TIMEOUT_MS absolute deadline. A normal run drains its
 * reporter completely and exits before either deadline fires.
 *
 * This test spawns the real reporter against the file where the race was
 * observed live (compact-record-history.test.js has both a large pure-helper
 * section and a trailing Postgres-gated boolean-skip test — the exact shape
 * that exposed the drop) and asserts the structured event count is stable
 * across repeated runs. Reverting the fix (re-adding --test-force-exit to
 * the spawned args) reproduces flakiness in this same assertion.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import accountingReporter, {
  redactStructuredHeaders,
  redactStructuredHeadersWithBudget,
} from "../../scripts/test-accounting/node-reporter.ts";
import { structuredNodeSummary } from "../../scripts/test-accounting/receipt.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const REPORTER_PATH = fileURLToPath(new URL("../../scripts/test-accounting/node-reporter.ts", import.meta.url));
const TARGET_TEST_FILE = "reference-implementation/test/compact-record-history.test.ts";
const RUN_COUNT = 6;
const REPORTER_FAILURE_NAME = "reporter preserves intentional failure diagnostics";
const MAX_FAILURE_FIELD_LENGTH = 2000;
const MAX_FAILURE_DIAGNOSTIC_LENGTH = 4000;
const DIAGNOSTIC_OVERFLOW_PATTERN = /\[REDACTED diagnostic overflow\]/;
type ReporterEvent = Parameters<typeof accountingReporter>[0] extends AsyncIterable<infer Event> ? Event : never;

interface SensitiveFailureCase {
  marker: string;
  payload: string;
  stderrChunks?: string[];
}

const SENSITIVE_FAILURE_CASES: readonly SensitiveFailureCase[] = [
  { marker: "marker-bearer-credential", payload: "Authorization: Bearer marker-bearer-credential" },
  { marker: "marker-basic-credential", payload: "Authorization: Basic marker-basic-credential" },
  { marker: "marker-token-scheme", payload: "Authorization: Token marker-token-scheme" },
  { marker: "marker-raw-token-header", payload: '{"Authorization":"Token marker-raw-token-header"}' },
  { marker: "marker-raw-bearer-header", payload: '{"Authorization":"Bearer marker-raw-bearer-header"}' },
  { marker: "marker-raw-basic-header", payload: '{"Authorization":"Basic marker-raw-basic-header"}' },
  { marker: "marker-escaped-token-header", payload: '"{\\"Authorization\\":\\"Token marker-escaped-token-header\\"}"' },
  {
    marker: "marker-escaped-bearer-header",
    payload: '"{\\"Authorization\\":\\"Bearer marker-escaped-bearer-header\\"}"',
  },
  { marker: "marker-escaped-basic-header", payload: '"{\\"Authorization\\":\\"Basic marker-escaped-basic-header\\"}"' },
  { marker: "marker-lowercase-auth-header", payload: '{"authorization":"Token marker-lowercase-auth-header"}' },
  { marker: "marker-raw-cookie-header", payload: '{"Cookie":"session=marker-raw-cookie-header"}' },
  { marker: "marker-raw-set-cookie-header", payload: '{"Set-Cookie":"session=marker-raw-set-cookie-header"}' },
  { marker: "marker-escaped-cookie-header", payload: '"{\\"Cookie\\":\\"session=marker-escaped-cookie-header\\"}"' },
  {
    marker: "marker-escaped-set-cookie-header",
    payload: '"{\\"Set-Cookie\\":\\"session=marker-escaped-set-cookie-header\\"}"',
  },
  { marker: "marker-mixed-cookie-header", payload: '{"cOoKiE":"session=marker-mixed-cookie-header"}' },
  { marker: "marker-github-token", payload: "GITHUB_TOKEN=marker-github-token" },
  { marker: "marker-github-json", payload: '{"GITHUB_TOKEN":"marker-github-json"}' },
  { marker: "marker-client-secret", payload: "client_secret=marker-client-secret" },
  { marker: "marker-client-quoted", payload: 'client_secret="marker-client-quoted"' },
  { marker: "marker-json-access-token", payload: '{"access_token":"marker-json-access-token"}' },
  { marker: "marker-access-token", payload: "access_token=marker-access-token" },
  { marker: "probe_token_9f20", payload: "token=probe_token_9f20" },
  { marker: "probe_secret_9f21", payload: "secret=probe_secret_9f21" },
  { marker: "probe_password_9f22", payload: "password=probe_password_9f22" },
  { marker: "probe_apikey_9f23", payload: "api_key=probe_apikey_9f23" },
  { marker: "marker-json-token", payload: '{"token":"marker-json-token"}' },
  { marker: "marker-json-secret", payload: '{"secret":"marker-json-secret"}' },
  { marker: "marker-json-password", payload: '{"password":"marker-json-password"}' },
  { marker: "marker-json-api-key", payload: '{"api_key":"marker-json-api-key"}' },
  { marker: "marker-cookie", payload: "Cookie: session=marker-cookie; theme=retained" },
  { marker: "marker-set-cookie", payload: "Set-Cookie: session=marker-set-cookie; HttpOnly" },
  { marker: "ghp_markerpatvalueabcdefghijklmnop", payload: "ghp_markerpatvalueabcdefghijklmnop" },
  { marker: "github_pat_markerpatvalueabcdefghijk", payload: "github_pat_markerpatvalueabcdefghijk" },
  { marker: "marker-url-userinfo", payload: "postgres://alice:marker-url-userinfo@example.test/db" },
  { marker: "marker-empty-user-dsn", payload: "postgres://:marker-empty-user-dsn@example.test/db" },
  { marker: "marker-redis-empty-user", payload: "redis://:marker-redis-empty-user@example.test/0" },
  { marker: "marker-https-userinfo", payload: "https://owner:marker-https-userinfo@example.test/path" },
  {
    marker: "marker-query-token",
    payload: "https://example.test/callback?access_token=marker-query-token&safe=retained",
  },
  {
    marker: "marker-query-secret",
    payload: "https://example.test/callback?client_secret=marker-query-secret&safe=retained",
  },
  {
    marker: "marker-split-boundary",
    payload: `GITHUB_TOKEN${" ".repeat(4500)}=marker-split-boundary`,
  },
  {
    marker: "marker-oversized-value",
    payload: `access_token=marker-oversized-value${"x".repeat(6000)}\nuseful trailing context`,
  },
];

// A structured header's key/colon/value separators can be literal whitespace
// (including Unicode separators such as U+2028 LINE SEPARATOR, U+2029
// PARAGRAPH SEPARATOR, and U+00A0 NO-BREAK SPACE — diagnostics are
// JSON-*like*, not necessarily strictly valid JSON, so a redactor that fails
// closed on malformed input cannot assume only ASCII whitespace appears) or,
// once the payload is JSON-serialized one or more times, an escaped
// whitespace sequence (`\t`/`\n`/`\r` or `\uXXXX` for the Unicode
// separators, themselves re-escaped by each further serialization layer).
// This matrix drives every mixed-case structured header key through every
// separator form (literal ASCII, literal Unicode, and manually-escaped
// `\uXXXX`) at every escape depth, so the redactor's whitespace handling is
// proven as a closed class rather than by one example per depth.
const STRUCTURED_WHITESPACE_HEADER_KEYS: readonly string[] = ["Authorization", "aUtHoRiZaTiOn", "Cookie", "sEt-CoOkIe"];
const STRUCTURED_WHITESPACE_SEPARATORS: readonly { label: string; whitespace: string }[] = [
  { label: "space", whitespace: " " },
  { label: "tab", whitespace: "\t" },
  { label: "newline", whitespace: "\n" },
  { label: "carriage-return", whitespace: "\r" },
  { label: "crlf", whitespace: "\r\n" },
  { label: "line-separator-u2028", whitespace: String.fromCodePoint(0x20_28) },
  { label: "paragraph-separator-u2029", whitespace: String.fromCodePoint(0x20_29) },
  { label: "nbsp-u00a0", whitespace: String.fromCodePoint(0x00_a0) },
];
// Manually-escaped `\uXXXX` separator forms: JSON.stringify never produces
// these itself (it leaves U+2028/U+2029/U+00A0 as literal characters, which
// STRUCTURED_WHITESPACE_SEPARATORS above already covers at every escape
// depth), but JSON-like diagnostic text authored or emitted by a different
// serializer legitimately can.
const STRUCTURED_ESCAPED_UNICODE_WHITESPACE_SEPARATORS: readonly { hex: string; label: string }[] = [
  { hex: "2028", label: "escaped-line-separator-u2028" },
  { hex: "2029", label: "escaped-paragraph-separator-u2029" },
  { hex: "00a0", label: "escaped-nbsp-u00a0" },
  { hex: "00A0", label: "escaped-nbsp-u00A0-uppercase-hex" },
];

function structuredWhitespacePayload(key: string, whitespace: string, marker: string): string {
  const rawPayload = `{"${key}"${whitespace}:${whitespace}"Token ${marker}"}`;
  return whitespace === " " ? rawPayload : JSON.stringify(rawPayload);
}

function doubleEscapedStructuredWhitespacePayload(key: string, whitespace: string, marker: string): string {
  return JSON.stringify(structuredWhitespacePayload(key, whitespace, marker));
}

function structuredEscapedUnicodeWhitespacePayload(key: string, hex: string, marker: string): string {
  return `{"${key}"\\u${hex}:\\u${hex}"Token ${marker}"}`;
}

const STRUCTURED_WHITESPACE_FAILURE_CASES: readonly SensitiveFailureCase[] = STRUCTURED_WHITESPACE_HEADER_KEYS.flatMap(
  (key) =>
    STRUCTURED_WHITESPACE_SEPARATORS.flatMap(({ label, whitespace }) => {
      const singleMarker = `marker-ws-${key.toLowerCase()}-${label}-single`;
      const doubleMarker = `marker-ws-${key.toLowerCase()}-${label}-double`;
      return [
        { marker: singleMarker, payload: structuredWhitespacePayload(key, whitespace, singleMarker) },
        { marker: doubleMarker, payload: doubleEscapedStructuredWhitespacePayload(key, whitespace, doubleMarker) },
      ];
    })
);

const STRUCTURED_ESCAPED_UNICODE_WHITESPACE_FAILURE_CASES: readonly SensitiveFailureCase[] =
  STRUCTURED_WHITESPACE_HEADER_KEYS.flatMap((key) =>
    STRUCTURED_ESCAPED_UNICODE_WHITESPACE_SEPARATORS.flatMap(({ hex, label }) => {
      const marker = `marker-ws-${key.toLowerCase()}-${label}`;
      return [{ marker, payload: structuredEscapedUnicodeWhitespacePayload(key, hex, marker) }];
    })
  );

// A recognized structured header whose value quote never closes (malformed
// JSON, a truncated log line, a mid-write crash) must still be redacted: the
// scanner fails closed by treating "opener with no closer" as "redact from
// the opener to the end of this field" rather than leaving the fragment —
// which still carries the credential — untouched. This matrix drives every
// structured header key, at raw/single/double escape depth, through an
// unterminated value.
const UNTERMINATED_STRUCTURED_HEADER_KEYS: readonly string[] = ["Authorization", "Cookie", "Set-Cookie"];

function unterminatedStructuredHeaderPayload(key: string, marker: string): string {
  return `{"${key}":"Token ${marker}`;
}

function unterminatedEscapedStructuredHeaderPayload(key: string, marker: string): string {
  return JSON.stringify(unterminatedStructuredHeaderPayload(key, marker));
}

function unterminatedDoubleEscapedStructuredHeaderPayload(key: string, marker: string): string {
  return JSON.stringify(unterminatedEscapedStructuredHeaderPayload(key, marker));
}

const UNTERMINATED_STRUCTURED_HEADER_CASES: readonly SensitiveFailureCase[] =
  UNTERMINATED_STRUCTURED_HEADER_KEYS.flatMap((key) => {
    const rawMarker = `marker-unterminated-${key.toLowerCase()}-raw`;
    const singleMarker = `marker-unterminated-${key.toLowerCase()}-single`;
    const doubleMarker = `marker-unterminated-${key.toLowerCase()}-double`;
    return [
      { marker: rawMarker, payload: unterminatedStructuredHeaderPayload(key, rawMarker) },
      { marker: singleMarker, payload: unterminatedEscapedStructuredHeaderPayload(key, singleMarker) },
      { marker: doubleMarker, payload: unterminatedDoubleEscapedStructuredHeaderPayload(key, doubleMarker) },
    ];
  });

// Once a quoted key case-insensitively matches Authorization, Cookie, or
// Set-Cookie, ANY malformed or unsupported attempted `\u` separator syntax
// before its colon/value must fail the ENTIRE FIELD closed — never fall
// back to copying the unrecognized candidate through, because the
// credential may still be present in whatever unrecognized syntax follows
// the confirmed-sensitive key. This matrix covers the defect class the gate
// demonstrated (not just its one reproduction example): truncated `\u`
// escapes of every length, invalid hex digits, a syntactically complete but
// unsupported escaped Unicode-space code point, and an overlong (5-hex-digit)
// escape — each for every recognized header key, at raw, single-, and
// double-serialized depth.
const MALFORMED_SEPARATOR_HEADER_KEYS: readonly string[] = ["Authorization", "aUtHoRiZaTiOn", "Cookie", "sEt-CoOkIe"];
const MALFORMED_SEPARATOR_FORMS: readonly { label: string; separator: string }[] = [
  { label: "truncated-u-bare", separator: "\\u" },
  { label: "truncated-u-1-digit", separator: "\\u2" },
  { label: "truncated-u-2-digits", separator: "\\u20" },
  { label: "truncated-u-3-digits", separator: "\\u202" },
  { label: "invalid-hex-all", separator: "\\uZZZZ" },
  { label: "invalid-hex-partial", separator: "\\u20ZZ" },
  { label: "unsupported-unicode-space-u2000", separator: "\\u2000" },
  { label: "unsupported-unicode-space-u3000", separator: "\\u3000" },
  { label: "overlong-5-hex-digits", separator: "\\u20280" },
];
const MALFORMED_SENSITIVE_HEADER_PATTERN = /\[REDACTED malformed sensitive header\]/;

function malformedSeparatorPayload(key: string, separator: string, marker: string): string {
  return `{"${key}"${separator}:${separator}"Token ${marker}"}`;
}

function malformedSeparatorEscapedPayload(key: string, separator: string, marker: string): string {
  return JSON.stringify(malformedSeparatorPayload(key, separator, marker));
}

function malformedSeparatorDoubleEscapedPayload(key: string, separator: string, marker: string): string {
  return JSON.stringify(malformedSeparatorEscapedPayload(key, separator, marker));
}

const MALFORMED_SEPARATOR_CASES: readonly SensitiveFailureCase[] = MALFORMED_SEPARATOR_HEADER_KEYS.flatMap((key) =>
  MALFORMED_SEPARATOR_FORMS.flatMap(({ label, separator }) => {
    const rawMarker = `marker-malformed-${key.toLowerCase()}-${label}-raw`;
    const singleMarker = `marker-malformed-${key.toLowerCase()}-${label}-single`;
    const doubleMarker = `marker-malformed-${key.toLowerCase()}-${label}-double`;
    return [
      { marker: rawMarker, payload: malformedSeparatorPayload(key, separator, rawMarker) },
      { marker: singleMarker, payload: malformedSeparatorEscapedPayload(key, separator, singleMarker) },
      { marker: doubleMarker, payload: malformedSeparatorDoubleEscapedPayload(key, separator, doubleMarker) },
    ];
  })
);

function childTestEnv() {
  // NODE_TEST_CONTEXT/NODE_TEST_WORKER_ID are set by the outer `node --test`
  // this suite itself runs under. Left inherited, Node detects the spawned
  // child as a recursive test() run() and skips it entirely (a warning, not
  // an error) — a real Node behavior, not the race under test. run-tests.js
  // avoids this because it is invoked as a plain script, never itself under
  // `node --test`; this harness must scrub it explicitly to spawn a real
  // nested run.
  const env = { ...process.env };
  env.NODE_TEST_CONTEXT = undefined;
  env.NODE_TEST_WORKER_ID = undefined;
  return env;
}

async function runNodeTestOnce(extraArgs: string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--test", ...extraArgs, `--test-reporter=${REPORTER_PATH}`, TARGET_TEST_FILE],
      { cwd: REPO_ROOT, env: childTestEnv(), stdio: ["ignore", "pipe", "pipe"] }
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", () => resolve(output));
  });
}

async function runIntentionalFailureFixture({
  payload,
  stderrChunks,
}: SensitiveFailureCase): Promise<{ exitCode: number; output: string }> {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "pdpp-node-reporter-"));
  const fixturePath = join(fixtureDirectory, "intentional-failure.test.mjs");
  const message = `failure message context ${payload}`;
  await writeFile(
    fixturePath,
    [
      'import test from "node:test";',
      `test(${JSON.stringify(REPORTER_FAILURE_NAME)}, () => {`,
      `  for (const chunk of ${JSON.stringify(stderrChunks ?? [`stderr context ${payload}\n`])}) process.stderr.write(chunk);`,
      `  const error = new Error(${JSON.stringify(message)});`,
      "  throw error;",
      "});",
    ].join("\n")
  );
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--test", `--test-reporter=${REPORTER_PATH}`, fixturePath],
        {
          cwd: REPO_ROOT,
          env: childTestEnv(),
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.on("error", reject);
      child.on("exit", (exitCode) => resolve({ exitCode: exitCode ?? 1, output }));
    });
  } finally {
    await rm(fixtureDirectory, { force: true, recursive: true });
  }
}

async function reporterOutput(events: ReporterEvent[]): Promise<string> {
  async function* source() {
    yield* events;
  }
  let output = "";
  for await (const line of accountingReporter(source())) {
    output += line;
  }
  return output;
}

function failureFromOutput(output: string): Record<string, string> {
  const line = output.split("\n").find((value) => value.startsWith("PDPP_TEST_ACCOUNTING_EVENT "));
  assert.ok(line, "reporter must emit a terminal failure event");
  const event = JSON.parse(line.slice("PDPP_TEST_ACCOUNTING_EVENT ".length)) as {
    details?: { failure?: Record<string, string> };
  };
  assert.ok(event.details?.failure, "terminal failure must retain a failure payload");
  return event.details.failure;
}

function assertFailureCaps(failure: Record<string, string>) {
  for (const [field, value] of Object.entries(failure)) {
    const maximum = field === "stderr_tail" ? MAX_FAILURE_DIAGNOSTIC_LENGTH : MAX_FAILURE_FIELD_LENGTH;
    assert.ok(value.length <= maximum, `${field} must not exceed ${maximum} characters`);
  }
}

function requiredFailureField(failure: Record<string, string>, field: string): string {
  const value = failure[field];
  if (typeof value !== "string") {
    assert.fail(`${field} must be retained`);
  }
  return value;
}

function expectedStderrContext(sensitiveCase: SensitiveFailureCase): string {
  if (sensitiveCase.marker === "marker-oversized-value") {
    return "useful trailing context";
  }
  return "stderr context";
}

describe("run-tests reporter determinism (compact-record-history.test.js)", () => {
  it(`observes the same structured assertion count across ${RUN_COUNT} repeated clean runs without --test-force-exit`, async () => {
    const counts: number[] = [];
    for (let index = 0; index < RUN_COUNT; index += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: ordered test setup is intentionally sequential
      const output = await runNodeTestOnce([]);
      counts.push(structuredNodeSummary(output).assertions);
    }
    assert.ok(
      counts.every((count: number) => count === counts[0]),
      `structured assertion count must be stable across repeated runs; observed ${JSON.stringify(counts)}`
    );
  });

  it("run-tests.ts never forwards --test-force-exit to spawned child test processes", async () => {
    const runTestsSource = await import("node:fs/promises").then((fs) =>
      fs.readFile(fileURLToPath(new URL("../scripts/run-tests.ts", import.meta.url)), "utf8")
    );
    assert.doesNotMatch(
      runTestsSource,
      TOP_LEVEL_REGEX_1,
      "run-tests.ts must not forward --test-force-exit — it truncates the reporter event stream non-deterministically"
    );
  });

  it("redacts bounded failure diagnostics without lifecycle noise or weaker terminal accounting", async () => {
    for (const sensitiveCase of SENSITIVE_FAILURE_CASES) {
      // biome-ignore lint/performance/noAwaitInLoops: each child is an independent mutation-grade failure oracle.
      const { exitCode, output } = await runIntentionalFailureFixture(sensitiveCase);
      const failure = failureFromOutput(output);

      assert.notEqual(exitCode, 0, `${sensitiveCase.marker}: the fixture must remain an actual failed test run`);
      assert.match(output, FAILURE_TEST_NAME_PATTERN);
      assert.match(output, FAILURE_CODE_PATTERN);
      assert.match(output, FAILURE_MESSAGE_PATTERN);
      assert.match(output, FAILURE_STACK_PATTERN);
      assert.match(JSON.stringify(failure), REDACTED_PATTERN);
      assert.equal(output.includes(sensitiveCase.marker), false, `${sensitiveCase.marker}: marker must be redacted`);
      for (const field of ["message", "stack", "stderr_tail"]) {
        assert.equal(
          requiredFailureField(failure, field).includes(sensitiveCase.marker),
          false,
          `${sensitiveCase.marker}: ${field} must redact the marker`
        );
      }
      if (sensitiveCase.payload.includes("?")) {
        assert.equal(output.includes("[REDACTED]]"), false, "query redaction must remain well formed");
        assert.match(output, SAFE_QUERY_CONTEXT_PATTERN);
      }
      if (sensitiveCase.payload.startsWith("Authorization:")) {
        assert.match(JSON.stringify(failure), REDACTED_AUTHORIZATION_PATTERN);
      }
      if (sensitiveCase.payload.includes("Authorization")) {
        assert.equal(
          JSON.stringify(failure).includes("Authorization"),
          true,
          "Authorization header context must remain"
        );
      }
      if (sensitiveCase.payload.includes("Cookie")) {
        assert.equal(JSON.stringify(failure).includes("Cookie"), true, "Cookie header context must remain");
      }
      if (sensitiveCase.payload.includes("://")) {
        assert.equal(output.includes("example.test"), true, `${sensitiveCase.marker}: URL host must remain useful`);
      }
      assert.equal(
        requiredFailureField(failure, "stderr_tail").includes(expectedStderrContext(sensitiveCase)),
        true,
        `${sensitiveCase.marker}: useful stderr context must remain after redaction and tailing`
      );
      assert.match(JSON.stringify(failure), RETAINED_CONTEXT_PATTERN);
      assert.doesNotMatch(output, LIFECYCLE_EVENT_PATTERN);
      for (const field of ["code", "failure_type", "message", "stack", "stderr_tail"]) {
        requiredFailureField(failure, field);
      }
      assertFailureCaps(failure);
      assert.deepEqual(structuredNodeSummary(output), {
        assertions: 1,
        consumed_mapping_identities: [],
        failed: 1,
        passed: 0,
        skip_reasons: {},
        skipped: 0,
      });
    }
  });

  it("redacts structured Authorization/Cookie/Set-Cookie values across every escaped-whitespace separator form", async () => {
    for (const sensitiveCase of STRUCTURED_WHITESPACE_FAILURE_CASES) {
      // biome-ignore lint/performance/noAwaitInLoops: each child is an independent mutation-grade failure oracle.
      const { exitCode, output } = await runIntentionalFailureFixture(sensitiveCase);
      const failure = failureFromOutput(output);

      assert.notEqual(exitCode, 0, `${sensitiveCase.marker}: the fixture must remain an actual failed test run`);
      assert.equal(output.includes(sensitiveCase.marker), false, `${sensitiveCase.marker}: marker must be redacted`);
      for (const field of ["message", "stack", "stderr_tail"]) {
        assert.equal(
          requiredFailureField(failure, field).includes(sensitiveCase.marker),
          false,
          `${sensitiveCase.marker}: ${field} must redact the marker`
        );
      }
      assert.match(JSON.stringify(failure), REDACTED_PATTERN);
      assert.equal(
        requiredFailureField(failure, "stderr_tail").includes(expectedStderrContext(sensitiveCase)),
        true,
        `${sensitiveCase.marker}: useful stderr context must remain after redaction and tailing`
      );
      assert.doesNotMatch(output, LIFECYCLE_EVENT_PATTERN);
      for (const field of ["code", "failure_type", "message", "stack", "stderr_tail"]) {
        requiredFailureField(failure, field);
      }
      assertFailureCaps(failure);
      assert.deepEqual(structuredNodeSummary(output), {
        assertions: 1,
        consumed_mapping_identities: [],
        failed: 1,
        passed: 0,
        skip_reasons: {},
        skipped: 0,
      });
    }
  });

  it("redacts structured Authorization/Cookie/Set-Cookie values separated by manually-escaped \\uXXXX Unicode whitespace", async () => {
    for (const sensitiveCase of STRUCTURED_ESCAPED_UNICODE_WHITESPACE_FAILURE_CASES) {
      // biome-ignore lint/performance/noAwaitInLoops: each child is an independent mutation-grade failure oracle.
      const { exitCode, output } = await runIntentionalFailureFixture(sensitiveCase);
      const failure = failureFromOutput(output);

      assert.notEqual(exitCode, 0, `${sensitiveCase.marker}: the fixture must remain an actual failed test run`);
      assert.equal(output.includes(sensitiveCase.marker), false, `${sensitiveCase.marker}: marker must be redacted`);
      for (const field of ["message", "stack", "stderr_tail"]) {
        assert.equal(
          requiredFailureField(failure, field).includes(sensitiveCase.marker),
          false,
          `${sensitiveCase.marker}: ${field} must redact the marker`
        );
      }
      assert.match(JSON.stringify(failure), REDACTED_PATTERN);
      assert.equal(
        requiredFailureField(failure, "stderr_tail").includes(expectedStderrContext(sensitiveCase)),
        true,
        `${sensitiveCase.marker}: useful stderr context must remain after redaction and tailing`
      );
      assert.doesNotMatch(output, LIFECYCLE_EVENT_PATTERN);
      for (const field of ["code", "failure_type", "message", "stack", "stderr_tail"]) {
        requiredFailureField(failure, field);
      }
      assertFailureCaps(failure);
      assert.deepEqual(structuredNodeSummary(output), {
        assertions: 1,
        consumed_mapping_identities: [],
        failed: 1,
        passed: 0,
        skip_reasons: {},
        skipped: 0,
      });
    }
  });

  it("fails closed and redacts an unterminated structured Authorization/Cookie/Set-Cookie value", async () => {
    for (const sensitiveCase of UNTERMINATED_STRUCTURED_HEADER_CASES) {
      // biome-ignore lint/performance/noAwaitInLoops: each child is an independent mutation-grade failure oracle.
      const { exitCode, output } = await runIntentionalFailureFixture(sensitiveCase);
      const failure = failureFromOutput(output);

      assert.notEqual(exitCode, 0, `${sensitiveCase.marker}: the fixture must remain an actual failed test run`);
      assert.equal(output.includes(sensitiveCase.marker), false, `${sensitiveCase.marker}: marker must be redacted`);
      for (const field of ["message", "stack", "stderr_tail"]) {
        assert.equal(
          requiredFailureField(failure, field).includes(sensitiveCase.marker),
          false,
          `${sensitiveCase.marker}: ${field} must redact an unterminated value, not retain it verbatim`
        );
      }
      assert.match(JSON.stringify(failure), REDACTED_PATTERN);
      assert.equal(
        requiredFailureField(failure, "stderr_tail").includes(expectedStderrContext(sensitiveCase)),
        true,
        `${sensitiveCase.marker}: useful stderr context must remain after redaction and tailing`
      );
      assert.doesNotMatch(output, LIFECYCLE_EVENT_PATTERN);
      for (const field of ["code", "failure_type", "message", "stack", "stderr_tail"]) {
        requiredFailureField(failure, field);
      }
      assertFailureCaps(failure);
      assert.deepEqual(structuredNodeSummary(output), {
        assertions: 1,
        consumed_mapping_identities: [],
        failed: 1,
        passed: 0,
        skip_reasons: {},
        skipped: 0,
      });
    }
  });

  it("fails the entire field closed for a malformed or unsupported separator after a recognized sensitive key", async () => {
    for (const sensitiveCase of MALFORMED_SEPARATOR_CASES) {
      // biome-ignore lint/performance/noAwaitInLoops: each child is an independent mutation-grade failure oracle.
      const { exitCode, output } = await runIntentionalFailureFixture(sensitiveCase);
      const failure = failureFromOutput(output);

      assert.notEqual(exitCode, 0, `${sensitiveCase.marker}: the fixture must remain an actual failed test run`);
      assert.equal(output.includes(sensitiveCase.marker), false, `${sensitiveCase.marker}: marker must never leak`);
      for (const field of ["message", "stack", "stderr_tail"]) {
        const value = requiredFailureField(failure, field);
        assert.equal(value.includes(sensitiveCase.marker), false, `${sensitiveCase.marker}: ${field} must not leak`);
        assert.match(
          value,
          MALFORMED_SENSITIVE_HEADER_PATTERN,
          `${sensitiveCase.marker}: ${field} must fail the whole field closed, never fall back to copying the malformed candidate through`
        );
      }
      assert.doesNotMatch(output, LIFECYCLE_EVENT_PATTERN);
      for (const field of ["code", "failure_type", "message", "stack", "stderr_tail"]) {
        requiredFailureField(failure, field);
      }
      assertFailureCaps(failure);
      assert.deepEqual(structuredNodeSummary(output), {
        assertions: 1,
        consumed_mapping_identities: [],
        failed: 1,
        passed: 0,
        skip_reasons: {},
        skipped: 0,
      });
    }
  });

  it("fails closed on the gate's exact malformed-separator reproduction vector", async () => {
    const marker = "child_malformed_unicode_0729";
    const payload = `{"Authorization"\\u20:\\u20"Token ${marker}"}`;
    const { exitCode, output } = await runIntentionalFailureFixture({ marker, payload });
    const failure = failureFromOutput(output);

    assert.notEqual(exitCode, 0, "the fixture must remain an actual failed test run");
    assert.equal(output.includes(marker), false, "the gate's exact marker must never leak");
    for (const field of ["message", "stack", "stderr_tail"]) {
      const value = requiredFailureField(failure, field);
      assert.equal(value.includes(marker), false, `${field} must not retain the gate's marker`);
      assert.match(value, MALFORMED_SENSITIVE_HEADER_PATTERN, `${field} must fail the whole field closed`);
    }
    assert.deepEqual(structuredNodeSummary(output), {
      assertions: 1,
      consumed_mapping_identities: [],
      failed: 1,
      passed: 0,
      skip_reasons: {},
      skipped: 0,
    });
  });

  it("redacts a structured header value at the raw input scan bound rather than truncating then leaking", async () => {
    const marker = "marker-oversized-structured-header";
    const oversizedMessage = `{"Authorization":"Token ${marker}${"x".repeat(25_000)}"}`;
    const output = await reporterOutput([
      {
        data: {
          details: {
            error: { message: oversizedMessage, stack: "bounded stack" },
            type: "test",
          },
          name: REPORTER_FAILURE_NAME,
        },
        type: "test:fail",
      },
    ]);
    const failure = failureFromOutput(output);
    assert.equal(output.includes(marker), false, "oversized raw input must never leak its marker");
    assert.equal(
      requiredFailureField(failure, "message"),
      "[REDACTED oversized diagnostic input]",
      "oversized raw input must be replaced wholesale by a safe overflow marker, not truncated then redacted"
    );
  });

  // Builds N segments of strictly increasing backslash-run length, each
  // followed by a quote: segment i is `\`.repeat(i) + `"`. This is the exact
  // adversarial shape that exposed the prior gate's blind spot — an
  // outer-loop-only step counter reports O(N) steps (one per segment) while
  // the scanner's own inner work (each segment's failed key-open attempt
  // scanning forward looking for a same-depth close) was actually O(N) per
  // segment, O(N^2) total. A budget that charges every character inspection —
  // not just outer-loop iterations — is the only oracle that can see this.
  function increasingBackslashSegments(segmentCount: number): string {
    let input = "";
    for (let segment = 1; segment <= segmentCount; segment += 1) {
      input += `${"\\".repeat(segment)}"`;
    }
    return input;
  }

  it("enforces one shared per-field scan budget across outer and inner scanning, not an outer-step-only count", () => {
    // A budget of exactly the input length is nowhere near enough for this
    // adversarial shape (each segment's failed key-open attempt inspects more
    // than 1 character), so it must exhaust and produce the whole-field-safe
    // marker rather than a partially-redacted result that could still retain
    // unscanned, unredacted text.
    const adversarialInput = increasingBackslashSegments(200);
    const exhausted = redactStructuredHeadersWithBudget(adversarialInput, adversarialInput.length);
    assert.match(exhausted, BUDGET_EXHAUSTED_PATTERN, "an insufficient budget must fail the whole field closed");
    assert.equal(
      exhausted,
      "[REDACTED scan budget exhausted]",
      "exhaustion must replace the ENTIRE field, not a prefix"
    );

    // A budget of effectively unlimited size must still complete normally
    // (proves exhaustion is genuinely budget-driven, not an unconditional
    // failure for this input shape).
    const unrestricted = redactStructuredHeadersWithBudget(adversarialInput, adversarialInput.length * 10_000);
    assert.doesNotMatch(unrestricted, BUDGET_EXHAUSTED_PATTERN);
  });

  it("keeps the production per-field budget linear across increasing-backslash-segment shapes, including the gate's exact reproduction", () => {
    // These exact segment counts (and therefore input lengths: 5,150 /
    // 20,300 / 80,600 characters) reproduce the third-gate's measured
    // superlinear timing (1.20ms -> 8.71ms, 7.3x time for 3.9x input) on the
    // prior scanner. redactStructuredHeaders (the real production entry
    // point, sizing its own budget from input length) must complete every one
    // of these without exhausting, and the minimum sufficient budget — found
    // by binary search, a deterministic measure of total work rather than a
    // wall-clock sample — must scale linearly with input length, not
    // quadratically.
    const segmentCounts = [100, 200, 400, 800];
    const measurements = segmentCounts.map((segmentCount) => {
      const input = increasingBackslashSegments(segmentCount);
      const output = redactStructuredHeaders(input);
      assert.doesNotMatch(
        output,
        BUDGET_EXHAUSTED_PATTERN,
        `${segmentCount} segments (${input.length} chars) must complete within the production budget`
      );
      let low = 0;
      let high = input.length * 50;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        const attempt = redactStructuredHeadersWithBudget(input, mid);
        if (BUDGET_EXHAUSTED_PATTERN.test(attempt)) {
          low = mid + 1;
        } else {
          high = mid;
        }
      }
      return { length: input.length, minimumBudget: low, segmentCount };
    });
    const consecutivePairs = measurements.slice(1).map((current, index) => ({
      current,
      previous: measurements[index] ?? current,
    }));
    for (const { current, previous } of consecutivePairs) {
      const lengthRatio = current.length / previous.length;
      const budgetRatio = current.minimumBudget / previous.minimumBudget;
      assert.ok(
        budgetRatio <= lengthRatio + 0.5,
        `minimum sufficient budget must scale linearly with input length; ${previous.segmentCount}->${current.segmentCount} segments produced length ratio ${lengthRatio.toFixed(2)} but budget ratio ${budgetRatio.toFixed(2)}`
      );
    }
  });

  it("scans a single long backslash run and a run of plain non-matching characters within a small constant multiple of their length", () => {
    // Complements the increasing-segment shapes above with the simpler single
    // adversarial shapes from prior gates, now measured via minimum
    // sufficient budget (deterministic) instead of an outer-step count that
    // cannot see inner-scanner work.
    const singleRunLengths = [1000, 2000, 4000, 8000, 16_000];
    for (const length of singleRunLengths) {
      const input = `${"\\".repeat(length)}"`;
      const sufficientBudget = length * 4;
      const output = redactStructuredHeadersWithBudget(input, sufficientBudget);
      assert.doesNotMatch(
        output,
        BUDGET_EXHAUSTED_PATTERN,
        `a single backslash run of length ${length} must resolve within ${sufficientBudget} operations (4x input length)`
      );
    }

    const plainLengths = [1000, 2000, 4000, 8000, 16_000];
    for (const length of plainLengths) {
      const input = `${"a".repeat(length)}"`;
      const sufficientBudget = length * 2;
      const output = redactStructuredHeadersWithBudget(input, sufficientBudget);
      assert.doesNotMatch(
        output,
        BUDGET_EXHAUSTED_PATTERN,
        `${length} plain characters must resolve within ${sufficientBudget} operations (2x input length)`
      );
    }
  });

  it("bounds the separator/colon scan after a recognized key so a long run before the colon fails closed cheaply, not via unbounded work", () => {
    // MAX_STRUCTURED_HEADER_SEPARATOR_SCAN_LENGTH (64) caps how far the
    // scanner looks for a colon/value after a recognized key, independent
    // of the shared budget — this is what keeps ordinary unrelated prose
    // that merely contains a recognized-looking key from itself costing
    // unbounded work once "malformed separator" started failing the whole
    // field closed rather than falling back to a cheap "not a match" copy.
    const separatorLengths = [10, 50, 100, 1000, 10_000, 100_000];
    const boundedOperationCeiling = 500;
    for (const length of separatorLengths) {
      const input = `{"Authorization"${" ".repeat(length)}: "Token marker-bounded-separator"}`;
      const output = redactStructuredHeadersWithBudget(input, boundedOperationCeiling);
      assert.doesNotMatch(
        output,
        BUDGET_EXHAUSTED_PATTERN,
        `a ${length}-character run before the colon must resolve (redacted or fail-closed) within ${boundedOperationCeiling} operations, not exhaust the shared budget`
      );
    }

    // Ordinary prose that happens to contain the word "Authorization" in a
    // quoted, non-structured shape (no colon/value pair at all) must remain
    // cheap regardless of how much unrelated text follows it.
    const proseLengths = [1000, 10_000, 100_000];
    for (const length of proseLengths) {
      const input = `Discussing "Authorization" headers in general. ${"Unrelated prose text. ".repeat(length / 24)}`;
      const output = redactStructuredHeadersWithBudget(input, input.length * 4);
      assert.doesNotMatch(
        output,
        BUDGET_EXHAUSTED_PATTERN,
        `${length}-character unrelated prose containing a bare "Authorization" quote must resolve within 4x its own length`
      );
    }
  });

  it("keeps split labels until their credential can be redacted and applies every cap", async () => {
    const splitOutput = await reporterOutput([
      { data: { message: "GITHUB_" }, type: "test:stderr" },
      { data: { message: "TOKEN=marker-direct-split\nuseful split context" }, type: "test:stderr" },
      {
        data: {
          details: {
            error: {
              message: `error message GITHUB_TOKEN=marker-direct-split ${"x".repeat(5000)}`,
              stack: `error stack GITHUB_TOKEN=marker-direct-split ${"x".repeat(5000)}`,
            },
            type: "test",
          },
          name: REPORTER_FAILURE_NAME,
        },
        type: "test:fail",
      },
    ]);
    const splitFailure = failureFromOutput(splitOutput);
    assert.doesNotMatch(splitOutput, SPLIT_MARKER_PATTERN);
    assert.match(JSON.stringify(splitFailure), SPLIT_REDACTION_PATTERN);
    assert.equal(requiredFailureField(splitFailure, "stderr_tail").includes("useful split context"), true);
    assertFailureCaps(splitFailure);
  });

  it("bounds diagnostic retention before terminal failure without leaking discarded input", async () => {
    const marker = "marker-bounded-diagnostic";
    const overflowOutput = await reporterOutput([
      { data: { message: `token=${marker}` }, type: "test:stderr" },
      { data: { message: "x".repeat(20_000) }, type: "test:stderr" },
      {
        data: {
          details: { error: { message: "bounded memory failure", stack: "bounded memory stack" }, type: "test" },
          name: REPORTER_FAILURE_NAME,
        },
        type: "test:fail",
      },
    ]);
    const overflowFailure = failureFromOutput(overflowOutput);
    assert.doesNotMatch(overflowOutput, BOUNDED_DIAGNOSTIC_MARKER_PATTERN);
    assert.match(requiredFailureField(overflowFailure, "stderr_tail"), DIAGNOSTIC_OVERFLOW_PATTERN);
    assertFailureCaps(overflowFailure);
  });

  it("leaves URLs without a password userinfo value intact", async () => {
    const safeUrls = "postgres://alice@example.test/db postgres://example.test/db postgres://alice:@example.test/db";
    const output = await reporterOutput([
      { data: { message: safeUrls }, type: "test:stderr" },
      {
        data: {
          details: {
            error: { message: `safe URL boundary ${safeUrls}`, stack: `safe URL stack ${safeUrls}` },
            type: "test",
          },
          name: REPORTER_FAILURE_NAME,
        },
        type: "test:fail",
      },
    ]);
    assert.match(output, SAFE_NAMED_USER_URL_PATTERN);
    assert.match(output, SAFE_NO_USER_URL_PATTERN);
    assert.match(output, SAFE_EMPTY_PASSWORD_URL_PATTERN);
    assert.doesNotMatch(output, REDACTED_EXAMPLE_USERINFO_PATTERN);
  });

  it("leaves a nonstandard X-Authorization extension header intact", async () => {
    const safeHeader = "X-Authorization: public-extension-value";
    const output = await reporterOutput([
      { data: { message: safeHeader }, type: "test:stderr" },
      {
        data: {
          details: { error: { message: safeHeader, stack: safeHeader }, type: "test" },
          name: REPORTER_FAILURE_NAME,
        },
        type: "test:fail",
      },
    ]);
    assert.equal(output.includes(safeHeader), true);
    assert.equal(output.includes("X-Authorization: [REDACTED]"), false);
  });

  it("leaves a JSON-structured X-Authorization extension header intact", async () => {
    const safeHeader = '{"X-Authorization":"public-extension-value"}';
    const output = await reporterOutput([
      { data: { message: safeHeader }, type: "test:stderr" },
      {
        data: {
          details: { error: { message: safeHeader, stack: safeHeader }, type: "test" },
          name: REPORTER_FAILURE_NAME,
        },
        type: "test:fail",
      },
    ]);
    assert.equal(output.includes(JSON.stringify(safeHeader).slice(1, -1)), true);
    assert.equal(output.includes("[REDACTED]"), false);
  });
});
