// Synthetic Twitter archive samples for parsers.test.ts. Shapes mirror
// what Twitter's Data Download ships in data/tweets.js and
// data/direct-messages.js after `window.YTD.*.partN = ` is stripped.

import type { DMEntry, TweetEntry } from "../types.ts";

/** Modern layout — tweet lives under .tweet. */
export const TWEET_ENTRY_MODERN: TweetEntry = {
  tweet: {
    id_str: "1234567890",
    id: "1234567890",
    full_text: "Hello world!",
    text: "Hello world!",
    created_at: "Wed Jun 05 13:45:22 +0000 2024",
    favorite_count: "42",
    retweet_count: "7",
    in_reply_to_status_id_str: null,
    in_reply_to_screen_name: null,
    lang: "en",
    entities: {
      media: [{ id: "m1" }],
      urls: [{ url: "https://t.co/abc" }, { url: "https://t.co/def" }],
    },
  },
};

/** Older layout — tweet fields live at the top level. */
export const TWEET_ENTRY_LEGACY = {
  id_str: "9999",
  full_text: "Legacy shape",
  created_at: "Wed Jun 06 10:00:00 +0000 2024",
  favorite_count: 3,
  retweet_count: 0,
  lang: "en",
  entities: { media: [], urls: [] },
};

/** Reply tweet with all reply fields populated. */
export const TWEET_REPLY: TweetEntry = {
  tweet: {
    id_str: "2000",
    full_text: "@alice good question",
    created_at: "Wed Jun 07 08:30:00 +0000 2024",
    favorite_count: "0",
    retweet_count: "0",
    in_reply_to_status_id_str: "1900",
    in_reply_to_screen_name: "alice",
    lang: "en",
    entities: { media: [], urls: [] },
  },
};

/** Tweet missing created_at — should be skipped by buildTweetRecord. */
export const TWEET_NO_DATE: TweetEntry = {
  tweet: {
    id_str: "nope",
    full_text: "no date",
  },
};

/** DM conversation with two messages. */
export const DM_ENTRY: DMEntry = {
  dmConversation: {
    conversationId: "111-222",
    messages: [
      {
        messageCreate: {
          id: "m1",
          senderId: "111",
          recipientId: "222",
          text: "hey",
          createdAt: "2024-06-05T13:45:22.000Z",
        },
      },
      {
        messageCreate: {
          id: "m2",
          senderId: "222",
          recipientId: "111",
          text: "hi back",
          createdAt: "2024-06-05T13:46:00.000Z",
        },
      },
    ],
  },
};

/** DM with one valid message and one missing createdAt (should be skipped). */
export const DM_ENTRY_WITH_MALFORMED: DMEntry = {
  dmConversation: {
    conversationId: "333-444",
    messages: [
      {
        messageCreate: {
          id: "ok",
          senderId: "333",
          recipientId: "444",
          text: "valid",
          createdAt: "2024-06-05T13:45:22.000Z",
        },
      },
      {
        messageCreate: {
          id: "bad",
          senderId: "333",
          recipientId: "444",
          text: "no timestamp",
        },
      },
    ],
  },
};
