// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The supporter card's words and sizes, declared once. The copy is supplied
// verbatim by the brand owner: change it only on their word. The card carries
// no personal data, so the same image goes to every supporter.

import { SITE_ORIGIN } from "../site-facts.ts";

export const SHARE_CARD_COPY = {
  button: "Sign the pledge → pdpp.dev",
  hashtag: "#PDPP",
  statement: "My data, my rules.",
  subtext: "I just signed the pledge for global rules on where my data goes and who trains AI on it.",
} as const;

export const SHARE_CARD_FORMATS = {
  feed: { height: 1350, width: 1080 },
  story: { height: 1920, width: 1080 },
} as const;

export type ShareCardFormat = keyof typeof SHARE_CARD_FORMATS;

export const SHARE_CARD_FORMAT_NAMES = Object.keys(SHARE_CARD_FORMATS) as ShareCardFormat[];

export function isShareCardFormat(value: string): value is ShareCardFormat {
  return Object.hasOwn(SHARE_CARD_FORMATS, value);
}

export function shareCardPath(format: ShareCardFormat): string {
  return `/principles/card/${format}`;
}

/** What the Share button copies when the browser cannot share the image. */
export const SHARE_CARD_LINK = `${SITE_ORIGIN}/principles`;

/** The alt text for the card image: the card's words, in reading order. */
export const SHARE_CARD_ALT = `${SHARE_CARD_COPY.statement} ${SHARE_CARD_COPY.subtext} ${SHARE_CARD_COPY.button} ${SHARE_CARD_COPY.hashtag}`;
