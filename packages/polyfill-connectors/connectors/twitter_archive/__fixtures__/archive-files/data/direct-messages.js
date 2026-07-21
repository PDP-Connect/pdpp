// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

window.YTD.direct_messages.part0 = [
  {
    "dmConversation" : {
      "conversationId" : "111-222",
      "messages" : [
        {
          "messageCreate" : {
            "id" : "m1",
            "senderId" : "111",
            "recipientId" : "222",
            "text" : "hey there — em dash, \"quoted\", and \\ backslash",
            "createdAt" : "2024-06-05T13:45:22.000Z"
          }
        },
        {
          "messageCreate" : {
            "id" : "m2",
            "senderId" : "222",
            "recipientId" : "111",
            "text" : "multi\nline reply with unicode ☃ and a ] bracket",
            "createdAt" : "2024-06-05T13:46:00.000Z"
          }
        },
        {
          "messageCreate" : {
            "id" : "m3-no-date",
            "senderId" : "222",
            "recipientId" : "111",
            "text" : "missing createdAt — skipped"
          }
        }
      ]
    }
  },
  {
    "dmConversation" : {
      "conversationId" : "333-444",
      "messages" : [
        {
          "messageCreate" : {
            "id" : "m4",
            "senderId" : "333",
            "recipientId" : "444",
            "text" : "second conversation",
            "createdAt" : "2024-06-08T09:00:00.000Z"
          }
        }
      ]
    }
  }
];
