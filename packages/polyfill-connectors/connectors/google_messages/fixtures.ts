// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Canned `gmcli ... --json` output fixtures for Google Messages connector
 * tests, plus the `GmcliRunner` injection seam so tests can swap in a fake
 * runner instead of spawning a real subprocess.
 *
 * FIELD SHAPE PROVENANCE: this fixture shape mirrors gmcli's actual
 * `RichHit` Go struct (github.com/johnlindquist/gmkit,
 * internal/store/search.go), fetched and verified directly from source —
 * see schemas.ts's header comment for the exact struct quote. It is NOT
 * captured from a real `gmcli messages search --json` run (no live binary
 * or paired device is available in this environment), so field VALUES are
 * synthetic, but field NAMES/shape are source-verified, not guessed.
 */

export interface GmcliResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

/** Swappable seam: production code spawns a real gmcli process; tests inject a fake. */
export type GmcliRunner = (args: readonly string[]) => Promise<GmcliResult>;

/** A single-chat, two-message RichHit-shaped sample `gmcli messages search --json` output. */
export function buildMessagesJsonFixture(): string {
  return JSON.stringify([
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
  ]);
}

/** Empty result set — a paired-but-empty archive. */
export function buildEmptyMessagesJsonFixture(): string {
  return JSON.stringify([]);
}

/** Malformed/schema-drifted output (missing required fields) for the schema-drift test. */
export function buildMalformedMessagesJsonFixture(): string {
  return JSON.stringify([{ unexpected_field: "no message_id, no conversation_id, no timestamp" }]);
}

/** Not-valid-JSON output at all — proves the parser fails closed on total garbage. */
export function buildNotJsonFixture(): string {
  return "this is not json output from gmcli";
}
