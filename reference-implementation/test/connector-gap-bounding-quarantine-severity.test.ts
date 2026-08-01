// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// `recordQuarantinedDetailGap` (runtime/index.ts) builds its known_gap via
// `buildKnownGap({ kind: "detail_gap", severity: "actionable", ... })` — an
// EXPLICIT per-call override, not a change to `classifyKnownGapSeverity`'s
// shared `kind === "detail_gap"` fallback (which stays `"recoverable"` for
// the common case: a detail_gap that eventually hydrates on retry — see
// detail-coverage-recovered-gap-regression.test.ts). `buildKnownGap`'s
// existing `severity` param already short-circuits that fallback
// (connector-gap-bounding.ts: `if (typeof severity === "string" &&
// GAP_SEVERITIES.has(severity)) return severity;`), so this only affects the
// one caller that opts in.
//
// `severity: "actionable"` here does NOT mean "owner can fix this" — per
// connection-health coverage policy (server/connector-gap-classification.ts)
// and rendered-verdict.ts's `buildRequiredActions`, a `disposition: "terminal"`
// connection with no credential failure renders a maintainer-only `code_fix`
// status line (`audience: "maintainer"`, `satisfied_when.kind: "none"`), never
// an owner CTA. A quarantined per-item gap (the runtime's no-progress budget
// exhausted, `runtime/recovery-quarantine.ts`) is exactly that: there is no
// owner action that un-quarantines an item, so `recoverable` (implying
// "already fine") would mask a real data-completeness gap, and it must
// resolve to the terminal/code_fix bucket instead.

import assert from "node:assert/strict";
import test from "node:test";

import { buildKnownGap } from "../runtime/connector-gap-bounding.ts";

const IMAP_DOWNLOAD_FAILED_PATTERN = /imap_download_failed/;
const NO_CAPTURED_CAUSE_PATTERN = /no captured cause/;
const NEEDS_INVESTIGATION_PATTERN = /needs investigation/;

test("a quarantined detail_gap with a captured failure_class names the cause and is actionable/maintainer, not recoverable", () => {
  const gap = buildKnownGap({
    kind: "detail_gap",
    message:
      "Repeated no-progress on this item (cause: imap_download_failed); quarantined for connector diagnosis (siblings keep recovering).",
    reason: "quarantined",
    recoveryHint: "not_retriable",
    scope: { parent_stream: "messages", record_key: "1664530353808036049:7" },
    severity: "actionable",
    stream: "attachments",
  });

  assert.equal(gap.severity, "actionable");
  assert.equal(gap.reason, "quarantined");
  assert.deepEqual(gap.recovery_hint, { action: "not_retriable", retryable: false });
  assert.match(gap.message as string, IMAP_DOWNLOAD_FAILED_PATTERN);
});

test("a quarantined detail_gap with NO captured failure_class says so honestly instead of claiming a specific cause", () => {
  const gap = buildKnownGap({
    kind: "detail_gap",
    message:
      "Repeated no-progress on this item with no captured cause; quarantined for connector diagnosis and needs investigation (siblings keep recovering).",
    reason: "quarantined",
    recoveryHint: "not_retriable",
    scope: { parent_stream: "messages", record_key: "unknown:0" },
    severity: "actionable",
    stream: "attachments",
  });

  assert.equal(gap.severity, "actionable");
  assert.match(gap.message as string, NO_CAPTURED_CAUSE_PATTERN);
  assert.match(gap.message as string, NEEDS_INVESTIGATION_PATTERN);
});

test("a non-quarantined detail_gap with no severity override still classifies as recoverable (the shared fallback is untouched)", () => {
  const gap = buildKnownGap({
    kind: "detail_gap",
    reason: "hydration_failed",
    recoveryHint: "retry_by_runtime",
    stream: "attachments",
  });

  assert.equal(gap.severity, "recoverable");
});

test("a quarantined detail_gap with NO severity override still falls back to recoverable via the shared classifier (proves the override, not the shared rule, carries this fix)", () => {
  const gap = buildKnownGap({
    kind: "detail_gap",
    reason: "quarantined",
    recoveryHint: "not_retriable",
    stream: "attachments",
  });

  assert.equal(
    gap.severity,
    "recoverable",
    "classifyKnownGapSeverity's kind==='detail_gap' fallback is untouched by this fix — only recordQuarantinedDetailGap's explicit override changes behavior"
  );
});
