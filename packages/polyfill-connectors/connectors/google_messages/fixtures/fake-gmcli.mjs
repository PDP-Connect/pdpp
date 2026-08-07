#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Fake `gmcli` binary for connector subprocess/protocol tests. Behavior is
 * selected via the FAKE_GMCLI_MODE env var so a single script covers every
 * fixture-driven scenario the integration test needs, without spawning a
 * real gmkit binary (which would require a real paired Android device).
 *
 * Modes:
 *   healthy      -> `messages search --json` exits 0 with the two-message fixture
 *   empty        -> exits 0 with an empty JSON array
 *   not_paired   -> exits 1 with pairing-required-shaped stderr text
 *   malformed    -> exits 0 with output missing required fields
 *   not_json     -> exits 0 with non-JSON stdout
 */

const mode = process.env.FAKE_GMCLI_MODE || "healthy";

// RichHit-shaped rows (github.com/johnlindquist/gmkit,
// internal/store/search.go — verified from source; see schemas.ts's header
// comment for the exact struct quote).
const FIXTURES = {
  healthy: JSON.stringify([
    {
      message_id: "msg_0001",
      conversation_id: "chat_alice",
      conversation_name: "Alice",
      sender_name: "Alice",
      body: "hey, are we still on for lunch?",
      snippet: "hey, are we still on for lunch?",
      timestamp_ms: 1_754_071_452_000,
      timestamp_iso: "2026-08-01T18:04:12.000Z",
      is_from_me: false,
    },
    {
      message_id: "msg_0002",
      conversation_id: "chat_alice",
      conversation_name: "Alice",
      body: "yep, see you at noon",
      snippet: "yep, see you at noon",
      timestamp_ms: 1_754_071_605_000,
      timestamp_iso: "2026-08-01T18:06:45.000Z",
      is_from_me: true,
    },
  ]),
  empty: "[]",
  malformed: JSON.stringify([{ unexpected_field: "no message_id, no conversation_id, no timestamp" }]),
  not_json: "this is not json output from gmcli",
};

if (mode === "not_paired") {
  process.stderr.write("error: device not paired. Please run `gmcli auth` to pair your Android device.\n");
  process.exit(1);
}

process.stdout.write(FIXTURES[mode] ?? FIXTURES.healthy);
process.exit(0);
