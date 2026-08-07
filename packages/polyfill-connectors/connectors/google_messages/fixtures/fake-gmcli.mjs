#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Fake `gmcli` binary for connector subprocess/protocol tests. Behavior is
 * selected via the FAKE_GMCLI_MODE env var so a single script covers every
 * fixture-driven scenario the integration test needs, without spawning a
 * real gmkit binary (which would require a real paired Android device).
 * Dispatches on the actual subcommand (`chats list` vs `messages list
 * --conv <id>`) the way the real gmcli CLI would, so tests can assert on
 * argument order/shape, not just stdout content.
 *
 * Modes:
 *   healthy         -> chats list returns 1 chat; messages list returns 2 messages
 *   empty           -> chats list returns 0 chats (messages list never called)
 *   not_paired      -> chats list exits 1 with pairing-required-shaped stderr text
 *   malformed_chats -> chats list returns output missing conversation_id
 *   malformed_messages -> chats list ok; messages list returns output missing required fields
 *   not_json        -> chats list exits 0 with non-JSON stdout
 *   full_page       -> chats list returns 1 chat; messages list returns exactly --limit rows (truncation-proxy test)
 */

const mode = process.env.FAKE_GMCLI_MODE || "healthy";
const args = process.argv.slice(2);

// Conversation/Message-shaped rows (github.com/johnlindquist/gmkit,
// internal/store/conversations.go + messages.go — verified from source;
// see schemas.ts's header comment for the exact struct quotes).
const CHATS_HEALTHY = JSON.stringify([
  {
    conversation_id: "chat_alice",
    source_platform: "rcs",
    name: "Alice",
    is_group: false,
    last_message_time_ms: 1_754_071_605_000,
  },
]);
const CHATS_EMPTY = "[]";
const CHATS_MALFORMED = JSON.stringify([{ unexpected_field: "no conversation_id" }]);

const MESSAGES_HEALTHY = JSON.stringify([
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
const MESSAGES_MALFORMED = JSON.stringify([{ unexpected_field: "no message_id, no conversation_id, no timestamp" }]);

function limitFromArgs() {
  const idx = args.indexOf("--limit");
  const n = idx >= 0 ? Number(args[idx + 1]) : 500;
  return Number.isFinite(n) && n > 0 ? n : 500;
}

function fullPageMessages() {
  const limit = limitFromArgs();
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

// Global flags (--json, --full) are Cobra root persistent flags and may
// legally precede the subcommand, so find "chats"/"messages" wherever they
// appear rather than assuming they're at index 0.
const isChatsList = args.includes("chats") && args.includes("list") && args[args.indexOf("chats") + 1] === "list";
const isMessagesList = args[0] === "messages" && args[1] === "list";

if (mode === "not_paired") {
  process.stderr.write("error: device not paired. Please run `gmcli auth` to pair your Android device.\n");
  process.exit(1);
}

if (isChatsList) {
  if (mode === "empty") {
    process.stdout.write(CHATS_EMPTY);
  } else if (mode === "malformed_chats") {
    process.stdout.write(CHATS_MALFORMED);
  } else if (mode === "not_json") {
    process.stdout.write("this is not json output from gmcli");
  } else {
    process.stdout.write(CHATS_HEALTHY);
  }
  process.exit(0);
}

if (isMessagesList) {
  if (mode === "malformed_messages") {
    process.stdout.write(MESSAGES_MALFORMED);
  } else if (mode === "full_page") {
    process.stdout.write(fullPageMessages());
  } else {
    process.stdout.write(MESSAGES_HEALTHY);
  }
  process.exit(0);
}

process.stderr.write(`fake-gmcli: unrecognized invocation: ${args.join(" ")}\n`);
process.exit(1);
