// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Build-time guardrail: any connector manifest stream that declares
 * `coverage_policy` must use a recognized enum value, and a stream
 * declaring an accepted-coverage policy (anything other than `collect`)
 * must NOT also declare `required: true` — a required+accepted-absent
 * stream is a contradictory manifest that degrades health rather than
 * projecting accepted-coverage-green.
 *
 * Backs OpenSpec `add-universal-connector-coverage-evidence`: "The manifest
 * stream schema SHALL declare and validate coverage_policy."
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MANIFESTS_DIR = join(PACKAGE_ROOT, "manifests");

const VALID_COVERAGE_POLICIES = new Set(["collect", "deferred", "inventory_only", "unavailable", "unsupported"]);

// Accepted-coverage policies: declaring one of these on a required stream is
// contradictory (the stream is simultaneously load-bearing and accepted-absent).
const ACCEPTED_COVERAGE_POLICIES = new Set(["deferred", "inventory_only", "unavailable", "unsupported"]);

interface ManifestStream {
  coverage_policy?: unknown;
  name?: unknown;
  required?: unknown;
  [key: string]: unknown;
}

interface ConnectorManifest {
  streams?: ManifestStream[];
  [key: string]: unknown;
}

test("connector manifest streams: coverage_policy uses only valid enum values", () => {
  const violations: string[] = [];

  for (const filename of readdirSync(MANIFESTS_DIR).sort()) {
    if (!filename.endsWith(".json")) {
      continue;
    }
    const manifestPath = join(MANIFESTS_DIR, filename);
    if (!existsSync(manifestPath)) {
      continue;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ConnectorManifest;
    const connectorKey = filename.replace(/\.json$/, "");

    for (const stream of manifest.streams ?? []) {
      if (!("coverage_policy" in stream)) {
        continue;
      }
      const policy = stream.coverage_policy;
      if (!VALID_COVERAGE_POLICIES.has(policy as string)) {
        violations.push(
          `${connectorKey}.${String(stream.name)}: coverage_policy "${String(policy)}" is not in the recognized enum ` +
            `(${[...VALID_COVERAGE_POLICIES].join(" | ")})`
        );
      }
    }
  }

  assert.deepEqual(violations, [], "All declared coverage_policy values must be in the recognized enum");
});

test("connector manifest streams: accepted-coverage policy must not combine with required: true", () => {
  const violations: string[] = [];

  for (const filename of readdirSync(MANIFESTS_DIR).sort()) {
    if (!filename.endsWith(".json")) {
      continue;
    }
    const manifestPath = join(MANIFESTS_DIR, filename);
    if (!existsSync(manifestPath)) {
      continue;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ConnectorManifest;
    const connectorKey = filename.replace(/\.json$/, "");

    for (const stream of manifest.streams ?? []) {
      const policy = stream.coverage_policy as string | undefined;
      if (!(policy && ACCEPTED_COVERAGE_POLICIES.has(policy))) {
        continue;
      }
      // `required` defaults to true when absent — so absent is the same as required: true.
      const { required } = stream;
      if (required !== false) {
        violations.push(
          `${connectorKey}.${String(stream.name)}: coverage_policy="${policy}" with required=${String(required ?? "absent (defaults true)")} ` +
            "is contradictory — a stream cannot be both load-bearing and accepted-absent. " +
            `Add "required": false or change coverage_policy to "collect".`
        );
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    "Accepted-coverage policy (deferred/inventory_only/unavailable/unsupported) requires required: false"
  );
});

/**
 * Fields that carry no runtime/behavioral meaning — free-text prose shown
 * to owners in UI copy. Reformatting or clarifying these must NOT trip the
 * ratchet below; every other field on a stream is part of its behavioral
 * contract (schema, semantics, cursor/incremental strategy, coverage
 * policy, the `required` flag itself, etc.) and DOES trip it.
 */
const COSMETIC_STREAM_FIELDS = new Set(["description", "display"]);

/**
 * Fingerprints the semantically meaningful subset of a manifest stream
 * (everything except `COSMETIC_STREAM_FIELDS`) into a short, stable,
 * order-independent digest. Two stream objects with identical fingerprints
 * are behaviorally identical for every consumer of the manifest; anything
 * that changes the fingerprint is a semantic edit, not formatting.
 */
function fingerprintSemanticStream(stream: ManifestStream): string {
  const semantic: Record<string, unknown> = {};
  for (const key of Object.keys(stream).sort()) {
    if (!COSMETIC_STREAM_FIELDS.has(key)) {
      semantic[key] = stream[key];
    }
  }
  return createHash("sha256").update(JSON.stringify(semantic)).digest("hex").slice(0, 16);
}

/**
 * Ratchet guardrail for the `7cc177eec` class of regression: a manifest
 * stream that silently loses its `required: false` declaration (or never
 * gets one) becomes implicitly load-bearing, and — absent a run-isolation
 * seam — a transient failure in that ONE stream can fail an entire
 * connector run even when every other stream succeeded (see
 * `tmp/workstreams/2026-07-14-health-regression/slack-stars.md`).
 *
 * A blanket "every stream must declare required" rule is the concept-
 * correct end state, but 117 of 134 streams across the manifest set
 * predate this guardrail and omit `required` today (verified by direct
 * scan at authoring time) — failing all of them at once is out of scope
 * for a single change.
 *
 * `KNOWN_MISSING_REQUIRED` is that exact snapshot, keyed by
 * `connector.stream` and mapped to a fingerprint (see
 * `fingerprintSemanticStream`) of that stream's semantic fields AT THE
 * TIME IT WAS GRANDFATHERED. This is deliberately NOT a bare allowlist of
 * keys: a bare allowlist only catches a brand-new omission — it would
 * silently accept an edit to an EXISTING grandfathered stream (e.g.
 * widening its `schema`, flipping `semantics`, or adding a
 * `coverage_policy`) as long as the stream's `name` stayed on the list and
 * `required` stayed absent. Comparing fingerprints closes that gap without
 * touching git history: any semantic change to a grandfathered stream
 * changes its fingerprint and fails the test, while pure prose edits to
 * `description`/`display` (excluded from the fingerprint) do not.
 *
 * The map does NOT grow. Any NEW stream, or any EXISTING stream not
 * already on this list, must declare `required` explicitly. Shrinking the
 * map (a stream gaining an explicit `required`, so it's removed entirely)
 * is encouraged and always passes. The test fails if: (a) a stream not on
 * this map omits `required`, or (b) a stream ON this map still omits
 * `required` AND its current fingerprint no longer matches the frozen one
 * — i.e. someone edited a grandfathered stream's semantics without also
 * giving it an explicit `required`.
 */
const KNOWN_MISSING_REQUIRED = new Map([
  ["amazon.orders", "0f982754cdbd3515"],
  ["amazon.order_items", "4ebc04ded1936f87"],
  ["anthropic.conversations", "30ae75cafa437b1a"],
  ["anthropic.messages", "20d62f1a0c2f2052"],
  ["anthropic.projects", "415dccf66dc5c874"],
  ["apple_health.records", "5e0be530965e99b7"],
  ["apple_health.workouts", "5041f6c6a2dd23a1"],
  ["chase.accounts", "71bcf4e2f00dc245"],
  ["chase.transactions", "dea21991c632f625"],
  ["chase.current_activity", "8b8b57d39d026288"],
  ["chase.statements", "2821c3ef98cec2a2"],
  ["chase.balances", "15c21df9a8a9c805"],
  ["chatgpt.conversations", "d657ca4397289582"],
  ["chatgpt.messages", "cc672810cdb9d950"],
  ["chatgpt.memories", "b5c37dda48682901"],
  ["chatgpt.custom_gpts", "2fd94123f1988a58"],
  ["chatgpt.custom_instructions", "c3fab122ae6242c0"],
  ["chatgpt.shared_conversations", "e78a424f4991a12e"],
  ["claude_code.sessions", "d20454c2fa7a8a00"],
  ["claude_code.messages", "1a160c80dd0e55b9"],
  ["claude_code.attachments", "e11507ebc9578ee3"],
  ["claude_code.skills", "999d688ffc24cf50"],
  ["claude_code.memory_notes", "cb9f29664cd93902"],
  ["claude_code.slash_commands", "02e2932c49d7cca0"],
  ["codex.sessions", "fc9ede7170030600"],
  ["codex.messages", "58259a2fb69ebb7f"],
  ["codex.function_calls", "780a42f8931bda6f"],
  ["codex.rules", "a056c2cd28198a13"],
  ["codex.prompts", "b46d9879df70b604"],
  ["codex.skills", "bd5a65644fcfe045"],
  ["codex.coverage_diagnostics", "fb67ab5be18229ef"],
  ["doordash.orders", "3f7608fe62440cad"],
  ["doordash.order_items", "3c8fd340d907545c"],
  ["github.user", "b6ec1e77b0c49ac1"],
  ["github.user_stats", "ad44e77cf37957c5"],
  ["github.repositories", "a281334e68e1a5f6"],
  ["github.starred", "9e311bc30648caf0"],
  ["github.issues", "78d301cf719a8421"],
  ["github.pull_requests", "d444968a557e6de5"],
  ["github.gists", "b373793ba858d2c5"],
  ["gmail.messages", "88c18d102254ecd8"],
  ["gmail.threads", "10a2882dc2287b8c"],
  ["gmail.labels", "7b5c8aad799a9641"],
  ["gmail.message_bodies", "b5728d074ffa2170"],
  ["gmail.attachments", "3883a623c52d9879"],
  ["google_maps.timeline_points", "8bb6f3a0b2f01651"],
  ["google_maps.timeline_segments", "1f331e7b299d5569"],
  ["google_maps_data_portability.archive_jobs", "1bdf641fe46f4606"],
  ["google_takeout.location_history", "4541b67d9dca3a75"],
  ["google_takeout.youtube_watch_history", "a457e03d943b3122"],
  ["google_takeout.search_history", "d7b77b2dd865f3a5"],
  ["heb.orders", "600aed4c2656fc7d"],
  ["heb.order_items", "6758669e7210b043"],
  ["ical.events", "868ee3c02c299d62"],
  ["imessage.messages", "d3da2aabba2487c9"],
  ["linkedin.profile", "3395f862d4b24d20"],
  ["linkedin.experience", "2be57c6594dce57f"],
  ["linkedin.education", "25502e171aedae30"],
  ["linkedin.skills", "f4bb4fd4caaa6d20"],
  ["loom.videos", "a9092d819dada367"],
  ["loom.transcripts", "f46e8b4855374a75"],
  ["meta.profile", "0aad83eb0dac8dd5"],
  ["meta.posts", "290a77d8251d161a"],
  ["notion.pages", "7ec6e24c7e82d415"],
  ["notion.databases", "671e140318e03f48"],
  ["oura.sleep", "3fa91ffee7d9cad4"],
  ["oura.readiness", "c152a01bbdffce42"],
  ["oura.activity", "84eda8d7791f9822"],
  ["pocket.items", "0bd037ae0e378345"],
  ["reddit.submitted", "dda537b9eb701de8"],
  ["reddit.comments", "930a68711ff5b78e"],
  ["reddit.saved", "b932abf40690ab85"],
  ["reddit.upvoted", "33f9037aa1ea6d85"],
  ["reddit.downvoted", "1a9026c2bead89eb"],
  ["reddit.hidden", "a4178a68b917c4c1"],
  ["shopify.orders", "82e53111c3127073"],
  ["slack.workspace", "2b5e89d561548e8a"],
  ["slack.channels", "b7ef731906d7805a"],
  ["slack.channel_stats", "ef2a59153d6fef45"],
  ["slack.channel_memberships", "049cf3d633da5661"],
  ["slack.users", "1cae0a8da39124f9"],
  ["slack.messages", "38f98de17c65338e"],
  ["slack.message_attachments", "cf872f751aac2ce3"],
  ["slack.reactions", "58b42c686049edf8"],
  ["slack.files", "c571b539ff895d86"],
  ["slack.canvases", "58ebea2c21b732bd"],
  ["spotify.playlists", "a9d3a81ca9e29ba5"],
  ["spotify.saved_tracks", "2c05bac3705c2f52"],
  ["spotify.top_artists", "56f6aedaf8d2dc5d"],
  ["spotify.recently_played", "cb5cb7f10b08629a"],
  ["strava.activities", "48ff5417d023dc35"],
  ["twitter_archive.tweets", "8085506aa0ddadff"],
  ["twitter_archive.direct_messages", "2b3c295be264d6ac"],
  ["uber.trips", "e5a6e4ab2ce5e2f6"],
  ["usaa.accounts", "24cc147d7fa524fc"],
  ["usaa.account_stats", "8607c29b4e89fb01"],
  ["usaa.transactions", "f6f24c9f21a0fe5c"],
  ["usaa.statements", "bac6a161e9785082"],
  ["usaa.inbox_messages", "52b1b61a69d45997"],
  ["usaa.credit_card_billing", "b2311dfb2032ddd8"],
  ["usaa.credit_card_billing_stats", "87f249d60fe97097"],
  ["whatsapp.chats", "bda40161868cb51d"],
  ["whatsapp.messages", "0ca393093fdd3ee7"],
  ["whatsapp.attachments", "b34fceb4e643d2b0"],
  ["wholefoods.orders", "b53a3045fa8d5242"],
  ["wholefoods.order_items", "64da9ffc7bab5eaf"],
  ["ynab.budgets", "e8476b164b31a208"],
  ["ynab.accounts", "db6d5e850d1e0547"],
  ["ynab.account_stats", "94ee4e7cfc69a755"],
  ["ynab.category_groups", "bbae3e5ae7aa0797"],
  ["ynab.categories", "e97af498f620ac5e"],
  ["ynab.payees", "adbaeb2df184bbf7"],
  ["ynab.payee_locations", "2a7c30e0d389d609"],
  ["ynab.transactions", "25ca417c1dc282d3"],
  ["ynab.scheduled_transactions", "5f8dfe081f555d8d"],
  ["ynab.months", "365a162a9071baf5"],
  ["ynab.month_categories", "9a04c2a4f7c6d957"],
]);

test("connector manifest streams: required must be declared explicitly (ratchet — no new or edited omissions)", () => {
  const newOmissions: string[] = [];
  const editedGrandfatheredStreams: string[] = [];

  for (const filename of readdirSync(MANIFESTS_DIR).sort()) {
    if (!filename.endsWith(".json")) {
      continue;
    }
    const manifestPath = join(MANIFESTS_DIR, filename);
    if (!existsSync(manifestPath)) {
      continue;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ConnectorManifest;
    const connectorKey = filename.replace(/\.json$/, "");

    for (const stream of manifest.streams ?? []) {
      if ("required" in stream) {
        continue;
      }
      const key = `${connectorKey}.${String(stream.name)}`;
      const frozenFingerprint = KNOWN_MISSING_REQUIRED.get(key);
      if (frozenFingerprint === undefined) {
        newOmissions.push(key);
        continue;
      }
      if (fingerprintSemanticStream(stream) !== frozenFingerprint) {
        editedGrandfatheredStreams.push(key);
      }
    }
  }

  assert.deepEqual(
    newOmissions.sort(),
    [],
    "New manifest stream(s) omit `required` — declare it explicitly (true or false) rather than relying on " +
      "the implicit required:true default. This is the exact authoring gap that let commit 7cc177eec silently " +
      `make stars/user_groups/reminders/dm_read_states load-bearing: ${JSON.stringify(newOmissions.sort())}`
  );

  assert.deepEqual(
    editedGrandfatheredStreams.sort(),
    [],
    "Existing manifest stream(s) that are grandfathered onto KNOWN_MISSING_REQUIRED (still omitting `required`) " +
      "were semantically edited (schema, semantics, cursor/incremental strategy, coverage_policy, etc. — " +
      "description/display prose changes are exempt). An edit to a stream's real behavior invalidates its " +
      "grandfathered status: either declare `required` explicitly on it now, or if the edit is truly benign, " +
      "update its fingerprint in KNOWN_MISSING_REQUIRED as a deliberate, reviewable allowlist change. " +
      `Streams: ${JSON.stringify(editedGrandfatheredStreams.sort())}`
  );
});
