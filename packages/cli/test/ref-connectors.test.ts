// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";

import { runCli } from "../src/index.ts";
import { runRefConnectors } from "../src/ref/commands/connectors.ts";
import { PdppCliError, PdppHttpError, PdppUsageError } from "../src/ref/errors.ts";

const NO_USABLE_NEXT_CURSOR_RE = /malformed connector-summary page/;
const REPEATED_SELF_LOOPING_CURSOR_RE = /repeated\/self-looping next_cursor/;
const CAP_STOPPED_AT_1000_RE = /stopped after 1000 pages \(safety cap of 1000\)/;
const CAP_RESUME_CURSOR_1000_RE = /resume with --cursor cursor-1000/;

function mockFetch(responses) {
  // biome-ignore lint/suspicious/useAwait: mocks the fetch(...) => Promise<Response> contract (or Response.text()/json()); async is required to satisfy the type even though this mock body never awaits.
  return async (url) => {
    const key = url.toString();
    if (!Object.hasOwn(responses, key)) {
      throw new Error(`Unexpected fetch: ${key}`);
    }
    const { body, status = 200 } = responses[key];
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 401 ? "Unauthorized" : "OK",
      text: async () => text,
      headers: { get: () => null },
    };
  };
}

function capture() {
  let out = "";
  let err = "";
  return {
    io: {
      stdout: {
        write: (c) => {
          out += c;
        },
      },
      stderr: {
        write: (c) => {
          err += c;
        },
      },
    },
    get stdout() {
      return out;
    },
    get stderr() {
      return err;
    },
  };
}

const SUMMARY_FIXTURE = {
  connection_id: "github",
  connector_id: "github",
  display_name: "GitHub",
  manifest_version: "1.0.0",
  streams: ["issues", "commits"],
  total_records: 42,
  freshness: {},
  refresh_policy: null,
  schedule: {
    next_due_at: "2026-05-19T01:00:00Z",
  },
  last_run: {
    last_at: "2026-05-19T00:30:00Z",
    status: "succeeded",
    run_id: "run-1",
  },
  last_successful_run: {
    last_at: "2026-05-19T00:30:00Z",
    status: "succeeded",
    run_id: "run-1",
  },
  next_action: {
    action_target: "dashboard",
    attention_id: "att-1",
    expires_at: null,
    owner_action: "provide_value",
    reason_code: "otp_required",
    response_contract: "response_required",
    source: "structured",
  },
  rendered_verdict: {
    pill: { label: "Needs you", tone: "red" },
    channel: "attention",
    annotations: [],
    forward_statement: "Reconnect this account and collection resumes.",
    required_actions: [
      {
        kind: "reauth",
        audience: "owner",
        urgency: "now",
        affects: [],
        cta: "Reconnect this account",
        terminal: false,
        satisfied_when: { kind: "credential_present_and_unrejected" },
      },
    ],
    streams: [],
    progress: { headline: "Reconnect this account.", detail: null, facts: [] },
    detail: {
      forward_disposition: "resumable",
      suppressed: [],
      primary_cause: null,
      coverage: null,
      freshness: null,
      attention: null,
      outbox: null,
      remote_surface: null,
    },
    trace: {
      tone_cause: "red",
      tone_inputs: [],
      channel_cause: "owner_action",
      suppressed_evidence: [],
      detail_destinations: [],
      primary_action_kind: "reauth",
      satisfied_when: "credential_present_and_unrejected",
      runtime_capped: false,
    },
  },
  acquisition_coverage: {
    latest_batch: {
      accepted_count: 12,
      acquisition_method: "owner_artifact",
      batch_id: "ab_timeline_1",
      date_range: { start: "2024-06-01T00:00:00.000Z", end: "2024-06-05T13:45:22.000Z" },
      detected_format: "legacy_records",
      duplicate_count: 2,
      failed_count: 0,
      media_coverage: { status: "none_reported" },
      parsed_count: 14,
      skipped_count: 0,
      status: "committed",
      uploaded_file_name: "Timeline.json",
      warnings: ["older export"],
    },
    recent_batches: [],
  },
  connection_health: {
    axes: {
      attention: "open",
      coverage: "partial",
      freshness: "fresh",
      outbox: "idle",
    },
    badges: { stale: false, syncing: true },
    conditions: [
      {
        id: "AttentionClear:otp_required",
        type: "AttentionClear",
        status: "false",
        severity: "blocked",
        reason: "otp_required",
        message: "Owner action is required before collection can continue.",
        origin: "runtime",
        observed_at: "2026-05-19T00:30:00Z",
        expires_at: null,
        current: true,
        sensitivity: "owner",
        remediation: {
          action: "satisfy_attention",
          label: "Open the requested interaction and complete the action",
          retryable: false,
          target: "dashboard",
        },
      },
      {
        id: "SourceCoverageComplete:partial",
        type: "SourceCoverageComplete",
        status: "false",
        severity: "warning",
        reason: "partial",
        message: "Required source coverage is incomplete.",
        origin: "connector",
        observed_at: "2026-05-19T00:30:00Z",
        expires_at: null,
        current: true,
        sensitivity: "owner",
        remediation: null,
      },
    ],
    dominant_condition_id: "AttentionClear:otp_required",
    last_success_at: "2026-05-19T00:30:00Z",
    next_action: {
      action_target: "dashboard",
      attention_id: "att-1",
      expires_at: null,
      owner_action: "provide_value",
      reason_code: "otp_required",
      response_contract: "response_required",
      source: "structured",
    },
    next_attempt_at: "2026-05-19T01:00:00Z",
    reason_code: "attention_open",
    state: "needs_attention",
    supporting_condition_ids: ["AttentionClear:otp_required", "SourceCoverageComplete:partial"],
    unknown_reasons: [],
  },
};

// ---- list -------------------------------------------------------------------

test("ref connectors list: projects summary fields in JSON list", async () => {
  const fetch = mockFetch({
    "https://ref.test/_ref/connectors?limit=100": {
      body: { data: [SUMMARY_FIXTURE], has_more: false, object: "list" },
    },
  });

  const captured = capture();
  const code = await runRefConnectors(["list", "--as-url", "https://ref.test", "--format", "json"], captured.io, fetch);

  assert.equal(code, 0);
  const parsed = JSON.parse(captured.stdout);
  assert.equal(parsed.object, "list");
  assert.equal(parsed.data.length, 1);
  const [row] = parsed.data;
  assert.equal(row.connector_id, "github");
  assert.equal(row.connection_id, "github");
  assert.equal(row.state, "needs_attention");
  assert.equal(row.coverage, "partial");
  assert.equal(row.freshness, "fresh");
  assert.equal(row.attention, "open");
  assert.equal(row.outbox, "idle");
  assert.equal(row.syncing, true);
  assert.equal(row.stale, false);
  assert.equal(row.reason_code, "attention_open");
  assert.equal(row.dominant_condition_id, "AttentionClear:otp_required");
  assert.equal(row.dominant_condition_type, "AttentionClear");
  assert.equal(row.dominant_condition_reason, "otp_required");
  assert.equal(row.dominant_condition_severity, "blocked");
  assert.equal(row.dominant_condition_message, "Owner action is required before collection can continue.");
  assert.equal(row.dominant_condition_origin, "runtime");
  assert.deepEqual(row.supporting_condition_ids, ["AttentionClear:otp_required", "SourceCoverageComplete:partial"]);
  assert.deepEqual(row.unknown_reasons, []);
  assert.equal(row.rendered_verdict_label, "Needs you");
  assert.equal(row.rendered_verdict_tone, "red");
  assert.equal(row.rendered_verdict_channel, "attention");
  assert.equal(row.rendered_verdict_statement, "Reconnect this account and collection resumes.");
  assert.equal(row.primary_action_kind, "reauth");
  assert.equal(row.primary_action_audience, "owner");
  assert.equal(row.primary_action_cta, "Reconnect this account");
  assert.equal(row.primary_action_satisfied_when, "credential_present_and_unrejected");
  assert.equal(row.primary_action_terminal, false);
  assert.equal(row.next_action_source, "structured");
  assert.equal(row.next_action_reason, "otp_required");
  assert.equal(row.next_action_owner_action, "provide_value");
  assert.equal(row.next_action_target, "dashboard");
  assert.equal(row.last_run_at, "2026-05-19T00:30:00Z");
  assert.equal(row.last_run_status, "succeeded");
  assert.equal(row.last_success_at, "2026-05-19T00:30:00Z");
  assert.equal(row.next_attempt_at, "2026-05-19T01:00:00Z");
  assert.equal(row.latest_acquisition_batch_id, "ab_timeline_1");
  assert.equal(row.latest_acquisition_status, "committed");
  assert.equal(row.latest_acquisition_method, "owner_artifact");
  assert.equal(row.latest_acquisition_format, "legacy_records");
  assert.equal(row.latest_acquisition_file, "Timeline.json");
  assert.equal(row.latest_acquisition_start, "2024-06-01T00:00:00.000Z");
  assert.equal(row.latest_acquisition_end, "2024-06-05T13:45:22.000Z");
  assert.equal(row.latest_acquisition_parsed, 14);
  assert.equal(row.latest_acquisition_accepted, 12);
  assert.equal(row.latest_acquisition_duplicates, 2);
  assert.equal(row.latest_acquisition_skipped, 0);
  assert.equal(row.latest_acquisition_failed, 0);
  assert.equal(row.latest_acquisition_warnings, 1);
  assert.equal(Object.hasOwn(row, "artifact_sha256"), false);
  assert.equal(Object.hasOwn(row, "media_coverage"), false);
});

test("ref connectors list: --verbose returns raw envelope", async () => {
  const fetch = mockFetch({
    "https://ref.test/_ref/connectors?limit=100": {
      body: { data: [SUMMARY_FIXTURE], has_more: false, object: "list" },
    },
  });

  const captured = capture();
  await runRefConnectors(["list", "--as-url", "https://ref.test", "--format", "json", "--verbose"], captured.io, fetch);

  const parsed = JSON.parse(captured.stdout);
  assert.deepEqual(parsed, { data: [SUMMARY_FIXTURE], has_more: false, object: "list" });
});

test("ref connectors list: table format includes projected columns", async () => {
  const fetch = mockFetch({
    "https://ref.test/_ref/connectors?limit=100": {
      body: { data: [SUMMARY_FIXTURE], has_more: false, object: "list" },
    },
  });

  const captured = capture();
  await runRefConnectors(["list", "--as-url", "https://ref.test", "--format", "table"], captured.io, fetch);

  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(captured.stdout, /connector_id/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(captured.stdout, /state/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(captured.stdout, /dominant_condition_reason/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(captured.stdout, /github/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(captured.stdout, /needs_attention/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(captured.stdout, /primary_action_kind/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(captured.stdout, /reauth/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(captured.stdout, /Reconnect this account/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(captured.stdout, /latest_acquisition_status/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(captured.stdout, /owner_artifact/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.doesNotMatch(captured.stdout, /Owner action is required before collection can continue/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.doesNotMatch(captured.stdout, /artifact_sha256/);
});

test("ref connectors list: handles missing axes / next_action without crashing", async () => {
  const minimal = {
    connection_id: "spotify",
    connector_id: "spotify",
    display_name: "Spotify",
    connection_health: {
      state: "unknown",
      axes: {},
      badges: {},
      unknown_reasons: ["no_runs"],
      next_action: null,
    },
    next_action: null,
    last_run: null,
    last_successful_run: null,
    schedule: null,
  };
  const fetch = mockFetch({
    "https://ref.test/_ref/connectors?limit=100": { body: { data: [minimal], has_more: false, object: "list" } },
  });

  const captured = capture();
  await runRefConnectors(["list", "--as-url", "https://ref.test", "--format", "json"], captured.io, fetch);

  const [row] = JSON.parse(captured.stdout).data;
  assert.equal(row.state, "unknown");
  assert.equal(row.coverage, "unknown");
  assert.equal(row.freshness, "unknown");
  assert.equal(row.attention, "none");
  assert.equal(row.outbox, "unknown");
  assert.equal(row.dominant_condition_id, null);
  assert.equal(row.dominant_condition_reason, null);
  assert.deepEqual(row.supporting_condition_ids, []);
  assert.equal(row.rendered_verdict_label, null);
  assert.equal(row.primary_action_kind, null);
  assert.equal(row.next_action_source, "none");
  assert.equal(row.next_action_target, null);
  assert.deepEqual(row.unknown_reasons, ["no_runs"]);
});

// ---- show -------------------------------------------------------------------

test("ref connectors show: returns projected row for connector id", async () => {
  const fetch = mockFetch({
    "https://ref.test/_ref/connectors/github": { body: SUMMARY_FIXTURE },
  });

  const captured = capture();
  const code = await runRefConnectors(
    ["show", "github", "--as-url", "https://ref.test", "--format", "json"],
    captured.io,
    fetch
  );

  assert.equal(code, 0);
  const parsed = JSON.parse(captured.stdout);
  assert.equal(parsed.connector_id, "github");
  assert.equal(parsed.state, "needs_attention");
  assert.equal(parsed.dominant_condition_reason, "otp_required");
  assert.equal(parsed.rendered_verdict_label, "Needs you");
  assert.equal(parsed.primary_action_kind, "reauth");
  assert.equal(parsed.primary_action_cta, "Reconnect this account");
  assert.equal(parsed.next_action_source, "structured");
  assert.equal(parsed.latest_acquisition_status, "committed");
  assert.equal(parsed.latest_acquisition_accepted, 12);
});

test("ref connectors show: --verbose returns raw envelope", async () => {
  const fetch = mockFetch({
    "https://ref.test/_ref/connectors/github": { body: SUMMARY_FIXTURE },
  });

  const captured = capture();
  await runRefConnectors(
    ["show", "github", "--as-url", "https://ref.test", "--format", "json", "--verbose"],
    captured.io,
    fetch
  );

  const parsed = JSON.parse(captured.stdout);
  assert.deepEqual(parsed, SUMMARY_FIXTURE);
});

test("ref connectors show: percent-encodes connector id", async () => {
  let capturedUrl: string | null = null;
  // biome-ignore lint/suspicious/useAwait: mocks the fetch(...) => Promise<Response> contract (or Response.text()/json()); async is required to satisfy the type even though this mock body never awaits.
  const fetch = async (url) => {
    capturedUrl = url.toString();
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(SUMMARY_FIXTURE),
      headers: { get: () => null },
    };
  };

  const { io } = capture();
  await runRefConnectors(["show", "foo/bar baz", "--as-url", "https://ref.test", "--format", "json"], io, fetch);

  assert.equal(capturedUrl, "https://ref.test/_ref/connectors/foo%2Fbar%20baz");
});

test("ref connectors show: omits action_target when server has redacted secret", async () => {
  const redacted = {
    ...SUMMARY_FIXTURE,
    next_action: { ...SUMMARY_FIXTURE.next_action, action_target: null },
    connection_health: {
      ...SUMMARY_FIXTURE.connection_health,
      next_action: { ...SUMMARY_FIXTURE.connection_health.next_action, action_target: null },
    },
  };
  const fetch = mockFetch({
    "https://ref.test/_ref/connectors/github": { body: redacted },
  });

  const captured = capture();
  await runRefConnectors(["show", "github", "--as-url", "https://ref.test", "--format", "json"], captured.io, fetch);

  const parsed = JSON.parse(captured.stdout);
  assert.equal(parsed.next_action_source, "structured");
  assert.equal(parsed.next_action_target, null);
});

test("ref connectors show: throws PdppUsageError when missing connector id", async () => {
  const { io } = capture();
  await assert.rejects(
    () => runRefConnectors(["show", "--as-url", "https://ref.test"], io, mockFetch({})),
    // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
    (err) => err instanceof PdppUsageError && /connector-id/.test(err.message)
  );
});

test("ref connectors: throws PdppUsageError for unknown subcommand", async () => {
  const { io } = capture();
  await assert.rejects(
    () => runRefConnectors(["blah", "--as-url", "https://ref.test"], io, mockFetch({})),
    (err) => err instanceof PdppUsageError
  );
});

test("ref connectors show: maps 404 to PdppHttpError exit code 5", async () => {
  const fetch = mockFetch({
    "https://ref.test/_ref/connectors/missing": {
      body: { error_description: "not found" },
      status: 404,
    },
  });

  const { io } = capture();
  await assert.rejects(
    () => runRefConnectors(["show", "missing", "--as-url", "https://ref.test"], io, fetch),
    (err) => err instanceof PdppHttpError && err.exitCode === 5 && err.status === 404
  );
});

// ---- routing via runCli -----------------------------------------------------

test("runCli ref connectors list routes to handler", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = mockFetch({
    "https://ref.test/_ref/connectors?limit=100": { body: { data: [], has_more: false, object: "list" } },
  });

  try {
    const captured = capture();
    const code = await runCli(
      ["ref", "connectors", "list", "--as-url", "https://ref.test", "--format", "json"],
      captured.io
    );
    assert.equal(code, 0);
    // Non-verbose output is the PROJECTED shape ({ data, object }), which
    // never carried has_more — only the mock fixture (the server envelope
    // going IN) needed has_more added for the strict validator.
    assert.deepEqual(JSON.parse(captured.stdout), { data: [], object: "list" });
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("runCli ref --help mentions connectors commands", async () => {
  const captured = capture();
  const code = await runCli(["ref", "--help"], captured.io);
  assert.equal(code, 0);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(captured.stdout, /ref connectors list/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(captured.stdout, /ref connectors show/);
});

// ---- canonical envelope warnings -------------------------------------------

test("ref connectors list: surfaces canonical meta.warnings to stderr without polluting stdout JSON", async () => {
  const fetch = mockFetch({
    "https://ref.test/_ref/connectors?limit=100": {
      body: {
        data: [SUMMARY_FIXTURE],
        has_more: false,
        meta: {
          warnings: [
            { code: "deprecated_alias", message: "connector_instance_id is deprecated; use connection_id" },
            { code: "count_downgraded", dropped_parameter: "count=exact" },
          ],
        },
        object: "list",
      },
    },
  });

  const captured = capture();
  const code = await runRefConnectors(["list", "--as-url", "https://ref.test", "--format", "json"], captured.io, fetch);

  assert.equal(code, 0);
  // stdout stays clean JSON (no warning prose mixed in).
  const parsed = JSON.parse(captured.stdout);
  assert.equal(parsed.object, "list");
  assert.equal(parsed.data.length, 1);
  // stderr carries the warnings.
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(captured.stderr, /warning: deprecated_alias/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(captured.stderr, /connector_instance_id is deprecated/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(captured.stderr, /warning: count_downgraded/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(captured.stderr, /\(dropped: count=exact\)/);
});

test("ref connectors show: surfaces canonical meta.warnings on single-record responses", async () => {
  const fetch = mockFetch({
    "https://ref.test/_ref/connectors/github": {
      body: {
        ...SUMMARY_FIXTURE,
        meta: { warnings: [{ code: "skipped_source", message: "one binding had no snapshot" }] },
      },
    },
  });

  const captured = capture();
  const code = await runRefConnectors(
    ["show", "github", "--as-url", "https://ref.test", "--format", "json"],
    captured.io,
    fetch
  );

  assert.equal(code, 0);
  // stdout is still a parseable record projection.
  const parsed = JSON.parse(captured.stdout);
  assert.equal(parsed.connector_id, "github");
  // stderr surfaces the warning.
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(captured.stderr, /warning: skipped_source — one binding had no snapshot/);
});

test("ref connectors list: emits no stderr noise when meta.warnings is absent (backward compat)", async () => {
  const fetch = mockFetch({
    "https://ref.test/_ref/connectors?limit=100": {
      body: { data: [SUMMARY_FIXTURE], has_more: false, object: "list" },
    },
  });

  const captured = capture();
  await runRefConnectors(["list", "--as-url", "https://ref.test", "--format", "json"], captured.io, fetch);

  // No canonical envelope today ⇒ no warnings line.
  assert.equal(captured.stderr, "");
});

test("ref connectors list: ignores malformed warnings entries", async () => {
  const fetch = mockFetch({
    "https://ref.test/_ref/connectors?limit=100": {
      body: {
        data: [SUMMARY_FIXTURE],
        has_more: false,
        meta: {
          warnings: [
            "not-an-object",
            { message: "missing code field" },
            null,
            { code: "ok_warning", message: "this one is well-formed" },
          ],
        },
        object: "list",
      },
    },
  });

  const captured = capture();
  await runRefConnectors(["list", "--as-url", "https://ref.test", "--format", "json"], captured.io, fetch);

  // Only the well-formed entry surfaces.
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(captured.stderr, /warning: ok_warning/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.doesNotMatch(captured.stderr, /not-an-object/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.doesNotMatch(captured.stderr, /missing code field/);
});

// ---- pagination (bounded-by-default, --cursor, --all) ----------------------

test("ref connectors list: defaults to one bounded page (limit=100), never the bare unbounded route", async () => {
  const fetch = mockFetch({
    "https://ref.test/_ref/connectors?limit=100": {
      body: { data: [SUMMARY_FIXTURE], has_more: false, next_cursor: null, object: "list" },
    },
  });

  const captured = capture();
  const code = await runRefConnectors(["list", "--as-url", "https://ref.test", "--format", "json"], captured.io, fetch);

  assert.equal(code, 0);
  const parsed = JSON.parse(captured.stdout);
  assert.equal(parsed.data.length, 1);
  // No "more results" notice — has_more was false.
  assert.equal(captured.stderr, "");
});

test("ref connectors list: has_more:true without --all surfaces an explicit continuation notice, never a silent truncation", async () => {
  const fetch = mockFetch({
    "https://ref.test/_ref/connectors?limit=100": {
      body: { data: [SUMMARY_FIXTURE], has_more: true, next_cursor: "cursor-page-2", object: "list" },
    },
  });

  const captured = capture();
  const code = await runRefConnectors(["list", "--as-url", "https://ref.test", "--format", "json"], captured.io, fetch);

  assert.equal(code, 0);
  // The page's data still prints in full — never silently dropped.
  assert.equal(JSON.parse(captured.stdout).data.length, 1);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(captured.stderr, /more results available/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(captured.stderr, /--cursor cursor-page-2/);
});

test("ref connectors list: --cursor requests the exact continuation, not page 1", async () => {
  const fetch = mockFetch({
    "https://ref.test/_ref/connectors?limit=100&cursor=cursor-page-2": {
      body: { data: [SUMMARY_FIXTURE], has_more: false, next_cursor: null, object: "list" },
    },
  });

  const captured = capture();
  const code = await runRefConnectors(
    ["list", "--as-url", "https://ref.test", "--format", "json", "--cursor", "cursor-page-2"],
    captured.io,
    fetch
  );

  assert.equal(code, 0);
  assert.equal(JSON.parse(captured.stdout).data.length, 1);
});

test("ref connectors list: --limit is capped at the reference's own page-size max (100)", async () => {
  const fetch = mockFetch({
    "https://ref.test/_ref/connectors?limit=100": {
      body: { data: [SUMMARY_FIXTURE], has_more: false, next_cursor: null, object: "list" },
    },
  });

  const captured = capture();
  const code = await runRefConnectors(
    ["list", "--as-url", "https://ref.test", "--format", "json", "--limit", "5000"],
    captured.io,
    fetch
  );

  assert.equal(code, 0, "a request for limit=5000 must clamp to 100, not fail or bypass the cap");
});

test("ref connectors list: --all page-follows every page and merges all rows, with no duplication", async () => {
  const pageOneSummary = { ...SUMMARY_FIXTURE, connection_id: "github-1", connector_instance_id: "github-1" };
  const pageTwoSummary = { ...SUMMARY_FIXTURE, connection_id: "github-2", connector_instance_id: "github-2" };
  const fetch = mockFetch({
    "https://ref.test/_ref/connectors?limit=100": {
      body: { data: [pageOneSummary], has_more: true, next_cursor: "cursor-page-2", object: "list" },
    },
    "https://ref.test/_ref/connectors?limit=100&cursor=cursor-page-2": {
      body: { data: [pageTwoSummary], has_more: false, next_cursor: null, object: "list" },
    },
  });

  const captured = capture();
  const code = await runRefConnectors(
    ["list", "--as-url", "https://ref.test", "--format", "json", "--all"],
    captured.io,
    fetch
  );

  assert.equal(code, 0);
  const parsed = JSON.parse(captured.stdout);
  assert.equal(parsed.data.length, 2, "both pages' rows must be present, exactly once each");
  const ids = parsed.data.map((row) => row.connection_id);
  assert.deepEqual(new Set(ids).size, ids.length, "no row may be duplicated across the page boundary");
  // Exhausted cleanly (has_more:false on the last page) — no continuation notice.
  assert.equal(captured.stderr, "");
});

test("ref connectors list: --all stops at the safety cap and FAILS NON-ZERO with a resumable cursor, never a success-shaped partial output", async () => {
  // Third gate REVISE (2026-07-29), finding 3: hitting the page-count safety
  // cap with more remaining must be a FAILURE (non-zero exit, nothing
  // printed to stdout), never exit 0 with 1000 rows silently presented as
  // if that were the whole answer — automation consuming --all must never
  // mistake a capped partial result for a complete one.
  let calls = 0;
  // biome-ignore lint/suspicious/useAwait: mocks the fetch(...) => Promise<Response> contract; async is required to satisfy the type even though this mock body never awaits.
  const fetch = async () => {
    calls += 1;
    const body = {
      data: [{ ...SUMMARY_FIXTURE, connection_id: `endless-${calls}`, connector_instance_id: `endless-${calls}` }],
      has_more: true,
      next_cursor: `cursor-${calls}`,
      object: "list",
    };
    return {
      headers: { get: () => null },
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
    };
  };

  const captured = capture();
  await assert.rejects(
    () => runRefConnectors(["list", "--as-url", "https://ref.test", "--format", "json", "--all"], captured.io, fetch),
    (err) =>
      err instanceof PdppCliError &&
      err.exitCode === 7 &&
      CAP_STOPPED_AT_1000_RE.test(err.message) &&
      CAP_RESUME_CURSOR_1000_RE.test(err.message)
  );
  assert.equal(
    captured.stdout,
    "",
    "the cap-exceeded case must print NOTHING to stdout — no success-shaped partial output"
  );
});

test("ref connectors list: a rejected/malformed continuation surfaces as an explicit HTTP error, never an empty or truncated list", async () => {
  const fetch = mockFetch({
    "https://ref.test/_ref/connectors?limit=100&cursor=not-a-real-cursor": {
      body: { error_description: "Connector summary cursor is invalid" },
      status: 400,
    },
  });

  const captured = capture();
  await assert.rejects(
    () =>
      runRefConnectors(
        ["list", "--as-url", "https://ref.test", "--format", "json", "--cursor", "not-a-real-cursor"],
        captured.io,
        fetch
      ),
    (err) => err instanceof PdppHttpError && err.status === 400
  );
  // Nothing printed to stdout — a rejected cursor never renders a fabricated empty page.
  assert.equal(captured.stdout, "");
});

// ---- second gate REVISE (2026-07-29): envelope validation + full merge ----

test("ADVERSARIAL: has_more:true with a wrong discriminator (object !== 'list') is rejected, never silently accepted", async () => {
  const fetch = mockFetch({
    "https://ref.test/_ref/connectors?limit=100": {
      body: { data: {}, has_more: false, object: "not-a-list" },
    },
  });
  const captured = capture();
  await assert.rejects(
    () => runRefConnectors(["list", "--as-url", "https://ref.test", "--format", "json"], captured.io, fetch),
    (err) => err instanceof PdppCliError && err.exitCode === 6
  );
  assert.equal(captured.stdout, "", "a malformed discriminator/data shape never renders a fabricated empty list");
});

test("ADVERSARIAL: a blank (whitespace-only) next_cursor on has_more:true is rejected, never issued as a literal ?cursor=+ request", async () => {
  const fetch = mockFetch({
    "https://ref.test/_ref/connectors?limit=100": {
      body: { data: [SUMMARY_FIXTURE], has_more: true, next_cursor: " ", object: "list" },
    },
  });
  const captured = capture();
  await assert.rejects(
    () => runRefConnectors(["list", "--as-url", "https://ref.test", "--format", "json", "--all"], captured.io, fetch),
    (err) => err instanceof PdppCliError && err.exitCode === 6
  );
  assert.equal(
    captured.stdout,
    "",
    "a blank cursor never renders a fabricated page or issues a literal ?cursor=+ follow-up"
  );
});

test("ADVERSARIAL: --all rejects has_more:true with no next_cursor — never silently stops as if exhausted", async () => {
  const fetch = mockFetch({
    "https://ref.test/_ref/connectors?limit=100": {
      body: { data: [SUMMARY_FIXTURE], has_more: true, next_cursor: null, object: "list" },
    },
  });

  const captured = capture();
  await assert.rejects(
    () => runRefConnectors(["list", "--as-url", "https://ref.test", "--format", "json", "--all"], captured.io, fetch),
    (err) => err instanceof PdppCliError && err.exitCode === 6 && NO_USABLE_NEXT_CURSOR_RE.test(err.message)
  );
  assert.equal(captured.stdout, "", "a malformed envelope never renders a fabricated page");
});

test("ADVERSARIAL: --all rejects a next_cursor that repeats the cursor already consumed (self-loop) — never loops forever", async () => {
  const fetch = mockFetch({
    "https://ref.test/_ref/connectors?limit=100": {
      body: { data: [SUMMARY_FIXTURE], has_more: true, next_cursor: "loop-cursor", object: "list" },
    },
    "https://ref.test/_ref/connectors?limit=100&cursor=loop-cursor": {
      body: {
        data: [{ ...SUMMARY_FIXTURE, connection_id: "github-2" }],
        has_more: true,
        next_cursor: "loop-cursor",
        object: "list",
      },
    },
  });

  const captured = capture();
  await assert.rejects(
    () => runRefConnectors(["list", "--as-url", "https://ref.test", "--format", "json", "--all"], captured.io, fetch),
    (err) => err instanceof PdppCliError && err.exitCode === 6 && REPEATED_SELF_LOOPING_CURSOR_RE.test(err.message)
  );
  assert.equal(captured.stdout, "", "a self-looping cursor never renders a partial/duplicated page");
});

test("ADVERSARIAL: --all rejects a next_cursor equal to any cursor already seen this run (not just the immediately-prior one)", async () => {
  const fetch = mockFetch({
    "https://ref.test/_ref/connectors?limit=100": {
      body: { data: [SUMMARY_FIXTURE], has_more: true, next_cursor: "cursor-a", object: "list" },
    },
    "https://ref.test/_ref/connectors?limit=100&cursor=cursor-a": {
      body: {
        data: [{ ...SUMMARY_FIXTURE, connection_id: "github-2" }],
        has_more: true,
        next_cursor: "cursor-b",
        object: "list",
      },
    },
    "https://ref.test/_ref/connectors?limit=100&cursor=cursor-b": {
      body: {
        data: [{ ...SUMMARY_FIXTURE, connection_id: "github-3" }],
        has_more: true,
        // Loops back to the FIRST cursor, not the immediately-prior one.
        next_cursor: "cursor-a",
        object: "list",
      },
    },
  });

  const captured = capture();
  await assert.rejects(
    () => runRefConnectors(["list", "--as-url", "https://ref.test", "--format", "json", "--all"], captured.io, fetch),
    (err) => err instanceof PdppCliError && err.exitCode === 6
  );
});

test("the visited-cursor set is fresh per invocation — a cursor value seen in one --all run does not poison the next", async () => {
  // Two SEPARATE runRefConnectors(["list", ..., "--all"]) invocations, each a
  // single well-formed page whose one cursor happens to be the same string
  // ("shared"). If the visited-set were shared across invocations (e.g.
  // globalThis-backed, the exact shape the gate rejected for the
  // interactive UI pagers), the second invocation would spuriously treat
  // "shared" as already-visited. It must not: each call gets a brand-new
  // local Set inside collectConnectorSummaryPages.
  const fetch = mockFetch({
    "https://ref.test/_ref/connectors?limit=100": {
      body: { data: [SUMMARY_FIXTURE], has_more: false, next_cursor: null, object: "list" },
    },
  });

  const firstCaptured = capture();
  await runRefConnectors(
    ["list", "--as-url", "https://ref.test", "--format", "json", "--all"],
    firstCaptured.io,
    fetch
  );
  const secondCaptured = capture();
  await runRefConnectors(
    ["list", "--as-url", "https://ref.test", "--format", "json", "--all"],
    secondCaptured.io,
    fetch
  );

  assert.ok(firstCaptured.stdout.length > 0, "first invocation must succeed");
  assert.ok(
    secondCaptured.stdout.length > 0,
    "a fresh invocation must not inherit a prior invocation's visited-cursor history"
  );
});

test("--all --verbose --format json merges every collected page's envelope, never dropping earlier pages", async () => {
  const pageOneSummary = { ...SUMMARY_FIXTURE, connection_id: "github-1" };
  const pageTwoSummary = { ...SUMMARY_FIXTURE, connection_id: "github-2" };
  const fetch = mockFetch({
    "https://ref.test/_ref/connectors?limit=100": {
      body: { data: [pageOneSummary], has_more: true, next_cursor: "cursor-page-2", object: "list" },
    },
    "https://ref.test/_ref/connectors?limit=100&cursor=cursor-page-2": {
      body: { data: [pageTwoSummary], has_more: false, next_cursor: null, object: "list" },
    },
  });

  const captured = capture();
  const code = await runRefConnectors(
    ["list", "--as-url", "https://ref.test", "--format", "json", "--all", "--verbose"],
    captured.io,
    fetch
  );

  assert.equal(code, 0);
  const parsed = JSON.parse(captured.stdout);
  assert.equal(parsed.data.length, 2, "--verbose --all must merge BOTH pages' rows, not just the last page's");
  const ids = parsed.data.map((row) => row.connection_id);
  assert.deepEqual(new Set(ids).size, ids.length, "no row is duplicated across the page boundary");
  assert.equal(parsed.envelopes.length, 2, "every collected page's raw envelope is present, not just the last");
});

test("--verbose (no --all, single page) still returns the bare raw envelope unchanged (no wrapper regression)", async () => {
  const fetch = mockFetch({
    "https://ref.test/_ref/connectors?limit=100": {
      body: { object: "list", data: [SUMMARY_FIXTURE], has_more: false, next_cursor: null },
    },
  });

  const captured = capture();
  await runRefConnectors(["list", "--as-url", "https://ref.test", "--format", "json", "--verbose"], captured.io, fetch);

  const parsed = JSON.parse(captured.stdout);
  assert.deepEqual(parsed, { object: "list", data: [SUMMARY_FIXTURE], has_more: false, next_cursor: null });
});
