// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

window.YTD.tweets.part0 = [
  {
    "tweet" : {
      "id_str" : "1001",
      "id" : "1001",
      "full_text" : "Plain modern tweet 🚀 with emoji",
      "created_at" : "Wed Jun 05 13:45:22 +0000 2024",
      "favorite_count" : "42",
      "retweet_count" : "7",
      "lang" : "en",
      "entities" : {
        "media" : [ { "id" : "m1" } ],
        "urls" : [ { "url" : "https://t.co/abc" }, { "url" : "https://t.co/def" } ]
      }
    }
  },
  {
    "tweet" : {
      "id_str" : "1002",
      "full_text" : "Escaped \"quotes\", a backslash \\, a newline\nand a closing-bracket ] plus comma , inside text",
      "created_at" : "Wed Jun 06 10:00:00 +0000 2024",
      "favorite_count" : "0",
      "retweet_count" : "0",
      "lang" : "en",
      "entities" : { "media" : [], "urls" : [] }
    }
  },
  {
    "tweet" : {
      "id_str" : "1003",
      "full_text" : "Reply with nested entities {not real json} and accents café résumé naïve",
      "created_at" : "Wed Jun 07 08:30:00 +0000 2024",
      "favorite_count" : "3",
      "retweet_count" : "1",
      "in_reply_to_status_id_str" : "1900",
      "in_reply_to_screen_name" : "alice",
      "lang" : "fr",
      "entities" : {
        "media" : [],
        "urls" : [ { "url" : "https://t.co/xyz", "expanded_url" : "https://example.com/a?b=c&d=e" } ]
      }
    }
  },
  {
    "tweet" : {
      "id_str" : "1004",
      "full_text" : "No created_at — should be skipped by the record builder"
    }
  }
];
