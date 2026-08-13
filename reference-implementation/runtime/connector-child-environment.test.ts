// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { composeConnectorChildEnvironment } from "./connector-child-environment.ts";

function manifest(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../../packages/polyfill-connectors/manifests/${name}.json`, import.meta.url), "utf8")
  );
}

function compose(manifestValue: unknown, sourceEnv: NodeJS.ProcessEnv, connectionEnv: Record<string, string> = {}) {
  return composeConnectorChildEnvironment({
    connectionEnv,
    explicitRunEnv: {},
    manifest: manifestValue,
    platform: "linux",
    sourceEnv,
  });
}

function assertConnectorLocalFallback(
  manifestName: string,
  sourceEnv: NodeJS.ProcessEnv,
  expected: Record<string, string>
): void {
  const env = compose(manifest(manifestName), sourceEnv);
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(env[key], value, `${manifestName} should receive ${key}`);
  }
  const siblingKeys = Object.keys(sourceEnv).filter((key) => !(key in expected));
  for (const key of siblingKeys) {
    assert.equal(env[key], undefined, `${manifestName} must not receive another connector's ${key}`);
  }
}

test("current manifest fallback follows supported declaration fields only", () => {
  const env = compose(
    {
      capabilities: {
        auth: {
          connection_config: [{ env_var: "CONNECTION_ENV" }, { env_var: "" }, { ignored: "UNKNOWN" }],
          deployment_config: [
            "AUTH_BARE",
            { key: "AUTH_LEGACY" },
            { logical_key: "AUTH_LOGICAL" },
            { env_alias: "AUTH_ALIAS", logical_key: "AUTH_OTHER_LOGICAL" },
            { env_alias: "ORPHAN_ALIAS" },
            { key: "MALFORMED_LEGACY", logical_key: "" },
          ],
          required: ["LEGACY_MUST_NOT_APPEAR"],
        },
      },
      runtime_requirements: {
        external_tools: [{ detect: { executable_env_override: "TOOL_ENV" } }, { detect: { unknown: "NOPE" } }],
        local_paths: {
          home_env_override: "HOME_OVERRIDE",
          paths: [{ env_override: "PATH_OVERRIDE" }, { ignored: "NOPE" }],
        },
      },
      setup: {
        credential_capture: { fields: [{ env: ["CAPTURE_ENV", { env_alias: "NO_OBJECTS" }, "", 3] }] },
        deployment_config: [
          "SETUP_BARE",
          { key: "SETUP_LEGACY" },
          { logical_key: "SETUP_LOGICAL" },
          { env_alias: "SETUP_ALIAS", logical_key: "SETUP_OTHER_LOGICAL" },
          { env_alias: "ORPHAN_SETUP_ALIAS" },
        ],
        manual_or_upload: { import_dir_env_var: "IMPORT_DIR" },
      },
    },
    {
      AUTH_ALIAS: "auth-alias",
      AUTH_BARE: "auth-bare",
      AUTH_LEGACY: "auth-legacy",
      AUTH_LOGICAL: "auth-logical",
      CAPTURE_ENV: "capture",
      CONNECTION_ENV: "connection",
      HOME_OVERRIDE: "home",
      IMPORT_DIR: "import",
      LEGACY_MUST_NOT_APPEAR: "legacy",
      MALFORMED_LEGACY: "must-not-cross",
      NO_OBJECTS: "object",
      ORPHAN_ALIAS: "orphan",
      ORPHAN_SETUP_ALIAS: "orphan-setup",
      PATH_OVERRIDE: "path",
      SETUP_ALIAS: "setup-alias",
      SETUP_BARE: "setup-bare",
      SETUP_LEGACY: "setup-legacy",
      SETUP_LOGICAL: "setup-logical",
      TOOL_ENV: "tool",
    }
  );

  assert.deepEqual(env, {
    AUTH_ALIAS: "auth-alias",
    AUTH_BARE: "auth-bare",
    AUTH_LEGACY: "auth-legacy",
    AUTH_LOGICAL: "auth-logical",
    CAPTURE_ENV: "capture",
    CONNECTION_ENV: "connection",
    HOME_OVERRIDE: "home",
    IMPORT_DIR: "import",
    PATH_OVERRIDE: "path",
    SETUP_ALIAS: "setup-alias",
    SETUP_BARE: "setup-bare",
    SETUP_LEGACY: "setup-legacy",
    SETUP_LOGICAL: "setup-logical",
    TOOL_ENV: "tool",
  });
});

test("legacy auth.required supplies actual Strava credentials", () => {
  assert.deepEqual(compose(manifest("strava"), { STRAVA_ACCESS_TOKEN: "strava-token" }), {
    STRAVA_ACCESS_TOKEN: "strava-token",
  });
});

test("Google Calendar deployment and connection declarations reach its child", () => {
  assert.deepEqual(
    compose(manifest("google_calendar"), {
      GOOGLE_CALENDAR_REFRESH_TOKEN: "refresh-token",
      GOOGLE_OAUTH_CLIENT_ID: "client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
      OTHER_CONNECTOR_TOKEN: "must-not-cross",
    }),
    {
      GOOGLE_CALENDAR_REFRESH_TOKEN: "refresh-token",
      GOOGLE_OAUTH_CLIENT_ID: "client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
    }
  );
});

test("legacy shipped inputs remain connector-local until their manifests declare them", () => {
  const sourceEnv = {
    APPLE_CARDDAV_ORIGIN: "https://carddav.example",
    APPLE_HEALTH_EXPORT_DIR: "/imports/apple-health",
    APPLE_PHOTOS_EXPORT_DIR: "/imports/apple-photos",
    CHASE_2FA_METHOD: "email",
    CLAUDE_CODE_PROJECT_EXCLUDE: "private",
    CLAUDE_CODE_PROJECT_INCLUDE: "work",
    CODEX_PROMPTS_DIR: "/codex/prompts",
    CODEX_RULES_DIR: "/codex/rules",
    CODEX_SKILLS_DIR: "/codex/skills",
    GOOGLE_TAKEOUT_DIR: "/imports/google-takeout",
    ICAL_IMPORT_DIR: "/imports/ical",
    ICAL_SUBSCRIPTION_URL: "https://calendar.example/feed.ics",
    IMESSAGE_ATTACHMENTS_ROOT: "/messages/attachments",
    IMESSAGE_DB_PATH: "/messages/chat.db",
    SLACK_CHANNEL_ALLOWLIST: "C123,C456",
    SLACK_CHANNEL_TYPES: "public_channel,private_channel",
    SLACK_LOOKBACK_DAYS: "90",
    SLACK_MEMBER_ONLY: "true",
    SLACK_RECLAIM_UPLOADS: "1",
    SLACK_SKIP_FILES: "false",
    TWITTER_ARCHIVE_DIR: "/imports/twitter",
  };
  const cases: [string, Record<string, string>][] = [
    ["apple_health", { APPLE_HEALTH_EXPORT_DIR: sourceEnv.APPLE_HEALTH_EXPORT_DIR }],
    ["apple_contacts", { APPLE_CARDDAV_ORIGIN: sourceEnv.APPLE_CARDDAV_ORIGIN }],
    ["apple_photos", { APPLE_PHOTOS_EXPORT_DIR: sourceEnv.APPLE_PHOTOS_EXPORT_DIR }],
    ["chase", { CHASE_2FA_METHOD: sourceEnv.CHASE_2FA_METHOD }],
    [
      "claude_code",
      {
        CLAUDE_CODE_PROJECT_EXCLUDE: sourceEnv.CLAUDE_CODE_PROJECT_EXCLUDE,
        CLAUDE_CODE_PROJECT_INCLUDE: sourceEnv.CLAUDE_CODE_PROJECT_INCLUDE,
      },
    ],
    [
      "codex",
      {
        CODEX_PROMPTS_DIR: sourceEnv.CODEX_PROMPTS_DIR,
        CODEX_RULES_DIR: sourceEnv.CODEX_RULES_DIR,
        CODEX_SKILLS_DIR: sourceEnv.CODEX_SKILLS_DIR,
      },
    ],
    ["google_takeout", { GOOGLE_TAKEOUT_DIR: sourceEnv.GOOGLE_TAKEOUT_DIR }],
    [
      "ical",
      {
        ICAL_IMPORT_DIR: sourceEnv.ICAL_IMPORT_DIR,
        ICAL_SUBSCRIPTION_URL: sourceEnv.ICAL_SUBSCRIPTION_URL,
      },
    ],
    [
      "imessage",
      {
        IMESSAGE_ATTACHMENTS_ROOT: sourceEnv.IMESSAGE_ATTACHMENTS_ROOT,
        IMESSAGE_DB_PATH: sourceEnv.IMESSAGE_DB_PATH,
      },
    ],
    [
      "slack",
      {
        SLACK_CHANNEL_ALLOWLIST: sourceEnv.SLACK_CHANNEL_ALLOWLIST,
        SLACK_CHANNEL_TYPES: sourceEnv.SLACK_CHANNEL_TYPES,
        SLACK_LOOKBACK_DAYS: sourceEnv.SLACK_LOOKBACK_DAYS,
        SLACK_MEMBER_ONLY: sourceEnv.SLACK_MEMBER_ONLY,
        SLACK_RECLAIM_UPLOADS: sourceEnv.SLACK_RECLAIM_UPLOADS,
        SLACK_SKIP_FILES: sourceEnv.SLACK_SKIP_FILES,
      },
    ],
    ["strava", {}],
    ["twitter_archive", { TWITTER_ARCHIVE_DIR: sourceEnv.TWITTER_ARCHIVE_DIR }],
  ];

  for (const [manifestName, expected] of cases) {
    assertConnectorLocalFallback(manifestName, sourceEnv, expected);
  }
});

test("connection fragments cannot override reserved controls and take precedence over fallback", () => {
  const env = compose(
    { capabilities: { auth: { required: ["CURRENT_CONNECTOR_TOKEN"] } } },
    { CURRENT_CONNECTOR_TOKEN: "ambient", PATH: "/safe-path", PDPP_OWNER_TOKEN: "ambient-owner" },
    {
      CURRENT_CONNECTOR_TOKEN: "connection",
      Path: "attack",
      pdpp_owner_token: "attack",
      pdpp_rs_url: "attack",
    }
  );
  assert.equal(env.CURRENT_CONNECTOR_TOKEN, "connection");
  assert.equal(env.PDPP_OWNER_TOKEN, undefined);
  assert.equal(env.PDPP_RS_URL, undefined);
  assert.equal(env.PATH, "/safe-path");
});

test("Windows has one case-insensitive logical key; POSIX keeps proxy aliases", () => {
  const windows = composeConnectorChildEnvironment({
    connectionEnv: { NAME: "first", name: "second" },
    explicitRunEnv: { nAmE: "run" },
    manifest: { capabilities: { auth: { required: ["NAME"] } } },
    platform: "win32",
    sourceEnv: { HTTP_PROXY: "upper", Path: "C:\\Windows" },
  });
  assert.equal(Object.keys(windows).filter((key) => key.toUpperCase() === "NAME").length, 1);
  assert.equal(windows.nAmE, "run");
  assert.equal(Object.keys(windows).filter((key) => key.toUpperCase() === "PATH").length, 1);
  assert.equal(windows.Path, "C:\\Windows");

  const windowsFallback = composeConnectorChildEnvironment({
    explicitRunEnv: {},
    manifest: { capabilities: { auth: { required: ["CURRENT_CONNECTOR_TOKEN"] } } },
    platform: "win32",
    sourceEnv: { current_connector_token: "ambient" },
  });
  assert.equal(windowsFallback.CURRENT_CONNECTOR_TOKEN, "ambient");

  const windowsLegacyFallback = composeConnectorChildEnvironment({
    explicitRunEnv: {},
    manifest: manifest("slack"),
    platform: "win32",
    sourceEnv: {
      Slack_Reclaim_Uploads: "1",
      slack_channel_allowlist: "C123",
    },
  });
  assert.deepEqual(windowsLegacyFallback, {
    SLACK_CHANNEL_ALLOWLIST: "C123",
    SLACK_RECLAIM_UPLOADS: "1",
  });

  const windowsSibling = composeConnectorChildEnvironment({
    explicitRunEnv: {},
    manifest: manifest("strava"),
    platform: "win32",
    sourceEnv: {
      google_takeout_dir: "C:\\imports\\takeout",
      iMessage_Db_Path: "C:\\Messages\\chat.db",
      Slack_Reclaim_Uploads: "1",
    },
  });
  assert.equal(windowsSibling.GOOGLE_TAKEOUT_DIR, undefined);
  assert.equal(windowsSibling.IMESSAGE_DB_PATH, undefined);
  assert.equal(windowsSibling.SLACK_RECLAIM_UPLOADS, undefined);

  const posix = compose({}, { HTTP_PROXY: "upper", http_proxy: "lower" });
  assert.equal(posix.HTTP_PROXY, "upper");
  assert.equal(posix.http_proxy, "lower");

  const posixLayers = compose(
    { capabilities: { auth: { required: ["NAME"] } } },
    { NAME: "ambient" },
    { NAME: "connection-exact", name: "connection-distinct" }
  );
  assert.equal(posixLayers.NAME, "connection-exact");
  assert.equal(posixLayers.name, "connection-distinct");
});

test("reviewed production tuning crosses while discontinued probes do not", () => {
  const env = compose(
    {},
    {
      PDPP_CHATGPT_BROWSER_LOGIN_TIMEOUT_MS: "30000",
      PDPP_CHATGPT_DETAIL_INITIAL_CONCURRENCY_PROBE: "10",
      PDPP_CHATGPT_DETAIL_MAX_CONCURRENCY_PROBE: "20",
      PDPP_CHATGPT_DETAIL_PAUSE_MAX_MS_PROBE: "300",
      PDPP_CHATGPT_DETAIL_PAUSE_MIN_MS_PROBE: "100",
      PDPP_CHATGPT_PUSH_APPROVAL_TIMEOUT_MS: "10000",
    }
  );
  assert.equal(env.PDPP_CHATGPT_PUSH_APPROVAL_TIMEOUT_MS, "10000");
  assert.equal(env.PDPP_CHATGPT_BROWSER_LOGIN_TIMEOUT_MS, "30000");
  assert.equal(env.PDPP_CHATGPT_DETAIL_INITIAL_CONCURRENCY_PROBE, undefined);
  assert.equal(env.PDPP_CHATGPT_DETAIL_MAX_CONCURRENCY_PROBE, undefined);
  assert.equal(env.PDPP_CHATGPT_DETAIL_PAUSE_MAX_MS_PROBE, undefined);
  assert.equal(env.PDPP_CHATGPT_DETAIL_PAUSE_MIN_MS_PROBE, undefined);
});
