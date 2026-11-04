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

/** The page every post links to. */
export const SHARE_CARD_LINK = `${SITE_ORIGIN}/principles`;

/** The alt text for the card image: the card's words, in reading order. */
export const SHARE_CARD_ALT = `${SHARE_CARD_COPY.statement} ${SHARE_CARD_COPY.subtext} ${SHARE_CARD_COPY.button} ${SHARE_CARD_COPY.hashtag}`;

const SHARE_CARD_CAPTION_LEAD =
  "I just signed the pledge for global rules on where my data goes and who trains AI on it. Sign it too:";

/** The post text a supporter can copy, link included. */
export const SHARE_CARD_CAPTION = `${SHARE_CARD_CAPTION_LEAD} ${SHARE_CARD_LINK} ${SHARE_CARD_COPY.hashtag}`;

/** X takes the link in its own field, so the text leaves the link out. */
export function xIntentUrl(): string {
  const params = new URLSearchParams({
    text: `${SHARE_CARD_CAPTION_LEAD} ${SHARE_CARD_COPY.hashtag}`,
    url: SHARE_CARD_LINK,
  });
  return `https://x.com/intent/post?${params}`;
}

/** LinkedIn's share URL takes a link and no text. */
export function linkedInShareUrl(): string {
  return `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(SHARE_CARD_LINK)}`;
}
