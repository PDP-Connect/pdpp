// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Real fields from the specification's worked examples. Never lorem.
//
// Shared between the client canvas (hero-water.tsx) and the server-rendered
// still frame (hero-water-still.tsx) so the two can never drift apart: the
// still frame is what a reader sees until the canvas replaces it, so it has
// to be the same records in the same columns, not a stand-in.
export const HERO_WATER_STREAMS: readonly (readonly (readonly [string, string])[])[] = [
  [
    ["sleep_score", "82"],
    ["day", "2026-03-14"],
    ["total_sleep", "7h21m"],
    ["sleep_score", "77"],
    ["day", "2026-03-13"],
    ["total_sleep", "6h48m"],
    ["sleep_score", "91"],
    ["day", "2026-03-12"],
  ],
  [
    ["artist", "Grouper"],
    ["play_count", "141"],
    ["rank", "1"],
    ["artist", "Loscil"],
    ["play_count", "98"],
    ["rank", "2"],
    ["artist", "Stars of the Lid"],
    ["play_count", "64"],
  ],
  [
    ["title", "Weather"],
    ["role", "user"],
    ["messages", "12"],
    ["title", "Trip planning"],
    ["role", "agent"],
    ["messages", "31"],
    ["title", "Groceries"],
    ["role", "user"],
  ],
];
