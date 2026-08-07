// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Canned `gmcli ... --json` output fixtures for Google Messages connector
 * tests, plus the `GmcliRunner` injection seam so tests can swap in a fake
 * runner instead of spawning a real subprocess.
 *
 * FIELD SHAPE PROVENANCE: this fixture shape mirrors gmcli's actual
 * `Conversation`/`Message` Go structs (github.com/johnlindquist/gmkit,
 * internal/store/conversations.go + messages.go), fetched and verified
 * directly from source — see schemas.ts's header comment for the exact
 * struct quotes. It is NOT captured from a real `gmcli chats list`/`gmcli
 * messages list` run (no live binary or paired device is available in this
 * environment), so field VALUES are synthetic, but field NAMES/shape are
 * source-verified, not guessed.
 */

export interface GmcliResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

/** Swappable seam: production code spawns a real gmcli process; tests inject a fake. */
export type GmcliRunner = (args: readonly string[]) => Promise<GmcliResult>;

/** Conversation-shaped sample `gmcli --json --full chats list` output — one chat. */
export function buildChatsJsonFixture(): string {
  return JSON.stringify([
    {
      conversation_id: "chat_alice",
      source_platform: "rcs",
      name: "Alice",
      is_group: false,
      last_message_time_ms: 1_754_071_605_000,
    },
  ]);
}

/** No conversations at all — a paired-but-empty archive. */
export function buildEmptyChatsJsonFixture(): string {
  return JSON.stringify([]);
}

/** Malformed chats output (missing conversation_id) for the schema-drift test. */
export function buildMalformedChatsJsonFixture(): string {
  return JSON.stringify([{ unexpected_field: "no conversation_id" }]);
}

/** A two-message Message-shaped sample `gmcli messages list --conv <id> --json --full` output. */
export function buildMessagesJsonFixture(): string {
  return JSON.stringify([
    {
      message_id: "msg_0001",
      conversation_id: "chat_alice",
      source_platform: "rcs",
      sender_id: "+15551230001",
      body: "hey, are we still on for lunch?",
      timestamp_ms: 1_754_071_452_000,
      status: 1,
      is_from_me: false,
    },
    {
      message_id: "msg_0002",
      conversation_id: "chat_alice",
      source_platform: "rcs",
      sender_id: "me",
      body: "yep, see you at noon",
      timestamp_ms: 1_754_071_605_000,
      status: 1,
      is_from_me: true,
    },
  ]);
}

/** Empty result set for one conversation — no messages returned. */
export function buildEmptyMessagesJsonFixture(): string {
  return JSON.stringify([]);
}

/**
 * A full page of messages (exactly `limit` rows) — the only detectable
 * proxy gmcli gives for "this conversation may have more history than we
 * fetched," since `--limit` has no accompanying total-count/cursor.
 */
export function buildFullPageMessagesJsonFixture(limit: number): string {
  return JSON.stringify(
    Array.from({ length: limit }, (_, i) => ({
      message_id: `msg_${String(i).padStart(4, "0")}`,
      conversation_id: "chat_alice",
      source_platform: "rcs",
      sender_id: i % 2 === 0 ? "+15551230001" : "me",
      body: `message ${String(i)}`,
      timestamp_ms: 1_754_071_452_000 + i * 1000,
      status: 1,
      is_from_me: i % 2 === 1,
    }))
  );
}

/** Malformed/schema-drifted messages output (missing required fields) for the schema-drift test. */
export function buildMalformedMessagesJsonFixture(): string {
  return JSON.stringify([{ unexpected_field: "no message_id, no conversation_id, no timestamp" }]);
}

/** Not-valid-JSON output at all — proves the parser fails closed on total garbage. */
export function buildNotJsonFixture(): string {
  return "this is not json output from gmcli";
}
