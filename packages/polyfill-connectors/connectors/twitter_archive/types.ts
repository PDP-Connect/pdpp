// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Shared types for the Twitter archive connector. Kept out of index.ts so
// the pure parsers in parsers.ts can import them without pulling in the
// runtime entry point or fs.

export interface TweetEntities {
  media?: unknown[];
  urls?: unknown[];
}

export interface TweetShape {
  created_at?: string;
  entities?: TweetEntities;
  favorite_count?: string | number;
  full_text?: string | null;
  id?: string;
  id_str?: string;
  in_reply_to_screen_name?: string | null;
  in_reply_to_status_id_str?: string | null;
  lang?: string | null;
  retweet_count?: string | number;
  text?: string | null;
}

export interface TweetEntry {
  tweet?: TweetShape;
  [k: string]: unknown;
}

export interface DMShape {
  createdAt?: string;
  id?: string;
  recipientId?: string | null;
  senderId?: string | null;
  text?: string | null;
}

export interface DMMessage {
  messageCreate?: DMShape;
  [k: string]: unknown;
}

export interface DMConversation {
  conversationId?: string | null;
  messages?: DMMessage[];
}

export interface DMEntry {
  dmConversation?: DMConversation;
  [k: string]: unknown;
}

export interface StreamState {
  last_created_at?: string;
}

/** Shape emitted on the `tweets` stream. */
export interface TweetOut {
  created_at: string;
  favorite_count: number | null;
  id: string | null;
  in_reply_to_screen_name: string | null;
  in_reply_to_status_id: string | null;
  lang: string | null;
  media_count: number;
  retweet_count: number | null;
  text: string | null;
  url_count: number;
}

/** Shape emitted on the `direct_messages` stream. */
export interface DMOut {
  conversation_id: string | null;
  created_at: string;
  id: string | null;
  recipient_id: string | null;
  sender_id: string | null;
  text: string | null;
}
