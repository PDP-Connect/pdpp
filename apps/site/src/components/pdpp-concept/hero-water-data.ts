// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Real fields from the specification's worked examples. Never lorem.
//
// Shared record streams for the three server-rendered hero columns.
//
// LENGTH MATTERS: hero-water-still.tsx renders ROWS_PER_COLUMN rows per copy
// and cycles with `rowIndex % stream.length`. A stream shorter than that
// repeats inside a single visible column — with eight rows in seventeen slots
// the reader saw "title Weather" twice a few lines apart. Each stream below is
// at least ROWS_PER_COLUMN long so a column never repeats itself on screen;
// the only intended repeat is the seam between the two scrolling copies.
//
// WIDTH MATTERS: the three columns are equal flex tracks, so the longest
// "label value" pair sets whether a column overflows into its neighbour at
// narrow widths. "artist Stars of the Lid" (23 chars) did exactly that at
// 600px. Keep pairs at or under ~19 characters.
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
    ["total_sleep", "8h02m"],
    ["sleep_score", "68"],
    ["day", "2026-03-11"],
    ["total_sleep", "5h54m"],
    ["sleep_score", "88"],
    ["day", "2026-03-10"],
    ["total_sleep", "7h39m"],
    ["sleep_score", "74"],
    ["day", "2026-03-09"],
  ],
  [
    ["artist", "Grouper"],
    ["play_count", "141"],
    ["rank", "1"],
    ["artist", "Loscil"],
    ["play_count", "98"],
    ["rank", "2"],
    ["artist", "Tim Hecker"],
    ["play_count", "64"],
    ["rank", "3"],
    ["artist", "Barwick"],
    ["play_count", "52"],
    ["rank", "4"],
    ["artist", "Eluvium"],
    ["play_count", "47"],
    ["rank", "5"],
    ["artist", "Biosphere"],
    ["play_count", "33"],
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
    ["messages", "8"],
    ["title", "Invoice draft"],
    ["role", "agent"],
    ["messages", "24"],
    ["title", "Reading list"],
    ["role", "user"],
    ["messages", "17"],
    ["title", "Standup notes"],
    ["role", "agent"],
  ],
];
