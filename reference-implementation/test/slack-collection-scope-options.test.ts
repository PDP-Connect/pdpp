// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Slack collection-scope options must reach the connector child.
 *
 * Incident (ledger D8): the owner asked at least twice for his 95 ARCHIVED
 * Slack channels. Two independent defects kept them out of reach.
 *
 *   1. The connector reported archived channels as "absent by configuration,
 *      not lost" — a claim only honest if the configuration is reachable.
 *      (Fixed in connectors/slack/index.ts; `-member-only` filters on
 *      `is_member` alone and never on `is_archived`.)
 *   2. THIS file's concern: `SLACK_MEMBER_ONLY` was absent from PLATFORM_KEYS,
 *      so the connector child never inherited it. Setting it on the container
 *      changed nothing, silently. Live proof at the time of the fix: the
 *      deployment had `SLACK_RECLAIM_UPLOADS` set on the container, and the
 *      running connector child's `/proc/<pid>/environ` did NOT contain it.
 *
 * The contract pinned here: an operator who sets a Slack collection-scope
 * option in the deployment environment gets it delivered to the connector
 * child verbatim. Without that, the option is documentation, not a setting.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { composeConnectorChildEnvironment } from "../runtime/connector-child-environment.ts";

/** Every option `readSlackOptions` reads, per connectors/slack/index.ts. */
const SLACK_COLLECTION_SCOPE_OPTIONS = [
  "SLACK_MEMBER_ONLY",
  "SLACK_LOOKBACK_DAYS",
  "SLACK_CHANNEL_ALLOWLIST",
  "SLACK_CHANNEL_TYPES",
  "SLACK_SKIP_FILES",
  "SLACK_RECLAIM_UPLOADS",
] as const;

function childEnv(sourceEnv: NodeJS.ProcessEnv): Record<string, string> {
  return composeConnectorChildEnvironment({
    connectorId: "slack",
    explicitRunEnv: {},
    manifest: {},
    platform: "linux",
    sourceEnv: { PATH: "/usr/bin", ...sourceEnv },
  });
}

test("SLACK_MEMBER_ONLY=false reaches the connector child", () => {
  // The single setting that unblocks the owner's archived channels. If this
  // assertion fails, the owner can set the variable and nothing happens.
  const env = childEnv({ SLACK_MEMBER_ONLY: "false" });
  assert.equal(
    env.SLACK_MEMBER_ONLY,
    "false",
    "SLACK_MEMBER_ONLY must be delivered to the child: without it the archived-channel fix is unreachable"
  );
});

test("every Slack collection-scope option reaches the connector child", () => {
  const source: NodeJS.ProcessEnv = {};
  for (const key of SLACK_COLLECTION_SCOPE_OPTIONS) {
    source[key] = `value-for-${key}`;
  }
  const env = childEnv(source);
  const missing = SLACK_COLLECTION_SCOPE_OPTIONS.filter((key) => env[key] !== `value-for-${key}`);
  assert.deepEqual(missing, [], `Slack options dropped before the connector child: ${missing.join(", ")}`);
});

test("an unset Slack option is not fabricated into the child environment", () => {
  // Absence must stay absence so the connector's own default (member-only
  // ON) applies, rather than an empty string coercing to a surprise value.
  const env = childEnv({});
  for (const key of SLACK_COLLECTION_SCOPE_OPTIONS) {
    assert.equal(env[key], undefined, `${key} must be absent when the operator did not set it`);
  }
});
