// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * biome-ignore-all lint/performance/useTopLevelRegex: These invariant tests use
 * local regex assertions to keep the source-contract checks readable.
 *
 * Asserts that the device-exporters enrollment form surfaces the canonical
 * `@pdpp/local-collector` enroll / run invocations via the shared
 * helpers in apps/console/src/lib/pdpp-cli-command.ts, and exposes stable test
 * hooks for the rendered commands. The operator-readiness runbook in
 * docs/operator/local-collector-runbook.md depends on this surface; if it
 * drifts, the runbook drifts with it.
 *
 * See openspec/changes/introduce-local-collector-runner and
 * openspec/changes/design-local-collector-state-sync.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../../../../../../", import.meta.url);

function read(relPath: string): Promise<string> {
  return readFile(fileURLToPath(new URL(relPath, ROOT)), "utf8");
}

const FORM_PATH = "apps/console/src/app/(console)/device-exporters/enrollment-form.tsx";
const ACTIONS_PATH = "apps/console/src/app/(console)/device-exporters/actions.ts";

const COLLECTOR_ENROLL_HELPER = /pdppLocalCollectorEnrollCommand/;
const COLLECTOR_RUN_HELPER = /pdppLocalCollectorRunCommand/;
const LOCAL_COLLECTOR_PACKAGE = /@pdpp\/local-collector/;
const BROWSER_COLLECTOR_MONOREPO_COPY =
  /PDPP monorepo checkout|pnpm --dir|packages\/polyfill-connectors|browser-collector run command/;
const ENROLL_TESTID = /data-testid="collector-enroll-command"/;
const RUN_TESTID_CLAUDE = /data-testid={`collector-run-command-/;
const SUPPORTED_CONNECTORS = /COLLECTOR_RUN_CONNECTORS\s*=\s*\["claude_code",\s*"codex"\]/;

test("enrollment form derives the canonical local collector commands via shared helpers", async () => {
  const src = await read(FORM_PATH);
  assert.match(src, COLLECTOR_ENROLL_HELPER, "form must call pdppLocalCollectorEnrollCommand");
  assert.match(src, COLLECTOR_RUN_HELPER, "form must call pdppLocalCollectorRunCommand");
  assert.match(src, LOCAL_COLLECTOR_PACKAGE, "form must surface the public @pdpp/local-collector path");
  assert.doesNotMatch(src, BROWSER_COLLECTOR_MONOREPO_COPY, "normal form must not surface browser monorepo commands");
});

test("enrollment form exposes stable test hooks for the rendered commands", async () => {
  const src = await read(FORM_PATH);
  assert.match(src, ENROLL_TESTID, "enroll command must carry a stable data-testid");
  assert.match(src, RUN_TESTID_CLAUDE, "run command must carry a stable per-connector data-testid");
});

test("enrollment form advertises claude_code and codex as the operator-ready connectors", async () => {
  const src = await read(FORM_PATH);
  assert.match(src, SUPPORTED_CONNECTORS, "claude_code and codex are the documented MVP collector lanes");
});

test("enrollment action only mints packaged local collector enrollment codes", async () => {
  const src = await read(ACTIONS_PATH);
  assert.match(src, /isSupportedLocalCollectorConnector\(connectorId\)/);
  assert.match(src, /only creates packaged local collector enrollments/);
  assert.doesNotMatch(src, /isSupportedBrowserCollectorConnector/);
});

const RUNBOOK_CROSS_REF = /docs\/operator\/local-collector-runbook\.md/;
const PDPP_COLLECTOR_ENROLL_LITERAL = /@pdpp\/local-collector enroll/;

test("local-device-exporter runbook cross-references the operator runbook", async () => {
  const legacyDoc = await read("reference-implementation/docs/local-device-exporter.md");
  assert.match(
    legacyDoc,
    RUNBOOK_CROSS_REF,
    "legacy lane doc must point operators at the supported pdpp collector flow"
  );
  assert.match(
    legacyDoc,
    PDPP_COLLECTOR_ENROLL_LITERAL,
    "legacy lane doc must surface the canonical @pdpp/local-collector enroll command"
  );
});
