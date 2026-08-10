// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Raw `api.venmo.com/v1` response shapes, as documented by the unofficial
 * client github.com/mmohades/Venmo (`venmo_api/models/json_schema.py`,
 * `venmo_api/apis/*.py`, MIT, fetched 2026-08-09). Venmo publishes no
 * schema of its own — these field names are read from that client's
 * source, not guessed or inferred from prose docs.
 */

/** `user_json_format` / `profile_json_format` shape (both share these keys). */
export interface VenmoUser {
  about?: string | null;
  date_joined?: string | null;
  display_name?: string | null;
  first_name?: string | null;
  id: string;
  is_active?: boolean | null;
  is_business?: boolean | null;
  is_group?: boolean | null;
  last_name?: string | null;
  phone?: string | null;
  profile_picture_url?: string | null;
  username?: string | null;
}

/** `GET /account` response body: `{ data: { user: VenmoUser, ... } }`. */
export interface VenmoAccountResponse {
  data?: {
    user?: VenmoUser | null;
  } | null;
}

/** `GET /users/{id}/friends` response body: `{ data: VenmoUser[], pagination: {...} }`. */
export interface VenmoFriendsResponse {
  data?: VenmoUser[] | null;
  pagination?: {
    next?: string | null;
  } | null;
}

/** Nested `payment` object inside a story, per `payment_json_format`. */
export interface VenmoStoryPayment {
  action?: string | null;
  actor?: VenmoUser | null;
  amount?: number | null;
  date_completed?: string | null;
  id?: string | null;
  note?: string | null;
  status?: string | null;
  target?: {
    user?: VenmoUser | null;
  } | null;
}

/** One entry in a `/stories/target-or-actor/{id}` response, per `transaction_json_format`. */
export interface VenmoStory {
  app?: { name?: string | null } | null;
  audience?: string | null;
  date_created?: string | null;
  date_updated?: string | null;
  id: string;
  payment?: VenmoStoryPayment | null;
  type?: string | null;
}

/** `GET /stories/target-or-actor/{id}` response body. */
export interface VenmoStoriesResponse {
  data?: VenmoStory[] | null;
  pagination?: {
    next?: string | null;
  } | null;
}

/** `POST /oauth/access_token` success response body. */
export interface VenmoAccessTokenResponse {
  access_token?: string | null;
  balance?: number | null;
  user?: VenmoUser | null;
}

/** `POST /oauth/access_token` 2FA-required error response body. */
export interface VenmoTwoFactorRequiredResponse {
  error?: {
    code?: number | null;
    message?: string | null;
  } | null;
}
